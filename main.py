import asyncio
import json
import logging
import mimetypes
import os
import re
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Literal

import boto3
import httpx
from botocore.exceptions import ClientError
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("content-manager")

# ---------------- Configuration ----------------

ENVIRONMENT = os.environ.get("ENVIRONMENT", "production")
R2_ENDPOINT_URL = os.environ.get("R2_ENDPOINT_URL")
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY")
R2_BUCKET_NAME = os.environ.get("R2_BUCKET_NAME")
CONVERSION_SERVICE_URL = os.environ.get("CONVERSION_SERVICE_URL", "http://webp-converter:8090")
PUBLIC_URL_PREFIX = os.environ.get("PUBLIC_URL_PREFIX", "")
API_KEY = os.environ.get("API_KEY")

ALLOWED_SITES = [s.strip() for s in os.environ.get("ALLOWED_SITES", "").split(",") if s.strip()]
TURNSTILE_SECRET_KEY = os.environ.get("TURNSTILE_SECRET_KEY")
TURNSTILE_SITE_KEY = os.environ.get("TURNSTILE_SITE_KEY", "")
DISCORD_WEBHOOK = os.environ.get("DISCORD_WEBHOOK")
ADMIN_URL = os.environ.get("ADMIN_URL", "")

MAX_PUBLIC_UPLOAD_BYTES = 25 * 1024 * 1024
SUGGESTIONS_PREFIX = "_suggestions/"
PENDING_PREFIX = "_suggestions/_pending/"
TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

SUPPORTED_FORMATS_FALLBACK = frozenset({
    "jpg", "jpeg", "png", "apng", "gif", "webp", "avif", "heic", "heif",
    "tiff", "tif", "bmp", "mp4", "mov", "webm", "mkv", "avi",
})
SUPPORTED_FORMATS: frozenset[str] = SUPPORTED_FORMATS_FALLBACK

if not API_KEY:
    logger.warning("API_KEY not set. All admin API requests will be rejected.")
if not ALLOWED_SITES:
    logger.warning("ALLOWED_SITES not set. Public suggestion API will reject all submissions.")


# ---------------- Lifespan ----------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    global SUPPORTED_FORMATS
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{CONVERSION_SERVICE_URL}/formats", timeout=5)
            resp.raise_for_status()
            formats = frozenset(f.lower() for f in resp.json().get("formats", []))
            if formats:
                SUPPORTED_FORMATS = formats
                logger.info("Loaded %d supported formats from conversion service", len(formats))
    except Exception:
        logger.warning("Could not fetch /formats from conversion service; using fallback list")
    yield


app = FastAPI(lifespan=lifespan)


# ---------------- CORS ----------------

cors_origins = [
    "https://www.duck-automata.com",
    "https://duck-automata.com",
    "https://dev.duck-automata.com",
]
extra_cors = [o.strip() for o in os.environ.get("EXTRA_CORS_ORIGINS", "").split(",") if o.strip()]
cors_origins.extend(extra_cors)

cors_origin_regex: str | None = None
if ENVIRONMENT == "development":
    cors_origin_regex = r"https?://(localhost|127\.0\.0\.1)(:\d+)?"

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_origin_regex=cors_origin_regex,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["X-API-KEY", "Content-Type"],
)


# ---------------- Auth ----------------

def require_api_key(x_api_key: str | None = Header(default=None)):
    if not API_KEY:
        raise HTTPException(status_code=500, detail="Server not configured: API_KEY missing")
    if not x_api_key:
        raise HTTPException(status_code=401, detail="Missing API key")
    if not secrets.compare_digest(x_api_key, API_KEY):
        raise HTTPException(status_code=401, detail="Invalid API key")


# ---------------- S3 client ----------------

def get_s3_client():
    if not all([R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME]):
        logger.warning("R2 credentials missing. S3 operations will fail.")
        os.close(1)
    return boto3.client(
        "s3",
        endpoint_url=R2_ENDPOINT_URL,
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    )


s3 = get_s3_client()


def _list_all_objects(prefix: str):
    paginator = s3.get_paginator("list_objects_v2")
    contents = []
    for page in paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix=prefix):
        contents.extend(page.get("Contents", []))
    return contents


