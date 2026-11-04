import * as React from 'react';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { membersApi } from '@/api/platform';
import { approveTierByHand, salesApi } from '@/api/sales';
import { ApiError, NetworkError } from '@/api/client';
import {
  EMPTY_TIER_APPROVAL,
  TierApprovalPanel,
  tierApprovalChoiceOf,
} from '@/components/shared/TierApprovalPanel';
import { VerifyTierModal } from '@/components/shared/VerifyTierModal';
import {
  TIER_APPROVAL_PROBLEMS,
  TIER_APPROVAL_REASONS,
  approvedByHandLine,
  tierApprovalErrorText,
} from '@/lib/tierApproval';
import { TIER_PROOF_CHOICES } from '@/lib/tierProof';

/**
 * SCRUM-772 — "Special case, approve by hand" on the till's verify step.
 *
 * The document check stays the normal path and keeps its list. Beside it, the
 * staff member on the till may approve the Thai rate alone, with a reason and
 * an optional note; it is recorded on the platform as a claim for this sale
 * and never saved to the member.
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

vi.mock('@/auth/OperatorContext', () => ({
  useOperator: () => ({ can: () => false }),
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
  vi.mocked(membersApi.verifyTier).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The platform's answer to an approval, as the route describes it. */
const CLAIM = {
  id: '018f0000-0000-7000-8000-000000000772',
  actionId: 'a',
  branchId: '018f0000-0000-7000-8000-0000000000b1',
  toTier: 'thai',
  evidenceType: 'Approved by hand',
  evidenceExpiresAt: null,
  note: null,
  approval: { reason: 'thai_child_foreign_parent', reasonText: null, note: null },
  verifiedByAccountId: '018f0000-0000-7000-8000-0000000000a1',
  createdAt: '2026-11-04T07:00:00.000Z',
  expiresAt: '2026-11-04T07:30:00.000Z',
  spentBySaleId: null,
};

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
      onApproveByHand: async () => {},
      ...over,
    }),
  );

describe('SCRUM-772 — the verify step offers the special case beside the document check', () => {
  it('keeps the document list and adds the third button for the Thai rate', () => {
    const out = modal();
    for (const kind of TIER_PROOF_CHOICES) expect(out).toContain(`>${kind}</button>`);
    expect(out).toContain('Choose proof to verify');
    expect(out).toContain('Special case, approve by hand');
    // The document step is first; the special case comes after it.
    expect(out.indexOf('Choose proof to verify')).toBeLessThan(out.indexOf('Special case, approve by hand'));
  });

  it('offers no special case for another rate, or where the till cannot record one', () => {
    expect(modal({ tier: 'expat' })).not.toContain('Special case, approve by hand');
    expect(modal({ onApproveByHand: undefined })).not.toContain('Special case, approve by hand');
  });
});

describe('SCRUM-772 — the special-case step', () => {
  const panel = (draft = EMPTY_TIER_APPROVAL, error: string | null = null) =>
    renderToStaticMarkup(
      createElement(TierApprovalPanel, {
        tierName: 'Thai',
        tier: 'thai',
        approverName: 'Som',
        draft,
        onDraftChange: () => {},
        busy: false,
        error,
        onBack: () => {},
        onApprove: () => {},
      }),
    );

  it('lists the three reasons, an optional note, the approver, and a way back', () => {
    const out = panel();
    expect(out).toContain('Thai child with a foreign parent');
    expect(out).toContain('Thai ID seen earlier, not to hand');
    expect(out).toContain('>Other</button>');
    expect(out).toContain('Note (optional)');
    expect(out).toContain('Approved by <span class="font-semibold text-foreground">Som</span>');
    expect(out).toContain('for this sale only. The member profile is not changed.');
    expect(out).toContain('Back to the document check');
    // Nothing to approve until a reason is chosen, and no PIN is asked for.
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>.*Approve Thai rate by hand/);
    expect(out.toLowerCase()).not.toContain('pin');
    expect(out.toLowerCase()).not.toContain('manager');
  });

  it('asks what the reason is only for Other', () => {
    expect(panel()).not.toContain('What is the reason?');
    expect(panel({ ...EMPTY_TIER_APPROVAL, reason: 'other' })).toContain('What is the reason?');
  });

  it('shows why the platform refused the last press', () => {
    expect(panel(EMPTY_TIER_APPROVAL, 'No answer')).toContain('role="alert"');
  });

  it('turns the draft into a choice on the platform’s own rule', () => {
    expect(tierApprovalChoiceOf('thai', EMPTY_TIER_APPROVAL)).toEqual({ choice: null, problem: null });
    expect(
      tierApprovalChoiceOf('thai', { reason: 'thai_child_foreign_parent', reasonText: 'left over', note: '  ' }),
    ).toEqual({ choice: { reason: 'thai_child_foreign_parent' }, problem: null });
    expect(
      tierApprovalChoiceOf('thai', { reason: 'other', reasonText: ' Thai grandparent present ', note: ' Came with mum ' }),
    ).toEqual({
      choice: { reason: 'other', reasonText: 'Thai grandparent present', note: 'Came with mum' },
      problem: null,
    });
    expect(tierApprovalChoiceOf('thai', { reason: 'other', reasonText: 'Grandma', note: '' }).problem).toBe(
      TIER_APPROVAL_PROBLEMS.reasonMissing,
    );
    expect(
      tierApprovalChoiceOf('thai', { reason: 'thai_id_seen_not_to_hand', reasonText: '', note: 'ID 1101700203451' })
        .problem,
    ).toBe(TIER_APPROVAL_PROBLEMS.number);
    expect(TIER_APPROVAL_REASONS).toHaveLength(3);
  });
});

