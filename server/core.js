// VisiQ core: everything that changes queue state lives here, inside database transactions.
// Routes stay thin; this file is where the Patient -> Visit -> Service -> Queue logic is enforced.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const db = require('./db');
const { KIND_PERMISSION, ROUTE_TARGETS, PAYMENT_METHODS } = require('./perms');

const bus = new EventEmitter();
const ZONE = 'Asia/Manila'; // Philippines: UTC+8, no daylight saving
const TZ = 8;
const LOCAL = (col) => `(${col} AT TIME ZONE '${ZONE}')`;
const clock = { offset: 0 }; // only the demo seeder moves this, to replay a realistic morning
const nowMs = () => Date.now() + clock.offset;
const setClockOffset = (ms) => { clock.offset = ms; };
const now = () => new Date(nowMs()).toISOString();
const localDate = (d = new Date(nowMs())) => new Date(d.getTime() + TZ * 36e5).toISOString().slice(0, 10);
const localDayStartUtc = () => new Date(Date.parse(localDate() + 'T00:00:00Z') - TZ * 36e5).toISOString();
const minutesAgo = (m) => new Date(nowMs() - m * 6e4).toISOString();
const daysAgoIso = (d) => new Date(nowMs() - d * 864e5).toISOString();
const mins = (a, b) => `(EXTRACT(EPOCH FROM (${b} - ${a})) / 60)`;

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

const ACTIVE = ['waiting', 'called', 'serving'];
const clean = (s, max = 200) => (s == null ? null : String(s).trim().slice(0, max) || null);

// ---------------------------------------------------------------- settings (cached for a few seconds)
const DEFAULTS = {
  hospital_name: 'Sugbo Medical Center', hospital_tagline: 'Integrated Hospital Visit & Queue Management', hospital_logo: '',
  queue_start_number: '1', queue_number_pad: '3', queue_number_format: '{prefix}-{number}', queue_reset_schedule: 'daily',
  wait_calc: 'current_avg', display_show_names: '0',
  voice_enabled: '1', voice_volume: '0.9', voice_repeat: '2', voice_delay: '3', voice_language: 'en-PH',
  auto_lab_to_cashier: '1', auto_cashier_to_pharmacy: '1',
  session_timeout_minutes: '20', visit_expiry_hours: '24', max_calls_before_no_show: '3', public_base_url: '',
};
let settingsCache = { at: 0, data: null };
async function getSettings() {
  if (settingsCache.data && Date.now() - settingsCache.at < 5000) return settingsCache.data;
  const out = { ...DEFAULTS };
  for (const r of await db.all('SELECT key, value FROM settings')) out[r.key] = r.value;
  settingsCache = { at: Date.now(), data: out }; return out;
}
async function setSettings(ctx, patch) {
  settingsCache.at = 0; const prev = await getSettings(); const changed = {}; const was = {};
  await db.transaction(async () => {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULTS)) continue;
      const val = String(v ?? '').slice(0, k === 'hospital_logo' ? 200000 : 300);
      if (val !== prev[k]) { await db.run('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at', [k, val, now()]); changed[k] = k === 'hospital_logo' ? '(logo updated)' : val; was[k] = k === 'hospital_logo' ? '' : prev[k]; }
    }
    if (Object.keys(changed).length) await audit(ctx, 'settings.changed', { entity: 'settings', summary: 'Changed settings: ' + Object.keys(changed).join(', '), prev: was, next: changed });
  });
  settingsCache.at = 0; bus.emit('change', { all: true });
  return getSettings();
}

