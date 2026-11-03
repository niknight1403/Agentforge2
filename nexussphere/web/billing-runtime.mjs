import{JsonStore}from"./store.mjs";import{verifyStripeSignature}from"./billing.mjs";
const ALLOWED_EVENTS=new Set(["customer.subscription.created","customer.subscription.updated","customer.subscription.deleted"]);
const MAX_EVENTS=1000;
export class BillingRuntime{
 constructor({store=new JsonStore(process.env.NEXUSSPHERE_BILLING_PATH||"./data/billing.json"),pricePlans={}}={}){this.store=store;this.pricePlans={...pricePlans};this.state={events:[],subscriptions:{}};this.write=Promise.resolve()}
 async init(){this.state=await this.store.load({events:[],subscriptions:{}});return this}
 async apply(input){const run=()=>this.#apply(input);const result=this.write.then(run,run);this.write=result.then(()=>undefined,()=>undefined);return result}
 async #apply({secret,rawBody,signature,now}){
  if(!verifyStripeSignature({secret,rawBody,signature,now}))throw Object.assign(Error("INVALID_STRIPE_SIGNATURE"),{status:400});
  let event;try{event=JSON.parse(rawBody)}catch{throw Object.assign(Error("INVALID_STRIPE_PAYLOAD"),{status:400})}
  if(!event?.id)throw Object.assign(Error("EVENT_ID_REQUIRED"),{status:400});
  if(this.state.events.includes(event.id))return{duplicate:true,eventId:event.id};
  if(!ALLOWED_EVENTS.has(event.type))return{ignored:true,eventId:event.id};
  const o=event.data?.object;
  if(o?.object!=="subscription"||!o.id)return{ignored:true,eventId:event.id};
  const priceId=o.items?.data?.[0]?.price?.id||null,plan=priceId?this.pricePlans[priceId]||null:null;
  this.state.subscriptions[o.id]={id:o.id,status:event.type==="customer.subscription.deleted"?"canceled":o.status||"unknown",customer:o.customer||null,plan,priceId,productId:o.items?.data?.[0]?.price?.product||null};
  this.state.events.push(event.id);if(this.state.events.length>MAX_EVENTS)this.state.events.splice(0,this.state.events.length-MAX_EVENTS);
  await this.store.save(this.state);return{duplicate:false,eventId:event.id}
 }
 snapshot(){return structuredClone(this.state)}
}
