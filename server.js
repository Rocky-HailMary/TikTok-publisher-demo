const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const multer = require('multer');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const {
  PORT = 3000,
  APP_BASE_URL = 'http://localhost:3000',
  TIKTOK_CLIENT_KEY = '',
  TIKTOK_CLIENT_SECRET = '',
  TIKTOK_REDIRECT_URI = 'http://localhost:3000/auth/tiktok/callback',
  TIKTOK_SCOPES = 'user.info.basic,video.publish',
  TIKTOK_AUTH_BASE = 'https://www.tiktok.com',
  TIKTOK_API_BASE = 'https://open.tiktokapis.com',
  SESSION_SECRET = 'change-this-in-production',
  ALLOWED_ORIGINS = 'https://www.hypercreative.games,https://hypercreative.games',
  SESSION_COOKIE_DOMAIN = '',
  SESSION_SAMESITE = 'none',
  MAX_UPLOAD_MB = '200',
  LOCAL_UPLOAD_TTL_MIN = '120',
  MAC_BRIDGE_BASE_URL = '',
  MAC_BRIDGE_TOKEN = '',
  MAC_BRIDGE_FILE_TOKEN = '',
  APPROVED_TIKTOK_OPEN_IDS = '',
  SITE_LOGIN_USER = '',
  SITE_LOGIN_PASS = ''
} = process.env;

const allowedOrigins = ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
const uploadDir = path.join('/tmp', 'dg-tiktok-upload-cache');
const maxUploadBytes = Math.max(1, Number(MAX_UPLOAD_MB || 200)) * 1024 * 1024;
const uploadTtlMs = Math.max(5, Number(LOCAL_UPLOAD_TTL_MIN || 120)) * 60 * 1000;

const oauthStateStore = new Map();
const oauthStateTtlMs = 10 * 60 * 1000;
let lastOAuthDebug = null;
const approvedOpenIds = new Set(
  String(APPROVED_TIKTOK_OPEN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.mp4';
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  }
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: maxUploadBytes },
  fileFilter: (_req, file, cb) => {
    const okMime = ['video/mp4', 'video/quicktime', 'application/octet-stream'];
    const ext = path.extname(file.originalname || '').toLowerCase();
    const okExt = ['.mp4', '.mov'].includes(ext);
    if (okExt || okMime.includes(file.mimetype)) return cb(null, true);
    return cb(new Error('Unsupported file type. Use .mp4 or .mov'));
  }
});

function publicUploadUrl(fileName) {
  return new URL(`/uploads/${encodeURIComponent(fileName)}`, APP_BASE_URL).toString();
}

function getMacClipPublicUrl(name) {
  const base = MAC_BRIDGE_BASE_URL.trim();
  if (!base) throw new Error('MAC_BRIDGE_BASE_URL is not configured');
  const url = new URL(`/clips/${encodeURIComponent(name)}`, base);
  if (MAC_BRIDGE_FILE_TOKEN) {
    url.searchParams.set('token', MAC_BRIDGE_FILE_TOKEN);
  }
  return url.toString();
}

function isAllowedClipName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  return ['.mp4', '.mov'].includes(path.extname(name).toLowerCase());
}

function oauthNoticeRedirect(type, message) {
  const key = type === 'ok' ? 'oauth_ok' : 'oauth_error';
  const text = String(message || '').trim() || (type === 'ok' ? 'OAuth success' : 'OAuth failed');
  return `/?${key}=${encodeURIComponent(text)}`;
}

function cleanupOAuthStateStore() {
  const now = Date.now();
  for (const [state, createdAt] of oauthStateStore.entries()) {
    if (now - createdAt > oauthStateTtlMs) {
      oauthStateStore.delete(state);
    }
  }
}

function isApprovedTikTokOpenId(openId) {
  if (!openId) return false;
  if (!approvedOpenIds.size) return false;
  return approvedOpenIds.has(String(openId));
}

function getActiveTikTokAuth(req) {
  return req.session?.tiktok || null;
}

function requireApprovedTikTok(req, res, next) {
  const t = getActiveTikTokAuth(req);
  if (!t?.access_token) {
    return res.status(401).json({ ok: false, error: 'Not connected. Connect TikTok first.' });
  }

  if (!isApprovedTikTokOpenId(t.open_id)) {
    return res.status(403).json({
      ok: false,
      error: 'Connected TikTok account is not approved for this app.',
      open_id: t.open_id || null
    });
  }

  return next();
}

function requireSiteSession(req, res, next) {
  if (!SITE_LOGIN_USER || !SITE_LOGIN_PASS) return next();
  if (req.session?.siteAuthed) return next();
  return res.status(401).json({
    ok: false,
    error: 'Not logged in to site. Open / and sign in first.'
  });
}

async function cleanupUploadCache() {
  try {
    const files = await fsp.readdir(uploadDir);
    const now = Date.now();
    await Promise.all(files.map(async (name) => {
      const full = path.join(uploadDir, name);
      try {
        const stat = await fsp.stat(full);
        if (!stat.isFile()) return;
        if (now - stat.mtimeMs > uploadTtlMs) {
          await fsp.unlink(full);
        }
      } catch {
        // ignore per-file cleanup failures
      }
    }));
  } catch {
    // ignore cleanup failures
  }
}

setInterval(cleanupUploadCache, 15 * 60 * 1000).unref();
setInterval(cleanupOAuthStateStore, 2 * 60 * 1000).unref();

