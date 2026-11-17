import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import { buildMcpPodmanRunSpec, probeMcpPodmanRootless } from './mcp-podman-rootless-runner.mjs';
import { createMcpProcessGroupTransport } from './mcp-process-group-transport.mjs';

function buildPodmanHostEnv(podmanPath, source = process.env) {
  const pathEntries = [path.dirname(podmanPath), '/usr/bin', '/bin'];
  const safe = {
    PATH: [...new Set(pathEntries)].join(path.delimiter),
    HOME: typeof source.HOME === 'string' && source.HOME.startsWith('/') ? source.HOME : '/',
  };
  for (const key of ['XDG_RUNTIME_DIR', 'TMPDIR']) {
    const value = source[key];
    if (typeof value === 'string' && value.startsWith('/') && !value.includes('\\0')) {
      safe[key] = value;
    }
  }
  return Object.freeze(safe);
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function runPodmanControl(command, args, {
  spawnProcess = spawn,
  timeoutMs = 3_000,
  env = process.env,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(code);
    };
    const timer = setTimeout(() => {
      try {
        if (Number.isInteger(child?.pid)) process.kill(-child.pid, 'SIGKILL');
        else child?.kill('SIGKILL');
      } catch { /* best effort */ }
      finish(fail('MCP_PODMAN_CONTROL_TIMEOUT', 'Podman cleanup command exceeded its deadline'));
    }, timeoutMs);
    timer.unref?.();
    try {
      child = spawnProcess(command, args, {
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: 'ignore',
        env,
      });
    } catch {
      finish(fail('MCP_PODMAN_CLEANUP_FAILED', 'Could not start the Podman cleanup command'));
      return;
    }
    child.once('error', () => finish(fail('MCP_PODMAN_CLEANUP_FAILED', 'Podman cleanup command failed to start')));
    child.once('close', (code) => finish(null, code));
  });
}

async function removeContainer(podmanPath, containerName, options) {
  const exists = await runPodmanControl(podmanPath, ['container', 'exists', containerName], options);
  if (exists === 0) {
    const removed = await runPodmanControl(podmanPath, ['rm', '--force', containerName], options);
    if (removed !== 0) {
      throw fail('MCP_PODMAN_CLEANUP_FAILED', 'Podman did not confirm forced removal of the MCP container');
    }
  } else if (exists !== 1) {
    throw fail('MCP_PODMAN_CLEANUP_FAILED', 'Podman could not determine whether the MCP container still exists');
  }
}

/**
 * MCP SDK transport backed by one rootless Podman container.
 * Container cleanup is explicit even when the attached Podman client exits
 * abnormally. The profile is deployment-owned and immutable.
 */
export function createMcpPodmanTransport({
  profile,
  podmanPath = '/usr/bin/podman',
  cwd = '/',
  env = process.env,
  spawnProcess = spawn,
  probe = probeMcpPodmanRootless,
  controlTimeoutMs = 3_000,
  shutdownTimeoutMs = 1_500,
  onProcessExit,
} = {}) {
  const spec = buildMcpPodmanRunSpec({ podmanPath, profile });
  if (typeof probe !== 'function') throw new TypeError('A rootless Podman capability probe is required');

  const hostEnv = buildPodmanHostEnv(podmanPath, env);
  const options = { spawnProcess, timeoutMs: controlTimeoutMs, env: hostEnv };
  const transport = createMcpProcessGroupTransport({
    command: spec.command,
    args: spec.args,
    cwd,
    env: hostEnv,
    spawnProcess,
    shutdownTimeoutMs,
    // Podman must own teardown of its rootless pause process; remove the named
    // container explicitly after stopping only the Podman CLI.
    killProcessGroupOnClose: false,
    // Capture stderr only for an allowlisted category; raw text is never logged or exposed.
    stderr: 'diagnostic',
    onProcessExit,
  });
  let started = false;
  let closePromise;
  let runtimeTimer;

  function clearRuntimeTimer() {
    if (runtimeTimer) clearTimeout(runtimeTimer);
    runtimeTimer = undefined;
  }

  function closeTransport() {
    if (closePromise) return closePromise;
    clearRuntimeTimer();
    closePromise = (async () => {
      let closeError;
      try {
        await transport.close();
      } catch (error) {
        closeError = error;
      }
      try {
        await removeContainer(podmanPath, spec.containerName, options);
      } catch (error) {
        if (!closeError) closeError = error;
      }
      if (closeError) throw closeError;
    })();
    return closePromise;
  }

  return Object.freeze({
    get onclose() { return transport.onclose; },
    set onclose(value) {
      transport.onclose = (...args) => {
        clearRuntimeTimer();
        value?.(...args);
      };
    },
    get onerror() { return transport.onerror; },
    set onerror(value) { transport.onerror = value; },
    get onmessage() { return transport.onmessage; },
    set onmessage(value) { transport.onmessage = value; },

    async start() {
      if (started) throw fail('MCP_PODMAN_TRANSPORT_ALREADY_STARTED', 'Podman MCP transport already started');
      const capability = await probe({ podmanPath, spawnProcess });
      if (capability?.available !== true || capability?.rootless !== true) {
        throw fail('MCP_PODMAN_NOT_ROOTLESS', 'A verified rootless Podman runtime is required');
      }
      await transport.start();
      started = true;
      runtimeTimer = setTimeout(() => {
        const error = fail('MCP_PODMAN_RUNTIME_TIMEOUT',
          'MCP Podman container exceeded its deployment-owned runtime deadline');
        transport.onerror?.(error);
        void closeTransport().catch((closeError) => transport.onerror?.(closeError));
      }, spec.timeoutMs);
    },

    send(message) {
      return transport.send(message);
    },

    close() {
      return closeTransport();
    },
  });
}
