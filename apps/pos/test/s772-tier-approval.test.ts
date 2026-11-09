import * as React from 'react';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { membersApi } from '@/api/platform';
import { approveTierByHand, salesApi } from '@/api/sales';
import { ApiError, NetworkError } from '@/api/client';
import { VerifyTierModal } from '@/components/shared/VerifyTierModal';
import { saveDeferredVerification } from '@/lib/deferredTierVerification';
import {
  confirmTierAtTill,
  confirmTierWithoutSale,
  tillConfirmation,
} from '@/lib/thaiRateConfirmation';
import {
  TIER_APPROVAL_EVIDENCE,
  TIER_APPROVAL_PROBLEMS,
  TIER_APPROVAL_REASON_LABELS,
  TIER_APPROVAL_TILL_REASON,
  approvedByHandLine,
  savedRateSummary,
  tierApprovalErrorText,
} from '@/lib/tierApproval';
import { TIER_PROOF_CHOICES } from '@/lib/tierProof';
import type { Member } from '@/types';

/**
 * SCRUM-772 — THE THAI RATE CONFIRMED AT THE TILL.
 *
 * The owner's rule (6 November 2026): "For the Thai rate, we don't need to
 * show document options or expiry date. Just a verification modal with 2
 * buttons and record staff logs." The Thai rate's verify step is "Confirm
 * Thai rate" or "Cancel" and nothing else. Confirm records the sale's claim
 * with the one reason `confirmed_at_till` and saves the rate to the member as
 * a document check did — at once for a member, at the details step for a
 * walk-in (SCRUM-227, SCRUM-779) — with the evidence "Approved by hand". The
 * Expat rate keeps its document step and its expiry.
 */

vi.mock('@/api/platform', () => ({
  membersApi: {
    lookup: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    verifyTier: vi.fn(),
    revokeTierVerification: vi.fn(),
  },
}));

vi.mock('@/lib/membership', () => ({
  tierLabel: (id: string) => ({ thai: 'Thai', expat: 'Expat', tourist: 'Tourist' })[id] ?? id,
  isDefaultTier: (id: string) => id === 'tourist',
}));

vi.mock('@/mockApi', () => ({
  getDefaultTier: () => ({ id: 'tourist', name: 'Tourist', isDefault: true, requiresVerification: false, sortOrder: 0 }),
}));

/** Whether the signed-in account may end a member's rate (SCRUM-241). */
let mayRevoke = false;
vi.mock('@/auth/OperatorContext', () => ({
  useOperator: () => ({ can: () => mayRevoke }),
}));

// The dialog renders its children in place, so the step can be read as markup.
vi.mock('@/components/ui/dialog', () => {
  const pass = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
      open ? createElement('div', null, children) : null,
    DialogContent: pass,
    DialogHeader: pass,
    DialogTitle: pass,
    DialogDescription: pass,
  };
});

// The till's components compile to classic React.createElement calls under this runner.
Object.assign(globalThis, { React });

