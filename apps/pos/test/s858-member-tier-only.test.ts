import * as React from 'react';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CustomerDisplay } from '@/components/till/CustomerDisplay';
import { StepCustomerType } from '@/components/till/StepCustomerType';
import { getDefaultTier, getTiers } from '@/mockApi';
import { resolveAutoTier, soleTierFor } from '@/lib/membership';
import type { Member, Sale, TierVerification } from '@/types';

/**
 * SCRUM-858 — TIERS AT THE TILL: A REGISTERED MEMBER SEES ONLY THEIR OWN RATE.
 *
 * The owner's words (8 and 12 November 2026): "Registered members should not
 * see other ticket types. Show only their relevant ticket until their
 * document expires. For example if a registered member is already confirmed
 * Thai from the first visit, on the next visit when he enters the number just
 * show the Thai tier and rates instead of showing all types again."
 *
 * So the customer type step draws ONE card for a member whose verified rate
 * is in date — a Thai rate confirmed at the till records no expiry and
 * always qualifies — and every card, as before, for a walk-in, a member with
 * no verified rate, and a member whose document has expired (`reverifyDue`,
 * beside the re-verify prompt). "Show all rates" is the one way back, for
 * this sale only, and writes nothing to the member. The customer half says
 * what the staff half offers: "Member rate applied" while the member's rate
 * is the sale's, and nothing once staff priced a guest of theirs at the
 * tourist rate.
 */

// The unit runner has no React plugin, so the components' JSX compiles to
// the classic `React.createElement` and needs `React` in scope.
Object.assign(globalThis, { React });

vi.mock('@/i18n/LanguageContext', () => ({
  useLanguage: () => ({ lang: 'en', setLang: () => undefined, t: (key: string) => key }),
}));

const src = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

const verification = (over: Partial<TierVerification> = {}): TierVerification => ({
  tier: 'expat',
  proofType: 'Passport',
  verifiedBy: 'Reception',
  verifiedById: 'api',
  verifiedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const member = (tierVerification?: TierVerification): Member => ({
  id: '0192f000-0000-7000-8000-000000000858',
  phone: '+66898020858',
  nickname: 'ZZ TEST member',
  ...(tierVerification ? { tierVerification } : {}),
});

/** A Thai rate confirmed at the till: no document, no expiry (SCRUM-772). */
const thaiMember = () => member(verification({ tier: 'thai', proofType: 'Approved by hand' }));
/** An expat whose passport is in date. */
const expatMember = () => member(verification({ expiresAt: '2030-06-01' }));
/** An expat whose recorded expiry has passed: the rate holds, the document is asked for again. */
const expiredExpatMember = () => member(verification({ expiresAt: '2025-06-01', reverifyDue: true }));

type Props = Parameters<typeof StepCustomerType>[0];
const props = (member: Member | null, over: Partial<Props> = {}): Props => ({
  member,
  selectedTier: resolveAutoTier(member),
  onPickTier: vi.fn(),
  onRequestVerify: vi.fn(),
  onShowAllTiers: vi.fn(),
  ...over,
});
const html = (p: Props) => renderToStaticMarkup(createElement(StepCustomerType, p));
/** The tier cards on the page: each card is the one `<h3>` on the step. */
const cards = (markup: string) => [...markup.matchAll(/<h3[^>]*>([^<]*)<\/h3>/g)].map((m) => m[1]);

// --- The element tree, walked for the presses (the component is hook-free and is called as a function)

interface El { type: unknown; props: Record<string, unknown> }
const isEl = (n: unknown): n is El => !!n && typeof n === 'object' && 'type' in n && 'props' in n;
function* walk(node: unknown): Generator<El> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (!isEl(node)) return;
  yield node;
  for (const value of Object.values(node.props)) {
    if (Array.isArray(value) || isEl(value)) yield* walk(value);
  }
}
const textOf = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isEl(node)) return ` ${textOf(node.props.children)} `;
  return '';
};
/** The first pressable element whose text holds these words. */
function pressable(tree: unknown, words: string): (() => unknown) | null {
  for (const el of walk(tree)) {
    if (typeof el.props.onClick !== 'function') continue;
    if (textOf(el.props.children).replace(/\s+/g, ' ').includes(words)) return el.props.onClick as () => unknown;
  }
  return null;
}
const pressables = (tree: unknown) => [...walk(tree)].filter((el) => typeof el.props.onClick === 'function').length;

