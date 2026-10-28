import { describe, expect, it } from 'vitest';
import { INTENT_TABLE } from '../src/intents';
import { EN_PERSONA, PRICING_RULE, PROHIBITIONS, RU_PERSONA, TH_PERSONA } from '../src/persona';
import { buildKnowledge, STATIC_SYSTEM_TEXT } from '../src/prompt';
import { traceabilityGuard } from '../src/guards';
import { CALCULATOR_CENTRAL, pgate, playbookKnowledge, TIER_BRANCHES } from './playbook-support';
import { FIXTURE_KNOWLEDGE_INPUT } from './support';

/**
 * SCRUM-220, Tom's playbook — "Pricing conversations", "By customer type",
 * "Price tables" (owner D3: tier pricing confirmed). The old "standard prices
 * only" rule is gone: any price a cited source states may be quoted — tourist,
 * Thai, resident, deals — and the traceability guard still refuses any number
 * no cited source holds, so a total, a sum or an invented discount never
 * passes.
 */

const knowledge = playbookKnowledge();
const central = knowledge.grounding.get('fact.prices.central')!.text;
const chalong = knowledge.grounding.get('fact.prices.chalong')!.text;

describe('E. the price rule, rewritten', () => {
  it('"standard unit prices only" is gone; totals, arithmetic and invented discounts stay forbidden', () => {
    const rule = PROHIBITIONS.find((p) => p.id === 'no_custom_price')!.text;
    expect(rule).not.toMatch(/State only the standard unit prices/);
    expect(rule).toMatch(/any price exactly as a source you cite states it/);
    expect(rule).toMatch(/tourist, Thai, resident/);
    expect(rule).toMatch(/Never compute a total/);
    expect(rule).toMatch(/never do arithmetic/);
    expect(rule).toMatch(/never invent a discount/);
    expect(STATIC_SYSTEM_TEXT).toContain(rule);
    expect(STATIC_SYSTEM_TEXT).not.toContain('standard ticket prices: unit prices only');
  });

  it('the pricing flow is in the prompt: "starts from", the calculator line, the one combined question, the Thai opener', () => {
    expect(STATIC_SYSTEM_TEXT).toContain(PRICING_RULE);
    expect(PRICING_RULE).toContain('starts from');
    expect(PRICING_RULE).toContain(EN_PERSONA.calculatorLine);
    expect(EN_PERSONA.calculatorLine).toBe(
      'For your convenience, we have a price calculator where you can see exactly how much your visit will cost:',
    );
    expect(PRICING_RULE).toContain(EN_PERSONA.branchResidencyQuestion);
    expect(EN_PERSONA.branchResidencyQuestion).toBe(
      'Which branch are you thinking of, Central Floresta or Robinson Chalong? And are you visiting Phuket or living in Thailand? Residents get a discount at Central 😊',
    );
    expect(PRICING_RULE).toContain('no residency part once Robinson Chalong is chosen');
    expect(PRICING_RULE).toMatch(/Thai customer[^.]*branch part only/);
    expect(PRICING_RULE).toContain(EN_PERSONA.thaiOpener);
    expect(EN_PERSONA.thaiOpener).toBe('Thai families get special prices!');
    expect(PRICING_RULE).toContain(TH_PERSONA.thaiOpener);
  });

  it('the prompt hard-codes none of the "starts from" prices: they come from the facts', () => {
    for (const price of ['690', '483', '300', '150', '420']) expect(STATIC_SYSTEM_TEXT).not.toMatch(new RegExp(`(?<!\\d)${price}(?!\\d)`));
  });

  it('a price question may rest on the live facts or the approved price notes', () => {
    const rule = INTENT_TABLE.ticket_prices;
    if (rule.action !== 'answer') throw new Error('ticket_prices answers');
    expect(rule.groundingTopics).toEqual(['prices', 'prices_note']);
  });
});

