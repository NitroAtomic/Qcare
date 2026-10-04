require('./env');
const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const db = require('./db');
const core = require('./core');
const auth = require('./auth');
const authprovider = require('./authprovider');
const { api, pub } = require('./routes');
const { seedIfEmpty } = require('./seed');

async function createApp() {
  await db.init();
  await seedIfEmpty();
  const app = express();
  const tp = (process.env.TRUST_PROXY || '').trim(); if (tp && tp !== '0') app.set('trust proxy', tp === '1' ? 1 : tp);
  app.disable('x-powered-by');
  const https = process.env.COOKIE_SECURE === '1';
  app.use(helmet({
    contentSecurityPolicy: { useDefaults: false, directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], styleSrcAttr: ["'unsafe-inline'"],
      fontSrc: ["'self'"], imgSrc: ["'self'", 'data:'], objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'self'"],
      connectSrc: ["'self'", (req) => `ws://${req.headers.host} wss://${req.headers.host}`] } },
    hsts: https ? { maxAge: 15552000 } : false, crossOriginResourcePolicy: { policy: 'same-origin' },
  }));
  app.use(express.json({ limit: '400kb' }));
  app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api/public', rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please wait a moment.' } }), pub);
  app.use('/api/login', rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many sign-in attempts. Please wait a few minutes.' } }));
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 900, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please slow down.' } }));
  app.use('/api', await auth.sessionMiddleware(), auth.attach, auth.csrf, api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.get('/display', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'display.html')));
  app.get('/q/:token', (req, res) => { res.set('Referrer-Policy', 'no-referrer'); res.sendFile(path.join(__dirname, '..', 'public', 'track.html')); });
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '5m', extensions: ['html'] }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof core.HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    if (err instanceof authprovider.AuthError) return res.status(err.status).json({ error: err.message });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large' });
    if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({ error: 'Bad request' });
    const c = String(err?.code || '');
    if (c === '23505') return res.status(409).json({ error: 'That was already done by someone else. Please check the screen.' });          // unique violation
    if (c === '40001' || c === '40P01') return res.status(409).json({ error: 'The system was busy. Please try again.' });                   // serialization / deadlock
    if (c === '23503' || c === '23514' || c === '22P02' || c === '22007' || c === '22008') return res.status(400).json({ error: 'Some of the information is not valid.' });
    console.error(err); res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
  });
  return app;
}

// WebSocket: pings only ("something changed"). No patient data is ever sent over the socket.
function attachRealtime(server) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 });
  const send = (msg) => { const data = JSON.stringify(msg); for (const c of wss.clients) if (c.readyState === 1) c.send(data); };
  let pending = null;
  core.bus.on('change', (e) => { // coalesce bursts into one message
    if (!pending) { pending = { d: new Set(), all: false }; setTimeout(() => { send({ t: 'queue', d: [...pending.d], all: pending.all }); pending = null; }, 80); }
    if (e.all) pending.all = true; (e.depts || []).forEach((x) => pending.d.add(x));
  });
  core.bus.on('announce', (a) => send({ t: 'announce', ...a }));
  const beat = setInterval(() => { for (const c of wss.clients) { if (c.isAlive === false) { c.terminate(); continue; } c.isAlive = false; c.ping(); } }, 30000); beat.unref();
  wss.on('connection', (ws) => { ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; }); ws.on('error', () => {}); ws.send(JSON.stringify({ t: 'hello' })); });
  return wss;
}

async function start(port = Number(process.env.PORT) || 3000) {
  const app = await createApp(); const server = http.createServer(app); attachRealtime(server);
  return new Promise((resolve) => server.listen(port, () => resolve({ server, port: server.address().port })));
}
if (require.main === module) {
  start().then(({ port }) => {
    console.log(`\n  VisiQ is running\n  Staff:     http://localhost:${port}\n  TV board:  http://localhost:${port}/display`);
    console.log(`  Database:  ${db.mode === 'postgres' ? 'Supabase / PostgreSQL' : 'built-in local Postgres (trial mode, set DATABASE_URL to use Supabase)'}`);
    console.log(`  Sign-in:   ${authprovider.get().name === 'supabase' ? 'Supabase Auth' : 'local passwords (trial mode, set the SUPABASE_* variables to use Supabase Auth)'}\n`);
    if (process.env.VISIQ_DEMO !== '0') console.log('  Demo mode is ON (sign-in hints shown). Set VISIQ_DEMO=0 before real use.\n');
  }).catch((e) => { console.error('\nVisiQ could not start:', e.message, '\n'); process.exit(1); });
}
module.exports = { createApp, start };
