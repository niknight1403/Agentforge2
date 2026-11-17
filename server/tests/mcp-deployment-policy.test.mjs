import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpDeploymentPolicyProvider } from '../mcp-deployment-policy.mjs';

const realpath = (value) => ({
  '/usr/bin/node': '/usr/bin/node',
  '/srv/mcp': '/srv/mcp',
}[value] ?? value);

function server(overrides = {}) {
  return {
    id: 'server_1', command: '/usr/bin/node', cwd: '/srv/mcp',
    args: ['/srv/mcp/server.mjs'], config: { env: { NODE_ENV: 'production' } },
    ...overrides,
  };
}

test('deployment policy fails closed when no launch policy is configured', () => {
  const policyFor = createMcpDeploymentPolicyProvider({ env: {}, realpath });
  assert.throws(() => policyFor(server()), { code: 'MCP_LAUNCH_POLICY_NOT_CONFIGURED' });
});

test('deployment policy accepts only exact executable, cwd, env and argument allowlists', () => {
  const policyFor = createMcpDeploymentPolicyProvider({
    env: {
      MCP_STDIO_LAUNCH_POLICY_JSON: JSON.stringify({
        executables: [{
          path: '/usr/bin/node',
          workingDirectories: ['/srv/mcp'],
          allowedEnvironmentKeys: ['NODE_ENV'],
          allowedArgs: [['/srv/mcp/server.mjs']],
          credentialEnvKey: 'MCP_SERVER_TOKEN',
        }],
      }),
    },
    realpath,
  });
  const policy = policyFor(server());
  assert.deepEqual(policy.allowedExecutables, ['/usr/bin/node']);
  assert.deepEqual(policy.allowedWorkingDirectories, ['/srv/mcp']);
  assert.deepEqual(policy.allowedEnvironmentKeys, ['NODE_ENV', 'MCP_SERVER_TOKEN']);
  assert.equal(policy.validateArgs('/usr/bin/node', ['/srv/mcp/server.mjs']), true);
  assert.equal(policy.validateArgs('/usr/bin/node', ['--eval', 'process.exit()']), false);
  assert.equal(policy.credentialEnvKey, 'MCP_SERVER_TOKEN');
});

test('deployment policy rejects registry-supplied executables and duplicate policy entries', () => {
  const policyFor = createMcpDeploymentPolicyProvider({
    env: {
      MCP_STDIO_LAUNCH_POLICY_JSON: JSON.stringify({
        executables: [{
          path: '/usr/bin/node', workingDirectories: ['/srv/mcp'],
          allowedEnvironmentKeys: [], allowedArgs: [['/srv/mcp/server.mjs']],
        }],
      }),
    },
    realpath,
  });
  assert.throws(() => policyFor(server({ command: '/bin/sh' })), { code: 'MCP_EXECUTABLE_NOT_ALLOWED' });
  assert.throws(() => createMcpDeploymentPolicyProvider({
    env: { MCP_STDIO_LAUNCH_POLICY_JSON: JSON.stringify({ executables: [] , arbitrary: true }) },
    realpath,
  })()(server()), { code: 'MCP_LAUNCH_POLICY_INVALID' });
});

test('deployment policy rejects malformed paths and argument allowlists', () => {
  const policyFor = createMcpDeploymentPolicyProvider({
    env: {
      MCP_STDIO_LAUNCH_POLICY_JSON: JSON.stringify({
        executables: [{
          path: '/usr/bin/node', workingDirectories: [''],
          allowedEnvironmentKeys: [], allowedArgs: [['/srv/mcp/server.mjs']],
        }],
      }),
    },
    realpath,
  });
  assert.throws(() => policyFor(server()), { code: 'MCP_LAUNCH_POLICY_INVALID' });
});
