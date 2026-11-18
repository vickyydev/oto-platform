import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeCartOf } from '@oto/shared';
import { priceOfflineSale, readOfflineCatalogue } from '../src/offline-pricing';
import { tillBundle } from './_support';

/**
 * SCRUM-1010 — THE PARK'S DAY RUNS MIDNIGHT TO MIDNIGHT, ON THE BOX TOO.
 *
 * The box prices an offline sale on the business date its config bundle's
 * `businessDayStart` gives. The cloud now sends 00:00 for every park, so a
 * sale at 00:30 on a Saturday is Saturday's and takes the weekend price, as
 * the platform prices it. Before the switch the bundle carried 05:00 and the
 * same sale took Friday's weekday price.
 */

const PACKAGE = '018f0000-0000-7000-8000-000000101001';
const LINE = '018f0000-0000-7000-8000-000000101002';

function catalogue() {
  return readOfflineCatalogue({
    items: [
      {
        version: 'cat-s1010-midnight',
        packages: [
          {
            id: PACKAGE,
            name: 'ZZ TEST Two hours',
            prices: { tourist: { weekday: 50_000, weekend: 60_000 } },
            adultRules: null,
            freebies: [],
            active: true,
            archivedAt: null,
          },
        ],
        categories: [],
        products: [],
        modifierGroups: [],
        modifierOptions: [],
        modifierLinks: [],
        tiers: [{ code: 'tourist', isDefault: true, archivedAt: null }],
        holidays: [],
        taxConfig: {
          config: {
            rates: [{ id: 'vat', name: 'VAT', percent: 7 }],
            categoryRules: [{ category: 'tickets', taxRateId: 'vat', taxMode: 'inclusive' }],
            discountPlacement: 'before_tax',
          },
        },
      },
    ],
  })!;
}

const cart = () => bridgeCartOf({ lines: [{ id: LINE, packageId: PACKAGE, kids: 1, adults: 0 }] });

const contextAt = (iso: string, businessDayStart: string) => ({
  now: new Date(iso),
  timezone: 'Asia/Bangkok',
  businessDayStart,
  memberTier: null,
});

test('the till bundle the cloud sends carries the park’s midnight day start', () => {
  assert.equal(tillBundle().branch.businessDayStart, '00:00');
});

test('an offline sale at 00:30 on Saturday is Saturday’s: weekend price', () => {
  const dayStart = tillBundle().branch.businessDayStart;
  // 00:30 on Saturday 26 September 2026 in Bangkok.
  const priced = priceOfflineSale(catalogue(), cart(), contextAt('2026-09-25T17:30:00.000Z', dayStart));
  assert.equal(priced.quote.pricingMode, 'weekend');
  assert.equal(priced.quote.lineTotals[LINE], 60_000);
});

test('an offline sale at 23:59 on Friday is still Friday’s: weekday price', () => {
  const dayStart = tillBundle().branch.businessDayStart;
  const priced = priceOfflineSale(catalogue(), cart(), contextAt('2026-09-25T16:59:00.000Z', dayStart));
  assert.equal(priced.quote.pricingMode, 'weekday');
  assert.equal(priced.quote.lineTotals[LINE], 50_000);
});

test('a box still holding a 05:00 bundle prices the same 00:30 sale on Friday until its next heartbeat', () => {
  // The case the plan names for a box that has not fetched the new bundle
  // yet: the park is closed at that hour, and the cloud re-dates the sale.
  const priced = priceOfflineSale(catalogue(), cart(), contextAt('2026-09-25T17:30:00.000Z', '05:00'));
  assert.equal(priced.quote.pricingMode, 'weekday');
});
