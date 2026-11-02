import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RUBRIC_KEYS,
  buildDissent,
  parseRubric,
  rubricSystemPrompt,
  rubricUserPrompt,
  summarizeScores,
} from '../council-rubric.mjs';

const PROPOSALS = [
  { agent: 'Arbeiter-1', text: 'Dashboard mit vier Kennzahlen' },
  { agent: 'Arbeiter-2', text: 'Farben saisonal anpassen' },
];

const good = (extra = {}) => ({
  agent: 'Arbeiter-1',
  impact: 8,
  effort: 2,
  nutzen: 5,
  machbarkeit: 4,
  belegbarkeit: 4,
  differenzierung: 4,
  ...extra,
});

test('Vollstaendige Bewertung wird als bewertet erkannt, inklusive Gewichtung', () => {
  const raw = JSON.stringify({ ranked: [good(), good({ agent: 'Arbeiter-2', impact: 3, effort: 6, nutzen: 1, machbarkeit: 3, belegbarkeit: 2, differenzierung: 1 })] });
  const parsed = parseRubric(raw, PROPOSALS);
  assert.equal(parsed.rated, true);
  assert.equal(parsed.entries[0].weighted, 4.35); // 5*.35 + 4*.25 + 4*.25 + 4*.15
  assert.equal(parsed.entries[0].leverage, 10.6);
  assert.equal(parsed.entries[1].rated, true);
});

test('Fehlende Rubrik-Werte gelten als unbewertet, nicht als 3/5', () => {
  const raw = JSON.stringify({ ranked: [{ agent: 'Arbeiter-1', impact: 8, effort: 2, nutzen: 4 }] });
  const parsed = parseRubric(raw, PROPOSALS);
  assert.equal(parsed.rated, false);
  assert.equal(parsed.entries[0].rated, false);
  assert.equal(parsed.entries[0].weighted, null);
  assert.deepEqual(parsed.entries[0].missing, ['machbarkeit', 'belegbarkeit', 'differenzierung']);
});

test('Werte ausserhalb der Skalen machen den Eintrag unbewertet', () => {
  const raw = JSON.stringify({ ranked: [good({ impact: 42 })] });
  const parsed = parseRubric(raw, PROPOSALS);
  assert.equal(parsed.entries[0].rated, false);
  assert.equal(parsed.entries[0].impact, null);
});

test('Kaputtes JSON und leere Antworten liefern rated:false mit Grund', () => {
  assert.deepEqual(parseRubric('kein json', PROPOSALS).rated, false);
  assert.match(parseRubric('kein json', PROPOSALS).reason, /kein gueltiges JSON/);
  assert.equal(parseRubric(JSON.stringify({ ranked: [] }), PROPOSALS).rated, false);
  assert.equal(parseRubric('', PROPOSALS).rated, false);
});

test('JSON hinter einem Codeblock wird trotzdem gelesen', () => {
  const raw = '```json\n' + JSON.stringify({ ranked: [good(), good({ agent: 'Arbeiter-2' })] }) + '\n```';
  const parsed = parseRubric(raw, PROPOSALS);
  assert.equal(parsed.rated, true);
  assert.equal(parsed.entries.length, 2);
});

test('Minderheitenvoten behalten Vorschlaege ausserhalb der Auswahl samt Begruendung', () => {
  const raw = JSON.stringify({
    ranked: [
      good(),
      good({ agent: 'Arbeiter-2', impact: 3, effort: 6, nutzen: 1, machbarkeit: 3, belegbarkeit: 2, differenzierung: 1 }),
    ],
  });
  const parsed = parseRubric(raw, PROPOSALS);
  const dissent = buildDissent(parsed.entries, { selectedAgents: ['Arbeiter-1'], threshold: 6 });
  assert.equal(dissent.length, 1);
  assert.equal(dissent[0].agent, 'Arbeiter-2');
  assert.equal(dissent[0].weakestDimension, 'nutzen');
  assert.match(dissent[0].reason, /schwaechste Dimension: nutzen/);
});

test('Unbewertete Vorschlaege bleiben als offener Vorschlag stehen', () => {
  const parsed = parseRubric('kein json', PROPOSALS);
  const dissent = buildDissent(
    PROPOSALS.map((p) => ({ agent: p.agent, rubric: {}, rated: false, missing: ['nutzen'], leverage: null })),
    { selectedAgents: [], threshold: 6 }
  );
  assert.equal(parsed.rated, false);
  assert.equal(dissent.length, 2);
  assert.match(dissent[0].reason, /nicht bewertet/);
});

test('summarizeScores gibt unbewertete Runden klar als solche aus', () => {
  assert.deepEqual(summarizeScores({ rated: false, reason: 'x', entries: [] }), { rated: false, reason: 'x', entries: [] });
  const summarized = summarizeScores(parseRubric(JSON.stringify({ ranked: [good(), good({ agent: 'A2' })] }), PROPOSALS));
  assert.equal(summarized.rated, true);
  assert.equal(summarized.entries[0].agent, 'Arbeiter-1');
});

test('Prompts nennen alle Rubrik-Dimensionen und verlangen JSON', () => {
  const sys = rubricSystemPrompt();
  for (const key of RUBRIC_KEYS) assert.ok(sys.includes(key), key);
  assert.match(sys, /NUR mit JSON/);
  assert.match(rubricUserPrompt(PROPOSALS), /1\. Arbeiter-1/);
});