function secureEquals(a, b) {
  const aBuf = Buffer.from(String(a || ''), 'utf8');
  const bBuf = Buffer.from(String(b || ''), 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function requireBasicAuth(req, res, next) {
  if (!SITE_LOGIN_USER || !SITE_LOGIN_PASS) return next();

  // Keep the main page behind Basic Auth, but let app JSON/action routes
  // authenticate via session/TikTok checks so browser fetches don't stall.
  const authOptionalPath =
    req.path === '/health' ||
    req.path === '/api/status' ||
    req.path.startsWith('/mac/') ||
    req.path.startsWith('/publish/') ||
    req.path.startsWith('/uploads/');

  if (authOptionalPath) return next();
  if (req.session?.siteAuthed) return next();

  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="api.hypercreative.games", charset="UTF-8"');
    return res.status(401).send('Authentication required');
  }

  let decoded = '';
  try {
    decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    decoded = '';
  }

  const idx = decoded.indexOf(':');
  const user = idx >= 0 ? decoded.slice(0, idx) : '';
  const pass = idx >= 0 ? decoded.slice(idx + 1) : '';

  const ok = secureEquals(user, SITE_LOGIN_USER) && secureEquals(pass, SITE_LOGIN_PASS);
  if (!ok) {
    res.setHeader('WWW-Authenticate', 'Basic realm="api.hypercreative.games", charset="UTF-8"');
    return res.status(401).send('Invalid credentials');
  }

  if (req.session) {
    req.session.siteAuthed = true;
    return req.session.save(() => next());
  }

  return next();
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  return next();
});

const appIsHttps = APP_BASE_URL.startsWith('https://');
const sameSiteRaw = String(SESSION_SAMESITE || 'none').toLowerCase();
const sameSiteNormalized = ['none', 'lax', 'strict'].includes(sameSiteRaw) ? sameSiteRaw : 'none';
const sameSiteEffective = (!appIsHttps && sameSiteNormalized === 'none') ? 'lax' : sameSiteNormalized;

app.use(
  session({
    name: 'dg_tiktok_demo',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: sameSiteEffective,
      secure: appIsHttps,
      domain: SESSION_COOKIE_DOMAIN || undefined
    }
  })
);

app.use(requireBasicAuth);

function mustHaveConfig() {
  const missing = [];
  if (!TIKTOK_CLIENT_KEY) missing.push('TIKTOK_CLIENT_KEY');
  if (!TIKTOK_CLIENT_SECRET) missing.push('TIKTOK_CLIENT_SECRET');
  if (!TIKTOK_REDIRECT_URI) missing.push('TIKTOK_REDIRECT_URI');
  if (!approvedOpenIds.size) missing.push('APPROVED_TIKTOK_OPEN_IDS');
  return missing;
}

function fmtDate(ts) {
  if (!ts) return 'n/a';
  try {
    return new Date(ts).toISOString();
  } catch {
    return 'n/a';
  }
}

function authUrl(state) {
  const url = new URL('/v2/auth/authorize/', TIKTOK_AUTH_BASE);
  url.searchParams.set('client_key', TIKTOK_CLIENT_KEY);
  url.searchParams.set('scope', TIKTOK_SCOPES);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', TIKTOK_REDIRECT_URI);
  url.searchParams.set('state', state);
  return url.toString();
}

async function exchangeCodeForToken(code) {
  const tokenUrl = new URL('/v2/oauth/token/', TIKTOK_API_BASE).toString();
  const body = new URLSearchParams({
    client_key: TIKTOK_CLIENT_KEY,
    client_secret: TIKTOK_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: TIKTOK_REDIRECT_URI
  }).toString();

  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  const text = await resp.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  if (!resp.ok) {
    return { ok: false, status: resp.status, payload };
  }
  return { ok: true, status: resp.status, payload };
}

async function publishVideoInit({ accessToken, openId, caption, videoUrl }) {
  const publishUrl = new URL('/v2/post/publish/video/init/', TIKTOK_API_BASE).toString();
  const body = {
    post_info: {
      title: String(caption || '').slice(0, 2200),
      privacy_level: 'SELF_ONLY',
      disable_comment: false,
      disable_duet: false,
      disable_stitch: false
    },
    source_info: {
      source: 'PULL_FROM_URL',
      video_url: videoUrl
    }
  };

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  };
  if (openId) headers.open_id = openId;

  const resp = await fetch(publishUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  const text = await resp.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  return {
    ok: resp.ok,
    status: resp.status,
    payload
  };
}

async function fetchMacBridgeClips() {
  if (!MAC_BRIDGE_BASE_URL) {
    return { ok: false, status: 500, payload: { ok: false, error: 'MAC_BRIDGE_BASE_URL is not configured' } };
  }

  const url = new URL('/clips', MAC_BRIDGE_BASE_URL).toString();
  const headers = {};
  if (MAC_BRIDGE_TOKEN) headers.Authorization = `Bearer ${MAC_BRIDGE_TOKEN}`;

  const resp = await fetch(url, { headers });
  const text = await resp.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  return { ok: resp.ok, status: resp.status, payload };
}

