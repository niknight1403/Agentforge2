const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
};

let currentVilla = null;
let currentAgentId = null;

/* --------------------------- Health --------------------------- */
async function checkHealth() {
  try {
    const h = await api('/api/health');
    $('#healthDot').className = 'dot ok';
    $('#healthText').textContent = `Hub online · ${h.routes} Routen · v${h.version}`;
  } catch {
    $('#healthDot').className = 'dot err';
    $('#healthText').textContent = 'Hub nicht erreichbar';
  }
}

/* --------------------------- Villen --------------------------- */
async function loadVillas() {
  const villas = await api('/api/villas');
  const box = $('#villaList');
  if (!Array.isArray(villas) || !villas.length) {
    box.innerHTML = '<p class="hint">Noch keine Villa erstellt.</p>';
    return;
  }
  box.innerHTML = villas.map((v) => `
    <div class="villa-card" data-id="${v.id}">
      <div>
        <b>${esc(v.name)}</b>
        <small>${esc((v.idea || '').slice(0, 110))}</small>
      </div>
      <span class="badge ${v.status}">${v.status}</span>
    </div>`).join('');
  box.querySelectorAll('.villa-card').forEach((el) =>
    el.addEventListener('click', () => openVilla(Number(el.dataset.id))));
}

async function createVilla() {
  const idea = $('#idea').value.trim();
  if (!idea) { setMsg('Bitte zuerst eine Idee eingeben.', true); return; }
  const sourcePath = $('#sourcePath').value.trim();
  const btn = $('#createBtn');
  btn.disabled = true;
  setMsg(sourcePath
    ? 'Deep Agent liest das Projekt, erstellt einen Analysebericht und plant die Umsetzung …'
    : 'Deep Agent plant deine Idee und erzeugt den Agentenpool …');
  try {
    const out = await api('/api/villas', {
      method: 'POST',
      body: {
        name: $('#villaName').value.trim() || 'Neue Villa',
        idea,
        agentCount: Number($('#agentCount').value) || 24,
        sourcePath
      }
    });
    if (out.error) { setMsg(out.error, true); return; }
    setMsg(`Villa #${out.villaId} erstellt mit ${out.agents} Agenten. Chat wird geöffnet …`);
    $('#idea').value = '';
    $('#sourcePath').value = '';
    await loadVillas();
    await openVilla(out.villaId);
  } catch (e) {
    setMsg(String(e), true);
  } finally {
    btn.disabled = false;
  }
}

function setMsg(text, err = false) {
  const el = $('#createMsg');
  el.textContent = text;
  el.className = 'msg' + (err ? ' err' : '');
}

