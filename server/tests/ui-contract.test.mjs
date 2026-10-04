/**
 * UI-Vertragstest: die Web-Oberflaeche besteht aus index.html (Struktur),
 * app.js (Logik) und styles.css. Referenziert app.js ein Element, das im
 * HTML fehlt (oder umgekehrt Schaltflaechen ohne Handler), faellt das
 * hier sofort auf — ohne Browser, als reine Statische Analyse.
 */
import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pub = resolve(import.meta.dirname, '../public');
const html = readFileSync(`${pub}/index.html`, 'utf8');
const js = readFileSync(`${pub}/app.js`, 'utf8');
const css = readFileSync(`${pub}/styles.css`, 'utf8');

const htmlIds = new Set([...html.matchAll(/id="([a-zA-Z][a-zA-Z0-9]*)"/g)].map((m) => m[1]));
// Selektoren der Form $('#xy') und querySelector('#xy')
const jsIds = new Set([...js.matchAll(/\$\('#([a-zA-Z][a-zA-Z0-9]*)'\)/g)].map((m) => m[1]));

test('app.js referenziert nur Elemente, die im HTML existieren', () => {
  const missing = [...jsIds].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `app.js nutzt fehlende IDs: ${missing.join(', ')}`);
});

test('Schaltflaechen im HTML haben einen Event-Handler in app.js', () => {
  // Alle Buttons mit fester ID muessen im JS vorkommen (als Klick-Ziel).
  const buttons = [...html.matchAll(/<button[^>]*id="([a-zA-Z][a-zA-Z0-9]*)"/g)].map((m) => m[1]);
  const unhandled = buttons.filter((id) => !js.includes(`#${id}`));
  assert.deepEqual(unhandled, [], `Buttons ohne Logik: ${unhandled.join(', ')}`);
});

test('HTML-Eingabefelder werden vom JS gelesen', () => {
  const inputs = [...html.matchAll(/<(input|textarea|select)[^>]*id="([a-zA-Z][a-zA-Z0-9]*)"/g)].map((m) => m[2]);
  const unread = inputs.filter((id) => !js.includes(`#${id}`));
  assert.deepEqual(unread, [], `Unbenutzte Eingabefelder: ${unread.join(', ')}`);
});

test('Chat-Eingaben und Statusanzeigen sind vorhanden', () => {
  for (const id of ['chatLog', 'chatMsg', 'sendBtn', 'healthDot', 'healthText', 'villaList']) {
    assert.ok(htmlIds.has(id), `${id} fehlt im HTML`);
    assert.ok(jsIds.has(id), `${id} wird von app.js nicht genutzt`);
  }
});

test('Styles decken die zentralen Klassen ab', () => {
  for (const cls of ['villa-card', 'bubble', 'badge', 'empty-state', 'status-pill', 'dot']) {
    assert.ok(css.includes(cls), `CSS-Klasse .${cls} fehlt`);
  }
});

test('app.js ist syntaktisch gultiges JavaScript', async () => {
  // node --check lief frueher manuell; hier fest verdrahtet.
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, ['--check', `${pub}/app.js`]);
});
