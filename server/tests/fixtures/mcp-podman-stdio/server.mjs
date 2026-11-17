import readline from 'node:readline';

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'agentforge-podman-fixture', version: '1.0.0' },
      },
    }) + '\n');
  } else if (message.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: message.id,
      result: { tools: [{
        name: 'healthcheck',
        description: 'Returns a fixture health response',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      }, {
        name: 'crash',
        description: 'Terminates the fixture process to exercise cleanup',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      }] },
    }) + '\n');
  } else if (message.method === 'tools/call' && message.params?.name === 'crash') {
    process.exit(23);
  } else if (message.method === 'tools/call') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: message.id,
      result: { content: [{ type: 'text', text: 'rootless-podman-ok' }], isError: false },
    }) + '\n');
  }
}
