/* VillaForge · Mobile-First App-Logik (v1.55.0)
   Übersicht / Chat / Agenten / Konto + Vollbild-Arbeitsraum.
   Alle Touch-Targets ≥44px, SSE-Live-Updates, Offline-freundlich. */
const $ = (s) => document.querySelector(s);
let vfToken = localStorage.getItem('vf_token') || '';
let currentVilla = null;
let currentAgentId = null;
let latestVillas = [];
let latestFocusVillaId = null;
let activityTicks = [];
let dashboardActionsLoadedAt = 0;
let activeDetailLoadedAt = 0;
let activeDetailVillaId = null;

const api = async (path, opts = {}) => {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(vfToken ? { Authorization: 'Bearer ' + vfToken } : {}) }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { error: text }; }
  if (!res.ok && !data.error) data.error = `HTTP ${res.status}`;
  if (res.status === 401) { vfToken = ''; localStorage.removeItem('vf_token'); showLogin('Login erforderlich.'); }
  return data;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(window.vfToastT); window.vfToastT = setTimeout(() => { t.hidden = true; }, 2600); }

/* ---------- Login ---------- */
function showLogin(msg = 'Melde dich an, um weiterzuarbeiten.') { const o = $('#loginOverlay'); if (o) { o.hidden = false; $('#loginMsg').textContent = msg; } }
function hideLogin() { const o = $('#loginOverlay'); if (o) o.hidden = true; }
async function doLogin() {
  const email = $('#loginEmail').value.trim(), password = $('#loginPassword').value;
  if (!email || !password) { $('#loginMsg').textContent = 'Bitte E-Mail und Passwort eingeben.'; return; }
  $('#loginBtn').disabled = true; $('#loginMsg').textContent = 'Anmeldung läuft …';
  try {
    const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const out = await res.json();
    if (out.token) { vfToken = out.token; localStorage.setItem('vf_token', vfToken); hideLogin(); $('#loginMsg').textContent = ''; $('#loginPassword').value = ''; boot(); }
    else { $('#loginMsg').textContent = out.error || 'Anmeldung fehlgeschlagen.'; }
  } catch (e) { $('#loginMsg').textContent = String(e); }
  finally { $('#loginBtn').disabled = false; }
}
async function checkSession() {
  try {
    const me = await api('/api/auth/me');
    if (me.user) {
      hideLogin();
      const label = me.user.name || me.user.email || 'Mein Konto';
      $('#accountName').textContent = label;
      $('#accountDetail').textContent = me.user.email && me.user.name ? me.user.email : 'Angemeldet · VillaForge';
      const initial = String(label).trim().charAt(0).toLocaleUpperCase('de-DE');
      if (initial) document.querySelectorAll('.avatar').forEach(el => { el.textContent = initial; });
    } else {
      $('#accountName').textContent = 'Mein Konto';
      $('#accountDetail').textContent = 'Nicht angemeldet';
    }
  } catch {}
}

/* ---------- Navigation (Bottom-Tabs) ---------- */
function selectView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  document.querySelectorAll('.bottomnav .nav-item[data-view]').forEach(n => n.classList.toggle('active', n.dataset.view === name));
  window.scrollTo({ top: 0 });
}

