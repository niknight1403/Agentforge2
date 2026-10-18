// Webhook-Gateway-Tests: Stripe-Signatur, Digistore24-Signatur, Universal-Auth,
// Idempotenz (Fallback-Modus), Slack-Block-Bau. Alles deterministisch ohne Netz.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'vf-wh-')), 'test.db');
delete process.env.REDIS_URL;                         // deterministischer Fallback-Pfad
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.DIGISTORE24_PASSPHRASE;
delete process.env.WEBHOOK_API_KEYS;
delete process.env.WEBHOOK_INTERNAL_TOKEN;
delete process.env.SLACK_WEBHOOK_URL;

const {
  verifyStripeSignature, verifyDigistore24Signature,
  authorizeUniversalRequest, claimEventId,
  slackSaleBlocks, slackSystemBlocks, gatewayStatus,
  initWebhookStore
} = await import('../webhooks.mjs');
const { db } = await import('../db.mjs');
initWebhookStore();

const SECRET = 'whsec_test_123';
function stripeSig(body, secret = SECRET, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

test('Stripe: gueltige Signatur wird akzeptiert', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: {} } });
  const r = verifyStripeSignature(body, stripeSig(body), SECRET);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('Stripe: manipulierter Body wird abgewiesen', () => {
  const body = '{"id":"evt_1"}';
  const r = verifyStripeSignature(body, stripeSig('{"id":"evt_0"}'), SECRET);
  assert.equal(r.ok, false);
  assert.match(r.error, /Signatur/);
});

test('Stripe: Zeitstempel aelter als Toleranz wird abgewiesen (Replay-Schutz)', () => {
  const body = '{}';
  const alt = Math.floor(Date.now() / 1000) - 3_600;
  const r = verifyStripeSignature(body, stripeSig(body, SECRET, alt), SECRET, 300);
  assert.equal(r.ok, false);
  assert.match(r.error, /zu alt/);
});

test('Stripe: fehlendes Secret konfiguriert -> klarer Fehler statt stiller Durchlauf', () => {
  const r = verifyStripeSignature('{}', 't=1,v1=aa', undefined);
  assert.equal(r.ok, false);
  assert.match(r.error, /STRIPE_WEBHOOK_SECRET/);
});

test('Digistore24: Standardkonkatenation (Passphrase + customer_email + transaction_id + item_id + etrigger)', () => {
  const passphrase = 'ds24-pass';
  const params = {
    customer_email: 'kunde@example.com', transaction_id: 'TX-9',
    item_id: '4711', etrigger: 'payment'
  };
  const material = passphrase + params.customer_email + params.transaction_id + params.item_id + params.etrigger;
  params.sha256_signature = createHash('sha256').update(material).digest('hex');
  const r = verifyDigistore24Signature(params, passphrase);
  assert.equal(r.ok, true, JSON.stringify(r));
  // Abweichende Feldliste via drittes Argument bleibt konfigurierbar und real:
  const material2 = params.transaction_id + params.item_id;
  params.sha256_signature = createHash('sha256').update(material2).digest('hex');
  const r2 = verifyDigistore24Signature(params, passphrase, 'transaction_id,item_id');
  assert.equal(r2.ok, true);
});

test('Digistore24: falsche Passphrase/Signatur wird abgewiesen', () => {
  const params = { customer_email: 'a@b.c', transaction_id: 'T', item_id: 'I', etrigger: 'refund', sha256_signature: 'deadbeef'.repeat(8) };
  const r = verifyDigistore24Signature(params, 'correct-horse');
  assert.equal(r.ok, false);
  assert.match(r.error, /Signatur/);
});

test('Digistore24: ohne konfigurierte Passphrase -> klarer Fehler', () => {
  const r = verifyDigistore24Signature({ sha256_signature: 'ab' }, undefined);
  assert.equal(r.ok, false);
  assert.match(r.error, /DIGISTORE24_PASSPHRASE/);
});

test('Universal: gueltiger Bearer wird akzeptiert, falscher abgewiesen (Konstante-Zeit-Vergleich)', () => {
  process.env.WEBHOOK_API_KEYS = 'key-one,key-two';
  const reqOk = { headers: { authorization: 'Bearer key-two' } };
  const reqBad = { headers: { authorization: 'Bearer key-three' } };
  assert.equal(authorizeUniversalRequest(reqOk).ok, true);
  assert.equal(authorizeUniversalRequest(reqBad).ok, false);
  const reqXApi = { headers: { 'x-api-key': 'key-one' } };
  assert.equal(authorizeUniversalRequest(reqXApi).ok, true);
  const reqNone = { headers: {} };
  assert.equal(authorizeUniversalRequest(reqNone).ok, false);
  assert.match(authorizeUniversalRequest(reqNone).error, /Kein Bearer/);
  delete process.env.WEBHOOK_API_KEYS;
});

test('Idempotenz (Fallback ohne Redis): erste Claim gewinnt, zweite ist Duplikat', async () => {
  assert.equal(await claimEventId('test', 'evt-unique-1'), true);
  assert.equal(await claimEventId('test', 'evt-unique-1'), false);
  assert.equal(await claimEventId('test', 'evt-unique-2'), true, 'andere IDs bleiben frei');
});

test('Slack Blocks: Verkauf- und System-Alerts sind wohlgeformte Block-Kit-Strukturen', () => {
  const sale = slackSaleBlocks({ title: 'Verkauf', product: 'P', email: 'e@x.de', amount: '9.99', currency: 'EUR', source: 'Stripe', eventId: 'evt_1' });
  assert.equal(sale[0].type, 'header');
  assert.ok(sale[1].fields.length === 4);
  const sys = slackSystemBlocks({ title: 'Fehler', message: 'M', detail: 'D' });
  assert.equal(sys.length, 3);
  assert.equal(sys[1].text.text, 'M');
});

test('Gateway-Status meldet ehrlich, was konfiguriert ist', () => {
  const s = gatewayStatus();
  assert.equal(s.redis, 'in-memory-fallback');
  assert.equal(s.stripe, 'deaktiviert');
  assert.equal(s.slack, 'deaktiviert');
  assert.equal(s.universal, 'deaktiviert');
  assert.equal(s.digistore24, 'deaktiviert');
});

const { logWebhookEvent, markWebhookProcessed } = await import('../webhooks.mjs');

test('Webhook-Store: Events landen persistent, Statuswechsel auf PROCESSED', () => {
  const row1 = logWebhookEvent('stripe', 'evt-persist-1', { type: 'checkout.session.completed' });
  assert.ok(row1.id > 0);
  assert.equal(row1.status, 'RECEIVED');
  // Identisches (source, event_id) wird KEIN zweites Mal angelegt (Idempotenz-DB-Ebene)
  const row2 = logWebhookEvent('stripe', 'evt-persist-1', { type: 'checkout.session.completed' });
  assert.equal(row2.id, row1.id);
  markWebhookProcessed('stripe', 'evt-persist-1');
  const row3 = db.prepare('SELECT status, processed_at FROM webhook_events WHERE id = ?').get(row1.id);
  assert.equal(row3.status, 'PROCESSED');
  assert.ok(row3.processed_at > 0);
});
