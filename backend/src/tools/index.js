import { getAction, isKnownTool, TOOL_REGISTRY } from './registry.js';
import { getGoogleFor } from './google-client.js';
import { PermissionError, ValidationError } from '../util/errors.js';
import logger from '../util/logger.js';

/**
 * The tool layer. Nothing else in the codebase imports googleapis.
 *
 * It re-checks permissions at call time even though the validator already checked them at
 * plan time. That is deliberate: the validator protects the *plan*, this protects the
 * *process*. Any future code path — a retry, a resume, a scheduler-triggered step, a bug —
 * still cannot execute an ungranted action.
 */
export function createToolLayer({ repo, googleFactory = getGoogleFor, log = logger }) {
  async function assertAllowed(toolName, action) {
    if (!isKnownTool(toolName)) {
      throw new PermissionError(`Unknown tool "${toolName}"`, { tool_name: toolName });
    }
    const def = getAction(toolName, action);
    if (!def) {
      throw new PermissionError(`Unknown action "${toolName}.${action}"`, { tool_name: toolName, action });
    }
    const permissions = await repo.getToolPermissions();
    const granted = permissions[toolName] || [];
    if (!granted.includes(action)) {
      throw new PermissionError(`Action "${toolName}.${action}" is not permitted`, {
        tool_name: toolName,
        action,
        granted,
      });
    }
    return def;
  }

  async function buildCtx({ userId, workflowId, idempotencyKey }) {
    return {
      userId,
      workflowId,
      idempotencyKey,
      repo,
      google: await googleFactory(userId, repo),
    };
  }

  return {
    registry: TOOL_REGISTRY,

    /** Executes one action. Assumes the caller owns idempotency bookkeeping. */
    async invoke({ toolName, action, params, userId, workflowId, idempotencyKey }) {
      const def = await assertAllowed(toolName, action);
      const parsed = def.params.safeParse(params);
      if (!parsed.success) {
        throw new ValidationError(`Invalid arguments for ${toolName}.${action}`, {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      const ctx = await buildCtx({ userId, workflowId, idempotencyKey });
      log.info('tool.invoke', { tool_name: toolName, action, idempotency_key: idempotencyKey });
      return def.handler({ params: parsed.data, ctx });
    },

    /**
     * Asks the provider whether this step's side effect already exists. Returns the same
     * shape as a successful invoke, or null if the action definitively never happened.
     * Returns undefined when the action has no way to answer the question.
     */
    async reconcile({ toolName, action, userId, workflowId, idempotencyKey }) {
      const def = await assertAllowed(toolName, action);
      if (!def.reconcile) return undefined;
      const ctx = await buildCtx({ userId, workflowId, idempotencyKey });
      return def.reconcile({ ctx });
    },

    canReconcile(toolName, action) {
      return typeof getAction(toolName, action)?.reconcile === 'function';
    },
  };
}

export default createToolLayer;