// ---------------------------------------------------------------- audit + notifications
async function audit(ctx, action, o = {}) {
  await db.run(`INSERT INTO audit_logs(user_id,username,role,action,entity_type,entity_id,patient_id,visit_id,summary,prev_value,new_value,ip,user_agent,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    ctx?.user?.id ?? null, ctx?.user?.username ?? null, ctx?.user?.role ?? null, action, o.entity ?? null,
    o.id != null ? String(o.id) : null, o.patient_id ?? null, o.visit_id ?? null, o.summary,
    o.prev != null ? JSON.stringify(o.prev) : null, o.next != null ? JSON.stringify(o.next) : null,
    ctx?.ip ?? null, (ctx?.ua || '').slice(0, 200), now()]);
}
async function notify(userIds, title, body, visitId = null) {
  for (const id of new Set(userIds.filter(Boolean))) await db.run('INSERT INTO notifications(user_id,title,body,visit_id,created_at) VALUES(?,?,?,?,?)', [id, title, body, visitId, now()]);
}

// ---------------------------------------------------------------- lookups
const getDept = (id) => db.get('SELECT * FROM departments WHERE id=? AND deleted_at IS NULL', [id]);
const getVisit = (id) => db.get('SELECT * FROM patient_visits WHERE id=? AND deleted_at IS NULL', [id]);
const getPatient = (id) => db.get('SELECT * FROM patients WHERE id=? AND deleted_at IS NULL', [id]);
const fullName = (p) => [p.first_name, p.middle_name, p.last_name, p.suffix].filter(Boolean).join(' ');
const ageOf = (birth) => { const b = new Date(birth), n = new Date(nowMs() + TZ * 36e5); let a = n.getUTCFullYear() - b.getUTCFullYear(); const m = n.getUTCMonth() - b.getUTCMonth(); if (m < 0 || (m === 0 && n.getUTCDate() < b.getUTCDate())) a--; return a; };

const ENTRY_SQL = `SELECT e.*, d.name AS dept_name, d.kind AS dept_kind, d.queue_prefix, s.name AS service_name, c.name AS counter_name,
  p.patient_no, p.first_name, p.middle_name, p.last_name, p.suffix, p.birth_date, p.sex, p.patient_type,
  v.visit_no, v.token, v.reason, v.status AS visit_status, pr.label AS priority_label, doc.full_name AS doctor_name, u.full_name AS staff_name
  FROM queue_entries e JOIN departments d ON d.id=e.department_id LEFT JOIN services s ON s.id=e.service_id
  LEFT JOIN queue_counters c ON c.id=e.counter_id JOIN patients p ON p.id=e.patient_id JOIN patient_visits v ON v.id=e.visit_id
  LEFT JOIN priority_rules pr ON pr.id=e.priority_rule_id LEFT JOIN doctors doc ON doc.id=e.doctor_id LEFT JOIN users u ON u.id=e.staff_user_id`;
function decorate(e) { if (!e) return e; e.patient_name = fullName(e); e.age = ageOf(e.birth_date); return e; }
const getEntry = async (id) => decorate(await db.get(ENTRY_SQL + ' WHERE e.id=? AND e.deleted_at IS NULL', [id]));
const entries = async (where, params) => (await db.all(ENTRY_SQL + ' ' + where, params)).map(decorate);

// ---------------------------------------------------------------- access helpers
const canWork = (user, dept) => {
  const perm = KIND_PERMISSION[dept.kind];
  if (user.perms.has('config.manage')) return true;
  if (!perm || !user.perms.has(perm)) return false;
  if (dept.kind === 'consultation' && user.doctor) return user.doctor.department_id === dept.id;
  return true;
};
const canView = (user, dept) => user.perms.has('queue.view') || canWork(user, dept);
function assertWork(user, dept) { if (!dept) fail(404, 'Department not found'); if (!canWork(user, dept)) fail(403, 'You are not allowed to manage this queue'); }
async function assertEntryAccess(user, entry) {
  const dept = await getDept(entry.department_id); assertWork(user, dept);
  if (dept.kind === 'consultation' && user.doctor && entry.doctor_id && entry.doctor_id !== user.doctor.id) fail(403, 'This patient is assigned to another doctor');
  return dept;
}

// ---------------------------------------------------------------- numbering (atomic: safe when many staff register at once)
async function periodKey() {
  const mode = (await getSettings()).queue_reset_schedule;
  if (mode === 'never') return 'all';
  const d = localDate();
  if (mode === 'weekly') { const dt = new Date(d + 'T00:00:00Z'); const back = (dt.getUTCDay() + 6) % 7; return new Date(dt.getTime() - back * 864e5).toISOString().slice(0, 10); }
  return d;
}
async function nextQueueNumber(dept) {
  const s = await getSettings(); const period = await periodKey();
  const start = Math.max(1, parseInt(s.queue_start_number, 10) || 1);
  const r = await db.get(`INSERT INTO queue_sequences(department_id,period,last_number) VALUES(?,?,?)
    ON CONFLICT(department_id,period) DO UPDATE SET last_number = queue_sequences.last_number + 1 RETURNING last_number`, [dept.id, period, start]);
  const pad = Math.min(6, Math.max(1, parseInt(s.queue_number_pad, 10) || 3));
  return (s.queue_number_format || '{prefix}-{number}').replace('{prefix}', dept.queue_prefix).replace('{number}', String(r.last_number).padStart(pad, '0'));
}
async function bumpCounter(name) { return (await db.get(`INSERT INTO counters(name,last_number) VALUES(?,1) ON CONFLICT(name) DO UPDATE SET last_number = counters.last_number + 1 RETURNING last_number`, [name])).last_number; }
const yearNow = () => new Date(nowMs() + TZ * 36e5).getUTCFullYear();
async function nextPatientNo() { const y = yearNow(); return `P-${y}-${String(await bumpCounter('patient-' + y)).padStart(5, '0')}`; }
async function nextVisitNo() { const y = yearNow(); return `VISIT-${y}-${String(await bumpCounter('visit-' + y)).padStart(5, '0')}`; }

// ---------------------------------------------------------------- waiting time estimate
async function avgServiceMinutes(dept) {
  const mode = (await getSettings()).wait_calc;
  if (mode === 'fixed') return dept.avg_service_minutes;
  const q = (since) => db.get(`SELECT AVG(${mins('started_at', 'completed_at')}) AS a, COUNT(*) AS n FROM queue_entries
    WHERE department_id=? AND status='completed' AND started_at IS NOT NULL AND completed_at>=?
    AND ${mins('started_at', 'completed_at')} BETWEEN 0.5 AND 120`, [dept.id, since]);
  if (mode !== 'historical') { const t = await q(localDayStartUtc()); if (t.n >= 3) return Math.round(t.a * 10) / 10; }
  const h = await q(daysAgoIso(14)); if (h.n >= 3) return Math.round(h.a * 10) / 10;
  return dept.avg_service_minutes;
}
async function activeServers(deptId) {
  const r = await db.get(`SELECT COUNT(DISTINCT counter_id) AS n FROM queue_entries WHERE department_id=? AND queue_date=? AND counter_id IS NOT NULL
    AND (status IN ('called','serving') OR completed_at>=?)`, [deptId, localDate(), minutesAgo(30)]);
  return Math.max(1, r.n);
}
async function waitInfo(e, cache = {}) {
  if (e.status !== 'waiting') return { ahead: 0, avg: null, minutes: 0 };
  const ahead = (await db.get(`SELECT COUNT(*) AS n FROM queue_entries q WHERE q.department_id=? AND q.queue_date=? AND q.status='waiting' AND q.deleted_at IS NULL
    AND (q.priority_weight>? OR (q.priority_weight=? AND (q.queued_at<? OR (q.queued_at=? AND q.id<?))))
    AND (?::int IS NULL OR q.doctor_id IS NULL OR q.doctor_id=?)`, [e.department_id, e.queue_date, e.priority_weight, e.priority_weight, e.queued_at, e.queued_at, e.id, e.doctor_id, e.doctor_id])).n;
  const k = 'd' + e.department_id;
  if (!cache[k]) cache[k] = { avg: await avgServiceMinutes(await getDept(e.department_id)), servers: await activeServers(e.department_id) };
  const { avg, servers } = cache[k];
  return { ahead, avg, minutes: Math.round((ahead * avg) / servers) };
}

// ---------------------------------------------------------------- visit status + journey
async function refreshVisit(visitId, { final = false } = {}) {
  const v = await getVisit(visitId);
  if (!v || v.status === 'completed' || v.status === 'cancelled') return v;
  const rows = await db.all(`SELECT status, COUNT(*) AS n FROM queue_entries WHERE visit_id=? AND deleted_at IS NULL AND status IN ('called','serving','waiting','completed') GROUP BY status`, [visitId]);
  const n = (s) => rows.find((r) => r.status === s)?.n || 0;
  const busy = n('called') + n('serving'), waiting = n('waiting'), done = n('completed');
  let status;
  if (busy) status = 'in_service'; else if (waiting) status = done ? 'waiting_next' : 'waiting'; else status = final ? 'completed' : 'waiting_next';
  if (status !== v.status) await db.run('UPDATE patient_visits SET status=?, completed_at=? WHERE id=?', [status, status === 'completed' ? now() : null, visitId]);
  return getVisit(visitId);
}
async function journey(visitId) {
  const v = await getVisit(visitId);
  const list = await entries('WHERE e.visit_id=? AND e.deleted_at IS NULL ORDER BY e.created_at, e.id', [visitId]);
  const steps = [{ key: 'registration', label: 'Registration', state: 'done', time: v.created_at }];
  const cache = {};
  for (const e of list) {
    const w = await waitInfo(e, cache);
    const state = e.status === 'completed' ? 'done' : ACTIVE.includes(e.status) ? 'active' : e.status;
    steps.push({ entry_id: e.id, key: e.dept_kind, label: e.dept_name, service: e.service_name, queue_number: e.queue_number, status: e.status, state,
      ahead: w.ahead, wait_minutes: w.minutes, counter: e.counter_name, time: e.completed_at || e.called_at || e.created_at });
  }
  if (!['completed', 'cancelled'].includes(v.status)) {
    const have = new Set(list.filter((e) => e.status !== 'cancelled').map((e) => e.dept_kind));
    const heldRx = await db.get(`SELECT 1 AS x FROM prescriptions WHERE visit_id=? AND queue_entry_id IS NULL AND status='pending'`, [visitId]);
    for (const kind of ['cashier', 'pharmacy']) {
      if (have.has(kind)) continue;
      const d = await db.get(`SELECT name FROM departments WHERE kind=? AND active=1 AND deleted_at IS NULL ORDER BY sort_order LIMIT 1`, [kind]);
      if (d) steps.push({ key: kind, label: d.name, state: 'upcoming', note: kind === 'pharmacy' && heldRx ? 'After payment at the cashier' : 'If needed' });
    }
  }
  return steps;
}

// ---------------------------------------------------------------- priority
async function suggestPriority(patient, today = localDate()) {
  const rules = await db.all('SELECT * FROM priority_rules WHERE enabled=1');
  const by = (code) => rules.find((r) => r.code === code);
  if (patient.patient_type === 'PWD' && by('pwd')) return { rule: by('pwd'), reason: 'Patient type is PWD' };
  if (patient.patient_type === 'Pregnant' && by('pregnant')) return { rule: by('pregnant'), reason: 'Patient type is Pregnant' };
  if ((patient.patient_type === 'Senior Citizen' || ageOf(patient.birth_date) >= 60) && by('senior')) return { rule: by('senior'), reason: `Senior citizen (age ${ageOf(patient.birth_date)})` };
  const appt = await db.get(`SELECT 1 AS x FROM appointments WHERE patient_id=? AND status='scheduled' AND ${LOCAL('scheduled_at')}::date=?`, [patient.id, today]);
  if (appt && by('appointment')) return { rule: by('appointment'), reason: 'Has a scheduled appointment today' };
  return { rule: by('regular') || rules[0], reason: null };
}

// ---------------------------------------------------------------- creating queue entries
const actor = (ctx) => (ctx?.user ? ctx.user.full_name : 'System');
async function createEntry(ctx, o) {
  const v = await getVisit(o.visit_id); if (!v) fail(404, 'Visit not found');
  if (v.status === 'completed' || v.status === 'cancelled') fail(409, `This visit is already ${v.status}`);
  if (new Date(v.expires_at) < new Date(nowMs())) fail(409, 'This visit has expired. Please create a new visit.');
  const dept = await getDept(o.department_id);
  if (!dept || !dept.active) fail(400, 'That department is not available right now');
  const dup = await db.get(`SELECT id FROM queue_entries WHERE visit_id=? AND department_id=? AND status IN ('waiting','called','serving') AND deleted_at IS NULL`, [v.id, dept.id]);
  if (dup) return { entry: await getEntry(dup.id), duplicate: true };

  let rule = o.priority_rule_id ? await db.get('SELECT * FROM priority_rules WHERE id=? AND enabled=1', [o.priority_rule_id]) : null;
  if (!rule) rule = await db.get(`SELECT * FROM priority_rules WHERE code='regular'`);
  const reason = clean(o.priority_reason, 300);
  if (rule.requires_reason && !reason) fail(400, `Please write the reason for "${rule.label}" priority`);

  const number = await nextQueueNumber(dept); const t = now();
  const id = await db.insert(`INSERT INTO queue_entries(queue_number,queue_date,department_id,service_id,visit_id,patient_id,doctor_id,priority_rule_id,priority_weight,priority_reason,
    status,amount,notes,created_at,queued_at,created_by,source_entry_id) VALUES(?,?,?,?,?,?,?,?,?,?, 'waiting', ?,?,?,?,?,?)`,
  [number, localDate(), dept.id, o.service_id ?? null, v.id, v.patient_id, o.doctor_id ?? null, rule.id, rule.weight, reason, o.amount || 0, clean(o.notes, 300), t, t, ctx?.user?.id ?? null, o.source_entry_id ?? null]);
  const entry = await getEntry(id);
  await audit(ctx, 'queue.created', { entity: 'queue_entry', id: entry.id, patient_id: v.patient_id, visit_id: v.id,
    summary: `${actor(ctx)} created ${number} (${dept.name}) for ${v.visit_no}. Priority: ${rule.label}${reason ? ' - ' + reason : ''}`,
    next: { queue_number: number, priority: rule.label, priority_reason: reason } });
  await refreshVisit(v.id);
  bus.emit('change', { depts: [dept.id], visit: v.id });
  return { entry, duplicate: false };
}

// ---------------------------------------------------------------- patients and visits
const publicPatient = (p) => ({ id: p.id, patient_no: p.patient_no, name: fullName(p), first_name: p.first_name, middle_name: p.middle_name, last_name: p.last_name, suffix: p.suffix,
  birth_date: p.birth_date, age: ageOf(p.birth_date), sex: p.sex, contact_no: p.contact_no, address: p.address, patient_type: p.patient_type,
  emergency_contact_name: p.emergency_contact_name, emergency_contact_no: p.emergency_contact_no });
async function findDuplicates({ first_name, last_name, birth_date, contact_no }) {
  const a = /^\d{4}-\d{2}-\d{2}$/.test(birth_date || '') ? await db.all(`SELECT * FROM patients WHERE deleted_at IS NULL AND lower(first_name)=lower(?) AND lower(last_name)=lower(?) AND birth_date=?`, [first_name, last_name, birth_date]) : [];
  const b = contact_no ? await db.all(`SELECT * FROM patients WHERE deleted_at IS NULL AND contact_no=? AND lower(last_name)=lower(?)`, [contact_no, last_name]) : [];
  const seen = new Set(); return [...a, ...b].filter((p) => !seen.has(p.id) && seen.add(p.id));
}
async function registerPatient(ctx, b) {
  const first = clean(b.first_name, 60), last = clean(b.last_name, 60);
  if (!first || !last) fail(400, 'First name and last name are required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.birth_date || '') || new Date(b.birth_date) > new Date(nowMs()) || isNaN(new Date(b.birth_date))) fail(400, 'Enter a valid date of birth');
  if (!['Male', 'Female'].includes(b.sex)) fail(400, 'Choose Male or Female');
  const contact = clean(b.contact_no, 20);
  if (contact && !/^[0-9+\-\s()]{7,20}$/.test(contact)) fail(400, 'Contact number should only have digits, spaces, + or -');
  const type = ['Regular', 'Senior Citizen', 'PWD', 'Pregnant'].includes(b.patient_type) ? b.patient_type : 'Regular';
  return db.transaction(async () => {
    const matches = await findDuplicates({ first_name: first, last_name: last, birth_date: b.birth_date, contact_no: contact });
    if (matches.length && !b.confirm_new) fail(409, 'Patient Found', { matches: matches.map(publicPatient) });
    const no = await nextPatientNo();
    const id = await db.insert(`INSERT INTO patients(patient_no,first_name,middle_name,last_name,suffix,birth_date,sex,contact_no,address,emergency_contact_name,emergency_contact_no,patient_type,created_at,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [no, first, clean(b.middle_name, 60), last, clean(b.suffix, 10), b.birth_date, b.sex, contact, clean(b.address, 250), clean(b.emergency_contact_name, 100), clean(b.emergency_contact_no, 20), type, now(), ctx.user.id]);
    const p = await getPatient(id);
    await audit(ctx, 'patient.registered', { entity: 'patient', id: p.id, patient_id: p.id, summary: `${actor(ctx)} registered patient ${no} (${fullName(p)})`, next: { patient_no: no } });
    return p;
  });
}

