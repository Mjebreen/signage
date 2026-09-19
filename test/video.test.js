// Turned copies of videos for portrait screens (lib/video.js).
//
// A stand-in ffmpeg (test/fake-ffmpeg.js) is used so the plumbing is tested for real:
// when copies are made, that the right turn is requested for each direction, that a
// finished copy reaches the TV without restarting its playlist, and that nothing
// breaks when ffmpeg is missing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const { startServer, stopServer, request, cookieOf } = require('./helpers');

const PASSWORD = 'video tests';
const FAKE = { FFMPEG_PATH: process.execPath, FFMPEG_PREFIX_ARGS: JSON.stringify([path.join(__dirname, 'fake-ffmpeg.js')]) };

function multipart(filename, mime, content) {
  const boundary = '----signagetest' + Math.floor(Math.random() * 1e9);
  const head = '--' + boundary + '\r\nContent-Disposition: form-data; name="files"; filename="' + filename + '"\r\nContent-Type: ' + mime + '\r\n\r\n';
  return { body: Buffer.concat([Buffer.from(head), content, Buffer.from('\r\n--' + boundary + '--\r\n')]), type: 'multipart/form-data; boundary=' + boundary };
}

async function setup(env) {
  const srv = await startServer({ ADMIN_PASSWORD: PASSWORD, ...env });
  const cookie = cookieOf(await request(srv.base, 'POST', '/api/login', { body: { password: PASSWORD } }));
  const admin = extra => ({ headers: { Cookie: cookie }, ...extra });
  const upload = async name => {
    const form = multipart(name, 'video/mp4', Buffer.from('not really a video'));
    const r = await request(srv.base, 'POST', '/api/media', { rawBody: form.body, headers: { Cookie: cookie, 'Content-Type': form.type } });
    assert.equal(r.status, 200);
    return r.json[0];
  };
  const pair = async (orientation, items) => {
    const reg = await request(srv.base, 'POST', '/api/player/register', { body: { screenSize: '1920x1080' } });
    await request(srv.base, 'POST', '/api/screens/claim', admin({ body: { code: reg.json.code, name: orientation, orientation } }));
    await request(srv.base, 'PUT', '/api/screens/' + reg.json.screenId, admin({ body: { items, style: 'full', clock: false } }));
    return reg.json.screenId;
  };
  const state = () => request(srv.base, 'GET', '/api/state', admin()).then(r => r.json);
  const config = id => request(srv.base, 'GET', '/api/player/' + id + '/config').then(r => r.json);
  const until = async (check, what) => {
    for (let i = 0; i < 60; i++) { const v = await check(); if (v) return v; await new Promise(r => setTimeout(r, 100)); }
    throw new Error('timed out waiting for ' + what);
  };
  return { srv, admin, upload, pair, state, config, until };
}

test('a portrait screen gets a turned copy for each way round, with the right turn baked in', async () => {
  const t = await setup(FAKE);
  try {
    const video = await t.upload('clip.mp4');
    const id = await t.pair('portrait', [video.id]);

    const media = await t.until(async () => { const m = (await t.state()).media[0]; return m.turned ? m : null; }, 'turned copies');
    assert.equal(media.turning, false);
    assert.equal(media.turnFailed, false);
    assert.equal((await t.state()).video.ffmpeg, true);

    const item = (await t.config(id)).zones[0].items[0];
    assert.deepEqual(Object.keys(item.turned).sort(), ['270', '90']);

    // A TV needs no login to fetch them, and each direction asked ffmpeg for the right turn:
    // panel hung clockwise -> picture turned 270 -> pixels turned counter-clockwise (transpose=2).
    for (const [deg, transpose] of [['270', 'transpose=2'], ['90', 'transpose=1']]) {
      const r = await request(t.srv.base, 'GET', item.turned[deg]);
      assert.equal(r.status, 200, deg);
      const args = JSON.parse(r.text);
      const filter = args[args.indexOf('-vf') + 1];
      assert.ok(filter.startsWith(transpose + ','), deg + ' -> ' + filter);
      // the LONG side is capped after the turn (a turned 4K clip must not come out 2160x3840)
      assert.ok(filter.includes('min(1920,trunc(iw/2)*2)') && filter.includes('min(1920,trunc(ih/2)*2)'), filter);
      assert.doesNotMatch(filter, /:-2,format/);
      // the frame rate is capped, not forced: 24/25 fps material stays as it is
      assert.doesNotMatch(filter, /fps=/);
      assert.equal(args[args.indexOf('-fpsmax') + 1], '30');
      assert.ok(args.indexOf('-fpsmax') > args.indexOf('-i'), '-fpsmax is an output option');
      assert.equal(args[args.indexOf('-map') + 1], '0:v:0');
      assert.ok(args.includes('-an'));
    }
  } finally { stopServer(t.srv); }
});

