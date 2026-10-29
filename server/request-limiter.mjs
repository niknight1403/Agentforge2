/** Credential-scoped sliding window with one interactive reservation, no quota increase. */
export function createRequestLimiter({clock=Date.now,windowMs=60000}={}){
 const windows=new Map();
 return {admit(key,limit,{interactive=false}={}){
  const time=clock();for(const [k,list] of windows)if(!list.length||list.at(-1)<=time-windowMs)windows.delete(k);
  const cap=Number.isFinite(Number(limit))?Math.max(1,Math.floor(Number(limit))):1;
  const list=(windows.get(key)||[]).filter(t=>t>time-windowMs);windows.set(key,list);
  const allowed=interactive?cap:Math.max(1,cap-1);
  if(list.length>=allowed)return {ok:false,retryAfterMs:Math.max(1,list[0]+windowMs-time)};
  list.push(time);return {ok:true,retryAfterMs:0};
 },size:()=>windows.size};
}
