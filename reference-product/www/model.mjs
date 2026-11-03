/** Offline task model, shared by the Android WebView and Node tests. */
export function cleanTitle(value) {
  const text=String(value??'').trim().replace(/\s+/g,' ');
  if(!text||text.length>120)throw Error('Bitte eine Aufgabe mit höchstens 120 Zeichen eingeben.');
  return text;
}
export function validateTasks(value){
  if(!Array.isArray(value))return [];
  return value.slice(0,500).filter(t=>t&&Number.isSafeInteger(t.id)&&t.id>0&&typeof t.title==='string'&&t.title.trim().length>0&&t.title.length<=120&&typeof t.done==='boolean')
    .map(t=>({id:t.id,title:t.title,done:t.done}));
}
export function addTask(tasks,title,id=Date.now()){
  if(!Number.isSafeInteger(id)||id<1)throw Error('Ungültige ID');
  const items=validateTasks(tasks);
  if(items.length>=500)throw Error('Maximal 500 Aufgaben');
  return [{id,title:cleanTitle(title),done:false},...items.filter(t=>t.id!==id)];
}
export function toggleTask(tasks,id){
 return validateTasks(tasks).map(t=>t.id===id?{...t,done:!t.done}:t);
}
export function removeTask(tasks,id){
 return validateTasks(tasks).filter(t=>t.id!==id);
}
export function loadTasks(storage){
 try{return validateTasks(JSON.parse(storage.getItem('villa-tasks-v1')||'[]'));}catch{return [];}
}
export function saveTasks(storage,tasks){
 const data=validateTasks(tasks);
 storage.setItem('villa-tasks-v1',JSON.stringify(data));
 return data;
}