test('a copy becoming ready does not change the config version (no playlist restart)', async () => {
  const t = await setup(FAKE);
  try {
    const video = await t.upload('clip.mp4');
    const id = await t.pair('portrait', [video.id]);
    await t.until(async () => (await t.state()).media[0].turned, 'turned copies');
    const withCopies = await t.config(id);
    assert.ok(withCopies.zones[0].items[0].turned);

    fs.rmSync(path.join(t.srv.dataDir, 'media', 'turned'), { recursive: true, force: true });
    const without = await t.config(id);
    assert.equal(without.zones[0].items[0].turned, undefined);
    assert.equal(without.version, withCopies.version);
  } finally { stopServer(t.srv); }
});

test('no copies are made while every screen is landscape, or when turned off', async () => {
  const t = await setup(FAKE);
  try {
    const video = await t.upload('clip.mp4');
    const wide = await t.pair('landscape', [video.id]);
    await new Promise(r => setTimeout(r, 600));
    assert.equal((await t.state()).video.wanted, false);
    assert.equal(fs.existsSync(path.join(t.srv.dataDir, 'media', 'turned')), false);
    assert.equal((await t.config(wide)).zones[0].items[0].turned, undefined);

    // switching that screen to portrait is what starts them
    await request(t.srv.base, 'PUT', '/api/screens/' + wide, t.admin({ body: { orientation: 'portrait' } }));
    await t.until(async () => (await t.state()).media[0].turned, 'copies after switching to portrait');

    // an estate whose TVs were seen to turn video themselves can switch copies off
    await request(t.srv.base, 'PUT', '/api/settings', t.admin({ body: { videoRotation: 'css' } }));
    assert.equal((await t.config(wide)).zones[0].items[0].turned, undefined);
    assert.equal((await t.state()).video.wanted, false);
  } finally { stopServer(t.srv); }
});

test('deleting a video deletes its turned copies', async () => {
  const t = await setup(FAKE);
  try {
    const video = await t.upload('clip.mp4');
    await t.pair('portrait', [video.id]);
    await t.until(async () => (await t.state()).media[0].turned, 'turned copies');
    const dir = path.join(t.srv.dataDir, 'media', 'turned');
    assert.equal(fs.readdirSync(dir).length, 2);
    await request(t.srv.base, 'DELETE', '/api/media/' + video.id, t.admin());
    await t.until(async () => fs.readdirSync(dir).length === 0, 'copies to be removed');
  } finally { stopServer(t.srv); }
});

