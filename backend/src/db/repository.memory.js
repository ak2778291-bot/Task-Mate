import { randomUUID } from 'node:crypto';

/**
 * In-memory implementation of the repository contract.
 *
 * Exists so the executor, validator and orchestrator can be unit-tested without a live
 * Postgres, and so `npm test` runs in CI with no services. Every method here has a
 * one-to-one counterpart in repository.pg.js — the engine only ever sees this interface.
 */
export function createMemoryRepository() {
  const users = new Map();
  const workflows = new Map();
  const steps = new Map();
  const reminders = new Map();
  const ledger = new Map();
  const permissions = new Map([
    ['gmail', ['send_email', 'create_draft']],
    ['calendar', ['create_event', 'list_events']],
    ['reminders', ['create_reminder', 'cancel_reminder']],
  ]);

  const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

  return {
    kind: 'memory',

    /* ---------- users ---------- */
    async createUser({ email, passwordHash }) {
      if ([...users.values()].some((u) => u.email === email)) {
        const err = new Error('email already registered');
        err.code = 'EMAIL_TAKEN';
        throw err;
      }
      const user = {
        id: randomUUID(),
        email,
        password_hash: passwordHash,
        google_refresh_token_encrypted: null,
        created_at: new Date().toISOString(),
      };
      users.set(user.id, user);
      return clone(user);
    },
    async findUserByEmail(email) {
      return clone([...users.values()].find((u) => u.email === email));
    },
    async findUserById(id) {
      return clone(users.get(id));
    },
    async setGoogleRefreshToken(userId, encrypted) {
      const u = users.get(userId);
      if (!u) return undefined;
      u.google_refresh_token_encrypted = encrypted;
      return clone(u);
    },

    /* ---------- workflows ---------- */
    async createWorkflow({ userId, requestText, status = 'planned' }) {
      const wf = {
        id: randomUUID(),
        user_id: userId,
        request_text: requestText,
        status,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      workflows.set(wf.id, wf);
      return clone(wf);
    },
    async getWorkflow(id) {
      return clone(workflows.get(id));
    },
    async listWorkflows(userId) {
      return clone(
        [...workflows.values()]
          .filter((w) => w.user_id === userId)
          .sort((a, b) => b.created_at.localeCompare(a.created_at)),
      );
    },
    async listInterruptedWorkflows(userId) {
      return clone(
        [...workflows.values()].filter(
          (w) => w.status === 'executing' && (!userId || w.user_id === userId),
        ),
      );
    },
    async updateWorkflow(id, patch) {
      const wf = workflows.get(id);
      if (!wf) return undefined;
      Object.assign(wf, patch, { updated_at: new Date().toISOString() });
      return clone(wf);
    },

    /* ---------- steps ---------- */
    async createStep(step) {
      const row = {
        id: randomUUID(),
        workflow_id: step.workflowId,
        step_order: step.stepOrder,
        tool_name: step.toolName,
        action: step.action,
        action_payload: step.actionPayload,
        status: step.status || 'pending',
        requires_confirmation: !!step.requiresConfirmation,
        idempotency_key: step.idempotencyKey || randomUUID(),
        external_ref_id: null,
        error_message: null,
        attempts: 0,
        executed_at: null,
      };
      steps.set(row.id, row);
      return clone(row);
    },
    async listSteps(workflowId) {
      return clone(
        [...steps.values()]
          .filter((s) => s.workflow_id === workflowId)
          .sort((a, b) => a.step_order - b.step_order),
      );
    },
    async updateStep(id, patch) {
      const s = steps.get(id);
      if (!s) return undefined;
      Object.assign(s, patch);
      return clone(s);
    },

    /* ---------- idempotency ledger ---------- */
    async reserveIdempotencyKey({ key, toolName, action }) {
      const existing = ledger.get(key);
      if (existing) return { inserted: false, entry: clone(existing) };
      const entry = {
        idempotency_key: key,
        tool_name: toolName,
        action,
        state: 'reserved',
        external_ref_id: null,
        reserved_at: new Date().toISOString(),
        committed_at: null,
      };
      ledger.set(key, entry);
      return { inserted: true, entry: clone(entry) };
    },
    async commitIdempotencyKey(key, externalRefId) {
      const entry = ledger.get(key);
      if (!entry) return undefined;
      entry.state = 'committed';
      entry.external_ref_id = externalRefId ?? null;
      entry.committed_at = new Date().toISOString();
      return clone(entry);
    },
    async releaseIdempotencyKey(key) {
      ledger.delete(key);
    },
    async getLedgerEntry(key) {
      return clone(ledger.get(key));
    },

    /* ---------- reminders ---------- */
    async createReminder({ userId, workflowId = null, fireAt, payload = {} }) {
      const r = {
        id: randomUUID(),
        user_id: userId,
        workflow_id: workflowId,
        fire_at: new Date(fireAt).toISOString(),
        status: 'pending',
        payload,
      };
      reminders.set(r.id, r);
      return clone(r);
    },
    async listReminders(userId) {
      return clone(
        [...reminders.values()]
          .filter((r) => r.user_id === userId)
          .sort((a, b) => a.fire_at.localeCompare(b.fire_at)),
      );
    },
    async getDueReminders(now = new Date(), limit = 50) {
      return clone(
        [...reminders.values()]
          .filter((r) => r.status === 'pending' && new Date(r.fire_at) <= now)
          .sort((a, b) => a.fire_at.localeCompare(b.fire_at))
          .slice(0, limit),
      );
    },
    async updateReminder(id, patch) {
      const r = reminders.get(id);
      if (!r) return undefined;
      Object.assign(r, patch);
      return clone(r);
    },

    /* ---------- tool permissions ---------- */
    async getToolPermissions() {
      return Object.fromEntries([...permissions.entries()].map(([k, v]) => [k, [...v]]));
    },
    async setToolPermission(toolName, allowedActions) {
      permissions.set(toolName, [...allowedActions]);
      return { tool_name: toolName, allowed_actions: [...allowedActions] };
    },
  };
}

export default createMemoryRepository;
