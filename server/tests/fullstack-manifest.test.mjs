import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveManifest, digestManifest, summarizeManifest, slugify,
  FULLSTACK_ROLES, FULLSTACK_STACK, FULLSTACK_MANIFEST_VERSION,
} from '../fullstack/manifest.mjs';

const PROMPT = 'Baue ein Rechnungs-Tool fuer Freelancer mit Kunden, Rechnungen, Preisen und einem Dashboard.';

test('Blueprint erkennt die genannten Domaenen und traegt feste Rollen', () => {
  const manifest = deriveManifest(PROMPT);
  const models = manifest.entities.map(entity => entity.model);
  assert.ok(models.includes('Customer'), 'Kunden fehlen: ' + models.join(','));
  assert.ok(models.includes('Invoice'), 'Rechnungen fehlen: ' + models.join(','));
  assert.deepEqual(manifest.roles, [...FULLSTACK_ROLES]);
  assert.equal(manifest.stack.auth, FULLSTACK_STACK.auth);
  assert.equal(manifest.version, FULLSTACK_MANIFEST_VERSION);
  assert.equal(manifest.name.length > 0, true);
});

test('dieselbe Eingabe ergibt denselben Blueprint, ohne den Prompt zu speichern', () => {
  const first = deriveManifest(PROMPT, { now: () => 1_700_000_000_000 });
  const second = deriveManifest(PROMPT, { now: () => 1_700_000_000_000 });
  assert.equal(first.digest, second.digest);
  assert.equal(first.digest, digestManifest(first));
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes(PROMPT), false, 'Der Auftragstext darf nicht im Blueprint landen');
  assert.ok(first.name.length <= 40, 'Der Produktname bleibt ein kurzer Titel');
  assert.equal(first.requestDigest.length, 64);
});

test('jede Domaene bekommt Schreibrechte nur fuer Manager und Admin, Loeschen nur fuer Admin', () => {
  const manifest = deriveManifest(PROMPT);
  for (const entity of manifest.entities) {
    const routes = manifest.routes.filter(route => route.entity === entity.model);
    const byAction = Object.fromEntries(routes.map(route => [route.action, route]));
    assert.equal(byAction.list.access, 'authenticated');
    assert.equal(byAction.read.access, 'authenticated');
    assert.deepEqual(byAction.create.roles, ['Manager', 'Admin']);
    assert.deepEqual(byAction.update.roles, ['Manager', 'Admin']);
    assert.deepEqual(byAction.delete.roles, ['Admin']);
  }
  const auth = manifest.routes.filter(route => route.access === 'public').map(route => route.path);
  assert.deepEqual(auth, ['/health', '/api/auth/register', '/api/auth/login']);
});

test('Preis-, Termin- und Mengenwuensche erzeugen passende Felder', () => {
  const manifest = deriveManifest('Verwalte Produkte mit Preis, Menge, Bild und einer Frist fuer die Lieferung.');
  const fields = manifest.entities[0].fields.map(field => field.name);
  for (const expected of ['price', 'quantity', 'imageUrl', 'dueAt']) {
    assert.ok(fields.includes(expected), expected + ' fehlt in ' + fields.join(','));
  }
});

test('Projekt-Domaene verankert die uebrigen Domaenen per projectId', () => {
  const manifest = deriveManifest('Ein Projektmanagement-Tool mit Projekten und Aufgaben.');
  const project = manifest.entities.find(entity => entity.model === 'Project');
  const task = manifest.entities.find(entity => entity.model === 'Task');
  assert.ok(project, 'Projekt-Domaene fehlt');
  assert.ok(task, 'Aufgaben-Domaene fehlt');
  assert.ok(task.fields.some(field => field.name === 'projectId' && field.reference === 'Project'));
});

test('ohne bekannte Domaene entsteht eine benannte Rueckfall-Domaene', () => {
  const manifest = deriveManifest('Ein Werkzeug fuer die Verwaltung von Wunschzetteln und Wunschlisten.');
  assert.ok(manifest.entities.length >= 1);
  assert.match(manifest.entities[0].model, /^[A-Z][A-Za-z0-9]*$/);
  assert.ok(manifest.entities[0].fields.some(field => field.name === 'title'));
});

test('zu kurze oder zu lange Auftraege werden abgelehnt', () => {
  assert.throws(() => deriveManifest('kurz'), error => error.code === 'FULLSTACK_PROMPT_TOO_SHORT');
  assert.throws(() => deriveManifest('x'.repeat(20_001)), error => error.code === 'FULLSTACK_PROMPT_TOO_LONG');
});

test('Zusammenfassung bleibt ein Metadaten-Satz fuer Events', () => {
  const manifest = deriveManifest(PROMPT);
  const summary = summarizeManifest(manifest);
  assert.equal(summary.blueprintDigest, manifest.digest);
  assert.equal(typeof summary.entities, 'number');
  assert.equal(Object.keys(summary).includes('entities'), true);
  assert.equal(JSON.stringify(summary).includes(PROMPT), false, 'Zusammenfassung enthaelt keinen Auftragstext');
});

test('Slug ist stabil, kleingeschrieben und ohne Umlaute', () => {
  assert.equal(slugify('Rechnungs-Tool für Früchte & Größe'), 'rechnungs-tool-fuer-fruechte-groesse');
  assert.equal(slugify(''), 'projekt');
});
