import { describe, expect, it } from 'vitest';
import {
  normalizePhone,
  phoneDigits,
  samePhone,
  satangFromBaht,
  bahtFromSatang,
  formatTHB,
  formatWWPrice,
  wwp,
  isoDateInTz,
  dayOfWeekInTz,
  isWeekendIsoDate,
  branchToday,
  getRateModeForDate,
  resolveRate,
  newId,
} from '../src/index';

describe('phone normalisation (SCRUM-17)', () => {
  it('normalises Thai local trunk format to E.164 (prototype rule)', () => {
    expect(normalizePhone('0818953926')).toBe('+66818953926');
    expect(normalizePhone('081-895-3926')).toBe('+66818953926');
  });
  it('normalises +66 international with spaces', () => {
    expect(normalizePhone('+66 81 895 3926')).toBe('+66818953926');
  });
  it('reads a leading 00 as the international access code — the prototype does not', () => {
    expect(normalizePhone('0066818953926')).toBe('+66818953926');
    // The prototype treats a leading 00 as "already international" and then
    // only strips non-digits (lib/phoneUtils.ts:29-32), so its comparison key
    // for the same input is the thirteen digits as typed — which matches no
    // member. Ours is the eleven-digit Thai number. See the note in phone.ts.
    expect(phoneDigits(normalizePhone('0066818953926')!)).toBe('66818953926');
    expect('0066818953926'.replace(/\D/g, '')).toBe('0066818953926');
  });
  it('keeps non-Thai international numbers', () => {
    expect(normalizePhone('+44 7911 123456')).toBe('+447911123456');
  });
  it('rejects garbage', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
  });
  it('compares across formats', () => {
    expect(samePhone('0818953926', '+66 81 895 3926')).toBe(true);
    expect(phoneDigits('+66818953926')).toBe('66818953926');
  });
});

describe('money (SCRUM-17)', () => {
  it('round-trips satang', () => {
    expect(satangFromBaht(690)).toBe(69000);
    expect(bahtFromSatang(69000)).toBe(690);
    expect(satangFromBaht(10.5)).toBe(1050);
  });
  it('formats like the prototype (whole ฿, grouped)', () => {
    expect(formatTHB(satangFromBaht(1090))).toBe('฿1,090');
    expect(formatTHB(1050)).toBe('฿10.50');
  });
  it('formats weekday/weekend pairs like the prototype admin list', () => {
    expect(formatWWPrice(wwp(satangFromBaht(100)))).toBe('฿100');
    expect(formatWWPrice(wwp(satangFromBaht(100), satangFromBaht(150)))).toBe('฿100 / ฿150 wknd');
  });
});

describe('branch timezone dates (SCRUM-17)', () => {
  it('round-trips a UTC instant into the branch calendar day', () => {
    // 18:30 UTC = 01:30 next day in Asia/Bangkok (+07:00)
    const instant = new Date('2026-09-11T18:30:00Z');
    expect(isoDateInTz(instant, 'Asia/Bangkok')).toBe('2026-09-12');
    expect(isoDateInTz(instant, 'UTC')).toBe('2026-09-11');
    expect(dayOfWeekInTz(instant, 'Asia/Bangkok')).toBe(6); // Saturday in Bangkok
    expect(branchToday('Asia/Bangkok', instant)).toBe('2026-09-12');
  });
});

describe('rate mode resolver (SCRUM-36 core, ported from prototype pricingMode.ts)', () => {
  const holidays = [{ name: 'Songkran', startsOn: '2026-04-13', endsOn: '2026-04-15' }];
  it('weekday', () => {
    expect(getRateModeForDate('2026-09-09', holidays).mode).toBe('weekday'); // Wed
  });
  it('saturday and sunday are weekend', () => {
    expect(getRateModeForDate('2026-09-12', holidays).mode).toBe('weekend');
    expect(getRateModeForDate('2026-09-13', holidays).mode).toBe('weekend');
    expect(isWeekendIsoDate('2026-09-12')).toBe(true);
  });
  it('a weekday inside a holiday range bills weekend, with the holiday named', () => {
    const r = getRateModeForDate('2026-04-14', holidays); // Tuesday
    expect(r.mode).toBe('weekend');
    expect(r.reason).toBe('Weekend pricing — Songkran');
    expect(r.overrideName).toBe('Songkran');
  });
  it('range boundaries are inclusive on both ends', () => {
    expect(getRateModeForDate('2026-04-13', holidays).overrideName).toBe('Songkran');
    expect(getRateModeForDate('2026-04-15', holidays).overrideName).toBe('Songkran');
    expect(getRateModeForDate('2026-04-16', holidays).mode).toBe('weekday'); // Thursday after
  });
  it('resolves stored pairs per mode', () => {
    const p = wwp(69000, 79000);
    expect(resolveRate(p, 'weekday')).toBe(69000);
    expect(resolveRate(p, 'weekend')).toBe(79000);
    expect(resolveRate(undefined, 'weekday')).toBe(0);
  });
});

