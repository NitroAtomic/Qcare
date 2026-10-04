require('./env');
// First-run data.
//   VISIQ_DEMO=0  production start: roles, permissions, departments, priority rules and ONE administrator. No patients.
//   otherwise     demo: also staff accounts, ~150 patients, a week of history, and a hospital "morning in progress".
// Live queues are produced by replaying real actions through core.js on a shifted clock, so the audit trail and waiting times are genuine.
const crypto = require('crypto');
const db = require('./db');
const core = require('./core');
const auth = require('./auth');
const provider = require('./authprovider');
const { PERMISSIONS, ROLES } = require('./perms');

const DEMO_PASSWORD = 'Qcare#2026';
// VISIQ_DEMO_SIZE=small builds about a third of the demo data. Much faster on a slow or faraway database.
const SMALL = String(process.env.VISIQ_DEMO_SIZE || '').toLowerCase() === 'small';
const log = (m) => { if (process.env.VISIQ_QUIET !== '1') console.log('  ' + m); };
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function seedIfEmpty() {
  if ((await db.get('SELECT COUNT(*) AS n FROM users')).n > 0) return false;
  await provider.get().check(); // wrong Supabase keys are caught here, before anything is written
  await clearLeftovers(); // a first run that stopped half way must not block the next one
  await seed({ demo: process.env.VISIQ_DEMO !== '0' }); return true;
}
// With no users, nobody has been able to sign in, so nothing real can exist yet. Safe to start clean.
async function clearLeftovers() {
  if ((await db.get('SELECT COUNT(*) AS n FROM departments')).n === 0 && (await db.get('SELECT COUNT(*) AS n FROM roles')).n === 0) return;
  log('Cleaning up an unfinished first run...');
  await db.exec(`TRUNCATE role_permissions, permissions, roles, queue_sequences, counters, laboratory_results, laboratory_requests, prescriptions, payments, notifications, audit_logs,
    queue_entries, appointments, patient_visits, patients, doctors, queue_counters, services, departments, priority_rules RESTART IDENTITY CASCADE;`);
}

