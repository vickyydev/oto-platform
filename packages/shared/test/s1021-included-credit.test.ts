import { describe, expect, it } from 'vitest';
import {
  earningPersonsOf,
  grantLinesOfLedger,
  supervisedLineCreditSatang,
  type GrantLedgerRow,
} from '../src/wallet';

/**
 * SCRUM-1021 — the ticket credit a dropped-off or nanny child's line includes
 * (the owner's answer of 19 November 2026: Eat & Play's credit goes on the
 * child's band, and the form shows it as included). The figure is the grant
 * law's for the line's kids, with the drop-off fee and the prepaid food rows
 * left out; the sale's own grant still passes the line by, so the credit is
 * granted once, at check-in.
 */

const EAT_PLAY = { creditRule: { appliesTo: 'both', basis: 'full_price' }, gateAccess: true };
const ADULTS_ONLY = { creditRule: { appliesTo: 'adults', basis: 'full_price' }, gateAccess: true };
const FIXED = { creditRule: { appliesTo: 'kids', basis: 'fixed', value: 300 }, gateAccess: false };

function supervisedRows(cartLineId: string, packageId: string, food = 0): GrantLedgerRow[] {
  return [
    { cartLineId, kind: 'kids', ticketPackageId: packageId, quantity: 1, unitSatang: 130_000, lineNo: 1 },
    { cartLineId, kind: 'service_fee', ticketPackageId: packageId, quantity: 1, unitSatang: 22_500, lineNo: 2 },
    ...(food > 0 ? [{ cartLineId, kind: 'food_provision', ticketPackageId: packageId, quantity: 1, unitSatang: food, lineNo: 3 }] : []),
  ];
}

describe('supervisedLineCreditSatang', () => {
  it('Eat & Play: the child earns the ticket’s full price, fee and prepaid food left out', () => {
    const packages = new Map([['pkg-eat', EAT_PLAY]]);
    expect(supervisedLineCreditSatang(supervisedRows('stay-1', 'pkg-eat', 20_000), packages, 'stay-1')).toBe(130_000);
    expect(supervisedLineCreditSatang(supervisedRows('stay-1', 'pkg-eat'), packages, 'stay-1')).toBe(130_000);
  });

  it('the sale’s own grant law still passes the supervised line by: never granted twice', () => {
    const packages = new Map([['pkg-eat', EAT_PLAY]]);
    expect(earningPersonsOf(grantLinesOfLedger(supervisedRows('stay-1', 'pkg-eat', 20_000), packages))).toEqual([]);
    expect(earningPersonsOf(grantLinesOfLedger(supervisedRows('stay-1', 'pkg-eat'), packages, new Set(['stay-1'])))).toEqual([]);
  });

  it('reads the rule of the ticket: adults only earns the child nothing; a fixed kids rule its value', () => {
    expect(supervisedLineCreditSatang(supervisedRows('s', 'p'), new Map([['p', ADULTS_ONLY]]), 's')).toBe(0);
    expect(supervisedLineCreditSatang(supervisedRows('s', 'p'), new Map([['p', FIXED]]), 's')).toBe(30_000);
    expect(supervisedLineCreditSatang(supervisedRows('s', 'p'), new Map(), 's')).toBe(0);
  });

  it('only the named line counts, and a Golden Ticket’s child earns nothing', () => {
    const packages = new Map([['pkg-eat', EAT_PLAY]]);
    const rows = [...supervisedRows('stay-1', 'pkg-eat'), ...supervisedRows('stay-2', 'pkg-eat').map((r) => ({ ...r, lineNo: r.lineNo + 10 }))];
    expect(supervisedLineCreditSatang(rows, packages, 'stay-2')).toBe(130_000);
    expect(supervisedLineCreditSatang(rows, packages, 'stay-2', new Set(['stay-2']))).toBe(0);
    expect(supervisedLineCreditSatang(rows, packages, 'nobody')).toBe(0);
  });
});
