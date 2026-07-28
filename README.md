# content-manager-system
A simple python and go server that manages content in an object storage bucket and optimize images before being uploaded.

## Overview

_System_

- **[Content Manager](#content-manager)**
- **[Image Converter](#webp-converter)**

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

The image converter is the golang part of the codebase located under the [webp/](/webp/) folder. It is used to extract info from the image and convert any image to webp.

This will only be called if the uploaded file is an image.

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
   The compose file mounts `./data` into the container for the suggestion
   database (SQLite) — back this folder up and keep the mount, or suggestions
   are lost when the container is recreated.
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

### Building new image
To build a new image with the latest tag, run
```bash
./build.sh
```

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

### R2 lifecycle rule

Set a 30-day delete rule on the prefix `_suggestions/_pending/`. In the Cloudflare dashboard: **R2 → bucket → Settings → Object lifecycle rules → Add rule**, scope to prefix `_suggestions/_pending/`, action: delete after 30 days. Suggestion records themselves are in the local database, not R2, so they are unaffected and kept forever as an audit trail.

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

| Method | Path                                                       | Purpose                                                  |
|--------|------------------------------------------------------------|----------------------------------------------------------|
| GET    | `/api/suggestions?site=&status=&limit=`                    | List newest-first (filters optional; `limit` default 200, max 1000). Returns `{suggestions, total, truncated}` |
| GET    | `/api/suggestions/counts`                                  | `{site: {pending, approved, rejected, completed}}` for tabs |
| GET    | `/api/suggestions/{id}`                                    | Get single suggestion                                    |
| GET    | `/api/suggestions/{id}/images.zip`                         | All the suggestion's original image files as one zip, each entry named `{image_id}{ext}`. Missing files are skipped and listed in the `X-Skipped-Images` header. |
| PATCH  | `/api/suggestions/{id}`                                    | Edit `payload` / `kind` / `site` (only while pending). `admin_context` (feedback shown to the suggester) and `summary` are editable at any time. |
| PATCH  | `/api/suggestions/{id}/status`                             | `{status: "approved" \| "rejected" \| "completed"}` — approve moves images to live prefix; only approved suggestions can be completed |
| DELETE | `/api/suggestions/{id}/images/{imgId}`                     | Reject one image (deletes pending files; only while suggestion is pending) |
| DELETE | `/api/suggestions/{id}`                                    | Delete suggestion + non-approved pending images          |