# ---------------- Image conversion + storage ----------------

async def _convert_and_store(
    *, content: bytes, mime: str, original_ext: str, original_name: str, prefix: str
) -> dict:
    """Run the conversion pipeline and upload original/preview/thumbnail under `prefix`.
    Rolls back partial uploads on failure. Returns slug, ext, and the three keys."""
    async with httpx.AsyncClient() as client:
        try:
            slug_resp = await client.get(
                f"{CONVERSION_SERVICE_URL}/slug", params={"name": original_name}
            )
            slug_resp.raise_for_status()
            short_uuid = slug_resp.json()["short_uuid"]
        except Exception as e:
            logger.exception("Failed to get slug from conversion service")
            raise HTTPException(status_code=500, detail=f"Failed to get slug: {e}")

        original_key = f"{prefix}{short_uuid}{original_ext}"
        preview_key = f"{prefix}{short_uuid}_p.webp"
        thumbnail_key = f"{prefix}{short_uuid}_t.webp"

        try:
            preview_resp = await client.post(
                f"{CONVERSION_SERVICE_URL}/convert",
                content=content,
                headers={"Content-Type": mime},
            )
            preview_resp.raise_for_status()
            preview_content = preview_resp.content
        except Exception as e:
            logger.exception("Failed to convert image to preview")
            raise HTTPException(status_code=500, detail=f"Conversion failed: {e}")

        try:
            thumb_resp = await client.post(
                f"{CONVERSION_SERVICE_URL}/thumbnail",
                params={"height": 128},
                content=content,
                headers={"Content-Type": mime},
            )
            thumb_resp.raise_for_status()
            thumb_content = thumb_resp.content
        except Exception as e:
            logger.exception("Failed to create thumbnail")
            raise HTTPException(status_code=500, detail=f"Thumbnail conversion failed: {e}")

    uploads = [
        (original_key, content, mime),
        (preview_key, preview_content, "image/webp"),
        (thumbnail_key, thumb_content, "image/webp"),
    ]
    uploaded: list[str] = []
    try:
        for key, body, ctype in uploads:
            await asyncio.to_thread(
                s3.put_object, Bucket=R2_BUCKET_NAME, Key=key, Body=body, ContentType=ctype,
            )
            uploaded.append(key)
    except Exception as e:
        logger.exception("Upload failed mid-flight, rolling back")
        for k in uploaded:
            try:
                await asyncio.to_thread(s3.delete_object, Bucket=R2_BUCKET_NAME, Key=k)
            except Exception:
                logger.exception("Rollback failed for key %s", k)
        raise HTTPException(status_code=500, detail=f"Upload failed: {e}")

    return {
        "slug": short_uuid,
        "ext": original_ext,
        "original": original_key,
        "preview": preview_key,
        "thumbnail": thumbnail_key,
    }


# ---------------- Suggestion helpers ----------------

_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")


def _validate_id(value: str, kind: str) -> None:
    if not _ID_RE.fullmatch(value):
        raise HTTPException(status_code=400, detail=f"Invalid {kind} id")


def _suggestion_key(suggestion_id: str) -> str:
    return f"{SUGGESTIONS_PREFIX}{suggestion_id}.json"


def _read_suggestion_sync(suggestion_id: str) -> dict | None:
    try:
        resp = s3.get_object(Bucket=R2_BUCKET_NAME, Key=_suggestion_key(suggestion_id))
        return json.loads(resp["Body"].read())
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
            return None
        raise


async def _read_suggestion(suggestion_id: str) -> dict | None:
    return await asyncio.to_thread(_read_suggestion_sync, suggestion_id)


async def _write_suggestion(suggestion: dict) -> None:
    body = json.dumps(suggestion).encode("utf-8")
    await asyncio.to_thread(
        s3.put_object,
        Bucket=R2_BUCKET_NAME,
        Key=_suggestion_key(suggestion["id"]),
        Body=body,
        ContentType="application/json",
    )


