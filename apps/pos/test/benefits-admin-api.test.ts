import { describe, expect, it } from 'vitest';
import type { BenefitProfile as PlatformProfile } from '@oto/shared';
import { inForceOn, profileFromApi, profileToApi, sameProfile } from '@/api/benefits';

/**
 * S2-21 round 1 — Admin > Staff Benefits converts a profile at the API
 * boundary and nowhere else: satang on the platform, baht in the prototype's
 * editor. A profile read and saved back unedited must be the profile it was,
 * or every Save would write a version nobody changed.
 */

const COFFEE = '0199a2b4-0000-7000-8000-000000000001';
const MANAGER: PlatformProfile = {
  freeItems: [
    {
      id: 'coffee',
      label: 'Free coffee',
      target: { kind: 'fnbCategory', category: COFFEE },
      quotaPerPeriod: 2,
      period: 'daily',
    },
  ],
  credit: { amountSatang: 50_000, period: 'monthly' },
  standingDiscount: { percent: 30, target: { kind: 'fnb' } },
};

describe('the profile at the API boundary', () => {
  it('reads satang as the editor’s baht and writes it back unchanged', () => {
    const editor = profileFromApi(MANAGER);
    expect(editor.credit).toEqual({ amountTHB: 500, period: 'monthly' });
    expect(profileToApi(editor)).toEqual(MANAGER);
    expect(sameProfile(profileToApi(editor), MANAGER)).toBe(true);
    expect(profileToApi(profileFromApi({ comp: true }))).toEqual({ comp: true });
    expect(profileToApi(profileFromApi({}))).toEqual({});
  });

  it('leaves out a switched-off comp and an emptied free-item list', () => {
    expect(profileToApi({ comp: false, freeItems: [] })).toEqual({});
  });

  it('turns a typed baht amount into whole satang', () => {
    expect(profileToApi({ credit: { amountTHB: 500.5, period: 'daily' } }).credit?.amountSatang).toBe(50_050);
  });

  it('compares by content, not by key order', () => {
    const reordered = {
      standingDiscount: { target: { kind: 'fnb' }, percent: 30 },
      credit: { period: 'monthly', amountSatang: 50_000 },
      freeItems: MANAGER.freeItems,
    } as PlatformProfile;
    expect(sameProfile(reordered, MANAGER)).toBe(true);
    expect(sameProfile({ ...MANAGER, credit: { amountSatang: 60_000, period: 'monthly' } }, MANAGER)).toBe(false);
  });

  it('finds the version in force on a day: [from, to), an empty range on no day', () => {
    const versions = [
      { id: 'a', effectiveFrom: '2026-01-01', effectiveTo: '2026-10-08', createdAt: '', createdBy: null },
      { id: 'b', effectiveFrom: '2026-10-08', effectiveTo: '2026-10-08', createdAt: '', createdBy: null },
      { id: 'c', effectiveFrom: '2026-10-08', effectiveTo: null, createdAt: '', createdBy: null },
    ];
    expect(inForceOn(versions, '2026-10-07')?.id).toBe('a');
    expect(inForceOn(versions, '2026-10-08')?.id).toBe('c');
    expect(inForceOn(versions, '2025-12-31')).toBeUndefined();
  });
});
