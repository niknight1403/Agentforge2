import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import process from 'node:process';

const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once('exit', onExit);
  });
}

function processGroupExists(pid) {
  // On Linux, kill(-pgid, 0) also reports zombie-only groups as present.
  // Zombies cannot execute; inspect /proc so a reaped process tree is not
  // misreported as a live descendant after SIGKILL.
  if (process.platform === 'linux') {
    try {
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
          const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
          const state = fields[0];
          const processGroupId = Number(fields[2]);
          if (processGroupId === pid && state !== 'Z' && state !== 'X') return true;
        } catch { /* process exited while /proc was scanned */ }
      }
      return false;
    } catch { /* fall back to kill(0) when /proc is unavailable */ }
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function waitForGroupGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) return true;
    await delay(25);
  }
  return !processGroupExists(pid);
}

/**
 * POSIX stdio transport for the official MCP Client.
 *
 * Unlike the SDK's stock StdioClientTransport, this starts the executable as a
 * detached process-group leader and terminates the complete group on close.
 * Keep Windows disabled until equivalent Job Object handling is implemented.
 */
export function createMcpProcessGroupTransport({
  command,
  args = [],
  cwd,
  env,
  stderr = 'inherit',
  maxBufferSize = DEFAULT_MAX_BUFFER_BYTES,
  shutdownTimeoutMs = 1_500,
  spawnProcess = spawn,
  platform = process.platform,
} = {}) {
  if (platform === 'win32') {
    throw fail('MCP_PROCESS_GROUP_UNSUPPORTED', 'MCP stdio process-group isolation is not implemented on Windows');
  }
  if (typeof command !== 'string' || !command || !Array.isArray(args)
    || args.some((arg) => typeof arg !== 'string')
    || typeof cwd !== 'string' || !cwd
    || !env || typeof env !== 'object' || Array.isArray(env)
    || !Number.isInteger(maxBufferSize) || maxBufferSize < 1024
    || !Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 100 || shutdownTimeoutMs > 10_000
    || typeof spawnProcess !== 'function') {
    throw new TypeError('command, args, cwd, env and bounded transport options are required');
  }

  let child = null;
  let started = false;
  let closing = false;
  let closePromise = null;
  let buffer = '';
  const decoder = new StringDecoder('utf8');

  const transport = {
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,

    async start() {
      if (child) throw new Error('MCP process-group transport already started');
      child = spawnProcess(command, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', stderr],
        shell: false,
        windowsHide: true,
        detached: true,
      });

      await new Promise((resolve, reject) => {
        let settled = false;
        const onSpawn = () => {
          started = true;
          settled = true;
          resolve();
        };
        const onError = (error) => {
          if (!settled) {
            settled = true;
            reject(error);
          } else {
            transport.onerror?.(error);
          }
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
      });

      child.stdout.on('data', (chunk) => {
        if (closing) return;
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer, 'utf8') > maxBufferSize && !buffer.includes('\n')) {
          transport.onerror?.(fail('MCP_STDIO_BUFFER_LIMIT', 'MCP stdio message exceeded the configured buffer limit'));
          void transport.close().catch(() => {});
          return;
        }
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          if (Buffer.byteLength(line, 'utf8') > maxBufferSize) {
            transport.onerror?.(fail('MCP_STDIO_BUFFER_LIMIT', 'MCP stdio message exceeded the configured buffer limit'));
            void transport.close().catch(() => {});
            return;
          }
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            transport.onerror?.(fail('MCP_STDIO_INVALID_MESSAGE', 'MCP stdio emitted invalid JSON'));
            continue;
          }
          transport.onmessage?.(message);
        }
      });
      child.stdout.on('error', (error) => transport.onerror?.(error));
      child.stdin.on('error', (error) => {
        if (!closing && error?.code !== 'EPIPE') transport.onerror?.(error);
      });
      child.once('exit', () => {
        if (!closing) {
          transport.onclose?.();
          // Unexpected parent exit must not leave descendants in its group.
          void terminateGroup(child.pid, child).catch((error) => transport.onerror?.(error));
        }
      });
    },

    async send(message) {
      if (!started || closing || !child?.stdin || child.stdin.destroyed) {
        throw fail('MCP_PROCESS_NOT_CONNECTED', 'MCP stdio process is not connected');
      }
      const payload = JSON.stringify(message) + '\n';
      await new Promise((resolve, reject) => {
        child.stdin.write(payload, 'utf8', (error) => error ? reject(error) : resolve());
      });
    },

    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        if (!child) return;
        const processId = child.pid;
        try { child.stdin?.end(); } catch { /* best effort */ }
        await waitForExit(child, 300);
        await terminateGroup(processId, child);
        try { child.stdout?.destroy(); } catch { /* best effort */ }
        try { child.stdin?.destroy(); } catch { /* best effort */ }
        try { child.stderr?.destroy(); } catch { /* best effort */ }
        buffer = '';
      })();
      return closePromise;
    },
  };

  async function terminateGroup(pid, processHandle) {
    if (!Number.isInteger(pid) || pid <= 1) return;
    if (processGroupExists(pid)) {
      signalProcessGroup(pid, 'SIGTERM');
      await waitForGroupGone(pid, shutdownTimeoutMs);
    }
    if (processGroupExists(pid)) {
      signalProcessGroup(pid, 'SIGKILL');
      await Promise.race([waitForExit(processHandle, shutdownTimeoutMs), delay(shutdownTimeoutMs)]);
    }
    if (processGroupExists(pid)) {
      throw fail('MCP_PROCESS_GROUP_TERMINATION_UNCONFIRMED', 'MCP process group still exists after SIGKILL');
    }
  }

  return transport;
}
