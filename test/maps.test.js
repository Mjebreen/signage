// The Map page: pictures with TVs pinned on them.
//
// Dashboard-only by design: a floor plan says where things are in a building, so unlike
// /media it must never be readable without the login, and moving a pin must never reach a TV.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const { startServer, stopServer, request, cookieOf } = require('./helpers');

const PASSWORD = 'map tests';
// the smallest valid PNG: one transparent pixel
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let srv, cookie;
before(async () => {
  srv = await startServer({ ADMIN_PASSWORD: PASSWORD });
  cookie = cookieOf(await request(srv.base, 'POST', '/api/login', { body: { password: PASSWORD } }));
});
after(() => stopServer(srv));

const admin = extra => ({ headers: { Cookie: cookie }, ...extra });
const state = () => request(srv.base, 'GET', '/api/state', admin()).then(r => r.json);

function form(fields, file) {
  const boundary = '----signagemap' + Object.keys(fields).length + (file ? file.name.length : 0) + 'x7';
  const parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + v + '\r\n'));
  if (file) parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="image"; filename="' + file.name + '"\r\nContent-Type: ' + file.type + '\r\n\r\n'), file.content, Buffer.from('\r\n'));
  parts.push(Buffer.from('--' + boundary + '--\r\n'));
  return { rawBody: Buffer.concat(parts), type: 'multipart/form-data; boundary=' + boundary };
}
const post = (url, fields, file, withCookie = true) => {
  const f = form(fields, file);
  return request(srv.base, 'POST', url, { rawBody: f.rawBody, headers: { 'Content-Type': f.type, ...(withCookie ? { Cookie: cookie } : {}) } });
};
async function pairedScreen(name) {
  const reg = await request(srv.base, 'POST', '/api/player/register', { body: { screenSize: '1920x1080' } });
  await request(srv.base, 'POST', '/api/screens/claim', admin({ body: { code: reg.json.code, name, orientation: 'portrait' } }));
  return reg.json.screenId;
}

test('maps are behind the login, picture included', async () => {
  const made = await post('/api/maps', { name: 'Secret floor' }, { name: 'plan.png', type: 'image/png', content: PNG });
  assert.equal(made.status, 200);
  const id = made.json.id;

  for (const [method, url] of [['GET', '/api/maps/' + id + '/image'], ['DELETE', '/api/maps/' + id], ['PATCH', '/api/maps/' + id]]) {
    assert.equal((await request(srv.base, method, url, { body: method === 'PATCH' ? { name: 'x' } : undefined })).status, 401, method + ' ' + url);
  }
  assert.equal((await post('/api/maps', { name: 'nope' }, null, false)).status, 401);
  assert.equal((await request(srv.base, 'PUT', '/api/screens/whatever/place', { body: { mapId: id, x: 1, y: 1 } })).status, 401);

  // and it is not sitting in the open /media folder either
  const stored = fs.readdirSync(path.join(srv.dataDir, 'maps'));
  assert.equal(stored.length, 1);
  assert.equal((await request(srv.base, 'GET', '/media/' + stored[0])).status, 404);
  assert.equal((await request(srv.base, 'GET', '/media/maps/' + stored[0])).status, 404);
  assert.equal((await request(srv.base, 'GET', '/media/../maps/' + stored[0])).status, 400);

  const pic = await request(srv.base, 'GET', '/api/maps/' + id + '/image', admin());
  assert.equal(pic.status, 200);
  assert.equal(pic.headers['content-type'], 'image/png');
  assert.equal(pic.headers['x-content-type-options'], 'nosniff');
  assert.match(pic.headers['cache-control'], /private/);
});