async function deleteMacBridgeClips(names) {
  if (!MAC_BRIDGE_BASE_URL) {
    return { ok: false, status: 500, payload: { ok: false, error: 'MAC_BRIDGE_BASE_URL is not configured' } };
  }

  const url = new URL('/clips/delete', MAC_BRIDGE_BASE_URL).toString();
  const headers = { 'Content-Type': 'application/json' };
  if (MAC_BRIDGE_TOKEN) headers.Authorization = `Bearer ${MAC_BRIDGE_TOKEN}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ names })
  });

  const text = await resp.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  return { ok: resp.ok, status: resp.status, payload };
}

function renderHome(req, res) {
  const missing = mustHaveConfig();
  const tiktok = getActiveTikTokAuth(req);
  const connected = Boolean(tiktok?.access_token);
  const openId = tiktok?.open_id || 'n/a';
  const isApproved = connected ? isApprovedTikTokOpenId(tiktok?.open_id) : false;
  const createdAt = fmtDate(tiktok?.created_at);
  const expiresAt = tiktok?.expires_at ? fmtDate(tiktok.expires_at) : 'n/a';
  const flash = req.session.flash || null;
  req.session.flash = null;
  const oauthErrorNotice = String(req.query?.oauth_error || '').trim();
  const oauthOkNotice = String(req.query?.oauth_ok || '').trim();
  const notice = flash || (oauthErrorNotice
    ? { type: 'error', message: oauthErrorNotice }
    : (oauthOkNotice ? { type: 'ok', message: oauthOkNotice } : null));

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Dance Guru TikTok Demo</title>
  <style>
    body { font-family: Inter, system-ui, Arial, sans-serif; margin: 24px; max-width: 980px; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 16px; margin-bottom: 14px; }
    .ok { color: #0f7a2c; }
    .bad { color: #a12121; }
    button { padding: 10px 14px; border-radius: 8px; border: 1px solid #aaa; cursor: pointer; }
    input, textarea { width: 100%; padding: 9px; margin: 6px 0 10px; border: 1px solid #bbb; border-radius: 8px; }
    pre { background:#111; color:#f7f7f7; padding: 12px; border-radius: 10px; overflow:auto; max-height: 260px; }
    .muted { color: #666; font-size: 13px; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; }
    .row > button { width: auto; }
    .clip-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(154px, 154px));
      justify-content: start;
      gap: 12px;
      margin: 10px 0 12px;
    }
    .clip-card {
      width: 100%;
      text-align: left;
      border: 1px solid #bbb;
      border-radius: 10px;
      background: #fff;
      padding: 0;
      overflow: hidden;
      position: relative;
      cursor: pointer;
      transition: border-color .15s ease, box-shadow .15s ease;
    }
    .clip-card:hover {
      border-color: #666;
    }
    .clip-card.selected {
      border-color: #111;
      box-shadow: 0 0 0 2px #111 inset;
    }
    .clip-check-wrap {
      position: absolute;
      top: 6px;
      left: 6px;
      z-index: 2;
      background: rgba(255, 255, 255, 0.92);
      border-radius: 6px;
      padding: 2px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .clip-check {
      width: 18px;
      height: 18px;
      margin: 0;
      cursor: pointer;
    }
    .clip-thumb {
      width: 100%;
      aspect-ratio: 9 / 16;
      background: #000;
      position: relative;
      overflow: hidden;
    }
    .clip-thumb img,
    .clip-thumb video {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
      background: #000;
    }
    .clip-thumb-fallback {
      width: 100%;
      height: 100%;
      color: #bbb;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .clip-meta {
      padding: 8px 10px 10px;
    }
    .clip-name {
      font-size: 12px;
      font-weight: 600;
      word-break: break-word;
      line-height: 1.35;
      margin-bottom: 4px;
    }
    .clip-sub {
      font-size: 11px;
      color: #666;
      line-height: 1.35;
    }
    .clip-posting {
      margin-top: 6px;
      font-size: 11px;
      line-height: 1.35;
      color: #2b2b2b;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-overflow: ellipsis;
      min-height: 44px;
    }
    .clip-hashtags {
      margin-top: 4px;
      font-size: 11px;
      line-height: 1.35;
      color: #3556d8;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-overflow: ellipsis;
      min-height: 30px;
    }
    .clip-player-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.65);
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .clip-player-backdrop[hidden] {
      display: none !important;
    }
    .clip-player-modal {
      width: min(92vw, 520px);
      background: #0f0f10;
      color: #fff;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 12px 40px rgba(0,0,0,0.4);
    }
    .clip-player-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 12px;
      font-size: 13px;
      background: #16171a;
    }
    .clip-player-head a {
      color: #9ec2ff;
      text-decoration: none;
      font-size: 12px;
    }
    .clip-player-head button {
      padding: 6px 10px;
      border-radius: 6px;
    }
    .clip-player-video {
      width: 100%;
      aspect-ratio: 9 / 16;
      display: block;
      background: #000;
    }
    .clip-player-float-close {
      position: fixed;
      top: calc(env(safe-area-inset-top, 0px) + 10px);
      right: 10px;
      z-index: 1002;
      width: 40px;
      height: 40px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.35);
      background: rgba(0,0,0,0.62);
      color: #fff;
      font-size: 24px;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }
    @media (max-width: 760px) {
      body { margin: 14px; }
      .card { padding: 12px; border-radius: 10px; }
      .clip-grid {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .clip-card {
        width: 100%;
        display: grid;
        grid-template-columns: 112px minmax(0, 1fr);
        align-items: stretch;
      }
      .clip-thumb {
        width: 112px;
        min-height: 198px;
        aspect-ratio: auto;
      }
      .clip-meta {
        padding: 8px;
      }
      .clip-name {
        font-size: 13px;
      }
      .clip-sub,
      .clip-posting,
      .clip-hashtags {
        font-size: 12px;
      }
      .clip-posting,
      .clip-hashtags {
        min-height: 0;
      }
      .clip-posting {
        -webkit-line-clamp: 4;
      }
      .clip-hashtags {
        -webkit-line-clamp: 3;
      }

      .clip-player-backdrop {
        padding: 0;
        background: rgba(0,0,0,0.92);
      }
      .clip-player-modal {
        width: 100vw;
        height: 100vh;
        max-width: none;
        border-radius: 0;
        display: flex;
        flex-direction: column;
      }
      .clip-player-head {
        padding: 8px 10px;
      }
      .clip-player-video {
        flex: 1;
        width: 100%;
        height: auto;
        aspect-ratio: auto;
        object-fit: contain;
      }
      .clip-player-float-close {
        width: 46px;
        height: 46px;
        font-size: 28px;
      }
    }
  </style>
</head>
<body>
  <h1>Dance Guru TikTok Review Demo</h1>
  <p class="muted">Domain: ${APP_BASE_URL}</p>

  ${notice ? `<div class="card ${notice.type === 'error' ? 'bad' : 'ok'}">${notice.message}</div>` : ''}

  <div class="card">
    <h3>Config check</h3>
    ${missing.length ? `<p class="bad">Missing env vars: ${missing.join(', ')}</p>` : '<p class="ok">Config looks complete.</p>'}
    <p class="muted">Redirect URI configured: ${TIKTOK_REDIRECT_URI}</p>
  </div>

  <div class="card">
    <h3>1) Connect TikTok (OAuth)</h3>
    <p>Status: ${connected ? '<span class="ok">Connected</span>' : '<span class="bad">Not connected</span>'}</p>
    <p>Approved account: ${connected ? (isApproved ? '<span class="ok">Yes</span>' : '<span class="bad">No</span>') : '<span class="bad">No</span>'}</p>
    <p class="muted">open_id: ${openId}</p>
    <p class="muted">token created_at: ${createdAt} | expires_at: ${expiresAt}</p>
    ${connected && !isApproved ? '<p class="bad">This TikTok account is not approved to use upload/clip actions on this site.</p>' : ''}
    <p>
      <a href="/auth/tiktok/start"><button>Connect TikTok</button></a>
      <a href="/auth/tiktok/logout"><button>Disconnect</button></a>
    </p>
  </div>

  <div class="card">
    <h3>2) Upload from this device (no cloud storage required)</h3>
    <p class="muted">File is uploaded to this backend, exposed temporarily as a short-lived URL, then TikTok pulls it.</p>
    <p class="muted">Max upload size: ${Math.round(maxUploadBytes / (1024 * 1024))} MB</p>
    <form id="uploadForm" enctype="multipart/form-data">
      <label>Video file (.mp4/.mov):</label>
      <input id="video_file" name="video" type="file" accept="video/mp4,video/quicktime,.mp4,.mov" required />

      <label>Caption:</label>
      <textarea id="upload_caption" name="caption" rows="3" placeholder="Post caption">Dance Guru TikTok API demo post</textarea>

      <button type="submit">Upload & Publish</button>
    </form>
    <pre id="uploadResult">No upload attempt yet.</pre>
  </div>

  <div class="card">
    <h3>3) Upload from Mac mini export clips</h3>
    <p class="muted">Shows clips currently available in SyncFiles/export_clips via the Mac bridge (${MAC_BRIDGE_BASE_URL || 'not configured'}).</p>
    <div class="row">
      <button id="loadMacClipsBtn" type="button" onclick="if (window.loadMacClips) { window.loadMacClips(); return false; } window.location.href='/mac/clips'; return false;">Load clips from Mac mini</button>
      <button id="deleteMacClipsBtn" type="button">Delete Selected</button>
    </div>

    <div id="mac_clip_grid" class="clip-grid"></div>
    <p class="muted">Click a thumbnail image to open smooth player popup. Posting text + hashtags come from each clip's support file.</p>
    <p class="muted">Selected clip: <strong id="selected_mac_clip">None</strong></p>
    <p class="muted">Publish uses caption/hashtags from the selected clip support file.</p>

    <button id="publishMacClipBtn" type="button" disabled>Publish Selected Mac Clip</button>
    <pre id="macResult">No Mac mini publish attempt yet.</pre>
  </div>

  <div class="card">
    <h3>Review checklist</h3>
    <ul>
      <li>Show this domain + URL in browser address bar.</li>
      <li>Click Connect TikTok and show consent screen.</li>
      <li>Return to app showing connected state.</li>
      <li>Upload from device and show API response payload.</li>
      <li>Load Mac mini clips as thumbnails, select one, and publish.</li>
    </ul>
  </div>

  <div id="clipPlayerModal" class="clip-player-backdrop" hidden>
    <button id="clipPlayerFloatCloseBtn" class="clip-player-float-close" type="button" aria-label="Close preview">×</button>
    <div class="clip-player-modal">
      <div class="clip-player-head">
        <strong id="clipPlayerTitle">Clip Preview</strong>
        <div>
          <a id="clipPlayerOpenLink" href="#" target="_blank" rel="noopener noreferrer">Open raw video</a>
          <button id="clipPlayerCloseBtn" type="button">Close</button>
        </div>
      </div>
      <video id="clipPlayerVideo" class="clip-player-video" controls playsinline preload="metadata"></video>
    </div>
  </div>

  <script>
    const uploadForm = document.getElementById('uploadForm');
    const uploadResult = document.getElementById('uploadResult');

    uploadForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fileInput = document.getElementById('video_file');
      const captionInput = document.getElementById('upload_caption');
      if (!fileInput.files || !fileInput.files.length) {
        uploadResult.textContent = 'Please choose a video file first.';
        return;
      }
      uploadResult.textContent = 'Uploading and publishing...';
      const fd = new FormData();
      fd.append('video', fileInput.files[0]);
      fd.append('caption', captionInput.value || 'Dance Guru TikTok API demo post');

      try {
        const r = await fetch('/publish/upload', {
          method: 'POST',
          credentials: 'include',
          body: fd
        });
        const d = await r.json();
        uploadResult.textContent = JSON.stringify(d, null, 2);
      } catch (err) {
        uploadResult.textContent = String(err);
      }
    });

    const loadMacClipsBtn = document.getElementById('loadMacClipsBtn');
    const deleteMacClipsBtn = document.getElementById('deleteMacClipsBtn');
    const publishMacClipBtn = document.getElementById('publishMacClipBtn');
    const macResult = document.getElementById('macResult');
    const macClipGrid = document.getElementById('mac_clip_grid');
    const selectedMacClipLabel = document.getElementById('selected_mac_clip');

    const clipPlayerModal = document.getElementById('clipPlayerModal');
    const clipPlayerVideo = document.getElementById('clipPlayerVideo');
    const clipPlayerTitle = document.getElementById('clipPlayerTitle');
    const clipPlayerOpenLink = document.getElementById('clipPlayerOpenLink');
    const clipPlayerCloseBtn = document.getElementById('clipPlayerCloseBtn');
    const clipPlayerFloatCloseBtn = document.getElementById('clipPlayerFloatCloseBtn');

    let selectedMacClip = '';
    let currentMacClips = [];

    function formatClipSize(bytes) {
      const mb = Number(bytes || 0) / (1024 * 1024);
      return mb.toFixed(2) + ' MB';
    }

    function clipPostingText(clip) {
      const posting = clip && clip.posting ? clip.posting : null;
      return posting && posting.text ? String(posting.text).trim() : '';
    }

    function clipPostingHashtags(clip) {
      const posting = clip && clip.posting ? clip.posting : null;
      return posting && Array.isArray(posting.hashtags) ? posting.hashtags : [];
    }

    function buildSuggestedCaption(clip) {
      const text = clipPostingText(clip);
      const hashtags = clipPostingHashtags(clip);
      const tagText = hashtags.join(' ').trim();
      return [text, tagText].filter(Boolean).join('\\n\\n').trim();
    }

    function getCheckedMacClips() {
      const checks = macClipGrid.querySelectorAll('.clip-check:checked');
      return Array.from(checks)
        .map((check) => String(check.dataset.name || ''))
        .filter(Boolean);
    }

    function findClipByName(name) {
      return currentMacClips.find((clip) => clip.name === name) || null;
    }

    function updatePublishButtonState() {
      publishMacClipBtn.disabled = !selectedMacClip;
    }

    function setSelectedMacClip(name) {
      selectedMacClip = name || '';
      selectedMacClipLabel.textContent = selectedMacClip || 'None';
      const cards = macClipGrid.querySelectorAll('.clip-card');
      cards.forEach((card) => {
        card.classList.toggle('selected', card.dataset.name === selectedMacClip);
      });
      updatePublishButtonState();
    }

    function openClipPlayer(clip) {
      if (!clip || !clip.url) return;
      clipPlayerTitle.textContent = clip.name || 'Clip Preview';
      clipPlayerOpenLink.href = clip.url;
      clipPlayerVideo.src = clip.url;
      clipPlayerModal.hidden = false;
      requestAnimationFrame(() => {
        clipPlayerVideo.play().catch(() => {});
      });
    }

    function closeClipPlayer() {
      clipPlayerVideo.pause();
      clipPlayerVideo.removeAttribute('src');
      clipPlayerVideo.load();
      clipPlayerModal.hidden = true;
    }

    clipPlayerCloseBtn.addEventListener('click', closeClipPlayer);
    clipPlayerFloatCloseBtn.addEventListener('click', closeClipPlayer);
    clipPlayerModal.addEventListener('click', (event) => {
      if (event.target === clipPlayerModal) closeClipPlayer();
    });

    function renderMacClipGrid(clips) {
      currentMacClips = Array.isArray(clips) ? clips : [];
      macClipGrid.innerHTML = '';
      if (!currentMacClips.length) {
        selectedMacClip = '';
        selectedMacClipLabel.textContent = 'None';
        updatePublishButtonState();
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = 'No clips found in export_clips.';
        macClipGrid.appendChild(empty);
        return;
      }

      currentMacClips.forEach((clip) => {
        const card = document.createElement('div');
        card.className = 'clip-card';
        card.dataset.name = clip.name;

        const checkWrap = document.createElement('div');
        checkWrap.className = 'clip-check-wrap';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'clip-check';
        check.dataset.name = clip.name;
        check.title = 'Select for deletion';
        check.addEventListener('click', (event) => event.stopPropagation());
        checkWrap.appendChild(check);

        const thumb = document.createElement('div');
        thumb.className = 'clip-thumb';
        if (clip.thumb_url) {
          const img = document.createElement('img');
          img.loading = 'lazy';
          img.decoding = 'async';
          img.src = clip.thumb_url;
          img.alt = clip.name;
          thumb.appendChild(img);
        } else if (clip.url) {
          const previewVideo = document.createElement('video');
          previewVideo.muted = true;
          previewVideo.playsInline = true;
          previewVideo.preload = 'metadata';
          previewVideo.src = clip.url;
          previewVideo.addEventListener('loadedmetadata', () => {
            try {
              previewVideo.currentTime = Math.min(0.15, Number(previewVideo.duration || 0) / 2 || 0.15);
            } catch {}
          });
          thumb.appendChild(previewVideo);
        } else {
          const fallback = document.createElement('div');
          fallback.className = 'clip-thumb-fallback';
          fallback.textContent = 'No thumbnail';
          thumb.appendChild(fallback);
        }

        thumb.addEventListener('click', (event) => {
          event.stopPropagation();
          setSelectedMacClip(clip.name);
          openClipPlayer(clip);
        });

        const meta = document.createElement('div');
        meta.className = 'clip-meta';

        const name = document.createElement('div');
        name.className = 'clip-name';
        name.textContent = clip.name;

        const sub = document.createElement('div');
        sub.className = 'clip-sub';
        const mtime = clip.mtime ? new Date(clip.mtime).toLocaleString() : 'Unknown time';
        sub.textContent = formatClipSize(clip.size) + ' • ' + mtime;

        const postingText = document.createElement('div');
        postingText.className = 'clip-posting';
        postingText.textContent = clipPostingText(clip) || 'No posting text found in support file.';

        const hashtags = document.createElement('div');
        hashtags.className = 'clip-hashtags';
        const tags = clipPostingHashtags(clip);
        hashtags.textContent = tags.length ? tags.join(' ') : 'No hashtags found.';

        meta.appendChild(name);
        meta.appendChild(sub);
        meta.appendChild(postingText);
        meta.appendChild(hashtags);

        card.appendChild(checkWrap);
        card.appendChild(thumb);
        card.appendChild(meta);

        card.addEventListener('click', () => {
          setSelectedMacClip(clip.name);
        });
        macClipGrid.appendChild(card);
      });

      setSelectedMacClip(currentMacClips[0].name);
    }

    async function loadMacClips() {
      macResult.textContent = 'Loading clips + support metadata...';
      loadMacClipsBtn.disabled = true;
      deleteMacClipsBtn.disabled = true;
      try {
        const r = await fetch('/mac/clips', { credentials: 'include' });
        const raw = await r.text();
        let d = null;
        try {
          d = JSON.parse(raw);
        } catch {
          d = { ok: false, error: 'Non-JSON response from /mac/clips', raw };
        }

        if (!r.ok || !d.ok) {
          const out = (d && typeof d === 'object')
            ? Object.assign({ http_status: r.status }, d)
            : { http_status: r.status, error: String(d || 'Unknown error') };
          macResult.textContent = JSON.stringify(out, null, 2);
          return;
        }

        const clips = Array.isArray(d.clips) ? d.clips : [];
        renderMacClipGrid(clips);
        const withPosting = clips.filter((c) => {
          const text = clipPostingText(c);
          const tags = clipPostingHashtags(c);
          return Boolean(text || (tags && tags.length));
        }).length;
        macResult.textContent = JSON.stringify({ ok: true, clip_count: clips.length, with_posting_support: withPosting }, null, 2);
      } catch (err) {
        macResult.textContent = String(err);
      } finally {
        loadMacClipsBtn.disabled = false;
        deleteMacClipsBtn.disabled = false;
      }
    }

    window.loadMacClips = loadMacClips;
    loadMacClipsBtn.addEventListener('click', loadMacClips);
    // Auto-load once so users immediately see either clips or a clear error.
    setTimeout(() => {
      loadMacClips().catch(() => {});
    }, 0);

    deleteMacClipsBtn.addEventListener('click', async () => {
      const names = getCheckedMacClips();
      if (!names.length) {
        macResult.textContent = 'Check one or more clip boxes first.';
        return;
      }

      const confirmed = window.confirm('Delete ' + names.length + ' selected clip(s), plus related support files (.posting.json/.meta.json/.thumb.*)?');
      if (!confirmed) return;

      macResult.textContent = 'Deleting selected clips + support files...';
      try {
        const r = await fetch('/mac/clips/delete', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ names })
        });
        const raw = await r.text();
        let d = null;
        try {
          d = JSON.parse(raw);
        } catch {
          d = { ok: false, error: 'Non-JSON response from /mac/clips/delete', raw };
        }

        const out = (d && typeof d === 'object')
          ? Object.assign({ http_status: r.status }, d)
          : { http_status: r.status, error: String(d || 'Unknown error') };
        macResult.textContent = JSON.stringify(out, null, 2);

        if (r.ok && d.ok) {
          await loadMacClips();
          macResult.textContent = JSON.stringify(d, null, 2);
        }
      } catch (err) {
        macResult.textContent = String(err);
      }
    });

    publishMacClipBtn.addEventListener('click', async () => {
      const name = selectedMacClip;
      if (!name) {
        macResult.textContent = 'Choose a clip thumbnail first.';
        return;
      }

      const selectedClip = findClipByName(name);
      const caption = buildSuggestedCaption(selectedClip) || 'Dance Guru TikTok API demo post';
      macResult.textContent = 'Publishing selected Mac clip with support-file caption...';

      try {
        const r = await fetch('/publish/mac-clip', {
          method: 'POST',
          credentials: 'include',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({
            name,
            caption
          })
        });
        const d = await r.json();
        const publishId = d && d.response_payload && d.response_payload.data ? d.response_payload.data.publish_id : null;
        if (r.ok && d && d.ok && publishId) {
          macResult.textContent = '✅ Publish started successfully.\nPublish ID: ' + publishId + '\n\n' + JSON.stringify(d, null, 2);
        } else {
          macResult.textContent = JSON.stringify(d, null, 2);
        }
      } catch (err) {
        macResult.textContent = String(err);
      }
    });
  </script>
</body>
</html>`;

  res.status(200).send(html);
}


