const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const db = require('./db');
const core = require('./core');
const auth = require('./auth');
const stats = require('./stats');
const authprovider = require('./authprovider');
const { PERMISSIONS, PAYMENT_METHODS } = require('./perms');
const { fail, clean, LOCAL } = core;

const wrap = (fn) => (req, res, next) => { try { Promise.resolve(fn(req, res, next)).catch(next); } catch (e) { next(e); } };
const id = (v) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0 || n > 2147483647) fail(400, 'Invalid id'); return n; };
const page = (req, def = 15) => { const p = Math.max(1, parseInt(req.query.page, 10) || 1); const per = Math.min(50, Math.max(5, parseInt(req.query.per, 10) || def)); return { p, per, off: (p - 1) * per }; };
const like = (q) => '%' + String(q).replace(/[\\%_]/g, (m) => '\\' + m) + '%';
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(new Date(s));
const { requirePerm: need } = auth;
const anyQueue = need('queue.view', 'queue.consultation', 'queue.laboratory', 'queue.cashier', 'queue.pharmacy');
const authErr = (e) => (e instanceof authprovider.AuthError ? new core.HttpError(e.status, e.message) : e);

const api = express.Router();

// ------------------------------------------------------------------ auth
api.get('/csrf', (req, res) => { if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('base64url'); res.json({ csrf: req.session.csrf, demo: process.env.VISIQ_DEMO !== '0' }); });
api.post('/login', wrap(async (req, res) => { const u = await auth.login(req, req.body.username, req.body.password); res.json({ user: auth.publicUser(u), csrf: req.session.csrf }); }));
api.post('/logout', wrap(async (req, res) => { if (req.user) await core.audit(req.ctx, 'auth.logout', { entity: 'user', id: req.user.id, summary: `${req.user.full_name} signed out` }); req.session.destroy(() => { res.clearCookie('visiq.sid'); res.json({ ok: true }); }); }));
api.get('/me', wrap(async (req, res) => { const s = await core.getSettings(); res.json({ user: req.user ? auth.publicUser(req.user) : null, csrf: req.session?.csrf || null,
  brand: { hospital_name: s.hospital_name, tagline: s.hospital_tagline, logo: s.hospital_logo, session_timeout_minutes: Number(s.session_timeout_minutes), tz: core.TZ } }); }));
api.post('/me/password', auth.requireAuth, wrap(async (req, res) => {
  const { current, next } = req.body; auth.validatePassword(next);
  try { await authprovider.get().signIn(req.user.email, String(current || '')); } catch (e) { if (e.status === 401) fail(400, 'Your current password is not correct'); throw authErr(e); }
  try { await authprovider.get().setPassword(req.user.auth_id, next); } catch (e) { throw authErr(e); }
  await core.audit(req.ctx, 'auth.password_changed', { entity: 'user', id: req.user.id, summary: `${req.user.full_name} changed their password` }); res.json({ ok: true });
}));

// everything below needs a signed-in staff member
api.use(auth.requireAuth);

api.get('/meta', wrap(async (req, res) => {
  const s = await core.getSettings();
  res.json({
    departments: await db.all('SELECT * FROM departments WHERE deleted_at IS NULL ORDER BY sort_order, id'),
    services: await db.all('SELECT * FROM services WHERE deleted_at IS NULL ORDER BY department_id, name'),
    counters: await db.all('SELECT * FROM queue_counters WHERE deleted_at IS NULL ORDER BY department_id, id'),
    doctors: await db.all('SELECT * FROM doctors WHERE deleted_at IS NULL ORDER BY full_name'),
    priorities: await db.all('SELECT * FROM priority_rules WHERE enabled=1 ORDER BY weight DESC, sort_order'),
    payment_methods: PAYMENT_METHODS, voice: { enabled: s.voice_enabled === '1' },
  });
}));

