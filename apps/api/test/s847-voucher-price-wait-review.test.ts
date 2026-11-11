import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pos = (file: string) => readFileSync(new URL(`../../pos/src/${file}`, import.meta.url), 'utf8');

/**
 * SCRUM-847 — the till's own wiring for the wait on a voucher price. What each
 * piece does is driven in apps/pos (s847-voucher-price-wait, s847-display-price-wait)
 * and on the box (packages/box-agent s847-price-wait-display); the lines that
 * join them in `pages/Till.tsx` are only readable as text.
 */
describe('SCRUM-847: the customer screen waits with the staff screen', () => {
  const till = pos('pages/Till.tsx');

  it('both customer screens are told the price is pending, from the one flag the staff step reads', () => {
    expect(till).toContain("const voucherPricePending = voucher.held !== null && cart.quote.source !== 'platform'");
    // The separate display, through what is published to it.
    expect(till).toMatch(/const linkedDisplay = useTicketDisplay\([\s\S]{0,1200}\n {4}pricePending: voucherPricePending,\n/);
    // The till's own customer half.
    expect(till).toMatch(/<CustomerDisplay\n[\s\S]{0,900}\n {14}pricePending=\{voucherPricePending\}\n/);
    // The staff step.
    expect(till).toContain('pricePending={voucherPricePending}\n              priceUnavailable={voucherUnpriced}');
  });

  it('nothing of the sale is published for the wait, and only at the payment stage', () => {
    const session = pos('lib/displaySession.ts');
    expect(session).toContain("const awaitingPrice = state.pricePending === true && state.stage === 'payment';");
    expect(session).toContain('const supported = !awaitingPrice && allowed &&');
    expect(session).toContain('const sale = awaitingPrice ? undefined : state.sale;');
    expect(session).toContain('const totals = state.totals && !awaitingPrice ? {');
    expect(session).toContain('payment: state.payment && !awaitingPrice ? {');
  });

  it('the customer half asks for nothing before any other payment screen is chosen', () => {
    const display = pos('components/till/CustomerDisplay.tsx');
    const stage = display.slice(display.indexOf("if (stage === 'payment') {"));
    expect(stage.indexOf('if (pricePending) {')).toBeGreaterThan(0);
    expect(stage.indexOf('if (pricePending) {')).toBeLessThan(stage.indexOf('if (nothingToPay && unpriced.length === 0 && sale.total === 0) {'));
    expect(stage.indexOf('if (pricePending) {')).toBeLessThan(stage.indexOf("t('common.pleasePay')"));
    expect(stage).toContain("{t('common.waitingForStaff')}");
  });

  it('the staff line gives the reason the voucher card gives, and only when nothing is on its way', () => {
    expect(till).toMatch(/const voucherUnpriced = voucher\.held\n\s+\? voucherUnpricedReason\(\{\n\s+quote: cart\.quote,\n\s+pending: cart\.pending,\n\s+error: cart\.error,/);
    const step = pos('components/till/StepPayment.tsx');
    expect(step).toContain('{pricePending && (priceUnavailable');
    expect(step).toContain('{voucherPriceUnavailableLine(priceUnavailable)}');
    expect(step).toContain('Waiting for the voucher price...');
    // No timer and no second request: the quote hook is not touched by this work.
    expect(pos('lib/tillVoucher.ts')).toContain("if (quote.source === 'platform' || pending) return null;");
  });
});