def _list_suggestion_keys_sync() -> list[str]:
    paginator = s3.get_paginator("list_objects_v2")
    keys: list[str] = []
    # Delimiter="/" prevents recursion into _pending/
    for page in paginator.paginate(
        Bucket=R2_BUCKET_NAME, Prefix=SUGGESTIONS_PREFIX, Delimiter="/"
    ):
        for obj in page.get("Contents", []):
            if obj["Key"].endswith(".json"):
                keys.append(obj["Key"])
    return keys


async def _read_all_suggestions() -> list[dict]:
    keys = await asyncio.to_thread(_list_suggestion_keys_sync)
    suggestions: list[dict] = []
    for k in keys:
        try:
            resp = await asyncio.to_thread(s3.get_object, Bucket=R2_BUCKET_NAME, Key=k)
            suggestions.append(json.loads(resp["Body"].read()))
        except Exception:
            logger.exception("Failed to read suggestion %s", k)
    suggestions.sort(key=lambda s: s.get("submitted_at", ""), reverse=True)
    return suggestions


def _find_pending_image_ext_sync(image_id: str) -> str | None:
    """Return the original-file extension (with dot) for a pending image id, or None."""
    paginator = s3.get_paginator("list_objects_v2")
    prefix = f"{PENDING_PREFIX}{image_id}"
    for page in paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix=prefix):
        for obj in page.get("Contents", []):
            name = obj["Key"][len(PENDING_PREFIX):]
            base, ext = os.path.splitext(name)
            if base == image_id:
                return ext
    return None


# ---------------- Turnstile ----------------

def _client_ip(request: Request) -> str | None:
    return request.headers.get("CF-Connecting-IP") or (
        request.client.host if request.client else None
    )


async def verify_turnstile(token: str | None, remote_ip: str | None = None) -> None:
    if not TURNSTILE_SECRET_KEY:
        if ENVIRONMENT == "development":
            logger.info("Turnstile bypass: ENVIRONMENT=development and no secret configured")
            return
        raise HTTPException(status_code=500, detail="Turnstile not configured")
    if not token:
        raise HTTPException(status_code=400, detail="Missing Turnstile token")
    data = {"secret": TURNSTILE_SECRET_KEY, "response": token}
    if remote_ip:
        data["remoteip"] = remote_ip
    try:
        async with httpx.AsyncClient() as client:
            r = await client.post(TURNSTILE_VERIFY_URL, data=data, timeout=10)
            r.raise_for_status()
            result = r.json()
    except Exception:
        logger.exception("Turnstile verification request failed")
        raise HTTPException(status_code=503, detail="Turnstile verification unavailable")
    if not result.get("success"):
        logger.warning("Turnstile rejected: %s", result.get("error-codes", []))
        raise HTTPException(status_code=403, detail="Turnstile verification failed")


# ---------------- Discord ----------------

async def _notify_discord(suggestion: dict, sample_image_url: str | None) -> None:
    if not DISCORD_WEBHOOK:
        return
    sid = suggestion["id"]
    site = suggestion.get("site", "?")
    kind = suggestion.get("kind", "?")
    images = suggestion.get("images", [])
    payload_str = json.dumps(suggestion.get("payload", {}), indent=2)
    if len(payload_str) > 900:
        payload_str = payload_str[:900] + "\n... (truncated)"
    review_url = (
        f"{ADMIN_URL.rstrip('/')}/suggestions.html?id={sid}" if ADMIN_URL else None
    )

    embed: dict = {
        "title": f"New {kind} suggestion for {site}",
        "color": 0x5865F2,
        "fields": [
            {"name": "Site", "value": site, "inline": True},
            {"name": "Kind", "value": kind, "inline": True},
            {"name": "Images", "value": str(len(images)), "inline": True},
            {"name": "Payload", "value": f"```json\n{payload_str}\n```"},
        ],
    }
    if review_url:
        embed["url"] = review_url
    if sample_image_url:
        embed["image"] = {"url": sample_image_url}

    try:
        async with httpx.AsyncClient() as client:
            await client.post(DISCORD_WEBHOOK, json={"embeds": [embed]}, timeout=10)
    except Exception:
        logger.exception("Discord webhook delivery failed")


# ---------------- Models ----------------

