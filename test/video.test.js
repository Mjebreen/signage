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
      const filter = JSON.parse(r.text)[JSON.parse(r.text).indexOf('-vf') + 1];
      assert.ok(filter.startsWith(transpose + ','), deg + ' -> ' + filter);
      assert.match(filter, /fps=30/);
      assert.ok(JSON.parse(r.text).includes('-an'));
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

test('the PC preview does not overwrite what the TV reported', async () => {
  const t = await setup(FAKE);
  try {
    const id = await t.pair('portrait', []);
    await request(t.srv.base, 'POST', '/api/player/register', { body: { screenId: id, screenSize: '1745x859', preview: true } });
    const screen = (await t.state()).screens.find(s => s.id === id);
    assert.equal(screen.screenSize, '1920x1080');
  } finally { stopServer(t.srv); }
});

test('a TV running an older player script is asked to reload, once', async () => {
  const t = await setup(FAKE);
  try {
    const id = await t.pair('portrait', []);
    const firstMessage = url => new Promise(resolve => {
      const ws = new WebSocket(url);
      const done = v => { try { ws.terminate(); } catch (e) { /* ignore */ } resolve(v); };
      ws.on('message', d => done(JSON.parse(d).type));
      ws.on('error', () => done('error'));
      setTimeout(() => done('nothing'), 700);
    });
    assert.equal(await firstMessage(t.srv.wsBase + '/ws?screen=' + id), 'hardReload');        // old script: no version
    assert.equal(await firstMessage(t.srv.wsBase + '/ws?screen=' + id), 'nothing');           // not in a loop
    assert.equal(await firstMessage(t.srv.wsBase + '/ws?screen=' + id + '&pv=2'), 'nothing'); // current script
  } finally { stopServer(t.srv); }
});
