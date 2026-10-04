// Dashboard statistics and reports. All times are shown in Philippine time.
const db = require('./db');
const core = require('./core');
const { localDate, LOCAL, mins } = core;
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const rnd = (expr) => `ROUND((${expr})::numeric, 1)`;

async function dashboard() {
  const today = localDate();
  const visits = await db.all(`SELECT status, COUNT(*) AS n FROM patient_visits WHERE visit_date=? AND deleted_at IS NULL GROUP BY status`, [today]);
  const vs = (s) => visits.find((v) => v.status === s)?.n || 0; const total = visits.reduce((a, b) => a + b.n, 0);
  const q = async (st) => (await db.get(`SELECT COUNT(*) AS n FROM queue_entries WHERE queue_date=? AND status IN (${st}) AND deleted_at IS NULL`, [today])).n;
  const wait = (await db.get(`SELECT AVG(${mins('created_at', 'called_at')}) AS a FROM queue_entries WHERE queue_date=? AND called_at IS NOT NULL AND deleted_at IS NULL`, [today])).a;
  const svc = (await db.get(`SELECT AVG(${mins('started_at', 'completed_at')}) AS a FROM queue_entries WHERE queue_date=? AND status='completed' AND started_at IS NOT NULL AND ${mins('started_at', 'completed_at')} BETWEEN 0.5 AND 120 AND deleted_at IS NULL`, [today])).a;
  const departments = (await db.all(`SELECT d.id, d.name, d.kind, COUNT(e.id) AS patients,
      COUNT(e.id) FILTER (WHERE e.status='waiting') AS waiting, COUNT(e.id) FILTER (WHERE e.status IN ('called','serving')) AS serving, COUNT(e.id) FILTER (WHERE e.status='completed') AS completed,
      AVG(CASE WHEN e.called_at IS NOT NULL THEN ${mins('e.created_at', 'e.called_at')} END) AS avg_wait
    FROM departments d LEFT JOIN queue_entries e ON e.department_id=d.id AND e.queue_date=? AND e.deleted_at IS NULL
    WHERE d.active=1 AND d.deleted_at IS NULL GROUP BY d.id ORDER BY d.sort_order, d.id`, [today])).map((d) => ({ ...d, avg_wait: r1(d.avg_wait) }));
  const hourly = (await db.all(`SELECT EXTRACT(HOUR FROM ${LOCAL('created_at')})::int AS h, COUNT(*) AS n,
      AVG(CASE WHEN called_at IS NOT NULL THEN ${mins('created_at', 'called_at')} END) AS w
    FROM queue_entries WHERE queue_date=? AND deleted_at IS NULL GROUP BY 1 ORDER BY 1`, [today])).map((h) => ({ hour: h.h, arrivals: h.n, avg_wait: r1(h.w) }));
  const activity = await db.all(`SELECT id, summary, action, created_at FROM audit_logs WHERE action NOT LIKE 'auth.%' ORDER BY id DESC LIMIT 12`);
  const active = await db.all(`SELECT d.name AS department, d.kind, e.queue_number, e.status, c.name AS counter
    FROM queue_entries e JOIN departments d ON d.id=e.department_id LEFT JOIN queue_counters c ON c.id=e.counter_id
    WHERE e.status IN ('called','serving') AND e.deleted_at IS NULL ORDER BY d.sort_order, e.called_at`);
  return { date: today, total_patients: total, waiting: await q(`'waiting'`), serving: await q(`'called','serving'`), completed: vs('completed'), cancelled: vs('cancelled'),
    no_show: await q(`'no_show'`), avg_wait: r1(wait), avg_service: r1(svc), departments, hourly, activity, active };
}

