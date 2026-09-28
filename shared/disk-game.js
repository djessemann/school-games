// Runs an Apple II game disk on a page with an on-screen controller.
// Shared by the disk games; each page supplies its deck markup and a small config:
//
//   DiskGame.start({
//     disk: 'game.dsk',            // disk image next to the page (or disks: ['side-a.dsk', 'side-b.dsk'] for two drives)
//     model: 'ii+',                // or 'iie' for games that need 128K
//     saveKey: 'game-disk',        // where changed sectors (high scores, saved games) are kept in the browser
//     patch(dsk) {},               // optional: change the disk before it boots
//     bigKey(m) { return { code: 13, label: 'OK' }; },   // what the big bar sends right now
//     rom: true,                   // load the real Apple II+ ROM (for games written in Applesoft BASIC)
//     namePrompt(m) { return false; },  // true while the game waits for a typed name,
//                                       // or { label: 'Type a name, then OK', max: 20 } to say more
//     nameEmptyOk: false,          // let OK send an empty answer (when the game fills in a default)
//     nameKeepCase: false,         // send lowercase as typed (for games with their own lowercase text)
//     onFrame(m) {},               // optional: per-frame hook, e.g. to switch deck layouts
//     speed(m) { return 1; },      // optional: run the machine faster for a while (fast-forward)
//   bigKey may also return { press(m) {} } to do something other than send a key.
//   });
//
// Deck markup: any .key with data-key="codes" (comma list) sends those keys; data-rep repeats while held;
// data-label is drawn in the Apple II font. #gamesKey goes back to the portal, #bigKey asks cfg.bigKey.
(function () {
  'use strict';
  const FONT = Uint8Array.from(atob(FONT_B64), c => c.charCodeAt(0));
  const CPS = 1023000;   // Apple II clock
  let cfg = null, m = null, origs = [];
  const keyQ = [];
  const send = (...codes) => { keyQ.push(...codes); };
  const $ = id => document.getElementById(id);

  // ---------- screen ----------
  const cv = $('screen'), cx = cv.getContext('2d');
  const off = document.createElement('canvas'); off.width = 280; off.height = 192;
  const offx = off.getContext('2d'), idata = offx.createImageData(280, 192);
  function layout() {
    const dpr = window.devicePixelRatio || 1;
    const wrap = $('screenwrap');
    const r = wrap.getBoundingClientRect();
    const bw = parseFloat(getComputedStyle(wrap).borderLeftWidth) * 2 || 0;
    const aw = Math.max(100, r.width - bw), ah = Math.max(80, r.height - bw);
    // device-pixel scale that fits; snap to a whole number when that costs little space
    let s = Math.min(aw * dpr / 280, ah * dpr / 192);
    if (s - Math.floor(s) < 0.2 && s >= 1) s = Math.floor(s);
    const W = Math.round(280 * s), H = Math.round(192 * s);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    cv.style.width = (W / dpr) + 'px'; cv.style.height = (H / dpr) + 'px';
    labelKeys();
  }

  // ---------- key labels, drawn in the Apple II font ----------
  function ink() { return getComputedStyle(document.documentElement).getPropertyValue('--key-ink').trim() || '#000'; }
  // a few extra glyphs for key labels: the diagonal arrows (rows top to bottom, bit 0 is the leftmost pixel)
  const UL = [0x0f, 0x07, 0x0f, 0x1d, 0x38, 0x70, 0x20, 0x00];
  const mirror = r => { let o = 0; for (let p = 0; p < 7; p++) if (r >> p & 1) o |= 1 << (6 - p); return o; };
  const EXTRA = { '\u2196': UL, '\u2197': UL.map(mirror), '\u2199': [...UL.slice(0, 7)].reverse().concat(0), '\u2198': [...UL.slice(0, 7)].reverse().map(mirror).concat(0) };
  const glyphRow = (ch, r) => EXTRA[ch] ? EXTRA[ch][r] : FONT[(ch.charCodeAt(0) - 32) * 8 + r];
  function glyphLabel(text, maxW) {
    const dpr = window.devicePixelRatio || 1;
    let k = Math.round(2 * dpr);
    if (maxW > 0) k = Math.max(1, Math.min(k, Math.floor(maxW * dpr / (text.length * 7))));
    const c = document.createElement('canvas');
    c.width = text.length * 7 * k; c.height = 8 * k;
    c.style.width = (c.width / dpr) + 'px'; c.style.height = (c.height / dpr) + 'px';
    const g = c.getContext('2d'); g.fillStyle = ink();
    [...text].forEach((ch, i) => {
      for (let r = 0; r < 8; r++) { const b = glyphRow(ch, r); for (let p = 0; p < 7; p++) if (b >> p & 1) g.fillRect((i * 7 + p) * k, r * k, k, k); }
    });
    return c;
  }
  function setLabel(b, text) {
    b.dataset.label = text;
    b.innerHTML = '';
    // keys in a shared row (data-row) or group (data-group) use one size: the largest that fits their longest label
    const row = b.closest('[data-row]');
    let maxW = b.clientWidth ? b.clientWidth - 16 : 0;
    if (row || b.dataset.group) {
      const keys = row ? [...row.querySelectorAll('.key')] : [...document.querySelectorAll(`.key[data-group="${b.dataset.group}"]`)];
      const longest = Math.max(...keys.map(k => k.dataset.label.length));
      const room = Math.min(...keys.map(k => k.clientWidth - 12));
      maxW = room * text.length / longest;
    }
    b.appendChild(glyphLabel(text, maxW));
  }
  function labelKeys() {
    for (const b of document.querySelectorAll('.key[data-label]')) if (b.offsetParent) setLabel(b, b.dataset.label);
    const nl = $('nameLabel');
    if (nl && nl.offsetParent) { nl.innerHTML = ''; nl.appendChild(glyphLabel(nameText, nl.clientWidth)); }
  }

  // ---------- saved disk changes (high scores) ----------
  const saveKeyFor = i => i ? cfg.saveKey + '-' + (i + 1) : cfg.saveKey;
  function saveDisk(dsk, i) {
    const changed = {}, base = origs[i];
    for (let s = 0; s < 560; s++) {
      const o = s * 256;
      for (let k = 0; k < 256; k++) if (dsk[o + k] !== base[o + k]) { changed[s] = btoa(String.fromCharCode(...dsk.subarray(o, o + 256))); break; }
    }
    try { localStorage.setItem(saveKeyFor(i), JSON.stringify(changed)); } catch (e) {}
  }
  function loadSaved(dsk, i) {
    try {
      const changed = JSON.parse(localStorage.getItem(saveKeyFor(i)) || '{}');
      for (const s in changed) dsk.set(Uint8Array.from(atob(changed[s]), c => c.charCodeAt(0)), s * 256);
    } catch (e) {}
  }

  // ---------- name entry: show a text box so the phone keyboard can type ----------
  const nameBox = $('nameBox'), nameInput = $('nameInput'), dmain = $('dmain');
  let typed = '', submitted = false, nameText = 'Type your name, then OK';
  function watchNamePrompt() {
    if (!nameBox) return;
    let asking = !m.halted && cfg.namePrompt && cfg.namePrompt(m);
    if (asking && nameBox.hidden && typeof asking === 'object') {
      nameText = asking.label || 'Type your name, then OK';
      if (asking.max) nameInput.maxLength = asking.max;
    }
    // after OK, the game can still be sitting in its name reader for a moment; don't reopen until it leaves
    if (!asking) submitted = false; else if (submitted) asking = false;
    if (asking && nameBox.hidden) { nameBox.hidden = false; dmain.hidden = true; nameInput.value = typed = ''; labelKeys(); }
    else if (!asking && !nameBox.hidden) closeName();
  }
  function closeName() { nameBox.hidden = true; dmain.hidden = false; nameInput.blur(); labelKeys(); }
  if (nameBox) {
    nameInput.addEventListener('input', () => {
      const v = (cfg.nameKeepCase ? nameInput.value : nameInput.value.toUpperCase()).replace(/[^ -~]/g, '');
      let i = 0; while (i < typed.length && i < v.length && typed[i] === v[i]) i++;
      for (let k = typed.length; k > i; k--) send(8);
      for (const ch of v.slice(i)) send(ch.charCodeAt(0));
      typed = v;
    });
    nameBox.addEventListener('submit', e => {
      e.preventDefault();
      if (!typed.trim() && !cfg.nameEmptyOk) { nameInput.focus(); return; }   // the game wants a name; keep the box open
      send(13); submitted = true; closeName();
    });
  }

  // ---------- the big bar ----------
  const bigKey = $('bigKey');
  function updateBigKey() {
    if (!bigKey) return;
    const label = m.halted ? 'OK' : cfg.bigKey(m).label;
    if (bigKey.dataset.label !== label) { setLabel(bigKey, label); bigKey.setAttribute('aria-label', label); }
  }

  // ---------- sound: the speaker is a 1-bit click; turn its toggles into samples ----------
  let actx = null, playAt = 0, level = 0.2, hpX = 0, hpY = 0;
  function startAudio() {
    if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) actx = new AC();
  }
  function playSpeaker(c0, c1) {
    const spk = m.spk;
    if (!actx || actx.state !== 'running') { m.spk = spk.filter(t => t >= c1); return; }
    const now = spk.filter(t => t < c1);
    m.spk = spk.filter(t => t >= c1);
    if (!now.length && Math.abs(hpY) < 0.001) return;
    const sr = actx.sampleRate, n = Math.max(1, Math.round((c1 - c0) / CPS * sr));
    const buf = actx.createBuffer(1, n, sr), d = buf.getChannelData(0);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const t = c0 + (i / sr) * CPS;
      while (j < now.length && now[j] <= t) { level = -level; j++; }
      // high-pass so a speaker left "on" fades to silence instead of a DC offset
      hpY = level - hpX + 0.995 * hpY; hpX = level; d[i] = hpY;
    }
    const t0 = actx.currentTime;
    if (playAt < t0 + 0.02 || playAt > t0 + 0.3) playAt = t0 + 0.06;
    const src = actx.createBufferSource(); src.buffer = buf; src.connect(actx.destination); src.start(playAt);
    playAt += n / sr;
  }

  // if the emulator hits something it can't do, say so and let OK restart the game
  let haltShown = false;
  function showHalt() {
    if (haltShown) return; haltShown = true;
    console.error('emulator stopped:', m.halted);
    m.text = true; m.mixed = false; m.page2 = false;
    const msg = ['', '', '', '', '', '', '', '', '', '   SORRY, THE GAME STOPPED WORKING.', '', '   PRESS OK TO START IT AGAIN.'];
    for (let a = 0x400; a < 0x800; a++) m.ram[a] = 0xa0;
    const row = r => 0x400 + (r & 7) * 0x80 + (r >> 3) * 0x28;
    msg.forEach((t, r) => [...t].forEach((ch, c) => { m.ram[row(r) + c] = ch.charCodeAt(0) | 0x80; }));
  }

  // ---------- main loop ----------
  let last = 0, flash = false, frames = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (!m) return;
    if (window.Portrait && Portrait.turned()) { last = 0; return; }   // phone on its side: paused behind the note
    const dt = last ? Math.min(100, now - last) : 16.7; last = now;
    if (keyQ.length && !(m.key & 0x80)) m.pressKey(keyQ.shift());
    const c0 = m.cpu.cycles, speed = cfg.speed ? cfg.speed(m) : 1;
    m.run(Math.round(dt * CPS / 1000 * speed));
    if (speed === 1) playSpeaker(c0, m.cpu.cycles); else m.spk.length = 0;   // fast-forward runs silent
    if (m.halted) showHalt();
    watchNamePrompt();
    if (cfg.onFrame && !m.halted) cfg.onFrame(m);
    updateBigKey();
    if (++frames % 16 === 0) flash = !flash;
    m.render(idata.data, FONT, flash);
    offx.putImageData(idata, 0, 0);
    cx.imageSmoothingEnabled = false;
    cx.drawImage(off, 0, 0, cv.width, cv.height);
  }
  document.addEventListener('visibilitychange', () => { last = 0; });

  // ---------- controller ----------
  const stops = new Set();
  function wireKeys() {
    for (const b of document.querySelectorAll('.key:not(#nameOk)')) {
      let t1 = null, t2 = null;
      const codes = b.dataset.key ? b.dataset.key.split(',').map(Number) : [];
      const fire = () => {
        if (b.id === 'gamesKey') { location.href = '../'; return; }
        if (!m) return;
        if (m.halted) { if (b === bigKey) location.reload(); return; }
        if (b === bigKey) { const k = cfg.bigKey(m); if (k.press) k.press(m); else { keyQ.length = 0; m.pressKey(k.code); } return; }
        if (codes.length === 1) { keyQ.length = 0; m.pressKey(codes[0]); } else send(...codes);
      };
      const stop = () => { clearTimeout(t1); clearInterval(t2); t1 = t2 = null; b.classList.remove('pressed'); stops.delete(stop); };
      b.addEventListener('pointerdown', e => {
        e.preventDefault(); startAudio(); b.classList.add('pressed'); stops.add(stop); fire();
        if ('rep' in b.dataset) t1 = setTimeout(() => { t2 = setInterval(fire, 180); }, 400);
      });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => b.addEventListener(ev, stop));
      b.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); fire(); } });
    }
    const stopAll = () => { for (const f of [...stops]) f(); };
    window.addEventListener('pointerup', stopAll);
    window.addEventListener('blur', stopAll);
    document.addEventListener('visibilitychange', stopAll);
    if (window.Portrait) Portrait.onChange(stopAll);
  }

  // a real keyboard works too (an Apple II+ only types capitals)
  window.addEventListener('keydown', e => {
    if (nameInput && e.target === nameInput) return;
    if (e.target.closest && e.target.closest('.key') && (e.key === ' ' || e.key === 'Enter')) return;
    startAudio();
    const map = { ArrowLeft: 8, ArrowRight: 21, ArrowUp: 11, ArrowDown: 10, Enter: 13, Escape: 27, Backspace: 8, Delete: 127 };
    let c = null;
    if (e.ctrlKey && e.key.length === 1 && /[a-z]/i.test(e.key)) c = e.key.toUpperCase().charCodeAt(0) - 64;
    else if (map[e.key] !== undefined) c = map[e.key];
    else if (e.key.length === 1 && !e.metaKey && !e.altKey) c = e.key.toUpperCase().charCodeAt(0) & 0x7f;
    if (c !== null && m) { e.preventDefault(); m.pressKey(c); }
  });
  document.addEventListener('gesturestart', e => e.preventDefault());

  function start(config) {
    cfg = config;
    wireKeys();
    new ResizeObserver(layout).observe($('screenwrap'));
    window.addEventListener('resize', layout);
    layout();
    requestAnimationFrame(frame);
    const paths = [].concat(cfg.disks || cfg.disk), roms = cfg.rom ? ['../shared/roms/apple2plus.rom', '../shared/roms/disk2.rom'] : [];
    Promise.all([...paths, ...roms].map(p => fetch(p).then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }))).then(bufs => {
      const dsks = bufs.slice(0, paths.length).map(b => new Uint8Array(b));
      const [rom, diskRom] = bufs.slice(paths.length).map(b => new Uint8Array(b));
      if (cfg.patch) cfg.patch(dsks[0], dsks);
      origs = dsks.map(d => d.slice());
      dsks.forEach((d, i) => loadSaved(d, i));
      m = new Apple2(dsks[0], dsks[1], { model: cfg.model, rom, diskRom });
      m.drives.forEach((d, i) => { d.onWrite = dsk => saveDisk(dsk, i); });
      m.boot();
      window.m = m;   // handy for poking at it from the console
    }).catch(() => {
      const g = offx; g.fillStyle = '#000'; g.fillRect(0, 0, 280, 192); g.fillStyle = '#fff';
      const t = "Couldn't load the game disk.";
      [...t].forEach((ch, i) => { const gi = (ch.charCodeAt(0) - 32) * 8; for (let r = 0; r < 8; r++) for (let p = 0; p < 7; p++) if (FONT[gi + r] >> p & 1) g.fillRect(40 + i * 7 + p, 90 + r, 1, 1); });
      cx.imageSmoothingEnabled = false; cx.drawImage(off, 0, 0, cv.width, cv.height);
    });
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('../sw.js', { scope: '../' }).catch(() => {});
    }
  }

  // screen band fingerprint, for recognizing a screen by its pixels
  function screenPrint(mm, y0, y1) {
    const base = mm.page2 ? 0x4000 : 0x2000; let h = 0;
    for (let y = y0; y < y1; y++) { const row = base + (y & 7) * 0x400 + ((y >> 3) & 7) * 0x80 + (y >> 6) * 0x28; for (let c = 0; c < 40; c++) h = (h * 31 + mm.ram[row + c]) >>> 0; }
    return h;
  }

  window.DiskGame = { start, labelKeys, screenPrint };
})();
