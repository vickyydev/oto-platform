import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BandCreditRemaining, FoodReconciliationSummary } from '@/components/shared/FoodReconciliationSummary';
import type { PrepaidFoodReconciliation } from '@/lib/dropoff';

/**
 * SCRUM-1021 — AT PICKUP, "You still have X baht remaining" (the owner's
 * answer of 19 November 2026): for staff to tell the parent, in place of
 * "Forfeited" where the park does not refund. Fix round: where the park
 * refunds, the refund line is as it was and the credit left on the band
 * after it (the ticket's own) is said too; no line about how long the
 * credit lasts (that is the park's wallet expiry setting, "as today").
 */

beforeEach(() => { vi.stubGlobal('React', React); });

const html = (el: React.ReactElement) =>
  renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

const credit = (unusedTHB: number): PrepaidFoodReconciliation => ({
  mode: 'prepaid_credit',
  paidTHB: 200,
  remainingCreditTHB: unusedTHB,
  itemBreakdown: [],
  totalRedeemedTHB: 200 - unusedTHB,
  totalUnusedTHB: unusedTHB,
});

describe('SCRUM-1021 — the pickup screen says what is left on the band', () => {
  it('forfeit: "You still have" the band’s figure, and never "Forfeited"', () => {
    const out = html(React.createElement(FoodReconciliationSummary, { reconciliation: credit(150), policy: 'forfeit', bandCreditTHB: 1450 }));
    expect(out).toContain('You still have ฿1450 remaining');
    expect(out).not.toContain('take-away');
    expect(out).not.toContain('Forfeited');
    expect(out).not.toContain('forfeited per venue policy');
  });

  it('forfeit with no figure from the platform (a box’s offline copy): the unused prepaid figure stands in', () => {
    const out = html(React.createElement(FoodReconciliationSummary, { reconciliation: credit(150), policy: 'forfeit' }));
    expect(out).toContain('You still have ฿150 remaining');
  });

  it('forfeit with everything spent and nothing left on the band: as before', () => {
    const out = html(React.createElement(FoodReconciliationSummary, { reconciliation: credit(0), policy: 'forfeit', bandCreditTHB: 0 }));
    expect(out).toContain('All prepaid food was fully redeemed');
    expect(out).not.toContain('You still have');
  });

  it('refund: the refund to the parent as before, then what stays on the band after it', () => {
    const out = html(React.createElement(FoodReconciliationSummary, { reconciliation: credit(150), policy: 'refund', bandCreditTHB: 1450 }));
    expect(out).toContain('Refund to parent');
    expect(out).toContain('−฿150');
    // ฿1,450 on the band less the ฿150 handed back: the ticket's ฿1,300.
    expect(out).toContain('You still have ฿1300 remaining');
  });

  it('refund with nothing else on the band, or no figure from the platform: no remaining line', () => {
    const none = html(React.createElement(FoodReconciliationSummary, { reconciliation: credit(150), policy: 'refund', bandCreditTHB: 150 }));
    expect(none).toContain('Refund to parent');
    expect(none).not.toContain('You still have');
    const offline = html(React.createElement(FoodReconciliationSummary, { reconciliation: credit(150), policy: 'refund' }));
    expect(offline).not.toContain('You still have');
  });

  it('a band with credit and no prepaid food gets the line on its own', () => {
    const out = html(React.createElement(BandCreditRemaining, { remainingTHB: 1300 }));
    expect(out).toContain('You still have ฿1300 remaining');
    expect(out).not.toContain('take-away');
  });
});
