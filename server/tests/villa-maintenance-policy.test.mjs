import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {mayRunVillaMaintenance,runnableMaintenanceVillas} from '../villa-maintenance-policy.mjs';

test('maintenance never starts a paused or explicitly disabled Villa',()=>{
 for(const villa of [
  {id:1,status:'PAUSED',autonomy:0},
  {id:2,status:'CREATED',autonomy:0},
  {id:3,status:'STOPPING',autonomy:1},
  {id:4,status:'ARCHIVED',autonomy:1},
  {id:5,status:'COMPLETED',autonomy:1}
 ])assert.equal(mayRunVillaMaintenance(villa),false);
});

test('maintenance retains only Villas already enabled by the owner',()=>{
 const villas=[
  {id:1,status:'PAUSED',autonomy:0},
  {id:2,status:'CREATED',autonomy:1},
  {id:3,status:'RUNNING',autonomy:1},
  {id:4,status:'WAITING_FOR_MODEL',autonomy:1}
 ];
 assert.deepEqual(runnableMaintenanceVillas(villas).map(v=>v.id),[2,3,4]);
});

test('production sweep applies the policy before inspection and before restart',()=>{
 const source=readFileSync(resolve(import.meta.dirname,'../../scripts/ops/villa-sweep.mjs'),'utf8');
 assert.ok(source.includes('runnableMaintenanceVillas(db.prepare(`'));
 assert.ok(source.includes('if (!mayRunVillaMaintenance(current))'));
 assert.ok(!source.includes('UPDATE villas SET autonomy=1'));
});
