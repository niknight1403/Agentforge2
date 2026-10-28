import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'swarm-'));
process.env.VF_DB = join(tmp, 'test.db');
process.env.VF_WORKSPACE = join(tmp, 'workspace');
const agents = await import('../agents.mjs');
const { db } = await import('../db.mjs');
agents._setPlanningChat(async () => ({ content: JSON.stringify({ summary: 'Swarm test', tasks: [{ title: 'Bootstrap', description: 'Accept: ready', role: 'CODER' }] }) }));

test('swarm validates execution contracts and rejects invalid role or oversized plans', () => {
  assert.throws(() => agents.normalizeSwarmBlueprint([{ title: 'x', goal: 'y', acceptance: 'z', role: 'ROOT' }]), /nicht delegierbar/);
  assert.throws(() => agents.normalizeSwarmBlueprint(Array.from({ length: 9 }, (_, i) => ({ title: `t${i}`, goal: 'g', acceptance: 'a', role: 'CODER' }))), /1 bis 8/);
  assert.throws(() => agents.normalizeSwarmBlueprint([{ title: 'x', goal: 'y', role: 'CODER' }]), /Abnahmekriterium/);
});

test('swarm atomically creates role-bound agents and tasks within villa capacity', async () => {
  const villa = await agents.createVilla({ name: 'Swarm', idea: 'A verified app', agentCount: 2 });
  db.prepare('UPDATE villas SET max_agents=4 WHERE id=?').run(villa.villaId);
  const args = { tasks: [
    { title: 'API bauen', goal: 'Implementiere Endpoint und Speicher', role: 'CODER', acceptance: 'Integrationstest belegt HTTP 200 und Persistenz', constraints: 'Keine Secrets im Quelltext', priority: 1 },
    { title: 'API prüfen', goal: 'Teste Endpoint einschließlich Fehlerfall', role: 'TESTER', acceptance: 'Test schlägt bei ungültigem Input erwartungsgemäß fehl', priority: 2 }
  ] };
  const failed = await agents.runTool({ villaId: villa.villaId, agentId: villa.rootId }, 'swarm_dispatch', args);
  assert.match(String(failed), /zurückgerollt/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tasks WHERE villa_id=? AND title IN (?,?)').get(villa.villaId, 'API bauen', 'API prüfen').c, 0);
  db.prepare('UPDATE villas SET max_agents=6 WHERE id=?').run(villa.villaId);
  const out = await agents.runTool({ villaId: villa.villaId, agentId: villa.rootId }, 'swarm_dispatch', args);
  assert.match(String(out), /^\{/, String(out));
  const result = JSON.parse(out);
  assert.equal(result.dispatched, 2);
  const rows = db.prepare('SELECT t.title,t.description,t.agent_id,a.role FROM tasks t JOIN agents a ON a.id=t.agent_id WHERE t.villa_id=? AND t.title IN (?,?) ORDER BY t.priority').all(villa.villaId, 'API bauen', 'API prüfen');
  assert.deepEqual(rows.map(r => r.role), ['CODER', 'TESTER']);
  assert.ok(rows.every(r => r.description.includes('Akzeptanz:') && r.description.includes('Liefervertrag:')));
  assert.equal(new Set(rows.map(r => r.agent_id)).size, 2);
});
