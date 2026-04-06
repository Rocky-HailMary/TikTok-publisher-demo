const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
require('dotenv').config();

const {
  PORT = 8787,
  BRIDGE_TOKEN = '',
  EXPORT_CLIPS_DIR = '/Users/rocky/.openclaw/workspaces/marketing/SyncFiles/export_clips',
  BRIDGE_BASE_URL = '',
  BRIDGE_FILE_TOKEN = ''
} = process.env;

const app = express();
const clipsRoot = path.resolve(EXPORT_CLIPS_DIR);
const allowedExt = new Set(['.mp4', '.mov']);

function isAllowedExt(name) {
  return allowedExt.has(path.extname(name).toLowerCase());
}

function getSafeClipPath(name) {
  const basename = path.basename(name || '');
  if (!basename || basename !== name) return null;
  if (!isAllowedExt(basename)) return null;

  const fullPath = path.resolve(clipsRoot, basename);
  const rel = path.relative(clipsRoot, fullPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return fullPath;
}

function requireBridgeToken(req, res, next) {
  if (!BRIDGE_TOKEN) {
    return res.status(500).json({ ok: false, error: 'BRIDGE_TOKEN is not configured' });
  }
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'Missing bearer token' });
  }
  const token = auth.slice('Bearer '.length).trim();
  if (!token || token !== BRIDGE_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Invalid token' });
  }
  return next();
}

function requireFileTokenIfEnabled(req, res, next) {
  if (!BRIDGE_FILE_TOKEN) return next();
  const token = String(req.query.token || '').trim();
  if (token !== BRIDGE_FILE_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Invalid file token' });
  }
  return next();
}

app.get('/health', async (_req, res) => {
  let clipCount = 0;
  try {
    const names = await fsp.readdir(clipsRoot);
    clipCount = names.filter((n) => isAllowedExt(n)).length;
  } catch {
    // ignore
  }

  res.json({
    ok: true,
    service: 'mac-mini-clip-bridge',
    clips_root: clipsRoot,
    bridge_base_url: BRIDGE_BASE_URL || null,
    clip_count_hint: clipCount,
    time: new Date().toISOString()
  });
});

app.get('/clips', requireBridgeToken, async (_req, res) => {
  try {
    const names = await fsp.readdir(clipsRoot);
    const clips = [];

    for (const name of names) {
      if (!isAllowedExt(name)) continue;
      const full = path.join(clipsRoot, name);
      let stat;
      try {
        stat = await fsp.stat(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      const clipUrl = new URL(`/clips/${encodeURIComponent(name)}`, BRIDGE_BASE_URL || `http://localhost:${PORT}`).toString();
      clips.push({
        name,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        url: BRIDGE_FILE_TOKEN ? `${clipUrl}?token=${encodeURIComponent(BRIDGE_FILE_TOKEN)}` : clipUrl
      });
    }

    clips.sort((a, b) => (new Date(b.mtime).getTime() - new Date(a.mtime).getTime()));

    return res.json({
      ok: true,
      clips
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/clips/:name', requireFileTokenIfEnabled, async (req, res) => {
  const name = String(req.params.name || '');
  const fullPath = getSafeClipPath(name);
  if (!fullPath) {
    return res.status(400).json({ ok: false, error: 'Invalid clip name. Only direct .mp4/.mov filenames are allowed.' });
  }

  try {
    const stat = await fsp.stat(fullPath);
    if (!stat.isFile()) return res.status(404).json({ ok: false, error: 'Not found' });

    const ext = path.extname(name).toLowerCase();
    const mime = ext === '.mov' ? 'video/quicktime' : 'video/mp4';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Cache-Control', 'public, max-age=120');
    res.setHeader('Accept-Ranges', 'bytes');

    const stream = fs.createReadStream(fullPath);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: 'Failed to stream clip' });
      } else {
        res.destroy();
      }
    });
    return stream.pipe(res);
  } catch (e) {
    if (e && e.code === 'ENOENT') return res.status(404).json({ ok: false, error: 'Not found' });
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`mac-mini-clip-bridge listening on :${PORT}`);
  console.log(`Export clips dir: ${clipsRoot}`);
});
