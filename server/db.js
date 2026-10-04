// Database adapter. One tiny API on top of either:
//   - Supabase / any PostgreSQL (set DATABASE_URL)          <- production
//   - PGlite, PostgreSQL running inside Node (no DATABASE_URL) <- local trial and automated tests
// Transactions are carried implicitly (AsyncLocalStorage), so code inside db.transaction(...) just calls db.get/all/run.
const { AsyncLocalStorage } = require('async_hooks');
const path = require('path');
const fs = require('fs');
const { FULL } = require('./schema');

const als = new AsyncLocalStorage();
// Same type handling for both backends: ids and counts are numbers, money is a float, dates stay plain strings, timestamps are ISO strings.
const PARSERS = { 20: (v) => parseInt(v, 10), 1700: (v) => parseFloat(v), 1082: (v) => v, 1184: (v) => new Date(v).toISOString() };

// "?" placeholders or "@name" placeholders -> $1, $2 ...
function convert(sql, params) {
  if (params === undefined || Array.isArray(params)) { let i = 0; return { text: sql.replace(/\?/g, () => '$' + ++i), values: params || [] }; }
  const names = [];
  const text = sql.replace(/@(\w+)/g, (m, n) => { let k = names.indexOf(n); if (k < 0) { names.push(n); k = names.length - 1; } return '$' + (k + 1); });
  return { text, values: names.map((n) => params[n]) };
}

let backend = null; let mode = null;

async function init() {
  if (backend) return;
  const url = process.env.DATABASE_URL;
  if (url) {
    const { Pool, types } = require('pg');
    for (const [oid, fn] of Object.entries(PARSERS)) types.setTypeParser(Number(oid), fn);
    const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
    const pool = new Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX) || 10, ssl: local || process.env.DATABASE_SSL === '0' ? false : { rejectUnauthorized: false }, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 });
    pool.on('error', (e) => console.error('Database connection error:', e.message));
    backend = { kind: 'postgres', query: (c, text, values) => (c || pool).query(text, values).then((r) => ({ rows: r.rows, count: r.rowCount })),
      async tx(fn) { const c = await pool.connect(); try { await c.query('BEGIN'); const out = await als.run({ client: c }, fn); await c.query('COMMIT'); return out; } catch (e) { try { await c.query('ROLLBACK'); } catch { /* ignore */ } throw e; } finally { c.release(); } },
      exec: (text) => pool.query(text), close: () => pool.end() };
    mode = 'postgres';
  } else {
    const { PGlite } = require('@electric-sql/pglite');
    const dir = process.env.QCARE_DATA === 'memory' ? undefined : (process.env.QCARE_DATA || path.join(__dirname, '..', 'data')) + '/pglite';
    if (dir) fs.mkdirSync(path.dirname(dir), { recursive: true });
    const pg = dir ? new PGlite(dir, { parsers: PARSERS }) : new PGlite({ parsers: PARSERS }); await pg.waitReady;
    let chain = Promise.resolve(); const locked = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; }; // one connection: serialise work
    backend = { kind: 'pglite', query: (c, text, values) => (c ? pg.query(text, values) : locked(() => pg.query(text, values))).then((r) => ({ rows: r.rows, count: r.affectedRows ?? r.rows.length })),
      tx: (fn) => locked(async () => { await pg.exec('BEGIN'); try { const out = await als.run({ client: 'pglite' }, fn); await pg.exec('COMMIT'); return out; } catch (e) { try { await pg.exec('ROLLBACK'); } catch { /* ignore */ } throw e; } }),
      exec: (text) => locked(() => pg.exec(text)), close: () => pg.close() };
    mode = 'pglite';
  }
  await backend.exec(FULL);
}

const client = () => { const s = als.getStore(); return s ? s.client : null; };
async function run(sql, params) { const { text, values } = convert(sql, params); const r = await backend.query(client(), text, values); return { rows: r.rows, changes: r.count }; }
const all = async (sql, params) => (await run(sql, params)).rows;
const get = async (sql, params) => (await run(sql, params)).rows[0];
const insert = async (sql, params) => (await get(sql + ' RETURNING id', params)).id;
const transaction = (fn) => (als.getStore() ? fn() : backend.tx(fn)); // nested calls join the outer transaction
module.exports = { init, run, all, get, insert, transaction, exec: (t) => backend.exec(t), close: () => backend.close(), get mode() { return mode; } };
