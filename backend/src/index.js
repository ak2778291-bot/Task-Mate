import config from './config.js';
import { createApp } from './app.js';
import { createPgRepository } from './db/repository.pg.js';
import { createMemoryRepository } from './db/repository.memory.js';
import { createToolLayer } from './tools/index.js';
import { createExecutor } from './engine/executor.js';
import { createOrchestrator } from './engine/orchestrator.js';
import { createPlanner } from './planner/planner.js';
import { createScheduler } from './scheduler/scheduler.js';
import { migrate } from './db/migrate.js';
import { closePool } from './db/pool.js';
import logger from './util/logger.js';

async function main() {
  let repo;
  try {
    repo = createPgRepository();
    await migrate();
    logger.info('db.ready', { kind: 'postgres' });
  } catch (err) {
    if (process.env.ALLOW_MEMORY_FALLBACK === '1') {
      logger.warn('db.fallback_memory', { error: err.message });
      repo = createMemoryRepository();
    } else {
      throw err;
    }
  }

  const tools = createToolLayer({ repo });
  const planner = createPlanner();
  const executor = createExecutor({ repo, tools });
  const orchestrator = createOrchestrator({ repo, planner });
  const app = createApp({ repo, tools, planner, executor, orchestrator });

  // A restart is the most common "crash" in practice, so sweep before serving traffic.
  await executor.resumeInterrupted().catch((err) => logger.error('resume.sweep_failed', { error: err.message }));

  const scheduler = createScheduler({ repo, executor });
  scheduler.start();

  const server = app.listen(config.port, () =>
    logger.info('server.listening', {
      port: config.port,
      env: config.env,
      planner: planner.kind,
      google: config.mockGoogle ? 'mock' : 'live',
    }),
  );

  const shutdown = (signal) => {
    logger.info('server.shutdown', { signal });
    scheduler.stop();
    server.close(async () => {
      await closePool().catch(() => {});
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('server.boot_failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
