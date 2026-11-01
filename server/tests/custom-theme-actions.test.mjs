import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAction } from '../master-control.mjs';

test('upsert_theme normalisiert die Theme-ID zu einem Slug und akzeptiert HEX-Farben', () => {
  const action = validateAction({
    type: 'upsert_theme',
    args: { id: 'Mein Theme 2026', title: 'Mein Theme', colors: { bg: '#0A0B0C', cyan: '#00E5FF' }, activate: true }
  });
  assert.equal(action.type, 'upsert_theme');
  assert.equal(action.args.id, 'mein-theme-2026');
  assert.deepEqual(action.args.colors, { bg: '#0a0b0c', cyan: '#00e5ff' });
  assert.equal(action.args.activate, true);
  assert.equal(action.args.title, 'Mein Theme');
});

test('upsert_theme weist ungueltige Farbwerte ab', () => {
  assert.throws(
    () => validateAction({ type: 'upsert_theme', args: { id: 'streng', colors: { bg: 'blau', cyan: '#00E5FF' } } }),
    /HEX-Wert/
  );
});

test('upsert_theme verlangt mindestens zwei Farben', () => {
  assert.throws(
    () => validateAction({ type: 'upsert_theme', args: { id: 'zu-wenig', colors: { bg: '#101010' } } }),
    /Mindestens zwei/
  );
});

test('upsert_theme verlangt eine verwendbare ID', () => {
  assert.throws(
    () => validateAction({ type: 'upsert_theme', args: { id: '!!!', colors: { bg: '#101010', cyan: '#00E5FF' } } }),
    /Theme-ID fehlt/
  );
});
