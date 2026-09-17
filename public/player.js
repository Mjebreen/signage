/* Signage player. Written in plain ES5 on purpose: Samsung TV browsers run
   old Chromium/WebKit builds without arrow functions, fetch, or let/const. */
(function () {
  'use strict';

  var LS_ID = 'signage.screenId';
  var LS_CFG = 'signage.config';
  var stage = document.getElementById('stage');
  var pairEl = document.getElementById('pair');
  var codeEl = document.getElementById('code');
  var pairInfo = document.getElementById('pairinfo');
  var statusEl = document.getElementById('status');
  var errEl = document.getElementById('err');
  var rootEl = document.getElementById('root');
  var vboxEl = document.getElementById('vbox');
  var vvideo = document.getElementById('vvideo');
  var testEl = document.getElementById('testcard');
  // Sent to the server, which asks a TV still running an older script to reload.
  var PLAYER_VERSION = 2;

  var screenId = null;
  var config = null;
  var ws = null;
  var wsRetry = 1000;
  var pollTimer = null;
  var zoneStates = [];
  var startedAt = Date.now();
  var preview = false;

  // ---------- small utils ----------
  function qs(name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
  }
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) {} }
  function xhr(method, url, body, cb) {
    var r = new XMLHttpRequest();
    r.open(method, url, true);
    r.setRequestHeader('Content-Type', 'application/json');
    r.onreadystatechange = function () {
      if (r.readyState !== 4) return;
      if (r.status >= 200 && r.status < 300) {
        var data = null; try { data = JSON.parse(r.responseText); } catch (e) {}
        cb(null, data, r.status);
      } else cb(new Error('HTTP ' + r.status), null, r.status);
    };
    r.onerror = function () { cb(new Error('network'), null, 0); };
    try { r.send(body ? JSON.stringify(body) : null); } catch (e) { cb(e, null, 0); }
  }
  function showErr(text) {
    if (!text) { errEl.style.display = 'none'; return; }
    errEl.textContent = text; errEl.style.display = 'block';
  }
  function setOnline(on) { statusEl.className = on ? '' : 'off'; }
  var raf = window.requestAnimationFrame || window.webkitRequestAnimationFrame || function (f) { return setTimeout(function () { f(Date.now()); }, 16); };
  var caf = window.cancelAnimationFrame || window.webkitCancelAnimationFrame || clearTimeout;
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // ---------- orientation ----------
  // Most screens are mounted on their side, and a TV on its side still renders a
  // landscape page. So everything is laid out inside #root in the orientation a
  // person should SEE, and #root is turned to match the viewport the TV really
  // has. The maths lives in player-layout.js so it can be unit-tested.
  var lastBox = '';
  var curBox = null, viewW = 0, viewH = 0; // the layout in force, for placing the turned video
  function layout() {
    if (!rootEl || !window.SignageLayout) return false; // keep the CSS fallback
    var W = window.innerWidth || document.documentElement.clientWidth || 1920;
    var H = window.innerHeight || document.documentElement.clientHeight || 1080;
    var want = config && config.orientation === 'portrait' ? 'portrait' : 'landscape';
    var box = window.SignageLayout.decideLayout(W, H, want, !!(config && config.flip), preview);
    curBox = box; viewW = W; viewH = H;
    var key = [box.width, box.height, box.left, box.top, box.deg].join(',');
    if (key === lastBox) return false;
    lastBox = key;
    var turn = box.transform; // exact integer matrix about the top-left corner
    rootEl.style.width = box.width + 'px';
    rootEl.style.height = box.height + 'px';
    rootEl.style.left = box.left + 'px';
    rootEl.style.top = box.top + 'px';
    rootEl.style.webkitTransform = turn;
    rootEl.style.transform = turn;
    rootEl.style.fontSize = box.unit + 'px'; // 1em = 1% of the logical short side
    return true;
  }
  // Text in a bar is sized from the bar itself, never from the viewport: vh would
  // measure the wrong side once the picture is turned.
  function zoneFont(st) {
    return Math.max(8, Math.round((st.el.offsetHeight || 0) * (st.zone.fontScale || 0.4)));
  }

  // ---------- registration / config ----------
  function register() {
    var body = { screenId: screenId, screenSize: window.innerWidth + 'x' + window.innerHeight, playerVersion: PLAYER_VERSION, preview: preview };
    xhr('POST', '/api/player/register', body, function (err, cfg) {
      if (err || !cfg) {
        setOnline(false);
        var cached = lsGet(LS_CFG);
        if (cached && !config) { try { applyConfig(JSON.parse(cached)); } catch (e) {} }
        showErr('Cannot reach server. Retrying...');
        setTimeout(register, 5000);
        return;
      }
      showErr(null); setOnline(true);
      if (cfg.screenId !== screenId) { screenId = cfg.screenId; if (!preview) lsSet(LS_ID, screenId); }
      applyConfig(cfg);
      connectWs();
      schedulePoll();
    });
  }

  function fetchConfig() {
    if (!screenId) return;
    xhr('GET', '/api/player/' + encodeURIComponent(screenId) + '/config', null, function (err, cfg, status) {
      if (status === 404) { // screen was deleted on the server
        lsDel(LS_ID); lsDel(LS_CFG); screenId = null; config = null;
        window.location.reload(); return;
      }
      if (err || !cfg) { setOnline(false); return; }
      setOnline(true); showErr(null);
      applyConfig(cfg);
    });
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    var ms = (config && config.paired) ? 60000 : 5000;
    pollTimer = setTimeout(function () { fetchConfig(); schedulePoll(); }, ms);
  }

  function applyConfig(cfg) {
    if (!cfg.paired) {
      pairEl.style.display = 'block';
      codeEl.textContent = cfg.code || '------';
      pairInfo.textContent = 'Dashboard: ' + window.location.protocol + '//' + window.location.host + '/    Screen id: ' + cfg.screenId;
      if (config && config.version === cfg.version) return;
      config = cfg; layout(); teardown();
      return;
    }
    pairEl.style.display = 'none';
    if (config && config.version === cfg.version) { patchTurned(cfg); return; }
    config = cfg;
    lsSet(LS_CFG, JSON.stringify(cfg));
    layout();
    render();
  }

  // Same screen, but a turned copy of a video may have become ready on the server. Take
  // the new addresses in place: the next time that video comes round it uses the copy,
  // and the playlist is not restarted.
  function patchTurned(cfg) {
    if (!config || !config.zones || !cfg.zones) return;
    for (var i = 0; i < cfg.zones.length && i < config.zones.length; i++) {
      var fresh = cfg.zones[i].items || [], live = config.zones[i].items || [];
      for (var j = 0; j < fresh.length && j < live.length; j++) {
        if (fresh[j].id === live[j].id) live[j].turned = fresh[j].turned;
      }
    }
    lsSet(LS_CFG, JSON.stringify(config));
  }

  // ---------- websocket ----------
  function connectWs() {
    if (ws || !screenId) return;
    var proto = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    try { ws = new WebSocket(proto + window.location.host + '/ws?screen=' + encodeURIComponent(screenId) + '&pv=' + PLAYER_VERSION + (preview ? '&preview=1' : '')); }
    catch (e) { ws = null; return; }
    var pingTimer = null;
    ws.onopen = function () {
      wsRetry = 1000; setOnline(true);
      pingTimer = setInterval(function () {
        try { ws.send(JSON.stringify({ type: 'ping', version: config ? config.version : null })); } catch (e) {}
      }, 15000);
    };
    ws.onmessage = function (ev) {
      var msg = {}; try { msg = JSON.parse(ev.data); } catch (e) {}
      if (msg.type === 'reload') fetchConfig();
      else if (msg.type === 'hardReload') window.location.reload();
      else if (msg.type === 'unpaired') { lsDel(LS_ID); lsDel(LS_CFG); window.location.reload(); }
      else if (msg.type === 'identify') showTestCard(60000);
    };
    ws.onclose = function () {
      clearInterval(pingTimer); ws = null; setOnline(false);
      setTimeout(connectWs, wsRetry);
      wsRetry = Math.min(wsRetry * 2, 30000);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  // ---------- turned video ----------
  // The address of a pre-turned copy of this video, if the picture is being turned and
  // the server has one for that direction. Otherwise null: play it inside the page.
  function turnedCopy(item) {
    if (preview || !curBox || !vvideo || !window.SignageLayout.physicalRect) return null;
    if (curBox.deg !== 90 && curBox.deg !== 270) return null;
    return (item.turned && item.turned[curBox.deg]) || null;
  }

  function clearVideoEl() {
    vvideo.oncanplay = vvideo.onended = vvideo.onerror = vvideo.onstalled = null;
    try { vvideo.pause(); vvideo.removeAttribute('src'); vvideo.load(); } catch (e) {}
  }

  // Stop the behind-the-page video right now and make the photo area solid again.
  function stopTurnedNow(st) {
    if (st) { st.turnedActive = false; if (st.cover) st.cover.style.opacity = '1'; }
    if (!vvideo) return;
    clearVideoEl();
    vboxEl.style.display = 'none';
  }

  // ...or after the crossfade that is covering it has finished.
  function releaseTurned(st, delay) {
    st.turnedActive = false;
    setTimeout(function () { if (!st.turnedActive) { clearVideoEl(); vboxEl.style.display = 'none'; } }, delay);
  }

  function playTurned(st, item, src, single, done, after) {
    var r = window.SignageLayout.physicalRect(curBox, viewW, viewH, st.el.offsetLeft, st.el.offsetTop, st.el.offsetWidth, st.el.offsetHeight);
    vboxEl.style.left = r.left + 'px'; vboxEl.style.top = r.top + 'px';
    vboxEl.style.width = r.width + 'px'; vboxEl.style.height = r.height + 'px';
    vboxEl.style.display = 'block';
    var started = false, finished = false;
    function begin() {
      vvideo.loop = !!single;
      vvideo.oncanplay = function () {
        if (started) return; started = true;
        try { var p = vvideo.play(); if (p && p['catch']) p['catch'](function () {}); } catch (e) {}
        // Fade the page away over the video: the old photo out, the black backing out.
        var old = st.current; st.current = null;
        if (old) { old.className = 'layer'; setTimeout(function () { if (old.parentNode) old.parentNode.removeChild(old); }, 700); }
        st.cover.style.opacity = '0';
        if (item.duration > 0 && !single) after(item.duration);
      };
      vvideo.onended = function () { if (!finished && !single) { finished = true; done(); } };
      vvideo.onerror = function () { if (!finished) { finished = true; after(3); } };
      vvideo.onstalled = function () { try { vvideo.play(); } catch (e) {} };
      vvideo.src = src;
      try { vvideo.load(); } catch (e) {}
      setTimeout(function () { if (!started && !finished) { finished = true; after(1); } }, 30000);
    }
    if (st.turnedActive) {
      // video to video: through black, because only one decoder may run at a time
      st.cover.style.opacity = '1';
      setTimeout(begin, 350);
    } else { st.turnedActive = true; begin(); }
  }

  // ---------- test card ----------
  // Shows which edge the player thinks is the top and what the TV reports. Asked for
  // from the dashboard ("Identify"), or by opening /player?test=1.
  var testTimer = null;
  function showTestCard(ms) {
    if (!testEl) return;
    var chrome = /Chrom(?:e|ium)\/(\d+)/.exec(navigator.userAgent);
    testEl.innerHTML = '<b>&#9650; TOP &#9650;</b>' + escapeHtml((config && config.name) || 'This screen') +
      '<br>TV reports ' + window.innerWidth + 'x' + window.innerHeight + ' &middot; turned ' + (curBox ? curBox.deg : 0) + '&deg;' +
      (chrome ? ' &middot; Chrome ' + chrome[1] : '');
    testEl.style.display = 'block';
    clearTimeout(testTimer);
    if (ms > 0) testTimer = setTimeout(function () { testEl.style.display = 'none'; }, ms);
  }

  // ---------- rendering ----------
  function teardown() {
    stopTurnedNow(null);
    for (var i = 0; i < zoneStates.length; i++) {
      var st = zoneStates[i];
      if (st.timer) clearTimeout(st.timer);
      if (st.interval) clearInterval(st.interval);
      if (st.raf) caf(st.raf);
      if (st.video) { try { st.video.pause(); st.video.removeAttribute('src'); st.video.load(); } catch (e) {} }
    }
    zoneStates = [];
    stage.innerHTML = '';
  }

  function render() {
    teardown();
    // While the picture is turned the stage is see-through, so the behind-the-page video
    // can show; each photo area has its own black backing (.cover) instead.
    var turned = !preview && curBox && (curBox.deg === 90 || curBox.deg === 270);
    stage.style.background = turned ? 'transparent' : ((config.layout && config.layout.background) || '#000');
    if (!config.layout) {
      stage.innerHTML = '<div class="msg">Paired as "' + escapeHtml(config.name || '') + '".<br>Assign a layout in the dashboard.</div>';
      return;
    }
    for (var i = 0; i < config.zones.length; i++) {
      var z = config.zones[i];
      var el = document.createElement('div');
      el.className = 'zone zone-' + z.type;
      el.style.left = z.x + '%'; el.style.top = z.y + '%';
      el.style.width = z.w + '%'; el.style.height = z.h + '%';
      if (z.background) el.style.background = z.background;
      stage.appendChild(el);
      var st = { zone: z, el: el, index: -1, timer: null, interval: null, raf: null, current: null, video: null };
      zoneStates.push(st);
      if (z.type === 'playlist') startPlaylist(st);
      else if (z.type === 'ticker') startTicker(st);
      else if (z.type === 'clock') startClock(st);
    }
  }

  function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // --- playlist zone: crossfades between items, preloading each before showing it
  function startPlaylist(st) {
    var items = st.zone.items || [];
    st.cover = document.createElement('div');
    st.cover.className = 'cover';
    st.el.appendChild(st.cover);
    if (!items.length) {
      st.el.innerHTML = '<div class="msg">No playlist content</div>';
      return;
    }
    next(st);
  }

  function next(st) {
    var items = st.zone.items;
    st.index = (st.index + 1) % items.length;
    var item = items[st.index];
    var layer = document.createElement('div');
    layer.className = 'layer';
    var single = items.length === 1;

    var swapped = false;
    function swap() {
      if (swapped) return; swapped = true;
      st.el.appendChild(layer);
      // force a reflow so the transition runs
      void layer.offsetWidth;
      layer.className = 'layer show';
      var old = st.current;
      st.current = layer;
      // Coming off a behind-the-page video: bring the black backing up together with the
      // new layer, so the last video frame never shows in a photo's letterbox bars.
      if (st.turnedActive) { st.cover.style.opacity = '1'; releaseTurned(st, 700); }
      if (old) {
        old.className = 'layer';
        setTimeout(function () {
          var v = old.getElementsByTagName('video')[0];
          if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {} }
          if (old.parentNode) old.parentNode.removeChild(old);
        }, 700);
      }
    }
    function done() {
      if (single && item.type !== 'video') return; // one static item: leave it up
      if (st.timer) clearTimeout(st.timer);
      st.timer = setTimeout(function () { next(st); }, 50);
    }
    function after(sec) {
      if (st.timer) clearTimeout(st.timer);
      st.timer = setTimeout(function () { next(st); }, Math.max(1, sec) * 1000);
    }

    if (item.type === 'image') {
      var div = document.createElement('div');
      div.className = 'fill imgfill' + (st.zone.fit === 'cover' ? ' cover' : '');
      var img = new Image();
      var settled = false;
      img.onload = function () {
        if (settled) return; settled = true;
        div.style.backgroundImage = 'url("' + item.src + '")';
        swap(); if (!single) after(item.duration || 10);
      };
      img.onerror = function () { if (settled) return; settled = true; after(3); };
      img.src = item.src;
      layer.appendChild(div);
      setTimeout(function () { if (!settled) { settled = true; after(3); } }, 20000);
    } else if (item.type === 'video' && turnedCopy(item)) {
      playTurned(st, item, turnedCopy(item), single, done, after);
    } else if (item.type === 'video') {
      stopTurnedNow(st); // never two decoders at once
      var video = document.createElement('video');
      video.muted = true; video.defaultMuted = true;
      video.setAttribute('muted', ''); video.setAttribute('playsinline', ''); video.setAttribute('webkit-playsinline', '');
      video.autoplay = true; video.preload = 'auto';
      if (single) video.loop = true;
      video.src = item.src;
      var started = false, finished = false;
      video.oncanplay = function () {
        if (started) return; started = true;
        swap();
        try { var p = video.play(); if (p && p['catch']) p['catch'](function () {}); } catch (e) {}
        if (item.duration > 0 && !single) after(item.duration);
      };
      video.onended = function () { if (!finished && !single) { finished = true; done(); } };
      video.onerror = function () { if (!finished) { finished = true; after(3); } };
      video.onstalled = function () { try { video.play(); } catch (e) {} };
      st.video = video;
      layer.appendChild(video);
      try { video.load(); } catch (e) {}
      // if the video never becomes playable, move on
      setTimeout(function () { if (!started && !finished) { finished = true; after(1); } }, 30000);
    } else if (item.type === 'web') {
      var frame = document.createElement('iframe');
      frame.setAttribute('scrolling', 'no');
      frame.setAttribute('allow', 'autoplay');
      var loaded = false;
      frame.onload = function () { if (loaded) return; loaded = true; swap(); };
      frame.src = item.src;
      layer.appendChild(frame);
      setTimeout(function () { if (!loaded) { loaded = true; swap(); } }, 4000);
      if (!single) after(item.duration || 30);
    } else {
      after(1);
    }
  }

  // --- ticker zone: scrolls text right-to-left with requestAnimationFrame
  function startTicker(st) {
    var z = st.zone;
    st.el.className += ' ticker';
    st.el.style.background = z.background || '#111';
    st.el.style.color = z.color || '#fff';
    st.el.style.fontSize = zoneFont(st) + 'px';
    var span = document.createElement('span');
    var text = (z.text || '').replace(/\s+/g, ' ');
    span.textContent = text ? text + '      •      ' : '';
    st.el.appendChild(span);
    if (!text) return;
    var speed = Number(z.speed) || 80; // px per second
    var x = st.el.offsetWidth;
    var last = null;
    function step(t) {
      if (last === null) last = t;
      var dt = Math.min(100, t - last) / 1000; last = t;
      x -= speed * dt;
      var w = span.offsetWidth;
      if (x < -w) x = st.el.offsetWidth;
      span.style.webkitTransform = 'translate3d(' + x + 'px,-50%,0)';
      span.style.transform = 'translate3d(' + x + 'px,-50%,0)';
      st.raf = raf(step);
    }
    st.raf = raf(step);
  }

  // --- clock zone
  function startClock(st) {
    var z = st.zone;
    st.el.className += ' clock';
    st.el.style.background = z.background || '#111';
    st.el.style.color = z.color || '#fff';
    st.el.style.fontSize = zoneFont(st) + 'px';
    var timeEl = document.createElement('div'); timeEl.className = 'time';
    var dateEl = document.createElement('div'); dateEl.className = 'date';
    dateEl.style.fontSize = '0.45em';
    st.el.appendChild(timeEl);
    if (z.showDate !== false) st.el.appendChild(dateEl);
    var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var fmt = z.format || config.clockFormat || '24h';
    function tick() {
      var d = new Date();
      var h = d.getHours(), suffix = '';
      if (fmt === '12h') { suffix = h >= 12 ? ' PM' : ' AM'; h = h % 12; if (h === 0) h = 12; }
      timeEl.textContent = (fmt === '12h' ? h : pad(h)) + ':' + pad(d.getMinutes()) + (z.showSeconds ? ':' + pad(d.getSeconds()) : '') + suffix;
      dateEl.textContent = days[d.getDay()] + ', ' + d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
    }
    tick();
    st.interval = setInterval(tick, 1000);
  }

  // ---------- housekeeping ----------
  // TV browsers leak memory over days; reload once a day in the small hours.
  setInterval(function () {
    var h = new Date().getHours();
    if (Date.now() - startedAt > 20 * 3600 * 1000 && h === 4) window.location.reload();
  }, 60000);

  // The viewport can change under us (browser chrome hiding, a display switching its
  // own orientation). Lay out again, and redraw the zones if the box really changed.
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (layout() && config && config.paired) render(); }, 250);
  }, false);

  // Some TV remotes send keys; swallow them so nothing scrolls.
  document.addEventListener('keydown', function (e) { if (e.keyCode === 38 || e.keyCode === 40) e.preventDefault(); }, false);

  // ---------- boot ----------
  var forced = qs('screen');
  if (forced) { screenId = forced; preview = true; }
  else screenId = lsGet(LS_ID);
  var cached = lsGet(LS_CFG);
  if (cached && !preview) { try { var c = JSON.parse(cached); if (c.paired) applyConfig(c); } catch (e) {} }
  layout();
  if (qs('test')) showTestCard(0);
  register();
})();