function range(kind, from, to) {
  const t = localDate(); const d = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  if (kind === 'yesterday') return { from: d(t, -1), to: d(t, -1) };
  if (kind === 'week') { const dow = (new Date(t + 'T00:00:00Z').getUTCDay() + 6) % 7; return { from: d(t, -dow), to: t }; }
  if (kind === 'month') return { from: t.slice(0, 8) + '01', to: t };
  if (kind === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(from || '') && /^\d{4}-\d{2}-\d{2}$/.test(to || '')) return from <= to ? { from, to } : { from: to, to: from };
  return { from: t, to: t };
}
const col = (key, label, type) => ({ key, label, type });
const SERVICE_MINS = `CASE WHEN started_at IS NOT NULL AND ${mins('started_at', 'completed_at')} BETWEEN 0.5 AND 120 THEN ${mins('started_at', 'completed_at')} END`;
const REPORTS = {
  daily_volume: { title: 'Daily patient volume', run: async ({ from, to }) => ({ columns: [col('date', 'Date'), col('visits', 'Visits', 'n'), col('completed', 'Completed', 'n'), col('cancelled', 'Cancelled', 'n')],
    rows: await db.all(`SELECT visit_date AS date, COUNT(*) AS visits, COUNT(*) FILTER (WHERE status='completed') AS completed, COUNT(*) FILTER (WHERE status='cancelled') AS cancelled FROM patient_visits WHERE visit_date BETWEEN ? AND ? AND deleted_at IS NULL GROUP BY visit_date ORDER BY visit_date`, [from, to]) }) },
  department_volume: { title: 'Department volume', run: async ({ from, to }) => ({ columns: [col('department', 'Department'), col('patients', 'Queue numbers', 'n'), col('completed', 'Completed', 'n'), col('waiting', 'Still waiting', 'n')],
    rows: await db.all(`SELECT d.name AS department, COUNT(e.id) AS patients, COUNT(e.id) FILTER (WHERE e.status='completed') AS completed, COUNT(e.id) FILTER (WHERE e.status='waiting') AS waiting FROM departments d LEFT JOIN queue_entries e ON e.department_id=d.id AND e.queue_date BETWEEN ? AND ? AND e.deleted_at IS NULL WHERE d.deleted_at IS NULL AND d.active=1 GROUP BY d.id ORDER BY d.sort_order`, [from, to]) }) },
  queue_performance: { title: 'Queue performance', run: async ({ from, to }) => ({ columns: [col('department', 'Department'), col('served', 'Served', 'n'), col('avg_wait', 'Avg wait (min)', 'n'), col('max_wait', 'Longest wait (min)', 'n'), col('avg_service', 'Avg service (min)', 'n')],
    rows: await db.all(`SELECT d.name AS department, COUNT(e.id) AS served, ${rnd('AVG(' + mins('e.created_at', 'e.called_at') + ')')} AS avg_wait, ${rnd('MAX(' + mins('e.created_at', 'e.called_at') + ')')} AS max_wait,
      ${rnd('AVG(' + SERVICE_MINS.replace(/started_at/g, 'e.started_at').replace(/completed_at/g, 'e.completed_at') + ')')} AS avg_service
      FROM departments d JOIN queue_entries e ON e.department_id=d.id AND e.queue_date BETWEEN ? AND ? AND e.called_at IS NOT NULL AND e.deleted_at IS NULL GROUP BY d.id ORDER BY d.sort_order`, [from, to]) }) },
  average_waiting: { title: 'Average waiting time by day', run: async ({ from, to }) => ({ columns: [col('date', 'Date'), col('avg_wait', 'Avg wait (min)', 'n'), col('avg_service', 'Avg service (min)', 'n')],
    rows: await db.all(`SELECT queue_date AS date, ${rnd('AVG(' + mins('created_at', 'called_at') + ')')} AS avg_wait, ${rnd('AVG(' + SERVICE_MINS + ')')} AS avg_service
      FROM queue_entries WHERE queue_date BETWEEN ? AND ? AND called_at IS NOT NULL AND deleted_at IS NULL GROUP BY queue_date ORDER BY queue_date`, [from, to]) }) },
  outcomes: { title: 'Completed, cancelled and no-show', run: async ({ from, to }) => ({ columns: [col('department', 'Department'), col('completed', 'Completed', 'n'), col('cancelled', 'Cancelled', 'n'), col('no_show', 'No-show', 'n'), col('skipped', 'Skipped', 'n')],
    rows: await db.all(`SELECT d.name AS department, COUNT(e.id) FILTER (WHERE e.status='completed') AS completed, COUNT(e.id) FILTER (WHERE e.status='cancelled') AS cancelled, COUNT(e.id) FILTER (WHERE e.status='no_show') AS no_show, COUNT(e.id) FILTER (WHERE e.status='skipped') AS skipped
      FROM departments d LEFT JOIN queue_entries e ON e.department_id=d.id AND e.queue_date BETWEEN ? AND ? AND e.deleted_at IS NULL WHERE d.deleted_at IS NULL AND d.active=1 GROUP BY d.id ORDER BY d.sort_order`, [from, to]) }) },
  peak_hours: { title: 'Peak hours', run: async ({ from, to }) => ({ columns: [col('hour', 'Hour'), col('arrivals', 'Queue numbers issued', 'n'), col('avg_wait', 'Avg wait (min)', 'n')],
    rows: await db.all(`SELECT to_char(${LOCAL('created_at')}, 'HH24:00') AS hour, COUNT(*) AS arrivals, ${rnd('AVG(CASE WHEN called_at IS NOT NULL THEN ' + mins('created_at', 'called_at') + ' END)')} AS avg_wait
      FROM queue_entries WHERE queue_date BETWEEN ? AND ? AND deleted_at IS NULL GROUP BY 1 ORDER BY 1`, [from, to]) }) },
  doctor_workload: { title: 'Doctor workload', run: async ({ from, to }) => ({ columns: [col('doctor', 'Doctor'), col('specialty', 'Specialty'), col('patients', 'Patients seen', 'n'), col('avg_service', 'Avg consultation (min)', 'n')],
    rows: await db.all(`SELECT d.full_name AS doctor, d.specialty, COUNT(e.id) AS patients, ${rnd('AVG(CASE WHEN ' + mins('e.started_at', 'e.completed_at') + ' BETWEEN 0.5 AND 120 THEN ' + mins('e.started_at', 'e.completed_at') + ' END)')} AS avg_service
      FROM doctors d LEFT JOIN queue_entries e ON e.doctor_id=d.id AND e.status='completed' AND e.queue_date BETWEEN ? AND ? AND e.deleted_at IS NULL WHERE d.deleted_at IS NULL GROUP BY d.id ORDER BY patients DESC`, [from, to]) }) },
  laboratory_workload: { title: 'Laboratory workload', run: async ({ from, to }) => ({ columns: [col('test', 'Test'), col('requests', 'Requests', 'n'), col('ready', 'Results ready', 'n')],
    rows: await db.all(`SELECT r.test_name AS test, COUNT(*) AS requests, COUNT(*) FILTER (WHERE r.status='results_ready') AS ready FROM laboratory_requests r WHERE ${LOCAL('r.requested_at')}::date BETWEEN ? AND ? GROUP BY r.test_name ORDER BY requests DESC`, [from, to]) }) },
  cashier_transactions: { title: 'Cashier transactions', run: async ({ from, to }) => ({ columns: [col('date', 'Date/time'), col('visit', 'Visit'), col('queue', 'Queue no.'), col('method', 'Method'), col('amount', 'Amount (PHP)', 'n'), col('cashier', 'Received by')],
    rows: await db.all(`SELECT to_char(${LOCAL('p.created_at')}, 'YYYY-MM-DD HH24:MI') AS date, v.visit_no AS visit, e.queue_number AS queue, p.method AS method, p.amount AS amount, u.full_name AS cashier
      FROM payments p JOIN patient_visits v ON v.id=p.visit_id JOIN queue_entries e ON e.id=p.queue_entry_id LEFT JOIN users u ON u.id=p.received_by
      WHERE p.status='paid' AND ${LOCAL('p.created_at')}::date BETWEEN ? AND ? ORDER BY p.created_at`, [from, to]) }) },
  pharmacy_transactions: { title: 'Pharmacy transactions', run: async ({ from, to }) => ({ columns: [col('status', 'Prescription status'), col('count', 'Prescriptions', 'n')],
    rows: await db.all(`SELECT status, COUNT(*) AS count FROM prescriptions WHERE ${LOCAL('created_at')}::date BETWEEN ? AND ? GROUP BY status ORDER BY count DESC`, [from, to]) }) },
};
async function report(type, q) {
  const def = REPORTS[type]; if (!def) throw new core.HttpError(404, 'Unknown report');
  const rg = range(q.range, q.from, q.to);
  return { type, title: def.title, ...rg, ...(await def.run(rg)) };
}
const reportList = () => Object.entries(REPORTS).map(([id, d]) => ({ id, title: d.title }));
module.exports = { dashboard, report, reportList };
