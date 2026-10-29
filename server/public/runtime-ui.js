/* Shared, side-effect-free presentation rules for real runtime evidence. */
(function (root) {
  const count = value => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
  function summarizeHealth(health, at = Date.now()) {
    if (health?.ok !== true) return {state:'offline',label:'Hub offline',detail:'Verbindung prüfen und erneut laden.',active:0,waiting:0};
    const llm=health.llm || {}, active=count(llm.queue?.active), waiting=count(llm.queue?.waiting);
    const verified=count(llm.lastSuccessfulReplyAt), recent=verified>0 && at>=verified && at-verified<300000;
    const eligible=count(llm.eligibleRoutes), configured=count(llm.configuredRoutes);
    if(recent && eligible>0)return {state:'ready',label:'Modellantwort bestätigt',detail:`${llm.lastSuccessfulRoute || 'KI-Route'} · zuletzt ${new Date(verified).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}. Produktabnahmen werden separat geprüft.`,active,waiting};
    if(active || waiting)return {state:'busy',label:'KI-Anfragen laufen',detail:`${active} Modellanfragen aktiv, ${waiting} warten. Noch keine aktuelle Modellantwort bestätigt.`,active,waiting};
    if(!eligible)return {state:'blocked',label:'Modellzugriff nicht bereit',detail:`${configured} Routen konfiguriert. Schlüssel, Providerquoten oder Cooldowns prüfen.`,active,waiting};
    return {state:'unverified',label:'Modellantwort noch ungeprüft',detail:`${eligible} Routen freigegeben. Freigabe bedeutet noch keine erfolgreiche Modellantwort.`,active,waiting};
  }
  function chooseVilla(villas,selectedId,focusId) {
    return villas.find(v=>Number(v.id)===Number(selectedId)) || villas.find(v=>Number(v.id)===Number(focusId)) || villas.find(v=>v.status==='RUNNING') || villas[0] || null;
  }
  root.VFRuntimeUI = Object.freeze({summarizeHealth,chooseVilla});
})(globalThis);
