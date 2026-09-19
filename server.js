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
const { createVideoTurner } = require('./lib/video');

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

// Bump when TVs must reload to pick up a new player script (they cannot turn their
// picture, or use turned video copies, while still running an older one).
const PLAYER_VERSION = 3;

// Turned copies of videos for TVs hung on their side; see lib/video.js for why.
// Only made once a portrait screen exists, and never when settings.videoRotation is
// 'css' (for an estate where every TV has been seen to turn video correctly itself).
const wantsTurnedCopies = () => db.settings.videoRotation !== 'css' && db.screens.some(s => s.paired && s.orientation === 'portrait');
const turner = createVideoTurner({
  mediaDir: MEDIA_DIR,
  log: msg => console.warn(msg),
  onReady: () => {
    // The config version does not change when a copy becomes ready, so a portrait TV
    // picks the new address up in place instead of restarting its playlist.
    db.screens.filter(s => s.orientation === 'portrait').forEach(s => sendTo(s.id, { type: 'reload' }));
    notifyAdmins();
  }
});
function ensureTurnedCopies() {
  if (!wantsTurnedCopies()) { turner.cancelQueued(); return; }
  db.media.filter(m => m.type === 'video' && m.file).forEach(m => turner.ensure(m.file));
}

// ---------- helpers ----------
function findOr404(list, id, res) {
  const item = list.find(x => x.id === id);
  if (!item) res.status(404).json({ error: 'Not found' });
  return item;
}
const mediaUrl = m => m.type === 'web' ? m.url : '/media/' + encodeURIComponent(m.file);
// turning / turnFailed / turned only mean something while portrait copies are wanted
const publicMedia = m => Object.assign({}, m, { src: mediaUrl(m) }, m.type === 'video' && m.file && wantsTurnedCopies() ? turner.status(m.file) : null);

// Turn a screen's simple settings into the zone list the player renders.
function buildPlayerConfig(s) {
  const items = (s.items || []).map(id => db.media.find(m => m.id === id)).filter(Boolean).map(m => ({
    id: m.id, type: m.type, name: m.name, src: mediaUrl(m),
    duration: m.type === 'video' ? 0 : Number(s.seconds) || 10
  }));
  // Zones are in percent of what a person sees, so each orientation gets its own
  // geometry: a bar that is 10% of a landscape screen would be a fat 192px slab on a
  // 1920px-tall portrait one, and a 20%-wide clock too narrow on a 1080px-wide one.
  const portrait = s.orientation === 'portrait';
  const G = portrait
    ? { bar: 6, clockW: 32, box: { x: 60, y: 1.5, w: 38, h: 5.5 } }
    : { bar: 10, clockW: 20, box: { x: 78, y: 2, w: 20, h: 10 } };
  const zones = [];
  // fontScale is a fraction of the zone's own height: the player sizes text from the
  // zone rather than the viewport, so it survives the picture being turned. fontSize
  // stays for a TV still running an older cached player script.
  const tickerZone = { type: 'ticker', text: s.ticker || '', speed: 80, background: '#0f172a', color: '#ffffff', fontSize: 4, fontScale: 0.4 };
  const clockZone = { type: 'clock', background: '#1e293b', color: '#ffffff', format: db.settings.clockFormat, showDate: true, fontSize: 4, fontScale: 0.4 };
  if (s.style === 'ticker') {
    zones.push({ type: 'playlist', x: 0, y: 0, w: 100, h: 100 - G.bar, fit: s.fit, items });
    zones.push(Object.assign({ x: 0, y: 100 - G.bar, w: s.clock ? 100 - G.clockW : 100, h: G.bar }, tickerZone));
    if (s.clock) zones.push(Object.assign({ x: 100 - G.clockW, y: 100 - G.bar, w: G.clockW, h: G.bar }, clockZone));
  } else {
    zones.push({ type: 'playlist', x: 0, y: 0, w: 100, h: 100, fit: s.fit, items });
    if (s.clock) zones.push(Object.assign({}, G.box, clockZone, { background: 'rgba(15,23,42,0.6)' }));
  }
  const config = {
    screenId: s.id, name: s.name, paired: !!s.paired, code: s.paired ? undefined : s.code,
    // What a person should see. The player compares this with the viewport it actually
    // has and turns the picture itself when a TV on its side still renders landscape.
    orientation: portrait ? 'portrait' : 'landscape', flip: !!s.flip,
    layout: { id: s.style, name: s.style, background: '#000000' }, zones, clockFormat: db.settings.clockFormat
  };
  config.version = crypto.createHash('md5').update(JSON.stringify(config)).digest('hex').slice(0, 12);
  // Added after the version on purpose: a copy becoming ready must not look like a changed
  // screen, or every portrait TV would restart its playlist each time a transcode finishes.
  if (db.settings.videoRotation !== 'css') {
    zones.forEach(z => (z.items || []).forEach(item => {
      if (item.type !== 'video') return;
      const m = db.media.find(x => x.id === item.id);
      const turned = m && m.file ? turner.turnedUrls(m.file) : null;
      if (turned) item.turned = turned;
    }));
  }
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
  res.json({
    media: db.media.map(publicMedia), screens: db.screens.map(screenSummary), maps: db.maps.map(publicMap), settings: db.settings, serverTime: Date.now(),
    video: { ffmpeg: turner.isAvailable(), wanted: wantsTurnedCopies(), pending: turner.pending() }
  });
});
app.put('/api/settings', (req, res) => {
  Object.assign(db.settings, req.body || {});
  ensureTurnedCopies();
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
  ensureTurnedCopies();
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
  if (m.file) { fs.unlink(path.join(MEDIA_DIR, m.file), () => {}); turner.remove(m.file); }
  store.save(); notifyAllScreens(); res.json({ ok: true });
});

