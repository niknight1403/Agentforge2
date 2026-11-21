(function(){
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
const setMsg=(id,msg,error=false)=>{const el=$(id);el.textContent=msg;el.style.color=error?'#ff8194':'var(--green)';};

let masterPending = null;
let masterSending = false;
function speakMasterMessage(content) {
  if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance !== 'function') {
    setMsg('#masterMsg', 'Sprachausgabe wird von diesem Browser nicht unterstützt.', true);
    return;
  }
  const text = String(content || '').trim();
  if (!text) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 12000));
  const language = document.documentElement.lang || 'de-DE';
  utterance.lang = language;
  const voices = window.speechSynthesis.getVoices();
  utterance.voice = voices.find(voice => voice.lang.toLowerCase() === language.toLowerCase())
    || voices.find(voice => voice.lang.toLowerCase().startsWith(language.slice(0, 2).toLowerCase()))
    || null;
  utterance.onerror = event => {
    if (event.error !== 'canceled' && event.error !== 'interrupted') {
      setMsg('#masterMsg', 'Die Sprachausgabe konnte nicht gestartet werden.', true);
    }
  };
  window.speechSynthesis.speak(utterance);
  setMsg('#masterMsg', 'Sprachausgabe läuft. Mit „Vorlesen stoppen“ kannst du sie beenden.');
}

