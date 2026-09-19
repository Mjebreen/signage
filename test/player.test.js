// The player's playlist logic, run on a simulated TV (test/player-sim.js).
//
// "VVIDEO" is the one shared, un-turned <video> that plays a pre-turned copy behind the
// page; "page" is a <video> inside the turned page. A TV has one hardware decoder, so at
// no point may two video elements hold a source for long.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fakeTv } = require('./player-sim');

const TURNED = { 270: '/media/turned/270_v.mp4', 90: '/media/turned/90_v.mp4' };
const video = (id, turned) => Object.assign({ id, type: 'video', name: id, src: '/media/' + id + '.mp4', duration: 0 }, turned ? { turned } : {});
const photo = id => ({ id, type: 'image', name: id, src: '/media/' + id + '.jpg', duration: 10 });
const startedAfter = (tv, t) => tv.plays.filter(p => p[0] >= t && p[2] === 'canplay').map(p => p[1]);

test('a portrait screen plays the turned copy behind the page, a landscape one plays inside it', () => {
  const tall = fakeTv({ items: [video('v', TURNED), photo('p')] });
  tall.advance(40000);
  assert.deepEqual(startedAfter(tall, 0), ['VVIDEO', 'VVIDEO', 'VVIDEO']);
  assert.ok(tall.plays.every(p => p[3] === TURNED[270]), 'the copy for the way this TV is turned');

  const wide = fakeTv({ items: [video('v', TURNED), photo('p')], orientation: 'landscape' });
  wide.advance(40000);
  assert.ok(startedAfter(wide, 0).length >= 2);
  assert.ok(wide.plays.every(p => p[1] === 'page' && p[3] === '/media/v.mp4'), 'nothing is turned, so the original plays');
});

test('one looping video switches to its turned copy as soon as the copy is ready', () => {
  const tv = fakeTv({ items: [video('v')] }); // the transcode has not finished yet
  tv.advance(20000);
  assert.deepEqual(startedAfter(tv, 0), ['page']);

  tv.env.items = [video('v', TURNED)]; // same config version: only the addresses were added
  tv.push({ type: 'reload' });
  tv.advance(5000);
  assert.deepEqual(startedAfter(tv, 0), ['page', 'VVIDEO']);
  assert.deepEqual(tv.holding().map(v => v.id), ['vvideo'], 'the in-page video let go of its decoder');
  assert.equal(tv.vbox.style.display, 'block');

  // further polls with nothing new do not restart it
  const count = tv.plays.length;
  tv.push({ type: 'reload' }); tv.advance(130000);
  assert.equal(tv.plays.length, count);
});

test('never two decoders: in-page video, then a turned copy, then a photo', () => {
  const tv = fakeTv({ items: [video('a'), video('v', TURNED), photo('p')] });
  let most = 0;
  for (let i = 0; i < 600; i++) { tv.advance(100); most = Math.max(most, tv.holding().filter(v => !v.paused).length); }
  assert.equal(most, 1);
  assert.ok(startedAfter(tv, 0).includes('page') && startedAfter(tv, 0).includes('VVIDEO'));
});

test('a video given up on after 30 s is unloaded, not left loading out of sight', () => {
  // only the very first load is slow: it would reach "canplay" at 45 s, long after the give-up
  let first = true;
  const tv = fakeTv({ items: [video('a')], orientation: 'landscape', loadDelay: () => { if (first) { first = false; return 45000; } return 5000; } });
  tv.advance(60000);
  const held = tv.holding();
  assert.equal(held.length, 1, held.length + ' video elements hold a source');
  assert.equal(held[0].paused, false);
});

test('a video that is always slow does not pile up one decoder per attempt', () => {
  const tv = fakeTv({ items: [video('a')], orientation: 'landscape', loadDelay: () => 45000 });
  tv.advance(300000);
  assert.ok(tv.holding().length <= 1, tv.holding().length + ' video elements hold a source after 5 minutes');
});

test('an abandoned video does not come back to life next to a later one', () => {
  const tv = fakeTv({ items: [video('a'), photo('p'), video('b')], orientation: 'landscape', loadDelay: src => (/a\.mp4/.test(src) ? 45000 : 2000) });
  tv.advance(48000); // a is given up at 30 s, then the photo, then b; a would have reached canplay at 45 s
  assert.deepEqual(tv.holding().map(v => v.src), ['/media/b.mp4']);
});

for (const socketNotices of [true, false]) {
  test('after a 45 s outage the turned copy is used again (socket ' + (socketNotices ? 'closes' : 'does not notice') + ')', () => {
    const tv = fakeTv({ items: [video('v', TURNED), photo('p')] });
    tv.advance(40000);
    tv.outage(45000, socketNotices);
    const back = tv.now();
    tv.advance(300000);
    const later = startedAfter(tv, back + 60000); // the first minute may still be catching up
    assert.ok(later.length > 5);
    assert.deepEqual(later.filter(w => w !== 'VVIDEO'), [], 'video is still playing inside the turned page');
  });
}

test('one looping video goes back to the turned copy after an outage', () => {
  const tv = fakeTv({ items: [video('v', TURNED)] });
  tv.advance(20000);
  tv.env.up = false;
  tv.vvideo.onerror(); // a big looping file breaks part-way once the server has gone
  tv.outage(8000, false);
  const back = tv.now();
  tv.advance(120000);
  const later = startedAfter(tv, back);
  assert.equal(later[later.length - 1], 'VVIDEO', 'the single video is left looping inside the turned page');
});

test('a TV that cannot play the copy falls back to the page, and a reconnect costs it one try only', () => {
  const tv = fakeTv({ items: [video('v', TURNED), photo('p')] });
  tv.env.copyBroken = true;
  tv.advance(120000);
  const before = tv.plays.filter(p => p[1] === 'VVIDEO').length;
  assert.equal(before, 2, 'two failures, then inside the page');
  assert.ok(startedAfter(tv, 0).length >= 5 && startedAfter(tv, 0).every(w => w === 'page'));
  tv.outage(20000, true);
  tv.advance(180000);
  assert.equal(tv.plays.filter(p => p[1] === 'VVIDEO').length - before, 1, 'one more try after the reconnect, not two');
  assert.equal(startedAfter(tv, tv.now() - 60000).every(w => w === 'page'), true);
});

test('the cached config is only rewritten when something changed', () => {
  const tv = fakeTv({ items: [video('v', TURNED), photo('p')] });
  tv.advance(5000);
  let writes = 0;
  const real = tv.stored['signage.config'];
  Object.defineProperty(tv.stored, 'signage.config', { get: () => real, set() { writes++; }, configurable: true });
  tv.push({ type: 'reload' }); tv.advance(200000); // several polls, same config
  assert.equal(writes, 0);
});
