import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extraCreditOfSlot } from '@/lib/dropOffFoodCredit';
import { extraCreditAfterGate, followTickets, gateExtraCredit, withExtraCredit } from '@/lib/extraCredit';
import type { CartLine } from '@/types';

/**
 * SCRUM-1059 (2) — "ADD FOOD CREDIT" ON A TICKET THAT BECOMES A DROP-OFF LINE.
 *
 * Staff may add extra food credit for a child on a ticket with children and
 * no adult (SCRUM-1048); Continue then sends those children through the
 * drop-off gate, where the family chooses extra food credit on their form
 * (SCRUM-1021). What happened before this ticket: the gate's form opened at
 * ฿0 for that child, and once the gate wrote, `followTickets` removed the
 * staff's line because its ticket had become a drop-off line. Nobody was
 * charged twice, but the credit staff added was lost without a word; and on a
 * ticket where a waived child stayed a plain ticket, the line could land on
 * the other child (the places closed up) or vanish.
 *
 * Now ONE source for each child: the staff's amount opens the child's form as
 * the extra credit already chosen (the field staff's own "Prepaid credit" on
 * the till sets), so the family sees it and keeps or changes it; when the gate
 * writes, the staff line of a child in care goes and the form's amount is the
 * one charged and loaded; a child who stayed a plain ticket keeps theirs, at
 * their new place.
 */

const ticket = { id: 'zz-1h', name: '1 Hour Play' } as CartLine['ticketType'];
const line = (id: string, kids: number): CartLine =>
  ({ id, ticketType: ticket, tier: 'tourist', kids, adults: 0, socks: 0, addOns: [], lineTotal: 450 * kids }) as CartLine;
let n = 0;
const newId = () => `zz-credit-${++n}`;

describe('SCRUM-1059 (2): the staff amount opens the child\'s form', () => {
  it('the child\'s form starts at the amount staff added; a child with none starts at nothing', () => {
    const lines = withExtraCredit([line('zz-t', 2)], 'zz-t', 1, 200, newId);
    const carried = gateExtraCredit(lines, 'zz-t', 1);
    expect(carried).toEqual({ foodProvision: { mode: 'prepaid_credit', creditAmountTHB: 200, paidTHB: 200 }, mayOrderFood: true });
    // What the family's form is sent as their extra credit (`consentSlotFood`).
    expect(extraCreditOfSlot(carried!)).toBe(200);
    expect(gateExtraCredit(lines, 'zz-t', 0)).toBeNull();
    expect(gateExtraCredit(lines, 'zz-other', 1)).toBeNull();
  });
});

describe('SCRUM-1059 (2): once the gate writes, one source for each child', () => {
  it('one child, into care: the staff line goes (the form carried it), never charged twice', () => {
    const lines = withExtraCredit([line('zz-t', 1)], 'zz-t', 0, 200, newId);
    const after = extraCreditAfterGate(lines, new Map([['zz-t', [true]]]));
    expect(after.filter((l) => l.extraCredit)).toEqual([]);
  });

  it('two children, the first in care and the second waived: each keeps their own, at the right place', () => {
    let lines = withExtraCredit([line('zz-t', 2)], 'zz-t', 0, 150, newId);
    lines = withExtraCredit(lines, 'zz-t', 1, 300, newId);
    // The gate shrinks the ticket to its one plain child (the second), keeping its id.
    const residual = lines.map((l) => (l.id === 'zz-t' ? { ...l, kids: 1 } : l));
    const after = followTickets(extraCreditAfterGate(residual, new Map([['zz-t', [true, false]]])));
    expect(after.filter((l) => l.extraCredit).map((l) => [l.extraCredit!.kidOrdinal, l.extraCredit!.amountTHB])).toEqual([[0, 300]]);
    // Before: the first child's ฿150 stayed on the ticket's only place (the waived child's), and the
    // waived child's own ฿300 was dropped for a place the ticket no longer had.
    expect(followTickets(residual).filter((l) => l.extraCredit).map((l) => [l.extraCredit!.kidOrdinal, l.extraCredit!.amountTHB]))
      .toEqual([[0, 150]]);
  });

  it("another ticket's credit, and a place the gate did not draw, are left as they were", () => {
    let lines = withExtraCredit([line('zz-t', 1), line('zz-u', 1)], 'zz-u', 0, 100, newId);
    lines = withExtraCredit(lines, 'zz-t', 0, 50, newId);
    const after = extraCreditAfterGate(lines, new Map([['zz-t', []]]));
    expect(after).toEqual(lines);
  });

  it('the till carries the amount in when the gate opens and settles the lines when it writes', () => {
    const till = readFileSync(new URL('../src/pages/Till.tsx', import.meta.url), 'utf8');
    expect(till).toContain('slots.push({ ...place, ...gateExtraCredit(only?.lines ?? lines, l.id, i) });');
    expect(till).toContain('places.set(place.id, { lineId: l.id, ordinal: i });');
    expect(till).toContain('gateKidPlacesRef.current = places;');
    expect(till).toContain('setLines(normalizeDropOffFees([...extraCreditAfterGate(residual, inCare), ...dropLines], dropOffPricing));');
  });
});
