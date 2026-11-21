import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

test('Free Route Hunter GET endpoint is registered once and exposes the complete status payload', () => {
  const registrations = source.match(/if\s*\(p\s*===\s*['"]\/api\/free-routes\/hunter['"]\s*&&\s*m\s*===\s*['"]GET['"]\)/g) || [];
  assert.equal(registrations.length, 1, 'duplicate route handlers make later status payloads unreachable');

  const routeIndex = source.indexOf(registrations[0]);
  const routeBody = source.slice(routeIndex, routeIndex + 900);
  assert.match(routeBody, /hunter:\s*hunterStatus\(\)/);
  assert.match(routeBody, /weekly:\s*weeklyReport\(\)/);
  assert.match(routeBody, /mediaTools:/);
});
