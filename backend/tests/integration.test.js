import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createMemoryRepository } from '../src/db/repository.memory.js';
import { createToolLayer } from '../src/tools/index.js';
import { createExecutor } from '../src/engine/executor.js';
import { createOrchestrator } from '../src/engine/orchestrator.js';
import { createStubPlanner } from '../src/planner/planner.js';
import { createMockGoogle } from '../src/tools/mock-google.js';
import { createScheduler } from '../src/scheduler/scheduler.js';
import { silentLog, fixedPlanner } from './helpers.js';

function buildApp({ planner = createStubPlanner(), google = createMockGoogle() } = {}) {
  const repo = createMemoryRepository();
  const tools = createToolLayer({ repo, googleFactory: async () => google, log: silentLog });
  const executor = createExecutor({ repo, tools, log: silentLog });
  const orchestrator = createOrchestrator({ repo, planner, log: silentLog });
  const app = createApp({ repo, tools, planner, executor, orchestrator, log: silentLog });
  return { app, repo, google, executor };
}

async function authed(app, email = 'demo@example.com') {
  const res = await request(app).post('/auth/register').send({ email, password: 'correct-horse-battery' });
  expect(res.status).toBe(201);
  return res.body.token;
}

describe('HTTP API — happy path', () => {
  let ctx;
  beforeEach(() => {
    ctx = buildApp();
  });

  it('request → plan → confirm → real side effect → history', async () => {
    const token = await authed(ctx.app);

    const planRes = await request(ctx.app)
      .post('/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ request: 'Send an email to ana@example.com about Friday’s handover' });

    expect(planRes.status).toBe(201);
    expect(planRes.body.requires_confirmation).toBe(true);
    expect(planRes.body.workflow.status).toBe('awaiting_confirmation');
    expect(planRes.body.workflow.steps[0]).toMatchObject({
      tool_name: 'gmail',
      action: 'send_email',
      status: 'validated',
    });
    expect(ctx.google.counters.send).toBe(0); // nothing sent before confirmation

    const id = planRes.body.workflow.id;
    const confirmRes = await request(ctx.app)
      .post(`/workflows/${id}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.workflow.status).toBe('completed');
    expect(ctx.google.counters.send).toBe(1);
    expect(ctx.google.gmail._sent()[0].to).toBe('ana@example.com');

    const historyRes = await request(ctx.app)
      .get(`/workflows/${id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(historyRes.body.workflow.steps[0]).toMatchObject({
      status: 'executed',
      attempts: 1,
    });
    expect(historyRes.body.workflow.steps[0].external_ref_id).toBeTruthy();
    expect(historyRes.body.workflow.steps[0].executed_at).toBeTruthy();
  });

  it('confirming twice does not produce a second email', async () => {
    const token = await authed(ctx.app);
    const { body } = await request(ctx.app)
      .post('/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ request: 'Send an email to ana@example.com about the handover' });

    await request(ctx.app).post(`/workflows/${body.workflow.id}/confirm`).set('Authorization', `Bearer ${token}`).send();
    const second = await request(ctx.app)
      .post(`/workflows/${body.workflow.id}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    expect(second.status).toBe(409); // completed workflows cannot be re-confirmed
    expect(ctx.google.counters.send).toBe(1);
  });

  it('a reminder-only request needs no confirmation and schedules a reminder', async () => {
    const token = await authed(ctx.app);
    const planRes = await request(ctx.app)
      .post('/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ request: 'Remind me to follow up with Ana on Friday' });

    expect(planRes.body.requires_confirmation).toBe(false);
    expect(planRes.body.workflow.steps[0].tool_name).toBe('reminders');

    await request(ctx.app)
      .post(`/workflows/${planRes.body.workflow.id}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    const reminders = await request(ctx.app).get('/reminders').set('Authorization', `Bearer ${token}`);
    expect(reminders.body.reminders).toHaveLength(1);
    expect(reminders.body.reminders[0].status).toBe('pending');
  });
});

describe('HTTP API — refusals', () => {
  it('returns 422 and the violation when the plan breaks the permission set', async () => {
    const ctx = buildApp({
      planner: fixedPlanner({
        summary: 'Delete it',
        steps: [{ tool_name: 'gmail', action: 'delete_email', arguments: { messageId: 'x' } }],
      }),
    });
    const token = await authed(ctx.app);

    const res = await request(ctx.app)
      .post('/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ request: 'delete that message from Ana' });

    expect(res.status).toBe(422);
    expect(res.body.violations[0].code).toBe('PERMISSION_DENIED');
    expect(res.body.workflow.steps[0].status).toBe('skipped');
    expect(ctx.google.counters.send).toBe(0);
  });

  it('rejects unauthenticated requests', async () => {
    const ctx = buildApp();
    const res = await request(ctx.app).get('/workflows');
    expect(res.status).toBe(401);
  });

  it('hides another user’s workflow behind a 404', async () => {
    const ctx = buildApp();
    const alice = await authed(ctx.app, 'alice@example.com');
    const bob = await authed(ctx.app, 'bob@example.com');

    const { body } = await request(ctx.app)
      .post('/workflows')
      .set('Authorization', `Bearer ${alice}`)
      .send({ request: 'Remind me to call the bank tomorrow' });

    const res = await request(ctx.app)
      .get(`/workflows/${body.workflow.id}`)
      .set('Authorization', `Bearer ${bob}`);
    expect(res.status).toBe(404);
  });

  it('will not register the same email twice', async () => {
    const ctx = buildApp();
    await authed(ctx.app);
    const res = await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'demo@example.com', password: 'correct-horse-battery' });
    expect(res.status).toBe(409);
  });
});

describe('scheduler', () => {
  it('fires due reminders and leaves future ones alone', async () => {
    const ctx = buildApp();
    const user = await ctx.repo.createUser({ email: 's@example.com', passwordHash: 'x' });
    await ctx.repo.createReminder({ userId: user.id, fireAt: new Date(Date.now() - 1000), payload: { message: 'due' } });
    await ctx.repo.createReminder({ userId: user.id, fireAt: new Date(Date.now() + 3600_000), payload: { message: 'later' } });

    const scheduler = createScheduler({ repo: ctx.repo, executor: ctx.executor, log: silentLog });
    const result = await scheduler.tick();

    expect(result.fired).toBe(1);
    const reminders = await ctx.repo.listReminders(user.id);
    expect(reminders.filter((r) => r.status === 'fired')).toHaveLength(1);
    expect(reminders.filter((r) => r.status === 'pending')).toHaveLength(1);
  });
});