function renderMasterMessages(rows) {
  $('#masterLog').innerHTML = rows.length ? rows.map(m => {
    const isUser = m.role === 'user';
    return `<article class="master-bubble ${isUser ? 'user' : ''}"><small>${isUser ? 'Du' : 'Master-Agent'}</small><p>${esc(m.content)}</p>${isUser ? '' : `<button type="button" class="ghost master-speak" data-speak="${esc(m.content)}" aria-label="Master-Agent-Antwort vorlesen">Vorlesen</button><button type="button" class="ghost master-stop" aria-label="Sprachausgabe stoppen">Stopp</button>`}</article>`;
  }).join('') : '<div class="empty-state"><b>Deine Zentrale für VillaForge</b><p>Beschreibe eine Änderung oder wähle einen Vorschlag. Du kannst mit „Status“ beginnen.</p></div>';
  document.querySelectorAll('.master-speak').forEach(button => button.addEventListener('click', () => speakMasterMessage(button.dataset.speak)));
  document.querySelectorAll('.master-stop').forEach(button => button.addEventListener('click', () => window.speechSynthesis?.cancel()));
  $('#masterLog').scrollTop = $('#masterLog').scrollHeight;
}
async function refreshMaster() {
  const [history, status, proposals, integrations] = await Promise.all([api('/api/master/messages'),api('/api/master/status'),api('/api/master/suggestions'),api('/api/integrations')]);
  if (history.error) { setMsg('#masterMsg', `Master-Agent nicht verfügbar: ${history.error}. Der Hub benötigt die passende Aktualisierung.`,true); return; }
  renderMasterMessages(history);
  if (!status.error) {
    const ultra = status.ultra || {version:'-',capabilities:0,enabledVillas:[]};
    $('#masterSummary').textContent = `${status.villas.length} Villen · APEX-Ω ${ultra.version} · ${ultra.enabledVillas.length} Autopilot aktiv · ${status.skills.length} Skills · ${status.connectors.length} Connectoren`;
    const routeData = !integrations?.error ? integrations?.llm : null;
    const routeRows = Array.isArray(routeData?.routes) ? routeData.routes : [];
    const mcpRows = Array.isArray(integrations?.mcpTools) ? integrations.mcpTools : [];
    const routeLine = routeData
      ? `LLM: ${routeRows.length} Routen · ${routeRows.filter(r => r.status === 'OK').length} zuletzt gesund · Free-only ${routeData.freeOnly ? 'an' : 'aus'}`
      : 'LLM-/MCP-Inventar nur mit Administratorrechten verfügbar';
    const routeDetails = routeRows.slice(0, 8).map(r => `${esc(r.provider)} / ${esc(r.model)} · ${esc(r.status)} · ${r.enabled ? 'aktiv' : 'aus'} · ${r.free ? 'free' : 'nicht als free eingestuft'}`).join(' | ');
    const mcpDetails = mcpRows.slice(0, 8).map(t => esc(t.name)).join(', ');
    $('#masterCatalog').innerHTML = `<p class="hint"><b>APEX-Ω Ultra Agent:</b> ${ultra.capabilities} Fähigkeiten · aktiv: ${ultra.enabledVillas.length ? ultra.enabledVillas.map(id=>'#'+id).join(', ') : 'keine Villa'} · Befehl: „Aktiviere Autopilot #ID“</p><p class="hint">Packs: ${status.packs.features.map(p => `${esc(p.id)} ${p.enabled ? 'an' : 'aus'}`).join(' · ')}</p><p class="hint">Skills: ${status.skills.map(s => `${esc(s.title)} (${s.enabled ? 'an' : 'aus'})`).join(', ') || 'noch keine'}</p><p class="hint">Connectoren: ${status.connectors.map(c => `${esc(c.title)}: ${esc(c.last_status)}`).join(', ') || 'noch keine'}</p><p class="hint">${esc(routeLine)}</p><p class="hint">${routeDetails || 'Keine konfigurierten LLM-Routen gemeldet.'}</p><p class="hint">Freigegebene aktive MCP-Werkzeuge: ${mcpRows.length}${mcpDetails ? ` · ${mcpDetails}` : ''}</p>`;
  }
  const rows = Array.isArray(proposals) ? proposals : [];
  $('#masterSuggestions').innerHTML = rows.map(r => `<button type="button" class="ghost master-suggestion" data-prompt="${esc(r.prompt)}" title="${esc(r.reason)}">${esc(r.title)} ↗</button>`).join('');
  document.querySelectorAll('.master-suggestion').forEach(b => b.addEventListener('click', () => { $('#masterInput').value = b.dataset.prompt; $('#masterInput').focus(); }));
}
async function openMaster() {
  if (!$('#masterDialog').open) $('#masterDialog').showModal();
  setMsg('#masterMsg','');
  await refreshMaster();
  $('#masterInput').focus();
}
async function sendMaster(e) {
  e?.preventDefault();
  if (masterSending) return;
  const message = $('#masterInput').value.trim();
  if (!masterPending && !message) return;
  if (!masterPending) masterPending = {message,requestId:crypto.randomUUID()};
  masterSending = true; $('#masterSendBtn').disabled = true;
  setMsg('#masterMsg','Master-Agent prüft die Nachricht und führt passende Aktionen aus …');
  try {
    let out = await api('/api/master/chat',{method:'POST',body:masterPending});
    for (let i=0;out.pending && i<15;i++) {
      await new Promise(r => setTimeout(r,1500));
      out = await api(`/api/master/turn/${encodeURIComponent(masterPending.requestId)}`);
    }
    if (out.code === 'LLM_UNAVAILABLE') {
      setMsg('#masterMsg',out.answer || 'Kein Sprachmodell erreichbar. Es wurde nichts angelegt.',true);
      masterPending = null; $('#masterInput').value = '';
      await refreshMaster();
      return;
    }
    if (out.error || out.pending) throw new Error(out.error || 'Die Aktion läuft noch. Mit „Status prüfen“ wird dieselbe Anfrage fortgesetzt.');
    if (out.answer) setMsg('#masterMsg',out.ok ? 'Bearbeitung abgeschlossen.' : out.answer,!out.ok);
    masterPending = null; $('#masterInput').value = '';
    await Promise.all([refreshMaster(),loadVillas(),typeof loadStats === 'function' ? loadStats() : Promise.resolve(),typeof loadPacks === 'function' ? loadPacks() : Promise.resolve()]);
  } catch(err) { setMsg('#masterMsg',String(err.message || err),true); }
  finally {
    masterSending = false; $('#masterSendBtn').disabled = false;
    $('#masterSendBtn').textContent = masterPending ? 'Status prüfen' : 'Senden';
  }
}
$('#masterOpenBtn').addEventListener('click',openMaster);
$('#mobileMasterBtn')?.addEventListener('click',openMaster);
$('#masterCloseBtn').addEventListener('click',() => $('#masterDialog').close());
$('#masterForm').addEventListener('submit',sendMaster);
$('#masterInput').addEventListener('keydown',e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMaster(); } });

window.openVillaForgeMaster = openMaster;

})();
