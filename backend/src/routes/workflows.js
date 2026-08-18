import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../util/errors.js';

const requestSchema = z.object({
  request: z.string().min(3).max(2000),
  timezone: z.string().max(64).optional(),
});

export function workflowRoutes({ repo, orchestrator, executor }) {
  const router = Router();
  router.use(requireAuth);

  async function ownedWorkflow(req) {
    const workflow = await repo.getWorkflow(req.params.id);
    // 404 rather than 403 for someone else's workflow — don't confirm it exists.
    if (!workflow || workflow.user_id !== req.user.id) {
      throw new AppError('Workflow not found', { code: 'NOT_FOUND', status: 404 });
    }
    return workflow;
  }

  const view = (workflow, steps) => ({
    ...workflow,
    steps: steps.map((s) => ({
      id: s.id,
      step_order: s.step_order,
      tool_name: s.tool_name,
      action: s.action,
      action_payload: s.action_payload,
      status: s.status,
      requires_confirmation: s.requires_confirmation,
      external_ref_id: s.external_ref_id,
      error_message: s.error_message,
      attempts: s.attempts,
      executed_at: s.executed_at,
    })),
  });

  /** Plan only. Reversible plans still wait for POST /:id/confirm so the user always sees
   *  what will run before it runs — the plan is a proposal, not a commitment. */
  router.post('/', async (req, res, next) => {
    try {
      const parsed = requestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError('Tell me what you want done, in a sentence.', {
          code: 'VALIDATION_FAILED',
          status: 422,
          details: parsed.error.issues.map((i) => i.message),
        });
      }
      const result = await orchestrator.planWorkflow({
        userId: req.user.id,
        requestText: parsed.data.request,
        timezone: parsed.data.timezone || 'UTC',
      });
      res.status(result.ok ? 201 : 422).json({
        workflow: view(result.workflow, result.steps),
        summary: result.summary ?? null,
        requires_confirmation: result.requiresConfirmation,
        violations: result.violations,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/confirm', async (req, res, next) => {
    try {
      const workflow = await ownedWorkflow(req);
      if (!['planned', 'awaiting_confirmation'].includes(workflow.status)) {
        throw new AppError(`This workflow is ${workflow.status} and cannot be confirmed.`, {
          code: 'INVALID_STATE',
          status: 409,
        });
      }
      const run = await executor.runWorkflow({ workflowId: workflow.id, confirmed: true });
      const [updated, steps] = await Promise.all([
        repo.getWorkflow(workflow.id),
        repo.listSteps(workflow.id),
      ]);
      res.json({ workflow: view(updated, steps), run });
    } catch (err) {
      next(err);
    }
  });

  /** Resume after a failure or crash. Same pass as confirm — executed steps are skipped. */
  router.post('/:id/resume', async (req, res, next) => {
    try {
      const workflow = await ownedWorkflow(req);
      const run = await executor.resumeWorkflow({ workflowId: workflow.id, confirmed: true });
      const [updated, steps] = await Promise.all([
        repo.getWorkflow(workflow.id),
        repo.listSteps(workflow.id),
      ]);
      res.json({ workflow: view(updated, steps), run });
    } catch (err) {
      next(err);
    }
  });

  router.get('/', async (req, res, next) => {
    try {
      const workflows = await repo.listWorkflows(req.user.id);
      const withSteps = await Promise.all(
        workflows.map(async (w) => view(w, await repo.listSteps(w.id))),
      );
      res.json({ workflows: withSteps });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const workflow = await ownedWorkflow(req);
      res.json({ workflow: view(workflow, await repo.listSteps(workflow.id)) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default workflowRoutes;
