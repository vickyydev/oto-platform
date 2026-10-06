import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DROP_OFF_PRICING,
  DEFAULT_SUPERVISION_POLICY as POLICY,
  buildAcknowledgedConfirmations,
  confirmationsSatisfied,
  coveringSibling,
  dropOffFees,
  dropOffLineEntersCart,
  dropOffServiceFee,
  nannyGroups,
  prepaidFoodCharge,
  resolveDropOffPricing,
  resolveGroupRequirements,
  resolveRequirement,
  resolveSupervisionOutcome,
  saleBandDocument,
  supervisionBadgeOf,
  waiverRefusal,
  type SalePrintSnapshot,
  type SupervisionPolicy,
} from '../src';

/**
 * S2-13 round 1 — the supervision resolver and the fee law, ported from the
 * prototype's `lib/supervision.ts` and `lib/dropoff.ts` and pinned here as a
 * table: every band boundary, the waiver (offered, never applied, and taken
 * away again by an age edit), opt-in at zero, and the nanny charged once.
 */

describe('resolveRequirement — every band boundary of the seeded policy', () => {
  const table: [number, string][] = [
    [0, 'nanny'],
    [1, 'nanny'],
    [4, 'nanny'],
    [5, 'drop_off'],
    [6, 'drop_off'],
    [8, 'drop_off'],
    [9, 'none'],
    [12, 'none'],
    [17, 'none'],
  ];
  it.each(table)('age %i → %s', (age, expected) => {
    expect(resolveRequirement(age, POLICY)).toBe(expected);
  });

  it('an age no band covers resolves to none (the prototype’s gap rule)', () => {
    const gappy: SupervisionPolicy = {
      ...POLICY,
      bands: [{ id: 'b', label: '0–4', minAge: 0, maxAge: 4, requirement: 'nanny' }],
    };
    expect(resolveRequirement(6, gappy)).toBe('none');
    expect(resolveRequirement(-1, POLICY)).toBe('none');
  });
});

describe('resolveSupervisionOutcome — the flow decoupled from the fee', () => {
  it('a mandatory requirement always runs the full flow', () => {
    expect(resolveSupervisionOutcome('drop_off', false, false)).toEqual({
      effective: 'drop_off',
      needsConsent: true,
      service: 'drop_off',
    });
    expect(resolveSupervisionOutcome('nanny', false, undefined).service).toBe('nanny');
  });

  it('a genuinely-none child opted in runs the same flow on a real line at no fee', () => {
    const out = resolveSupervisionOutcome('none', false, true);
    expect(out).toEqual({ effective: 'none', needsConsent: true, service: 'none' });
    expect(dropOffServiceFee(out.service!, 2, resolveDropOffPricing(DEFAULT_DROP_OFF_PRICING, 'weekday'))).toBe(0);
  });

  it('a none child not opted in stays a plain ticket', () => {
    expect(resolveSupervisionOutcome('none', false, false)).toEqual({ effective: 'none', needsConsent: false, service: null });
  });

  it('a requirement WAIVED down to none stays a plain ticket even with opt-in set', () => {
    expect(resolveSupervisionOutcome('drop_off', true, true)).toEqual({
      effective: 'none',
      needsConsent: false,
      service: null,
    });
  });
});