// ---------- screens ----------
app.post('/api/screens/claim', (req, res) => {
  const code = String(req.body.code || '').toUpperCase().trim();
  const s = db.screens.find(x => x.code === code && !x.paired);
  if (!s) return res.status(404).json({ error: 'No TV is showing that code' });
  s.paired = true; s.name = req.body.name || 'TV ' + code;
  if (req.body.orientation === 'landscape' || req.body.orientation === 'portrait') {
    s.orientation = req.body.orientation;
    db.settings.defaultOrientation = s.orientation; // the next TV starts from the same choice
  }
  ensureTurnedCopies();
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
  if ((b.orientation === 'landscape' || b.orientation === 'portrait') && b.orientation !== s.orientation) {
    s.orientation = b.orientation;
    // "Hung the other way round" belongs to one mounting. Carried over, it would turn a
    // correct picture upside down on the other one.
    if (b.flip == null) s.flip = false;
  }
  if (b.flip != null) s.flip = !!b.flip;
  ensureTurnedCopies();
  store.save();
  // delivered: how many real TVs heard about it just now, so the dashboard can be honest
  const delivered = notifyScreen(s.id);
  notifyAdmins(); res.json(Object.assign(screenSummary(s), { delivered }));
});
app.delete('/api/screens/:id', (req, res) => {
  const s = findOr404(db.screens, req.params.id, res); if (!s) return;
  db.screens = db.screens.filter(x => x.id !== s.id);
  ensureTurnedCopies(); // the last portrait screen going away stops the queue
  store.save(); sendTo(s.id, { type: 'unpaired' }); notifyAdmins(); res.json({ ok: true });
});
// Both only reach a TV that is connected right now, so they say how many heard.
app.post('/api/screens/:id/reload', (req, res) => {
  const s = findOr404(db.screens, req.params.id, res); if (!s) return;
  res.json({ ok: true, delivered: sendTo(s.id, { type: 'hardReload' }) });
});
// Shows a "TOP" marker and what the TV reports, for a minute: which screen is this, and which way up?
app.post('/api/screens/:id/identify', (req, res) => {
  const s = findOr404(db.screens, req.params.id, res); if (!s) return;
  res.json({ ok: true, delivered: sendTo(s.id, { type: 'identify' }) });
});

// ---------- maps ----------
// A picture (a floor plan, a photo of the room, a screenshot of a street map) with the TVs
// pinned on it, so you can see at a glance which one is where and which ones are down.
// Dashboard only: the picture is served from behind the login, never from the open /media,
// and none of this reaches a TV.
const MAPS_DIR = path.join(DATA_DIR, 'maps');
const MAP_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
const mapUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { fs.mkdirSync(MAPS_DIR, { recursive: true }); cb(null, MAPS_DIR); },
    // our own name and extension: nothing the uploader typed ends up in a path
    filename: (req, file, cb) => cb(null, store.id() + MAP_TYPES[file.mimetype]),
  }),
  fileFilter: (req, file, cb) => { const ok = !!MAP_TYPES[file.mimetype]; if (!ok) req.badMapPicture = true; cb(null, ok); },
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
}).single('image');
const BAD_PICTURE = 'Use a PNG, JPG, WebP or GIF picture';
const publicMap = m => ({ id: m.id, name: m.name, hasImage: !!m.file, updatedAt: m.updatedAt });
const mapName = (value, fallback) => String(value == null ? '' : value).trim().slice(0, 60) || fallback;
const dropUpload = req => { if (req.file) fs.unlink(req.file.path, () => {}); };

