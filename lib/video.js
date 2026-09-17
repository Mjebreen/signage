// Pre-turned copies of videos, for TVs hung on their side.
//
// A TV on its side still renders a landscape page, so the player turns its own
// picture with CSS. Photos, text and web pages turn fine. Video is the weak
// point: TVs decode it in hardware on a separate plane that may ignore CSS, so
// a turned page can show the video sideways or black. Nobody documents which
// Samsung model years are affected, so the player never relies on it: for a
// turned screen the server makes a copy of each video with the turn baked into
// the pixels (ffmpeg), and the player shows that copy in a plain, untransformed
// <video>. Without ffmpeg nothing breaks; the player just falls back to CSS.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Which way to bake the turn for each CSS rotation the player may apply.
// transpose=2 is 90 degrees counter-clockwise, transpose=1 is 90 degrees clockwise.
const TRANSPOSE = { 270: '2', 90: '1' };
// Both directions are always made, so correcting an upside-down TV never makes
// its videos disappear while new copies are prepared.
const DEGREES = [270, 90];
// After the turn: cap the LONG side at 1920 (a turned 4K clip would otherwise come out
// 2160x3840, which no TV decodes), never upscale, keep both sides even.
const SCALE = "scale=w='if(gte(iw,ih),min(1920,trunc(iw/2)*2),-2)':h='if(gte(iw,ih),-2,min(1920,trunc(ih/2)*2))'";