test('deleting a video while its copy is being made leaves nothing behind', async () => {
  const t = await setup({ ...FAKE, FAKE_FFMPEG_DELAY_MS: '3000' });
  try {
    const video = await t.upload('clip.mp4');
    await t.pair('portrait', [video.id]);
    const dir = path.join(t.srv.dataDir, 'media', 'turned');
    await t.until(async () => fs.existsSync(dir) && fs.readdirSync(dir).some(n => n.endsWith('.part')), 'a transcode to start');
    await request(t.srv.base, 'DELETE', '/api/media/' + video.id, t.admin());
    await t.until(async () => (await t.state()).video.pending === 0 && fs.readdirSync(dir).length === 0, 'the half-made copy to be cleared up');
    // ...and the original is gone as well, with no copy appearing afterwards
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual(fs.readdirSync(path.join(t.srv.dataDir, 'media')).filter(n => n !== 'turned'), []);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { stopServer(t.srv); }
});

test('copies that stop being wanted are not queued up behind the one in hand', async () => {
  const t = await setup({ ...FAKE, FAKE_FFMPEG_DELAY_MS: '1500' });
  try {
    const a = await t.upload('a.mp4');
    const b = await t.upload('b.mp4');
    const id = await t.pair('portrait', [a.id, b.id]);
    await t.until(async () => (await t.state()).video.pending === 4, 'four copies to be queued');
    assert.equal((await t.state()).media[0].turning, true);

    await request(t.srv.base, 'PUT', '/api/screens/' + id, t.admin({ body: { orientation: 'landscape' } }));
    const s = await t.state();
    assert.equal(s.video.wanted, false);
    assert.ok(s.video.pending <= 1, 'only the job already running may finish, got ' + s.video.pending);
    assert.equal(s.media[0].turning, undefined, 'no "Preparing" chip once nothing is portrait');
  } finally { stopServer(t.srv); }
});

test('start-up clears half-written copies and copies of videos that no longer exist', async () => {
  const first = await setup(FAKE);
  let dataDir;
  try {
    const video = await first.upload('clip.mp4');
    await first.pair('portrait', [video.id]);
    await first.until(async () => (await first.state()).media[0].turned, 'turned copies');
    dataDir = first.srv.dataDir;
    const dir = path.join(dataDir, 'media', 'turned');
    fs.writeFileSync(path.join(dir, '270_crashed.mp4.part'), 'half');
    fs.writeFileSync(path.join(dir, '90_deleted_long_ago.mp4'), 'orphan');
    await new Promise(r => setTimeout(r, 400)); // the store writes a moment after a change
  } finally { stopServer(first.srv, { keepData: true }); }

  const again = await startServer({ ADMIN_PASSWORD: PASSWORD, ...FAKE, DATA_DIR: dataDir });
  try {
    const dir = path.join(dataDir, 'media', 'turned');
    for (let i = 0; i < 50 && fs.readdirSync(dir).length !== 2; i++) await new Promise(r => setTimeout(r, 100));
    const names = fs.readdirSync(dir).sort();
    assert.equal(names.length, 2, names.join(', '));
    assert.ok(names.every(n => /^(270|90)_clip_.*\.mp4$/.test(n)), names.join(', '));
  } finally { stopServer(again); }
});

test('an ffmpeg too old for -fpsmax gets the fps filter instead', async () => {
  const t = await setup({ ...FAKE, FAKE_FFMPEG_NO_FPSMAX: '1' });
  try {
    const video = await t.upload('clip.mp4');
    const id = await t.pair('portrait', [video.id]);
    const m = await t.until(async () => { const x = (await t.state()).media[0]; return x.turned ? x : null; }, 'turned copies from an old ffmpeg');
    assert.equal(m.turnFailed, false);
    const item = (await t.config(id)).zones[0].items[0];
    const args = JSON.parse((await request(t.srv.base, 'GET', item.turned['270'])).text);
    assert.equal(args.indexOf('-fpsmax'), -1);
    assert.match(args[args.indexOf('-vf') + 1], /^transpose=2,fps=30,scale=/);
  } finally { stopServer(t.srv); }
});

test('without ffmpeg nothing breaks: the TV is simply told nothing about copies', async () => {
  const t = await setup({ FFMPEG_PATH: 'definitely-not-ffmpeg-' + process.pid, FFMPEG_PREFIX_ARGS: '' });
  try {
    const video = await t.upload('clip.mp4');
    const id = await t.pair('portrait', [video.id]);
    const s = await t.until(async () => { const st = await t.state(); return st.video.ffmpeg === false ? st : null; }, 'ffmpeg probe');
    assert.equal(s.video.wanted, true); // the dashboard can say why videos may look wrong
    assert.equal(s.media[0].turned, false);
    const cfg = await t.config(id);
    assert.equal(cfg.zones[0].items[0].type, 'video');
    assert.equal(cfg.zones[0].items[0].turned, undefined);
  } finally { stopServer(t.srv); }
});

test('a failed transcode is reported once and not retried forever', async () => {
  const t = await setup({ ...FAKE, FAKE_FFMPEG_FAIL: '1' });
  try {
    const video = await t.upload('clip.mp4');
    await t.pair('portrait', [video.id]);
    const m = await t.until(async () => { const x = (await t.state()).media[0]; return x.turnFailed ? x : null; }, 'failure to be reported');
    assert.equal(m.turned, false);
    assert.equal((await t.state()).video.pending, 0);
  } finally { stopServer(t.srv); }
});

// One socket, like the player opens. Resolves once the server has answered a ping, so
// everything the server does on connect has happened by then; no sleeping, no guessing.
function playerSocket(url, ping) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const seen = [];
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('no pong from ' + url)); }, 10000);
    ws.on('open', () => ws.send(JSON.stringify(ping || { type: 'ping' })));
    ws.on('message', d => {
      const type = JSON.parse(d).type;
      seen.push(type);
      if (type === 'pong') { clearTimeout(timer); resolve({ ws, seen }); }
    });
    ws.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

