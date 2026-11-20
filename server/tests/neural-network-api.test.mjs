import './_env.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'vf-neural-api-')), 'test.db');
process.env.PORT = String(43000 + Math.floor(Math.random() * 1000));
process.env.HOST = '127.0.0.1';

const { db, now } = await import('../db.mjs');
const { createUser, createSession } = await import('../auth.mjs');
const { server } = await import('../server.mjs');

let baseUrl;
let userToken;
let adminToken;
let villaId;

before(async () => {
  const user = createUser({ email: 'neural-api-user@example.test', password: 'test-password-123', role: 'USER' });
  const admin = createUser({ email: 'neural-api-admin@example.test', password: 'test-password-123', role: 'ADMIN' });
  userToken = createSession(user.id);
  adminToken = createSession(admin.id);
  const timestamp = now();
  villaId = Number(db.prepare(
    'INSERT INTO villas(name,idea,status,autonomy,max_agents,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
  ).run('API authorization test', 'Isolated endpoint test', 'PAUSED', 0, 10, timestamp, timestamp).lastInsertRowid);

  if (!server.listening) await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${process.env.PORT}`;
});

after(async () => {
  if (server.listening) await new Promise(resolve => server.close(resolve));
});

async function request(path, method = 'GET', token) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {})
    },
    ...(method === 'POST' ? { body: '{}' } : {})
  });
}

test('neural network status requires authentication', async () => {
  const response = await request(`/api/villas/${villaId}/neural-network`);
  assert.equal(response.status, 401);
});

test('non-admin users cannot read or mutate the neural network', async () => {
  const read = await request(`/api/villas/${villaId}/neural-network`, 'GET', userToken);
  const activate = await request(`/api/villas/${villaId}/neural-network/activate`, 'POST', userToken);
  const deactivate = await request(`/api/villas/${villaId}/neural-network/deactivate`, 'POST', userToken);
  assert.equal(read.status, 403);
  assert.equal(activate.status, 403);
  assert.equal(deactivate.status, 403);
  assert.equal(db.prepare('SELECT autonomy FROM villas WHERE id=?').get(villaId).autonomy, 0);
});

test('administrator can inspect network status without starting a run', async () => {
  const response = await request(`/api/villas/${villaId}/neural-network`, 'GET', adminToken);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.villa.id, villaId);
  assert.equal(db.prepare('SELECT autonomy FROM villas WHERE id=?').get(villaId).autonomy, 0);
});

test('administrator activation dispatches through the real scheduler and deactivation disables the Villa', async () => {
  const activate = await request(`/api/villas/${villaId}/neural-network/activate`, 'POST', adminToken);
  assert.equal(activate.status, 202);
  const activation = await activate.json();
  assert.equal(activation.accepted, true);
  assert.equal(activation.villa.id, villaId);
  assert.equal(db.prepare('SELECT autonomy FROM villas WHERE id=?').get(villaId).autonomy, 1);

  const deactivate = await request(`/api/villas/${villaId}/neural-network/deactivate`, 'POST', adminToken);
  assert.equal(deactivate.status, 200);
  const deactivation = await deactivate.json();
  assert.equal(deactivation.accepted, true);
  assert.equal(deactivation.villa.autonomy, false);
  assert.equal(db.prepare('SELECT autonomy FROM villas WHERE id=?').get(villaId).autonomy, 0);
});

test('administrator route rejects unexpected activation path segments', async () => {
  const response = await request(`/api/villas/${villaId}/neural-network/activate/extra`, 'POST', adminToken);
  assert.equal(response.status, 405);
  assert.equal(db.prepare('SELECT autonomy FROM villas WHERE id=?').get(villaId).autonomy, 0);
});
