import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createMcpProcessGroupTransport } from '../mcp-process-group-transport.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readFile(file, 'utf8'); } catch { await delay(25); }
  }
  throw new Error('Timed out waiting for child PID file');
}

async function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(') ') + 2, stat.lastIndexOf(') ') + 3);
      return state !== 'Z' && state !== 'X';
    }
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH' && error?.code !== 'ENOENT';
  }
}

test('MCP process-group transport kills a SIGTERM-resistant grandchild on close', {
  skip: process.platform !== 'linux' && 'Process-group termination regression is Linux-only',
  timeout: 10_000,
}, async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'agentforge-mcp-process-group-'));
  const pidFile = path.join(cwd, 'grandchild.pid');
  const grandchildSource = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
  const parentSource = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { stdio: 'ignore' });
    fs.writeFileSync(process.env.PID_FILE, String(child.pid));
    setInterval(() => {}, 1000);
  `;
  const transport = createMcpProcessGroupTransport({
    command: process.execPath,
    args: ['-e', parentSource],
    cwd,
    env: { PID_FILE: pidFile },
    stderr: 'ignore',
    shutdownTimeoutMs: 200,
  });
  let grandchildPid;
  try {
    await transport.start();
    grandchildPid = Number(await waitForFile(pidFile));
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 1);
    assert.equal(await processIsRunning(grandchildPid), true);
    await transport.close();
    assert.equal(await processIsRunning(grandchildPid), false, 'grandchild must not survive transport close');
  } finally {
    try { await transport.close(); } catch {
      if (grandchildPid) { try { process.kill(grandchildPid, 'SIGKILL'); } catch {} }
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test('MCP process-group transport rejects Windows until Job Object teardown exists', () => {
  assert.throws(() => createMcpProcessGroupTransport({
    command: 'node', args: [], cwd: process.cwd(), env: {}, platform: 'win32',
  }), { code: 'MCP_PROCESS_GROUP_UNSUPPORTED' });
});
