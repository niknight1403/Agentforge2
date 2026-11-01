import os from 'node:os';
import {readFileSync} from 'node:fs';
/** Linux reclaimable cache is available capacity, not an allocation failure. */
export function availableMemory(total,{read=()=>readFileSync('/proc/meminfo','utf8'),fallback=()=>os.freemem()}={}){
 const cap=Math.max(0,Number(total)||0);
 try{
  const match=/^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(read());
  if(match){const bytes=Number(match[1])*1024;if(Number.isSafeInteger(bytes))return Math.min(cap,Math.max(0,bytes));}
 }catch{}
 const value=Number(fallback());
 return Number.isFinite(value)?Math.min(cap,Math.max(0,value)):0;
}
