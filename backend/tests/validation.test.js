import { describe, it, expect, vi } from 'vitest';
import { validatePlan, VIOLATION } from '../src/validation/validator.js';
import { buildSystem, fixedPlanner, seedUser, iso } from './helpers.js';

const PERMISSIONS = {
  gmail: ['send_email', 'create_draft'],
  calendar: ['create_event', 'list_events'],
  reminders: ['create_reminder', 'cancel_reminder'],
};

const sendStep = (over = {}) => ({
  tool_name: 'gmail',
  action: 'send_email',
  arguments: { to: 'ana@example.com', subject: 'Follow up', body: 'Checking in.' },
  ...over,
});

describe('validation layer — plan shape', () => {
  it('accepts a well-formed permitted plan and marks irreversible steps for confirmation', () => {
    const result = validatePlan({ summary: 'Email Ana', steps: [sendStep()] }, PERMISSIONS);
    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].requiresConfirmation).toBe(true);
  });

  it('marks reversible steps as not needing confirmation', () => {
    const result = validatePlan(
      {
        summary: 'Remind me',
        steps: [{ tool_name: 'reminders', action: 'create_reminder', arguments: { fire_at: iso(24), message: 'Ping Ana' } }],
      },
      PERMISSIONS,
    );
    expect(result.ok).toBe(true);
    expect(result.steps[0].requiresConfirmation).toBe(false);
  });

  it('rejects a plan that is not an action plan at all', () => {
    const result = validatePlan({ notAPlan: true }, PERMISSIONS);
    expect(result.ok).toBe(false);
    expect(result.violations[0].code).toBe(VIOLATION.MALFORMED_PLAN);
  });

  it('drops keys the model invented rather than passing them through', () => {
    const result = validatePlan(
      { summary: 'Email Ana', steps: [sendStep({ arguments: { to: 'ana@example.com', subject: 'Hi', body: 'Hello', bcc: 'exfiltrate@evil.com' } })] },
      PERMISSIONS,
    );
    expect(result.ok).toBe(true);
    expect(result.steps[0].params).not.toHaveProperty('bcc');
  });
});

describe('validation layer — permission gate', () => {
  it('blocks an action that exists but is not granted', () => {
    const result = validatePlan(
      { summary: 'Clean up', steps: [{ tool_name: 'gmail', action: 'delete_email', arguments: { messageId: 'abc123' } }] },
      PERMISSIONS,
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0].code).toBe(VIOLATION.PERMISSION_DENIED);
  });

  it('blocks a tool that does not exist', () => {
    const result = validatePlan(
      { summary: 'Upload', steps: [{ tool_name: 'drive', action: 'upload_file', arguments: {} }] },
      PERMISSIONS,
    );
    expect(result.violations[0].code).toBe(VIOLATION.UNKNOWN_TOOL);
  });

  it('rejects arguments that fail the action schema', () => {
    const result = validatePlan(
      { summary: 'Email', steps: [sendStep({ arguments: { to: 'not-an-email', subject: 'Hi', body: 'x' } })] },
      PERMISSIONS,
    );
    expect(result.violations[0].code).toBe(VIOLATION.INVALID_ARGUMENTS);
  });

  it('fails closed: one bad step rejects the whole plan, including its legal steps', () => {
    const result = validatePlan(
      {
        summary: 'Mixed',
        steps: [sendStep(), { tool_name: 'gmail', action: 'delete_email', arguments: { messageId: 'x' } }],
      },
      PERMISSIONS,
    );
    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(0);
  });
});

describe('permission enforcement reaches the tool layer', () => {
  // The interview-critical test: an ungranted action proposed by the model must never
  // arrive at a handler, and must be visible as blocked in the workflow history.
  it('an out-of-permission proposed action never reaches the tool layer', async () => {
    const plan = {
      summary: 'Delete that message',
      steps: [{ tool_name: 'gmail', action: 'delete_email', arguments: { messageId: 'abc123' } }],
    };
    const { repo, orchestrator, google } = buildSystem({ planner: fixedPlanner(plan) });
    const user = await seedUser(repo);

    const result = await orchestrator.planWorkflow({ userId: user.id, requestText: 'delete that message' });

    expect(result.ok).toBe(false);
    expect(result.violations[0].code).toBe('PERMISSION_DENIED');
    expect(result.workflow.status).toBe('failed');
    expect(result.steps[0].status).toBe('skipped');
    expect(result.steps[0].error_message).toContain('PERMISSION_DENIED');
    // No Google call of any kind was attempted.
    expect(google.counters).toEqual({ send: 0, draft: 0, event: 0, list: 0 });
  });

  it('the tool layer refuses an ungranted action even if the validator is bypassed', async () => {
    const { tools, repo } = buildSystem();
    const user = await seedUser(repo);
    await expect(
      tools.invoke({
        toolName: 'gmail',
        action: 'delete_email',
        params: { messageId: 'abc' },
        userId: user.id,
        idempotencyKey: 'k1',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('the tool layer re-checks against the live permission set, not a snapshot', async () => {
    const { tools, repo } = buildSystem();
    const user = await seedUser(repo);
    await repo.setToolPermission('gmail', ['create_draft']); // send revoked at runtime
    await expect(
      tools.invoke({
        toolName: 'gmail',
        action: 'send_email',
        params: { to: 'ana@example.com', subject: 'Hi', body: 'Hello' },
        userId: user.id,
        idempotencyKey: 'k2',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('rejects malformed arguments at the tool layer with a schema error, not a crash', async () => {
    const { tools, repo } = buildSystem();
    const user = await seedUser(repo);
    const spy = vi.fn();
    await tools
      .invoke({
        toolName: 'calendar',
        action: 'create_event',
        params: { summary: 'Sync', start: 'next tuesday', end: 'later' },
        userId: user.id,
        idempotencyKey: 'k3',
      })
      .catch(spy);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});
