import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pos = (file: string) => readFileSync(new URL(`../../pos/src/${file}`, import.meta.url), 'utf8');
const mobile = pos('components/mobile/MobileTill.tsx');
const payment = pos('components/till/StepPayment.tsx');

describe('SCRUM-801/800 — phone payment adversarial review', () => {
  it('HIGH FINDING fixed: every order Cancel uses the counter writer, never reset alone', () => {
    expect(mobile).not.toContain('onCancel={resetSale}');
    expect(mobile).not.toContain('onClick={resetSale}');
    expect(mobile.match(/void handleCancel\(\)/g)).toHaveLength(3);
    expect(mobile).toContain('await saleWriter.cancel(CANCELLED_AT_THE_TILL)');
    expect(pos('pages/Till.tsx')).toContain('await saleWriter.cancel(CANCELLED_AT_THE_TILL)');
    expect(mobile).not.toContain('salesApi.voidSale(');
  });

  it('pins refusals, pending money and an unanswered void without losing the order', () => {
    expect(mobile).toContain('setCancelRefusal(cancelled.message)');
    expect(mobile).toContain('testId="cancel-refusal"');
    expect(mobile).toContain('cancellingRef.current || completionRetry');
    expect(mobile).toContain('!paymentStage.canBack');
    expect(mobile).toContain('inert={cancelling}');
    expect(mobile).toContain('saleEpochRef.current !== epoch');
  });

  it('MEDIUM FINDING fixed: phone controls fit without clipping the payment words', () => {
    expect(payment).toContain('flex-col sm:flex-row');
    expect(payment).toContain('whitespace-normal');
    expect(payment).toContain('grid-cols-2');
    expect(payment).toContain('sm:grid-cols-3');
    expect(payment).toContain('break-words');
    expect(payment).not.toContain('overflow-x-hidden');
  });
});
