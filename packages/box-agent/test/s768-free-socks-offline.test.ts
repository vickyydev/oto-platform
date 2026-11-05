import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bridgeCartOf } from '@oto/shared';
import { offlineLedgerLines, priceOfflineSale, readOfflineCatalogue } from '../src/offline-pricing';

/**
 * SCRUM-768 follow-up — A FREE REGULAR SOCKS ON THE SOCKS COUNTER, WITH THE
 * INTERNET DOWN.
 *
 * Admin saves a free Regular Socks under the branch's socks product
 * (`AO-SOCKS`); the till names the socks on its order panel's counter by the
 * prototype's `a-socks`, at the socks product's price. The box finds that
 * product in its catalogue copy by its code, as the platform does, so the
 * bundled socks come off the counter's socks at ฿0 and print as their own row.
 */

const PACKAGE = '018f0000-0000-7000-8000-000000076801';
const SOCKS = '018f0000-0000-7000-8000-000000076802';
const ADDONS = '018f0000-0000-7000-8000-000000076803';
const LINE = '018f0000-0000-7000-8000-000000076804';
const SALE = '018f0000-0000-7000-8000-000000076805';
const NOON = new Date('2026-11-04T05:00:00.000Z'); // a Wednesday, noon in Phuket

function catalogue(over: { freebieTiers?: string[]; socksProduct?: boolean } = {}) {
  return readOfflineCatalogue({
    items: [
      {
        version: 'cat-s768-socks',
        packages: [
          {
            id: PACKAGE,
            name: 'ZZ TEST Two hours',
            prices: { tourist: { weekday: 50_000, weekend: 60_000 } },
            adultRules: null,
            freebies: [{ id: 'fb-socks', kind: 'addon', addOnId: SOCKS, quantity: 1, tiers: over.freebieTiers ?? ['tourist'] }],
            active: true,
            archivedAt: null,
          },
        ],
        categories: [{ id: ADDONS, parentId: null, taxableCategory: 'addons', name: 'Add-ons', defaultPrepStation: null }],
        products:
          over.socksProduct === false
            ? []
            : [
                {
                  id: SOCKS,
                  kind: 'addon',
                  code: 'AO-SOCKS',
                  name: 'Regular Socks',
                  priceSatang: 5_000,
                  priceWeekendSatang: null,
                  categoryId: ADDONS,
                  taxCategoryOverride: null,
                  prepStationOverride: null,
                  variants: [],
                  active: true,
                  archivedAt: null,
                },
              ],
        modifierGroups: [],
        modifierOptions: [],
        modifierLinks: [],
        tiers: [{ code: 'tourist', isDefault: true, archivedAt: null }],
        holidays: [],
        taxConfig: {
          config: {
            rates: [{ id: 'vat', name: 'VAT', percent: 7 }],
            categoryRules: [
              { category: 'tickets', taxRateId: 'vat', taxMode: 'inclusive' },
              { category: 'addons', taxRateId: 'vat', taxMode: 'inclusive' },
            ],
            discountPlacement: 'before_tax',
          },
        },
      },
    ],
  })!;
}

/** Two kids' worth of ticket with one child, and two socks on the counter, as the till sends it. */
const cart = (unitSatang: number, lineTotalSatang?: number) =>
  bridgeCartOf({
    socks: { addOnId: 'a-socks', unitSatang, label: 'Regular Socks' },
    lines: [
      {
        id: LINE,
        packageId: PACKAGE,
        kids: 1,
        adults: 0,
        socks: 2,
        ...(lineTotalSatang !== undefined ? { lineTotalSatang } : {}),
      },
    ],
  });

const context = { now: NOON, timezone: 'Asia/Bangkok', businessDayStart: '05:00:00', memberTier: null };

test('the box takes the bundled sock off the counter at ฿0 and prints it as its own row', () => {
  const copy = catalogue();
  const priced = priceOfflineSale(copy, cart(5_000, 50_000 + 5_000), context);
  assert.equal(priced.quote.pricingMode, 'weekday');
  assert.equal(priced.quote.lineTotals[LINE], 50_000 + 5_000);
  assert.equal(priced.quote.totals.grossSatang, 55_000);
  const printed = offlineLedgerLines(SALE, copy, priced, null);
  assert.deepEqual(
    printed.map((l) => [l.kind, l.label, l.quantity, l.grossSatang]),
    [
      ['kids', 'Kids', 1, 50_000],
      ['socks', 'Regular Socks', 1, 5_000],
      ['socks', 'Regular Socks (free)', 1, 0],
    ],
  );
});

test('the box charges every sock at a tier the free socks were not set for', () => {
  const priced = priceOfflineSale(catalogue({ freebieTiers: ['thai'] }), cart(5_000), context);
  assert.equal(priced.quote.lineTotals[LINE], 50_000 + 2 * 5_000);
});

test('the box refuses a till still charging the bundled sock, as the platform does', () => {
  assert.throws(
    () => priceOfflineSale(catalogue(), cart(5_000, 50_000 + 2 * 5_000), context),
    (err: unknown) => (err as { code?: string }).code === 'SALE_LINE_PRICE_MISMATCH',
  );
});

test('with no socks product on the box, the counter socks are the till’s price and none is free', () => {
  const copy = catalogue({ socksProduct: false });
  const priced = priceOfflineSale(copy, cart(0, 50_000), context);
  assert.equal(priced.quote.lineTotals[LINE], 50_000);
  assert.deepEqual(
    offlineLedgerLines(SALE, copy, priced, null)
      .filter((l) => l.kind === 'socks')
      .map((l) => [l.label, l.quantity, l.grossSatang]),
    [['Regular Socks', 2, 0]],
  );
});