test('a map can be made with or without a picture; only pictures are accepted', async () => {
  const blank = await post('/api/maps', { name: '  Warehouse  ' });
  assert.equal(blank.status, 200);
  assert.deepEqual([blank.json.name, blank.json.hasImage], ['Warehouse', false]);
  assert.equal((await request(srv.base, 'GET', '/api/maps/' + blank.json.id + '/image', admin())).status, 404);

  const unnamed = await post('/api/maps', { name: '' });
  assert.match(unnamed.json.name, /^Map \d+$/);

  const before = fs.readdirSync(path.join(srv.dataDir, 'maps')).length;
  const html = await post('/api/maps', { name: 'Bad' }, { name: 'plan.html', type: 'text/html', content: Buffer.from('<script>alert(1)</script>') });
  assert.equal(html.status, 400);
  const svg = await post('/api/maps/' + blank.json.id + '/image', {}, { name: 'plan.svg', type: 'image/svg+xml', content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
  assert.equal(svg.status, 400);
  assert.equal(fs.readdirSync(path.join(srv.dataDir, 'maps')).length, before, 'a refused upload leaves no file behind');
  assert.ok(!(await state()).maps.some(m => m.name === 'Bad'));

  // the stored name never comes from the uploader
  const sneaky = await post('/api/maps/' + blank.json.id + '/image', {}, { name: '../../evil.png', type: 'image/png', content: PNG });
  assert.equal(sneaky.status, 200);
  assert.equal(sneaky.json.hasImage, true);
  assert.ok(sneaky.json.updatedAt >= blank.json.updatedAt);
  assert.ok(fs.readdirSync(path.join(srv.dataDir, 'maps')).every(n => /^[a-z0-9]+\.(png|jpg|webp|gif)$/.test(n)));
  assert.equal(fs.existsSync(path.join(srv.dataDir, 'evil.png')), false);

  // replacing the picture removes the old file
  const count = fs.readdirSync(path.join(srv.dataDir, 'maps')).length;
  assert.equal((await post('/api/maps/' + blank.json.id + '/image', {}, { name: 'new.png', type: 'image/png', content: PNG })).status, 200);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(fs.readdirSync(path.join(srv.dataDir, 'maps')).length, count);

  assert.equal((await post('/api/maps/nope/image', {}, { name: 'a.png', type: 'image/png', content: PNG })).status, 404);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(fs.readdirSync(path.join(srv.dataDir, 'maps')).length, count, 'an upload for a map that does not exist is thrown away');

  const renamed = await request(srv.base, 'PATCH', '/api/maps/' + blank.json.id, admin({ body: { name: 'Warehouse B' } }));
  assert.equal(renamed.json.name, 'Warehouse B');
  assert.equal((await request(srv.base, 'PATCH', '/api/maps/' + blank.json.id, admin({ body: { name: '   ' } }))).json.name, 'Warehouse B');
});

test('pinning a TV: stored in percent, clamped, and the TV never hears about it', async () => {
  const map = (await post('/api/maps', { name: 'Hall' })).json;
  const id = await pairedScreen('Hall TV');
  const versionBefore = (await request(srv.base, 'GET', '/api/player/' + id + '/config')).json.version;

  // a TV that is connected while its pin is moved
  const heard = [];
  const tv = new WebSocket(srv.wsBase + '/ws?screen=' + id + '&pv=4');
  await new Promise((resolve, reject) => { tv.on('open', resolve); tv.on('error', reject); });
  tv.on('message', d => heard.push(JSON.parse(d).type));

  try {
    let r = await request(srv.base, 'PUT', '/api/screens/' + id + '/place', admin({ body: { mapId: map.id, x: 25.12345, y: 80 } }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.map, { id: map.id, x: 25.12, y: 80 });
    r = await request(srv.base, 'PUT', '/api/screens/' + id + '/place', admin({ body: { mapId: map.id, x: -40, y: 400 } }));
    assert.deepEqual(r.json.map, { id: map.id, x: 0, y: 100 });
    r = await request(srv.base, 'PUT', '/api/screens/' + id + '/place', admin({ body: { mapId: map.id, x: 'abc' } }));
    assert.deepEqual(r.json.map, { id: map.id, x: 0, y: 0 });
    assert.deepEqual((await state()).screens.find(s => s.id === id).map, { id: map.id, x: 0, y: 0 });

    assert.equal((await request(srv.base, 'PUT', '/api/screens/' + id + '/place', admin({ body: { mapId: 'no-such-map', x: 1, y: 1 } }))).status, 404);
    assert.equal((await request(srv.base, 'PUT', '/api/screens/nope/place', admin({ body: { mapId: map.id, x: 1, y: 1 } }))).status, 404);

    // a TV still showing its pairing code cannot be pinned
    const unpaired = await request(srv.base, 'POST', '/api/player/register', { body: { screenSize: '1920x1080' } });
    assert.equal((await request(srv.base, 'PUT', '/api/screens/' + unpaired.json.screenId + '/place', admin({ body: { mapId: map.id, x: 1, y: 1 } }))).status, 400);

    // saving the TV from its editor does not knock it off the map
    await request(srv.base, 'PUT', '/api/screens/' + id, admin({ body: { name: 'Hall TV 2', seconds: 9 } }));
    assert.deepEqual((await state()).screens.find(s => s.id === id).map, { id: map.id, x: 0, y: 0 });

    // nothing about the map is in what the TV is sent, and the TV was only told about the rename
    const cfg = (await request(srv.base, 'GET', '/api/player/' + id + '/config')).json;
    assert.equal(JSON.stringify(cfg).includes(map.id), false);
    await new Promise(resolve => { tv.once('message', resolve); tv.send(JSON.stringify({ type: 'ping' })); setTimeout(resolve, 2000); });
    assert.deepEqual(heard.filter(t => t !== 'pong'), ['reload'], 'one reload, for the rename; none for the pin moves');
    assert.notEqual(cfg.version, versionBefore); // the rename
  } finally { tv.terminate(); }

  // off the map again
  const off = await request(srv.base, 'PUT', '/api/screens/' + id + '/place', admin({ body: { mapId: null } }));
  assert.equal(off.json.map, null);
});

test('deleting a map takes its TVs off it and removes the picture; other maps are untouched', async () => {
  const a = (await post('/api/maps', { name: 'A' }, { name: 'a.png', type: 'image/png', content: PNG })).json;
  const b = (await post('/api/maps', { name: 'B' })).json;
  const onA = await pairedScreen('On A');
  const onB = await pairedScreen('On B');
  await request(srv.base, 'PUT', '/api/screens/' + onA + '/place', admin({ body: { mapId: a.id, x: 10, y: 10 } }));
  await request(srv.base, 'PUT', '/api/screens/' + onB + '/place', admin({ body: { mapId: b.id, x: 20, y: 20 } }));
  const files = fs.readdirSync(path.join(srv.dataDir, 'maps')).length;

  assert.equal((await request(srv.base, 'DELETE', '/api/maps/' + a.id, admin())).status, 200);
  const s = await state();
  assert.ok(!s.maps.some(m => m.id === a.id));
  assert.equal(s.screens.find(x => x.id === onA).map, null);
  assert.equal(s.screens.find(x => x.id === onA).paired, true);
  assert.deepEqual(s.screens.find(x => x.id === onB).map, { id: b.id, x: 20, y: 20 });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(fs.readdirSync(path.join(srv.dataDir, 'maps')).length, files - 1);
  assert.equal((await request(srv.base, 'DELETE', '/api/maps/' + a.id, admin())).status, 404);
});

test('a database from before maps existed gains them on load', async () => {
  const old = await startServer({ ADMIN_PASSWORD: PASSWORD });
  let dataDir;
  try {
    const id = await (async () => {
      const reg = await request(old.base, 'POST', '/api/player/register', { body: { screenSize: '1920x1080' } });
      return reg.json.screenId;
    })();
    await new Promise(r => setTimeout(r, 400)); // the store writes a moment after a change
    dataDir = old.dataDir;
    const file = path.join(dataDir, 'db.json');
    const db = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete db.maps;
    for (const s of db.screens) delete s.map;
    assert.ok(db.screens.some(s => s.id === id));
    stopServer(old, { keepData: true });
    await new Promise(r => setTimeout(r, 300));
    fs.writeFileSync(file, JSON.stringify(db));
  } catch (e) { stopServer(old); throw e; }

  const again = await startServer({ ADMIN_PASSWORD: PASSWORD, DATA_DIR: dataDir });
  try {
    const c = cookieOf(await request(again.base, 'POST', '/api/login', { body: { password: PASSWORD } }));
    const s = (await request(again.base, 'GET', '/api/state', { headers: { Cookie: c } })).json;
    assert.deepEqual(s.maps, []);
    assert.ok(s.screens.length >= 1);
    assert.ok(s.screens.every(x => x.map === null));
  } finally { stopServer(again); }
});
