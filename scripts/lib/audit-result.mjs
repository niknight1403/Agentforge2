export const REQUIRED_AUDIT_SCOPES=['desktop-dashboard','desktop','mobil-dashboard','mobil','mobil-360-dashboard','mobil-360','mobil-430-dashboard','mobil-430','reduzierteBewegung'];
/** No scopes means no inspection, never zero-defect success. */
export function auditResult(results,{error=null,maxFindings=0,requiredScopes=REQUIRED_AUDIT_SCOPES}={}){
 const missingScopes=requiredScopes.filter(name=>!results[name]);
 const total=Object.values(results).reduce((sum,r)=>sum+Object.values(r.findings||{}).reduce((n,list)=>n+(Array.isArray(list)?list.length:0),0),0);
 const status=error||missingScopes.length?'blocked':total>maxFindings?'failed':'passed';
 return {status,total,missingScopes,error:error?String(error.message||error).slice(0,800):null,exitCode:status==='passed'?0:1};
}
