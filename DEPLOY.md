# DEPLOY.md

Backend + Postgres on Render, frontend on Vercel. Roughly 45 minutes end to end, most of it waiting on Google's consent screen form.

Do it in this order. The Google redirect URI needs the backend's real URL, and the backend's CORS origin needs the frontend's real URL, so deploying out of order means going back to fix env vars twice.

---

## 1. Backend + database (Render)

1. Push the repo to GitHub.
2. Render dashboard → **New → Blueprint** → select the repo. It reads `render.yaml` and creates `ows-postgres` and `ows-backend` together.
3. Fill the secrets marked `sync: false` in the dashboard — the blueprint deliberately doesn't carry them:

   | Variable | Value |
   |---|---|
   | `TOKEN_ENCRYPTION_KEY` | `openssl rand -hex 32` — exactly 64 hex characters |
   | `ANTHROPIC_API_KEY` | your key, or leave blank to run the offline planner |
   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | from step 3 below |
   | `GOOGLE_REDIRECT_URI` | `https://<your-backend>.onrender.com/auth/google/callback` |
   | `CORS_ORIGIN` | your Vercel URL, filled in after step 2 |

4. Deploy, then confirm:

```bash
curl https://<your-backend>.onrender.com/health
# {"ok":true,"google":"live","planner":"llm"}
```

If `google` reads `mock`, `GOOGLE_CLIENT_ID` didn't reach the container — `config.js` falls back to the fake Google whenever that variable is empty, which is deliberate but easy to miss.

**Two things about the free tier**, both worth being able to explain:

- The instance sleeps after ~15 minutes idle, so the first request after a gap takes 30–60s. Say so before a live demo rather than during one.
- While it sleeps, `node-cron` isn't running. Reminders still fire, just late — the poller selects `fire_at <= now()` rather than matching an exact timestamp, so everything that came due during the sleep is picked up on the next tick after wake. That's a property of polling a table, and one of the honest advantages over a fire-once in-memory timer.

Railway works identically: point it at `backend/Dockerfile`, add the Postgres plugin, set the same variables. `DATABASE_URL` is injected automatically.

---

## 2. Frontend (Vercel)

1. **Add New → Project** → same repo → set **Root Directory** to `frontend`.
2. Environment variable: `VITE_API_URL = https://<your-backend>.onrender.com`.
3. Deploy. `vercel.json` handles the SPA rewrite and the Vite build.

Vite inlines `VITE_*` variables at build time, so changing `VITE_API_URL` needs a **redeploy**, not just a save. This is the single most common wasted half-hour on this step.

Now go back to Render and set `CORS_ORIGIN` to the Vercel URL (no trailing slash). The backend splits it on commas, so you can allow the preview domain too:

```
CORS_ORIGIN=https://one-work-space.vercel.app,http://localhost:5173
```

---

## 3. Google Cloud Console

1. New project → **APIs & Services → Library** → enable **Gmail API** and **Google Calendar API**.
2. **OAuth consent screen** → External. Add yourself under **Test users**.
3. Add these scopes: `gmail.send`, `gmail.compose`, `gmail.metadata`, `calendar.events`.
4. **Credentials → Create Credentials → OAuth client ID → Web application.** Authorised redirect URIs:

```
https://<your-backend>.onrender.com/auth/google/callback
http://localhost:4000/auth/google/callback
```

Google matches redirect URIs exactly — scheme, host, path, trailing slash. A mismatch gives `redirect_uri_mismatch`, which is a config error, not a code error.

### Leave the app in Testing mode

Do not click "Publish app". Gmail scopes are restricted, and publishing triggers Google's verification process — a privacy policy, a demo video, and for restricted scopes a third-party CASA security assessment that costs money and takes weeks. Testing mode allows up to 100 test users, which is 99 more than a portfolio project needs.

Consequences to expect and explain rather than hide:

- Unverified apps show an "unverified" interstitial. Click *Advanced → Go to (app)*. Demo from your own account so this is expected, not a surprise on a call.
- **Refresh tokens for apps in Testing mode expire after 7 days.** Reconnect before any demo. This is why `GET /auth/google` exists as an endpoint rather than a one-time setup script — and it's a good answer to "what would you change for production": publish and verify, or move to a service account with domain-wide delegation for a Workspace tenant.

If you'd rather not touch real Google at all for a demo, set `MOCK_GOOGLE=1`. The fake implements the same two contracts (Message-ID lookup, client-assigned event IDs), so the idempotency behaviour you're demonstrating is genuinely the same code path — worth stating out loud, since "it's mocked" otherwise sounds like a dodge.

---

## 4. Post-deploy check

```bash
API=https://<your-backend>.onrender.com

curl -s $API/health
curl -s $API/tools | grep -o '"action":"delete_email","[^}]*granted":false'   # the ungranted action

TOKEN=$(curl -s -X POST $API/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"a-real-password"}' | jq -r .token)

curl -s -X POST $API/workflows -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"request":"Remind me to follow up with ana@example.com on Friday"}' | jq '.workflow.status'
# "planned"  — planned, not executed
```

Checklist:

- [ ] `/health` returns `google: live`, `planner: llm`
- [ ] Frontend loads and can register
- [ ] Google connect completes and returns to the app
- [ ] A send-email request stops at `awaiting_confirmation`
- [ ] Confirming produces a real email
- [ ] History shows both steps with refs
- [ ] CI green on push

---

## 5. The live demo, in about three minutes

Rehearse this out loud once. The failure mode in interviews isn't the code, it's narrating it badly under time pressure.

**Beat 1 — the plan is not the action (~40s).** Type *"Send an email to ana@example.com about the handover and schedule a sync."* Point at the screen: two steps, both `validated`, nothing sent. "The model produced this, but it's a proposal. It has no credentials and no network access. Both steps are marked irreversible, so nothing runs until I approve."

**Beat 2 — approval and real side effects (~30s).** Click *Approve and run*. Show the email in Gmail and the event in Calendar. Point at the step refs in history: "every step persists its external reference, which matters in a moment."

**Beat 3 — the refusal (~40s).** Have `/tools` open in a second tab showing `delete_email` as ungranted. "`delete_email` is fully implemented in the tool registry. It's granted to nobody." Then run the test:

```bash
npm test -- tests/validation.test.js -t "never reaches the tool layer"
```

"The assertion isn't just that it failed — it's that the Google call counters are still zero. Nothing was attempted."

**Beat 4 — the crash (~60s).** This is the beat that separates the project from a demo.

```bash
npm test -- tests/idempotency.test.js -t "reconciles a crash inside the send window"
```

"The dangerous crash isn't between steps — it's inside one. Gmail accepted the message, then the process died before the status write. On disk the step still looks unfinished, so a naive resume sends a second email. Here the idempotency key was reserved but never committed, which means *unknown* rather than *not done*. So the resume asks Gmail: the key was pinned as the RFC-822 Message-ID, we look it up, find the send, and adopt it. One email."

If you have another 20 seconds, land it: "I checked this was real by breaking the reconciliation on purpose — the test fails with `expected 2 to be 1`. A duplicate email. So the mechanism is load-bearing, not decoration."

**Have ready but don't volunteer:** why fail-closed instead of executing the valid steps; why no message queue; why not MCP; what happens when reconciliation itself can't answer (the `in_doubt` state). Those are in DESIGN.md §3–§5.
