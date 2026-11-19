import * as React from 'react';
import { createElement, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TIER_PROOF_EXPIRY_PROBLEMS, tierProofExpiryProblem } from '@oto/shared';
import { membersApi, type ApiMember } from '@/api/platform';
import { ApiError } from '@/api/client';
import { OrderSummary } from '@/components/till/OrderSummary';
import { VerifyTierModal } from '@/components/shared/VerifyTierModal';
import { createMemberForNumber, newMemberName, rateStepSkippedFor } from '@/lib/membershipCheck';
import type { Member, TierVerification } from '@/types';

/**
 * SCRUM-1019 — THE NUMBER, THE RATE AND THE DOCUMENT AT THE TILL (the owner's
 * answers of 19 November 2026, docs/progress/plans/dropoff-beo-20261119/
 * ANSWERS.md §2).
 *
 * - A number the system does not know creates the customer by itself, with
 *   the name the family gave on the first screen: no "New member?" box for it.
 *   With no name known the box still asks staff for one (a member's name
 *   cannot be empty), and a sale with no number stays a walk-in.
 * - A member with a valid Expat rate skips the rate step and goes straight to
 *   tickets; the rate shows on the order with a "change" link.
 * - The expiry date is required on every document kind, Other included.
 *
 * Demo data only: every number and name below is a ZZ TEST fixture.
 */

vi.mock('@/api/platform', () => ({
  membersApi: { lookup: vi.fn(), create: vi.fn(), get: vi.fn(), verifyTier: vi.fn(), revokeTierVerification: vi.fn() },
}));
vi.mock('@/auth/OperatorContext', () => ({ useOperator: () => ({ can: () => false }) }));
// The dialog renders its children in place, so the step can be read as markup.
vi.mock('@/components/ui/dialog', () => {
  const pass = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) => (open ? createElement('div', null, children) : null),
    DialogContent: pass,
    DialogHeader: pass,
    DialogTitle: pass,
    DialogDescription: pass,
  };
});
// The panel's add-on grid reads live stock, which a static render has no snapshot of.
vi.mock('@/components/till/AddOnsGrid', () => ({ AddOnsGrid: () => null }));

// The unit runner has no React plugin, so the components' JSX compiles to
// the classic `React.createElement` and needs `React` in scope.
Object.assign(globalThis, { React });

const src = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

const apiMember = (over: Partial<ApiMember> = {}): ApiMember => ({
  id: '0192f000-0000-7000-8000-000000001019',
  phone: '+66619191019',
  nickname: 'ZZ TEST 1019 Mali',
  name: null,
  email: null,
  tierCode: 'tourist',
  preferredChannel: 'line',
  notes: null,
  tierVerification: null,
  children: [],
  ...over,
}) as ApiMember;

const verification = (over: Partial<TierVerification> = {}): TierVerification => ({
  tier: 'expat',
  proofType: 'Passport',
  verifiedBy: 'Reception',
  verifiedById: 'api',
  verifiedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});
const member = (tierVerification?: TierVerification): Member => ({
  id: '0192f000-0000-7000-8000-000000001020',
  phone: '+66619191020',
  nickname: 'ZZ TEST 1019 member',
  ...(tierVerification ? { tierVerification } : {}),
});

beforeEach(() => {
  vi.mocked(membersApi.create).mockReset();
  vi.mocked(membersApi.lookup).mockReset();
});

describe('a number nobody knows makes the customer by itself', () => {
  it('with the name the family gave; no name yet means none to create with', () => {
    expect(newMemberName('  ZZ TEST Mali  ')).toBe('ZZ TEST Mali');
    expect(newMemberName('')).toBeNull();
    expect(newMemberName('   ')).toBeNull();
    expect(newMemberName(undefined)).toBeNull();
    expect(newMemberName('x'.repeat(150))).toHaveLength(100);
  });

  it('is created from the number, the name and the family’s channel', async () => {
    vi.mocked(membersApi.create).mockResolvedValue({ member: apiMember() });
    const created = await createMemberForNumber({ phone: '0619191019', name: 'ZZ TEST 1019 Mali', channel: 'line' });
    expect(membersApi.create).toHaveBeenCalledWith({ phone: '0619191019', nickname: 'ZZ TEST 1019 Mali', preferredChannel: 'line' });
    expect(created).toMatchObject({ id: apiMember().id, nickname: 'ZZ TEST 1019 Mali' });
  });

  it('never makes a second member: a number created a moment earlier is that member, found again', async () => {
    vi.mocked(membersApi.create).mockRejectedValue(
      new ApiError(409, 'MEMBER_PHONE_EXISTS', 'A member with this phone already exists', { memberId: apiMember().id }),
    );
    vi.mocked(membersApi.lookup).mockResolvedValue({ member: apiMember({ nickname: 'ZZ TEST 1019 first' }) });
    const found = await createMemberForNumber({ phone: '0619191019', name: 'ZZ TEST 1019 second' });
    expect(membersApi.lookup).toHaveBeenCalledWith('0619191019');
    expect(found.nickname).toBe('ZZ TEST 1019 first');
  });

  it('any other refusal is said, never swallowed', async () => {
    const offline = new Error('ZZ TEST network down');
    vi.mocked(membersApi.create).mockRejectedValue(offline);
    await expect(createMemberForNumber({ phone: '0619191019', name: 'ZZ TEST 1019 Mali' })).rejects.toBe(offline);
    const conflict = new ApiError(409, 'MEMBER_PHONE_EXISTS', 'exists', {});
    vi.mocked(membersApi.create).mockRejectedValue(conflict);
    vi.mocked(membersApi.lookup).mockResolvedValue({ member: null });
    await expect(createMemberForNumber({ phone: '0619191019', name: 'ZZ TEST 1019 Mali' })).rejects.toBe(conflict);
  });
});

