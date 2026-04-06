# TikTok Review Demo (Dance Guru)

Minimal web demo to satisfy TikTok app review requirements:
- OAuth connect flow
- Callback + token exchange
- Content Posting API test call
- Local file upload from your device (no cloud storage required)
- **Option 1:** Browse/publish clips directly from Mac mini `SyncFiles/export_clips` via a lightweight bridge service
- Clear UI for recording end-to-end demo video

## 1) Local run (demo backend)

```bash
cd tiktok-review-demo
cp .env.example .env
npm install
npm start
```

Open: `http://localhost:3000`

## 2) Render deploy

Use Node web service and set env vars from `.env.example`.

Required env vars:
- `APP_BASE_URL`
- `TIKTOK_CLIENT_KEY`
- `TIKTOK_CLIENT_SECRET`
- `TIKTOK_REDIRECT_URI`
- `SESSION_SECRET`

Recommended:
- `TIKTOK_SCOPES=user.info.basic,video.publish`
- `ALLOWED_ORIGINS=https://www.hypercreative.games,https://hypercreative.games`
- `SESSION_COOKIE_DOMAIN=.hypercreative.games`
- `SESSION_SAMESITE=none`
- `MAX_UPLOAD_MB=200`
- `LOCAL_UPLOAD_TTL_MIN=120`

For Option 1 (Mac mini bridge integration):
- `MAC_BRIDGE_BASE_URL=https://clips.hypercreative.games` (or your public tunnel URL)
- `MAC_BRIDGE_TOKEN=<same token as bridge BRIDGE_TOKEN>`
- `MAC_BRIDGE_FILE_TOKEN=<optional, only if enabled on bridge>`

## 3) Domain + callback

Target demo domain:
- `https://api.hypercreative.games`

Set TikTok redirect URI to:
- `https://api.hypercreative.games/auth/tiktok/callback`

Ensure this exact URL also appears in Render env (`TIKTOK_REDIRECT_URI`).

If Wix manages DNS, add:
- CNAME `api` -> `<your-render-service>.onrender.com`

Wait for SSL to become active on Render custom domain before running OAuth.

## 4) Option 1 setup: Mac mini clip bridge (new)

A lightweight local service is included at:
- `mac-mini-clip-bridge/`

It exposes files in `SyncFiles/export_clips` as pullable URLs for TikTok.

### 4.1 Run bridge on Mac mini

```bash
cd tiktok-review-demo/mac-mini-clip-bridge
cp .env.example .env
npm install
npm start
```

Bridge env vars:
- `BRIDGE_TOKEN` (required for `GET /clips` metadata list)
- `EXPORT_CLIPS_DIR` (e.g. `/Users/rocky/.openclaw/workspaces/marketing/SyncFiles/export_clips`)
- `BRIDGE_BASE_URL` (public URL TikTok can fetch from)
- `PORT` (default `8787`)
- `BRIDGE_FILE_TOKEN` (optional: if set, file endpoint requires `?token=...`)

Endpoints:
- `GET /health`
- `GET /clips` (requires `Authorization: Bearer <BRIDGE_TOKEN>`)
- `GET /clips/:name` (streams `.mp4` / `.mov`; optional query token)

### 4.2 Expose bridge publicly

TikTok must be able to fetch video URLs from the internet.

Options:
- Reverse proxy/domain to Mac mini (recommended): e.g. `https://clips.hypercreative.games`
- Temporary tunnel URL for testing (Cloudflare Tunnel / ngrok / Tailscale funnel)

Set this public address as:
- bridge `BRIDGE_BASE_URL`
- Render `MAC_BRIDGE_BASE_URL`

### 4.3 Wire bridge into Render backend

Set on Render (`api.hypercreative.games` service):
- `MAC_BRIDGE_BASE_URL`
- `MAC_BRIDGE_TOKEN`
- optional `MAC_BRIDGE_FILE_TOKEN`

Then in app UI:
1. Click **Load clips from Mac mini**
2. Select a clip
3. Enter caption
4. Click **Publish Selected Mac Clip**

## 5) Demo recording checklist

1. Show browser URL with your real domain.
2. Click **Connect TikTok**.
3. Show TikTok consent + redirect back.
4. Show connected state in UI.
5. Publish test and show JSON response.
6. Optional: show local file upload + publish for no-cloud workflow.
7. Optional: show Mac mini clip browse + publish flow.

## 6) No-cloud-storage upload paths

### Path A: direct upload in demo UI
- Use **Upload from this device** section.
- Backend stores file temporarily in `/tmp`, exposes `/uploads/...`, TikTok pulls by URL.

### Path B (Option 1): Mac mini bridge
- Keep your clips in `SyncFiles/export_clips` on Mac mini.
- Bridge exposes those clips directly.
- Render app lists and publishes selected clip by URL.
- Avoids setting up separate object storage.

## 7) Notes

- This is review/demo-focused, not production hardening.
- For production, add persistent token storage, refresh flow, CSRF hardening, audit logs, stronger auth, and stricter bridge access controls.
