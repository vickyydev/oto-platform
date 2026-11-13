import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Cross-screen landing pins complement POS runtime recovery tests and the
// disposable two-account browser test. No platform money behavior is changed.
const root = resolve(import.meta.dirname, '../../..');
const screens = ['pages/Till.tsx', 'components/mobile/MobileTill.tsx', 'pages/OrderStation.tsx',
  'pages/MerchStation.tsx', 'components/mobile/order-station/MobileOrderStation.tsx'];
describe('SCRUM-982 adversarial review: a kept charge cannot become another order', () => {
  for (const screen of screens) {
    const source = readFileSync(resolve(root, 'apps/pos/src', screen), 'utf8');
    it(`HIGH: ${screen} supplies its existing sale to payment recovery before collection`, () => {
      expect(source).toMatch(/resumeSaleId: (?:resumed\?\.saleId \?\? )?saleWriter\.committed\?\.id/);
      expect(source).toContain('if (existing) return { ok: true, written: true, saleId: existing.id, sale: existing, replay: true };');
    });
    it(`HIGH: ${screen} keeps late preparation behind scope and lock guards`, () => {
      const start = source.indexOf('const existing = saleWriter.committed;');
      expect(start).toBeGreaterThan(0);
      expect(source.slice(start - 450, start)).toContain('staffLocked.current');
      expect(source.slice(start - 450, start)).toContain('epoch');
    });
  }
  it('HIGH: all three item screens refresh their payment callback when B continues', () => {
    for (const screen of screens.slice(2)) {
      const source = readFileSync(resolve(root, 'apps/pos/src', screen), 'utf8');
      expect(source).not.toContain("stage === 'payment' && paymentSnapshotRef.current?.epoch !== paymentEpoch");
      expect(source).toContain('paymentOrderIdentity(');
    }
  });
});
