// Sessions (stored in Postgres), sign-in through Supabase Auth, CSRF, and permission checks.
// Supabase Auth proves WHO someone is. VisiQ's own `users` table decides WHAT they may do (role + permissions).
const session = require('express-session');
const crypto = require('crypto');
const db = require('./db');
const core = require('./core');
const provider = require('./authprovider');
const { ROUTE_TARGETS } = require('./perms');

class PgStore extends session.Store {
  get(sid, cb) { db.get('SELECT sess, expires FROM sessions WHERE sid=?', [sid]).then((r) => cb(null, !r || r.expires < Date.now() ? null : JSON.parse(r.sess)), cb); }
  set(sid, sess, cb) {
    const exp = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 36e5;
    db.run('INSERT INTO sessions(sid,sess,expires,uid) VALUES(?,?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expires=excluded.expires, uid=excluded.uid', [sid, JSON.stringify(sess), exp, sess.uid ?? null]).then(() => cb?.(null), (e) => cb?.(e));
  }
  destroy(sid, cb) { db.run('DELETE FROM sessions WHERE sid=?', [sid]).then(() => cb?.(null), (e) => cb?.(e)); }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}
setInterval(() => { db.run('DELETE FROM sessions WHERE expires<?', [Date.now()]).catch(() => {}); }, 10 * 60 * 1000).unref();

async function sessionMiddleware() {
  let secret = process.env.SESSION_SECRET;
  if (!secret) { // generate one and keep it so sessions survive restarts
    const row = await db.get(`SELECT value FROM settings WHERE key='_session_secret'`);
    if (row) secret = row.value; else { secret = crypto.randomBytes(32).toString('hex'); await db.run(`INSERT INTO settings(key,value,updated_at) VALUES('_session_secret',?,?) ON CONFLICT(key) DO NOTHING`, [secret, core.now()]); secret = (await db.get(`SELECT value FROM settings WHERE key='_session_secret'`)).value; }
  }
  return session({ name: 'visiq.sid', secret, resave: false, saveUninitialized: false, rolling: true, store: new PgStore(),
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === '1', maxAge: 20 * 60 * 1000 } });
}

async function loadUser(id) {
  const u = await db.get(`SELECT u.*, r.code AS role, r.name AS role_name FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=? AND u.active=1 AND u.deleted_at IS NULL`, [id]);
  if (!u) return null;
  const perms = new Set((await db.all(`SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=?`, [u.role_id])).map((r) => r.code));
  const doctor = (await db.get('SELECT id, full_name, specialty, department_id, counter_id FROM doctors WHERE user_id=? AND active=1 AND deleted_at IS NULL', [u.id])) || null;
  return { id: u.id, username: u.username, email: u.email, auth_id: u.auth_id, full_name: u.full_name, role: u.role, role_name: u.role_name, perms, department_id: u.department_id, counter_id: u.counter_id, doctor };
}
const publicUser = (u) => ({ route_targets: ROUTE_TARGETS[u.role] || [], id: u.id, username: u.username, full_name: u.full_name, role: u.role, role_name: u.role_name, perms: [...u.perms], department_id: u.department_id, counter_id: u.counter_id, doctor: u.doctor });

// Attach req.user, keep the idle timeout in sync with the setting, and enforce CSRF on writes.
async function attach(req, res, next) {
  try {
    const mins = Math.min(240, Math.max(1, parseInt((await core.getSettings()).session_timeout_minutes, 10) || 20));
    if (req.session) req.session.cookie.maxAge = mins * 60 * 1000;
    // Idle timeout. Background refreshes (X-Background) do not count as activity, so an unattended screen really signs out.
    if (req.session?.uid) {
      const t = Date.now(); const last = req.session.last || t;
      if (t - last > mins * 60 * 1000) delete req.session.uid; else if (!req.get('x-background')) req.session.last = t;
    }
    req.user = req.session?.uid ? await loadUser(req.session.uid) : null;
    if (req.session?.uid && !req.user) delete req.session.uid;
    req.ctx = { user: req.user, ip: req.ip, ua: req.get('user-agent') };
    next();
  } catch (e) { next(e); }
}
function csrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = req.get('x-csrf-token') || ''; const want = req.session?.csrf || '';
  const ok = want.length && sent.length === want.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(want));
  if (!ok) return res.status(403).json({ error: 'Your session expired. Please refresh the page and try again.', code: 'csrf' });
  next();
}
const requireAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please sign in', code: 'auth' }));
const requirePerm = (...codes) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please sign in', code: 'auth' });
  if (codes.some((c) => req.user.perms.has(c))) return next();
  res.status(403).json({ error: 'You do not have access to this feature' });
};

async function login(req, identifier, password) {
  const id = String(identifier || '').trim().toLowerCase();
  const u = await db.get(`SELECT u.* FROM users u WHERE (lower(u.username)=? OR lower(u.email)=?) AND u.deleted_at IS NULL`, [id, id]);
  const bad = async () => { await core.audit({ ip: req.ip, ua: req.get('user-agent') }, 'auth.login_failed', { entity: 'user', id: u?.id, summary: `Failed sign-in for "${id.slice(0, 40)}"` }); throw new core.HttpError(401, 'Wrong username or password'); };
  if (!u || !u.active) { try { await provider.get().signIn(provider.emailFor(id), String(password || '')); } catch { /* same timing and answer either way */ } return bad(); }
  if (u.locked_until && new Date(u.locked_until) > new Date()) throw new core.HttpError(423, 'Too many wrong attempts. Try again in a few minutes.');
  let authId;
  try { authId = await provider.get().signIn(u.email, String(password || '')); }
  catch (e) {
    if (e.status && e.status !== 401) throw new core.HttpError(e.status, e.message); // service problem, not a wrong password
    const n = u.failed_attempts + 1;
    await db.run('UPDATE users SET failed_attempts=?, locked_until=? WHERE id=?', [n >= 5 ? 0 : n, n >= 5 ? new Date(Date.now() + 10 * 60000).toISOString() : null, u.id]);
    return bad();
  }
  if (u.auth_id && u.auth_id !== authId) return bad(); // the Supabase account is not the one linked to this profile
  await db.run('UPDATE users SET failed_attempts=0, locked_until=NULL, last_login_at=?, auth_id=COALESCE(auth_id, ?) WHERE id=?', [core.now(), authId, u.id]);
  await new Promise((res, rej) => req.session.regenerate((e) => (e ? rej(e) : res()))); // prevents session fixation
  req.session.uid = u.id; req.session.last = Date.now(); req.session.csrf = crypto.randomBytes(24).toString('base64url');
  const user = await loadUser(u.id); req.user = user; req.ctx = { user, ip: req.ip, ua: req.get('user-agent') };
  await core.audit(req.ctx, 'auth.login', { entity: 'user', id: u.id, summary: `${user.full_name} signed in` });
  return user;
}
function validatePassword(pw) { if (typeof pw !== 'string' || pw.length < 8) throw new core.HttpError(400, 'Password must be at least 8 characters'); if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new core.HttpError(400, 'Password needs letters and numbers'); }

module.exports = { sessionMiddleware, attach, csrf, requireAuth, requirePerm, login, loadUser, publicUser, validatePassword };
