import { useCallback, useEffect, useState } from 'react';
import api, { setToken } from './api.js';

const EXAMPLES = [
  'Remind me to follow up with ana@example.com on Friday',
  'Send an email to ana@example.com about the handover notes',
  'Schedule a sync with ana@example.com and email them the agenda',
];

const STAMP = {
  validated: ['idle', 'Ready'],
  pending: ['idle', 'Not validated'],
  executing: ['hold', 'Running'],
  executed: ['done', 'Done'],
  failed: ['stop', 'Failed'],
  skipped: ['stop', 'Blocked'],
  in_doubt: ['stop', 'In doubt'],
};

const WORKFLOW_STAMP = {
  planned: ['idle', 'Ready'],
  awaiting_confirmation: ['hold', 'Needs you'],
  executing: ['hold', 'Running'],
  completed: ['done', 'Done'],
  failed: ['stop', 'Stopped'],
};

function Stamp({ status, map = STAMP }) {
  const [tone, label] = map[status] || ['idle', status];
  return <span className={`stamp ${tone}`}>{label}</span>;
}

function Step({ step }) {
  const blocked = step.status === 'skipped' || step.status === 'failed';
  return (
    <div
      className={`step${step.requires_confirmation ? ' irreversible' : ''}${blocked ? ' blocked' : ''}`}
    >
      <div className="step-ordinal">{String(step.step_order).padStart(2, '0')}</div>
      <div className="step-main">
        <span className="step-status">
          <Stamp status={step.status} />
        </span>
        <div className="step-call">
          {step.tool_name}
          <span className="dot">.</span>
          {step.action}
        </div>
        <p className="step-args">{JSON.stringify(step.action_payload, null, 1)}</p>
        {step.error_message && <p className="step-note">{step.error_message}</p>}
        {step.external_ref_id && <p className="step-ref">ref {step.external_ref_id}</p>}
      </div>
    </div>
  );
}

function Manifest({ workflow, summary, violations = [], onConfirm, onResume, onDiscard, busy }) {
  const needsYou = workflow.status === 'awaiting_confirmation' || workflow.status === 'planned';
  const irreversible = workflow.steps.filter((s) => s.requires_confirmation).length;

  return (
    <section className="sheet">
      <header className="sheet-head">
        <span>Proposed plan</span>
        <Stamp status={workflow.status} map={WORKFLOW_STAMP} />
      </header>
      {summary && <div className="sheet-body" style={{ paddingBottom: 0 }}>{summary}</div>}
      {violations.length > 0 && (
        <div className="sheet-body" style={{ paddingBottom: 0 }}>
          <p className="notice">
            {violations.length === 1
              ? 'This plan was refused before anything ran.'
              : `${violations.length} steps were refused before anything ran.`}{' '}
            {violations[0].code}: {violations[0].message}
          </p>
        </div>
      )}
      <div>
        {workflow.steps.map((step) => (
          <Step key={step.id} step={step} />
        ))}
      </div>
      <div className="actions">
        {needsYou && (
          <>
            <button className={`btn${irreversible ? ' hold' : ''}`} onClick={onConfirm} disabled={busy}>
              {busy ? 'Running…' : irreversible ? 'Approve and run' : 'Run this plan'}
            </button>
            <button className="btn ghost" onClick={onDiscard} disabled={busy}>
              Discard
            </button>
            {irreversible > 0 && (
              <span className="hint">
                {irreversible} step{irreversible > 1 ? 's' : ''} can’t be undone. Nothing runs until you approve.
              </span>
            )}
          </>
        )}
        {workflow.status === 'failed' && workflow.steps.some((s) => s.status !== 'skipped') && (
          <>
            <button className="btn" onClick={onResume} disabled={busy}>
              Resume from the last incomplete step
            </button>
            <span className="hint">Completed steps are skipped — no duplicate side effects.</span>
          </>
        )}
        {workflow.status === 'completed' && <span className="hint">Every step finished. See the record below.</span>}
        {violations.length > 0 && (
          <button className="btn ghost" onClick={onDiscard}>
            Start over
          </button>
        )}
      </div>
    </section>
  );
}

