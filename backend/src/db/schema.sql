-- One Work Space — schema (Section 5 of the build prompt, plus the idempotency ledger
-- that makes Section 4.2's guarantee survive a crash between the API call and the status write).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id                             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                          TEXT UNIQUE NOT NULL,
  password_hash                  TEXT NOT NULL,
  google_refresh_token_encrypted TEXT,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  CREATE TYPE workflow_status AS ENUM ('planned','awaiting_confirmation','executing','completed','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE step_status AS ENUM ('pending','validated','executing','executed','failed','skipped','in_doubt');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE reminder_status AS ENUM ('pending','fired','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS workflows (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_text TEXT NOT NULL,
  status       workflow_status NOT NULL DEFAULT 'planned',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflows_user_created_idx ON workflows (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id     UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  step_order      INT NOT NULL,
  tool_name       TEXT NOT NULL,
  action          TEXT NOT NULL,
  action_payload  JSONB NOT NULL,
  status          step_status NOT NULL DEFAULT 'pending',
  requires_confirmation BOOLEAN NOT NULL DEFAULT false,
  idempotency_key UUID NOT NULL UNIQUE,
  external_ref_id TEXT,
  error_message   TEXT,
  attempts        INT NOT NULL DEFAULT 0,
  executed_at     TIMESTAMPTZ,
  UNIQUE (workflow_id, step_order)
);
CREATE INDEX IF NOT EXISTS workflow_steps_workflow_idx ON workflow_steps (workflow_id, step_order);

-- Reserve-then-commit ledger. A row is INSERTed (reserved) before the external call and
-- UPDATEd (committed) after it returns. A reserved-but-uncommitted row on restart means
-- "we may or may not have caused the side effect" — see engine/executor.js.
CREATE TABLE IF NOT EXISTS idempotency_ledger (
  idempotency_key UUID PRIMARY KEY,
  tool_name       TEXT NOT NULL,
  action          TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('reserved','committed')),
  external_ref_id TEXT,
  reserved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS reminders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_id UUID REFERENCES workflows(id) ON DELETE SET NULL,
  fire_at     TIMESTAMPTZ NOT NULL,
  status      reminder_status NOT NULL DEFAULT 'pending',
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders (status, fire_at);

CREATE TABLE IF NOT EXISTS tool_permissions (
  tool_name       TEXT PRIMARY KEY,
  allowed_actions TEXT[] NOT NULL
);

-- Default grant: everything the tool registry exposes EXCEPT gmail.delete_email,
-- which exists in the registry precisely so the negative test has something real to block.
INSERT INTO tool_permissions (tool_name, allowed_actions) VALUES
  ('gmail',     ARRAY['send_email','create_draft']),
  ('calendar',  ARRAY['create_event','list_events']),
  ('reminders', ARRAY['create_reminder','cancel_reminder'])
ON CONFLICT (tool_name) DO NOTHING;
