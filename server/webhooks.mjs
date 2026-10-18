/**
 * VillaForge Hub — Unified Webhook Gateway (Stripe, Digistore24, Slack, Universal)
 *
 * Zentrale, signaturgepruefte Einnahme- und Integrationsrouten unter
 * /api/v1/webhooks/... . Alle Handler sind:
 *   - authentifiziert (HMAC-SHA256 bzw. SHA256-Passphrase bzw. Bearer-Token)
 *   - idempotent (verarbeitete Event-IDs werden per Redis SET NX EX
 *     gespeichert; ohne REDIS_URL greift ein In-Process-Fallback mit TTL)
 *   - asynchron entkoppelt (Verarbeitung via Event-Bus, Antwort an den
 *     Absender erfolgt sofort mit Empfangsquittung)
 *
 * Secrets kommen ausschliesslich aus ENV/.env bzw. der secrets-Tabelle,
 * niemals aus dem Code.
 */
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { emit } from './events.mjs';
import { db } from './db.mjs';
import { redisTrySetNx, redisAvailable } from './redis.mjs';

// ── Persistenz: jedes eingehende Event wird revisionssicher geloggt ──
export function initWebhookStore() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      event_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'RECEIVED',
      payload TEXT NOT NULL DEFAULT '{}',
      received_at INTEGER NOT NULL,
      processed_at INTEGER,
      UNIQUE(source, event_id)
    );
  `);
}

export function logWebhookEvent(source, eventId, payload) {
  db.prepare(
    'INSERT OR IGNORE INTO webhook_events (source, event_id, payload, received_at) VALUES (?,?,?,?)'
  ).run(source, eventId, JSON.stringify(payload ?? {}), Date.now());
  return db.prepare('SELECT id, status FROM webhook_events WHERE source = ? AND event_id = ?').get(source, eventId);
}

export function markWebhookProcessed(source, eventId) {
  db.prepare('UPDATE webhook_events SET status = ?, processed_at = ? WHERE source = ? AND event_id = ?')
    .run('PROCESSED', Date.now(), source, eventId);
}

/** Duplikat-Schutz: true = Event ist NEU und darf verarbeitet werden. */
export async function claimEventId(scope, eventId, ttlSeconds = 86_400) {
  if (!eventId) return true;
  // Redis ist die dauerhafte instanzuebergreifende Abgrenzung; der erste
  // Claim baut die Verbindung automatisch auf (kein manueller Init noetig).
  // Rueckgabe: true = neu beansprucht, false = Duplikat, null = Redis
  // nicht verfuegbar -> In-Process-Fallback unten (statt 500 an den Sender).
  const claimed = await redisTrySetNx(`vf:wh:${scope}:${eventId}`, '1', ttlSeconds);
  if (claimed !== null) return claimed;
  // Fallback (ein Prozess): In-Memory-Map mit harter TTL
  if (!claimEventId._mem) claimEventId._mem = new Map();
  const now = Date.now();
  for (const [k, exp] of claimEventId._mem) if (exp < now) claimEventId._mem.delete(k);
  const key = `${scope}:${eventId}`;
  if (claimEventId._mem.has(key)) return false;
  claimEventId._mem.set(key, now + ttlSeconds * 1_000);
  return true;
}

// ── Hilfsfunktionen: konstante Zeit vergleichen, ohne Leaks ──
function safeEqualHex(expectedHex, actualHex) {
  const a = Buffer.from(expectedHex, 'hex');
  const b = Buffer.from(String(actualHex ?? ''), 'hex');
  if (a.length !== b.length || b.length === 0) return false;
  return timingSafeEqual(a, b);
}

// ── Slack: Block-Kit-Alerts (Verkaeufe, Systemfehler, Statusaenderungen) ──
export function slackSaleBlocks({ title, product, email, amount, currency, source, eventId }) {
  return [
    { type: 'header', text: { type: 'plain_text', text: title } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Produkt:*\n${product}` },
        { type: 'mrkdwn', text: `*Betrag:*\n${amount} ${currency}` },
        { type: 'mrkdwn', text: `*Kaeufer:*\n${email}` },
        { type: 'mrkdwn', text: `*Quelle:*\n${source}` }
      ]
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Event-ID: \`${eventId}\`` }] }
  ];
}

export function slackSystemBlocks({ title, message, detail }) {
  return [
    { type: 'header', text: { type: 'plain_text', text: title } },
    { type: 'section', text: { type: 'mrkdwn', text: message } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: String(detail ?? '') }] }
  ];
}

