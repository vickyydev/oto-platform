import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DisplayPayment, DisplayTenderCart } from '@oto/shared';
import type { SupportedLang } from '@/i18n/types';
vi.mock('react', async () => ({ ...await vi.importActual('react'), ...await import('./support/hooks') }));
vi.mock('@/lib/payments', () => ({ paymentMethodKind: (method: string) => method === 'promptpay' ? 'qr' : method }));
const language = vi.hoisted(() => ({ current: 'en' as SupportedLang }));
vi.mock('@/i18n/LanguageContext', async () => {
  const actual = await vi.importActual<typeof import('@/i18n/LanguageContext')>('@/i18n/LanguageContext');
  return { ...actual, useLanguage: () => ({ lang: language.current, t: actual.tFor(language.current) }) };
});
import { useTenderPresentation } from '@/lib/tenderDisplay';
import type { StationDisplayState } from '@/lib/displaySession';
import { TenderCustomerDisplay } from '@/components/shared/TenderCustomerDisplay';
import { PromptPayCustomerScreen } from '@/components/shared/PromptPayCustomerScreen';
import { renderHook } from './support/hooks';

const payment: DisplayPayment = { saleId: null, amountSatang: 12345, qrPayload: 'ZZ TEST gateway payload', qrImageUrl: null,
  expiresAt: '2026-11-05T00:00:00.000Z', status: 'pending', offline: false, online: true };
const cart: DisplayTenderCart = { kind: 'tender', supported: true, subject: 'party_balance', method: 'qr' };
beforeEach(() => { language.current = 'en'; });
afterEach(() => vi.unstubAllGlobals());

describe('SCRUM-738 read-only tender presentation', () => {
  it.each(['event_pass', 'party_balance'] as const)('HIGH: %s forwards only the controller state and releases it once paid', subject => {
    const cleanups: ReturnType<typeof vi.fn>[] = [];
    const handover = vi.fn((_state: StationDisplayState) => { const cleanup = vi.fn(); cleanups.push(cleanup); return cleanup; });
    const hook = renderHook((shown: DisplayPayment) => useTenderPresentation(handover, subject, 'promptpay', shown, true), payment);
    expect(handover).toHaveBeenCalledOnce();
    expect(handover.mock.calls[0]![0].presentation('')).toEqual({ stage: 'payment', step: null, cart: { ...cart, subject },
      payment, member: null, totals: null, prompt: null });
    hook.rerender({ ...payment }); // An equivalent render does not reclaim or blank the display.
    expect(handover).toHaveBeenCalledOnce();
    hook.rerender({ ...payment, status: 'paid' });
    expect(cleanups[0]).toHaveBeenCalledOnce();
    expect(handover).toHaveBeenCalledOnce();
    hook.unmount();
    expect(cleanups[0]).toHaveBeenCalledOnce();
  });

  it('HIGH: changing the tender updates its frame and close/unmount restores the host', () => {
    const cleanup = vi.fn();
    const handover = vi.fn((_state: StationDisplayState) => cleanup);
    const hook = renderHook(({ visible, value }: { visible: boolean; value: DisplayPayment }) =>
      useTenderPresentation(handover, 'event_pass', 'promptpay', value, visible), { visible: true, value: payment });
    hook.rerender({ visible: true, value: { ...payment, status: 'failed', qrPayload: null } });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(handover.mock.calls.at(-1)![0].presentation('').payment?.status).toBe('failed');
    hook.rerender({ visible: false, value: payment });
    expect(cleanup).toHaveBeenCalledTimes(2);
    hook.unmount();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it('HIGH: cash and a malformed payment never start a tender display', () => {
    const handover = vi.fn(() => vi.fn());
    const hook = renderHook(({ method, value }: { method: string; value: DisplayPayment }) =>
      useTenderPresentation(handover, 'event_pass', method, value, true), { method: 'cash', value: payment });
    expect(handover).not.toHaveBeenCalled();
    hook.rerender({ method: 'promptpay', value: { ...payment, amountSatang: -1 } });
    expect(handover).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('HIGH: the display receives the actual QR only while the tender is pending and online', () => {
    vi.stubGlobal('React', React);
    const props = (value: DisplayPayment) => {
      const tree = TenderCustomerDisplay({ cart, payment: value });
      const body = tree.props.children[1] as React.ReactElement<{ children: React.ReactElement<Record<string, unknown>> }>;
      expect(body.props.children.type).toBe(PromptPayCustomerScreen);
      return body.props.children.props;
    };
    expect(props(payment)).toMatchObject({ amount: 123.45, qrPayload: payment.qrPayload, expiresAt: payment.expiresAt });
    for (const changes of [{ status: 'idle' }, { status: 'paid' }, { status: 'blocked' }, { status: 'failed' }, { offline: true }, { online: false }] as Partial<DisplayPayment>[]) {
      expect(props({ ...payment, ...changes })).toMatchObject({ qrPayload: null, qrImageUrl: null, expiresAt: null });
    }
  });

  it('MEDIUM: a card tender has no QR and no family information', () => {
    vi.stubGlobal('React', React);
    const tree = TenderCustomerDisplay({ cart: { ...cart, subject: 'event_pass', method: 'card' }, payment });
    const text = JSON.stringify(tree);
    expect(text).toContain('Event pass'); expect(text).toContain('Pay by card');
    expect(text).not.toContain(payment.qrPayload);
  });

  it.each([
    ['en', 'Party balance', 'Event pass', 'Pay by card'],
    ['th', 'ยอดคงเหลือของงานปาร์ตี้', 'บัตรผ่านกิจกรรม', 'ชำระด้วยบัตร'],
    ['zh', '派对尾款', '活动通行证', '银行卡付款'],
    ['ru', 'Остаток за праздник', 'Пропуск на мероприятие', 'Оплатите картой'],
    ['fr', 'Solde de la fête', 'Pass événement', 'Payer par carte'],
  ] as const)('MEDIUM: the separate tender screen follows the display language (%s)', (lang, party, pass, card) => {
    language.current = lang;
    vi.stubGlobal('React', React);
    const qr = JSON.stringify(TenderCustomerDisplay({ cart, payment }));
    expect(qr).toContain(party);
    const cardText = JSON.stringify(TenderCustomerDisplay({ cart: { ...cart, subject: 'event_pass', method: 'card' }, payment }));
    expect(cardText).toContain(pass);
    expect(cardText).toContain(card);
    expect(cardText).not.toContain(payment.qrPayload);
    if (lang !== 'en') {
      expect(qr).not.toContain('Party balance');
      expect(qr).not.toContain('Waiting for payment confirmation');
      const refused = JSON.stringify(TenderCustomerDisplay({ cart, payment: { ...payment, status: 'failed' } }));
      expect(refused).not.toContain('Please follow the staff screen');
    }
  });
});
