/* Patient queue page. No account. Opens from the QR code on the ticket. */
(function () {
  'use strict';
  const { html, $ } = Q;
  const root = document.getElementById('t'); const token = location.pathname.split('/').filter(Boolean)[1] || '';
  let showJourney = false, lastStatus = null, data = null, online = true;

  const wait = (q) => (q.status === 'waiting' ? Q.waitText(q.wait_minutes, q.ahead) : '');
  function hero(d) {
    const active = d.queues.filter((q) => ['waiting', 'called', 'serving'].includes(q.status)); const q = active.find((x) => x.status === 'called') || active.find((x) => x.status === 'serving') || active[0];
    if (!q) { const fin = d.visit_status === 'completed' || d.visit_status === 'cancelled';
      return html`<div class="hero ${fin ? 'done' : ''}"><div class="hi">Hello, ${d.first_name}</div><div class="big">${fin ? (d.visit_status === 'completed' ? 'All done' : 'Visit cancelled') : 'Next step'}</div><div class="dept">${fin ? (d.visit_status === 'completed' ? 'Thank you for visiting. Take care!' : 'Please see the reception desk.') : 'Please wait for the staff to send you to your next department.'}</div></div>`; }
    const turn = q.status === 'called'; const serving = q.status === 'serving';
    return html`<div class="hero ${turn ? 'turn' : ''}"><div class="hi">Hello, ${d.first_name}</div><div class="lbl">YOUR QUEUE · ${q.department.toUpperCase()}</div><div class="big">${q.number}</div>
      ${turn ? html`<div class="msg">It is your turn. Please go to ${q.counter || q.department} now.</div>` : serving ? html`<div class="dept">You are being served${q.counter ? ' at ' + q.counter : ''}.</div>` : ''}
      ${q.status === 'waiting' ? html`<div class="facts"><div><small>NOW SERVING</small><b>${q.now_serving || '—'}</b></div><div><small>PATIENTS AHEAD</small><b>${q.ahead}</b></div><div class="full"><small>ESTIMATED WAIT</small><b>${wait(q)}</b></div></div><p class="note">This is an estimate only. It changes as patients are served.</p>` : ''}</div>`;
  }
  function draw() {
    const d = data; const others = d.queues.filter((q) => q.status !== 'cancelled');
    const info = (q) => q.status === 'waiting' ? `${q.ahead} ahead · ${wait(q)}` : q.status === 'called' ? `Go to ${q.counter || 'the counter'}` : q.status === 'serving' ? 'Being served' : q.status === 'completed' ? 'Done' : Q.statusLabel[q.status];
    const extra = (q) => q.lab ? q.lab.map((l) => `${l.test}: ${Q.statusLabel[l.status]}`).join(' · ') : q.rx_status ? `Medicines: ${Q.statusLabel[q.rx_status]}` : q.pay ? `${Q.peso(q.pay.due)} · ${Q.statusLabel[q.pay.status]}` : '';
    Q.mount(root, html`<div class="off ${online ? '' : 'on'}" role="status">No connection. Showing the last update. Trying again…</div>
      <div class="wrap"><div class="t-top">${Q.logoMark()}<b>VisiQ</b><span>${d.hospital}<br>${d.visit_no}</span></div>${hero(d)}
        <button class="btn btn-primary btn-journey" id="jb" aria-expanded="${showJourney}">${showJourney ? 'HIDE PATIENT JOURNEY' : 'VIEW PATIENT JOURNEY'}</button>
        ${showJourney ? html`<div class="card"><h2>Your visit today</h2>${Q.journeyView(d.journey)}</div>` : ''}
        ${others.length > 1 || (others.length === 1 && d.queues.length) ? html`<div class="card"><h2>Your queue numbers</h2><ul class="qlist">${others.map((q) => html`<li><span class="n">${q.number}</span><div><div class="d">${q.department}</div><div class="s">${info(q)}${extra(q) ? ' · ' + extra(q) : ''}</div></div>${Q.chip(q.status)}</li>`)}</ul></div>` : ''}
        <details class="card"><summary style="cursor:pointer;font-weight:700">Show my QR code</summary><div class="qr"><img src="/api/public/visit/${token}/qr.svg" alt="QR code for this visit" width="190" height="190"><span class="small muted">Keep this page or QR code. It opens your queue again.</span></div></details>
        <p class="foot">Waiting times are estimates, not promises.<br>Updated ${Q.time(d.updated_at)} · Created by JPD</p></div>`);
  }
  async function load() {
    try { data = await Q.get('/api/public/visit/' + encodeURIComponent(token), { quiet: true }); online = true; const cur = data.queues.find((q) => q.status === 'called'); if (cur && lastStatus !== 'called:' + cur.number) { navigator.vibrate?.([300, 120, 300]); lastStatus = 'called:' + cur.number; } else if (!cur) lastStatus = null; draw(); }
    catch (e) { if (e.status === 404 || e.status === 410) return Q.mount(root, html`<div class="err-page">${Q.icon('alert')}<h1>${e.status === 410 ? 'This link has expired' : 'We cannot open this link'}</h1><p class="muted">${e.message}</p><p class="foot">Created by JPD</p></div>`); online = false; if (data) draw(); else Q.mount(root, html`<div class="err-page">${Q.icon('alert')}<h1>No connection</h1><p class="muted">Check your internet. We will try again.</p></div>`); }
  }
  root.addEventListener('click', (e) => { if (e.target.closest('#jb')) { showJourney = !showJourney; draw(); } });
  Q.on('queue', Q.debounce(load, 400)); Q.on('online', load); Q.on('offline', () => { online = false; if (data) draw(); });
  setInterval(load, 15000); load(); Q.connectLive();
})();
