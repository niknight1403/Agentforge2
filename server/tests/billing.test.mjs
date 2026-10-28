import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB=join(mkdtempSync(join(tmpdir(),'vf-billing-')),'test.db');
delete process.env.STRIPE_SECRET_KEY;
const {db}=await import('../db.mjs');
const {createUser}=await import('../auth.mjs');
const billing=await import('../billing.mjs');

test('Stripe subscription events grant and revoke paid entitlement idempotently',()=>{
  const user=createUser({email:'billing@example.test',password:'correct-horse-battery'});
  billing.initBillingStore();
  const active={id:'evt_sub_active',type:'customer.subscription.created',created:1_800_000_000,data:{object:{id:'sub_test',customer:'cus_test',status:'active',current_period_end:1_900_000_000,items:{data:[{price:{id:'price_pro'}}]},metadata:{user_id:String(user.id)}}}};
  assert.deepEqual(billing.applyStripeBillingEvent(active),{handled:true,updated:true});
  assert.equal(db.prepare('SELECT plan FROM users WHERE id=?').get(user.id).plan,'pro');
  assert.equal(db.prepare('SELECT token_budget FROM users WHERE id=?').get(user.id).token_budget,'5000000');
  const canceled={...active,id:'evt_sub_canceled',type:'customer.subscription.deleted',data:{object:{...active.data.object,status:'canceled'}}};
  billing.applyStripeBillingEvent(canceled);
  billing.applyStripeBillingEvent(canceled);
  assert.equal(db.prepare('SELECT plan FROM users WHERE id=?').get(user.id).plan,'free');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM billing_subscriptions WHERE stripe_subscription_id=?').get('sub_test').n,1);
});

test('Stripe event transactions are persisted once and metrics aggregate paid revenue',()=>{
  const user=createUser({email:'buyer@example.test',password:'correct-horse-battery'});
  const event={id:'evt_invoice_1',created:1_800_000_000,type:'invoice.paid',data:{object:{id:'in_test_1',customer:'cus_buyer',amount_paid:1299,currency:'eur',metadata:{user_id:String(user.id)}}}};
  billing.applyStripeBillingEvent(event);
  billing.applyStripeBillingEvent(event);
  const metrics=billing.adminBillingMetrics(30);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM billing_transactions WHERE stripe_object_id='in_test_1'").get().n,1);
  assert.equal(metrics.revenue.find(x=>x.currency==='eur').amount_minor,1299);
});

test('Stripe SDK remains safely disabled without a secret',()=>{
  assert.throws(()=>billing.getStripeClient(),error=>error.code==='STRIPE_NOT_CONFIGURED'&&error.statusCode===503);
});
