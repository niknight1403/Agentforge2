/* VillaForge Web-Oberflaeche
   ----------------------------------------------------------------------------
   Grundsaetze dieses Skripts:
   - Keine blockierenden Browser-Dialoge (alert/confirm/prompt): alles laeuft
     ueber eigene Toasts und ein <dialog>-Modal. Die sind gestaltbar, mit der
     Tastatur bedienbar und brechen in Kiosk-/PWA-Umgebungen nicht weg.
   - Genau eine SSE-Verbindung. Wird der Token gewechselt, wird die alte
     Verbindung geschlossen, sonst sammeln sich offene Streams an.
   - Fehler werden angezeigt, nicht verschluckt: eine Antwort ohne `ok` ist
     kein Erfolg, auch wenn HTTP 200 zurueckkommt.
*/
const $ = (s) => document.querySelector(s);

// Optionaler Hub-Token (VF_TOKEN): wird in localStorage gehalten und als
// Bearer-Header mitgeschickt. EventSource kann keine Header, dort laeuft
// der Token als URL-Parameter.
const getToken = () => localStorage.getItem('vf_token') || '';
const setToken = (t) => { t ? localStorage.setItem('vf_token', t) : localStorage.removeItem('vf_token'); };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}), ...opts.headers };
  try {
    const { timeoutMs = 90000, ...fetchOpts } = opts;
    const res = await fetch(path, { ...fetchOpts, headers, signal: opts.signal ?? AbortSignal.timeout(timeoutMs), body: opts.body ? JSON.stringify(opts.body) : undefined });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { error: text || `HTTP ${res.status}` }; }
    if (!res.ok && !data.error) data.error = `HTTP ${res.status}`;
    return data;
  } catch (err) {
    return { error: err.name === 'TimeoutError' ? 'Der Hub antwortet zu langsam. Bitte erneut versuchen.' : 'Hub nicht erreichbar. Bitte die Verbindung prüfen.' };
  }
}

let currentVilla = null;
let currentAgentId = null;
let latestVillas = [];
let packState = null;
let eventSource = null;
let workspaceOpener = null;
let villaLoadSequence = 0;
let sectionObserver = null;

/* ---------------------------- Rueckmeldungen ---------------------------- */

/** Kurze Rueckmeldung unten rechts. Fehler bleiben laenger stehen. */
function toast(text, kind = 'ok') {
  const wrap = $('#toastWrap');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  el.innerHTML = `<span aria-hidden="true">${kind === 'err' ? '⚠' : kind === 'info' ? 'ℹ' : '✓'}</span><span>${esc(text)}</span>`;
  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', 'Meldung schliessen');
  close.textContent = '✕';
  close.addEventListener('click', () => el.remove());
  el.appendChild(close);
  wrap.appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 9000 : 4500);
}

/**
 * Modal mit <dialog>. Wird fuer Bestaetigungen und kleine Formulare benutzt
 * und ersetzt confirm()/prompt(). Liefert bei Abbruch null.
 * @param {{title:string,text?:string,ok?:string,fields?:Array<{id:string,label:string,value?:string,type?:string,hint?:string}>}} opts
 */
function openModal({ title, text = '', ok = 'Bestätigen', fields = [] }) {
  const dlg = $('#modal');
  if (!dlg) return Promise.resolve(null);
  $('#modalTitle').textContent = title;
  $('#modalText').textContent = text;
  $('#modalText').hidden = !text;
  $('#modalMsg').textContent = '';
  $('#modalOk').textContent = ok;
  const box = $('#modalFields');
  box.innerHTML = fields.map((f) => `<label>${esc(f.label)}<input id="modal_${esc(f.id)}" type="${esc(f.type || 'text')}" value="${esc(f.value ?? '')}" ${f.hint ? `placeholder="${esc(f.hint)}"` : ''} /></label>`).join('');
  box.hidden = !fields.length;

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      $('#modalOk').removeEventListener('click', submit);
      dlg.removeEventListener('cancel', onCancel);
      dlg.removeEventListener('close', onClose);
      resolve(value);
    };
    const submit = () => {
      const out = {};
      fields.forEach((f) => { out[f.id] = $(`#modal_${f.id}`)?.value ?? ''; });
      dlg.close('ok');
      settle(out);
    };
    const onCancel = (e) => { e.preventDefault(); dlg.close('cancel'); settle(null); };
    const onClose = () => settle(null);
    $('#modalOk').addEventListener('click', submit);
    dlg.addEventListener('cancel', onCancel);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    (box.querySelector('input') || $('#modalOk')).focus();
  });
}

/** Bestaetigung mit Modal. Liefert bei Bestaetigung ein leeres Objekt, sonst null. */
const confirmAction = (title, text, ok = 'Bestätigen') => openModal({ title, text, ok });

/* ------------------------------- Zustand ------------------------------- */

function statusLabel(status) {
  return ({ RUNNING: 'läuft', COMPLETED: 'fertig', PLANNING: 'plant', PAUSED: 'pausiert', STOPPING: 'stoppt', FAILED: 'Fehler' })[status] || status || 'bereit';
}

function setMsg(sel, text, err = false) {
  const el = $(sel);
  if (!el) return;
  el.textContent = text;
  el.className = `msg${err ? ' err' : ''}`;
}