class BulkDeleteRequest(BaseModel):
    keys: list[str]


class PublicSuggestionRequest(BaseModel):
    cf_turnstile_response: str
    site: str
    kind: Literal["new", "edit", "delete"]
    payload: dict = Field(default_factory=dict)
    image_ids: list[str] = Field(default_factory=list)


class SuggestionEditRequest(BaseModel):
    payload: dict | None = None
    kind: Literal["new", "edit", "delete"] | None = None
    site: str | None = None


class SuggestionStatusRequest(BaseModel):
    status: Literal["approved", "rejected"]


# ---------------- Existing admin endpoints ----------------

@app.get("/api/auth/check", dependencies=[Depends(require_api_key)])
async def auth_check():
    return {"ok": True}


@app.get("/api/content", dependencies=[Depends(require_api_key)])
async def get_content(prefix: str):
    if not s3:
        raise HTTPException(status_code=500, detail="S3 client not configured")
    try:
        contents = await asyncio.to_thread(_list_all_objects, prefix)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    images: dict = {}
    videos: dict = {}
    others: list = []

    for item in contents:
        key = item["Key"]
        filename = key[len(prefix):] if key.startswith(prefix) else key
        if not filename:
            continue
        if filename.endswith("_p.webp"):
            uuid_key = filename[:-7]
            group = images.setdefault(uuid_key, {"prefix": prefix, "slug": uuid_key, "files": {}, "size": 0, "last_modified": item["LastModified"].isoformat()})
            group["files"]["preview"] = filename
            group["size"] += item["Size"]
        elif filename.endswith("_t.webp"):
            uuid_key = filename[:-7]
            group = images.setdefault(uuid_key, {"prefix": prefix, "slug": uuid_key, "files": {}, "size": 0, "last_modified": item["LastModified"].isoformat()})
            group["files"]["thumbnail"] = filename
            group["size"] += item["Size"]
        else:
            others.append({"key": key, "filename": filename, "size": item["Size"], "last_modified": item["LastModified"].isoformat()})

    final_others = []
    for other in others:
        name_no_ext = os.path.splitext(other["filename"])[0]
        ext = os.path.splitext(other["filename"])[1].lower()
        if name_no_ext in images:
            group = images[name_no_ext]
            group["files"]["original"] = other["filename"]
            group["size"] = group.get("size", 0) + other["size"]
            group["last_modified"] = other["last_modified"]
            if ext in [".mp4", ".mov", ".webm", ".mkv", ".avi"]:
                videos[name_no_ext] = images.pop(name_no_ext)
                videos[name_no_ext]["type"] = "video"
            else:
                group["type"] = "image"
        else:
            final_others.append(other)

    images_list = list(images.values())
    videos_list = list(videos.values())
    images_list.sort(key=lambda x: x.get("last_modified", ""), reverse=True)
    videos_list.sort(key=lambda x: x.get("last_modified", ""), reverse=True)
    final_others.sort(key=lambda x: x.get("last_modified", ""), reverse=True)
    return {"images": images_list, "videos": videos_list, "others": final_others, "public_url_prefix": PUBLIC_URL_PREFIX}


