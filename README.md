# RskMedia

A self-hosted media gallery with S3-backed storage, designed for fast browsing on phones and desktop browsers over local Wi-Fi or the public internet.

The application serves photos and videos through a local proxy, streams partial content with HTTP Range, and ships with a token-based authentication system, an admin panel for content management, perceptual duplicate detection, and JSON database backups.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Database Schema](#database-schema)
- [API Reference](#api-reference)
- [Security Model](#security-model)
- [Performance](#performance)
- [Admin Panel](#admin-panel)
- [Development](#development)
- [Deployment Notes](#deployment-notes)
- [License](#license)

---

## Overview

RskMedia is a Node.js / Express application that stores binary media in an S3-compatible bucket and keeps relational metadata (categories, subcategories, age ratings, favorites, perceptual hashes, tokens) in PostgreSQL.

The frontend is vanilla JavaScript with hand-written CSS — no React, no bundler, no build step. The same codebase serves the gallery, the favorites page, the login page, and the admin panel.

The application is built around four ideas:

1. **Local-first media access** — media is served through a `/media/:type/:id` proxy on the same Node server, which avoids cross-network firewall/CORS issues when clients are on phones connected to different Wi-Fi networks than the S3 endpoint.
2. **HTTP Range streaming** — videos and large images stream as `206 Partial Content`, so seeking works in the in-browser player without downloading the whole file.
3. **Token-based access control** — there are no passwords. Admins issue opaque tokens (`client_<32hex>` or `admin_<32hex>`); the token is bcrypt-hashed server-side, the issued JWT is itself bcrypt-hashed on the server, and logout invalidates the session by clearing the JWT hash.
4. **Operational tooling** — the admin panel includes backup/restore, duplicate detection, batch editing, statistics, and token lifecycle management.

---

## Features

### Gallery

- Infinite-scroll grid with URL-synced filters (category, subcategory, age rating, sort)
- Search by media key, category name, or subcategory name
- Fullscreen media viewer with keyboard navigation (`←`, `→`, `Esc`), touch swipe, and pinch-zoom + drag-pan for images
- Progressive image upgrade — thumbnails are replaced by the 1920 px display variant when the card enters the viewport (with a fade transition to avoid flicker)
- Auto-hide controls in the viewer after 3 s of mouse/touch/keyboard inactivity
- Favorites — per-card heart button, batch-check API for the grid view, dedicated `/favorites` page
- Age rating badge on every card and in the viewer

### Admin Panel

Seven tabs, all behind `admin_` token role:

| Tab | What it does |
|-----|--------------|
| **Upload** | Single-file upload with XHR progress bar, drag-and-drop batch upload with concurrency limit, per-file progress, and cancel button |
| **Batch Edit** | Infinite-scroll grid of all media with inline category / subcategory / age dropdowns; bulk select-and-apply or bulk delete |
| **Categories** | Create, rename, and delete categories and subcategories; refuses to delete a category that still has media or subcategories |
| **Tokens** | Create new tokens (client or admin), toggle active, set expiry, delete (cannot delete your own session) |
| **Backup** | Download a JSON snapshot of all five tables (tokens are exported without the `jwt_hash` field); restore from a previously downloaded JSON with structural and type validation |
| **Duplicates** | Trigger a perceptual-hash scan (64-bit dHash via `sharp`, LSH bucketing, Hamming distance ≤ 10) and visually inspect duplicate groups |
| **Stats** | Six aggregate tables: type breakdown, age distribution, category/subcategory counts, missing-metadata report, recent uploads (24 h / 7 d / 30 d) |

### Media Proxy

- `GET /media/:type/:id` and `HEAD /media/:type/:id` where `type` is `thumb`, `display`, or `original`
- Full HTTP Range support — `bytes=START-END`, `bytes=START-`, `bytes=-SUFFIX`, returns `416` for invalid ranges
- In-memory LRU cache for files ≤ 5 MB (≤ 500 entries, 1 h TTL)
- In-flight request deduplication — concurrent requests for the same key share a single S3 fetch
- HEAD requests return only metadata, no body
- Large files stream directly from S3 without buffering
- Cached content is served from RAM as a `Buffer.slice` for sub-millisecond responses

### Operational

- Database initialization with idempotent migrations (`scripts/init-db.js`)
- First-run bootstrap: creates an admin token and prints the plaintext to the console once
- Backfill script for legacy `file_size` column (`scripts/populate-file-sizes.js`)

---

## Tech Stack

### Backend

| Layer | Technology |
|-------|------------|
| Runtime | Node.js ≥ 18 |
| HTTP framework | Express 4 |
| View engine | EJS 3 (server-rendered, no SPA) |
| Database | PostgreSQL (via `pg`) |
| Object storage | S3-compatible (AWS SDK v3) |
| Image processing | `sharp` — resize, thumbnail, dHash grayscale |
| Video processing | `fluent-ffmpeg` — validation (`ffprobe`) and thumbnail extraction |
| Uploads | `multer` — disk storage with size limits |
| Auth | `jsonwebtoken` + `bcryptjs` |
| Security | `helmet` (CSP with nonces), `express-rate-limit`, custom CSRF middleware |
| Logging | `morgan` |
| Compression | `compression` (gzip) |

### Frontend

| Layer | Technology |
|-------|------------|
| Markup | EJS templates with partials (`<%- include %>`) |
| CSS | Hand-written, organized into 5 files (`base`, `layout`, `components`, `pages`, `style` import hub) |
| JavaScript | Vanilla ES modules — no bundler, no transpiler |
| Icons | Lucide (vendored `lucide.min.js`) |
| Fonts | Inter + Space Grotesk (Google Fonts) |

### Dev

| Tool | Purpose |
|------|---------|
| `nodemon` | Auto-restart during development (`npm run dev`) |

---

## Architecture

```
                ┌─────────────────────────────────────────────┐
                │               Browser                       │
                │  (gallery, viewer, admin panel)             │
                └────────────┬────────────────────────────────┘
                             │ HTTPS / HTTP
                             │
                ┌────────────▼────────────────────────────────┐
                │            Express app                      │
                │  ┌──────────────────────────────────────┐   │
                │  │  Helmet (CSP nonce)                  │   │
                │  │  CORS · Cookie parser · Compression  │   │
                │  │  CSRF middleware                     │   │
                │  │  Rate limiters (api/upload/admin)    │   │
                │  └──────────────────────────────────────┘   │
                │                                             │
                │  /api/auth     /api/media     /api/admin    │
                │  /api/categories               /api/favorites
                │  /media/:type/:id  (Range-aware S3 proxy)    │
                └────────┬──────────────────────────┬─────────┘
                         │                          │
                  ┌──────▼──────┐            ┌──────▼──────┐
                  │ PostgreSQL  │            │  S3 bucket  │
                  │ (metadata,  │            │  (binary    │
                  │  tokens,    │            │  media)     │
                  │  favorites) │            │             │
                  └─────────────┘            └─────────────┘
```

The server binds to `0.0.0.0:3000` so the same instance is reachable from the LAN (phones on the same Wi-Fi) and from the public internet (behind a reverse proxy if desired). On startup the server logs both the loopback URL and the LAN IP.

---

## Project Structure

```
RskMedia/
├── app.js                       Express bootstrap, middleware chain, route mounting
├── package.json
├── .env.example                 Template for required environment variables
│
├── config/
│   ├── constants.js             SORT_MAP, AGE_RATINGS, SIGN_URL_EXPIRES
│   ├── database.js              pg.Pool + query/transaction helpers
│   └── s3.js                    S3 client, signed-URL LRU cache, getObjectStream
│
├── controllers/
│   ├── authController.js        Token login, logout (revokes JWT hash)
│   ├── mediaController.js       List, search, upload (single+batch), update, delete
│   ├── categoryController.js    Categories & subcategories CRUD
│   ├── favoritesController.js   Add, remove, check, batch-check
│   └── adminController.js       Tokens, stats, backup/restore, duplicate detection
│
├── middleware/
│   ├── auth.js                  JWT verification + signed-cookie auth
│   ├── admin.js                 requireAdmin guard
│   ├── csrf.js                  Double-submit cookie CSRF
│   ├── nonce.js                 CSP nonce generator (16-byte base64)
│   ├── rateLimiter.js           apiLimiter, uploadLimiter, adminLimiter, authLimiter
│   └── validate.js              express-validator result extractor
│
├── models/
│   ├── user.js                  Token lookup, bcrypt compare
│   ├── media.js                 List, search, create, update, delete, counts
│   ├── category.js              Category CRUD + media count
│   ├── subcategory.js           Subcategory CRUD by category
│   └── favorites.js             Add, remove, check, batch-check
│
├── routes/
│   ├── auth.js                  POST /login, POST /logout
│   ├── media.js                 GET, search, upload, batch-update, batch-delete, DELETE
│   ├── categories.js            CRUD for categories & subcategories
│   ├── favorites.js             GET, POST, DELETE, batch-check
│   ├── admin.js                 Tokens, media, stats, backup, restore, find-duplicates
│   └── mediaProxy.js            Range-aware S3 media streaming
│
├── helpers/
│   ├── mime.js                  MIME → extension map
│   └── fileValidator.js         Magic-byte content validation
│
├── scripts/
│   ├── init-db.js               CREATE TABLE migrations + seed admin token
│   └── populate-file-sizes.js   Backfill file_size from S3 HeadObject
│
├── views/
│   ├── main.ejs                 Gallery page
│   ├── login.ejs                Token login page
│   ├── favorites.ejs            Favorites page
│   ├── admin.ejs                Admin panel (7 tabs)
│   ├── error.ejs                Generic error / 404 page
│   └── partials/
│       ├── header.ejs           <head>, lucide, RSK_USER_TYPE, csrf-token meta
│       ├── navbar.ejs           Fixed nav with role-aware links
│       ├── footer.ejs           Body close + footer.js
│       └── gallery.ejs          Filter bar, media grid, modal, edit panel
│
├── public/
│   ├── css/
│   │   ├── style.css            @import hub
│   │   ├── base.css             Variables, reset, scrollbar, animations
│   │   ├── layout.css           Navbar, grid, filters, breakpoints
│   │   ├── components.css       Cards, modal, toast, progress, badges, confirm
│   │   └── pages.css            Login, admin, edit panel, duplicates UI
│   └── js/
│       ├── main.js              auth, api, toast, categories, favorites
│       ├── constants.js         AGE_RATINGS export
│       ├── player.js            Gallery, viewer, zoom/pan, idle, edit, delete
│       ├── admin.js             Admin tabs, upload, batch edit, tokens, backup
│       ├── login.js             Login form handler
│       ├── navbar.js            lucide.createIcons init
│       ├── footer.js            Final lucide.createIcons call
│       └── lucide.min.js        Vendored Lucide icon library
│
└── uploads/
    └── .gitkeep                 Multer temp destination
```

---

## Quick Start

### Prerequisites

- Node.js 18 or newer
- PostgreSQL 12 or newer
- An S3-compatible bucket (AWS S3, Beget Cloud, MinIO, etc.)
- `ffmpeg` and `ffprobe` on the `$PATH` if you intend to upload video files

### 1. Clone and install

```bash
git clone https://github.com/schwf3xlr/RskMedia.git
cd RskMedia
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — see Configuration section below
```

### 3. Initialize the database

```bash
npm run init-db
```

This creates the schema, seeds the default categories, and **prints a freshly generated admin token to stdout exactly once**. Save it — it is the only time the plaintext token is shown.

### 4. Start the server

```bash
npm start          # production
npm run dev        # nodemon, auto-restart
```

### 5. Open the app

The server prints both URLs on startup:

```
Local:   http://localhost:3000
Network: http://192.168.x.x:3000
```

Navigate to the local URL, click the login link, and paste the admin token you saved in step 3.

---

## Configuration

All configuration is read from environment variables (`.env` in development).

### Server

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP listen port |
| `NODE_ENV` | `development` | Affects logging, cache headers, error verbosity |
| `TRUST_PROXY` | `1` | Express `trust proxy` hop count (set to your reverse proxy depth) |
| `CORS_ORIGIN` | `http://localhost:3000` | Allowed CORS origin (set to `false` to disable) |

### Security

| Variable | Default | Purpose |
|----------|---------|---------|
| `COOKIE_SECRET` | — | **Required**, ≥ 32 chars. Signs session cookies |
| `JWT_SECRET` | — | **Required**, ≥ 32 chars. Signs JWTs |
| `JWT_EXPIRES` | `7d` | JWT lifetime |

### Database

| Variable | Default | Purpose |
|----------|---------|---------|
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `rskmedia` | Database name |
| `DB_USER` | `postgres` | Database user |
| `DB_PASSWORD` | — | Database password |
| `DB_SSL` | `false` | Enable SSL/TLS to Postgres |

### S3

| Variable | Default | Purpose |
|----------|---------|---------|
| `S3_ENDPOINT` | `https://s3.beget.com` | S3-compatible endpoint |
| `S3_REGION` | `ru-1` | Region |
| `S3_ACCESS_KEY` | — | Access key ID |
| `S3_SECRET_KEY` | — | Secret access key |
| `S3_BUCKET` | `rskmedia` | Bucket name |
| `S3_URL_CACHE_TTL` | `3300` | Signed-URL cache TTL (seconds) |
| `S3_URL_CACHE_MAX` | `5000` | Signed-URL cache max entries |

### Uploads

| Variable | Default | Purpose |
|----------|---------|---------|
| `MAX_FILE_SIZE_MB` | `500` | Hard cap for any single file |
| `MAX_PHOTO_SIZE_MB` | `50` | Per-photo upload cap |
| `MAX_VIDEO_SIZE_MB` | `500` | Per-video upload cap |
| `MAX_BATCH_FILES` | `100` | Max files in one batch upload |

### Rate Limits

| Variable | Default | Purpose |
|----------|---------|---------|
| `API_RATE_LIMIT` | `300` | Requests per window for `/api/*` (non-admin) |
| `UPLOAD_RATE_LIMIT` | `50` | Requests per window for upload endpoints |
| `ADMIN_RATE_LIMIT` | `200` | Requests per window for admin endpoints |

### Optimizations

| Variable | Default | Purpose |
|----------|---------|---------|
| `SIGN_URL_EXPIRES` | `3600` | Presigned URL expiry (seconds) |
| `MEDIA_PAGE_SIZE` | `20` | Items per page on the main gallery |
| `ADMIN_PAGE_SIZE` | `50` | Items per page in the admin grid |
| `USE_MEDIA_PROXY` | `true` | When `true`, media is served via `/media/:type/:id`; set to `false` to use direct presigned S3 URLs |

The app **fails fast on startup** if `JWT_SECRET` or `COOKIE_SECRET` are shorter than 32 characters.

---

## Database Schema

Five tables, all defined in `scripts/init-db.js`. Foreign keys cascade on token and media deletion, and `SET NULL` on category / subcategory deletion.

### `tokens`

| Column | Type | Notes |
|--------|------|-------|
| `id` | `SERIAL PK` | |
| `token_hash` | `VARCHAR(255) UNIQUE NOT NULL` | bcrypt(12) of plaintext token |
| `jwt_hash` | `VARCHAR(255)` | bcrypt(12) of issued JWT — clearing it invalidates the session |
| `type` | `VARCHAR(10)` | `CHECK IN ('client', 'admin')` |
| `created_at` | `TIMESTAMP` | `DEFAULT NOW()` |
| `expires_at` | `TIMESTAMP` | nullable |
| `is_active` | `BOOLEAN` | `DEFAULT true` |

### `categories`

| Column | Type | Notes |
|--------|------|-------|
| `id` | `SERIAL PK` | |
| `name` | `VARCHAR(100) UNIQUE NOT NULL` | |
| `created_at` | `TIMESTAMP` | |

### `subcategories`

| Column | Type | Notes |
|--------|------|-------|
| `id` | `SERIAL PK` | |
| `category_id` | `INTEGER` | `FK categories(id) ON DELETE CASCADE` |
| `name` | `VARCHAR(100) NOT NULL` | `UNIQUE(category_id, name)` |
| `created_at` | `TIMESTAMP` | |

### `media`

| Column | Type | Notes |
|--------|------|-------|
| `id` | `SERIAL PK` | |
| `type` | `VARCHAR(5)` | `CHECK IN ('photo', 'video')` |
| `s3_key` | `VARCHAR(500) NOT NULL` | Original file |
| `thumbnail_s3_key` | `VARCHAR(500) NOT NULL` | 400 px thumbnail |
| `display_s3_key` | `VARCHAR(500)` | 1920 px display variant (nullable) |
| `file_size` | `BIGINT` | Backfilled via `scripts/populate-file-sizes.js` |
| `category_id` | `INTEGER` | `FK categories(id) ON DELETE SET NULL` |
| `subcategory_id` | `INTEGER` | `FK subcategories(id) ON DELETE SET NULL` |
| `age_rating` | `INTEGER` | `CHECK BETWEEN 0 AND 21` |
| `phash` | `NUMERIC(20,0)` | 64-bit dHash for duplicate detection |
| `uploaded_at` | `TIMESTAMP` | `DEFAULT NOW()` |

### `favorites`

| Column | Type | Notes |
|--------|------|-------|
| `id` | `SERIAL PK` | |
| `token_id` | `INTEGER` | `FK tokens(id) ON DELETE CASCADE` |
| `media_id` | `INTEGER` | `FK media(id) ON DELETE CASCADE` |
| `added_at` | `TIMESTAMP` | `DEFAULT NOW()` |
| | | `UNIQUE(token_id, media_id)` |

### Indexes

Created automatically by `init-db.js`:

- `media(uploaded_at DESC)` — for newest/oldest sort
- `media(category_id)`, `media(subcategory_id)`, `media(age_rating)`, `media(type)`
- `media(phash) WHERE phash IS NOT NULL` — partial index for duplicate lookups
- `media(category_id, age_rating, uploaded_at DESC)` — composite for filtered listing
- `favorites(token_id)`, `favorites(media_id)`, `favorites(token_id, media_id)`
- `subcategories(category_id)`, `tokens(type)`, `tokens(is_active)`

---

## API Reference

All `/api/*` routes require a valid session cookie. All write operations require a matching CSRF token in the `X-CSRF-Token` header or `_csrf` body field.

### Auth — `/api/auth`

| Method | Path | Body | Response |
|--------|------|------|----------|
| `POST` | `/login` | `{ token: "client_xxx" \| "admin_xxx" }` | `{ success, token_type, csrfToken }` |
| `POST` | `/logout` | — | `{ success }` — clears JWT hash server-side |

### Media — `/api/media`

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/` | client+ | Paginated list, query: `page`, `limit`, `category_id`, `subcategory_id`, `age_rating`, `type`, `sort` |
| `GET` | `/search` | client+ | Search by `q` plus the same filters as `/` |
| `GET` | `/:id` | client+ | Single media detail |
| `POST` | `/upload/single` | admin | `multipart/form-data` with `file` field |
| `POST` | `/upload/multiple` | admin | `multipart/form-data` with `files[]` (max 100) |
| `PUT` | `/batch-update` | admin | `{ ids: number[], category_id?, subcategory_id?, age_rating? }` |
| `POST` | `/batch-delete` | admin | `{ ids: number[] }` |
| `DELETE` | `/:id` | admin | Delete one — removes original, thumbnail, and display from S3 |

### Categories — `/api/categories`

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/` | client+ | List categories |
| `GET` | `/subcategories` | client+ | List all subcategories |
| `GET` | `/subcategories/:category_id` | client+ | Subcategories of one category |
| `POST` | `/` | admin | Create category `{ name }` |
| `POST` | `/subcategories` | admin | Create subcategory `{ category_id, name }` |
| `PUT` | `/:id` | admin | Rename category `{ name }` |
| `DELETE` | `/:id` | admin | Delete category (refuses if it still has media or subcategories) |
| `DELETE` | `/subcategories/:id` | admin | Delete subcategory |

### Favorites — `/api/favorites`

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/` | client+ | Paginated favorites with same filter/sort surface as `/api/media/` |
| `POST` | `/:media_id` | client+ | Add favorite |
| `DELETE` | `/:media_id` | client+ | Remove favorite |
| `GET` | `/check/:media_id` | client+ | `{ favorited: boolean }` |
| `POST` | `/batch-check` | client+ | `{ ids: number[] }` → `{ "1": true, "2": false, ... }` |

### Admin — `/api/admin`

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/tokens` | admin | List tokens |
| `POST` | `/tokens` | admin | Create token `{ type: 'client'\|'admin', expires_at? }` — plaintext returned once |
| `PUT` | `/tokens/:id` | admin | `{ is_active?, expires_at? }` — cannot deactivate self |
| `DELETE` | `/tokens/:id` | admin | Delete token — cannot delete self |
| `GET` | `/media` | admin | Admin media list (50/page), with `missing` filter |
| `GET` | `/stats` | admin | Six aggregate tables + summary cards |
| `GET` | `/backup` | admin | JSON stream of all five tables (tokens without `jwt_hash`) |
| `POST` | `/restore` | admin | `multipart/form-data` with `file` field — validates structure, types, then `TRUNCATE CASCADE` + re-insert + reset sequences |
| `POST` | `/find-duplicates` | admin | Compute dHash for all media, return groups with Hamming distance ≤ 10 |

### Media Proxy — `/media/:type/:id`

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/media/:type/:id` | Stream S3 media. `type` is `thumb`, `display`, or `original`. Supports `Range`. |
| `HEAD` | `/media/:type/:id` | Headers only |

---

## Security Model

### Content Security Policy

Helmet is configured with `useDefaults: false` and a hand-built CSP that injects a per-request 16-byte nonce into `script-src` and `style-src`. Image and media sources allow `https:` so signed S3 URLs (when not using the proxy) work without violating the policy.

The defaults bundle is deliberately disabled to prevent Helmet from re-injecting `upgrade-insecure-requests` or `cross-origin-*` policies that would break LAN access over plain HTTP.

### CSRF

Double-submit cookie pattern (`middleware/csrf.js`):

- A `csrf_token` cookie is set on every response (signed, httpOnly false on the response, sameSite=lax, secure in production).
- The frontend reads it from the `<meta name="csrf-token">` tag in `<head>` and sends it as `X-CSRF-Token` on every API request.
- The middleware compares the signed cookie value to the header (or `_csrf` body field) on every non-`GET`/`HEAD`/`OPTIONS` request.

### Authentication

- Tokens are generated as `<type>_<32 hex chars>` and bcrypt-hashed (12 rounds) before storage.
- On login, a JWT is signed with `JWT_SECRET` and stored in a signed httpOnly cookie.
- A bcrypt hash of the JWT is written to `tokens.jwt_hash`. Every authenticated request re-checks that the JWT hash still matches — this lets logout invalidate sessions instantly without rotating the cookie secret.
- `JWT_SECRET` and `COOKIE_SECRET` must be ≥ 32 chars; the server exits if they are not.

### Authorization

- `authenticateToken` populates `req.user` with the resolved token row.
- `requireAdmin` checks `req.user.type === 'admin'` and returns 403 otherwise.
- All `/api/admin/*` endpoints require both.

### Rate Limiting

Four `express-rate-limit` instances, applied per-route:

| Limiter | Default | Applied to |
|---------|---------|------------|
| `apiLimiter` | 300 / window | most `/api/*` |
| `uploadLimiter` | 50 / window | upload endpoints |
| `adminLimiter` | 200 / window | `/api/admin/*` |
| `authLimiter` | (default) | `/api/auth/*` |

### Input Validation

`express-validator` chains are defined inline on route handlers and extracted by `middleware/validate.js`. Uploads additionally pass through `helpers/fileValidator.js`, which inspects magic bytes to refuse MIME-type spoofing.

---

## Performance

### Image Pipeline (on upload)

1. `sharp` reads the buffer and probes metadata
2. A 400 px thumbnail is generated and uploaded as `thumbnail_s3_key`
3. If the source is wider than 1920 px, a 1920 px variant is uploaded as `display_s3_key`
4. The original is uploaded as `s3_key`

### Progressive Display (on view)

The gallery serves thumbnails immediately and swaps to the display variant only when the card enters the viewport (via `IntersectionObserver`). The swap is hidden behind a 310 ms opacity transition to avoid flicker.

### Proxy Caching

`routes/mediaProxy.js` keeps a small in-memory LRU:

- Files ≤ 5 MB are cached as `Buffer`s
- Cache holds up to 500 entries, evicted after 1 hour
- Concurrent requests for the same key share a single in-flight fetch
- Range requests bypass the cache and stream directly from S3

### Signed URL Caching

`config/s3.js` keeps an LRU of presigned URLs (default: 5 000 entries, 55 min TTL) to avoid the cost of re-signing identical URLs on every page load.

### Indexes

All filterable columns are indexed, and the most common listing pattern (`category_id` + `age_rating` + `ORDER BY uploaded_at DESC`) is covered by a composite index.

---

## Admin Panel

Path: `/admin`. Requires an `admin_` token.

```
┌─ Загрузка ──────┬─ Редактирование ─┬─ Категории ─┬─ Токены ─┬─ Бэкап ─┬─ Дубликаты ─┬─ Статистика ─┐
│ drag-drop       │ infinite-scroll   │ tag UI      │ table    │ download│ perceptual  │ 6 aggregate  │
│ XHR progress    │ inline dropdowns  │ CRUD        │ CRUD     │ / upload│ hash groups │ tables +     │
│ batch + cancel  │ bulk select-apply │ cascading   │ expiry   │ JSON    │ visual      │ summary      │
│                 │ bulk delete       │ delete guard│ self-     │         │ preview     │ cards        │
│                 │                   │             │ protect  │         │             │              │
```

---

## Development

### Scripts

| Command | What it does |
|---------|--------------|
| `npm start` | Run with `node app.js` |
| `npm run dev` | Run with `nodemon` — auto-restart on file changes |
| `npm run init-db` | Idempotent — creates schema if missing, runs migrations, seeds categories, prints bootstrap admin token |

### Code Style

- CommonJS on the backend (`require` / `module.exports`)
- ES Modules in the frontend (`type="module"`)
- No transpiler — native browser ES2022 is assumed
- No bundler — files are served directly from `public/`
- CSS is split by concern: variables and reset in `base.css`, page layout in `layout.css`, reusable widgets in `components.css`, page-specific overrides in `pages.css`

### Logging

`morgan('dev')` in development, `morgan('combined')` in production. Errors are logged by the central error handler in `app.js` and return JSON for `/api/*` requests or render `error.ejs` for page requests (message hidden in production).

---

## Deployment Notes

- **Listen address**: the server binds to `0.0.0.0`, so it accepts connections on every interface. Behind a reverse proxy (nginx, Caddy), set `TRUST_PROXY` to the number of hops so Express sees the real client IP.
- **TLS**: the application does not terminate TLS itself. Run it behind a reverse proxy or a managed platform that does.
- **`uploads/`**: the Multer temp directory. Safe to delete between restarts; files are streamed to S3 during the request.
- **`NODE_ENV=production`**: enables secure cookies, longer static-asset caching, `morgan('combined')`, and hides error messages from end users.
- **Service worker**: the app intentionally serves a self-unregistering service worker at `/sw.js` to ensure browser-side caches are purged after upgrades.
- **ffmpeg/ffprobe**: required on the host if you intend to upload video files. The server calls `fluent-ffmpeg` for validation (`ffprobe`) and thumbnail extraction (at the 1 s mark).
- **Reverse proxy example (Caddy)**:

```
rskmedia.example.com {
    reverse_proxy 127.0.0.1:3000
    encode gzip zstd
}
```

---

## License

No license file is included in this repository. All rights reserved by the project owner unless a `LICENSE` file is added later.
