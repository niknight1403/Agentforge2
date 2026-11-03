/** Product-output contract. Packaging source is not the requested APK/media deliverable. */
import {deepMissionProfile} from './deep-mission.mjs';

const mediaOutput=Object.freeze({
 'playable-video': ['.mp4','.webm'],
 'playable-audio': ['.mp3','.wav','.ogg','.m4a','.flac'],
 'image-file': ['.png','.jpg','.jpeg','.webp','.svg']
});
export function artifactContract({idea='',kind='',artifactName='',artifactType=''}={}){
 const profile=deepMissionProfile(idea);
 const required=profile.formats.filter(format=>format==='installable-apk'||Object.hasOwn(mediaOutput,format));
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
