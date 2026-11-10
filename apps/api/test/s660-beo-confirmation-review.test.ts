import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { beoPathOf, InboxBeoConfirmationSchema, InboxOpenBeoBodySchema, readHandoffTarget, withHandoffTarget } from '@oto/shared';
import { BEO_CONFIRMATION_SCAN, carriesBirthdayDetails } from '../src/services/inbox/beo-confirmation';

/**
 * SCRUM-660 house review: Create BEO's AI Fill on the inbox confirmation.
 *
 * Passing pins hold what the lane promises; `it.fails` FINDINGs are what
 * still stands, each with its severity and the prescribed fix. Pure: no
 * database, no server (the route's own tests are inbox-beo-confirmation.test.ts
 * and the OTO App's tests/beo-inbox-fill.check.ts).
 */

const APP = (path: string) => fileURLToPath(new URL(`../../oto-app/${path}`, import.meta.url));
const editor = readFileSync(APP('client/src/components/beo/beo-event-editor.tsx'), 'utf8');
const aiRoutes = readFileSync(APP('server/ai-routes.ts'), 'utf8');
const aiFill = readFileSync(APP('server/lib/aiFill.ts'), 'utf8');

/** The body of one top-level `const name = async (…) => { … };` in the editor. */
function handlerBody(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = async`);
  expect(start, name).toBeGreaterThan(-1);
  const next = source.indexOf('\n  const ', start + 10);
  return source.slice(start, next < 0 ? undefined : next);
}

describe('SCRUM-660 review: the message never travels in an address', () => {
  it('pin: the hand-off target carries only the flag, and the open-beo body only takes the flag', () => {
    const id = '01964600-0000-7000-8000-000000000001';
    const path = beoPathOf(id, { aiFill: true });
    expect(path).toBe(`/studio/events/kanban?beo=${id}&fill=inbox`);
    const launch = withHandoffTarget('https://app.example/#handoff=abc', path);
    expect(readHandoffTarget(new URL(launch).hash)).toBe(path);
    expect(InboxOpenBeoBodySchema.safeParse({ aiFill: true, text: 'Emma 21 March' }).success).toBe(false);
  });

  it('pin: the OTO App takes no message from the request; it reads the platform with the person\'s session', () => {
    // SCRUM-826: the body also carries the press's purpose, a word ("fill" | "fetch"), never a message.
    expect(aiRoutes).toContain('const InboxFillBodySchema = z.object({ existingData: ExistingDataSchema, purpose: z.enum(["fill", "fetch"]).optional() });');
    expect(aiRoutes).not.toMatch(/InboxFillBodySchema = z\.object\(\{[^}]*(text|message|body):/);
    expect(aiRoutes).toContain('deps.inboxConfirmation(req, event.inboxConversationId)');
    // The pick names the event, and the app refuses a conversation that names another one.
    expect(InboxBeoConfirmationSchema.shape.eventId).toBeDefined();
    expect(aiRoutes).toContain('if (confirmation.eventId !== event.id) return refuse("event_mismatch", event.id);');
  });
});

describe('SCRUM-660 review: nothing is logged or recorded with the text', () => {
  it('pin: no console call and no prompt, message or answer in a log line of the AI routes', () => {
    expect(aiRoutes).not.toMatch(/console\.(log|error|warn|info)\(/);
    expect(aiRoutes).not.toMatch(/log\(\)\.\w+\([^)]*\b(userMessage|notes_text|text|prompt|system|answer)\b/);
    expect(aiFill).not.toMatch(/console\.|log\(\)/);
  });
});

describe('SCRUM-660 review: which message is read', () => {
  it(`pin: the team's newest ${BEO_CONFIRMATION_SCAN} messages, and only one naming a date, a time and a party detail`, () => {
    expect(BEO_CONFIRMATION_SCAN).toBe(100);
    expect(carriesBirthdayDetails('See you on 21 March at 14:00!')).toBe(false);
    expect(carriesBirthdayDetails('21 March at 14:00, 15 kids, nuggets for the kids')).toBe(true);
  });

  /**
   * FINDING (low; owner question, stands): a team message that only repeats
   * the customer's request back ("You asked for 21 March at 14:00 for 15 kids,
   * let me check") reads as a confirmation by the rule, so if it is the newest
   * such message it is the one read. The person sees the message before
   * anything is applied, which is the guard today. Prescribed fix: none in
   * code until the owner names how a final confirmation is marked (a
   * template, a word such as "Confirmed", or the newest after Book Date).
   */
  it.fails('FINDING: a read-back of the request is not told apart from the final confirmation', () => {
    expect(carriesBirthdayDetails('You asked for 21 March at 14:00 for 15 kids, let me check the room for you.')).toBe(false);
  });
});

describe('SCRUM-660 review: nothing is saved until Save', () => {
  it('pin: the inbox AI Fill only opens the review step; it writes nothing to the BEO', () => {
    const run = handlerBody(editor, 'runInboxAiFill');
    expect(run).toContain('/beo/ai-fill/inbox');
    expect(run).not.toMatch(/apiRequest\("(PUT|PATCH|DELETE)"/);
    expect(run).not.toContain('/beo/timeline');
    expect(run).toContain('openAiFillPreview(');
  });

  it("pin: a team member is assigned only when the reviewer ticked them", () => {
    const apply = handlerBody(editor, 'handleAiFillApply');
    expect(apply).toContain('aiFillAccepted.has(field)');
  });

  /**
   * FINDING (medium; owner question, stands): Load into Editor — the AI Fill
   * review step's own button, unchanged from before this lane — creates the
   * answer's timeline lines on the server at once (`POST …/beo/timeline`),
   * before the form's Save, for a pasted message as for the inbox one. Every
   * other field waits for Save. Prescribed fix: hold the timeline lines in the
   * form and write them with Save; not done here because it changes the
   * approved AI Fill behaviour (the SCRUM-488 ruling) — the owner decides.
   */
  it.fails('FINDING: Load into Editor writes the timeline before the form is saved', () => {
    const apply = handlerBody(editor, 'handleAiFillApply');
    expect(apply).not.toContain('/beo/timeline');
  });
});
