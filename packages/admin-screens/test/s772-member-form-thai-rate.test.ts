import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TIER_APPROVAL_EVIDENCE, TIER_PROOF_TYPES } from '@oto/shared';
import type { Member } from '../src/lifted/model/types';
import {
  MemberFormDialogWithPorts,
  tierChangeFor,
  tierSelectionFor,
  type TierSelection,
} from '../src/lifted/components/admin/members/MemberFormDialog';

/**
 * SCRUM-772 — the Console member form (the same form serves the till's
 * /admin) once the Thai rate needs no document. The owner's rule (6 November
 * 2026): "For the Thai rate, we don't need to show document options or expiry
 * date. Just a verification modal with 2 buttons and record staff logs." The
 * Thai rate shows no proof type and no expiry date and saves with the
 * evidence "Approved by hand"; the Expat rate keeps its document and expiry.
 */

// The dialog renders its children in place, so the form can be read as markup.
vi.mock('../src/lifted/components/ui/dialog', () => {
  const pass = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
      open ? createElement('div', null, children) : null,
    DialogContent: pass,
    DialogDescription: pass,
    DialogFooter: pass,
    DialogHeader: pass,
    DialogTitle: pass,
  };
});

const isDefaultTier = (id: string) => id === 'tourist';
const tierLabel = (id: string) => ({ thai: 'Thai', expat: 'Expat', tourist: 'Tourist' })[id] ?? id;

const ports = {
  getDefaultTier: () => ({ id: 'tourist', name: 'Tourist', isDefault: true, requiresVerification: false, sortOrder: 0 }),
  tierLabel,
  isDefaultTier,
  verifiedTiers: () => ['expat', 'thai'],
  operator: { id: 'zz-som', name: 'ZZ TEST Som' },
  can: () => true,
};

const base: Member = { id: '018f0000-0000-7000-8000-0000000007e1', phone: '+66637720792', nickname: 'ZZ TEST Nok' };

const form = (member: Member | null) =>
  renderToStaticMarkup(
    createElement(MemberFormDialogWithPorts, {
      open: true,
      member,
      onOpenChange: () => {},
      onSave: async () => {},
      ports,
    } as Parameters<typeof MemberFormDialogWithPorts>[0]),
  );

const holdsThaiAtTill: Member = {
  ...base,
  tierVerification: {
    tier: 'thai',
    proofType: TIER_APPROVAL_EVIDENCE,
    verifiedBy: 'Som',
    verifiedById: 'zz-som',
    verifiedAt: '2026-11-09T07:00:00.000Z',
  },
};

const holdsExpat: Member = {
  ...base,
  tierVerification: {
    tier: 'expat',
    proofType: 'Passport',
    verifiedBy: 'Som',
    verifiedById: 'zz-som',
    verifiedAt: '2026-11-01T07:00:00.000Z',
    expiresAt: '2027-11-01',
  },
};

describe('SCRUM-772 — the Thai rate in the member form', () => {
  it('shows no proof type and no document expiry date for the Thai rate', () => {
    const out = form(holdsThaiAtTill);
    expect(out).not.toContain('aria-label="Proof type"');
    expect(out).not.toContain('Document expiry date');
    expect(out).not.toContain('type="date"');
    expect(out).not.toContain(`${TIER_APPROVAL_EVIDENCE} (recorded)`);
    expect(out).toContain('No document needed for the Thai rate.');
  });

  it('reads a Thai rate confirmed at the till as such, not as a document', () => {
    const out = form(holdsThaiAtTill);
    expect(out).toContain('Holds Thai, confirmed at the till by Som.');
    expect(out).not.toContain('on a Approved by hand');
  });

  it('keeps the Expat rate’s proof type and expiry date', () => {
    const out = form(holdsExpat);
    expect(out).toContain('aria-label="Proof type"');
    expect(out).toContain('Document expiry date');
    expect(out).toContain('Holds Expat on a Passport, valid to 2027-11-01');
    expect(out).not.toContain('No document needed');
  });

  it('picks the Thai rate with no document and no expiry, and the Expat rate with a document', () => {
    const tourist: TierSelection = { tier: 'tourist', proofType: '', expiresAt: '' };
    const thai = tierSelectionFor('thai', tourist, isDefaultTier);
    expect(thai).toEqual({ tier: 'thai', proofType: TIER_APPROVAL_EVIDENCE, expiresAt: '' });
    // From the Thai rate to Expat: a document again, never "Approved by hand".
    expect(tierSelectionFor('expat', thai, isDefaultTier)).toEqual({
      tier: 'expat',
      proofType: TIER_PROOF_TYPES[0],
      expiresAt: '',
    });
    // From Expat with its document to Thai: the document and expiry are left behind.
    expect(
      tierSelectionFor('thai', { tier: 'expat', proofType: 'School card', expiresAt: '2027-01-01' }, isDefaultTier),
    ).toEqual({ tier: 'thai', proofType: TIER_APPROVAL_EVIDENCE, expiresAt: '' });
    expect(tierSelectionFor('tourist', thai, isDefaultTier)).toEqual(tourist);
  });

  it('saves the Thai rate with the evidence "Approved by hand", no expiry and no note', () => {
    const thai = tierSelectionFor('thai', { tier: 'tourist', proofType: '', expiresAt: '' }, isDefaultTier);
    expect(tierChangeFor(thai, undefined, isDefaultTier)).toEqual({
      toTier: 'thai',
      evidenceType: TIER_APPROVAL_EVIDENCE,
    });
    // From Expat to Thai is a change too.
    expect(tierChangeFor(thai, holdsExpat.tierVerification, isDefaultTier)).toEqual({
      toTier: 'thai',
      evidenceType: TIER_APPROVAL_EVIDENCE,
    });
  });

  it('treats a member already holding the Thai rate as the same tier', () => {
    const thai: TierSelection = { tier: 'thai', proofType: TIER_APPROVAL_EVIDENCE, expiresAt: '' };
    expect(tierChangeFor(thai, holdsThaiAtTill.tierVerification, isDefaultTier)).toBeNull();
    // An older Thai rate on a document holds the same rate: nothing to send.
    const onPassport = { ...holdsThaiAtTill.tierVerification!, proofType: 'Passport', expiresAt: '2027-01-01' };
    expect(tierChangeFor({ tier: 'thai', proofType: 'Passport', expiresAt: '2027-01-01' }, onPassport, isDefaultTier)).toBeNull();
  });

  it('still sends the Expat rate with its document and expiry, and nothing when unchanged', () => {
    const expat: TierSelection = { tier: 'expat', proofType: 'Passport', expiresAt: '2027-11-01' };
    expect(tierChangeFor(expat, holdsExpat.tierVerification, isDefaultTier)).toBeNull();
    expect(tierChangeFor({ ...expat, expiresAt: '2028-11-01' }, holdsExpat.tierVerification, isDefaultTier)).toEqual({
      toTier: 'expat',
      evidenceType: 'Passport',
      evidenceExpiresAt: '2028-11-01',
    });
    expect(tierChangeFor({ tier: 'tourist', proofType: '', expiresAt: '' }, holdsExpat.tierVerification, isDefaultTier)).toBeNull();
  });
});
