export class HubRouteAdapter{
  constructor({baseUrl,token,fetchImpl=fetch}){if(!baseUrl)throw Error("HUB_URL_REQUIRED");this.baseUrl=baseUrl.replace(/\/$/,"");this.token=token;this.fetch=fetchImpl}
  async status(){const r=await this.fetch(this.baseUrl+"/api/free-routes",{headers:{accept:"application/json",...(this.token?{authorization:"Bearer "+this.token}:{})}});if(!r.ok)throw Object.assign(Error("HUB_FREE_ROUTES_"+r.status),{status:r.status});return r.json()}
  async hunterStatus(){const r=await this.fetch(this.baseUrl+"/api/free-routes/hunter",{headers:{accept:"application/json",...(this.token?{authorization:"Bearer "+this.token}:{})}});if(!r.ok)throw Object.assign(Error("HUB_HUNTER_"+r.status),{status:r.status});return r.json()}
  async freeRoutes(){const data=await this.status();const routes=Array.isArray(data)?data:(data.routes||[]);return routes.filter(x=>x.enabled!==false&&x.available!==false).map(x=>({id:x.id,name:x.name,provider:x.provider,model:x.model,priority:Number(x.priority)||50,enabled:true,free:true,status:x.status,successes:x.successes||0,failures:x.failures||0,cooldownUntil:x.cooldownUntil||0,baseUrl:x.base_url||x.baseUrl||null}))}
}
