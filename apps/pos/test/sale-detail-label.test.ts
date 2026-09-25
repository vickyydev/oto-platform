import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiSaleDiscount } from '@/api/history';
import { DiscountLabel, voucherLabelParts } from '@/components/history/SaleDetail';

// The page's session hook reads `window` as its module loads (a hand-off in
// the address). Nothing here renders the page, only its discount line, so the
// hook is replaced by the one thing the module imports from it.
vi.mock('@/auth/OperatorContext', () => ({
  useOperator: () => ({ operator: null, can: () => false }),
}));

// This runner has no React plugin (vitest.config.ts), so the component's JSX
// is compiled to `React.createElement` and looks for `React` in scope. It is
// put there for each test, and the runner puts it back after each one.
beforeEach(() => {
  vi.stubGlobal('React', React);
});

/**
 * A VOUCHER LINE ON THE HISTORY PAGE KEEPS ITS LAST FOUR IN VIEW — SCRUM-433,
 * `components/history/SaleDetail.tsx`.
 *
 * The platform labels a voucher's discount line "<type name> (voucher …WXYZ)".
 * The row is cut with an ellipsis when it does not fit, and cut at the end a
 * long type name pushed the four characters that match the line to the slip
 * off it. The label is now split where the voucher part starts: the name is the
 * part that truncates, the voucher part never does. Any other label renders as
 * the one truncating run it always was.
 *
 * The markup is rendered to a string with React's own server renderer, which
 * needs no DOM; the width is the browser's, so what is pinned here is which
 * part carries the truncation and which part cannot shrink.
 */

type Discount = Pick<ApiSaleDiscount, 'kind' | 'label' | 'targetLabel'>;

const render = (discount: Discount): string =>
  renderToStaticMarkup(React.createElement(DiscountLabel, { discount }));

describe('voucherLabelParts — where a voucher line turns from its name to its code', () => {
  it('splits a voucher line into the type’s name and the voucher part', () => {
    expect(voucherLabelParts('Free Bracelet Workshop (voucher …WXYZ)')).toEqual({
      name: 'Free Bracelet Workshop',
      tail: ' (voucher …WXYZ)',
    });
  });

  it('splits at the last voucher part, so a name that says "(voucher" stays the name', () => {
    expect(voucherLabelParts('Gift (voucher club) (voucher …47WP)')).toEqual({
      name: 'Gift (voucher club)',
      tail: ' (voucher …47WP)',
    });
  });

  it('leaves every other label whole', () => {
    expect(voucherLabelParts('Staff Discount')).toBeNull();
    expect(voucherLabelParts('Songkran (voucher club) · Kids')).toBeNull();
    expect(voucherLabelParts(' (voucher …47WP)')).toBeNull();
    expect(voucherLabelParts(null)).toBeNull();
  });
});

describe('DiscountLabel — the line on the money card', () => {
  it('renders a voucher line as a name that truncates and a voucher part that does not', () => {
    const html = render({
      kind: 'promo',
      label: 'Free Bracelet Workshop (voucher …WXYZ)',
      targetLabel: null,
    });
    expect(html).toBe(
      '<span class="flex min-w-0">' +
        '<span class="min-w-0 truncate">Free Bracelet Workshop</span>' +
        '<span class="shrink-0 whitespace-pre"> (voucher …WXYZ)</span>' +
        '</span>',
    );
  });

  it('keeps a line aimed at something readable after the voucher part', () => {
    const html = render({
      kind: 'promo',
      label: 'Kids Pizza (voucher …8H2J)',
      targetLabel: 'Kids',
    });
    expect(html).toContain('<span class="shrink-0 whitespace-pre"> (voucher …8H2J)</span>');
    // Opened by a no-break space, which a flex item keeps at its start.
    const noBreakSpace = String.fromCharCode(0xa0);
    expect(html).toContain(`<span class="min-w-0 truncate">${noBreakSpace}· Kids</span>`);
  });

  it('renders every other line as the one truncating run it always was', () => {
    expect(render({ kind: 'promo', label: 'Staff Discount', targetLabel: null })).toBe(
      '<span class="block truncate">Staff Discount</span>',
    );
    expect(render({ kind: 'manual', label: null, targetLabel: '2 Hours Play' })).toBe(
      '<span class="block truncate">Discount · 2 Hours Play</span>',
    );
    // A park code's label that merely mentions a voucher is not a voucher's line.
    expect(render({ kind: 'manual', label: 'Staff (voucher …1234)', targetLabel: null })).toBe(
      '<span class="block truncate">Staff (voucher …1234)</span>',
    );
  });
});
