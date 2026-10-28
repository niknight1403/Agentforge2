/**
 * Sprint 1 (v1.32.0) — Packs sind echte Schalter im Live-Hub.
 *
 * Feature- und Werkzeug-Packs (portiert aus Agentforge2): Der Hub ist die
 * eine Wahrheit fuer Hub, Web-UI und Android-App. Ist ein Werkzeug-Pack aus,
 * blockiert runTool das Werkzeug im Lauf und protokolliert den Versuch
 * als "blockiert" im Audit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'packs-')), 'test.db');
process.env.VF_WORKSPACE = join(process.env.VF_DB, '..', 'ws');

const { canUseTool, setPackEnabled, packState, packSummary, MASTER_PACK, TOOL_PACKS } = await import('../packs.mjs');
const { toolSpecs, TOOL_SPECS } = await import('../agents.mjs');

test('Unberuehrte Packs: alles erlaubt (Default an)', () => {
  assert.equal(canUseTool('artifact_write').allowed, true);
  assert.equal(canUseTool('memory_search').allowed, true);
});

test('Werkzeug-Pack aus blockiert seine Werkzeuge, Audit-Grund genannt', () => {
  setPackEnabled('artefakte', false);
  const gate = canUseTool('artifact_write');
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /Artefakte/);
  // anderes Pack unberuehrt
  assert.equal(canUseTool('memory_write').allowed, true);
  setPackEnabled('artefakte', true);
  assert.equal(canUseTool('artifact_write').allowed, true);
});

test('Hauptschalter sperrt alle Werkzeug-Packs auf einmal', () => {
  setPackEnabled(MASTER_PACK, false);
  assert.equal(canUseTool('artifact_write').allowed, false);
  assert.equal(canUseTool('project_run').allowed, false);
  assert.equal(canUseTool('web_fetch').allowed, false);
  setPackEnabled(MASTER_PACK, true);
  assert.equal(canUseTool('artifact_write').allowed, true);
});

test('Unbekanntes Pack wird abgelehnt', () => {
  const r = setPackEnabled('gibtsnicht', true);
  assert.equal(r.ok, false);
});

test('packState liefert Features, Tools und Hauptschalter konsistent', () => {
  const st = packState();
  assert.ok(st.features.length >= 9);
  assert.ok(st.tools.length >= 6);
  assert.equal(st.master.id, MASTER_PACK);
  assert.ok(Array.isArray(st.blocked));
  assert.equal(st.master.enabled, true);
});

test('packSummary ist kompakt und enthaelt Effektivitaet je Pack', () => {
  const s = packSummary();
  assert.ok(s.toolPacks.every((t) => typeof t.effective === 'boolean'));
  assert.equal(s.master, true);
});

test('toolSpecs rechnet die Freigabe frisch dazu (kein eingefrorenes Flag)', () => {
  const before = toolSpecs();
  assert.ok(before.every((t) => t.enabled === true || t.pack === null));
  setPackEnabled('planung', false);
  const after = toolSpecs();
  const planung = after.find((t) => t.pack === 'planung');
  const gedaechtnis = after.find((t) => t.pack === 'gedaechtnis');
  assert.equal(planung.enabled, false);
  assert.equal(gedaechtnis.enabled, true);
  setPackEnabled('planung', true);
});

test('Jedes bekannte Werkzeug hat ein Pack oder bleibt bewusst packfrei', () => {
  const packTools = new Set(TOOL_PACKS.flatMap((p) => p.tools));
  for (const spec of TOOL_SPECS) {
    if (packTools.has(spec.name)) assert.ok(spec.pack, `${spec.name} sollte ein Pack haben`);
  }
});

test('GitHub-Publish ist als abschaltbares Plugin-Pack registriert', () => {
  const pack = packState().tools.find((item) => item.id === 'github');
  assert.ok(pack, 'GitHub-Plugin-Pack fehlt');
  assert.ok(pack.tools.includes('github_publish'));
  assert.equal(canUseTool('github_publish').pack, 'github');
  assert.equal(canUseTool('github_publish').allowed, true);
  setPackEnabled('github', false);
  assert.equal(canUseTool('github_publish').allowed, false);
  assert.equal(packState().tools.find((item) => item.id === 'github').effective, false);
  setPackEnabled('github', true);
});
