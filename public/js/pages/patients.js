/* Patients: search, register (with duplicate detection), profile, and creating a hospital visit. */
(function () {
  'use strict';
  const { html, $, $$ } = Q;
  const TYPES = ['Regular', 'Senior Citizen', 'PWD', 'Pregnant'];

  // ---------- new hospital visit
  Q.newVisit = async (patientId) => {
    const m = Q.modal({ title: 'New hospital visit', body: Q.skeleton(5) });
    let info; try { info = await Q.get('/api/patients/' + patientId); } catch (e) { return m.setBody(Q.errorBox(e.message)); }
    const p = info.patient; const meta = Q.state.meta; const cons = meta.departments.filter((d) => d.active && d.kind === 'consultation');
    if (info.open_visit) { m.setBody(html`<div class="banner">${p.name} already has an open visit today: <strong>${info.open_visit.visit_no}</strong>. One patient can only have one open visit at a time.</div>`);
      m.setFoot(html`<button class="btn" data-close>Close</button><button class="btn btn-primary" data-open>Open visit</button>`); $('[data-open]', m.el).addEventListener('click', () => { m.close(); Q.openVisit(info.open_visit.id); }); return; }
    const sug = info.suggested_priority; const pris = meta.priorities;
    m.setBody(html`<form id="vf" class="stack" novalidate>
      <div class="match"><div><strong>Patient Found</strong><div class="small">${p.name} · ${p.patient_no} · ${p.age} yrs, ${p.sex}</div></div><span class="chip completed">Existing record</span></div>
      ${info.appointments_today.length ? html`<div class="banner ok">Has an appointment today${info.appointments_today[0].doctor ? ' with ' + info.appointments_today[0].doctor : ''}.</div>` : ''}
      <div class="form-grid"><div class="field"><label for="vd">Department</label><select id="vd" name="department_id">${cons.map((d) => html`<option value="${d.id}">${d.name}</option>`)}</select></div>
        <div class="field"><label for="vdoc">Doctor</label><select id="vdoc" name="doctor_id"></select></div></div>
      <div class="field"><label for="vr">Reason for visit</label><input id="vr" name="reason" type="text" maxlength="300" placeholder="Example: Cough and fever for 3 days"></div>
      <div class="form-grid"><div class="field"><label for="vp">Priority</label><select id="vp" name="priority_rule_id">${pris.map((r) => html`<option value="${r.id}" ${r.id === sug.rule_id ? 'selected' : ''}>${r.label}</option>`)}</select><span class="hint" id="vph">${sug.reason ? 'Suggested from patient record: ' + sug.reason : 'Regular queue'}</span></div>
        <div class="field" id="vpwrap"><label for="vpr">Why this priority?</label><input id="vpr" name="priority_reason" type="text" maxlength="300" value="${sug.reason || ''}"><span class="err" data-for="priority_reason"></span></div></div></form>`);
    m.setFoot(html`<button class="btn" data-close>CANCEL</button><button class="btn btn-primary" data-go>CREATE VISIT &amp; QUEUE NUMBER</button>`);
    const f = $('#vf', m.el); const docs = (id) => meta.doctors.filter((d) => d.department_id === id && d.active);
    const fillDocs = () => { $('#vdoc', f).innerHTML = html`<option value="">Any available doctor</option>${docs(+f.department_id.value).map((d) => html`<option value="${d.id}">${d.full_name}${d.specialty ? ' (' + d.specialty + ')' : ''}</option>`)}`.s; };
    const prio = () => { const r = pris.find((x) => x.id === +f.priority_rule_id.value); $('#vpwrap', f).classList.toggle('hide', !(r.weight > 0)); return r; };
    f.department_id.addEventListener('change', fillDocs); f.priority_rule_id.addEventListener('change', () => { const r = prio(); if (r.weight > 0 && r.id !== sug.rule_id) f.priority_reason.value = ''; if (r.id === sug.rule_id) f.priority_reason.value = sug.reason || ''; }); fillDocs(); prio();
    $('[data-go]', m.el).addEventListener('click', (e) => Q.busy(e.currentTarget, async () => { const d = Q.formData(f); const r = prio(); if (r.requires_reason && !d.priority_reason) return Q.setErrors(f, { priority_reason: `Please write why this patient is "${r.label}".` });
      if (r.weight > 0 && !d.priority_reason) return Q.setErrors(f, { priority_reason: 'Write a short reason so it appears in the audit log.' });
      try { const out = await Q.post('/api/visits', { patient_id: p.id, department_id: +d.department_id, doctor_id: d.doctor_id ? +d.doctor_id : null, reason: d.reason, priority_rule_id: +d.priority_rule_id, priority_reason: d.priority_reason }); m.close(); Q.toast(`Queue number ${out.entry.queue_number} created`); Q.showTicket(out.visit_id); Q.emit('queue', { all: true }); }
      catch (err) { if (err.status === 409 && err.data.visit_id) { m.close(); Q.openVisit(err.data.visit_id); } Q.fail(err); } }));
  };

  // ---------- profile
  Q.openPatient = async (id) => {
    const m = Q.modal({ title: 'Patient', size: 'wide', body: Q.skeleton(5) });
    try { const d = await Q.get('/api/patients/' + id); const p = d.patient;
      Q.mount($('.modal-head h2', m.el), html`${p.name}`);
      m.setBody(html`<div class="cols-eq" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))"><div class="stack"><div class="person"><span class="avatar">${Q.initials(p.name)}</span><div><strong style="font-size:1.1rem">${p.patient_no}</strong><div class="muted small">${p.age} yrs · ${p.sex} · born ${Q.date(p.birth_date + 'T12:00:00Z')}</div></div></div>
        <dl class="kv"><dt>Patient type</dt><dd>${p.patient_type}</dd><dt>Contact</dt><dd>${p.contact_no || '—'}</dd><dt>Address</dt><dd>${p.address || '—'}</dd><dt>Emergency contact</dt><dd>${p.emergency_contact_name || '—'}${p.emergency_contact_no ? ' · ' + p.emergency_contact_no : ''}</dd></dl></div>
        <div><h3 style="margin-bottom:8px">Past visits</h3>${d.visits.length ? html`<div class="table-wrap"><table><tbody>${d.visits.map((v) => html`<tr class="click" data-visit="${v.id}"><td><strong>${v.visit_no}</strong><div class="xs muted">${Q.date(v.created_at)}</div></td><td>${Q.chip(v.status)}</td></tr>`)}</tbody></table></div>` : Q.empty('visits', 'No visits yet')}</div></div>`);
      m.setFoot(html`<button class="btn" data-close>Close</button>${Q.can('patients.register') ? html`<button class="btn" data-edit>${Q.icon('edit')}Edit details</button>` : ''}${Q.can('visits.create') ? (d.open_visit ? html`<button class="btn btn-primary" data-open="${d.open_visit.id}">Open today's visit</button>` : html`<button class="btn btn-primary" data-new>${Q.icon('plus')}New hospital visit</button>`) : ''}`);
      m.el.addEventListener('click', (e) => { const v = e.target.closest('[data-visit]'); if (v) { m.close(); Q.openVisit(+v.dataset.visit); } const o = e.target.closest('[data-open]'); if (o) { m.close(); Q.openVisit(+o.dataset.open); } if (e.target.closest('[data-new]')) { m.close(); Q.newVisit(id); } if (e.target.closest('[data-edit]')) { m.close(); Q.patientForm(p); } });
    } catch (e) { m.setBody(Q.errorBox(e.message)); }
  };

  // ---------- register / edit
  Q.patientForm = (edit) => {
    const m = Q.modal({ title: edit ? 'Edit patient' : 'Register patient', size: 'wide', body: html`${edit ? '' : html`<div class="seg" style="margin-bottom:16px" role="group" aria-label="Patient kind"><button type="button" data-mode="new" aria-pressed="true">New patient</button><button type="button" data-mode="ret" aria-pressed="false">Returning patient</button></div>
      <div id="retbox" class="hide stack"><div class="field"><label for="rs">Find the patient</label><input id="rs" type="search" placeholder="Name, patient ID or phone number" autocomplete="off"></div><div id="rres"></div></div>`}
      <form id="pf" class="stack" novalidate><div id="dup"></div><div class="form-grid">
        <div class="field"><label>Patient ID</label><input type="text" value="${edit ? edit.patient_no : 'Assigned when you save'}" disabled></div>
        <div class="field"><label for="f1">First name *</label><input id="f1" name="first_name" type="text" maxlength="60" value="${edit?.first_name || ''}"><span class="err" data-for="first_name"></span></div>
        <div class="field"><label for="f2">Middle name</label><input id="f2" name="middle_name" type="text" maxlength="60" value="${edit?.middle_name || ''}"></div>
        <div class="field"><label for="f3">Last name *</label><input id="f3" name="last_name" type="text" maxlength="60" value="${edit?.last_name || ''}"><span class="err" data-for="last_name"></span></div>
        <div class="field"><label for="f4">Suffix</label><input id="f4" name="suffix" type="text" maxlength="10" placeholder="Jr., Sr., III" value="${edit?.suffix || ''}"></div>
        <div class="field"><label for="f5">Date of birth *</label><input id="f5" name="birth_date" type="date" value="${edit?.birth_date || ''}" ${edit ? 'disabled' : ''} max="${new Date().toISOString().slice(0, 10)}"><span class="err" data-for="birth_date"></span></div>
        <div class="field"><label for="f6">Sex *</label><select id="f6" name="sex" ${edit ? 'disabled' : ''}><option value="">Choose…</option>${['Male', 'Female'].map((s) => html`<option ${edit?.sex === s ? 'selected' : ''}>${s}</option>`)}</select><span class="err" data-for="sex"></span></div>
        <div class="field"><label for="f7">Contact number</label><input id="f7" name="contact_no" type="tel" inputmode="tel" placeholder="09xx xxx xxxx" value="${edit?.contact_no || ''}"><span class="err" data-for="contact_no"></span></div>
        <div class="field span-2"><label for="f8">Address</label><input id="f8" name="address" type="text" maxlength="250" value="${edit?.address || ''}"></div>
        <div class="field"><label for="f9">Emergency contact name</label><input id="f9" name="emergency_contact_name" type="text" value="${edit?.emergency_contact_name || ''}"></div>
        <div class="field"><label for="f10">Emergency contact number</label><input id="f10" name="emergency_contact_no" type="tel" value="${edit?.emergency_contact_no || ''}"></div>
        <div class="field"><label for="f11">Patient type</label><select id="f11" name="patient_type">${TYPES.map((t) => html`<option ${edit?.patient_type === t ? 'selected' : ''}>${t}</option>`)}</select><span class="hint">Used to suggest priority. Seniors are also detected from age.</span></div></div></form>`,
      foot: html`<button class="btn" data-close>CANCEL</button><button class="btn btn-primary" data-save>${edit ? 'SAVE CHANGES' : 'REGISTER PATIENT'}</button>` });
    const f = $('#pf', m.el);
    const validate = (d) => { const e = {}; if (!d.first_name) e.first_name = 'Enter the first name'; if (!d.last_name) e.last_name = 'Enter the last name'; if (!edit) { if (!d.birth_date) e.birth_date = 'Enter the date of birth'; if (!d.sex) e.sex = 'Choose Male or Female'; } if (d.contact_no && !/^[0-9+\-\s()]{7,20}$/.test(d.contact_no)) e.contact_no = 'Use digits only, for example 0917 123 4567'; return e; };
    const showMatches = (matches) => { Q.mount($('#dup', m.el), html`<div class="stack"><div class="match"><div><strong>Patient Found</strong><div class="small">This person may already be registered. Please use the existing record instead of making a new one.</div></div></div>${matches.map((x) => html`<div class="match" style="background:#fff;border-color:var(--line-2)"><div><strong>${x.name}</strong><div class="small muted">${x.patient_no} · ${x.age} yrs · ${x.sex}${x.contact_no ? ' · ' + x.contact_no : ''}</div></div><button type="button" class="btn btn-primary btn-sm" data-use="${x.id}">Use this patient</button></div>`)}<button type="button" class="btn btn-sm" data-force>This is a different person. Register anyway</button></div>`); };
    m.el.addEventListener('click', (e) => { const u = e.target.closest('[data-use]'); if (u) { m.close(); Q.newVisit(+u.dataset.use); } if (e.target.closest('[data-force]')) save(true); const md = e.target.closest('[data-mode]');
      if (md) { $$('[data-mode]', m.el).forEach((b) => b.setAttribute('aria-pressed', b === md)); $('#retbox', m.el).classList.toggle('hide', md.dataset.mode !== 'ret'); f.classList.toggle('hide', md.dataset.mode === 'ret'); $('[data-save]', m.el).classList.toggle('hide', md.dataset.mode === 'ret'); if (md.dataset.mode === 'ret') $('#rs', m.el).focus(); }
      const r = e.target.closest('[data-pick]'); if (r) { m.close(); Q.newVisit(+r.dataset.pick); } });
    $('#rs', m.el)?.addEventListener('input', Q.debounce(async (e) => { const q = e.target.value.trim(); const box = $('#rres', m.el); if (q.length < 2) return Q.mount(box, ''); try { const d = await Q.get('/api/patients?' + Q.qs({ q, per: 5 })); Q.mount(box, d.items.length ? html`<div class="stack" style="gap:8px">${d.items.map((x) => html`<button type="button" class="match" style="width:100%;text-align:left;cursor:pointer;background:#fff;border-color:var(--line-2)" data-pick="${x.id}"><span><strong>${x.name}</strong><br><span class="small muted">${x.patient_no} · ${x.age} yrs · ${x.sex}</span></span><span class="btn btn-sm btn-primary">New visit</span></button>`)}</div>` : html`<p class="muted">No match. Switch to <strong>New patient</strong> to register.</p>`); } catch (er) { Q.mount(box, Q.errorBox(er.message)); } }, 250));
    async function save(force) { const btn = $('[data-save]', m.el); const d = Q.formData(f); if (!Q.setErrors(f, validate(d))) return;
      await Q.busy(btn, async () => { try { if (edit) { await Q.patch('/api/patients/' + edit.id, d); Q.toast('Patient updated'); m.close(); Q.emit('queue', { all: true }); return; }
        d.confirm_new = !!force; const r = await Q.post('/api/patients', d); m.close(); Q.toast(`Registered ${r.patient.patient_no}`); Q.emit('queue', { all: true }); if (Q.can('visits.create')) Q.newVisit(r.patient.id); }
        catch (err) { if (err.status === 409 && err.data.matches) showMatches(err.data.matches); else Q.fail(err); } }); }
    $('[data-save]', m.el).addEventListener('click', () => save(false));
  };

  // ---------- page
  Q.pages.patients = { title: 'Patients', async render(el) {
    const st = { q: '', page: 1 };
    Q.mount(el, html`<div class="page-head"><div><h1>Patients</h1><p>Search for a patient first. If they are already registered, start a new visit from their record.</p></div>${Q.can('patients.register') ? html`<button class="btn btn-primary btn-xl" id="reg">${Q.icon('plus')}Register patient</button>` : ''}</div>
      <div class="toolbar"><div class="field"><input id="pq" type="search" placeholder="Search by name, patient ID or phone number" aria-label="Search patients" autofocus></div></div><div id="pl"></div>`);
    const load = async () => { const box = $('#pl', el); try { const d = await Q.get('/api/patients?' + Q.qs({ q: st.q, page: st.page }));
      Q.mount(box, d.items.length ? html`<div class="table-wrap"><table><thead><tr><th>Patient ID</th><th>Name</th><th>Age / sex</th><th>Contact</th><th>Type</th><th>Last visit</th><th></th></tr></thead><tbody>${d.items.map((p) => html`<tr class="click" data-id="${p.id}"><td><strong>${p.patient_no}</strong></td><td>${p.name}</td><td>${p.age} · ${p.sex}</td><td>${p.contact_no || '—'}</td><td>${p.patient_type !== 'Regular' ? html`<span class="chip pri">${p.patient_type}</span>` : html`<span class="muted">Regular</span>`}</td><td>${p.last_visit ? Q.date(p.last_visit + 'T12:00:00Z') : html`<span class="muted">New patient</span>`}</td>
        <td class="right">${Q.can('visits.create') ? (p.open_visit ? html`<span class="chip waiting">Visit open</span>` : html`<button class="btn btn-sm btn-primary" data-new="${p.id}">New visit</button>`) : ''}</td></tr>`)}</tbody></table>${Q.pager(d, 'patients')}</div>` : Q.empty('patients', st.q ? 'No patient found' : 'No patients yet', st.q ? 'Check the spelling, or register a new patient.' : '')); } catch (e) { Q.mount(box, Q.errorBox(e.message)); } };
    el.addEventListener('click', (e) => { const n = e.target.closest('[data-new]'); if (n) return Q.newVisit(+n.dataset.new); const r = e.target.closest('tr[data-id]'); if (r) return Q.openPatient(+r.dataset.id); const pg = e.target.closest('[data-page]'); if (pg) { st.page = +pg.dataset.page; load(); } if (e.target.closest('#reg')) Q.patientForm(); if (e.target.closest('[data-retry]')) load(); });
    $('#pq', el).addEventListener('input', Q.debounce((e) => { st.q = e.target.value; st.page = 1; load(); }, 300));
    await load(); Q.live(load, { poll: 60000 });
  } };
})();
