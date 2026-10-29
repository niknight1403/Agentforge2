#!/usr/bin/env node
/**
 * VillaForge Design-Audit: misst die Oberflaeche statt sie zu bewerten.
 *
 * Ein Design-Maengel-Report ist nur brauchbar, wenn er reproduzierbar ist —
 * deshalb prueft dieses Skript die gerenderte Seite in einem echten Chrome
 * gegen harte Kriterien: WCAG-Kontrast, Textueberlauf, abgeschnittene Inhalte,
 * Touch-Zielgroessen, Schriftgroessen, benannte Bedienelemente, doppelte IDs,
 * Fokus-Stile, reduzierte Bewegung und falsch verankerte Pseudo-Elemente.
 *
 * Aufruf: node scripts/design-audit.mjs [--max-findings 0]
 * Exit 0 = keine Befunde, 1 = Befunde vorhanden.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchChrome, newTarget, Page, delay } from './lib/cdp.mjs';
import { startHub, ROOT } from './lib/hub.mjs';
import { auditResult } from './lib/audit-result.mjs';
import { startMockLlm } from './lib/mock-llm.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = resolve(ROOT, arg('out', 'artifacts/design-audit'));
/** Erlaubte Befunde (Default 0 -> jede Abweichung ist rot). */
const MAX_FINDINGS = Number(arg('max-findings', 0));

/* ---------------------------------------------------------------- */
/* Laeuft in der Seite. Muss selbststaendig sein (wird serialisiert). */
/* ---------------------------------------------------------------- */
function designProbe() {
  const findings = { contrast: [], overflow: [], clipped: [], smallText: [], unnamed: [], duplicateIds: [], pseudoHost: [], tinyTargets: [], notes: [] };

  const shown = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5;
  };
  const label = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = el.classList.length ? `.${[...el.classList].slice(0, 2).join('.')}` : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };
  const parseColor = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || '');
    if (!m) return null;
    const p = m[1].split(',').map((v) => parseFloat(v));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (a, b) => {
    const l1 = lum(a); const l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  /** Effektive Hintergrundfarbe: alle halbtransparenten Ebenen bis zum Body kompostieren. */
  const behind = (el) => {
    const layers = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const c = parseColor(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) layers.push(c);
      if (c && c.a >= 0.999) break;
      node = node.parentElement;
    }
    let base = { r: 6, g: 9, b: 22 };
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      base = { r: l.r * l.a + base.r * (1 - l.a), g: l.g * l.a + base.g * (1 - l.a), b: l.b * l.a + base.b * (1 - l.a) };
    }
    return base;
  };
  const hasOwnText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);

  // 1) Kontrast + Schriftgroessen
  for (const el of document.querySelectorAll('body *')) {
    if (!shown(el) || !hasOwnText(el)) continue;
    const s = getComputedStyle(el);
    const size = parseFloat(s.fontSize);
    const weight = Number(s.fontWeight) || 400;
    const fg = parseColor(s.color) || { r: 255, g: 255, b: 255, a: 1 };
    const bg = behind(el);
    const mixed = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
    const required = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
    const got = contrast(mixed, bg);
    if (got + 0.05 < required) {
      findings.contrast.push({ el: label(el), size, weight, ratio: Number(got.toFixed(2)), required, text: el.textContent.trim().slice(0, 40) });
    }
    if (size < 11) findings.smallText.push({ el: label(el), size, text: el.textContent.trim().slice(0, 40) });
  }

  // 2) Seitlicher Ueberlauf
  const docOverflow = document.documentElement.scrollWidth - window.innerWidth;
  if (docOverflow > 2) findings.overflow.push({ el: 'documentElement', px: docOverflow });

  // 3) Abgeschnittener Text (Inhalt breiter als der Kasten)
  for (const el of document.querySelectorAll('body *')) {
    if (!shown(el) || !hasOwnText(el)) continue;
    const s = getComputedStyle(el);
    if (['auto', 'scroll'].includes(s.overflowX)) continue;
    if (s.textOverflow === 'ellipsis' || s.whiteSpace === 'nowrap') continue;
    if (el.scrollWidth - el.clientWidth > 1 && el.clientWidth > 0) {
      findings.clipped.push({ el: label(el), over: el.scrollWidth - el.clientWidth, text: el.textContent.trim().slice(0, 40) });
    }
  }

  // 4) Bedienelemente ohne zugaenglichen Namen
  const nameOf = (el) => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled && document.getElementById(labelled)) return document.getElementById(labelled).textContent;
    if (el.id) { const l = document.querySelector(`label[for="${el.id}"]`); if (l) return l.textContent; }
    const wrap = el.closest('label');
    if (wrap) return wrap.textContent;
    if (el.getAttribute('title')) return el.getAttribute('title');
    if (el.getAttribute('placeholder')) return el.getAttribute('placeholder');
    return (el.textContent || '').trim();
  };
  for (const el of document.querySelectorAll('button, a[href], input, textarea, select')) {
    if (!shown(el)) continue;
    if (el.type === 'hidden') continue;
    if (!nameOf(el)) findings.unnamed.push({ el: label(el) });
  }

  // 5) Doppelte IDs
  const seen = new Map();
  for (const el of document.querySelectorAll('[id]')) seen.set(el.id, (seen.get(el.id) || 0) + 1);
  for (const [id, n] of seen) if (n > 1) findings.duplicateIds.push({ id, count: n });

  // 6) Pseudo-Elemente, die am falschen Vorfahren haengen
  for (const el of document.querySelectorAll('body *')) {
    const hostPos = getComputedStyle(el).position;
    if (hostPos !== 'static') continue;
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudo);
      if (ps.content && ps.content !== 'none' && ps.position === 'absolute') {
        findings.pseudoHost.push({ el: label(el), pseudo });
      }
    }
  }

  // 7) Touch-Ziele (nur mobile Breiten)
  if (window.innerWidth <= 760) {
    for (const el of document.querySelectorAll('button, a[href], input, textarea, select')) {
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 44) findings.tinyTargets.push({ el: label(el), h: Math.round(r.height) });
    }
  }

  // 8) Fokus-Stile vorhanden?
  let focusVisible = false;
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules) {
      if (rule.selectorText && rule.selectorText.includes(':focus-visible')) focusVisible = true;
    }
  }
  if (!focusVisible) findings.notes.push('keine :focus-visible-Regel im Stylesheet');

  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    orbAnimation: (() => { const o = document.querySelector('.hero-orb'); return o ? getComputedStyle(o).animationName : null; })(),
    counts: Object.fromEntries(Object.entries(findings).map(([k, v]) => [k, v.length])),
    findings
  };
}