describe('the sibling waiver — offered, never applied', () => {
  it('0 adults, a 6-year-old alone: drop_off, no waiver on offer', () => {
    const [six] = resolveGroupRequirements([{ id: 'a', age: 6 }], POLICY);
    expect(six).toEqual({ id: 'a', age: 6, requirement: 'drop_off', waiverEligible: false });
  });

  it('a 9-year-old sibling makes the 6-year-old waivable; the requirement itself is unchanged', () => {
    const group = resolveGroupRequirements(
      [
        { id: 'a', age: 6 },
        { id: 'b', age: 9 },
      ],
      POLICY,
    );
    expect(group[0]).toEqual({ id: 'a', age: 6, requirement: 'drop_off', waiverEligible: true });
    // Offered is not applied: until staff accept it, the child still resolves drop_off.
    expect(resolveSupervisionOutcome(group[0]!.requirement, false, true).service).toBe('drop_off');
    expect(group[1]).toEqual({ id: 'b', age: 9, requirement: 'none', waiverEligible: false });
  });

  it('an 8-year-old sibling is not old enough to cover', () => {
    const group = resolveGroupRequirements(
      [
        { id: 'a', age: 6 },
        { id: 'b', age: 8 },
      ],
      POLICY,
    );
    expect(group.every((g) => !g.waiverEligible)).toBe(true);
  });

  it('a nanny-age child is never waivable — only drop_off is', () => {
    const [toddler] = resolveGroupRequirements(
      [
        { id: 'a', age: 3 },
        { id: 'b', age: 12 },
      ],
      POLICY,
    );
    expect(toddler!.waiverEligible).toBe(false);
    expect(waiverRefusal({ childAge: 3, siblingAge: 12, waivedRequirement: 'nanny' }, POLICY)).toMatch(
      /cannot be waived/,
    );
  });

  it('an age edit takes the waiver away: the sibling corrected from 9 to 7', () => {
    const before = resolveGroupRequirements(
      [
        { id: 'a', age: 6 },
        { id: 'b', age: 9 },
      ],
      POLICY,
    );
    const after = resolveGroupRequirements(
      [
        { id: 'a', age: 6 },
        { id: 'b', age: 7 },
      ],
      POLICY,
    );
    expect(before[0]!.waiverEligible).toBe(true);
    expect(after[0]!.waiverEligible).toBe(false);
    expect(waiverRefusal({ childAge: 6, siblingAge: 7, waivedRequirement: 'drop_off' }, POLICY)).toBe(
      'The sibling must be at least 9 to cover a younger child.',
    );
  });

  it('an age edit on the CHILD takes it away too: 6 corrected to 10 has nothing to waive', () => {
    expect(waiverRefusal({ childAge: 10, siblingAge: 12, waivedRequirement: 'drop_off' }, POLICY)).toMatch(
      /check the age/,
    );
  });

  it('a switched-off waiver is refused, and an eligible one is not', () => {
    expect(
      waiverRefusal(
        { childAge: 6, siblingAge: 9, waivedRequirement: 'drop_off' },
        { ...POLICY, siblingWaiver: { ...POLICY.siblingWaiver, enabled: false } },
      ),
    ).toMatch(/switched off/);
    expect(waiverRefusal({ childAge: 6, siblingAge: 9, waivedRequirement: 'drop_off' }, POLICY)).toBeNull();
  });

  it('the covering sibling is the OLDEST other child old enough', () => {
    const kids = [
      { id: 'a', age: 6 },
      { id: 'b', age: 9 },
      { id: 'c', age: 11 },
      { id: 'd', age: 8 },
    ];
    expect(coveringSibling(kids, 'a', POLICY)?.id).toBe('c');
    expect(coveringSibling([{ id: 'a', age: 6 }, { id: 'd', age: 8 }], 'a', POLICY)).toBeNull();
  });
});

describe('confirmations', () => {
  it('all three seeded confirmations are required, and the record carries item, wording and time', () => {
    expect(confirmationsSatisfied(POLICY, ['confirm-15min', 'confirm-no-refund'])).toBe(false);
    expect(confirmationsSatisfied(POLICY, ['confirm-15min', 'confirm-no-refund', 'confirm-evac'])).toBe(true);
    const at = '2026-10-01T03:00:00.000Z';
    expect(buildAcknowledgedConfirmations(POLICY, ['confirm-evac', 'confirm-15min'], at)).toEqual([
      { itemId: 'confirm-15min', text: 'I will remain within 15 minutes of the venue', acknowledgedAt: at },
      { itemId: 'confirm-evac', text: 'I acknowledge the emergency evacuation point', acknowledgedAt: at },
    ]);
  });
});

