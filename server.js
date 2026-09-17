// LAN digital signage server: dashboard, REST API, media hosting, and a
// WebSocket channel that tells TV players to refresh when anything changes.
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const store = require('./lib/db');
const { createAuth } = require('./lib/auth');

// Local settings (ADMIN_PASSWORD and friends) from a git-ignored .env next to this
// file, so every way of starting the server picks them up. Variables already set in
// the real environment win, which keeps systemd's EnvironmentFile in charge on a server.
function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue; // blank lines and # comments
    let value = m[2];
    if (value.length >= 2 && ((value[0] === '"' && value.slice(-1) === '"') || (value[0] === "'" && value.slice(-1) === "'"))) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnvFile(process.env.SIGNAGE_ENV_FILE || path.join(__dirname, '.env'));

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
// Set when the server is reachable from the internet (e.g. through a tunnel).
// Purely informational, except that it makes a dashboard password mandatory.
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
// Cloudflare's proxy caps request bodies; the dashboard warns before uploading.
const TUNNEL_UPLOAD_LIMIT_MB = parseInt(process.env.TUNNEL_UPLOAD_LIMIT_MB || '100', 10);

if (PUBLIC_URL && !ADMIN_PASSWORD) {
  console.error('PUBLIC_URL is set but ADMIN_PASSWORD is empty. Refusing to expose the dashboard to the internet without a password.');
  process.exit(1);
}
const auth = createAuth({ password: ADMIN_PASSWORD, secret: process.env.SESSION_SECRET });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const app = express();
// Honour X-Forwarded-* only from the tunnel connector on this host, so a LAN
// client cannot spoof its address (and pick its own lockout bucket) or claim
// to be https. Set TRUSTED_PROXY if cloudflared runs on another machine.
app.set('trust proxy', process.env.TRUSTED_PROXY || 'loopback');
app.use(express.json({ limit: '2mb' }));

// ---------- login (always public) ----------
app.get('/login', (req, res) => {
  if (auth.isAuthenticated(req)) return res.redirect(302, '/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.post('/api/login', auth.login);
app.post('/api/logout', auth.logout);
app.get('/api/session', (req, res) => {
  const viaTunnel = auth.isViaTunnel(req);
  res.json({
    authRequired: auth.enabled, authenticated: auth.isAuthenticated(req),
    viaTunnel, uploadLimitMb: viaTunnel ? TUNNEL_UPLOAD_LIMIT_MB : null, publicUrl: PUBLIC_URL || null
  });
});

// Everything below is gated unless it is on the player allow-list in lib/auth.js.
app.use(auth.middleware);
// Cache-Control choices matter once a CDN sits in front (Cloudflare through the
// tunnel): "private" keeps it from caching multi-hundred-megabyte videos and
// "no-transform" keeps it from rewriting or injecting scripts into the player.
app.use('/media', express.static(MEDIA_DIR, {
  setHeaders: res => res.setHeader('Cache-Control', 'private, max-age=604800, immutable, no-transform'),
}));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: res => res.setHeader('Cache-Control', 'no-cache, no-transform'),
}));

const db = store.get();

// ---------- helpers ----------
function findOr404(list, id, res) {
  const item = list.find(x => x.id === id);
  if (!item) res.status(404).json({ error: 'Not found' });
  return item;
}
const mediaUrl = m => m.type === 'web' ? m.url : '/media/' + encodeURIComponent(m.file);
const publicMedia = m => Object.assign({}, m, { src: mediaUrl(m) });

