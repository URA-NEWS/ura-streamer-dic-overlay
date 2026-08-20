const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3942;
let streamersData = [];
let overlaySettings = { width: 640, bgOpacity: 0.85, bgLevel: 12, fontScale: 1 };
let connectedClients = { dock: new Set(), overlay: new Set() };

const streamersJsonPath = path.join(__dirname, 'streamers.json');

function loadStreamersData() {
  try {
    if (fs.existsSync(streamersJsonPath)) {
      streamersData = JSON.parse(fs.readFileSync(streamersJsonPath, 'utf-8'));
      console.log(`Loaded ${streamersData.length} streamers`);
    } else {
      streamersData = [];
    }
  } catch (err) {
    console.error('Failed to load streamers.json:', err.message);
    streamersData = [];
  }
}

function saveStreamersData() {
  try {
    fs.writeFileSync(streamersJsonPath, JSON.stringify(streamersData, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Save failed:', err.message);
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 30 * 1024 * 1024) { req.destroy(); reject(new Error('too large')); }
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
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(filePath, 'utf-8'));
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
      streamersData = data;
      const ok = saveStreamersData();
      connectedClients.dock.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'dataUpdated' }));
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, count: streamersData.length }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
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
    loadStreamersData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, count: streamersData.length }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let clientType = null;

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.type === 'init') {
        clientType = msg.clientType;
        if (connectedClients[clientType]) connectedClients[clientType].add(ws);
        ws.send(JSON.stringify({ type: 'ack', clientType, settings: overlaySettings }));
        console.log(`${clientType} connected. dock=${connectedClients.dock.size} overlay=${connectedClients.overlay.size}`);
        return;
      }

      if (msg.type === 'selectStreamer') {
        const s = streamersData.find(x => x.id === msg.streamerId);
        if (s) {
          connectedClients.overlay.forEach(c => {
            if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'showStreamer', streamer: s }));
          });
          console.log(`-> ${s.name} to ${connectedClients.overlay.size} overlay(s)`);
        }
        return;
      }

      if (msg.type === 'hideStreamer') {
        connectedClients.overlay.forEach(c => {
          if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'hideOverlay' }));
        });
        return;
      }

      // スクロール操作
      if (msg.type === 'scroll') {
        connectedClients.overlay.forEach(c => {
          if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'scroll', dir: msg.dir }));
        });
        return;
      }

      if (msg.type === 'updateSettings') {
        overlaySettings = Object.assign(overlaySettings, msg.settings || {});
        connectedClients.overlay.forEach(c => {
          if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'settings', settings: overlaySettings }));
        });
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

console.log(`cwd: ${__dirname}`);
loadStreamersData();
server.listen(PORT, () => {
  console.log(`Streamer Dictionary Overlay Server / Port: ${PORT}`);
  console.log(`Dock:    /dock`);
  console.log(`Overlay: /overlay`);
});
