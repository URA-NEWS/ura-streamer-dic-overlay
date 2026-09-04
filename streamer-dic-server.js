const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3942;
const VERSION = '2026-09-05-timeline-upload';

/* ───── Supabase 設定 ─────
   SUPABASE_URL              例: https://xxxxxxxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY サービスロールキー（サーバー専用・公開禁止）
   SUPABASE_STORAGE_BUCKET   任意。設定すると年表画像をSupabase Storageへ保存
   未設定ならローカルファイルに保存する（開発用フォールバック）        */
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
const SB_TABLE = process.env.SUPABASE_TABLE || 'streamer_dic';
const SB_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || process.env.SUPABASE_BUCKET || '';
const USE_SB = !!(SB_URL && SB_KEY);
const USE_SB_STORAGE = !!(USE_SB && SB_STORAGE_BUCKET);

const LOCAL_DIR = process.env.DATA_DIR || __dirname;
const localStreamersPath = path.join(LOCAL_DIR, 'streamers.json');
const localSettingsPath  = path.join(LOCAL_DIR, 'settings.json');
const uploadDir = process.env.UPLOAD_DIR || path.join(LOCAL_DIR, 'uploads');

let streamersData = [];
let overlaySettings = { width: 640, bgOpacity: 0.9, bgLevel: 8, fontScale: 1, volume: 60 };
let connectedClients = { dock: new Set(), overlay: new Set() };
let lastError = '';
let clientVersions = { dock: null, overlay: null };
let selectedStreamerId = null;

/* ───── Supabase REST ───── */
function sbHeaders(extra) {
  return Object.assign({
    'apikey': SB_KEY,
    'Authorization': 'Bearer ' + SB_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

async function sbGet(key) {
  const url = `${SB_URL}/rest/v1/${SB_TABLE}?key=eq.${encodeURIComponent(key)}&select=data`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`GET ${key} ${r.status} ${await r.text()}`);
  const rows = await r.json();
  return rows.length ? rows[0].data : null;
}

async function sbPut(key, data) {
  const url = `${SB_URL}/rest/v1/${SB_TABLE}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify([{ key, data, updated_at: new Date().toISOString() }])
  });
  if (!r.ok) throw new Error(`PUT ${key} ${r.status} ${await r.text()}`);
  return true;
}

async function sbUploadImage(objectName, buffer, mime) {
  const url = `${SB_URL}/storage/v1/object/${encodeURIComponent(SB_STORAGE_BUCKET)}/${objectName}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type': mime,
      'x-upsert': 'true'
    },
    body: buffer
  });
  if (!r.ok) throw new Error(`UPLOAD ${r.status} ${await r.text()}`);
  return `${SB_URL}/storage/v1/object/public/${encodeURIComponent(SB_STORAGE_BUCKET)}/${objectName}`;
}

/* ───── ローカル保存（フォールバック） ───── */
function localRead(p, fallback) {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) { console.error('local read failed:', err.message); }
  return fallback;
}

function localWrite(p, data) {
  try {
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, p);
    return true;
  } catch (err) {
    console.error('local write failed:', err.message);
    return false;
  }
}

function bundledStreamers() {
  const data = localRead(path.join(__dirname, 'streamers.json'), []);
  return Array.isArray(data) ? data : [];
}

function mergeBundledStreamers(current) {
  const data = Array.isArray(current) ? current.slice() : [];
  const seed = bundledStreamers().filter(s => s && s.id);
  let changed = false;
  seed.forEach(s => {
    const i = data.findIndex(x => x && x.id === s.id);
    if (i >= 0) {
      if (JSON.stringify(data[i]) !== JSON.stringify(s)) {
        data[i] = s;
        changed = true;
      }
    } else {
      data.push(s);
      changed = true;
    }
  });
  return { data, changed, seedCount: seed.length };
}

function ensureUploadDir() {
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
}

function imageExt(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'jpg';
}

