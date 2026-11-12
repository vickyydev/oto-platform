import * as React from 'react';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StationSessionDocument } from '@oto/shared';
import { CustomerDisplay, type CustomerStage } from '@/components/till/CustomerDisplay';
import { LanguageProvider } from '@/i18n/LanguageContext';
import { readTicketDisplayView, ticketDisplayPresentation } from '@/lib/displaySession';
import { welcomedMember } from '@/lib/welcomeMember';
import type { Member, Sale } from '@/types';

/**
 * SCRUM-885 — A MEMBER CREATED A MOMENT AGO IS NOT GREETED AS RETURNING.
 *
 * Seen in the SCRUM-858 staging proof (picture 01): a family registered at
 * the till's "New member?" box was told "Welcome back, … Great to see you
 * again." on the customer side, seconds after they first gave their number.
 *
 * The prototype's welcome screen (imports/oto-pos/artifacts/oto-till,
 * components/till/CustomerDisplay.tsx, stage `welcome`) has two greetings:
 * "Welcome back, {name}!" for the member the membership check found, and
 * "Welcome to Oto" with "Thailand's happiest indoor play park" for everyone
 * else — a number nobody knows stays without a member there. The screen is
 * unchanged; the till now hands it the member the check found, so a member
 * created on this sale is welcomed as the prototype welcomes any first visit,
 * on the till's own half and on a separate display alike.
 */

// The unit runner has no React plugin, so the components' JSX compiles to
// the classic `React.createElement` and needs `React` in scope.
Object.assign(globalThis, { React });

const src = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

const created: Member = { id: '0192f000-0000-7000-8000-000000000885', phone: '+66898850885', nickname: 'ZZ TEST 885 new' };
const found: Member = { id: '0192f000-0000-7000-8000-000000000886', phone: '+66898850886', nickname: 'ZZ TEST 885 found' };

const sale = { id: 'sale-885', operatorId: 'acc-som', operatorName: 'Som', tier: 'tourist', total: 0, lines: [],
  manualDiscounts: [], creditGrants: [], bracelets: { adults: 0, children: 0 }, createdAt: '', status: 'paid',
  refunds: [] } as unknown as Sale;

