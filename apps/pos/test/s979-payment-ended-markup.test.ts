import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PaymentAttemptView } from '@oto/shared';
import { PaymentRow } from '@/components/history/SaleDetail';
import { PaymentTenderPanel } from '@/components/till/PaymentTenderPanel';
import { endedTenderLine, notStartedReason, PAYMENT_NOT_STARTED_SENTENCES } from '@/lib/paymentEnded';
import type { PaymentStageController, PaymentStageState } from '@/lib/usePaymentStage';

// The components are compiled with the classic JSX runtime here, as in s954.
Object.assign(globalThis, { React });
// SaleDetail reads the operator, the station and the router at import (as s954 stands them in).
vi.mock('@/station/StationContext', () => ({ useStation: () => ({ active: { id: 'station-1' } }) }));
vi.mock('wouter', () => ({ useLocation: () => ['/', () => undefined] }));
vi.mock('@/auth/OperatorContext', () => ({
  useOperator: () => ({ operator: { id: 'acc-som', name: 'Som' }, can: () => true, offlineUnlock: null }),
}));

/**
 * SCRUM-979 (points 1, 11, 12, 13) — WHAT IS DRAWN FOR A TENDER THAT ENDED
 * WITHOUT MONEY: the payment step's status card and line, and History's row.
 */
const plain = (html: string) => html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const NOT_READY = 'The card terminal is not ready on this counter yet. Try again in a moment, or take another way to pay.';

function attempt(over: Partial<PaymentAttemptView> = {}): PaymentAttemptView {
  return {
    id: 'a', saleId: 's', method: 'card', provider: 'digio', status: 'declined', amountSatang: 104_000, tenderedSatang: null,
    changeSatang: null, terminalRef: null, tid: null, approvalCode: null, last4: null, invoiceNo: null, tranRef: null,
    actionId: null, offline: false, paidAt: null, createdAt: '2026-11-13T05:00:00.000Z', ...over,
  };
}

function panel(state: Partial<PaymentStageState>): string {
  const full = {
    phase: 'ready', saleId: 's', method: null, kind: null, outstandingSatang: 104_000, amountSatang: 104_000, tenderedSatang: 104_000,
    attempt: null, route: 'card_terminal', qr: { qrPayload: null, qrImageUrl: null, expiresAt: null, expiryTimerMs: null },
    error: null, retryable: false, settlements: [], creditSatang: 0, creditSaleId: null, creditRefusedSaleId: null, cancelRefusal: null,
    ...state,
  } as PaymentStageState;
  const stage = { state: full, online: true, locked: false, busy: false, canSubmit: false, canInquire: false, canConfirm: false, canCancel: false,
    retry: async () => undefined, cancel: async () => false, inquire: async () => undefined, confirm: async () => undefined,
    manual: async () => undefined } as unknown as PaymentStageController;
  return plain(renderToStaticMarkup(createElement(PaymentTenderPanel, { stage, showSubmit: false })));
}

