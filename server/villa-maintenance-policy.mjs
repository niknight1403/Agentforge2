const BLOCKED_STATES=new Set(['PAUSED','STOPPING','ARCHIVED','COMPLETED']);

/** Maintenance may continue only for a Villa whose owner already enabled autonomy. */
export function mayRunVillaMaintenance(villa){
 if(!villa||Number(villa.autonomy)!==1)return false;
 return !BLOCKED_STATES.has(String(villa.status||'').toUpperCase());
}

export function runnableMaintenanceVillas(villas=[]){
 return villas.filter(mayRunVillaMaintenance);
}