beforeEach(() => {
  mayRevoke = false;
  for (const fn of Object.values(membersApi)) vi.mocked(fn).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const MEMBER_ID = '018f0000-0000-7000-8000-0000000007c1';

/** The platform's answer to a till confirmation, as the route describes it. */
const CLAIM = {
  id: '018f0000-0000-7000-8000-000000000772',
  actionId: 'a',
  branchId: '018f0000-0000-7000-8000-0000000000b1',
  toTier: 'thai',
  evidenceType: TIER_APPROVAL_EVIDENCE,
  evidenceExpiresAt: null,
  note: null,
  approval: { reason: TIER_APPROVAL_TILL_REASON, reasonText: null, note: null },
  verifiedByAccountId: '018f0000-0000-7000-8000-0000000000a1',
  stationId: '018f0000-0000-7000-8000-0000000000c1',
  createdAt: '2026-11-09T07:00:00.000Z',
  expiresAt: '2026-11-09T07:30:00.000Z',
  spentBySaleId: null,
};

/** The member the platform answers once the rate is saved on them. */
function apiMember(tierVerification: Record<string, unknown> | null = null) {
  return {
    id: MEMBER_ID,
    phone: '+66637720791',
    nickname: 'Nok',
    name: null,
    email: null,
    tierCode: tierVerification ? 'thai' : 'tourist',
    preferredChannel: null,
    notes: null,
    childrenReviewSince: null,
    children: [],
    tierVerification,
  };
}

const SAVED_THAI = {
  tier: 'thai',
  proofType: TIER_APPROVAL_EVIDENCE,
  note: null,
  verifiedAt: '2026-11-09T07:00:00.000Z',
  verifiedBy: 'Som',
  expiresAt: null,
  reverifyDue: false,
};

const tourist: Member = { id: MEMBER_ID, phone: '+66637720791', nickname: 'Nok' };

const modal = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(VerifyTierModal, {
      open: true,
      onOpenChange: () => {},
      tier: 'thai',
      member: null,
      operatorId: 'r',
      operatorName: 'Som',
      onConfirm: () => {},
      onConfirmAtTill: async () => {},
      ...over,
    }),
  );

const buttons = (markup: string) => markup.match(/<button[^>]*>.*?<\/button>/g) ?? [];

describe('SCRUM-772 — the Thai rate is one confirmation with two buttons', () => {
  it('shows "Confirm Thai rate" and "Cancel", and nothing else to press', () => {
    for (const member of [null, tourist]) {
      const out = modal({ member });
      const pressed = buttons(out);
      expect(pressed).toHaveLength(2);
      expect(pressed[0]).toContain('>Cancel</button>');
      expect(pressed[1]).toContain('Confirm Thai rate');
      expect(out).toContain('data-testid="tier-confirm-step"');
      expect(out).toContain('No document needed.');
      // Who confirmed it is recorded from the session, and said so.
      expect(out).toContain('Confirmed by <span class="font-semibold text-foreground">Som</span>');
    }
  });

  it('shows no document options, no expiry date and no reason to choose', () => {
    const out = modal();
    for (const kind of TIER_PROOF_CHOICES) expect(out).not.toContain(`>${kind}</button>`);
    expect(out).not.toContain('Proof checked');
    expect(out).not.toContain('Document expiry date');
    expect(out).not.toContain('type="date"');
    expect(out).not.toContain('Choose proof to verify');
    expect(out).not.toContain('Special case, approve by hand');
    for (const label of Object.values(TIER_APPROVAL_REASON_LABELS)) {
      if (label !== TIER_APPROVAL_REASON_LABELS.confirmed_at_till) expect(out).not.toContain(label);
    }
    expect(out.toLowerCase()).not.toContain('pin');
  });

  it('keeps it two buttons for a member holding another rate, even for a manager', () => {
    mayRevoke = true;
    const holdsExpat: Member = {
      ...tourist,
      tierVerification: {
        tier: 'expat',
        proofType: 'Passport',
        verifiedBy: 'Som',
        verifiedById: 'r',
        verifiedAt: '2026-11-01T07:00:00.000Z',
      },
    };
    const out = modal({ member: holdsExpat });
    expect(buttons(out)).toHaveLength(2);
    expect(out).not.toContain('End the Expat rate');
  });
});

describe('SCRUM-772 — the Expat rate keeps its document step', () => {
  it('lists the documents and the expiry date, with no till confirmation', () => {
    const out = modal({ tier: 'expat' });
    for (const kind of TIER_PROOF_CHOICES) expect(out).toContain(`>${kind}</button>`);
    expect(out).toContain('Proof checked');
    expect(out).toContain('Document expiry date');
    expect(out).toContain('type="date"');
    expect(out).toContain('Choose proof to verify');
    expect(out).not.toContain('Confirm Expat rate');
    expect(out).not.toContain('No document needed.');
    expect(out).not.toContain('Special case, approve by hand');
  });

  it('reads a member’s Thai rate confirmed at the till as such, not as a document', () => {
    mayRevoke = true;
    const holdsThai: Member = {
      ...tourist,
      tierVerification: {
        tier: 'thai',
        proofType: TIER_APPROVAL_EVIDENCE,
        verifiedBy: 'Som',
        verifiedById: 'r',
        verifiedAt: '2026-11-09T07:00:00.000Z',
      },
    };
    const out = modal({ tier: 'expat', member: holdsThai });
    expect(out).toContain(', confirmed at the till by Som.');
    expect(out).not.toContain('an Approved by hand');
    expect(out).toContain('End the Thai rate');
  });
});

describe('SCRUM-772 — Confirm Thai rate on a till that sells', () => {
  it('for a walk-in: records the claim with the one reason, and holds the rate for the details step', async () => {
    const tierApproval = vi.spyOn(salesApi, 'tierApproval').mockResolvedValue({ claim: CLAIM });
    const done = await confirmTierAtTill({
      branchId: 'b',
      tier: 'thai',
      member: null,
      confirmedBy: { id: 'r', name: 'Som' },
    });
    expect(tierApproval).toHaveBeenCalledTimes(1);
    expect(tierApproval.mock.calls[0]![0]).toEqual({
      actionId: done.claimActionId,
      branchId: 'b',
      toTier: 'thai',
      reason: TIER_APPROVAL_TILL_REASON,
    });
    expect(membersApi.verifyTier).not.toHaveBeenCalled();
    expect(done.member).toBeNull();
    expect(done.profileError).toBeNull();
    expect(done.pending).toMatchObject({
      tier: 'thai',
      proofType: TIER_APPROVAL_EVIDENCE,
      verifiedBy: 'Som',
      verifiedById: 'r',
    });
    expect(done.pending).not.toHaveProperty('expiresAt');
    expect(done.pending).not.toHaveProperty('note');
  });

  it('for a walk-in: the details step saves it to the new member with no document (SCRUM-779)', async () => {
    vi.mocked(membersApi.lookup).mockResolvedValue({ member: null });
    vi.mocked(membersApi.create).mockResolvedValue({ member: apiMember() } as never);
    vi.mocked(membersApi.verifyTier).mockResolvedValue({ member: apiMember(SAVED_THAI) } as never);
    const saved = await saveDeferredVerification({
      phone: '+66637720791',
      nickname: 'Nok',
      verification: tillConfirmation('thai', { id: 'r', name: 'Som' }),
    });
    expect(membersApi.verifyTier).toHaveBeenCalledWith(MEMBER_ID, {
      toTier: 'thai',
      evidenceType: TIER_APPROVAL_EVIDENCE,
    });
    expect(saved.tierVerification).toMatchObject({ tier: 'thai', proofType: TIER_APPROVAL_EVIDENCE });
    expect(savedRateSummary(tillConfirmation('thai', { id: 'r', name: 'Som' }))).toBe(
      'Confirmed at the till by Som',
    );
  });

  it('for a member: records the claim and saves the rate on them now, so the next visit skips the step', async () => {
    const tierApproval = vi.spyOn(salesApi, 'tierApproval').mockResolvedValue({ claim: CLAIM });
    vi.mocked(membersApi.verifyTier).mockResolvedValue({ member: apiMember(SAVED_THAI) } as never);
    const done = await confirmTierAtTill({
      branchId: 'b',
      tier: 'thai',
      member: tourist,
      confirmedBy: { id: 'r', name: 'Som' },
    });
    expect(tierApproval).toHaveBeenCalledTimes(1);
    expect(membersApi.verifyTier).toHaveBeenCalledWith(MEMBER_ID, {
      toTier: 'thai',
      evidenceType: TIER_APPROVAL_EVIDENCE,
    });
    expect(done.claimActionId).toEqual(expect.any(String));
    expect(done.pending).toBeNull();
    expect(done.member?.tierVerification).toMatchObject({ tier: 'thai', proofType: TIER_APPROVAL_EVIDENCE });
  });

  it('for a member with the platform out of reach: saves the rate through the box, with no claim', async () => {
    vi.spyOn(salesApi, 'tierApproval').mockRejectedValue(new NetworkError());
    vi.mocked(membersApi.verifyTier).mockResolvedValue({ member: apiMember(SAVED_THAI) } as never);
    const done = await confirmTierAtTill({
      branchId: 'b',
      tier: 'thai',
      member: tourist,
      confirmedBy: { id: 'r', name: 'Som' },
    });
    expect(done.claimActionId).toBeNull();
    expect(done.member?.tierVerification?.tier).toBe('thai');
  });

  it('for a walk-in with the platform out of reach: refuses, with a sentence for the counter', async () => {
    vi.spyOn(salesApi, 'tierApproval').mockRejectedValue(new NetworkError());
    const refused = confirmTierAtTill({
      branchId: 'b',
      tier: 'thai',
      member: null,
      confirmedBy: { id: 'r', name: 'Som' },
    });
    await expect(refused).rejects.toBeInstanceOf(NetworkError);
    expect(membersApi.verifyTier).not.toHaveBeenCalled();
    expect(tierApprovalErrorText(new NetworkError())).toContain('needs the platform');
  });

  it('keeps the claim when the save to the member fails, and says so', async () => {
    vi.spyOn(salesApi, 'tierApproval').mockResolvedValue({ claim: CLAIM });
    vi.mocked(membersApi.verifyTier).mockRejectedValue(new Error('Member not found'));
    const done = await confirmTierAtTill({
      branchId: 'b',
      tier: 'thai',
      member: tourist,
      confirmedBy: { id: 'r', name: 'Som' },
    });
    expect(done.claimActionId).toEqual(expect.any(String));
    expect(done.member).toBeNull();
    expect(done.profileError).toBe('Member not found');
  });

  it('sends the one reason with no empty fields, through the route the till always used', async () => {
    const tierApproval = vi.spyOn(salesApi, 'tierApproval').mockResolvedValue({ claim: CLAIM });
    const actionId = await approveTierByHand({ branchId: 'b', tier: 'thai', reason: TIER_APPROVAL_TILL_REASON });
    expect(tierApproval.mock.calls[0]![0]).toEqual({
      actionId,
      branchId: 'b',
      toTier: 'thai',
      reason: TIER_APPROVAL_TILL_REASON,
    });
  });
});

describe('SCRUM-772 — Confirm Thai rate with no sale to claim (the party tab)', () => {
  it('saves the rate to a member, and hands a walk-in’s back without writing anything', async () => {
    vi.mocked(membersApi.verifyTier).mockResolvedValue({ member: apiMember(SAVED_THAI) } as never);
    const forMember = await confirmTierWithoutSale({ tier: 'thai', member: tourist, confirmedBy: { id: 'r', name: 'Som' } });
    expect(membersApi.verifyTier).toHaveBeenCalledWith(MEMBER_ID, { toTier: 'thai', evidenceType: TIER_APPROVAL_EVIDENCE });
    expect(forMember.member?.tierVerification?.proofType).toBe(TIER_APPROVAL_EVIDENCE);
    vi.mocked(membersApi.verifyTier).mockClear();
    const forWalkIn = await confirmTierWithoutSale({ tier: 'thai', member: null, confirmedBy: { id: 'r', name: 'Som' } });
    expect(membersApi.verifyTier).not.toHaveBeenCalled();
    expect(forWalkIn).toMatchObject({ member: null, verification: { tier: 'thai', proofType: TIER_APPROVAL_EVIDENCE } });
  });
});

describe('SCRUM-772 — why a press did not land', () => {
  it('names the platform, never a document to check instead', () => {
    for (const text of [
      tierApprovalErrorText(new NetworkError()),
      tierApprovalErrorText(new ApiError(404, 'ROUTE_NOT_FOUND', 'x')),
    ]) {
      expect(text).toContain('Thai rate');
      expect(text.toLowerCase()).not.toContain('document');
    }
    // A station forced offline is answered as the platform being out of reach,
    // not with the platform's sentence about taking payment.
    const offline = tierApprovalErrorText(
      new ApiError(503, 'STATION_FORCED_OFFLINE', 'Go online before taking payment or changing the sale.'),
    );
    expect(offline).toContain('needs the platform');
    expect(offline).not.toContain('payment');
    expect(tierApprovalErrorText(new ApiError(400, 'TIER_APPROVAL', TIER_APPROVAL_PROBLEMS.tier))).toBe(
      TIER_APPROVAL_PROBLEMS.tier,
    );
  });
});

describe('SCRUM-772 — the sale’s document check', () => {
  const approval = {
    reason: TIER_APPROVAL_TILL_REASON,
    reasonLabel: 'Confirmed at the till',
    note: null,
    approvedByAccountId: 'r',
    approvedBy: 'Som',
  };

  it('reads "Thai rate confirmed at the till by <name>"', () => {
    expect(approvedByHandLine({ toTier: 'thai', approval })).toBe('Thai rate confirmed at the till by Som');
  });

  it('still reads a 5 November approval with its reason and note', () => {
    const earlier = { ...approval, reason: 'thai_child_foreign_parent', reasonLabel: 'Thai child with a foreign parent' };
    expect(approvedByHandLine({ toTier: 'thai', approval: earlier })).toBe(
      'Thai rate approved by hand by Som: Thai child with a foreign parent',
    );
    expect(approvedByHandLine({ toTier: 'thai', approval: { ...earlier, note: 'Mother is Thai' } })).toBe(
      'Thai rate approved by hand by Som: Thai child with a foreign parent — Mother is Thai',
    );
  });

  it('is nothing for a document check, so History keeps "Priced on passport"', () => {
    expect(approvedByHandLine({ toTier: 'thai', approval: null })).toBeNull();
    expect(approvedByHandLine({ toTier: 'thai' })).toBeNull();
  });
});
