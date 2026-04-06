# mac-mini-clip-bridge

Lightweight Express service that exposes local Mac mini export clips as public URLs for TikTok pull-by-url publishing.

## Run

```bash
cp .env.example .env
npm install
npm start
```

## Env vars

- `PORT` (default `8787`)
- `BRIDGE_TOKEN` (required for `GET /clips`)
- `EXPORT_CLIPS_DIR` (directory containing `.mp4`/`.mov` clips)
- `BRIDGE_BASE_URL` (public base URL, used in returned clip URLs)
- `BRIDGE_FILE_TOKEN` (optional: if set, `/clips/:name` requires `?token=...`)

## Endpoints

- `GET /health`
- `GET /clips` with `Authorization: Bearer <BRIDGE_TOKEN>`
- `GET /clips/:name` streams a clip (`.mp4` / `.mov` only)

## Security notes

- Filename is strictly validated (`basename` only, no traversal)
- Only `.mp4` and `.mov` files are allowed
- Metadata listing is token-protected
- File streaming can be public or gated with `BRIDGE_FILE_TOKEN`
