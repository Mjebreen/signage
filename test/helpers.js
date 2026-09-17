// Shared by the test files: start the real server on a free port with a throwaway
// data directory, and talk to it over HTTP and WebSocket as a TV or browser would.
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function startServer(env, { unset = [] } = {}) {
  const port = await freePort();
  // Pass DATA_DIR to start a second server on the data a first one left behind.
  const dataDir = (env && env.DATA_DIR) || fs.mkdtempSync(path.join(os.tmpdir(), 'signage-test-'));
  // SIGNAGE_ENV_FILE points away from the project's real .env so a developer's
  // own password can never leak into (or break) a test run.
  const childEnv = { ...process.env, PORT: String(port), DATA_DIR: dataDir, PUBLIC_URL: '', ADMIN_PASSWORD: '', SIGNAGE_ENV_FILE: path.join(dataDir, 'none.env'), ...env };
  for (const k of unset) delete childEnv[k];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('server did not start:\n' + out)); }, 15000);
    const handle = { child, port, dataDir, base: 'http://127.0.0.1:' + port, wsBase: 'ws://127.0.0.1:' + port };
    child.stdout.on('data', d => { out += d; if (out.includes('LAN Signage running')) { clearTimeout(timer); resolve(handle); } });
    child.stderr.on('data', d => { out += d; });
    child.on('exit', code => { clearTimeout(timer); reject(Object.assign(new Error('server exited with ' + code + ':\n' + out), { code, out })); });
  });
}

function stopServer(h, { keepData = false } = {}) {
  if (!h) return;
  try { h.child.kill(); } catch (e) { /* already gone */ }
  if (!keepData) fs.rmSync(h.dataDir, { recursive: true, force: true });
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

module.exports = { ROOT, startServer, stopServer, request, wsOpens, wsSurvives, cookieOf };
