import './_env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

// The production deploy runs the full test suite on a constrained hub.
// Reusing the isolated test process avoids a second full Hub startup, which
// previously timed out after 15 s under load despite the HTTP route working.
process.env.HOST = '127.0.0.1';
process.env.PORT = String(37000 + Math.floor(Math.random() * 2000));
process.env.VF_RESUME = '0';
process.env.VF_OPEN_MODE = '1';
process.env.OPENHANDS_CANVAS_URL = 'https://canvas.example.test/canvas#private-fragment';

const { server } = await import('../server.mjs');
if (!server.listening) await once(server, 'listening');
const addr = server.address();
const base = `http://127.0.0.1:${addr.port}`;

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('OpenHands Canvas integration endpoint returns a sanitized, configured browser URL', async () => {
  const response = await fetch(`${base}/api/integrations/openhands`, {signal:AbortSignal.timeout(10000)});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    enabled: true,
    url: 'https://canvas.example.test/canvas',
    state: 'configured'
  });
});

test('open mode never grants anonymous LLM route mutation privileges', async () => {
  const create = await fetch(`${base}/api/routes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', keyEnv: 'GROQ_API_KEY' })
  });
  assert.equal(create.status, 403);
  const update = await fetch(`${base}/api/routes/1`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true })
  });
  assert.equal(update.status, 403);
  const remove = await fetch(`${base}/api/routes/1`, { method: 'DELETE' });
  assert.equal(remove.status, 403);
});
