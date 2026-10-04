/* Visits: list, visit detail with the Patient Journey, ticket + QR, and the "send to another department" dialogs. */
(function () {
  'use strict';
  const { html, $, $$ } = Q;

  // ---------- ticket
  Q.showTicket = async (visitId) => {
    const m = Q.modal({ title: 'Patient ticket', size: 'narrow', body: Q.skeleton(3) });
    try {
      const t = await Q.get(`/api/visits/${visitId}/ticket`);
      m.setBody(html`<div class="print-ticket" id="printable"><div class="muted small">${t.hospital}</div><div class="small"><strong>${t.patient_name}</strong><br>${t.patient_no} · ${t.visit_no}</div>
        ${t.entries.length ? t.entries.map((e, i) => i === 0 ? html`<div><div class="muted small">${e.department}${e.priority && e.priority !== 'Regular' ? ' · ' + e.priority + ' priority' : ''}</div><div class="big">${e.queue_number}</div><div class="small muted">${e.ahead} ahead · ${Q.waitText(e.wait_minutes, e.ahead)} (estimate)</div></div>` : '') : html`<p class="muted">No active queue numbers</p>`}
        ${Q.raw(t.qr_svg)}<div class="small"><strong>Scan to see your queue</strong><br><span class="muted">No account needed. Works on your phone.</span></div>
        ${t.entries.length > 1 ? html`<div class="tk-list">${t.entries.slice(1).map((e) => html`<div><span>${e.department}</span><strong class="num">${e.queue_number}</strong></div>`)}</div>` : ''}
        <div class="xs muted">${Q.dateTime(t.created_at)} · Created by JPD</div></div>`);
      m.setFoot(html`<button class="btn" data-close>Close</button><button class="btn" data-journey>Patient journey</button><button class="btn btn-primary" data-print>${Q.icon('print')}Print ticket</button>`);
      $('[data-print]', m.el).addEventListener('click', () => window.print()); $('[data-journey]', m.el).addEventListener('click', () => { m.close(); Q.openVisit(visitId); });
    } catch (e) { m.setBody(Q.errorBox(e.message)); }
  };

  // ---------- send to another department
  Q.routeModal = ({ visitId, kind, fromEntryId, onDone }) => {
    const meta = Q.state.meta; const depts = meta.departments.filter((d) => d.active && (kind === 'laboratory' ? ['laboratory', 'radiology'].includes(d.kind) : d.kind === kind) && Q.state.user.route_targets.includes(d.kind));
    if (!depts.length) return Q.toast('That department is not set up yet.', 'err');
    const label = { laboratory: 'Laboratory or X-Ray', radiology: 'X-Ray / Ultrasound', cashier: 'Cashier', pharmacy: 'Pharmacy', consultation: 'Another doctor' }[kind];
    const svcOf = (id) => meta.services.filter((s) => s.department_id === id && s.active);
    const body = () => { const d = depts[0]; return html`<form id="rf" class="stack" novalidate>
      ${depts.length > 1 ? html`<div class="field"><label for="rd">Department</label><select id="rd" name="department_id">${depts.map((x) => html`<option value="${x.id}">${x.name}</option>`)}</select></div>` : html`<input type="hidden" name="department_id" value="${d.id}">`}
      <div id="rbody" class="stack">${inner(d)}</div></form>`; };
    const inner = (d) => {
      if (d.kind === 'laboratory' || d.kind === 'radiology') return html`<div class="field"><span class="label">Choose the tests</span><div class="stack" style="gap:8px">${svcOf(d.id).map((s) => html`<label class="check"><input type="checkbox" name="svc" value="${s.id}" data-price="${s.price}"><span class="grow"><strong>${s.name}</strong></span><span class="muted">${Q.peso(s.price)}</span></label>`)}</div><span class="err" data-for="svc"></span></div><div class="small muted">Total: <strong id="rt">₱0.00</strong></div>`;
      if (d.kind === 'pharmacy') return html`<div class="field"><label for="ri">Medicines to prepare</label><textarea id="ri" name="items" placeholder="Example: Amoxicillin 500 mg, 1 capsule 3 times a day for 7 days"></textarea><span class="err" data-for="items"></span></div>
        <div class="stack" style="gap:8px"><label class="check"><input type="radio" name="when" value="after" checked><span><strong>After payment at the Cashier</strong><br><span class="small muted">The patient goes to Pharmacy automatically once the bill is paid.</span></span></label><label class="check"><input type="radio" name="when" value="now"><span><strong>Send to Pharmacy now</strong><br><span class="small muted">Creates a Pharmacy queue number right away.</span></span></label></div>`;
      if (d.kind === 'cashier') return html`<p>The patient will get a Cashier queue number. The amount due is added up from the services on this visit.</p>`;
      return html`<p>The patient will get a new queue number in <strong>${d.name}</strong>.</p>`;
    };
    const m = Q.modal({ title: `Send to ${label}`, body: body(), foot: html`<button class="btn" data-close>CANCEL</button><button class="btn btn-primary" data-send>SEND PATIENT</button>` });
    const f = $('#rf', m.el);
    const total = () => { const t = $$('input[name=svc]:checked', f).reduce((a, c) => a + Number(c.dataset.price), 0); const el = $('#rt', f); if (el) el.textContent = Q.peso(t); };
    f.addEventListener('change', (e) => { if (e.target.name === 'department_id') { const d = depts.find((x) => x.id === +e.target.value); Q.mount($('#rbody', f), inner(d)); } total(); });
    $('[data-send]', m.el).addEventListener('click', (e) => Q.busy(e.currentTarget, async () => {
      const d = Q.formData(f); const dept = depts.find((x) => x.id === +d.department_id); const body = { department_id: dept.id, from_entry_id: fromEntryId || undefined };
      if (dept.kind === 'laboratory' || dept.kind === 'radiology') { body.service_ids = $$('input[name=svc]:checked', f).map((c) => +c.value); if (!body.service_ids.length) return Q.setErrors(f, { svc: 'Choose at least one test' }); }
      if (dept.kind === 'pharmacy') { if (!d.items) return Q.setErrors(f, { items: 'Write the medicines first' }); body.items = d.items; body.hold = d.when === 'after'; }
      try { const r = await Q.post(`/api/visits/${visitId}/route`, body); m.close();
        Q.toast(r.held ? 'Prescription saved. The patient goes to Pharmacy after paying.' : r.duplicate ? `Already in ${dept.name} as ${r.entry.queue_number}` : `Sent to ${dept.name} as ${r.entry.queue_number}`, r.duplicate ? 'info' : 'ok'); onDone && onDone(r); }
      catch (err) { Q.fail(err); }
    }));
  };

  // ---------- visit detail
  Q.openVisit = async (visitId) => {
    const m = Q.modal({ title: 'Hospital visit', size: 'wide', body: Q.skeleton(6) });
    const load = async () => {
      let d; try { d = await Q.get(`/api/visits/${visitId}`); } catch (e) { m.setBody(Q.errorBox(e.message)); return; }
      const v = d.visit, p = d.patient; const open = !['completed', 'cancelled'].includes(v.status); const canRoute = open && Q.can('route.send');
      Q.mount($('.modal-head h2', m.el), html`${v.visit_no} ${Q.chip(v.status)}`);
      m.setBody(html`<div class="cols-eq" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))"><div class="stack">
          <div class="person"><span class="avatar">${Q.initials(p.name)}</span><div><strong style="font-size:1.1rem">${p.name}</strong><div class="muted small">${p.patient_no}${p.age != null ? ` · ${p.age} yrs · ${p.sex}` : ''}</div></div></div>
          <dl class="kv"><dt>Date</dt><dd>${Q.dateTime(v.created_at)}</dd>${d.department ? html`<dt>Department</dt><dd>${d.department.name}</dd>` : ''}${d.doctor ? html`<dt>Doctor</dt><dd>${d.doctor.full_name}</dd>` : ''}${v.reason ? html`<dt>Reason</dt><dd>${v.reason}</dd>` : ''}${p.contact_no ? html`<dt>Contact</dt><dd>${p.contact_no}</dd>` : ''}${p.patient_type && p.patient_type !== 'Regular' ? html`<dt>Patient type</dt><dd>${p.patient_type}</dd>` : ''}</dl>
          <div><h3 style="margin-bottom:8px">Queue numbers on this visit</h3>${d.entries.length ? html`<div class="stack" style="gap:8px">${d.entries.map((e) => html`<div class="q-row" style="grid-template-columns:auto 1fr auto"><span class="qn">${e.queue_number}</span><div><div class="nm">${e.dept_name}${e.service_name && ['laboratory', 'radiology'].includes(e.dept_kind) ? ' · ' + e.service_name : ''}</div><div class="sub">${e.status === 'waiting' ? `${e.ahead} ahead · about ${e.wait_minutes} min` : e.counter_name || ''}${e.priority_weight > 0 ? ` · ${e.priority_label}` : ''}${e.pay ? ` · ${Q.peso(e.pay.paid)} of ${Q.peso(e.pay.due)} paid` : ''}</div></div>${Q.chip(e.status)}</div>`)}</div>` : Q.empty('inbox', 'No queue numbers yet')}</div></div>
        <div><h3 style="margin-bottom:12px">Patient journey</h3>${Q.journeyView(d.journey)}</div></div>`);
      m.setFoot(html`${Q.can('audit.view') ? html`<a class="btn btn-ghost" href="#/audit/${v.id}" data-close>${Q.icon('audit')}Audit trail</a>` : ''}<span class="grow"></span>
        <button class="btn" data-act="ticket">${Q.icon('print')}Ticket &amp; QR</button>${canRoute ? html`<button class="btn" data-act="send">${Q.icon('arrow')}Send to…</button>` : ''}
        ${open && Q.can('visits.manage') ? html`<button class="btn btn-danger" data-act="cancel">Cancel visit</button><button class="btn btn-primary" data-act="complete">Complete visit</button>` : ''}`);
      m.el.onclick = async (e) => {
        if (e.target === m.el || e.target.closest('[data-close]')) return m.close(); const a = e.target.closest('[data-act]')?.dataset.act; if (!a) return;
        if (a === 'ticket') Q.showTicket(visitId);
        if (a === 'send') { const kinds = ['laboratory', 'cashier', 'pharmacy', 'consultation'].filter((k) => Q.state.user.route_targets.includes(k) || (k === 'laboratory' && Q.state.user.route_targets.includes('radiology')));
          const pick = await Q.modal({ title: 'Send patient to…', size: 'narrow', body: html`<div class="stack">${kinds.map((k) => html`<button class="btn btn-block" data-kind="${k}">${{ laboratory: 'Laboratory / X-Ray', cashier: 'Cashier', pharmacy: 'Pharmacy', consultation: 'Another doctor' }[k]}</button>`)}</div>` });
          pick.el.addEventListener('click', (ev) => { const k = ev.target.closest('[data-kind]')?.dataset.kind; if (!k) return; pick.close(); Q.routeModal({ visitId, kind: k, onDone: load }); }); }
        if (a === 'complete') { if (await Q.confirm({ title: 'Complete this visit?', message: `${v.visit_no} will be marked COMPLETED.`, confirmLabel: 'COMPLETE VISIT' })) { try { await Q.post(`/api/visits/${visitId}/complete`); Q.toast('Visit completed'); load(); } catch (err) { Q.fail(err); } } }
        if (a === 'cancel') { const why = await Q.prompt({ title: 'Cancel this visit?', label: 'Why is the visit being cancelled?', confirmLabel: 'CANCEL VISIT' }); if (why) { try { await Q.post(`/api/visits/${visitId}/cancel`, { reason: why }); Q.toast('Visit cancelled'); load(); } catch (err) { Q.fail(err); } } }
      };
    };
    await load(); const off = Q.on('queue', Q.debounce(() => { if (m.el.isConnected) load(); }, 600)); m.el.addEventListener('close', off);
  };

  // ---------- visits page
  Q.pages.visits = { title: 'Visits', async render(el) {
    const st = { q: '', status: 'open', date: 'today', page: 1 };
    Q.mount(el, html`<div class="page-head"><div><h1>Visits</h1><p>Every hospital visit and where the patient is right now.</p></div></div>
      <div class="toolbar"><div class="field"><input id="vq" type="search" placeholder="Search visit ID, patient ID or name" aria-label="Search visits"></div>
        <div class="seg" role="group" aria-label="Status" id="vs">${[['open', 'Open'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['', 'All']].map(([v, l]) => html`<button data-v="${v}" aria-pressed="${v === 'open'}">${l}</button>`)}</div>
        <div class="seg" role="group" aria-label="Date" id="vd">${[['today', 'Today'], ['all', 'All dates']].map(([v, l]) => html`<button data-v="${v}" aria-pressed="${v === 'today'}">${l}</button>`)}</div></div><div id="vl"></div>`);
    const load = async () => { const box = $('#vl', el); try { const d = await Q.get('/api/visits?' + Q.qs({ q: st.q, status: st.status, date: st.date === 'today' ? '' : 'all', page: st.page }));
      Q.mount(box, d.items.length ? html`<div class="table-wrap"><table><thead><tr><th>Visit</th><th>Patient</th><th>Department</th><th>Status</th><th>Active queue numbers</th><th>Started</th></tr></thead><tbody>${d.items.map((v) => html`<tr class="click" data-id="${v.id}" tabindex="0"><td><strong>${v.visit_no}</strong></td><td>${v.patient_name}<div class="xs muted">${v.patient_no}</div></td><td>${v.department || ''}</td><td>${Q.chip(v.status)}</td><td class="num" style="text-align:left">${v.active_queues || html`<span class="muted">—</span>`}</td><td>${Q.time(v.created_at)}<div class="xs muted">${Q.date(v.created_at)}</div></td></tr>`)}</tbody></table>${Q.pager(d, 'visits')}</div>` : Q.empty('visits', 'No visits found', 'Create a visit from the Patients page.')); } catch (e) { Q.mount(box, Q.errorBox(e.message)); } };
    el.addEventListener('click', (e) => { const r = e.target.closest('tr[data-id]'); if (r) return Q.openVisit(+r.dataset.id); const pg = e.target.closest('[data-page]'); if (pg) { st.page = +pg.dataset.page; load(); } if (e.target.closest('[data-retry]')) load();
      for (const [id, key] of [['#vs', 'status'], ['#vd', 'date']]) { const b = e.target.closest(id + ' button'); if (b) { st[key] = b.dataset.v; st.page = 1; $$(id + ' button', el).forEach((x) => x.setAttribute('aria-pressed', x === b)); load(); } } });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const r = e.target.closest('tr[data-id]'); if (r) Q.openVisit(+r.dataset.id); } });
    $('#vq', el).addEventListener('input', Q.debounce((e) => { st.q = e.target.value; st.page = 1; load(); }, 300));
    await load(); Q.live(load);
  } };
})();
