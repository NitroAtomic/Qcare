/* Dashboard: live floor, today's numbers, charts, recent activity. */
(function () {
  'use strict';
  const { html, $ } = Q;
  const hourLabel = (h) => (h % 12 || 12) + (h < 12 ? 'a' : 'p');

  Q.barChart = (rows, key, { fmt = (v) => v, color = '' } = {}) => {
    if (!rows.length) return Q.empty('reports', 'No data yet', 'Charts fill in as patients are served.');
    const max = Math.max(1, ...rows.map((r) => r[key] || 0)); const peak = Math.max(...rows.map((r) => r[key] || 0));
    return html`<div class="bars" role="img" aria-label="Bar chart">${rows.map((r) => html`<div class="b ${(r[key] || 0) === peak && peak > 0 ? 'peak' : ''}" title="${r.label}: ${fmt(r[key] || 0)}"><em>${r[key] ? fmt(r[key]) : ''}</em><i style="height:${Math.max(2, ((r[key] || 0) / max) * 100)}%;${color ? 'background:' + color : ''}"></i></div>`)}</div><div class="axis">${rows.map((r) => html`<span>${r.label}</span>`)}</div>`;
  };

  Q.pages.dashboard = { title: 'Dashboard', async render(el) {
    const load = async () => {
      const d = await Q.get('/api/stats'); const lo = Math.min(7, ...d.hourly.map((h) => h.hour)), hi = Math.max(16, ...d.hourly.map((h) => h.hour));
      const hours = []; for (let h = lo; h <= hi; h++) { const f = d.hourly.find((x) => x.hour === h); hours.push({ label: hourLabel(h), arrivals: f?.arrivals || 0, avg_wait: f?.avg_wait ? Math.round(f.avg_wait) : 0 }); }
      const maxPat = Math.max(1, ...d.departments.map((x) => x.patients));
      const liveBy = (name) => d.active.filter((a) => a.department === name);
      Q.mount(el, html`<div class="page-head"><div><h1>Today at ${Q.state.brand.hospital_name}</h1><p>${new Date().toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila' })} · updates live</p></div>
          <div class="row"><a class="btn" href="/display" target="_blank" rel="noopener">${Q.icon('display')}Open TV board</a>${Q.can('patients.register') ? html`<a class="btn btn-primary" href="#/patients">${Q.icon('plus')}Register patient</a>` : ''}</div></div>
        <div class="floor-title"><h2>Live floor</h2><span class="muted small">Who is being served right now</span></div>
        <div class="floor">${d.departments.map((x) => { const l = liveBy(x.name); return html`<a href="#/station/${x.id}" style="text-decoration:none;color:inherit"><div class="ticket ${l.length ? 'live' : 'quiet'}"><span class="t-label">${x.name}</span><span class="t-num">${l[0]?.queue_number || '—'}</span><span class="t-sub">${l.length ? (l[0].counter || 'Now serving') : 'Idle'} · ${x.waiting} waiting</span></div></a>`; })}</div>
        <div class="ledger"><div><b>${d.total_patients}</b><span>Total patients today</span></div><div class="hot"><b>${d.waiting}</b><span>Waiting</span></div><div><b>${d.serving}</b><span>Currently serving</span></div><div><b>${d.completed}</b><span>Completed</span></div><div><b>${d.cancelled}</b><span>Cancelled</span></div><div><b>${d.avg_wait ?? '—'}<small style="font-size:1rem"> min</small></b><span>Average wait time</span></div><div><b>${d.avg_service ?? '—'}<small style="font-size:1rem"> min</small></b><span>Average service time</span></div></div>
        <div class="cols"><div class="stack-l"><div class="panel"><div class="panel-h"><h2>Queue numbers issued by hour</h2><span class="muted small">Darkest bar is the busiest hour</span></div>${Q.barChart(hours, 'arrivals')}</div>
            <div class="panel"><div class="panel-h"><h2>Average waiting time by hour</h2><span class="muted small">Minutes from queue number to being called</span></div>${Q.barChart(hours, 'avg_wait', { fmt: (v) => v + 'm', color: 'var(--signal)' })}</div></div>
          <div class="stack-l"><div class="panel"><div class="panel-h"><h2>Department performance</h2></div>${d.departments.map((x) => html`<div class="hbar"><span><strong>${x.name}</strong></span><span class="track" title="${x.completed} done, ${x.waiting + x.serving} in line"><i class="a" style="width:${(x.completed / maxPat) * 100}%"></i><i class="w" style="width:${((x.waiting + x.serving) / maxPat) * 100}%"></i></span><span class="num right"><strong>${x.patients}</strong></span></div><div class="xs muted" style="margin:-4px 0 4px 140px">${x.completed} done · ${x.waiting} waiting${x.avg_wait != null ? ` · avg wait ${Math.round(x.avg_wait)} min` : ''}</div>`)}
              <div class="xs muted row" style="margin-top:8px"><span class="chip completed">Done</span><span class="chip waiting">In line</span></div></div>
            <div class="panel"><div class="panel-h"><h2>Recent activity</h2>${Q.can('audit.view') ? html`<a class="small" href="#/audit">Audit log</a>` : ''}</div><ul class="feed">${d.activity.length ? d.activity.map((a) => html`<li><span>${a.summary}</span><time>${Q.time(a.created_at)}</time></li>`) : html`<li class="muted">Nothing yet</li>`}</ul></div></div></div>`);
    };
    await load(); Q.live(load);
  } };
})();
