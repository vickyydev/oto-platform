import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pos = (file: string) => readFileSync(new URL(`../../pos/src/${file}`, import.meta.url), 'utf8');

describe('SCRUM-807 adversarial review: the voucher price at payment', () => {
  it('MEDIUM fixed: the quote arrival retries entry without Back and Pay', () => {
    const till = pos('pages/Till.tsx');
    expect(till).toContain("const voucherPricePending = voucher.held !== null && cart.quote.source !== 'platform'");
    expect(till).toContain('if (locked || step !== 5 || resumed) return;');
    expect(till).toContain('if (voucherPricePending) return;');
    expect(till).toContain('[step, locked, voucherPricePending]');
    expect(till).toContain('active: step === 5 && completionRetry === null && !voucherPricePending');
    expect(till).toContain('pricePending={voucherPricePending}');
  });

  it('MEDIUM FINDING fixed: waiting hides the local estimate with amountUnavailable', () => {
    expect(pos('components/till/StepPayment.tsx')).toContain("{amountUnavailable ? '—'");
  });

  it('MEDIUM FINDING fixed: a pending zero does not promise a free sale', () => {
    expect(pos('components/till/StepPayment.tsx')).toContain('&& !amountUnavailable && total === 0');
  });

  it('MEDIUM fixed: waiting cannot select a tender or confirm, and the voucher guard remains', () => {
    const step = pos('components/till/StepPayment.tsx');
    expect(step).toContain('if (paymentStage?.locked || amountUnavailable) return;');
    expect(step).toContain('|| busy || amountUnavailable}');
    expect(step).toContain('paymentStage && !amountUnavailable && <PaymentTenderPanel');
    expect(pos('pages/Till.tsx')).toContain("if (cart.quote.source !== 'platform')");
    expect(pos('pages/Till.tsx')).toContain('if (!(await voucherReadyFor(input)))');
  });
});
