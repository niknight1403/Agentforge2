/** Product-output contract. Packaging source is not the requested APK/media deliverable. */
import {deepMissionProfile} from './deep-mission.mjs';

const mediaOutput=Object.freeze({
 'playable-video': ['.mp4','.webm'],
 'playable-audio': ['.mp3','.wav','.ogg','.m4a','.flac'],
 'image-file': ['.png','.jpg','.jpeg','.webp','.svg']
});
export function artifactContract({idea='',kind='',artifactName='',artifactType='',deliverable=''}={}){
 const profile=deepMissionProfile(idea);
 // Medienformate sind nur Lieferzwang, wenn das Produkt selbst Medien ist.
 // Bei einem Software-Auftrag sind Woerter wie "Audio-Optimierung" oder
 // "Video-Tutorial" beschreibend: ein fertig gebautes und geprueftes Projekt
 // darf nicht daran scheitern (Villa 10: REQUIRED_ARTIFACT_MISSING playable-audio/video).
 // Ist eine Medienklasse bestimmt, zaehlt genau deren Format: ein Video-Produkt
 // braucht ein Video, nicht zusaetzlich die Tonspur, die die Idee nur erwaehnt.
 const deliverableFormat={'video':'playable-video','audio':'playable-audio','image':'image-file'}[deliverable];
 let required=deliverable==='software'?[]:profile.formats.filter(format=>format==='installable-apk'||Object.hasOwn(mediaOutput,format));
 if(deliverableFormat)required=required.includes(deliverableFormat)?[deliverableFormat]:[];
 // Source-backed Android projects must also yield APK rather than a ZIP fallback,
 // even where the idea has no explicit "Android" keyword.
 if(['android','android-cloud'].includes(kind)&&!required.includes('installable-apk'))required.push('installable-apk');
 const name=String(artifactName).toLowerCase();
 const missing=[];
 for(const format of required){
  if(format==='installable-apk'){
   if(artifactType!=='apk'||!name.endsWith('.apk'))missing.push(format);
  }else if(!mediaOutput[format].some(ext=>name.endsWith(ext)))missing.push(format);
 }
 return {ok:missing.length===0,expected:required,actual:artifactType||'none',
  blockers:missing.map(format=>'REQUIRED_ARTIFACT_MISSING:'+format)};
}
