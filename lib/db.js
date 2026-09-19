// Tiny JSON-file database. Everything lives in memory and is flushed to disk
// shortly after each change. Plenty for a signage server with a handful of screens.
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'db.json');

const DEFAULTS = {
  media: [],    // { id, name, type: image|video|web, file?, url?, size, createdAt }
  screens: [],  // { id, name, code, paired, style, items, seconds, fit, ticker, clock, orientation, flip, map, lastSeen }
  maps: [],     // { id, name, file?, createdAt, updatedAt }: pictures the dashboard pins TVs on
  settings: { clockFormat: '24h' }
};

// orientation is what a person looking at the screen sees ('landscape' 16:9 or 'portrait'
// 9:16); flip is for a TV that was mounted the other way round. map is where the dashboard
// shows it: { id, x, y } with x/y in percent of that map's picture, or null.
const SCREEN_DEFAULTS = { style: 'ticker', items: [], seconds: 10, fit: 'contain', ticker: '', clock: true, orientation: 'landscape', flip: false, map: null };

let db = null;
let saveTimer = null;

function load() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    db = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), JSON.parse(raw)); // a copy: never hand out DEFAULTS' own arrays
    migrate(db);
  } catch (e) {
    db = JSON.parse(JSON.stringify(DEFAULTS));
    saveNow();
  }
  return db;
}

// Older versions kept separate playlists and layouts. Fold them into each screen.
function migrate(d) {
  if (d.layouts || d.playlists) {
    const layouts = d.layouts || [], playlists = d.playlists || [];
    for (const s of d.screens) {
      const layout = layouts.find(l => l.id === s.layoutId);
      const zones = layout ? layout.zones : [];
      const plZone = zones.find(z => z.type === 'playlist');
      const pl = plZone ? playlists.find(p => p.id === plZone.playlistId) : null;
      const ticker = zones.find(z => z.type === 'ticker');
      s.style = ticker ? 'ticker' : 'full';
      s.items = pl ? pl.items.map(it => it.mediaId) : [];
      s.seconds = pl && pl.items[0] && pl.items[0].duration ? Number(pl.items[0].duration) : 10;
      s.fit = plZone && plZone.fit === 'cover' ? 'cover' : 'contain';
      s.ticker = ticker ? (ticker.text || '') : '';
      s.clock = zones.some(z => z.type === 'clock');
      delete s.layoutId; delete s.rules;
    }
    delete d.layouts; delete d.playlists;
    saveNow();
  }
  if (!Array.isArray(d.maps)) d.maps = [];
  for (const s of d.screens) for (const k in SCREEN_DEFAULTS) if (s[k] === undefined) s[k] = JSON.parse(JSON.stringify(SCREEN_DEFAULTS[k]));
}

function get() {
  if (!db) load();
  return db;
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 150);
}

function saveNow() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

function id() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function pairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

module.exports = { get, save, saveNow, id, pairingCode, DB_PATH, SCREEN_DEFAULTS };
