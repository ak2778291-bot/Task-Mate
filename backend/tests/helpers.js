import { createMemoryRepository } from '../src/db/repository.memory.js';
import { createToolLayer } from '../src/tools/index.js';
import { createExecutor } from '../src/engine/executor.js';
import { createOrchestrator } from '../src/engine/orchestrator.js';
import { createMockGoogle } from '../src/tools/mock-google.js';

export const silentLog = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return silentLog; },
};

/**
 * Builds a fresh executor over an existing repository and Google facade.
 * This is what a process restart looks like: new in-memory objects, same persisted state.
 */
export function rebuildExecutor({ repo, google, hooks = {} }) {
  const tools = createToolLayer({ repo, googleFactory: async () => google, log: silentLog });
  return createExecutor({
    repo,
    tools,
    log: silentLog,
    hooks,
    retryOptions: { attempts: 3, baseMs: 1, sleepFn: async () => {} },
  });
}

/** Assembles the real engine over an in-memory repo and the fake Google. */
export function buildSystem({ planner, hooks = {}, google = createMockGoogle() } = {}) {
  const repo = createMemoryRepository();
  const tools = createToolLayer({ repo, googleFactory: async () => google, log: silentLog });
  const executor = rebuildExecutor({ repo, google, hooks });
  const orchestrator = planner ? createOrchestrator({ repo, planner, log: silentLog }) : null;
  return { repo, tools, executor, orchestrator, google };
}

/** A planner that returns a fixed plan — stands in for the LLM's structured output. */
export function fixedPlanner(plan) {
  return { kind: 'fixed', async plan() { return typeof plan === 'function' ? plan() : plan; } };
}

export async function seedUser(repo, email = 'demo@example.com') {
  return repo.createUser({ email, passwordHash: 'not-a-real-hash' });
}

export const iso = (offsetHours = 24) =>
  new Date(Date.now() + offsetHours * 3600_000).toISOString();
