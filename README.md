# LurlHub

Self-hosted video and image capture platform with member management, HLS streaming, and automated maintenance.

Capture content from any URL, organize it into collections, stream with adaptive bitrate HLS, and manage everything through a built-in admin dashboard.

## Features

### Content Pipeline
- **Capture** videos and images from any URL via browser extension or API
- **Download** with multi-strategy fallback (HTTP, cookie injection, Puppeteer stealth)
- **Transcode** to adaptive bitrate HLS (1080p / 720p / 480p)
- **Generate** WebP thumbnails and 3-6s preview clips automatically
- **Serve** HLS streams with master playlist and quality switching

### Member System
- Email registration with PBKDF2 password hashing
- JWT authentication (7-day access / 30-day refresh tokens)
- Quota-based access control (free tier: 3 uses, VIP: unlimited)
- Redemption codes for bonus quota (admin-generated, expirable)
- Watch history with playback progress tracking

### Organization
- Custom collections / playlists (public or private)
- Tagging system with user subscriptions
- Voting (like / dislike) and content reporting
- Search, filter by type, and sort

### Maintenance Automation
Five background strategies that keep your library healthy:

| Priority | Strategy | What it does |
|----------|----------|--------------|
| 1 | Download | Fetch missing source files |
| 2 | Thumbnail | Generate WebP thumbnails |
| 3 | Preview | Extract short preview clips |
| 4 | HLS | Transcode to multi-bitrate HLS |
| 5 | Cleanup | Delete originals after HLS conversion |

Run manually, per-strategy, or on auto-schedule via the admin dashboard.

### Admin Dashboard
Single-page dashboard at `/lurl/admin` with tabs for:
- Records management (status, delete, bulk actions)
- User management (quota, tier, ban)
- Redemption codes (generate, track, expire)
- HLS queue monitoring and batch transcoding
- Maintenance controls and execution history
- Version management for userscript updates

## Quick Start

```bash
git clone https://github.com/Jeffrey0117/LurlHub.git
cd LurlHub
cp .env.example .env    # edit with your secrets
npm install
node server.js          # http://localhost:4017
```

### Prerequisites

- Node.js >= 18
- FFmpeg + FFprobe (for video processing)
- Puppeteer dependencies (optional, for stealth downloads)

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 4017) |
| `LURL_ADMIN_PASSWORD` | Yes | Admin dashboard password |
| `LURL_CLIENT_TOKEN` | Yes | API token for capture/upload |
| `LURL_SESSION_SECRET` | Yes | Session signing secret |
| `LURL_JWT_SECRET` | No | JWT secret (defaults to session secret) |
| `LURL_VIP_WHITELIST` | No | Comma-separated visitor IDs with unlimited quota |
| `WORKR_URL` | No | Workr job queue URL for background processing |

## Architecture

```
lurlhub/
├── server.js              HTTP server (port 4017)
├── lurl.js                Core application (routes, pages, API, auth)
├── _lurl-db.js            SQLite data layer (better-sqlite3, WAL mode)
├── _lurl-checker.js       File existence and format detection
├── _lurl-retry.js         Puppeteer-based download retry (optional)
├── _workr-client.js       External job queue client (optional)
├── maintenance/
│   ├── index.js           Maintenance system entry
│   ├── scheduler.js       Strategy-based scheduler
│   ├── base-strategy.js   Base class for strategies
│   └── strategies/        5 maintenance strategies
├── public/
│   └── admin.html         Standalone admin dashboard
├── userscript/            Browser extension for content capture
├── docs/                  Specs and documentation
└── data/                  Runtime data (gitignored)
    ├── lurl.db            SQLite database
    ├── videos/            Downloaded videos
    ├── images/            Downloaded images
    ├── thumbnails/        WebP thumbnails
    ├── previews/          Preview clips
    └── hls/               HLS streams (m3u8 + ts segments)
```

## API

### Public
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/lurl/health` | Health check |
| GET | `/lurl/api/records` | List records (paginated, filterable) |
| GET | `/lurl/api/stats` | Platform statistics |

### Authenticated (Client Token)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/lurl/api/capture` | Submit URL for capture |
| POST | `/lurl/api/upload` | Chunked file upload |

### Member (JWT)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/lurl/api/auth/register` | Register account |
| POST | `/lurl/api/auth/login` | Login (returns JWT) |
| GET | `/lurl/api/member/history` | Watch history |
| GET | `/lurl/api/collections` | List collections |
| POST | `/lurl/api/redeem` | Redeem bonus code |

### Admin
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/lurl/api/users` | List all users |
| POST | `/lurl/api/maintenance/run` | Trigger maintenance cycle |
| GET | `/lurl/api/maintenance/status` | Maintenance system status |
| POST | `/lurl/api/hls/transcode-all` | Batch HLS transcoding |
| POST | `/lurl/api/redemptions/generate` | Generate redemption codes |

Full API reference: 60+ endpoints covering records, users, collections, HLS, maintenance, and more.

## Database

SQLite with better-sqlite3 (WAL mode). Tables:

- **records** - Videos and images with per-field status tracking
- **quotas** - Per-visitor usage and bonus quota
- **users** - Member accounts (email, hashed password, tier)
- **watch_history** - Viewing records with playback progress
- **collections** / **collection_items** - User playlists
- **hidden_records** - Per-user content hiding
- **tag_subscriptions** - Tag follow system

Auto-migrates from legacy JSONL format on first run.

## CloudPipe Integration

LurlHub is part of the [CloudPipe](https://github.com/Jeffrey0117/CloudPipe) ecosystem. When registered:

- **Gateway**: 9 tools available via `gw.call('lurlhub_list_records', { limit: 10 })`
- **MCP**: Tools exposed as `lurlhub_*` for AI assistants
- **Telegram Bot**: `/call lurlhub_get_stats`
- **Pipeline**: Chain with other services (e.g., capture + upload to Upimg)

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js (native HTTP, no framework) |
| Database | SQLite (better-sqlite3) |
| Image processing | sharp |
| Video processing | FFmpeg / FFprobe |
| Authentication | PBKDF2 + HMAC-SHA256 JWT |
| Download fallback | Puppeteer + stealth plugin |
| Compression | zlib (gzip responses) |

## License

MIT
