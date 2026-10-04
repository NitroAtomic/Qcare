// Who checks passwords?
//   Supabase Auth  (SUPABASE_URL + SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY set)   <- production
//   Local          (nothing set)  passwords hashed with bcrypt in the database, for trial runs and tests only
// VisiQ keeps roles and permissions in its own `users` table, linked to the provider by auth_id.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

const EMAIL_DOMAIN = process.env.VISIQ_EMAIL_DOMAIN || 'visiq.example.com';
const emailFor = (username) => `${String(username).toLowerCase()}@${EMAIL_DOMAIN}`;
class AuthError extends Error { constructor(status, message) { super(message); this.status = status; } }

function supabaseProvider() {
  const { createClient } = require('@supabase/supabase-js');
  const clean = (v) => String(v || '').trim().replace(/^['"]|['"]$/g, ''); const url = clean(process.env.SUPABASE_URL).replace(/\/+$/, ''); const anon = clean(process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY); const service = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  const admin = createClient(url, service, opts);
  const findByEmail = async (email) => { for (let page = 1; page <= 20; page++) { const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 }); if (error) throw new AuthError(502, 'Could not reach Supabase Auth: ' + error.message); const u = data.users.find((x) => x.email?.toLowerCase() === email.toLowerCase()); if (u) return u; if (data.users.length < 200) break; } return null; };
  return {
    name: 'supabase',
    // Run before anything is written, so a wrong key never leaves a half-finished setup behind.
    async check() {
      if (/^sb_publishable_|^eyJ/.test(service) === false && !/^sb_secret_/.test(service)) throw new AuthError(500, 'SUPABASE_SERVICE_ROLE_KEY does not look like a Supabase secret key. It should start with sb_secret_ (or eyJ for the older service_role key).');
      if (/^sb_publishable_/.test(service)) throw new AuthError(500, 'SUPABASE_SERVICE_ROLE_KEY holds the PUBLISHABLE key. Put the SECRET key there (API Keys page, "Secret keys" section).');
      const { error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
      if (error) {
        if (/invalid api key|apikey|jwt|unauthor|forbidden/i.test(error.message)) throw new AuthError(500, 'Supabase rejected SUPABASE_SERVICE_ROLE_KEY ("' + error.message + '"). Copy the secret key again from Project Settings > API Keys, with no spaces, quotes or line breaks, and make sure SUPABASE_URL belongs to the same project.');
        if (/fetch|network|ENOTFOUND|timeout/i.test(error.message)) throw new AuthError(503, 'Cannot reach ' + url + '. Check SUPABASE_URL and your internet connection.');
        throw new AuthError(500, 'Supabase Auth check failed: ' + error.message);
      }
    },
    async signIn(email, password) {
      const c = createClient(url, anon || service, opts); // a fresh client per sign-in so nothing is shared between staff
      const { data, error } = await c.auth.signInWithPassword({ email, password });
      if (error || !data?.user) { if (error && /fetch|network|ENOTFOUND|timeout/i.test(error.message)) throw new AuthError(503, 'Cannot reach the sign-in service. Try again.'); throw new AuthError(401, 'Wrong username or password'); }
      return data.user.id;
    },
    async createUser(email, password, { overwrite = false } = {}) {
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (!error) return data.user.id;
      if (/already|registered|exists/i.test(error.message)) { if (!overwrite) throw new AuthError(409, 'That email is already used by another account'); const u = await findByEmail(email); if (!u) throw new AuthError(409, error.message); await admin.auth.admin.updateUserById(u.id, { password, ban_duration: 'none', email_confirm: true }); return u.id; }
      throw new AuthError(/fetch|network|ENOTFOUND|timeout/i.test(error.message) ? 503 : 400, /fetch|network|ENOTFOUND|timeout/i.test(error.message) ? 'Cannot reach Supabase Auth. Check SUPABASE_URL and your internet connection.' : error.message);
    },
    async setPassword(authId, password) { const { error } = await admin.auth.admin.updateUserById(authId, { password }); if (error) throw new AuthError(/fetch|network/i.test(error.message) ? 503 : 400, /fetch|network/i.test(error.message) ? 'Cannot reach Supabase Auth.' : error.message); },
    async setActive(authId, active) { const { error } = await admin.auth.admin.updateUserById(authId, { ban_duration: active ? 'none' : '876000h' }); if (error) throw new AuthError(400, error.message); },
    async remove(authId) { await admin.auth.admin.deleteUser(authId); },
  };
}

function localProvider() {
  return {
    name: 'local',
    async check() { /* nothing to check */ },
    async signIn(email, password) {
      const r = await db.get('SELECT auth_id, password_hash FROM local_credentials WHERE lower(email)=lower(?)', [email]);
      const ok = await bcrypt.compare(String(password || ''), r?.password_hash || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid.');
      if (!r || !ok) throw new AuthError(401, 'Wrong username or password');
      return r.auth_id;
    },
    async createUser(email, password, { overwrite = false } = {}) {
      const ex = await db.get('SELECT auth_id FROM local_credentials WHERE lower(email)=lower(?)', [email]);
      if (ex) { if (!overwrite) throw new AuthError(409, 'That email is already used by another account'); await db.run('UPDATE local_credentials SET password_hash=? WHERE auth_id=?', [bcrypt.hashSync(password, 10), ex.auth_id]); return ex.auth_id; }
      const id = crypto.randomUUID(); await db.run('INSERT INTO local_credentials(auth_id,email,password_hash) VALUES(?,?,?)', [id, email.toLowerCase(), bcrypt.hashSync(password, 10)]); return id;
    },
    async setPassword(authId, password) { await db.run('UPDATE local_credentials SET password_hash=? WHERE auth_id=?', [bcrypt.hashSync(password, 10), authId]); },
    async setActive() { /* the users table's own "active" flag is enough in local mode */ },
    async remove(authId) { await db.run('DELETE FROM local_credentials WHERE auth_id=?', [authId]); },
  };
}

let provider = null;
function get() {
  if (provider) return provider;
  const sb = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY) && process.env.VISIQ_AUTH !== 'local';
  provider = sb ? supabaseProvider() : localProvider(); return provider;
}
module.exports = { get, emailFor, AuthError, EMAIL_DOMAIN };
