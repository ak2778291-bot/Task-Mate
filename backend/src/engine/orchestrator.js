import { randomUUID } from 'node:crypto';
import { validatePlan, planNeedsConfirmation } from '../validation/validator.js';
import logger from '../util/logger.js';

/**
 * Request → plan → validate → persist.
 *
 * Nothing here executes anything. A workflow leaves this module in one of three states:
 *   rejected              — the plan violated permissions or schemas; steps persisted as
 *                           `skipped` with the reason, so the block is visible in history.
 *   awaiting_confirmation — the plan is legal but contains an irreversible step.
 *   planned               — legal and fully reversible; ready to run.
 */
export function createOrchestrator({ repo, planner, log = logger }) {
  return {
    async planWorkflow({ userId, requestText, timezone = 'UTC' }) {
      const raw = await planner.plan({ requestText, timezone, now: new Date() });
      const permissions = await repo.getToolPermissions();
      const result = validatePlan(raw, permissions);

      if (!result.ok) {
        log.warn('plan.rejected', {
          user_id: userId,
          violations: result.violations.map((v) => v.code),
        });
        const workflow = await repo.createWorkflow({
          userId,
          requestText,
          status: 'failed',
        });
        // Persist the rejected steps so the block is inspectable, not just logged.
        const proposed = Array.isArray(raw?.steps) ? raw.steps : [];
        const steps = [];
        for (const [i, step] of proposed.entries()) {
          const violation = result.violations.find((v) => v.index === i);
          steps.push(
            await repo.createStep({
              workflowId: workflow.id,
              stepOrder: i + 1,
              toolName: String(step?.tool_name ?? 'unknown'),
              action: String(step?.action ?? 'unknown'),
              actionPayload: step?.arguments ?? {},
              status: 'skipped',
              requiresConfirmation: false,
              idempotencyKey: randomUUID(),
            }),
          );
          if (violation) {
            const updated = await repo.updateStep(steps[i].id, {
              error_message: `${violation.code}: ${violation.message}`,
            });
            steps[i] = updated;
          }
        }
        return { workflow, steps, violations: result.violations, requiresConfirmation: false, ok: false };
      }

      const requiresConfirmation = planNeedsConfirmation(result.steps);
      const workflow = await repo.createWorkflow({
        userId,
        requestText,
        status: requiresConfirmation ? 'awaiting_confirmation' : 'planned',
      });

      const steps = [];
      for (const step of result.steps) {
        steps.push(
          await repo.createStep({
            workflowId: workflow.id,
            stepOrder: step.stepOrder,
            toolName: step.toolName,
            action: step.action,
            actionPayload: step.params,
            // 'validated' records that this step passed the gate — the executor will not
            // run a step that is merely 'pending'.
            status: 'validated',
            requiresConfirmation: step.requiresConfirmation,
            idempotencyKey: randomUUID(),
          }),
        );
      }

      log.info('plan.accepted', {
        workflow_id: workflow.id,
        step_count: steps.length,
        requires_confirmation: requiresConfirmation,
      });
      return { workflow, steps, violations: [], requiresConfirmation, summary: result.summary, ok: true };
    },
  };
}

export default createOrchestrator;