app.post('/api/maps', mapUpload, (req, res) => {
  if (req.badMapPicture) return res.status(400).json({ error: BAD_PICTURE });
  const now = Date.now();
  const m = { id: store.id(), name: mapName(req.body && req.body.name, 'Map ' + (db.maps.length + 1)), file: req.file ? req.file.filename : null, createdAt: now, updatedAt: now };
  db.maps.push(m); store.save(); notifyAdmins(); res.json(publicMap(m));
});
app.post('/api/maps/:id/image', mapUpload, (req, res) => {
  const m = db.maps.find(x => x.id === req.params.id);
  if (!m) { dropUpload(req); return res.status(404).json({ error: 'Not found' }); }
  if (req.badMapPicture || !req.file) { dropUpload(req); return res.status(400).json({ error: BAD_PICTURE }); }
  if (m.file) fs.unlink(path.join(MAPS_DIR, m.file), () => {});
  m.file = req.file.filename; m.updatedAt = Date.now();
  store.save(); notifyAdmins(); res.json(publicMap(m));
});
app.patch('/api/maps/:id', (req, res) => {
  const m = findOr404(db.maps, req.params.id, res); if (!m) return;
  if (req.body && req.body.name != null) m.name = mapName(req.body.name, m.name);
  store.save(); notifyAdmins(); res.json(publicMap(m));
});
app.delete('/api/maps/:id', (req, res) => {
  const m = findOr404(db.maps, req.params.id, res); if (!m) return;
  db.maps = db.maps.filter(x => x.id !== m.id);
  db.screens.forEach(s => { if (s.map && s.map.id === m.id) s.map = null; });
  if (m.file) fs.unlink(path.join(MAPS_DIR, m.file), () => {});
  store.save(); notifyAdmins(); res.json({ ok: true });
});
app.get('/api/maps/:id/image', (req, res) => {
  const m = findOr404(db.maps, req.params.id, res); if (!m) return;
  if (!m.file) return res.status(404).json({ error: 'This map has no picture' });
  res.sendFile(path.join(MAPS_DIR, m.file), {
    // the address carries ?v=<updatedAt>, so a changed picture is a new address
    headers: { 'Cache-Control': 'private, max-age=604800', 'X-Content-Type-Options': 'nosniff' },
  }, err => { if (err && !res.headersSent) res.status(404).json({ error: 'Picture missing' }); });
});
// Where a TV sits on a map. Deliberately not part of PUT /api/screens/:id: moving a pin
// changes nothing on the TV, so the TV is not told.
app.put('/api/screens/:id/place', (req, res) => {
  const s = findOr404(db.screens, req.params.id, res); if (!s) return;
  const b = req.body || {};
  if (b.mapId == null) s.map = null;
  else {
    if (!s.paired) return res.status(400).json({ error: 'Pair this TV first' });
    if (!db.maps.some(m => m.id === b.mapId)) return res.status(404).json({ error: 'No such map' });
    const pct = v => Math.round(Math.min(100, Math.max(0, Number(v) || 0)) * 100) / 100;
    s.map = { id: b.mapId, x: pct(b.x), y: pct(b.y) };
  }
  store.save(); notifyAdmins(); res.json(screenSummary(s));
});