describe('ids', () => {
  it('generates monotonic-ish uuidv7', () => {
    const a = newId();
    const b = newId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});

describe('ticket pricing port (prototype lib/pricing.ts semantics)', () => {
  const ADMISSION = { weekday: 35000, weekend: 50000 };
  const pkg = {
    prices: {
      tourist: { weekday: 69000, weekend: 69000 },
      thai: { weekday: 42000, weekend: 52000 },
    },
    adultRules: {
      tourist: { kind: 'set_price' as const, price: ADMISSION },
      thai: {
        kind: 'free_adults' as const,
        freeAdults: 1,
        overflow: 'set_price' as const,
        price: ADMISSION,
      },
    },
  };
  it('set_price adults pay the flat admission (weekday/weekend aware)', async () => {
    const { resolveAdultLine } = await import('../src/pricing');
    expect(resolveAdultLine(pkg, 'tourist', 2, 'weekday')).toMatchObject({ paidCount: 2, total: 70000 });
    expect(resolveAdultLine(pkg, 'tourist', 2, 'weekend').total).toBe(100000);
  });
  it('free_adults: first free per LINE, overflow at the set price (D5)', async () => {
    const { resolveAdultLine } = await import('../src/pricing');
    const r = resolveAdultLine(pkg, 'thai', 3, 'weekday');
    expect(r.freeCount).toBe(1);
    expect(r.paidCount).toBe(2);
    expect(r.total).toBe(70000);
  });
  it('absent rule defaults to same_as_kid; unpriced tier resolves to 0', async () => {
    const { resolveAdultLine, computeTicketLine } = await import('../src/pricing');
    const bare = { prices: { tourist: { weekday: 10000, weekend: 12000 } } };
    expect(resolveAdultLine(bare, 'tourist', 2, 'weekday').total).toBe(20000);
    expect(resolveAdultLine(bare, 'expat', 2, 'weekday').total).toBe(0);
    const line = computeTicketLine({ pkg, tier: 'thai', kids: 2, adults: 2 }, 'weekend');
    expect(line.kidsTotal).toBe(104000); // 2 × ฿520
    expect(line.adults.total).toBe(50000); // 1 free + 1 × ฿500
    expect(line.lineTotal).toBe(154000);
  });
});

describe('permission bundles (S2-01b)', () => {
  it('every bundled permission is in the vocabulary', async () => {
    const { PERMISSIONS, ROLE_BUNDLES, SYSTEM_ROLES } = await import('../src/permissions');
    const known = new Set<string>(PERMISSIONS);
    for (const roleName of SYSTEM_ROLES) {
      for (const permission of ROLE_BUNDLES[roleName]) expect(known.has(permission)).toBe(true);
    }
  });

  it('no bundle carries the same permission twice', async () => {
    const { ROLE_BUNDLES, SYSTEM_ROLES } = await import('../src/permissions');
    for (const roleName of SYSTEM_ROLES) {
      const bundle = ROLE_BUNDLES[roleName];
      expect(new Set(bundle).size).toBe(bundle.length);
    }
  });

  // The dominance rule (S2-01a) only lets an account grant a role whose every
  // permission it already holds: a manager who could not grant `reception`
  // could not staff their own branch.
  it('the bundles nest: staff ⊆ reception ⊆ branch_manager ⊆ operator_admin', async () => {
    const { ROLE_BUNDLES } = await import('../src/permissions');
    const within = (inner: string[], outer: string[]) => {
      const held = new Set(outer);
      return inner.filter((p) => !held.has(p));
    };
    expect(within(ROLE_BUNDLES.staff, ROLE_BUNDLES.reception)).toEqual([]);
    expect(within(ROLE_BUNDLES.reception, ROLE_BUNDLES.branch_manager)).toEqual([]);
    expect(within(ROLE_BUNDLES.branch_manager, ROLE_BUNDLES.operator_admin)).toEqual([]);
  });
});