describe('the payment step after a card the terminal was never asked for (point 3)', () => {
  it('the card reads "Card payment not started" and the line is the platform’s reason', () => {
    const text = panel({ attempt: attempt(), error: NOT_READY, notStarted: true });
    expect(text).toContain('Card payment not started');
    expect(text).not.toContain('Payment declined');
    expect(text).toContain(NOT_READY);
  });

  it('a real decline reads as it did: "Payment declined" on the card, today’s line under it', () => {
    const text = panel({ attempt: attempt(), error: 'Payment declined. Choose a payment method.', notStarted: false });
    // The card's "Payment declined", then the line under it.
    expect(text.indexOf('Payment declined')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Payment declined')).toBeLessThan(text.indexOf('Payment declined. Choose a payment method.'));
    expect(text).not.toContain('not started');
  });

  it('the rule: only the platform’s own sentences on a declined tender; any other text, or none, is a real decline', () => {
    for (const sentence of PAYMENT_NOT_STARTED_SENTENCES) {
      expect(notStartedReason({ status: 'declined' }, sentence)).toBe(sentence);
      expect(notStartedReason({ status: 'declined' }, `  ${sentence} `)).toBe(sentence);
      expect(notStartedReason({ status: 'cancelled' }, sentence)).toBeNull();
    }
    expect(notStartedReason({ status: 'declined' }, 'Bank error (code 05)')).toBeNull();
    expect(notStartedReason({ status: 'declined' }, null)).toBeNull();
    const today = (status: string) => `Payment ${status}. Choose a payment method.`;
    expect(endedTenderLine({ status: 'declined' }, 'DECLINED', today)).toEqual({ line: 'Payment declined. Choose a payment method.', notStarted: false });
    expect(endedTenderLine({ status: 'not_found' }, null, today)).toEqual({ line: 'Payment not found. Choose a payment method.', notStarted: false });
    expect(endedTenderLine({ status: 'declined' }, NOT_READY, today)).toEqual({ line: NOT_READY, notStarted: true });
  });

  it('the till’s sentences are the platform’s own, word for word (apps/api services/payments/terminal.ts)', () => {
    const platform = readFileSync(path.resolve(import.meta.dirname, '../../api/src/services/payments/terminal.ts'), 'utf8')
      .replace(/'\s*\+\s*'/g, '').replace(/\s+/g, ' ');
    for (const sentence of PAYMENT_NOT_STARTED_SENTENCES) expect(platform, sentence).toContain(`'${sentence}'`);
    // Every sentence the platform says for a refusal that sent nothing is one the till knows.
    const block = platform.slice(platform.indexOf('const NOT_SENT_WORDS'), platform.indexOf('export const TERMINAL_NOTHING_SENT_CODES'));
    const said = [...block.matchAll(/: '([^']+)'/g), ...block.matchAll(/COMMAND_EXPIRED_WORDS = '([^']+)'/g)].map((m) => m[1]!);
    expect(said.length).toBeGreaterThanOrEqual(9);
    for (const sentence of new Set(said)) expect(PAYMENT_NOT_STARTED_SENTENCES, sentence).toContain(sentence);
  });
});

describe('History lists a tender that took no money without an amount in the money column (point 6)', () => {
  const row = (over: Partial<PaymentAttemptView>) => renderToStaticMarkup(createElement(PaymentRow, {
    attempt: attempt(over), sale: { note: null }, fmt: () => '13 Nov, 12:00',
  }));
  const moneyColumn = (html: string) => html.match(/<span class="tabular-nums shrink-0 font-semibold">([^<]*)<\/span>/)?.[1] ?? null;

  it('a declined card: "Card · Declined (฿1040 asked)", greyed, and nothing in the money column', () => {
    const html = row({ status: 'declined' });
    expect(plain(html)).toContain('Card · Declined (฿1040 asked)');
    expect(html).toContain('<span class="font-normal text-sm text-muted-foreground"> (฿1040 asked)</span>');
    expect(moneyColumn(html)).toBeNull();
  });

  it('a cancelled QR and a card not on the terminal: the same', () => {
    for (const over of [{ status: 'cancelled' as const, method: 'qr' as const }, { status: 'not_found' as const }]) {
      const html = row(over);
      expect(plain(html)).toContain('(฿1040 asked)');
      expect(moneyColumn(html)).toBeNull();
    }
  });

  it('cash approved keeps its amount where it was; a deposit kept with the party keeps its amount', () => {
    expect(moneyColumn(row({ status: 'approved', method: 'cash', paidAt: '2026-11-13T05:01:00.000Z' }))).toBe('฿1040');
    const deposit = row({ status: 'cancelled', method: 'other', partyDeposit: true });
    expect(moneyColumn(deposit)).toBe('฿1040');
    expect(plain(deposit)).not.toContain('asked');
  });

  it('a tender still open (waiting, no answer, to be confirmed) keeps its amount: money may have moved', () => {
    for (const status of ['sent_to_terminal', 'unknown', 'awaiting_staff_confirmation', 'created'] as const) {
      expect(moneyColumn(row({ status })), status).toBe('฿1040');
    }
  });
});