function setActiveSection(id) {
  document.querySelectorAll('[data-nav-section]').forEach((link) => {
    const active = link.dataset.navSection === id || (id === 'routesSection' && link.dataset.navSection === 'packsSection');
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  document.querySelectorAll('.topnav a[href^="#"]').forEach((link) => {
    const active = link.getAttribute('href') === `#${id}`;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
}

function connectSectionNavigation() {
  const sections = ['top', 'createSection', 'villaSection', 'packsSection', 'routesSection']
    .map((id) => document.getElementById(id)).filter(Boolean);
  if (!('IntersectionObserver' in window) || !sections.length) return;
  sectionObserver?.disconnect();
  sectionObserver = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (visible) setActiveSection(visible.target.id);
  }, { rootMargin: '-18% 0px -62% 0px', threshold: [0.1, 0.35, 0.7] });
  sections.forEach((section) => sectionObserver.observe(section));
  document.querySelectorAll('[data-nav-section]').forEach((link) => link.addEventListener('click', () => setActiveSection(link.dataset.navSection)));
}

/* -------------------------- Hub-Gesundheit ---------------------------- */

async function checkHealth() {
  const dot = $('#healthDot');
  const banner = $('#offlineBanner');
  try {
    const h = await api('/api/health');
    // Wichtig: api() wirft bei HTTP-Fehlern nicht — hier muss der Inhalt zaehlen.
    if (h.error || h.ok !== true) throw new Error(h.error || 'Health meldet kein ok');
    dot.className = 'dot ok';
    $('#healthText').textContent = `Hub online · ${h.routes} Routen`;
    $('#metricRoutes').textContent = h.routes;
    banner.hidden = true;
  } catch (err) {
    dot.className = 'dot err';
    $('#healthText').textContent = 'Hub nicht erreichbar';
    $('#offlineText').textContent = `Der Hub antwortet nicht (${String(err.message || err).slice(0, 90)}). Prüfe, ob der Server läuft.`;
    banner.hidden = false;
  }
}

/* -------------------------------- Villen ------------------------------ */

async function loadVillas() {
  const sequence = ++villaLoadSequence;
  $('#villaList').setAttribute('aria-busy', 'true');
  try {
    const villas = await api('/api/villas');
    if (sequence !== villaLoadSequence) return;
    if (villas.error || !Array.isArray(villas)) throw new Error(villas.error || 'Ungültige Antwort');
    latestVillas = villas;
    $('#openLatestBtn').disabled = !villas.length;
    renderVillaList();
  } catch (err) {
    if (sequence !== villaLoadSequence) return;
    $('#villaResultCount').textContent = 'Laden fehlgeschlagen';
    $('#villaList').innerHTML = '<div class="empty-state"><b>Villen nicht erreichbar</b><p>Prüfe deine Verbindung und lade die Liste erneut.</p><button class="ghost villa-retry" type="button">Erneut laden</button></div>';
    $('#villaList').querySelector('.villa-retry').addEventListener('click', loadVillas);
  } finally {
    if (sequence === villaLoadSequence) $('#villaList').setAttribute('aria-busy', 'false');
  }
}

function renderVillaList() {
  const villas = VillaUI.visibleVillas(latestVillas, {
    query: $('#villaSearch').value, status: $('#villaFilter').value, sort: $('#villaSort').value
  });
  $('#villaResultCount').textContent = `${villas.length} von ${latestVillas.length} Villen`;
  if (!villas.length) {
    const hasVillas = latestVillas.length > 0;
    $('#villaList').innerHTML = `<div class="empty-state"><span class="empty-icon" aria-hidden="true">◇</span><b>${hasVillas ? 'Kein passender Entwicklungsraum' : 'Dein erstes Projekt beginnt hier'}</b><p>${hasVillas ? 'Ändere deine Suche oder setze die Filter zurück.' : 'Beschreibe deine Idee und erstelle eine Villa für dein Agententeam.'}</p><button class="ghost empty-action" type="button">${hasVillas ? 'Filter zurücksetzen' : 'Idee eingeben'}</button></div>`;
    $('#villaList').querySelector('.empty-action').addEventListener('click', () => {
      if (hasVillas) { $('#villaSearch').value = ''; $('#villaFilter').value = ''; renderVillaList(); $('#villaSearch').focus(); }
      else $('#idea').focus();
    });
    return;
  }
  $('#villaList').innerHTML = villas.map((v) => `<button type="button" class="villa-card" data-id="${esc(v.id)}"><span class="villa-card-title"><span class="project-mark" aria-hidden="true">◇</span><b>${esc(v.name)}</b></span><small>${esc((v.idea || '').slice(0, 160))}</small><span class="villa-card-footer"><span class="badge ${esc(v.status)}">${esc(statusLabel(v.status))}</span><span class="project-open">Öffnen ↗</span></span></button>`).join('');
  document.querySelectorAll('.villa-card').forEach((el) => el.addEventListener('click', () => openVilla(Number(el.dataset.id))));
}

async function createVilla() {
  const idea = $('#idea').value.trim();
  if (!idea) { setMsg('#createMsg', 'Bitte zuerst eine Idee eingeben.', true); $('#idea').focus(); return; }
  const btn = $('#createBtn');
  btn.disabled = true;
  setMsg('#createMsg', 'Villa wird geplant und der Entwicklungsraum vorbereitet …');
  try {
    const out = await api('/api/villas', {
      method: 'POST',
      body: {
        name: $('#villaName').value.trim() || 'Neue Villa', idea,
        agentCount: Number($('#agentCount').value) || 24,
        sourcePath: $('#sourcePath').value.trim()
      }
    });
    if (out.error) { setMsg('#createMsg', out.error, true); toast(out.error, 'err'); return; }
    $('#idea').value = '';
    $('#sourcePath').value = '';
    setMsg('#createMsg', `Villa #${out.villaId} bereit. Entwicklungsraum wird geöffnet …`);
    toast(`Villa #${out.villaId} erstellt`);
    await loadVillas();
    await openVilla(out.villaId);
  } catch (err) {
    setMsg('#createMsg', String(err.message || err), true);
    toast(`Anlegen fehlgeschlagen: ${String(err.message || err)}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

function openWorkspace() {
  if ($('#detailPanel').hidden) workspaceOpener = document.activeElement;
  $('#detailPanel').hidden = false;
  document.querySelectorAll('.topbar, #mobileNav, .dashboard, body > footer').forEach((el) => { el.inert = true; });
  document.body.classList.add('workspace-open');
  setTimeout(() => $('#chatMsg')?.focus(), 80);
}

function closeWorkspace() {
  $('#detailPanel').hidden = true;
  document.body.classList.remove('workspace-open');
  document.querySelectorAll('.topbar, #mobileNav, .dashboard, body > footer').forEach((el) => { el.inert = false; });
  currentVilla = null;
  currentAgentId = null;
  const fallback = $('#openLatestBtn');
  const target = workspaceOpener?.isConnected && workspaceOpener.getClientRects().length ? workspaceOpener : fallback;
  target?.focus();
  if (document.activeElement !== target) fallback?.focus();
}

async function openVilla(id) {
  const data = await api(`/api/villas/${id}`);
  if (data.error) { toast(data.error, 'err'); return; }
  currentVilla = data;
  const agents = data.agents || [];
  currentAgentId = agents.find((a) => a.is_root)?.id ?? agents[0]?.id ?? null;
  openWorkspace();
  selectTab('chat');
  $('#dName').textContent = data.villa.name;
  $('#dIdea').textContent = data.villa.idea;
  renderAll(data);
  await renderSuggestions(data);
  await loadChat(id);
  $('#chatMsg').focus();
}

function renderAll(data) {
  renderStats(data);
  renderReports(data.reports);
  renderTasks(data.tasks);
  renderAgents(data.agents);
  renderMemories(data.memories);
  renderAudit(data.audit);
}

function renderStats(d) {
  const tasks = d.tasks || [];
  const agents = d.agents || [];
  const done = tasks.filter((t) => t.status === 'DONE').length;
  const total = tasks.length;
  const open = tasks.filter((t) => ['PENDING', 'READY', 'RUNNING', 'REVIEW'].includes(t.status)).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const active = d.running || ['RUNNING', 'STOPPING'].includes(d.villa.status);
  $('#startBtn').hidden = active; $('#startBtn').disabled = false;
  $('#stopBtn').hidden = !active;
  $('#stopBtn').textContent = d.villa.status === 'STOPPING' ? 'Stoppt …' : 'Stoppen';
  $('#deleteBtn').hidden = active;
  $('#workspaceStatus').textContent = active ? 'Entwicklung läuft' : statusLabel(d.villa.status);
  $('#workspaceStatus').className = `status-pill ${active ? 'RUNNING' : esc(d.villa.status)}`;
  const autoAt = Number(d.villa.auto_retry_at || 0);
  const autoTile = autoAt && d.villa.status === 'PAUSED'
    ? `<div class="stat"><b>~${new Date(autoAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr</b>Auto-Fortsetzung</div>`
    : '';
  $('#dStats').innerHTML = `<div class="stat"><b>${statusLabel(d.villa.status)}</b>Status</div><div class="stat"><b>${agents.length}</b>Agenten</div><div class="stat"><b>${done}/${total}</b>erledigt</div><div class="stat"><b>${open}</b>offen</div>${autoTile}`;
  $('#progressBar').style.width = `${pct}%`;
  $('#progressLabel').textContent = `${pct}% abgeschlossen · ${open} nächste Schritte`;
  const track = $('#progressTrack');
  if (track) track.setAttribute('aria-valuenow', String(pct));
  $('#taskCount').textContent = total;
  $('#agentCountLabel').textContent = agents.length;

}

async function renderSuggestions(d) {
  const tasks = d.tasks || [];
  const fallback = [
    { title: 'Plan schärfen', prompt: 'Prüfe den aktuellen Plan, nenne die drei wichtigsten Risiken und schlage konkrete Verbesserungen vor.', rationale: 'Projektqualität erhöhen' },
    { title: 'Nächsten Schritt', prompt: tasks.find((t) => ['PENDING', 'READY'].includes(t.status))?.title || 'Welche konkrete Aufgabe sollten wir als Nächstes umsetzen?', rationale: 'Arbeitsfluss fortsetzen' }
  ];
  const out = await api(`/api/villas/${d.villa.id}/suggestions`);
  const suggestions = Array.isArray(out) && out.length ? out : fallback;
  $('#suggestionList').innerHTML = suggestions.map((s) => `<button type="button" class="suggestion" data-prompt="${esc(s.prompt)}"><span class="suggestion-title"><b>${esc(s.title)}</b><em>${esc(s.category || 'Empfehlung')} · ${esc(String(s.priority || ''))}</em></span><span class="suggestion-rationale">${esc(s.rationale || s.prompt.slice(0, 72))}</span>${Array.isArray(s.context) && s.context.length ? `<small>${esc(s.context.slice(0, 2).join(' · '))}</small>` : ''}</button>`).join('');
  document.querySelectorAll('.suggestion').forEach((b) => b.addEventListener('click', () => { $('#chatMsg').value = b.dataset.prompt; $('#chatMsg').focus(); }));
}

function renderTasks(tasks) {
  const all = Array.isArray(tasks) ? tasks : [];
  const f = $('#taskFilter')?.value || '';
  const shown = f ? all.filter((t) => t.status === f) : all;
  $('#taskList').innerHTML = shown.length
    ? shown.map((t) => `<div class="row"><div class="head"><b>${esc(t.title)}</b><span class="badge ${esc(t.status)}">${esc(t.status)}${t.attempts > 1 ? ` · Versuch ${esc(String(t.attempts))}` : ''}</span></div><div class="sub">${esc(t.description || '')}${t.result ? `\n→ ${esc(String(t.result).slice(0, 500))}` : ''}</div>${t.status === 'FAILED' ? `<button type="button" data-retry="${esc(String(t.id))}" class="compact">Neu starten</button>` : ''}</div>`).join('')
    : '<p class="empty-state">Keine Aufgaben in dieser Ansicht.</p>';
  const bar = $('#retryFailedBar');
  if (bar) bar.hidden = !all.some((x) => x.status === 'FAILED');
  document.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', () => retryTask(b.dataset.retry)));
}

async function retryTask(taskId) {
  if (!currentVilla) return;
  const out = await api(`/api/villas/${currentVilla.villa.id}/tasks/${taskId}/retry`, { method: 'POST' });
  if (out.error) { toast(`Neustart fehlgeschlagen: ${out.error}`, 'err'); return; }
  toast(`Aufgabe #${taskId} wieder in der Warteschlange`);
  await refreshCurrent();
}

async function retryFailedAll() {
  if (!currentVilla) return;
  const out = await api(`/api/villas/${currentVilla.villa.id}/retry-failed`, { method: 'POST' });
  if (out.error) { toast(`Sammel-Neustart fehlgeschlagen: ${out.error}`, 'err'); return; }
  toast(out.requeued ? `${out.requeued} Aufgaben erneut gestartet` : 'Keine fehlgeschlagenen Aufgaben', out.requeued ? 'ok' : 'info');
  await refreshCurrent();
}

function renderAgents(agents) {
  const list = Array.isArray(agents) ? agents : [];
  $('#agentList').innerHTML = list.length
    ? list.map((a) => `<div class="row"><div class="head"><b>${esc(a.name)}${a.is_root ? ' · Deep Agent' : ''}</b><span class="badge ${esc(a.status)}">${esc(a.status)}</span></div><div class="sub">Rolle: ${esc(a.role)} · Autonomie: ${esc(a.autonomy_level)}</div></div>`).join('')
    : '<p class="empty-state">Keine Agenten angelegt.</p>';
}

function renderMemories(memories) {
  const list = Array.isArray(memories) ? memories : [];
  $('#memList').innerHTML = list.length
    ? list.map((m) => `<div class="row"><div class="head"><b>${esc(m.title)}</b><span class="badge">${esc(m.kind)} · <span class="num">${esc(m.importance)}</span>/10</span></div><div class="sub">${esc((m.content || '').slice(0, 500))}</div></div>`).join('')
    : '<p class="empty-state">Noch kein Gedächtnis.</p>';
}

function renderReports(reports) {
  const list = Array.isArray(reports) ? reports : [];
  $('#reportList').innerHTML = list.length
    ? list.map((r) => `<details class="row"><summary><b>${esc(r.title)}</b> <span class="badge">${esc(r.kind)}</span></summary><div class="sub">${esc(r.content)}</div></details>`).join('')
    : '<p class="empty-state">Noch keine Berichte.</p>';
}

function renderAudit(entries) {
  const list = Array.isArray(entries) ? entries : [];
  $('#auditList').innerHTML = list.length
    ? list.map((e) => `<div class="row"><div class="head"><b>${esc(e.tool)}</b><span class="badge ${e.allowed ? 'RUNNING' : 'FAILED'}">${e.allowed ? 'erlaubt' : 'blockiert'}</span></div><div class="sub">${esc(e.args)}\n→ ${esc(e.result)}</div></div>`).join('')
    : '<p class="empty-state">Keine Werkzeugaufrufe protokolliert.</p>';
}

async function loadChat(villaId) {
  const msgs = await api(`/api/villas/${villaId}/messages?agentId=${currentAgentId}`);
  const log = $('#chatLog');
  log.innerHTML = Array.isArray(msgs) && msgs.length
    ? msgs.map((m) => `<div class="bubble ${m.role}"><span class="meta">${m.role === 'user' ? 'Du' : 'Deep Agent'} · ${new Date(m.created_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span>${esc(m.content)}</div>`).join('')
    : '<div class="bubble assistant"><span class="meta">Deep Agent · bereit</span>Ich bin dein Entwicklungsleiter. Wähle links einen Vorschlag oder beschreibe direkt, was als Nächstes gebaut werden soll.</div>';
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
  const pending = document.createElement('div');
  pending.className = 'bubble assistant';
  pending.innerHTML = '<span class="meta">Deep Agent · denkt …</span>';
  log.appendChild(pending);
  log.scrollTop = log.scrollHeight;
  try {
    const out = await api(`/api/villas/${currentVilla.villa.id}/chat`, { method: 'POST', body: { message: msg, agentId: currentAgentId } });
    if (out.error) throw new Error(out.error);
    pending.innerHTML = `<span class="meta">Deep Agent · ${esc(out.route || 'Offline-Planer')}</span>${esc(out.answer || 'Keine Antwort.')}`;
  } catch (err) {
    pending.innerHTML = `<span class="meta">Fehler</span>${esc(String(err.message || err))}`;
    toast(`Chat fehlgeschlagen: ${String(err.message || err)}`, 'err');
  } finally {
    btn.disabled = false;
    log.scrollTop = log.scrollHeight;
    await refreshCurrent();
  }
}

async function refreshCurrent() {
  if (!currentVilla) return;
  const data = await api(`/api/villas/${currentVilla.villa.id}`);
  if (data.error) return;
  currentVilla = data;
  renderAll(data);
  await renderSuggestions(data);
  loadVillas();
}

async function startDevelopment() {
  if (!currentVilla) return;
  $('#startBtn').disabled = true;
  const out = await api(`/api/villas/${currentVilla.villa.id}/orchestrate`, { method: 'POST', body: { concurrency: 4, maxTasks: 500, adaptive: true } });
  if (out.error) toast(out.error, 'err'); else toast('Entwicklung gestartet');
  await refreshCurrent();
}

async function stopDevelopment() {
  if (!currentVilla) return;
  const out = await api(`/api/villas/${currentVilla.villa.id}/stop`, { method: 'POST' });
  if (out.error) toast(out.error, 'err'); else toast('Lauf gestoppt');
  await refreshCurrent();
}

async function deleteVilla() {
  if (!currentVilla) return;
  const ok = await confirmAction('Villa löschen?', `„${currentVilla.villa.name}" wird mitsamt allen Agenten, Aufgaben und Berichten gelöscht. Das lässt sich nicht rückgängig machen.`, 'Endgültig löschen');
  if (!ok) return;
  const out = await api(`/api/villas/${currentVilla.villa.id}`, { method: 'DELETE' });
  if (out.error) { toast(out.error, 'err'); return; }
  toast('Villa gelöscht', 'info');
  closeWorkspace();
  loadVillas();
}

async function exportVilla() {
  if (!currentVilla) return;
  const id = currentVilla.villa.id;
  const res = await fetch(`/api/villas/${id}/export`, { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} });
  if (!res.ok) { toast(`Export fehlgeschlagen (HTTP ${res.status})`, 'err'); return; }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `villa-${id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`Villa #${id} exportiert`, 'info');
}

async function editVilla() {
  if (!currentVilla) return;
  const v = currentVilla.villa;
  const out = await openModal({
    title: 'Villa bearbeiten',
    text: 'Name und Idee lassen sich jederzeit anpassen.',
    ok: 'Speichern',
    fields: [
      { id: 'name', label: 'Name', value: v.name },
      { id: 'idea', label: 'Idee / Ziel', value: v.idea }
    ]
  });
  if (!out) return;
  const patch = {};
  if (out.name.trim() && out.name.trim() !== v.name) patch.name = out.name.trim();
  if (out.idea.trim() && out.idea.trim() !== v.idea) patch.idea = out.idea.trim();
  if (!Object.keys(patch).length) { toast('Keine Änderung erkannt', 'info'); return; }
  const res = await api(`/api/villas/${v.id}`, { method: 'PATCH', body: patch });
  if (res.error) { toast(`Speichern fehlgeschlagen: ${res.error}`, 'err'); return; }
  toast('Villa aktualisiert');
  await refreshCurrent();
  loadVillas();
}

/* ------------------------------- Routen ------------------------------- */

async function loadRoutes() {
  const routes = await api('/api/routes');
  if (!Array.isArray(routes)) { $('#routeList').innerHTML = '<p class="empty-state">Routen konnten nicht geladen werden.</p>'; return; }
  $('#routeList').innerHTML = routes.length
    ? routes.map((r) => `<div class="row"><div class="head"><b>${esc(r.name)}</b><span class="badge ${r.hasKey || r.provider === 'offline' ? 'RUNNING' : 'PAUSED'}">${r.provider === 'offline' ? 'offline' : r.hasKey ? 'Key vorhanden' : 'kein Key'}</span></div><div class="sub">${esc(r.provider)} · ${esc(r.model)} · Prio <span class="num">${esc(r.priority)}</span> · ok <span class="num">${esc(r.ok)}</span> / fail <span class="num">${esc(r.fail)}</span></div><button type="button" data-toggle="${r.id}" data-enabled="${r.enabled}" class="compact">${r.enabled ? 'Deaktivieren' : 'Aktivieren'}</button></div>`).join('')
    : '<p class="empty-state">Noch keine Routen angelegt.</p>';
  document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/routes/${b.dataset.toggle}`, { method: 'PATCH', body: { enabled: b.dataset.enabled !== '1' } });
    loadRoutes();
  }));
}

async function addRoute() {
  const out = await api('/api/routes', {
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
  if (out.error) { toast(`Route nicht gespeichert: ${out.error}`, 'err'); return; }
  toast('Route gespeichert');
  loadRoutes();
}

async function loadSecrets() {
  const list = await api('/api/secrets');
  $('#secretList').innerHTML = Array.isArray(list) && list.length
    ? list.map((s) => `<div class="row"><div class="head"><b>${esc(s.name)}</b><span class="badge RUNNING">gesetzt</span></div></div>`).join('')
    : '<p class="hint">Noch kein Key hinterlegt. Der Offline-Planer bleibt verfügbar.</p>';
}

async function addSecret() {
  const name = $('#sName').value.trim();
  const value = $('#sValue').value;
  if (!name || !value) { toast('Name und Wert sind nötig', 'err'); return; }
  const out = await api('/api/secrets', { method: 'POST', body: { name, value } });
  if (out.error) { toast(`Key nicht gespeichert: ${out.error}`, 'err'); return; }
  $('#sValue').value = '';
  toast(`Key ${name} gespeichert (Wert wird nie angezeigt)`);
  loadSecrets();
  loadRoutes();
}

/* --------------------------- Packs & Werkzeuge -------------------------- */

function packCard(p, kind) {
  const off = p.enabled === false;
  const chips = kind === 'tool' && Array.isArray(p.tools)
    ? `<div class="chip-row">${p.tools.map((t) => `<span class="tool-chip ${p.effective === false ? '' : 'on'}">${esc(t)}</span>`).join('')}</div>`
    : '';
  const blocked = p.effective === false && p.enabled === true
    ? '<p class="msg err">Wirkungslos: der Hauptschalter „Werkzeuge“ ist aus.</p>' : '';
  return `<article class="pack-card ${off ? 'off' : ''}">
    <div class="pack-head"><strong>${esc(p.title)}</strong>
      <button type="button" class="toggle" data-pack="${esc(p.id)}" data-enabled="${p.enabled ? '1' : '0'}" aria-pressed="${p.enabled ? 'true' : 'false'}"><span class="knob" aria-hidden="true"></span>${p.enabled ? 'an' : 'aus'}</button>
    </div>
    <p>${esc(p.description)}</p>${chips}${blocked}
  </article>`;
}

async function loadPacks() {
  const state = await api('/api/packs');
  if (state.error || !Array.isArray(state.features)) {
    $('#packList').innerHTML = '<p class="empty-state">Packs konnten nicht geladen werden.</p>';
    return;
  }
  packState = state;
  $('#packList').innerHTML = state.features.map((f) => packCard(f, 'feature')).join('');
  const enabledTools = state.tools.filter((t) => t.effective).length;
  $('#packCountLabel').textContent = `${enabledTools}/${state.tools.length}`;
  setMsg('#packMsg', state.blocked.length
    ? `${state.blocked.length} Werkzeug-Pack(s) gesperrt: ${state.blocked.join(', ')} — die Agenten können diese Werkzeuge nicht benutzen.`
    : `${enabledTools} von ${state.tools.length} Werkzeug-Packs aktiv · Hauptschalter ${state.master.enabled ? 'frei' : 'gesperrt'}`, state.blocked.length > 0);
  if ($('#workspacePackList')) {
    $('#workspacePackList').innerHTML = state.tools.map((t) => packCard(t, 'tool')).join('')
      + `<article class="pack-card"><div class="pack-head"><strong>Hauptschalter</strong><span class="badge ${state.master.enabled ? 'RUNNING' : 'FAILED'}">${state.master.enabled ? 'freigegeben' : 'gesperrt'}</span></div><p>Der Hauptschalter „Werkzeuge“ gibt alle Werkzeug-Packs frei. Ist er aus, blockiert der Hub jeden Werkzeugaufruf und protokolliert das im Audit.</p></article>`;
  }
  document.querySelectorAll('[data-pack]').forEach((b) => b.addEventListener('click', () => togglePack(b.dataset.pack, b.dataset.enabled !== '1')));
}

async function togglePack(id, enabled) {
  const out = await api(`/api/packs/${id}`, { method: 'PATCH', body: { enabled } });
  if (out.error) { toast(`Pack nicht geändert: ${out.error}`, 'err'); return; }
  toast(`Pack ${id} ${enabled ? 'aktiviert' : 'deaktiviert'}`, enabled ? 'ok' : 'info');
  await loadPacks();
  loadTools();
  loadStats();
}

async function loadTools() {
  const tools = await api('/api/tools');
  const box = $('#toolList');
  if (!box) return;
  if (!Array.isArray(tools)) { box.innerHTML = '<p class="empty-state">Werkzeuge konnten nicht geladen werden.</p>'; return; }
  const blocked = tools.filter((t) => !t.enabled).length;
  box.innerHTML = (blocked ? `<p class="msg err">${blocked} von ${tools.length} Werkzeugen sind gerade gesperrt.</p>` : '')
    + tools.map((t) => `<div class="row"><div class="head"><b>${esc(t.name)}</b><span class="badge ${t.enabled ? 'RUNNING' : 'FAILED'}">${t.enabled ? 'frei' : 'gesperrt'}</span></div><div class="sub">${esc(t.description)}${t.packTitle ? `\nPack: ${esc(t.packTitle)}` : ''}</div></div>`).join('');
}

/* ---------------------------- Statistik & SSE --------------------------- */

async function loadStats() {
  const s = await api('/api/stats');
  if (s.error) return;
  $('#metricVillas').textContent = s.villas;
  $('#metricAgents').textContent = s.agents;
  $('#metricTasks').textContent = `${s.tasks.done ?? 0}/${s.tasks.total}`;
  let h = `Villen ${s.villas} · Agenten ${s.agents} · Aufgaben offen ${s.tasks.open}/${s.tasks.total} · laufende Villen ${s.runningVillas ? s.runningVillas.length : 0} · Hub v${s.version}`;
  if (s.routesHealth) {
    const rh = s.routesHealth;
    h += ` · Routen ok/fail ${rh.ok}/${rh.fail}`;
    if (rh.cooling && rh.cooling.length) h += ` · Cooldown: ${rh.cooling.join(', ')}`;
  }
  if (s.packs && s.packs.blocked && s.packs.blocked.length) h += ` · gesperrte Werkzeug-Packs: ${s.packs.blocked.join(', ')}`;
  $('#statsBar').textContent = h;
}

/**
 * Genau eine SSE-Verbindung: eine bestehende wird vor dem Neuaufbau
 * geschlossen, sonst haengen nach jedem Token-Wechsel weitere Streams offen.
 */
function connectEvents() {
  if (eventSource) { try { eventSource.close(); } catch { /* schon zu */ } eventSource = null; }
  const t = getToken();
  const es = new EventSource(t ? `/api/events?token=${encodeURIComponent(t)}` : '/api/events');
  eventSource = es;
  es.onopen = () => { if (eventSource === es) { $('#healthDot').className = 'dot ok'; $('#streamStatus').textContent = '● Live verbunden'; } };
  es.onerror = () => { if (eventSource === es) { $('#streamStatus').textContent = 'Live getrennt · verbinde erneut'; checkHealth(); } };
  // Nur Statusaenderungen loesen einen Refresh aus; Schwellwertereignisse
  // (task/chat/tool) werden gebuendelt, damit ein Lauf die API nicht flutet.
  let refreshTimer = null;
  es.onmessage = (ev) => {
    let e = {};
    try { e = JSON.parse(ev.data); } catch { /* kein JSON — ignorieren */ }
    if (!['villa', 'progress', 'report', 'pack_updated'].includes(e.type)) return;
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      loadVillas();
      loadStats();
      if (currentVilla) refreshCurrent();
      if (e.type === 'pack_updated') { loadPacks(); loadTools(); }
    }, 900);
  };
}

function saveToken() {
  setToken($('#tokenInput').value.trim());
  $('#tokenInput').value = '';
  toast('Token gespeichert', 'info');
  loadRoutes();
  loadSecrets();
  connectEvents();
  checkHealth();
}

/* ------------------------------ Wartung ------------------------------- */

async function downloadBackup() {
  const out = await api('/api/backup');
  if (out.error) { setMsg('#maintMsg', `Backup fehlgeschlagen: ${out.error}`, true); return; }
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `villaforge-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  setMsg('#maintMsg', `Backup geladen (${out.villas.length} Villen, Hub ${out.version})`);
}

async function pruneAudit() {
  const input = await openModal({
    title: 'Protokolle aufräumen',
    text: 'Audit-Einträge und Nachrichten, die älter als die angegebene Zahl von Tagen sind, werden entfernt. Zuerst läuft ein Trockenlauf.',
    ok: 'Trockenlauf',
    fields: [{ id: 'days', label: 'Älter als (Tage)', value: '90', type: 'number' }]
  });
  if (!input) return;
  const days = Number(input.days) || 90;
  const dry = await api('/api/maintenance/prune', { method: 'POST', body: { days, dryRun: true } });
  if (dry.error) { setMsg('#maintMsg', `Wartung fehlgeschlagen: ${dry.error}`, true); return; }
  const ok = await confirmAction('Aufräumen bestätigen?', `Trockenlauf: ${dry.deleted.audit} Audit-Einträge und ${dry.deleted.messages} Nachrichten älter als ${days} Tage würden entfernt.`, 'Jetzt aufräumen');
  if (!ok) { setMsg('#maintMsg', 'Aufräumen abgebrochen.'); return; }
  const done = await api('/api/maintenance/prune', { method: 'POST', body: { days } });
  if (done.error) { setMsg('#maintMsg', `Wartung fehlgeschlagen: ${done.error}`, true); return; }
  const text = `Aufgeräumt: ${done.deleted.audit} Audit-Einträge, ${done.deleted.messages} Nachrichten`;
  setMsg('#maintMsg', text);
  toast(text);
}

async function importVillaFile() {
  const file = $('#importFile').files[0];
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    if (!payload || !payload.villa) throw new Error('Kein Villa-Export (villa-Objekt fehlt)');
    const out = await api('/api/villas/import', { method: 'POST', body: payload });
    if (out.error) throw new Error(out.error);
    toast(`Villa #${out.villaId} importiert`);
    await loadVillas();
    openVilla(out.villaId);
  } catch (err) {
    toast(`Import fehlgeschlagen: ${String(err.message || err)}`, 'err');
  } finally {
    $('#importFile').value = '';
  }
}

/* -------------------------- Globaler Master-Agent ----------------------- */
function renderMasterMessages(messages) {
  const log = $('#masterChatLog');
  if (!log) return;
  log.innerHTML = Array.isArray(messages) && messages.length
    ? messages.map((m) => `<div class="bubble ${m.role === 'user' ? 'user' : 'assistant'}"><span class="meta">${m.role === 'user' ? 'Du' : 'Master Agent'}</span>${esc(m.content)}</div>`).join('')
    : '<div class="bubble assistant"><span class="meta">Master Agent · bereit</span>Ich kann die gesamte VillaForge-Konfiguration steuern. Frage mich nach Status, Duplikaten, Vorschlägen, Villen, Packs oder Connectoren.</div>';
  log.scrollTop = log.scrollHeight;
}
async function loadMasterChat() {
  const messages = await api('/api/master/messages?limit=40');
  if (!messages.error) renderMasterMessages(messages);
}
async function sendMasterChat(text = $('#masterChatMsg')?.value.trim()) {
  if (!text) return;
  $('#masterChatMsg').value = '';
  const log = $('#masterChatLog');
  log.insertAdjacentHTML('beforeend', `<div class="bubble user"><span class="meta">Du</span>${esc(text)}</div><div class="bubble assistant"><span class="meta">Master Agent · arbeitet …</span>Konfiguration wird geprüft …</div>`);
  log.scrollTop = log.scrollHeight;
  const out = await api('/api/master/chat', { method: 'POST', body: { message: text }, timeoutMs: 120000 });
  if (out.error) { toast(`Master-Agent: ${out.error}`, 'err'); await loadMasterChat(); return; }
  setMsg('#masterMsg', out.answer || 'Aktion verarbeitet.');
  await loadMasterChat();
  await Promise.all([loadVillas(), loadStats(), loadPacks()]);
  if (out.villaId) openVilla(out.villaId);
}

/* -------------------------------- Tabs -------------------------------- */

function selectTab(tab) {
  document.querySelectorAll('.side-tab').forEach((t) => {
    const on = t.dataset.tab === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    t.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('.workspace-main .tabpane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab));
  if (tab === 'packs') { loadPacks(); loadTools(); }
}

/* ------------------------------- Verdrahtung --------------------------- */

$('#taskFilter').addEventListener('change', () => currentVilla && renderTasks(currentVilla.tasks));
$('#retryFailedBar').addEventListener('click', retryFailedAll);
$('#createForm').addEventListener('submit', (e) => { e.preventDefault(); createVilla(); });
$('#villaSearch').addEventListener('input', renderVillaList);
$('#villaFilter').addEventListener('change', renderVillaList);
$('#villaSort').addEventListener('change', renderVillaList);
$('#heroCreateBtn').addEventListener('click', () => { $('#createSection').scrollIntoView({ behavior: 'smooth' }); setTimeout(() => $('#idea').focus(), 350); });
$('#refreshBtn').addEventListener('click', loadVillas);
$('#openLatestBtn').addEventListener('click', () => latestVillas[0] && openVilla(latestVillas[0].id));
$('#closeDetail').addEventListener('click', closeWorkspace);
$('#deleteBtn').addEventListener('click', deleteVilla);
$('#exportBtn').addEventListener('click', exportVilla);
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', importVillaFile);
$('#editBtn').addEventListener('click', editVilla);
$('#backupBtn').addEventListener('click', downloadBackup);
$('#pruneBtn').addEventListener('click', pruneAudit);
$('#startBtn').addEventListener('click', startDevelopment);
$('#stopBtn').addEventListener('click', stopDevelopment);
$('#sendBtn').addEventListener('click', sendChat);
$('#chatMsg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); } });
$('#masterSendBtn').addEventListener('click', () => sendMasterChat());
$('#masterChatMsg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMasterChat(); } });
document.querySelectorAll('[data-master-prompt]').forEach((b) => b.addEventListener('click', () => sendMasterChat(b.dataset.masterPrompt)));
$('#addRouteBtn').addEventListener('click', addRoute);
$('#addSecretBtn').addEventListener('click', addSecret);
$('#saveTokenBtn').addEventListener('click', saveToken);
$('#packsRefreshBtn').addEventListener('click', () => { loadPacks(); loadTools(); toast('Packs neu geladen', 'info'); });
$('#offlineRetry').addEventListener('click', () => { checkHealth(); loadVillas(); loadStats(); });
$('#modalCancel').addEventListener('click', () => $('#modal').close('cancel'));
// Enter im Modal-Formular bestaetigt, damit man nicht zur Maus greifen muss.
$('#modalFields').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#modalOk').click(); } });
document.querySelectorAll('.side-tab').forEach((t, index, tabs) => {
  t.id = `tab-${t.dataset.tab}`;
  t.setAttribute('aria-controls', `pane-${t.dataset.tab}`);
  t.tabIndex = t.classList.contains('active') ? 0 : -1;
  const pane = document.querySelector(`[data-pane="${t.dataset.tab}"]`);
  pane.id = `pane-${t.dataset.tab}`;
  pane.setAttribute('role', 'tabpanel');
  pane.setAttribute('aria-labelledby', t.id);
  t.addEventListener('click', () => selectTab(t.dataset.tab));
  t.addEventListener('keydown', (e) => {
    const offset = ['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : 0;
    if (!offset && !['Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const next = tabs[e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + offset + tabs.length) % tabs.length];
    selectTab(next.dataset.tab); next.focus();
  });
});
function syncNavigation() { setActiveSection((location.hash || '#top').slice(1)); }
window.addEventListener('hashchange', syncNavigation);
syncNavigation();
document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !$('#detailPanel').hidden && !$('#modal').open) {
    const focusable = [...$('#detailPanel').querySelectorAll('button, input, textarea, select, [tabindex="0"]')].filter((el) => !el.disabled && el.getClientRects().length && el.tabIndex >= 0);
    const first = focusable[0], last = focusable.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }
  if (e.key === 'Escape'  && !$('#detailPanel').hidden && !$('#modal').open) closeWorkspace();
});

checkHealth();
loadVillas();
loadStats();
loadRoutes();
loadSecrets();
loadPacks();
loadTools();
connectEvents();
connectSectionNavigation();
loadMasterChat();
setInterval(checkHealth, 20000);
setInterval(loadStats, 30000);
