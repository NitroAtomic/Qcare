// End-to-end test: runs the 24-step patient journey plus the error cases through the real HTTP API.
// Usage: npm test
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.QCARE_DATA = 'memory'; // in-process PostgreSQL (PGlite): same SQL engine as Supabase
delete process.env.DATABASE_URL; process.env.QCARE_AUTH = 'local'; process.env.QCARE_QUIET = '1';
process.env.QCARE_DEMO = '1';
const { start } = require('../server/index');
const assert = require('assert');
const PW = 'Qcare#2026';
let base, passed = 0;

function client() {
  let cookie = ''; let csrf = '';
  const call = async (method, url, body, { raw } = {}) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.getSetCookie?.() || []; if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    if (raw) return res; let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
  return { call, get: (u) => call('GET', u), post: (u, b) => call('POST', u, b || {}),
    async login(username, password = PW) { const t = await call('GET', '/api/csrf'); csrf = t.data.csrf; const r = await call('POST', '/api/login', { username, password }); if (r.status === 200) csrf = r.data.csrf; return r; } };
}
const step = (n, label) => console.log(`  ${String(n).padStart(2)}. ${label}`);
async function ok(label, fn) { try { await fn(); passed++; console.log('  ✓ ' + label); } catch (e) { console.log('  ✗ ' + label + '\n      ' + (e.message || e)); process.exitCode = 1; } }

