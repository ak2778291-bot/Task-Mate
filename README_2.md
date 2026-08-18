# One Work Space

A natural-language request — *"remind me to follow up with Ana on Friday"*, *"email Ana about the handover"* — becomes a validated, permissioned plan of tool calls executed against real Gmail and Google Calendar APIs, with every step persisted and resumable.

> **The thesis.** The LLM never touches an external API directly. It proposes a structured action plan, which is validated against explicit tool permissions and — for irreversible actions — confirmed by the user, before a permissioned tool layer executes it against Gmail/Calendar with idempotency guarantees.

That sentence is the whole design. The technology list is downstream of it.

---

## Run it

The system runs with no Google credentials and no LLM key. Without them it uses a deterministic offline planner and an in-process fake Google that reproduces the two real API behaviours the reliability logic depends on (see [DESIGN.md](DESIGN.md)). This is what makes the interesting parts demoable in one command.

```bash
cp .env.example .env          # optional: fill in ANTHROPIC_API_KEY / Google OAuth creds
docker compose up --build
# frontend  http://localhost:5173
# backend   http://localhost:4000/health
```

Local, without Docker:

```bash
# terminal 1
cd backend && npm install && npm run migrate && npm run seed && npm run dev
# terminal 2
cd frontend && npm install && npm run dev
```

Run the tests:

```bash
cd backend && npm test        # 32 tests, no services required
cd backend && npm run lint
```

### Going live against real Google

1. Create an OAuth 2.0 Web client in Google Cloud Console; add `http://localhost:4000/auth/google/callback` as a redirect URI.
2. Enable the Gmail API and Calendar API.
3. Put the client ID/secret in `.env` and set `MOCK_GOOGLE=0`.
4. Generate a real encryption key: `openssl rand -hex 32` → `TOKEN_ENCRYPTION_KEY`.
5. Sign in, then `GET /auth/google` returns the consent URL.

Scopes requested are `gmail.send`, `gmail.compose`, `gmail.metadata`, `calendar.events` — send and create, never full mailbox read, never Drive.

---

## Architecture

```
                    ┌─────────────┐
  "email Ana about  │   React UI  │  shows the plan; holds irreversible
   the handover"───▶│  (manifest) │  steps until the user approves
                    └──────┬──────┘
                           │ POST /workflows
                    ┌──────▼──────────────────────────────────────┐
                    │              Orchestrator                   │
                    │  request ─▶ planner ─▶ validator ─▶ persist  │
                    └──────┬──────────────────────────────────────┘
             ┌─────────────┴────────────┐
      ┌──────▼───────┐         ┌────────▼─────────┐
      │   Planner    │         │    Validator     │  ◀── tool_permissions (DB)
      │ forced tool- │         │  1 shape         │
      │ use → typed  │         │  2 existence     │      fails CLOSED:
      │ action plan  │         │  3 permission    │      one bad step
      └──────────────┘         │  4 arg schema    │      rejects the plan
        (never sees            └────────┬─────────┘
         credentials)                   │ validated steps persisted
                                 ┌──────▼──────────────────────┐
                                 │        Executor             │
     POST /workflows/:id/confirm │  reserve ─▶ call ─▶ commit   │
     POST /workflows/:id/resume  │  per-step idempotency key    │
                                 │  reconcile on crash          │
                                 │  retry w/ backoff (transient)│
                                 └──────┬──────────────────────┘
                                        │ the ONLY path to an external API
                                 ┌──────▼──────────────────────┐
                                 │       Tool layer            │
                                 │  re-checks permissions      │
                                 │  parses args against Zod    │
                                 └──────┬──────────────────────┘
                                        │
                          ┌─────────────┴────────────┐
                     ┌────▼─────┐              ┌─────▼──────┐
                     │  Gmail   │              │  Calendar  │
                     └──────────┘              └────────────┘

  node-cron ──▶ polls reminders + sweeps workflows stuck in 'executing'
```

