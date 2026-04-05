const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
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
  DEMO_VIDEO_URL = '',
  SESSION_SECRET = 'change-this-in-production',
  ALLOWED_ORIGINS = 'https://www.hypercreative.games,https://hypercreative.games',
  SESSION_COOKIE_DOMAIN = ''
} = process.env;

const allowedOrigins = ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);

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

app.use(
  session({
    name: 'dg_tiktok_demo',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: APP_BASE_URL.startsWith('https://'),
      domain: SESSION_COOKIE_DOMAIN || undefined
    }
  })
);

function mustHaveConfig() {
  const missing = [];
  if (!TIKTOK_CLIENT_KEY) missing.push('TIKTOK_CLIENT_KEY');
  if (!TIKTOK_CLIENT_SECRET) missing.push('TIKTOK_CLIENT_SECRET');
  if (!TIKTOK_REDIRECT_URI) missing.push('TIKTOK_REDIRECT_URI');
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
  if (openId) headers['open_id'] = openId;

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

function renderHome(req, res) {
  const missing = mustHaveConfig();
  const tiktok = req.session.tiktok || null;
  const connected = Boolean(tiktok?.access_token);
  const openId = tiktok?.open_id || 'n/a';
  const createdAt = fmtDate(tiktok?.created_at);
  const expiresAt = tiktok?.expires_at ? fmtDate(tiktok.expires_at) : 'n/a';
  const flash = req.session.flash || null;
  req.session.flash = null;

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Dance Guru TikTok Demo</title>
  <style>
    body { font-family: Inter, system-ui, Arial, sans-serif; margin: 24px; max-width: 860px; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 16px; margin-bottom: 14px; }
    .ok { color: #0f7a2c; }
    .bad { color: #a12121; }
    button { padding: 10px 14px; border-radius: 8px; border: 1px solid #aaa; cursor: pointer; }
    input, textarea { width: 100%; padding: 9px; margin: 6px 0 10px; border: 1px solid #bbb; border-radius: 8px; }
    pre { background:#111; color:#f7f7f7; padding: 12px; border-radius: 10px; overflow:auto; max-height: 260px; }
    .muted { color: #666; font-size: 13px; }
  </style>
</head>
<body>
  <h1>Dance Guru TikTok Review Demo</h1>
  <p class="muted">Domain: ${APP_BASE_URL}</p>

  ${flash ? `<div class="card ${flash.type === 'error' ? 'bad' : 'ok'}">${flash.message}</div>` : ''}

  <div class="card">
    <h3>Config check</h3>
    ${missing.length ? `<p class="bad">Missing env vars: ${missing.join(', ')}</p>` : '<p class="ok">Config looks complete.</p>'}
    <p class="muted">Redirect URI configured: ${TIKTOK_REDIRECT_URI}</p>
  </div>

  <div class="card">
    <h3>1) Connect TikTok (OAuth)</h3>
    <p>Status: ${connected ? '<span class="ok">Connected</span>' : '<span class="bad">Not connected</span>'}</p>
    <p class="muted">open_id: ${openId}</p>
    <p class="muted">token created_at: ${createdAt} | expires_at: ${expiresAt}</p>
    <p>
      <a href="/auth/tiktok/start"><button>Connect TikTok</button></a>
      <a href="/auth/tiktok/logout"><button>Disconnect</button></a>
    </p>
  </div>

  <div class="card">
    <h3>2) Publish test video (sandbox/demo)</h3>
    <form id="publishForm">
      <label>Video URL (public):</label>
      <input id="video_url" name="video_url" placeholder="https://.../demo.mp4" value="${DEMO_VIDEO_URL || ''}" />

      <label>Caption:</label>
      <textarea id="caption" name="caption" rows="3" placeholder="Test post from Dance Guru demo">Dance Guru TikTok API demo post</textarea>

      <button type="submit">Publish Test</button>
    </form>
    <pre id="result">No publish attempt yet.</pre>
  </div>

  <div class="card">
    <h3>Review checklist</h3>
    <ul>
      <li>Show this domain + URL in browser address bar.</li>
      <li>Click Connect TikTok and show consent screen.</li>
      <li>Return to app showing connected state.</li>
      <li>Publish test and show API response payload.</li>
    </ul>
  </div>

  <script>
    const form = document.getElementById('publishForm');
    const result = document.getElementById('result');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      result.textContent = 'Publishing...';
      const payload = {
        video_url: document.getElementById('video_url').value,
        caption: document.getElementById('caption').value
      };
      try {
        const r = await fetch('/publish/test', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify(payload)
        });
        const d = await r.json();
        result.textContent = JSON.stringify(d, null, 2);
      } catch (err) {
        result.textContent = String(err);
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
    req.session.flash = { type: 'error', message: `Missing env vars: ${missing.join(', ')}` };
    return res.redirect('/');
  }

  const state = crypto.randomBytes(24).toString('hex');
  req.session.oauthState = state;
  return res.redirect(authUrl(state));
});

app.get('/auth/tiktok/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    req.session.flash = { type: 'error', message: `TikTok error: ${error} ${error_description || ''}` };
    return res.redirect('/');
  }

  if (!code) {
    req.session.flash = { type: 'error', message: 'Missing authorization code in callback.' };
    return res.redirect('/');
  }

  if (!state || state !== req.session.oauthState) {
    req.session.flash = { type: 'error', message: 'State mismatch. Please retry OAuth.' };
    return res.redirect('/');
  }

  try {
    const tokenResp = await exchangeCodeForToken(String(code));
    if (!tokenResp.ok) {
      req.session.flash = {
        type: 'error',
        message: `Token exchange failed (HTTP ${tokenResp.status}): ${JSON.stringify(tokenResp.payload)}`
      };
      return res.redirect('/');
    }

    const data = tokenResp.payload?.data || tokenResp.payload || {};
    const expiresIn = Number(data.expires_in || 0);
    const now = Date.now();
    req.session.tiktok = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      open_id: data.open_id,
      scope: data.scope,
      created_at: now,
      expires_at: expiresIn > 0 ? now + expiresIn * 1000 : null,
      raw: tokenResp.payload
    };

    req.session.flash = { type: 'ok', message: 'TikTok connected successfully.' };
    return res.redirect('/');
  } catch (e) {
    req.session.flash = { type: 'error', message: `Callback error: ${String(e.message || e)}` };
    return res.redirect('/');
  }
});

app.get('/auth/tiktok/logout', (req, res) => {
  req.session.tiktok = null;
  req.session.oauthState = null;
  req.session.flash = { type: 'ok', message: 'Disconnected TikTok session.' };
  res.redirect('/');
});

app.get('/api/status', (req, res) => {
  const t = req.session.tiktok || null;
  res.json({
    ok: true,
    connected: Boolean(t?.access_token),
    open_id: t?.open_id || null,
    expires_at: t?.expires_at || null,
    has_access_token: Boolean(t?.access_token),
    redirect_uri: TIKTOK_REDIRECT_URI
  });
});

app.post('/publish/test', async (req, res) => {
  const t = req.session.tiktok || null;
  if (!t?.access_token) {
    return res.status(401).json({ ok: false, error: 'Not connected. Run OAuth first.' });
  }

  const videoUrl = String(req.body?.video_url || DEMO_VIDEO_URL || '').trim();
  const caption = String(req.body?.caption || 'Dance Guru API demo post').trim();
  if (!videoUrl) {
    return res.status(400).json({ ok: false, error: 'Missing video_url. Provide a public MP4 URL.' });
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

app.listen(PORT, () => {
  console.log(`TikTok review demo running on :${PORT}`);
});