/** Sendet einen Slack-Alert an SLACK_WEBHOOK_URL (Incoming Webhook, Block Kit). */
export async function postSlackAlert(blocks) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return { sent: false, reason: 'SLACK_WEBHOOK_URL nicht gesetzt' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks }),
      signal: AbortSignal.timeout(8_000)
    });
    if (!res.ok) return { sent: false, reason: `Slack antwortete ${res.status}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: `Slack nicht erreichbar: ${err.message}` };
  }
}

// ── Stripe: stripe-signature Verifikation + Event-Handling ──
export function parseStripeSignature(header) {
  const parts = String(header ?? '').split(',').map((s) => s.trim());
  const out = {};
  for (const part of parts) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/** Stripe-Standard: v1 = HMAC-SHA256(secret, `${t}.${rawBody}`), t = Zeitstempel. */
export function verifyStripeSignature(rawBody, sigHeader, secret, toleranceSec = 300) {
  if (!secret) return { ok: false, error: 'STRIPE_WEBHOOK_SECRET nicht konfiguriert' };
  const { t, v1 } = parseStripeSignature(sigHeader);
  if (!t || !v1) return { ok: false, error: 'stripe-signature fehlt t= oder v1=' };
  const age = Math.abs(Date.now() / 1000 - Number(t));
  if (!Number.isFinite(age) || age > toleranceSec)
    return { ok: false, error: `Zeitstempel zu alt (${Math.round(age)}s > ${toleranceSec}s)` };
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  if (!safeEqualHex(expected, v1)) return { ok: false, error: 'Signatur stimmt nicht ueberein' };
  return { ok: true };
}

/**
 * Verarbeitet ein verifiziertes Stripe-Event.
 * Unterstuetzt: checkout.session.completed, customer.subscription.updated,
 * invoice.payment_failed.
 */
export async function handleStripeEvent(event) {
  const type = event?.type ?? '';
  const obj = event?.data?.object ?? {};
  const supported = [
    'checkout.session.completed',
    'customer.subscription.updated',
    'invoice.payment_failed'
  ];
  const amount = obj.amount_total != null ? (obj.amount_total / 100).toFixed(2)
    : obj.amount_due != null ? (obj.amount_due / 100).toFixed(2)
    : '?';
  if (type === 'checkout.session.completed') {
    const r = await postSlackAlert(slackSaleBlocks({
      title: '✅ Verkauf: Stripe-Checkout abgeschlossen',
      product: obj.metadata?.product ?? obj.metadata?.plan ?? 'unbenannt',
      email: obj.customer_details?.email ?? obj.customer_email ?? 'unbekannt',
      amount, currency: (obj.currency ?? 'EUR').toUpperCase(),
      source: 'Stripe', eventId: event.id
    }));
    return { handled: true, slack: r };
  }
  if (type === 'customer.subscription.updated') {
    const r = await postSlackAlert(slackSystemBlocks({
      title: '🔄 Abo aktualisiert (Stripe)',
      message: `Abo \`${obj.id ?? '?'}\` → Status *${obj.status ?? '?'}*`,
      detail: `Event: ${event.id}`
    }));
    return { handled: true, slack: r };
  }
  if (type === 'invoice.payment_failed') {
    const r = await postSlackAlert(slackSystemBlocks({
      title: '⚠️ Zahlung fehlgeschlagen (Stripe)',
      message: `Rechnung \`${obj.id ?? '?'}\`: Zahlung fehlgeschlagen.`,
      detail: `Event: ${event.id}`
    }));
    return { handled: true, slack: r };
  }
  return { handled: false, supported, slack: { sent: false, reason: `Event-Typ ${type} nicht abonniert` } };
}

// ── Digistore24: IPN-SHA256-Passphrase-Validierung ──
/**
 * Digistore24 sendet IPN als Form-Parameter inkl. `sha256_signature`.
 * Die Signatur ist SHA256 ueber die Konkatenation der vereinbarten
 * Parameter, beginnend mit der IPN-Passphrase (DIGISTORE24_PASSPHRASE).
 * Die exakte Feldliste je Konto laesst sich ueber
 * DIGISTORE24_SIGNATURE_PARAMS anpassen (Komma-Liste); Standard ist die
 * uebliche Variante Passphrase + customer_email + transaction_id +
 * item_id + etrigger.
 */
