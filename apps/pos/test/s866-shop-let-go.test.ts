import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * SCRUM-866 — THE SHOP STATION LETS A SALE IT RANG UP GO.
 *
 * Charge rings the sale up on the platform (`tendering`). Before this, Back
 * from the payment screen and then the cart's X or Clear only reset the shop's
 * own state: the sale stayed Unpaid on the platform for good, History showed
 * it with no receipt number, and the ticket till at the same station kept
 * offering it back as a sale left behind. The shop now does what the F&B
 * station does (`letOrderGo` in `pages/OrderStation.tsx`): the sale is voided
 * through the writer's Cancel with the reason "Cancelled at the till", and a
 * void the platform refuses is shown in its words.
 *
 * The page needs a renderer to drive; what is pinned here is the wiring that
 * makes it the F&B station's behaviour, line for line.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(join(here, '..', 'src', path), 'utf8');

describe('the shop cart voids what it rang up', () => {
  const shop = source('pages/MerchStation.tsx');

  it('voids the rung-up sale through the writer with the till’s Cancel reason', () => {
    expect(shop).toContain("import { CANCELLED_AT_THE_TILL } from '@/lib/tillVoucher';");
    expect(shop).toContain('const cancelled = await saleWriter.cancel(CANCELLED_AT_THE_TILL);');
    // A voided sale's ids are spent: the next Charge is a new sale.
    expect(shop).toContain('if (cancelled.voided) saleWriter.reset();');
  });

  it('wires X (switch tab / scan wristband) and Clear to the let-go first', () => {
    expect(shop).toContain('if (await letOrderGo()) resetOrder();');
    expect(shop).toContain('if (await letOrderGo()) handleClearCart();');
    expect(shop).toContain('onClear={() => void clearOrder()}');
    expect(shop).toContain('onSwitchTab={() => void cancelOrder()}');
    expect(shop).not.toContain('onSwitchTab={resetOrder}');
    expect(shop).not.toContain('onClear={handleClearCart}');
  });

  it('shows a refused void in the platform’s words and keeps the sale on screen', () => {
    expect(shop).toContain('setCancelRefusal(cancelled.message);');
    expect(shop).toMatch(/if \(!cancelled\.ok\) \{\s*setCancelRefusal\(cancelled\.message\);\s*return false;/);
    expect(shop).toContain('testId="cancel-refusal"');
    // A new sale starts clean.
    expect(shop).toMatch(/const resetOrder = \(\) => \{[\s\S]*?setCancelRefusal\(null\);[\s\S]*?setStage\('scan'\);/);
  });

  it('is the same let-go the F&B station has', () => {
    const fnb = source('pages/OrderStation.tsx');
    for (const page of [fnb, shop]) {
      expect(page).toContain('const cancelled = await saleWriter.cancel(CANCELLED_AT_THE_TILL);');
      expect(page).toContain('if (cancelled.voided) saleWriter.reset();');
      expect(page).toContain('if (await letOrderGo()) resetOrder();');
      expect(page).toContain('if (await letOrderGo()) handleClearCart();');
    }
  });
});