describe('a valid Expat rate skips the rate step', () => {
  it('skips for an Expat rate in date, or recorded before the date was required', () => {
    expect(rateStepSkippedFor(member(verification({ expiresAt: '2030-06-01' })))).toBe('expat');
    // An older document with no date: never expired, so it skips as it showed its one card.
    expect(rateStepSkippedFor(member(verification()))).toBe('expat');
  });

  it('shows the rate step as today for an expired document, a Thai rate, no rate, or a walk-in', () => {
    expect(rateStepSkippedFor(member(verification({ expiresAt: '2025-06-01', reverifyDue: true })))).toBeNull();
    expect(rateStepSkippedFor(member(verification({ tier: 'thai', proofType: 'Approved by hand' })))).toBeNull();
    expect(rateStepSkippedFor(member())).toBeNull();
    expect(rateStepSkippedFor(null)).toBeNull();
  });

  it('the order shows the rate with a "change" link only when the step was skipped', () => {
    const noop = () => undefined;
    const panel = (extra: { onChangeTier?: () => void }) =>
      renderToStaticMarkup(createElement(OrderSummary, {
        tier: 'expat', lines: [], discounts: [], manualDiscounts: [], onUpdateLine: noop, onRemoveLine: noop,
        onRemoveDiscount: noop, onAddManualDiscount: noop, onRemoveManualDiscount: noop, onPay: noop, onCancel: noop,
        canPay: false, ...extra,
      }));
    const skipped = panel({ onChangeTier: noop });
    expect(skipped).toContain('>expat</span>');
    expect(skipped).toMatch(/data-testid="order-change-tier"[^>]*>change<\/button>/);
    const asToday = panel({});
    expect(asToday).toContain('>expat</span>');
    expect(asToday).not.toContain('order-change-tier');
  });
});

describe('the expiry date on a rate document', () => {
  it('is required on every kind, and must be a day of the calendar', () => {
    expect(tierProofExpiryProblem('')).toBe(TIER_PROOF_EXPIRY_PROBLEMS.missing);
    expect(tierProofExpiryProblem(null)).toBe(TIER_PROOF_EXPIRY_PROBLEMS.missing);
    expect(tierProofExpiryProblem('2031-02-30')).toBe(TIER_PROOF_EXPIRY_PROBLEMS.notADate);
    expect(tierProofExpiryProblem('2031-02-28')).toBeNull();
  });

  it('the till’s document step marks it required; the Thai rate still asks for none', () => {
    const modal = (tier: string) => renderToStaticMarkup(createElement(VerifyTierModal, {
      open: true, onOpenChange: () => undefined, tier, member: null, operatorId: 'acc-zz', operatorName: 'ZZ TEST Som',
      onConfirm: () => undefined,
    }));
    expect(modal('expat')).toMatch(/Document expiry date <span class="text-destructive">\*<\/span>/);
    expect(modal('thai')).not.toContain('Document expiry date');
  });

  it('Verify waits for a date that is given and not past', () => {
    const modal = src('components/shared/VerifyTierModal.tsx');
    expect(modal).toContain('const expiryValid = tierProofExpiryProblem(expiresAt) === null && expiresAt >= todayIso();');
    expect(modal).toContain('const canConfirm = !!proofType && expiryValid && noteProblem === null && !busy;');
    expect(modal).not.toContain("expiresAt === '' ||");
  });
});

describe('the till wires it', () => {
  const till = src('pages/Till.tsx');
  const identify = till.slice(till.indexOf('const identifyPhone = ('), till.indexOf('const handleIdentify = '));

  it('creates the member by itself when the family gave a name, and asks staff only when none is known', () => {
    expect(identify).toContain('const name = !mapped && phone ? newMemberName(nickname) : null;');
    expect(identify).toContain('mapped = await createMemberForNumber({ phone, name, channel });');
    // Greeted as a first visit, as the box's create is (SCRUM-885).
    expect(identify).toMatch(/if \(mapped && createdHere\) \{\n[^}]*setCreatedMemberId\(mapped\.id\);/);
    // The box only for a number with no name to create with; a sale with no number stays a walk-in.
    expect(identify).toMatch(/\} else if \(phone\) \{\n[^}]*setOfferCreateMember\(true\);/);
    expect(till).toContain('New member?');
    // The separate display's answer brings its own nickname and channel.
    expect(till).toContain('identifyPhone(answer.phone, { nickname: answer.nickname, channel: answer.contactChannel });');
  });

  it('goes straight to tickets for a valid Expat rate, with "change" back to the rate step', () => {
    expect(identify).toContain('skipTier = rateStepSkippedFor(mapped);');
    expect(identify).toContain('setStep(skipTier ? 3 : 2);');
    expect(identify).toContain('setRateSkippedFor(skipTier && mapped ? mapped.id : null);');
    expect(till).toContain(
      '{...(step === 3 && member && rateSkippedFor === member.id ? { onChangeTier: () => setStep(2) } : {})}',
    );
    // Forgotten with the sale.
    expect(till).toMatch(/setSupervisionResolved\(false\);\n[^\n]*\n\s*setRateSkippedFor\(null\);\n\s*\};/);
  });
});