async function createVisit(ctx, b) {
  return db.transaction(async () => {
    const p = await getPatient(b.patient_id); if (!p) fail(404, 'Patient not found');
    await db.get('SELECT id FROM patients WHERE id=? FOR UPDATE', [p.id]); // serialises two receptionists opening a visit for the same patient
    const dept = await getDept(b.department_id);
    if (!dept || !dept.active || dept.kind !== 'consultation') fail(400, 'Choose a consultation department such as Internal Medicine');
    const open = await db.get(`SELECT id, visit_no FROM patient_visits WHERE patient_id=? AND visit_date=? AND status NOT IN ('completed','cancelled') AND deleted_at IS NULL`, [p.id, localDate()]);
    if (open) fail(409, `${fullName(p)} already has an open visit today (${open.visit_no})`, { visit_id: open.id, visit_no: open.visit_no });
    let doctorId = null;
    if (b.doctor_id) { const d = await db.get('SELECT * FROM doctors WHERE id=? AND department_id=? AND active=1 AND deleted_at IS NULL', [b.doctor_id, dept.id]); if (!d) fail(400, 'That doctor is not in this department'); doctorId = d.id; }
    const s = await getSettings(); const t = now();
    const vid = await db.insert(`INSERT INTO patient_visits(visit_no,patient_id,token,visit_date,created_at,reason,doctor_id,department_id,status,expires_at,created_by)
      VALUES(?,?,?,?,?,?,?,?, 'waiting', ?,?)`, [await nextVisitNo(), p.id, crypto.randomBytes(18).toString('base64url'), localDate(), t, clean(b.reason, 300), doctorId, dept.id,
      new Date(nowMs() + (parseInt(s.visit_expiry_hours, 10) || 24) * 36e5).toISOString(), ctx.user.id]);
    const visit = await getVisit(vid);
    await audit(ctx, 'visit.created', { entity: 'visit', id: visit.id, patient_id: p.id, visit_id: visit.id, summary: `${actor(ctx)} created ${visit.visit_no} for ${fullName(p)} (${dept.name})` });
    const svc = await db.get('SELECT * FROM services WHERE department_id=? AND active=1 AND deleted_at IS NULL ORDER BY id LIMIT 1', [dept.id]);
    const sug = await suggestPriority(p);
    const ruleId = b.priority_rule_id || sug.rule.id;
    const reason = b.priority_rule_id ? b.priority_reason : (b.priority_reason || sug.reason);
    const { entry } = await createEntry(ctx, { visit_id: visit.id, department_id: dept.id, service_id: svc?.id, doctor_id: doctorId, priority_rule_id: ruleId, priority_reason: reason, amount: svc?.price || 0 });
    await db.run(`UPDATE appointments SET status='arrived' WHERE patient_id=? AND status='scheduled' AND ${LOCAL('scheduled_at')}::date=?`, [p.id, localDate()]);
    return { visit: await getVisit(vid), entry };
  });
}

