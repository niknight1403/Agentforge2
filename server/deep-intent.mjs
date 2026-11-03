export function classifyDeepDevelopmentIntent(prompt,{projectCreation=false}={}) {
 const text=String(prompt||'').trim();
 if(text.length<10 || /\?\s*$/.test(text))return {action:'CHAT_ONLY'};
 if(/\b(nicht bauen|nicht entwickeln|nicht erstellen|nur erklaeren|nur diskutieren)\b/i.test(text))return {action:'CHAT_ONLY'};
 const product=/\b(app|apk|software|webseite|website|video|bild|audio|musik|projekt|plattform|tool|studio)\b/i.test(text);
 const command=/\b(erstelle|entwickle|implementiere|programmiere|baue|generiere|produziere|create|build|develop)\b/i.test(text);
 const projectIdea=projectCreation && /^(ein|eine|einen|mein|meine|neue|neues)\b/i.test(text);
 return {action:product&&(command||projectIdea)?'AUTO_BUILD':'CHAT_ONLY'};
}
