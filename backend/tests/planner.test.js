import { describe, it, expect, vi } from 'vitest';
import { createLlmPlanner, createStubPlanner, buildSystemPrompt } from '../src/planner/planner.js';
import { validatePlan } from '../src/validation/validator.js';

const PERMISSIONS = {
  gmail: ['send_email', 'create_draft'],
  calendar: ['create_event', 'list_events'],
  reminders: ['create_reminder', 'cancel_reminder'],
};

describe('planner', () => {
  it('forces the model into tool-use mode and returns the tool input as the plan', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          name: 'submit_action_plan',
          input: {
            summary: 'Draft a note',
            steps: [
              {
                tool_name: 'gmail',
                action: 'create_draft',
                arguments: { to: 'ana@example.com', subject: 'Hi', body: 'Hello' },
              },
            ],
          },
        },
      ],
    });
    const planner = createLlmPlanner({ client: { messages: { create } } });

    const plan = await planner.plan({ requestText: 'draft a note to Ana' });

    const call = create.mock.calls[0][0];
    expect(call.tool_choice).toEqual({ type: 'tool', name: 'submit_action_plan' });
    expect(call.tools).toHaveLength(1);
    expect(plan.steps[0].action).toBe('create_draft');
  });

  it('degrades to an empty plan rather than throwing when the model returns prose', async () => {
    const create = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'I cannot do that' }] });
    const planner = createLlmPlanner({ client: { messages: { create } } });
    const plan = await planner.plan({ requestText: 'do something odd' });
    expect(plan.steps).toEqual([]);
  });

  it('never advertises an action outside the registry', () => {
    const prompt = buildSystemPrompt({ now: new Date('2026-01-01T00:00:00Z') });
    expect(prompt).toContain('gmail.send_email');
    expect(prompt).toContain('2026-01-01'); // current time is injected for relative dates
    expect(prompt).not.toContain('drive.');
  });

  it('offline stub produces plans that survive validation', async () => {
    const planner = createStubPlanner({ now: new Date('2026-01-01T00:00:00Z') });
    for (const request of [
      'Email ana@example.com about the handover',
      'Remind me to follow up with Ana on Friday',
      'Schedule a meeting with ana@example.com next week',
      'Something completely unstructured',
    ]) {
      const plan = await planner.plan({ requestText: request });
      const result = validatePlan(plan, PERMISSIONS);
      expect(result.ok, `plan for "${request}" should validate`).toBe(true);
    }
  });

  it('drafts instead of sending when no recipient is given', async () => {
    const planner = createStubPlanner();
    const plan = await planner.plan({ requestText: 'Send a note about the handover' });
    expect(plan.steps[0].action).toBe('create_draft');
  });
});
