/* Queue console: one screen for every department (doctor, laboratory, X-ray, cashier, pharmacy). */
(function () {
  'use strict';
  const { html, $, $$ } = Q;
  const KINDS = { doctors: ['consultation'], laboratory: ['laboratory', 'radiology'], billing: ['cashier'], pharmacy: ['pharmacy'] };
  const START = { consultation: 'START CONSULTATION', laboratory: 'START SERVICE', radiology: 'START SERVICE', pharmacy: 'START', cashier: 'START' };
  const DONE = { consultation: 'COMPLETE CONSULTATION', laboratory: 'COMPLETE', radiology: 'COMPLETE', cashier: 'COMPLETE', pharmacy: 'RELEASE' };

  // ---------- overview of every queue
  Q.pages.queues = { title: 'Queues', async render(el) {
    const load = async () => { const d = await Q.get('/api/queue/overview'); Q.mount(el, html`<div class="page-head"><div><h1>Manage Queue</h1><p>Every department's line, live. Open one to call, skip or complete patients.</p></div></div>
      ${d.departments.length ? html`<div class="dept-grid">${d.departments.map((x) => html`<a href="#/station/${x.id}"><div class="ticket ${x.serving ? 'live' : ''}"><span class="t-label">${x.name}</span><span class="t-num">${x.waiting}</span><span class="t-sub">waiting · ${x.serving} being served · ${x.completed} done today</span><span class="t-sub" style="margin-top:8px;font-weight:700;color:inherit">${x.can_work ? 'Manage queue' : 'View only'} ${Q.icon('arrow')}</span></div></a>`)}</div>` : Q.empty('queues', 'No queues available', 'Ask an administrator to set up departments.')}`); };
    await load(); Q.live(load);
  } };

  // ---------- station page factory
  const pageFor = (kindKey) => ({ title: { doctors: 'Doctors', laboratory: 'Laboratory', billing: 'Billing', pharmacy: 'Pharmacy' }[kindKey] || 'Queue', async render(el, args) {
    const ov = await Q.get('/api/queue/overview'); const kinds = KINDS[kindKey];
    let depts = ov.departments.filter((d) => (kinds ? kinds.includes(d.kind) && d.can_work : true));
    if (!depts.length) return Q.mount(el, Q.empty('queues', 'No queue for you here', 'Ask an administrator to assign you to a department.'));
    let id = args && args[0] ? +args[0] : +localStorage.getItem('qcare.dept.' + kindKey) || depts[0].id; if (!depts.some((d) => d.id === id)) id = depts[0].id;
    const tabs = depts.length > 1 && kinds;
    Q.mount(el, html`${tabs ? html`<div class="tabs" role="tablist">${depts.map((d) => html`<button role="tab" data-dept="${d.id}" aria-selected="${d.id === id}">${d.name}</button>`)}</div>` : ''}<div id="stn"></div>`);
    el.addEventListener('click', (e) => { const t = e.target.closest('[data-dept]'); if (t && t.getAttribute('role') === 'tab') { localStorage.setItem('qcare.dept.' + kindKey, t.dataset.dept); Q.go(kindKey + '/' + t.dataset.dept); } });
    if (args && args[0] && kinds) localStorage.setItem('qcare.dept.' + kindKey, id);
    await station($('#stn', el), id);
  } });
  Q.pages.doctors = pageFor('doctors'); Q.pages.laboratory = pageFor('laboratory'); Q.pages.billing = pageFor('billing'); Q.pages.pharmacy = pageFor('pharmacy');
  Q.pages.station = pageFor(null);

  // ---------- the console
  async function station(box, deptId) {
    let st = null; let pendingRender = false; let key = ''; let lastCounter = localStorage.getItem('qcare.counter.' + deptId) || '';
    const me = Q.state.user.id; const hasOwnCounter = !!(Q.state.user.counter_id || Q.state.user.doctor?.counter_id);

    async function load() {
      st = await Q.get('/api/queue/department/' + deptId); const mineKey = JSON.stringify([st.serving, st.waiting.map((e) => [e.id, e.priority_weight, e.status]), st.recent.slice(0, 3).map((e) => e.id + e.status), st.stats]);
      const typing = box.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && $('#nowpanel', box)?.contains(document.activeElement);
      if (mineKey === key) return; if (typing) { pendingRender = true; return; } key = mineKey; render();
    }
    box.addEventListener('focusout', () => setTimeout(() => { if (pendingRender && !(box.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName))) { pendingRender = false; render(); } }, 50));

    function render() {
      const d = st.department; const doc = Q.state.user.doctor; const mine = st.serving.filter((e) => e.staff_user_id === me); const others = st.serving.filter((e) => e.staff_user_id !== me);
      const justDone = d.kind === 'consultation' && !mine.length ? st.recent.find((e) => e.status === 'completed' && e.staff_user_id === me && !['completed', 'cancelled'].includes(e.visit_status)) : null;
      const counterName = (doc && st.counters.find((c) => c.id === doc.counter_id)?.name) || st.counters.find((c) => c.id === Q.state.user.counter_id)?.name;
      Q.mount(box, html`<div class="station-head"><div>${d.kind === 'consultation' && doc ? html`<h1>${doc.full_name}</h1><div class="dept">${doc.specialty || d.name}${counterName ? ' · ' + counterName : ''}</div>` : html`<h1>${d.name}</h1><div class="dept">${counterName || ({ cashier: 'Payment counters', pharmacy: 'Medicine release', laboratory: 'Tests and specimens', radiology: 'X-ray and ultrasound', consultation: 'Consultation rooms' }[d.kind] || '')}</div>`}</div>
        <div class="row gap-l"><div class="mini-stats"><div><b class="num">${st.stats.waiting}</b><span>Waiting</span></div><div><b class="num">${st.stats.total_today}</b><span>Today</span></div><div><b class="num">${Math.round(st.stats.avg_service_minutes)} min</b><span>Avg service</span></div></div>
          ${st.can_work && !hasOwnCounter && st.counters.length ? html`<div class="field" style="min-width:170px"><label for="ctr">Counter / room</label><select id="ctr"><option value="">First free</option>${st.counters.map((c) => html`<option value="${c.id}" ${String(c.id) === lastCounter ? 'selected' : ''}>${c.name}</option>`)}</select></div>` : ''}
          ${st.can_work && d.kind === 'consultation' && !doc && st.doctors.length ? html`<div class="field" style="min-width:170px"><label for="cdoc">Calling for</label><select id="cdoc"><option value="">Any doctor</option>${st.doctors.map((x) => html`<option value="${x.id}">${x.full_name}</option>`)}</select></div>` : ''}</div></div>
        ${!st.can_work ? html`<div class="banner" style="margin-bottom:16px">You can see this queue but not manage it.</div>` : ''}
        <div class="console"><div class="stack-l" id="nowcol">
          ${mine.length ? mine.map((e) => nowPanel(e, true)) : idlePanel()}
          ${justDone ? sendBar(justDone, 'Just finished') : ''}
          ${others.length ? html`<div class="panel"><h3 style="margin-bottom:10px">Also being served here</h3><div class="stack" style="gap:8px">${others.map((e) => html`<div class="q-row"><span class="qn">${e.queue_number}</span><div><div class="nm">${e.patient_name}</div><div class="sub">${e.counter_name || ''} · ${e.staff_name || ''}</div></div><div class="row gap-s">${Q.chip(e.status)}${st.can_work && Q.can('config.manage') ? html`<button class="btn btn-sm" data-act="open" data-id="${e.id}">Manage</button>` : ''}</div></div>`)}</div></div>` : ''}</div>
        <div class="stack-l">${nextAndWaiting()}${skippedPanel()}${recentPanel()}</div></div>`);
    }

    function idlePanel() {
      const n = st.next; const can = st.can_work;
      return html`<div class="now idle" id="nowpanel"><div class="lbl">NOW SERVING</div><div class="big">—</div>
        <div class="who muted" style="font-weight:600">${n ? `Next patient: ${n.queue_number} · ${n.patient_name}` : 'Nobody is waiting right now'}</div>
        ${can ? html`<div class="actions-bar"><button class="btn btn-primary btn-xl" data-act="next" ${n ? '' : 'disabled'}>${Q.icon('arrow')}CALL NEXT</button></div>` : ''}</div>`;
    }
    function nowPanel(e, isMine) {
      const k = st.department.kind; const can = st.can_work; const overCalls = e.call_count >= st.settings.max_calls; const wait = e.called_at ? Q.minsSince(e.created_at) : 0;
      return html`<div class="now" id="nowpanel"><div class="lbl">NOW SERVING</div><div class="big">${e.queue_number}</div>
        <div class="who">${e.patient_name}</div>
        <div class="meta"><span>${e.age} yrs · ${e.sex}</span>${Q.chip(e.status)}${Q.priChip(e)}${e.call_count > 1 ? html`<span class="chip">Called ${e.call_count} times</span>` : ''}<span>Waited ${wait} min</span></div>
        ${e.counter_name ? html`<div class="room">${e.counter_name}</div>` : ''}
        ${e.priority_weight > 0 && e.priority_reason ? html`<div class="reason"><strong>Priority:</strong> ${e.priority_reason}</div>` : ''}
        ${e.reason ? html`<div class="reason"><strong>Reason for visit:</strong> ${e.reason}</div>` : ''}
        ${kindPanel(e, k)}
        ${can ? html`<div class="actions-bar">${actionsFor(e, k, overCalls)}</div>` : ''}</div>
        ${k === 'consultation' && can && e.status === 'serving' ? sendBar(e, 'Send patient to') : ''}`;
    }
    function kindPanel(e, k) {
      if (k === 'laboratory' || k === 'radiology') return html`<ul class="tests">${(e.lab || []).map((r) => html`<li><span>${r.test_name}</span>${Q.chip(r.status)}</li>`)}</ul>`;
      if (k === 'cashier' && e.pay) { const p = e.pay; const canPay = st.can_work && ['called', 'serving'].includes(e.status);
        return html`<div class="money"><div><span>Amount due</span><b>${Q.peso(p.due)}</b></div><div><span>Paid</span><b>${Q.peso(p.paid)}</b></div><div><span>Balance</span><b>${Q.peso(p.remaining)}</b></div></div><div style="margin-top:10px">${Q.chip(p.status)}</div>
          ${canPay && p.remaining > 0 ? html`<form id="payf" class="stack" style="margin-top:14px;background:#fff;color:var(--text);padding:14px;border-radius:12px" novalidate data-key="${crypto.randomUUID()}" data-id="${e.id}"><div class="form-grid"><div class="field"><label for="pa">Amount received (₱)</label><input id="pa" name="amount" type="number" step="0.01" min="0.01" max="${p.remaining}" value="${p.remaining}" inputmode="decimal"><span class="err" data-for="amount"></span></div>
            <div class="field"><label for="pm">Payment method</label><select id="pm" name="method">${Q.state.meta.payment_methods.map((m) => html`<option>${m}</option>`)}</select></div></div>
            <div class="field"><label for="pn">Reference or note (optional)</label><input id="pn" name="note" type="text" maxlength="120" placeholder="Receipt number or reference. Never enter card numbers."></div>
            <div class="row"><button class="btn btn-primary btn-xl" type="submit">RECORD PAYMENT</button><button class="btn btn-ghost" type="button" data-act="adjust" data-id="${e.id}" data-due="${p.due}">Change amount due</button></div></form>` : ''}`; }
      if (k === 'pharmacy') return html`<ul class="tests">${(e.rx || []).length ? e.rx.map((r) => html`<li><span>${r.items}</span>${Q.chip(r.status)}</li>`) : html`<li><span>No prescription attached</span></li>`}</ul>`;
      return '';
    }
    function actionsFor(e, k, overCalls) {
      const primary = [], second = []; const live = ['called', 'serving'].includes(e.status); const lab = ['laboratory', 'radiology'].includes(k);
      if (k === 'pharmacy' && live) { const rx = e.rx?.[0]?.status;
        if (!e.rx?.length) primary.push(html`<button class="btn btn-signal btn-xl" data-act="complete" data-id="${e.id}">RELEASE</button>`);
        else if (rx === 'pending') primary.push(html`<button class="btn btn-signal btn-xl" data-act="rx" data-s="preparing" data-id="${e.id}">PREPARING</button>`);
        else if (rx === 'preparing') primary.push(html`<button class="btn btn-signal btn-xl" data-act="rx" data-s="ready" data-id="${e.id}">MARK READY</button>`);
        else if (rx === 'ready') primary.push(html`<button class="btn btn-signal btn-xl" data-act="rx" data-s="released" data-id="${e.id}">RELEASE MEDICINES</button>`); }
      else if (k !== 'cashier') { if (e.status === 'called') primary.push(html`<button class="btn btn-signal btn-xl" data-act="start" data-id="${e.id}">${START[k]}</button>`); if (e.status === 'serving') primary.push(html`<button class="btn btn-signal btn-xl" data-act="complete" data-id="${e.id}">${DONE[k]}</button>`); }
      if (k === 'cashier' && e.pay && e.pay.due === 0 && live) primary.push(html`<button class="btn btn-signal btn-xl" data-act="complete" data-id="${e.id}">COMPLETE (NO CHARGE)</button>`);
      if (lab && live && e.lab?.some((r) => r.status === 'requested')) second.push(html`<button class="btn btn-xl" data-act="specimen" data-id="${e.id}">SPECIMEN COLLECTED</button>`);
      if (lab && ['called', 'serving', 'completed'].includes(e.status) && e.lab?.some((r) => r.status !== 'results_ready')) second.push(html`<button class="btn btn-xl" data-act="results" data-id="${e.id}">MARK RESULTS READY</button>`);
      if (e.status === 'called') { second.push(html`<button class="btn btn-xl" data-act="recall" data-id="${e.id}">${Q.icon('volume')}RECALL</button>`, html`<button class="btn btn-xl" data-act="skip" data-id="${e.id}">SKIP</button>`);
        if (overCalls) second.push(html`<button class="btn btn-xl" data-act="noshow" data-id="${e.id}">MARK NO SHOW</button>`);
        second.push(html`<button class="btn btn-xl" data-act="undo" data-id="${e.id}" title="Called the wrong patient?">WRONG PATIENT</button>`); }
      if (e.status !== 'completed') second.push(html`<button class="btn btn-danger btn-xl" data-act="cancel" data-id="${e.id}">CANCEL</button>`);
      return [...primary, ...second];
    }
    function sendBar(e, title) {
      if (!st.can_work) return '';
      const t = Q.state.user.route_targets; const btn = (kind, label) => (t.includes(kind) ? html`<button class="btn btn-xl" data-act="send" data-kind="${kind}" data-visit="${e.visit_id}" data-from="${e.id}">${label}</button>` : '');
      return html`<div class="sendbar"><h3>${title} ${e.patient_name} <span class="num muted">${e.queue_number}</span></h3><div class="grid">${btn('laboratory', 'SEND TO LABORATORY')}${btn('radiology', 'SEND TO X-RAY')}${btn('cashier', 'SEND TO CASHIER')}${btn('pharmacy', 'SEND TO PHARMACY')}</div></div>`;
    }
    function nextAndWaiting() {
      const w = st.waiting; const n = w[0];
      return html`<div class="ticket quiet next-card" style="margin-top:0"><span class="t-label">NEXT PATIENT</span><span class="t-num">${n ? n.queue_number : '—'}</span><span class="t-sub">${n ? `${n.patient_name} · ${n.age} yrs${n.priority_weight > 0 ? ' · ' + n.priority_label + ' priority' : ''}` : 'Nobody waiting'}</span></div>
        <div class="panel"><div class="panel-h"><h3>WAITING <span class="muted">(${w.length})</span></h3></div>${w.length ? html`<ul class="queue-list">${w.map((e, i) => html`<li class="q-row ${i === 0 ? 'first' : ''}"><span class="qn">${e.queue_number}</span><div><div class="nm">${e.patient_name} ${Q.priChip(e)}</div><div class="sub">${e.age} yrs · ${e.sex} · waiting ${Q.minsSince(e.created_at)} min · ${e.ahead === 0 ? 'next in line' : 'about ' + e.wait_minutes + ' min to go'}${e.reason ? ' · ' + e.reason : ''}</div></div><div class="row gap-s">${st.can_work && Q.can('priority.change') ? html`<button class="btn btn-sm btn-ghost" data-act="priority" data-id="${e.id}" data-n="${e.queue_number}" title="Change priority" aria-label="Change priority for ${e.queue_number}">${Q.icon('edit')}</button>` : ''}${st.can_work ? html`<button class="btn btn-sm btn-ghost" data-act="cancel" data-id="${e.id}" data-n="${e.queue_number}" aria-label="Cancel ${e.queue_number}">${Q.icon('x')}</button>` : ''}</div></li>`)}</ul>` : Q.empty('inbox', 'No one is waiting', 'New patients appear here as soon as they get a queue number.')}</div>`;
    }
    function skippedPanel() {
      if (!st.skipped.length) return '';
      return html`<div class="panel"><h3 style="margin-bottom:10px">Skipped and no-show</h3><ul class="queue-list">${st.skipped.map((e) => html`<li class="q-row"><span class="qn">${e.queue_number}</span><div><div class="nm">${e.patient_name}</div><div class="sub">${Q.statusLabel[e.status]}</div></div>${st.can_work ? html`<div class="row gap-s">${e.status === 'skipped' ? html`<button class="btn btn-sm" data-act="noshow" data-id="${e.id}">No show</button>` : ''}<button class="btn btn-sm btn-primary" data-act="requeue" data-id="${e.id}" data-n="${e.queue_number}">Return to queue</button></div>` : ''}</li>`)}</ul></div>`;
    }
    function recentPanel() {
      const r = st.recent.filter((e) => e.status === 'completed' || e.status === 'cancelled'); if (!r.length) return '';
      return html`<div class="panel"><h3 style="margin-bottom:6px">Recently done</h3><ul class="feed">${r.slice(0, 6).map((e) => html`<li><span><strong class="num">${e.queue_number}</strong> ${e.patient_name}</span><span>${Q.chip(e.status)}</span></li>`)}</ul></div>`;
    }

    // ---------- actions
    const run = async (btn, fn, ok) => { if (btn) return Q.busy(btn, async () => { try { const r = await fn(); if (ok) Q.toast(typeof ok === 'function' ? ok(r) : ok); key = ''; await load(); return r; } catch (e) { Q.fail(e); key = ''; await load().catch(() => {}); } }); };
    const entry = (id) => [...st.serving, ...st.waiting, ...st.recent, ...st.skipped].find((e) => e.id === +id);
    box.addEventListener('change', (e) => { if (e.target.id === 'ctr') { lastCounter = e.target.value; localStorage.setItem('qcare.counter.' + deptId, lastCounter); } });
    box.addEventListener('submit', async (ev) => { const f = ev.target.closest('#payf'); if (!f) return; ev.preventDefault(); const d = Q.formData(f); const amt = Number(d.amount); const rem = entry(f.dataset.id)?.pay?.remaining || 0;
      if (!(amt > 0)) return Q.setErrors(f, { amount: 'Enter the amount received' }); if (amt > rem + 0.001) return Q.setErrors(f, { amount: `The balance is only ${Q.peso(rem)}` });
      await run($('button[type=submit]', f), () => Q.post(`/api/billing/${f.dataset.id}/pay`, { amount: amt, method: d.method, note: d.note, idempotency_key: f.dataset.key }), (r) => (r.duplicate ? 'That payment was already recorded' : r.summary.status === 'paid' ? 'Payment complete. Patient moved on.' : 'Partial payment recorded')); });
    box.addEventListener('click', async (ev) => {
      if (ev.target.closest('[data-retry]')) { key = ''; return load(); }
      const b = ev.target.closest('[data-act]'); if (!b) return; const a = b.dataset.act; const id = b.dataset.id; const e = id ? entry(id) : null; const num = e?.queue_number || b.dataset.n || '';
      const counter_id = $('#ctr', box)?.value || null; const doctor_id = $('#cdoc', box)?.value || null;
      if (a === 'next') return run(b, () => Q.post('/api/queue/call-next', { department_id: deptId, counter_id, doctor_id }), (r) => `Called ${r.entry.queue_number}`);
      if (a === 'recall') return run(b, () => Q.post(`/api/queue/${id}/recall`), `Called ${num} again`);
      if (a === 'start') return run(b, () => Q.post(`/api/queue/${id}/start`), 'Started');
      if (a === 'complete') return run(b, () => Q.post(`/api/queue/${id}/complete`), (r) => r.entry.auto_created?.length ? `Completed. Sent to ${r.entry.auto_created.map((x) => x.dept_name + ' ' + x.queue_number).join(', ')}` : 'Completed');
      if (a === 'skip') { if (await Q.confirm({ title: 'Skip this patient?', message: `Are you sure you want to skip queue ${num}?`, confirmLabel: 'SKIP PATIENT', danger: true })) run(b, () => Q.post(`/api/queue/${id}/skip`), `${num} skipped`); return; }
      if (a === 'noshow') { if (await Q.confirm({ title: 'Mark as no show?', message: `Queue ${num} did not come. Mark as no show?`, confirmLabel: 'MARK NO SHOW', danger: true })) run(b, () => Q.post(`/api/queue/${id}/no-show`), `${num} marked no show`); return; }
      if (a === 'undo') { if (await Q.confirm({ title: 'Called the wrong patient?', message: `${num} goes back to the waiting list in the same place.`, confirmLabel: 'RETURN TO WAITING LIST' })) run(b, () => Q.post(`/api/queue/${id}/undo-call`), `${num} is back in line`); return; }
      if (a === 'requeue') { if (await Q.confirm({ title: 'Return to queue?', message: `${num} goes to the end of the waiting list.`, confirmLabel: 'RETURN TO QUEUE' })) run(b, () => Q.post(`/api/queue/${id}/requeue`), `${num} is back in line`); return; }
      if (a === 'cancel') { const why = await Q.prompt({ title: `Cancel queue ${num}?`, label: 'Why is this queue number being cancelled?', confirmLabel: 'CANCEL QUEUE NUMBER' }); if (why) run(b, () => Q.post(`/api/queue/${id}/cancel`, { reason: why }), `${num} cancelled`); return; }
      if (a === 'specimen') return run(b, () => Q.post(`/api/lab/${id}/specimen`), 'Specimen recorded');
      if (a === 'results') { const note = await Q.prompt({ title: 'Mark results ready', label: 'Short note for the doctor (optional)', required: false, confirmLabel: 'RESULTS READY' }); if (note !== null) run(b, () => Q.post(`/api/lab/${id}/results-ready`, { summary: note }), 'Results marked ready. The doctor was notified.'); return; }
      if (a === 'rx') return run(b, () => Q.post(`/api/pharmacy/${id}/status`, { status: b.dataset.s }), (r) => (b.dataset.s === 'released' ? 'Medicines released. Visit finished.' : 'Updated'));
      if (a === 'send') return Q.routeModal({ visitId: +b.dataset.visit, kind: b.dataset.kind, fromEntryId: +b.dataset.from, onDone: () => { key = ''; load(); } });
      if (a === 'adjust') { const m = Q.modal({ title: 'Change amount due', size: 'narrow', body: html`<form id="af" class="stack" novalidate><div class="field"><label for="aa">New amount due (₱)</label><input id="aa" name="amount" type="number" step="0.01" min="0" value="${b.dataset.due}"><span class="err" data-for="amount"></span></div><div class="field"><label for="ar">Why?</label><input id="ar" name="reason" type="text"><span class="err" data-for="reason"></span></div></form>`, foot: html`<button class="btn" data-close>CANCEL</button><button class="btn btn-primary" data-s>SAVE AMOUNT</button>` });
        $('[data-s]', m.el).addEventListener('click', async (x) => { const f = $('#af', m.el); const d = Q.formData(f); if (!d.reason) return Q.setErrors(f, { reason: 'Write why the amount changes' }); await Q.busy(x.currentTarget, async () => { try { await Q.post(`/api/billing/${id}/adjust`, { amount: d.amount, reason: d.reason }); m.close(); Q.toast('Amount updated'); key = ''; load(); } catch (er) { Q.setErrors(f, { amount: er.message }); } }); }); return; }
      if (a === 'priority') { const pris = Q.state.meta.priorities; const m = Q.modal({ title: `Change priority for ${num}`, size: 'narrow', body: html`<form id="prf" class="stack" novalidate><div class="field"><label for="prs">New priority</label><select id="prs" name="rule_id">${pris.map((p) => html`<option value="${p.id}" ${e && p.id === e.priority_rule_id ? 'selected' : ''}>${p.label}</option>`)}</select></div><div class="field"><label for="prr">Why is the priority changing?</label><input id="prr" name="reason" type="text" placeholder="This is saved in the audit log"><span class="err" data-for="reason"></span></div></form>`, foot: html`<button class="btn" data-close>CANCEL</button><button class="btn btn-primary" data-s>SAVE PRIORITY</button>` });
        $('[data-s]', m.el).addEventListener('click', async (x) => { const f = $('#prf', m.el); const d = Q.formData(f); if (!d.reason) return Q.setErrors(f, { reason: 'Please write the reason' }); await Q.busy(x.currentTarget, async () => { try { await Q.post(`/api/queue/${id}/priority`, { rule_id: +d.rule_id, reason: d.reason }); m.close(); Q.toast('Priority updated'); key = ''; load(); } catch (er) { Q.setErrors(f, { reason: er.message }); } }); }); return; }
    });
    try { await load(); } catch (e) { Q.mount(box, Q.errorBox(e.message)); }
    Q.live(async () => { await load(); });
    // refresh elapsed minutes without a network call
    const iv = setInterval(() => { if (st && !(box.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName))) render(); }, 60000); Q.cleanups.push(() => clearInterval(iv));
  }
})();