(async () => {
  const { server, port } = await start(0); base = `http://localhost:${port}`;
  const [rc, ds, lab, cash, ph, adm, disp] = await Promise.all(['reception', 'drsantos', 'lab', 'cashier', 'pharmacy', 'admin', 'display'].map(async (u) => { const c = client(); const r = await c.login(u); assert.equal(r.status, 200, u + ' login'); return c; }));
  const meta = (await rc.get('/api/meta')).data; const dept = (code) => meta.departments.find((d) => d.code === code);
  const im = dept('internal-medicine'), labD = dept('laboratory'), cashD = dept('cashier'), phD = dept('pharmacy');
  console.log('\nWorkflow (steps from the spec)');
  let patient, visitId, visitNo, token, dNum, labNum, cNum, phNum, entry;

  await ok('1-3. Receptionist finds Juan Dela Cruz and sees "Patient Found" on a duplicate', async () => {
    step(1, 'search'); const s = (await rc.get('/api/patients?q=Dela%20Cruz')).data; patient = s.items.find((p) => p.first_name === 'Juan'); assert(patient, 'Juan not found'); assert.match(patient.patient_no, /^P-\d{4}-\d{5}$/);
    const dup = await rc.post('/api/patients', { first_name: 'Juan', last_name: 'Dela Cruz', birth_date: patient.birth_date, sex: 'Male' }); assert.equal(dup.status, 409); assert.equal(dup.data.error, 'Patient Found'); assert(dup.data.matches.length);
  });
  await ok('3-6. Creates a visit for Internal Medicine; D-number generated; ticket has QR', async () => {
    const v = await rc.post('/api/visits', { patient_id: patient.id, department_id: im.id, reason: 'Check-up' }); assert.equal(v.status, 201, JSON.stringify(v.data)); visitId = v.data.visit_id; visitNo = v.data.visit_no; dNum = v.data.entry.queue_number; assert.match(dNum, /^D-\d{3}$/);
    const t = (await rc.get(`/api/visits/${visitId}/ticket`)).data; assert(t.qr_svg.startsWith('<svg')); token = t.url.split('/q/')[1]; assert(token.length >= 20); assert(!t.url.includes(patient.patient_no), 'QR must not expose patient id');
    const dupVisit = await rc.post('/api/visits', { patient_id: patient.id, department_id: im.id }); assert.equal(dupVisit.status, 409, 'second open visit blocked');
  });
  await ok('7. Doctor dashboard shows the new number', async () => { const st = (await ds.get(`/api/queue/department/${im.id}`)).data; assert(st.waiting.some((e) => e.queue_number === dNum)); });
  await ok('8-10. Doctor CALL NEXT; TV shows it; patient phone shows queue status (no login)', async () => {
    // Doctor Santos may already be serving a seeded patient: finish that first.
    let st = (await ds.get(`/api/queue/department/${im.id}`)).data; const mine = st.serving.find((e) => e.staff_name === 'Dr. Santos');
    if (mine) await ds.post(`/api/queue/${mine.id}/complete`);
    // Call until Juan is called (seeded waiting patients come first)
    for (let i = 0; i < 12; i++) { const r = await ds.post('/api/queue/call-next', { department_id: im.id }); assert.equal(r.status, 200, JSON.stringify(r.data)); entry = r.data.entry; if (entry.queue_number === dNum) break; await ds.post(`/api/queue/${entry.id}/start`); await ds.post(`/api/queue/${entry.id}/complete`); }
    assert.equal(entry.queue_number, dNum);
    const tv = (await (await fetch(base + '/api/public/display')).json()); const row = tv.departments.find((d) => d.id === im.id); assert(row.serving.some((s) => s.number === dNum)); assert(!JSON.stringify(tv).includes('Dela Cruz'), 'TV must not expose names');
    const mob = await (await fetch(base + '/api/public/visit/' + token)).json(); assert.equal(mob.queues[0].number, dNum); assert.equal(mob.queues[0].status, 'called');
    assert.equal(mob.first_name, 'Juan'); assert(!('patient_no' in mob));
  });
  await ok('11. Doctor starts and completes consultation', async () => { await ds.post(`/api/queue/${entry.id}/start`); const r = await ds.post(`/api/queue/${entry.id}/complete`); assert.equal(r.data.entry.status, 'completed'); });
  await ok('12-13. SEND TO LABORATORY creates a LAB number automatically (and is idempotent)', async () => {
    const tests = meta.services.filter((s) => s.department_id === labD.id).slice(0, 2).map((s) => s.id);
    const r = await ds.post(`/api/visits/${visitId}/route`, { kind: 'laboratory', service_ids: tests, from_entry_id: entry.id }); assert.equal(r.status, 200, JSON.stringify(r.data)); labNum = r.data.entry.queue_number; assert.match(labNum, /^LAB-\d{3}$/);
    const again = await ds.post(`/api/visits/${visitId}/route`, { kind: 'laboratory', service_ids: tests, from_entry_id: entry.id }); assert.equal(again.data.duplicate, true); assert.equal(again.data.entry.queue_number, labNum, 'no duplicate queue number');
    const wrongRole = await lab.post(`/api/visits/${visitId}/route`, { kind: 'consultation', department_id: im.id }); assert.equal(wrongRole.status, 403);
    const pharmacyHold = await ds.post(`/api/visits/${visitId}/route`, { kind: 'pharmacy', items: 'Paracetamol 500 mg', hold: true, from_entry_id: entry.id }); assert.equal(pharmacyHold.data.held, true);
  });
  await ok('14-16. Laboratory receives it, calls, serves, completes; results ready', async () => {
    let le; for (let i = 0; i < 15; i++) { const r = await lab.post('/api/queue/call-next', { department_id: labD.id }); if (r.status === 409 && r.data.entry) { await lab.post(`/api/queue/${r.data.entry.id}/start`); await lab.post(`/api/queue/${r.data.entry.id}/complete`); continue; } assert.equal(r.status, 200, JSON.stringify(r.data)); le = r.data.entry; if (le.queue_number === labNum) break; await lab.post(`/api/queue/${le.id}/start`); await lab.post(`/api/queue/${le.id}/complete`); }
    assert.equal(le.queue_number, labNum); await lab.post(`/api/queue/${le.id}/start`); assert.equal((await lab.post(`/api/lab/${le.id}/specimen`)).status, 200);
    const c = await lab.post(`/api/queue/${le.id}/complete`); assert.equal(c.status, 200); const auto = c.data.entry.auto_created; assert(auto?.length, 'lab complete should auto-create cashier'); cNum = auto[0].queue_number; assert.match(cNum, /^C-\d{3}$/);
    assert.equal((await lab.post(`/api/lab/${le.id}/results-ready`, { summary: 'Normal' })).status, 200);
    step(17, `sent to Cashier automatically as ${cNum}`);
  });
  await ok('17-19. Cashier: payment recorded once even when submitted twice; over-payment rejected', async () => {
    let ce; for (let i = 0; i < 15; i++) { const r = await cash.post('/api/queue/call-next', { department_id: cashD.id }); if (r.status === 409 && r.data.entry) { const e = r.data.entry; const s = (await cash.get(`/api/queue/department/${cashD.id}`)).data.serving.find((x) => x.id === e.id); await cash.post(`/api/billing/${e.id}/pay`, { amount: s.pay.remaining || 0.01, idempotency_key: 'x' + e.id }); continue; } assert.equal(r.status, 200, JSON.stringify(r.data)); ce = r.data.entry; if (ce.queue_number === cNum) break; const sm = (await cash.get(`/api/queue/department/${cashD.id}`)).data.serving.find((x) => x.id === ce.id); await cash.post(`/api/billing/${ce.id}/pay`, { amount: sm.pay.due, idempotency_key: 'k' + ce.id }); }
    assert.equal(ce.queue_number, cNum); const s = (await cash.get(`/api/queue/department/${cashD.id}`)).data.serving.find((x) => x.id === ce.id); assert(s.pay.due > 0);
    const over = await cash.post(`/api/billing/${ce.id}/pay`, { amount: s.pay.due + 100, idempotency_key: 'over' }); assert.equal(over.status, 400);
    const half = await cash.post(`/api/billing/${ce.id}/pay`, { amount: 100, idempotency_key: 'half-1' }); assert.equal(half.data.summary.status, 'partial'); const cantComplete = await cash.post(`/api/queue/${ce.id}/complete`); assert.equal(cantComplete.status, 409);
    const rest = Math.round((s.pay.due - 100) * 100) / 100; const p1 = await cash.post(`/api/billing/${ce.id}/pay`, { amount: rest, idempotency_key: 'rest-1' }); const p2 = await cash.post(`/api/billing/${ce.id}/pay`, { amount: rest, idempotency_key: 'rest-1' });
    assert.equal(p1.data.summary.status, 'paid'); assert.equal(p2.data.duplicate, true); const total = (await adm.get(`/api/reports/cashier_transactions?range=today`)).data.rows.filter((r) => r.visit === visitNo); assert.equal(total.length, 2, 'exactly two payment rows');
    phNum = p1.data.entry.auto_created?.[0]?.queue_number; assert.match(phNum || '', /^PH-\d{3}$/, 'prescription auto-sends to pharmacy after payment'); step(20, `prescription sent to Pharmacy as ${phNum}`);
  });
  await ok('21-23. Pharmacy processes and releases; visit becomes COMPLETED', async () => {
    let pe; for (let i = 0; i < 15; i++) { const r = await ph.post('/api/queue/call-next', { department_id: phD.id }); if (r.status === 409 && r.data.entry) { const e = r.data.entry; await ph.post(`/api/pharmacy/${e.id}/status`, { status: 'ready' }); await ph.post(`/api/pharmacy/${e.id}/status`, { status: 'released' }); continue; } assert.equal(r.status, 200, JSON.stringify(r.data)); pe = r.data.entry; if (pe.queue_number === phNum) break; await ph.post(`/api/pharmacy/${pe.id}/status`, { status: 'ready' }); await ph.post(`/api/pharmacy/${pe.id}/status`, { status: 'released' }); }
    assert.equal(pe.queue_number, phNum); assert.equal((await ph.post(`/api/pharmacy/${pe.id}/status`, { status: 'released' })).status, 409, 'cannot skip Preparing/Ready');
    assert.equal((await ph.post(`/api/pharmacy/${pe.id}/status`, { status: 'preparing' })).status, 200); assert.equal((await ph.post(`/api/pharmacy/${pe.id}/status`, { status: 'ready' })).status, 200);
    const rel = await ph.post(`/api/pharmacy/${pe.id}/status`, { status: 'released' }); assert.equal(rel.status, 200); const v = (await adm.get(`/api/visits/${visitId}`)).data; assert.equal(v.visit.status, 'completed');
    assert.deepEqual(v.journey.map((j) => j.state).filter((s) => s !== 'done'), [], 'every journey step done'); assert.equal(v.entries.length, 4, 'consult, lab, cashier, pharmacy all on the same visit');
  });
  await ok('24. Admin dashboard statistics update', async () => { const s = (await adm.get('/api/stats')).data; assert(s.completed >= 1); assert(s.departments.length >= 6); assert(s.avg_service > 0); });
  await ok('Patient page shows "completed" and the full connected journey', async () => { const m = await (await fetch(base + '/api/public/visit/' + token)).json(); assert.equal(m.visit_status, 'completed'); assert.equal(m.queues.length, 4); assert(m.journey.every((j) => j.state === 'done')); });

  console.log('\nError handling and security');
  await ok('Wrong credentials rejected; locked after repeated failures', async () => { const c = client(); for (let i = 0; i < 5; i++) assert.equal((await c.login('lab', 'nope')).status, 401); assert.equal((await c.login('lab', PW)).status, 423); });
  await ok('Writes without a CSRF token are refused', async () => { const c = client(); await c.login('reception'); const r = await fetch(base + '/api/visits', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'x' }, body: '{}' }); assert.equal(r.status, 403); });
  await ok('Unauthenticated and unauthorized access is blocked', async () => { assert.equal((await fetch(base + '/api/patients')).status, 401); assert.equal((await cash.get('/api/patients')).status, 403); assert.equal((await cash.get('/api/admin/audit')).status, 403); assert.equal((await ds.get('/api/reports/daily_volume')).status, 403); assert.equal((await disp.get('/api/stats')).status, 403); });
  await ok('Roles only reach their own queues', async () => { assert.equal((await cash.get(`/api/queue/department/${im.id}`)).status, 403); assert.equal((await lab.post('/api/queue/call-next', { department_id: im.id })).status, 403); assert.equal((await rc.post('/api/queue/call-next', { department_id: im.id })).status, 403); });
  await ok('Invalid and unknown QR tokens fail safely', async () => { assert.equal((await fetch(base + '/api/public/visit/not-a-real-token')).status, 404); assert.equal((await fetch(base + '/api/public/visit/' + 'a'.repeat(500))).status, 404); });
  await ok('Search is permission-aware (cashier gets no patient directory or contact numbers)', async () => { const r = (await cash.get('/api/search?q=Santos')).data; assert.equal(r.patients.length, 0, 'no patient directory'); assert(!JSON.stringify(r).includes('contact_no'), 'no contact numbers'); const a = (await rc.get('/api/search?q=Santos')).data; assert(a.patients.length > 0); });
  await ok('Wrong patient called: undo returns number to the queue in the same place', async () => {
    const v = await rc.post('/api/visits', { patient_id: (await rc.get('/api/patients?q=Dela%20Cruz')).data.items[0].id, department_id: im.id, reason: 'again' }); assert.equal(v.status, 201);
    const r = await ds.post('/api/queue/call-next', { department_id: im.id }); const e = r.data.entry; const u = await ds.post(`/api/queue/${e.id}/undo-call`); assert.equal(u.data.entry.status, 'waiting');
    const sk = await ds.post('/api/queue/call-next', { department_id: im.id }); assert.equal(sk.data.entry.id, e.id, 'same patient is next again'); await ds.post(`/api/queue/${e.id}/skip`); const rq = await ds.post(`/api/queue/${e.id}/requeue`); assert.equal(rq.data.entry.status, 'waiting');
    assert.equal((await ds.post(`/api/queue/${e.id}/complete`)).status, 409, 'cannot complete a waiting number');
    const mid = await ds.post(`/api/visits/${v.data.visit_id}/cancel`); assert.equal(mid.status, 403, 'doctor cannot cancel visit'); assert.equal((await rc.post(`/api/visits/${v.data.visit_id}/cancel`, { reason: 'Left' })).status, 200);
  });
  await ok('Priority: emergency requires a reason and jumps the queue, with an audit trail', async () => {
    const pts = (await rc.get('/api/patients?q=Reyes&per=5')).data.items; const p = pts.find((x) => !x.open_visit);
    const bad = await rc.post('/api/visits', { patient_id: p.id, department_id: im.id, priority_rule_id: meta.priorities.find((r) => r.code === 'emergency').id }); assert.equal(bad.status, 400);
    const good = await rc.post('/api/visits', { patient_id: p.id, department_id: im.id, priority_rule_id: meta.priorities.find((r) => r.code === 'emergency').id, priority_reason: 'Chest pain, brought by ambulance' }); assert.equal(good.status, 201);
    const next = (await ds.get(`/api/queue/department/${im.id}`)).data.next; assert.equal(next.queue_number, good.data.entry.queue_number); assert.equal(next.priority_label, 'Emergency');
    const log = (await adm.get('/api/admin/audit?q=Chest%20pain')).data; assert(log.items.length >= 1, 'priority reason audited'); await rc.post(`/api/visits/${good.data.visit_id}/cancel`, { reason: 'test' });
  });
  await ok('Reports export to CSV and PDF', async () => { const csv = await (await adm.call('GET', '/api/reports/department_volume.csv?range=today', null, { raw: true })).text(); assert(csv.includes('Department')); const pdf = await adm.call('GET', '/api/reports/queue_performance.pdf?range=week', null, { raw: true }); assert.equal(pdf.status, 200); const buf = Buffer.from(await pdf.arrayBuffer()); assert.equal(buf.slice(0, 4).toString(), '%PDF'); });
  await ok('Audit log recorded the whole journey with user, action and IP', async () => { const a = (await adm.get(`/api/admin/audit?visit_id=${visitId}&per=50`)).data; assert(a.total >= 12, 'only ' + a.total); assert(a.items.every((i) => i.username && i.created_at && i.ip !== undefined)); });
  await ok('Settings: queue format change applies to new numbers', async () => { assert.equal((await adm.call('PUT', '/api/admin/settings', { queue_number_pad: 4 })).status, 200); const p = (await rc.get('/api/patients?q=Garcia&per=5')).data.items.find((x) => !x.open_visit); const v = await rc.post('/api/visits', { patient_id: p.id, department_id: im.id }); assert.match(v.data.entry.queue_number, /^D-\d{4}$/); await rc.post(`/api/visits/${v.data.visit_id}/cancel`, { reason: 'test' }); await adm.call('PUT', '/api/admin/settings', { queue_number_pad: 3 }); });

  console.log('\nConcurrency (the reason QCare uses Postgres row locking)');
  await ok('Two doctors pressing CALL NEXT at the same instant get different patients', async () => {
    const d2 = client(); await d2.login('drreyes'); const rcs = [];
    for (const n of ['Aquino', 'Castillo', 'Flores']) { const p = (await rc.get(`/api/patients?q=${n}&per=5`)).data.items.find((x) => !x.open_visit && x.age >= 18); if (!p) continue; const v = await rc.post('/api/visits', { patient_id: p.id, department_id: im.id }); if (v.status === 201) rcs.push(v.data.visit_id); }
    // clear anyone either doctor is holding from earlier steps
    for (const c of [ds, d2]) { const st = (await c.get(`/api/queue/department/${im.id}`)).data; for (const e of st.serving.filter((x) => x.staff_name === (c === ds ? 'Dr. Santos' : 'Dr. Reyes'))) { if (e.status === 'called') await c.post(`/api/queue/${e.id}/start`); await c.post(`/api/queue/${e.id}/complete`); } }
    const [a, b] = await Promise.all([ds.post('/api/queue/call-next', { department_id: im.id }), d2.post('/api/queue/call-next', { department_id: im.id })]);
    assert.equal(a.status, 200, JSON.stringify(a.data)); assert.equal(b.status, 200, JSON.stringify(b.data)); assert.notEqual(a.data.entry.id, b.data.entry.id, 'both doctors were given the same patient');
    const st = (await adm.get(`/api/queue/department/${im.id}`)).data; assert.equal(st.serving.filter((x) => [a.data.entry.id, b.data.entry.id].includes(x.id)).length, 2);
    for (const [c, r] of [[ds, a], [d2, b]]) { await c.post(`/api/queue/${r.data.entry.id}/start`); await c.post(`/api/queue/${r.data.entry.id}/complete`); }
  });
  await ok('Double-clicking CALL NEXT never calls two patients for one doctor', async () => {
    const [x, y] = await Promise.all([ds.post('/api/queue/call-next', { department_id: im.id }), ds.post('/api/queue/call-next', { department_id: im.id })]);
    const oks = [x, y].filter((r) => r.status === 200); assert.equal(oks.length, 1, 'exactly one call succeeds'); assert.equal([x, y].find((r) => r.status !== 200).status, 409);
    const e = oks[0].data.entry; await ds.post(`/api/queue/${e.id}/skip`); await ds.post(`/api/queue/${e.id}/cancel`, { reason: 'test cleanup' });
  });
  await ok('The same payment sent twice at the same instant is recorded once', async () => {
    const p = (await rc.get('/api/patients?q=Gonzales&per=5')).data.items.find((x) => !x.open_visit && x.age >= 18); const v = await rc.post('/api/visits', { patient_id: p.id, department_id: im.id }); assert.equal(v.status, 201);
    const gone = (await ds.post('/api/queue/call-next', { department_id: im.id })); const mine = (await adm.get(`/api/queue/department/${im.id}`)).data.serving.find((e) => e.visit_id === v.data.visit_id) || gone.data.entry;
    const doneEntries = []; let cur = gone.data.entry; while (cur && cur.visit_id !== v.data.visit_id) { await ds.post(`/api/queue/${cur.id}/start`); await ds.post(`/api/queue/${cur.id}/complete`); const nx = await ds.post('/api/queue/call-next', { department_id: im.id }); cur = nx.data.entry; }
    await ds.post(`/api/queue/${cur.id}/start`); await ds.post(`/api/queue/${cur.id}/complete`); const r = await ds.post(`/api/visits/${v.data.visit_id}/route`, { kind: 'cashier', from_entry_id: cur.id }); assert.equal(r.status, 200, JSON.stringify(r.data));
    let ce; for (let i = 0; i < 40; i++) { const c = await cash.post('/api/queue/call-next', { department_id: cashD.id }); if (c.status === 409 && c.data.entry) { const e = c.data.entry; const s = (await cash.get(`/api/queue/department/${cashD.id}`)).data.serving.find((q) => q.id === e.id); await cash.post(`/api/billing/${e.id}/pay`, { amount: s.pay.remaining, idempotency_key: 'c' + e.id }); continue; } ce = c.data.entry; if (ce.visit_id === v.data.visit_id) break; const s = (await cash.get(`/api/queue/department/${cashD.id}`)).data.serving.find((q) => q.id === ce.id); await cash.post(`/api/billing/${ce.id}/pay`, { amount: s.pay.remaining, idempotency_key: 'c' + ce.id }); }
    assert.equal(ce.visit_id, v.data.visit_id); const due = (await cash.get(`/api/queue/department/${cashD.id}`)).data.serving.find((q) => q.id === ce.id).pay.due;
    const [p1, p2] = await Promise.all([cash.post(`/api/billing/${ce.id}/pay`, { amount: due, idempotency_key: 'same-key' }), cash.post(`/api/billing/${ce.id}/pay`, { amount: due, idempotency_key: 'same-key' })]);
    assert(p1.status === 200 && p2.status === 200, JSON.stringify([p1.data, p2.data])); assert.equal([p1, p2].filter((x) => x.data.duplicate).length, 1, 'one of them is flagged duplicate');
    const rows = (await adm.get('/api/reports/cashier_transactions?range=today')).data.rows.filter((x) => x.queue === ce.queue_number); assert.equal(rows.length, 1, 'exactly one payment row');
  });

  console.log(`\n${passed} checks passed${process.exitCode ? ' — SOME FAILED' : ''}\n`);
  server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100);
})().catch((e) => { console.error(e); process.exit(1); });
