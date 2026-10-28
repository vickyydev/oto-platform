import { describe, expect, it } from 'vitest';
import { AI_ACTIONS, AI_INTENTS, type AiIntent } from '../src/intents';
import { AI_OUTCOME_REASONS } from '../src/decision';
import { applyGates, type GateVerdict } from '../src/gate';
import type { TicketPackageFact, TurnContext } from '../src/prompt';
import { context, decision, episode, fixtureKnowledge } from './support';

/**
 * SCRUM-220, the inbox playbook build — the TYPE SURFACE the playbook lanes
 * build on. Nothing here is behaviour: the gate never emits a silent
 * hand-over yet, and the prompt renders no country code and no tier price.
 * The lanes that wire them replace these pins with their own.
 */

describe('the playbook contract in @oto/assistant (SCRUM-220)', () => {
  it('a silent hand-over is a verdict the type holds: the plan routes, no holding line is sent', () => {
    const v: GateVerdict = {
      action: 'silent_handover',
      reason: 'SILENCE_POLICY',
      intent: 'drop_off_care',
      intents: ['drop_off_care'],
      language: 'en',
      plan: { templateKey: 'handover_general', route: 'general', brochure: false },
      branchNamed: null,
    };
    expect(v.action).toBe('silent_handover');
    expect(AI_OUTCOME_REASONS).toContain('SILENCE_POLICY');
  });

  it('the gate never emits a silent hand-over yet, whatever the intent and the model action', () => {
    const grounding = fixtureKnowledge().grounding;
    for (const intent of AI_INTENTS as readonly AiIntent[]) {
      for (const action of AI_ACTIONS) {
        const v = applyGates({ decision: decision({ intent, action }), grounding, episode: episode() });
        expect(v.action, `${intent}/${action}`).not.toBe('silent_handover');
      }
    }
  });

  it('the turn context can carry the contact’s calling code, and a package its tier prices', () => {
    const ctx: TurnContext = context({ contactCountryCode: '66' });
    expect(ctx.contactCountryCode).toBe('66');
    const pkg: TicketPackageFact = {
      name: 'Play pass',
      kidWeekday: 69_000,
      kidWeekend: 69_000,
      adultWeekday: 35_000,
      adultWeekend: 35_000,
      includedAdults: 1,
      overflowAdult: 35_000,
      tierPrices: [{ tierCode: 'thai', kidWeekday: 42_000, kidWeekend: 52_000, adultWeekday: 35_000, adultWeekend: 50_000 }],
    };
    expect(pkg.tierPrices?.[0]?.tierCode).toBe('thai');
  });
});
