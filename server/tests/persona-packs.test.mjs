/**
 * Darstellerinnen-Schicht: Persoenlichkeiten, Kleidungs-Packs, Look-Auswahl.
 * Laeuft offline gegen eine temporaere DB (siehe _env.mjs).
 */
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db.mjs';
import {
  WARDROBE_SLOTS,
  castOverview,
  createPersona,
  createWardrobePack,
  listPersonas,
  listWardrobePacks,
  normalizePackItems,
  personaCard,
  personaGaps,
  resolveLook,
  updatePersona
} from '../persona-packs.mjs';

function seedVilla(name = 'Medien-Villa') {
  const ts = Date.now();
  const info = db.prepare('INSERT INTO villas(name,idea,status,max_agents,autonomy,route_strategy,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(name, 'Test-Idee', 'CREATED', 3, 1, 'ROTATE', ts, ts);
  return Number(info.lastInsertRowid);
}

const PACK_ITEMS = [
  { slot: 'top', description: 'weisse Seidenbluse', colors: ['weiss'] },
  { slot: 'bottom', description: 'dunkle Stoffhose', colors: ['anthrazit'] },
  { slot: 'shoes', description: 'flache Lederloafer', colors: ['schwarz'] },
  { slot: 'accessory', description: 'feine Goldkette' }
];

test('Figur ohne Charakter, Stimme und Pack ist nicht besetzbar und nennt die Luecken', () => {
  const villaId = seedVilla();
  const persona = createPersona(villaId, { name: 'Mara' });
  assert.equal(persona.castable, false);
  assert.deepEqual(persona.gaps.sort(), ['charakter_zu_duenn', 'grenzen_fehlen', 'kleidungs_pack_fehlt', 'stimme_fehlt'].sort());
});

test('vollstaendige Figur wird besetzbar, sobald das Pack existiert', () => {
  const villaId = seedVilla('Cast-Villa');
  const created = createPersona(villaId, {
    name: 'Mara',
    voice: 'warm, ruhig, leicht rauchig',
    traits: ['neugierig', 'trockener Humor', 'strukturiert'],
    boundaries: ['keine realen Personen nachahmen', 'keine intimen Inhalte'],
    languages: ['de', 'en']
  });
  const pack = createWardrobePack(created.id, { name: 'Business', occasion: 'business', items: PACK_ITEMS });
  assert.ok(pack.id > 0);
  const detail = listPersonas(villaId)[0];
  assert.equal(detail.castable, true);
  assert.deepEqual(detail.gaps, []);
  assert.equal(detail.status, 'castable');
  assert.equal(detail.packs.length, 1);
  assert.equal(detail.packs[0].items.length, PACK_ITEMS.length);
});

test('Pack ohne Oberteil oder Schuhe wird abgelehnt', () => {
  assert.throws(() => normalizePackItems([{ slot: 'top', description: 'Shirt' }]), /LOOK_OHNE_SCHUHE/);
  assert.throws(() => normalizePackItems([{ slot: 'shoes', description: 'Sneaker' }]), /LOOK_OHNE_OBERTEIL/);
  assert.throws(() => normalizePackItems([{ slot: 'helm', description: 'Helm' }, { slot: 'shoes', description: 'S' }]), /SLOT_UNBEKANNT/);
  assert.throws(() => normalizePackItems([]), /PACK_OHNE_TEILE/);
});

test('alle deklarierten Slots sind benutzbar', () => {
  for (const slot of WARDROBE_SLOTS) {
    // Grundlook immer vollstaendig: Oberteil (oder Kleid) und Schuhe sind Pflicht.
    const items = [{ slot: 'shoes', description: 'Schuhe' }];
    if (slot === 'dress') items.push({ slot: 'dress', description: 'Kleid' });
    else {
      items.push({ slot: 'top', description: 'Oberteil' });
      if (slot !== 'shoes' && slot !== 'top') items.push({ slot, description: `Teil ${slot}` });
    }
    assert.doesNotThrow(() => normalizePackItems(items), slot);
  }
});

test('Look-Auswahl ist deterministisch und bevorzugt den passenden Anlass', () => {
  const villaId = seedVilla('Look-Villa');
  const persona = createPersona(villaId, { name: 'Nadia', voice: 'klar', traits: ['a', 'b', 'c'], boundaries: ['keine realen Personen'] });
  createWardrobePack(persona.id, { name: 'Alltag', occasion: 'alltag', items: PACK_ITEMS });
  createWardrobePack(persona.id, { name: 'Abend', occasion: 'abend', items: PACK_ITEMS });

  const first = resolveLook(persona.id, { occasion: 'abend', day: '2026-11-09' });
  const second = resolveLook(persona.id, { occasion: 'abend', day: '2026-11-09' });
  assert.equal(first.ok, true);
  assert.equal(first.pack, 'Abend');
  assert.equal(first.seed, second.seed);

  const fallback = resolveLook(persona.id, { occasion: 'sport', day: '2026-11-09' });
  assert.equal(fallback.pack, 'Alltag');
  assert.equal(fallback.note, 'kein_pack_fuer_anlass_genommen_standard');
});

test('ohne Pack sagt die Look-Auswahl ehrlich ab', () => {
  const villaId = seedVilla('Leer-Villa');
  const persona = createPersona(villaId, { name: 'Ohne Garderobe' });
  const result = resolveLook(persona.id);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'kein_kleidungs_pack');
});

test('Aenderungen an der Figur aktualisieren die Besetzbarkeit', () => {
  const villaId = seedVilla('Update-Villa');
  const persona = createPersona(villaId, { name: 'Ida', traits: ['ruhig'] });
  assert.ok(personaGaps(persona, []).includes('charakter_zu_duenn'));
  const updated = updatePersona(persona.id, { traits: ['ruhig', 'praezise', 'humorvoll'], voice: 'tief', boundaries: ['keine Nachahmung'] });
  assert.equal(updated.traits.length, 3);
  createWardrobePack(persona.id, { name: 'Studio', occasion: 'studio', items: PACK_ITEMS });
  const card = personaCard(persona.id);
  assert.equal(card.castable, true);
  assert.equal(card.packs[0].slots.includes('shoes'), true);
});

test('Cast-Uebersicht zaehlt besetzbare Figuren je Villa', () => {
  const villaId = seedVilla('Cast-Uebersicht');
  const a = createPersona(villaId, { name: 'A', voice: 'x', traits: ['1', '2', '3'], boundaries: ['keine'] });
  createWardrobePack(a.id, { name: 'P', items: PACK_ITEMS });
  createPersona(villaId, { name: 'B' });
  const overview = castOverview(villaId);
  assert.equal(overview.total, 2);
  assert.equal(overview.castable, 1);
  assert.equal(overview.personas.find((entry) => entry.name === 'B').gaps.length > 0, true);
});

test('Fremde Villa sieht keine Figuren einer anderen', () => {
  const first = seedVilla('Villa Eins');
  const second = seedVilla('Villa Zwei');
  createPersona(first, { name: 'Nur hier' });
  assert.equal(listPersonas(second).length, 0);
  assert.equal(listWardrobePacks(999999).length, 0);
});