function createVideoTurner(options) {
  const mediaDir = options.mediaDir;
  const outDir = path.join(mediaDir, 'turned');
  const onReady = options.onReady || function () {};
  const log = options.log || function () {};
  const command = process.env.FFMPEG_PATH || 'ffmpeg';
  let prefixArgs = [];
  try { prefixArgs = JSON.parse(process.env.FFMPEG_PREFIX_ARGS || '[]'); } catch (e) { prefixArgs = []; }

  let available = null;      // null until probed
  let running = null;        // { file, deg, child, cancelled }
  // -fpsmax caps the frame rate without touching 24/25 fps material, but needs ffmpeg 4.3.
  // An older build says so once, and from then on gets the plain fps filter instead.
  let fpsCapOption = true;
  const queue = [];          // [{ file, deg }]
  const failed = new Set();  // "deg:file", until the next restart

  const keyOf = (file, deg) => deg + ':' + file;
  const outName = (file, deg) => deg + '_' + path.basename(file, path.extname(file)) + '.mp4';
  const outPath = (file, deg) => path.join(outDir, outName(file, deg));
  const urlFor = (file, deg) => '/media/turned/' + encodeURIComponent(outName(file, deg));

  function isReady(file, deg) {
    try { return fs.statSync(outPath(file, deg)).size > 0; } catch (e) { return false; }
  }

  // { "270": url, "90": url } for the copies that exist, or null.
  function turnedUrls(file) {
    const urls = {};
    let any = false;
    for (const deg of DEGREES) if (isReady(file, deg)) { urls[deg] = urlFor(file, deg); any = true; }
    return any ? urls : null;
  }

  function status(file) {
    const busy = (running && running.file === file) || queue.some(j => j.file === file);
    const bad = DEGREES.some(deg => failed.has(keyOf(file, deg)));
    const done = DEGREES.every(deg => isReady(file, deg));
    return { turning: busy, turnFailed: !busy && bad && !done, turned: done };
  }

  function probe(done) {
    let settled = false;
    const finish = ok => { if (settled) return; settled = true; available = ok; if (done) done(ok); pump(); };
    let child;
    try { child = spawn(command, prefixArgs.concat(['-version']), { stdio: 'ignore' }); } catch (e) { finish(false); return; }
    child.on('error', () => finish(false));
    child.on('exit', code => finish(code === 0));
  }

  function ensure(file) {
    if (available === false || !file) return;
    for (const deg of DEGREES) {
      const queued = (running && running.file === file && running.deg === deg) || queue.some(j => j.file === file && j.deg === deg);
      if (!queued && !isReady(file, deg) && !failed.has(keyOf(file, deg))) queue.push({ file, deg });
    }
    pump();
  }

  // One job at a time: a signage server is often a small box that is also streaming to TVs.
  function pump() {
    if (running || available !== true || queue.length === 0) return;
    const job = running = queue.shift();
    const input = path.join(mediaDir, job.file);
    const output = outPath(job.file, job.deg);
    const partial = output + '.part';
    fs.mkdirSync(outDir, { recursive: true });
    const args = prefixArgs.concat([
      '-y', '-loglevel', 'error', '-i', input,
      // the picture only: subtitle or data tracks in a MOV/MKV would fail the mp4 mux
      '-map', '0:v:0', '-sn', '-dn',
      // turn, cap the size at what every TV decodes, plain 8-bit 4:2:0
      '-vf', 'transpose=' + TRANSPOSE[job.deg] + (fpsCapOption ? ',' : ',fps=30,') + SCALE + ',format=yuv420p',
    ], fpsCapOption ? ['-fpsmax', '30'] : [], [
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-profile:v', 'high', '-level', '4.1',
      '-an',                       // the player is always muted
      '-movflags', '+faststart',   // playable while it is still downloading
      '-f', 'mp4', partial,
    ]);
    let stderr = '';
    const finish = ok => {
      if (running !== job) return;
      running = null;
      if (job.cancelled) {
        // The video was deleted while its copy was being made: leave nothing behind, and
        // say nothing. On Windows ffmpeg held the original open, so the caller's delete
        // failed; the child has exited now, so it goes here.
        fs.unlink(partial, () => {}); fs.unlink(output, () => {}); fs.unlink(input, () => {});
        pump();
        return;
      }
      if (!ok && fpsCapOption && /fpsmax/i.test(stderr)) {
        fpsCapOption = false;
        fs.unlink(partial, () => {});
        queue.unshift({ file: job.file, deg: job.deg });
        pump();
        return;
      }
      if (ok) {
        try { fs.renameSync(partial, output); } catch (e) { ok = false; }
      }
      if (!ok) {
        failed.add(keyOf(job.file, job.deg));
        fs.unlink(partial, () => {});
        log('Could not prepare a turned copy of ' + job.file + ' (' + job.deg + ' degrees)' + (stderr ? ': ' + stderr.trim().split('\n').pop() : ''));
      }
      onReady(job.file, job.deg, ok);
      pump();
    };
    let child;
    try { child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { finish(false); return; }
    job.child = child;
    child.stderr.on('data', d => { if (stderr.length < 4000) stderr += d; });
    child.on('error', () => finish(false));
    child.on('exit', code => {
      let size = 0;
      try { size = fs.statSync(partial).size; } catch (e) { /* no output */ }
      finish(code === 0 && size > 0);
    });
  }

  function remove(file) {
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].file === file) queue.splice(i, 1);
    if (running && running.file === file) {
      running.cancelled = true; // finish() clears up once the child has gone
      try { if (running.child) running.child.kill(); } catch (e) { /* already gone */ }
    }
    for (const deg of DEGREES) { failed.delete(keyOf(file, deg)); fs.unlink(outPath(file, deg), () => {}); }
  }

  // Copies stopped being wanted (last portrait screen gone, or turned off): drop what has
  // not started. The job in hand finishes; its copy is small and may be wanted again.
  function cancelQueued() { queue.length = 0; }

  // At start-up: half-written files from a crash, and copies of videos that no longer exist.
  function sweep(files) {
    const keep = new Set();
    for (const file of files) for (const deg of DEGREES) keep.add(outName(file, deg));
    let names = [];
    try { names = fs.readdirSync(outDir); } catch (e) { return; }
    for (const name of names) if (!keep.has(name)) fs.unlink(path.join(outDir, name), () => {});
  }

  return {
    probe, ensure, remove, cancelQueued, sweep, turnedUrls, status,
    isAvailable: () => available === true,
    pending: () => queue.length + (running ? 1 : 0),
  };
}

module.exports = { createVideoTurner, TRANSPOSE, DEGREES };
