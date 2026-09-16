// Dashboard authentication. No dependencies: a single admin password, a signed
// session cookie, and a small brute-force lockout.
//
// Why an allow-list rather than protecting routes one by one: the TV player is
// the thing that must never break. Listing exactly what a TV needs, and gating
// everything else, means a new dashboard route is protected by default and a
// forgotten one fails closed rather than open.
const crypto = require('crypto');

const COOKIE = 'signage_session';
const SESSION_DAYS = 30;
const MAX_FAILURES = 10;          // wrong passwords per IP...
const LOCKOUT_MS = 15 * 60 * 1000; // ...before this cooling-off period

// Everything a TV player or a not-yet-logged-in browser may fetch.
const PUBLIC_EXACT = new Set([
  '/player', '/player.html', '/player.js',
  '/login', '/login.html', '/style.css', '/favicon.ico',
  '/api/login', '/api/logout', '/api/session',
]);
const PUBLIC_PREFIX = ['/api/player/', '/media/'];

function isPublicPath(pathname) {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIX.some(p => pathname.startsWith(p));
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
  const failures = new Map(); // ip -> { count, since, until }

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
  // Behind Cloudflare the app sees plain HTTP; express's trust-proxy setting
  // turns the forwarded header into req.secure so the cookie gets Secure.
  const isSecure = req => !!req.secure || req.headers['x-forwarded-proto'] === 'https';
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

  // Express middleware: let public paths through, gate everything else.
  function middleware(req, res, next) {
    if (!enabled || isPublicPath(req.path) || isAuthenticated(req)) { next(); return; }
    if (req.path.startsWith('/api/')) { res.status(401).json({ error: 'Login required' }); return; }
    if (req.method === 'GET') { res.redirect(302, '/login'); return; }
    res.status(401).json({ error: 'Login required' });
  }

  // ws "verifyClient": screens connect freely; the admin channel needs a session.
  function verifyWebSocket(info, done) {
    const q = new URL(info.req.url, 'http://x').searchParams;
    if (q.get('admin') && !isAuthenticated(info.req)) { done(false, 401, 'Unauthorized'); return; }
    done(true);
  }

  return { enabled, middleware, login, logout, isAuthenticated, verifyWebSocket, isPublicPath, COOKIE };
}

module.exports = { createAuth, isPublicPath, COOKIE };
