import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../util/errors.js';
import { describeRegistry } from '../tools/registry.js';

const reminderSchema = z.object({
  fire_at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'fire_at must be ISO-8601'),
  message: z.string().min(1).max(1000),
  workflow_id: z.string().uuid().optional(),
});

export function reminderRoutes({ repo }) {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res, next) => {
    try {
      res.json({ reminders: await repo.listReminders(req.user.id) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const parsed = reminderSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError('A reminder needs a message and a time.', {
          code: 'VALIDATION_FAILED',
          status: 422,
          details: parsed.error.issues.map((i) => i.message),
        });
      }
      const reminder = await repo.createReminder({
        userId: req.user.id,
        workflowId: parsed.data.workflow_id ?? null,
        fireAt: parsed.data.fire_at,
        payload: { message: parsed.data.message },
      });
      res.status(201).json({ reminder });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const all = await repo.listReminders(req.user.id);
      if (!all.some((r) => r.id === req.params.id)) {
        throw new AppError('Reminder not found', { code: 'NOT_FOUND', status: 404 });
      }
      // Cancel, don't delete: the reminder may be referenced by a workflow step's history.
      const reminder = await repo.updateReminder(req.params.id, { status: 'cancelled' });
      res.json({ reminder });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** Read-only view of what the system can do and what this deployment has granted. */
export function toolRoutes({ repo }) {
  const router = Router();
  router.get('/', async (_req, res, next) => {
    try {
      const permissions = await repo.getToolPermissions();
      res.json({
        catalogue: describeRegistry().map((a) => ({
          ...a,
          granted: (permissions[a.tool_name] || []).includes(a.action),
        })),
        permissions,
      });
    } catch (err) {
      next(err);
    }
  });
  return router;
}

export default reminderRoutes;
