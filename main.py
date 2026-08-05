import asyncio
import csv
import hashlib
import io
import json
import logging
import mimetypes
import os
import re
import secrets
import sqlite3
import tempfile
import zipfile
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import boto3
import httpx
from botocore.exceptions import ClientError
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("content-manager")

# ---------------- Configuration ----------------

ENVIRONMENT = os.environ.get("ENVIRONMENT", "production")
R2_ENDPOINT_URL = os.environ.get("R2_ENDPOINT_URL")
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY")
R2_BUCKET_NAME = os.environ.get("R2_BUCKET_NAME")
S3_CONFIGURED = all([R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME])
CONVERSION_SERVICE_URL = os.environ.get("CONVERSION_SERVICE_URL", "http://webp-converter:8090")
PUBLIC_URL_PREFIX = os.environ.get("PUBLIC_URL_PREFIX", "")
API_KEY = os.environ.get("API_KEY")

ALLOWED_SITES = [s.strip() for s in os.environ.get("ALLOWED_SITES", "").split(",") if s.strip()]
# Frequently visited prefixes shown in the manager's "Go to" dropdown. Each is
# normalized to end with a single "/".
COMMON_PREFIXES = [
    p.strip().rstrip("/") + "/"
    for p in os.environ.get("COMMON_PREFIXES", "home,dokimotes,dokinomicon,dokimosaic").split(",")
    if p.strip()
]