/* --------------------------- Detail --------------------------- */
async function openVilla(id) {
  const data = await api(`/api/villas/${id}`);
  if (data.error) return;
  currentVilla = data;
  currentAgentId = data.agents.find((a) => a.is_root)?.id ?? data.agents[0]?.id ?? null;
  $('#detailPanel').hidden = false;
  $('#dName').textContent = data.villa.name;
  $('#dIdea').textContent = data.villa.idea;
  renderStats(data);
  renderReports(data.reports);
  renderTasks(data.tasks);
  renderAgents(data.agents);
  renderMemories(data.memories);
  renderAudit(data.audit);
  await loadChat(id);
  $('#detailPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderStats(d) {
  const done = d.tasks.filter((t) => t.status === 'DONE').length;
  const open = d.tasks.filter((t) => ['PENDING', 'READY', 'RUNNING', 'REVIEW'].includes(t.status)).length;
  const active = d.running || d.villa.status === 'RUNNING' || d.villa.status === 'STOPPING';
  $('#startBtn').hidden = active;
  $('#stopBtn').hidden = !active;
  $('#stopBtn').textContent = d.villa.status === 'STOPPING' ? 'Stoppt …' : 'Stoppen';
  $('#startBtn').disabled = active;
  $('#dStats').innerHTML = `
    <div class="stat"><b>${d.villa.status}</b>Status${d.running ? ' · läuft' : ''}</div>
    <div class="stat"><b>${d.agents.length}</b>Agenten (max ${d.villa.max_agents})</div>
    <div class="stat"><b>${done}/${d.tasks.length}</b>Aufgaben erledigt</div>
    <div class="stat"><b>${open}</b>offen</div>
    <div class="stat"><b>${d.memories.length}</b>Gedächtnis-Einträge</div>`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderReports(reports) {
  const box = $('#reportList');
  if (!reports || !reports.length) {
    box.innerHTML = '<p class="hint">Noch keine Berichte. Bei hinterlegtem Projekt entsteht nach dem Start ein Analysebericht, am Ende ein Verifikationsbericht.</p>';
    return;
  }
  box.innerHTML = reports.map((r) => `
    <details class="report" ${['ANALYSIS', 'REVENUE'].includes(r.kind) ? 'open' : ''}>
      <summary><b>${esc(r.title)}</b> <span class="badge">${esc(r.kind)}</span></summary>
      <pre class="report-body">${esc(r.content)}</pre>
    </details>`).join('');
}

function renderTasks(tasks) {
  $('#taskList').innerHTML = tasks.length ? tasks.map((t) => `
    <div class="row">
      <div class="head"><b>${esc(t.title)}</b><span class="badge ${t.status}">${t.status}</span></div>
      <div class="sub">${esc(t.description || '')}${t.result ? '\n\n→ ' + esc(t.result.slice(0, 500)) : ''}</div>
    </div>`).join('') : '<p class="hint">Keine Aufgaben.</p>';
}

function renderAgents(agents) {
  $('#agentList').innerHTML = agents.map((a) => `
    <div class="row">
      <div class="head"><b>${esc(a.name)}${a.is_root ? ' · Deep Agent' : ''}</b><span class="badge ${a.status}">${a.status}</span></div>
      <div class="sub">Rolle: ${a.role} · Rechte-Maske: <code>${a.permissions}</code> · Autonomie: ${a.autonomy_level}</div>
    </div>`).join('');
}

function renderMemories(memories) {
  $('#memList').innerHTML = memories.length ? memories.map((m) => `
    <div class="row">
      <div class="head"><b>${esc(m.title)}</b><span class="badge">${m.kind} · ${m.importance}/10</span></div>
      <div class="sub">${esc(m.content.slice(0, 500))}</div>
    </div>`).join('') : '<p class="hint">Noch kein Gedächtnis.</p>';
}

function renderAudit(entries) {
  $('#auditList').innerHTML = entries.length ? entries.map((e) => `
    <div class="row">
      <div class="head"><b>${esc(e.tool)}</b><span class="badge ${e.allowed ? 'RUNNING' : 'FAILED'}">${e.allowed ? 'erlaubt' : 'blockiert'}</span></div>
      <div class="sub">${esc(e.args)}\n→ ${esc(e.result)}</div>
    </div>`).join('') : '<p class="hint">Keine Werkzeugaufrufe protokolliert.</p>';
}

async function loadChat(villaId) {
  const msgs = await api(`/api/villas/${villaId}/messages?agentId=${currentAgentId}`);
  const log = $('#chatLog');
  log.innerHTML = Array.isArray(msgs) && msgs.length
    ? msgs.map((m) => `<div class="bubble ${m.role}"><span class="meta">${m.role === 'user' ? 'Du' : 'Agent'} · ${new Date(m.created_at).toLocaleTimeString('de-DE')}</span>${esc(m.content)}</div>`).join('')
    : '<p class="hint">Noch keine Nachrichten. Schreibe dem Deep Agent eine Nachricht.</p>';
  log.scrollTop = log.scrollHeight;
}

async function sendChat() {
  const msg = $('#chatMsg').value.trim();
  if (!msg || !currentVilla) return;
  const btn = $('#sendBtn');
  btn.disabled = true;
  $('#chatMsg').value = '';
  const log = $('#chatLog');
  log.insertAdjacentHTML('beforeend', `<div class="bubble user"><span class="meta">Du</span>${esc(msg)}</div>`);
  log.scrollTop = log.scrollHeight;
  const pending = document.createElement('div');
  pending.className = 'bubble assistant';
  pending.textContent = 'Deep Agent denkt …';
  log.appendChild(pending);
  log.scrollTop = log.scrollHeight;
  try {
    const out = await api(`/api/villas/${currentVilla.villa.id}/chat`, {
      method: 'POST',
      body: { message: msg, agentId: currentAgentId }
    });
    pending.innerHTML = `<span class="meta">Agent · ${esc(out.route || 'Route')}${out.offline ? ' · Offline-Planer' : ''}</span>${esc(out.answer || out.error || '')}`;
  } catch (e) {
    pending.innerHTML = `<span class="meta">Fehler</span>${esc(String(e))}`;
  } finally {
    btn.disabled = false;
    log.scrollTop = log.scrollHeight;
    openVillaRefresh();
  }
}

async function openVillaRefresh() {
  if (!currentVilla) return;
  const data = await api(`/api/villas/${currentVilla.villa.id}`);
  if (data.error) return;
  currentVilla = data;
  renderStats(data);
  renderReports(data.reports);
  renderTasks(data.tasks);
  renderAgents(data.agents);
  renderMemories(data.memories);
  renderAudit(data.audit);
}

/* --------------------------- Routen --------------------------- */
async function loadRoutes() {
  const routes = await api('/api/routes');
  $('#routeList').innerHTML = routes.map((r) => `
    <div class="row">
      <div class="head">
        <b>${esc(r.name)}</b>
        <span class="badge ${r.hasKey || r.provider === 'offline' ? 'RUNNING' : 'PAUSED'}">
          ${r.provider === 'offline' ? 'offline' : r.hasKey ? 'Key vorhanden' : 'kein Key'}
        </span>
      </div>
      <div class="sub">${esc(r.provider)} · ${esc(r.model)}\n${esc(r.base_url)}\nPrio ${r.priority} · ok ${r.ok} / fail ${r.fail} · Status ${r.status}</div>
      <div class="actions">
        <button data-toggle="${r.id}" data-enabled="${r.enabled}">${r.enabled ? 'Deaktivieren' : 'Aktivieren'}</button>
      </div>
    </div>`).join('');
  document.querySelectorAll('[data-toggle]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api(`/api/routes/${b.dataset.toggle}`, { method: 'PATCH', body: { enabled: b.dataset.enabled !== '1' } });
      loadRoutes();
    }));
}