**Reading order**, if you want to follow the interesting path through the code:

| File | What it is |
|---|---|
| `src/tools/registry.js` | Every action the system can take: schema, reversibility, handler, reconciliation. Single source of truth. |
| `src/validation/validator.js` | The permission gate. Section 4.1. |
| `src/engine/executor.js` | Reserve → call → commit, reconciliation, resume. Section 4.2. |
| `src/tools/index.js` | The only code that reaches an external API. |
| `src/planner/planner.js` | Forced tool-use: the model can only emit a typed plan. |

---

## API

| Method | Path | Notes |
|---|---|---|
| `POST` | `/auth/register`, `/auth/login` | JWT |
| `GET` | `/auth/google` | Returns the consent URL |
| `GET` | `/auth/google/callback` | Exchanges the code, stores the refresh token encrypted |
| `POST` | `/workflows` | Request → plan. `201` if accepted, `422` with violations if refused. **Executes nothing.** |
| `POST` | `/workflows/:id/confirm` | User approval → execution |
| `POST` | `/workflows/:id/resume` | Resume after a failure or crash |
| `GET` | `/workflows`, `/workflows/:id` | Full step-by-step history |
| `GET/POST/DELETE` | `/reminders` | Delete cancels rather than destroys |
| `GET` | `/tools` | The catalogue, and what this deployment has granted |

---

## The two things this project is actually about

### 1. An out-of-permission action is provably blocked

`gmail.delete_email` is fully implemented in the tool registry and granted to nobody. When the model proposes it:

```
POST /workflows  →  422
{
  "violations": [{ "code": "PERMISSION_DENIED",
                   "message": "gmail.delete_email is not in the granted permission set" }],
  "workflow": { "status": "failed", "steps": [{ "status": "skipped", ... }] }
}
```

The refusal is persisted as a skipped step, so it shows up in history rather than only in a log. The test asserts the Google call counters are all still zero — nothing was attempted, not merely nothing succeeded.

```bash
npm test -- tests/validation.test.js
```

### 2. A mid-workflow crash resumes without duplicating a side effect

Two tests, covering two different crashes:

- **Between steps** — dies after the email is sent, before the calendar event. Resume completes the workflow; exactly one email.
- **Inside a step** — dies *after* Gmail accepted the message but *before* the status write. On disk the step still looks unfinished. A naive "status !== executed" resume sends a second email here. This one reconciles instead: Gmail is queried for the Message-ID the step pinned, the existing send is adopted, and the count stays at one.

```bash
npm test -- tests/idempotency.test.js
```

This was mutation-tested rather than trusted: stub out Gmail reconciliation and the second test fails with `expected 2 to be 1` — a real duplicate email. The mechanism is load-bearing, not decorative.

---

## Testing

| Suite | Covers |
|---|---|
| `tests/validation.test.js` | Plan shape, unknown tools/actions, permission denial, argument schemas, fail-closed behaviour, runtime permission revocation |
| `tests/idempotency.test.js` | Happy path, confirmation gate, both crash shapes, duplicate-key dedup, transient retry, permanent-failure halt |
| `tests/integration.test.js` | Full HTTP path: request → plan → confirm → real side effect → history; authz isolation; scheduler |
| `tests/planner.test.js` | Forced tool-use, prose degradation, prompt never advertises ungranted tools, offline planner output survives validation |

Dependencies are injected throughout, so the whole system assembles over an in-memory repository and a fake Google. That is why CI needs no services.

---

## Deployment

Backend + Postgres on Render/Railway, frontend on Vercel. Managed hosting is a deliberate trade-off, not an omission: the limited time went into the agent and reliability logic rather than infra ops. `docker compose up` reproduces the whole stack locally.

Step-by-step deployment, the Google Cloud Console gotchas, and a three-minute demo script are in [DEPLOY.md](DEPLOY.md).

Design decisions and the things deliberately left out are written up in [DESIGN.md](DESIGN.md).
