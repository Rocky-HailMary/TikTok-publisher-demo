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
app.use(express.json());
const clipsRoot = path.resolve(EXPORT_CLIPS_DIR);
const allowedClipExt = new Set(['.mp4', '.mov']);

function isAllowedClipExt(name) {
  return allowedClipExt.has(path.extname(name).toLowerCase());
}

function getSafeClipName(name) {
  const basename = path.basename(String(name || ''));
  if (!basename || basename !== String(name || '')) return null;
  if (!isAllowedClipExt(basename)) return null;
  return basename;
}

function getSafeClipPath(name) {
  const safeName = getSafeClipName(name);
  if (!safeName) return null;

  const fullPath = path.resolve(clipsRoot, safeName);
  const rel = path.relative(clipsRoot, fullPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return fullPath;
}

function buildPublicUrl(pathname) {
  return new URL(pathname, BRIDGE_BASE_URL || `http://localhost:${PORT}`).toString();
}

function withFileToken(url) {
  if (!BRIDGE_FILE_TOKEN) return url;
  const u = new URL(url);
  u.searchParams.set('token', BRIDGE_FILE_TOKEN);
  return u.toString();
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

async function fileExists(fullPath) {
  try {
    const stat = await fsp.stat(fullPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function firstNonEmptyString(values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function normalizeHashtags(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const v of values) {
    const tag = String(v || '').trim();
    if (!tag) continue;
    out.push(tag.startsWith('#') ? tag : `#${tag}`);
  }
  return [...new Set(out)];
}

async function readPostingInfoForClip(clipName) {
  const postingFileName = `${clipName}.posting.json`;
  const postingPath = path.join(clipsRoot, postingFileName);
  if (!(await fileExists(postingPath))) return null;

  try {
    const raw = await fsp.readFile(postingPath, 'utf8');
    const payload = JSON.parse(raw);
    const postingTikTok = payload?.posting?.platforms?.tiktok || {};
    const creativeTikTok = payload?.creative?.base_platform_copy?.tiktok || {};

    const text = firstNonEmptyString([
      postingTikTok.caption,
      postingTikTok.description,
      postingTikTok.base_copy_ref?.caption,
      postingTikTok.base_copy_ref?.description,
      creativeTikTok.caption,
      creativeTikTok.description,
      payload?.creative?.hook_text
    ]);

    const hashtags = normalizeHashtags(
      postingTikTok.hashtags
      || postingTikTok.base_copy_ref?.hashtags
      || creativeTikTok.hashtags
      || []
    );

    return {
      text: text || null,
      hashtags,
      file: postingFileName
    };
  } catch {
    return {
      text: null,
      hashtags: [],
      file: postingFileName,
      parse_error: true
    };
  }
}

async function buildClipRecord(name) {
  const full = path.join(clipsRoot, name);
  let stat;
  try {
    stat = await fsp.stat(full);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const clipUrl = withFileToken(buildPublicUrl(`/clips/${encodeURIComponent(name)}`));

  const thumbCandidates = [
    `${name}.thumb.jpg`,
    `${name}.thumb.jpeg`,
    `${name}.thumb.png`
  ];

  let thumbName = null;
  for (const candidate of thumbCandidates) {
    if (await fileExists(path.join(clipsRoot, candidate))) {
      thumbName = candidate;
      break;
    }
  }

  const postingInfo = await readPostingInfoForClip(name);

  return {
    name,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    url: clipUrl,
    thumb_url: thumbName ? withFileToken(buildPublicUrl(`/support/${encodeURIComponent(thumbName)}`)) : null,
    posting: postingInfo,
    support_files: {
      posting_json: postingInfo?.file || null,
      meta_json: (await fileExists(path.join(clipsRoot, `${name}.meta.json`))) ? `${name}.meta.json` : null,
      thumbnail: thumbName
    }
  };
}

app.get('/health', async (_req, res) => {
  let clipCount = 0;
  try {
    const names = await fsp.readdir(clipsRoot);
    clipCount = names.filter((n) => isAllowedClipExt(n)).length;
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
    const clipNames = names.filter((n) => isAllowedClipExt(n));
    const records = await Promise.all(clipNames.map((name) => buildClipRecord(name)));
    const clips = records.filter(Boolean).sort((a, b) => (new Date(b.mtime).getTime() - new Date(a.mtime).getTime()));

    return res.json({ ok: true, clips });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/clips/delete', requireBridgeToken, async (req, res) => {
  const rawNames = Array.isArray(req.body?.names) ? req.body.names : [];
  const names = [...new Set(rawNames.map((n) => String(n || '').trim()).filter(Boolean))];

  if (!names.length) {
    return res.status(400).json({ ok: false, error: 'Provide one or more clip names in body.names' });
  }

  const deleted = [];
  const deletedSupportFiles = [];
  const missing = [];
  const invalid = [];
  const errors = [];

  const supportSuffixes = [
    '.posting.json',
    '.meta.json',
    '.thumb.jpg',
    '.thumb.jpeg',
    '.thumb.png',
    '.caption.txt',
    '.caption.json'
  ];

  for (const name of names) {
    const safeName = getSafeClipName(name);
    if (!safeName) {
      invalid.push(name);
      continue;
    }

    const videoPath = path.join(clipsRoot, safeName);

    try {
      const stat = await fsp.stat(videoPath);
      if (stat.isFile()) {
        await fsp.unlink(videoPath);
        deleted.push(safeName);
      } else {
        missing.push(safeName);
      }
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        missing.push(safeName);
      } else {
        errors.push({ name: safeName, error: String(e.message || e) });
      }
    }

    for (const suffix of supportSuffixes) {
      const supportName = `${safeName}${suffix}`;
      const supportPath = path.join(clipsRoot, supportName);
      try {
        const st = await fsp.stat(supportPath);
        if (!st.isFile()) continue;
        await fsp.unlink(supportPath);
        deletedSupportFiles.push(supportName);
      } catch (e) {
        if (!(e && e.code === 'ENOENT')) {
          errors.push({ name: supportName, error: String(e.message || e) });
        }
      }
    }
  }

  return res.json({
    ok: errors.length === 0,
    requested: names,
    deleted,
    deleted_support_files: deletedSupportFiles,
    missing,
    invalid,
    errors
  });
});

app.get('/support/:name', requireFileTokenIfEnabled, async (req, res) => {
  const safeName = path.basename(String(req.params.name || ''));
  if (!safeName || safeName !== String(req.params.name || '')) {
    return res.status(400).json({ ok: false, error: 'Invalid support filename' });
  }

  const allowedSupportSuffixes = ['.thumb.jpg', '.thumb.jpeg', '.thumb.png'];
  if (!allowedSupportSuffixes.some((suffix) => safeName.endsWith(suffix))) {
    return res.status(400).json({ ok: false, error: 'Unsupported support file type' });
  }

  const fullPath = path.resolve(clipsRoot, safeName);
  const rel = path.relative(clipsRoot, fullPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return res.status(400).json({ ok: false, error: 'Invalid support file path' });
  }

  try {
    const stat = await fsp.stat(fullPath);
    if (!stat.isFile()) return res.status(404).json({ ok: false, error: 'Not found' });

    const ext = path.extname(safeName).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : (ext === '.jpeg' || ext === '.jpg' ? 'image/jpeg' : 'application/octet-stream');
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Cache-Control', 'public, max-age=600');

    return fs.createReadStream(fullPath).pipe(res);
  } catch (e) {
    if (e && e.code === 'ENOENT') return res.status(404).json({ ok: false, error: 'Not found' });
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
    const fileSize = stat.size;

    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=120');
    res.setHeader('Accept-Ranges', 'bytes');

    const range = String(req.headers.range || '').trim();
    if (range) {
      const match = range.match(/bytes=(\d*)-(\d*)/i);
      if (!match) {
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        return res.status(416).end();
      }

      let start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : fileSize - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= fileSize) {
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        return res.status(416).end();
      }
      end = Math.min(end, fileSize - 1);

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', String((end - start) + 1));
      return fs.createReadStream(fullPath, { start, end }).pipe(res);
    }

    res.setHeader('Content-Length', String(fileSize));
    return fs.createReadStream(fullPath).pipe(res);
  } catch (e) {
    if (e && e.code === 'ENOENT') return res.status(404).json({ ok: false, error: 'Not found' });
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`mac-mini-clip-bridge listening on :${PORT}`);
  console.log(`Export clips dir: ${clipsRoot}`);
});
