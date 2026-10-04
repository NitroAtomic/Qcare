/* VisiQ staff app: sign-in, shell, router, global search, notifications, idle sign-out. */
(function () {
  'use strict';
  const { html, $, $$ } = Q;
  const root = document.getElementById('app');

  const NAV = [
    { id: 'dashboard', label: 'Dashboard', perms: ['dashboard.view'] }, { id: 'patients', label: 'Patients', perms: ['patients.view'] }, { id: 'visits', label: 'Visits', perms: ['visits.view'] },
    { id: 'queues', label: 'Queues', perms: ['queue.view', 'queue.consultation', 'queue.laboratory', 'queue.cashier', 'queue.pharmacy'] }, { id: 'departments', label: 'Departments', perms: ['config.manage'] },
    { id: 'doctors', label: 'Doctors', perms: ['queue.consultation'] }, { id: 'laboratory', label: 'Laboratory', perms: ['queue.laboratory'] }, { id: 'billing', label: 'Billing', perms: ['queue.cashier'] },
    { id: 'pharmacy', label: 'Pharmacy', perms: ['queue.pharmacy'] }, { id: 'reports', label: 'Reports', perms: ['reports.view'] }, { id: 'users', label: 'Users', perms: ['users.manage'] },
    { id: 'audit', label: 'Audit Logs', perms: ['audit.view'] }, { id: 'settings', label: 'Settings', perms: ['config.manage'] }, { id: 'display', label: 'Public Display', perms: ['display.manage'] },
  ];
  const HOME = { super_admin: 'dashboard', receptionist: 'patients', doctor: 'doctors', laboratory: 'laboratory', cashier: 'billing', pharmacist: 'pharmacy', display_operator: 'display' };
  const allowed = () => NAV.filter((n) => n.perms.some((p) => Q.can(p)));
  const logoImg = () => (Q.state.brand.logo ? html`<img src="${Q.state.brand.logo}" alt="" width="40" height="40" style="border-radius:10px;object-fit:cover">` : Q.logoMark());

  // ------------------------------------------------------------------ boot
  async function boot() {
    try { const me = await Q.get('/api/me', { quiet: true }); Q.state.csrf = me.csrf; Q.state.brand = me.brand; Q.state.user = me.user; document.title = me.brand.hospital_name ? `VisiQ - ${me.brand.hospital_name}` : 'VisiQ'; if (me.user) return start(); } catch (e) { return fatal(e); }
    showLogin();
  }
  function fatal(e) { Q.mount(root, html`<div style="padding:40px;max-width:560px;margin:auto">${Q.errorBox(e.message)}</div>`); $('[data-retry]', root)?.addEventListener('click', boot); }

  // ------------------------------------------------------------------ login
  async function showLogin(notice) {
    let demo = false; try { const t = await Q.get('/api/csrf', { quiet: true }); Q.state.csrf = t.csrf; demo = t.demo; } catch { /* offline */ }
    document.body.className = '';
    Q.mount(root, html`<div class="login">
      <div class="login-art" aria-hidden="true"><div class="brand">${Q.logoMark()}<div><b>VisiQ</b><span>Integrated Hospital Visit & Queue Management</span></div></div>
        <div class="stack-t"><div class="ticket live"><span class="t-label">Doctor Consultation</span><span class="t-num">D-025</span><span class="t-sub">Please proceed to Consultation Room 3</span></div>
          <div class="ticket"><span class="t-label">Laboratory</span><span class="t-num">LAB-014</span><span class="t-sub">3 patients ahead</span></div>
          <div class="ticket"><span class="t-label">Cashier</span><span class="t-num">C-031</span><span class="t-sub">Next after laboratory</span></div></div>
        <p style="color:#8fa9d3;max-width:380px">One patient. One visit. Every department connected from registration to pharmacy.</p></div>
      <form class="login-form" id="lf" novalidate>
        <div><h1>Sign in</h1><p class="muted">${Q.state.brand.hospital_name || 'VisiQ'}</p></div>
        ${notice ? html`<div class="banner">${notice}</div>` : ''}
        <div class="field"><label for="u">Username</label><input id="u" name="username" type="text" autocomplete="username" autocapitalize="none" required><span class="err" data-for="username"></span></div>
        <div class="field"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required><span class="err" data-for="password"></span></div>
        <div class="err" id="lerr" role="alert"></div>
        <button class="btn btn-primary btn-xl" type="submit">Sign in</button>
        ${demo ? html`<div class="demo-box small"><strong>Demo accounts</strong> <span class="muted">(password: Qcare#2026)</span><div style="margin-top:6px">${[['admin', 'Administrator'], ['reception', 'Receptionist'], ['drsantos', 'Doctor'], ['lab', 'Laboratory'], ['cashier', 'Cashier'], ['pharmacy', 'Pharmacist'], ['display', 'Display']].map(([u, l]) => html`<button type="button" data-fill="${u}">${l}</button>`)}</div></div>` : ''}
        <p class="brand-foot">Created by JPD</p></form></div>`);
    const f = $('#lf');
    f.addEventListener('click', (e) => { const b = e.target.closest('[data-fill]'); if (b) { f.username.value = b.dataset.fill; f.password.value = 'Qcare#2026'; f.password.focus(); } });
    f.addEventListener('submit', async (e) => {
      e.preventDefault(); const d = Q.formData(f); const errs = {}; if (!d.username) errs.username = 'Enter your username'; if (!d.password) errs.password = 'Enter your password';
      if (!Q.setErrors(f, errs)) return; const btn = $('button[type=submit]', f); $('#lerr').textContent = '';
      await Q.busy(btn, async () => { try { const r = await Q.post('/api/login', d, { quiet: true }); Q.state.user = r.user; Q.state.csrf = r.csrf; const me = await Q.get('/api/me'); Q.state.brand = me.brand; start(); } catch (err) { $('#lerr').textContent = err.message; f.password.value = ''; f.password.focus(); } });
    });
    $('#u').focus();
  }

  // ------------------------------------------------------------------ shell
  let started = false;
  function start() {
    document.body.className = 'app'; started = true;
    const u = Q.state.user; const nav = allowed();
    Q.mount(root, html`<div class="shell">
      <aside class="side" id="side" aria-label="Main menu"><a class="brand" href="#/${HOME[u.role] || 'dashboard'}">${logoImg()}<div><b>VisiQ</b><span>Integrated Hospital Visit &amp; Queue Management</span></div></a>
        <nav class="nav" id="nav">${nav.map((n) => html`<a href="#/${n.id}" data-nav="${n.id}">${Q.icon(n.id)}<span>${n.label}</span></a>`)}</nav>
        <div class="side-foot">${u.role_name}<br>Created by JPD</div></aside>
      <div class="main"><div class="net" id="net" role="status">Connection lost. Showing the last information we had. Trying to reconnect…</div>
        <header class="top"><button class="icon-btn menu-btn" id="mb" aria-label="Open menu">${Q.icon('menu')}</button>
          <div class="hosp">${Q.state.brand.hospital_name}<small>${Q.state.brand.tagline}</small></div>
          ${Q.can('search.use') ? html`<div class="searchbox">${Q.icon('search')}<input id="gs" type="search" placeholder="Search name, patient ID, visit ID, queue no., phone" autocomplete="off" aria-label="Search"><div class="results hide" id="gsr" role="listbox"></div></div>` : html`<div class="grow"></div>`}
          <div class="clock" id="clock"></div>
          <div class="pop"><button class="icon-btn" id="bell" aria-label="Notifications">${Q.icon('bell')}<span class="dot hide" id="bdot">0</span></button><div class="menu hide" id="bellmenu" style="min-width:320px"></div></div>
          <div class="pop"><button class="icon-btn" id="um" aria-label="Profile menu" aria-haspopup="true"><span class="avatar">${Q.initials(u.full_name)}</span></button>
            <div class="menu hide" id="umenu"><div class="who"><strong>${u.full_name}</strong><div class="muted small">${u.role_name}</div></div><button data-act="pw">${Q.icon('settings')}Change password</button><button data-act="out">${Q.icon('logout')}Sign out</button></div></div></header>
        <main class="view" id="view" tabindex="-1"></main><footer class="view-foot brand-foot">VisiQ · Integrated Hospital Visit &amp; Queue Management · Created by JPD</footer></div></div>`);
    wireShell(); Q.connectLive(); loadMeta().then(route);
  }
  async function loadMeta() { try { Q.state.meta = await Q.get('/api/meta'); } catch { Q.state.meta = Q.state.meta || { departments: [], services: [], counters: [], doctors: [], priorities: [], payment_methods: [] }; } }
  Q.reloadMeta = loadMeta;
  function wireShell() {
    const tick = () => { const n = new Date(); $('#clock').innerHTML = `${n.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' })}<small>${n.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'Asia/Manila' })}</small>`; };
    tick(); setInterval(tick, 15000);
    $('#mb').addEventListener('click', () => document.body.classList.toggle('nav-open'));
    document.addEventListener('click', (e) => { if (document.body.classList.contains('nav-open') && !e.target.closest('#side') && !e.target.closest('#mb')) document.body.classList.remove('nav-open'); });
    $('#nav').addEventListener('click', () => document.body.classList.remove('nav-open'));
    const menus = [['#um', '#umenu'], ['#bell', '#bellmenu']];
    menus.forEach(([b, m]) => $(b).addEventListener('click', (e) => { e.stopPropagation(); const open = $(m).classList.contains('hide'); menus.forEach(([, mm]) => $(mm).classList.add('hide')); $(m).classList.toggle('hide', !open); if (b === '#bell' && open) openBell(); }));
    document.addEventListener('click', (e) => { if (!e.target.closest('.pop')) menus.forEach(([, mm]) => $(mm)?.classList.add('hide')); if (!e.target.closest('.searchbox')) $('#gsr')?.classList.add('hide'); });
    $('#umenu').addEventListener('click', (e) => { const a = e.target.closest('[data-act]')?.dataset.act; $('#umenu').classList.add('hide'); if (a === 'out') signOut(); if (a === 'pw') changePassword(); });
    Q.on('offline', () => $('#net')?.classList.add('on')); Q.on('online', () => $('#net')?.classList.remove('on'));
    Q.on('queue', Q.debounce(loadBell, 800)); Q.on('queue', (e) => { if (e.all) loadMeta(); }); loadBell(); idleWatch(); wireSearch();
  }

  // ------------------------------------------------------------------ search
  function wireSearch() {
    const input = $('#gs'); if (!input) return; const box = $('#gsr');
    const run = Q.debounce(async () => {
      const q = input.value.trim(); if (q.length < 2) return box.classList.add('hide');
      try { const r = await Q.get('/api/search?q=' + encodeURIComponent(q)); const none = !r.patients.length && !r.visits.length && !r.queues.length;
        Q.mount(box, none ? Q.empty('search', 'No match', 'Try a name, patient ID, visit ID or queue number.') : html`
          ${r.patients.length ? html`<h4>Patients</h4>${r.patients.map((p) => html`<button class="r" data-kind="patient" data-id="${p.id}"><span><strong>${p.name}</strong></span><span class="muted small">${p.patient_no}${p.contact_no ? ' · ' + p.contact_no : ''}</span></button>`)}` : ''}
          ${r.visits.length ? html`<h4>Visits</h4>${r.visits.map((v) => html`<button class="r" data-kind="visit" data-id="${v.id}"><span><strong>${v.visit_no}</strong> <span class="muted">${v.patient_name}</span></span>${Q.chip(v.status)}</button>`)}` : ''}
          ${r.queues.length ? html`<h4>Queue numbers</h4>${r.queues.map((x) => html`<button class="r" data-kind="visit" data-id="${x.visit_id}"><span><strong class="num">${x.queue_number}</strong> <span class="muted">${x.department}${x.patient_name ? ' · ' + x.patient_name : ''}</span></span>${Q.chip(x.status)}</button>`)}` : ''}`);
        box.classList.remove('hide'); } catch (e) { Q.mount(box, html`<div class="errbox">${e.message}</div>`); box.classList.remove('hide'); }
    }, 250);
    input.addEventListener('input', run); input.addEventListener('focus', () => input.value.trim().length >= 2 && run());
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { box.classList.add('hide'); input.blur(); } });
    box.addEventListener('click', (e) => { const b = e.target.closest('[data-kind]'); if (!b) return; box.classList.add('hide'); input.value = ''; if (b.dataset.kind === 'patient') Q.openPatient(+b.dataset.id); else Q.openVisit(+b.dataset.id); });
  }

  // ------------------------------------------------------------------ notifications
  async function loadBell() { try { const d = await Q.get('/api/notifications'); Q.state.notes = d; const dot = $('#bdot'); if (dot) { dot.textContent = d.unread; dot.classList.toggle('hide', !d.unread); } } catch { /* ignore */ } }
  async function openBell() {
    const m = $('#bellmenu'); const d = Q.state.notes || { items: [] };
    Q.mount(m, d.items.length ? html`${d.items.map((n) => html`<div style="padding:10px 12px;border-bottom:1px solid var(--line);${n.read_at ? 'opacity:.6' : ''}"><strong>${n.title}</strong><div class="small muted">${n.body || ''}</div><div class="xs muted">${Q.dateTime(n.created_at)}</div></div>`)}` : Q.empty('bell', 'No notifications', 'Lab results and alerts show up here.'));
    if (d.unread) { try { await Q.post('/api/notifications/read'); $('#bdot').classList.add('hide'); } catch { /* ignore */ } }
  }

  // ------------------------------------------------------------------ account
  async function signOut(msg) { try { await Q.post('/api/logout', {}, { quiet: true }); } catch { /* ignore */ } Q.runCleanups(); Q.state.user = null; started = false; showLogin(msg); }
  Q.on('signedout', () => { if (started) { Q.runCleanups(); Q.state.user = null; started = false; showLogin('Your session ended. Please sign in again.'); } });
  function changePassword() {
    const m = Q.modal({ title: 'Change password', size: 'narrow', body: html`<form id="pf" class="stack" novalidate><div class="field"><label for="c">Current password</label><input id="c" name="current" type="password" autocomplete="current-password"><span class="err" data-for="current"></span></div>
      <div class="field"><label for="n">New password</label><input id="n" name="next" type="password" autocomplete="new-password"><span class="hint">At least 8 characters with letters and numbers.</span><span class="err" data-for="next"></span></div></form>`,
      foot: html`<button class="btn" data-close>CANCEL</button><button class="btn btn-primary" data-save>SAVE PASSWORD</button>` });
    Q.$('[data-save]', m.el).addEventListener('click', async (e) => { const f = Q.$('#pf', m.el); const d = Q.formData(f); const errs = {}; if (!d.current) errs.current = 'Enter your current password'; if ((d.next || '').length < 8) errs.next = 'Use at least 8 characters';
      if (!Q.setErrors(f, errs)) return; await Q.busy(e.currentTarget, async () => { try { await Q.post('/api/me/password', d); Q.toast('Password changed'); m.close(); } catch (err) { Q.setErrors(f, { current: err.message }); } }); });
  }
  function idleWatch() {
    const mins = Q.state.brand.session_timeout_minutes || 20; let last = Date.now(), warned = false;
    ['click', 'keydown', 'pointerdown', 'touchstart'].forEach((ev) => addEventListener(ev, () => { last = Date.now(); warned = false; }, { passive: true }));
    setInterval(() => { if (!started) return; const idle = (Date.now() - last) / 60000; if (idle >= mins) signOut(`You were signed out after ${mins} minutes without activity.`); else if (idle >= mins - 1 && !warned) { warned = true; Q.toast('You will be signed out in 1 minute. Tap anywhere to stay signed in.', 'info'); } }, 10000);
  }

  // ------------------------------------------------------------------ router
  async function route() {
    if (!started) return;
    const hash = location.hash.replace(/^#\/?/, ''); const [id, ...args] = hash.split('/'); const nav = allowed();
    let name = id || HOME[Q.state.user.role] || nav[0]?.id; if (!nav.some((n) => n.id === name) && !['station'].includes(name)) name = nav[0]?.id;
    const page = Q.pages[name]; Q.runCleanups();
    const prev = $('#view'); const view = prev.cloneNode(false); prev.replaceWith(view); // fresh container so listeners from the last page never pile up
    $$('#nav a').forEach((a) => (a.dataset.nav === (name === 'station' ? 'queues' : name) ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
    if (!page) { Q.mount(view, Q.empty('alert', 'Page not found', 'Use the menu to go somewhere else.')); return; }
    document.title = `${page.title || name} - VisiQ`; Q.mount(view, Q.skeleton(5));
    try { await page.render(view, args); } catch (e) { Q.mount(view, Q.errorBox(e.message)); $('[data-retry]', view)?.addEventListener('click', route); }
    view.scrollTop = 0; window.scrollTo(0, 0);
  }
  addEventListener('hashchange', route);
  Q.route = route;
  Q.go = (h) => { if (location.hash === '#/' + h) route(); else location.hash = '#/' + h; };
  window.addEventListener('DOMContentLoaded', boot);
})();
