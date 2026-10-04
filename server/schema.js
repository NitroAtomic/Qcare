// QCare schema for PostgreSQL / Supabase. Idempotent: safe to run on every start.
// Row-level security is switched ON for every table with NO policies, so Supabase's public API (anon / authenticated keys)
// can never read or write hospital data. QCare's server connects with the database owner role and enforces permissions itself.
const TABLES = ['roles', 'permissions', 'role_permissions', 'departments', 'services', 'queue_counters', 'users', 'doctors', 'patients', 'patient_visits', 'priority_rules', 'queue_sequences', 'queue_entries',
  'appointments', 'laboratory_requests', 'laboratory_results', 'prescriptions', 'payments', 'notifications', 'audit_logs', 'settings', 'sessions', 'counters', 'local_credentials'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS roles(
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT);
CREATE TABLE IF NOT EXISTS permissions(
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, code TEXT UNIQUE NOT NULL, description TEXT);
CREATE TABLE IF NOT EXISTS role_permissions(
  role_id INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY(role_id, permission_id));

CREATE TABLE IF NOT EXISTS departments(
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('consultation','laboratory','radiology','pharmacy','cashier','registration','records','billing','other')),
  queue_prefix TEXT NOT NULL, avg_service_minutes INT NOT NULL DEFAULT 10,
  active INT NOT NULL DEFAULT 1, show_on_display INT NOT NULL DEFAULT 1, sort_order INT NOT NULL DEFAULT 0, deleted_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS services(
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, department_id INT NOT NULL REFERENCES departments(id),
  code TEXT, name TEXT NOT NULL, price NUMERIC(12,2) NOT NULL DEFAULT 0, active INT NOT NULL DEFAULT 1, deleted_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS queue_counters(
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, department_id INT NOT NULL REFERENCES departments(id),
  name TEXT NOT NULL, active INT NOT NULL DEFAULT 1, deleted_at TIMESTAMPTZ);

-- Staff profile. The password lives in Supabase Auth (auth_id = auth.users.id), never in this table.
CREATE TABLE IF NOT EXISTS users(
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, auth_id UUID UNIQUE, email TEXT UNIQUE NOT NULL, username TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL, role_id INT NOT NULL REFERENCES roles(id),
  department_id INT REFERENCES departments(id), counter_id INT REFERENCES queue_counters(id),
  active INT NOT NULL DEFAULT 1, failed_attempts INT NOT NULL DEFAULT 0, locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS doctors(
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id INT UNIQUE REFERENCES users(id),
  full_name TEXT NOT NULL, specialty TEXT, department_id INT NOT NULL REFERENCES departments(id),
  counter_id INT REFERENCES queue_counters(id), active INT NOT NULL DEFAULT 1, deleted_at TIMESTAMPTZ);

CREATE TABLE IF NOT EXISTS patients(
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, patient_no TEXT UNIQUE NOT NULL,
  first_name TEXT NOT NULL, middle_name TEXT, last_name TEXT NOT NULL, suffix TEXT,
  birth_date DATE NOT NULL, sex TEXT NOT NULL CHECK(sex IN ('Male','Female')),
  contact_no TEXT, address TEXT, emergency_contact_name TEXT, emergency_contact_no TEXT,
  patient_type TEXT NOT NULL DEFAULT 'Regular',
  created_at TIMESTAMPTZ NOT NULL, created_by INT REFERENCES users(id), deleted_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(lower(last_name), lower(first_name));
CREATE INDEX IF NOT EXISTS idx_patients_contact ON patients(contact_no);
CREATE INDEX IF NOT EXISTS idx_patients_dob ON patients(birth_date);

CREATE TABLE IF NOT EXISTS patient_visits(
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, visit_no TEXT UNIQUE NOT NULL,
  patient_id INT NOT NULL REFERENCES patients(id), token TEXT UNIQUE NOT NULL,
  visit_date DATE NOT NULL, created_at TIMESTAMPTZ NOT NULL, reason TEXT,
  doctor_id INT REFERENCES doctors(id), department_id INT REFERENCES departments(id),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','in_service','waiting_next','completed','cancelled')),
  completed_at TIMESTAMPTZ, expires_at TIMESTAMPTZ NOT NULL, created_by INT REFERENCES users(id), deleted_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS idx_visits_patient ON patient_visits(patient_id);
CREATE INDEX IF NOT EXISTS idx_visits_date ON patient_visits(visit_date, status);

CREATE TABLE IF NOT EXISTS priority_rules(
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, code TEXT UNIQUE NOT NULL, label TEXT NOT NULL, weight INT NOT NULL DEFAULT 0,
  requires_reason INT NOT NULL DEFAULT 0, enabled INT NOT NULL DEFAULT 1, sort_order INT NOT NULL DEFAULT 0, description TEXT);

CREATE TABLE IF NOT EXISTS queue_sequences(
  department_id INT NOT NULL REFERENCES departments(id), period TEXT NOT NULL,
  last_number INT NOT NULL, PRIMARY KEY(department_id, period));
CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY, last_number INT NOT NULL);

CREATE TABLE IF NOT EXISTS queue_entries(
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, queue_number TEXT NOT NULL, queue_date DATE NOT NULL,
  department_id INT NOT NULL REFERENCES departments(id), service_id INT REFERENCES services(id),
  visit_id INT NOT NULL REFERENCES patient_visits(id), patient_id INT NOT NULL REFERENCES patients(id),
  doctor_id INT REFERENCES doctors(id),
  priority_rule_id INT REFERENCES priority_rules(id), priority_weight INT NOT NULL DEFAULT 0, priority_reason TEXT,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','called','serving','completed','skipped','cancelled','no_show')),
  amount NUMERIC(12,2) NOT NULL DEFAULT 0, notes TEXT,
  created_at TIMESTAMPTZ NOT NULL, queued_at TIMESTAMPTZ NOT NULL, called_at TIMESTAMPTZ, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
  call_count INT NOT NULL DEFAULT 0, counter_id INT REFERENCES queue_counters(id),
  staff_user_id INT REFERENCES users(id), created_by INT REFERENCES users(id),
  source_entry_id INT REFERENCES queue_entries(id), deleted_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS idx_qe_dept ON queue_entries(department_id, queue_date, status);
CREATE INDEX IF NOT EXISTS idx_qe_visit ON queue_entries(visit_id);
CREATE INDEX IF NOT EXISTS idx_qe_number ON queue_entries(queue_number);
CREATE INDEX IF NOT EXISTS idx_qe_order ON queue_entries(department_id, queue_date, priority_weight DESC, queued_at, id) WHERE status='waiting';
CREATE UNIQUE INDEX IF NOT EXISTS uq_qe_number ON queue_entries(department_id, queue_date, queue_number);
-- A visit can never be in the same department queue twice at the same time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_qe_active ON queue_entries(visit_id, department_id)
  WHERE status IN ('waiting','called','serving') AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS appointments(
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, patient_id INT NOT NULL REFERENCES patients(id),
  doctor_id INT REFERENCES doctors(id), department_id INT REFERENCES departments(id),
  scheduled_at TIMESTAMPTZ NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled', notes TEXT, created_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS idx_appt_patient ON appointments(patient_id, scheduled_at);

CREATE TABLE IF NOT EXISTS laboratory_requests(
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, visit_id INT NOT NULL REFERENCES patient_visits(id),
  patient_id INT NOT NULL REFERENCES patients(id), queue_entry_id INT NOT NULL REFERENCES queue_entries(id),
  service_id INT REFERENCES services(id), test_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','specimen_collected','results_ready','cancelled')),
  requested_by INT REFERENCES users(id), requested_at TIMESTAMPTZ NOT NULL,
  specimen_collected_at TIMESTAMPTZ, results_ready_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS idx_lab_entry ON laboratory_requests(queue_entry_id);
CREATE INDEX IF NOT EXISTS idx_lab_visit ON laboratory_requests(visit_id);
CREATE TABLE IF NOT EXISTS laboratory_results(
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, request_id INT NOT NULL REFERENCES laboratory_requests(id),
  summary TEXT, recorded_by INT REFERENCES users(id), recorded_at TIMESTAMPTZ NOT NULL);

CREATE TABLE IF NOT EXISTS prescriptions(
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, visit_id INT NOT NULL REFERENCES patient_visits(id),
  patient_id INT NOT NULL REFERENCES patients(id), queue_entry_id INT REFERENCES queue_entries(id),
  items TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','preparing','ready','released','cancelled')),
  hold_until_paid INT NOT NULL DEFAULT 0, prescribed_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, released_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS idx_rx_visit ON prescriptions(visit_id);
CREATE INDEX IF NOT EXISTS idx_rx_entry ON prescriptions(queue_entry_id);

-- One row per payment transaction. Only the method label and a note are kept (no card or account numbers).
CREATE TABLE IF NOT EXISTS payments(
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, visit_id INT NOT NULL REFERENCES patient_visits(id),
  patient_id INT NOT NULL REFERENCES patients(id), queue_entry_id INT NOT NULL REFERENCES queue_entries(id),
  amount NUMERIC(12,2) NOT NULL CHECK(amount > 0), method TEXT NOT NULL DEFAULT 'Cash', note TEXT,
  status TEXT NOT NULL DEFAULT 'paid' CHECK(status IN ('paid','cancelled')),
  idempotency_key TEXT UNIQUE, received_by INT REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS idx_pay_entry ON payments(queue_entry_id);

CREATE TABLE IF NOT EXISTS notifications(
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, body TEXT, visit_id INT REFERENCES patient_visits(id),
  created_at TIMESTAMPTZ NOT NULL, read_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);

CREATE TABLE IF NOT EXISTS audit_logs(
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id INT, username TEXT, role TEXT, action TEXT NOT NULL,
  entity_type TEXT, entity_id TEXT, patient_id INT, visit_id INT, summary TEXT NOT NULL,
  prev_value TEXT, new_value TEXT, ip TEXT, user_agent TEXT, created_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_visit ON audit_logs(visit_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);

CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires BIGINT NOT NULL, uid INT);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires);
-- Only used when running without Supabase (local trial mode). Empty in production.
CREATE TABLE IF NOT EXISTS local_credentials(auth_id UUID PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
`;
const RLS = TABLES.map((t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`).join('\n');
module.exports = { SCHEMA, RLS, TABLES, FULL: SCHEMA + '\n' + RLS + '\n' };