// ---------- player side ----------
app.post('/api/player/register', (req, res) => {
  if (!allowRegister(req.ip)) return res.status(429).json({ error: 'Too many registrations; try again in a minute' });
  const body = req.body || {};
  let s = body.screenId ? db.screens.find(x => x.id === body.screenId) : null;
  if (!s) {
    // The dashboard's Preview of a screen that has gone must not turn into a new screen.
    if (body.preview) return res.status(404).json({ error: 'No such screen' });
    if (db.screens.filter(x => !x.paired).length >= MAX_UNPAIRED) return res.status(429).json({ error: 'Too many unpaired screens' });
    s = Object.assign({ id: store.id(), name: '', code: store.pairingCode(), paired: false, createdAt: Date.now() }, JSON.parse(JSON.stringify(store.SCREEN_DEFAULTS)));
    // A display that already reports a tall viewport is portrait. Anything else starts
    // from the owner's usual choice, so the pairing code is upright on most of their TVs.
    const size = /^(\d+)x(\d+)$/.exec(String(body.screenSize || ''));
    const reportsTall = !!size && Number(size[2]) > Number(size[1]);
    s.orientation = reportsTall || db.settings.defaultOrientation === 'portrait' ? 'portrait' : 'landscape';
    db.screens.push(s);
  }
  // The dashboard's Preview opens the player on a PC; it must not overwrite what the TV reported.
  if (!body.preview) {
    s.lastSeen = Date.now();
    s.userAgent = req.headers['user-agent'] || '';
    if (body.screenSize) s.screenSize = body.screenSize;
  }
  store.save(); notifyAdmins();
  res.json(buildPlayerConfig(s));
});
app.get('/api/player/:id/config', (req, res) => {
  const s = findOr404(db.screens, req.params.id, res); if (!s) return;
  if (!req.query.preview) s.lastSeen = Date.now(); // a preview on a PC is not the TV
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
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'That file is too big' : 'Upload failed' });
  }
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', verifyClient: auth.verifyWebSocket });
const sockets = new Map(); // ws -> { role, screenId, preview }
const forcedReloads = new Map(); // screenId -> when we last asked it to reload

wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const role = q.get('admin') ? 'admin' : 'screen';
  const screenId = q.get('screen');
  // The dashboard's Preview: it gets updates like a TV, but is never mistaken for the TV.
  const isPreview = role === 'screen' && !!q.get('preview');
  // Only real screens get a socket; anything else would just fan out admin refreshes.
  if (role === 'screen' && !db.screens.some(x => x.id === screenId)) { ws.close(1008, 'Unknown screen'); return; }
  sockets.set(ws, { role, screenId, preview: isPreview });
  // A TV still running an older player script cannot turn its picture. Ask it to reload,
  // but at most once every ten minutes in case its browser keeps serving the old script.
  if (role === 'screen' && !isPreview && Number(q.get('pv') || 0) < PLAYER_VERSION) {
    if (Date.now() - (forcedReloads.get(screenId) || 0) > 10 * 60 * 1000) {
      forcedReloads.set(screenId, Date.now());
      ws.send(JSON.stringify({ type: 'hardReload' }));
    }
  }
  if (role === 'screen' && screenId && !isPreview) touch(screenId);
  ws.on('message', (data) => {
    let msg = {};
    try { msg = JSON.parse(data); } catch (e) { /* ignore */ }
    // Both screens and the dashboard heartbeat; proxies drop idle sockets.
    if (msg.type === 'ping') { if (screenId && !isPreview) touch(screenId, msg); ws.send(JSON.stringify({ type: 'pong' })); }
  });
  ws.on('close', () => { sockets.delete(ws); notifyAdmins(); });
  ws.on('error', () => {});
  if (role === 'screen') notifyAdmins();
});

function touch(screenId, msg) {
  const s = db.screens.find(x => x.id === screenId);
  if (s) { s.lastSeen = Date.now(); if (msg && msg.version) s.version = msg.version; }
}
// Returns how many real TVs it reached; an open Preview hears it too but does not count.
function sendTo(screenId, obj) {
  const payload = JSON.stringify(obj);
  let reached = 0;
  for (const [ws, info] of sockets) {
    if (info.role !== 'screen' || info.screenId !== screenId || ws.readyState !== 1) continue;
    ws.send(payload);
    if (!info.preview) reached++;
  }
  return reached;
}
function notifyScreen(screenId) { return sendTo(screenId, { type: 'reload' }); }
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
  turner.sweep(db.media.filter(m => m.type === 'video' && m.file).map(m => m.file));
  turner.probe(ok => {
    console.log(ok
      ? '  Video:      ffmpeg found - videos get turned copies for portrait screens'
      : '  Video:      ffmpeg NOT found - on portrait screens video relies on the TV turning it (install ffmpeg to be safe)');
    ensureTurnedCopies();
  });
});
