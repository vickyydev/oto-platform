import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VoucherTypeEditor } from '@/components/booth/VoucherTypeEditor';
import type { VoucherDefinitionRow, VoucherLinkOptions } from '@/components/booth/boothApi';

/**
 * SCRUM-1040 — MYSTERY BOX: WHERE A HAND-OVER PRIZE IS TOLD WHICH STOCK ITEM
 * IT TAKES ONE FROM. The voucher type's drawer, under "What it is worth", gives
 * a hand-over prize one picker per park — that park's counted stock items, or
 * "nothing" — beside where a free product's park products are chosen. Each
 * change is saved at once (`PUT /voucher-definitions/:id/park-stock/:branchId`).
 */

const CENTRAL = '01964000-0000-7000-8000-00000000c001';
const CHALONG = '01964000-0000-7000-8000-00000000c002';
const BOX_CENTRAL = '01964000-0000-7000-8000-00000000b001';
const BOX_CHALONG_RETIRED = '01964000-0000-7000-8000-00000000b002';
const CAP_CHALONG = '01964000-0000-7000-8000-00000000b003';

const handOver = (over: Partial<VoucherDefinitionRow> = {}): VoucherDefinitionRow => ({
  id: '01964000-0000-7000-8000-00000000d001',
  code: 'zz-test-mystery-box',
  nameEn: 'ZZ TEST Mystery Box',
  nameTh: null,
  kind: 'manual',
  valueType: 'none',
  valueSatang: null,
  valueBp: null,
  expiryDays: 14,
  costSatang: 0,
  active: true,
  productId: null,
  ticketPackageId: null,
  parkStock: [
    { branchId: CENTRAL, branchName: 'Central Floresta', stockItemId: BOX_CENTRAL, stockItemName: 'ZZ TEST Mystery Box', live: true },
    {
      branchId: CHALONG,
      branchName: 'Robinson Chalong',
      stockItemId: BOX_CHALONG_RETIRED,
      stockItemName: 'ZZ TEST Old Mystery Box',
      live: false,
    },
  ],
  ...over,
});

const links: VoucherLinkOptions = {
  products: [],
  packages: [],
  stockItems: [
    { id: BOX_CENTRAL, name: 'ZZ TEST Mystery Box', branchId: CENTRAL, branchName: 'Central Floresta' },
    { id: CAP_CHALONG, name: 'ZZ TEST Cap', branchId: CHALONG, branchName: 'Robinson Chalong' },
  ],
};

function render(definition: VoucherDefinitionRow, opts: { linkOptions?: VoucherLinkOptions; withSetter?: boolean } = {}) {
  return renderToStaticMarkup(
    React.createElement(VoucherTypeEditor, {
      definition,
      linkOptions: opts.linkOptions ?? links,
      linkOptionsFailed: null,
      saving: false,
      readOnly: false,
      error: null,
      onSave: () => {},
      onArchive: () => {},
      onRestore: () => {},
      onSetParkProduct: () => {},
      ...(opts.withSetter === false ? {} : { onSetParkStock: () => {} }),
      onClose: () => {},
    }),
  );
}

/** The `<select>` for one park, by its accessible name. */
function pickerFor(html: string, park: string): string {
  const at = html.indexOf(`aria-label="Stock item at ${park}"`);
  expect(at, `no picker for ${park}`).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<select', at);
  return html.slice(start, html.indexOf('</select>', at));
}

describe('a hand-over prize’s stock item, park by park', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React);
  });

  it('offers each park its own counted items, with the link chosen and "nothing" to clear it', () => {
    const html = render(handOver());
    expect(html).toContain('data-testid="voucher-type-park-stock"');
    expect(html).toContain('the stock item one prize takes off the count when its voucher is used at the till');
    expect(html).toContain('At zero the till warns and the prize is still handed over');

    const central = pickerFor(html, 'Central Floresta');
    expect(central).toContain('<option value="">— nothing —</option>');
    expect(central).toMatch(new RegExp(`<option value="${BOX_CENTRAL}" selected="">ZZ TEST Mystery Box</option>`));
    // Only that park's items: Chalong's cap is not offered at Central.
    expect(central).not.toContain(CAP_CHALONG);
  });

  it('a link to an item no longer counted there is still shown, named as such, so the manager sees why nothing is taken', () => {
    const html = render(handOver());
    const chalong = pickerFor(html, 'Robinson Chalong');
    expect(chalong).toMatch(
      new RegExp(`<option value="${BOX_CHALONG_RETIRED}" selected="">ZZ TEST Old Mystery Box — not counted</option>`),
    );
    expect(chalong).toContain(`<option value="${CAP_CHALONG}">ZZ TEST Cap</option>`);
    expect(html).toContain('Not counted there any more — the till takes nothing off it.');
  });

  it('is for a hand-over prize only, and only where the page can save it', () => {
    const freeItem = render(handOver({ kind: 'free_item', valueType: 'item', productId: '01964000-0000-7000-8000-00000000e001', parkStock: [] }));
    expect(freeItem).not.toContain('voucher-type-park-stock');
    expect(render(handOver(), { withSetter: false })).not.toContain('voucher-type-park-stock');
    // No park counts anything and nothing is linked: no pickers at all.
    expect(render(handOver({ parkStock: [] }), { linkOptions: { products: [], packages: [], stockItems: [] } })).not.toContain(
      'voucher-type-park-stock',
    );
  });
});