function mimeFromExt(ext) {
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

function safePart(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'image';
}

async function saveUploadedImage(dataUrl, meta) {
  const m = String(dataUrl || '').match(/^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([a-zA-Z0-9+/=]+)$/);
  if (!m) throw new Error('image data required');
  const mime = m[1] === 'image/jpg' ? 'image/jpeg' : m[1];
  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length) throw new Error('empty image');
  if (buffer.length > 8 * 1024 * 1024) throw new Error('image too large');

  const ext = imageExt(mime);
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const name = [safePart(meta.streamerId), safePart(meta.date), safePart(meta.title), stamp]
    .filter(Boolean).join('-') + '.' + ext;
  const objectName = `timeline/${name}`;

  if (USE_SB_STORAGE) return { url: await sbUploadImage(objectName, buffer, mime), storage: 'supabase-storage' };

  ensureUploadDir();
  const filePath = path.join(uploadDir, name);
  fs.writeFileSync(filePath, buffer);
  return { url: `/uploads/${name}`, storage: 'local-upload' };
}

function serveUpload(res, urlPath) {
  const name = path.basename(decodeURIComponent(urlPath.replace(/^\/uploads\//, '')));
  const filePath = path.join(uploadDir, name);
  if (!filePath.startsWith(uploadDir) || !fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  res.writeHead(200, { 'Content-Type': mimeFromExt(path.extname(filePath).toLowerCase()), 'Cache-Control': 'public, max-age=31536000, immutable' });
  fs.createReadStream(filePath).pipe(res);
}

function patchDockHtml(html) {
  const patchedVersion = html.replace(/const APP_VERSION = '[^']+';/, "const APP_VERSION = '2026-09-05-upload-backed-timeline';");
  const replacement = String.raw`function pickTimelineImage(i){
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = ev => {
      const img = new Image();
      img.onload = async () => {
        try {
          const MAX = 1000;
          const sc = Math.min(1, MAX / Math.max(img.width, img.height));
          const cv = document.createElement('canvas');
          cv.width = Math.round(img.width * sc);
          cv.height = Math.round(img.height * sc);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          const imageData = cv.toDataURL('image/jpeg', 0.86);
          $('editStatus').textContent = '画像をアップロードしています…';
          const r = await fetch('/api/upload-image', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({
              imageData,
              streamerId: editing && editing.id ? editing.id : 'new',
              date: editing.timeline[i].date || '',
              title: editing.timeline[i].title || ''
            })
          });
          const j = await r.json();
          if (!r.ok || !j.ok || !j.url) throw new Error(j.error || 'upload failed');
          editing.timeline[i].imageUrl = j.url;
          renderTimeline();
          $('editStatus').textContent = '画像をアップロードしました。保存を押してください。';
        } catch (err) {
          $('editStatus').textContent = '画像をアップロードできませんでした：' + err.message;
        }
      };
      img.src = ev.target.result;
    };
    rd.readAsDataURL(f);
  };
  inp.click();
}

/* 配信サイト */`;
  return patchedVersion.replace(/function pickTimelineImage\(i\)\{[\s\S]*?\n\}\n\n\/\* 配信サイト \*\//, replacement);
}

/* ───── 読み込み ───── */
async function loadAll() {
  if (USE_SB) {
    try {
      const s = await sbGet('streamers');
      if (Array.isArray(s)) {
        const merged = mergeBundledStreamers(s);
        streamersData = merged.data;
        if (merged.changed) await sbPut('streamers', streamersData);
        console.log(`Supabase: loaded ${s.length} streamers${merged.changed ? ', synced bundled data' : ''}`);
      } else {
        streamersData = bundledStreamers();
        if (streamersData.length) {
          await sbPut('streamers', streamersData);
          console.log(`Supabase: seeded ${streamersData.length} streamers`);
        } else {
          await sbPut('streamers', []);
          console.log('Supabase: initialized empty streamers');
        }
      }

      const st = await sbGet('settings');
      if (st && typeof st === 'object') overlaySettings = Object.assign(overlaySettings, st);
      lastError = '';
    } catch (err) {
      lastError = err.message;
      console.error('Supabase load failed:', err.message);
      const merged = mergeBundledStreamers(localRead(localStreamersPath, []));
      streamersData = merged.data;
    }
  } else {
    const merged = mergeBundledStreamers(localRead(localStreamersPath, []));
    streamersData = merged.data;
    if (merged.changed) localWrite(localStreamersPath, streamersData);
    overlaySettings = Object.assign(overlaySettings, localRead(localSettingsPath, {}));
    console.log(`Local: loaded ${streamersData.length} streamers${merged.changed ? ', synced bundled data' : ''}`);
  }
}

/* ───── 保存 ───── */
async function saveStreamers() {
  if (USE_SB) {
    try {
      await sbPut('streamers', streamersData);
      lastError = '';
      return true;
    } catch (err) {
      lastError = err.message;
      console.error('Supabase save failed:', err.message);
      return false;
    }
  }
  return localWrite(localStreamersPath, streamersData);
}

let settingsTimer = null;
function saveSettingsSoon() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(async () => {
    if (USE_SB) {
      try { await sbPut('settings', overlaySettings); }
      catch (err) { console.error('Supabase settings save failed:', err.message); }
    } else {
      localWrite(localSettingsPath, overlaySettings);
    }
  }, 1500);
}

function sendToOverlays(payload) {
  connectedClients.overlay.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(payload));
  });
}

function refreshSelectedStreamer() {
  if (!selectedStreamerId) return;
  const idx = streamersData.findIndex(x => x.id === selectedStreamerId);
  const s = idx >= 0 ? streamersData[idx] : null;
  if (!s) return;
  sendToOverlays({ type: 'showStreamer', streamer: s, index: idx });
}

/* ───── HTTP ───── */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 80 * 1024 * 1024) { req.destroy(); reject(new Error('too large')); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function serveFile(res, fileName) {
  const filePath = path.join(__dirname, fileName);
  try {
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`File not found: ${fileName}`);
      return;
    }
    let body = fs.readFileSync(filePath, 'utf-8');
    if (fileName === 'streamer_dic_dock.html') body = patchDockHtml(body);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Error: ' + err.message);
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = req.url.split('?')[0];
  console.log(`[${new Date().toISOString()}] ${req.method} ${url}`);

  if (url === '/dock' && req.method === 'GET') { serveFile(res, 'streamer_dic_dock.html'); return; }
  if (url === '/overlay' && req.method === 'GET') { serveFile(res, 'streamer_dic_overlay.html'); return; }
  if (url.startsWith('/uploads/') && req.method === 'GET') { serveUpload(res, url); return; }

  if (url === '/api/streamers' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(streamersData));
    return;
  }

  if (url === '/api/streamers' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      if (!Array.isArray(data)) throw new Error('array required');
      const prev = streamersData;
      streamersData = data;
      const ok = await saveStreamers();
      if (!ok) streamersData = prev;
      connectedClients.dock.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'dataUpdated' }));
      });
      if (ok) refreshSelectedStreamer();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, count: streamersData.length, error: ok ? undefined : lastError }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (url === '/api/upload-image' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const saved = await saveUploadedImage(data.imageData || data.dataUrl, data || {});
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, url: saved.url, storage: saved.storage }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (url === '/api/settings' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(overlaySettings));
    return;
  }

  if (url === '/api/reload' && req.method === 'POST') {
    await loadAll();
    connectedClients.dock.forEach(c => {
      if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'dataUpdated' }));
    });
    refreshSelectedStreamer();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, count: streamersData.length }));
    return;
  }

  if (url === '/api/health' && req.method === 'GET') {
    const info = {
      serverVersion: VERSION,
      dockVersion: clientVersions.dock || '(未接続)',
      overlayVersion: clientVersions.overlay || '(未接続)',
      connected: { dock: connectedClients.dock.size, overlay: connectedClients.overlay.size },
      storage: USE_SB ? 'supabase' : 'local-file',
      imageStorage: USE_SB_STORAGE ? `supabase-storage:${SB_STORAGE_BUCKET}` : 'local-upload',
      supabaseUrl: USE_SB ? SB_URL : null,
      table: USE_SB ? SB_TABLE : null,
      streamers: streamersData.length,
      selectedStreamerId,
      lastError: lastError || null
    };
    if (USE_SB) {
      try {
        const probe = await sbGet('streamers');
        info.reachable = true;
        info.rowExists = probe !== null;
      } catch (err) {
        info.reachable = false;
        info.lastError = err.message;
      }
    } else {
      info.path = localStreamersPath;
      info.fileExists = fs.existsSync(localStreamersPath);
      info.uploadDir = uploadDir;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(info, null, 2));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

/* ───── WebSocket ───── */
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let clientType = null;

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.type === 'init') {
        clientType = msg.clientType;
        if (connectedClients[clientType]) connectedClients[clientType].add(ws);
        if (clientType in clientVersions) clientVersions[clientType] = msg.version || '(不明・旧版)';
        ws.send(JSON.stringify({ type: 'ack', clientType, settings: overlaySettings }));
        console.log(`${clientType} connected. dock=${connectedClients.dock.size} overlay=${connectedClients.overlay.size}`);
        return;
      }

      if (msg.type === 'selectStreamer') {
        const idx = streamersData.findIndex(x => x.id === msg.streamerId);
        const s = idx >= 0 ? streamersData[idx] : null;
        if (s) {
          selectedStreamerId = msg.streamerId;
          sendToOverlays({ type: 'showStreamer', streamer: s, index: idx });
        }
        return;
      }

      if (msg.type === 'hideStreamer') {
        selectedStreamerId = null;
        sendToOverlays({ type: 'hideOverlay' });
        return;
      }

      if (msg.type === 'scroll') {
        sendToOverlays({ type: 'scroll', dir: msg.dir });
        return;
      }

      if (msg.type === 'playVideo') {
        sendToOverlays({ type: 'playVideo', url: msg.url, title: msg.title });
        return;
      }

      if (msg.type === 'videoCmd') {
        sendToOverlays({ type: 'videoCmd', action: msg.action, value: msg.value });
        return;
      }

      if (msg.type === 'videoState') {
        connectedClients.dock.forEach(c => {
          if (c.readyState === WebSocket.OPEN) {
            c.send(JSON.stringify({
              type: 'videoState',
              playing: msg.playing,
              time: msg.time,
              duration: msg.duration,
              controllable: msg.controllable
            }));
          }
        });
        return;
      }

      if (msg.type === 'stopVideo') {
        sendToOverlays({ type: 'stopVideo' });
        return;
      }

      if (msg.type === 'setVolume') {
        overlaySettings.volume = msg.volume;
        saveSettingsSoon();
        sendToOverlays({ type: 'setVolume', volume: msg.volume });
        return;
      }

      if (msg.type === 'updateSettings') {
        overlaySettings = Object.assign(overlaySettings, msg.settings || {});
        saveSettingsSoon();
        sendToOverlays({ type: 'settings', settings: overlaySettings });
        return;
      }

    } catch (err) {
      console.error('WS message error:', err.message);
    }
  });

  ws.on('close', () => {
    if (clientType && connectedClients[clientType]) connectedClients[clientType].delete(ws);
  });

  ws.on('error', (err) => console.error('WS error:', err.message));
});

/* ───── 起動 ───── */
if (typeof fetch !== 'function') {
  console.error('このNode.jsにはfetchがありません。Node 18以上が必要です。');
}

loadAll().then(() => {
  server.listen(PORT, () => {
    console.log('Streamer Dictionary Overlay Server  ' + VERSION);
    console.log(`  Port:      ${PORT}`);
    console.log(`  Storage:   ${USE_SB ? 'Supabase (' + SB_URL + ' / ' + SB_TABLE + ')' : 'ローカルファイル ' + localStreamersPath}`);
    console.log(`  Images:    ${USE_SB_STORAGE ? 'Supabase Storage (' + SB_STORAGE_BUCKET + ')' : 'ローカルアップロード ' + uploadDir}`);
    console.log(`  Streamers: ${streamersData.length}`);
    if (!USE_SB) console.log('  ※ SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が未設定です');
  });
});