/* ---------- Health & Kennzahlen ---------- */
async function checkHealth() {
  try {
    const h = await api('/api/health');
    $('#healthDot').className = 'dot ok';
    $('#healthText').textContent = `Hub online · ${h.routes} Routen · v${h.version || ''}`;
    $('#systemBadge').className = 'badge online'; $('#systemBadge').textContent = '● Hub online';
    $('.quality-card').classList.remove('is-offline');
    $('#gateChip').className = 'chip ok'; $('#gateChip').textContent = 'VERBUNDEN';
    $('#systemHeadline').textContent = 'Hub erreichbar';
    const llm = h.llm || {};
    $('#systemDetail').textContent = `${llm.eligibleRoutes ?? 0} nutzbare KI-Routen · ${llm.freeOnly ? 'kostenfreie Routen bevorzugt' : 'Routenmodus aktiv'}`;
    $('#metricRoutes').textContent = h.routes ?? '–';
    const up = h.uptime || {};
    $('#superagentStatus').className = 'chip ok'; $('#superagentStatus').textContent = 'LIVE · AKTIV';
    $('#healthDetails').innerHTML = [
      ['Version', 'v' + (h.version || '–')], ['Routen', h.routes ?? '–'],
      ['System-Uptime', up.systemSec ? Math.round(up.systemSec / 3600) + ' h' : '–'],
      ['CPU-Kerne', h.cpu?.cores ?? '–']
    ].map(([k, v]) => `<div class="row" style="display:flex;justify-content:space-between"><span style="color:var(--muted)">${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
    $('#verNum').textContent = h.version || '–';
  } catch {
    $('#healthDot').className = 'dot err'; $('#healthText').textContent = 'Hub nicht erreichbar';
    $('#systemBadge').className = 'badge status FAILED'; $('#systemBadge').textContent = '● Hub offline';
    $('.quality-card').classList.add('is-offline');
    $('#gateChip').className = 'chip'; $('#gateChip').textContent = 'OFFLINE';
    $('#systemHeadline').textContent = 'Hub nicht erreichbar';
    $('#systemDetail').textContent = 'Prüfe die Serververbindung und lade die Seite erneut.';
    $('#superagentStatus').className = 'chip'; $('#superagentStatus').textContent = 'OFFLINE';
  }
}

async function loadOpenHandsCanvas() {
  const state = $('#openhandsState');
  const link = $('#openhandsLink');
  const help = $('#openhandsHelp');
  if (!state || !link || !help) return;
  try {
    const integration = await api('/api/integrations/openhands');
    if (integration.enabled && /^https?:$/.test(new URL(integration.url).protocol)) {
      state.textContent = 'URL konfiguriert';
      link.href = integration.url;
      link.hidden = false;
      help.textContent = 'Canvas wird separat betrieben. Die URL wird beim Öffnen in einem neuen Tab geladen.';
    } else if (integration.state === 'invalid_configuration') {
      state.textContent = 'Konfiguration prüfen';
      help.textContent = 'OPENHANDS_CANVAS_URL ist ungültig. Erlaubt sind HTTP- oder HTTPS-URLs ohne Zugangsdaten.';
    } else {
      state.textContent = 'Nicht eingerichtet';
      link.hidden = true;
      help.textContent = 'Zum Aktivieren OPENHANDS_CANVAS_URL im Hub konfigurieren.';
    }
  } catch {
    state.textContent = 'Status nicht verfügbar';
    link.hidden = true;
    help.textContent = 'Canvas-Status konnte nicht geladen werden.';
  }
}

/* ---------- Villen ---------- */
const statusLabel = (status) => ({ RUNNING: 'läuft', COMPLETED: 'fertig', PLANNING: 'plant', PAUSED: 'pausiert', STOPPING: 'stoppt', FAILED: 'Fehler' })[status] || status || 'bereit';

function villaCardHtml(v, controls = false) {
  const active = v.status === 'RUNNING' || v.executing || v.queued;
  const control = controls ? `<button type="button" class="villa-control ${active ? 'stop' : 'start'}" data-villa-control="${Number(v.id)}" data-active="${active ? '1' : '0'}" aria-label="${active ? 'Villa stoppen' : 'Villa starten'}">${active ? '■ Stoppen' : '▶ Starten'}</button>` : '';
  const state = v.executing ? 'arbeitet' : v.queued ? 'wartet' : statusLabel(v.status);
  return `<div class="villa-entry${controls ? ' with-controls' : ''}"><button type="button" class="villa-card" data-id="${Number(v.id)}"><span class="villa-card-copy"><b>${esc(v.name)}</b><small>${esc((v.idea || '').slice(0, 105))}</small></span><span class="villa-card-state"><span class="badge status ${esc(v.status)}">${esc(state)}</span><span class="chev">›</span></span></button>${control}</div>`;
}

function renderVillaLists(villas = latestVillas) {
  const homeQuery = ($('#villaSearch')?.value || '').trim().toLocaleLowerCase('de-DE');
  const chatQuery = ($('#chatVillaSearch')?.value || '').trim().toLocaleLowerCase('de-DE');
  const matches = (query) => villas.filter(v => `${v.name || ''} ${v.idea || ''}`.toLocaleLowerCase('de-DE').includes(query));
  const homeMatches = matches(homeQuery);
  const chatMatches = matches(chatQuery);
  $('#villaList').innerHTML = homeMatches.length
    ? homeMatches.slice(0, homeQuery ? homeMatches.length : 12).map(v => villaCardHtml(v, true)).join('')
    : `<p class="empty-state">${villas.length ? 'Keine Villa passt zu deiner Suche.' : 'Noch keine Villa. Tippe oben auf ＋ Neue Villa.'}</p>`;
  $('#chatPickList').innerHTML = chatMatches.length
    ? chatMatches.map(v => villaCardHtml(v,false)).join('')
    : `<p class="empty-state">${villas.length ? 'Kein Projekt passt zu deiner Suche.' : 'Erstelle zuerst eine Villa, um mit ihrem Deep Agent zu arbeiten.'}</p>`;
  document.querySelectorAll('.villa-card').forEach(el => el.addEventListener('click', () => openVilla(Number(el.dataset.id))));
  document.querySelectorAll('[data-villa-control]').forEach(el => el.addEventListener('click', async event => {
    event.preventDefault(); event.stopPropagation();
    const id=Number(el.dataset.villaControl), active=el.dataset.active==='1'; el.disabled=true;
    try {
      const out=await api(active?`/api/villas/${id}/stop`:`/api/villas/${id}/orchestrate`,{method:'POST',body:active?{}:{concurrency:4,maxTasks:500,adaptive:true}});
      if(out.error)throw new Error(out.error);
      toast(active?(out.cancelled?'Villa aus der Warteschlange entfernt':'Villa wird angehalten'):(out.queued?'Villa vorgemerkt':'Entwicklung gestartet'));
      await loadVillas();
    } catch(e){toast('Steuerung fehlgeschlagen: '+String(e.message||e));el.disabled=false;}
  }));
}

async function loadDashboardActions(force = false) {
  const list=$('#dashboardActionList');
  if(!list || (!force && Date.now()-dashboardActionsLoadedAt<20000))return;
  dashboardActionsLoadedAt=Date.now();
  try {
    const rows=await api('/api/master/suggestions');
    const items=Array.isArray(rows)?rows.filter(row=>row.kind!=='status').slice(0,3):[];
    list.innerHTML=items.length?items.map(row=>'<button type="button" class="dashboard-action" data-dashboard-prompt="'+esc(row.prompt)+'"><span class="dashboard-action-top"><b>'+esc(row.title)+'</b><i class="priority-tag '+esc(row.priority||'normal')+'">'+esc(row.priority||'normal')+'</i></span><span class="dashboard-action-reason">'+esc(row.reason)+'</span><span class="dashboard-action-footer">'+esc(row.impact||'Projektfortschritt')+' · '+esc(row.acceptance||'Ergebnis mit prüfbarer Abnahme')+'</span></button>').join(''):'<div class="dashboard-clear"><span>✓</span><div><b>Keine akuten Blocker</b><small>Deine Villen laufen ohne gemeldete Fehler.</small></div></div>';
    list.querySelectorAll('[data-dashboard-prompt]').forEach(button=>button.addEventListener('click',()=>{
      if(typeof window.openVillaForgeMaster!=='function'){toast('Master-Agent ist gerade nicht verfügbar');return;}
      window.openVillaForgeMaster();
      setTimeout(()=>{const input=$('#masterInput');if(input){input.value=button.dataset.dashboardPrompt;input.focus();}},120);
    }));
  } catch {
    list.innerHTML='<p class="hint">Prioritäten können gerade nicht geladen werden.</p>';
  }
}

function renderOverview(villas) {
  const focus = villas.find(v => Number(v.id) === Number(latestFocusVillaId));
  const banner = $('#focusBanner');
  if (banner) banner.hidden = !latestFocusVillaId;
  const active = focus || villas.find(v => v.status === 'RUNNING') || villas.find(v => v.status === 'PLANNING') || villas[0] || null;
  const totalDone = villas.reduce((n, v) => n + Number(v.tasks_done || 0), 0);
  $('#metricAgents').textContent = villas.reduce((n,v)=>n+Number(v.agents_count||0),0);
  $('#metricRunning').textContent = villas.filter(v=>v.status==='RUNNING'||v.executing||v.queued).length;
  $('#metricDone').textContent = totalDone;
  $('#villaCount').textContent = villas.length;
  if (active) {
    $('#activeName').textContent = active.name;
    $('#activeIdea').textContent = (active.idea || '').slice(0, 120);
    $('#activeChip').textContent = statusLabel(active.status).toUpperCase();
    $('#activeChip').className = 'chip ' + (active.status === 'RUNNING' ? 'ok' : '');
    $('#activeVillaCard').dataset.id = active.id;
    $('#activeQualityChip').textContent = 'Prüfung lädt';
    $('#activeQualityChip').className = 'chip';
    $('#activeQualityHint').textContent = 'Lade den belegten Reifegrad und aktuelle Abnahmehindernisse …';
  } else {
    $('#activeName').textContent = 'Keine Villa aktiv';
    $('#activeIdea').textContent = 'Tippe auf ＋ und starte deine erste Villa.';
    $('#activeChip').textContent = 'LEER';
    $('#activeQualityChip').textContent = 'Nicht gestartet';
    $('#activeQualityHint').textContent = 'Nach dem Start erscheinen hier Reifegrad und nächste Qualitätskriterien.';
    $('#ringPct').textContent = '0%';
    $('#ringFg').style.strokeDashoffset = 213.6;
    $('#activeVillaCard').removeAttribute('data-id');
  }
  renderVillaLists(villas);
  updateActivity(totalDone);
  loadDashboardActions();
}

/* Fortschrittsring + Produktpushes der aktiven Villa nachladen */
async function loadActiveDetail(force = false) {
  const active = latestVillas.find(v => Number(v.id) === Number(latestFocusVillaId)) || latestVillas.find(v => v.status === 'RUNNING') || latestVillas[0];
  if (!active || (!force && Number(activeDetailVillaId)===Number(active.id) && Date.now()-activeDetailLoadedAt<15000)) return;
  activeDetailVillaId=Number(active.id);
  activeDetailLoadedAt=Date.now();
  try {
    const [d, product] = await Promise.all([api(`/api/villas/${active.id}`), api(`/api/villas/${active.id}/product`)]);
    if (d.error) return;
    const pct = Number.isFinite(Number(product.score)) ? Math.max(0,Math.min(100,Math.round(Number(product.score)))) : 0;
    $('#ringPct').textContent = pct + '%';
    $('#ringFg').style.strokeDashoffset = 213.6 * (1 - pct / 100);
    const verified=!!product.verified;
    $('#activeQualityChip').textContent=verified?'VERIFIZIERT':product.stage||'ABNAHME OFFEN';
    $('#activeQualityChip').className='chip '+(verified?'ok':'');
    const blockers=Array.isArray(product.blockers)?product.blockers:[];
    $('#activeQualityHint').textContent=verified?`${product.deliveryLabel||'Produkt'} · unabhängige Qualitätsprüfung bestanden`: `${product.deliveryLabel||'Produkt'} · ${blockers[0]||'Nachweise fehlen noch'}`;
    const pushes = (d.memories || []).filter(m => String(m.title || '').startsWith('Produkt-Push:')).slice(0, 3);
    $('#pushChip').textContent = pushes.length;
    $('#productList').innerHTML = pushes.length
      ? pushes.map(m => `<div class="product-row"><span class="ok-ico" style="width:18px;height:18px;font-size:10px">↑</span>${esc(String(m.content || '').replace('Fertiger Stand im GitHub-Produkt-Repo: https://github.com/', ''))}</div>`).join('')
      : '<p class="card-sub">Noch kein Produkt gepusht – nach jedem grünen Tor erscheint hier das fertige Repo.</p>';
    renderFleet(d);
  } catch {}
}

/* ---------- Agenten-Ansicht ---------- */
function renderFleet(d) {
  $('#fleetCount').textContent = (d.agents || []).length;
  $('#fleetVilla').textContent = 'Villa: ' + (d.villa?.name || '–');
  $('#fleetList').innerHTML = (d.agents || []).length
    ? d.agents.map(a => `<div class="row"><div class="head"><b>${esc(a.name)}${a.is_root ? ' · Deep Agent' : ''}</b><span class="badge ${esc(a.status)}">${esc(a.status)}</span></div><div class="sub">Rolle: ${esc(a.role)} · Autonomie: ${esc(a.autonomy_level)}</div></div>`).join('')
    : '<p class="empty-state">Keine Agenten vorhanden.</p>';
}
async function loadFleet() {
  const active = latestVillas.find(v => v.status === 'RUNNING') || latestVillas[0];
  if (!active) { $('#fleetList').innerHTML = '<p class="empty-state">Erst eine Villa erstellen, dann siehst du hier dein Agenten-Team.</p>'; $('#fleetCount').textContent = '0'; return; }
  const d = await api(`/api/villas/${active.id}`);
  if (!d.error) renderFleet(d);
}

/* ---------- Aktivität (Sparkline, SSE-getrieben) ---------- */
function updateActivity(totalDone) {
  $('#activityCount').textContent = totalDone || (activityTicks.length ? 'LIVE' : 0);
  activityTicks.push(totalDone);
  if (activityTicks.length > 24) activityTicks.shift();
  const max = Math.max(...activityTicks, 1), min = Math.min(...activityTicks, 0);
  const pts = activityTicks.map((v, i) => {
    const x = (i / Math.max(activityTicks.length - 1, 1)) * 120;
    const y = 36 - ((v - min) / Math.max(max - min, 1)) * 32;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  $('#sparkLine').setAttribute('points', pts || '0,38 120,38');
}

/* ---------- Villen laden / erstellen ---------- */
async function loadVillas() {
  const [villas, scheduler] = await Promise.all([api('/api/villas'), api('/api/scheduler')]);
  latestVillas = Array.isArray(villas) ? villas : [];
  latestFocusVillaId = Number(scheduler?.focusVillaId) || null;
  renderOverview(latestVillas);
  loadActiveDetail();
}
function setMsg(text, err = false) { const el = $('#createMsg'); el.textContent = text; el.className = 'msg' + (err ? ' err' : ''); }
async function createVilla() {
  const idea = $('#idea').value.trim();
  if (!idea) { setMsg('Bitte zuerst eine Idee eingeben.', true); $('#idea').focus(); return; }
  const btn = $('#createBtn'); btn.disabled = true; setMsg('Villa wird geplant …');
  try {
    const out = await api('/api/villas', { method: 'POST', body: { name: $('#villaName').value.trim() || 'Neue Villa', idea, agentCount: Number($('#agentCount').value) || 24, sourcePath: $('#sourcePath').value.trim() } });
    if (out.error) { setMsg(out.error, true); return; }
    $('#idea').value = ''; $('#sourcePath').value = '';
    closeSheet(); toast(`Villa #${out.villaId} erstellt`);
    await loadVillas(); await openVilla(out.villaId);
  } catch (e) { setMsg(String(e), true); } finally { btn.disabled = false; }
}
function openSheet() { $('#createSheet').hidden = false; setTimeout(() => $('#idea').focus(), 250); }
function closeSheet() { $('#createSheet').hidden = true; setMsg(''); }

/* ---------- Arbeitsraum (Vollbild) ---------- */
function selectTab(tab) {
  document.querySelectorAll('.tab-chip').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.workspace-main .tabpane').forEach(p => p.classList.toggle('active', p.dataset.pane === tab));
}
async function openVilla(id, tab = 'chat') {
  const data = await api(`/api/villas/${id}`);
  if (data.error) { toast(data.error); return; }
  currentVilla = data;
  currentAgentId = data.agents.find(a => a.is_root)?.id ?? data.agents[0]?.id ?? null;
  $('#detailPanel').hidden = false;
  $('#dName').textContent = data.villa.name;
  selectTab(tab);
  renderAll(data); renderSuggestions(data); await loadChat(id);
}
function closeWorkspace() { $('#detailPanel').hidden = true; }
async function refreshCurrent() { if (!currentVilla) return; const data = await api(`/api/villas/${currentVilla.villa.id}`); if (data.error) return; currentVilla = data; renderAll(data); loadVillas(); }
function renderAll(d) {
  const done = d.tasks.filter(t => t.status === 'DONE').length, total = d.tasks.length;
  const open = d.tasks.filter(t => ['PENDING', 'READY', 'RUNNING', 'REVIEW'].includes(t.status)).length;
  const pct = total ? Math.round(done / total * 100) : 0;
  const active = d.running || ['RUNNING', 'STOPPING'].includes(d.villa.status), queued = !!d.queued;
  $('#startBtn').hidden = active || queued; $('#stopBtn').hidden = !active && !queued;
  $('#workspaceStatus').textContent = queued ? 'wartet auf Startslot' : active ? '● läuft' : statusLabel(d.villa.status);
  $('#workspaceStatus').className = 'chip ' + (active ? 'ok' : '');
  $('#dStats').innerHTML = `<div class="stat"><b>${done}/${total}</b>erledigt</div><div class="stat"><b>${open}</b>offen</div><div class="stat"><b>${d.agents.length}</b>Agenten</div>`;
  $('#progressBar').style.width = pct + '%';
  $('#progressLabel').textContent = `${pct}% abgeschlossen · ${open} nächste Schritte`;
  $('#taskCount').textContent = total; $('#agentCountLabel').textContent = d.agents.length;
  renderTasks(d.tasks); renderAgents(d.agents); renderMemories(d.memories); renderReports(d.reports); renderAudit(d.audit);
}
async function renderSuggestions(d) {
  const id = d.villa.id;
  const rows = await api(`/api/master/suggestions?villaId=${id}`);
  if (currentVilla?.villa.id !== id) return;
  if (!Array.isArray(rows)) { $('#suggestionList').textContent = 'Vorschläge gerade nicht verfügbar.'; return; }
  $('#suggestionList').innerHTML = rows.length ? rows.map(r => `<button type="button" class="suggestion" data-prompt="${esc(r.prompt)}"><span class="suggestion-title">${esc(r.title)} <i aria-hidden="true">↗</i></span><span class="suggestion-reason">${esc(r.reason)}</span><span class="suggestion-meta"><b>${esc(r.priority || 'normal')} Priorität</b><span>${esc(r.impact || 'Projektfortschritt')}</span><span>Aufwand: ${esc(r.effort || 'mittel')}</span></span><span class="suggestion-acceptance"><b>Abnahme:</b> ${esc(r.acceptance || 'Ergebnis mit überprüfbarem Kriterium')}</span></button>`).join('') : '<p class="hint">Keine neuen passenden Vorschläge.</p>';
  document.querySelectorAll('#suggestionList .suggestion').forEach(b => b.addEventListener('click', () => { selectTab('chat'); $('#chatMsg').value = b.dataset.prompt; $('#chatMsg').focus(); }));
}

function renderTasks(tasks) {
  $('#taskList').innerHTML = tasks.length
    ? tasks.slice(0, 60).map(t => `<div class="row"><div class="head"><b>${esc(t.title)}</b><span class="badge ${esc(t.status)}">${esc(t.status)}</span></div><div class="sub">${esc(t.description || '')}${t.result ? '\n→ ' + esc(t.result.slice(0, 400)) : ''}</div></div>`).join('')
    : '<p class="empty-state">Keine Aufgaben vorhanden.</p>';
}
function renderAgents(agents) {
  $('#agentList').innerHTML = agents.map(a => `<div class="row"><div class="head"><b>${esc(a.name)}${a.is_root ? ' · Deep Agent' : ''}</b><span class="badge ${esc(a.status)}">${esc(a.status)}</span></div><div class="sub">Rolle: ${esc(a.role)} · Autonomie: ${esc(a.autonomy_level)}</div></div>`).join('') || '<p class="empty-state">Keine Agenten.</p>';
}
function renderMemories(memories) {
  $('#memList').innerHTML = memories?.length
    ? memories.slice(0, 40).map(m => `<div class="row"><div class="head"><b>${esc(m.title)}</b><span class="badge">${esc(m.kind)} · ${esc(m.importance)}/10</span></div><div class="sub">${esc((m.content || '').slice(0, 400))}</div></div>`).join('')
    : '<p class="empty-state">Noch kein Gedächtnis.</p>';
}
function renderReports(reports) {
  $('#reportList').innerHTML = reports?.length
    ? reports.slice(0, 30).map(r => `<details class="row"><summary><b>${esc(r.title)}</b> <span class="badge">${esc(r.kind)}</span></summary><div class="sub">${esc(r.content)}</div></details>`).join('')
    : '<p class="empty-state">Noch keine Berichte.</p>';
}
function renderAudit(entries) {
  $('#auditList').innerHTML = entries?.length
    ? entries.slice(0, 40).map(e => `<div class="row"><div class="head"><b>${esc(e.tool)}</b><span class="badge ${e.allowed ? 'RUNNING' : 'FAILED'}">${e.allowed ? 'erlaubt' : 'blockiert'}</span></div><div class="sub">${esc(e.args)}\n→ ${esc(e.result)}</div></div>`).join('')
    : '<p class="empty-state">Keine Werkzeugaufrufe protokolliert.</p>';
}

/* ---------- Chat ---------- */
async function loadChat(villaId) {
  const msgs = await api(`/api/villas/${villaId}/messages?agentId=${currentAgentId}`);
  const log = $('#chatLog');
  log.innerHTML = Array.isArray(msgs) && msgs.length
    ? msgs.map(m => `<div class="bubble ${m.role}"><span class="meta">${m.role === 'user' ? 'Du' : 'Deep Agent'} · ${new Date(m.created_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span>${esc(m.content)}</div>`).join('')
    : `<div class="bubble assistant"><span class="meta">Deep Agent · bereit</span>Ich bin dein Entwicklungsleiter. Beschreibe, was als Nächstes gebaut werden soll.</div>${(window.vfSuggestions || []).map(s => `<button class="suggestion" data-prompt="${esc(s.text)}"><span>${esc(s.label)} ↗</span>${esc(s.text.slice(0, 80))}</button>`).join('')}`;
  bindSuggestions(); log.scrollTop = log.scrollHeight;
}
function bindSuggestions() {
  document.querySelectorAll('.suggestion').forEach(b => b.addEventListener('click', () => { $('#chatMsg').value = b.dataset.prompt; $('#chatMsg').focus(); }));
}
async function sendChat() {
  const msg = $('#chatMsg').value.trim();
  if (!msg || !currentVilla) return;
  const btn = $('#sendBtn'); btn.disabled = true; $('#chatMsg').value = '';
  const log = $('#chatLog');
  log.insertAdjacentHTML('beforeend', `<div class="bubble user"><span class="meta">Du</span>${esc(msg)}</div>`);
  const pending = document.createElement('div');
  pending.className = 'bubble assistant';
  pending.innerHTML = '<span class="meta">Deep Agent · denkt …</span>';
  log.appendChild(pending); log.scrollTop = log.scrollHeight;
  try {
    const out = await api(`/api/villas/${currentVilla.villa.id}/chat`, { method: 'POST', body: { message: msg, agentId: currentAgentId } });
    pending.innerHTML = `<span class="meta">Deep Agent · ${esc(out.route || (out.code==='LLM_UNAVAILABLE'?'Modellverbindung unterbrochen':'Keine Modellantwort'))}</span>${esc(out.answer || out.error || 'Keine Antwort.')}`;
  } catch (e) { pending.innerHTML = `<span class="meta">Fehler</span>${esc(String(e))}`; }
  finally { btn.disabled = false; log.scrollTop = log.scrollHeight; refreshCurrent(); }
}
async function startDevelopment() {
  if (!currentVilla) return;
  const btn = $('#startBtn'); btn.disabled = true;
  try {
    const out = await api(`/api/villas/${currentVilla.villa.id}/orchestrate`, { method: 'POST', body: { concurrency: 4, maxTasks: 500, adaptive: true } });
    if (out.error) { toast(out.error); return; }
    await refreshCurrent();
    toast(out.queued ? 'Villa vorgemerkt und startet, sobald ein Slot frei ist' : 'Entwicklung gestartet');
  } catch (e) { toast('Start fehlgeschlagen: ' + String(e.message || e)); }
  finally { btn.disabled = false; }
}
async function stopDevelopment() {
  if (!currentVilla) return;
  try {
    const out = await api(`/api/villas/${currentVilla.villa.id}/stop`, { method: 'POST' });
    if (out.error) { toast(out.error); return; }
    await refreshCurrent();
    toast(out.cancelled ? 'Villa aus der Warteschlange entfernt' : out.stopped ? 'Villa wird sicher angehalten' : 'Villa pausiert');
  } catch (e) { toast('Stopp fehlgeschlagen: ' + String(e.message || e)); }
}

/* ---------- Routen & Keys (Konto) ---------- */
async function loadRoutes() {
  const routes = await api('/api/routes');
  if (!Array.isArray(routes)) return;
  $('#routeCount').textContent = routes.length;
  $('#routeList').innerHTML = routes.map(r => {
    const st = r.ok > 0 ? 'OK' : (r.fail > 0 ? 'ERROR' : 'NEW');
    const stL = r.ok > 0 ? 'aktiv' : (r.fail > 0 ? 'Fehler' : 'bereit');
    const keyL = r.provider === 'offline' ? 'offline' : r.hasKey ? 'Key' : 'kein Key';
    const keyC = (r.provider === 'offline' || r.hasKey) ? 'RUNNING' : 'PAUSED';
    return `<div class="row route-row${r.enabled ? '' : ' off'}"><div class="head"><b><i class="rdot rdot-${st.toLowerCase()}"></i>${esc(r.name)}</b><span class="badge ${st}">${stL}</span></div><div class="sub">${esc(r.model)} · Prio ${esc(r.priority)} · <span class="okc">ok ${esc(r.ok)}</span> · <span class="failc">fail ${esc(r.fail)}</span></div><div class="row-actions"><span class="badge ${keyC}">${keyL}</span><button data-toggle="${r.id}" data-enabled="${r.enabled}" class="compact">${r.enabled ? 'Deaktivieren' : 'Aktivieren'}</button></div></div>`;
  }).join('');
  document.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', async () => { await api(`/api/routes/${b.dataset.toggle}`, { method: 'PATCH', body: { enabled: b.dataset.enabled !== '1' } }); loadRoutes(); }));
}
async function addRoute() {
  const name = $('#rName').value.trim(); const url = $('#rUrl').value.trim();
  if (!name || !url) { toast('Name und Base URL angeben'); return; }
  await api('/api/routes', { method: 'POST', body: { name, provider: 'openai-compatible', baseUrl: url, model: $('#rModel').value.trim(), keyEnv: $('#rKeyEnv').value.trim(), priority: 10 } });
  toast('Route gespeichert'); loadRoutes();
}
async function loadSecrets() {
  const list = await api('/api/secrets');
  $('#secretList').innerHTML = Array.isArray(list) && list.length
    ? list.map(s => `<div class="row" style="display:flex;justify-content:space-between;align-items:center"><b>${esc(s.name)}</b><span class="badge RUNNING">gesetzt</span></div>`).join('')
    : '<p class="hint">Noch kein Key hinterlegt.</p>';
}
async function addSecret() {
  const name = $('#sName').value.trim(), value = $('#sValue').value;
  if (!name || !value) { toast('Name und Wert angeben'); return; }
  await api('/api/secrets', { method: 'POST', body: { name, value } });
  $('#sValue').value = ''; toast('Key gespeichert'); loadSecrets(); loadRoutes();
}

/* ---------- SSE (Live-Updates mit Selbstheilung) ---------- */
function connectEvents() {
  if (window.vfES) { try { window.vfES.close(); } catch (e) {} }
  if (window.vfBeatTimer) clearInterval(window.vfBeatTimer);
  const es = new EventSource('/api/events'); window.vfES = es;
  let lastBeat = Date.now();
  es.onopen = () => { lastBeat = Date.now(); };
  es.onmessage = () => {
    lastBeat = Date.now();
    activityTicks.push(Date.now());
    if (activityTicks.length > 24) activityTicks.shift();
    loadVillas();
    if (currentVilla) refreshCurrent();
  };
  es.onerror = () => { try { es.close(); } catch (e) {} setTimeout(connectEvents, 5000); };
  window.vfBeatTimer = setInterval(() => { if (Date.now() - lastBeat > 45000) { try { window.vfES.close(); } catch (e) {} connectEvents(); } }, 15000);
}

/* ---------- Ereignisse & Start ---------- */
$('#loginBtn').addEventListener('click', doLogin);
$('#loginPassword').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.querySelectorAll('.bottomnav .nav-item[data-view]').forEach(n => n.addEventListener('click', () => {
  const v = n.dataset.view;
  if (v === 'chat') { selectView('chat'); return; }
  if (v === 'agents') { selectView('agents'); loadFleet(); return; }
  selectView(v);
}));
$('#newVillaBtn').addEventListener('click', openSheet);
$('#villaSearch').addEventListener('input', () => renderVillaLists());
$('#chatVillaSearch').addEventListener('input', () => renderVillaLists());
$('#createBackdrop').addEventListener('click', closeSheet);
$('#createBtn').addEventListener('click', createVilla);
$('#activeVillaCard').addEventListener('click', () => { const id = $('#activeVillaCard').dataset.id; if (id) openVilla(Number(id)); else openSheet(); });
$('#activeVillaCard').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#activeVillaCard').click(); } });
$('#dashboardNewBtn').addEventListener('click',openSheet);
$('#dashboardMasterBtn').addEventListener('click',()=>window.openVillaForgeMaster?.());
$('#dashboardActionsRefresh').addEventListener('click',()=>loadDashboardActions(true));
$('#superagentOpen').addEventListener('click', () => window.openVillaForgeMaster());

$('#closeDetail').addEventListener('click', closeWorkspace);
$('#startBtn').addEventListener('click', startDevelopment);
$('#stopBtn').addEventListener('click', stopDevelopment);
$('#sendBtn').addEventListener('click', sendChat);
$('#chatMsg').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
$('#chatMsg').addEventListener('input', () => { const t = $('#chatMsg'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 120) + 'px'; });
$('#addRouteBtn').addEventListener('click', addRoute);
$('#addSecretBtn').addEventListener('click', addSecret);
document.querySelectorAll('.tab-chip').forEach(t => t.addEventListener('click', () => selectTab(t.dataset.tab)));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#detailPanel').hidden) closeWorkspace(); });

function boot() { checkSession(); checkHealth(); loadOpenHandsCanvas(); loadVillas(); loadRoutes(); loadSecrets(); connectEvents(); }
boot(); setInterval(checkHealth, 20000);
