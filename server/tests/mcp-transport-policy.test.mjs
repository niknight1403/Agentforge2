import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateStdioLaunch, validateRemoteEndpoint } from '../mcp-transport-policy.mjs';

const stdioPolicy = {
  realpath: (value) => path.resolve(value),
  allowedExecutables: ['/usr/bin/node'],
  allowedWorkingDirectories: ['/srv/mcp-sandboxes'],
  allowedEnvironmentKeys: ['LANG', 'PATH'],
  validateArgs: (_command, args) => args.length === 1 && args[0] === '/srv/mcp-sandboxes/demo/server.mjs',
};

test('stdio policy accepts only allowlisted executable, sandbox cwd, argv and env', () => {
  const result = validateStdioLaunch({
    command: '/usr/bin/node',
    args: ['/srv/mcp-sandboxes/demo/server.mjs'],
    cwd: '/srv/mcp-sandboxes/demo',
    env: { LANG: 'C.UTF-8' },
  }, stdioPolicy);
  assert.equal(result.shell, false);
  assert.deepEqual(result.args, ['/srv/mcp-sandboxes/demo/server.mjs']);
});

test('stdio policy rejects relative or non-allowlisted executables', () => {
  assert.throws(() => validateStdioLaunch({ command: 'node', cwd: '/srv/mcp-sandboxes/demo' }, stdioPolicy), { code: 'MCP_EXECUTABLE_NOT_ABSOLUTE' });
  assert.throws(() => validateStdioLaunch({ command: '/bin/sh', cwd: '/srv/mcp-sandboxes/demo' }, stdioPolicy), { code: 'MCP_EXECUTABLE_NOT_ALLOWED' });
});

test('stdio policy rejects sandbox escapes, unsafe argv and unapproved environment keys', () => {
  assert.throws(() => validateStdioLaunch({ command: '/usr/bin/node', cwd: '/tmp', args: ['/srv/mcp-sandboxes/demo/server.mjs'] }, stdioPolicy), { code: 'MCP_WORKDIR_NOT_ALLOWED' });
  assert.throws(() => validateStdioLaunch({ command: '/usr/bin/node', cwd: '/srv/mcp-sandboxes/demo', args: ['--eval=process.exit()'] }, stdioPolicy), { code: 'MCP_ARGUMENT_POLICY_REJECTED' });
  assert.throws(() => validateStdioLaunch({ command: '/usr/bin/node', cwd: '/srv/mcp-sandboxes/demo', args: ['/srv/mcp-sandboxes/demo/server.mjs'], env: { API_TOKEN: 'secret' } }, stdioPolicy), { code: 'MCP_ENV_KEY_NOT_ALLOWED' });
});

const remotePolicy = {
  allowedHosts: ['mcp.example.test'],
  allowedPorts: [443],
  allowedResolvedAddresses: ['203.0.113.10'],
};

test('remote policy returns an explicit pinned address set for the transport', () => {
  const result = validateRemoteEndpoint({
    url: 'https://mcp.example.test/mcp',
    resolvedAddresses: ['203.0.113.10'],
  }, remotePolicy);
  assert.deepEqual(result.pinnedAddresses, ['203.0.113.10']);
  assert.equal(result.port, 443);
});

test('remote policy rejects insecure schemes, unapproved hosts and unpinned DNS answers', () => {
  assert.throws(() => validateRemoteEndpoint({ url: 'http://mcp.example.test', resolvedAddresses: ['203.0.113.10'] }, remotePolicy), { code: 'MCP_REMOTE_SCHEME_REJECTED' });
  assert.throws(() => validateRemoteEndpoint({ url: 'https://other.example.test', resolvedAddresses: ['203.0.113.10'] }, remotePolicy), { code: 'MCP_REMOTE_HOST_NOT_ALLOWED' });
  assert.throws(() => validateRemoteEndpoint({ url: 'https://mcp.example.test', resolvedAddresses: ['198.51.100.7'] }, remotePolicy), { code: 'MCP_RESOLVED_ADDRESS_NOT_ALLOWED' });
  assert.throws(() => validateRemoteEndpoint({ url: 'https://mcp.example.test' }, remotePolicy), { code: 'MCP_DNS_RESULT_REQUIRED' });
});
