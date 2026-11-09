import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationTaskExecutor } from '../GenerationTaskExecutor.js';

test('generation executor submits a prompt and waits for the terminal result', async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url=String(input); calls.push(url);
    if(url.endsWith('/internal/mesh/generate')) return new Response(JSON.stringify({status:'ACCEPTED'}),{status:202});
    return new Response(JSON.stringify({status:'COMPLETED',result:{workspace:'server/data/generated/task-1',build:'passed',tests:'passed'},checkpoints:[{stage:'PROJECT_PLANNED',metadata:{files:8}},{stage:'SCAFFOLD_GENERATED',metadata:{files:8}},{stage:'CONTAINER_TEST_PASSED',metadata:{build:'passed',tests:'passed'}}]}),{status:200});
  };
  const executor=createGenerationTaskExecutor({hubUrl:'http://127.0.0.1:12000',token:'x'.repeat(40),fetcher});
  const result=await executor.execute({kind:'project.generate',prompt:'Build a small CRM',projectId:'crm-1'},{
    taskId:'00000000-0000-4000-8000-000000000001',attempt:1,signal:new AbortController().signal
  });
  assert.equal(calls.length,2);
  assert.equal(result.steps.length,3);
  assert.equal(result.steps[0]?.toolName,'generation.project_planned');
  assert.deepEqual(result.result,{workspace:'server/data/generated/task-1',build:'passed',tests:'passed'});
});

test('generation executor rejects malformed task payloads', async () => {
  const executor=createGenerationTaskExecutor({hubUrl:'http://127.0.0.1:12000',token:'x'.repeat(40)});
  await assert.rejects(()=>executor.execute({kind:'project.generate',prompt:''},{
    taskId:'00000000-0000-4000-8000-000000000001',attempt:1,signal:new AbortController().signal
  }),/Invalid project generation task input/);
});