describe('E. the live price facts carry every tier and the "starts from" prices', () => {
  it('Thai and resident prices are rendered beside the standard ones; Thai parents at Central enter free', () => {
    expect(central).toContain('1 hour: child weekday ฿690, child weekend ฿690');
    expect(central).toContain('Thai price: child weekday ฿420, child weekend ฿520, adult weekday free, adult weekend free');
    expect(central).toContain('resident discount price (residents and expats): child weekday ฿483, child weekend ฿552');
    expect(chalong).toContain('Thai price: child weekday ฿150');
  });

  it('"starts from" is the lowest weekday child price, per tier, from the catalogue (never hard-coded)', () => {
    expect(central).toContain('Prices start from ฿690 per child');
    expect(central).toContain('Thai prices start from ฿420');
    expect(central).toContain('resident discount prices start from ฿483');
    expect(chalong).toContain('Prices start from ฿300 per child');
    expect(chalong).toContain('Thai prices start from ฿150');
    expect(chalong).not.toContain('resident');
    const moved = buildKnowledge({
      kb: [],
      examples: [],
      branches: [{ ...TIER_BRANCHES[1]!, packages: TIER_BRANCHES[1]!.packages.map((p) => ({ ...p, kidWeekday: p.kidWeekday + 5_000 })) }],
    });
    expect(moved.grounding.get('fact.prices.chalong')!.text).toContain('Prices start from ฿350 per child');
  });

  it('a package with no tiers renders as before (the A1 fixtures)', () => {
    const plain = buildKnowledge(FIXTURE_KNOWLEDGE_INPUT).grounding.get('fact.prices.chalong')!.text;
    expect(plain).toContain('Play pass: child weekday ฿300, child weekend ฿390; includes 1 adult per child ticket, each further adult ฿120');
    expect(plain).not.toContain('Thai price');
  });
});

describe('E. the gate: any cited price, never a computed one', () => {
  it('a Thai price, a resident "starts from" and a deal pass when cited', () => {
    expect(
      pgate({
        intent: 'ticket_prices',
        grounding: ['fact.prices.central'],
        bubbles: ['Thai families get special prices! At Central Floresta it starts from ฿420 per child on weekdays 😊'],
      }),
    ).toMatchObject({ action: 'answer' });
    expect(
      pgate({
        intent: 'ticket_prices',
        grounding: ['pb.prices-central-resident'],
        bubbles: ['For residents at Central Floresta, prices start from 483 baht per hour 😊'],
      }),
    ).toMatchObject({ action: 'answer' });
  });

  it('a total is still refused (no arithmetic)', () => {
    expect(
      pgate({ intent: 'ticket_prices', grounding: ['fact.prices.central'], bubbles: ["For two kids for an hour that's ฿1,380."] }),
    ).toMatchObject({ action: 'silent', reason: 'GUARD_NUMBER' });
  });

  it('the calculator line with the link the knowledge holds passes; a guessed calculator link does not', () => {
    expect(
      pgate({ intent: 'ticket_prices', grounding: ['pb.prices-central'], bubbles: [`${EN_PERSONA.calculatorLine} ${CALCULATOR_CENTRAL}`] }),
    ).toMatchObject({ action: 'answer' });
    expect(
      pgate({
        intent: 'ticket_prices',
        grounding: ['pb.prices-central'],
        bubbles: [`${EN_PERSONA.calculatorLine} https://phuket.otoplay.co/prices?branch=chalong&rate=tourist&calculator=open`],
      }),
    ).toMatchObject({ action: 'silent', reason: 'GUARD_LINK' });
  });

  it('the combined question\'s "discount" is allowed only because a cited price source says it', () => {
    expect(
      pgate({ intent: 'ticket_prices', grounding: ['fact.prices.central', 'fact.prices.chalong'], bubbles: [EN_PERSONA.branchResidencyQuestion], askBranch: true }),
    ).toMatchObject({ action: 'answer', askBranch: true });
    expect(traceabilityGuard([EN_PERSONA.branchResidencyQuestion], [chalong])).toMatchObject({ ok: false, rule: 'en:discount' });
    expect(traceabilityGuard([EN_PERSONA.branchResidencyQuestion], [central])).toEqual({ ok: true });
  });

  it('the Thai and Russian branch questions hold no promise word, so they need no source', () => {
    expect(traceabilityGuard([TH_PERSONA.branchQuestion], [])).toEqual({ ok: true });
    expect(traceabilityGuard([RU_PERSONA.branchResidencyQuestion], [])).toEqual({ ok: true });
    expect(RU_PERSONA.branchResidencyQuestion).toContain('Robinson Chalong');
  });
});
