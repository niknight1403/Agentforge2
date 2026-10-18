/**
 * Minimaler RESP-Client (Redis) fuer den VillaForge Hub.
 *
 * Der Hub ist bewusst npm-abhaengigkeitsfrei; fuer die Webhook-Idempotenz
 * reicht ein winziger Teil des Redis-Protokolls: PING, SET (mit EX/NX),
 * GET, DEL, AUTH, SELECT.
 *
 * Design-Regeln (beheben die fruehere Handshake-Blockade):
 *   - Der AUTH/SELECT-Handshake schreibt direkt auf den Socket und wartet
 *     auf normale FIFO-Warteplaetze — er ruft NIEMALS redisCommand oder
 *     getConnection auf und kann sich deshalb nicht selbst blockieren.
 *   - Der Verbindungsaufbau ist EIN memoisiertes Promise pro Versuch:
 *     parallele erste Befehle teilen sich exakt einen Socket und einen
 *     Handshake, statt je eine Verbindung zu oeffnen.
 *   - Parsing auf Buffer-Basis: mehrbyteige UTF-8-Zeichen koennen nicht
 *     an TCP-Chunk-Grenzen zerfallen (ein String-Puffer konnte dabei die
 *     Pipeline blockieren, bis der 5s-Timeout griff).
 *   - Kein stiller Zombie: schlaegt AUTH/SELECT oder der Aufbau fehl,
 *     wird der Socket zerstoert und alles zurueckgesetzt; der naechste
 *     Befehl baut neu auf (mit 1s Abkuehlphase gegen Fehler-Sturmböen
 *     bei Webhook-Retries von Stripe/Digistore24).
 *   - conn gilt erst NACH erfolgreichem Handshake — ein gescheiterter
 *     AUTH hinterlaesst keine scheinbar "verfuegbare" Verbindung.
 *
 * Konfiguration: REDIS_URL=redis://[:passwort@]host:port[/db]
 * Ist REDIS_URL ungesetzt oder Redis nicht erreichbar, liefern die
 * redisTry*-Funktionen null zurueck und der Caller nutzt seinen
 * In-Process-Fallback (siehe webhooks.mjs). Der erste Befehl baut die
 * Verbindung automatisch auf — ein manueller Init-Aufruf ist nicht noetig.
 */
import { connect } from 'node:net';

let conn = null;            // aktive Verbindung: { socket, queue, buffer }
let connecting = null;      // laufender Verbindungsaufbau (memoisiert, genau einer)
let retryNotBefore = 0;     // Abkuehlphase nach Verbindungsaufbau-Fehler
let lastError = null;

export function redisAvailable() {
  return !!(conn && conn.socket && !conn.socket.destroyed && !conn.socket.pending);
}

export function redisLastError() {
  return lastError;
}

function parseRedisUrl(raw) {
  const u = new URL(raw);
  return {
    host: u.hostname || '127.0.0.1',
    port: Number(u.port || 6379),
    password: u.password ? decodeURIComponent(u.password) : null,
    db: u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0
  };
}

function encodeCommand(args) {
  const parts = [`*${args.length}\r\n`];
  for (const a of args) {
    const b = Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'utf8');
    parts.push(`$${b.length}\r\n`, b, '\r\n');
  }
  return Buffer.concat(parts.map((p) => Buffer.isBuffer(p) ? p : Buffer.from(p, 'binary')));
}

/**
 * Parst genau eine vollstaendige RESP-Antwort aus dem Buffer.
 * Rueckgabe { value, rest } oder null (Antwort noch unvollstaendig).
 * Fehler-Antworten ('-...') werden als Error-Objekt geliefert.
 */
function readFrame(buf) {
  const lineEnd = buf.indexOf('\r\n');
  if (lineEnd === -1) return null;
  const type = buf[0];
  const body = buf.subarray(1, lineEnd).toString('utf8');
  let i = lineEnd + 2;
  if (type === 0x2b /* + */ || type === 0x2d /* - */ || type === 0x3a /* : */) {
    const value = type === 0x2d
      ? Object.assign(new Error(body), { redisError: true })
      : type === 0x3a ? Number(body) : body;
    return { value, rest: buf.subarray(i) };
  }
  if (type === 0x24 /* $ */) {
    const len = Number(body);
    if (len === -1) return { value: null, rest: buf.subarray(i) };
    if (i + len + 2 > buf.length) return null;      // Nutzdaten noch nicht komplett
    const value = buf.subarray(i, i + len).toString('utf8');
    return { value, rest: buf.subarray(i + len + 2) };
  }
  if (type === 0x2a /* * */) {
    const count = Number(body);
    if (count === -1) return { value: null, rest: buf.subarray(i) };
    let rest = buf.subarray(i);
    const items = [];
    for (let n = 0; n < count; n++) {
      const inner = readFrame(rest);
      if (inner === null) return null;
      items.push(inner.value);
      rest = inner.rest;
    }
    return { value: items, rest };
  }
  return { value: new Error(`Unbekannter RESP-Typ: ${String.fromCharCode(type)}`), rest: buf.subarray(i) };
}

