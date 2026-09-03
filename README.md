# content-manager-system
A simple python and go server that manages content in an object storage bucket and optimize images before being uploaded.

## Overview

_System_

- **[Content Manager](#content-manager)**
- **[Image Converter](#webp-converter)**
- **[Metadata Removal](#metadata-removal)**

_Development_

- **[Tech Used](#tech-used)**
- **[Requirements](#requirements)**
- **[Running Source Code](#running-source-code)**

_Docker_
- **[Host Requirements](#host-requirements)**
- **[Version Guide](#version-guide)**
- **[Running with Docker](#running-with-docker)**

## System

### Content Manager

The content manager is the python part of the codebase. It is used to view, manage, upload, and delete files in an object storage bucket.

Its main part is the web interface. Here you can drag and drop files in, and set what prefix you want to work in.

It also exposes a **public suggestion API** that lets external sites (e.g. dokimotes, dokinomicon) send in suggested content / data changes for admin review. See [Public Suggestion API](#public-suggestion-api).

### Image Converter

The image converter is the golang part of the codebase located under the [webp/](/webp/) folder. It is used to extract info from the image, convert any image to webp, and strip metadata from the original.

This will only be called if the uploaded file is an image.

**Animation.** GIF and WebP animations are decoded by libvips. APNG and animated AVIF are not — PNG decoders ignore the APNG frame chunks, and libheif only reads the still image out of an AVIF, so both used to come out as a static preview. Those two formats are now decoded with ffmpeg into a stack of frames that libvips understands, so their previews and thumbnails animate like any other. Long or very large animations are cut to a frame and pixel budget (`MAX_ANIM_FRAMES`, `MAX_ANIM_PIXELS`).

**Metadata.** See [Metadata removal](#metadata-removal).

## Development

### Tech Used (content manager only)
- Python 3.12

### Requirements
- Python
- A running instance of webp-converter
- Object Storage bucket. S3 or R2.
- Any OS

### Running Source Code

**NOTE**: This is only required to run the source code. If you only want to run it and not develop it, then check out the [Docker section](#docker)

1. **Create the environment file**:
   ```bash
   cp .env.example .env
   ```
   And fill in your environment values.

2. **Create and activate a virtual environment**:
   ```bash
   python -m venv .venv
   
   # Windows
   .\.venv\Scripts\activate
   
   # macOS/Linux
   source .venv/bin/activate
   ```

3. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

4. **Run the FastAPI development server**:
   ```bash
   uvicorn main:app --reload --port 8000
   ```

The application UI will be available at [http://127.0.0.1:8000/](http://127.0.0.1:8000/).

If you want to expose the app to your network, you can use the `--host` flag:
```bash
uvicorn main:app --reload --port 8000 --host 0.0.0.0
```

### How the web UI is cached

The two HTML pages are always served with `Cache-Control: no-cache`, so browsers and
CDN edges revalidate them on every load (a cheap ETag round trip). Every script and
stylesheet URL in them carries `?v=<fingerprint>`, where the fingerprint is derived
from the size and modification time of all files under `static/` and substituted for
`__ASSET_VERSION__` when the HTML is served; an import map gives the modules' own
relative imports the same suffix. A request whose `?v=` matches the current
fingerprint is served `immutable` for a year, so a normal page load makes no asset
requests at all, while a deploy changes the fingerprint and the next HTML load pulls
the new files. Requests without the current `?v=` fall back to `no-cache`.

If Cloudflare sits in front of the app, a cache rule that bypasses the cache for the
manager's path keeps every request on the visitor's own edge (see the deployment notes
in the git history for why); browser caching is unaffected by it.

## Docker

### Host Requirements
- Any OS
- Docker and Docker Compose

If it has Docker, it can run this.

You can view the image on Dockerhub:
- [content-manager](https://hub.docker.com/r/duckautomata/content-manager)
- [webp-converter](https://hub.docker.com/r/duckautomata/webp-converter)

### Running with Docker
The easiest way to run the docker image is to
1. copy [docker-compose.yml](./docker-compose.yml) and create an `.env` file in a folder where you want to run it.
2. Ensure your `.env` file is properly configured.
   The compose file mounts `./data` into the container for the application
   database (SQLite) — back this folder up and keep the mount, or suggestions
   and pending scheduled deletions are lost when the container is recreated.
3. Start the containers:
   ```bash
   docker compose up -d
   ```
4. Stop the container:
   ```bash
   docker compose down
   ```

The application will be available at http://<server-address>:8000
The webp-converter will be available at http://<server-address>:8090

To update the image, run:
```bash
docker compose pull && docker compose up -d
```

### Image converter configuration

The `webp-converter` reads its settings from environment variables (set them in the
`environment:` block of `docker-compose.yml` — it does **not** read `.env`). All are
optional:

| Variable           | Default        | Purpose                                                      |
|--------------------|----------------|--------------------------------------------------------------|
| `PORT`             | `8080`         | Port the server listens on (compose sets `8090`).            |
| `MAX_UPLOAD_MB`    | `25`           | Max size of a single upload; larger requests get `413`.      |
| `WEBP_QUALITY`     | `75`           | WebP output quality (1–100).                                 |
| `WEBP_EFFORT`      | `4`            | WebP compression effort (0–6; higher = smaller but slower).  |
| `MAX_CONCURRENCY`  | CPU core count | Max simultaneous conversions (protects small hosts).         |
| `VIPS_CONCURRENCY` | `0`            | libvips threads per operation (`0` = libvips default).       |
| `MAX_ANIM_FRAMES`  | `300`          | Frames kept from an APNG / animated AVIF; the rest are cut.  |
| `MAX_ANIM_PIXELS`  | `50000000`     | Pixel budget across all frames of one such animation.        |

### Converter endpoints

| Method | Path                    | Purpose                                                                          |
|--------|-------------------------|----------------------------------------------------------------------------------|
| POST   | `/info`                  | Dimensions, format, hash, frame count, orientation, and what metadata it carries |
| POST   | `/convert`               | Full-size WebP (animated if the source is)                                       |
| POST   | `/thumbnail?height=N`    | WebP scaled to N pixels tall                                                     |
| POST   | `/strip`                 | The same file with its metadata removed (see below)                              |
| POST   | `/bulk?height=N`         | Zip of images in, zip of WebPs out                                               |
| GET    | `/slug?name=`            | Slug and short uuid for a name                                                   |
| GET    | `/formats`               | Accepted input extensions                                                        |

### Building new image
To build a new image with the latest tag, run
```bash
./build.sh
```
On Windows use the PowerShell equivalent (same flow: build, list, ask to push):
```powershell
.\build.ps1            # add -Push to skip the prompt, -Tag 1.2.3 for a custom tag, -DryRun to preview
```
The converter has the same pair of scripts in [webp/](./webp/).

## Metadata removal

Uploads carry more than pixels: camera model, GPS coordinates, timestamps, editing
history, XMP and IPTC records. All of it is removed, in two places:

- **The original**, before it is stored, via `POST /strip`. The file is edited at the
  container level and never re-encoded, so the stored image is bit-for-bit the one that
  was uploaded apart from the metadata. Videos are stored as uploaded.
- **The preview and thumbnail**, when they are encoded.

What is *not* removed is anything that decides how the image looks. Colour profiles,
palettes, transparency, gamma and animation control blocks all stay. Two cases get
special handling:

- **EXIF orientation** is the one descriptive tag that changes rendering. Deleting it
  alone would leave phone photos lying on their side, so the original keeps a minimal
  EXIF block holding nothing but the orientation, and the WebP versions have the
  rotation applied to the pixels instead.
- **Colour profiles** are converted rather than discarded: a wide-gamut or CMYK source
  is transformed into sRGB before its profile is dropped, so the colours a viewer sees
  do not shift.

Each strip is verified before it is used. The converter decodes the original and the
stripped copy and compares dimensions, frame count, frame height, bands, alpha,
orientation, colour profile presence and every pixel; if anything differs, or either
copy fails to decode, the original bytes are returned untouched and the reason is
reported in the `X-Strip-Note` header. This is what keeps a bug in one of the container
editors from doing what [Discord's EXIF removal did to their animated WebP
uploads](https://discord.com/blog/modern-image-formats-at-discord-supporting-webp-and-avif):
removing a chunk while leaving the container's own bookkeeping describing a file that no
longer existed.

Response headers from `/strip`: `X-Strip-Format`, `X-Strip-Changed`, `X-Strip-Verified`,
`X-Strip-Removed` (a comma-separated list such as `jpeg:exif,jpeg:xmp`), `X-Strip-Note`.

| Format          | How metadata is removed                                                                          |
|-----------------|--------------------------------------------------------------------------------------------------|
| JPEG            | EXIF, XMP, Photoshop/IPTC, comments and other `APPn` segments dropped; JFIF, ICC and the Adobe colour-transform marker kept. Anything appended after the end of the image goes too — where a phone's MPF index points, that is a second picture: the frames of a motion photo (with audio), a depth map, an HDR gain map. Reported as `jpeg:appended-images` |
| PNG / APNG      | `eXIf`, text (`tEXt`/`zTXt`/`iTXt`, where XMP lives), `tIME` and unknown chunks dropped; APNG control chunks and all colour chunks kept |
| WebP            | `EXIF` and `XMP` chunks dropped, **and** the `VP8X` feature flags and RIFF length rewritten to match — the step whose absence broke Discord's animated WebPs |
| GIF             | Comment blocks, XMP and other application extensions dropped; the NETSCAPE loop count and ICC extension kept |
| AVIF / HEIC     | EXIF and XMP item payloads overwritten in place and metadata boxes retyped to `free`, because the format addresses its own data by absolute file offset and cannot be shortened safely |
| TIFF            | Descriptive tags removed from each directory and their values zeroed, including the EXIF and GPS sub-directories |
| BMP, everything else | Left alone (nothing to remove, or the format is not understood)                             |

## Public Suggestion API

The server hosts a small public API so external sites can suggest content changes. Suggestions are queued and reviewed by an admin at `/suggestions.html` before anything is published.

### Endpoints

All public endpoints require a Cloudflare Turnstile token. CORS is restricted to `https://www.duck-automata.com` (and localhost when `ENVIRONMENT=development`).

| Method | Path                            | Body / Query                                                           | Returns                                          |
|--------|---------------------------------|------------------------------------------------------------------------|--------------------------------------------------|
| GET    | `/api/public/config`            | —                                                                      | `{turnstile_site_key, allowed_sites, max_image_bytes, supported_formats, public_url_prefix, pending_prefix}` |
| POST   | `/api/public/image`             | multipart: `cf_turnstile_response`, `file`                             | `{id, ext, urls: {original, preview, thumbnail}}` |
| POST   | `/api/public/suggestion`        | json: `{cf_turnstile_response, site, kind, payload, image_ids, summary}` | `{id}` (201)                               |
| GET    | `/api/public/suggestions/{site}` | query: `ids=sug_a,sug_b` (comma-separated, max 50)                    | `{suggestions: [{id, site, kind, status, summary, submitted_at, updated_at, admin_context}], not_found: [...]}` |

The status-lookup endpoint needs no Turnstile token or auth: suggestion ids are
unguessable tokens handed out only at submission time, so knowing an id is the
access capability. Suggester sites should tell users to save their id (or store
it in localStorage) so they can check progress and read any admin feedback
(`admin_context`) later.

The `{site}` path segment scopes the lookup: ids belonging to a different site
come back in `not_found`, so a site can pass its whole saved id list without
surfacing another site's suggestions. An unknown site is a `404`.

`summary` is a short (≤300 char) human-readable line describing what the
suggestion asked for, so the submitter can tell their suggestions apart. The
submitting site should send it; when omitted, the server derives one from the
`kind` plus a `name`/`title`/`label`/`display_name`/`slug`/`id` key in the
payload (e.g. `"Add pogduck"`). Admins can rewrite it at any time — in any
status — with the **Summary** button on a card at `/suggestions.html`, or
via `PATCH /api/suggestions/{id}`. Saving an empty value re-derives it from the
current payload.

**Suggestion `kind`:**
- `new` — adding a new entity (e.g., a new emote)
- `edit` — editing an existing entity (replace/remove images, change fields, etc.)
- `delete` — requesting deletion of an entity

**Suggestion `status`:**
- `pending` — awaiting admin review
- `approved` — accepted; images moved to the live prefix (work may still be in progress)
- `completed` — approved *and* the change is done/live on the site
- `rejected` — declined

**Storage:**

Suggestion records live in a local SQLite database (`DB_PATH`, default
`data/suggestions.db`; mounted as the `./data` volume in docker-compose). Image
files stay in R2:

```
_suggestions/
  _pending/
    {img_id}.{ext}                     # original (TTL'd 30d)
    {img_id}_p.webp                    # preview
    {img_id}_t.webp                    # thumbnail

{site}/                                # live, no TTL
  {img_id}.{ext}                       # moved here on suggestion approval
  {img_id}_p.webp
  {img_id}_t.webp
```

On startup, any suggestion JSON objects still in R2 (legacy `_suggestions/{id}.json`
or `_suggestions/{site}/{status}/...json` layouts) are imported into the database
and then removed from the bucket.

**Pending uploads view.** The manager's site row ends with a **Pending uploads**
tab (also linked from the suggestions page) that lists `_suggestions/_pending/`.
Its media is split into **Not in any suggestion** — uploaded through the public API
but never attached to a suggestion, i.e. abandoned submissions or abuse — and **In a
suggestion**, where each tile carries the suggestion id and the preview dialog links
to it. Captions show the upload age; the filter box matches suggestion ids too.
Uploads are disabled in this view. The grouping comes from
`GET /api/suggestions/image-refs`.

### Performance & benchmark logging

Approving a suggestion copies every pending image's three files (original,
preview, thumbnail) to the live prefix **concurrently** and then removes the
pending originals with a single batch delete, so approval time stays roughly
flat as the image count grows. The same applies to uploads (preview/thumbnail
conversion and the three R2 puts run in parallel) and to the per-image pending
checks at submission time. `R2_OP_CONCURRENCY` (default `16`) caps how many R2
object operations a single request runs at once.

Slow paths log a one-line `[bench]` breakdown of where the time went:

```
INFO:content-manager:[bench] approve sug_x site=dokimotes images=4 total=812ms read_db=2ms copy=655ms delete_pending=118ms write_db=3ms
INFO:content-manager:[bench] convert+store a1b2c3.png bytes=52341 total=1204ms slug=35ms convert=890ms upload=270ms
INFO:content-manager:[bench] submit sug_y site=dokimotes images=2 total=310ms lookup_images=280ms write_db=4ms
```

### R2 lifecycle rule

Set a 30-day delete rule on the prefix `_suggestions/_pending/`. In the Cloudflare dashboard: **R2 → bucket → Settings → Object lifecycle rules → Add rule**, scope to prefix `_suggestions/_pending/`, action: delete after 30 days. Suggestion records themselves are in the local database, not R2, so they are unaffected and kept forever as an audit trail.

### Delayed deletion

Deleting media from the manager can be deferred ("delete in 30 days") so a CDN
cache has time to expire before the files actually go away. Each pending job —
its id, target keys, due time, and the label shown in the UI — is a row in the
`scheduled_deletes` table of the database. A background sweep runs every
`SCHEDULED_DELETE_POLL_SECONDS` (default 60), deletes the R2 objects of every job
whose due time has passed, and drops the row. If the R2 delete fails the row is
kept, so the next sweep retries rather than silently losing the job.

Because the jobs are database rows, R2 holds nothing but the media files and the
CSVs. Keep `./data` mounted or pending deletions are lost on container recreation.

On startup, any leftover markers from the older R2-backed layout
(`_scheduled_deletes/{due}__{id}.json`) are imported into the table and removed
from the bucket, so no pending deletion is dropped by upgrading. The import is
idempotent and can be re-run safely; a marker that can't be parsed is left in the
bucket and logged rather than discarded.

### Spreadsheet (CSV) sources

`CSV_SOURCES` maps a bucket prefix to the Google Sheet tabs whose CSV export should
overwrite files under it. Each referenced tab must be link-accessible ("anyone with
the link"); `gid` is the tab id from the sheet URL (`.../edit#gid=<gid>`).

```
CSV_SOURCES={"dokinomicon":[{"file":"data.csv","id":"<sheet-id>","gid":"0"}]}
```

That powers the manager's **Data files** panel, which is pinned above the media on
any prefix with sources configured. Each data file row shows its row and column
count, size and last-modified time, and offers:

- **View** — opens the file in the in-app viewer (a sortable, searchable table for
  CSV/TSV, plain text for other text files). The viewer reads straight from the
  bucket through `GET /api/content/preview`, never from the CDN, so what you see is
  exactly what the sites will fetch next. Row counts skip blank lines and exclude
  the header row (the scheduled sync's safety check also skips blank lines but
  counts the header, so its "row count fell from" numbers run one higher).
- **Open sheet** — opens the Google Sheet tab the file is exported from in a new tab.
- **Update from spreadsheet** — downloads each configured tab and overwrites the
  matching file, then reports per file what changed (rows before → after, or
  "unchanged" when the content is identical) and flags a drop of 50% or more.

Other text files in a prefix (`.json`, `.txt`, `.md`, …) get the same **View** action.

#### Automatic sync

Set `CSV_AUTO_SYNC_DAYS` to a positive number and the server re-syncs every
configured prefix on its own, every N days at **12:00 America/New_York** (noon ET,
following daylight saving). `0` — the default — leaves syncing manual-only.

The scheduled path is deliberately more cautious than the button, because nobody is
watching it. For each prefix it downloads **every** file and checks all of them
before writing **any** of them; if a single check fails, that prefix is left
completely untouched and the failure goes to `DISCORD_WEBHOOK`. A rejected sync is
not retried early — it waits for the next slot — so a broken sheet can't spam the
webhook. Other prefixes are unaffected by one prefix failing.

A download is rejected when it:

- fails to fetch (non-200, network error, empty body, or an HTML login page — the
  usual sign a sheet stopped being link-accessible),
- isn't valid UTF-8 or doesn't parse as CSV, or has no rows / an empty header,
- has a **different header row** than the file it would replace (a column added,
  removed, or renamed upstream),
- **shrank** below `CSV_AUTO_SYNC_MIN_RATIO` (default `0.5`) of the live file's row
  count or byte size — the signature of a half-exported or cleared sheet.

The last two only apply when there's a live file to compare against, so the first
sync of a new file always goes through. If the live file can't be read at all, the
sync is refused rather than overwriting it blind. Lower `CSV_AUTO_SYNC_MIN_RATIO` if
one of your sheets legitimately shrinks a lot in a single edit.

The "last run" timestamp lives in the `app_state` table of the suggestions database,
so the interval survives container restarts — keep `./data` mounted. On first start
(or if the container was down through a slot) the next run is the upcoming noon ET,
not immediately on boot.

### Cloudflare Turnstile setup

1. Cloudflare dashboard → **Turnstile** → **Add site**.
2. Domain: `duck-automata.com` (covers all subpaths).
3. Widget mode: **Managed**.
4. Save. Copy the **Site Key** (public) and **Secret Key** (server-only) into `.env`:
   ```
   TURNSTILE_SITE_KEY=...
   TURNSTILE_SECRET_KEY=...
   ```
5. On the suggester site (e.g. dokimotes), add the widget script `https://challenges.cloudflare.com/turnstile/v0/api.js` and render with the site key. Submit the rendered token in the `cf_turnstile_response` field of the API request.
6. In dev, leaving `TURNSTILE_SECRET_KEY` empty + `ENVIRONMENT=development` bypasses verification so you can test without the widget.

### Cloudflare rate limiting

Cloudflare dashboard → **Security → WAF → Rate limiting rules** → Create rule:
- **Field**: URI Path, **Operator**: starts with, **Value**: `/api/public/`
- **Rate**: e.g. 10 requests per 1 minute per IP
- **Action**: Block (or Managed Challenge)

### Admin endpoints (X-API-KEY required)

Content (used by the manager page):

| Method | Path                                          | Purpose                                                  |
|--------|-----------------------------------------------|----------------------------------------------------------|
| GET    | `/api/content?prefix=`                        | Grouped listing: `images`, `videos`, `others`, `public_url_prefix`, `common_prefixes`, and `csv_sources` as `[{file, sheet_url}]` for the prefix |
| GET    | `/api/content/preview?key=`                   | Parsed contents of a text-ish object for the in-app viewer. CSV/TSV → `{kind: "table", header, rows, total_rows, truncated, row_limit, …}` (first 5000 rows); other text → `{kind: "text", text, total_chars, truncated}`. Also `size`, `last_modified`, `etag`, `encoding`. `404` missing, `413` over 8 MB, `415` binary/unsupported, `422` unparseable CSV. Successful responses carry `Cache-Control: no-store`. |
| POST   | `/api/content/sync-csv?prefix=`               | Re-download the prefix's configured sheet tabs → `{updated, errors}` |
| POST   | `/api/upload`                                 | multipart `prefix`, `file`, optional `override_filename` |
| DELETE | `/api/content?key=`                           | Delete one object                                        |
| POST   | `/api/content/bulk-delete`                    | `{keys}` — delete up to 1000 objects                     |
| POST   | `/api/content/schedule-delete`                | `{keys, delay_seconds, label, prefix}` — delayed delete  |
| GET    | `/api/scheduled-deletes?prefix=`              | Pending delayed deletes                                  |
| DELETE | `/api/scheduled-deletes/{id}`                 | Cancel a delayed delete                                  |

Suggestions:

| Method | Path                                                       | Purpose                                                  |
|--------|------------------------------------------------------------|----------------------------------------------------------|
| GET    | `/api/suggestions?site=&status=&limit=`                    | List newest-first (filters optional; `limit` default 200, max 1000). Returns `{suggestions, total, truncated}` |
| GET    | `/api/suggestions/counts`                                  | `{site: {pending, approved, rejected, completed}}` for tabs |
| GET    | `/api/suggestions/image-refs`                              | `{image_id: [{suggestion_id, site, status, image_status, moved_to, submitted_at}]}` for every image any suggestion mentions (drives the pending-uploads grouping) |
| GET    | `/api/suggestions/{id}`                                    | Get single suggestion                                    |
| GET    | `/api/suggestions/{id}/images.zip`                         | All the suggestion's original image files as one zip, each entry named `{image_id}{ext}`. Missing files are skipped and listed in the `X-Skipped-Images` header. |
| PATCH  | `/api/suggestions/{id}`                                    | Edit `payload` / `kind` / `site` (only while pending). `admin_context` (feedback shown to the suggester) and `summary` are editable at any time. |
| PATCH  | `/api/suggestions/{id}/status`                             | `{status: "approved" \| "rejected" \| "completed"}` — approve moves images to live prefix; only approved suggestions can be completed |
| DELETE | `/api/suggestions/{id}/images/{imgId}`                     | Reject one image (deletes pending files; only while suggestion is pending) |
| DELETE | `/api/suggestions/{id}`                                    | Delete suggestion + non-approved pending images          |

