/**
 * Design-Vertragstest (statisch, ohne Browser).
 *
 * Der Browser-Audit (scripts/design-audit.mjs) misst das gerenderte Ergebnis.
 * Dieser Test haelt die Regeln schon im Quelltext fest, damit sie nicht
 * versehentlich zurueckgedreht werden: Mindestschriftgroesse, Fokus-Ringe,
 * reduzierte Bewegung, keine blockierenden Browser-Dialoge und genau eine
 * offene Ereignisverbindung.
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

/**
 * Kommentare fliegen raus, bevor geprueft wird: ein Test soll den Code
 * messen und nicht die Prosa. Sonst schlaegt er an, weil in einer
 * Erklaerung das Wort "confirm()" vorkommt.
 */
const jsCode = js
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** Alle font-size-Werte in px, die im Blatt stehen. */
function fontSizes(text) {
  return [...text.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
}

test('keine Schriftgroesse unter 11px', () => {
  const tooSmall = fontSizes(css).filter((px) => px < 11);
  assert.deepEqual(tooSmall, [], `zu kleine Schriftgroessen: ${tooSmall.join(', ')}`);
});

test('Fokus ist ueberall sichtbar (:focus-visible)', () => {
  assert.match(css, /:focus-visible\s*{/, 'kein globaler :focus-visible-Ring im Stylesheet');
  assert.match(css, /input:focus-visible/, 'Eingabefelder haben keinen Fokus-Ring');
  assert.match(css, /--focus/, 'Fokusfarbe ist nicht als Token hinterlegt');
});

test('reduzierte Bewegung wird respektiert', () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  const block = css.slice(css.indexOf('prefers-reduced-motion'));
  assert.match(block, /\.hero-orb\s*{\s*animation:\s*none/, 'die Hero-Kugel animiert trotz reduzierter Bewegung');
});

test('Zahlen stehen tabellarisch (springen nicht beim Takt)', () => {
  assert.match(css, /font-variant-numeric:\s*tabular-nums/);
});

test('die Hero-Kugel ist Bezugsrahmen fuer ihr Pseudo-Element', () => {
  // .hero-orb::before ist absolut positioniert — ohne position:relative
  // haengt der Ring an der ganzen Hero-Karte (echter Darstellungsfehler).
  const orb = /\.hero-orb\s*{([\s\S]*?)}/.exec(css);
  assert.ok(orb, '.hero-orb fehlt im Stylesheet');
  assert.match(orb[1], /position:\s*relative/, '.hero-orb braucht position:relative');
  assert.match(css, /\.hero-orb::before/, 'Ring der Hero-Kugel fehlt');
});

test('Status-Pillen decken alle Zustaende ab', () => {
  for (const state of ['RUNNING', 'COMPLETED', 'FAILED', 'PAUSED']) {
    assert.match(css, new RegExp(`\\.status-pill\\.${state}`), `Farbe fuer .status-pill.${state} fehlt`);
  }
});

test('Mobilblock haelt Touch-Ziele bei mindestens 44px', () => {
  const mobile = css.slice(css.indexOf('max-width: 760px'));
  assert.match(mobile, /min-height:\s*44px/, 'keine 44px-Mindesthoehe im Mobilblock');
  assert.match(mobile, /100svh/, 'mobiler Arbeitsbereich nutzt keine dynamische Viewport-Hoehe');
});

test('keine blockierenden Browser-Dialoge im Skript', () => {
  for (const bad of [/\balert\s*\(/, /\bconfirm\s*\(/, /\bprompt\s*\(/]) {
    assert.doesNotMatch(jsCode, bad, `blockierender Dialog gefunden: ${bad}`);
  }
  assert.match(jsCode, /openModal|showModal/, 'kein eigenes Modal vorhanden');
  assert.match(jsCode, /function toast/, 'keine Toast-Rueckmeldung vorhanden');
});

test('genau eine Ereignisverbindung: die alte wird vorher geschlossen', () => {
  assert.match(js, /if \(eventSource\)[\s\S]{0,80}eventSource\.close\(\)/, 'alte SSE-Verbindung wird nicht geschlossen');
  assert.match(js, /new EventSource\(/);
});

test('Health prueft den Inhalt, nicht nur den HTTP-Status', () => {
  // api() wirft bei HTTP-Fehlern nicht — eine Fehlerantwort darf nicht als
  // "Hub online" durchgehen.
  assert.match(js, /h\.error \|\| h\.ok !== true/, 'Health prueft die Antwort nicht auf Fehler');
  assert.match(html, /id="offlineBanner"/, 'kein Offline-Hinweis im HTML');
});

test('Passwortfelder stehen in einem Formular (Autofill-Warnung)', () => {
  const forms = [...html.matchAll(/<form[\s\S]*?<\/form>/g)].map((m) => m[0]);
  const passwordIds = [...html.matchAll(/<input[^>]*type="password"[^>]*id="([a-zA-Z]+)"|<input[^>]*id="([a-zA-Z]+)"[^>]*type="password"/g)]
    .map((m) => m[1] || m[2]);
  assert.ok(passwordIds.length >= 2, 'erwartete Passwortfelder fehlen');
  for (const id of passwordIds) {
    assert.ok(forms.some((f) => f.includes(`id="${id}"`)), `${id} liegt in keinem Formular`);
  }
});

test('jeder Reiter hat einen passenden Bereich', () => {
  const tabs = [...html.matchAll(/class="side-tab[^"]*"\s+data-tab="([a-z]+)"/g)].map((m) => m[1]);
  const panes = [...html.matchAll(/class="tabpane[^"]*"\s+data-pane="([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(tabs.length >= 6, `nur ${tabs.length} Reiter gefunden`);
  for (const tab of tabs) assert.ok(panes.includes(tab), `Reiter ${tab} hat keinen Bereich`);
  for (const pane of panes) assert.ok(tabs.includes(pane), `Bereich ${pane} hat keinen Reiter`);
});

test('keine doppelten IDs im HTML', () => {
  const ids = [...html.matchAll(/\sid="([a-zA-Z][a-zA-Z0-9]*)"/g)].map((m) => m[1]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual([...new Set(dupes)], [], `doppelte IDs: ${[...new Set(dupes)].join(', ')}`);
});

test('Live-Bereiche sind fuer Screenreader ausgezeichnet', () => {
  for (const id of ['createMsg', 'maintMsg', 'statsBar', 'healthText']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*aria-live`), `${id} hat kein aria-live`);
  }
  assert.match(html, /name="color-scheme"/, 'color-scheme fehlt (falsche Systemfarben)');
  assert.match(html, /name="description"/, 'Beschreibung fehlt');
});

test('Packs sind in der Oberflaeche sichtbar und schaltbar', () => {
  assert.match(html, /id="packList"/, 'keine Pack-Liste im HTML');
  assert.match(html, /id="workspacePackList"/, 'keine Pack-Liste im Arbeitsbereich');
  assert.match(html, /id="toolList"/, 'keine Werkzeugliste im Arbeitsbereich');
  assert.match(js, /\/api\/packs/, 'die Oberflaeche ruft /api/packs nicht auf');
  assert.match(js, /\/api\/packs\/[\s\S]{0,80}method: 'PATCH'/, 'Packs lassen sich nicht schalten');
});
