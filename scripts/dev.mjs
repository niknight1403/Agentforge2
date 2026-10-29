import {existsSync} from 'node:fs';
const args = process.argv.slice(2);
const value = (name, fallback) => {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

process.env.HOST = value('--host', process.env.HOST || '127.0.0.1');
process.env.PORT = value('--port', process.env.PORT || '12000');
if(process.env.VF_PREVIEW_FIXTURE==='1'||existsSync(new URL('../.vf-preview-fixture',import.meta.url))){
  process.env.VF_PREVIEW_FIXTURE='1';
  const {startMockLlm}=await import('./lib/mock-llm.mjs');
  const fixture=await startMockLlm();
  for(const key of Object.keys(process.env))if(/^(GROQ|GEMINI|GOOGLE|CEREBRAS|MISTRAL|OPENROUTER|XAI|HUGGINGFACE|HF_TOKEN).*KEY|^HF_TOKEN$/.test(key))delete process.env[key];
  process.env.VF_LOCAL_LLM_URL=fixture.url;process.env.VF_LOCAL_LLM_MODEL='villa-test';
  console.log('VORSCHAU: deterministisches lokales Modell-Fixture, kein Produktionsnachweis.');
  process.once('SIGTERM',()=>{void fixture.close();});
}
await import('../server/server.mjs');
