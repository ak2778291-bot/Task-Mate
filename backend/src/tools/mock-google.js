import { randomUUID } from 'node:crypto';

/**
 * A fake Google that reproduces exactly the two real API behaviours this system depends on:
 *
 *   1. Gmail assigns a message its RFC-822 Message-ID and lets you find it again with
 *      `q=rfc822msgid:<...>` — that is how a send can be reconciled after a crash.
 *   2. Calendar accepts a client-assigned event id and returns 409 on a duplicate — that is
 *      real, provider-side idempotency for event creation.
 *
 * Used when MOCK_GOOGLE=1 (the default when no OAuth client is configured) so the system is
 * demoable and testable end-to-end without credentials. `sentCount` lets tests assert that a
 * crash + resume produced exactly one side effect.
 */
export function createMockGoogle() {
  const messages = new Map(); // rfc822MsgId -> message
  const drafts = new Map();
  const events = new Map(); // eventId -> event
  const counters = { send: 0, draft: 0, event: 0, list: 0 };

  return {
    kind: 'mock',
    counters,

    gmail: {
      async sendMessage({ to, subject, body, rfc822MsgId }) {
        counters.send += 1; // deliberately counts *every* attempted delivery
        const id = randomUUID();
        const msg = {
          id,
          threadId: id,
          rfc822MsgId,
          to,
          subject,
          body,
          sentAt: new Date().toISOString(),
        };
        messages.set(rfc822MsgId, msg);
        return { id, threadId: id };
      },
      async findByRfc822MsgId(rfc822MsgId) {
        const msg = messages.get(rfc822MsgId);
        return msg ? { id: msg.id, threadId: msg.threadId } : null;
      },
      async createDraft({ to, subject, body }) {
        counters.draft += 1;
        const id = randomUUID();
        drafts.set(id, { id, to, subject, body });
        return { id };
      },
      _sent: () => [...messages.values()],
    },

    calendar: {
      async insertEvent(event) {
        counters.event += 1;
        if (events.has(event.id)) {
          const err = new Error('The requested identifier already exists.');
          err.code = 409;
          err.status = 409;
          throw err;
        }
        events.set(event.id, { ...event, htmlLink: `https://calendar.example/${event.id}` });
        return events.get(event.id);
      },
      async getEvent(id) {
        return events.get(id) || null;
      },
      async listEvents({ timeMin, timeMax }) {
        counters.list += 1;
        return [...events.values()]
          .filter((e) => (!timeMin || e.start >= timeMin) && (!timeMax || e.start <= timeMax))
          .sort((a, b) => String(a.start).localeCompare(String(b.start)));
      },
      _all: () => [...events.values()],
    },
  };
}

export default createMockGoogle;