describe('SCRUM-772 — what the till sends, and what it never writes', () => {
  it('records the approval as a claim for this sale, and saves nothing to the member', async () => {
    const tierApproval = vi
      .spyOn(salesApi, 'tierApproval')
      .mockResolvedValue({ claim: CLAIM });
    const actionId = await approveTierByHand({
      branchId: 'b',
      tier: 'thai',
      reason: 'other',
      reasonText: 'Thai grandparent present',
      note: 'Came with mum',
    });
    expect(tierApproval.mock.calls[0]![0]).toEqual({
      actionId,
      branchId: 'b',
      toTier: 'thai',
      reason: 'other',
      reasonText: 'Thai grandparent present',
      note: 'Came with mum',
    });
    expect(membersApi.verifyTier).not.toHaveBeenCalled();
  });

  it('sends no empty fields for a named reason', async () => {
    const tierApproval = vi
      .spyOn(salesApi, 'tierApproval')
      .mockResolvedValue({ claim: CLAIM });
    const actionId = await approveTierByHand({ branchId: 'b', tier: 'thai', reason: 'thai_child_foreign_parent' });
    expect(tierApproval.mock.calls[0]![0]).toEqual({
      actionId,
      branchId: 'b',
      toTier: 'thai',
      reason: 'thai_child_foreign_parent',
    });
  });

  it('says why a press did not land, pointing back at the document check', () => {
    expect(tierApprovalErrorText(new NetworkError())).toContain('check a document instead');
    expect(tierApprovalErrorText(new ApiError(404, 'ROUTE_NOT_FOUND', 'x'))).toContain('Check a document instead');
    expect(tierApprovalErrorText(new ApiError(400, 'TIER_APPROVAL', TIER_APPROVAL_PROBLEMS.tier))).toBe(
      TIER_APPROVAL_PROBLEMS.tier,
    );
  });
});

describe('SCRUM-772 — the sale’s document check', () => {
  it('reads "Thai rate approved by hand by <name>: <reason>", with the note after it', () => {
    const approval = {
      reason: 'thai_child_foreign_parent',
      reasonLabel: 'Thai child with a foreign parent',
      note: null,
      approvedByAccountId: 'r',
      approvedBy: 'Som',
    };
    expect(approvedByHandLine({ toTier: 'thai', approval })).toBe(
      'Thai rate approved by hand by Som: Thai child with a foreign parent',
    );
    expect(approvedByHandLine({ toTier: 'thai', approval: { ...approval, note: 'Mother is Thai' } })).toBe(
      'Thai rate approved by hand by Som: Thai child with a foreign parent — Mother is Thai',
    );
  });

  it('is nothing for a document check, so History keeps "Priced on passport"', () => {
    expect(approvedByHandLine({ toTier: 'thai', approval: null })).toBeNull();
    expect(approvedByHandLine({ toTier: 'thai' })).toBeNull();
  });
});