async function cancelVisit(ctx, visitId, reason) {
  return db.transaction(async () => {
    const v = await getVisit(visitId); if (!v) fail(404, 'Visit not found');
    if (v.status === 'completed' || v.status === 'cancelled') fail(409, `This visit is already ${v.status}`);
    const rows = await db.all(`SELECT id, department_id FROM queue_entries WHERE visit_id=? AND status IN ('waiting','called','serving','skipped') AND deleted_at IS NULL`, [visitId]);
    await db.run(`UPDATE queue_entries SET status='cancelled', completed_at=? WHERE visit_id=? AND status IN ('waiting','called','serving','skipped') AND deleted_at IS NULL`, [now(), visitId]);
    await db.run(`UPDATE patient_visits SET status='cancelled', completed_at=? WHERE id=?`, [now(), visitId]);
    await db.run(`UPDATE prescriptions SET status='cancelled', updated_at=? WHERE visit_id=? AND status IN ('pending','preparing','ready')`, [now(), visitId]);
    await audit(ctx, 'visit.cancelled', { entity: 'visit', id: v.id, patient_id: v.patient_id, visit_id: v.id, summary: `${actor(ctx)} cancelled ${v.visit_no}${reason ? ': ' + reason : ''}`, prev: { status: v.status }, next: { status: 'cancelled' } });
    bus.emit('change', { depts: rows.map((r) => r.department_id), visit: v.id });
    return getVisit(visitId);
  });
}
async function completeVisit(ctx, visitId) {
  return db.transaction(async () => {
    const v = await getVisit(visitId); if (!v) fail(404, 'Visit not found');
    if (v.status === 'completed' || v.status === 'cancelled') fail(409, `This visit is already ${v.status}`);
    const act = await db.all(`SELECT queue_number FROM queue_entries WHERE visit_id=? AND status IN ('waiting','called','serving') AND deleted_at IS NULL`, [visitId]);
    if (act.length) fail(409, `Still in queue: ${act.map((a) => a.queue_number).join(', ')}. Complete or cancel those first.`);
    const r = await refreshVisit(visitId, { final: true });
    await audit(ctx, 'visit.completed', { entity: 'visit', id: v.id, patient_id: v.patient_id, visit_id: v.id, summary: `${actor(ctx)} completed ${v.visit_no}`, prev: { status: v.status }, next: { status: 'completed' } });
    bus.emit('change', { visit: v.id });
    return r;
  });
}

// ---------------------------------------------------------------- station actions
async function pickCounter(user, dept, wanted) {
  const ok = async (id) => (id ? (await db.get('SELECT id FROM queue_counters WHERE id=? AND department_id=? AND active=1 AND deleted_at IS NULL', [id, dept.id]))?.id : null);
  const chosen = (await ok(wanted)) || (await ok(user.counter_id)) || (await ok(user.doctor?.counter_id));
  if (chosen) return chosen;
  const free = await db.get(`SELECT c.id FROM queue_counters c WHERE c.department_id=? AND c.active=1 AND c.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM queue_entries e WHERE e.counter_id=c.id AND e.status IN ('called','serving')) ORDER BY c.id LIMIT 1`, [dept.id]);
  return free?.id ?? null;
}
const announce = (entry) => bus.emit('announce', { id: entry.id, number: entry.queue_number, n: entry.call_count, counter: entry.counter_name || null, dept: entry.dept_name, dept_id: entry.department_id });

async function callNext(ctx, { department_id, counter_id, doctor_id }) {
  return db.transaction(async () => {
    const dept = await getDept(department_id); assertWork(ctx.user, dept);
    await db.get('SELECT id FROM users WHERE id=? FOR UPDATE', [ctx.user.id]); // one call at a time per staff member (double-clicks)
    const doctor = ctx.user.doctor ? ctx.user.doctor.id : (doctor_id || null);
    const mine = await db.get(`SELECT id FROM queue_entries WHERE staff_user_id=? AND department_id=? AND status IN ('called','serving') AND deleted_at IS NULL`, [ctx.user.id, dept.id]);
    if (mine) fail(409, 'Finish or skip your current patient first', { entry: await getEntry(mine.id) });
    // SKIP LOCKED: if two staff press CALL NEXT together, each gets a different patient. Nobody is called twice.
    const next = await db.get(`SELECT id FROM queue_entries WHERE department_id=? AND queue_date=? AND status='waiting' AND deleted_at IS NULL
      AND (?::int IS NULL OR doctor_id IS NULL OR doctor_id=?) ORDER BY priority_weight DESC, queued_at ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED`, [dept.id, localDate(), doctor, doctor]);
    if (!next) fail(404, 'No patients are waiting');
    const counter = await pickCounter(ctx.user, dept, counter_id);
    const r = await db.run(`UPDATE queue_entries SET status='called', called_at=?, call_count=1, counter_id=?, staff_user_id=?, doctor_id=COALESCE(doctor_id,?) WHERE id=? AND status='waiting'`, [now(), counter, ctx.user.id, doctor, next.id]);
    if (!r.changes) fail(409, 'That number was just called by someone else. Please try again.');
    const e = await getEntry(next.id);
    await audit(ctx, 'queue.called', { entity: 'queue_entry', id: e.id, patient_id: e.patient_id, visit_id: e.visit_id, summary: `${actor(ctx)} called ${e.queue_number}${e.counter_name ? ' to ' + e.counter_name : ''}`, prev: { status: 'waiting' }, next: { status: 'called' } });
    await refreshVisit(e.visit_id); announce(e); bus.emit('change', { depts: [dept.id], visit: e.visit_id });
    return e;
  });
}

const label = (s) => ({ no_show: 'marked no-show' }[s] || s);
async function transition(ctx, id, { from, to, action, verb, past, set = {}, after }) {
  return db.transaction(async () => {
    await db.get('SELECT id FROM queue_entries WHERE id=? FOR UPDATE', [id]);
    const e = await getEntry(id); if (!e) fail(404, 'Queue number not found');
    await assertEntryAccess(ctx.user, e);
    if (!from.includes(e.status)) fail(409, `${e.queue_number} is ${label(e.status)}, so you cannot ${verb} it`, { entry: e });
    const cols = { status: to, ...set }; const keys = Object.keys(cols);
    const r = await db.run(`UPDATE queue_entries SET ${keys.map((k) => k + '=?').join(',')} WHERE id=? AND status=?`, [...keys.map((k) => cols[k]), id, e.status]);
    if (!r.changes) fail(409, 'Someone else just changed this queue number. Please check the screen.');
    const n = await getEntry(id);
    await audit(ctx, action, { entity: 'queue_entry', id, patient_id: n.patient_id, visit_id: n.visit_id, summary: `${actor(ctx)} ${past} ${n.queue_number}`, prev: { status: e.status }, next: { status: to } });
    if (after) await after(n, e);
    await refreshVisit(n.visit_id);
    bus.emit('change', { depts: [n.department_id], visit: n.visit_id });
    return getEntry(id);
  });
}
const recall = (ctx, id) => transition(ctx, id, { from: ['called'], to: 'called', action: 'queue.recalled', verb: 'recall', past: 'recalled', set: { called_at: now() },
  after: async (n) => { await db.run('UPDATE queue_entries SET call_count=call_count+1 WHERE id=?', [n.id]); announce(await getEntry(n.id)); } });
