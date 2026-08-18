import { withRetry } from '../util/retry.js';
import { isTransient, PermissionError, ValidationError } from '../util/errors.js';
import logger from '../util/logger.js';

/**
 * Section 4.2 — idempotent, resumable execution.
 *
 * The naive version ("skip steps whose status is executed") only survives a crash that
 * happens between steps. The dangerous crash is *inside* a step: after Gmail accepted the
 * message, before we wrote status='executed'. On restart the step still looks pending, and a
 * naive resume sends the email twice.
 *
 * So each step goes through reserve → call → commit against an idempotency ledger:
 *
 *   reserved, not committed   we crashed mid-call and do not know whether the side effect
 *                             happened. Ask the provider (reconcile): Gmail is queried by the
 *                             Message-ID we pinned, Calendar by the event id we assigned.
 *                             Adopt the existing result if found; only call again if the
 *                             provider says it definitively never happened.
 *   committed                 the side effect happened. Adopt its reference and move on.
 *
 * If a step is in doubt and its action cannot answer the question, it is parked as `in_doubt`
 * rather than retried. Repeating an irreversible action on a guess is the failure mode this
 * whole mechanism exists to prevent.
 */
export function createExecutor({ repo, tools, log = logger, hooks = {}, retryOptions = {} }) {
  async function executeStep(step, { userId, workflowId, stepLog }) {
    const key = step.idempotency_key;
    const common = { toolName: step.tool_name, action: step.action, userId, workflowId, idempotencyKey: key };

    const { inserted, entry } = await repo.reserveIdempotencyKey({
      key,
      toolName: step.tool_name,
      action: step.action,
    });

    if (!inserted && entry.state === 'committed') {
      stepLog.info('step.deduplicated', { external_ref_id: entry.external_ref_id });
      await repo.updateStep(step.id, {
        status: 'executed',
        external_ref_id: entry.external_ref_id,
        executed_at: new Date().toISOString(),
        error_message: null,
      });
      return { outcome: 'deduplicated' };
    }

    if (!inserted && entry.state === 'reserved') {
      const reconciled = await tools.reconcile(common).catch((err) => {
        stepLog.warn('step.reconcile_failed', { error: err.message });
        return undefined;
      });

      if (reconciled) {
        stepLog.info('step.reconciled', { external_ref_id: reconciled.externalRefId });
        await repo.commitIdempotencyKey(key, reconciled.externalRefId);
        await repo.updateStep(step.id, {
          status: 'executed',
          external_ref_id: reconciled.externalRefId,
          executed_at: new Date().toISOString(),
          error_message: null,
        });
        return { outcome: 'reconciled' };
      }

      if (reconciled === undefined) {
        stepLog.error('step.in_doubt', {});
        await repo.updateStep(step.id, {
          status: 'in_doubt',
          error_message:
            'A previous attempt crashed mid-call and this action cannot confirm whether it took effect. Left for manual review rather than retried.',
        });
        return { outcome: 'in_doubt' };
      }
      // reconciled === null: the provider says it never happened. Safe to call.
      stepLog.info('step.retry_after_crash', {});
    }

    await repo.updateStep(step.id, { status: 'executing', attempts: (step.attempts || 0) + 1 });

    let result;
    try {
      result = await withRetry(() => tools.invoke({ ...common, params: step.action_payload }), {
        attempts: 3,
        onRetry: ({ attempt, delayMs, error }) =>
          stepLog.warn('step.retrying', { attempt, delay_ms: delayMs, error: error.message }),
        ...retryOptions,
      });
    } catch (err) {
      // Nothing was accepted upstream, so the key must not stay reserved — otherwise a later
      // resume would see a false "in doubt" and park a step that simply failed cleanly.
      if (!isTransient(err) || err instanceof PermissionError || err instanceof ValidationError) {
        await repo.releaseIdempotencyKey(key);
      }
      stepLog.error('step.failed', { error: err.message, code: err.code });
      await repo.updateStep(step.id, { status: 'failed', error_message: err.message });
      return { outcome: 'failed', error: err };
    }

    // The crash window this design exists to close is exactly here.
    await hooks.afterInvoke?.({ step, result });

    await repo.commitIdempotencyKey(key, result.externalRefId);
    await repo.updateStep(step.id, {
      status: 'executed',
      external_ref_id: result.externalRefId ?? null,
      executed_at: new Date().toISOString(),
      error_message: null,
    });
    stepLog.info('step.executed', { external_ref_id: result.externalRefId });
    return { outcome: 'executed', result };
  }

  /**
   * Runs a workflow from its first incomplete step. Resuming is not a separate code path —
   * a resume is just this function called again, which is why the resume path cannot rot.
   */
  async function runWorkflow({ workflowId, confirmed = false }) {
    const workflow = await repo.getWorkflow(workflowId);
    if (!workflow) throw new Error(`workflow ${workflowId} not found`);

    const wfLog = log.child({ workflow_id: workflowId, user_id: workflow.user_id });
    await repo.updateWorkflow(workflowId, { status: 'executing' });

    const steps = await repo.listSteps(workflowId);
    const outcomes = [];

    for (const step of steps) {
      const stepLog = wfLog.child({
        step_id: step.id,
        step_order: step.step_order,
        tool_name: step.tool_name,
        action: step.action,
      });

      if (step.status === 'executed' || step.status === 'skipped') {
        outcomes.push({ stepId: step.id, outcome: 'already_done' });
        continue;
      }

      if (step.status === 'pending') {
        // Never validated. Refuse rather than guess.
        await repo.updateStep(step.id, {
          status: 'failed',
          error_message: 'Step was never validated; refusing to execute.',
        });
        outcomes.push({ stepId: step.id, outcome: 'failed' });
        await repo.updateWorkflow(workflowId, { status: 'failed' });
        return { workflowId, status: 'failed', outcomes };
      }

      if (step.requires_confirmation && !confirmed) {
        stepLog.info('step.awaiting_confirmation', {});
        await repo.updateWorkflow(workflowId, { status: 'awaiting_confirmation' });
        return { workflowId, status: 'awaiting_confirmation', outcomes };
      }

      await hooks.beforeStep?.({ step });
      const res = await executeStep(step, { userId: workflow.user_id, workflowId, stepLog });
      outcomes.push({ stepId: step.id, outcome: res.outcome });

      if (res.outcome === 'failed' || res.outcome === 'in_doubt') {
        // Halt: later steps often assume earlier ones happened. Everything after stays
        // untouched and resumable once the cause is fixed.
        await repo.updateWorkflow(workflowId, { status: 'failed' });
        return { workflowId, status: 'failed', outcomes, error: res.error?.message };
      }
    }

    await repo.updateWorkflow(workflowId, { status: 'completed' });
    wfLog.info('workflow.completed', { steps: outcomes.length });
    return { workflowId, status: 'completed', outcomes };
  }

  return {
    runWorkflow,
    /** Explicit alias — a resume is the same pass, by design. */
    resumeWorkflow: ({ workflowId, confirmed = true }) => runWorkflow({ workflowId, confirmed }),

    /** Sweeps workflows left mid-flight by a crash. Called on boot and by the scheduler. */
    async resumeInterrupted({ userId } = {}) {
      if (!repo.listInterruptedWorkflows) return [];
      const stuck = await repo.listInterruptedWorkflows(userId);
      const results = [];
      for (const wf of stuck) {
        log.info('workflow.auto_resume', { workflow_id: wf.id });
        results.push(await runWorkflow({ workflowId: wf.id, confirmed: true }));
      }
      return results;
    },
  };
}

export default createExecutor;
