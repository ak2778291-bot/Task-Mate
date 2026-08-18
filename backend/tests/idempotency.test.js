import { describe, it, expect } from 'vitest';
import { buildSystem, rebuildExecutor, fixedPlanner, seedUser, iso } from './helpers.js';
import { TransientError } from '../src/util/errors.js';

/** Send an email, then book a calendar event: the classic partially-completed workflow. */
const twoStepPlan = () => ({
  summary: 'Email Ana and book the sync',
  steps: [
    {
      tool_name: 'gmail',
      action: 'send_email',
      arguments: { to: 'ana@example.com', subject: 'Sync', body: 'Sending an invite.' },
    },
    {
      tool_name: 'calendar',
      action: 'create_event',
      arguments: { summary: 'Sync with Ana', start: iso(24), end: iso(25), attendees: ['ana@example.com'] },
    },
  ],
});

async function planned(system, userId) {
  const { workflow } = await system.orchestrator.planWorkflow({
    userId,
    requestText: 'email ana and book the sync',
  });
  return workflow;
}

describe('idempotent, resumable execution', () => {
  it('runs a confirmed two-step workflow to completion', async () => {
    const system = buildSystem({ planner: fixedPlanner(twoStepPlan()) });
    const user = await seedUser(system.repo);
    const workflow = await planned(system, user.id);

    const run = await system.executor.runWorkflow({ workflowId: workflow.id, confirmed: true });

    expect(run.status).toBe('completed');
    expect(system.google.counters.send).toBe(1);
    expect(system.google.counters.event).toBe(1);
    const steps = await system.repo.listSteps(workflow.id);
    expect(steps.map((s) => s.status)).toEqual(['executed', 'executed']);
    expect(steps[0].external_ref_id).toBeTruthy();
  });

  it('will not run an irreversible step without confirmation', async () => {
    const system = buildSystem({ planner: fixedPlanner(twoStepPlan()) });
    const user = await seedUser(system.repo);
    const workflow = await planned(system, user.id);

    const run = await system.executor.runWorkflow({ workflowId: workflow.id, confirmed: false });

    expect(run.status).toBe('awaiting_confirmation');
    expect(system.google.counters.send).toBe(0);
  });

  // Section 4.2's headline case: crash between the two steps.
  it('resumes after a crash between steps without re-sending the email', async () => {
    const crashAfterStep1 = {
      beforeStep: ({ step }) => {
        if (step.step_order === 2) throw new Error('SIMULATED PROCESS CRASH');
      },
    };
    const system = buildSystem({ planner: fixedPlanner(twoStepPlan()), hooks: crashAfterStep1 });
    const user = await seedUser(system.repo);
    const workflow = await planned(system, user.id);

    await expect(
      system.executor.runWorkflow({ workflowId: workflow.id, confirmed: true }),
    ).rejects.toThrow('SIMULATED PROCESS CRASH');
    expect(system.google.counters.send).toBe(1);

    // Restart: a fresh executor over the same persisted state, no crash hook this time.
    const resumed = await rebuildExecutor({ repo: system.repo, google: system.google })
      .resumeWorkflow({ workflowId: workflow.id });

    expect(resumed.status).toBe('completed');
    expect(system.google.counters.send).toBe(1); // still exactly one email
    expect(system.google.counters.event).toBe(1);
  });

  // The harder case: the crash lands *after* Gmail accepted the message but *before* the
  // status write. Naive "status !== executed" resume would send a second email here.
  it('reconciles a crash inside the send window instead of re-sending', async () => {
    const crashInsideStep1 = {
      afterInvoke: ({ step }) => {
        if (step.step_order === 1) throw new Error('CRASH AFTER SEND, BEFORE COMMIT');
      },
    };
    const system = buildSystem({ planner: fixedPlanner(twoStepPlan()), hooks: crashInsideStep1 });
    const user = await seedUser(system.repo);
    const workflow = await planned(system, user.id);

    await expect(
      system.executor.runWorkflow({ workflowId: workflow.id, confirmed: true }),
    ).rejects.toThrow('CRASH AFTER SEND, BEFORE COMMIT');

    const steps = await system.repo.listSteps(workflow.id);
    expect(steps[0].status).toBe('executing'); // looks unfinished on disk
    expect(system.google.counters.send).toBe(1); // but the mail is already out

    const resumed = await rebuildExecutor({ repo: system.repo, google: system.google })
      .resumeWorkflow({ workflowId: workflow.id });

    expect(resumed.status).toBe('completed');
    expect(system.google.counters.send).toBe(1); // reconciled, not re-sent
    expect(resumed.outcomes[0].outcome).toBe('reconciled');
  });

  it('treats a duplicate calendar id as success rather than an error', async () => {
    const system = buildSystem({ planner: fixedPlanner(twoStepPlan()) });
    const user = await seedUser(system.repo);
    const workflow = await planned(system, user.id);
    await system.executor.runWorkflow({ workflowId: workflow.id, confirmed: true });

    // Force a second pass over an already-executed step by clearing its status only.
    const steps = await system.repo.listSteps(workflow.id);
    await system.repo.updateStep(steps[1].id, { status: 'validated' });

    const rerun = await system.executor.runWorkflow({ workflowId: workflow.id, confirmed: true });
    expect(rerun.status).toBe('completed');
    expect(system.google.counters.event).toBe(1); // ledger short-circuited the second call
  });

  it('retries a transient failure and succeeds without duplicating the side effect', async () => {
    let attempts = 0;
    const flakyGoogle = {
      counters: { send: 0, draft: 0, event: 0, list: 0 },
      gmail: {
        async sendMessage() {
          attempts += 1;
          if (attempts < 3) throw new TransientError('rate limited');
          flakyGoogle.counters.send += 1;
          return { id: 'msg-1', threadId: 't-1' };
        },
        async findByRfc822MsgId() { return null; },
        async createDraft() { return { id: 'd' }; },
      },
      calendar: {
        async insertEvent(e) { flakyGoogle.counters.event += 1; return { id: e.id }; },
        async getEvent() { return null; },
        async listEvents() { return []; },
      },
    };

    const system = buildSystem({ planner: fixedPlanner(twoStepPlan()), google: flakyGoogle });
    const user = await seedUser(system.repo);
    const workflow = await planned(system, user.id);

    const run = await system.executor.runWorkflow({ workflowId: workflow.id, confirmed: true });
    expect(run.status).toBe('completed');
    expect(attempts).toBe(3);
    expect(flakyGoogle.counters.send).toBe(1);
  });

  it('halts the workflow when a step fails permanently, leaving later steps resumable', async () => {
    const brokenGoogle = {
      counters: { send: 0, draft: 0, event: 0, list: 0 },
      gmail: {
        async sendMessage() { throw Object.assign(new Error('mailbox does not exist'), { status: 400 }); },
        async findByRfc822MsgId() { return null; },
        async createDraft() { return { id: 'd' }; },
      },
      calendar: {
        async insertEvent(e) { brokenGoogle.counters.event += 1; return { id: e.id }; },
        async getEvent() { return null; },
        async listEvents() { return []; },
      },
    };

    const system = buildSystem({ planner: fixedPlanner(twoStepPlan()), google: brokenGoogle });
    const user = await seedUser(system.repo);
    const workflow = await planned(system, user.id);

    const run = await system.executor.runWorkflow({ workflowId: workflow.id, confirmed: true });
    expect(run.status).toBe('failed');
    expect(brokenGoogle.counters.event).toBe(0); // step 2 never ran

    const steps = await system.repo.listSteps(workflow.id);
    expect(steps[0].status).toBe('failed');
    expect(steps[1].status).toBe('validated'); // still pending, still resumable
  });
});
