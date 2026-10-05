import './_env.mjs';
/**
 * Adaptive Batching: Die Parallelitaet der Orchestrierung koppelt an die
 * Anzahl gerade nutzbarer ECHTER Routen (readyRealRoutes).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readyRealRoutes, enabledRoutes } from '../llm.mjs';
import { seedRoutes } from '../seed.mjs';

seedRoutes();
import { db } from '../db.mjs';

function setSecret(name, value) {
  db.prepare('INSERT INTO secrets (name, value, updated_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(name, value, Date.now());
}

test('readyRealRoutes: zahlt nur echte, nicht gesperrte Routen', () => {
  const rows = enabledRoutes();
  const real = rows.filter((r) => r.provider !== 'offline' && r.priority < 50);
  assert.ok(real.length >= 1, 'Test braucht mindestens eine echte Route');

  // Alle echten Routen mit Test-Keys versorgen, damit sie als nutzbar gelten.
  for (const r of real) {
    if (r.key_env) setSecret(r.key_env, `test-key-${r.id}`);
  }
  // Grundzustand: ungesperrte echte Routen werden gezaehlt.
  const base = readyRealRoutes();
  assert.ok(base >= 1 && base <= real.length, `Zahl zwischen 1 und ${real.length}, war ${base}`);

  // Eine echte Route in den Cooldown schicken: Zahl sinkt um 1.
  const victim = real[0];
  const until = Date.now() + 120_000;
  db.prepare('UPDATE routes SET cooldown_until = ? WHERE id = ?').run(until, victim.id);
  const after = readyRealRoutes();
  assert.equal(after, Math.max(0, base - 1), 'Cooldown muss die Zahl um genau 1 senken');
  // Cooldown aufheben (1s in der Zukunft reicht fuer den Zeitvergleich nicht:
  // jetzt() liefert ms, also sauber zuruecksetzen).
  db.prepare('UPDATE routes SET cooldown_until = 0 WHERE id = ?').run(victim.id);
  assert.equal(readyRealRoutes(), base, 'Ohne Cooldown ist die Zahl zurueck');

  // Offline-Planer zaehlt nie mit.
  const offline = rows.find((r) => r.provider === 'offline' || r.priority >= 50);
  if (offline) {
    assert.ok(!real.some((r) => r.id === offline.id), 'Offline-Route ist keine echte Route');
  }
});

test('readyRealRoutes: nie groesser als die Zahl echter Routen', () => {
  const real = enabledRoutes().filter((r) => r.provider !== 'offline' && r.priority < 50).length;
  assert.ok(readyRealRoutes() <= real, 'Kann nicht mehr bereit sein als echt existieren');
});
