#!/usr/bin/env node
import {db} from '../db.mjs';
import {maturity} from '../product.mjs';
import {ensureVerificationTasks,verifyProjectRuntime} from '../project-verification.mjs';
const ids=process.argv.slice(2).filter(a=>/^\d+$/.test(a)).map(Number);
if(!ids.length){console.error('Specify explicit villa IDs, e.g. node server/scripts/check-readiness.mjs 1 2 3 [--apply] [--verify]');process.exit(2);}
for(const id of ids){
 if(!db.prepare('SELECT id FROM villas WHERE id=?').get(id))continue;
 if(process.argv.includes('--apply'))ensureVerificationTasks(id);
 if(process.argv.includes('--verify'))await verifyProjectRuntime(id);
 console.log(JSON.stringify({id,...maturity(id)}));
}