function History({ workflows, onResume, busy }) {
  const [openId, setOpenId] = useState(null);

  if (!workflows.length) {
    return (
      <section className="sheet">
        <header className="sheet-head"><span>Record</span></header>
        <p className="empty">Nothing has run yet. Every plan you approve is kept here, step by step.</p>
      </section>
    );
  }

  return (
    <section className="sheet">
      <header className="sheet-head">
        <span>Record</span>
        <span>{workflows.length} request{workflows.length > 1 ? 's' : ''}</span>
      </header>
      {workflows.map((w) => (
        <article className="record" key={w.id}>
          <button className="record-head" onClick={() => setOpenId(openId === w.id ? null : w.id)}>
            <span className="record-request">{w.request_text}</span>
            <span style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
              <span className="record-time">{new Date(w.created_at).toLocaleString()}</span>
              <Stamp status={w.status} map={WORKFLOW_STAMP} />
            </span>
          </button>
          {openId === w.id && (
            <>
              <div>{w.steps.map((s) => <Step key={s.id} step={s} />)}</div>
              {w.status === 'failed' && w.steps.some((s) => s.status !== 'skipped') && (
                <div className="actions">
                  <button className="btn ghost" onClick={() => onResume(w.id)} disabled={busy}>
                    Resume
                  </button>
                </div>
              )}
            </>
          )}
        </article>
      ))}
    </section>
  );
}

function SignIn({ onSignedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState('register');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const { data } = mode === 'register' ? await api.register(email, password) : await api.login(email, password);
      onSignedIn(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="sheet auth">
      <header className="sheet-head">
        <span>{mode === 'register' ? 'Create an account' : 'Sign in'}</span>
      </header>
      <div className="sheet-body">
        {error && <p className="notice">{error}</p>}
        <label htmlFor="email">Email</label>
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <div className="composer-row">
          <button className="btn" onClick={submit} disabled={busy || !email || password.length < 8}>
            {mode === 'register' ? 'Create account' : 'Sign in'}
          </button>
          <button
            className="btn ghost"
            onClick={() => { setMode(mode === 'register' ? 'login' : 'register'); setError(null); }}
          >
            {mode === 'register' ? 'I already have an account' : 'Create one instead'}
          </button>
        </div>
      </div>
    </section>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  const [health, setHealth] = useState(null);
  const [request, setRequest] = useState('');
  const [proposal, setProposal] = useState(null);
  const [workflows, setWorkflows] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.health().then(({ data }) => setHealth(data)).catch(() => setHealth(null));
  }, []);

  const refresh = useCallback(async () => {
    const { data } = await api.workflows();
    setWorkflows(data.workflows);
  }, []);

  useEffect(() => {
    if (session) refresh().catch((err) => setError(err.message));
  }, [session, refresh]);

  function signedIn(data) {
    setToken(data.token);
    setSession(data.user);
  }

  async function submitRequest() {
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.plan(request);
      setProposal({ workflow: data.workflow, summary: data.summary, violations: data.violations });
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function run(id, how = 'confirm') {
    setBusy(true);
    setError(null);
    try {
      const { data } = how === 'confirm' ? await api.confirm(id) : await api.resume(id);
      setProposal((p) => (p && p.workflow.id === id ? { ...p, workflow: data.workflow } : p));
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <header className="masthead">
        <h1 className="wordmark">
          One Work Space<span>.</span>
        </h1>
        <div className="masthead-meta">
          {health && <span>Google: {health.google}</span>}
          {health && <span>Planner: {health.planner}</span>}
          {session && <span>{session.email}</span>}
        </div>
      </header>

      <p className="thesis">
        Say what you want done. You get back <em>a plan, not an action</em> — checked against what this
        system is allowed to do, and held until you approve anything that can’t be undone.
      </p>

      {error && <p className="notice">{error}</p>}

      {!session ? (
        <SignIn onSignedIn={signedIn} />
      ) : (
        <>
          <section className="sheet composer">
            <header className="sheet-head">
              <span>New request</span>
            </header>
            <div className="sheet-body">
              <textarea
                value={request}
                onChange={(e) => setRequest(e.target.value)}
                placeholder="Remind me to follow up with ana@example.com on Friday"
                aria-label="What do you want done?"
              />
              <div className="examples">
                {EXAMPLES.map((ex) => (
                  <button key={ex} onClick={() => setRequest(ex)}>{ex}</button>
                ))}
              </div>
              <div className="composer-row">
                <button className="btn" onClick={submitRequest} disabled={busy || request.trim().length < 3}>
                  {busy ? 'Working…' : 'Draft a plan'}
                </button>
                <span className="hint">Nothing leaves this machine until you approve it.</span>
              </div>
            </div>
          </section>

          {proposal && (
            <Manifest
              workflow={proposal.workflow}
              summary={proposal.summary}
              violations={proposal.violations}
              busy={busy}
              onConfirm={() => run(proposal.workflow.id, 'confirm')}
              onResume={() => run(proposal.workflow.id, 'resume')}
              onDiscard={() => { setProposal(null); setRequest(''); }}
            />
          )}

          <History workflows={workflows} busy={busy} onResume={(id) => run(id, 'resume')} />
        </>
      )}
    </div>
  );
}
