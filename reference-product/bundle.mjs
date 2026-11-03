/** Bundle the two audited local scripts for file:// Android WebView execution.
 * No network, dynamic code, or external dependency required.
 */
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
const root=resolve(process.cwd(),'reference-product','www');
const model=readFileSync(join(root,'model.mjs'),'utf8');
const app=readFileSync(join(root,'app.mjs'),'utf8');
const imp=/^import\s+\{[^\n]+\}\s+from\s+['"]\.\/model\.mjs['"];?\s*\n/;
if(!imp.test(app))throw Error('Unrecognized model import; do not produce an incomplete bundle.');
const localModel=model.replace(/\bexport (?=(?:function|const|let|class)\b)/g,'');
if(/\b(?:export|import)\s/.test(localModel))throw Error('Model contains unsupported module syntax.');
const localApp=app.replace(imp,'');
if(/\b(?:export|import)\s/.test(localApp))throw Error('App contains unsupported module syntax.');
const bundled=['(function(){','"use strict";',localModel,localApp,'})();',''].join('\n');
const output=process.argv[2]||join(root,'app.bundle.js');
writeFileSync(output,bundled);
console.log('Offline WebView script bundled:',Buffer.byteLength(bundled),'bytes');
