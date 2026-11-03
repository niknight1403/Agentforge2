import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanTitle,addTask,toggleTask,removeTask,loadTasks,saveTasks,validateTasks} from '../www/model.mjs';
test('new task persists and survives reopening',()=>{
 const memory=new Map();const storage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v)};
 const tasks=saveTasks(storage,addTask([],'  Tests schreiben  ',111));
 assert.equal(tasks[0].title,'Tests schreiben');
 assert.deepEqual(loadTasks(storage),tasks);
});
test('complete and delete tasks',()=>{
 const tasks=addTask([],'Build prüfen',222);
 assert.equal(toggleTask(tasks,222)[0].done,true);
 assert.equal(removeTask(tasks,222).length,0);
});
test('reject empty or oversized task strings',()=>{
 assert.throws(()=>cleanTitle('   '));
 assert.throws(()=>addTask([],'x'.repeat(121)));
});
test('invalid persisted data fails closed and prototype fragments are ignored',()=>{
 assert.deepEqual(validateTasks({}),[]);
 assert.deepEqual(validateTasks([{id:1,title:'ok',done:false},{id:'2',title:'bad',done:false}]),[{id:1,title:'ok',done:false}]);
 assert.deepEqual(loadTasks({getItem:()=>'{broken json'}),[]);
});
