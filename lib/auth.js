// Dashboard authentication. No dependencies: a single admin password, a signed
// session cookie, and a small brute-force lockout.
//
// Why an allow-list rather than protecting routes one by one: the TV player is
// the thing that must never break. Listing exactly what a TV needs, and gating
// everything else, means a new dashboard route is protected by default and a
// forgotten one fails closed rather than open.
//
// Paths are canonicalised before the allow-list is consulted. Express does not
// normalise dot-segments or percent-encoding in req.path, but the static file
// handler does, so without this "/media/../app.js" would pass the allow-list as
// a media request and then be served as the dashboard. Anything that is not a
// plain path is refused outright; nothing legitimate ever sends one.
const crypto = require('crypto');

const COOKIE = 'signage_session';
const SESSION_DAYS = 30;
const MAX_FAILURES = 10;          // wrong passwords per client...
const LOCKOUT_MS = 15 * 60 * 1000; // ...before this cooling-off period

// Everything a TV player or a not-yet-logged-in browser may fetch.
const PUBLIC_EXACT = new Set([
  '/player', '/player.html', '/player.js',
  '/login', '/login.html', '/style.css', '/favicon.ico',
  '/api/login', '/api/logout', '/api/session',
]);
const PUBLIC_PREFIX = ['/api/player/', '/media/'];

// Decoded path, or null when it contains anything a real client never sends:
// dot-segments, backslashes, NUL, or undecodable escapes.
function canonicalPath(raw) {
  let p;
  try { p = decodeURIComponent(raw); } catch (e) { return null; }
  if (p.indexOf('\\') !== -1 || p.indexOf('\0') !== -1) return null;
  const segments = p.split('/');
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === '.' || segments[i] === '..') return null;
  }
  return p;
}

function isPublicPath(pathname) {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIX.some(p => pathname.startsWith(p));
}

function isLoopback(addr) {
  return addr === '::1' || (typeof addr === 'string' && (addr.startsWith('127.') || addr.startsWith('::ffff:127.')));
}

// True only when the request arrived through the tunnel connector: cloudflared
// sets CF-Connecting-IP, and coming from a trusted proxy address (loopback by
// default) is what makes that header believable. A LAN client can forge the
// header but not its own socket address.
function isViaTunnel(req) {
  const peer = req.socket && req.socket.remoteAddress;
  const trust = req.app && req.app.get('trust proxy fn');
  const trusted = typeof trust === 'function' ? trust(peer, 0) : isLoopback(peer);
  return !!trusted && !!req.headers['cf-connecting-ip'];
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { /* ignore */ }
    }
  }
  return out;
}

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest(); }

function createAuth(options) {
  const password = String(options.password || '');
  const enabled = password.length > 0;
  // Sessions must survive a service restart, so derive the signing key from the
  // password unless an explicit secret is provided. Changing the password logs
  // everyone out, which is the behaviour you want.
  const secret = options.secret
    ? sha256('signage-session:' + options.secret)
    : (enabled ? sha256('signage-session:' + password) : crypto.randomBytes(32));
  const passwordHash = sha256(password);
  const failures = new Map(); // client -> { count, since, until }

  const sign = exp => crypto.createHmac('sha256', secret).update(String(exp)).digest('base64url');

  function makeToken() {
    const exp = Date.now() + SESSION_DAYS * 86400000;
    return exp + '.' + sign(exp);
  }

  function verifyToken(token) {
    if (!token || typeof token !== 'string') return false;
    const i = token.indexOf('.');
    if (i < 0) return false;
    const exp = Number(token.slice(0, i));
    if (!Number.isFinite(exp) || exp < Date.now()) return false;
    const given = Buffer.from(token.slice(i + 1));
    const expected = Buffer.from(sign(exp));
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  const tokenOf = req => parseCookies(req.headers.cookie)[COOKIE];
  const isAuthenticated = req => !enabled || verifyToken(tokenOf(req));
  // req.secure and req.ip honour X-Forwarded-* only from proxies the app trusts
  // (server.js: loopback by default, where cloudflared runs). A direct LAN
  // client therefore cannot pick its own lockout bucket or claim to be https.
  const isSecure = req => !!req.secure;
  const clientIp = req => req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';

  function setCookie(req, res, value, maxAgeSeconds) {
    const parts = [COOKIE + '=' + value, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + maxAgeSeconds];
    if (isSecure(req)) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  function lockState(ip) {
    const f = failures.get(ip);
    if (!f) return null;
    if (f.until && f.until > Date.now()) return f;
    if (Date.now() - f.since > LOCKOUT_MS) { failures.delete(ip); return null; }
    return f;
  }

  function recordFailure(ip) {
    const now = Date.now();
    const f = lockState(ip) || { count: 0, since: now, until: 0 };
    f.count += 1;
    if (f.count >= MAX_FAILURES) f.until = now + LOCKOUT_MS;
    failures.set(ip, f);
  }

  function login(req, res) {
    if (!enabled) { res.json({ ok: true, authRequired: false }); return; }
    const ip = clientIp(req);
    const lock = lockState(ip);
    if (lock && lock.until > Date.now()) {
      res.status(429).json({ error: 'Too many attempts. Try again in ' + Math.ceil((lock.until - Date.now()) / 60000) + ' min.' });
      return;
    }
    const given = req.body && typeof req.body.password === 'string' ? req.body.password : '';
    if (!crypto.timingSafeEqual(sha256(given), passwordHash)) {
      recordFailure(ip);
      res.status(401).json({ error: 'Wrong password' });
      return;
    }
    failures.delete(ip);
    setCookie(req, res, makeToken(), SESSION_DAYS * 86400);
    res.json({ ok: true, authRequired: true });
  }

  function logout(req, res) {
    setCookie(req, res, '', 0);
    res.json({ ok: true });
  }

  // Express middleware: refuse odd paths, let public paths through, gate the rest.
  function middleware(req, res, next) {
    const p = canonicalPath(req.path);
    if (p === null) { res.status(400).json({ error: 'Bad path' }); return; }
    if (!enabled || isPublicPath(p) || isAuthenticated(req)) { next(); return; }
    if (p.startsWith('/api/')) { res.status(401).json({ error: 'Login required' }); return; }
    if (req.method === 'GET') { res.redirect(302, '/login'); return; }
    res.status(401).json({ error: 'Login required' });
  }

  // ws "verifyClient": screens connect freely; the admin channel needs a session.
  function verifyWebSocket(info, done) {
    const q = new URL(info.req.url, 'http://x').searchParams;
    if (q.get('admin') && !isAuthenticated(info.req)) { done(false, 401, 'Unauthorized'); return; }
    done(true);
  }

  return { enabled, middleware, login, logout, isAuthenticated, verifyWebSocket, isPublicPath, isViaTunnel, COOKIE };
}

module.exports = { createAuth, isPublicPath, canonicalPath, isViaTunnel, isLoopback, COOKIE };
