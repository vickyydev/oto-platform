import { describe, expect, it } from 'vitest';
import {
  BoothDutyRosterSchema,
  boothDutyLabel,
  boothStaffLabel,
  joinBoothStaffNames,
} from '../src/booth';

/**
 * SCRUM-473 (plan D6) — the voucher's Staff row as the day's merged label.
 */

const TOM = '0190f000-0000-7000-8000-000000000001';
const JERRY = '0190f000-0000-7000-8000-000000000002';
const NOK = '0190f000-0000-7000-8000-000000000003';

describe('joinBoothStaffNames', () => {
  it('joins names as a person says them', () => {
    expect(joinBoothStaffNames(['Tom'])).toBe('Tom');
    expect(joinBoothStaffNames(['Tom', 'Jerry'])).toBe('Tom and Jerry');
    expect(joinBoothStaffNames(['Tom', 'Jerry', 'Nok'])).toBe('Tom, Jerry and Nok');
    expect(joinBoothStaffNames(['A', 'B', 'C', 'D'])).toBe('A, B, C and D');
  });

  it('drops blanks, says a repeated name once, and answers null for nobody', () => {
    expect(joinBoothStaffNames([' Tom ', '', null, 'tom', 'Jerry'])).toBe('Tom and Jerry');
    expect(joinBoothStaffNames([])).toBeNull();
    expect(joinBoothStaffNames(['  ', undefined])).toBeNull();
  });
});

describe('boothDutyLabel — the ladder', () => {
  const roster = (people: Array<{ accountId: string | null; displayName: string }>, date = '2026-10-01') => ({
    date,
    people,
  });
  const nok = { accountId: NOK, name: 'Nok', label: boothStaffLabel('Nok', 'S-7KMQ') };

  it('prints every roster name for today', () => {
    expect(
      boothDutyLabel({
        roster: roster([
          { accountId: TOM, displayName: 'Tom' },
          { accountId: null, displayName: 'Jerry' },
        ]),
        today: '2026-10-01',
        signedIn: null,
      }),
    ).toBe('Tom and Jerry');
  });

  it('does not repeat a signed-in person already on the roster', () => {
    expect(
      boothDutyLabel({
        roster: roster([
          { accountId: TOM, displayName: 'Tom' },
          { accountId: JERRY, displayName: 'Jerry' },
        ]),
        today: '2026-10-01',
        signedIn: { accountId: TOM, name: 'Tom', label: 'Tom (S-AAAA)' },
      }),
    ).toBe('Tom and Jerry');
  });

  it('adds a stand-in who signed in, by name', () => {
    expect(
      boothDutyLabel({
        roster: roster([
          { accountId: TOM, displayName: 'Tom' },
          { accountId: JERRY, displayName: 'Jerry' },
        ]),
        today: '2026-10-01',
        signedIn: nok,
      }),
    ).toBe('Tom, Jerry and Nok');
  });

  it('before anyone is attributed today (no roster, or an empty one), prints the signed-in person exactly as before', () => {
    expect(boothDutyLabel({ roster: null, today: '2026-10-01', signedIn: nok })).toBe('Nok (S-7KMQ)');
    expect(boothDutyLabel({ roster: roster([]), today: '2026-10-01', signedIn: nok })).toBe(
      'Nok (S-7KMQ)',
    );
  });

  it('once anyone is attributed today — a self-assigned stand-in alone included — the label is names only', () => {
    // The owner's format ruling: the merged day label applies the moment the
    // day's roster is non-empty, so after the first sign-in of the day at a
    // booth with no rota self-assigns Nok, the slip reads "Nok", not
    // "Nok (S-7KMQ)". Intended, and scoped: the untouched slip is "before
    // anyone is attributed today".
    expect(
      boothDutyLabel({
        roster: roster([{ accountId: NOK, displayName: 'Nok' }]),
        today: '2026-10-01',
        signedIn: nok,
      }),
    ).toBe('Nok');
  });

  it('with nobody at all, is null — the slip prints “unattributed”', () => {
    expect(boothDutyLabel({ roster: undefined, today: '2026-10-01', signedIn: null })).toBeNull();
  });

  it('treats a roster for another day as none', () => {
    expect(
      boothDutyLabel({
        roster: roster([{ accountId: TOM, displayName: 'Tom' }], '2026-09-30'),
        today: '2026-10-01',
        signedIn: nok,
      }),
    ).toBe('Nok (S-7KMQ)');
  });
});

describe('BoothDutyRosterSchema', () => {
  it('reads a roster with a casual, and refuses a malformed date', () => {
    const parsed = BoothDutyRosterSchema.parse({
      date: '2026-10-01',
      people: [
        { accountId: TOM, displayName: 'Tom' },
        { accountId: null, displayName: 'Nok' },
      ],
    });
    expect(parsed.people).toHaveLength(2);
    expect(BoothDutyRosterSchema.safeParse({ date: '1 Oct', people: [] }).success).toBe(false);
  });
});
