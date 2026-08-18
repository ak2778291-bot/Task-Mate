import { z } from 'zod';
import { getAction, isKnownTool } from '../tools/registry.js';

/**
 * Section 4.1 — the layer that makes this an agentic *system* rather than a chatbot with
 * API keys. The model's output is data, never instruction: it is parsed, checked against a
 * permission set the model cannot see or modify, and only then turned into executable steps.
 *
 * Four gates, in order:
 *   1. Shape      — the plan parses as a typed action plan at all.
 *   2. Existence  — every tool/action named is one this system actually implements.
 *   3. Permission — every action is in the granted set for that tool (from the DB, not code).
 *   4. Arguments  — every argument object parses against that action's own schema.
 *
 * Fail closed: one violation rejects the whole plan. Executing "the safe half" of a plan the
 * model got wrong is how you get a half-finished workflow with real side effects in it.
 */

export const ACTION_PLAN_SCHEMA = z.object({
  summary: z.string().min(1).max(500),
  steps: z
    .array(
      z.object({
        tool_name: z.string().min(1),
        action: z.string().min(1),
        arguments: z.record(z.unknown()).default({}),
        rationale: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(10),
});

export const VIOLATION = {
  MALFORMED_PLAN: 'MALFORMED_PLAN',
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  UNKNOWN_ACTION: 'UNKNOWN_ACTION',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  INVALID_ARGUMENTS: 'INVALID_ARGUMENTS',
};

/**
 * @param {object} plan        raw plan object emitted by the planner
 * @param {object} permissions { [tool_name]: string[] } loaded from tool_permissions
 * @returns {{ok: boolean, summary?: string, steps: object[], violations: object[]}}
 */
export function validatePlan(plan, permissions) {
  const parsed = ACTION_PLAN_SCHEMA.safeParse(plan);
  if (!parsed.success) {
    return {
      ok: false,
      steps: [],
      violations: [
        {
          code: VIOLATION.MALFORMED_PLAN,
          message: 'Plan did not match the action-plan schema',
          detail: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      ],
    };
  }

  const violations = [];
  const steps = [];

  parsed.data.steps.forEach((step, index) => {
    const where = { index, tool_name: step.tool_name, action: step.action };

    if (!isKnownTool(step.tool_name)) {
      violations.push({ ...where, code: VIOLATION.UNKNOWN_TOOL, message: `No such tool: ${step.tool_name}` });
      return;
    }

    const def = getAction(step.tool_name, step.action);
    if (!def) {
      violations.push({
        ...where,
        code: VIOLATION.UNKNOWN_ACTION,
        message: `No such action: ${step.tool_name}.${step.action}`,
      });
      return;
    }

    const granted = permissions[step.tool_name] || [];
    if (!granted.includes(step.action)) {
      violations.push({
        ...where,
        code: VIOLATION.PERMISSION_DENIED,
        message: `${step.tool_name}.${step.action} is not in the granted permission set`,
        detail: { granted },
      });
      return;
    }

    const args = def.params.safeParse(step.arguments);
    if (!args.success) {
      violations.push({
        ...where,
        code: VIOLATION.INVALID_ARGUMENTS,
        message: `Arguments rejected by ${step.tool_name}.${step.action} schema`,
        detail: args.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    steps.push({
      stepOrder: index + 1,
      toolName: step.tool_name,
      action: step.action,
      // Only the parsed value is kept — unknown keys the model invented are dropped here,
      // so nothing unvalidated can ride along into the tool layer.
      params: args.data,
      rationale: step.rationale ?? null,
      requiresConfirmation: !!def.irreversible,
    });
  });

  if (violations.length) return { ok: false, steps: [], violations, summary: parsed.data.summary };
  return { ok: true, summary: parsed.data.summary, steps, violations: [] };
}

export function planNeedsConfirmation(steps) {
  return steps.some((s) => s.requiresConfirmation);
}

export default validatePlan;