/** The customer screen as the page draws it, in English, with the real dictionary. */
const screen = (props: { stage?: CustomerStage; sale?: Sale; nickname: string; member: Member | null }) =>
  renderToStaticMarkup(createElement(LanguageProvider, {
    children: createElement(CustomerDisplay, {
      stage: props.stage ?? 'welcome', sale: props.sale ?? sale, phone: '', nickname: props.nickname, member: props.member,
      onPhoneChange: () => undefined, onNicknameChange: () => undefined, onIdentify: () => undefined,
      onCustomerDone: () => undefined,
    }),
  })).replace(/&#x27;/g, "'");

const FIRST_VISIT = ['Welcome to Oto', "Thailand's happiest indoor play park. Let's get you ready to play!"];
const RETURNING = ['Welcome back,', "Great to see you again. Let's get you ready to play!"];

describe('SCRUM-885 — the rule: who the welcome screen greets as returning', () => {
  it('a member created on this sale is not handed to the welcome screen', () => {
    expect(welcomedMember('welcome', created, created.id)).toBeNull();
  });

  it('a member the check found is handed over as before', () => {
    expect(welcomedMember('welcome', found, null)).toBe(found);
    // Another member found after one was created on this sale is still found.
    expect(welcomedMember('welcome', found, created.id)).toBe(found);
  });

  it('every other screen keeps the member created on this sale', () => {
    for (const stage of ['identify', 'order', 'input', 'payment', 'thankyou'] as const) {
      expect(welcomedMember(stage, created, created.id)).toBe(created);
    }
  });

  it('a walk-in has no member on any screen', () => {
    expect(welcomedMember('welcome', null, null)).toBeNull();
    expect(welcomedMember('welcome', null, created.id)).toBeNull();
  });
});

describe("SCRUM-885 — the till's own customer half", () => {
  it("a member created on this sale is welcomed with the prototype's first-visit words, their name above", () => {
    const markup = screen({ nickname: created.nickname, member: welcomedMember('welcome', created, created.id) });
    for (const words of FIRST_VISIT) expect(markup).toContain(words);
    for (const words of RETURNING) expect(markup).not.toContain(words);
    // The bar over the screen still names the customer, from the name they gave.
    expect(markup).toContain(created.nickname);
  });

  it('a member the check found is still welcomed back by name', () => {
    const markup = screen({ nickname: found.nickname, member: welcomedMember('welcome', found, created.id) });
    expect(markup).toContain(`Welcome back, ${found.nickname}!`);
    expect(markup).toContain(RETURNING[1]);
    expect(markup).not.toContain(FIRST_VISIT[0]);
  });

  it('the order screen still has the member created on this sale: "Member rate applied" once their rate is the sale\'s', () => {
    const thaiSale = { ...sale, tier: 'thai' } as Sale;
    const markup = screen({ stage: 'order', sale: thaiSale, nickname: created.nickname,
      member: welcomedMember('order', created, created.id) });
    expect(markup).toContain('Member rate applied');
  });
});

describe('SCRUM-885 — a separate display is handed the same greeting', () => {
  /** What the till publishes, read back the way the display page reads it (pages/Display.tsx). */
  const paired = (member: Member | null, nickname: string) => {
    const presentation = ticketDisplayPresentation({
      stage: 'welcome', step: 2, sessionKey: '885', tier: 'tourist', phone: '+66898850885', nickname,
      contactChannel: 'whatsapp', member,
    }, 'request-885');
    const document = {
      stationId: 'station-885', boxId: 'box-885', schemaVersion: 1, sequence: 1, language: 'en', lease: null,
      takeoverCount: 0, updatedAt: '2026-11-12T00:00:00Z', ...presentation,
    } as unknown as StationSessionDocument;
    const view = readTicketDisplayView(document);
    expect(view).not.toBeNull();
    return screen({ stage: view!.stage, sale: view!.sale, nickname: view!.nickname, member: view!.member });
  };

  it('a member created on this sale: the display says the same first-visit words', () => {
    const markup = paired(welcomedMember('welcome', created, created.id), created.nickname);
    for (const words of FIRST_VISIT) expect(markup).toContain(words);
    for (const words of RETURNING) expect(markup).not.toContain(words);
  });

  it('a member the check found: the display welcomes them back by name, as before', () => {
    const markup = paired(welcomedMember('welcome', found, created.id), found.nickname);
    expect(markup).toContain(`Welcome back, ${found.nickname}!`);
  });
});

describe('SCRUM-885 — the counter till hands both screens the same member', () => {
  const till = src('pages/Till.tsx');

  it('names each member it creates at the start of a sale, and forgets them with the sale', () => {
    expect(till).toContain('const [createdMemberId, setCreatedMemberId] = useState<string | null>(null);');
    // The "New member?" box, the event pass from the first screen, and its name prompt.
    expect(till).toMatch(/const mapped = apiMemberToMember\(res\.member\);\n\s*setMember\(mapped\);\n\s*setCreatedMemberId\(mapped\.id\);/);
    expect(till.match(/setMember\(created\);\n\s*setCreatedMemberId\(created\.id\);/g)).toHaveLength(2);
    // resetSale: the next family is nobody this till created.
    expect(till).toMatch(/setMember\(null\);\n\s*setCreatedMemberId\(null\);\n\s*setConfirmedVisitId\(null\);/);
  });

  it('the member both customer screens are handed comes from the one rule', () => {
    expect(till).toContain('const customerMember = welcomedMember(customerStage, member, createdMemberId);');
    // The separate display, through what is published to it.
    expect(till).toMatch(/useTicketDisplay\([\s\S]{0,400}contactChannel: customerContactChannel, member: customerMember,\n/);
    // The till's own customer half.
    expect(till).toMatch(/<CustomerDisplay\n[\s\S]{0,300}\n {14}member=\{customerMember\}\n/);
  });
});
