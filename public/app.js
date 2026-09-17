/* Dashboard. Runs on a normal PC browser, so modern JS is fine here. */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let state = { media: [], screens: [], settings: {} };
  let draft = null;        // screen being edited (a copy)
  let pairingOpen = false;
  let pairOrientation = 'landscape'; // choice in the "Add a TV" sheet
  let session = { authRequired: false, authenticated: true, viaTunnel: false, uploadLimitMb: null, publicUrl: null };
  let wsRetry = 2000;

  $('#playerUrl').textContent = location.host + '/player';
  $('#copyUrl').onclick = () => navigator.clipboard.writeText(location.origin + '/player').then(() => toast('Copied. Type this in the TV browser.'));

  // ---------- api ----------
  async function api(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(url, opts);
    if (r.status === 401) { location.href = '/login'; throw new Error('Login required'); }
    if (!r.ok) { let msg = 'HTTP ' + r.status; try { msg = (await r.json()).error || msg; } catch (e) {} throw new Error(msg); }
    return r.json();
  }
  async function load() { state = await api('GET', '/api/state'); render(); }
  function toast(msg, err) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : '');
    clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add('hidden'), 2600);
  }
  const run = (p, ok) => p.then(r => { if (ok) toast(ok); return r; }).catch(e => toast(e.message, true));

  function connectWs() {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?admin=1');
    let heartbeat = null;
    ws.onopen = () => {
      $('#conn').classList.add('on'); wsRetry = 2000;
      load().catch(() => {}); // catch up on anything missed while disconnected
      heartbeat = setInterval(() => { try { ws.send('{"type":"ping"}'); } catch (e) { /* closing */ } }, 15000);
    };
    ws.onmessage = e => { let m = {}; try { m = JSON.parse(e.data); } catch (x) { /* ignore */ } if (m.type !== 'pong') load().catch(() => {}); };
    ws.onclose = () => {
      clearInterval(heartbeat); $('#conn').classList.remove('on');
      api('GET', '/api/session').then(s => {
        // Session gone (logged out elsewhere, or expired): go to the login page
        // instead of retrying a handshake the server will keep refusing.
        if (s.authRequired && !s.authenticated) { location.href = '/login'; return; }
        setTimeout(connectWs, wsRetry);
      }).catch(() => {
        // Server or tunnel down: keep trying, backing off to 30 s.
        wsRetry = Math.min(wsRetry * 2, 30000);
        setTimeout(connectWs, wsRetry);
      });
    };
  }

  // ---------- nav ----------
  $$('.seg button').forEach(b => b.onclick = () => {
    $$('.seg button').forEach(x => x.classList.toggle('active', x === b));
    $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + b.dataset.page));
  });

  function render() {
    renderScreens(); renderLibrary();
    if (pairingOpen) renderSeenCodes();
  }

  // ---------- helpers ----------
  const media = id => state.media.find(m => m.id === id);
  const ago = ts => { if (!ts) return 'never seen'; const s = Math.round((Date.now() - ts) / 1000);
    return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; };
  const RISKY = /\.(avif|svg|webp|heic|heif|gif|mov|mkv|webm|avi)$/i;
  function picHtml(m) {
    if (!m) return '<div class="pic">?</div>';
    if (m.type === 'image') return `<div class="pic"><img src="${esc(m.src)}" loading="lazy" alt=""></div>`;
    if (m.type === 'video') return `<div class="pic"><video src="${esc(m.src)}" preload="metadata" muted></video></div>`;
    return `<div class="pic">🌐</div>`;
  }
  const nowClock = () => { const d = new Date(); let h = d.getHours(); const m = String(d.getMinutes()).padStart(2, '0');
    if (state.settings.clockFormat === '12h') { const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return h + ':' + m + ' ' + ap; } return String(h).padStart(2, '0') + ':' + m; };

  // Mini TV preview used on cards and in the editor
  function tvHtml(s, big) {
    const first = (s.items || []).map(media).find(m => m && m.type !== 'web');
    const style = s.style === 'ticker' ? 'ticker' : 'full';
    const n = (s.items || []).length;
    let main;
    if (!n) main = `<div class="empty">Nothing to show yet</div>`;
    else if (first && first.type === 'image') main = `<div class="main ${s.fit === 'cover' ? 'cover' : ''}" style="background-image:url('${esc(first.src)}')"></div>`;
    else main = `<div class="main empty">▶</div>`;
    const port = s.orientation === 'portrait';
    return `<div class="tvwrap ${big ? 'big' : ''} ${port ? 'portrait' : ''}"><div class="tv ${big ? 'big' : ''} ${style} ${port ? 'portrait' : ''} ${s.clock ? '' : 'noclock'}">
      ${main}
      ${n ? `<div class="count">${n} item${n === 1 ? '' : 's'}</div>` : ''}
      ${style === 'ticker' ? `<div class="bar">${esc(s.ticker || '')}</div>` : ''}
      ${s.clock ? `<div class="clk">${nowClock()}</div>` : ''}
    </div></div>`;
  }

  // The same two big buttons when pairing a TV and when editing one.
  const orientHtml = cur => `<div class="styles orient">
      <div class="style-opt ${cur === 'portrait' ? 'sel' : ''}" data-orient="portrait"><div class="ico port"><b></b></div>Portrait · 9:16</div>
      <div class="style-opt ${cur !== 'portrait' ? 'sel' : ''}" data-orient="landscape"><div class="ico land"><b></b></div>Landscape · 16:9</div>
    </div>`;
  const isTall = size => { const m = /^(\d+)x(\d+)$/.exec(size || ''); return !!m && Number(m[2]) > Number(m[1]); };
  function pickPairOrient(o) {
    pairOrientation = o;
    $$('#sheet .style-opt[data-orient]').forEach(x => x.classList.toggle('sel', x.dataset.orient === o));
  }

  // ================= SCREENS =================
  function renderScreens() {
    const root = $('#page-screens');
    const paired = state.screens.filter(s => s.paired);
    const online = paired.filter(s => s.online).length;
    root.innerHTML = `
      <div class="topline">
        <div><h1>Screens</h1><p class="sub">${paired.length ? `${online} of ${paired.length} online` : 'Add your first TV to get started.'}</p></div>
        <button class="btn" id="addTv">+ Add a TV</button>
      </div>
      <div class="grid">
        ${paired.map(s => `
          <div class="card screen" data-id="${s.id}">
            ${tvHtml(s)}
            <div class="body">
              <div class="title"><span>${esc(s.name)}</span><span class="status ${s.online ? 'on' : ''}">${s.online ? 'Online' : ago(s.lastSeen)}</span></div>
              <div class="muted" style="font-size:13px">${s.orientation === 'portrait' ? 'Portrait' : 'Landscape'} · ${(s.items || []).length} items · ${s.seconds}s each · ${s.style === 'ticker' ? 'Ticker bar' : 'Fullscreen'}${s.clock ? ' · Clock' : ''}</div>
            </div>
          </div>`).join('')}
        <div class="add-tv" id="addTv2">
          <div><div class="plus">+</div>Add a TV${unpairedCodes().length ? `<div class="codes">${unpairedCodes().map(c => `<span class="code-chip">${c}</span>`).join('')}</div><div style="font-size:12px;margin-top:6px">TVs waiting to be paired</div>` : ''}</div>
        </div>
      </div>`;
    $('#addTv').onclick = openPairing; $('#addTv2').onclick = openPairing;
    $$('.screen', root).forEach(el => el.onclick = () => openEditor(el.dataset.id));
  }
  const unpairedCodes = () => state.screens.filter(s => !s.paired && s.online).map(s => s.code);

  // ---------- pairing ----------
  function openPairing() {
    pairingOpen = true;
    pairOrientation = state.settings.defaultOrientation === 'portrait' ? 'portrait' : 'landscape';
    $('#sheet').innerHTML = `
      <div class="head"><h2 style="margin:0">Add a TV</h2><button class="close" id="closeSheet">✕</button></div>
      <ol class="steps">
        <li><div>On the Samsung TV open the <b>Internet</b> app and go to <code>${esc(location.host)}/player</code>.<br><span class="muted" style="font-size:13px">Tip: set it as the homepage so it comes back after a power cycle.</span></div></li>
        <li><div>The TV shows a 6-letter code. Type it here:</div></li>
      </ol>
      <input class="code-input" id="pairCode" maxlength="6" placeholder="ABC123" autocomplete="off">
      <div class="seen" id="seenCodes"></div>
      <div class="field"><label>Name this TV</label><input type="text" id="pairName" placeholder="Lobby, Reception, Cafeteria..."></div>
      <div class="field"><label>How is it mounted?</label>${orientHtml(pairOrientation)}</div>
      <div class="actions"><span class="spacer"></span><button class="btn" id="pairBtn">Pair TV</button></div>`;
    renderSeenCodes();
    $$('#sheet .style-opt[data-orient]').forEach(el => el.onclick = () => pickPairOrient(el.dataset.orient));
    $('#closeSheet').onclick = closeSheet;
    $('#pairCode').focus();
    $('#pairBtn').onclick = () => {
      const code = $('#pairCode').value.trim().toUpperCase();
      if (code.length !== 6) return toast('Enter the 6-letter code shown on the TV', true);
      run(api('POST', '/api/screens/claim', { code, name: $('#pairName').value.trim(), orientation: pairOrientation }), 'TV paired').then(s => { if (s) { closeSheet(); openEditor(s.id); } });
    };
    $('#modal').classList.remove('hidden');
  }
  function renderSeenCodes() {
    const el = $('#seenCodes'); if (!el) return;
    const codes = unpairedCodes();
    el.innerHTML = codes.length ? `<span class="muted" style="font-size:13px;align-self:center">Seen on the network:</span>` + codes.map(c => `<button data-c="${c}">${c}</button>`).join('') : '';
    $$('button', el).forEach(b => b.onclick = () => {
      $('#pairCode').value = b.dataset.c; $('#pairName').focus();
      // a display that already reports a tall picture is certainly portrait
      const seen = state.screens.find(x => x.code === b.dataset.c);
      if (seen && isTall(seen.screenSize)) pickPairOrient('portrait');
    });
  }
  function closeSheet() { $('#modal').classList.add('hidden'); draft = null; pairingOpen = false; }
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeSheet(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

  // ---------- editor ----------
  function openEditor(id) {
    const s = state.screens.find(x => x.id === id); if (!s) return;
    draft = JSON.parse(JSON.stringify(s));
    drawEditor();
    $('#modal').classList.remove('hidden');
  }

  function drawEditor() {
    const d = draft;
    const order = new Map(d.items.map((id, i) => [id, i + 1]));
    $('#sheet').innerHTML = `
      <div class="head"><input id="edName" value="${esc(d.name)}" placeholder="TV name"><button class="close" id="closeSheet">✕</button></div>
      <div class="cols">
        <div>
          <div id="preview">${tvHtml(d, true)}</div>
          <div class="field"><label>How is this TV mounted?</label>${orientHtml(d.orientation)}</div>
          <div class="field"><label>Style</label>
            <div class="styles">
              <div class="style-opt ${d.style !== 'ticker' ? 'sel' : ''}" data-style="full"><div class="ico"></div>Fullscreen</div>
              <div class="style-opt ${d.style === 'ticker' ? 'sel' : ''}" data-style="ticker"><div class="ico"><i></i></div>With ticker bar</div>
            </div>
          </div>
          <div class="toggles">
            <label class="toggle"><input type="checkbox" id="edClock" ${d.clock ? 'checked' : ''}> Show clock</label>
            <label class="toggle"><input type="checkbox" id="edFit" ${d.fit === 'cover' ? 'checked' : ''}> Fill the screen (crop photos)</label>
            <label class="toggle" title="For a TV that was hung the other way round"><input type="checkbox" id="edFlip" ${d.flip ? 'checked' : ''}> Picture upside down on the TV? Tick this</label>
          </div>
          <div class="field"><label>Seconds per photo</label>
            <div class="range"><input type="range" id="edSeconds" min="3" max="120" value="${d.seconds}"><output id="edSecondsOut">${d.seconds}s</output></div>
          </div>
          <div class="field ${d.style === 'ticker' ? '' : 'hidden'}" id="tickerField"><label>Ticker text</label>
            <input type="text" id="edTicker" value="${esc(d.ticker)}" placeholder="Welcome! Today's specials...">
          </div>
        </div>
        <div>
          <div class="picker-head"><h2 style="margin:0">Photos &amp; videos</h2><span class="hint">Click to add or remove. Numbers are the play order.</span></div>
          ${state.media.length ? `<div class="thumbs">${state.media.map(m => `
            <div class="thumb pick ${order.has(m.id) ? 'sel' : ''}" data-id="${m.id}">
              ${picHtml(m)}
              ${order.has(m.id) ? `<div class="num">${order.get(m.id)}</div>` : ''}
              <div class="name">${esc(m.name)}</div>
            </div>`).join('')}</div>` : `<div class="empty-state"><b>Library is empty</b>Upload photos in the Library tab first.</div>`}
        </div>
      </div>
      <div class="actions">
        <button class="btn" id="edSave">Save</button>
        <a class="btn ghost" href="/player?screen=${d.id}" target="_blank">Preview</a>
        <button class="btn ghost" id="edReload">Reload TV</button>
        <span class="spacer"></span>
        <button class="btn danger" id="edRemove">Remove TV</button>
      </div>`;

    const refresh = () => { $('#preview').innerHTML = tvHtml(d, true); };
    $('#closeSheet').onclick = closeSheet;
    $('#edName').oninput = e => { d.name = e.target.value; };
    $$('.style-opt[data-style]').forEach(el => el.onclick = () => { d.style = el.dataset.style; drawEditor(); });
    $$('.style-opt[data-orient]').forEach(el => el.onclick = () => { d.orientation = el.dataset.orient; drawEditor(); });
    $('#edFlip').onchange = e => { d.flip = e.target.checked; };
    $('#edClock').onchange = e => { d.clock = e.target.checked; refresh(); };
    $('#edFit').onchange = e => { d.fit = e.target.checked ? 'cover' : 'contain'; refresh(); };
    $('#edSeconds').oninput = e => { d.seconds = Number(e.target.value); $('#edSecondsOut').textContent = d.seconds + 's'; };
    const t = $('#edTicker'); if (t) t.oninput = e => { d.ticker = e.target.value; refresh(); };
    $$('.thumb.pick').forEach(el => el.onclick = () => {
      const id = el.dataset.id; const i = d.items.indexOf(id);
      if (i >= 0) d.items.splice(i, 1); else d.items.push(id);
      drawEditor();
    });
    // Point out photos and videos whose shape does not match the screen, once their size is known.
    const wantTall = d.orientation === 'portrait';
    $$('.thumb.pick').forEach(el => {
      const note = tall => {
        if (tall === wantTall || $('.fitnote', el)) return;
        const tip = (tall ? 'This one is tall and the screen is wide' : 'This one is wide and the screen is tall') +
          ', so it shows with black bars. Turn on "Fill the screen" to crop it instead.';
        el.insertAdjacentHTML('beforeend', `<span class="fitnote" title="${esc(tip)}">${tall ? 'tall' : 'wide'}</span>`);
      };
      const img = $('img', el), vid = $('video', el);
      if (img) { const f = () => { if (img.naturalWidth) note(img.naturalHeight > img.naturalWidth); }; if (img.complete) f(); else img.addEventListener('load', f); }
      else if (vid) { const f = () => { if (vid.videoWidth) note(vid.videoHeight > vid.videoWidth); }; if (vid.readyState >= 1) f(); else vid.addEventListener('loadedmetadata', f); }
    });
    $('#edSave').onclick = () => run(api('PUT', '/api/screens/' + d.id, { name: d.name, style: d.style, items: d.items, seconds: d.seconds, fit: d.fit, ticker: d.ticker, clock: d.clock, orientation: d.orientation, flip: !!d.flip }), 'Saved. The TV updates by itself.').then(closeSheet);
    $('#edReload').onclick = () => run(api('POST', '/api/screens/' + d.id + '/reload'), 'Reload sent');
    $('#edRemove').onclick = () => { if (confirm('Remove "' + d.name + '"? The TV will go back to showing a pairing code.')) run(api('DELETE', '/api/screens/' + d.id), 'TV removed').then(closeSheet); };
  }

  // ================= LIBRARY =================
  function renderLibrary() {
    const root = $('#page-library');
    root.innerHTML = `
      <div class="topline">
        <div><h1>Library</h1><p class="sub">${state.media.length ? state.media.length + ' items' : 'Photos and videos you can show on any screen.'}</p></div>
        <button class="btn ghost" id="webBtn">+ Add a web page</button>
      </div>
      <div class="drop" id="drop"><b>Drop photos or videos here</b>or click to choose files · JPG, PNG, MP4 work best on TVs · 1080×1920 for portrait screens, 1920×1080 for landscape${session.uploadLimitMb ? ` · up to ${session.uploadLimitMb} MB per file from outside the network` : ''}
        <div class="progress hidden" id="prog"><div></div></div></div>
      <input type="file" id="fileInput" multiple accept="image/*,video/*" class="hidden">
      <form id="webForm" class="card hidden" style="padding:16px;margin-bottom:22px;display:flex;gap:10px;align-items:end;flex-wrap:wrap">
        <div class="field" style="margin:0;flex:1"><label>Web page address</label><input type="text" name="url" placeholder="https://..." required></div>
        <div class="field" style="margin:0;flex:1"><label>Name</label><input type="text" name="name" placeholder="Weather"></div>
        <button class="btn">Add</button>
      </form>
      ${state.media.length ? `<div class="thumbs">${state.media.slice().reverse().map(m => `
        <div class="thumb" data-id="${m.id}">
          ${picHtml(m)}
          ${RISKY.test(m.name) ? '<span class="warn" title="Samsung TV browsers often cannot show this format. Use JPG, PNG or MP4.">may not play on TV</span>' : ''}
          ${m.type === 'web' && /^http:\/\//i.test(m.src) && (session.viaTunnel || /^https:/.test(session.publicUrl || '')) ? '<span class="warn" title="Browsers block http:// pages inside the https:// player. TVs that use the public address will show a blank page for this item; TVs on the LAN address are fine.">http only</span>' : ''}
          <button class="del" title="Delete">✕</button>
          <div class="name" title="${esc(m.name)}">${esc(m.name)}</div>
        </div>`).join('')}</div>` : `<div class="empty-state"><b>No photos yet</b>Drop some files above.</div>`}`;

    const drop = $('#drop'), fi = $('#fileInput');
    drop.onclick = () => fi.click();
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); uploadFiles(e.dataTransfer.files); };
    fi.onchange = () => uploadFiles(fi.files);
    $('#webBtn').onclick = () => $('#webForm').classList.toggle('hidden');
    $('#webForm').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); run(api('POST', '/api/media/web', { name: f.get('name'), url: f.get('url') }), 'Web page added'); };
    $$('.thumb .del', root).forEach(b => b.onclick = e => {
      e.stopPropagation(); const id = b.closest('.thumb').dataset.id; const m = media(id);
      if (confirm('Delete "' + m.name + '"? It is removed from every screen.')) run(api('DELETE', '/api/media/' + id), 'Deleted');
    });
  }

  function uploadFiles(files) {
    if (!files || !files.length) return;
    let list = Array.from(files);
    if (session.uploadLimitMb) {
      // Through the tunnel the proxy rejects big bodies; say so up front instead of failing mid-upload.
      const max = session.uploadLimitMb * 1024 * 1024;
      const big = list.filter(f => f.size > max);
      if (big.length) {
        toast(big.map(f => f.name).join(', ') + (big.length === 1 ? ' is' : ' are') + ' over ' + session.uploadLimitMb + ' MB. Upload large files from inside the network.', true);
        list = list.filter(f => f.size <= max);
        if (!list.length) return;
      }
    }
    const fd = new FormData(); list.forEach(f => fd.append('files', f));
    const prog = $('#prog'), bar = $('#prog div');
    prog.classList.remove('hidden'); bar.style.width = '0%';
    const x = new XMLHttpRequest();
    x.open('POST', '/api/media');
    x.upload.onprogress = e => { if (e.lengthComputable) bar.style.width = Math.round(e.loaded / e.total * 100) + '%'; };
    x.onload = () => { prog.classList.add('hidden'); x.status < 300 ? toast('Uploaded ' + list.length + ' file' + (list.length === 1 ? '' : 's')) : toast('Upload failed (' + x.status + ')', true); };
    x.onerror = () => { prog.classList.add('hidden'); toast('Upload failed', true); };
    x.send(fd);
  }

  // Keep clocks in previews ticking
  setInterval(() => $$('.tv .clk').forEach(el => { el.textContent = nowClock(); }), 15000);

  api('GET', '/api/session').then(s => {
    session = s;
    if (s.authRequired && !s.authenticated) { location.href = '/login'; return null; }
    if (s.authRequired) {
      const b = $('#logout'); b.classList.remove('hidden');
      b.onclick = () => api('POST', '/api/logout').then(() => { location.href = '/login'; });
    }
    return load().then(connectWs);
  }).catch(e => toast('Cannot load: ' + e.message, true));
})();
