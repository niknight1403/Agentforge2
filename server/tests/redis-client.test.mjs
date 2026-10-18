// Redis-Client-Integrationstest: der ECHTE Client laeuft gegen ein
// protokollakkurates RESP-Gegenstueck auf einem echten TCP-Socket
// (localhost, zufaelliger Port). Geprueft werden Handshake-Reihenfolge,
// FIFO-Antwortzuordnung, SET-NX-Idempotenz, AUTH-Fehler-Aufraeumen und
// Wiederaufbau nach serverseitigem Close — die Fehlermodi, die den
// frueheren Client blockierten.
//
// Bewusst ohne node:sqlite-Abhaengigkeit: dieses Modul testet nur redis.mjs
// und laeuft deshalb in jedem Node>=20 (lokal UND CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

// redis.mjs haelt seinen Zustand module-level; der Query-Suffix erzwingt je
// Test eine frische Modulinstanz (Node cached ESM pro URL), ohne den
// Produktionsimport anzufassen.
let loadCount = 0;
async function freshClient() {
  loadCount += 1;
  return import(`../redis.mjs?test=${loadCount}`);
}

/** Minimaler RESP-Server: PING/SET NX/GET/DEL/AUTH/SELECT, replies in Empfangsreihenfolge. */
function startRespServer({ rejectAuth = false } = {}) {
  const sockets = [];
  const store = new Map();
  const seen = [];
  const srv = createServer((socket) => {
    sockets.push(socket);
    let buf = Buffer.alloc(0);
    const reply = (raw) => socket.write(Buffer.from(raw, 'binary'));
    const replyOk = () => reply("+OK\r\n");
    const replyPong = () => reply("+PONG\r\n");
    const replyNil = () => reply("$-1\r\n");
    const replyInt = (n) => reply(`:${n}\r\n`);
    const replyErr = (msg) => reply(`-${msg}\r\n`);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const lineEnd = buf.indexOf('\r\n');
        if (lineEnd === -1) return;
        const line = buf.subarray(0, lineEnd).toString('utf8');
        const m = line.match(/^\*(\d+)$/);
        if (!m) { buf = Buffer.alloc(0); return; }   // kaputtes Framing: verwerfen
        const count = Number(m[1]);
        const args = [];
        let i = lineEnd + 2;
        for (let n = 0; n < count; n++) {
          const lenEnd = buf.indexOf('\r\n', i);
          if (lenEnd === -1) return;                 // noch unvollstaendig
          const len = Number(buf.subarray(i + 1, lenEnd).toString('utf8'));
          if (lenEnd + 2 + len + 2 > buf.length) return;
          args.push(buf.subarray(lenEnd + 2, lenEnd + 2 + len).toString('utf8'));
          i = lenEnd + 2 + len + 2;
        }
        buf = buf.subarray(i);
        seen.push(args);
        const [cmd, ...rest] = args;
        const c = cmd.toUpperCase();
        if (c === 'PING') { replyPong(); continue; }
        if (c === 'AUTH') {
          if (rejectAuth) replyErr('WRONGPASS invalid username-password pair or user is disabled.');
          else replyOk();
          continue;
        }
        if (c === 'SELECT') { replyOk(); continue; }
        if (c === 'SET') {
          const hasNx = rest.slice(2).some((x) => x.toUpperCase() === 'NX');
          if (hasNx && store.has(rest[0])) { replyNil(); }
          else { store.set(rest[0], rest[1]); replyOk(); }
          continue;
        }
        if (c === 'GET') {
          const v = store.get(rest[0]);
          if (v === undefined) replyNil();
          else reply(`$${Buffer.byteLength(v)}\r\n${v}\r\n`);
          continue;
        }
        if (c === 'DEL') { replyInt(store.delete(rest[0]) ? 1 : 0); continue; }
        replyErr(`unbekannter Befehl: ${cmd}`);
      }
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, sockets, store, seen, port: srv.address().port }));
  });
}

test('Handshake + SET-NX-Idempotenz + Wiederaufbau nach serverseitigem Close', async () => {
  const { redisTrySetNx, redisTryGet, redisTryPing, redisAvailable } = await freshClient();
  const { srv, sockets, port } = await startRespServer();
  process.env.REDIS_URL = `redis://127.0.0.1:${port}/2`;
  try {
    assert.equal(await redisTryPing(), true, 'PING nach Handshake (kein Passwort, SELECT db=2)');
    assert.equal(redisAvailable(), true, 'Verbindung erst nach Handshake verfuegbar');

    assert.equal(await redisTrySetNx('vf:wh:stripe:evt_1', '1', 60), true, 'erster Claim: true');
    assert.equal(await redisTrySetNx('vf:wh:stripe:evt_1', '1', 60), false, 'Duplikat: false (NX)');
    assert.equal(await redisTryGet('vf:wh:stripe:evt_1'), '1', 'GET liefert den gespeicherten Wert');

    // Serverseitiger Close: Client muss aufraeumen, keine Zombie-Verbindung
    srv.close();
    for (const s of sockets) s.destroy();
    await delay(80);
    assert.equal(redisAvailable(), false, 'nach Server-Close kein scheinbar verfuegender Zustand');

    // Wiederaufbau NACH Ablauf der 1s-Abkuehlphase (ehrlich warten, nicht umgehen)
    await delay(1_100);
    const secondSrv = await startRespServer();
    process.env.REDIS_URL = `redis://127.0.0.1:${secondSrv.port}/2`;
    try {
      assert.equal(await redisTrySetNx('vf:wh:d24:txn_2', '1', 60), true, 'Wiederaufbau klappt');
      assert.equal(redisAvailable(), true);
    } finally {
      secondSrv.srv.close();
      for (const s of secondSrv.sockets) s.destroy();
    }
  } finally {
    delete process.env.REDIS_URL;
    srv.close();
  }
});

test('Gescheiterter AUTH raeumt sauber auf: null statt Zombie, Abkuehlphase aktiv, ein Socket', async () => {
  const { redisTrySetNx, redisAvailable, redisLastError } = await freshClient();
  const { srv, sockets, port } = await startRespServer({ rejectAuth: true });
  process.env.REDIS_URL = `redis://:falsches-pass@127.0.0.1:${port}`;
  try {
    assert.equal(await redisTrySetNx('vf:wh:stripe:evt_x', '1', 60), null, 'AUTH-Fehler: null (Fallback beim Caller)');
    assert.equal(redisAvailable(), false, 'kein Zombie nach FAILED-AUTH');
    assert.ok(redisLastError(), 'Fehlerursache ist abrufbar');
    assert.equal(await redisTrySetNx('vf:wh:stripe:evt_y', '1', 60), null, 'Abkuehlphase verhindert Fehler-Sturmboeden');
    assert.equal(sockets.length, 1, 'genau EINE Verbindung (kein Doppel-Socket)');
  } finally {
    delete process.env.REDIS_URL;
    srv.close();
  }
});

test('REDIS_URL ungesetzt: null ohne jeden Verbindungsaufbau', async () => {
  const { redisTrySetNx, redisAvailable } = await freshClient();
  delete process.env.REDIS_URL;
  assert.equal(await redisTrySetNx('k', '1', 60), null, 'ohne URL: null (In-Process-Fallback)');
  assert.equal(redisAvailable(), false);
});