async function seed({ demo }) {
  log(demo ? (SMALL ? 'Creating a small demo (a few minutes on a remote database)...' : 'Creating demo data (10 to 25 minutes on a faraway database; set VISIQ_DEMO_SIZE=small for a quick one)...') : 'Setting up VisiQ for the first time...');
  const ids = await db.transaction(async () => {
    for (const [code, d] of Object.entries(PERMISSIONS)) await db.run('INSERT INTO permissions(code,description) VALUES(?,?) ON CONFLICT(code) DO NOTHING', [code, d]);
    for (const [code, r] of Object.entries(ROLES)) {
      const rid = (await db.get('INSERT INTO roles(code,name,description) VALUES(?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name RETURNING id', [code, r.name, r.description])).id;
      for (const p of r.perms) await db.run('INSERT INTO role_permissions(role_id,permission_id) SELECT ?, id FROM permissions WHERE code=? ON CONFLICT DO NOTHING', [rid, p]);
    }
    const prio = [['emergency', 'Emergency', 100, 1, 'Life-threatening. Goes to the front of every queue.'], ['critical', 'Critical', 90, 1, 'Urgent but stable.'], ['senior', 'Senior Citizen', 50, 0, 'Age 60 and above (RA 9994).'],
      ['pwd', 'PWD', 50, 0, 'Person with disability (RA 7277).'], ['pregnant', 'Pregnant', 50, 0, 'Pregnant patients.'], ['appointment', 'Scheduled Appointment', 30, 0, 'Has an appointment today.'], ['followup', 'Follow-up', 20, 0, 'Returning for a doctor follow-up.'], ['regular', 'Regular', 0, 0, 'No priority.']];
    for (let i = 0; i < prio.length; i++) { const [c, l, w, rq, d] = prio[i]; await db.run('INSERT INTO priority_rules(code,label,weight,requires_reason,sort_order,description) VALUES(?,?,?,?,?,?) ON CONFLICT(code) DO NOTHING', [c, l, w, rq, i, d]); }

    const dep = {}; const D = async (code, name, kind, prefix, avg, order, active = 1, show = 1) => { dep[code] = await db.insert('INSERT INTO departments(code,name,kind,queue_prefix,avg_service_minutes,active,show_on_display,sort_order) VALUES(?,?,?,?,?,?,?,?)', [code, name, kind, prefix, avg, active, show, order]); };
    await D('internal-medicine', 'Internal Medicine', 'consultation', 'D', 12, 1); await D('pediatrics', 'Pediatrics', 'consultation', 'PD', 12, 2);
    await D('laboratory', 'Laboratory', 'laboratory', 'LAB', 8, 3); await D('radiology', 'Radiology', 'radiology', 'XR', 10, 4);
    await D('cashier', 'Cashier', 'cashier', 'C', 4, 5); await D('pharmacy', 'Pharmacy', 'pharmacy', 'PH', 5, 6);
    await D('registration', 'Registration', 'registration', 'R', 4, 7, 0, 0); await D('medical-records', 'Medical Records', 'records', 'MR', 6, 8, 0, 0);
    const S = (d, name, price) => db.insert('INSERT INTO services(department_id,name,price) VALUES(?,?,?)', [dep[d], name, price]);
    const svc = { im: await S('internal-medicine', 'Doctor Consultation', 350), pd: await S('pediatrics', 'Pediatric Consultation', 300),
      cbc: await S('laboratory', 'Complete Blood Count (CBC)', 250), ua: await S('laboratory', 'Urinalysis', 120), fbs: await S('laboratory', 'Fasting Blood Sugar', 150), lipid: await S('laboratory', 'Lipid Profile', 650), crea: await S('laboratory', 'Creatinine', 200), fa: await S('laboratory', 'Fecalysis', 100),
      cxr: await S('radiology', 'Chest X-Ray', 450), us: await S('radiology', 'Ultrasound (Whole Abdomen)', 1100), cashier: await S('cashier', 'Payment', 0), disp: await S('pharmacy', 'Dispensing', 0) };
    const C = (d, name) => db.insert('INSERT INTO queue_counters(department_id,name) VALUES(?,?)', [dep[d], name]);
    const ctr = { r3: await C('internal-medicine', 'Consultation Room 3'), r4: await C('internal-medicine', 'Consultation Room 4'), r1: await C('pediatrics', 'Consultation Room 1'),
      lab1: await C('laboratory', 'Laboratory 1'), lab2: await C('laboratory', 'Laboratory 2'), xr1: await C('radiology', 'X-Ray Room 1'), usr: await C('radiology', 'Ultrasound Room'),
      c1: await C('cashier', 'Cashier 01'), c2: await C('cashier', 'Cashier 02'), ph1: await C('pharmacy', 'Pharmacy Window 1') };
    await db.run(`INSERT INTO settings(key,value,updated_at) VALUES('hospital_name',?,?) ON CONFLICT(key) DO NOTHING`, [process.env.HOSPITAL_NAME || 'Sugbo Medical Center', core.now()]);
    return { dep, svc, ctr };
  });

  const roleId = async (c) => (await db.get('SELECT id FROM roles WHERE code=?', [c])).id;
  const makeUser = async (username, name, role, deptCode, counter, password) => {
    const email = provider.emailFor(username); const authId = await provider.get().createUser(email, password, { overwrite: true });
    return db.insert('INSERT INTO users(auth_id,email,username,full_name,role_id,department_id,counter_id,created_at) VALUES(?,?,?,?,?,?,?,?)', [authId, email, username, name, await roleId(role), deptCode ? ids.dep[deptCode] : null, counter || null, core.now()]);
  };
  if (!demo) {
    const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase(); let pw = process.env.ADMIN_PASSWORD; let generated = false;
    if (!pw) { pw = 'Qc' + crypto.randomBytes(6).toString('hex') + '9'; generated = true; }
    await makeUser(username, process.env.ADMIN_NAME || 'VisiQ Administrator', 'super_admin', null, null, pw);
    log(`Administrator created. Username: ${username}${generated ? '   Password: ' + pw + '   (shown once. Change it after signing in.)' : ''}`);
    return;
  }
  const doc = async (username, name, spec, deptCode, counter) => { const uid = await makeUser(username, name, 'doctor', deptCode, counter, DEMO_PASSWORD); await db.run('INSERT INTO doctors(user_id,full_name,specialty,department_id,counter_id) VALUES(?,?,?,?,?)', [uid, name, spec, ids.dep[deptCode], counter]); };
  await makeUser('admin', 'VisiQ Administrator', 'super_admin', null, null, DEMO_PASSWORD); await makeUser('reception', 'Liza Mendoza', 'receptionist', null, null, DEMO_PASSWORD);
  await doc('drsantos', 'Dr. Santos', 'Internal Medicine', 'internal-medicine', ids.ctr.r3); await doc('drreyes', 'Dr. Reyes', 'Internal Medicine', 'internal-medicine', ids.ctr.r4); await doc('drgarcia', 'Dr. Garcia', 'Pediatrics', 'pediatrics', ids.ctr.r1);
  await makeUser('lab', 'Marco Villanueva', 'laboratory', 'laboratory', ids.ctr.lab1, DEMO_PASSWORD); await makeUser('cashier', 'Grace Tan', 'cashier', 'cashier', ids.ctr.c1, DEMO_PASSWORD);
  await makeUser('pharmacy', 'Rico Bautista', 'pharmacist', 'pharmacy', ids.ctr.ph1, DEMO_PASSWORD); await makeUser('display', 'Lobby Display', 'display_operator', null, null, DEMO_PASSWORD);
  log('Staff accounts ready.');

  const R = rng(20261004); const pick = (a) => a[Math.floor(R() * a.length)]; const between = (a, b) => a + R() * (b - a);
  const todayStr = core.localDate();
  await seedPatients(R, pick, between); log('Patients ready.');
  await history(ids, { R, pick, between, todayStr }); log('History ready.');
  await simulateToday(ids, { R, pick }); log('Live queues ready.');
  core.setClockOffset(0);
  await db.run('DELETE FROM sessions');
}