// ------------------------------------------------------------------ notifications + stats
api.get('/notifications', wrap(async (req, res) => res.json({
  items: await db.all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 20', [req.user.id]),
  unread: (await db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL', [req.user.id])).n })));
api.post('/notifications/read', wrap(async (req, res) => { await db.run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', [core.now(), req.user.id]); res.json({ ok: true }); }));
api.get('/stats', need('dashboard.view'), wrap(async (req, res) => res.json(await stats.dashboard())));

// ------------------------------------------------------------------ patients
const NAME_MATCH = (a = 'p') => `(${a}.first_name ILIKE @l ESCAPE '\\' OR ${a}.last_name ILIKE @l ESCAPE '\\' OR (${a}.first_name||' '||${a}.last_name) ILIKE @l ESCAPE '\\' OR ${a}.patient_no ILIKE @l ESCAPE '\\' OR ${a}.contact_no ILIKE @l ESCAPE '\\')`;
api.get('/patients', need('patients.view'), wrap(async (req, res) => {
  const { p, per, off } = page(req); const q = String(req.query.q || '').trim();
  const sql = q ? `p.deleted_at IS NULL AND ${NAME_MATCH()}` : 'p.deleted_at IS NULL'; const bind = q ? { l: like(q) } : {};
  const total = (await db.get(`SELECT COUNT(*) AS n FROM patients p WHERE ${sql}`, bind)).n;
  const rows = await db.all(`SELECT p.*, (SELECT MAX(visit_date) FROM patient_visits v WHERE v.patient_id=p.id) AS last_visit,
    (SELECT visit_no FROM patient_visits v WHERE v.patient_id=p.id AND v.visit_date=@today AND v.status NOT IN ('completed','cancelled') AND v.deleted_at IS NULL LIMIT 1) AS open_visit
    FROM patients p WHERE ${sql} ORDER BY lower(p.last_name), lower(p.first_name) LIMIT @per OFFSET @off`, { ...bind, today: core.localDate(), per, off });
  res.json({ items: rows.map((r) => ({ ...core.publicPatient(r), last_visit: r.last_visit, open_visit: r.open_visit })), total, page: p, per });
}));
api.post('/patients/check', need('patients.register', 'visits.create'), wrap(async (req, res) => {
  const b = req.body; res.json({ matches: (await core.findDuplicates({ first_name: clean(b.first_name, 60) || '', last_name: clean(b.last_name, 60) || '', birth_date: b.birth_date || '', contact_no: clean(b.contact_no, 20) })).map(core.publicPatient) });
}));
api.post('/patients', need('patients.register'), wrap(async (req, res) => res.status(201).json({ patient: core.publicPatient(await core.registerPatient(req.ctx, req.body)) })));
api.get('/patients/:id', need('patients.view'), wrap(async (req, res) => {
  const p = await core.getPatient(id(req.params.id)); if (!p) fail(404, 'Patient not found');
  const visits = await db.all(`SELECT id, visit_no, visit_date, status, created_at FROM patient_visits WHERE patient_id=? AND deleted_at IS NULL ORDER BY id DESC LIMIT 30`, [p.id]);
  const open = visits.find((v) => v.visit_date === core.localDate() && !['completed', 'cancelled'].includes(v.status));
  const sug = await core.suggestPriority(p);
  res.json({ patient: core.publicPatient(p), visits, open_visit: open || null, suggested_priority: { rule_id: sug.rule.id, label: sug.rule.label, reason: sug.reason },
    appointments_today: await db.all(`SELECT a.id, a.scheduled_at, d.full_name AS doctor FROM appointments a LEFT JOIN doctors d ON d.id=a.doctor_id WHERE a.patient_id=? AND a.status='scheduled' AND ${LOCAL('a.scheduled_at')}::date=?`, [p.id, core.localDate()]) });
}));
api.patch('/patients/:id', need('patients.register'), wrap(async (req, res) => {
  const p = await core.getPatient(id(req.params.id)); if (!p) fail(404, 'Patient not found'); const b = req.body;
  const next = { first_name: clean(b.first_name, 60) || p.first_name, middle_name: clean(b.middle_name, 60), last_name: clean(b.last_name, 60) || p.last_name, suffix: clean(b.suffix, 10),
    contact_no: clean(b.contact_no, 20), address: clean(b.address, 250), emergency_contact_name: clean(b.emergency_contact_name, 100), emergency_contact_no: clean(b.emergency_contact_no, 20),
    patient_type: ['Regular', 'Senior Citizen', 'PWD', 'Pregnant'].includes(b.patient_type) ? b.patient_type : p.patient_type };
  if (next.contact_no && !/^[0-9+\-\s()]{7,20}$/.test(next.contact_no)) fail(400, 'Contact number should only have digits, spaces, + or -');
  await db.run(`UPDATE patients SET first_name=@first_name, middle_name=@middle_name, last_name=@last_name, suffix=@suffix, contact_no=@contact_no, address=@address,
    emergency_contact_name=@emergency_contact_name, emergency_contact_no=@emergency_contact_no, patient_type=@patient_type WHERE id=@id`, { ...next, id: p.id });
  await core.audit(req.ctx, 'patient.updated', { entity: 'patient', id: p.id, patient_id: p.id, summary: `${req.user.full_name} updated patient ${p.patient_no}`, prev: { contact_no: p.contact_no, patient_type: p.patient_type }, next: { contact_no: next.contact_no, patient_type: next.patient_type } });
  res.json({ patient: core.publicPatient(await core.getPatient(p.id)) });
}));

// ------------------------------------------------------------------ visits
api.get('/visits', need('visits.view'), wrap(async (req, res) => {
  const { p, per, off } = page(req); const where = ['v.deleted_at IS NULL']; const bind = {};
  const date = isDate(req.query.date) ? req.query.date : (req.query.date === 'all' ? null : core.localDate());
  if (date) { where.push('v.visit_date=@date'); bind.date = date; }
  if (['waiting', 'in_service', 'waiting_next', 'completed', 'cancelled'].includes(req.query.status)) { where.push('v.status=@status'); bind.status = req.query.status; }
  else if (req.query.status === 'open') where.push(`v.status NOT IN ('completed','cancelled')`);
  const q = String(req.query.q || '').trim();
  if (q) { where.push(`(v.visit_no ILIKE @l ESCAPE '\\' OR p.patient_no ILIKE @l ESCAPE '\\' OR (p.first_name||' '||p.last_name) ILIKE @l ESCAPE '\\')`); bind.l = like(q); }
  const w = where.join(' AND ');
  const total = (await db.get(`SELECT COUNT(*) AS n FROM patient_visits v JOIN patients p ON p.id=v.patient_id WHERE ${w}`, bind)).n;
  const rows = await db.all(`SELECT v.id, v.visit_no, v.visit_date, v.created_at, v.status, p.id AS patient_id, p.patient_no, p.first_name, p.middle_name, p.last_name, p.suffix, d.name AS department,
    (SELECT string_agg(queue_number, ', ' ORDER BY id) FROM queue_entries e WHERE e.visit_id=v.id AND e.status IN ('waiting','called','serving')) AS active_queues
    FROM patient_visits v JOIN patients p ON p.id=v.patient_id LEFT JOIN departments d ON d.id=v.department_id WHERE ${w} ORDER BY v.id DESC LIMIT @per OFFSET @off`, { ...bind, per, off });
  res.json({ items: rows.map((r) => ({ ...r, patient_name: core.fullName(r) })), total, page: p, per });
}));
api.post('/visits', need('visits.create'), wrap(async (req, res) => { const r = await core.createVisit(req.ctx, req.body); res.status(201).json({ visit_id: r.visit.id, visit_no: r.visit.visit_no, entry: r.entry }); }));
api.get('/visits/:id', need('visits.view'), wrap(async (req, res) => res.json(await core.visitDetail(req.user, id(req.params.id)))));
api.get('/visits/:id/ticket', need('visits.view'), wrap(async (req, res) => {
  const v = await core.getVisit(id(req.params.id)); if (!v) fail(404, 'Visit not found');
  const p = await core.getPatient(v.patient_id); const s = await core.getSettings();
  const base = (s.public_base_url || `${req.protocol}://${req.get('host')}`).replace(/\/$/, ''); const url = `${base}/q/${v.token}`;
  const list = await core.entries(`WHERE e.visit_id=? AND e.status IN ('waiting','called','serving') AND e.deleted_at IS NULL ORDER BY e.created_at`, [v.id]);
  const out = []; for (const e of list) { const w = await core.waitInfo(e); out.push({ queue_number: e.queue_number, department: e.dept_name, counter: e.counter_name, ahead: w.ahead, wait_minutes: w.minutes, priority: e.priority_label }); }
  res.json({ hospital: s.hospital_name, visit_no: v.visit_no, patient_no: p.patient_no, patient_name: core.fullName(p), created_at: v.created_at, url, qr_svg: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }), entries: out });
}));
api.post('/visits/:id/route', need('route.send'), wrap(async (req, res) => res.json(await core.routeVisit(req.ctx, id(req.params.id), req.body))));
api.post('/visits/:id/cancel', need('visits.manage'), wrap(async (req, res) => res.json({ visit: await core.cancelVisit(req.ctx, id(req.params.id), clean(req.body.reason, 200)) })));
api.post('/visits/:id/complete', need('visits.manage', 'queue.consultation'), wrap(async (req, res) => res.json({ visit: await core.completeVisit(req.ctx, id(req.params.id)) })));

// ------------------------------------------------------------------ queues
api.get('/queue/overview', anyQueue, wrap(async (req, res) => {
  const rows = await db.all(`SELECT d.id, d.name, d.kind, d.queue_prefix, COUNT(e.id) FILTER (WHERE e.status='waiting') AS waiting, COUNT(e.id) FILTER (WHERE e.status IN ('called','serving')) AS serving,
    COUNT(e.id) FILTER (WHERE e.status='completed') AS completed, COUNT(e.id) AS total
    FROM departments d LEFT JOIN queue_entries e ON e.department_id=d.id AND e.queue_date=? AND e.deleted_at IS NULL
    WHERE d.active=1 AND d.deleted_at IS NULL GROUP BY d.id ORDER BY d.sort_order, d.id`, [core.localDate()]);
  res.json({ departments: rows.filter((d) => core.canView(req.user, d)).map((d) => ({ ...d, can_work: core.canWork(req.user, d) })) });
}));
api.get('/queue/department/:id', anyQueue, wrap(async (req, res) => res.json(await core.stationState(req.user, id(req.params.id)))));
api.post('/queue/call-next', anyQueue, wrap(async (req, res) => res.json({ entry: await core.callNext(req.ctx, { department_id: id(req.body.department_id), counter_id: req.body.counter_id ? id(req.body.counter_id) : null, doctor_id: req.body.doctor_id ? id(req.body.doctor_id) : null }) })));
const act = { recall: core.recall, start: core.startEntry, skip: core.skipEntry, 'no-show': core.noShow, requeue: core.requeue, 'undo-call': core.undoCall, complete: core.completeEntry };
for (const [name, fn] of Object.entries(act)) api.post(`/queue/:id/${name}`, anyQueue, wrap(async (req, res) => res.json({ entry: await fn(req.ctx, id(req.params.id)) })));
api.post('/queue/:id/cancel', anyQueue, wrap(async (req, res) => res.json({ entry: await core.cancelEntry(req.ctx, id(req.params.id), req.body.reason) })));
api.post('/queue/:id/priority', need('priority.change'), wrap(async (req, res) => res.json({ entry: await core.changePriority(req.ctx, id(req.params.id), id(req.body.rule_id), req.body.reason) })));
api.post('/lab/:id/specimen', need('queue.laboratory'), wrap(async (req, res) => res.json({ requests: await core.specimenCollected(req.ctx, id(req.params.id)) })));
api.post('/lab/:id/results-ready', need('queue.laboratory'), wrap(async (req, res) => res.json({ requests: await core.resultsReady(req.ctx, id(req.params.id), req.body.summary) })));
api.post('/billing/:id/pay', need('queue.cashier'), wrap(async (req, res) => res.json(await core.recordPayment(req.ctx, id(req.params.id), req.body))));
api.post('/billing/:id/adjust', need('queue.cashier'), wrap(async (req, res) => res.json({ entry: await core.adjustAmount(req.ctx, id(req.params.id), req.body.amount, req.body.reason) })));
api.post('/pharmacy/:id/status', need('queue.pharmacy'), wrap(async (req, res) => res.json({ entry: await core.setPrescription(req.ctx, id(req.params.id), String(req.body.status)) })));

// ------------------------------------------------------------------ search (permission aware)
api.get('/search', need('search.use'), wrap(async (req, res) => {
  const q = String(req.query.q || '').trim(); if (q.length < 2) return res.json({ patients: [], visits: [], queues: [] });
  const l = like(q); const u = req.user; const out = { patients: [], visits: [], queues: [] };
  if (u.perms.has('patients.view')) out.patients = (await db.all(`SELECT id, patient_no, first_name, middle_name, last_name, suffix, contact_no FROM patients p WHERE p.deleted_at IS NULL AND ${NAME_MATCH()} ORDER BY lower(last_name) LIMIT 8`, { l }))
    .map((p) => ({ id: p.id, patient_no: p.patient_no, name: core.fullName(p), contact_no: p.contact_no }));
  if (u.perms.has('visits.view')) out.visits = (await db.all(`SELECT v.id, v.visit_no, v.status, v.visit_date, p.first_name, p.middle_name, p.last_name, p.suffix, p.patient_no FROM patient_visits v JOIN patients p ON p.id=v.patient_id
    WHERE v.deleted_at IS NULL AND (v.visit_no ILIKE @l ESCAPE '\\' OR (p.first_name||' '||p.last_name) ILIKE @l ESCAPE '\\' OR p.patient_no ILIKE @l ESCAPE '\\') ORDER BY v.id DESC LIMIT 8`, { l }))
    .map((v) => ({ id: v.id, visit_no: v.visit_no, status: v.status, date: v.visit_date, patient_name: core.fullName(v), patient_no: v.patient_no }));
  out.queues = (await core.entries(`WHERE e.deleted_at IS NULL AND e.queue_number ILIKE ? ESCAPE '\\' ORDER BY e.id DESC LIMIT 20`, [l]))
    .filter((e) => core.canView(u, { id: e.department_id, kind: e.dept_kind })).slice(0, 8)
    .map((e) => ({ id: e.id, queue_number: e.queue_number, department: e.dept_name, status: e.status, date: e.queue_date, visit_id: e.visit_id, visit_no: e.visit_no, department_id: e.department_id, patient_name: u.perms.has('visits.view') ? e.patient_name : undefined }));
  res.json(out);
}));

// ------------------------------------------------------------------ reports
api.get('/reports', need('reports.view'), (req, res) => res.json({ reports: stats.reportList() }));
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? '"' + s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1") + '"' : s; };
api.get('/reports/:type.csv', need('reports.view'), wrap(async (req, res) => {
  const r = await stats.report(req.params.type, req.query);
  const csv = '\ufeff' + [r.columns.map((c) => csvCell(c.label)).join(','), ...r.rows.map((row) => r.columns.map((c) => csvCell(row[c.key])).join(','))].join('\r\n');
  await core.audit(req.ctx, 'report.exported', { entity: 'report', id: r.type, summary: `${req.user.full_name} exported "${r.title}" (CSV) ${r.from} to ${r.to}` });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="visiq-${r.type}-${r.from}_${r.to}.csv"` }).send(csv);
}));
api.get('/reports/:type.pdf', need('reports.view'), wrap(async (req, res) => {
  const r = await stats.report(req.params.type, req.query); const s = await core.getSettings();
  await core.audit(req.ctx, 'report.exported', { entity: 'report', id: r.type, summary: `${req.user.full_name} exported "${r.title}" (PDF) ${r.from} to ${r.to}` });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="visiq-${r.type}-${r.from}_${r.to}.pdf"` });
  const doc = new PDFDocument({ size: 'A4', margin: 40, layout: r.columns.length > 4 ? 'landscape' : 'portrait', bufferPages: true }); doc.pipe(res);
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#14243d').text(s.hospital_name); doc.font('Helvetica').fontSize(10).fillColor('#555').text('VisiQ - ' + s.hospital_tagline);
  doc.moveDown(0.8).font('Helvetica-Bold').fontSize(13).fillColor('#000').text(r.title); doc.font('Helvetica').fontSize(9).fillColor('#555').text(`${r.from === r.to ? r.from : r.from + ' to ' + r.to}  |  Printed ${new Date(core.nowMs() + core.TZ * 36e5).toISOString().slice(0, 16).replace('T', ' ')}`); doc.moveDown();
  const w = (doc.page.width - 80) / r.columns.length; const row = (cells, bold) => { if (doc.y > doc.page.height - 70) doc.addPage(); const yy = doc.y; doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#000');
    cells.forEach((c, i) => doc.text(String(c ?? ''), 40 + i * w, yy, { width: w - 6, ellipsis: true, lineBreak: false })); doc.y = yy + 16; if (bold) doc.moveTo(40, doc.y - 3).lineTo(doc.page.width - 40, doc.y - 3).strokeColor('#ccc').stroke(); };
  row(r.columns.map((c) => c.label), true);
  if (!r.rows.length) doc.fillColor('#777').text('No data for this period.'); else r.rows.forEach((x) => row(r.columns.map((c) => x[c.key]), false));
  const range = doc.bufferedPageRange(); for (let i = 0; i < range.count; i++) { doc.switchToPage(i); doc.font('Helvetica').fontSize(8).fillColor('#888').text('Created by JPD', 40, doc.page.height - 30, { lineBreak: false }); }
  doc.end();
}));
api.get('/reports/:type', need('reports.view'), wrap(async (req, res) => res.json(await stats.report(req.params.type, req.query))));

// ------------------------------------------------------------------ admin
const admin = express.Router();
admin.use(need('config.manage', 'users.manage', 'audit.view', 'display.manage'));

admin.get('/audit', need('audit.view'), wrap(async (req, res) => {
  const { p, per, off } = page(req, 25); const where = ['1=1']; const bind = {};
  const q = String(req.query.q || '').trim(); if (q) { where.push(`(summary ILIKE @l ESCAPE '\\' OR username ILIKE @l ESCAPE '\\')`); bind.l = like(q); }
  if (req.query.action) { where.push('action LIKE @a'); bind.a = String(req.query.action).replace(/[^a-z_.]/g, '') + '%'; }
  if (isDate(req.query.from)) { where.push(`${LOCAL('created_at')}::date >= @f::date`); bind.f = req.query.from; }
  if (isDate(req.query.to)) { where.push(`${LOCAL('created_at')}::date <= @t::date`); bind.t = req.query.to; }
  if (req.query.visit_id) { where.push('visit_id=@v'); bind.v = id(req.query.visit_id); }
  const w = where.join(' AND ');
  res.json({ total: (await db.get(`SELECT COUNT(*) AS n FROM audit_logs WHERE ${w}`, bind)).n, page: p, per, items: await db.all(`SELECT * FROM audit_logs WHERE ${w} ORDER BY id DESC LIMIT @per OFFSET @off`, { ...bind, per, off }) });
}));

// users: the password lives in Supabase Auth; VisiQ stores the profile and role
const USER_ROW = `SELECT u.id, u.username, u.email, u.full_name, u.active, u.last_login_at, u.department_id, u.counter_id, r.code AS role, r.name AS role_name FROM users u JOIN roles r ON r.id=u.role_id WHERE u.deleted_at IS NULL`;
admin.get('/users', need('users.manage'), wrap(async (req, res) => res.json({ users: await db.all(USER_ROW + ' ORDER BY u.full_name'), roles: await db.all('SELECT id, code, name, description FROM roles ORDER BY id') })));
admin.post('/users', need('users.manage'), wrap(async (req, res) => {
  const b = req.body; const username = clean(b.username, 30)?.toLowerCase(); const name = clean(b.full_name, 80);
  if (!username || !/^[a-z0-9._-]{3,30}$/.test(username)) fail(400, 'Username needs 3-30 letters or numbers (no spaces)'); if (!name) fail(400, 'Full name is required');
  auth.validatePassword(b.password);
  const role = await db.get('SELECT * FROM roles WHERE code=?', [String(b.role || '')]); if (!role) fail(400, 'Choose a role');
  if (await db.get('SELECT 1 AS x FROM users WHERE lower(username)=?', [username])) fail(409, 'That username is already taken');
  if (role.code === 'doctor' && !b.department_id) fail(400, "Choose the doctor's department");
  const email = authprovider.emailFor(username); let authId;
  try { authId = await authprovider.get().createUser(email, b.password); } catch (e) { throw authErr(e); }
  let uid;
  try {
    uid = await db.transaction(async () => {
      const newId = await db.insert('INSERT INTO users(auth_id,email,username,full_name,role_id,department_id,counter_id,created_at) VALUES(?,?,?,?,?,?,?,?)', [authId, email, username, name, role.id, b.department_id || null, b.counter_id || null, core.now()]);
      if (role.code === 'doctor') await db.run('INSERT INTO doctors(user_id,full_name,specialty,department_id,counter_id) VALUES(?,?,?,?,?)', [newId, name, clean(b.specialty, 80), b.department_id, b.counter_id || null]);
      await core.audit(req.ctx, 'user.created', { entity: 'user', id: newId, summary: `${req.user.full_name} created user ${username} (${role.name})` }); return newId;
    });
  } catch (e) { try { await authprovider.get().remove(authId); } catch { /* best effort */ } throw e; }
  res.status(201).json({ user: await db.get(USER_ROW + ' AND u.id=?', [uid]) });
}));
admin.patch('/users/:id', need('users.manage'), wrap(async (req, res) => {
  const uid = id(req.params.id); const u = await db.get(USER_ROW + ' AND u.id=?', [uid]); if (!u) fail(404, 'User not found'); const b = req.body;
  const role = b.role ? await db.get('SELECT * FROM roles WHERE code=?', [b.role]) : null; if (b.role && !role) fail(400, 'Unknown role');
  const active = b.active == null ? u.active : (b.active ? 1 : 0);
  if (uid === req.user.id && (!active || (role && role.code !== 'super_admin'))) fail(400, 'You cannot lock yourself out. Ask another administrator.');
  await db.transaction(async () => {
    await db.run('UPDATE users SET full_name=?, role_id=COALESCE(?,role_id), department_id=?, counter_id=?, active=?, failed_attempts=0, locked_until=NULL WHERE id=?', [clean(b.full_name, 80) || u.full_name, role?.id ?? null, b.department_id ?? u.department_id, b.counter_id ?? u.counter_id, active, uid]);
    const doc = await db.get('SELECT id FROM doctors WHERE user_id=?', [uid]);
    if (doc) await db.run('UPDATE doctors SET full_name=?, department_id=COALESCE(?,department_id), counter_id=?, active=? WHERE id=?', [clean(b.full_name, 80) || u.full_name, b.department_id || null, b.counter_id ?? null, active, doc.id]);
    await core.audit(req.ctx, 'user.updated', { entity: 'user', id: uid, summary: `${req.user.full_name} updated user ${u.username}`, prev: { role: u.role, active: u.active }, next: { role: role?.code || u.role, active } });
  });
  if (active !== u.active) { const a = await db.get('SELECT auth_id FROM users WHERE id=?', [uid]); if (a?.auth_id) { try { await authprovider.get().setActive(a.auth_id, !!active); } catch (e) { throw authErr(e); } } if (!active) await db.run('DELETE FROM sessions WHERE uid=?', [uid]); }
  res.json({ user: await db.get(USER_ROW + ' AND u.id=?', [uid]) });
}));
admin.post('/users/:id/reset-password', need('users.manage'), wrap(async (req, res) => {
  const uid = id(req.params.id); auth.validatePassword(req.body.password); const u = await db.get('SELECT username, auth_id, email FROM users WHERE id=? AND deleted_at IS NULL', [uid]); if (!u) fail(404, 'User not found');
  try { if (u.auth_id) await authprovider.get().setPassword(u.auth_id, req.body.password); else { const a = await authprovider.get().createUser(u.email, req.body.password, { overwrite: true }); await db.run('UPDATE users SET auth_id=? WHERE id=?', [a, uid]); } } catch (e) { throw authErr(e); }
  await db.run('UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=?', [uid]); await db.run('DELETE FROM sessions WHERE uid=?', [uid]);
  await core.audit(req.ctx, 'user.password_reset', { entity: 'user', id: uid, summary: `${req.user.full_name} reset the password for ${u.username}` }); res.json({ ok: true });
}));
admin.delete('/users/:id', need('users.manage'), wrap(async (req, res) => {
  const uid = id(req.params.id); if (uid === req.user.id) fail(400, 'You cannot remove your own account'); const u = await db.get('SELECT username, auth_id FROM users WHERE id=? AND deleted_at IS NULL', [uid]); if (!u) fail(404, 'User not found');
  await db.transaction(async () => { await db.run(`UPDATE users SET deleted_at=?, active=0, username=username||'~removed'||id, email='removed-'||id||'-'||email WHERE id=?`, [core.now(), uid]); await db.run('UPDATE doctors SET active=0 WHERE user_id=?', [uid]); await db.run('DELETE FROM sessions WHERE uid=?', [uid]);
    await core.audit(req.ctx, 'user.removed', { entity: 'user', id: uid, summary: `${req.user.full_name} removed user ${u.username}` }); });
  if (u.auth_id) { try { await authprovider.get().remove(u.auth_id); } catch { /* the profile is already disabled */ } }
  res.json({ ok: true });
}));

// roles and permissions
admin.get('/roles', need('users.manage'), wrap(async (req, res) => res.json({ permissions: Object.entries(PERMISSIONS).map(([code, description]) => ({ code, description })),
  roles: await Promise.all((await db.all('SELECT id, code, name, description FROM roles ORDER BY id')).map(async (r) => ({ ...r, perms: (await db.all('SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=?', [r.id])).map((x) => x.code) }))) })));
admin.put('/roles/:id/permissions', need('users.manage'), wrap(async (req, res) => {
  const r = await db.get('SELECT * FROM roles WHERE id=?', [id(req.params.id)]); if (!r) fail(404, 'Role not found'); if (r.code === 'super_admin') fail(400, 'The Super Administrator role always has full access');
  const codes = (req.body.perms || []).filter((c) => PERMISSIONS[c]); const before = (await db.all('SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=?', [r.id])).map((x) => x.code);
  await db.transaction(async () => { await db.run('DELETE FROM role_permissions WHERE role_id=?', [r.id]); for (const c of codes) await db.run('INSERT INTO role_permissions(role_id,permission_id) SELECT ?, id FROM permissions WHERE code=?', [r.id, c]);
    await core.audit(req.ctx, 'role.permissions_changed', { entity: 'role', id: r.id, summary: `${req.user.full_name} changed permissions for ${r.name}`, prev: before, next: codes }); });
  res.json({ ok: true });
}));

// departments, services, counters, doctors, priorities
const conf = need('config.manage'); const bool = (v, d = 1) => (v == null ? d : v ? 1 : 0);
const KINDS = ['consultation', 'laboratory', 'radiology', 'pharmacy', 'cashier', 'registration', 'records', 'billing', 'other'];
function deptBody(b, cur = {}) {
  const name = clean(b.name, 60) || cur.name; if (!name) fail(400, 'Department name is required');
  const kind = b.kind || cur.kind; if (!KINDS.includes(kind)) fail(400, 'Choose a department type');
  const prefix = String(b.queue_prefix ?? cur.queue_prefix ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); if (!prefix) fail(400, 'Queue prefix is required (letters or numbers, up to 6)');
  const avg = Math.min(240, Math.max(1, parseInt(b.avg_service_minutes ?? cur.avg_service_minutes ?? 10, 10) || 10));
  return { name, kind, prefix, avg, active: bool(b.active, cur.active ?? 1), show: bool(b.show_on_display, cur.show_on_display ?? 1), sort: parseInt(b.sort_order ?? cur.sort_order ?? 0, 10) || 0 };
}
admin.get('/departments', conf, wrap(async (req, res) => res.json({ departments: await db.all('SELECT * FROM departments WHERE deleted_at IS NULL ORDER BY sort_order, id'), services: await db.all('SELECT * FROM services WHERE deleted_at IS NULL ORDER BY department_id, name'),
  counters: await db.all('SELECT * FROM queue_counters WHERE deleted_at IS NULL ORDER BY department_id, id'), doctors: await db.all('SELECT * FROM doctors WHERE deleted_at IS NULL ORDER BY full_name'), kinds: KINDS })));
admin.post('/departments', conf, wrap(async (req, res) => { const d = deptBody(req.body); const code = (clean(req.body.code, 20) || d.name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (await db.get('SELECT 1 AS x FROM departments WHERE code=?', [code])) fail(409, 'A department with this name already exists');
  const nid = await db.insert('INSERT INTO departments(code,name,kind,queue_prefix,avg_service_minutes,active,show_on_display,sort_order) VALUES(?,?,?,?,?,?,?,?)', [code, d.name, d.kind, d.prefix, d.avg, d.active, d.show, d.sort]);
  await core.audit(req.ctx, 'department.created', { entity: 'department', id: nid, summary: `${req.user.full_name} added department ${d.name}` }); core.bus.emit('change', { all: true }); res.status(201).json({ id: nid }); }));
admin.patch('/departments/:id', conf, wrap(async (req, res) => { const cur = await core.getDept(id(req.params.id)); if (!cur) fail(404, 'Department not found'); const d = deptBody(req.body, cur);
  await db.run('UPDATE departments SET name=?, kind=?, queue_prefix=?, avg_service_minutes=?, active=?, show_on_display=?, sort_order=? WHERE id=?', [d.name, d.kind, d.prefix, d.avg, d.active, d.show, d.sort, cur.id]);
  await core.audit(req.ctx, 'department.updated', { entity: 'department', id: cur.id, summary: `${req.user.full_name} updated department ${d.name}`, prev: { prefix: cur.queue_prefix, active: cur.active, avg: cur.avg_service_minutes }, next: { prefix: d.prefix, active: d.active, avg: d.avg } }); core.bus.emit('change', { all: true }); res.json({ ok: true }); }));
admin.delete('/departments/:id', conf, wrap(async (req, res) => { const cur = await core.getDept(id(req.params.id)); if (!cur) fail(404, 'Department not found');
  if (await db.get(`SELECT 1 AS x FROM queue_entries WHERE department_id=? AND status IN ('waiting','called','serving')`, [cur.id])) fail(409, 'There are patients in this queue. Finish or cancel them first.');
  await db.run('UPDATE departments SET deleted_at=?, active=0 WHERE id=?', [core.now(), cur.id]); await core.audit(req.ctx, 'department.removed', { entity: 'department', id: cur.id, summary: `${req.user.full_name} removed department ${cur.name}` }); core.bus.emit('change', { all: true }); res.json({ ok: true }); }));
for (const [path, table, label] of [['services', 'services', 'service'], ['counters', 'queue_counters', 'counter or room']]) {
  admin.post(`/${path}`, conf, wrap(async (req, res) => { const b = req.body; const name = clean(b.name, 80); if (!name) fail(400, 'Name is required'); if (!(await core.getDept(id(b.department_id)))) fail(400, 'Choose a department');
    const nid = table === 'services' ? await db.insert('INSERT INTO services(department_id,name,price) VALUES(?,?,?)', [b.department_id, name, Math.max(0, Number(b.price) || 0)]) : await db.insert('INSERT INTO queue_counters(department_id,name) VALUES(?,?)', [b.department_id, name]);
    await core.audit(req.ctx, `${label.split(' ')[0]}.created`, { entity: table, id: nid, summary: `${req.user.full_name} added ${label} ${name}` }); res.status(201).json({ id: nid }); }));
  admin.patch(`/${path}/:id`, conf, wrap(async (req, res) => { const rid = id(req.params.id); const cur = await db.get(`SELECT * FROM ${table} WHERE id=? AND deleted_at IS NULL`, [rid]); if (!cur) fail(404, 'Not found'); const b = req.body;
    if (table === 'services') await db.run('UPDATE services SET name=?, price=?, active=? WHERE id=?', [clean(b.name, 80) || cur.name, b.price == null ? cur.price : Math.max(0, Number(b.price) || 0), bool(b.active, cur.active), rid]);
    else await db.run('UPDATE queue_counters SET name=?, active=? WHERE id=?', [clean(b.name, 80) || cur.name, bool(b.active, cur.active), rid]);
    await core.audit(req.ctx, `${label.split(' ')[0]}.updated`, { entity: table, id: rid, summary: `${req.user.full_name} updated ${label} ${cur.name}`, prev: { name: cur.name, price: cur.price, active: cur.active }, next: b }); core.bus.emit('change', { all: true }); res.json({ ok: true }); }));
  admin.delete(`/${path}/:id`, conf, wrap(async (req, res) => { const rid = id(req.params.id); const cur = await db.get(`SELECT * FROM ${table} WHERE id=? AND deleted_at IS NULL`, [rid]); if (!cur) fail(404, 'Not found');
    await db.run(`UPDATE ${table} SET deleted_at=?, active=0 WHERE id=?`, [core.now(), rid]); await core.audit(req.ctx, `${label.split(' ')[0]}.removed`, { entity: table, id: rid, summary: `${req.user.full_name} removed ${label} ${cur.name}` }); core.bus.emit('change', { all: true }); res.json({ ok: true }); }));
}
admin.patch('/doctors/:id', conf, wrap(async (req, res) => { const rid = id(req.params.id); const cur = await db.get('SELECT * FROM doctors WHERE id=? AND deleted_at IS NULL', [rid]); if (!cur) fail(404, 'Doctor not found'); const b = req.body;
  await db.run('UPDATE doctors SET specialty=?, counter_id=?, active=? WHERE id=?', [clean(b.specialty, 80) ?? cur.specialty, b.counter_id === undefined ? cur.counter_id : (b.counter_id || null), bool(b.active, cur.active), rid]);
  await core.audit(req.ctx, 'doctor.updated', { entity: 'doctor', id: rid, summary: `${req.user.full_name} updated ${cur.full_name}` }); core.bus.emit('change', { all: true }); res.json({ ok: true }); }));

admin.get('/priorities', conf, wrap(async (req, res) => res.json({ priorities: await db.all('SELECT * FROM priority_rules ORDER BY weight DESC, sort_order') })));
function ruleBody(b, cur = {}) { const label = clean(b.label, 40) || cur.label; if (!label) fail(400, 'Name is required'); const weight = Math.min(1000, Math.max(0, parseInt(b.weight ?? cur.weight ?? 0, 10) || 0));
  return { label, weight, req: bool(b.requires_reason, cur.requires_reason ?? 0), enabled: bool(b.enabled, cur.enabled ?? 1), desc: clean(b.description, 200) ?? cur.description ?? null }; }
admin.post('/priorities', conf, wrap(async (req, res) => { const r = ruleBody(req.body); const code = r.label.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (await db.get('SELECT 1 AS x FROM priority_rules WHERE code=?', [code])) fail(409, 'A priority with this name already exists');
  const nid = await db.insert('INSERT INTO priority_rules(code,label,weight,requires_reason,enabled,sort_order,description) VALUES(?,?,?,?,?,?,?)', [code, r.label, r.weight, r.req, r.enabled, 50, r.desc]);
  await core.audit(req.ctx, 'priority.created', { entity: 'priority_rule', id: nid, summary: `${req.user.full_name} added priority "${r.label}" (weight ${r.weight})` }); res.status(201).json({ id: nid }); }));
admin.patch('/priorities/:id', conf, wrap(async (req, res) => { const cur = await db.get('SELECT * FROM priority_rules WHERE id=?', [id(req.params.id)]); if (!cur) fail(404, 'Not found'); const r = ruleBody(req.body, cur);
  if (cur.code === 'regular' && !r.enabled) fail(400, 'The Regular priority cannot be turned off');
  await db.run('UPDATE priority_rules SET label=?, weight=?, requires_reason=?, enabled=?, description=? WHERE id=?', [r.label, r.weight, r.req, r.enabled, r.desc, cur.id]);
  await core.audit(req.ctx, 'priority.settings_changed', { entity: 'priority_rule', id: cur.id, summary: `${req.user.full_name} changed queue priority settings for "${cur.label}"`, prev: { weight: cur.weight, enabled: cur.enabled, requires_reason: cur.requires_reason }, next: { weight: r.weight, enabled: r.enabled, requires_reason: r.req } }); core.bus.emit('change', { all: true }); res.json({ ok: true }); }));

// Display operators may only change the voice announcement keys.
const VOICE_KEYS = ['voice_enabled', 'voice_volume', 'voice_repeat', 'voice_delay', 'voice_language'];
admin.get('/display', need('display.manage', 'config.manage'), wrap(async (req, res) => { const s = await core.getSettings(); res.json({ settings: Object.fromEntries(VOICE_KEYS.map((k) => [k, s[k]])) }); }));
admin.put('/display', need('display.manage', 'config.manage'), wrap(async (req, res) => {
  const b = {}; for (const k of VOICE_KEYS) if (req.body[k] != null) b[k] = req.body[k];
  const num = (k, lo, hi) => { if (b[k] != null && !(Number(b[k]) >= lo && Number(b[k]) <= hi)) fail(400, `${k.replace(/_/g, ' ')} must be between ${lo} and ${hi}`); };
  num('voice_volume', 0, 1); num('voice_repeat', 1, 5); num('voice_delay', 0, 30); if (b.voice_language != null && !/^[a-z]{2,3}-[A-Z]{2}$/.test(b.voice_language)) fail(400, 'Unknown language');
  const s = await core.setSettings(req.ctx, b); res.json({ settings: Object.fromEntries(VOICE_KEYS.map((k) => [k, s[k]])) });
}));
admin.get('/settings', conf, wrap(async (req, res) => { const s = { ...(await core.getSettings()) }; res.json({ settings: s }); }));
admin.put('/settings', conf, wrap(async (req, res) => {
  const b = req.body || {}; const num = (k, lo, hi) => { if (b[k] != null && !(Number(b[k]) >= lo && Number(b[k]) <= hi)) fail(400, `${k.replace(/_/g, ' ')} must be between ${lo} and ${hi}`); };
  num('queue_start_number', 1, 9999); num('queue_number_pad', 1, 6); num('voice_volume', 0, 1); num('voice_repeat', 1, 5); num('voice_delay', 0, 30); num('session_timeout_minutes', 1, 240); num('visit_expiry_hours', 1, 168); num('max_calls_before_no_show', 1, 10);
  if (b.queue_number_format != null && !/\{number\}/.test(b.queue_number_format)) fail(400, 'Queue number format must include {number}');
  if (b.queue_reset_schedule != null && !['daily', 'weekly', 'never'].includes(b.queue_reset_schedule)) fail(400, 'Choose daily, weekly or never');
  if (b.wait_calc != null && !['current_avg', 'historical', 'fixed'].includes(b.wait_calc)) fail(400, 'Unknown waiting-time method');
  res.json({ settings: await core.setSettings(req.ctx, b) });
}));
api.use('/admin', admin);

// ------------------------------------------------------------------ public (no sign-in): numbers only
const pub = express.Router(); let displayCache = { at: 0, data: null, pending: null };
core.bus.on('change', () => { displayCache.at = 0; });
pub.get('/display', wrap(async (req, res) => {
  if (Date.now() - displayCache.at > 1000 || !displayCache.data) { displayCache.pending ||= core.displayState().finally(() => { displayCache.pending = null; }); displayCache = { ...displayCache, data: await displayCache.pending, at: Date.now() }; }
  res.json(displayCache.data);
}));
pub.get('/visit/:token/qr.svg', wrap(async (req, res) => { const v = await db.get('SELECT token FROM patient_visits WHERE token=? AND deleted_at IS NULL', [String(req.params.token).slice(0, 64)]); if (!v) return res.status(404).end(); const base = ((await core.getSettings()).public_base_url || `${req.protocol}://${req.get('host')}`).replace(/\/$/, ''); res.type('image/svg+xml').send(await QRCode.toString(`${base}/q/${v.token}`, { type: 'svg', margin: 1 })); }));
pub.get('/visit/:token', wrap(async (req, res) => { const v = await core.publicVisit(req.params.token); if (!v) return res.status(404).json({ error: 'This link is not valid. Please ask the reception desk for a new QR code.', code: 'invalid' }); if (v.expired) return res.status(410).json({ error: 'This visit link has expired. Please ask the reception desk if you need help.', code: 'expired' }); res.json(v); }));

module.exports = { api, pub };