app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'tiktok-review-demo', time: new Date().toISOString() });
});

app.get('/', renderHome);

app.get('/auth/tiktok/start', (req, res) => {
  const missing = mustHaveConfig();
  if (missing.length) {
    const msg = `Missing env vars: ${missing.join(', ')}`;
    req.session.flash = { type: 'error', message: msg };
    return req.session.save(() => res.redirect(oauthNoticeRedirect('error', msg)));
  }

  const state = crypto.randomBytes(24).toString('hex');
  oauthStateStore.set(state, Date.now());
  lastOAuthDebug = {
    stage: 'start',
    time: new Date().toISOString(),
    state_prefix: state.slice(0, 10),
    app_base_url: APP_BASE_URL,
    redirect_uri: TIKTOK_REDIRECT_URI
  };

  // Keep session state too (best effort) for browsers that preserve cookies.
  req.session.oauthState = state;
  req.session.oauthStateCreatedAt = Date.now();

  return req.session.save((err) => {
    if (err) {
      // Even if session save fails, we can still proceed using in-memory state store.
      return res.redirect(authUrl(state));
    }
    return res.redirect(authUrl(state));
  });
});

app.get('/auth/tiktok/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  lastOAuthDebug = {
    stage: 'callback_received',
    time: new Date().toISOString(),
    has_code: Boolean(code),
    code_len: code ? String(code).length : 0,
    has_state: Boolean(state),
    state_prefix: state ? String(state).slice(0, 10) : null,
    error: error ? String(error) : null,
    error_description: error_description ? String(error_description) : null
  };

  if (error) {
    const msg = `TikTok error: ${error} ${error_description || ''}`;
    req.session.flash = { type: 'error', message: msg };
    return res.redirect(oauthNoticeRedirect('error', msg));
  }

  if (!code) {
    const msg = 'Missing authorization code in callback.';
    req.session.flash = { type: 'error', message: msg };
    return res.redirect(oauthNoticeRedirect('error', msg));
  }

  const now = Date.now();
  const sessionState = String(req.session?.oauthState || '');
  const stateValue = String(state || '');
  const stateFromSessionOk = Boolean(stateValue && sessionState && stateValue === sessionState);
  const stateCreatedAt = oauthStateStore.get(stateValue);
  const stateFromStoreOk = Boolean(stateCreatedAt && (now - stateCreatedAt <= oauthStateTtlMs));

  if (!stateFromSessionOk && !stateFromStoreOk) {
    const msg = `State mismatch/expired. Retry Connect TikTok. got=${stateValue || 'none'}`;
    lastOAuthDebug = {
      ...lastOAuthDebug,
      stage: 'state_failed',
      state_from_session_ok: stateFromSessionOk,
      state_from_store_ok: stateFromStoreOk,
      session_state_prefix: sessionState ? String(sessionState).slice(0, 10) : null,
      message: msg
    };
    req.session.flash = {
      type: 'error',
      message: msg
    };
    return req.session.save(() => res.redirect(oauthNoticeRedirect('error', msg)));
  }

  if (stateValue) {
    oauthStateStore.delete(stateValue);
  }
  req.session.oauthState = null;

  try {
    const tokenResp = await exchangeCodeForToken(String(code));
    if (!tokenResp.ok) {
      const msg = `Token exchange failed (HTTP ${tokenResp.status}): ${JSON.stringify(tokenResp.payload)}`;
      lastOAuthDebug = {
        ...lastOAuthDebug,
        stage: 'token_failed',
        token_http_status: tokenResp.status,
        token_payload: tokenResp.payload
      };
      req.session.flash = {
        type: 'error',
        message: msg
      };
      return res.redirect(oauthNoticeRedirect('error', msg));
    }

    const rawTokenPayload = tokenResp.payload || {};
    const data = (rawTokenPayload && typeof rawTokenPayload.data === 'object' && rawTokenPayload.data)
      ? rawTokenPayload.data
      : rawTokenPayload;
    const accessToken = String(data.access_token || '').trim();
    if (!accessToken) {
      const payloadKeys = Object.keys(data || {});
      const msg = `Token exchange returned no access_token. Payload keys: ${payloadKeys.join(', ') || 'none'}`;
      lastOAuthDebug = {
        ...lastOAuthDebug,
        stage: 'token_no_access_token',
        token_payload_keys: payloadKeys
      };
      req.session.flash = {
        type: 'error',
        message: msg
      };
      return res.redirect(oauthNoticeRedirect('error', msg));
    }

    const expiresIn = Number(data.expires_in || 0);
    const tokenData = {
      access_token: accessToken,
      refresh_token: data.refresh_token,
      open_id: data.open_id,
      scope: data.scope,
      created_at: now,
      expires_at: expiresIn > 0 ? now + expiresIn * 1000 : null,
      raw: tokenResp.payload
    };

    if (!isApprovedTikTokOpenId(tokenData.open_id)) {
      const msg = `TikTok connected, but this account is not approved for this app. open_id=${tokenData.open_id || 'unknown'}`;
      req.session.tiktok = null;
      lastOAuthDebug = {
        ...lastOAuthDebug,
        stage: 'token_unapproved_open_id',
        open_id: tokenData.open_id || null,
        approved_open_ids_count: approvedOpenIds.size
      };
      return req.session.save(() => res.redirect(oauthNoticeRedirect('error', msg)));
    }

    req.session.tiktok = tokenData;

    const okMsg = 'TikTok connected successfully.';
    lastOAuthDebug = {
      ...lastOAuthDebug,
      stage: 'token_success',
      open_id: tokenData.open_id || null,
      expires_at: tokenData.expires_at || null
    };
    req.session.flash = { type: 'ok', message: okMsg };
    return req.session.save((_saveErr) => res.redirect(oauthNoticeRedirect('ok', okMsg)));
  } catch (e) {
    const msg = `Callback error: ${String(e.message || e)}`;
    lastOAuthDebug = {
      ...lastOAuthDebug,
      stage: 'callback_exception',
      exception: String(e.message || e)
    };
    req.session.flash = { type: 'error', message: msg };
    return res.redirect(oauthNoticeRedirect('error', msg));
  }
});