/* ---------------------------- Ablauf ---------------------------- */
const results = {};
let hub = null;
let chrome = null;
let page = null;
let modelMock = null;
let auditError=null;

/** Probe ausfuehren und unter einem Namen ablegen. */
async function probe(name) {
  const out = await page.evaluate(`return (${designProbe.toString()})();`);
  results[name] = out;
  return out;
}

(async () => {
  console.log('\nVillaForge Design-Audit\n' + '-'.repeat(60));
  let code = 0;
  try {
    modelMock = await startMockLlm();
    hub = await startHub({ keep: has('--keep'), env: { VF_LOCAL_LLM_URL: modelMock.url, VF_LOCAL_LLM_MODEL: 'villa-test' } });
    console.log(`Hub v${hub.health.version} auf ${hub.base}`);
    chrome = await launchChrome();
    const target = await newTarget(chrome.base, 'about:blank');
    page = await Page.attach(target.webSocketDebuggerUrl);
    await page.enableAll();
    const url = `${hub.base}/`;

    // Eine Villa anlegen, damit auch der Arbeitsbereich bewertet wird.
    const response = await fetch(`${hub.base}/api/villas`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Design-Audit', idea: 'Oberflaeche pruefen', agentCount: 8 })
    });
    const created = await response.json();
    if (!response.ok || !created.villaId) throw new Error(`Testvilla konnte nicht angelegt werden: HTTP ${response.status} ${created.error || ''}`.trim());
    console.log(`Testvilla #${created.villaId}`);

    for (const [name, vp] of [['desktop', { w: 1440, h: 960 }], ['mobil-360', { w: 360, h: 844, mobile: true }], ['mobil', { w: 390, h: 844, mobile: true }], ['mobil-430', { w: 430, h: 844, mobile: true }]]) {
      await page.navigate(url);
      await page.setViewport(vp.w, vp.h, { mobile: !!vp.mobile });
      await delay(600);
      await page.waitFor("document.querySelector('#villaList .villa-card') && document.querySelector('#runtimeState')?.textContent !== 'PRÜFT'", { timeout: 20_000, label: 'Cockpit geladen' });
      const dashboard = await probe(`${name}-dashboard`);
      console.log(`${name}-cockpit ${JSON.stringify(dashboard.counts)}`);
      await page.screenshot(join(OUT, `${name}-dashboard.png`));
      // Arbeitsbereich oeffnen, damit dessen Stile mitgemessen werden.
      await page.evaluate("const c = document.querySelector('#villaList .villa-card'); if (c) c.click(); return true;");
      await page.waitFor("document.querySelector('#detailPanel').hidden === false", { timeout: 20_000, label: 'Arbeitsbereich' });
      await delay(400);
      const out = await probe(name);
      console.log(`${name.padEnd(8)} ${JSON.stringify(out.counts)}`);
      await page.screenshot(join(OUT, `${name}.png`));
    }

    // Reduzierte Bewegung respektieren?
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const reduced = await page.evaluate(`return (${designProbe.toString()})();`);
    results.reduzierteBewegung = reduced;
    console.log(`reduziert  Animationsname der Hero-Kugel: ${reduced.orbAnimation}`);
  } catch (err) {
    auditError=err;console.error('Abbruch:', err.message);
    code = 1;
  } finally {
    try { await modelMock?.close(); } catch { /* Testprozess wird ohnehin beendet. */ }
    mkdirSync(OUT, { recursive: true });
    const violations = Object.entries(results)
      .flatMap(([scope, r]) => Object.entries(r.findings || {}).map(([kind, list]) => ({ scope, kind, list })));
    const total = violations.reduce((a, v) => a + v.list.length, 0);
    const verdict=auditResult(results,{error:auditError,maxFindings:MAX_FINDINGS});
    writeFileSync(join(OUT, 'report.json'), JSON.stringify({ generated_at: new Date().toISOString(), ...verdict, results }, null, 2));
    console.log('-'.repeat(60));
    for (const v of violations) {
      if (!v.list.length) continue;
      console.log(`\u2716 ${v.scope}/${v.kind}: ${v.list.length}`);
      for (const item of v.list.slice(0, 4)) console.log(`    ${JSON.stringify(item)}`);
    }
    const notes = results.desktop?.notes || [];
    for (const n of notes) console.log(`\u26a0 ${n}`);
    console.log(`${verdict.status==='passed'?'PASS':verdict.status.toUpperCase()} · ${total} Befund(e) · ${verdict.missingScopes.length} ungeprüfte Ansichten · Report: ${join(OUT,'report.json')}`);
    code=verdict.exitCode;
    try { page?.close(); } catch { /* egal */ }
    try { chrome?.stop(); } catch { /* egal */ }
    try { await hub?.stop(); } catch { /* egal */ }
  }
  process.exit(code);
})();
