import Anthropic from '@anthropic-ai/sdk';
import config from '../config.js';
import { describeRegistry } from '../tools/registry.js';
import { withRetry } from '../util/retry.js';
import logger from '../util/logger.js';

/**
 * Turns a natural-language request into a *typed action plan*.
 *
 * The model is given a single tool, `submit_action_plan`, and forced to call it. That is the
 * whole trick: the model cannot reply with prose, only with a structured plan that the
 * validation layer can reason about. The model never receives credentials, never sees a URL,
 * and never learns which actions are permitted — permission is enforced downstream, so a
 * prompt-injected or hallucinated plan is just a plan that fails validation.
 */

const PLAN_TOOL = {
  name: 'submit_action_plan',
  description:
    'Submit the ordered plan of tool calls that fulfils the user request. This is the only way to respond.',
  input_schema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'One sentence, addressed to the user, describing what the plan will do.',
      },
      steps: {
        type: 'array',
        maxItems: 10,
        items: {
          type: 'object',
          properties: {
            tool_name: { type: 'string', description: 'Tool name from the catalogue.' },
            action: { type: 'string', description: 'Action name from the catalogue.' },
            arguments: { type: 'object', description: 'Arguments for that action.' },
            rationale: { type: 'string', description: 'Why this step is needed.' },
          },
          required: ['tool_name', 'action', 'arguments'],
        },
      },
    },
    required: ['summary', 'steps'],
  },
};

export function buildSystemPrompt({ now = new Date(), timezone = 'UTC' } = {}) {
  const catalogue = describeRegistry()
    .map((a) => `- ${a.tool_name}.${a.action}(${a.params.join(', ')}) — ${a.description}`)
    .join('\n');

  return [
    'You are the planner for One Work Space. You convert a user request into an ordered plan of tool calls.',
    '',
    'Rules:',
    '- Always answer by calling submit_action_plan. Never reply with prose.',
    '- Use only tools and actions from the catalogue below, with exactly those argument names.',
    '- Resolve relative dates ("Friday", "tomorrow at 3") into ISO-8601 datetimes using the current time.',
    '- Prefer the smallest plan that satisfies the request. Do not add steps the user did not ask for.',
    '- If the request is ambiguous or cannot be satisfied by the catalogue, submit a plan with a summary that says so and no steps beyond what is clearly asked.',
    '- Never invent recipient addresses. If no recipient is given, use gmail.create_draft rather than gmail.send_email.',
    '',
    `Current time: ${now.toISOString()} (user timezone: ${timezone})`,
    '',
    'Tool catalogue:',
    catalogue,
  ].join('\n');
}

/** Planner backed by the Anthropic API in forced tool-use mode. */
export function createLlmPlanner({ client, model = config.llm.model, log = logger } = {}) {
  const anthropic = client || new Anthropic({ apiKey: config.llm.apiKey });

  return {
    kind: 'llm',
    async plan({ requestText, now = new Date(), timezone = 'UTC' }) {
      const response = await withRetry(
        () =>
          anthropic.messages.create({
            model,
            max_tokens: config.llm.maxTokens,
            system: buildSystemPrompt({ now, timezone }),
            tools: [PLAN_TOOL],
            tool_choice: { type: 'tool', name: PLAN_TOOL.name },
            messages: [{ role: 'user', content: requestText }],
          }),
        { attempts: 3, onRetry: ({ attempt, error }) => log.warn('planner.retry', { attempt, error: error.message }) },
      );

      const block = (response.content || []).find(
        (c) => c.type === 'tool_use' && c.name === PLAN_TOOL.name,
      );
      if (!block) {
        // Not a crash: an unusable plan is a validation failure like any other.
        return { summary: 'The planner did not return a usable plan.', steps: [] };
      }
      return block.input;
    },
  };
}

/**
 * Deterministic offline planner. Covers the two request shapes in the demo script so the
 * system runs end-to-end with no ANTHROPIC_API_KEY — useful in CI and when showing the
 * validation/idempotency behaviour, which is where the engineering actually lives.
 */
export function createStubPlanner({ now: fixedNow } = {}) {
  return {
    kind: 'stub',
    async plan({ requestText, now = fixedNow || new Date() }) {
      const text = requestText.trim();
      const lower = text.toLowerCase();
      const steps = [];

      const emailMatch = text.match(/([\w.+-]+@[\w-]+\.[\w.]+)/);
      const wantsEmail = /\b(email|mail|message|write to|send)\b/.test(lower);
      const wantsReminder = /\b(remind|reminder|follow up|follow-up|nudge)\b/.test(lower);
      const wantsMeeting = /\b(meeting|meet|schedule|calendar|call|invite)\b/.test(lower);

      const at = (days, hour) => {
        const d = new Date(now);
        d.setUTCDate(d.getUTCDate() + days);
        d.setUTCHours(hour, 0, 0, 0);
        return d.toISOString();
      };

      if (wantsEmail && emailMatch) {
        steps.push({
          tool_name: 'gmail',
          action: 'send_email',
          arguments: {
            to: emailMatch[1],
            subject: text.slice(0, 78),
            body: `${text}\n\n— sent via One Work Space`,
          },
          rationale: 'The request names a recipient and asks for a message to be sent.',
        });
      } else if (wantsEmail) {
        steps.push({
          tool_name: 'gmail',
          action: 'create_draft',
          arguments: {
            to: 'draft@one-work-space.local',
            subject: text.slice(0, 78),
            body: text,
          },
          rationale: 'No recipient was given, so the message is drafted rather than sent.',
        });
      }

      if (wantsMeeting) {
        steps.push({
          tool_name: 'calendar',
          action: 'create_event',
          arguments: {
            summary: text.slice(0, 100),
            start: at(1, 10),
            end: at(1, 11),
            attendees: emailMatch ? [emailMatch[1]] : undefined,
          },
          rationale: 'The request asks for time to be booked.',
        });
      }

      if (wantsReminder || steps.length === 0) {
        steps.push({
          tool_name: 'reminders',
          action: 'create_reminder',
          arguments: { fire_at: at(1, 9), message: text.slice(0, 200) },
          rationale: 'The request asks to be reminded, or has no other actionable step.',
        });
      }

      return { summary: `Plan for: ${text.slice(0, 120)}`, steps };
    },
  };
}

export function createPlanner(opts = {}) {
  if (opts.planner) return opts.planner;
  return config.llm.apiKey ? createLlmPlanner(opts) : createStubPlanner(opts);
}

export default createPlanner;
