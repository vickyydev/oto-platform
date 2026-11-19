import * as React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sale } from '@/types';
import { StepConfirmation, rowBands, type CheckedInBand, type SaleIssue } from '@/components/till/StepConfirmation';

/**
 * SCRUM-1059 (8) — AFTER "CHECK IN NOW" THE BRACELET CARD SAYS THE BAND WAS
 * ISSUED.
 *
 * On Payment Successful a dropped-off child's bracelet card reads "Prints at
 * check-in" (SCRUM-931): the band is issued when the child is checked in. The
 * screen's bands come from the sale's read, taken as the screen opened, before
 * the door choice; so after "Check in now" printed the band, the card still
 * read "Prints at check-in" (staging's w6). The bands the check-in answered
 * with now go on the card of the stay they were issued to, in the words the
 * screen already uses for an issued band: its code and the child's name, as
 * the other child's card beside it shows. "Leave as booked" changes nothing:
 * that card still prints at check-in.
 */
beforeEach(() => {
  vi.stubGlobal('React', React);
});

const ticket = { id: 'zz-1h', name: '1 Hour Play', durationLabel: '1 Hour' } as unknown as Sale['lines'][number]['ticketType'];
const sale = {
  id: 'local-sale-1059', // not a platform id: the screen asks the platform for nothing
  operatorId: 'o', operatorName: 'Staff', tier: 'tourist',
  lines: [
    { id: 'l-tom', ticketType: ticket, tier: 'tourist', kids: 1, adults: 0, socks: 0, addOns: [], lineTotal: 690,
      dropOff: { checkInId: 'zz-stay-tom', registrationId: 'zz-reg', childName: 'ZZ TEST Tom', service: 'drop_off', serviceFeeTHB: 225 } },
  ],
  manualDiscounts: [], total: 690, quoted: { taxRows: [] }, creditGrants: [], bracelets: { adults: 0, children: 1 },
  createdAt: '2026-11-20T03:00:00.000Z', status: 'paid', refunds: [],
} as unknown as Sale;
const issue: SaleIssue = { number: { kind: 'receipt', number: 'Z05202-000002' }, bands: [], lines: [], printJobs: [], grants: [], issuedVouchers: [] };
const tomBand: CheckedInBand = { id: 'zz-band-tom', checkinId: 'zz-stay-tom', childName: 'ZZ TEST Tom', shortCode: 'T1-7KMQ4X' };

const render = (checkedIn?: CheckedInBand[]) =>
  renderToStaticMarkup(React.createElement(StepConfirmation, { sale, onNewSale: () => undefined, issue, ...(checkedIn ? { checkedIn } : {}) }))
    .replace(/&#x27;/g, "'");

describe('SCRUM-1059 (8): the drop-off child\'s bracelet card after the door choice', () => {
  it('before the choice (and after "Leave as booked") it prints at check-in, with no code', () => {
    const out = render();
    expect(out).toContain('Prints at check-in');
    expect(out).not.toContain('data-testid="band-codes"');
  });

  it('after "Check in now" it names the band issued: its code and the child, and no longer "Prints at check-in"', () => {
    const out = render([tomBand]);
    expect(out).not.toContain('Prints at check-in');
    expect(out).toMatch(/data-testid="band-codes"><span class="whitespace-nowrap"><span class="font-mono font-semibold text-foreground">T1-7KMQ4X<\/span><span class="text-muted-foreground"> ZZ TEST Tom<\/span>/);
  });

  it("another sale's or another stay's band is not put on this card", () => {
    const out = render([{ ...tomBand, checkinId: 'zz-stay-other' }]);
    expect(out).toContain('Prints at check-in');
    expect(out).not.toContain('T1-7KMQ4X');
  });

  it('a band both the read and the check-in name is shown once; two children on one card wait for both', () => {
    const read = [{ id: 'zz-band-tom', childName: 'ZZ TEST Tom', shortCode: 'T1-7KMQ4X' }];
    expect(rowBands(read, 'zz-stay-tom', [tomBand]).map((b) => b.id)).toEqual(['zz-band-tom']);
    expect(rowBands([], null, [tomBand])).toEqual([]);
  });

  it('the till keeps the bands with the sale they were issued for', () => {
    const till = readFileSync(new URL('../src/pages/Till.tsx', import.meta.url), 'utf8');
    expect(till).toContain('checkedIn={checkedInBands.saleId === shownResult.id ? checkedInBands.bands : undefined}');
    expect(till).toMatch(/setCheckedInBands\(\(prev\) => \(\{ saleId: checkedInSaleId,\s*bands: \[\.\.\.\(prev\.saleId === checkedInSaleId \? prev\.bands : \[\]\), \.\.\.done\.bands\] \}\)\);/);
  });
});