test('the PC preview is never mistaken for the TV', async () => {
  const t = await setup(FAKE);
  try {
    const id = await t.pair('portrait', []);
    const screen = async () => (await t.state()).screens.find(s => s.id === id);
    const before = await screen();
    assert.equal(before.screenSize, '1920x1080');

    await new Promise(r => setTimeout(r, 20)); // so a touched lastSeen would differ
    await request(t.srv.base, 'POST', '/api/player/register', { body: { screenId: id, screenSize: '1745x859', preview: true } });
    await request(t.srv.base, 'GET', '/api/player/' + id + '/config?preview=1');
    const p = await playerSocket(t.srv.wsBase + '/ws?screen=' + id + '&pv=4&preview=1', { type: 'ping', version: 'from-the-preview' });
    try {
      const during = await screen();
      assert.equal(during.screenSize, '1920x1080');
      assert.equal(during.lastSeen, before.lastSeen, 'a preview must not make the TV look online');
      assert.notEqual(during.version, 'from-the-preview');

      // it still hears about changes, but "did the TV get it?" does not count it
      const identify = await request(t.srv.base, 'POST', '/api/screens/' + id + '/identify', t.admin());
      assert.equal(identify.json.delivered, 0);
      await t.until(async () => p.seen.includes('identify'), 'the preview to hear the identify');
    } finally { p.ws.terminate(); }

    // a preview of a screen that has gone is told so, instead of becoming a new screen
    const count = (await t.state()).screens.length;
    const gone = await request(t.srv.base, 'POST', '/api/player/register', { body: { screenId: 'no-such-screen', preview: true } });
    assert.equal(gone.status, 404);
    assert.equal((await t.state()).screens.length, count);
  } finally { stopServer(t.srv); }
});

test('Identify, Reload and the mounting buttons say whether a TV actually heard them', async () => {
  const t = await setup(FAKE);
  try {
    const id = await t.pair('portrait', []);
    let r = await request(t.srv.base, 'POST', '/api/screens/' + id + '/identify', t.admin());
    assert.deepEqual(r.json, { ok: true, delivered: 0 });
    r = await request(t.srv.base, 'PUT', '/api/screens/' + id, t.admin({ body: { flip: true } }));
    assert.equal(r.json.delivered, 0);

    const tv = await playerSocket(t.srv.wsBase + '/ws?screen=' + id + '&pv=4');
    try {
      r = await request(t.srv.base, 'POST', '/api/screens/' + id + '/identify', t.admin());
      assert.equal(r.json.delivered, 1);
      r = await request(t.srv.base, 'POST', '/api/screens/' + id + '/reload', t.admin());
      assert.equal(r.json.delivered, 1);
      r = await request(t.srv.base, 'PUT', '/api/screens/' + id, t.admin({ body: { flip: false } }));
      assert.equal(r.json.delivered, 1);
    } finally { tv.ws.terminate(); }

    assert.equal((await request(t.srv.base, 'POST', '/api/screens/nope/identify', t.admin())).status, 404);
  } finally { stopServer(t.srv); }
});

test('a TV running an older player script is asked to reload, once', async () => {
  const t = await setup(FAKE);
  try {
    // Message order instead of time windows: whatever the server sends on connect arrives
    // before the pong. Fresh screens for each case, so one reload cannot mask another check.
    const old = await t.pair('portrait', []);
    const current = await t.pair('portrait', []);
    const previewed = await t.pair('portrait', []);
    const types = async url => { const p = await playerSocket(url); p.ws.terminate(); return p.seen; };
    const url = (id, extra) => t.srv.wsBase + '/ws?screen=' + id + (extra || '');
    assert.deepEqual(await types(url(old)), ['hardReload', 'pong']);            // old script: no version
    assert.deepEqual(await types(url(old)), ['pong']);                          // not in a loop
    assert.deepEqual(await types(url(old, '&pv=3')), ['pong']);                 // still within the ten minutes
    assert.deepEqual(await types(url(current, '&pv=4')), ['pong']);             // current script
    assert.deepEqual(await types(url(previewed, '&preview=1')), ['pong']);      // a preview is never reloaded
    assert.deepEqual(await types(url(previewed, '&pv=3')), ['hardReload', 'pong']); // the previous script
  } finally { stopServer(t.srv); }
});

