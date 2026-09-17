// Portrait (9:16) and landscape (16:9) screens.
//
// Two halves: the pure rotation maths the TV runs (public/player-layout.js), and
// what the server tells each screen. A TV mounted on its side normally still
// renders a landscape page, so "portrait" has to mean "what a person sees", and
// the player works out for itself whether it needs to turn the picture.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, request, cookieOf } = require('./helpers');
const { decideLayout } = require('../public/player-layout.js');

const PASSWORD = 'orientation tests';
let srv, cookie;
before(async () => {
  srv = await startServer({ ADMIN_PASSWORD: PASSWORD });
  cookie = cookieOf(await request(srv.base, 'POST', '/api/login', { body: { password: PASSWORD } }));
});
after(() => stopServer(srv));

const admin = extra => ({ headers: { Cookie: cookie }, ...extra });
const zone = (cfg, type) => cfg.zones.find(z => z.type === type);
const register = body => request(srv.base, 'POST', '/api/player/register', { body });
const configOf = id => request(srv.base, 'GET', '/api/player/' + id + '/config').then(r => r.json);

test('rotation maths: a TV on its side still renders landscape, so the player turns the picture', () => {
  // the common case: consumer TV turned 90 degrees, browser still 1920x1080
  // Samsung says to hang a panel in portrait by turning it clockwise, so the picture
  // needs the opposite turn: 270 degrees, as an exact matrix about the top-left corner.
  assert.deepEqual(decideLayout(1920, 1080, 'portrait', false, false),
    { width: 1080, height: 1920, deg: 270, left: 0, top: 0, transform: 'matrix(0,-1,1,0,0,1080)', unit: 10.8 });
  // hung the other way round
  const flipped = decideLayout(1920, 1080, 'portrait', true, false);
  assert.equal(flipped.deg, 90);
  assert.equal(flipped.transform, 'matrix(0,1,-1,0,1920,0)');

  // landscape TV, landscape content: untouched
  assert.deepEqual(decideLayout(1920, 1080, 'landscape', false, false),
    { width: 1920, height: 1080, deg: 0, left: 0, top: 0, transform: 'none', unit: 10.8 });
  const upsideDown = decideLayout(1920, 1080, 'landscape', true, false);
  assert.equal(upsideDown.deg, 180);
  assert.equal(upsideDown.transform, 'matrix(-1,0,0,-1,1920,1080)');

  // a display whose browser already reports a tall viewport needs no turning
  assert.deepEqual(decideLayout(1080, 1920, 'portrait', false, false),
    { width: 1080, height: 1920, deg: 0, left: 0, top: 0, transform: 'none', unit: 10.8 });
  assert.equal(decideLayout(1080, 1920, 'landscape', false, false).deg, 270);

  // every turn maps the logical box exactly onto the viewport, for odd sizes too
  // (a centred rotation would land on half pixels here and blur the page)
  for (const [vw, vh] of [[1920, 1080], [1280, 720], [960, 540], [1365, 768], [867, 417]]) {
    for (const flip of [false, true]) {
      const b = decideLayout(vw, vh, 'portrait', flip, false);
      const m = /^matrix\(([-\d]+),([-\d]+),([-\d]+),([-\d]+),([-\d]+),([-\d]+)\)$/.exec(b.transform).slice(1).map(Number);
      const at = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
      const corners = [at(0, 0), at(b.width, 0), at(0, b.height), at(b.width, b.height)];
      const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
      assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [0, vw, 0, vh], vw + 'x' + vh + ' flip=' + flip);
    }
  }

  // text sizes come from the short side, so they match in both orientations
  assert.equal(decideLayout(1920, 1080, 'portrait', false, false).unit,
    decideLayout(1920, 1080, 'landscape', false, false).unit);
});

test('rotation maths: the dashboard preview is upright and letterboxed, never turned', () => {
  const tall = decideLayout(1745, 859, 'portrait', true, true);
  assert.equal(tall.deg, 0);
  assert.equal(tall.height, 859);
  assert.equal(tall.width, Math.round(859 * 9 / 16));
  assert.equal(tall.top, 0);
  assert.equal(tall.left, Math.round((1745 - tall.width) / 2));

  const wide = decideLayout(800, 1200, 'landscape', false, true);
  assert.equal(wide.deg, 0);
  assert.equal(wide.width, 800);
  assert.equal(wide.height, 450);
});

test('a TV reporting a tall viewport starts as portrait; others follow the usual choice', async () => {
  const tall = await register({ screenSize: '1080x1920' });
  assert.equal(tall.json.orientation, 'portrait');
  assert.equal(tall.json.flip, false);

  const wide = await register({ screenSize: '1920x1080' });
  assert.equal(wide.json.orientation, 'landscape');

  // once the owner's usual choice is portrait, new landscape-reporting TVs start there too
  assert.equal((await request(srv.base, 'PUT', '/api/settings', admin({ body: { defaultOrientation: 'portrait' } }))).status, 200);
  const next = await register({ screenSize: '1920x1080' });
  assert.equal(next.json.orientation, 'portrait');
  await request(srv.base, 'PUT', '/api/settings', admin({ body: { defaultOrientation: 'landscape' } }));
});