describe('SCRUM-858 — soleTierFor: the one tier a returning member sees', () => {
  it('the branch configures the three tiers these cases name', () => {
    expect(getTiers().map((t) => t.id)).toEqual(['tourist', 'expat', 'thai']);
    expect(getDefaultTier().id).toBe('tourist');
  });

  it('a Thai rate confirmed with no expiry always qualifies', () => {
    expect(soleTierFor(thaiMember())).toBe('thai');
  });

  it('an expat with a document in date sees expat alone', () => {
    expect(soleTierFor(expatMember())).toBe('expat');
  });

  it('a passed expiry shows every tier again (the rate holds; the document is asked for)', () => {
    expect(soleTierFor(expiredExpatMember())).toBeNull();
    expect(resolveAutoTier(expiredExpatMember())).toBe('expat');
  });

  it('a walk-in and a member with no verified rate see every tier', () => {
    expect(soleTierFor(null)).toBeNull();
    expect(soleTierFor(member())).toBeNull();
  });

  it('a rate the branch no longer configures has no card to show alone', () => {
    expect(soleTierFor(member(verification({ tier: 'vip' })))).toBeNull();
  });
});

describe('SCRUM-858 — the customer type step, staff side', () => {
  it('a verified Thai member (no expiry) sees only the Thai card, pre-selected, with the way back', () => {
    const markup = html(props(thaiMember()));
    expect(cards(markup)).toEqual(['Thai']);
    expect(markup).toContain('Thai · verified');
    expect(markup).toContain('Show all rates');
    expect(markup).not.toContain('Standard pricing');
    expect(markup).not.toContain('Resident pricing');
    expect(markup).not.toContain('re-verify');
    // The one card is the selected one, as the pre-selected rate was before.
    expect(markup).toContain('ring-2 ring-primary');
  });

  it('a verified expat with a valid document sees only the Expat card', () => {
    const markup = html(props(expatMember()));
    expect(cards(markup)).toEqual(['Expat']);
    expect(markup).toContain('Expat · verified');
    expect(markup).toContain('Passport — no proof needed');
    expect(markup).toContain('Show all rates');
  });

  it('an expat whose document expired sees every tier with the re-verify prompt, and no way-back control', () => {
    const markup = html(props(expiredExpatMember()));
    expect(cards(markup)).toEqual(['Tourist', 'Expat', 'Thai']);
    expect(markup).toContain('Document expired — re-verify');
    expect(markup).toContain('Expat · verified');
    expect(markup).not.toContain('Show all rates');
  });

  it('a walk-in and a member with no verified rate see every tier, as before', () => {
    const walkIn = html(props(null));
    expect(cards(walkIn)).toEqual(['Tourist', 'Expat', 'Thai']);
    expect(walkIn).toContain('Walk-in (no member)');
    expect(walkIn).not.toContain('Show all rates');
    const unverified = html(props(member()));
    expect(cards(unverified)).toEqual(['Tourist', 'Expat', 'Thai']);
    expect(unverified).toContain('No verified rate');
    expect(unverified).not.toContain('Show all rates');
  });

  it('"Show all rates" brings every tier back and the control goes; the verified badge stays', () => {
    const markup = html(props(thaiMember(), { showAllTiers: true }));
    expect(cards(markup)).toEqual(['Tourist', 'Expat', 'Thai']);
    expect(markup).toContain('Thai · verified');
    expect(markup).not.toContain('Show all rates');
  });

  it('a caller giving no way back gets every tier: one card with no way out is never drawn', () => {
    const markup = html(props(thaiMember(), { onShowAllTiers: undefined }));
    expect(cards(markup)).toEqual(['Tourist', 'Expat', 'Thai']);
    expect(markup).not.toContain('Show all rates');
  });

  it('the one card is pressed exactly as the pre-selected card was: onPickTier, never a proof request', () => {
    const p = props(thaiMember());
    const tree = StepCustomerType(p);
    expect(pressables(tree)).toBe(2); // the Thai card and "Show all rates"
    pressable(tree, 'Thai')!();
    expect(p.onPickTier).toHaveBeenCalledTimes(1);
    expect(p.onPickTier).toHaveBeenCalledWith('thai');
    expect(p.onRequestVerify).not.toHaveBeenCalled();
    expect(p.onShowAllTiers).not.toHaveBeenCalled();
  });

  it('the way back is the caller\'s: the press asks for every rate and touches nothing else', () => {
    const p = props(expatMember());
    pressable(StepCustomerType(p), 'Show all rates')!();
    expect(p.onShowAllTiers).toHaveBeenCalledTimes(1);
    expect(p.onPickTier).not.toHaveBeenCalled();
    expect(p.onRequestVerify).not.toHaveBeenCalled();
    // Nothing on the step reaches the platform: the member's stored rate is not its to change.
    const step = src('components/till/StepCustomerType.tsx');
    expect(step).not.toMatch(/from '@\/api/);
  });

  it('with every rate back, the other cards behave as they always did: tourist is picked, another discounted rate asks for proof', () => {
    const p = props(expatMember(), { showAllTiers: true });
    const tree = StepCustomerType(p);
    pressable(tree, 'Tourist')!();
    expect(p.onPickTier).toHaveBeenCalledWith('tourist');
    pressable(tree, 'Thai')!();
    expect(p.onRequestVerify).toHaveBeenCalledWith('thai');
    pressable(tree, 'Expat')!();
    expect(p.onPickTier).toHaveBeenCalledWith('expat');
  });
});

describe('SCRUM-858 — the customer side says what the staff side offers', () => {
  const sale = (tier: string): Sale =>
    ({ id: 'sale-858', operatorId: 'acc-som', operatorName: 'Som', tier, total: 0, lines: [], manualDiscounts: [],
      creditGrants: [], bracelets: { adults: 0, children: 0 }, createdAt: '', status: 'paid', refunds: [] }) as unknown as Sale;
  const welcome = (m: Member | null, tier: string) =>
    renderToStaticMarkup(createElement(CustomerDisplay, {
      stage: 'welcome', sale: sale(tier), phone: m?.phone ?? '', nickname: m?.nickname ?? '', member: m,
      onPhoneChange: () => undefined, onNicknameChange: () => undefined, onIdentify: () => undefined,
      onCustomerDone: () => undefined,
    } as never));

  it('the one card on the staff side is "Member rate applied" on the customer side', () => {
    const markup = welcome(thaiMember(), resolveAutoTier(thaiMember()));
    expect(markup).toContain('till.welcome.backTitle');
    expect(markup).toContain('till.welcome.memberRate');
  });

  it('a guest of the member priced at the tourist rate after "Show all rates": no member rate on the customer side', () => {
    const markup = welcome(thaiMember(), getDefaultTier().id);
    expect(markup).toContain('till.welcome.backTitle');
    expect(markup).not.toContain('till.welcome.memberRate');
  });

  it('a walk-in sees the plain welcome', () => {
    const markup = welcome(null, getDefaultTier().id);
    expect(markup).toContain('till.welcome.title');
    expect(markup).not.toContain('till.welcome.memberRate');
  });
});

describe('SCRUM-858 — every screen that draws the step gives the way back, for this sale only', () => {
  const wiring = /showAllTiers=\{!!member && showAllTiersFor === member\.id\}\s*onShowAllTiers=\{\(\) => setShowAllTiersFor\(member\?\.id \?\? null\)\}/;

  it('the counter till: keyed by the member, cleared by a new lookup and by the sale\'s reset', () => {
    const till = src('pages/Till.tsx');
    expect(till).toMatch(wiring);
    expect(till).toMatch(/const \[showAllTiersFor, setShowAllTiersFor\] = useState<string \| null>\(null\);/);
    // resetSale, beside the claim the next visitor must not inherit; identifyPhone, before the member is set.
    expect(till).toMatch(/setTierClaimRefusal\(null\);\n\s*setShowAllTiersFor\(null\);\n\s*setSuperSlots\(\[\]\);/);
    expect(till).toMatch(/setConfirmedVisitId\(null\);\n[^\n]*\n\s*setShowAllTiersFor\(null\);\n\s*setMember\(mapped\);/);
    // The pick itself is untouched: the single card goes through handlePickTier as every card did.
    expect(till).toMatch(/onPickTier=\{handlePickTier\}/);
  });

  it('the phone till and the party ticket builder', () => {
    const mobile = src('components/mobile/MobileTill.tsx');
    expect(mobile).toMatch(wiring);
    expect(mobile).toMatch(/setTier\(null\);\n\s*setShowAllTiersFor\(null\);/);
    expect(mobile).toMatch(/setShowAllTiersFor\(null\);\n\s*setMember\(found\);/);
    const party = src('components/parties/PartyTicketModal.tsx');
    expect(party).toMatch(wiring);
    expect(party).toMatch(/const reset = \(\) => \{[\s\S]{0,200}setShowAllTiersFor\(null\);/);
  });
});
