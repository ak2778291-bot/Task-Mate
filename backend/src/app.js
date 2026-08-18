import express from 'express';
import cors from 'cors';
import config from './config.js';
import { authRoutes } from './routes/auth.js';
import { workflowRoutes } from './routes/workflows.js';
import { reminderRoutes, toolRoutes } from './routes/reminders.js';
import { createToolLayer } from './tools/index.js';
import { createOrchestrator } from './engine/orchestrator.js';
import { createExecutor } from './engine/executor.js';
import { createPlanner } from './planner/planner.js';
import logger from './util/logger.js';

/**
 * Dependencies are parameters, not imports, so tests assemble the same app over an
 * in-memory repository and a stub planner without touching Postgres, Google or the LLM.
 */
export function createApp({ repo, planner, tools, orchestrator, executor, log = logger } = {}) {
  if (!repo) throw new Error('createApp requires a repository');

  const toolLayer = tools || createToolLayer({ repo, log });
  const planLayer = planner || createPlanner();
  const orch = orchestrator || createOrchestrator({ repo, planner: planLayer, log });
  const exec = executor || createExecutor({ repo, tools: toolLayer, log });

  const app = express();
  app.use(cors({ origin: config.corsOrigin.split(',') }));
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) =>
    res.json({ ok: true, google: config.mockGoogle ? 'mock' : 'live', planner: planLayer.kind }),
  );

  app.use('/auth', authRoutes({ repo }));
  app.use('/workflows', workflowRoutes({ repo, orchestrator: orch, executor: exec }));
  app.use('/reminders', reminderRoutes({ repo }));
  app.use('/tools', toolRoutes({ repo }));

  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } }));

  // Errors carry a machine-readable code so the UI can say something specific.
  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) log.error('request.failed', { error: err.message, stack: err.stack });
    res.status(status).json({
      error: {
        code: err.code || 'INTERNAL',
        message: status >= 500 ? 'Something went wrong on our side.' : err.message,
        details: err.details,
      },
    });
  });

  app.locals.deps = { repo, tools: toolLayer, planner: planLayer, orchestrator: orch, executor: exec };
  return app;
}

export default createApp;
