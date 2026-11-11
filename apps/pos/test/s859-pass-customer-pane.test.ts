import * as React from 'react';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentDisplayState } from '@/lib/usePaymentStage';
import { CustomerPaymentPane } from '@/components/parties/AddAttendeeModal';
import { LanguageProvider, tFor } from '@/i18n/LanguageContext';

// The pane asks only which kind a method token is; the catalogue behind it says nothing of what is tested here.
vi.mock('@/lib/payments', () => ({ paymentMethodKind: (method: string) => method === 'promptpay' ? 'qr' : method }));
// The pane lives beside the modal it serves; the operator context the modal reads looks at the page's address on import, which a static render has none of.
vi.mock('@/auth/OperatorContext', () => ({ useOperator: () => ({}) }));

/**
 * SCRUM-859 — THE EVENT PASS'S SPLIT-VIEW CUSTOMER HALF SHOWS THE PASS.
 *
 * The paired tender display draws the pass by the event's title beside the
 * amount; the split view's customer half, the other surface of the same
 * tender, read only the amount. Now it draws the same line card and Total in
 * the same frame, beside the QR or the "Amount due" block it had; a free
 * event, with no line, keeps the amount-only screen. Mirrors the tender
 * display's cases in s859-payment-order-lines.test.ts.
 */

beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());

const QR_IMAGE = 'https://pay.example.test/zz-test-qr.png';
const EXPIRES = new Date(Date.now() + 5 * 60_000).toISOString();
const line = { label: 'ZZ TEST Party', qty: 1, lineTotal: 600 };

const display = (overrides: Partial<PaymentDisplayState> = {}): PaymentDisplayState => ({
  saleId: 'sale-pass', amountSatang: 60_000, qrPayload: null, qrImageUrl: null, expiresAt: null, status: 'idle', offline: false, online: true,
  creditSatang: 0, ...overrides,
});

/** The customer half as a guest reads it, in English. */
function under(element: ReactElement): string {
  vi.stubGlobal('window', {
    localStorage: { getItem: () => 'en', setItem: () => undefined },
    location: { search: '' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  return renderToStaticMarkup(createElement(LanguageProvider, { storageKey: 'zz-test-859-pass', children: element }));
}

/** The markup of one `data-testid` block, by its opening tag onward (the blocks here nest in document order). */
function from(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  expect(at, `${testId} is drawn`).toBeGreaterThan(-1);
  return html.slice(at);
}
function between(html: string, testId: string, nextTestId: string): string {
  const start = from(html, testId);
  const end = start.indexOf(`data-testid="${nextTestId}"`);
  expect(end, `${nextTestId} follows ${testId}`).toBeGreaterThan(0);
  return start.slice(0, end);
}

const pane = (props: Partial<Parameters<typeof CustomerPaymentPane>[0]>) =>
  under(createElement(CustomerPaymentPane, { amount: 600, qr: display(), note: 'ZZ TEST Party', paymentMethod: 'cash', ...props }));

describe('SCRUM-859: the event pass’s split-view customer half at the payment stage', () => {
  it('a named line beside the QR, and beside the card amount; the total is the payment’s own', () => {
    const t = tFor('en');
    const qr = pane({ paymentMethod: 'promptpay', lines: [line], qr: display({ status: 'pending', qrImageUrl: QR_IMAGE, expiresAt: EXPIRES }) });
    expect(qr).toContain('data-testid="customer-payment"');
    const drawn = between(qr, 'payment-order-lines', 'payment-order-summary');
    expect(drawn).toContain('data-testid="tender-display-line"');
    expect(drawn).toContain('ZZ TEST Party');
    const summary = between(qr, 'payment-order-summary', 'payment-amount');
    expect(summary).toContain(t('common.total'));
    expect(summary).toContain('฿600');
    const amount = from(qr, 'payment-amount');
    expect(amount).toContain('data-testid="payment-qr"');
    expect(amount).toContain(QR_IMAGE);
    expect(amount).toContain('data-testid="payment-qr-countdown"');
    expect(amount).toContain(t('till.payment.scanToPay'));
    expect(amount).toContain('฿600');

    const card = pane({ paymentMethod: 'card', lines: [line] });
    expect(between(card, 'payment-order-lines', 'payment-order-summary')).toContain('ZZ TEST Party');
    const due = from(card, 'payment-amount');
    expect(due).toContain('Amount due');
    expect(due).toContain('฿600');
    expect(due).toContain('Please complete payment with our staff.');
    expect(card).not.toContain('data-testid="payment-qr"');

    // No method chosen yet: the pane's own invitation, beside the line.
    expect(from(pane({ paymentMethod: null, lines: [line] }), 'payment-amount')).toContain('Our staff will help you choose how to pay.');

    // The Total row and the figure read the payment, never the line drawn beside them.
    const partial = pane({ amount: 500, lines: [line] });
    expect(between(partial, 'payment-order-lines', 'payment-order-summary')).toContain('฿600');
    expect(between(partial, 'payment-order-summary', 'payment-amount')).toContain('฿500');
    expect(from(partial, 'payment-amount')).toContain('฿500');
    expect(from(partial, 'payment-amount')).not.toContain('฿600');
  });

  it('no line — a free event — keeps the amount-only screen it had', () => {
    const cash = pane({ amount: 0, qr: display({ amountSatang: 0 }) });
    expect(cash).not.toContain('data-testid="customer-payment"');
    expect(cash).not.toContain('data-testid="tender-display-line"');
    expect(cash).toContain('Amount due');
    expect(cash).toContain('฿0');
    expect(cash).toContain('ZZ TEST Party');
    expect(cash).toContain('Please complete payment with our staff.');
    const qr = pane({ paymentMethod: 'promptpay', lines: [], qr: display({ status: 'pending', qrImageUrl: QR_IMAGE, expiresAt: EXPIRES }) });
    expect(qr).not.toContain('data-testid="customer-payment"');
    expect(qr).toContain(tFor('en')('till.payment.scanToPay'));
    expect(qr).toContain('data-testid="payment-qr"');
    expect(qr).toContain('data-testid="payment-qr-countdown"');
    expect(qr).toContain('฿600');
  });
});
