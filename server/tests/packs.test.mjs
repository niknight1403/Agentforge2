/**
 * Werkzeug- und Feature-Packs.
 *
 * Der Kern dieser Tests: ein Pack ist ein echter Schalter. Ist sein
 * Werkzeug-Pack aus, darf der Agent das Werkzeug nicht benutzen — der Versuch
 * muss im Audit als "blockiert" landen und nicht still ins Leere laufen.
 */
import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db.mjs';
import { TOOL_SPECS, toolSpecs, createVilla, runTool } from '../agents.mjs';
import {
  FEATURE_PACKS, TOOL_PACKS, MASTER_PACK,
  packState, packSummary, packEnabled, setPackEnabled, canUseTool, toolPackOf
} from '../packs.mjs';

const TOOL_NAMES = TOOL_SPECS.map((t) => t.name);

test('jedes Werkzeug gehoert zu genau einem Pack', () => {
  const assigned = TOOL_PACKS.flatMap((p) => p.tools);
  assert.deepEqual([...assigned].sort(), [...TOOL_NAMES].sort(), 'Werkzeugliste und Pack-Zuordnung laufen auseinander');
  assert.equal(new Set(assigned).size, assigned.length, 'ein Werkzeug ist doppelt zugeordnet');
});

test('jedes Pack hat eindeutige IDs und erklaerende Texte', () => {
  const ids = [...FEATURE_PACKS, ...TOOL_PACKS].map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'doppelte Pack-ID');
  for (const p of [...FEATURE_PACKS, ...TOOL_PACKS]) {
    assert.ok(p.title && p.title.length > 3, `${p.id}: Titel fehlt`);
    assert.ok(p.description && p.description.length > 15, `${p.id}: Beschreibung zu kurz`);
  }
});

test('der Hauptschalter existiert als Feature-Pack', () => {
  assert.ok(FEATURE_PACKS.some((p) => p.id === MASTER_PACK));
});

test('Standard: alles ist freigeschaltet', () => {
  for (const name of TOOL_NAMES) assert.equal(canUseTool(name).allowed, true, `${name} ist unerwartet gesperrt`);
  const state = packState();
  assert.equal(state.master.enabled, true);
  assert.deepEqual(state.blocked, []);
  assert.equal(state.features.length, FEATURE_PACKS.length);
  assert.equal(state.tools.length, TOOL_PACKS.length);
});

test('unbekanntes Pack kann nicht geschaltet werden', () => {
  const out = setPackEnabled('gibt-es-nicht', false);
  assert.equal(out.ok, false);
  assert.match(out.error, /Unbekanntes Pack/);
});

test('Werkzeug-Pack abschalten sperrt genau seine Werkzeuge', () => {
  const pack = TOOL_PACKS.find((p) => p.id === 'recherche');
  assert.ok(pack, 'Pack recherche fehlt');
  try {
    setPackEnabled(pack.id, false);
    for (const tool of pack.tools) {
      const gate = canUseTool(tool);
      assert.equal(gate.allowed, false, `${tool} haette gesperrt sein muessen`);
      assert.match(gate.reason, /recherche|ausgeschaltet/i);
    }
    // Andere Packs bleiben unberuehrt.
    assert.equal(canUseTool('memory_write').allowed, true);
    const summary = packSummary();
    assert.ok(summary.blocked.includes(pack.id));
    assert.equal(summary.toolPacks.find((p) => p.id === pack.id).effective, false);
  } finally {
    setPackEnabled(pack.id, true);
  }
  assert.equal(canUseTool(pack.tools[0]).allowed, true, 'Pack liess sich nicht zuruecksetzen');
});

test('Hauptschalter aus sperrt jedes Werkzeug-Pack', () => {
  try {
    setPackEnabled(MASTER_PACK, false);
    for (const name of TOOL_NAMES) {
      const gate = canUseTool(name);
      assert.equal(gate.allowed, false, `${name} trotz Hauptschalter aus erlaubt`);
    }
    assert.equal(packSummary().master, false);
    assert.equal(packSummary().blocked.length, TOOL_PACKS.length);
  } finally {
    setPackEnabled(MASTER_PACK, true);
  }
  assert.equal(packSummary().master, true);
});

test('toolSpecs meldet Pack und aktuelle Freigabe mit', () => {
  const spec = toolSpecs().find((t) => t.name === 'project_run');
  assert.equal(spec.pack, 'ausfuehrung');
  assert.equal(spec.packTitle, 'Ausfuehrung');
  assert.equal(spec.enabled, true);
  assert.equal(toolPackOf('gibt-es-nicht'), null);
  // Der statische Katalog bleibt ohne Freigabe-Flag...
  assert.equal(TOOL_SPECS.find((t) => t.name === 'project_run').enabled, undefined);
  // ...und die Freigabe folgt dem Pack-Zustand ohne Neustart.
  try {
    setPackEnabled('ausfuehrung', false);
    assert.equal(toolSpecs().find((t) => t.name === 'project_run').enabled, false);
  } finally {
    setPackEnabled('ausfuehrung', true);
  }
  assert.equal(toolSpecs().find((t) => t.name === 'project_run').enabled, true);
});

test('runTool verweigert gesperrte Werkzeuge und protokolliert das', async () => {
  const { villaId } = await createVilla({ name: 'Pack-Test', idea: 'Werkzeugsperre pruefen', agentCount: 3 });
  const agent = db.prepare('SELECT * FROM agents WHERE villa_id = ? AND is_root = 1').get(villaId);
  assert.ok(agent, 'Wurzelagent fehlt');

  // Erst der Normalfall: das Werkzeug arbeitet.
  const allowed = await runTool({ villaId, agentId: agent.id }, 'memory_write', { title: 'Vorher', content: 'geht', kind: 'FACT' });
  assert.match(allowed, /Gedaechtnis gespeichert/);

  try {
    setPackEnabled('gedaechtnis', false);
    const blocked = await runTool({ villaId, agentId: agent.id }, 'memory_write', { title: 'Nachher', content: 'soll nicht landen', kind: 'FACT' });
    assert.match(blocked, /blockiert/i);

    // Der Schreibversuch darf das Gedaechtnis nicht erreicht haben.
    const stored = db.prepare("SELECT COUNT(*) c FROM memories WHERE villa_id = ? AND title = 'Nachher'").get(villaId).c;
    assert.equal(stored, 0, 'gesperrtes Werkzeug hat trotzdem geschrieben');

    // Und der Versuch steht als blockiert im Audit.
    const entry = db.prepare("SELECT * FROM audit WHERE villa_id = ? AND tool = 'memory_write' ORDER BY id DESC LIMIT 1").get(villaId);
    assert.equal(entry.allowed, 0);
    assert.match(entry.result, /blockiert/i);
  } finally {
    setPackEnabled('gedaechtnis', true);
  }

  const after = await runTool({ villaId, agentId: agent.id }, 'memory_write', { title: 'Danach', content: 'geht wieder', kind: 'FACT' });
  assert.match(after, /Gedaechtnis gespeichert/);
});

test('packEnabled kennt nur bekannte Packs und meldet Unbekanntes als an', () => {
  assert.equal(packEnabled('recherche'), true);
  assert.equal(packEnabled('nie-gesetzt'), true);
});
