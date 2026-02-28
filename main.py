import os
import boto3
import httpx
import mimetypes
import logging
from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("content-manager")

app = FastAPI()

# Configuration
R2_ENDPOINT_URL = os.environ.get("R2_ENDPOINT_URL")
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY")
R2_BUCKET_NAME = os.environ.get("R2_BUCKET_NAME")
CONVERSION_SERVICE_URL = os.environ.get("CONVERSION_SERVICE_URL", "http://webp-converter:8090")
PUBLIC_URL_PREFIX = os.environ.get("PUBLIC_URL_PREFIX", "")  # Add trailing slash if used, mostly for returning public URLs to frontend

# S3 Client setup
def get_s3_client():
    if not all([R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME]):
        print("WARNING: R2 credentials missing. S3 operations will fail.")
        return None
    return boto3.client(
        's3',
        endpoint_url=R2_ENDPOINT_URL,
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY
    )

s3 = get_s3_client()

@app.get("/api/content")
async def get_content(prefix: str):
    if not s3:
        raise HTTPException(status_code=500, detail="S3 client not configured")
        
    try:
        response = s3.list_objects_v2(Bucket=R2_BUCKET_NAME, Prefix=prefix)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

        
    contents = response.get("Contents", [])
    
    images = {}
    others = []
    
    # Process contents to separate images (with original, _p, _t) from others
    for item in contents:
        key = item['Key']
        filename = key[len(prefix):] if key.startswith(prefix) else key
        if not filename:
            continue
            
        # Very simple grouping based on filenames ending in _p.webp or _t.webp
        # We will assume image UUIDs are used.
        if filename.endswith("_p.webp"):
            uuid_key = filename[:-7]
            if uuid_key not in images:
                images[uuid_key] = {"prefix": prefix, "slug": uuid_key, "files": {}, "last_modified": item['LastModified'].isoformat()}
            images[uuid_key]["files"]["preview"] = filename
        elif filename.endswith("_t.webp"):
            uuid_key = filename[:-7]
            if uuid_key not in images:
                images[uuid_key] = {"prefix": prefix, "slug": uuid_key, "files": {}, "last_modified": item['LastModified'].isoformat()}
            images[uuid_key]["files"]["thumbnail"] = filename
        else:
            # Could be original image or non-image. We check if there's an associated _p or _t to group it, or do it by mime types.
            # We'll just add to 'others' for now and resolve grouping after first pass
            others.append({"key": key, "filename": filename, "size": item['Size'], "last_modified": item['LastModified'].isoformat()})

    # Group original images that match UUIDs
    final_others = []
    for other in others:
        name_no_ext = os.path.splitext(other["filename"])[0]
        if name_no_ext in images:
            images[name_no_ext]["files"]["original"] = other["filename"]
            # To ensure images have last_modified if only original was processed first, though usually _p or _t are processed
            if "last_modified" not in images[name_no_ext]:
                images[name_no_ext]["last_modified"] = other["last_modified"]
        else:
            final_others.append(other)
            
    # Format images list & sort by date uploaded
    images_list = list(images.values())
    images_list.sort(key=lambda x: x.get("last_modified", ""), reverse=True)
    final_others.sort(key=lambda x: x.get("last_modified", ""), reverse=True)
            
    return {"images": images_list, "others": final_others, "public_url_prefix": PUBLIC_URL_PREFIX}

@app.post("/api/upload")
async def upload_content(prefix: str = Form(...), override_filename: str = Form(None), file: UploadFile = File(...)):
    try:
        if not s3:
            raise HTTPException(status_code=500, detail="S3 client not configured")
    
        content = await file.read()
        file_name = "default-filename"
        if file.filename:
            file_name = file.filename
        mime_type = file.content_type or mimetypes.guess_type(file_name)[0] or "application/octet-stream"
        original_ext = os.path.splitext(file_name)[1]

        # 1. Check if image
        is_image = mime_type.startswith("image/")
        
        if not is_image:
            # Upload non-image
            target_filename = override_filename if override_filename else file.filename
            file_key = f"{prefix}{target_filename}"
            s3.put_object(Bucket=R2_BUCKET_NAME, Key=file_key, Body=content, ContentType=mime_type)
            return {"status": "success", "type": "other", "key": file_key}
            
        # If image:
        async with httpx.AsyncClient() as client:
            # Get slug
            try:
                filename_for_conversion = file.filename or "image.png"
                slug_resp = await client.get(f"{CONVERSION_SERVICE_URL}/slug", params={"name": filename_for_conversion})
                slug_resp.raise_for_status()
                slug_data = slug_resp.json()
                short_uuid = slug_data["short_uuid"]
            except Exception as e:
                logger.exception("Failed to get slug from conversion service")
                raise HTTPException(status_code=500, detail=f"Failed to get slug: {e}")
                
            original_key = f"{prefix}{short_uuid}{original_ext}"
            preview_key = f"{prefix}{short_uuid}_p.webp"
            thumbnail_key = f"{prefix}{short_uuid}_t.webp"
            
            # Upload original
            s3.put_object(Bucket=R2_BUCKET_NAME, Key=original_key, Body=content, ContentType=mime_type)
            
            # Convert to WebP preview
            try:
                preview_resp = await client.post(
                    f"{CONVERSION_SERVICE_URL}/convert", 
                    content=content,
                    headers={"Content-Type": mime_type}
                )
                preview_resp.raise_for_status()
                preview_content = preview_resp.content
                s3.put_object(Bucket=R2_BUCKET_NAME, Key=preview_key, Body=preview_content, ContentType="image/webp")
            except Exception as e:
                logger.exception("Failed to convert image to preview")
                raise HTTPException(status_code=500, detail=f"Conversion failed: {e}")
                
            # Convert to Thumbnail
            try:
                thumb_resp = await client.post(
                    f"{CONVERSION_SERVICE_URL}/thumbnail", 
                    params={"height": 128}, 
                    content=content,
                    headers={"Content-Type": mime_type}
                )
                thumb_resp.raise_for_status()
                thumb_content = thumb_resp.content
                s3.put_object(Bucket=R2_BUCKET_NAME, Key=thumbnail_key, Body=thumb_content, ContentType="image/webp")
            except Exception as e:
                logger.exception("Failed to create thumbnail")
                raise HTTPException(status_code=500, detail=f"Thumbnail conversion failed: {e}")
                
        return {
            "status": "success", 
            "type": "image",
            "slug": short_uuid,
            "original": original_key,
            "preview": preview_key, 
            "thumbnail": thumbnail_key
        }
    except HTTPException as http_exc:
        # Re-raise HTTPExceptions so FastAPI can handle them normally
        raise http_exc
    except Exception as e:
        logger.exception("Unexpected error during upload")
        raise HTTPException(status_code=500, detail=f"Unexpected server error during upload: {e}")

@app.delete("/api/content")
async def delete_content(key: str):
    if not s3:
        raise HTTPException(status_code=500, detail="S3 client not configured")
    try:
        s3.delete_object(Bucket=R2_BUCKET_NAME, Key=key)
        return {"status": "success", "deleted": key}
    except Exception as e:
         raise HTTPException(status_code=500, detail=str(e))

# Ensure static folder exists
os.makedirs("static", exist_ok=True)
app.mount("/", StaticFiles(directory="static", html=True), name="static")