/** Legt einen Platz in der FIFO-Antwort-Warteschlange an (5s-Harttimeout). */
function makeWaiter(state) {
  return new Promise((resolve, reject) => {
    const waiter = {
      settle(value) {
        clearTimeout(waiter.timer);
        if (value instanceof Error) reject(value); else resolve(value);
      },
      timer: setTimeout(() => {
        const idx = state.queue.indexOf(waiter);
        if (idx >= 0) state.queue.splice(idx, 1);
        reject(new Error('Redis-Timeout (5s)'));
      }, 5_000)
    };
    state.queue.push(waiter);
  });
}

/**
 * Verbindungsaufbau inkl. AUTH/SELECT-Handshake. Genau EIN data-Listener;
 * der Handshake schreibt direkt auf den Socket (nie via redisCommand, eine
 * Selbst-Blockade ist strukturimmoeglich) und nutzt dieselbe FIFO-Queue
 * wie alle spaeteren Befehle.
 */
function buildConnection() {
  const { host, port, password, db } = parseRedisUrl(process.env.REDIS_URL);
  const state = { socket: null, queue: [], buffer: Buffer.alloc(0), closed: false };
  return new Promise((resolve, reject) => {
    const socket = connect(port, host);
    state.socket = socket;
    socket.setNoDelay(true);

    const failOnce = (err) => {
      if (state.closed) return;
      state.closed = true;
      lastError = err;
      retryNotBefore = Date.now() + 1_000;           // Abkuehlphase gegen Retry-Sturmböen
      socket.destroy();
      for (const waiter of state.queue.splice(0)) waiter.settle(err);
      conn = null;
      reject(err);                                    // no-op, falls bereits abgeschlossen
    };

    socket.on('error', failOnce);
    socket.on('close', () => {
      if (!state.closed) failOnce(new Error('Redis-Verbindung vom Server geschlossen'));
    });
    socket.on('data', (chunk) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      let frame;
      while ((frame = readFrame(state.buffer)) !== null) {
        state.buffer = frame.rest;
        const waiter = state.queue.shift();
        if (waiter) waiter.settle(frame.value);
      }
    });
    socket.on('connect', () => {
      (async () => {
        try {
          if (password) {
            const authWait = makeWaiter(state);
            socket.write(encodeCommand(['AUTH', password]));
            await authWait;                           // '+OK' oder Error('-WRONGPASS …')
          }
          if (db > 0) {
            const selectWait = makeWaiter(state);
            socket.write(encodeCommand(['SELECT', String(db)]));
            await selectWait;
          }
          conn = state;                               // erst NACH erfolgreichem Handshake aktiv
          resolve(state);
        } catch (err) {
          failOnce(err);                               // Socket weg, conn bleibt null
        }
      })();
    });
  });
}

/**
 * Liefert eine offene (handgeschaelte) Verbindung — memoisiert pro Versuch.
 * Bei Fehlern wird KEINE Ausnahme geworfen, sondern das memoisierte
 * Promise abgelehnt; der Caller (redisTry*) fängt das und meldet null.
 */
function getConnection() {
  if (conn) return Promise.resolve(conn);
  if (connecting) return connecting;
  if (!process.env.REDIS_URL) return Promise.reject(new Error('REDIS_URL nicht gesetzt'));
  if (Date.now() < retryNotBefore) {
    return Promise.reject(lastError || new Error('Redis-Verbindung in Abkuehlphase'));
  }
  connecting = buildConnection().finally(() => { connecting = null; });
  return connecting;
}

/** Fuehrt einen Redis-Befehl aus (5s Timeout, FIFO je Verbindung). */
export async function redisCommand(...args) {
  const state = await getConnection();
  const waiter = makeWaiter(state);
  state.socket.write(encodeCommand(args));
  return waiter;
}

/**
 * SET key value EX sekunden NX — Kern der Webhook-Idempotenz.
 * Rueckgabe: true = Claim erfolgreich, false = Key existierte bereits
 * (Duplikat), null = Redis nicht verfuegbar (Caller soll fallbacken).
 * Baut die Verbindung automatisch beim ersten Aufruf auf.
 */
export async function redisTrySetNx(key, value, ttlSeconds) {
  try {
    const res = await redisCommand('SET', key, value, 'EX', String(Math.max(1, Math.trunc(ttlSeconds))), 'NX');
    return res === 'OK' ? true : false;
  } catch (err) {
    lastError = err;
    return null;
  }
}

/** GET — null = Key fehlt ODER Redis nicht verfuegbar. */
export async function redisTryGet(key) {
  try {
    return await redisCommand('GET', key);
  } catch (err) {
    lastError = err;
    return null;
  }
}

/** DEL — Rueckgabe geloeschter Schluessel; null = Redis nicht verfuegbar. */
export async function redisTryDel(key) {
  try {
    return await redisCommand('DEL', key);
  } catch (err) {
    lastError = err;
    return null;
  }
}

/** PING — true bei '+PONG'; false bei jedem Fehler (nie throw). */
export async function redisTryPing() {
  try {
    return (await redisCommand('PING')) === 'PONG';
  } catch (err) {
    lastError = err;
    return false;
  }
}
