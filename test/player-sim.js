// A TV in a box: runs the real public/player.js and public/player-layout.js inside node:vm
// with a stand-in DOM, network and a virtual clock. No server, no real timers, so ten
// minutes of playlist take milliseconds and every run is identical.
//
// It models just what the player relies on: elements with children, <video> elements that
// reach "canplay" (or fail) some time after load(), images, XHR for register/config, and a
// WebSocket that opens while the "server" is up and drops when told to.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', 'public');

// options:
//   items        playlist items of the one fullscreen zone
//   orientation  'portrait' (default; the page is turned 270) or 'landscape'
//   loadDelay    (src, el) => ms until a video can play; Infinity = never. Default 150.
function fakeTv(options) {
  const opt = Object.assign({ items: [], orientation: 'portrait', loadDelay: () => 150 }, options);
  let now = 1700000000000, timers = [], ids = 1;
  const env = { up: true, copyBroken: false, sockets: [], items: opt.items, version: 'v1' };
  const plays = [];  // [ms, 'VVIDEO' | 'page', 'canplay' | 'error', src]
  const videos = []; // every <video> ever made, the shared one first

  const later = (fn, ms) => { const id = ids++; timers.push({ id, at: now + (ms || 0), fn }); return id; };
  const every = (fn, ms) => { const id = ids++; timers.push({ id, at: now + ms, fn, every: ms }); return id; };
  const clear = id => { timers = timers.filter(t => t.id !== id); };
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      let next = null;
      for (const t of timers) if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
      if (!next) break;
      now = Math.max(now, next.at);
      if (next.every) next.at += next.every; else timers = timers.filter(t => t !== next);
      next.fn();
    }
    now = end;
  }

  function el(tag) {
    const e = {
      tagName: String(tag).toUpperCase(), style: {}, className: '', children: [], parentNode: null, src: '', textContent: '',
      offsetWidth: 1080, offsetHeight: 1920, offsetLeft: 0, offsetTop: 0,
      appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = e; e.children.push(c); return c; },
      removeChild(c) { e.children = e.children.filter(x => x !== c); c.parentNode = null; return c; },
      setAttribute() {}, removeAttribute(k) { if (k === 'src') e.src = ''; },
      getElementsByTagName(t) {
        const out = [];
        (function walk(n) { for (const c of n.children) { if (c.tagName === t.toUpperCase()) out.push(c); walk(c); } })(e);
        return out;
      },
    };
    Object.defineProperty(e, 'innerHTML', { set() { for (const c of e.children) c.parentNode = null; e.children = []; }, get() { return ''; } });
    if (e.tagName === 'VIDEO') {
      e.paused = true;
      e.pause = () => { e.paused = true; };
      e.play = () => { if (e.src) e.paused = false; };
      e.load = () => {
        const gen = e.gen = (e.gen || 0) + 1, src = e.src;
        e.paused = true;
        if (!src) return;
        const wait = opt.loadDelay(src, e);
        if (!isFinite(wait)) return; // never becomes playable
        later(() => {
          if (gen !== e.gen) return;
          const who = e.id === 'vvideo' ? 'VVIDEO' : 'page';
          const ok = env.up && !(env.copyBroken && /\/turned\//.test(src));
          plays.push([now, who, ok ? 'canplay' : 'error', src]);
          if (!ok) { if (e.onerror) e.onerror(); return; }
          if (e.autoplay) e.paused = false; // autoplay does not need the element to be in the page
          if (e.oncanplay) e.oncanplay();
          if (!e.loop) later(() => { if (gen === e.gen && e.onended) e.onended(); }, 8000);
        }, wait);
      };
      videos.push(e);
    }
    return e;
  }

  const byId = {};
  for (const id of ['stage', 'pair', 'code', 'pairinfo', 'status', 'err', 'root', 'vbox', 'testcard']) byId[id] = el('div');
  byId.vvideo = el('video'); byId.vvideo.id = 'vvideo'; byId.vbox.appendChild(byId.vvideo);

  const seenImages = {};
  function FakeImage() {
    const img = {};
    Object.defineProperty(img, 'src', { set(v) { later(() => {
      if (env.up || seenImages[v]) { seenImages[v] = true; if (img.onload) img.onload(); } else if (img.onerror) img.onerror();
    }, 30); } });
    return img;
  }
  const config = () => JSON.stringify({
    screenId: 's1', name: 'TV', paired: true, orientation: opt.orientation, flip: false, version: env.version, clockFormat: '24h',
    layout: { id: 'full', name: 'full', background: '#000000' },
    zones: [{ type: 'playlist', x: 0, y: 0, w: 100, h: 100, fit: 'contain', items: env.items }],
  });
  function FakeXhr() {
    const r = { readyState: 0, status: 0, responseText: '', open() {}, setRequestHeader() {} };
    r.send = () => later(() => {
      if (!env.up) { if (r.onerror) r.onerror(); return; }
      r.readyState = 4; r.status = 200; r.responseText = config(); r.onreadystatechange();
    }, 40);
    return r;
  }
  const drop = s => { if (s.readyState === 1 || s.readyState === 0) { s.readyState = 3; if (s.onclose) s.onclose(); } };
  function FakeSocket() {
    const s = { readyState: 0, send() {}, close() { later(() => drop(s), 1); } };
    env.sockets.push(s);
    later(() => { if (s.readyState !== 0) return; if (env.up) { s.readyState = 1; if (s.onopen) s.onopen(); } else drop(s); }, 60);
    return s;
  }

  const stored = {};
  const FakeDate = function () { return new Date(now); };
  FakeDate.now = () => now;
  const window = {
    innerWidth: 1920, innerHeight: 1080, addEventListener() {},
    location: { search: '', protocol: 'http:', host: 'tv.test', reload() { throw new Error('unexpected page reload'); } },
    localStorage: { getItem: k => (k in stored ? stored[k] : null), setItem: (k, v) => { stored[k] = String(v); }, removeItem: k => { delete stored[k]; } },
  };
  const sandbox = vm.createContext({
    window, navigator: { userAgent: 'Tizen Chrome/63.0' }, Date: FakeDate, console,
    document: { getElementById: id => byId[id] || null, createElement: el, documentElement: {}, addEventListener() {} },
    XMLHttpRequest: FakeXhr, WebSocket: FakeSocket, Image: FakeImage,
    setTimeout: later, setInterval: every, clearTimeout: clear, clearInterval: clear,
  });
  vm.runInContext('(function () {' + fs.readFileSync(path.join(PUBLIC, 'player-layout.js'), 'utf8') + '}).call(window);', sandbox);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'player.js'), 'utf8'), sandbox);

  return {
    env, plays, advance, videos, vvideo: byId.vvideo, vbox: byId.vbox, stage: byId.stage, stored, now: () => now,
    // video elements that still hold a source, i.e. a download and possibly a decoder
    holding: () => videos.filter(v => v.src),
    // what the server pushes over the socket ("reload" = your config may have changed)
    push(msg) { env.sockets.forEach(s => { if (s.readyState === 1 && s.onmessage) s.onmessage({ data: JSON.stringify(msg) }); }); },
    // socketNotices=false: power cut or black-holed link; the socket only resets 15 s after the server is back
    outage(ms, socketNotices) {
      env.up = false;
      if (socketNotices) env.sockets.forEach(drop);
      advance(ms);
      env.up = true;
      if (!socketNotices) later(() => env.sockets.forEach(drop), 15000);
    },
  };
}

module.exports = { fakeTv };
