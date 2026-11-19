import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BAND_CREDIT_REMAINING_NOTE,
  BandCreditRemaining,
  FoodReconciliationSummary,
} from '@/components/shared/FoodReconciliationSummary';
import type { PrepaidFoodReconciliation } from '@/lib/dropoff';

/**
 * SCRUM-1021 — AT PICKUP, "You still have X baht remaining" (the owner's
 * answer of 19 November 2026): for staff to tell the parent, in place of
 * "Forfeited" where the park does not refund; one short line says the credit
 * pays for a take-away until the park's day ends. Wording and one figure:
 * where the park refunds, the card is as it was.
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
  it('forfeit: "You still have" the band’s figure, with the one line, and never "Forfeited"', () => {
    const out = html(React.createElement(FoodReconciliationSummary, { reconciliation: credit(150), policy: 'forfeit', bandCreditTHB: 1450 }));
    expect(out).toContain('You still have ฿1450 remaining');
    expect(out).toContain(BAND_CREDIT_REMAINING_NOTE);
    expect(BAND_CREDIT_REMAINING_NOTE).toBe("Usable for a take-away until the end of the park's day.");
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

  it('refund: unchanged — the refund to the parent, no remaining line', () => {
    const out = html(React.createElement(FoodReconciliationSummary, { reconciliation: credit(150), policy: 'refund', bandCreditTHB: 1450 }));
    expect(out).toContain('Refund to parent');
    expect(out).toContain('−฿150');
    expect(out).not.toContain('You still have');
  });

  it('a band with credit and no prepaid food gets the line on its own', () => {
    const out = html(React.createElement(BandCreditRemaining, { remainingTHB: 1300 }));
    expect(out).toContain('You still have ฿1300 remaining');
    expect(out).toContain(BAND_CREDIT_REMAINING_NOTE);
  });
});
