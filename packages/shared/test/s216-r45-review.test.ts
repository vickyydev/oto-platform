import { describe, expect, it } from 'vitest';
import { summariseReportDayV1, type ReportCartLineFacts, type ReportSaleFacts } from '../src/analytics-reports';

/**
 * S2-15b rounds 4-5 — THE REVIEW (lane G, focused): the Sales panel's ticket
 * side against the prototype's `lib/reporting.ts`.
 *
 * (R1), kept as `it.fails` until the fix round flips it: the prototype's live
 * drop-off line (`lib/dropoff.ts` makeDropOffLine) IS the child's play ticket —
 * `ticketType` the 2 Hours ticket, kids 1 — with a `dropOff` block, and
 * `ticketTypeSalesRows` counts it under that ticket; only the seed's synthetic
 * `svc-dropoff` SERVICE line and event passes are left out, and the row's
 * revenue "excludes drop-off fee". A child checked in with no supervision
 * (service `none`) is a plain ticket line there too. `summariseReportDayV1`
 * skips every stay cart line from the ticket type breakdown instead.
 */

const line = (over: Partial<ReportCartLineFacts>): ReportCartLineFacts => ({
  cartLineId: 'l',
  packageId: 'p-2h',
  packageName: '2 Hours Play',
  kids: 1,
  adults: 0,
  hours: 2,
  ticketBaseSatang: 0,
  feeBaseSatang: 0,
  stay: false,
  service: null,
  promo: false,
  ...over,
});

const sale = (cartLines: ReportCartLineFacts[]): ReportSaleFacts => ({
  saleId: 's',
  kind: 'ticket',
  tier: 'tourist',
  grossSatang: 0,
  categories: [],
  tenders: [],
  refundSlices: [],
  cartLines,
  items: [],
  discounts: [],
});

describe('the ticket type breakdown (ticketTypeSalesRows)', () => {
  it.fails('(R1) counts a drop-off child and a check-in child under their play ticket, without the drop-off fee', () => {
    const day = summariseReportDayV1([
      sale([
        line({ cartLineId: 'plain', kids: 2, adults: 1, ticketBaseSatang: 50_000 }),
        // The child's drop-off stay: their 2 Hours ticket and the ฿225 fee.
        line({ cartLineId: 'stay', ticketBaseSatang: 25_000, feeBaseSatang: 22_500, stay: true, service: 'drop_off' }),
        // A child checked in on the board with the guardian staying: no service, no fee.
        line({ cartLineId: 'checkin', ticketBaseSatang: 25_000, stay: true, service: 'none' }),
      ]),
    ]);
    const rows = (kind: string) => day.tickets.filter((t) => t.kind === kind);
    expect(rows('ticket_type').map((t) => [t.key, t.lineCount, t.kids, t.adults, t.revenueSatang])).toEqual([
      ['p-2h', 3, 4, 1, 100_000],
    ]);
    // The session card is unchanged: the one drop-off stay, its hours and its fee.
    expect(rows('service').map((t) => [t.key, t.lineCount, t.hours, t.revenueSatang])).toEqual([['drop_off', 1, 2, 22_500]]);
  });

  it('leaves out the free-item stub, as the prototype does (holds)', () => {
    const day = summariseReportDayV1([
      sale([line({ cartLineId: 'plain', ticketBaseSatang: 25_000 }), line({ cartLineId: 'stub', kids: 0, promo: true })]),
    ]);
    expect(day.tickets.filter((t) => t.kind === 'ticket_type').map((t) => [t.lineCount, t.kids, t.revenueSatang])).toEqual([[1, 1, 25_000]]);
  });
});
