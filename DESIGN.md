# DESIGN.md

Why this system is shaped the way it is, and what I deliberately didn't build. Written the way I'd answer it out loud.

---

## 1. The one idea

Most "AI agent" projects hand the model an API client and hope the prompt holds. That is a chatbot with API keys: the safety property lives in text the model is free to ignore, and there is nothing to test.

Here the model's output is **data, never instruction**. It emits a typed action plan; a validation layer checks it against a permission set the model cannot see or modify; irreversible actions wait for a human; and a separate permissioned tool layer is the only code in the repo that touches an external API. A prompt-injected or hallucinated plan is just a plan that fails validation.

That relocation — from prompt to type system and permission table — is the project. Everything below serves it.

---

## 2. Decisions

### Node + Express, not FastAPI
JavaScript end-to-end with the React frontend removes context-switching on a tight timeline. This project's complexity is orchestration logic, not async I/O throughput, so there's no framework-level reason to prefer FastAPI. If the bottleneck were fan-out over many concurrent upstream calls, that calculus changes.

### PostgreSQL
Workflow steps, users, and tokens are relational, and the idempotency guarantee depends on transactional writes and a unique constraint. `INSERT ... ON CONFLICT DO NOTHING` on the ledger *is* the atomic reservation primitive — a document store would push me into implementing that by hand.

### Structured/tool-use output, not prompt-and-parse
The model gets exactly one tool, `submit_action_plan`, with `tool_choice` forcing it. It physically cannot reply with prose. Asking for JSON in a prompt and parsing it is the same idea with worse failure modes — and when the model does return prose anyway, the planner returns an empty plan rather than throwing, because an unusable plan is a validation failure like any other, not a crash.

### A typed tool registry rather than MCP
MCP is the resume-relevant framing, and I evaluated it. Given the timeline I built an equivalent permission-enforced tool layer directly, because the engineering point — the LLM never calls an external API, only a permissioned tool function does — survives either way. The registry defines schema, reversibility, handler, and reconciliation per action, and generates the model's tool catalogue, so the model cannot name an action or argument shape that doesn't exist.

### Gmail + Calendar only, least-privilege scopes
`gmail.send`, `gmail.compose`, `gmail.metadata`, `calendar.events`. No full-mailbox read, no Drive, no Tasks. `gmail.metadata` is there for one specific reason — the crash-reconciliation lookup needs to find a message by its Message-ID — which is the kind of scope justification that should exist for every scope requested.

Adding Drive or Tasks would pad the technology list without introducing a new engineering idea.

### `node-cron` polling a table, not a message queue
A queue earns its complexity with real backpressure or worker-scaling needs. Neither exists here. The Postgres poller uses `FOR UPDATE SKIP LOCKED`, so it stays correct if a second instance is ever started — which is usually the first property people reach for a queue to get. At meaningful throughput, BullMQ/Redis is the explicit next step, and the executor's interface wouldn't change.

### JWT
Stateless and standard. Not itself interesting; the interesting security work is the permission layer and encrypting refresh tokens at rest with AES-256-GCM, keyed from the environment so a database dump alone doesn't yield usable Google credentials.

### Dependency injection everywhere
The repository, tool layer, planner, and Google client are all parameters. Two consequences: the whole system assembles over an in-memory repo and a fake Google, so CI runs the real engine with no services; and a resume in a test is a genuine process restart — new objects, same persisted state.

---

## 3. The permission gate (Section 4.1)

Four gates, in order: **shape** → **existence** → **permission** → **arguments**.

Two choices in there worth defending:

**It fails closed.** One violation rejects the entire plan, including its legal steps. Executing "the safe half" of a plan the model got wrong leaves you with a half-finished workflow containing real side effects and no clean resume point. Refusing the whole thing is recoverable; partial execution isn't.

**Only parsed arguments survive.** The validator keeps the Zod-parsed value, not the model's original object, so invented keys are dropped rather than forwarded. If the model adds `bcc: attacker@evil.com` to a send, that key never reaches the handler. There's a test for exactly this.

**Defence in depth.** The tool layer re-checks permissions at call time even though the validator already checked at plan time. The validator protects the *plan*; the tool layer protects the *process*. Any future path — a retry, a resume, a scheduler-triggered step, a bug I haven't written yet — still cannot execute an ungranted action. A test revokes a permission at runtime and confirms the tool layer refuses even for a previously-valid action.

