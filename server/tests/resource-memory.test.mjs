import {test} from 'node:test';import assert from 'node:assert/strict';
import {availableMemory} from '../resource-memory.mjs';
test('Linux cache does not trigger false critical RAM pressure',()=>{
 const total=23972*1024*1024;
 const available=availableMemory(total,{read:()=> 'MemFree: 339968 kB\nMemAvailable: 3449856 kB\n',fallback:()=>332*1024*1024});
 const used=(total-available)/total;
 assert.ok(used<0.92);assert.ok(used>0.82);assert.equal(available,3449856*1024);
});
test('missing, malformed and unavailable proc data retain bounded portable fallback',()=>{
 for(const read of [()=>'',()=> 'MemAvailable: nope kB',()=>{throw Error('no proc');}])assert.equal(availableMemory(1000,{read,fallback:()=>250}),250);
 assert.equal(availableMemory(1000,{read:()=> 'MemAvailable: 9000 kB',fallback:()=>0}),1000);
 assert.equal(availableMemory(1000,{read:()=>'',fallback:()=>NaN}),0);
});