export function verifyDigistore24Signature(params, passphrase, fieldList) {
  if (!passphrase) return { ok: false, error: 'DIGISTORE24_PASSPHRASE nicht konfiguriert' };
  const received = String(params.sha256_signature ?? '').toLowerCase();
  if (!received) return { ok: false, error: 'sha256_signature fehlt' };
  const fields = (fieldList ||
    process.env.DIGISTORE24_SIGNATURE_PARAMS ||
    'passphrase,customer_email,transaction_id,item_id,etrigger'
  ).split(',').map((f) => f.trim()).filter(Boolean);
  const material = fields.map((f) =>
    f === 'passphrase' || f === 'ds24password' ? passphrase : String(params[f] ?? '')
  ).join('');
  const expected = createHash('sha256').update(material).digest('hex');
  if (!safeEqualHex(expected, received)) return { ok: false, error: 'Signatur stimmt nicht ueberein' };
  return { ok: true, fields };
}

/** Auswertung von Produkt-ID, Kaeuferdaten und Transaktionsstatus. */
export async function handleDigistore24Event(params) {
  const status = String(params.etrigger ?? params.event ?? '').toLowerCase();
  const data = {
    transactionId: params.transaction_id ?? null,
    productId: params.product_id ?? params.item_id ?? null,
    amount: params.price ?? params.amount ?? null,
    currency: params.currency ?? 'EUR',
    buyer: {
      email: params.customer_email ?? params.email ?? null,
      name: [params.first_name, params.last_name].filter(Boolean).join(' ') || null,
      country: params.country ?? null
    },
    status
  };
  if (['payment', 'sale', 'booking', 'order'].includes(status)) {
    const r = await postSlackAlert(slackSaleBlocks({
      title: '✅ Verkauf: Digistore24-Zahlung',
      product: data.productId ?? 'unbekannt', email: data.buyer.email ?? 'unbekannt',
      amount: data.amount ?? '?', currency: data.currency,
      source: 'Digistore24', eventId: data.transactionId ?? 'ohne-ID'
    }));
    return { handled: true, data, slack: r };
  }
  if (['refund', 'chargeback', 'abonnement_storniert', 'cancel'].includes(status)) {
    const r = await postSlackAlert(slackSystemBlocks({
      title: '⚠️ Digistore24: Rueckzahlung/Storno',
      message: `Transaktion \`${data.transactionId ?? '?'}\` (${data.productId ?? '?'}): *${status}*`,
      detail: `Kaeufer: ${data.buyer.email ?? 'unbekannt'}`
    }));
    return { handled: true, data, slack: r };
  }
  return {
    handled: true, data,
    slack: { sent: false, reason: `etrigger '${status}' nur protokolliert (kein Alert-Event)` }
  };
}

// ── Universal Webhook Adapter: Bearer-Token / API-Key ──
/** Prueft Authorization: Bearer bzw. X-API-Key gegen WEBHOOK_API_KEYS (Komma-Liste) bzw. WEBHOOK_INTERNAL_TOKEN. */
export function authorizeUniversalRequest(req) {
  const header = String(req.headers['authorization'] ?? '');
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const apiKeyHeader = String(req.headers['x-api-key'] ?? '').trim();
  const presented = bearer || apiKeyHeader;
  if (!presented) return { ok: false, error: 'Kein Bearer-Token/X-API-Key uebermittelt' };
  const digest = (s) => createHash('sha256').update(String(s)).digest();
  const presentedHash = digest(presented);
  const candidates = [
    ...(process.env.WEBHOOK_INTERNAL_TOKEN ? [process.env.WEBHOOK_INTERNAL_TOKEN] : []),
    ...(process.env.WEBHOOK_API_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  ];
  if (candidates.length === 0) return { ok: false, error: 'Kein Universal-Webhook-Key konfiguriert' };
  for (const candidate of candidates) {
    if (candidate.length === presented.length && timingSafeEqual(digest(candidate), presentedHash)) {
      return { ok: true };
    }
  }
  return { ok: false, error: 'Token nicht gueltig' };
}

// ── Ergaenzung: Redis-Verbindung im Gateway oeffentlich melden ──
export function gatewayStatus() {
  return {
    redis: redisAvailable() ? 'verbunden' : 'in-memory-fallback',
    slack: process.env.SLACK_WEBHOOK_URL ? 'konfiguriert' : 'deaktiviert',
    stripe: process.env.STRIPE_WEBHOOK_SECRET ? 'konfiguriert' : 'deaktiviert',
    digistore24: process.env.DIGISTORE24_PASSPHRASE ? 'konfiguriert' : 'deaktiviert',
    universal: (process.env.WEBHOOK_API_KEYS || process.env.WEBHOOK_INTERNAL_TOKEN) ? 'konfiguriert' : 'deaktiviert'
  };
}
