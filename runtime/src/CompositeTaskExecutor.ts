import type { TaskExecutor } from './AgentWorker.js';
import { createHubTaskExecutor } from './HubTaskExecutor.js';
import { createGenerationTaskExecutor } from './GenerationTaskExecutor.js';

export function createCompositeTaskExecutor(options: { hubUrl:string; token:string; fetcher?:typeof fetch }): TaskExecutor {
  const hub = createHubTaskExecutor(options);
  const generation = createGenerationTaskExecutor(options);
  return {
    execute(input, context) {
      const kind = input && typeof input === 'object' && !Array.isArray(input)
        ? (input as {kind?:unknown}).kind : undefined;
      return kind === 'project.generate' ? generation.execute(input,context) : hub.execute(input,context);
    }
  };
}