// Turn a screen's simple settings into the zone list the player renders.
function buildPlayerConfig(s) {
  const items = (s.items || []).map(id => db.media.find(m => m.id === id)).filter(Boolean).map(m => ({
    id: m.id, type: m.type, name: m.name, src: mediaUrl(m),
    duration: m.type === 'video' ? 0 : Number(s.seconds) || 10
  }));
  const zones = [];
  const tickerZone = { type: 'ticker', text: s.ticker || '', speed: 80, background: '#0f172a', color: '#ffffff', fontSize: 4 };
  const clockZone = { type: 'clock', background: '#1e293b', color: '#ffffff', format: db.settings.clockFormat, showDate: true, fontSize: 4 };
  if (s.style === 'ticker') {
    zones.push({ type: 'playlist', x: 0, y: 0, w: 100, h: 90, fit: s.fit, items });
    zones.push(Object.assign({ x: 0, y: 90, w: s.clock ? 80 : 100, h: 10 }, tickerZone));
    if (s.clock) zones.push(Object.assign({ x: 80, y: 90, w: 20, h: 10 }, clockZone));
  } else {
    zones.push({ type: 'playlist', x: 0, y: 0, w: 100, h: 100, fit: s.fit, items });
    if (s.clock) zones.push(Object.assign({ x: 78, y: 2, w: 20, h: 10 }, clockZone, { background: 'rgba(15,23,42,0.6)' }));
  }
  const config = {
    screenId: s.id, name: s.name, paired: !!s.paired, code: s.paired ? undefined : s.code,
    layout: { id: s.style, name: s.style, background: '#000000' }, zones, clockFormat: db.settings.clockFormat
  };
  config.version = crypto.createHash('md5').update(JSON.stringify(config)).digest('hex').slice(0, 12);
  config.serverTime = Date.now();
  return config;
}

const screenSummary = s => Object.assign({}, s, { online: !!(s.lastSeen && Date.now() - s.lastSeen < 45000) });

// Registration is anonymous by design (a TV has no credentials yet), so it is
// rate-limited per client and the number of unpaired screens is capped: the
// pairing screen must not be usable to fill the database from the internet.
const REGISTER_PER_MINUTE = 30;
const MAX_UNPAIRED = 200;
const UNPAIRED_TTL_MS = 10 * 60 * 1000; // a TV showing a code refreshes every few seconds
const registerBuckets = new Map();
function allowRegister(ip) {
  const now = Date.now();
  const b = registerBuckets.get(ip) || { tokens: REGISTER_PER_MINUTE, last: now };
  b.tokens = Math.min(REGISTER_PER_MINUTE, b.tokens + (now - b.last) / 60000 * REGISTER_PER_MINUTE);
  b.last = now;
  const ok = b.tokens >= 1;
  if (ok) b.tokens -= 1;
  registerBuckets.set(ip, b);
  return ok;
}

// ---------- state ----------
app.get('/api/state', (req, res) => {
  res.json({ media: db.media.map(publicMedia), screens: db.screens.map(screenSummary), settings: db.settings, serverTime: Date.now() });
});
app.put('/api/settings', (req, res) => {
  Object.assign(db.settings, req.body || {});
  store.save(); notifyAllScreens(); res.json(db.settings);
});

// ---------- media ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: MEDIA_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const base = path.basename(file.originalname, ext).replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40);
      cb(null, base + '_' + store.id() + ext);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});

