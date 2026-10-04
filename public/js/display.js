/* TV board. Public, no sign-in. Shows queue numbers only (names appear only if the hospital turns that on). */
(function () {
  'use strict';
  const { html, $ } = Q;
  const root = document.getElementById('board');
  let state = null, spoken = new Set(), flash = new Map(); let gateDone = !Q.voice.supported;
  const pref = () => JSON.parse(localStorage.getItem('qcare.tv') || '{}');
  const savePref = (p) => localStorage.setItem('qcare.tv', JSON.stringify({ ...pref(), ...p }));

  const panel = (d, i) => {
    const s = d.serving; const top = s[0]; const rest = s.slice(1, 4); const hot = flash.has(d.id) && flash.get(d.id) > Date.now();
    return html`<section class="tv-panel ${top ? 'live' : 'idle'} ${hot ? 'flash' : ''}" data-d="${d.id}" aria-label="${d.name}">
      <h2>${d.name}</h2><div class="lbl">NOW SERVING</div><div class="no" aria-live="polite">${top ? top.number : '—'}</div>
      ${top ? html`<div class="go"><small>PLEASE PROCEED TO</small>${top.counter || d.name}${top.name ? html` <span style="font-weight:500;opacity:.8">· ${top.name}</span>` : ''}</div>` : html`<div class="go" style="color:#6F9A93;font-weight:600">No one is being called</div>`}
      ${rest.length ? html`<div class="also">${rest.map((x) => html`<span><b>${x.number}</b> ${x.counter || ''}</span>`)}</div>` : ''}
      <div class="next"><span>NEXT</span>${d.waiting.length ? d.waiting.slice(0, 3).map((n) => html`<b>${n}</b>`) : html`<span>—</span>`}<span style="margin-left:auto">${d.waiting_count} waiting</span></div></section>`;
  };
  function draw() {
    if (!state) return; const n = state.departments.length; const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
    const logo = state.logo ? html`<img src="${state.logo}" alt="">` : Q.logoMark(); const now = new Date();
    Q.mount(root, html`<header class="tv-head"><div class="tv-brand">${logo}<div><h1>${state.hospital}</h1><small>${state.tagline}</small></div></div><div class="tv-clock">${now.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' })}<small>${now.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'Asia/Manila' })}</small></div></header>
      <main class="tv-grid" style="--cols:${cols}">${n ? state.departments.map(panel) : Q.empty('display', 'No queues are set up yet')}</main>
      <footer class="tv-foot"><span class="state ${navigator.onLine && online ? '' : 'off'}" id="st">${navigator.onLine && online ? 'Live' : 'Reconnecting…'}</span><span>HOSPITAL QUEUE · Please wait for your number · Created by JPD</span></footer>
      <div class="tv-tools"><button id="mute" aria-pressed="${!!pref().mute}">${pref().mute ? 'Sound off' : 'Sound on'}</button><label class="sr" for="vol">Volume</label><input id="vol" type="range" min="0" max="1" step="0.1" value="${pref().volume ?? ''}" title="Volume"><button id="rep">Repeat last</button><button id="fs">Full screen</button></div>
      ${gateDone ? '' : html`<div class="sound-gate" id="gate"><div><button id="unlock">Tap to turn on voice announcements</button><p>Browsers need one tap before they can speak.</p></div></div>`}`);
    const v = $('#vol'); if (v && pref().volume == null) v.value = state.voice.volume;
  }
  let online = false;
  async function load() { state = await Q.get('/api/public/display', { quiet: true }); draw(); }
  const opts = () => ({ volume: pref().volume ?? state.voice.volume, repeat: state.voice.repeat, delay: state.voice.delay, lang: state.voice.lang });
  Q.on('announce', (a) => {
    const key = a.id + ':' + a.n; if (spoken.has(key)) return; spoken.add(key); if (spoken.size > 200) spoken = new Set([...spoken].slice(-50));
    flash.set(a.dept_id, Date.now() + 6000); setTimeout(() => { flash.delete(a.dept_id); draw(); }, 6200); load().catch(() => {});
    if (state?.voice.enabled && gateDone && !pref().mute) Q.voice.announce(a, opts());
  });
  Q.on('online', () => { online = true; load().catch(() => {}); }); Q.on('offline', () => { online = false; draw(); });
  Q.on('queue', Q.debounce(() => load().catch(() => {}), 250));
  root.addEventListener('click', (e) => {
    if (e.target.closest('#unlock')) { Q.voice.unlock(); gateDone = true; draw(); return; }
    if (e.target.closest('#mute')) { savePref({ mute: !pref().mute }); draw(); }
    if (e.target.closest('#rep')) { Q.voice.unlock(); Q.voice.repeatLast(); }
    if (e.target.closest('#fs')) { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(); }
  });
  root.addEventListener('input', (e) => { if (e.target.id === 'vol') savePref({ volume: +e.target.value }); });
  setInterval(() => { if (state) { const c = $('.tv-clock'); if (c) draw(); } }, 30000);
  setInterval(() => load().catch(() => {}), 20000); // safety net if the socket is down
  load().then(() => { if (!state.voice.enabled) { gateDone = true; draw(); } }).catch(() => Q.mount(root, html`<div class="boot" style="padding:40px">Cannot reach the queue system. Retrying…</div>`));
  Q.connectLive();
})();
