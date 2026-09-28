// Every page is laid out for a phone held upright. Browsers on iPhone can't lock the rotation, so when a phone
// turns sideways this covers the page with a note to turn it back, and the games pause (they check Portrait.turned()).
// Load after shared/font.js, at the end of <body>.
(function () {
  'use strict';
  // a phone on its side: landscape and short (a desktop window is landscape too, but tall enough to use)
  const mq = matchMedia('(orientation: landscape) and (max-height: 500px)');
  const listeners = [];

  const style = document.createElement('style');
  style.textContent = '#turn { position: fixed; inset: 0; z-index: 1000; display: flex; flex-direction: column; align-items: center;' +
    ' justify-content: center; gap: 14px; background: var(--page, #d8d2c2); touch-action: none; }' +
    ' #turn[hidden] { display: none; } #turn canvas { image-rendering: pixelated; }';
  document.head.appendChild(style);

  const el = document.createElement('div');
  el.id = 'turn'; el.hidden = true; el.setAttribute('role', 'alert');
  document.body.appendChild(el);

  // the note, in the Apple II font
  function draw() {
    el.innerHTML = '';
    if (typeof FONT_B64 === 'undefined') { el.textContent = 'Turn your phone upright to play'; return; }
    const FONT = Uint8Array.from(atob(FONT_B64), c => c.charCodeAt(0));
    const ink = getComputedStyle(document.documentElement).getPropertyValue('--key-ink').trim() || '#2b2823';
    const dpr = window.devicePixelRatio || 1, k = Math.round(3 * dpr);
    for (const text of ['Turn your phone', 'upright to play']) {
      const c = document.createElement('canvas');
      c.width = text.length * 7 * k; c.height = 8 * k;
      c.style.width = (c.width / dpr) + 'px'; c.style.height = (c.height / dpr) + 'px';
      const g = c.getContext('2d'); g.fillStyle = ink;
      [...text].forEach((ch, i) => {
        const gi = (ch.charCodeAt(0) - 32) * 8;
        for (let r = 0; r < 8; r++) for (let p = 0; p < 7; p++) if (FONT[gi + r] >> p & 1) g.fillRect((i * 7 + p) * k, r * k, k, k);
      });
      el.appendChild(c);
    }
  }

  function update() {
    const turned = mq.matches;
    if (turned && el.hidden) draw();
    el.hidden = !turned;
    listeners.forEach(f => f(turned));
  }
  mq.addEventListener ? mq.addEventListener('change', update) : mq.addListener(update);
  update();

  // Android (installed, or full screen) can really lock it
  try { screen.orientation.lock('portrait').catch(() => {}); } catch (e) {}

  window.Portrait = {
    turned: () => mq.matches,
    onChange: f => { listeners.push(f); },
  };
})();
