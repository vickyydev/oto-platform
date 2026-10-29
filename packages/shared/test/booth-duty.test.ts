import { describe, expect, it } from 'vitest';
import { BoothDutyRosterSchema, boothDutyLabel, joinBoothStaffNames } from '../src/booth';

/**
 * SCRUM-473 (plan D6), SCRUM-694 — the voucher's Staff row as the day's
 * merged roster label. Nobody signs in at the booth.
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

describe('boothDutyLabel — the roster alone (SCRUM-694)', () => {
  const roster = (people: Array<{ accountId: string | null; displayName: string }>, date = '2026-10-01') => ({
    date,
    people,
  });

  it("joins every name on today's roster, casuals included", () => {
    expect(
      boothDutyLabel({
        roster: roster([
          { accountId: TOM, displayName: 'Tom' },
          { accountId: null, displayName: 'Jerry' },
        ]),
        today: '2026-10-01',
      }),
    ).toBe('Tom and Jerry');
    expect(
      boothDutyLabel({
        roster: roster([
          { accountId: TOM, displayName: 'Tom' },
          { accountId: JERRY, displayName: 'Jerry' },
          { accountId: NOK, displayName: 'Nok' },
        ]),
        today: '2026-10-01',
      }),
    ).toBe('Tom, Jerry and Nok');
  });

  it('is null for an empty roster, and for none at all — the slip prints “unattributed”', () => {
    expect(boothDutyLabel({ roster: roster([]), today: '2026-10-01' })).toBeNull();
    expect(boothDutyLabel({ roster: undefined, today: '2026-10-01' })).toBeNull();
    expect(boothDutyLabel({ roster: null, today: '2026-10-01' })).toBeNull();
  });

  it('a roster for another day is null', () => {
    expect(
      boothDutyLabel({
        roster: roster([{ accountId: TOM, displayName: 'Tom' }], '2026-09-30'),
        today: '2026-10-01',
      }),
    ).toBeNull();
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
