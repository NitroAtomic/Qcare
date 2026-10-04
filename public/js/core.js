/* QCare front-end core: safe templates, API client, dialogs, toasts, live updates. No frameworks, no build step. */
(function () {
  'use strict';
  const Q = (window.Q = { state: { user: null, csrf: null, brand: {}, meta: null }, pages: {}, cleanups: [] });

  // ---- safe HTML: every interpolated value is escaped unless it was built with html``
  class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => map[c]);
  const val = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join('') : v === null || v === undefined || v === false ? '' : esc(v));
  Q.html = (s, ...v) => new Raw(s.reduce((a, x, i) => a + x + (i < v.length ? val(v[i]) : ''), ''));
  Q.raw = (s) => new Raw(String(s));
  Q.esc = esc;
  const html = Q.html;
  Q.mount = (el, raw) => { el.innerHTML = raw instanceof Raw ? raw.s : esc(raw); return el; };
  Q.$ = (sel, root = document) => root.querySelector(sel);
  Q.$$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // ---- tiny event bus
  const handlers = {};
  Q.on = (name, fn) => { (handlers[name] ||= new Set()).add(fn); return () => handlers[name].delete(fn); };
  Q.emit = (name, data) => (handlers[name] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } });

  // ---- formatting (Philippine time)
  const TZ = 'Asia/Manila';
  Q.time = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: TZ }) : '');
  Q.date = (iso) => (iso ? new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: TZ }) : '');
  Q.dateTime = (iso) => (iso ? `${Q.date(iso)}, ${Q.time(iso)}` : '');
  Q.minsSince = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  Q.peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  Q.waitText = (m, ahead) => (ahead === 0 || m <= 5 ? (ahead === 0 ? 'You are next' : 'About 5 minutes or less') : `Approximately ${Math.round(m / 5) * 5 || m} minutes`);
  Q.statusLabel = { waiting: 'Waiting', called: 'Called', serving: 'Serving', in_service: 'In service', waiting_next: 'Waiting for next service', completed: 'Completed', skipped: 'Skipped', cancelled: 'Cancelled', no_show: 'No show', pending: 'Pending', partial: 'Partially paid', paid: 'Paid', preparing: 'Preparing', ready: 'Ready', released: 'Released', requested: 'Requested', specimen_collected: 'Specimen collected', results_ready: 'Results ready' };
  Q.chip = (status, text) => html`<span class="chip ${status}">${text || Q.statusLabel[status] || status}</span>`;
  Q.priChip = (e) => (e.priority_weight > 0 ? html`<span class="chip pri ${e.priority_weight >= 90 ? 'hot' : ''}">${e.priority_label}</span>` : '');
  Q.initials = (n) => String(n || '?').replace(/^(Dr\.|Mr\.|Ms\.)\s*/i, '').split(/\s+/).slice(0, 2).map((x) => x[0]).join('').toUpperCase();

  // ---- icons (24px, stroke)
  const P = {
    dashboard: 'M3 13h8V3H3zM13 21h8V11h-8zM13 3v6h8V3zM3 21h8v-6H3z', patients: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    visits: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2M9 12h6M9 16h4',
    queues: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01', departments: 'M3 21h18M5 21V7l7-4 7 4v14M9 21v-4h6v4M9 10h.01M15 10h.01M9 13h.01M15 13h.01',
    doctors: 'M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6 6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3M8 15v1a6 6 0 0 0 6 6 6 6 0 0 0 6-6v-4M20 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4',
    laboratory: 'M10 2v7.5L4.6 19a2 2 0 0 0 1.7 3h11.4a2 2 0 0 0 1.7-3L14 9.5V2M8.5 2h7M7 16h10', billing: 'M2 7h20v12H2zM2 11h20M6 15h4M16 3l-4 4-4-4',
    pharmacy: 'M10.5 20.5 3.5 13.5a5 5 0 0 1 7-7l7 7a5 5 0 0 1-7 7zM8.5 8.5l7 7', reports: 'M3 3v18h18M7 14l4-4 3 3 5-6', users: 'M12 2 4 5v6c0 5 3.4 9.3 8 11 4.6-1.7 8-6 8-11V5zM9 12l2 2 4-4',
    audit: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6', settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    display: 'M2 4h20v13H2zM8 21h8M12 17v4', bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0', search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16M21 21l-4.3-4.3',
    logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9', plus: 'M12 5v14M5 12h14', menu: 'M3 6h18M3 12h18M3 18h18', x: 'M18 6 6 18M6 6l12 12', check: 'M20 6 9 17l-5-5',
    phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z',
    print: 'M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z', inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1',
    alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0', volume: 'M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14', arrow: 'M5 12h14M12 5l7 7-7 7',
    refresh: 'M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5', edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z', download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  };
  Q.icon = (n, cls = '') => Q.raw(`<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${P[n] || ''}"/></svg>`);
  Q.logoMark = () => Q.raw('<svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#1B7F7A"/><circle cx="31" cy="30" r="14" fill="none" stroke="#fff" stroke-width="6"/><path d="M40 40l9 9" stroke="#FFB300" stroke-width="7" stroke-linecap="round"/><path d="M31 24v12M25 30h12" stroke="#FFB300" stroke-width="3.5" stroke-linecap="round"/></svg>');

  // ---- API client
  async function request(method, url, body, opts = {}) {
    const res = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': Q.state.csrf || '', ...(method === 'GET' && Q.state.bg ? { 'X-Background': '1' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null; try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      if (res.status === 403 && data?.code === 'csrf' && !opts.retried) { try { const me = await fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.json()); Q.state.csrf = me.csrf; if (!me.user) { Q.emit('signedout'); } else return request(method, url, body, { retried: true }); } catch { /* fall through */ } }
      if (res.status === 401 && !opts.quiet) Q.emit('signedout');
      const err = new Error(data?.error || 'Something went wrong. Please try again.'); err.status = res.status; err.data = data || {}; throw err;
    }
    return data;
  }
  Q.get = (u, o) => request('GET', u, undefined, o); Q.post = (u, b, o) => request('POST', u, b ?? {}, o); Q.put = (u, b) => request('PUT', u, b ?? {});
  Q.patch = (u, b) => request('PATCH', u, b ?? {}); Q.del = (u) => request('DELETE', u);
  Q.qs = (o) => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  // ---- toasts
  Q.toast = (msg, type = 'ok') => {
    let box = document.getElementById('toasts'); if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.append(box); }
    const t = document.createElement('div'); t.className = 'toast ' + type; t.textContent = msg; box.append(t);
    setTimeout(() => t.remove(), type === 'err' ? 7000 : 4000);
  };
  Q.fail = (e) => Q.toast(e?.message || 'Something went wrong', 'err');

  // ---- modal + confirm (native <dialog> gives focus trap and Esc for free)
  Q.modal = ({ title, body, foot, size = '', onClose }) => {
    const d = document.createElement('dialog'); d.className = 'modal ' + size;
    d.innerHTML = html`<div class="modal-head"><h2>${title}</h2><button class="x" type="button" data-close aria-label="Close">${Q.icon('x')}</button></div><div class="modal-body">${body}</div>${foot ? html`<div class="modal-foot">${foot}</div>` : ''}`.s;
    document.body.append(d);
    const api = { el: d, body: Q.$('.modal-body', d), close: () => { if (d.open) d.close(); }, setBody: (r) => Q.mount(api.body, r), setFoot: (r) => { let f = Q.$('.modal-foot', d); if (!f) { f = document.createElement('div'); f.className = 'modal-foot'; d.append(f); } Q.mount(f, r); } };
    d.addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target === d) api.close(); });
    d.addEventListener('close', () => { d.remove(); onClose && onClose(); });
    d.showModal(); const first = Q.$('input:not([type=hidden]),select,textarea', d); if (first) first.focus();
    return api;
  };
  Q.confirm = ({ title = 'Please confirm', message, confirmLabel = 'CONFIRM', cancelLabel = 'CANCEL', danger = false }) => new Promise((resolve) => {
    let result = false;
    const m = Q.modal({ title, size: 'narrow', body: html`<p>${message}</p>`, foot: html`<button class="btn" data-close>${cancelLabel}</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${confirmLabel}</button>`, onClose: () => resolve(result) });
    Q.$('[data-yes]', m.el).addEventListener('click', () => { result = true; m.close(); }); Q.$('[data-yes]', m.el).focus();
  });
  Q.prompt = ({ title, label, confirmLabel = 'SAVE', required = true, placeholder = '', hint = '' }) => new Promise((resolve) => {
    let result = null;
    const m = Q.modal({ title, size: 'narrow', body: html`<div class="field"><label for="pm">${label}</label><textarea id="pm" placeholder="${placeholder}"></textarea>${hint ? html`<span class="hint">${hint}</span>` : ''}<span class="err" id="pe"></span></div>`,
      foot: html`<button class="btn" data-close>CANCEL</button><button class="btn btn-primary" data-yes>${confirmLabel}</button>`, onClose: () => resolve(result) });
    Q.$('[data-yes]', m.el).addEventListener('click', () => { const v = Q.$('#pm', m.el).value.trim(); if (required && !v) { Q.$('#pe', m.el).textContent = 'Please write a short reason.'; return; } result = v; m.close(); });
  });

  // ---- states
  Q.skeleton = (n = 4) => html`<div class="stack" aria-busy="true" aria-label="Loading">${Array.from({ length: n }, (_, i) => html`<div class="skel" style="height:${i === 0 ? 28 : 54}px;width:${i === 0 ? 40 : 100}%"></div>`)}</div>`;
  Q.empty = (icon, title, hint = '') => html`<div class="empty">${Q.icon(icon)}<strong>${title}</strong>${hint ? html`<span>${hint}</span>` : ''}</div>`;
  Q.errorBox = (msg) => html`<div class="errbox" role="alert">${Q.icon('alert')}<div class="grow"><strong>We could not load this.</strong><div class="small">${msg}</div></div><button class="btn btn-sm" data-retry>${Q.icon('refresh')}Try again</button></div>`;
  Q.busy = async (btn, fn) => { if (btn.classList.contains('is-busy')) return; btn.classList.add('is-busy'); try { return await fn(); } finally { btn.classList.remove('is-busy'); } };

  // ---- forms
  Q.formData = (form) => { const o = {}; for (const el of form.elements) { if (!el.name || el.disabled) continue; if (el.type === 'checkbox') o[el.name] = el.checked; else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; } else o[el.name] = el.value.trim(); } return o; };
  Q.setErrors = (form, errs) => { Q.$$('.err[data-for]', form).forEach((e) => (e.textContent = '')); Q.$$('[aria-invalid]', form).forEach((e) => e.removeAttribute('aria-invalid')); let first = null;
    for (const [k, msg] of Object.entries(errs)) { const f = form.elements[k]; const out = Q.$(`.err[data-for="${k}"]`, form); if (f) { f.setAttribute('aria-invalid', 'true'); first ||= f; } if (out) out.textContent = msg; } first?.focus(); return !first; };

  // ---- live updates: WebSocket pings tell us "something changed"; each page then re-fetches through its own permission-checked API
  let ws = null, wsTimer = null, backoff = 1000, online = false;
  Q.connectLive = () => {
    if (ws && ws.readyState <= 1) return;
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    try { ws = new WebSocket(url); } catch { return schedule(); }
    ws.onopen = () => { backoff = 1000; if (!online) { online = true; Q.emit('online'); } };
    ws.onmessage = (m) => { let d; try { d = JSON.parse(m.data); } catch { return; } if (d.t === 'queue') Q.emit('queue', d); else if (d.t === 'announce') Q.emit('announce', d); };
    ws.onclose = () => { if (online) { online = false; Q.emit('offline'); } schedule(); };
    ws.onerror = () => ws.close();
  };
  function schedule() { clearTimeout(wsTimer); wsTimer = setTimeout(Q.connectLive, backoff); backoff = Math.min(backoff * 1.7, 15000); }
  window.addEventListener('online', () => Q.connectLive());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { Q.connectLive(); Q.emit('queue', { all: true }); } });

  // Register a refresher for the current page. Debounced; also a slow poll as a safety net.
  Q.live = (fn, { poll = 30000 } = {}) => {
    let t = null; const go = () => { Q.state.bg = true; return fn().catch(() => {}).finally(() => { Q.state.bg = false; }); };
    const run = () => { clearTimeout(t); t = setTimeout(go, 250); };
    const off = [Q.on('queue', run), Q.on('online', run)]; const iv = setInterval(() => { if (!document.hidden) go(); }, poll);
    Q.cleanups.push(() => { off.forEach((o) => o()); clearInterval(iv); clearTimeout(t); });
  };
  Q.runCleanups = () => { Q.cleanups.splice(0).forEach((f) => { try { f(); } catch { /* ignore */ } }); };

  Q.debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  Q.can = (perm) => Q.state.user?.perms.includes(perm);
  Q.pager = (d, label = 'items') => html`<div class="pager"><span class="muted small">${d.total ? `${(d.page - 1) * d.per + 1}-${Math.min(d.total, d.page * d.per)} of ${d.total} ${label}` : ''}</span><div class="row gap-s"><button class="btn btn-sm" data-page="${d.page - 1}" ${d.page <= 1 ? 'disabled' : ''}>Previous</button><button class="btn btn-sm" data-page="${d.page + 1}" ${d.page * d.per >= d.total ? 'disabled' : ''}>Next</button></div></div>`;

  // ---- Patient Journey (the connected-flow view, reused by staff and patient pages)
  Q.journeyView = (steps) => html`<ol class="journey">${steps.map((s) => {
    const mark = s.state === 'done' ? '✓' : s.state === 'active' ? '→' : s.state === 'upcoming' ? '○' : s.state === 'cancelled' || s.state === 'no_show' ? '×' : '↷';
    const sub = s.state === 'upcoming' ? s.note : s.key === 'registration' ? `Done at ${Q.time(s.time)}` : s.state === 'active' ? (s.status === 'waiting' ? `${s.ahead === 0 ? 'Next in line' : s.ahead + ' patient' + (s.ahead > 1 ? 's' : '') + ' ahead'} · ${Q.waitText(s.wait_minutes, s.ahead)}` : s.counter ? `Please go to ${s.counter}` : Q.statusLabel[s.status]) : s.state === 'done' ? `Completed ${Q.time(s.time)}` : Q.statusLabel[s.status];
    return html`<li class="${s.state}"><span class="j-mark" aria-hidden="true">${mark}</span><div class="j-body"><strong>${s.label}${s.service && s.key !== 'registration' && s.key !== 'cashier' && s.key !== 'pharmacy' && s.key !== 'consultation' ? html` <span class="muted" style="font-weight:500">· ${s.service}</span>` : ''}</strong><span class="sub">${sub}</span></div>${s.queue_number ? html`<span class="j-q">${s.queue_number}</span>` : ''}</li>`;
  })}</ol>`;

})();