@app.post("/api/upload", dependencies=[Depends(require_api_key)])
async def upload_content(prefix: str = Form(...), override_filename: str = Form(None), file: UploadFile = File(...)):
    try:
        if not s3:
            raise HTTPException(status_code=500, detail="S3 client not configured")

        content = await file.read()
        file_name = file.filename or "default-filename"
        mime_type = file.content_type or mimetypes.guess_type(file_name)[0] or "application/octet-stream"
        original_ext = os.path.splitext(file_name)[1]

        is_image = mime_type.startswith("image/")
        is_video = mime_type.startswith("video/") or original_ext.lower() in [".mp4", ".mov", ".webm", ".mkv", ".avi"]

        if not (is_image or is_video):
            target_filename = override_filename if override_filename else file.filename
            file_key = f"{prefix}{target_filename}"
            await asyncio.to_thread(s3.put_object, Bucket=R2_BUCKET_NAME, Key=file_key, Body=content, ContentType=mime_type)
            return {"status": "success", "type": "other", "key": file_key}

        result = await _convert_and_store(
            content=content, mime=mime_type, original_ext=original_ext,
            original_name=file_name, prefix=prefix,
        )
        return {
            "status": "success",
            "type": "video" if is_video else "image",
            "slug": result["slug"],
            "original": result["original"],
            "preview": result["preview"],
            "thumbnail": result["thumbnail"],
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Unexpected error during upload")
        raise HTTPException(status_code=500, detail=f"Unexpected server error during upload: {e}")


@app.delete("/api/content", dependencies=[Depends(require_api_key)])
async def delete_content(key: str):
    if not s3:
        raise HTTPException(status_code=500, detail="S3 client not configured")
    try:
        await asyncio.to_thread(s3.delete_object, Bucket=R2_BUCKET_NAME, Key=key)
        return {"status": "success", "deleted": key}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/content/bulk-delete", dependencies=[Depends(require_api_key)])
async def bulk_delete_content(req: BulkDeleteRequest):
    if not s3:
        raise HTTPException(status_code=500, detail="S3 client not configured")
    if not req.keys:
        return {"deleted": [], "errors": []}
    if len(req.keys) > 1000:
        raise HTTPException(status_code=400, detail="Cannot delete more than 1000 keys per request")
    try:
        resp = await asyncio.to_thread(
            s3.delete_objects,
            Bucket=R2_BUCKET_NAME,
            Delete={"Objects": [{"Key": k} for k in req.keys], "Quiet": False},
        )
        deleted = [d["Key"] for d in resp.get("Deleted", [])]
        errors = [
            {"key": e.get("Key"), "code": e.get("Code"), "message": e.get("Message")}
            for e in resp.get("Errors", [])
        ]
        return {"deleted": deleted, "errors": errors}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------- Public endpoints ----------------

@app.get("/api/public/config")
async def public_config():
    return {
        "turnstile_site_key": TURNSTILE_SITE_KEY,
        "allowed_sites": ALLOWED_SITES,
        "max_image_bytes": MAX_PUBLIC_UPLOAD_BYTES,
        "supported_formats": sorted(SUPPORTED_FORMATS),
        "public_url_prefix": PUBLIC_URL_PREFIX,
        "pending_prefix": PENDING_PREFIX,
    }


@app.post("/api/public/image")
async def public_upload_image(
    request: Request,
    cf_turnstile_response: str = Form(...),
    file: UploadFile = File(...),
):
    await verify_turnstile(cf_turnstile_response, _client_ip(request))

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(content) > MAX_PUBLIC_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large (max {MAX_PUBLIC_UPLOAD_BYTES // (1024 * 1024)} MB)",
        )

    file_name = file.filename or "image"
    ext_with_dot = os.path.splitext(file_name)[1]
    ext_lower = ext_with_dot.lower().lstrip(".")
    if not ext_lower or ext_lower not in SUPPORTED_FORMATS:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported format: {ext_lower or '(none)'}",
        )

    mime = file.content_type or mimetypes.guess_type(file_name)[0] or ""
    if not (mime.startswith("image/") or mime.startswith("video/")):
        raise HTTPException(status_code=415, detail="Only image or video uploads are accepted")

    result = await _convert_and_store(
        content=content, mime=mime, original_ext=ext_with_dot,
        original_name=file_name, prefix=PENDING_PREFIX,
    )
    base = PUBLIC_URL_PREFIX.rstrip("/")
    return {
        "id": result["slug"],
        "ext": result["ext"],
        "urls": {
            "original": f"{base}/{result['original']}" if base else result["original"],
            "preview": f"{base}/{result['preview']}" if base else result["preview"],
            "thumbnail": f"{base}/{result['thumbnail']}" if base else result["thumbnail"],
        },
    }


@app.post("/api/public/suggestion", status_code=201)
async def public_submit_suggestion(req: PublicSuggestionRequest, request: Request):
    await verify_turnstile(req.cf_turnstile_response, _client_ip(request))

    if req.site not in ALLOWED_SITES:
        raise HTTPException(status_code=400, detail=f"Unknown site: {req.site}")

    images = []
    for img_id in req.image_ids:
        _validate_id(img_id, "image")
        ext = await asyncio.to_thread(_find_pending_image_ext_sync, img_id)
        if not ext:
            raise HTTPException(status_code=400, detail=f"Image not found in pending: {img_id}")
        images.append({"id": img_id, "ext": ext, "status": "pending", "moved_to": None})

    sid = "sug_" + secrets.token_urlsafe(8)
    suggestion = {
        "id": sid,
        "site": req.site,
        "kind": req.kind,
        "status": "pending",
        "payload": req.payload,
        "images": images,
        "submitted_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    await _write_suggestion(suggestion)

    sample_url = None
    if images and PUBLIC_URL_PREFIX:
        sample_url = f"{PUBLIC_URL_PREFIX.rstrip('/')}/{PENDING_PREFIX}{images[0]['id']}_p.webp"
    asyncio.create_task(_notify_discord(suggestion, sample_url))

    return {"id": sid}


# ---------------- Admin suggestion endpoints ----------------

@app.get("/api/suggestions", dependencies=[Depends(require_api_key)])
async def list_suggestions(site: str | None = None, status: str | None = None):
    suggestions = await _read_all_suggestions()
    if site:
        suggestions = [s for s in suggestions if s.get("site") == site]
    if status:
        suggestions = [s for s in suggestions if s.get("status") == status]
    return {"suggestions": suggestions}


@app.get("/api/suggestions/counts", dependencies=[Depends(require_api_key)])
async def suggestion_counts():
    suggestions = await _read_all_suggestions()
    counts: dict[str, dict[str, int]] = {
        site: {"pending": 0, "approved": 0, "rejected": 0} for site in ALLOWED_SITES
    }
    for s in suggestions:
        site = s.get("site")
        if not isinstance(site, str):
            continue
        status = s.get("status", "pending")
        if site not in counts:
            counts[site] = {"pending": 0, "approved": 0, "rejected": 0}
        if status in counts[site]:
            counts[site][status] += 1
    return counts


@app.get("/api/suggestions/{suggestion_id}", dependencies=[Depends(require_api_key)])
async def get_suggestion(suggestion_id: str):
    _validate_id(suggestion_id, "suggestion")
    s = await _read_suggestion(suggestion_id)
    if not s:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    return s


@app.patch("/api/suggestions/{suggestion_id}", dependencies=[Depends(require_api_key)])
async def edit_suggestion(suggestion_id: str, req: SuggestionEditRequest):
    _validate_id(suggestion_id, "suggestion")
    s = await _read_suggestion(suggestion_id)
    if not s:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    if s.get("status") != "pending":
        raise HTTPException(status_code=400, detail="Only pending suggestions can be edited")

    if req.payload is not None:
        s["payload"] = req.payload
    if req.kind is not None:
        s["kind"] = req.kind
    if req.site is not None:
        if req.site not in ALLOWED_SITES:
            raise HTTPException(status_code=400, detail=f"Unknown site: {req.site}")
        s["site"] = req.site

    await _write_suggestion(s)
    return s


async def _approve_suggestion(s: dict) -> dict:
    """Copy all pending images to the live prefix, then delete originals.
    Rolls back copies if any step fails."""
    site = s["site"]
    completed: list[tuple[str, str]] = []
    try:
        for img in s.get("images", []):
            if img.get("status") != "pending":
                continue
            img_id = img["id"]
            ext = img["ext"]
            triples = [
                (f"{PENDING_PREFIX}{img_id}{ext}", f"{site}/{img_id}{ext}"),
                (f"{PENDING_PREFIX}{img_id}_p.webp", f"{site}/{img_id}_p.webp"),
                (f"{PENDING_PREFIX}{img_id}_t.webp", f"{site}/{img_id}_t.webp"),
            ]
            for src, dst in triples:
                await asyncio.to_thread(
                    s3.copy_object,
                    CopySource={"Bucket": R2_BUCKET_NAME, "Key": src},
                    Bucket=R2_BUCKET_NAME,
                    Key=dst,
                )
                completed.append((src, dst))
            img["status"] = "approved"
            img["moved_to"] = f"{site}/{img_id}{ext}"

        for src, _ in completed:
            try:
                await asyncio.to_thread(s3.delete_object, Bucket=R2_BUCKET_NAME, Key=src)
            except Exception:
                logger.warning("Failed to delete pending source %s after approval (non-fatal)", src)

        s["status"] = "approved"
        return s
    except Exception:
        logger.exception("Approval failed mid-flight; rolling back copies")
        for _, dst in completed:
            try:
                await asyncio.to_thread(s3.delete_object, Bucket=R2_BUCKET_NAME, Key=dst)
            except Exception:
                logger.warning("Rollback delete failed for %s", dst)
        raise HTTPException(status_code=500, detail="Approval failed; rolled back")


@app.patch("/api/suggestions/{suggestion_id}/status", dependencies=[Depends(require_api_key)])
async def update_suggestion_status(suggestion_id: str, req: SuggestionStatusRequest):
    _validate_id(suggestion_id, "suggestion")
    s = await _read_suggestion(suggestion_id)
    if not s:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    if s.get("status") != "pending":
        raise HTTPException(status_code=400, detail="Suggestion already finalized")

    if req.status == "approved":
        s = await _approve_suggestion(s)
    else:
        s["status"] = "rejected"

    await _write_suggestion(s)
    return s


@app.delete(
    "/api/suggestions/{suggestion_id}/images/{image_id}",
    dependencies=[Depends(require_api_key)],
)
async def reject_image(suggestion_id: str, image_id: str):
    _validate_id(suggestion_id, "suggestion")
    _validate_id(image_id, "image")
    s = await _read_suggestion(suggestion_id)
    if not s:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    if s.get("status") != "pending":
        raise HTTPException(status_code=400, detail="Cannot modify images on finalized suggestion")

    img = next((i for i in s.get("images", []) if i.get("id") == image_id), None)
    if not img:
        raise HTTPException(status_code=404, detail="Image not in suggestion")
    if img.get("status") != "pending":
        raise HTTPException(status_code=400, detail=f"Image already {img.get('status')}")

    keys = [
        f"{PENDING_PREFIX}{image_id}{img['ext']}",
        f"{PENDING_PREFIX}{image_id}_p.webp",
        f"{PENDING_PREFIX}{image_id}_t.webp",
    ]
    try:
        await asyncio.to_thread(
            s3.delete_objects,
            Bucket=R2_BUCKET_NAME,
            Delete={"Objects": [{"Key": k} for k in keys], "Quiet": True},
        )
    except Exception:
        # TTL will eventually clean these up if delete fails here.
        logger.exception("Failed to delete rejected image files (non-fatal)")

    img["status"] = "rejected"
    await _write_suggestion(s)
    return s


@app.delete("/api/suggestions/{suggestion_id}", dependencies=[Depends(require_api_key)])
async def delete_suggestion(suggestion_id: str):
    _validate_id(suggestion_id, "suggestion")
    s = await _read_suggestion(suggestion_id)
    if not s:
        raise HTTPException(status_code=404, detail="Suggestion not found")

    keys_to_delete: list[str] = []
    for img in s.get("images", []):
        if img.get("status") == "approved":
            continue
        keys_to_delete.extend([
            f"{PENDING_PREFIX}{img['id']}{img['ext']}",
            f"{PENDING_PREFIX}{img['id']}_p.webp",
            f"{PENDING_PREFIX}{img['id']}_t.webp",
        ])

    if keys_to_delete:
        try:
            await asyncio.to_thread(
                s3.delete_objects,
                Bucket=R2_BUCKET_NAME,
                Delete={"Objects": [{"Key": k} for k in keys_to_delete], "Quiet": True},
            )
        except Exception:
            logger.exception("Failed to delete pending images during suggestion deletion (non-fatal)")

    await asyncio.to_thread(s3.delete_object, Bucket=R2_BUCKET_NAME, Key=_suggestion_key(suggestion_id))
    return {"deleted": True, "id": suggestion_id}


# ---------------- Static ----------------

os.makedirs("static", exist_ok=True)
app.mount("/", StaticFiles(directory="static", html=True), name="static")