test('a TV that went silent without closing its socket does not count as having heard', async () => {
  // A power cut or lost Wi-Fi sends no close: the socket stays open on the server. Staying
  // connected but silent looks exactly the same from the server's side.
  const t = await setup({ ...FAKE, ONLINE_WINDOW_MS: '400' });
  try {
    const id = await t.pair('portrait', []);
    const tv = await playerSocket(t.srv.wsBase + '/ws?screen=' + id + '&pv=4');
    try {
      let r = await request(t.srv.base, 'POST', '/api/screens/' + id + '/identify', t.admin());
      assert.equal(r.json.delivered, 1);

      await new Promise(res => setTimeout(res, 600)); // no ping for longer than the window
      r = await request(t.srv.base, 'POST', '/api/screens/' + id + '/identify', t.admin());
      assert.equal(r.json.delivered, 0, 'an open but silent socket is not a TV that heard');
      r = await request(t.srv.base, 'POST', '/api/screens/' + id + '/reload', t.admin());
      assert.equal(r.json.delivered, 0);
      r = await request(t.srv.base, 'PUT', '/api/screens/' + id, t.admin({ body: { flip: true } }));
      assert.equal(r.json.delivered, 0);
      assert.equal(r.json.online, false);

      // it speaks again: it counts again
      const pong = new Promise(res => tv.ws.once('message', res));
      tv.ws.send(JSON.stringify({ type: 'ping' }));
      await pong;
      r = await request(t.srv.base, 'POST', '/api/screens/' + id + '/identify', t.admin());
      assert.equal(r.json.delivered, 1);
    } finally { tv.ws.terminate(); }
  } finally { stopServer(t.srv); }
});

test('the turned folder can be deleted while the server runs: the copies are made again', async () => {
  const t = await setup({ ...FAKE, HOUSEKEEPING_MS: '300' });
  try {
    const video = await t.upload('clip.mp4');
    const id = await t.pair('portrait', [video.id]);
    await t.until(async () => (await t.state()).media[0].turned, 'turned copies');
    const version = (await t.config(id)).version;

    fs.rmSync(path.join(t.srv.dataDir, 'media', 'turned'), { recursive: true, force: true });
    // nothing is edited, uploaded or restarted: housekeeping alone must notice
    const m = await t.until(async () => { const x = (await t.state()).media[0]; return x.turned ? x : null; }, 'the copies to come back');
    assert.equal(m.turnFailed, false);
    const cfg = await t.config(id);
    assert.deepEqual(Object.keys(cfg.zones[0].items[0].turned).sort(), ['270', '90']);
    assert.equal(cfg.version, version);
  } finally { stopServer(t.srv); }
});

test('deleting the turned folder under a running transcode does not mark the video as failed', async () => {
  const t = await setup({ ...FAKE, FAKE_FFMPEG_DELAY_MS: '1200', HOUSEKEEPING_MS: '300' });
  try {
    const video = await t.upload('clip.mp4');
    await t.pair('portrait', [video.id]);
    const dir = path.join(t.srv.dataDir, 'media', 'turned');
    await t.until(async () => fs.existsSync(dir) && fs.readdirSync(dir).some(n => n.endsWith('.part')), 'a transcode to start');
    fs.rmSync(dir, { recursive: true, force: true });
    const until = async check => { for (let i = 0; i < 150; i++) { const v = await check(); if (v) return v; await new Promise(r => setTimeout(r, 100)); } throw new Error('timed out'); };
    const m = await until(async () => { const x = (await t.state()).media[0]; return x.turned || x.turnFailed ? x : null; });
    assert.equal(m.turnFailed, false);
    assert.equal(m.turned, true);
  } finally { stopServer(t.srv); }
});