const startEntry = (ctx, id) => transition(ctx, id, { from: ['called'], to: 'serving', action: 'queue.started', verb: 'start', past: 'started service for', set: { started_at: now() } });
const skipEntry = (ctx, id) => transition(ctx, id, { from: ['called'], to: 'skipped', action: 'queue.skipped', verb: 'skip', past: 'skipped' });
const noShow = (ctx, id) => transition(ctx, id, { from: ['called', 'skipped', 'waiting'], to: 'no_show', action: 'queue.no_show', verb: 'mark as no-show', past: 'marked as no-show:', set: { completed_at: now() } });
const requeue = (ctx, id) => transition(ctx, id, { from: ['skipped', 'no_show'], to: 'waiting', action: 'queue.requeued', verb: 'return to queue', past: 'returned to the queue:',
  set: { queued_at: now(), staff_user_id: null, counter_id: null, called_at: null, call_count: 0, completed_at: null } });
const undoCall = (ctx, id) => transition(ctx, id, { from: ['called'], to: 'waiting', action: 'queue.call_undone', verb: 'undo the call for', past: 'undid the call (wrong patient) for',
  set: { staff_user_id: null, counter_id: null, called_at: null, call_count: 0 } });
const cancelEntry = (ctx, id, reason) => transition(ctx, id, { from: ['waiting', 'called', 'serving', 'skipped'], to: 'cancelled', action: 'queue.cancelled', verb: 'cancel', past: 'cancelled',
  set: { completed_at: now(), notes: clean(reason, 300) },
  after: async (n) => { await db.run(`UPDATE laboratory_requests SET status='cancelled' WHERE queue_entry_id=? AND status!='results_ready'`, [n.id]); await db.run(`UPDATE prescriptions SET status='cancelled', updated_at=? WHERE queue_entry_id=? AND status IN ('pending','preparing','ready')`, [now(), n.id]); } });

async function completeEntry(ctx, id) {
  return db.transaction(async () => {
    await db.get('SELECT id FROM queue_entries WHERE id=? FOR UPDATE', [id]);
    const e = await getEntry(id); if (!e) fail(404, 'Queue number not found');
    await assertEntryAccess(ctx.user, e);
    if (!['called', 'serving'].includes(e.status)) fail(409, `${e.queue_number} is ${label(e.status)}, so you cannot complete it`, { entry: e });
    if (e.dept_kind === 'cashier') { const s = await paymentSummary(e); if (s.status !== 'paid' && s.due > 0) fail(409, 'Payment is not complete yet. Record the payment first.'); }
    return finishEntry(ctx, e);
  });
}
const carried = (src) => `Carried over from ${src.queue_number}${src.priority_reason ? ': ' + src.priority_reason : ''}`;
// Marks the entry completed and runs the automatic next-step rules.
async function finishEntry(ctx, e) {
  const t = now();
  await db.run(`UPDATE queue_entries SET status='completed', completed_at=?, started_at=COALESCE(started_at, called_at) WHERE id=? AND status IN ('called','serving')`, [t, e.id]);
  const n = await getEntry(e.id);
  await audit(ctx, 'queue.completed', { entity: 'queue_entry', id: n.id, patient_id: n.patient_id, visit_id: n.visit_id, summary: `${actor(ctx)} completed ${n.queue_number} (${n.dept_name})`, prev: { status: e.status }, next: { status: 'completed' } });
  const s = await getSettings(); let final = false; const auto = [];
  if (n.dept_kind === 'pharmacy') {
    await db.run(`UPDATE prescriptions SET status='released', released_at=?, updated_at=? WHERE queue_entry_id=? AND status IN ('pending','preparing','ready')`, [t, t, n.id]);
    final = true;
  } else if (n.dept_kind === 'cashier') {
    const held = await db.all(`SELECT id FROM prescriptions WHERE visit_id=? AND queue_entry_id IS NULL AND status='pending'`, [n.visit_id]);
    if (held.length && s.auto_cashier_to_pharmacy === '1') {
      const ph = await db.get(`SELECT id FROM departments WHERE kind='pharmacy' AND active=1 AND deleted_at IS NULL ORDER BY sort_order LIMIT 1`);
      if (ph) { const r = await createEntry(ctx, { visit_id: n.visit_id, department_id: ph.id, priority_rule_id: n.priority_rule_id, priority_reason: carried(n), source_entry_id: n.id });
        await db.run(`UPDATE prescriptions SET queue_entry_id=? WHERE visit_id=? AND queue_entry_id IS NULL AND status='pending'`, [r.entry.id, n.visit_id]); auto.push(r.entry); }
    } else if (!held.length) final = true;
  } else if ((n.dept_kind === 'laboratory' || n.dept_kind === 'radiology') && s.auto_lab_to_cashier === '1') {
    const c = await ensureCashier(ctx, n); if (c) auto.push(c);
  }
  await refreshVisit(n.visit_id, { final });
  bus.emit('change', { depts: [n.department_id, ...auto.map((a) => a.department_id)], visit: n.visit_id });
  return { ...(await getEntry(n.id)), auto_created: auto.map((a) => ({ id: a.id, queue_number: a.queue_number, dept_name: a.dept_name })) };
}

// ---------------------------------------------------------------- routing between departments
async function unbilledAmount(visitId) {
  const charges = (await db.get(`SELECT COALESCE(SUM(e.amount),0) AS s FROM queue_entries e JOIN departments d ON d.id=e.department_id WHERE e.visit_id=? AND d.kind NOT IN ('cashier') AND e.status!='cancelled' AND e.deleted_at IS NULL`, [visitId])).s;
  const billed = (await db.get(`SELECT COALESCE(SUM(e.amount),0) AS s FROM queue_entries e JOIN departments d ON d.id=e.department_id WHERE e.visit_id=? AND d.kind='cashier' AND e.status!='cancelled' AND e.deleted_at IS NULL`, [visitId])).s;
  return Math.max(0, Math.round((charges - billed) * 100) / 100);
}
async function ensureCashier(ctx, src) {
  const dept = await db.get(`SELECT * FROM departments WHERE kind='cashier' AND active=1 AND deleted_at IS NULL ORDER BY sort_order LIMIT 1`);
  if (!dept) return null;
  const existing = await db.get(`SELECT id FROM queue_entries WHERE visit_id=? AND department_id=? AND status IN ('waiting','called','serving') AND deleted_at IS NULL`, [src.visit_id, dept.id]);
  if (existing) return getEntry(existing.id);
  const amount = await unbilledAmount(src.visit_id);
  const svc = await db.get('SELECT id FROM services WHERE department_id=? AND deleted_at IS NULL LIMIT 1', [dept.id]);
  return (await createEntry(ctx, { visit_id: src.visit_id, department_id: dept.id, service_id: svc?.id, priority_rule_id: src.priority_rule_id, priority_reason: carried(src), amount, source_entry_id: src.id })).entry;
}

