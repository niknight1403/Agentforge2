import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMcpSharedNamespaceOptIn } from '../mcp-isolation-policy.mjs';

test('MCP stdio fails closed when per-server isolation is absent', () => {
  assert.throws(
    () => assertMcpSharedNamespaceOptIn({ env: {} }),
    { code: 'MCP_PER_SERVER_ISOLATION_REQUIRED' },
  );
});

test('MCP stdio requires the exact explicit shared-namespace acknowledgement', () => {
  for (const value of ['TRUE', '1', 'yes', 'false', undefined]) {
    assert.throws(
      () => assertMcpSharedNamespaceOptIn({ env: { MCP_STDIO_ALLOW_SHARED_HUB_NAMESPACE: value } }),
      { code: 'MCP_PER_SERVER_ISOLATION_REQUIRED' },
    );
  }
});

test('explicit shared namespace opt-in remains visibly non-isolated and trusted-only', () => {
  assert.deepEqual(
    assertMcpSharedNamespaceOptIn({ env: { MCP_STDIO_ALLOW_SHARED_HUB_NAMESPACE: 'true' } }),
    { mode: 'shared-hub-namespace', isolatedPerServer: false, untrustedServersAllowed: false },
  );
});
