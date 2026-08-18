import { randomUUID } from 'node:crypto';
import { getPool } from './pool.js';

/**
 * Postgres implementation of the repository contract. Same method surface as
 * repository.memory.js — nothing above this layer knows which one it is talking to.
 */
export function createPgRepository(pool = getPool()) {
  const one = async (text, params) => (await pool.query(text, params)).rows[0];
  const many = async (text, params) => (await pool.query(text, params)).rows;

  return {
    kind: 'postgres',
    pool,

    /* ---------- users ---------- */
    async createUser({ email, passwordHash }) {
      try {
        return await one(
          `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING *`,
          [email, passwordHash],
        );
      } catch (err) {
        if (err.code === '23505') {
          const e = new Error('email already registered');
          e.code = 'EMAIL_TAKEN';
          throw e;
        }
        throw err;
      }
    },
    findUserByEmail(email) {
      return one(`SELECT * FROM users WHERE email = $1`, [email]);
    },
    findUserById(id) {
      return one(`SELECT * FROM users WHERE id = $1`, [id]);
    },
    setGoogleRefreshToken(userId, encrypted) {
      return one(
        `UPDATE users SET google_refresh_token_encrypted = $2 WHERE id = $1 RETURNING *`,
        [userId, encrypted],
      );
    },

    /* ---------- workflows ---------- */
    createWorkflow({ userId, requestText, status = 'planned' }) {
      return one(
        `INSERT INTO workflows (user_id, request_text, status) VALUES ($1, $2, $3) RETURNING *`,
        [userId, requestText, status],
      );
    },
    getWorkflow(id) {
      return one(`SELECT * FROM workflows WHERE id = $1`, [id]);
    },
    listWorkflows(userId) {
      return many(`SELECT * FROM workflows WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [
        userId,
      ]);
    },
    // Workflows still marked 'executing' after a restart: the process died mid-run.
    listInterruptedWorkflows(userId) {
      return userId
        ? many(`SELECT * FROM workflows WHERE status = 'executing' AND user_id = $1`, [userId])
        : many(`SELECT * FROM workflows WHERE status = 'executing'`);
    },
    updateWorkflow(id, patch) {
      const fields = Object.keys(patch);
      const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
      return one(
        `UPDATE workflows SET ${sets}, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, ...fields.map((f) => patch[f])],
      );
    },

    /* ---------- steps ---------- */
    createStep(step) {
      return one(
        `INSERT INTO workflow_steps
           (workflow_id, step_order, tool_name, action, action_payload, status,
            requires_confirmation, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          step.workflowId,
          step.stepOrder,
          step.toolName,
          step.action,
          JSON.stringify(step.actionPayload),
          step.status || 'pending',
          !!step.requiresConfirmation,
          step.idempotencyKey || randomUUID(),
        ],
      );
    },
    listSteps(workflowId) {
      return many(`SELECT * FROM workflow_steps WHERE workflow_id = $1 ORDER BY step_order ASC`, [
        workflowId,
      ]);
    },
    updateStep(id, patch) {
      const fields = Object.keys(patch);
      const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
      return one(`UPDATE workflow_steps SET ${sets} WHERE id = $1 RETURNING *`, [
        id,
        ...fields.map((f) => patch[f]),
      ]);
    },

    /* ---------- idempotency ledger ---------- */
    // INSERT .. ON CONFLICT DO NOTHING is the atomic reservation: exactly one caller
    // gets a row back, everyone else learns the key is already taken.
    async reserveIdempotencyKey({ key, toolName, action }) {
      const inserted = await one(
        `INSERT INTO idempotency_ledger (idempotency_key, tool_name, action, state)
         VALUES ($1,$2,$3,'reserved')
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [key, toolName, action],
      );
      if (inserted) return { inserted: true, entry: inserted };
      const entry = await one(`SELECT * FROM idempotency_ledger WHERE idempotency_key = $1`, [key]);
      return { inserted: false, entry };
    },
    commitIdempotencyKey(key, externalRefId) {
      return one(
        `UPDATE idempotency_ledger
            SET state = 'committed', external_ref_id = $2, committed_at = now()
          WHERE idempotency_key = $1 RETURNING *`,
        [key, externalRefId ?? null],
      );
    },
    async releaseIdempotencyKey(key) {
      await pool.query(`DELETE FROM idempotency_ledger WHERE idempotency_key = $1`, [key]);
    },
    getLedgerEntry(key) {
      return one(`SELECT * FROM idempotency_ledger WHERE idempotency_key = $1`, [key]);
    },

    /* ---------- reminders ---------- */
    createReminder({ userId, workflowId = null, fireAt, payload = {} }) {
      return one(
        `INSERT INTO reminders (user_id, workflow_id, fire_at, payload)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [userId, workflowId, new Date(fireAt).toISOString(), JSON.stringify(payload)],
      );
    },
    listReminders(userId) {
      return many(`SELECT * FROM reminders WHERE user_id = $1 ORDER BY fire_at ASC LIMIT 200`, [
        userId,
      ]);
    },
    // FOR UPDATE SKIP LOCKED keeps the poller safe if a second backend instance ever runs.
    async getDueReminders(now = new Date(), limit = 50) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `SELECT * FROM reminders
            WHERE status = 'pending' AND fire_at <= $1
            ORDER BY fire_at ASC LIMIT $2
            FOR UPDATE SKIP LOCKED`,
          [now.toISOString(), limit],
        );
        await client.query('COMMIT');
        return rows;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    updateReminder(id, patch) {
      const fields = Object.keys(patch);
      const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
      return one(`UPDATE reminders SET ${sets} WHERE id = $1 RETURNING *`, [
        id,
        ...fields.map((f) => patch[f]),
      ]);
    },

    /* ---------- tool permissions ---------- */
    async getToolPermissions() {
      const rows = await many(`SELECT tool_name, allowed_actions FROM tool_permissions`);
      return Object.fromEntries(rows.map((r) => [r.tool_name, r.allowed_actions]));
    },
    setToolPermission(toolName, allowedActions) {
      return one(
        `INSERT INTO tool_permissions (tool_name, allowed_actions) VALUES ($1,$2)
         ON CONFLICT (tool_name) DO UPDATE SET allowed_actions = EXCLUDED.allowed_actions
         RETURNING *`,
        [toolName, allowedActions],
      );
    },
  };
}

export default createPgRepository;