app.get('/auth/tiktok/logout', (req, res) => {
  req.session.tiktok = null;
  req.session.oauthState = null;
  req.session.flash = { type: 'ok', message: 'Disconnected TikTok session.' };
  res.redirect('/');
});

app.get('/api/status', (req, res) => {
  const t = getActiveTikTokAuth(req);
  const approved = Boolean(t?.open_id && isApprovedTikTokOpenId(t.open_id));
  res.json({
    ok: true,
    site_login_enabled: Boolean(SITE_LOGIN_USER && SITE_LOGIN_PASS),
    connected: Boolean(t?.access_token),
    approved,
    approved_open_ids_count: approvedOpenIds.size,
    open_id: t?.open_id || null,
    expires_at: t?.expires_at || null,
    has_access_token: Boolean(t?.access_token),
    redirect_uri: TIKTOK_REDIRECT_URI,
    session_id: req.sessionID || null,
    has_oauth_state: Boolean(req.session?.oauthState),
    oauth_debug: lastOAuthDebug
  });
});

app.get('/mac/clips', requireSiteSession, async (_req, res) => {
  try {
    const bridgeResp = await fetchMacBridgeClips();
    if (!bridgeResp.ok) {
      return res.status(bridgeResp.status || 502).json({
        ok: false,
        error: 'Failed to fetch clips from Mac bridge',
        bridge_status: bridgeResp.status,
        bridge_payload: bridgeResp.payload
      });
    }

    const clips = Array.isArray(bridgeResp.payload?.clips) ? bridgeResp.payload.clips : [];
    return res.json({
      ok: true,
      clip_count: clips.length,
      clips,
      bridge: MAC_BRIDGE_BASE_URL
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/mac/clips/delete', requireSiteSession, async (req, res) => {
  const namesRaw = Array.isArray(req.body?.names) ? req.body.names : [];
  const names = [...new Set(
    namesRaw
      .map((n) => String(n || '').trim())
      .filter((n) => isAllowedClipName(n))
  )];

  if (!names.length) {
    return res.status(400).json({ ok: false, error: 'Provide one or more valid clip names in body.names' });
  }

  try {
    const bridgeResp = await deleteMacBridgeClips(names);
    if (!bridgeResp.ok) {
      return res.status(bridgeResp.status || 502).json({
        ok: false,
        error: 'Failed to delete clips on Mac bridge',
        bridge_status: bridgeResp.status,
        bridge_payload: bridgeResp.payload
      });
    }

    return res.json({
      ok: true,
      requested: names,
      bridge: MAC_BRIDGE_BASE_URL,
      result: bridgeResp.payload
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/uploads/:file', async (req, res) => {
  const name = path.basename(req.params.file || '');
  if (!name) return res.status(404).send('Not found');
  const full = path.join(uploadDir, name);
  if (!full.startsWith(uploadDir)) return res.status(400).send('Invalid file');
  try {
    await fsp.access(full, fs.constants.R_OK);
    return res.sendFile(full, {
      headers: {
        'Cache-Control': 'public, max-age=300'
      }
    });
  } catch {
    return res.status(404).send('Not found');
  }
});

app.post('/publish/upload', requireApprovedTikTok, upload.single('video'), async (req, res) => {
  const t = getActiveTikTokAuth(req);
  if (!t?.access_token) {
    if (req.file?.path) {
      try { await fsp.unlink(req.file.path); } catch {}
    }
    return res.status(401).json({ ok: false, error: 'Not connected. Run OAuth first.' });
  }

  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'Missing uploaded file. Use form field name "video".' });
  }

  const caption = String(req.body?.caption || 'Dance Guru API demo post').trim();
  const videoUrl = publicUploadUrl(req.file.filename);

  try {
    const out = await publishVideoInit({
      accessToken: t.access_token,
      openId: t.open_id,
      caption,
      videoUrl
    });

    return res.status(out.ok ? 200 : 400).json({
      ok: out.ok,
      endpoint: '/v2/post/publish/video/init/',
      request: {
        caption,
        source: 'PULL_FROM_URL',
        temp_video_url: videoUrl,
        privacy_level: 'SELF_ONLY'
      },
      local_upload: {
        filename: req.file.filename,
        size_bytes: req.file.size,
        ttl_minutes: Math.round(uploadTtlMs / 60000)
      },
      response_status: out.status,
      response_payload: out.payload
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/publish/mac-clip', requireApprovedTikTok, async (req, res) => {
  const t = getActiveTikTokAuth(req);
  if (!t?.access_token) {
    return res.status(401).json({ ok: false, error: 'Not connected. Run OAuth first.' });
  }

  const name = String(req.body?.name || '').trim();
  const caption = String(req.body?.caption || 'Dance Guru API demo post').trim();
  if (!isAllowedClipName(name)) {
    return res.status(400).json({ ok: false, error: 'Invalid clip name. Use an existing .mp4 or .mov filename.' });
  }

  let videoUrl;
  try {
    videoUrl = getMacClipPublicUrl(name);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }

  try {
    const out = await publishVideoInit({
      accessToken: t.access_token,
      openId: t.open_id,
      caption,
      videoUrl
    });

    return res.status(out.ok ? 200 : 400).json({
      ok: out.ok,
      endpoint: '/v2/post/publish/video/init/',
      request: {
        caption,
        source: 'PULL_FROM_URL',
        selected_clip: name,
        video_url: videoUrl,
        privacy_level: 'SELF_ONLY'
      },
      response_status: out.status,
      response_payload: out.payload
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.use((err, _req, res, next) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ ok: false, error: `File too large. Max ${Math.round(maxUploadBytes / (1024 * 1024))} MB.` });
  }
  return res.status(400).json({ ok: false, error: String(err.message || err) });
});

cleanupUploadCache().catch(() => {});

app.listen(PORT, () => {
  console.log(`TikTok review demo running on :${PORT}`);
});
