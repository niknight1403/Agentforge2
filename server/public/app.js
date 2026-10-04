const $ = (s) => document.querySelector(s);
// Optionaler Hub-Token (VF_TOKEN): wird in localStorage gehalten und als
// Bearer-Header mitgeschickt. EventSource kann keine Header, dort laeuft
// der Token als URL-Parameter.
const getToken = () => localStorage.getItem('vf_token') || '';
const setToken = (t) => { t ? localStorage.setItem('vf_token', t) : localStorage.removeItem('vf_token'); };
const api = async (path, opts = {}) => {
  const headers = { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) };
  const res = await fetch(path, { headers, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { error: text }; }
  if (!res.ok && !data.error) data.error = `HTTP ${res.status}`;
  return data;
};
const esc = (s) => String(s ?? '').replace(/[&<>\"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '\"':'&quot;' }[c]));
let currentVilla = null;
let currentAgentId = null;
let latestVillas = [];

async function checkHealth() {
  try { const h = await api('/api/health'); $('#healthDot').className='dot ok'; $('#healthText').textContent=`Hub online · ${h.routes} Routen`; $('#metricRoutes').textContent=h.routes; }
  catch { $('#healthDot').className='dot err'; $('#healthText').textContent='Hub nicht erreichbar'; }
}
function statusLabel(status) { return ({RUNNING:'läuft',COMPLETED:'fertig',PLANNING:'plant',PAUSED:'pausiert',STOPPING:'stoppt',FAILED:'Fehler'})[status] || status || 'bereit'; }
async function loadVillas() {
  const villas = await api('/api/villas'); latestVillas = Array.isArray(villas) ? villas : [];
  $('#metricVillas').textContent = latestVillas.length;
  if (!latestVillas.length) { $('#villaList').innerHTML='<p class="empty-state">Noch keine Villa erstellt. Starte oben deine erste Entwicklungsumgebung.</p>'; return; }
  $('#villaList').innerHTML = latestVillas.map(v => `<div class="villa-card" data-id="${v.id}"><div><b>${esc(v.name)}</b><small>${esc((v.idea||'').slice(0,105))}</small></div><span class="badge ${esc(v.status)}">${esc(statusLabel(v.status))}</span></div>`).join('');
  document.querySelectorAll('.villa-card').forEach(el=>el.addEventListener('click',()=>openVilla(Number(el.dataset.id))));
  const active = latestVillas.find(v=>v.status==='RUNNING'); $('#metricAgents').textContent = active ? 'aktiv' : '0';
}
function setMsg(text, err=false) { const el=$('#createMsg'); el.textContent=text; el.className='msg'+(err?' err':''); }
async function createVilla() {
  const idea=$('#idea').value.trim(); if(!idea){setMsg('Bitte zuerst eine Idee eingeben.',true); $('#idea').focus(); return;}
  const btn=$('#createBtn'); btn.disabled=true; setMsg('Villa wird geplant und der Entwicklungsraum vorbereitet …');
  try {
    const out=await api('/api/villas',{method:'POST',body:{name:$('#villaName').value.trim()||'Neue Villa',idea,agentCount:Number($('#agentCount').value)||24,sourcePath:$('#sourcePath').value.trim()}});
    if(out.error){setMsg(out.error,true);return;}
    $('#idea').value=''; $('#sourcePath').value=''; setMsg(`Villa #${out.villaId} bereit. Entwicklungsraum wird geöffnet …`); await loadVillas(); await openVilla(out.villaId);
  } catch(e){setMsg(String(e),true);} finally{btn.disabled=false;}
}
function openWorkspace(){ $('#detailPanel').hidden=false; document.body.classList.add('workspace-open'); setTimeout(()=>$('#chatMsg')?.focus(),80); }
function closeWorkspace(){ $('#detailPanel').hidden=true; document.body.classList.remove('workspace-open'); }
async function openVilla(id) {
  const data=await api(`/api/villas/${id}`); if(data.error)return;
  currentVilla=data; currentAgentId=data.agents.find(a=>a.is_root)?.id??data.agents[0]?.id??null; openWorkspace();
  $('#dName').textContent=data.villa.name; $('#dIdea').textContent=data.villa.idea; renderAll(data); renderSuggestions(data); await loadChat(id); $('#chatMsg').focus();
}
function renderAll(data){ renderStats(data); renderReports(data.reports); renderTasks(data.tasks); renderAgents(data.agents); renderMemories(data.memories); renderAudit(data.audit); }
function renderStats(d){
  const done=d.tasks.filter(t=>t.status==='DONE').length, total=d.tasks.length, open=d.tasks.filter(t=>['PENDING','READY','RUNNING','REVIEW'].includes(t.status)).length;
  const pct=total?Math.round(done/total*100):0; const active=d.running||['RUNNING','STOPPING'].includes(d.villa.status);
  $('#startBtn').hidden=active; $('#startBtn').disabled=false; $('#stopBtn').hidden=!active; $('#stopBtn').textContent=d.villa.status==='STOPPING'?'Stoppt …':'Stoppen'; $('#deleteBtn').hidden=active; $('#workspaceStatus').textContent=active?'Entwicklung läuft':statusLabel(d.villa.status); $('#workspaceStatus').className=`status-pill ${active?'RUNNING':''}`;
  $('#dStats').innerHTML=`<div class="stat"><b>${statusLabel(d.villa.status)}</b>Status</div><div class="stat"><b>${d.agents.length}</b>Agenten</div><div class="stat"><b>${done}/${total}</b>erledigt</div><div class="stat"><b>${open}</b>offen</div>`;
  $('#progressBar').style.width=`${pct}%`; $('#progressLabel').textContent=`${pct}% abgeschlossen · ${open} nächste Schritte`; $('#taskCount').textContent=total; $('#agentCountLabel').textContent=d.agents.length; $('#metricAgents').textContent=d.agents.length; $('#metricTasks').textContent=`${pct}%`;
}
function renderSuggestions(d){
  const open=d.tasks.filter(t=>['PENDING','READY'].includes(t.status)).slice(0,2); const suggestions=[
    {label:'Plan schärfen',text:'Prüfe den aktuellen Plan, nenne die drei wichtigsten Risiken und schlage konkrete Verbesserungen vor.'},
    {label:'Nächsten Schritt',text:open[0]?`Bearbeite jetzt die Aufgabe: ${open[0].title}. Liefere ein prüfbares Ergebnis.`:'Welche konkrete Aufgabe sollten wir als Nächstes umsetzen?'},
    {label:'Umsatzchance',text:'Bewerte Zielgruppe, Preismodell und die schnellste realistische Umsatzchance für dieses Projekt.'}
  ];
  $('#suggestionList').innerHTML=suggestions.map(s=>`<button class="suggestion" data-prompt="${esc(s.text)}"><span>${esc(s.label)} ↗</span>${esc(s.text.slice(0,72))}…</button>`).join('');
  document.querySelectorAll('.suggestion').forEach(b=>b.addEventListener('click',()=>{ $('#chatMsg').value=b.dataset.prompt; $('#chatMsg').focus(); }));
}
function renderTasks(tasks){ const f=$('#taskFilter')?.value||''; const shown=f?tasks.filter(t=>t.status===f):tasks; $('#taskList').innerHTML=shown.length?shown.map(t=>`<div class="row"><div class="head"><b>${esc(t.title)}</b><span class="badge ${esc(t.status)}">${esc(t.status)}</span></div><div class="sub">${esc(t.description||'')}${t.result?'\n→ '+esc(t.result.slice(0,500)):''}</div></div>`).join(''):'<p class="empty-state">Keine Aufgaben in dieser Ansicht.</p>'; }
function renderAgents(agents){ $('#agentList').innerHTML=agents.map(a=>`<div class="row"><div class="head"><b>${esc(a.name)}${a.is_root?' · Deep Agent':''}</b><span class="badge ${esc(a.status)}">${esc(a.status)}</span></div><div class="sub">Rolle: ${esc(a.role)} · Autonomie: ${esc(a.autonomy_level)}</div></div>`).join(''); }
function renderMemories(memories){ $('#memList').innerHTML=memories.length?memories.map(m=>`<div class="row"><div class="head"><b>${esc(m.title)}</b><span class="badge">${esc(m.kind)} · ${esc(m.importance)}/10</span></div><div class="sub">${esc((m.content||'').slice(0,500))}</div></div>`).join(''):'<p class="empty-state">Noch kein Gedächtnis.</p>'; }
function renderReports(reports){ $('#reportList').innerHTML=reports?.length?reports.map(r=>`<details class="row"><summary><b>${esc(r.title)}</b> <span class="badge">${esc(r.kind)}</span></summary><div class="sub">${esc(r.content)}</div></details>`).join(''):'<p class="empty-state">Noch keine Berichte.</p>'; }
function renderAudit(entries){ $('#auditList').innerHTML=entries?.length?entries.map(e=>`<div class="row"><div class="head"><b>${esc(e.tool)}</b><span class="badge ${e.allowed?'RUNNING':'FAILED'}">${e.allowed?'erlaubt':'blockiert'}</span></div><div class="sub">${esc(e.args)}\n→ ${esc(e.result)}</div></div>`).join(''):'<p class="empty-state">Keine Werkzeugaufrufe protokolliert.</p>'; }
async function loadChat(villaId){ const msgs=await api(`/api/villas/${villaId}/messages?agentId=${currentAgentId}`); const log=$('#chatLog'); log.innerHTML=Array.isArray(msgs)&&msgs.length?msgs.map(m=>`<div class="bubble ${m.role}"><span class="meta">${m.role==='user'?'Du':'Deep Agent'} · ${new Date(m.created_at).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}</span>${esc(m.content)}</div>`).join(''):'<div class="bubble assistant"><span class="meta">Deep Agent · bereit</span>Ich bin dein Entwicklungsleiter. Wähle links einen Vorschlag oder beschreibe direkt, was als Nächstes gebaut werden soll.</div>'; log.scrollTop=log.scrollHeight; }
async function sendChat(){ const msg=$('#chatMsg').value.trim(); if(!msg||!currentVilla)return; const btn=$('#sendBtn'); btn.disabled=true; $('#chatMsg').value=''; const log=$('#chatLog'); log.insertAdjacentHTML('beforeend',`<div class="bubble user"><span class="meta">Du</span>${esc(msg)}</div>`); const pending=document.createElement('div'); pending.className='bubble assistant'; pending.innerHTML='<span class="meta">Deep Agent · denkt …</span>'; log.appendChild(pending); log.scrollTop=log.scrollHeight; try{const out=await api(`/api/villas/${currentVilla.villa.id}/chat`,{method:'POST',body:{message:msg,agentId:currentAgentId}}); pending.innerHTML=`<span class="meta">Deep Agent · ${esc(out.route||'Offline-Planer')}</span>${esc(out.answer||out.error||'Keine Antwort.')}`;}catch(e){pending.innerHTML=`<span class="meta">Fehler</span>${esc(String(e))}`;}finally{btn.disabled=false;log.scrollTop=log.scrollHeight;await refreshCurrent();}}
async function refreshCurrent(){ if(!currentVilla)return; const data=await api(`/api/villas/${currentVilla.villa.id}`); if(data.error)return; currentVilla=data; renderAll(data); renderSuggestions(data); loadVillas(); }
async function startDevelopment(){ if(!currentVilla)return; $('#startBtn').disabled=true; await api(`/api/villas/${currentVilla.villa.id}/orchestrate`,{method:'POST',body:{concurrency:4,maxTasks:500,adaptive:true}}); await refreshCurrent(); }
async function stopDevelopment(){ if(!currentVilla)return; await api(`/api/villas/${currentVilla.villa.id}/stop`,{method:'POST'}); await refreshCurrent(); }
async function deleteVilla(){ if(!currentVilla)return; if(!confirm(`Villa "${currentVilla.villa.name}" mitsamt allen Daten loeschen?`))return; const out=await api(`/api/villas/${currentVilla.villa.id}`,{method:'DELETE'}); if(out.error){alert(out.error);return;} closeWorkspace(); loadVillas(); }
async function exportVilla(){ if(!currentVilla)return; const id=currentVilla.villa.id; const res=await fetch(`/api/villas/${id}/export`,{headers:getToken()?{Authorization:`Bearer ${getToken()}`}:{}}); if(!res.ok){alert('Export fehlgeschlagen (HTTP '+res.status+')');return;} const blob=await res.blob(); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`villa-${id}.json`; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),4000); }
async function loadRoutes(){const routes=await api('/api/routes'); if(!Array.isArray(routes))return; $('#routeList').innerHTML=routes.map(r=>`<div class="row"><div class="head"><b>${esc(r.name)}</b><span class="badge ${r.hasKey||r.provider==='offline'?'RUNNING':'PAUSED'}">${r.provider==='offline'?'offline':r.hasKey?'Key vorhanden':'kein Key'}</span></div><div class="sub">${esc(r.provider)} · ${esc(r.model)} · Prio ${esc(r.priority)} · ok ${esc(r.ok)} / fail ${esc(r.fail)}</div><button data-toggle="${r.id}" data-enabled="${r.enabled}" class="compact">${r.enabled?'Deaktivieren':'Aktivieren'}</button></div>`).join(''); document.querySelectorAll('[data-toggle]').forEach(b=>b.addEventListener('click',async()=>{await api(`/api/routes/${b.dataset.toggle}`,{method:'PATCH',body:{enabled:b.dataset.enabled!=='1'}});loadRoutes();}));}
async function addRoute(){await api('/api/routes',{method:'POST',body:{name:$('#rName').value.trim()||'Route',provider:$('#rProvider').value.trim()||'openai-compatible',baseUrl:$('#rUrl').value.trim(),model:$('#rModel').value.trim(),keyEnv:$('#rKeyEnv').value.trim(),priority:Number($('#rPrio').value)||10}});loadRoutes();}
async function loadSecrets(){const list=await api('/api/secrets');$('#secretList').innerHTML=Array.isArray(list)&&list.length?list.map(s=>`<div class="row"><b>${esc(s.name)}</b> <span class="badge RUNNING">gesetzt</span></div>`).join(''):'<p class="hint">Noch kein Key hinterlegt. Der Offline-Planer bleibt verfügbar.</p>';}
async function addSecret(){const name=$('#sName').value.trim(),value=$('#sValue').value;if(!name||!value)return;await api('/api/secrets',{method:'POST',body:{name,value}});$('#sValue').value='';loadSecrets();loadRoutes();}
function selectTab(tab){document.querySelectorAll('.side-tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===tab));document.querySelectorAll('.workspace-main .tabpane').forEach(p=>p.classList.toggle('active',p.dataset.pane===tab));}
function saveToken(){ setToken($('#tokenInput').value.trim()); $('#tokenInput').value=''; loadRoutes(); loadSecrets(); connectEvents(); checkHealth(); }
function connectEvents(){
  const t=getToken();
  const es=new EventSource(t ? `/api/events?token=${encodeURIComponent(t)}` : '/api/events');
  // Nur Statusaenderungen loesen einen Refresh aus;Schwellwertereignisse
  // (task/chat/tool) werden gebuendelt, damit ein Lauf die API nicht flutet.
  let refreshTimer=null;
  es.onmessage=(ev)=>{
    let e={}; try{e=JSON.parse(ev.data)}catch{}
    if(!['villa','progress','report'].includes(e.type)) return;
    if(refreshTimer) return;
    refreshTimer=setTimeout(()=>{refreshTimer=null;loadVillas();if(currentVilla)refreshCurrent();},900);
  };
}

async function importVillaFile(){ const file=$('#importFile').files[0]; if(!file)return; try{ const payload=JSON.parse(await file.text()); if(!payload||!payload.villa)throw new Error('Kein Villa-Export (villa-Objekt fehlt)'); const out=await api('/api/villas/import',{method:'POST',body:payload}); if(out.error){alert('Import fehlgeschlagen: '+out.error);return;} await loadVillas(); openVilla(out.villaId); }catch(e){ alert('Import fehlgeschlagen: '+String(e.message||e)); } finally{ $('#importFile').value=''; } }
async function editVilla(){ if(!currentVilla)return; const v=currentVilla.villa; const name=prompt('Neuer Name:',v.name); if(name===null)return; const idea=prompt('Neue Idee:',v.idea); if(idea===null)return; const patch={}; if(name.trim()&&name!==v.name)patch.name=name.trim(); if(idea.trim()&&idea!==v.idea)patch.idea=idea.trim(); if(!Object.keys(patch).length)return; const out=await api(`/api/villas/${v.id}`,{method:'PATCH',body:patch}); if(out.error){alert('Speichern fehlgeschlagen: '+out.error);return;} await refreshCurrent(); loadVillas(); }
$('#taskFilter').addEventListener('change',()=>currentVilla&&renderTasks(currentVilla.tasks));
$('#createBtn').addEventListener('click',createVilla); $('#heroCreateBtn').addEventListener('click',()=>{ $('#createSection').scrollIntoView({behavior:'smooth'}); setTimeout(()=>$('#idea').focus(),350); }); $('#refreshBtn').addEventListener('click',loadVillas); $('#openLatestBtn').addEventListener('click',()=>latestVillas[0]&&openVilla(latestVillas[0].id)); $('#closeDetail').addEventListener('click',closeWorkspace); $('#deleteBtn').addEventListener('click',deleteVilla); $('#exportBtn').addEventListener('click',exportVilla); $('#importBtn').addEventListener('click',()=>$('#importFile').click()); $('#importFile').addEventListener('change',importVillaFile); $('#editBtn').addEventListener('click',editVilla); $('#startBtn').addEventListener('click',startDevelopment); $('#stopBtn').addEventListener('click',stopDevelopment); $('#sendBtn').addEventListener('click',sendChat); $('#chatMsg').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat();}}); $('#addRouteBtn').addEventListener('click',addRoute); $('#addSecretBtn').addEventListener('click',addSecret); $('#saveTokenBtn').addEventListener('click',saveToken); document.querySelectorAll('.side-tab').forEach(t=>t.addEventListener('click',()=>selectTab(t.dataset.tab))); document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#detailPanel').hidden)closeWorkspace();});
checkHealth();loadVillas();loadRoutes();loadSecrets();connectEvents();setInterval(checkHealth,20000);
