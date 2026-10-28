import { createServer } from 'node:http';

/** Deterministic local OpenAI-compatible fixture for browser tests; never used by production. */
export async function startMockLlm() {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !String(req.url || '').endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1_000_000) {
        res.writeHead(413).end();
        return;
      }
    }
    let body;
    try { body = JSON.parse(raw); } catch {
      res.writeHead(400).end();
      return;
    }
    const system = String(body.messages?.find((message) => message.role === 'system')?.content || '');
    const content = /umsetzbaren Entwicklungsplan/i.test(system)
      ? JSON.stringify({
        summary: 'Deterministischer Browser-Testplan mit implementierbaren Schritten.',
        tasks: [
          { role: 'ARCHITECT', title: 'Anforderungen ordnen', description: 'Strukturiere das Nutzerziel und dokumentiere überprüfbare Akzeptanzkriterien.' },
          { role: 'CODER', title: 'Kernablauf umsetzen', description: 'Implementiere den wichtigsten Nutzerfluss modular und mit klarer Fehlerbehandlung.' },
          { role: 'TESTER', title: 'Kernablauf verifizieren', description: 'Prüfe Erfolg, Leerzustand und Fehlerfall mit reproduzierbaren Tests.' }
        ]
      })
      : 'Nächster konkreter Schritt: Prüfe den Kernablauf im Browser und verifiziere Erfolg, Fehlerzustand und Rückkehr zur Übersicht.';
    const output = {
      id: 'villa-test-completion', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
      model: body.model || 'villa-test',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(output));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}
