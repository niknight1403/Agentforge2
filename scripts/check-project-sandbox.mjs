import {projectSandboxPreflight} from '../server/project-sandbox-preflight.mjs';

const result=projectSandboxPreflight();
console.log(JSON.stringify(result,null,2));
process.exitCode=result.ready?0:1;
