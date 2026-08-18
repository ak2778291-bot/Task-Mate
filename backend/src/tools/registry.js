import { z } from 'zod';

/**
 * The tool registry is the single source of truth for what this system can do.
 *
 * Every action declares:
 *   params        — a Zod schema. The LLM's arguments are parsed against it; anything that
 *                   does not parse never reaches a handler.
 *   irreversible  — true means "a human must confirm before this runs" (Section 4.1).
 *   handler       — the ONLY code path that touches an external API.
 *   reconcile     — optional. Answers "did this side effect already happen?" after a crash,
 *                   which is what lets the resume pass be safe instead of merely hopeful.
 *
 * The registry is also what the planner turns into the LLM's tool schema, so the model
 * physically cannot name a tool or argument shape that does not exist here.
 */

const isoDateTime = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'must be an ISO-8601 datetime' });

/** Calendar event ids must be base32hex (0-9, a-v), 5-1024 chars. Derived from the step's key
 *  so the same step always produces the same event id — provider-side idempotency for free. */
export function eventIdFor(idempotencyKey) {
  return `evt${String(idempotencyKey).replace(/-/g, '').toLowerCase()}`;
}

/** RFC-822 Message-ID derived from the step's key, so a sent mail can be found again. */
export function messageIdFor(idempotencyKey) {
  return `${String(idempotencyKey)}@one-work-space.local`;
}

export const TOOL_REGISTRY = {
  gmail: {
    description: 'Send mail or save drafts as the authenticated user.',
    actions: {
      send_email: {
        description: 'Send an email immediately. Irreversible: requires user confirmation.',
        irreversible: true,
        params: z.object({
          to: z.string().email(),
          subject: z.string().min(1).max(500),
          body: z.string().min(1).max(20000),
        }),
        async handler({ params, ctx }) {
          const res = await ctx.google.gmail.sendMessage({
            ...params,
            rfc822MsgId: messageIdFor(ctx.idempotencyKey),
          });
          return { externalRefId: res.id, detail: { threadId: res.threadId } };
        },
        async reconcile({ ctx }) {
          const hit = await ctx.google.gmail.findByRfc822MsgId(messageIdFor(ctx.idempotencyKey));
          return hit ? { externalRefId: hit.id, detail: { threadId: hit.threadId } } : null;
        },
      },
      create_draft: {
        description: 'Save an email as a draft without sending it.',
        irreversible: false,
        params: z.object({
          to: z.string().email(),
          subject: z.string().min(1).max(500),
          body: z.string().min(1).max(20000),
        }),
        async handler({ params, ctx }) {
          const res = await ctx.google.gmail.createDraft(params);
          return { externalRefId: res.id, detail: {} };
        },
      },
      // Registered but never granted in tool_permissions. It exists so the permission layer
      // has a real out-of-policy action to block, and so the block is proved in a test
      // rather than asserted in a README.
      delete_email: {
        description: 'Permanently delete a message. Not granted to any user.',
        irreversible: true,
        params: z.object({ messageId: z.string().min(1) }),
        async handler() {
          throw new Error('delete_email must never execute');
        },
      },
    },
  },

  calendar: {
    description: 'Create and read events on the user’s primary calendar.',
    actions: {
      create_event: {
        description: 'Create a calendar event. Confirmed by the user because it notifies attendees.',
        irreversible: true,
        params: z.object({
          summary: z.string().min(1).max(500),
          start: isoDateTime,
          end: isoDateTime,
          description: z.string().max(5000).optional(),
          attendees: z.array(z.string().email()).max(25).optional(),
        }),
        async handler({ params, ctx }) {
          const id = eventIdFor(ctx.idempotencyKey);
          try {
            const res = await ctx.google.calendar.insertEvent({ id, ...params });
            return { externalRefId: res.id, detail: { htmlLink: res.htmlLink } };
          } catch (err) {
            // 409 means this exact event id already exists: a retry of a call that
            // actually succeeded. Treat it as success, not failure.
            if (err.code === 409 || err.status === 409) {
              return { externalRefId: id, detail: { deduplicated: true } };
            }
            throw err;
          }
        },
        async reconcile({ ctx }) {
          const existing = await ctx.google.calendar.getEvent(eventIdFor(ctx.idempotencyKey));
          return existing ? { externalRefId: existing.id, detail: { reconciled: true } } : null;
        },
      },
      list_events: {
        description: 'List events in a time range. Read-only.',
        irreversible: false,
        readOnly: true,
        params: z.object({ timeMin: isoDateTime, timeMax: isoDateTime }),
        async handler({ params, ctx }) {
          const events = await ctx.google.calendar.listEvents(params);
          return { externalRefId: null, detail: { events } };
        },
      },
    },
  },

  reminders: {
    description: 'Schedule internal reminders that fire from the scheduler.',
    actions: {
      create_reminder: {
        description: 'Schedule a reminder to fire at a future time.',
        irreversible: false,
        params: z.object({
          fire_at: isoDateTime,
          message: z.string().min(1).max(1000),
          related_to: z.string().max(200).optional(),
        }),
        async handler({ params, ctx }) {
          const reminder = await ctx.repo.createReminder({
            userId: ctx.userId,
            workflowId: ctx.workflowId ?? null,
            fireAt: params.fire_at,
            payload: { message: params.message, related_to: params.related_to ?? null },
          });
          return { externalRefId: reminder.id, detail: { fire_at: reminder.fire_at } };
        },
      },
      cancel_reminder: {
        description: 'Cancel a previously scheduled reminder.',
        irreversible: false,
        params: z.object({ reminder_id: z.string().min(1) }),
        async handler({ params, ctx }) {
          await ctx.repo.updateReminder(params.reminder_id, { status: 'cancelled' });
          return { externalRefId: params.reminder_id, detail: {} };
        },
      },
    },
  },
};

export function getAction(toolName, action) {
  return TOOL_REGISTRY[toolName]?.actions?.[action];
}

export function isKnownTool(toolName) {
  return Object.hasOwn(TOOL_REGISTRY, toolName);
}

/** Flat catalogue used by the planner prompt and by GET /tools. */
export function describeRegistry() {
  return Object.entries(TOOL_REGISTRY).flatMap(([toolName, tool]) =>
    Object.entries(tool.actions).map(([action, def]) => ({
      tool_name: toolName,
      action,
      description: def.description,
      irreversible: !!def.irreversible,
      params: Object.keys(def.params.shape ?? {}),
    })),
  );
}

export default TOOL_REGISTRY;
