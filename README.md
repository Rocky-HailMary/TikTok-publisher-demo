# TikTok Review Demo (Dance Guru)

Minimal web demo to satisfy TikTok app review requirements:
- OAuth connect flow
- Callback + token exchange
- Content Posting API test call
- Local file upload from your device (no cloud storage required)
- Clear UI for recording end-to-end demo video

## 1) Local run

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

## 3) Domain + callback

Target demo domain:
- `https://api.hypercreative.games`

Set TikTok redirect URI to:
- `https://api.hypercreative.games/auth/tiktok/callback`

Ensure this exact URL also appears in Render env (`TIKTOK_REDIRECT_URI`).

If Wix manages DNS, add:
- CNAME `api` -> `<your-render-service>.onrender.com`

Wait for SSL to become active on Render custom domain before running OAuth.

## 4) Demo recording checklist

1. Show browser URL with your real domain.
2. Click **Connect TikTok**.
3. Show TikTok consent + redirect back.
4. Show connected state in UI.
5. Enter public video URL + caption.
6. Click **Publish Test** and show JSON response.

## 5) No-cloud-storage upload path

- Open `https://api.hypercreative.games/`
- Use the **Upload from this device** section.
- The server stores the file temporarily in `/tmp`, generates a short-lived URL on your own domain (`/uploads/...`), then calls TikTok `publish/video/init` using that URL.
- This avoids third-party cloud object storage while still using TikTok's pull-by-URL mechanism.

## 6) Notes

- This is review/demo-focused, not production hardening.
- For production, add persistent token storage, refresh flow, CSRF hardening, audit logs, and stronger auth.
