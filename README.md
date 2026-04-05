# TikTok Review Demo (Dance Guru)

Minimal web demo to satisfy TikTok app review requirements:
- OAuth connect flow
- Callback + token exchange
- Content Posting API test call
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

## 3) Domain + callback

Target demo domain:
- `https://api.hypercreative.games`

Set TikTok redirect URI to:
- `https://api.hypercreative.games/auth/tiktok/callback`

Ensure this exact URL also appears in Render env (`TIKTOK_REDIRECT_URI`).

## 4) Demo recording checklist

1. Show browser URL with your real domain.
2. Click **Connect TikTok**.
3. Show TikTok consent + redirect back.
4. Show connected state in UI.
5. Enter public video URL + caption.
6. Click **Publish Test** and show JSON response.

## 5) Notes

- This is review/demo-focused, not production hardening.
- For production, add persistent token storage, refresh flow, CSRF hardening, audit logs, and stronger auth.