async function addRoute() {
  await api('/api/routes', {
    method: 'POST',
    body: {
      name: $('#rName').value.trim() || 'Route',
      provider: $('#rProvider').value.trim() || 'openai-compatible',
      baseUrl: $('#rUrl').value.trim(),
      model: $('#rModel').value.trim(),
      keyEnv: $('#rKeyEnv').value.trim(),
      priority: Number($('#rPrio').value) || 10
    }
  });
  $('#rName').value = $('#rUrl').value = $('#rModel').value = $('#rKeyEnv').value = '';
  loadRoutes();
}

async function loadSecrets() {
  const list = await api('/api/secrets');
  $('#secretList').innerHTML = Array.isArray(list) && list.length
    ? list.map((s) => `<div class="row"><div class="head"><b>${esc(s.name)}</b><span class="badge RUNNING">gesetzt</span></div></div>`).join('')
    : '<p class="hint">Noch kein Key hinterlegt. Ohne Key arbeitet der Offline-Planer.</p>';
}

async function addSecret() {
  const name = $('#sName').value.trim();
  const value = $('#sValue').value;
  if (!name || !value) return;
  await api('/api/secrets', { method: 'POST', body: { name, value } });
  $('#sValue').value = '';
  loadSecrets();
  loadRoutes();
}

/* --------------------------- Tabs --------------------------- */
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.remove('active'));
  tab.classList.add('active');
  document.querySelector(`.tabpane[data-pane="${tab.dataset.tab}"]`).classList.add('active');
}));

/* --------------------------- Events --------------------------- */
function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = () => {
    if (currentVilla) openVillaRefresh();
    loadVillas();
  };
  es.onerror = () => { /* Browser verbindet automatisch neu */ };
}

/* --------------------------- Init --------------------------- */
$('#createBtn').addEventListener('click', createVilla);
$('#refreshBtn').addEventListener('click', loadVillas);
$('#startBtn').addEventListener('click', async () => {
  if (!currentVilla) return;
  await api(`/api/villas/${currentVilla.villa.id}/orchestrate`, { method: 'POST', body: { concurrency: 4, maxTasks: 500 } });
  openVillaRefresh();
});
$('#stopBtn').addEventListener('click', async () => {
  if (!currentVilla) return;
  await api(`/api/villas/${currentVilla.villa.id}/stop`, { method: 'POST' });
  openVillaRefresh();
});
$('#closeDetail').addEventListener('click', () => { $('#detailPanel').hidden = true; });
$('#sendBtn').addEventListener('click', sendChat);
$('#chatMsg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendChat(); });
$('#addRouteBtn').addEventListener('click', addRoute);
$('#addSecretBtn').addEventListener('click', addSecret);

checkHealth();
loadVillas();
loadRoutes();
loadSecrets();
connectEvents();
setInterval(checkHealth, 20000);
