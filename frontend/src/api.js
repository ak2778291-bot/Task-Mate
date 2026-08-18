const BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000';

let token = null;
export function setToken(value) {
  token = value;
}
export function getToken() {
  return token;
}

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  // 422 from POST /workflows is a *result* (a blocked plan), not a transport failure —
  // the caller needs the body, so only genuinely failed calls throw.
  if (!res.ok && res.status !== 422) {
    const err = new Error(data?.error?.message || `Request failed (${res.status})`);
    err.code = data?.error?.code;
    err.details = data?.error?.details;
    throw err;
  }
  return { status: res.status, data };
}

export const api = {
  health: () => call('/health'),
  register: (email, password) => call('/auth/register', { method: 'POST', body: { email, password } }),
  login: (email, password) => call('/auth/login', { method: 'POST', body: { email, password } }),
  me: () => call('/auth/me'),
  googleUrl: () => call('/auth/google'),
  tools: () => call('/tools'),
  plan: (request) =>
    call('/workflows', {
      method: 'POST',
      body: { request, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    }),
  confirm: (id) => call(`/workflows/${id}/confirm`, { method: 'POST' }),
  resume: (id) => call(`/workflows/${id}/resume`, { method: 'POST' }),
  workflows: () => call('/workflows'),
  reminders: () => call('/reminders'),
};

export default api;