async function routeVisit(ctx, visitId, b) {
  return db.transaction(async () => {
    const v = await getVisit(visitId); if (!v) fail(404, 'Visit not found');
    const dept = b.department_id ? await getDept(b.department_id) : await db.get(`SELECT * FROM departments WHERE kind=? AND active=1 AND deleted_at IS NULL ORDER BY sort_order LIMIT 1`, [String(b.kind || '')]);
    if (!dept || !dept.active) fail(400, 'That department is not available');
    const allowed = ROUTE_TARGETS[ctx.user.role] || [];
    if (!ctx.user.perms.has('route.send') || !allowed.includes(dept.kind)) fail(403, `Your role cannot send patients to ${dept.name}`);
    const src = b.from_entry_id ? await getEntry(b.from_entry_id) : null;
    if (src && src.visit_id !== v.id) fail(400, 'That queue number belongs to a different visit');
    const rule = src ? { id: src.priority_rule_id, reason: carried(src) } : { id: b.priority_rule_id, reason: b.priority_reason };
    let amount = 0, serviceId = null; const picked = [];
    const firstService = async () => (await db.get('SELECT id FROM services WHERE department_id=? AND deleted_at IS NULL LIMIT 1', [dept.id]))?.id ?? null;

    if (dept.kind === 'laboratory' || dept.kind === 'radiology') {
      const ids = [...new Set((b.service_ids || []).map(Number).filter(Boolean))];
      if (!ids.length) fail(400, 'Choose at least one test');
      for (const id of ids) { const s = await db.get('SELECT * FROM services WHERE id=? AND department_id=? AND active=1 AND deleted_at IS NULL', [id, dept.id]); if (!s) fail(400, 'One of the tests is not available'); picked.push(s); amount += s.price; }
      serviceId = picked[0].id;
    } else if (dept.kind === 'cashier') { amount = await unbilledAmount(v.id); serviceId = await firstService();
    } else if (dept.kind === 'pharmacy') {
      const items = clean(b.items, 1000); if (!items) fail(400, 'Write the medicines to prepare');
      if (b.hold) {
        const t = now();
        const rid = await db.insert(`INSERT INTO prescriptions(visit_id,patient_id,items,status,hold_until_paid,prescribed_by,created_at,updated_at) VALUES(?,?,?,'pending',1,?,?,?)`, [v.id, v.patient_id, items, ctx.user.id, t, t]);
        await audit(ctx, 'prescription.held', { entity: 'prescription', id: rid, patient_id: v.patient_id, visit_id: v.id, summary: `${actor(ctx)} added a prescription for ${v.visit_no}; it will go to Pharmacy after payment` });
        await refreshVisit(v.id); bus.emit('change', { visit: v.id });
        return { held: true, entry: null, visit_id: v.id };
      }
      serviceId = await firstService();
    } else serviceId = await firstService();

    const res = await createEntry(ctx, { visit_id: v.id, department_id: dept.id, service_id: serviceId, doctor_id: dept.kind === 'consultation' ? (b.doctor_id || null) : null,
      priority_rule_id: rule.id, priority_reason: rule.reason, amount, source_entry_id: src?.id ?? null, notes: b.notes });
    if (!res.duplicate) {
      const t = now();
      for (const s of picked) await db.run(`INSERT INTO laboratory_requests(visit_id,patient_id,queue_entry_id,service_id,test_name,requested_by,requested_at) VALUES(?,?,?,?,?,?,?)`, [v.id, v.patient_id, res.entry.id, s.id, s.name, ctx.user.id, t]);
      if (dept.kind === 'pharmacy') await db.run(`INSERT INTO prescriptions(visit_id,patient_id,queue_entry_id,items,status,prescribed_by,created_at,updated_at) VALUES(?,?,?,?, 'pending', ?,?,?)`, [v.id, v.patient_id, res.entry.id, clean(b.items, 1000), ctx.user.id, t, t]);
      await audit(ctx, 'visit.routed', { entity: 'queue_entry', id: res.entry.id, patient_id: v.patient_id, visit_id: v.id, summary: `${actor(ctx)} sent ${v.visit_no} to ${dept.name} as ${res.entry.queue_number}${src ? ' (from ' + src.queue_number + ')' : ''}` });
    }
    return { ...res, entry: await getEntry(res.entry.id), visit_id: v.id };
  });
}

async function changePriority(ctx, id, ruleId, reason) {
  return db.transaction(async () => {
    const e = await getEntry(id); if (!e) fail(404, 'Queue number not found');
    if (!ctx.user.perms.has('priority.change')) fail(403, 'You cannot change priority');
    if (!ACTIVE.includes(e.status)) fail(409, 'Only active queue numbers can change priority');
    const rule = await db.get('SELECT * FROM priority_rules WHERE id=? AND enabled=1', [ruleId]); if (!rule) fail(400, 'Choose a priority');
    const why = clean(reason, 300); if (!why) fail(400, 'Please write why the priority is changing');
    await db.run('UPDATE queue_entries SET priority_rule_id=?, priority_weight=?, priority_reason=? WHERE id=?', [rule.id, rule.weight, why, id]);
    await audit(ctx, 'queue.priority_changed', { entity: 'queue_entry', id, patient_id: e.patient_id, visit_id: e.visit_id,
      summary: `${actor(ctx)} changed ${e.queue_number} priority from ${e.priority_label || 'Regular'} to ${rule.label}: ${why}`,
      prev: { priority: e.priority_label, reason: e.priority_reason }, next: { priority: rule.label, reason: why } });
    bus.emit('change', { depts: [e.department_id], visit: e.visit_id });
    return getEntry(id);
  });
}

// ---------------------------------------------------------------- laboratory
const labRequests = (entryId) => db.all('SELECT * FROM laboratory_requests WHERE queue_entry_id=? ORDER BY id', [entryId]);
async function specimenCollected(ctx, entryId) {
  return db.transaction(async () => {
    const e = await getEntry(entryId); if (!e) fail(404, 'Queue number not found'); await assertEntryAccess(ctx.user, e);
    if (!['called', 'serving', 'completed'].includes(e.status)) fail(409, 'Call the patient first');
    const r = await db.run(`UPDATE laboratory_requests SET status='specimen_collected', specimen_collected_at=? WHERE queue_entry_id=? AND status='requested'`, [now(), entryId]);
    if (!r.changes) fail(409, 'There is nothing waiting for a specimen');
    await audit(ctx, 'lab.specimen_collected', { entity: 'queue_entry', id: entryId, patient_id: e.patient_id, visit_id: e.visit_id, summary: `${actor(ctx)} collected specimen for ${e.queue_number}` });
    bus.emit('change', { depts: [e.department_id], visit: e.visit_id });
    return labRequests(entryId);
  });
}
async function resultsReady(ctx, entryId, summary) {
  return db.transaction(async () => {
    const e = await getEntry(entryId); if (!e) fail(404, 'Queue number not found'); await assertEntryAccess(ctx.user, e);
    const reqs = (await labRequests(entryId)).filter((r) => r.status !== 'cancelled'); if (!reqs.length) fail(409, 'There are no requests to mark');
    const t = now();
    await db.run(`UPDATE laboratory_requests SET status='results_ready', results_ready_at=?, specimen_collected_at=COALESCE(specimen_collected_at,?) WHERE queue_entry_id=? AND status!='cancelled'`, [t, t, entryId]);
    for (const r of reqs) await db.run('INSERT INTO laboratory_results(request_id,summary,recorded_by,recorded_at) VALUES(?,?,?,?)', [r.id, clean(summary, 500), ctx.user.id, t]);
    await audit(ctx, 'lab.results_ready', { entity: 'queue_entry', id: entryId, patient_id: e.patient_id, visit_id: e.visit_id, summary: `${actor(ctx)} marked results ready for ${e.queue_number}` });
    const doc = await db.get('SELECT d.user_id FROM patient_visits v JOIN doctors d ON d.id=v.doctor_id WHERE v.id=?', [e.visit_id]);
    await notify([...reqs.map((r) => r.requested_by), doc?.user_id], 'Lab results are ready', `${e.patient_name} - ${e.queue_number} (${e.visit_no})`, e.visit_id);
    bus.emit('change', { depts: [e.department_id], visit: e.visit_id, notify: true });
    return labRequests(entryId);
  });
}

