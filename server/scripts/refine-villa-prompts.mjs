import {refineVillaPrompts} from '../prompt-refinement.mjs';
const report=await refineVillaPrompts({refresh:process.argv.includes('--refresh'),signal:AbortSignal.timeout(210000)});
console.log(JSON.stringify({schemaVersion:1,proposalOnly:true,results:report}));
if(report.some(v=>v.status==='blocked'))process.exitCode=1;
