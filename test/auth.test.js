// Dashboard authentication, tested end to end.
//
// Spawns the real server on a free port with a throwaway data directory and
// talks to it over HTTP and WebSocket exactly as a TV and a browser would. The
// invariant that matters most is the first test: a TV must never need to log in.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct horse battery';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function startServer(env) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-test-'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, PUBLIC_URL: '', ADMIN_PASSWORD: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('server did not start:\n' + out)); }, 15000);
    const handle = { child, port, dataDir, base: 'http://127.0.0.1:' + port, wsBase: 'ws://127.0.0.1:' + port };
    child.stdout.on('data', d => { out += d; if (out.includes('LAN Signage running')) { clearTimeout(timer); resolve(handle); } });
    child.stderr.on('data', d => { out += d; });
    child.on('exit', code => { clearTimeout(timer); reject(Object.assign(new Error('server exited with ' + code + ':\n' + out), { code, out })); });
  });
}

function stopServer(h) {
  if (!h) return;
  try { h.child.kill(); } catch (e) { /* already gone */ }
  fs.rmSync(h.dataDir, { recursive: true, force: true });
}

function request(base, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(base + p, {
      method,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Resolves true if the socket reaches "open", false if the handshake is refused.
function wsOpens(url, headers) {
  return new Promise(resolve => {
    const ws = new WebSocket(url, { headers });
    let settled = false;
    const done = v => { if (settled) return; settled = true; try { ws.terminate(); } catch (e) { /* ignore */ } resolve(v); };
    ws.on('open', () => done(true));
    ws.on('error', () => done(false));
    ws.on('unexpected-response', () => done(false));
    setTimeout(() => done(false), 5000);
  });
}

const cookieOf = res => res.headers['set-cookie'][0].split(';')[0];

let srv;
before(async () => { srv = await startServer({ ADMIN_PASSWORD: PASSWORD }); });
after(() => stopServer(srv));

test('a TV never needs to log in', async () => {
  assert.equal((await request(srv.base, 'GET', '/player')).status, 200);
  assert.equal((await request(srv.base, 'GET', '/player.js')).status, 200);

  const reg = await request(srv.base, 'POST', '/api/player/register', { body: { screenSize: '1920x1080' } });
  assert.equal(reg.status, 200);
  assert.ok(reg.json.screenId);
  assert.equal(reg.json.paired, false);

  const cfg = await request(srv.base, 'GET', '/api/player/' + reg.json.screenId + '/config');
  assert.equal(cfg.status, 200);

  assert.equal(await wsOpens(srv.wsBase + '/ws?screen=' + reg.json.screenId), true);
});

test('the dashboard is closed without a session', async () => {
  assert.equal((await request(srv.base, 'GET', '/api/state')).status, 401);
  const home = await request(srv.base, 'GET', '/');
  assert.equal(home.status, 302);
  assert.equal(home.headers.location, '/login');
  assert.equal((await request(srv.base, 'PUT', '/api/settings', { body: { clockFormat: '12h' } })).status, 401);
  assert.equal((await request(srv.base, 'POST', '/api/screens/claim', { body: { code: 'ABCDEF' } })).status, 401);
  assert.equal((await request(srv.base, 'POST', '/api/media/web', { body: { url: 'http://x' } })).status, 401);
  assert.equal(await wsOpens(srv.wsBase + '/ws?admin=1'), false);
});

test('login page and session probe are public', async () => {
  assert.equal((await request(srv.base, 'GET', '/login')).status, 200);
  const s = await request(srv.base, 'GET', '/api/session');
  assert.equal(s.status, 200);
  assert.equal(s.json.authRequired, true);
  assert.equal(s.json.authenticated, false);
  assert.equal(s.json.viaTunnel, false);
});

test('wrong password is rejected; right password opens everything', async () => {
  const bad = await request(srv.base, 'POST', '/api/login', { body: { password: 'nope' } });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers['set-cookie'], undefined);

  const ok = await request(srv.base, 'POST', '/api/login', { body: { password: PASSWORD } });
  assert.equal(ok.status, 200);
  const raw = ok.headers['set-cookie'][0];
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Lax/);
  assert.doesNotMatch(raw, /Secure/); // plain http on the LAN
  const c = cookieOf(ok);

  assert.equal((await request(srv.base, 'GET', '/api/state', { headers: { Cookie: c } })).status, 200);
  assert.equal((await request(srv.base, 'GET', '/', { headers: { Cookie: c } })).status, 200);
  assert.equal((await request(srv.base, 'GET', '/login', { headers: { Cookie: c } })).status, 302);
  assert.equal(await wsOpens(srv.wsBase + '/ws?admin=1', { Cookie: c }), true);

  // A forged or tampered cookie is worthless.
  assert.equal((await request(srv.base, 'GET', '/api/state', { headers: { Cookie: 'signage_session=9999999999999.forged' } })).status, 401);
  assert.equal((await request(srv.base, 'GET', '/api/state', { headers: { Cookie: c.slice(0, -2) + 'zz' } })).status, 401);

  const out = await request(srv.base, 'POST', '/api/logout', { headers: { Cookie: c } });
  assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
});

test('the cookie is marked Secure behind an https proxy', async () => {
  const ok = await request(srv.base, 'POST', '/api/login', { body: { password: PASSWORD }, headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers['set-cookie'][0], /; Secure/);
});

test('session probe reports the tunnel and its upload limit', async () => {
  const s = await request(srv.base, 'GET', '/api/session', { headers: { 'CF-Connecting-IP': '198.51.100.9' } });
  assert.equal(s.json.viaTunnel, true);
  assert.equal(typeof s.json.uploadLimitMb, 'number');
});

test('repeated wrong passwords lock that client out', async () => {
  const h = { 'X-Forwarded-For': '203.0.113.7' }; // a distinct client so other tests are unaffected
  for (let i = 0; i < 10; i++) await request(srv.base, 'POST', '/api/login', { body: { password: 'x' }, headers: h });
  const locked = await request(srv.base, 'POST', '/api/login', { body: { password: PASSWORD }, headers: h });
  assert.equal(locked.status, 429);
  // ...and only that client
  assert.equal((await request(srv.base, 'POST', '/api/login', { body: { password: PASSWORD } })).status, 200);
});

test('without a password the dashboard stays open (LAN-only mode)', async () => {
  const open = await startServer({ ADMIN_PASSWORD: '' });
  try {
    assert.equal((await request(open.base, 'GET', '/api/state')).status, 200);
    assert.equal((await request(open.base, 'GET', '/api/session')).json.authRequired, false);
    assert.equal(await wsOpens(open.wsBase + '/ws?admin=1'), true);
  } finally { stopServer(open); }
});

test('refuses to start exposed to the internet without a password', async () => {
  await assert.rejects(
    startServer({ ADMIN_PASSWORD: '', PUBLIC_URL: 'https://signage.example.com' }),
    err => err.code === 1 && /ADMIN_PASSWORD/.test(err.out),
  );
});
