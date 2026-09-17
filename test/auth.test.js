// Dashboard authentication, tested end to end.
//
// Spawns the real server on a free port with a throwaway data directory and
// talks to it over HTTP and WebSocket exactly as a TV and a browser would. The
// invariant that matters most is the first test: a TV must never need to log in.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
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

async function startServer(env, { unset = [] } = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-test-'));
  // SIGNAGE_ENV_FILE points away from the project's real .env so a developer's
  // own password can never leak into (or break) a test run.
  const childEnv = { ...process.env, PORT: String(port), DATA_DIR: dataDir, PUBLIC_URL: '', ADMIN_PASSWORD: '', SIGNAGE_ENV_FILE: path.join(dataDir, 'none.env'), ...env };
  for (const k of unset) delete childEnv[k];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: childEnv,
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

// Uses the options form of http.request so the path is sent exactly as given
// (the URL form would silently normalise "/media/../app.js" before sending).
function request(base, method, p, { headers = {}, body, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const data = rawBody !== undefined ? rawBody : (body === undefined ? null : JSON.stringify(body));
    const req = http.request({
      hostname: u.hostname, port: u.port, path: p, method,
      headers: { ...(data !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
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

// Resolves true only if the socket opens AND the server keeps it open.
function wsSurvives(url, headers) {
  return new Promise(resolve => {
    const ws = new WebSocket(url, { headers });
    let settled = false, opened = false;
    const done = v => { if (settled) return; settled = true; try { ws.terminate(); } catch (e) { /* ignore */ } resolve(v); };
    ws.on('open', () => { opened = true; setTimeout(() => done(true), 800); });
    ws.on('close', () => done(false));
    ws.on('error', () => done(false));
    ws.on('unexpected-response', () => done(false));
    setTimeout(() => done(opened), 5000);
  });
}

const cookieOf = res => res.headers['set-cookie'][0].split(';')[0];

async function loginCookie(base) {
  const ok = await request(base, 'POST', '/api/login', { body: { password: PASSWORD } });
  assert.equal(ok.status, 200);
  return cookieOf(ok);
}

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

  fs.writeFileSync(path.join(srv.dataDir, 'media', 'x.txt'), 'hi');
  const media = await request(srv.base, 'GET', '/media/x.txt');
  assert.equal(media.status, 200);
  assert.equal(media.text, 'hi');
  assert.equal((await request(srv.base, 'GET', '/media/missing.txt')).status, 404);
  // Percent-encoded names (the player uses encodeURIComponent) are still fine.
  assert.equal((await request(srv.base, 'GET', '/media/photo%20one.jpg')).status, 404);

  assert.equal(await wsSurvives(srv.wsBase + '/ws?screen=' + reg.json.screenId), true);
});

test('a paired, then deleted, TV recovers without logging in', async () => {
  const reg = await request(srv.base, 'POST', '/api/player/register', { body: {} });
  const id = reg.json.screenId;
  const c = await loginCookie(srv.base);

  const claim = await request(srv.base, 'POST', '/api/screens/claim', { body: { code: reg.json.code, name: 'Lobby' }, headers: { Cookie: c } });
  assert.equal(claim.status, 200);

  const paired = await request(srv.base, 'GET', '/api/player/' + id + '/config');
  assert.equal(paired.status, 200);
  assert.equal(paired.json.paired, true);
  assert.equal(paired.json.code, undefined);

  const again = await request(srv.base, 'POST', '/api/player/register', { body: { screenId: id } });
  assert.equal(again.json.screenId, id);

  assert.equal((await request(srv.base, 'DELETE', '/api/screens/' + id, { headers: { Cookie: c } })).status, 200);
  // player.js relies on exactly 404 here to reset itself
  assert.equal((await request(srv.base, 'GET', '/api/player/' + id + '/config')).status, 404);

  const fresh = await request(srv.base, 'POST', '/api/player/register', { body: { screenId: id } });
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.json.screenId, id);
  assert.equal(fresh.json.paired, false);
});

test('the dashboard is closed without a session', async () => {
  assert.equal((await request(srv.base, 'GET', '/api/state')).status, 401);
  const home = await request(srv.base, 'GET', '/');
  assert.equal(home.status, 302);
  assert.equal(home.headers.location, '/login');
  assert.equal((await request(srv.base, 'PUT', '/api/settings', { body: { clockFormat: '12h' } })).status, 401);
  assert.equal((await request(srv.base, 'POST', '/api/screens/claim', { body: { code: 'ABCDEF' } })).status, 401);
  assert.equal((await request(srv.base, 'POST', '/api/screens/anything/reload')).status, 401);
  assert.equal((await request(srv.base, 'POST', '/api/media/web', { body: { url: 'http://x' } })).status, 401);
  assert.equal(await wsOpens(srv.wsBase + '/ws?admin=1'), false);
  assert.equal(await wsOpens(srv.wsBase + '/ws?screen=x&admin=1'), false);
});

test('dot-segments and encoded slashes cannot sneak past the allow-list', async () => {
  for (const p of ['/media/../app.js', '/media/%2e%2e/index.html', '/api/player/../../app.js', '/api/player/..%2f..%2fapp.js']) {
    const r = await request(srv.base, 'GET', p);
    assert.equal(r.status, 400, p);
  }
  // and the direct requests stay gated
  assert.equal((await request(srv.base, 'GET', '/app.js')).status, 302);
  assert.equal((await request(srv.base, 'GET', '/index.html')).status, 302);
});

test('login page and session probe are public', async () => {
  assert.equal((await request(srv.base, 'GET', '/login')).status, 200);
  const s = await request(srv.base, 'GET', '/api/session');
  assert.equal(s.status, 200);
  assert.equal(s.json.authRequired, true);
  assert.equal(s.json.authenticated, false);
  assert.equal(s.json.viaTunnel, false);
});

test('malformed JSON gets a plain 400, never an error page', async () => {
  for (const raw of ['null', '{bad', '"str"']) {
    const r = await request(srv.base, 'POST', '/api/login', { rawBody: raw });
    assert.equal(r.status, 400, raw);
    assert.ok(r.json && r.json.error, raw);
    assert.doesNotMatch(r.text, /node_modules|at .*\.js:\d+/);
  }
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
  assert.equal(await wsSurvives(srv.wsBase + '/ws?admin=1', { Cookie: c }), true);

  // A forged, tampered or expired cookie is worthless.
  assert.equal((await request(srv.base, 'GET', '/api/state', { headers: { Cookie: 'signage_session=9999999999999.forged' } })).status, 401);
  assert.equal((await request(srv.base, 'GET', '/api/state', { headers: { Cookie: c.slice(0, -2) + 'zz' } })).status, 401);
  const key = crypto.createHash('sha256').update('signage-session:' + PASSWORD).digest();
  const exp = Date.now() - 1000;
  const expired = 'signage_session=' + exp + '.' + crypto.createHmac('sha256', key).update(String(exp)).digest('base64url');
  assert.equal((await request(srv.base, 'GET', '/api/state', { headers: { Cookie: expired } })).status, 401);

  const out = await request(srv.base, 'POST', '/api/logout', { headers: { Cookie: c } });
  assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
});

test('the cookie is marked Secure behind the https tunnel', async () => {
  // The test client is on loopback, which is the trusted proxy address.
  const ok = await request(srv.base, 'POST', '/api/login', { body: { password: PASSWORD }, headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers['set-cookie'][0], /; Secure/);
});

test('session probe reports the tunnel and its upload limit', async () => {
  const s = await request(srv.base, 'GET', '/api/session', { headers: { 'CF-Connecting-IP': '198.51.100.9' } });
  assert.equal(s.json.viaTunnel, true);
  assert.equal(typeof s.json.uploadLimitMb, 'number');
});

test('web page addresses must be http(s)', async () => {
  const c = await loginCookie(srv.base);
  assert.equal((await request(srv.base, 'POST', '/api/media/web', { body: { url: 'javascript:alert(1)' }, headers: { Cookie: c } })).status, 400);
  assert.equal((await request(srv.base, 'POST', '/api/media/web', { body: { url: 'https://example.com/board' }, headers: { Cookie: c } })).status, 200);
});

test('repeated wrong passwords lock that client out', async () => {
  // From loopback (the trusted proxy address) a forwarded address is honoured,
  // which is exactly how cloudflared hands over the visitor's IP.
  const h = { 'X-Forwarded-For': '203.0.113.7' };
  for (let i = 0; i < 10; i++) await request(srv.base, 'POST', '/api/login', { body: { password: 'x' }, headers: h });
  const locked = await request(srv.base, 'POST', '/api/login', { body: { password: PASSWORD }, headers: h });
  assert.equal(locked.status, 429);
  // ...and only that client
  assert.equal((await request(srv.base, 'POST', '/api/login', { body: { password: PASSWORD } })).status, 200);
});

test('anonymous registration is throttled and unknown screens are cut off', async () => {
  const fresh = await startServer({ ADMIN_PASSWORD: PASSWORD });
  try {
    let last;
    for (let i = 0; i < 31; i++) last = await request(fresh.base, 'POST', '/api/player/register', { body: {} });
    assert.equal(last.status, 429);
    assert.equal(await wsSurvives(fresh.wsBase + '/ws?screen=does-not-exist'), false);
  } finally { stopServer(fresh); }
});

test('settings come from the env file, and the real environment wins', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-env-'));
  const file = path.join(dir, 'local.env');
  fs.writeFileSync(file, '# comment\n\nADMIN_PASSWORD="from file"\n');
  try {
    const fromFile = await startServer({ SIGNAGE_ENV_FILE: file }, { unset: ['ADMIN_PASSWORD'] });
    try {
      assert.equal((await request(fromFile.base, 'GET', '/api/session')).json.authRequired, true);
      assert.equal((await request(fromFile.base, 'POST', '/api/login', { body: { password: 'from file' } })).status, 200);
    } finally { stopServer(fromFile); }

    const fromEnv = await startServer({ SIGNAGE_ENV_FILE: file, ADMIN_PASSWORD: 'from env' });
    try {
      assert.equal((await request(fromEnv.base, 'POST', '/api/login', { body: { password: 'from env' } })).status, 200);
      assert.equal((await request(fromEnv.base, 'POST', '/api/login', { body: { password: 'from file' } })).status, 401);
    } finally { stopServer(fromEnv); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