test('pairing records the orientation and remembers it for the next TV', async () => {
  const reg = await register({ screenSize: '1920x1080' });
  const claim = await request(srv.base, 'POST', '/api/screens/claim', admin({ body: { code: reg.json.code, name: 'Lobby', orientation: 'portrait' } }));
  assert.equal(claim.status, 200);
  assert.equal(claim.json.orientation, 'portrait');
  assert.equal((await configOf(reg.json.screenId)).orientation, 'portrait');

  const state = await request(srv.base, 'GET', '/api/state', admin());
  assert.equal(state.json.settings.defaultOrientation, 'portrait');
  await request(srv.base, 'PUT', '/api/settings', admin({ body: { defaultOrientation: 'landscape' } }));
});

test('orientation and flip can be changed; nonsense is ignored', async () => {
  const reg = await register({ screenSize: '1920x1080' });
  const id = reg.json.screenId;
  await request(srv.base, 'POST', '/api/screens/claim', admin({ body: { code: reg.json.code, name: 'Hall', orientation: 'landscape' } }));

  let r = await request(srv.base, 'PUT', '/api/screens/' + id, admin({ body: { orientation: 'portrait', flip: true } }));
  assert.equal(r.json.orientation, 'portrait');
  assert.equal(r.json.flip, true);

  r = await request(srv.base, 'PUT', '/api/screens/' + id, admin({ body: { orientation: 'diagonal' } }));
  assert.equal(r.json.orientation, 'portrait');

  const cfg = await configOf(id);
  assert.equal(cfg.orientation, 'portrait');
  assert.equal(cfg.flip, true);
});

test('portrait uses a thinner bar; the landscape layout is unchanged', async () => {
  const reg = await register({ screenSize: '1920x1080' });
  const id = reg.json.screenId;
  await request(srv.base, 'POST', '/api/screens/claim', admin({ body: { code: reg.json.code, name: 'Bar', orientation: 'landscape' } }));
  await request(srv.base, 'PUT', '/api/screens/' + id, admin({ body: { style: 'ticker', clock: true, ticker: 'hello' } }));

  const wide = await configOf(id);
  assert.deepEqual([zone(wide, 'playlist').h, zone(wide, 'ticker').y, zone(wide, 'ticker').h, zone(wide, 'ticker').w], [90, 90, 10, 80]);
  assert.deepEqual([zone(wide, 'clock').x, zone(wide, 'clock').w], [80, 20]);

  await request(srv.base, 'PUT', '/api/screens/' + id, admin({ body: { orientation: 'portrait' } }));
  const tall = await configOf(id);
  assert.equal(zone(tall, 'playlist').h + zone(tall, 'ticker').h, 100);
  assert.ok(zone(tall, 'ticker').h < 10, 'portrait bar is thinner than the landscape one');
  assert.equal(zone(tall, 'ticker').y, zone(tall, 'playlist').h);
  assert.equal(zone(tall, 'ticker').w + zone(tall, 'clock').w, 100);
  // every zone stays on the screen
  for (const z of tall.zones) { assert.ok(z.x >= 0 && z.y >= 0 && z.x + z.w <= 100 && z.y + z.h <= 100, JSON.stringify(z)); }
  // text is sized from the zone, not the viewport, so it survives being turned
  assert.ok(zone(tall, 'ticker').fontScale > 0 && zone(tall, 'clock').fontScale > 0);

  await request(srv.base, 'PUT', '/api/screens/' + id, admin({ body: { style: 'full' } }));
  const full = await configOf(id);
  assert.equal(zone(full, 'playlist').h, 100);
  const c = zone(full, 'clock');
  assert.ok(c.x + c.w <= 100 && c.y + c.h <= 100);
});

test('changing orientation changes the config version, so the TV re-renders', async () => {
  const reg = await register({ screenSize: '1920x1080' });
  const id = reg.json.screenId;
  await request(srv.base, 'POST', '/api/screens/claim', admin({ body: { code: reg.json.code, name: 'V', orientation: 'landscape' } }));
  const a = await configOf(id);
  await request(srv.base, 'PUT', '/api/screens/' + id, admin({ body: { orientation: 'portrait' } }));
  const b = await configOf(id);
  await request(srv.base, 'PUT', '/api/screens/' + id, admin({ body: { flip: true } }));
  const c = await configOf(id);
  assert.notEqual(a.version, b.version);
  assert.notEqual(b.version, c.version);
});

test('the layout script is public like the rest of the player', async () => {
  assert.equal((await request(srv.base, 'GET', '/player-layout.js')).status, 200);
});
