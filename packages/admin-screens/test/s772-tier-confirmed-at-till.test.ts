import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApiTierVerificationRecord } from '../src/lifted/api/platform';
import {
  TierVerificationRecordList,
  verificationEvidence,
} from '../src/lifted/components/admin/members/TierVerificationsPanel';

/**
 * SCRUM-772 — the Console's Tier verifications page, once the Thai rate is
 * confirmed at the till with no document (the owner's rule of 6 November
 * 2026). A till confirmation reads "Confirmed at the till by <name>", with
 * the till it was confirmed at and no expiry; a document check reads as it
 * always did.
 */

const base: ApiTierVerificationRecord = {
  id: '018f0000-0000-7000-8000-0000000007d1',
  member: { id: '018f0000-0000-7000-8000-0000000007d2', nickname: 'ZZ TEST Nok', phone: '+66637720791' },
  fromTier: 'tourist',
  toTier: 'thai',
  evidenceType: 'Approved by hand',
  evidenceExpiresAt: null,
  expired: false,
  verifiedBy: 'Som',
  branch: 'Oto Play Park, Central Floresta',
  station: 'Till 1',
  note: null,
  verifiedAt: '2026-11-09T07:00:00.000Z',
};

const passport: ApiTierVerificationRecord = {
  ...base,
  id: '018f0000-0000-7000-8000-0000000007d3',
  toTier: 'expat',
  evidenceType: 'Passport',
  evidenceExpiresAt: '2030-01-01',
  station: null,
};

describe('SCRUM-772 — a Thai rate confirmed at the till, in the Console', () => {
  it('reads "Confirmed at the till by <name>" with the till, and a document as itself', () => {
    expect(verificationEvidence(base)).toEqual({ label: 'Confirmed at the till by Som', detail: 'Till 1' });
    expect(verificationEvidence({ ...base, verifiedBy: null, station: undefined })).toEqual({
      label: 'Confirmed at the till by an unnamed account',
      detail: null,
    });
    expect(verificationEvidence(passport)).toEqual({ label: 'Passport', detail: null });
    expect(verificationEvidence({ ...passport, evidenceType: 'Other', note: 'Work permit' })).toEqual({
      label: 'Other',
      detail: 'Work permit',
    });
  });

  it('lists both, with no expiry on the till confirmation', () => {
    const html = renderToStaticMarkup(
      createElement(TierVerificationRecordList, { records: [base, passport], tierLabel: (id: string) => id }),
    );
    expect(html).toContain('Confirmed at the till by Som');
    expect(html).toContain('Till 1');
    expect(html).not.toContain('>Approved by hand<');
    expect(html).toContain('Passport');
    expect(html).toContain('2030-01-01');
  });
});