describe('the fee law, to the satang', () => {
  const pricing = resolveDropOffPricing(DEFAULT_DROP_OFF_PRICING, 'weekday');

  it('the seeded prices: ฿225 flat, ฿330 an hour, ฿300 extra hour (display only)', () => {
    expect(pricing.oneTimeFee).toBe(22_500);
    expect(pricing.nannyHourly).toBe(33_000);
    expect(pricing.extraHour).toBe(30_000);
    expect(pricing.prepaidFoodUnused).toBe('refund');
  });

  it('plain drop-off: each child pays its own flat fee, whatever the length', () => {
    const fees = dropOffFees(
      [
        { id: 'a', service: 'drop_off', hours: 1, lengthChosen: true },
        { id: 'b', service: 'drop_off', hours: 3, lengthChosen: true },
      ],
      pricing,
    );
    expect([...fees.values()]).toEqual([22_500, 22_500]);
  });

  it('a shared nanny, two children of different lengths: ONE fee, on the longest', () => {
    const lines = [
      { id: 'short', service: 'nanny' as const, hours: 1, lengthChosen: true, nannyId: 'n1' },
      { id: 'long', service: 'nanny' as const, hours: 3, lengthChosen: true, nannyId: 'n1' },
    ];
    const fees = dropOffFees(lines, pricing);
    expect(fees.get('long')).toBe(99_000);
    expect(fees.get('short')).toBe(0);
    expect([...fees.values()].reduce((a, b) => a + b, 0)).toBe(99_000);
    const groups = nannyGroups(lines, pricing);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ nannyId: 'n1', hours: 3, fee: 99_000, lineIds: ['short', 'long'] });
  });

  it('a tie goes to the first line', () => {
    const fees = dropOffFees(
      [
        { id: 'x', service: 'nanny', hours: 2, lengthChosen: true, nannyId: 'n1' },
        { id: 'y', service: 'nanny', hours: 2, lengthChosen: true, nannyId: 'n1' },
      ],
      pricing,
    );
    expect(fees.get('x')).toBe(66_000);
    expect(fees.get('y')).toBe(0);
  });

  it('two nannies are two fees; an unassigned nanny line carries a provisional fee of its own', () => {
    const fees = dropOffFees(
      [
        { id: 'a', service: 'nanny', hours: 2, lengthChosen: true, nannyId: 'n1' },
        { id: 'b', service: 'nanny', hours: 1, lengthChosen: true, nannyId: 'n2' },
        { id: 'c', service: 'nanny', hours: 1.5, lengthChosen: true },
      ],
      pricing,
    );
    expect(fees.get('a')).toBe(66_000);
    expect(fees.get('b')).toBe(33_000);
    expect(fees.get('c')).toBe(49_500);
  });

  it('the fee is decoupled from safety: an opted-in 9+ child runs the flow at ฿0', () => {
    const fees = dropOffFees([{ id: 'n', service: 'none', hours: 4, lengthChosen: true }], pricing);
    expect(fees.get('n')).toBe(0);
    expect(resolveSupervisionOutcome('none', false, true).needsConsent).toBe(true);
  });

  it('a line whose length is not chosen is unpriced and does not enter the cart', () => {
    expect(dropOffFees([{ id: 'a', service: 'drop_off', hours: 2, lengthChosen: false }], pricing).get('a')).toBe(0);
    expect(dropOffLineEntersCart({ dropOff: { lengthChosen: false } })).toBe(false);
    expect(dropOffLineEntersCart({ dropOff: { lengthChosen: true } })).toBe(true);
    expect(dropOffLineEntersCart({})).toBe(true);
  });

  it('prepaid food is a line charge, and a prepaid mode with nothing paid charges nothing', () => {
    expect(prepaidFoodCharge({ mode: 'prepaid_credit', paidSatang: 15_000 })).toBe(15_000);
    expect(prepaidFoodCharge({ mode: 'prepaid_items', paidSatang: 0 })).toBe(0);
    expect(prepaidFoodCharge({ mode: 'none', paidSatang: 5_000 })).toBe(0);
    expect(prepaidFoodCharge(null)).toBe(0);
  });
});

describe('the kids band prints the badge and the nanny (R-50)', () => {
  const snapshot = {
    saleId: 's',
    receiptNumber: 'T1-1',
    at: '2026-10-01T03:00:00.000Z',
    timezone: 'Asia/Bangkok',
    operatorName: 'OTO',
    branchName: 'HKT',
    staffName: null,
    memberNickname: null,
    lines: [],
    subtotalSatang: 0,
    grossSatang: 0,
    taxBreakdown: {} as never,
    tenders: [],
    bands: [],
    orderChildren: [],
    note: null,
  } as unknown as SalePrintSnapshot;
  const base = {
    id: 'b',
    kind: 'kid' as const,
    code: 'T1-0000000000000000000000000.AAAAAAAAAAAA',
    saleLineId: null,
    childName: 'Mali',
    allergies: 'Peanuts',
    medicalNotes: null,
    dietary: null,
  };

  it('a nanny child: badge NANNY and the nanny’s name, beside the allergy', () => {
    const doc = saleBandDocument(snapshot, { ...base, supervisionBadge: 'NANNY', nannyName: 'Fon' });
    expect(doc.supervisionMode).toBe('NANNY');
    expect(doc.assignedNannyName).toBe('Fon');
    expect(doc.allergy).toBe('Peanuts');
  });

  it('a drop-off child: badge DROP-OFF and no nanny', () => {
    const doc = saleBandDocument(snapshot, { ...base, supervisionBadge: 'DROP-OFF', nannyName: null });
    expect(doc.supervisionMode).toBe('DROP-OFF');
    expect(doc.assignedNannyName).toBeUndefined();
  });

  it('an ordinary kids band and an adult band carry neither', () => {
    expect(saleBandDocument(snapshot, base).supervisionMode).toBeUndefined();
    expect(
      saleBandDocument(snapshot, { ...base, kind: 'adult', supervisionBadge: 'NANNY', nannyName: 'Fon' }),
    ).not.toHaveProperty('supervisionMode');
  });

  it('the badge follows the service', () => {
    expect(supervisionBadgeOf('nanny')).toBe('NANNY');
    expect(supervisionBadgeOf('drop_off')).toBe('DROP-OFF');
    expect(supervisionBadgeOf('none')).toBeNull();
  });
});