app.post('/api/media', upload.array('files', 100), (req, res) => {
  const created = [];
  for (const f of req.files || []) {
    const type = f.mimetype.startsWith('video/') ? 'video' : 'image';
    const m = { id: store.id(), name: f.originalname, type, file: f.filename, size: f.size, mime: f.mimetype, createdAt: Date.now() };
    db.media.push(m); created.push(publicMedia(m));
  }
  store.save(); notifyAdmins();
  res.json(created);
});
app.post('/api/media/web', (req, res) => {
  const body = req.body || {};
  if (!body.url) return res.status(400).json({ error: 'url required' });
  if (!/^https?:\/\//i.test(String(body.url))) return res.status(400).json({ error: 'Address must start with http:// or https://' });
  const m = { id: store.id(), name: body.name || body.url, type: 'web', url: body.url, createdAt: Date.now() };
  db.media.push(m); store.save(); notifyAdmins();
  res.json(publicMedia(m));
});
app.patch('/api/media/:id', (req, res) => {
  const m = findOr404(db.media, req.params.id, res); if (!m) return;
  if (req.body.name != null) m.name = req.body.name;
  if (req.body.url != null && m.type === 'web') m.url = req.body.url;
  store.save(); notifyAllScreens(); res.json(publicMedia(m));
});
app.delete('/api/media/:id', (req, res) => {
  const m = findOr404(db.media, req.params.id, res); if (!m) return;
  db.media = db.media.filter(x => x.id !== m.id);
  db.screens.forEach(s => { s.items = (s.items || []).filter(id => id !== m.id); });
  if (m.file) fs.unlink(path.join(MEDIA_DIR, m.file), () => {});
  store.save(); notifyAllScreens(); res.json({ ok: true });
});

// ---------- screens ----------
app.post('/api/screens/claim', (req, res) => {
  const code = String(req.body.code || '').toUpperCase().trim();
  const s = db.screens.find(x => x.code === code && !x.paired);
  if (!s) return res.status(404).json({ error: 'No TV is showing that code' });
  s.paired = true; s.name = req.body.name || 'TV ' + code;
  store.save(); notifyScreen(s.id); notifyAdmins(); res.json(screenSummary(s));
});
app.put('/api/screens/:id', (req, res) => {
  const s = findOr404(db.screens, req.params.id, res); if (!s) return;
  const b = req.body || {};
  if (b.name != null) s.name = String(b.name);
  if (b.style === 'full' || b.style === 'ticker') s.style = b.style;
  if (Array.isArray(b.items)) s.items = b.items.filter(id => db.media.some(m => m.id === id));
  if (b.seconds != null) s.seconds = Math.max(1, Number(b.seconds) || 10);
  if (b.fit === 'cover' || b.fit === 'contain') s.fit = b.fit;
  if (b.ticker != null) s.ticker = String(b.ticker);
  if (b.clock != null) s.clock = !!b.clock;
  store.save(); notifyScreen(s.id); notifyAdmins(); res.json(screenSummary(s));
});
app.delete('/api/screens/:id', (req, res) => {
  const s = findOr404(db.screens, req.params.id, res); if (!s) return;
  db.screens = db.screens.filter(x => x.id !== s.id);
  store.save(); sendTo(s.id, { type: 'unpaired' }); notifyAdmins(); res.json({ ok: true });
});
app.post('/api/screens/:id/reload', (req, res) => { sendTo(req.params.id, { type: 'hardReload' }); res.json({ ok: true }); });

// ---------- player side ----------
app.post('/api/player/register', (req, res) => {
  if (!allowRegister(req.ip)) return res.status(429).json({ error: 'Too many registrations; try again in a minute' });
  const body = req.body || {};
  let s = body.screenId ? db.screens.find(x => x.id === body.screenId) : null;
  if (!s) {
    if (db.screens.filter(x => !x.paired).length >= MAX_UNPAIRED) return res.status(429).json({ error: 'Too many unpaired screens' });
    s = Object.assign({ id: store.id(), name: '', code: store.pairingCode(), paired: false, createdAt: Date.now() }, JSON.parse(JSON.stringify(store.SCREEN_DEFAULTS)));
    db.screens.push(s);
  }
  s.lastSeen = Date.now();
  s.userAgent = req.headers['user-agent'] || '';
  if (body.screenSize) s.screenSize = body.screenSize;
  store.save(); notifyAdmins();
  res.json(buildPlayerConfig(s));
});
app.get('/api/player/:id/config', (req, res) => {
  const s = findOr404(db.screens, req.params.id, res); if (!s) return;
  s.lastSeen = Date.now();
  res.json(buildPlayerConfig(s));
});
app.get('/player', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html'), {
  headers: { 'Cache-Control': 'no-cache, no-transform' },
}));

