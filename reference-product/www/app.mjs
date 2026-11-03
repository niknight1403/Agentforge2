import {addTask,toggleTask,removeTask,loadTasks,saveTasks} from './model.mjs';
const $=id=>document.getElementById(id);
const form=$('task-form'),input=$('task-input'),list=$('tasks'),counter=$('counter'),empty=$('empty'),feedback=$('feedback');
let tasks=loadTasks(localStorage);
let sequence=Math.max(Date.now(),...tasks.map(t=>t.id+1),1);
function render(){
 list.replaceChildren();
 counter.textContent='('+tasks.filter(t=>!t.done).length+' offen)';
 empty.hidden=tasks.length>0;
 for(const task of tasks){
  const li=document.createElement('li');if(task.done)li.className='done';
  const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=task.done;
  checkbox.setAttribute('aria-label','Erledigt: '+task.title);
  checkbox.addEventListener('change',()=>update(toggleTask(tasks,task.id)));
  const title=document.createElement('span');title.textContent=task.title;
  const del=document.createElement('button');del.type='button';del.className='secondary';del.textContent='Löschen';del.setAttribute('aria-label','Aufgabe löschen: '+task.title);
  del.addEventListener('click',()=>update(removeTask(tasks,task.id)));
  li.append(checkbox,title,del);list.appendChild(li);
 }
}
function update(next){
 try{tasks=saveTasks(localStorage,next);feedback.textContent='Lokal gespeichert.';render();}
 catch(error){feedback.textContent='Speichern fehlgeschlagen: '+String(error.message);}
}
form.addEventListener('submit',event=>{
 event.preventDefault();
 try{update(addTask(tasks,input.value,++sequence));input.value='';input.focus();}
 catch(error){feedback.textContent=String(error.message);}
});
render();