// ---------------------------------------------------------------- cashier
async function paymentSummary(e) {
  const paid = (await db.get(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE queue_entry_id=? AND status='paid'`, [e.id])).s;
  const due = e.amount; const remaining = Math.max(0, Math.round((due - paid) * 100) / 100);
  let status = 'pending';
  if (e.status === 'cancelled') status = 'cancelled'; else if (due > 0 && remaining <= 0) status = 'paid'; else if (due === 0 && e.status === 'completed') status = 'paid'; else if (paid > 0) status = 'partial';
  return { due, paid, remaining, status };
}
async function recordPayment(ctx, entryId, b) {
  return db.transaction(async () => {
    await db.get('SELECT id FROM queue_entries WHERE id=? FOR UPDATE', [entryId]); // two cashiers cannot over-collect the same bill
    const e = await getEntry(entryId); if (!e) fail(404, 'Queue number not found');
    if (e.dept_kind !== 'cashier') fail(400, 'This is not a cashier queue number'); await assertEntryAccess(ctx.user, e);
    const key = clean(b.idempotency_key, 80);
    if (key && await db.get('SELECT 1 AS x FROM payments WHERE idempotency_key=?', [key])) return { duplicate: true, entry: e, summary: await paymentSummary(e) };
    if (!['called', 'serving'].includes(e.status)) fail(409, 'Call the patient before recording a payment');
    const amount = Math.round(Number(b.amount) * 100) / 100;
    if (!(amount > 0)) fail(400, 'Enter an amount greater than zero');
    const before = await paymentSummary(e);
    if (amount > before.remaining + 0.001) fail(400, `That is more than the balance of ₱${before.remaining.toFixed(2)}`);
    const method = PAYMENT_METHODS.includes(b.method) ? b.method : 'Cash';
    const ins = await db.run(`INSERT INTO payments(visit_id,patient_id,queue_entry_id,amount,method,note,idempotency_key,received_by,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING`,
      [e.visit_id, e.patient_id, e.id, amount, method, clean(b.note, 120), key, ctx.user.id, now()]);
    if (!ins.changes) return { duplicate: true, entry: e, summary: await paymentSummary(e) };
    await audit(ctx, 'payment.recorded', { entity: 'payment', id: e.id, patient_id: e.patient_id, visit_id: e.visit_id, summary: `${actor(ctx)} recorded ₱${amount.toFixed(2)} (${method}) for ${e.queue_number}`, prev: { paid: before.paid }, next: { paid: before.paid + amount } });
    const after = await paymentSummary(e);
    let result = await getEntry(e.id);
    if (after.status === 'paid') result = await finishEntry(ctx, e);
    bus.emit('change', { depts: [e.department_id], visit: e.visit_id });
    return { duplicate: false, entry: result, summary: await paymentSummary(await getEntry(e.id)) };
  });
}
async function adjustAmount(ctx, entryId, amount, reason) {
  return db.transaction(async () => {
    const e = await getEntry(entryId); if (!e || e.dept_kind !== 'cashier') fail(404, 'Cashier queue number not found'); await assertEntryAccess(ctx.user, e);
    if (!ACTIVE.includes(e.status)) fail(409, 'This bill is already closed');
    const amt = Math.round(Number(amount) * 100) / 100; if (!(amt >= 0)) fail(400, 'Enter a valid amount');
    const paid = (await paymentSummary(e)).paid; if (amt < paid) fail(400, 'Amount cannot be lower than what was already paid');
    if (!clean(reason)) fail(400, 'Please write why the amount is changing');
    await db.run('UPDATE queue_entries SET amount=? WHERE id=?', [amt, entryId]);
    await audit(ctx, 'billing.amount_changed', { entity: 'queue_entry', id: entryId, patient_id: e.patient_id, visit_id: e.visit_id, summary: `${actor(ctx)} changed amount due for ${e.queue_number} from ₱${e.amount.toFixed(2)} to ₱${amt.toFixed(2)}: ${clean(reason)}`, prev: { amount: e.amount }, next: { amount: amt } });
    bus.emit('change', { depts: [e.department_id], visit: e.visit_id });
    return getEntry(entryId);
  });
}

// ---------------------------------------------------------------- pharmacy
const RX_FLOW = { preparing: ['pending'], ready: ['pending', 'preparing'], released: ['ready'], cancelled: ['pending', 'preparing', 'ready'] };
async function setPrescription(ctx, entryId, status) {
  return db.transaction(async () => {
    const e = await getEntry(entryId); if (!e || e.dept_kind !== 'pharmacy') fail(404, 'Pharmacy queue number not found'); await assertEntryAccess(ctx.user, e);
    if (!RX_FLOW[status]) fail(400, 'Unknown prescription status');
    if (!['called', 'serving'].includes(e.status)) fail(409, 'Call the patient first');
    const rows = await db.all('SELECT * FROM prescriptions WHERE queue_entry_id=?', [e.id]);
    const ok = rows.filter((r) => RX_FLOW[status].includes(r.status));
    if (rows.length && !ok.length) fail(409, `The prescription is ${rows[0].status}, so it cannot become ${status}`);
    if (e.status === 'called' && status !== 'cancelled') await db.run(`UPDATE queue_entries SET status='serving', started_at=? WHERE id=?`, [now(), e.id]);
    for (const r of ok) await db.run('UPDATE prescriptions SET status=?, updated_at=?, released_at=? WHERE id=?', [status, now(), status === 'released' ? now() : null, r.id]);
    await audit(ctx, 'pharmacy.' + status, { entity: 'queue_entry', id: e.id, patient_id: e.patient_id, visit_id: e.visit_id, summary: `${actor(ctx)} set prescription for ${e.queue_number} to ${status}` });
    let out = await getEntry(e.id);
    if (status === 'released' || status === 'cancelled') out = await finishEntry(ctx, await getEntry(e.id));
    bus.emit('change', { depts: [e.department_id], visit: e.visit_id });
    return out;
  });
}

// ---------------------------------------------------------------- station snapshot
async function stationState(user, deptId) {
  const dept = await getDept(deptId); if (!dept) fail(404, 'Department not found');
  if (!canView(user, dept)) fail(403, 'You are not allowed to see this queue');
  const today = localDate(); const cache = {};
  const doctor = user.doctor ? user.doctor.id : null; const showReason = user.perms.has('reason.view');
  const mask = (e) => { if (!showReason) e.reason = null; e.token = undefined; return e; };
  const waiting = await entries(`WHERE e.department_id=? AND e.queue_date=? AND e.status='waiting' AND e.deleted_at IS NULL
    AND (?::int IS NULL OR e.doctor_id IS NULL OR e.doctor_id=?) ORDER BY e.priority_weight DESC, e.queued_at, e.id`, [dept.id, today, doctor, doctor]);
  let i = 0; for (const e of waiting) { e.position = ++i; const w = await waitInfo(e, cache); e.ahead = w.ahead; e.wait_minutes = w.minutes; mask(e); }
  const enrich = async (e) => { e.pay = e.dept_kind === 'cashier' ? await paymentSummary(e) : undefined; e.lab = await labRequests(e.id); e.rx = await db.all('SELECT * FROM prescriptions WHERE queue_entry_id=?', [e.id]); return mask(e); };
  const serving = []; for (const e of await entries(`WHERE e.department_id=? AND e.status IN ('called','serving') AND e.deleted_at IS NULL ORDER BY e.called_at`, [dept.id])) serving.push(await enrich(e));
  const recent = []; for (const e of await entries(`WHERE e.department_id=? AND e.queue_date=? AND e.status IN ('completed','skipped','no_show','cancelled') AND e.deleted_at IS NULL
    ORDER BY COALESCE(e.completed_at, e.called_at, e.created_at) DESC LIMIT 12`, [dept.id, today])) recent.push(await enrich(e));
  const skipped = recent.filter((e) => e.status === 'skipped' || e.status === 'no_show');
  const counters = await db.all('SELECT id, name FROM queue_counters WHERE department_id=? AND active=1 AND deleted_at IS NULL ORDER BY id', [dept.id]);
  const total = (await db.get(`SELECT COUNT(*) AS n FROM queue_entries WHERE department_id=? AND queue_date=? AND deleted_at IS NULL`, [dept.id, today])).n;
  const doctors = dept.kind === 'consultation' ? await db.all('SELECT id, full_name, specialty FROM doctors WHERE department_id=? AND active=1 AND deleted_at IS NULL', [dept.id]) : [];
  const svcs = await db.all('SELECT id, name, price FROM services WHERE department_id=? AND active=1 AND deleted_at IS NULL ORDER BY name', [dept.id]);
  return { department: dept, counters, doctors, services: svcs, serving, waiting, next: waiting[0] || null, recent, skipped,
    stats: { waiting: waiting.length, total_today: total, avg_service_minutes: await avgServiceMinutes(dept), servers: await activeServers(dept.id) },
    can_work: canWork(user, dept), settings: { max_calls: parseInt((await getSettings()).max_calls_before_no_show, 10) || 3 } };
}

// ---------------------------------------------------------------- visit detail + public views
function publicPatientFor(user, p) {
  const full = publicPatient(p);
  if (user.perms.has('patients.view')) return full;
  return { id: p.id, patient_no: p.patient_no, name: full.name, age: full.age, sex: full.sex };
}
async function visitDetail(user, visitId) {
  const v = await getVisit(visitId); if (!v) fail(404, 'Visit not found');
  const p = await getPatient(v.patient_id);
  const list = await entries('WHERE e.visit_id=? AND e.deleted_at IS NULL ORDER BY e.created_at, e.id', [visitId]);
  for (const e of list) { const w = await waitInfo(e); e.ahead = w.ahead; e.wait_minutes = w.minutes; e.token = undefined; e.reason = undefined; if (e.dept_kind === 'cashier') e.pay = await paymentSummary(e); }
  const doctor = v.doctor_id ? await db.get('SELECT id, full_name FROM doctors WHERE id=?', [v.doctor_id]) : null;
  const dept = v.department_id ? await getDept(v.department_id) : null;
  return { visit: { id: v.id, visit_no: v.visit_no, visit_date: v.visit_date, created_at: v.created_at, status: v.status, reason: user.perms.has('reason.view') ? v.reason : null, completed_at: v.completed_at, expires_at: v.expires_at },
    patient: publicPatientFor(user, p), doctor, department: dept && { id: dept.id, name: dept.name }, entries: list, journey: await journey(visitId) };
}

async function publicVisit(token) {
  const v = await db.get('SELECT * FROM patient_visits WHERE token=? AND deleted_at IS NULL', [String(token || '').slice(0, 64)]);
  if (!v) return null;
  if (new Date(v.expires_at) < new Date(nowMs())) return { expired: true };
  const p = await getPatient(v.patient_id); const cache = {};
  const list = await entries('WHERE e.visit_id=? AND e.deleted_at IS NULL ORDER BY e.created_at, e.id', [v.id]);
  const queues = [];
  for (const e of list) {
    const w = await waitInfo(e, cache);
    const nowSrv = await db.get(`SELECT queue_number FROM queue_entries WHERE department_id=? AND status IN ('called','serving') AND deleted_at IS NULL ORDER BY called_at DESC LIMIT 1`, [e.department_id]);
    const rx = e.dept_kind === 'pharmacy' ? (await db.get('SELECT status FROM prescriptions WHERE queue_entry_id=? LIMIT 1', [e.id]))?.status : null;
    const lab = (e.dept_kind === 'laboratory' || e.dept_kind === 'radiology') ? (await labRequests(e.id)).map((r) => ({ test: r.test_name, status: r.status })) : null;
    const pay = e.dept_kind === 'cashier' ? await paymentSummary(e) : null;
    queues.push({ number: e.queue_number, department: e.dept_name, status: e.status, now_serving: nowSrv?.queue_number || null, ahead: w.ahead, wait_minutes: w.minutes,
      counter: ['called', 'serving'].includes(e.status) ? e.counter_name : null, rx_status: rx, lab, pay: pay && { due: pay.due, status: pay.status } });
  }
  return { hospital: (await getSettings()).hospital_name, first_name: p.first_name, visit_no: v.visit_no, visit_status: v.status, visit_date: v.visit_date, queues, journey: await journey(v.id), updated_at: now() };
}

async function displayState() {
  const s = await getSettings(); const today = localDate(); const names = s.display_show_names === '1';
  const depts = await db.all(`SELECT * FROM departments WHERE active=1 AND show_on_display=1 AND deleted_at IS NULL ORDER BY sort_order, id`);
  const rows = [];
  for (const d of depts) {
    const cur = await entries(`WHERE e.department_id=? AND e.status IN ('called','serving') AND e.deleted_at IS NULL ORDER BY e.called_at DESC`, [d.id]);
    const wait = await db.all(`SELECT queue_number FROM queue_entries WHERE department_id=? AND queue_date=? AND status='waiting' AND deleted_at IS NULL ORDER BY priority_weight DESC, queued_at, id LIMIT 4`, [d.id, today]);
    const count = (await db.get(`SELECT COUNT(*) AS n FROM queue_entries WHERE department_id=? AND queue_date=? AND status='waiting' AND deleted_at IS NULL`, [d.id, today])).n;
    const lbl = (e) => (names ? `${e.first_name} ${e.last_name.charAt(0)}.` : undefined);
    rows.push({ id: d.id, name: d.name, kind: d.kind, serving: cur.map((e) => ({ number: e.queue_number, counter: e.counter_name, status: e.status, name: lbl(e) })), waiting: wait.map((w) => w.queue_number), waiting_count: count });
  }
  return { hospital: s.hospital_name, logo: s.hospital_logo, tagline: s.hospital_tagline, departments: rows,
    voice: { enabled: s.voice_enabled === '1', volume: Number(s.voice_volume), repeat: Number(s.voice_repeat), delay: Number(s.voice_delay), lang: s.voice_language }, now: now() };
}

module.exports = { bus, db, now, nowMs, localDate, localDayStartUtc, HttpError, fail, clean, ACTIVE, ZONE, LOCAL, mins, getSettings, setSettings, DEFAULTS, audit, notify,
  getDept, getVisit, getPatient, getEntry, entries, fullName, ageOf, canWork, canView, assertWork, assertEntryAccess, registerPatient, findDuplicates, publicPatient, createVisit,
  cancelVisit, completeVisit, callNext, recall, startEntry, skipEntry, noShow, requeue, undoCall, cancelEntry, completeEntry, routeVisit, changePriority, suggestPriority,
  specimenCollected, resultsReady, recordPayment, adjustAmount, paymentSummary, setPrescription, stationState, visitDetail, publicVisit, displayState, journey, waitInfo,
  avgServiceMinutes, setClockOffset, ENTRY_SQL, decorate, nextPatientNo, nextVisitNo, nextQueueNumber, createEntry, refreshVisit, finishEntry, unbilledAmount, minutesAgo, TZ, labRequests, bumpCounter };