// ---------------------------------------------------------------------------------------------- patients
async function seedPatients(R, pick, between) {
  const male = ['Juan', 'Pedro', 'Jose', 'Mark', 'John', 'Carlo', 'Miguel', 'Rafael', 'Eduardo', 'Ramon', 'Antonio', 'Roberto', 'Ernesto', 'Joel', 'Dennis', 'Arnel', 'Noel', 'Jericho', 'Christian', 'Kevin', 'Allan', 'Ricardo', 'Rodel', 'Nestor', 'Francisco', 'Vicente', 'Armando'];
  const female = ['Maria', 'Ana', 'Rosario', 'Lourdes', 'Cecilia', 'Grace', 'Jasmine', 'Angelica', 'Michelle', 'Liza', 'Marites', 'Josephine', 'Teresita', 'Rowena', 'Bernadette', 'Catherine', 'Divina', 'Elena', 'Flordeliza', 'Gina', 'Hazel', 'Imelda', 'Joy', 'Karen', 'Lolita', 'Remedios', 'Corazon'];
  const last = ['Dela Cruz', 'Santos', 'Reyes', 'Garcia', 'Ramos', 'Mendoza', 'Bautista', 'Villanueva', 'Aquino', 'Castillo', 'Flores', 'Navarro', 'Torres', 'Gonzales', 'Lopez', 'Cruz', 'Rivera', 'Fernandez', 'Tan', 'Lim', 'Dizon', 'Pascual', 'Abella', 'Alcantara', 'Cabrera', 'Salazar', 'Domingo', 'Soriano', 'Valdez', 'Pacheco', 'Cortez', 'Ybanez', 'Lumapas', 'Cabahug', 'Rosales', 'Quizon', 'Padilla', 'Alvarez', 'Tampus', 'Gabuya'];
  const places = ['Brgy. Lahug, Cebu City', 'Brgy. Mabolo, Cebu City', 'Brgy. Guadalupe, Cebu City', 'Brgy. Banilad, Mandaue City', 'Brgy. Opon, Lapu-Lapu City', 'Brgy. Bulacao, Talisay City', 'Brgy. Pit-os, Cebu City', 'Brgy. Basak, Mandaue City', 'Brgy. Tisa, Cebu City', 'Brgy. Poblacion, Consolacion'];
  const used = new Set(); const rows = []; const nowY = new Date(core.nowMs() + core.TZ * 36e5).getUTCFullYear();
  const named = [['Juan', 'Dela Cruz', 'Male', 41], ['Maria', 'Santos', 'Female', 34], ['Pedro', 'Reyes', 'Male', 52], ['Ana', 'Garcia', 'Female', 29]];
  const make = (first, lastName, sex, age) => {
    const dob = new Date(Date.UTC(nowY - age, Math.floor(R() * 12), 1 + Math.floor(R() * 27))).toISOString().slice(0, 10);
    const type = age >= 60 ? 'Senior Citizen' : sex === 'Female' && age >= 20 && age <= 38 && R() < 0.06 ? 'Pregnant' : R() < 0.03 ? 'PWD' : 'Regular';
    return { first, lastName, sex, dob, type, mid: R() < 0.7 ? pick(last) : null, contact: '09' + String(Math.floor(between(100000000, 999999999))), addr: pick(places) };
  };
  for (let i = 0; i < 150; i++) { // named demo patients take ids 125-128 so the first demo ticket reads like P-2026-00125
    let p;
    if (i >= 124 && i <= 127) { const n = named[i - 124]; p = make(n[0], n[1], n[2], n[3]); }
    else { const sex = R() < 0.5 ? 'Male' : 'Female'; let tries = 0, first, ln; do { first = pick(sex === 'Male' ? male : female); ln = pick(last); tries++; } while (used.has(first + ln) && tries < 50);
      const r = R(); const age = r < 0.2 ? Math.floor(between(1, 14)) : r < 0.7 ? Math.floor(between(18, 59)) : Math.floor(between(60, 88)); p = make(first, ln, sex, age); }
    used.add(p.first + p.lastName); rows.push(p);
  }
  await db.transaction(async () => {
    for (let i = 0; i < rows.length; i++) { const p = rows[i];
      await db.run(`INSERT INTO patients(patient_no,first_name,middle_name,last_name,birth_date,sex,contact_no,address,emergency_contact_name,emergency_contact_no,patient_type,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        [`P-${nowY}-${String(i + 1).padStart(5, '0')}`, p.first, p.mid, p.lastName, p.dob, p.sex, p.contact, p.addr, 'Family member', '09' + String(Math.floor(between(100000000, 999999999))), p.type, new Date(core.nowMs() - Math.floor(between(2, 400)) * 864e5).toISOString()]); }
    await db.run(`INSERT INTO counters(name,last_number) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET last_number=excluded.last_number`, ['patient-' + nowY, rows.length]);
  });
}

// ---------------------------------------------------------------------------------------------- history (past days + early today)
async function history({ dep, svc, ctr }, { R, pick, between, todayStr }) {
  const T = core.TZ; const iso = (dateStr, minOfDay) => new Date(Date.parse(dateStr + 'T00:00:00Z') + (minOfDay - T * 60) * 60000).toISOString();
  const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const patients = await db.all('SELECT id, birth_date, patient_type FROM patients ORDER BY id');
  const kids = patients.filter((p) => core.ageOf(p.birth_date) < 15); const adults = patients.filter((p) => core.ageOf(p.birth_date) >= 15);
  const prio = Object.fromEntries((await db.all('SELECT * FROM priority_rules')).map((r) => [r.code, r]));
  const doctors = await db.all('SELECT * FROM doctors'); const users = Object.fromEntries((await db.all('SELECT id, username FROM users')).map((u) => [u.username, u.id]));
  const prefix = Object.fromEntries((await db.all('SELECT id, queue_prefix FROM departments')).map((d) => [d.id, d.queue_prefix]));
  const seq = {}; const num = (d, date) => { const k = d + '|' + date; seq[k] = (seq[k] || 0) + 1; return `${prefix[d]}-${String(seq[k]).padStart(3, '0')}`; };
  const hourW = [[7, 0.5], [8, 1.1], [9, 1.5], [10, 1.5], [11, 1.2], [12, 0.5], [13, 1], [14, 1.1], [15, 0.9], [16, 0.4]];
  const pickHour = () => { const tot = hourW.reduce((a, b) => a + b[1], 0); let x = R() * tot; for (const [h, w] of hourW) { if ((x -= w) <= 0) return h; } return 9; };
  const rxText = ['Amoxicillin 500 mg, 1 capsule 3 times a day for 7 days; Paracetamol 500 mg every 6 hours as needed', 'Losartan 50 mg once daily; Amlodipine 5 mg once daily', 'Metformin 500 mg twice daily with meals', 'Cetirizine 10 mg at bedtime; Salbutamol nebule as needed', 'Omeprazole 20 mg before breakfast for 14 days'];
  const pedRx = ['Paracetamol syrup 250 mg/5 mL, 5 mL every 6 hours as needed for fever', 'Amoxicillin suspension 250 mg/5 mL, 5 mL 3 times a day for 7 days', 'Oral rehydration salts after each loose stool'];
  const nowLocalMin = () => { const d = new Date(Date.now() + T * 36e5); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  const usedPerDay = {}; const labTests = [['cbc', 'Complete Blood Count (CBC)', 250], ['ua', 'Urinalysis', 120], ['fbs', 'Fasting Blood Sugar', 150], ['lipid', 'Lipid Profile', 650], ['crea', 'Creatinine', 200], ['fa', 'Fecalysis', 100]];
  const ENTRY = `INSERT INTO queue_entries(queue_number,queue_date,department_id,service_id,visit_id,patient_id,doctor_id,priority_rule_id,priority_weight,priority_reason,status,amount,created_at,queued_at,called_at,started_at,completed_at,call_count,counter_id,staff_user_id)
      VALUES(?,?,?,?,?,?,?,?,?,?, 'completed', ?,?,?,?,?,?,1,?,?)`;

  async function oneVisit(date, startMin) {
    const kid = R() < 0.22; const pool = kid ? kids : adults; usedPerDay[date] ||= new Set(); let p, tries = 0;
    do { p = pick(pool); tries++; } while (usedPerDay[date].has(p.id) && tries < 30); usedPerDay[date].add(p.id);
    const cons = kid ? dep.pediatrics : dep['internal-medicine']; const dr = kid ? doctors.find((d) => d.department_id === dep.pediatrics) : pick(doctors.filter((d) => d.department_id === dep['internal-medicine']));
    const senior = p.patient_type === 'Senior Citizen' && R() < 0.9; const rule = senior ? prio.senior : p.patient_type === 'PWD' ? prio.pwd : prio.regular;
    const path = (() => { const x = R(); return x < 0.5 ? 'lab' : x < 0.68 ? 'xray' : 'none'; })(); const rx = R() < 0.6;
    const t0 = iso(date, startMin); const t = Date.parse(t0);
    const vid = await db.insert(`INSERT INTO patient_visits(visit_no,patient_id,token,visit_date,created_at,reason,doctor_id,department_id,status,completed_at,expires_at) VALUES(?,?,?,?,?,?,?,?, 'completed', ?, ?)`,
      [await core.nextVisitNo(), p.id, crypto.randomBytes(18).toString('base64url'), date, t0, kid ? 'Cough and fever' : pick(['Check-up', 'High blood pressure', 'Stomach pain', 'Follow-up consultation', 'Headache', 'Cough and colds']), dr.id, cons, t0, new Date(t + 864e5).toISOString()]);
    let amount = 0; let lastEnd = t;
    const entry = async (deptId, serviceId, created, wait, svcMin, counter, staff, amt, doctorId) => {
      const called = created + wait * 60000, started = called + 30000, done = started + svcMin * 60000; const iso1 = (x) => new Date(x).toISOString();
      const id = await db.insert(ENTRY, [num(deptId, date), date, deptId, serviceId, vid, p.id, doctorId || null, rule.id, rule.weight, rule.weight ? 'Auto: ' + rule.label : null, amt, iso1(created), iso1(created), iso1(called), iso1(started), iso1(done), counter, staff]);
      return { id, done, created, started };
    };
    const w = (lo, hi) => between(lo, hi);
    const consult = await entry(cons, kid ? svc.pd : svc.im, t, w(4, 24), w(8, 17), dr.counter_id, dr.user_id, kid ? 300 : 350, dr.id); lastEnd = consult.done; amount += kid ? 300 : 350;
    if (path === 'lab') { const n = 1 + Math.floor(R() * 3); const picks = [...labTests].sort(() => R() - 0.5).slice(0, n); const price = picks.reduce((a, b) => a + b[2], 0); amount += price;
      const le = await entry(dep.laboratory, svc[picks[0][0]], lastEnd + 30000, w(3, 14), w(5, 11), pick([ctr.lab1, ctr.lab2]), users.lab, price); lastEnd = le.done;
      for (const [k, name] of picks) await db.run(`INSERT INTO laboratory_requests(visit_id,patient_id,queue_entry_id,service_id,test_name,status,requested_by,requested_at,specimen_collected_at,results_ready_at) VALUES(?,?,?,?,?, 'results_ready', ?,?,?,?)`,
        [vid, p.id, le.id, svc[k], name, users.drsantos, new Date(le.created).toISOString(), new Date(le.started).toISOString(), new Date(le.done + 20 * 60000).toISOString()]); }
    else if (path === 'xray') { const us = R() < 0.35; const price = us ? 1100 : 450; amount += price; const e = await entry(dep.radiology, us ? svc.us : svc.cxr, lastEnd + 30000, w(3, 12), w(7, 16), us ? ctr.usr : ctr.xr1, users.lab, price); lastEnd = e.done; }
    const cash = await entry(dep.cashier, svc.cashier, lastEnd + 30000, w(2, 12), w(2, 6), pick([ctr.c1, ctr.c2]), users.cashier, amount);
    await db.run(`INSERT INTO payments(visit_id,patient_id,queue_entry_id,amount,method,received_by,created_at) VALUES(?,?,?,?,?,?,?)`, [vid, p.id, cash.id, amount, pick(['Cash', 'Cash', 'Cash', 'GCash', 'GCash', 'Maya', 'Card', 'PhilHealth']), users.cashier, new Date(cash.done).toISOString()]); lastEnd = cash.done;
    if (rx) { const ph = await entry(dep.pharmacy, svc.disp, lastEnd + 30000, w(2, 12), w(2, 7), ctr.ph1, users.pharmacy, 0); lastEnd = ph.done;
      await db.run(`INSERT INTO prescriptions(visit_id,patient_id,queue_entry_id,items,status,prescribed_by,created_at,updated_at,released_at) VALUES(?,?,?,?, 'released', ?,?,?,?)`, [vid, p.id, ph.id, kid ? pick(pedRx) : pick(rxText), users.drsantos, new Date(consult.done).toISOString(), new Date(ph.done).toISOString(), new Date(ph.done).toISOString()]); }
    await db.run('UPDATE patient_visits SET completed_at=? WHERE id=?', [new Date(lastEnd).toISOString(), vid]);
  }
  await db.transaction(async () => {
    for (let d = SMALL ? 2 : 7; d >= 1; d--) {
      const date = addDays(todayStr, -d); const dow = new Date(date + 'T00:00:00Z').getUTCDay(); const n = SMALL ? 8 : dow === 0 ? 5 : dow === 6 ? 12 : Math.floor(between(18, 28));
      const mins = Array.from({ length: n }, () => pickHour() * 60 + Math.floor(R() * 60)).sort((a, b) => a - b); for (const mm of mins) await oneVisit(date, mm);
    }
    const cutoff = nowLocalMin() - 130; const first = 6 * 60 + 40; // today, before the live morning replayed by simulateToday()
    if (cutoff > first + 20) { const n = Math.min(SMALL ? 6 : 24, Math.floor((cutoff - first) / 9)); for (let i = 0; i < n; i++) await oneVisit(todayStr, Math.floor(first + (i * (cutoff - first)) / n)); }
    for (const [k, v] of Object.entries(seq)) { const [d, date] = k.split('|'); await db.run('INSERT INTO queue_sequences(department_id,period,last_number) VALUES(?,?,?) ON CONFLICT(department_id,period) DO UPDATE SET last_number=excluded.last_number', [Number(d), date, v]); }
    const adultCut = new Date(Date.now() - 18 * 365.25 * 864e5).toISOString().slice(0, 10);
    const free = await db.all(`SELECT id FROM patients WHERE id NOT IN (SELECT patient_id FROM patient_visits WHERE visit_date=?) AND birth_date < ? AND patient_type='Regular' ORDER BY id LIMIT 3 OFFSET 20`, [todayStr, adultCut]);
    for (let i = 0; i < Math.min(2, free.length); i++) await db.run(`INSERT INTO appointments(patient_id,doctor_id,department_id,scheduled_at,notes,created_at) VALUES(?,?,?,?,?,?)`, [free[i].id, doctors[i % 2].id, dep['internal-medicine'], iso(todayStr, 15 * 60 + i * 30), 'Follow-up', core.now()]);
  });
}

// ---------------------------------------------------------------------------------------------- the live morning
async function simulateToday({ dep }, { R, pick }) {
  const ctxs = {}; const as = async (u) => (ctxs[u] ||= { user: await auth.loadUser((await db.get('SELECT id FROM users WHERE username=?', [u])).id), ip: 'demo', ua: 'seed' });
  const todayStr = core.localDate(); const dayAgo = (years) => new Date(Date.now() - years * 365.25 * 864e5).toISOString().slice(0, 10);
  const named = async (f, l) => db.get('SELECT * FROM patients WHERE first_name=? AND last_name=?', [f, l]);
  const maria = await named('Maria', 'Santos'), pedro = await named('Pedro', 'Reyes'), ana = await named('Ana', 'Garcia'), juan = await named('Juan', 'Dela Cruz');
  const base = `p.id NOT IN (SELECT patient_id FROM patient_visits WHERE visit_date=?) AND p.id NOT IN (SELECT patient_id FROM appointments) ORDER BY p.id DESC`;
  const A = await db.all(`SELECT p.* FROM patients p WHERE p.birth_date < ? AND p.birth_date > ? AND p.patient_type='Regular' AND ${base}`, [dayAgo(18), dayAgo(59), todayStr]);
  const S = await db.all(`SELECT p.* FROM patients p WHERE p.patient_type='Senior Citizen' AND ${base}`, [todayStr]);
  const K = await db.all(`SELECT p.* FROM patients p WHERE p.birth_date > ? AND ${base}`, [dayAgo(14), todayStr]);
  const taken = new Set([juan.id, maria.id, pedro.id, ana.id]); const take = (list) => { const p = list.find((x) => !taken.has(x.id)); taken.add(p.id); return p; };
  const a = () => take(A), s = () => take(S), k = () => take(K);
  const reasons = ['Check-up', 'High blood pressure', 'Stomach pain', 'Headache', 'Cough and colds', 'Follow-up consultation', 'Dizziness'];
  const plan = [
    { p: a, stage: 'done', path: 'lab', rx: true }, { p: a, stage: 'done', path: 'none' }, { p: a, stage: 'done', path: 'xray' }, { p: k, stage: 'done', path: 'none', rx: true, ped: true },
    { p: a, stage: 'done', path: 'lab', rx: true }, { p: s, stage: 'done', path: 'none', rx: true }, { p: a, stage: 'done', path: 'lab' },
    { p: a, stage: 'pharmacy_serving', path: 'lab', rx: true }, { p: a, stage: 'pharmacy_wait', path: 'none', rx: true }, { p: s, stage: 'pharmacy_wait', path: 'lab', rx: true },
    { p: a, stage: 'cashier_serving', path: 'xray' }, { p: a, stage: 'cashier_wait', path: 'lab' }, { p: a, stage: 'cashier_wait', path: 'none' },
    { p: a, stage: 'xray_serving', path: 'xray' }, { p: a, stage: 'xray_wait', path: 'xray' }, { p: a, stage: 'lab_serving', path: 'lab' }, { p: a, stage: 'lab_wait', path: 'lab' }, { p: a, stage: 'lab_wait', path: 'lab' },
    { p: k, stage: 'consult_serving', path: 'none', ped: true }, { p: k, stage: 'consult_wait', path: 'none', ped: true }, { p: k, stage: 'consult_wait', path: 'none', ped: true },
    { p: () => maria, stage: 'consult_serving', path: 'lab', doc: 'drsantos' }, { p: () => pedro, stage: 'consult_called', path: 'none', doc: 'drreyes' },
    { p: () => ana, stage: 'consult_wait', path: 'lab' }, { p: a, stage: 'consult_wait', path: 'none' }, { p: s, stage: 'consult_wait', path: 'none' }, { p: a, stage: 'consult_wait', path: 'xray' },
  ];
  if (SMALL) { const keep = new Set([0, 3, 7, 8, 10, 11, 13, 14, 15, 16, 18, 19, 21, 22, 23, 24]); plan.splice(0, plan.length, ...plan.filter((_, i) => keep.has(i))); }
  const tail = { consult_wait: 6, consult_called: 1, consult_serving: 5, lab_wait: 5, lab_serving: 4, xray_wait: 5, xray_serving: 4, cashier_wait: 4, cashier_serving: 2, pharmacy_wait: 4, pharmacy_serving: 2, done: 0 };
  const labPick = [['Complete Blood Count (CBC)', 'Urinalysis'], ['Fasting Blood Sugar', 'Lipid Profile'], ['Complete Blood Count (CBC)'], ['Creatinine', 'Urinalysis']];
  const rxList = ['Losartan 50 mg once daily; Amlodipine 5 mg once daily', 'Amoxicillin 500 mg, 1 capsule 3 times a day for 7 days; Paracetamol 500 mg as needed', 'Metformin 500 mg twice daily with meals', 'Omeprazole 20 mg before breakfast for 14 days'];
  const pedRx = 'Paracetamol syrup 250 mg/5 mL, 5 mL every 6 hours as needed for fever';
  const svcId = async (n) => (await db.get('SELECT id FROM services WHERE name=?', [n])).id;
  const activeOf = async (visitId, kind) => (await db.get(`SELECT e.id FROM queue_entries e JOIN departments d ON d.id=e.department_id WHERE e.visit_id=? AND d.kind=? AND e.status IN ('waiting','called','serving') ORDER BY e.id DESC LIMIT 1`, [visitId, kind]))?.id;

  for (let idx = 0; idx < plan.length; idx++) {
    const spec = plan[idx]; const patient = spec.p(); const ped = !!spec.ped; const consDept = ped ? dep.pediatrics : dep['internal-medicine'];
    const docUser = spec.doc || (ped ? 'drgarcia' : idx % 2 ? 'drreyes' : 'drsantos'); const st = {}; const steps = [];
    const add = (stage, dur, run) => steps.push({ stage, dur, run });
    add('consult_wait', 0, async () => { const r = await core.createVisit(await as('reception'), { patient_id: patient.id, department_id: consDept, reason: pick(reasons) }); st.v = r.visit.id; });
    add('consult_called', 8, async () => { await core.callNext(await as(docUser), { department_id: consDept }); });
    add('consult_serving', 1, async () => { await core.startEntry(await as(docUser), await activeOf(st.v, 'consultation')); });
    const afterRoute = spec.path === 'lab' ? 'lab_wait' : spec.path === 'xray' ? 'xray_wait' : 'cashier_wait';
    add(afterRoute, 10, async () => {
      const c = await as(docUser); const e = await activeOf(st.v, 'consultation'); await core.completeEntry(c, e);
      if (spec.path === 'lab') await core.routeVisit(c, st.v, { kind: 'laboratory', service_ids: await Promise.all(labPick[idx % 4].map(svcId)), from_entry_id: e });
      else if (spec.path === 'xray') await core.routeVisit(c, st.v, { kind: 'radiology', service_ids: [await svcId(idx % 3 ? 'Chest X-Ray' : 'Ultrasound (Whole Abdomen)')], from_entry_id: e });
      else await core.routeVisit(c, st.v, { kind: 'cashier', from_entry_id: e });
      if (spec.rx) await core.routeVisit(c, st.v, { kind: 'pharmacy', items: ped ? pedRx : rxList[idx % 4], hold: true, from_entry_id: e });
    });
    if (spec.path === 'lab') {
      add('lab_called', 7, async () => { await core.callNext(await as('lab'), { department_id: dep.laboratory }); });
      add('lab_serving', 1, async () => { const l = await as('lab'); const e = await activeOf(st.v, 'laboratory'); await core.startEntry(l, e); await core.specimenCollected(l, e); });
      add('cashier_wait', 8, async () => { const l = await as('lab'); const e = await activeOf(st.v, 'laboratory'); await core.completeEntry(l, e); if (spec.stage === 'done' || idx % 2 === 0) await core.resultsReady(l, e, 'Results encoded. Please see your doctor.'); });
    } else if (spec.path === 'xray') {
      add('xray_called', 6, async () => { await core.callNext(await as('lab'), { department_id: dep.radiology }); });
      add('xray_serving', 1, async () => { await core.startEntry(await as('lab'), await activeOf(st.v, 'radiology')); });
      add('cashier_wait', 9, async () => { await core.completeEntry(await as('lab'), await activeOf(st.v, 'radiology')); });
    }
    add('cashier_serving', 5, async () => { await core.callNext(await as('cashier'), { department_id: dep.cashier }); });
    add(spec.rx ? 'pharmacy_wait' : 'done', 3, async () => { const c = await as('cashier'); const e = await core.getEntry(await activeOf(st.v, 'cashier')); await core.recordPayment(c, e.id, { amount: (await core.paymentSummary(e)).remaining || e.amount, method: pick(['Cash', 'Cash', 'GCash', 'Maya']), idempotency_key: crypto.randomUUID() }); });
    if (spec.rx) {
      add('pharmacy_called', 5, async () => { await core.callNext(await as('pharmacy'), { department_id: dep.pharmacy }); });
      add('pharmacy_serving', 1, async () => { await core.setPrescription(await as('pharmacy'), await activeOf(st.v, 'pharmacy'), 'preparing'); });
      add('done', 4, async () => { const e = await activeOf(st.v, 'pharmacy'); const ph = await as('pharmacy'); await core.setPrescription(ph, e, 'ready'); await core.setPrescription(ph, e, 'released'); });
    }
    const stop = steps.findIndex((x) => x.stage === spec.stage); if (stop < 0) throw new Error('seed stage not reachable: ' + spec.stage + ' idx ' + idx);
    const run = steps.slice(0, stop + 1); const total = run.reduce((x, y) => x + y.dur, 0) + tail[spec.stage] + (plan.length - idx) * 0.45;
    let at = -total; for (const step of run) { at += step.dur; core.setClockOffset(Math.round(at * 60000)); await step.run(); }
  }
  core.setClockOffset(0);
}

module.exports = { seedIfEmpty, seed, DEMO_PASSWORD };
if (require.main === module) {
  (async () => {
    await db.init();
    if (process.argv.includes('--reset')) {
      if (db.mode === 'postgres') { console.log('Refusing to wipe a real database. Delete the tables in the Supabase dashboard if you really want to start over.'); process.exit(1); }
      await db.close(); require('fs').rmSync((process.env.VISIQ_DATA || require('path').join(__dirname, '..', 'data')) + '/pglite', { recursive: true, force: true }); console.log('Local trial database deleted.'); process.exit(0);
    }
    console.log(await seedIfEmpty() ? 'Demo data created.' : 'The database already has data, so nothing was changed.'); process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