**The fixture.** `gmail.delete_email` is a fully implemented registry action granted to nobody. Without it, "unauthorized actions are blocked" would be a claim about code that doesn't exist. With it, the negative test fires at something real.

---

## 4. Idempotency and resume (Section 4.2)

The naive design is "skip steps whose status is `executed`". That only survives a crash *between* steps. The dangerous crash is *inside* one:

```
send email ──▶ Gmail accepts ──▶ ✗ process dies ──▶ status write never happens
```

On restart the step still reads `validated`. A naive resume sends the email twice — and duplicate emails are exactly the failure this project claims to prevent.

So every step runs **reserve → call → commit** against an idempotency ledger:

| Ledger state on resume | What it means | What the executor does |
|---|---|---|
| no entry | never attempted | execute |
| `committed` | side effect happened | adopt the reference, skip |
| `reserved`, not committed | **crashed mid-call — unknown** | ask the provider |

That third row is the whole design. "Ask the provider" is `reconcile`, and it works because each action pins something the provider can be queried by:

- **Gmail** — the step's idempotency key becomes the RFC-822 `Message-ID`, found again with `q=rfc822msgid:`.
- **Calendar** — the key becomes the client-assigned event id; a duplicate insert returns `409`, which the handler treats as success rather than failure.

Both are real Google behaviours. The fake Google implements the same two contracts, which is why the tests exercise the real logic rather than a convenient stub.

**When the question can't be answered**, the step is parked as `in_doubt` and the workflow halts for manual review. It is *not* retried. Repeating an irreversible action on a guess is the exact failure mode this mechanism exists to prevent, and a system that guesses wrong under uncertainty is worse than one that stops.

**Retry is only for transient failures** — 429/5xx and socket errors, with exponential backoff and jitter. A permission or validation failure is a permanent answer; retrying it just makes the same wrong call three times. On a clean permanent failure the reservation is released, so a later resume doesn't see a false "in doubt" and park a step that simply failed.

**Halt, don't skip.** A failed step stops the workflow. Later steps usually assume earlier ones happened, so continuing past a failure produces incoherent state. Everything after stays untouched and resumable.

**Resume is not a separate code path.** `resumeWorkflow` is `runWorkflow` — executed steps are skipped by the same loop that ran them. A resume path that only runs after crashes is a path that silently rots; this one is exercised by every single test that calls the executor.

---

## 5. Explicitly cut

| Cut | Reason |
|---|---|
| Multi-agent orchestration | Email and calendar are parameterized actions, not independent reasoning problems needing hand-off. One orchestrator with tools is simpler, testable end-to-end, and gives permissions exactly one place to live. Multiple agents would mean multiple enforcement points. |
| Message queue (Kafka/BullMQ) | No throughput or worker-scaling problem at this scale. `SKIP LOCKED` covers the multi-instance correctness a queue would otherwise be bought for. |
| Full observability stack | Structured JSON logging keyed by `workflow_id`/`step_id` covers debugging at demo scale. Traces earn their keep across service boundaries; there's one service. |
| Multi-environment CI/CD | One lint + test workflow is genuine signal. A staging pipeline needs infrastructure this project doesn't have. |
| Exhaustive test pyramid | Depth on the two guarantees that matter, plus one full integration path and the negative cases. Coverage percentage would measure the wrong thing here. |
| More than 2 Google integrations | Drive/Tasks add surface area, not ideas. |
| VPS/Docker-in-production | Managed hosting so limited time went to agent and reliability logic rather than infra ops. |

---

## 6. What I'd do next

1. **Queue-backed execution** when throughput justifies it — the executor interface is already the seam.
2. **Per-user permission sets.** `tool_permissions` is currently global; the schema and validator take a table lookup, so scoping it per user is a join, not a redesign.
3. **A reconciliation sweep for `in_doubt` steps** — today they wait for a human, which is correct but manual.
4. **Plan diffing on resume**, so a resumed workflow re-validates against permissions that may have changed since it was planned.
5. **Rate limiting and audit export.** Every action is already persisted with an idempotency key and external reference, so the audit trail exists; it just isn't exposed.
