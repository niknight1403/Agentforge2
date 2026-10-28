import { createHash, timingSafeEqual } from 'node:crypto';
import { db } from './db.mjs';
import { publishRemoteCheckpoint, publishRuntimeCheckpoint } from './event-mesh.mjs';

db.exec(`CREATE TABLE IF NOT EXISTS agent_checkpoints (
  checkpoint_id TEXT PRIMARY KEY, task_id INTEGER NOT NULL, agent_id INTEGER NOT NULL,
  sequence INTEGER NOT NULL, parent_id TEXT, state_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, UNIQUE(task_id, agent_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_task ON agent_checkpoints(task_id, agent_id, sequence DESC);`);

const FORBIDDEN = /thought|reasoning|prompt|secret|token|password|credential|authorization/i;
function normalize(value, depth = 0) {
  if (depth > 16) throw new Error('Checkpoint state nesting is too deep.');
  if (value === null || ['string','number','boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(item => normalize(item, depth + 1));
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Checkpoint state must contain plain JSON data.');
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (FORBIDDEN.test(key)) throw new Error(`Checkpoint state cannot persist sensitive field: ${key}`);
    out[key] = normalize(value[key], depth + 1);
  }
  return out;
}
function digest(taskId, agentId, sequence, parentId, stateJson) {
  return createHash('sha256').update(`${taskId}\0${agentId}\0${sequence}\0${parentId || ''}\0${stateJson}`).digest('hex');
}
function validHash(actual, expected) {
  const a = Buffer.from(String(actual || ''), 'hex'); const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Persist a hash-linked checkpoint atomically in the existing transactional SQLite store. */
export function saveCheckpoint({ taskId, agentId, state, createdAt = Date.now() }) {
  if (!Number.isSafeInteger(taskId) || taskId < 1 || !Number.isSafeInteger(agentId) || agentId < 1) throw new Error('Valid taskId and agentId are required.');
  const stateJson = JSON.stringify(normalize(state));
  if (Buffer.byteLength(stateJson) > 64 * 1024) throw new Error('Checkpoint state exceeds 64 KiB.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = db.prepare('SELECT checkpoint_id,sequence FROM agent_checkpoints WHERE task_id=? AND agent_id=? ORDER BY sequence DESC LIMIT 1').get(taskId, agentId);
    const sequence = (previous?.sequence || 0) + 1;
    const parentId = previous?.checkpoint_id || null;
    const checkpointId = digest(taskId, agentId, sequence, parentId, stateJson);
    db.prepare('INSERT INTO agent_checkpoints(checkpoint_id,task_id,agent_id,sequence,parent_id,state_json,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(checkpointId, taskId, agentId, sequence, parentId, stateJson, createdAt);
    db.exec('COMMIT');
    const villaId=Number(db.prepare('SELECT villa_id FROM tasks WHERE id=?').get(taskId)?.villa_id||0);
    const checkpoint={ checkpointId, taskId, agentId, villaId, sequence, parentId, state: JSON.parse(stateJson), createdAt };
    void publishRemoteCheckpoint(checkpoint);
    void publishRuntimeCheckpoint(checkpoint).catch(()=>{});
    return checkpoint;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Verify every link and return the latest safe recovery point, or null on corruption. */
export function recoverCheckpoint(taskId, agentId) {
  const rows = db.prepare('SELECT checkpoint_id,sequence,parent_id,state_json,created_at FROM agent_checkpoints WHERE task_id=? AND agent_id=? ORDER BY sequence').all(taskId, agentId);
  let parentId = null; let latest = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.sequence !== i + 1 || row.parent_id !== parentId || !validHash(row.checkpoint_id, digest(taskId, agentId, row.sequence, parentId, row.state_json))) return null;
    let state; try { state = JSON.parse(row.state_json); } catch { return null; }
    latest = { checkpointId: row.checkpoint_id, sequence: row.sequence, parentId, state, createdAt: row.created_at };
    parentId = row.checkpoint_id;
  }
  return latest;
}
