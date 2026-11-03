/**
 * Deterministic task brief for DeepAgent -> Villa handover.
 * This is a capability request, not a claim that a renderer/build tool is installed.
 */
const PROFILES = Object.freeze([
  {id:'live-performance',pattern:/\b(?:live.performance|live.performance.studio|ableton|midi|launchpad|dj|latency|latenz)\b/i,tools:['audio-engine','midi-adapter','latency-benchmark'],artifact:'runnable-live-demo',verify:'Interaktive Session mit nachgewiesener Latenz, Start/Stop und Fehlerbehandlung'},
  {id:'video',pattern:/\b(?:video|film|schnitt|render|animation|reel|clip)\b/i,tools:['media-probe','video-renderer','codec-check'],artifact:'playable-video',verify:'Datei dekodierbar; Dauer, Bildgroesse und Tonspur kontrolliert'},
  {id:'audio',pattern:/\b(?:audio|musik|song|stimme|vocals|ton|podcast|sound)\b/i,tools:['audio-renderer','waveform-analyzer','codec-check'],artifact:'playable-audio',verify:'Audio dekodierbar; Sample-Rate, Dauer und Lautstaerke kontrolliert'},
  {id:'image',pattern:/\b(?:bild|foto|grafik|thumbnail|illustration|image)\b/i,tools:['image-renderer','image-inspector'],artifact:'image-file',verify:'Bilddatei vorhanden, Format und Abmessungen geprueft'},
  {id:'android',pattern:/\b(?:android|apk|flutter|handy.app|mobile.app)\b/i,tools:['android-build','device-smoke','ui-audit'],artifact:'installable-apk',verify:'APK-Build, Installations-Smoke-Test, Bedienbarkeit und Download-Nachweis'},
  {id:'web',pattern:/\b(?:web|website|browser|landingpage|web.build|frontend)\b/i,tools:['web-build','browser-smoke','accessibility-audit'],artifact:'deployable-web-build',verify:'Produktionsbuild, HTTP-Smoke-Test und mobil nutzbare Browseransicht'}
]);
const FALLBACK={id:'software',tools:['project-scaffold','unit-tests','integration-smoke'],artifact:'runnable-product',verify:'Reproduzierbarer Startbefehl, Tests und nachvollziehbarer Nutzerfluss'};
export function deepMissionProfile(idea) {
 const clean=String(idea||'').slice(0,9000);
 const matches=PROFILES.filter(p=>p.pattern.test(clean));
 const primary=matches[0]||FALLBACK;
 return {
  primary:primary.id,
  formats:[...new Set((matches.length?matches:[primary]).map(p=>p.artifact))],
  capabilities:[...new Set((matches.length?matches:[primary]).flatMap(p=>p.tools))],
  acceptance:[...new Set((matches.length?matches:[primary]).map(p=>p.verify))],
  lifecycle:['ANALYZE','SPECIFY','IMPLEMENT','TEST','REVIEW','BUILD','VERIFY','DELIVER'],
  qualityRules:[
   'Nur echte Dateien, Builds und Testergebnisse als abgeschlossen melden.',
   'Fehlende Werkzeuge zuerst im Sandbox-Projekt pruefen; keinen ungeprueften Hub-Code installieren.',
   'Alternative Loesungen nur mit gesondertem Nutzernutzen und belegter Qualitaet uebernehmen.',
   'Secrets nie in Prompts, Logs oder Artefakte schreiben.',
   'Keine erfundenen Links, Medien-Dateien, APKs oder Testergebnisse.'
  ]
 };
}
export function deepMissionBrief(idea) {
 const p=deepMissionProfile(idea);
 return [
  'DEEPAGENT-UEBERGABEVERTRAG (automatisch klassifiziert):',
  'Primaeres Profil: '+p.primary,
  'Ausgabeformate: '+p.formats.join(', '),
  'Benötigte Fähigkeiten (nicht automatisch als installiert betrachten): '+p.capabilities.join(', '),
  'Lebenszyklus: '+p.lifecycle.join(' -> '),
  'Abnahme: '+p.acceptance.join('; '),
  'Qualitaetsregeln: '+p.qualityRules.join(' ')
 ].join('\n');
}
