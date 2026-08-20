const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3942;
let streamersData = [];
let connectedClients = {
  dock: new Set(),
  overlay: new Set()
};

// JSONファイルパス
const streamersJsonPath = path.join(__dirname, 'streamers.json');

// 起動時にstreamers.jsonを読み込み
function loadStreamersData() {
  try {
    if (fs.existsSync(streamersJsonPath)) {
      const data = fs.readFileSync(streamersJsonPath, 'utf-8');
      streamersData = JSON.parse(data);
      console.log(`✓ Loaded ${streamersData.length} streamers from streamers.json`);
    } else {
      console.warn('⚠ streamers.json not found. Create one or run extract_streamers.js');
      streamersData = [];
    }
  } catch (err) {
    console.error('✗ Failed to load streamers.json:', err.message);
    streamersData = [];
  }
}

// HTTPサーバー
const server = http.createServer((req, res) => {
  // CORS設定
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  // ドック UI
  if (req.url === '/dock' && req.method === 'GET') {
    const filePath = path.join(__dirname, 'streamer_dic_dock.html');
    console.log(`Attempting to read dock file: ${filePath}`);
    try {
      if (!fs.existsSync(filePath)) {
        console.error(`✗ Dock file not found: ${filePath}`);
        console.log(`Files in ${__dirname}:`, fs.readdirSync(__dirname));
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`File not found: ${filePath}\nFiles: ${fs.readdirSync(__dirname).join(', ')}`);
        return;
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
      console.log('✓ Dock file served successfully');
    } catch (err) {
      console.error('✗ Error reading dock file:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error: ' + err.message);
    }
    return;
  }

  // 表示UI
  if (req.url === '/overlay' && req.method === 'GET') {
    const filePath = path.join(__dirname, 'streamer_dic_overlay.html');
    console.log(`Attempting to read overlay file: ${filePath}`);
    try {
      if (!fs.existsSync(filePath)) {
        console.error(`✗ Overlay file not found: ${filePath}`);
        console.log(`Files in ${__dirname}:`, fs.readdirSync(__dirname));
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`File not found: ${filePath}\nFiles: ${fs.readdirSync(__dirname).join(', ')}`);
        return;
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
      console.log('✓ Overlay file served successfully');
    } catch (err) {
      console.error('✗ Error reading overlay file:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error: ' + err.message);
    }
    return;
  }

  // JSONエンドポイント（ドック/表示から直接GET）
  if (req.url === '/api/streamers' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(streamersData));
    console.log(`✓ API /streamers returned ${streamersData.length} items`);
    return;
  }

  // データリロード（管理用）
  if (req.url === '/api/reload' && req.method === 'POST') {
    loadStreamersData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, count: streamersData.length }));
    console.log('✓ Streamers data reloaded');
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// WebSocketサーバー
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let clientType = null;

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      // クライアント初期化メッセージ
      if (msg.type === 'init') {
        clientType = msg.clientType; // 'dock' or 'overlay'
        if (connectedClients[clientType]) {
          connectedClients[clientType].add(ws);
          console.log(`✓ ${clientType} connected. Total: dock=${connectedClients.dock.size}, overlay=${connectedClients.overlay.size}`);
        }
        ws.send(JSON.stringify({ type: 'ack', clientType }));
        return;
      }

      // ドックから「配信者選択」メッセージ
      if (msg.type === 'selectStreamer') {
        const selectedStreamer = streamersData.find(s => s.id === msg.streamerId);
        if (selectedStreamer) {
          // すべてのoverlayクライアントに配信
          connectedClients.overlay.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'showStreamer',
                streamer: selectedStreamer
              }));
            }
          });
          console.log(`→ Sent ${selectedStreamer.name} to ${connectedClients.overlay.size} overlay(s)`);
        }
        return;
      }

      // オーバーレイから「非表示」メッセージ
      if (msg.type === 'hideStreamer') {
        connectedClients.overlay.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'hideOverlay' }));
          }
        });
        return;
      }

    } catch (err) {
      console.error('WebSocket message error:', err.message);
    }
  });

  ws.on('close', () => {
    if (clientType && connectedClients[clientType]) {
      connectedClients[clientType].delete(ws);
      console.log(`✗ ${clientType} disconnected. Total: dock=${connectedClients.dock.size}, overlay=${connectedClients.overlay.size}`);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

// サーバー起動
console.log(`Current working directory: ${__dirname}`);
console.log(`Files available: ${fs.readdirSync(__dirname).join(', ')}`);
loadStreamersData();
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   Streamer Dictionary Overlay Server   ║
╠════════════════════════════════════════╣
║ Port: ${PORT}
║ Dock:    http://localhost:${PORT}/dock
║ Overlay: http://localhost:${PORT}/overlay
║ API:     http://localhost:${PORT}/api/streamers
╚════════════════════════════════════════╝
  `);
});