// ---------- websocket ----------
// Never leak Express's default error page (stack traces, file paths): a bad
// body gets a plain JSON 400, anything else a JSON 500 with the detail logged.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    return res.status(err.status || 400).json({ error: 'Invalid request body' });
  }
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', verifyClient: auth.verifyWebSocket });
const sockets = new Map(); // ws -> { role, screenId }

wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const role = q.get('admin') ? 'admin' : 'screen';
  const screenId = q.get('screen');
  // Only real screens get a socket; anything else would just fan out admin refreshes.
  if (role === 'screen' && !db.screens.some(x => x.id === screenId)) { ws.close(1008, 'Unknown screen'); return; }
  sockets.set(ws, { role, screenId });
  if (role === 'screen' && screenId) touch(screenId);
  ws.on('message', (data) => {
    let msg = {};
    try { msg = JSON.parse(data); } catch (e) { /* ignore */ }
    // Both screens and the dashboard heartbeat; proxies drop idle sockets.
    if (msg.type === 'ping') { if (screenId) touch(screenId, msg); ws.send(JSON.stringify({ type: 'pong' })); }
  });
  ws.on('close', () => { sockets.delete(ws); notifyAdmins(); });
  ws.on('error', () => {});
  if (role === 'screen') notifyAdmins();
});

function touch(screenId, msg) {
  const s = db.screens.find(x => x.id === screenId);
  if (s) { s.lastSeen = Date.now(); if (msg && msg.version) s.version = msg.version; }
}
function sendTo(screenId, obj) {
  const payload = JSON.stringify(obj);
  for (const [ws, info] of sockets) if (info.role === 'screen' && info.screenId === screenId && ws.readyState === 1) ws.send(payload);
}
function notifyScreen(screenId) { sendTo(screenId, { type: 'reload' }); }
function notifyAllScreens() {
  const payload = JSON.stringify({ type: 'reload' });
  for (const [ws, info] of sockets) if (info.role === 'screen' && ws.readyState === 1) ws.send(payload);
  notifyAdmins();
}
let adminTimer = null;
function notifyAdmins() {
  clearTimeout(adminTimer);
  adminTimer = setTimeout(() => {
    const payload = JSON.stringify({ type: 'changed' });
    for (const [ws, info] of sockets) if (info.role === 'admin' && ws.readyState === 1) ws.send(payload);
  }, 100);
}

// Periodically persist lastSeen and refresh online badges in the dashboard.
setInterval(() => {
  // Forget TVs that showed a pairing code and then went away.
  const now = Date.now();
  const before = db.screens.length;
  db.screens = db.screens.filter(s => s.paired || now - (s.lastSeen || s.createdAt || now) < UNPAIRED_TTL_MS);
  if (db.screens.length !== before) {
    for (const [ws, info] of sockets) if (info.role === 'screen' && !db.screens.some(x => x.id === info.screenId)) ws.close(1008, 'Unknown screen');
  }
  store.save(); notifyAdmins();
}, 30000);

// 0.0.0.0 keeps the LAN address working for local TVs. cloudflared reaches the
// app over loopback, so a tunnel-only server can set BIND_ADDRESS=127.0.0.1.
const BIND_ADDRESS = process.env.BIND_ADDRESS || '0.0.0.0';
server.listen(PORT, BIND_ADDRESS, () => {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) for (const n of list) if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
  console.log('LAN Signage running.');
  console.log(auth.enabled ? '  Login:      dashboard password required' : '  Login:      NONE - set ADMIN_PASSWORD before exposing this server');
  if (PUBLIC_URL) {
    console.log('  Public:     ' + PUBLIC_URL + '/');
    console.log('  TV player:  ' + PUBLIC_URL + '/player');
  }
  console.log('  Dashboard:  http://localhost:' + PORT + '/');
  for (const ip of ips) {
    console.log('  Dashboard:  http://' + ip + ':' + PORT + '/');
    console.log('  TV player:  http://' + ip + ':' + PORT + '/player');
  }
  console.log('  Media dir:  ' + MEDIA_DIR);
});