def _load_csv_sources() -> dict:
    """Parse CSV_SOURCES (a JSON object) mapping a prefix to the Google Sheet
    tabs whose CSV export should overwrite files under that prefix. Shape:

        {"dokinomicon": [{"file": "data.csv", "id": "<sheet-id>", "gid": "0"}]}

    Prefix keys are normalized to end with "/". Malformed config disables the
    feature rather than crashing the app.
    """
    raw = os.environ.get("CSV_SOURCES", "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("CSV_SOURCES is not valid JSON; spreadsheet sync disabled")
        return {}
    sources: dict = {}
    for prefix, entries in (data or {}).items():
        key = prefix.strip().rstrip("/") + "/"
        cleaned = [
            {"file": e["file"], "id": e["id"], "gid": str(e.get("gid", "0"))}
            for e in entries
            if e.get("file") and e.get("id")
        ]
        if cleaned:
            sources[key] = cleaned
    return sources


# Prefix -> list of Google Sheet CSV sources for the "Update from spreadsheet" button.
CSV_SOURCES = _load_csv_sources()
# Unattended re-sync of every CSV_SOURCES entry, every N days at CSV_AUTO_SYNC_HOUR
# in CSV_AUTO_SYNC_TZ. 0 (the default) leaves syncing manual-only.
CSV_AUTO_SYNC_DAYS = int(os.environ.get("CSV_AUTO_SYNC_DAYS", "0"))
CSV_AUTO_SYNC_HOUR = 12
CSV_AUTO_SYNC_TZ_NAME = "America/New_York"
# A scheduled sync refuses to overwrite a live file whose replacement dropped
# below this fraction of its rows or bytes — a half-exported or accidentally
# cleared sheet should never land on top of good data.
CSV_AUTO_SYNC_MIN_RATIO = float(os.environ.get("CSV_AUTO_SYNC_MIN_RATIO", "0.5"))
# How often the scheduler re-checks the clock while waiting for the next slot.
CSV_AUTO_SYNC_TICK_SECONDS = 300
CSV_AUTO_SYNC_STATE_KEY = "csv_auto_sync_last_run"

try:
    CSV_AUTO_SYNC_TZ: ZoneInfo | None = ZoneInfo(CSV_AUTO_SYNC_TZ_NAME)
except ZoneInfoNotFoundError:
    # No tz database in the image. Guessing UTC would fire at the wrong hour, so
    # stay off instead.
    CSV_AUTO_SYNC_TZ = None
    logger.warning(
        "Time zone %s unavailable (install the tzdata package); CSV auto-sync disabled",
        CSV_AUTO_SYNC_TZ_NAME,
    )
TURNSTILE_ENABLED = os.environ.get("TURNSTILE_ENABLED", "true").strip().lower() in ("true", "1", "yes", "on")
TURNSTILE_SECRET_KEY = os.environ.get("TURNSTILE_SECRET_KEY")
TURNSTILE_SITE_KEY = os.environ.get("TURNSTILE_SITE_KEY", "")
DISCORD_WEBHOOK = os.environ.get("DISCORD_WEBHOOK", "")
ADMIN_URL = os.environ.get("ADMIN_URL", "")
IMAGE_UPLOAD_NOTIFY_INTERVAL_SECONDS = int(os.environ.get("IMAGE_UPLOAD_NOTIFY_INTERVAL_SECONDS", "600"))

MAX_PUBLIC_UPLOAD_BYTES = 50 * 1024 * 1024
MAX_PUBLIC_PAYLOAD_BYTES = 10 * 1024 * 1024
MAX_SUGGESTION_IMAGE_IDS = 1000
MAX_PUBLIC_STATUS_IDS = 50
MAX_SUGGESTION_SUMMARY_CHARS = 300
# Bulk image download: keep small zips in memory, spill bigger ones to disk, and
# refuse absurd ones outright rather than filling the container's disk.
SUGGESTION_ZIP_SPOOL_BYTES = 64 * 1024 * 1024
SUGGESTION_ZIP_MAX_BYTES = 1024 * 1024 * 1024
SUGGESTIONS_PAGE_LIMIT = 200
DB_PATH = os.environ.get("DB_PATH", "data/suggestions.db")
SUGGESTIONS_PREFIX = "_suggestions/"
PENDING_PREFIX = "_suggestions/_pending/"
# Delayed-delete jobs live in the scheduled_deletes table. This prefix is only
# still read to drain markers left by the older R2-backed layout.
SCHEDULED_DELETE_PREFIX = "_scheduled_deletes/"
SCHEDULED_DELETE_POLL_SECONDS = int(os.environ.get("SCHEDULED_DELETE_POLL_SECONDS", "60"))
MAX_DELETE_DELAY_SECONDS = 366 * 24 * 3600  # ~1 year ceiling
MIN_DELETE_DELAY_SECONDS = 60
TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
# Cloudflare's published always-pass test pair, used when a localhost origin is opted in via EXTRA_CORS_ORIGINS.
TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA"
TURNSTILE_TEST_SECRET_KEY = "1x0000000000000000000000000000000AA"
_LOCALHOST_ORIGIN_RE = re.compile(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$")

SUPPORTED_FORMATS_FALLBACK = frozenset({
    "jpg", "jpeg", "png", "apng", "gif", "webp", "avif", "heic", "heif",
    "tiff", "tif", "bmp", "mp4", "mov", "webm", "mkv", "avi",
})
SUPPORTED_FORMATS: frozenset[str] = SUPPORTED_FORMATS_FALLBACK

if not API_KEY:
    logger.warning("API_KEY not set. All admin API requests will be rejected.")
if not ALLOWED_SITES:
    logger.warning("ALLOWED_SITES not set. Public suggestion API will reject all submissions.")
if not TURNSTILE_ENABLED:
    logger.warning("TURNSTILE_ENABLED=false. Public endpoints will accept any request without captcha verification.")


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

    if S3_CONFIGURED:
        try:
            migrated = await asyncio.to_thread(_migrate_r2_suggestions_sync)
            if migrated:
                logger.info("Migrated %d suggestion(s) from R2 into the local database", migrated)
        except Exception:
            logger.exception("R2 suggestion migration failed")

        try:
            migrated = await asyncio.to_thread(_migrate_r2_scheduled_deletes_sync)
            if migrated:
                logger.info("Migrated %d scheduled delete(s) from R2 into the local database", migrated)
        except Exception:
            logger.exception("R2 scheduled-delete migration failed")

    rollup_task: asyncio.Task | None = None
    if IMAGE_UPLOAD_NOTIFY_INTERVAL_SECONDS > 0 and DISCORD_WEBHOOK:
        rollup_task = asyncio.create_task(_upload_rollup_loop())
        logger.info(
            "Image upload rollup enabled, interval=%ds",
            IMAGE_UPLOAD_NOTIFY_INTERVAL_SECONDS,
        )

    sweep_task: asyncio.Task | None = None
    if S3_CONFIGURED and SCHEDULED_DELETE_POLL_SECONDS > 0:
        sweep_task = asyncio.create_task(_scheduled_delete_loop())
        logger.info("Scheduled-delete sweep enabled, poll=%ds", SCHEDULED_DELETE_POLL_SECONDS)

    csv_sync_task: asyncio.Task | None = None
    if S3_CONFIGURED and CSV_AUTO_SYNC_DAYS > 0 and CSV_SOURCES and CSV_AUTO_SYNC_TZ is not None:
        csv_sync_task = asyncio.create_task(_csv_auto_sync_loop())
        logger.info(
            "CSV auto-sync enabled, every %d day(s) at %02d:00 %s, %d prefix(es)",
            CSV_AUTO_SYNC_DAYS,
            CSV_AUTO_SYNC_HOUR,
            CSV_AUTO_SYNC_TZ_NAME,
            len(CSV_SOURCES),
        )
    elif CSV_AUTO_SYNC_DAYS > 0 and not CSV_SOURCES:
        logger.warning("CSV_AUTO_SYNC_DAYS is set but CSV_SOURCES is empty; auto-sync disabled")

    try:
        yield
    finally:
        if csv_sync_task is not None:
            csv_sync_task.cancel()
            try:
                await csv_sync_task
            except asyncio.CancelledError:
                pass
        if sweep_task is not None:
            sweep_task.cancel()
            try:
                await sweep_task
            except asyncio.CancelledError:
                pass
        if rollup_task is not None:
            rollup_task.cancel()
            try:
                await rollup_task
            except asyncio.CancelledError:
                pass
            await _flush_upload_counter()


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
    if not S3_CONFIGURED:
        logger.warning("R2 credentials missing. S3 operations will fail.")
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


_SUGGESTION_STATUSES = ("pending", "approved", "rejected", "completed")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# Suggestions live in a local SQLite database (payload/images stored as JSON
# columns). Image files — pending and approved — stay in R2; only the
# suggestion records moved out of the bucket.

def _db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def _init_db() -> None:
    db_dir = os.path.dirname(DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)
    conn = _db_connect()
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        with conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS suggestions (
                    id TEXT PRIMARY KEY,
                    site TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    payload TEXT NOT NULL DEFAULT '{}',
                    images TEXT NOT NULL DEFAULT '[]',
                    admin_context TEXT NOT NULL DEFAULT '',
                    summary TEXT NOT NULL DEFAULT '',
                    submitted_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_suggestions_site_status"
                " ON suggestions (site, status, submitted_at)"
            )
            # Small key/value scratchpad for background jobs that must remember
            # something across restarts (currently the CSV auto-sync anchor).
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS app_state (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )
            # Pending "delete these keys later" jobs. due_at is a fixed-width
            # UTC ISO stamp, so the sweep can select due rows with a plain
            # string compare.
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS scheduled_deletes (
                    id TEXT PRIMARY KEY,
                    prefix TEXT NOT NULL DEFAULT '',
                    label TEXT NOT NULL DEFAULT '',
                    target_keys TEXT NOT NULL DEFAULT '[]',
                    due_at TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_scheduled_deletes_due ON scheduled_deletes (due_at)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_scheduled_deletes_prefix ON scheduled_deletes (prefix, due_at)"
            )
            # Added after the table shipped; older databases need the column.
            columns = {r["name"] for r in conn.execute("PRAGMA table_info(suggestions)")}
            if "summary" not in columns:
                conn.execute(
                    "ALTER TABLE suggestions ADD COLUMN summary TEXT NOT NULL DEFAULT ''"
                )
    finally:
        conn.close()


_init_db()


def _iso_z(dt: datetime) -> str:
    """UTC ISO stamp with no sub-second part, so stored timestamps are all the
    same width and sort/compare correctly as plain strings."""
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _get_app_state(key: str) -> str | None:
    conn = _db_connect()
    try:
        row = conn.execute("SELECT value FROM app_state WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None
    finally:
        conn.close()


def _set_app_state(key: str, value: str) -> None:
    conn = _db_connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO app_state (key, value) VALUES (?, ?)"
                " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )
    finally:
        conn.close()


# Payload keys, in priority order, that tend to name the thing a suggestion is
# about. Only consulted when the submitting site sent no summary.
_SUMMARY_PAYLOAD_KEYS = ("name", "title", "label", "display_name", "slug", "id")
_SUMMARY_VERBS = {"new": "Add", "edit": "Edit", "delete": "Delete"}
_SUMMARY_FALLBACKS = {
    "new": "Add a new item",
    "edit": "Edit an existing item",
    "delete": "Delete an item",
}


def _derive_summary(kind: str, payload: dict) -> str:
    """Best-effort one-liner for suggestions stored without a summary
    (rows predating the field, or sites that don't send one)."""
    for key in _SUMMARY_PAYLOAD_KEYS:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            verb = _SUMMARY_VERBS.get(kind, kind)
            return f"{verb} {value.strip()}"[:MAX_SUGGESTION_SUMMARY_CHARS]
    return _SUMMARY_FALLBACKS.get(kind, f"{kind} suggestion")


def _row_to_suggestion(row: sqlite3.Row) -> dict:
    payload = json.loads(row["payload"])
    kind = row["kind"]
    return {
        "id": row["id"],
        "site": row["site"],
        "kind": kind,
        "status": row["status"],
        "payload": payload,
        "images": json.loads(row["images"]),
        "admin_context": row["admin_context"],
        "summary": row["summary"] or _derive_summary(kind, payload),
        "submitted_at": row["submitted_at"],
        "updated_at": row["updated_at"],
    }


def _suggestion_row_params(s: dict) -> dict:
    return {
        "id": s["id"],
        "site": s["site"],
        "kind": s["kind"],
        "status": s["status"],
        "payload": json.dumps(s.get("payload", {})),
        "images": json.dumps(s.get("images", [])),
        "admin_context": s.get("admin_context", ""),
        "summary": s.get("summary", ""),
        "submitted_at": s["submitted_at"],
        "updated_at": s.get("updated_at") or s["submitted_at"],
    }


_SUGGESTION_COLUMNS_SQL = (
    "(id, site, kind, status, payload, images, admin_context, summary, submitted_at, updated_at)"
    " VALUES (:id, :site, :kind, :status, :payload, :images, :admin_context, :summary, :submitted_at, :updated_at)"
)
_SUGGESTION_UPSERT_SQL = f"""
    INSERT INTO suggestions {_SUGGESTION_COLUMNS_SQL}
    ON CONFLICT(id) DO UPDATE SET
        site = excluded.site,
        kind = excluded.kind,
        status = excluded.status,
        payload = excluded.payload,
        images = excluded.images,
        admin_context = excluded.admin_context,
        summary = excluded.summary,
        updated_at = excluded.updated_at
"""
_SUGGESTION_INSERT_IGNORE_SQL = f"INSERT OR IGNORE INTO suggestions {_SUGGESTION_COLUMNS_SQL}"


def _read_suggestion_sync(suggestion_id: str) -> dict | None:
    conn = _db_connect()
    try:
        row = conn.execute(
            "SELECT * FROM suggestions WHERE id = ?", (suggestion_id,)
        ).fetchone()
    finally:
        conn.close()
    return _row_to_suggestion(row) if row else None


async def _read_suggestion(suggestion_id: str) -> dict | None:
    return await asyncio.to_thread(_read_suggestion_sync, suggestion_id)


def _read_suggestions_bulk_sync(ids: list[str]) -> list[dict]:
    if not ids:
        return []
    placeholders = ",".join("?" for _ in ids)
    conn = _db_connect()
    try:
        rows = conn.execute(
            f"SELECT * FROM suggestions WHERE id IN ({placeholders})", ids
        ).fetchall()
    finally:
        conn.close()
    return [_row_to_suggestion(r) for r in rows]


def _write_suggestion_sync(s: dict) -> None:
    conn = _db_connect()
    try:
        with conn:
            conn.execute(_SUGGESTION_UPSERT_SQL, _suggestion_row_params(s))
    finally:
        conn.close()


async def _write_suggestion(s: dict) -> None:
    s["updated_at"] = _utc_now_iso()
    await asyncio.to_thread(_write_suggestion_sync, s)


def _delete_suggestion_sync(suggestion_id: str) -> None:
    conn = _db_connect()
    try:
        with conn:
            conn.execute("DELETE FROM suggestions WHERE id = ?", (suggestion_id,))
    finally:
        conn.close()


def _count_suggestions_sync() -> dict[str, dict[str, int]]:
    conn = _db_connect()
    try:
        rows = conn.execute(
            "SELECT site, status, COUNT(*) AS n FROM suggestions GROUP BY site, status"
        ).fetchall()
    finally:
        conn.close()
    counts: dict[str, dict[str, int]] = {}
    for row in rows:
        bucket = counts.setdefault(row["site"], {st: 0 for st in _SUGGESTION_STATUSES})
        if row["status"] in bucket:
            bucket[row["status"]] += row["n"]
    return counts


def _list_suggestions_sync(
    site: str | None, status: str | None, limit: int
) -> tuple[list[dict], int]:
    """Newest-first suggestions for the given filters. Returns (page, total)."""
    clauses: list[str] = []
    params: list = []
    if site:
        clauses.append("site = ?")
        params.append(site)
    if status:
        clauses.append("status = ?")
        params.append(status)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    conn = _db_connect()
    try:
        total = conn.execute(
            f"SELECT COUNT(*) FROM suggestions{where}", params
        ).fetchone()[0]
        rows = conn.execute(
            f"SELECT * FROM suggestions{where} ORDER BY submitted_at DESC LIMIT ?",
            [*params, limit],
        ).fetchall()
    finally:
        conn.close()
    return [_row_to_suggestion(r) for r in rows], total


def _migrate_r2_suggestions_sync() -> int:
    """Import suggestion JSON objects from R2 (legacy flat and site/status
    layouts) into the local database, deleting each R2 copy after a successful
    import. Idempotent: an id already in the database is left untouched, but its
    stale R2 object is still removed. Pending image files are skipped."""
    paginator = s3.get_paginator("list_objects_v2")
    migrated = 0
    conn = _db_connect()
    try:
        for page in paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix=SUGGESTIONS_PREFIX):
            for obj in page.get("Contents", []):
                key = obj["Key"]
                if key.startswith(PENDING_PREFIX) or not key.endswith(".json"):
                    continue
                try:
                    resp = s3.get_object(Bucket=R2_BUCKET_NAME, Key=key)
                    s = json.loads(resp["Body"].read())
                    if not s.get("id") or not s.get("site"):
                        logger.warning("Skipping malformed suggestion object %s", key)
                        continue
                    s.setdefault("kind", "new")
                    s.setdefault("status", "pending")
                    if not s.get("submitted_at"):
                        s["submitted_at"] = obj["LastModified"].isoformat().replace("+00:00", "Z")
                    with conn:
                        conn.execute(_SUGGESTION_INSERT_IGNORE_SQL, _suggestion_row_params(s))
                    s3.delete_object(Bucket=R2_BUCKET_NAME, Key=key)
                    migrated += 1
                except Exception:
                    logger.exception("Failed to migrate suggestion %s", key)
    finally:
        conn.close()
    return migrated


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


def _image_object_key(img: dict) -> str:
    """Bucket key of an image's original file. Approved images have been moved
    out of the pending prefix into the site's live prefix."""
    if img.get("status") == "approved" and img.get("moved_to"):
        return img["moved_to"]
    return f"{PENDING_PREFIX}{img['id']}{img['ext']}"


def _zip_suggestion_images_sync(images: list[dict]) -> tuple[tempfile.SpooledTemporaryFile, list[str]]:
    """Zip every image's original file, each entry named `{image_id}{ext}`.
    Objects that are gone — pending uploads past the bucket's 30-day TTL, say —
    are skipped and their ids returned alongside the archive."""
    spool = tempfile.SpooledTemporaryFile(max_size=SUGGESTION_ZIP_SPOOL_BYTES)
    skipped: list[str] = []
    total = 0
    try:
        # Stored, not deflated: these are already-compressed webp/jpeg/video
        # bytes, so compressing again costs CPU for no meaningful size win.
        with zipfile.ZipFile(spool, "w", zipfile.ZIP_STORED) as zf:
            for img in images:
                key = _image_object_key(img)
                try:
                    body = s3.get_object(Bucket=R2_BUCKET_NAME, Key=key)["Body"].read()
                except Exception:
                    logger.warning("Skipping missing image object %s", key)
                    skipped.append(img["id"])
                    continue
                total += len(body)
                if total > SUGGESTION_ZIP_MAX_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Images exceed the {SUGGESTION_ZIP_MAX_BYTES // (1024 ** 3)} GB download limit",
                    )
                zf.writestr(f"{img['id']}{img['ext']}", body)
        spool.seek(0)
        return spool, skipped
    except Exception:
        spool.close()
        raise


# ---------------- Turnstile ----------------

def _client_ip(request: Request) -> str | None:
    return request.headers.get("CF-Connecting-IP") or (
        request.client.host if request.client else None
    )


def _use_test_turnstile(request: Request) -> bool:
    """Localhost origins explicitly opted into EXTRA_CORS_ORIGINS use the always-pass test key pair,
    so devs can exercise the real widget locally without the prod site key (which is hostname-bound)."""
    origin = request.headers.get("Origin")
    if not origin or not _LOCALHOST_ORIGIN_RE.match(origin):
        return False
    return origin in extra_cors


async def verify_turnstile(
    token: str | None,
    remote_ip: str | None = None,
    *,
    use_test_keys: bool = False,
) -> None:
    if not TURNSTILE_ENABLED:
        return
    secret = TURNSTILE_TEST_SECRET_KEY if use_test_keys else TURNSTILE_SECRET_KEY
    if not secret:
        if ENVIRONMENT == "development":
            logger.info("Turnstile bypass: ENVIRONMENT=development and no secret configured")
            return
        raise HTTPException(status_code=500, detail="Turnstile not configured")
    if not token:
        raise HTTPException(status_code=400, detail="Missing Turnstile token")
    data = {"secret": secret, "response": token}
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

_upload_counter: dict[str, int] = {}
_upload_counter_lock = asyncio.Lock()
_ip_hash_salt = secrets.token_bytes(16)

# Hold references to fire-and-forget tasks so the event loop can't GC them mid-flight.
_background_tasks: set[asyncio.Task] = set()


def _hash_ip(ip: str) -> str:
    return hashlib.sha256(_ip_hash_salt + ip.encode("utf-8")).hexdigest()[:12]


def _format_window(seconds: int) -> str:
    if seconds < 60:
        return f"{seconds}s"
    if seconds % 60 == 0:
        return f"{seconds // 60} min"
    return f"{seconds / 60:.1f} min"


async def _record_image_upload(ip: str | None) -> None:
    if IMAGE_UPLOAD_NOTIFY_INTERVAL_SECONDS <= 0 or not DISCORD_WEBHOOK:
        return
    key = _hash_ip(ip) if ip else "unknown"
    async with _upload_counter_lock:
        _upload_counter[key] = _upload_counter.get(key, 0) + 1


async def _flush_upload_counter() -> None:
    async with _upload_counter_lock:
        if not _upload_counter:
            return
        snapshot = dict(_upload_counter)
        _upload_counter.clear()

    total = sum(snapshot.values())
    top = sorted(snapshot.items(), key=lambda kv: kv[1], reverse=True)[:10]
    breakdown = "\n".join(f"`{client}` — {count}" for client, count in top)
    if len(snapshot) > len(top):
        breakdown += f"\n... and {len(snapshot) - len(top)} more"

    embed = {
        "title": "Image upload activity",
        "color": 0x57F287,
        "description": (
            f"{total} upload(s) in the last {_format_window(IMAGE_UPLOAD_NOTIFY_INTERVAL_SECONDS)} "
            f"from {len(snapshot)} unique client(s)."
        ),
        "fields": [{"name": "Top clients (hashed)", "value": breakdown}],
    }
    try:
        async with httpx.AsyncClient() as client:
            await client.post(DISCORD_WEBHOOK, json={"embeds": [embed]}, timeout=10)
    except Exception:
        logger.exception("Discord upload rollup delivery failed")


async def _upload_rollup_loop() -> None:
    while True:
        try:
            await asyncio.sleep(IMAGE_UPLOAD_NOTIFY_INTERVAL_SECONDS)
            await _flush_upload_counter()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Upload rollup loop iteration failed")


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
    if summary := suggestion.get("summary"):
        embed["description"] = summary
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


class ScheduleDeleteRequest(BaseModel):
    keys: list[str]
    delay_seconds: int
    label: str | None = None
    prefix: str | None = None


class PublicSuggestionRequest(BaseModel):
    cf_turnstile_response: str = ""
    site: str
    kind: Literal["new", "edit", "delete"]
    payload: dict = Field(default_factory=dict)
    image_ids: list[str] = Field(default_factory=list, max_length=MAX_SUGGESTION_IMAGE_IDS)
    # Short human-readable summary shown back to the submitter on status lookup.
    # Derived from the payload when the site omits it.
    summary: str = Field(default="", max_length=MAX_SUGGESTION_SUMMARY_CHARS)

    @field_validator("payload")
    @classmethod
    def _payload_within_limit(cls, v: dict) -> dict:
        if len(json.dumps(v).encode("utf-8")) > MAX_PUBLIC_PAYLOAD_BYTES:
            raise ValueError(
                f"payload too large (max {MAX_PUBLIC_PAYLOAD_BYTES // (1024 * 1024)} MB)"
            )
        return v


class SuggestionEditRequest(BaseModel):
    payload: dict | None = None
    kind: Literal["new", "edit", "delete"] | None = None
    site: str | None = None
    admin_context: str | None = Field(default=None, max_length=5000)
    summary: str | None = Field(default=None, max_length=MAX_SUGGESTION_SUMMARY_CHARS)


class SuggestionStatusRequest(BaseModel):
    status: Literal["approved", "rejected", "completed"]


# ---------------- Existing admin endpoints ----------------

@app.get("/api/auth/check", dependencies=[Depends(require_api_key)])
async def auth_check():
    return {"ok": True}


@app.get("/api/content", dependencies=[Depends(require_api_key)])
async def get_content(prefix: str):
    if not S3_CONFIGURED:
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
    csv_sources = [e["file"] for e in CSV_SOURCES.get(prefix.rstrip("/") + "/", [])]
    return {"images": images_list, "videos": videos_list, "others": final_others, "public_url_prefix": PUBLIC_URL_PREFIX, "common_prefixes": COMMON_PREFIXES, "csv_sources": csv_sources}


@app.post("/api/upload", dependencies=[Depends(require_api_key)])
async def upload_content(prefix: str = Form(...), override_filename: str = Form(None), file: UploadFile = File(...)):
    try:
        if not S3_CONFIGURED:
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


async def _download_csv_export(client: httpx.AsyncClient, entry: dict) -> tuple[bytes | None, str | None]:
    """Fetch one sheet tab's CSV export. Returns (body, error); exactly one is set."""
    url = f"https://docs.google.com/spreadsheets/d/{entry['id']}/export?format=csv&gid={entry['gid']}"
    try:
        resp = await client.get(url)
    except Exception as ex:
        return None, str(ex)
    if resp.status_code != 200:
        return None, f"HTTP {resp.status_code}"
    # A private sheet redirects to an HTML login page instead of CSV.
    if "text/html" in resp.headers.get("content-type", "").lower():
        return None, "Got HTML, not CSV — is the sheet link-accessible?"
    if not resp.content:
        return None, "Empty response"
    return resp.content, None


def _read_csv_rows(body: bytes) -> list[list[str]]:
    """Parse CSV bytes into rows, dropping blank ones. Raises on bad input."""
    text = body.decode("utf-8-sig")
    return [row for row in csv.reader(io.StringIO(text, newline="")) if any(c.strip() for c in row)]


def _fetch_live_csv(storage_key: str) -> tuple[bytes | None, str | None]:
    """Read the CSV currently in the bucket. Returns (body, error). A missing
    object is (None, None) — the first sync has nothing to compare against — but
    a transient read failure is an error, so we never mistake "can't read it" for
    "it isn't there" and skip the safety checks."""
    try:
        obj = s3.get_object(Bucket=R2_BUCKET_NAME, Key=storage_key)
        return obj["Body"].read(), None
    except ClientError as ex:
        code = ex.response.get("Error", {}).get("Code", "")
        if code in ("NoSuchKey", "404", "NotFound"):
            return None, None
        return None, f"could not read live file: {code or ex}"
    except Exception as ex:
        return None, f"could not read live file: {ex}"


def _validate_csv_replacement(body: bytes, live: bytes | None) -> str | None:
    """Sanity-check a freshly downloaded CSV against the file it would replace.
    Returns a reason to reject, or None when the replacement looks trustworthy."""
    try:
        rows = _read_csv_rows(body)
    except UnicodeDecodeError:
        return "not valid UTF-8"
    except csv.Error as ex:
        return f"unparseable CSV: {ex}"
    if not rows:
        return "CSV has no rows"
    header = [c.strip() for c in rows[0]]
    if not any(header):
        return "CSV header row is empty"

    if live is None:
        return None
    try:
        live_rows = _read_csv_rows(live)
    except (UnicodeDecodeError, csv.Error):
        # The live file isn't readable as CSV, so it's not a baseline worth
        # trusting. The structural checks above still applied.
        return None
    if not live_rows:
        return None

    live_header = [c.strip() for c in live_rows[0]]
    if header != live_header:
        return f"header changed: {_short_list(live_header)} -> {_short_list(header)}"
    if len(rows) < len(live_rows) * CSV_AUTO_SYNC_MIN_RATIO:
        return f"row count fell from {len(live_rows)} to {len(rows)}"
    if len(body) < len(live) * CSV_AUTO_SYNC_MIN_RATIO:
        return f"size fell from {len(live)} to {len(body)} bytes"
    return None


def _short_list(values: list[str], limit: int = 120) -> str:
    text = ", ".join(values)
    return text if len(text) <= limit else text[:limit] + "..."


async def _sync_prefix_checked(key: str, entries: list[dict]) -> tuple[list[str], list[dict]]:
    """Download and validate every CSV configured for `key` before writing any of
    them. Returns (uploaded, errors); if validation turns up a problem the errors
    are returned with nothing uploaded, leaving the live files untouched."""
    staged: list[tuple[str, bytes, str]] = []
    errors: list[dict] = []

    async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
        for e in entries:
            body, err = await _download_csv_export(client, e)
            if err:
                errors.append({"file": e["file"], "error": err})
                continue
            storage_key = f"{key}{e['file']}"
            live, read_err = await asyncio.to_thread(_fetch_live_csv, storage_key)
            if read_err:
                errors.append({"file": e["file"], "error": read_err})
                continue
            if problem := _validate_csv_replacement(body, live):
                errors.append({"file": e["file"], "error": problem})
                continue
            staged.append((storage_key, body, e["file"]))

    if errors:
        return [], errors

    uploaded: list[str] = []
    for storage_key, body, name in staged:
        try:
            await asyncio.to_thread(
                s3.put_object,
                Bucket=R2_BUCKET_NAME,
                Key=storage_key,
                Body=body,
                ContentType="text/csv",
            )
            uploaded.append(name)
        except Exception as ex:
            errors.append({"file": name, "error": f"upload failed: {ex}"})
    return uploaded, errors


async def _notify_csv_sync_failure(key: str, errors: list[dict], uploaded: list[str]) -> None:
    detail = "\n".join(f"`{x['file']}` — {x['error']}" for x in errors[:10])
    if len(errors) > 10:
        detail += f"\n... and {len(errors) - 10} more"
    if len(detail) > 1000:
        detail = detail[:1000] + "\n... (truncated)"
    logger.error("Scheduled CSV sync failed for %s: %s", key, detail.replace("\n", "; "))

    if not DISCORD_WEBHOOK:
        return
    if uploaded:
        description = (
            f"`{key}` was only partly written — the downloads passed their checks but "
            f"{len(uploaded)} file(s) uploaded before this failure. Verify the prefix."
        )
    else:
        description = f"Nothing was written under `{key}`. The live files are unchanged."

    embed: dict = {
        "title": "Scheduled CSV sync aborted",
        "color": 0xED4245,
        "description": description,
        "fields": [{"name": "Problems", "value": detail}],
    }
    if uploaded:
        embed["fields"].append({"name": "Already uploaded", "value": ", ".join(f"`{u}`" for u in uploaded[:10])})
    if ADMIN_URL:
        embed["url"] = ADMIN_URL.rstrip("/") + "/"

    try:
        async with httpx.AsyncClient() as client:
            await client.post(DISCORD_WEBHOOK, json={"embeds": [embed]}, timeout=10)
    except Exception:
        logger.exception("Discord CSV sync alert delivery failed")


async def _run_csv_auto_sync() -> None:
    """One scheduled pass over every configured prefix. Each prefix is handled
    independently, so a bad sheet in one doesn't hold up the others."""
    for key, entries in CSV_SOURCES.items():
        try:
            uploaded, errors = await _sync_prefix_checked(key, entries)
        except Exception as ex:
            logger.exception("CSV auto-sync crashed for %s", key)
            uploaded, errors = [], [{"file": "*", "error": f"unexpected error: {ex}"}]
        if errors:
            await _notify_csv_sync_failure(key, errors, uploaded)
        else:
            logger.info("CSV auto-sync updated %s: %s", key, ", ".join(uploaded) or "(nothing configured)")


def _next_csv_sync_slot(after: datetime) -> datetime:
    """The first CSV_AUTO_SYNC_HOUR local-time occurrence strictly after `after`."""
    local = after.astimezone(CSV_AUTO_SYNC_TZ)
    slot = local.replace(hour=CSV_AUTO_SYNC_HOUR, minute=0, second=0, microsecond=0)
    if slot <= local:
        slot += timedelta(days=1)
    return slot


def _csv_sync_due_after(last_run: datetime) -> datetime:
    """The slot CSV_AUTO_SYNC_DAYS after `last_run`, snapped to the target hour."""
    local = last_run.astimezone(CSV_AUTO_SYNC_TZ)
    return (local + timedelta(days=CSV_AUTO_SYNC_DAYS)).replace(
        hour=CSV_AUTO_SYNC_HOUR, minute=0, second=0, microsecond=0
    )


async def _csv_auto_sync_loop() -> None:
    now = datetime.now(timezone.utc)
    raw = await asyncio.to_thread(_get_app_state, CSV_AUTO_SYNC_STATE_KEY)
    last_run: datetime | None = None
    if raw:
        try:
            last_run = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if last_run.tzinfo is None:
                last_run = last_run.replace(tzinfo=timezone.utc)
        except ValueError:
            logger.warning("Ignoring unparseable CSV auto-sync anchor %r", raw)

    due = _csv_sync_due_after(last_run) if last_run else _next_csv_sync_slot(now)
    if due <= now:
        # First boot, or the container was down through the slot. Wait for the
        # next one rather than syncing at some arbitrary hour.
        due = _next_csv_sync_slot(now)
    logger.info("CSV auto-sync: next run at %s", due.isoformat())

    while True:
        try:
            now = datetime.now(timezone.utc)
            if now >= due:
                await _run_csv_auto_sync()
                ran_at = datetime.now(timezone.utc)
                await asyncio.to_thread(
                    _set_app_state, CSV_AUTO_SYNC_STATE_KEY, ran_at.isoformat().replace("+00:00", "Z")
                )
                due = _csv_sync_due_after(ran_at)
                if due <= ran_at:
                    due = _next_csv_sync_slot(ran_at)
                logger.info("CSV auto-sync: next run at %s", due.isoformat())
                continue
            # Tick rather than sleeping for days, so a suspended host or a clock
            # adjustment still lands on the slot instead of drifting past it.
            await asyncio.sleep(min(CSV_AUTO_SYNC_TICK_SECONDS, (due - now).total_seconds()))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("CSV auto-sync loop iteration failed")
            await asyncio.sleep(CSV_AUTO_SYNC_TICK_SECONDS)


@app.post("/api/content/sync-csv", dependencies=[Depends(require_api_key)])
async def sync_csv(prefix: str):
    """Re-download the CSV exports configured for `prefix` from Google Sheets and
    overwrite the matching files in R2. Fetches first, then uploads, so a failed
    download never clobbers the live file."""
    if not S3_CONFIGURED:
        raise HTTPException(status_code=500, detail="S3 client not configured")

    key = prefix.rstrip("/") + "/"
    entries = CSV_SOURCES.get(key)
    if not entries:
        raise HTTPException(status_code=404, detail=f"No spreadsheet sources configured for prefix '{key}'")

    updated: list = []
    errors: list = []
    async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
        for e in entries:
            body, err = await _download_csv_export(client, e)
            if err:
                errors.append({"file": e["file"], "error": err})
                continue
            try:
                await asyncio.to_thread(
                    s3.put_object,
                    Bucket=R2_BUCKET_NAME,
                    Key=f"{key}{e['file']}",
                    Body=body,
                    ContentType="text/csv",
                )
                updated.append(e["file"])
            except Exception as ex:
                errors.append({"file": e["file"], "error": f"upload failed: {ex}"})

    if errors and not updated:
        raise HTTPException(status_code=502, detail="; ".join(f"{x['file']}: {x['error']}" for x in errors))
    return {"status": "success", "updated": updated, "errors": errors}


@app.delete("/api/content", dependencies=[Depends(require_api_key)])
async def delete_content(key: str):
    if not S3_CONFIGURED:
        raise HTTPException(status_code=500, detail="S3 client not configured")
    try:
        await asyncio.to_thread(s3.delete_object, Bucket=R2_BUCKET_NAME, Key=key)
        return {"status": "success", "deleted": key}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/content/bulk-delete", dependencies=[Depends(require_api_key)])
async def bulk_delete_content(req: BulkDeleteRequest):
    if not S3_CONFIGURED:
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


# ---------------- Scheduled (delayed) deletion ----------------


def _scheduled_delete_row_to_record(row: sqlite3.Row) -> dict:
    try:
        keys = json.loads(row["target_keys"])
    except (TypeError, ValueError):
        keys = []
    return {
        "id": row["id"],
        "prefix": row["prefix"],
        "label": row["label"],
        "keys": keys if isinstance(keys, list) else [],
        "due_at": row["due_at"],
        "created_at": row["created_at"],
    }


def _insert_scheduled_delete_sync(record: dict) -> None:
    conn = _db_connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO scheduled_deletes (id, prefix, label, target_keys, due_at, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (
                    record["id"],
                    record["prefix"],
                    record["label"],
                    json.dumps(record["keys"]),
                    record["due_at"],
                    record["created_at"],
                ),
            )
    finally:
        conn.close()


def _list_scheduled_deletes_sync(prefix: str | None = None) -> list:
    """Return all pending scheduled-delete records, soonest due first. When
    `prefix` is given, only records whose target prefix matches are returned."""
    conn = _db_connect()
    try:
        if prefix:
            rows = conn.execute(
                "SELECT * FROM scheduled_deletes WHERE prefix = ? ORDER BY due_at", (prefix,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM scheduled_deletes ORDER BY due_at").fetchall()
        return [_scheduled_delete_row_to_record(r) for r in rows]
    finally:
        conn.close()


def _cancel_scheduled_delete_sync(sid: str) -> bool:
    """Drop a pending job by id. False means there was no such job."""
    conn = _db_connect()
    try:
        with conn:
            cur = conn.execute("DELETE FROM scheduled_deletes WHERE id = ?", (sid,))
        return cur.rowcount > 0
    finally:
        conn.close()


def _run_due_deletions_sync() -> int:
    """Delete the target objects of every job whose due time has passed, then drop
    the job row. Returns the number of jobs executed."""
    now = _iso_z(datetime.now(timezone.utc))
    executed = 0
    conn = _db_connect()
    try:
        # Fixed-width UTC stamps -> lexical compare is chronological.
        rows = conn.execute(
            "SELECT * FROM scheduled_deletes WHERE due_at <= ? ORDER BY due_at", (now,)
        ).fetchall()
        for row in rows:
            rec = _scheduled_delete_row_to_record(row)
            target_keys = [k for k in rec["keys"] if k]
            if target_keys:
                try:
                    s3.delete_objects(
                        Bucket=R2_BUCKET_NAME,
                        Delete={"Objects": [{"Key": k} for k in target_keys], "Quiet": True},
                    )
                except Exception:
                    # Leave the row in place so the next sweep retries it.
                    logger.exception("Failed deleting targets for scheduled delete %s", rec["id"])
                    continue
            with conn:
                conn.execute("DELETE FROM scheduled_deletes WHERE id = ?", (rec["id"],))
            executed += 1
            logger.info("Executed scheduled deletion %s (%d object(s))", rec["id"], len(target_keys))
    finally:
        conn.close()
    return executed


def _migrate_r2_scheduled_deletes_sync() -> int:
    """Import legacy scheduled-delete markers from R2 into the database, removing
    each R2 copy after a successful import. Idempotent: an id already present is
    left untouched, but its stale marker object is still cleaned up."""
    paginator = s3.get_paginator("list_objects_v2")
    migrated = 0
    conn = _db_connect()
    try:
        for page in paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix=SCHEDULED_DELETE_PREFIX):
            for obj in page.get("Contents", []):
                key = obj["Key"]
                if not key.endswith(".json"):
                    continue
                try:
                    body = s3.get_object(Bucket=R2_BUCKET_NAME, Key=key)["Body"].read()
                    rec = json.loads(body)
                    sid = rec.get("id")
                    due_at = rec.get("due_at")
                    if not sid or not due_at:
                        logger.warning("Skipping malformed scheduled-delete marker %s", key)
                        continue
                    with conn:
                        conn.execute(
                            "INSERT OR IGNORE INTO scheduled_deletes"
                            " (id, prefix, label, target_keys, due_at, created_at)"
                            " VALUES (?, ?, ?, ?, ?, ?)",
                            (
                                sid,
                                rec.get("prefix", "") or "",
                                rec.get("label", "") or "",
                                json.dumps([k for k in rec.get("keys", []) if k]),
                                due_at,
                                rec.get("created_at")
                                or obj["LastModified"].isoformat().replace("+00:00", "Z"),
                            ),
                        )
                    s3.delete_object(Bucket=R2_BUCKET_NAME, Key=key)
                    migrated += 1
                except Exception:
                    logger.exception("Failed to migrate scheduled delete %s", key)
    finally:
        conn.close()
    return migrated


async def _scheduled_delete_loop() -> None:
    while True:
        try:
            await asyncio.sleep(SCHEDULED_DELETE_POLL_SECONDS)
            await asyncio.to_thread(_run_due_deletions_sync)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Scheduled-delete sweep iteration failed")


@app.post("/api/content/schedule-delete", dependencies=[Depends(require_api_key)])
async def schedule_delete(req: ScheduleDeleteRequest):
    if not S3_CONFIGURED:
        raise HTTPException(status_code=500, detail="S3 client not configured")
    keys = [k for k in req.keys if k]
    if not keys:
        raise HTTPException(status_code=400, detail="No keys to delete")
    if len(keys) > 1000:
        raise HTTPException(status_code=400, detail="Cannot schedule more than 1000 keys per request")
    if not (MIN_DELETE_DELAY_SECONDS <= req.delay_seconds <= MAX_DELETE_DELAY_SECONDS):
        raise HTTPException(
            status_code=400,
            detail=f"delay_seconds must be between {MIN_DELETE_DELAY_SECONDS} and {MAX_DELETE_DELAY_SECONDS}",
        )

    now = datetime.now(timezone.utc)
    due = now + timedelta(seconds=req.delay_seconds)
    sid = secrets.token_hex(8)
    record = {
        "id": sid,
        "prefix": req.prefix or "",
        "label": req.label or "",
        "keys": keys,
        "due_at": _iso_z(due),
        "created_at": _iso_z(now),
    }
    await asyncio.to_thread(_insert_scheduled_delete_sync, record)
    return {"status": "scheduled", "id": sid, "due_at": record["due_at"]}


@app.get("/api/scheduled-deletes", dependencies=[Depends(require_api_key)])
async def list_scheduled_deletes(prefix: str | None = None):
    records = await asyncio.to_thread(_list_scheduled_deletes_sync, prefix)
    return {"scheduled": records}


@app.delete("/api/scheduled-deletes/{sid}", dependencies=[Depends(require_api_key)])
async def cancel_scheduled_delete(sid: str):
    cancelled = await asyncio.to_thread(_cancel_scheduled_delete_sync, sid)
    if not cancelled:
        raise HTTPException(status_code=404, detail="Scheduled deletion not found")
    return {"status": "cancelled", "id": sid}


# ---------------- Public endpoints ----------------

@app.get("/api/public/config")
async def public_config(request: Request):
    site_key = TURNSTILE_TEST_SITE_KEY if _use_test_turnstile(request) else TURNSTILE_SITE_KEY
    return {
        "turnstile_enabled": TURNSTILE_ENABLED,
        "turnstile_site_key": site_key if TURNSTILE_ENABLED else "",
        "allowed_sites": ALLOWED_SITES,
        "max_image_bytes": MAX_PUBLIC_UPLOAD_BYTES,
        "supported_formats": sorted(SUPPORTED_FORMATS),
        "public_url_prefix": PUBLIC_URL_PREFIX,
        "pending_prefix": PENDING_PREFIX,
    }


@app.post("/api/public/image")
async def public_upload_image(
    request: Request,
    cf_turnstile_response: str = Form(""),
    file: UploadFile = File(...),
):
    await verify_turnstile(
        cf_turnstile_response, _client_ip(request),
        use_test_keys=_use_test_turnstile(request),
    )

    # Reject oversized uploads before reading the spooled file into memory.
    if file.size is not None and file.size > MAX_PUBLIC_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large (max {MAX_PUBLIC_UPLOAD_BYTES // (1024 * 1024)} MB)",
        )
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
    await _record_image_upload(_client_ip(request))
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
    await verify_turnstile(
        req.cf_turnstile_response, _client_ip(request),
        use_test_keys=_use_test_turnstile(request),
    )

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
        "admin_context": "",
        "summary": req.summary.strip() or _derive_summary(req.kind, req.payload),
        "submitted_at": _utc_now_iso(),
    }
    await _write_suggestion(suggestion)

    sample_url = None
    if images and PUBLIC_URL_PREFIX:
        sample_url = f"{PUBLIC_URL_PREFIX.rstrip('/')}/{PENDING_PREFIX}{images[0]['id']}_p.webp"
    task = asyncio.create_task(_notify_discord(suggestion, sample_url))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)

    return {"id": sid}


@app.get("/api/public/suggestions/{site}")
async def public_suggestion_status(site: str, ids: str):
    """Status lookup for submitters who saved their suggestion id(s). Ids are
    unguessable tokens handed out at submission time and act as the access
    capability, so reads need no captcha or auth. `ids` is comma-separated.
    Ids belonging to another site are reported as not found, so a site can hand
    the endpoint its whole saved id list without surfacing another site's data."""
    if site not in ALLOWED_SITES:
        raise HTTPException(status_code=404, detail=f"Unknown site: {site}")

    id_list = list(dict.fromkeys(i.strip() for i in ids.split(",") if i.strip()))
    if not id_list:
        raise HTTPException(status_code=400, detail="No ids provided")
    if len(id_list) > MAX_PUBLIC_STATUS_IDS:
        raise HTTPException(status_code=400, detail=f"Too many ids (max {MAX_PUBLIC_STATUS_IDS})")
    for sid in id_list:
        _validate_id(sid, "suggestion")

    found = {
        s["id"]: s
        for s in await asyncio.to_thread(_read_suggestions_bulk_sync, id_list)
        if s["site"] == site
    }
    suggestions = [
        {
            "id": s["id"],
            "site": s["site"],
            "kind": s["kind"],
            "status": s["status"],
            "summary": s["summary"],
            "submitted_at": s["submitted_at"],
            "updated_at": s["updated_at"],
            "admin_context": s["admin_context"],
        }
        for sid in id_list
        if (s := found.get(sid))
    ]
    not_found = [sid for sid in id_list if sid not in found]
    return {"suggestions": suggestions, "not_found": not_found}


# ---------------- Admin suggestion endpoints ----------------

@app.get("/api/suggestions", dependencies=[Depends(require_api_key)])
async def list_suggestions(
    site: str | None = None,
    status: str | None = None,
    limit: int = SUGGESTIONS_PAGE_LIMIT,
):
    limit = max(1, min(limit, 1000))
    suggestions, total = await asyncio.to_thread(_list_suggestions_sync, site, status, limit)
    return {"suggestions": suggestions, "total": total, "truncated": total > len(suggestions)}


@app.get("/api/suggestions/counts", dependencies=[Depends(require_api_key)])
async def suggestion_counts():
    counts = await asyncio.to_thread(_count_suggestions_sync)
    for site in ALLOWED_SITES:
        counts.setdefault(site, {st: 0 for st in _SUGGESTION_STATUSES})
    return counts


@app.get("/api/suggestions/{suggestion_id}", dependencies=[Depends(require_api_key)])
async def get_suggestion(suggestion_id: str):
    _validate_id(suggestion_id, "suggestion")
    s = await _read_suggestion(suggestion_id)
    if not s:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    return s


@app.get("/api/suggestions/{suggestion_id}/images.zip", dependencies=[Depends(require_api_key)])
async def download_suggestion_images(suggestion_id: str):
    """All of a suggestion's original image files in one archive, each entry
    named after its image id. Ids whose files no longer exist are listed in the
    X-Skipped-Images response header rather than failing the download."""
    _validate_id(suggestion_id, "suggestion")
    if not S3_CONFIGURED:
        raise HTTPException(status_code=500, detail="S3 client not configured")

    s = await _read_suggestion(suggestion_id)
    if not s:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    images = s.get("images", [])
    if not images:
        raise HTTPException(status_code=404, detail="Suggestion has no images")

    spool, skipped = await asyncio.to_thread(_zip_suggestion_images_sync, images)
    if len(skipped) == len(images):
        spool.close()
        raise HTTPException(status_code=404, detail="No image files remain for this suggestion")

    def _stream():
        try:
            while chunk := spool.read(256 * 1024):
                yield chunk
        finally:
            spool.close()

    headers = {"Content-Disposition": f'attachment; filename="{suggestion_id}.zip"'}
    if skipped:
        headers["X-Skipped-Images"] = ",".join(skipped)
    return StreamingResponse(_stream(), media_type="application/zip", headers=headers)


@app.patch("/api/suggestions/{suggestion_id}", dependencies=[Depends(require_api_key)])
async def edit_suggestion(suggestion_id: str, req: SuggestionEditRequest):
    _validate_id(suggestion_id, "suggestion")
    s = await _read_suggestion(suggestion_id)
    if not s:
        raise HTTPException(status_code=404, detail="Suggestion not found")

    content_edit = any(v is not None for v in (req.payload, req.kind, req.site))
    if content_edit and s.get("status") != "pending":
        raise HTTPException(status_code=400, detail="Only pending suggestions can be edited")

    if req.payload is not None:
        s["payload"] = req.payload
    if req.kind is not None:
        s["kind"] = req.kind
    if req.site is not None:
        if req.site not in ALLOWED_SITES:
            raise HTTPException(status_code=400, detail=f"Unknown site: {req.site}")
        s["site"] = req.site
    # Admin feedback and the summary are editable at any time, including
    # after finalization — neither changes what the suggestion asks for.
    if req.admin_context is not None:
        s["admin_context"] = req.admin_context
    if req.summary is not None:
        # Clearing it re-derives from the (possibly just-updated) kind/payload,
        # so the stored summary is never empty.
        s["summary"] = req.summary.strip() or _derive_summary(s["kind"], s["payload"])

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

    if req.status == "completed":
        if s.get("status") != "approved":
            raise HTTPException(status_code=400, detail="Only approved suggestions can be marked completed")
        s["status"] = "completed"
    else:
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
        logger.exception("Failed to delete removed image files (non-fatal)")

    s["images"] = [i for i in s.get("images", []) if i.get("id") != image_id]
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

    await asyncio.to_thread(_delete_suggestion_sync, suggestion_id)
    return {"deleted": True, "id": suggestion_id}


# ---------------- Static ----------------

os.makedirs("static", exist_ok=True)
app.mount("/", StaticFiles(directory="static", html=True), name="static")
