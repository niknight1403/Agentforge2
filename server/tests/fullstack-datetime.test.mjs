import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveManifest } from '../fullstack/manifest.mjs';
import { emitProject } from '../fullstack/emit.mjs';

/**
 * Regression fuer die Datumspruefung im erzeugten Projekt: die erste Fassung
 * akzeptierte ISO-Zeitstempel mit Millisekunden nicht, die zweite pruefte nur
 * die Form. Beides ist behoben; hier liegt die volle Akzeptanzmatrix.
 */
const workspace = mkdtempSync(join(tmpdir(), 'fs-date-'));
const manifest = deriveManifest('Verwalte Buchungen mit Buchungen, Kunden und einer Frist fuer die Lieferung.');
const emission = emitProject(manifest, join(workspace, 'app'));
const { validatePayload } = await import(join(emission.root, 'server/lib/validate.mjs'));

const schema = { dueAt: { type: 'datetime', required: false } };

function accepts(value) {
  try {
    validatePayload(schema, { dueAt: value });
    return true;
  } catch {
    return false;
  }
}

test('das erzeugte Projekt hat ein Datumsfeld', () => {
  const booking = manifest.entities[0];
  assert.ok(booking.fields.some(field => field.type === 'datetime'), 'kein Datumsfeld im Blueprint');
});

test('echte Tage und Zeitstempel werden angenommen', () => {
  for (const value of [
    '2026-01-15',
    '2026-01-15T10:00',
    '2026-01-15 10:00',
    '2026-01-15T10:00:30',
    '2026-01-15T10:00:30.123Z',
    '2026-01-15T10:00+02:00',
    '2026-01-15T10:00-05:00',
    '2028-02-29',
    '2026-01-15T10:00+14:00',
  ]) {
    assert.equal(accepts(value), true, value + ' wurde abgelehnt');
  }
});

test('unmoegliche Kalendertage werden abgelehnt', () => {
  for (const value of [
    '2026-02-29',
    '2026-02-31',
    '2026-04-31',
    '2026-13-01',
    '2026-00-10',
    '2026-01-00',
    '1900-02-29',
    '2100-02-29',
  ]) {
    assert.equal(accepts(value), false, value + ' wurde angenommen');
  }
});

test('Uhrzeit und Zeitzonenversatz werden geprueft', () => {
  for (const value of ['2026-01-15T24:00', '2026-01-15T23:60', '2026-01-15T10:00:60', '2026-01-15T10:00+14:30', '2026-01-15T10:00+15:00']) {
    assert.equal(accepts(value), false, value + ' wurde angenommen');
  }
});

test('andere Schreibweisen werden mit Feldhinweis abgelehnt', () => {
  for (const value of ['15.01.2026', '2026-1-5', '2026/01/15', 'morgen', '20260115']) {
    assert.equal(accepts(value), false, value + ' wurde angenommen');
  }
  try {
    validatePayload(schema, { dueAt: '31.12.2026' });
    assert.fail('ungueltige Eingabe wurde nicht abgelehnt');
  } catch (error) {
    assert.equal(error.status, 400);
    assert.equal(error.code, 'VALIDATION_FAILED');
    assert.match(error.details.dueAt, /gueltiges Datum/);
  }
});

test('leeres Feld bleibt bei optionalen Angaben erlaubt', () => {
  const value = validatePayload(schema, { dueAt: '' });
  assert.equal(value.dueAt, null);
});
