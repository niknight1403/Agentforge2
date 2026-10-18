/* Project studio: model-backed design choices, evidence-based next steps and an isolated UI preview. */
(()=>{
const el=s=>document.querySelector(s),safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let villaId=null,state=null,session=null,revision='',timer=null,loading=false;
const msg=(text,error=false)=>{el('#studioMessage').textContent=text;el('#studioMessage').style.color=error?'#ff9bab':'var(--muted)';};
function render(){
 el('#studioTitle').textContent=state.villa.name;
 const m=state.maturity;
 el('#studioEvidence').textContent=`${m.score}/100 · ${m.verified?'Technisch verifiziert':'Abnahme offen'} · Aufgabenplan ${m.planScore}/100`;
 el('#studioBlockers').innerHTML=m.blockers.map(b=>`<li>${safe(b)}</li>`).join('')||'<li>Build, Tests und Nutzerfluss am aktuellen Quellstand bestanden.</li>';
 el('#studioSteps').innerHTML=state.nextSteps.map((s,i)=>`<button class="studio-step" data-step="${i}"><strong>${safe(s.title)}</strong><small>${safe(s.reason)}</small></button>`).join('')||'<p>Keine offene Aufgabe. Formuliere die nächste konkrete Produktverbesserung.</p>';
 el('#studioSteps').querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>{el('#studioFeedback').value=state.nextSteps[Number(b.dataset.step)].prompt;el('#studioFeedback').focus();});
 const d=state.design;
 el('#studioDesigns').innerHTML=d?d.variants.map((v,i)=>`<article class="studio-design"><div class="studio-mock" style="--mock-bg:${v.palette.background};--mock-surface:${v.palette.surface};--mock-text:${v.palette.text};--mock-accent:${v.palette.accent}"><small>DESIGNENTWURF · ${safe(v.name)}</small><h3>${safe(v.layout[0])}</h3><div>${v.layout.slice(1).map(x=>`<p>${safe(x)}</p>`).join('')}</div><span class="studio-mock-action">${safe(v.flow[0])}</span></div><h3>${safe(v.name)}</h3><p>${safe(v.reason)}</p><ul>${v.acceptance.map(a=>`<li>${safe(a)}</li>`).join('')}</ul><button class="primary" data-design="${i}" ${d.selected===i?'disabled':''}>${d.selected===i?'Als Vorgabe gespeichert':'Diese Richtung wählen'}</button></article>`).join(''):'<p>Fordere zwei Designrichtungen für deine konkrete Idee an. Sie werden als Entwürfe gezeigt und erst nach deiner Wahl als Vorgabe gespeichert.</p>';
 el('#studioDesigns').querySelectorAll('[data-design]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{const out=await api(`/api/studio/villas/${villaId}/design-selection`,{method:'POST',body:{designId:d.id,index:Number(b.dataset.design)}});if(out.error)throw Error(out.error);msg(out.note);await refresh();}catch(e){msg(e.message,true);b.disabled=false;}});
}
async function refresh(){
 if(!villaId||loading)return;loading=true;
 try{
  const out=await api(`/api/studio/villas/${villaId}`);if(out.error)throw Error(out.error);state=out;render();
  if(out.preview.type!=='web'){el('#studioPreviewHint').textContent=out.preview.hint;el('#studioPreview').hidden=true;return;}
  el('#studioPreviewHint').textContent='UI-Vorschau des erzeugten Web-Builds. Der Abnahmestatus oben bewertet zusätzlich Build, Tests und Nutzerfluss. Vorschau-Verbindungen zur Hub-Verwaltung sind isoliert.';
  if(!session||session.expiresAt<Date.now()+30000){session=await api(`/api/studio/villas/${villaId}/preview-session`,{method:'POST',body:{}});if(session.error)throw Error(session.error);revision='';}
  if(session.available&&el('#studioLive').checked&&revision!==out.revision){el('#studioPreview').src=session.path+'?revision='+encodeURIComponent(out.revision||'initial');el('#studioPreview').hidden=false;revision=out.revision;}
 }catch(e){msg(e.message||String(e),true);}finally{loading=false;}
}
async function open(){if(!currentVilla?.villa?.id)return;villaId=currentVilla.villa.id;session=null;revision='';el('#studioDialog').showModal();await refresh();timer=setInterval(()=>{if(el('#studioLive').checked)refresh();},3000);}
el('#studioOpenBtn').onclick=open;
el('#studioCloseBtn').onclick=()=>el('#studioDialog').close();
el('#studioDialog').addEventListener('close',()=>{clearInterval(timer);timer=null;el('#studioPreview').removeAttribute('src');villaId=null;session=null;});
el('#studioRefresh').onclick=()=>{revision='';refresh();};
el('#studioLive').onchange=()=>{if(el('#studioLive').checked)refresh();};
el('#studioGenerate').onclick=async()=>{
 const b=el('#studioGenerate');b.disabled=true;msg('Zwei passende Designrichtungen werden vom Modell ausgearbeitet …');
 try{const out=await api(`/api/studio/villas/${villaId}/designs`,{method:'POST',body:{}});if(out.error)throw Error(out.error);await refresh();msg('Entwürfe bereit. Wähle eine Richtung oder gib Änderungswünsche an.');}catch(e){msg(e.message,true);}finally{b.disabled=false;}
};
el('#studioFeedbackForm').onsubmit=async e=>{
 e.preventDefault();const text=el('#studioFeedback').value.trim();if(!text)return;const b=el('#studioSend');b.disabled=true;msg('Deep Agent bearbeitet deinen konkreten Änderungsauftrag …');
 try{const out=await api(`/api/villas/${villaId}/chat`,{method:'POST',body:{message:text}});if(out.error)throw Error(out.error);el('#studioFeedbackResult').textContent=out.answer||'Keine Modellantwort.';el('#studioFeedback').value='';await refresh();}catch(e){msg(e.message,true);}finally{b.disabled=false;}
};
})();
