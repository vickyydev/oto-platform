import { useEffect, useRef, useState } from 'react';
import {
  DisplayCartSchema, DisplayMemberSchema, DisplayTotalsSchema, DisplayPaymentSchema,
  type DisplayCart, type DisplayTotals, type DisplayPayment, type DisplayLineBreakdown,
  type StationSessionDocument, type StationSessionStage,
} from '@oto/shared';
import { api, ApiError } from '@/api/client';
import type { ContactChannel, Member, Sale } from '@/types';
import { computeLineBreakdown, isAdultRulePriced, isTierPriced, unpricedCartLines } from './pricing';
import type { RateMode } from './pricingMode';
import type { OrderTotals } from '@/api/sales';

export interface DisplayAnswer {
  type: 'identify' | 'skip_identify' | 'contact_done';
  actionId: string;
  phone?: string;
  nickname?: string;
  contactChannel?: ContactChannel;
}
export interface TicketDisplayState {
  stage: StationSessionStage;
  step: number;
  sessionKey: string;
  tier: string;
  phone: string;
  nickname: string;
  contactChannel: ContactChannel;
  member: Member | null;
  sale?: Sale;
  totals?: OrderTotals;
  rateMode?: RateMode;
  online?: boolean;
  payment?: DisplayPayment;
  voucherPrize?: { nameEn: string; nameTh: string | null } | null;
  nothingToPay?: boolean;
}

const roundMoney = (value: number) => Math.round(value * 100) / 100;
const earlyStages = ['identify', 'welcome', 'input'];

/** Shares captured ticket presentation only, never child, staff or issue records. */
export function ticketDisplayPresentation(state: TicketDisplayState, requestId: string) {
  const allowed = state.step !== 7 && state.step !== 8;
  const supported = allowed && (earlyStages.includes(state.stage)
    || state.online === true && !!state.sale && !!state.totals && (state.stage !== 'payment' || !!state.payment));
  const sale = state.sale;
  const cart: DisplayCart | { supported: boolean; sale: { tier: string } } = sale ? {
    supported, nickname: state.nickname,
    sale: {
      id: sale.id, tier: sale.tier, total: roundMoney(sale.total),
      lines: sale.lines.map(line => {
        const lengthChosen = line.dropOff?.lengthChosen !== false;
        return {
          id: line.id, name: line.ticketType.name,
          translations: line.ticketType.translations ? Object.fromEntries(Object.entries(line.ticketType.translations)
            .filter((entry): entry is [string, { name: string }] => !!entry[1])
            .map(([language, value]) => [language, value.name])) : undefined,
          lineTotal: roundMoney(line.lineTotal), promoItem: line.promoItem ? { name: line.promoItem.name } : undefined,
          breakdown: {
            priced: unpricedCartLines([line]).length === 0, lengthChosen,
            rows: computeLineBreakdown(line, state.rateMode).map(row => ({ ...row,
              unitPrice: roundMoney(row.unitPrice), subtotal: roundMoney(row.subtotal),
              unpriced: row.kind === 'kids' ? !lengthChosen || !isTierPriced(line.ticketType, line.tier)
                : row.key === 'adults' ? !isAdultRulePriced(line.ticketType, line.tier, line.adults) : false,
            })),
          },
        };
      }),
      manualDiscounts: sale.manualDiscounts.map(discount => ({
        id: discount.id, scope: discount.scope, targetLineId: discount.targetLineId,
        targetComponent: discount.targetComponent, targetLabel: discount.targetLabel,
        type: discount.type, value: roundMoney(discount.value),
      })),
      creditGrants: state.stage === 'thankyou' ? sale.creditGrants
        .filter(grant => grant.type === 'fnb_credit' || grant.type === 'item')
        .map(grant => ({ type: grant.type as 'fnb_credit' | 'item', label: grant.label,
          valueTHB: grant.valueTHB === undefined ? undefined : roundMoney(grant.valueTHB), quantity: grant.quantity })) : [],
      bracelets: { adults: sale.bracelets.adults, children: sale.bracelets.children },
    },
    voucherPrize: state.voucherPrize ?? null, nothingToPay: state.nothingToPay ?? false,
  } : { supported, sale: { tier: state.tier } };
  const totals = state.totals ? {
    manualAmounts: Object.fromEntries(Object.entries(state.totals.manualAmounts).map(([key, amount]) => [key, roundMoney(amount)])),
    discountAmount: roundMoney(state.totals.discountAmount), total: roundMoney(state.totals.total),
    taxBreakdown: { serviceChargeTotal: roundMoney(state.totals.taxBreakdown.serviceChargeTotal),
      categories: state.totals.taxBreakdown.categories.map(category => ({
        taxMode: category.taxMode, taxName: category.taxName, tax: roundMoney(category.tax),
        secondaryTaxMode: category.secondaryTaxMode, secondaryTaxName: category.secondaryTaxName,
        secondaryTax: roundMoney(category.secondaryTax),
      })) },
  } : null;
  return {
    stage: state.stage,
    step: state.step,
    cart,
    member: state.member ? { id: state.member.id, nickname: state.member.nickname, tier: state.tier } : null,
    totals,
    payment: state.payment ? {
      saleId: state.payment.saleId, amountSatang: state.payment.amountSatang,
      qrPayload: state.payment.qrPayload, qrImageUrl: state.payment.qrImageUrl, expiresAt: state.payment.expiresAt,
      status: state.payment.status, offline: state.payment.offline, online: state.payment.online,
    } : null,
    prompt: supported && (state.stage === 'identify' || state.stage === 'input') ? {
      kind: state.stage === 'identify' ? 'identify' : 'contact', requestId,
      phone: state.phone, nickname: state.nickname, contactChannel: state.contactChannel,
    } : null,
  };
}

export interface TicketDisplayView {
  stage: 'identify' | 'welcome' | 'order' | 'input' | 'payment' | 'thankyou';
  sale: Sale;
  nickname: string;
  member: Member | null;
  totals?: Pick<OrderTotals, 'manualAmounts' | 'discountAmount' | 'total' | 'taxBreakdown'>;
  payment?: DisplayPayment;
  lineBreakdowns?: Record<string, DisplayLineBreakdown>;
  voucherPrize?: DisplayCart['voucherPrize'];
  nothingToPay?: boolean;
}

/** Reject malformed public data before it reaches the customer renderer. */
export function readTicketDisplayView(document: StationSessionDocument): TicketDisplayView | null {
  if (!['identify', 'welcome', 'order', 'input', 'payment', 'thankyou'].includes(document.stage)
    || document.step === 7 || document.step === 8 || document.cart?.supported !== true) return null;
  const stage = document.stage as TicketDisplayView['stage'];
  const member = document.member == null ? null : DisplayMemberSchema.safeParse(document.member);
  const totals = document.totals == null ? null : DisplayTotalsSchema.safeParse(document.totals);
  const payment = document.payment == null ? null : DisplayPaymentSchema.safeParse(document.payment);
  if (member && !member.success || totals && !totals.success || payment && !payment.success) return null;
  if (stage === 'identify' || stage === 'input') {
    const prompt = document.prompt;
    if (!prompt || prompt.kind !== (stage === 'identify' ? 'identify' : 'contact')
      || typeof prompt.requestId !== 'string' || !prompt.requestId || prompt.requestId.length > 200
      || typeof prompt.phone !== 'string' || prompt.phone.length > 32
      || typeof prompt.nickname !== 'string' || prompt.nickname.length > 100
      || !['whatsapp', 'telegram', 'line'].includes(String(prompt.contactChannel))) return null;
  }
  const full = DisplayCartSchema.safeParse(document.cart);
  // A rolling first-slice publisher has only a tier, and is safe at early steps.
  const rawSale = document.cart.sale;
  const legacy = rawSale !== null && typeof rawSale === 'object' && !Array.isArray(rawSale)
    && !('id' in rawSale) && earlyStages.includes(stage)
    && typeof (rawSale as { tier?: unknown }).tier === 'string'
    && ((rawSale as { tier: string }).tier.length > 0)
    && ((rawSale as { tier: string }).tier.length <= 200);
  if (!full.success && !legacy) return null;
  if (!earlyStages.includes(stage) && (!totals?.success || stage === 'payment' && !payment?.success)) return null;
  const cart = full.success ? full.data : null;
  const publicSale = cart?.sale;
  const sale: Sale = {
    id: publicSale?.id ?? 'DISPLAY', operatorId: '', operatorName: '',
    tier: publicSale?.tier ?? (document.cart.sale as { tier: string }).tier,
    lines: publicSale?.lines.map(line => ({
      id: line.id, ticketType: { id: line.id, name: line.name, durationLabel: '', hours: 0, prices: {},
        translations: line.translations ? Object.fromEntries(Object.entries(line.translations).map(([language, name]) => [language, { name }])) : undefined },
      tier: publicSale.tier, kids: 0, adults: 0, socks: 0, addOns: [], lineTotal: line.lineTotal,
      promoItem: line.promoItem ? { itemId: '', itemKind: 'menu', name: line.promoItem.name, priceTHB: 0 } : undefined,
    })) ?? [],
    manualDiscounts: publicSale?.manualDiscounts.map(discount => ({ ...discount,
      reason: '', amountTHB: totals?.success ? totals.data.manualAmounts[discount.id] ?? 0 : 0,
      appliedBy: '', appliedById: '', appliedAt: '',
    })) ?? [],
    total: publicSale?.total ?? 0,
    // These identifiers are React keys only; showGrantQr is disabled by Display.
    creditGrants: publicSale?.creditGrants.map((grant, index) => ({ ...grant, id: `summary-${index}` })) ?? [],
    bracelets: publicSale?.bracelets ?? { adults: 0, children: 0 }, createdAt: '', status: 'paid', refunds: [],
  };
  return {
    stage, sale, nickname: cart?.nickname ?? '', member: member?.success ? { ...member.data, phone: '' } : null,
    totals: totals?.success ? displayTotals(totals.data) : undefined,
    payment: payment?.success ? payment.data : undefined,
    lineBreakdowns: publicSale ? Object.fromEntries(publicSale.lines.map(line => [line.id, line.breakdown])) : undefined,
    voucherPrize: cart?.voucherPrize, nothingToPay: cart?.nothingToPay,
  };
}

function displayTotals(totals: DisplayTotals): TicketDisplayView['totals'] {
  return { ...totals, taxBreakdown: { ...totals.taxBreakdown,
    netSubtotal: 0, discountTotal: 0, exclusiveTaxTotal: 0, inclusiveTaxTotal: 0, taxTotal: 0, grandTotal: totals.total,
    categories: totals.taxBreakdown.categories.map(category => ({ ...category,
      category: 'tickets', base: 0, taxPercent: 0, serviceCharge: 0, secondaryTaxPercent: 0, gross: 0,
    })),
  } };
}

export function readDisplayAnswer(document: StationSessionDocument, requestId: string): DisplayAnswer | null {
  if (document.prompt?.requestId !== requestId) return null;
  const answer = document.prompt.answer as Partial<DisplayAnswer> | undefined;
  if (!answer || typeof answer.actionId !== 'string') return null;
  if (answer.type === 'skip_identify' && document.stage === 'identify') return answer as DisplayAnswer;
  if (answer.type === 'identify' && document.stage === 'identify' && typeof answer.phone === 'string') return answer as DisplayAnswer;
  if (answer.type === 'contact_done' && document.stage === 'input' && typeof answer.phone === 'string'
    && typeof answer.nickname === 'string' && ['whatsapp','telegram','line'].includes(answer.contactChannel ?? '')) return answer as DisplayAnswer;
  return null;
}

interface ConnectedDisplay { id: string; name: string; connected: boolean }
const POLL_MS = 1_500;
// The browser document keeps its publisher identity through a paused or
// remounted till. A different tab cannot silently take a live display lease.
const holders = new Map<string,string>();
function holderFor(stationId: string): string {
  let holder = holders.get(stationId);
  if (!holder) { holder = crypto.randomUUID(); holders.set(stationId,holder); }
  return holder;
}

interface DisplayPublisher {
  stationId: string;
  holder: string;
  leaseId: string | null;
  renewedAt: number;
  lastPublished: string;
  promptKey: string;
  requestId: string;
  handled: Set<string>;
}

/** A lock pauses this publisher without discarding the current visitor's prompt. */
export function useTicketDisplay(stationId: string | null, state: TicketDisplayState, onAnswer: (answer: DisplayAnswer) => void, active = true) {
  const current = useRef({ state, onAnswer, active });
  current.current = { state, onAnswer, active };
  const publisher = useRef<DisplayPublisher | null>(null);
  const [connected, setConnected] = useState<ConnectedDisplay[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setConnected([]);
    setError(null);
    if (!stationId) return;
    const channel: DisplayPublisher = {
      stationId, holder: holderFor(stationId), leaseId: null, renewedAt: 0,
      lastPublished: '', promptKey: '', requestId: '', handled: new Set(),
    };
    publisher.current = channel;
    return () => {
      if (publisher.current === channel) publisher.current = null;
      if (channel.leaseId) void api.post(`/stations/${stationId}/lease/release`, { leaseId: channel.leaseId }).catch(() => undefined);
    };
  }, [stationId]);

  useEffect(() => {
    const channel = publisher.current;
    if (!stationId || !active || !channel || channel.stationId !== stationId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const base = `/stations/${stationId}`;
    const paused = () => stopped || !current.current.active || publisher.current !== channel;
    const tick = async () => {
      if (paused()) return;
      try {
        const list = await api.get<{ displays: ConnectedDisplay[] }>(`${base}/displays`);
        if (paused()) return;
        const online = list.displays.filter(display => display.connected);
        setConnected(online);
        if (!online.length) return;
        let document: StationSessionDocument;
        if (!channel.leaseId) {
          const claimed = await api.post<{ document: StationSessionDocument; lease: { leaseId: string } }>(`${base}/lease`, { holder: channel.holder });
          if (paused()) return;
          channel.leaseId = claimed.lease.leaseId;
          channel.renewedAt = Date.now();
          document = claimed.document;
          channel.lastPublished = '';
        } else if (Date.now() - channel.renewedAt >= 15_000) {
          const renewed = await api.post<{ document: StationSessionDocument }>(`${base}/lease/renew`, { leaseId: channel.leaseId });
          if (paused()) return;
          document = renewed.document;
          channel.renewedAt = Date.now();
        } else {
          document = (await api.get<{ document: StationSessionDocument }>(`${base}/session`)).document;
          if (paused()) return;
        }
        const latest = current.current;
        const key = `${latest.state.sessionKey}:${latest.state.stage}:${latest.state.step}`;
        if (key !== channel.promptKey) {
          channel.promptKey = key;
          channel.requestId = crypto.randomUUID();
        }
        const answer = readDisplayAnswer(document, channel.requestId);
        if (answer && !channel.handled.has(answer.actionId)) {
          channel.handled.add(answer.actionId);
          latest.onAnswer(answer);
          // React applies the resulting stage/contact state before the next publish.
          return;
        }
        const payload = ticketDisplayPresentation(latest.state, channel.requestId);
        const signature = JSON.stringify(payload);
        if (signature !== channel.lastPublished) {
          await api.post(`${base}/intents`, { type: 'session.publish_display', leaseId: channel.leaseId,
            lastSeenSequence: document.sequence, actionId: crypto.randomUUID(), payload });
          if (paused()) return;
          channel.lastPublished = signature;
        }
        setError(null);
      } catch (failure) {
        if (paused()) return;
        if (failure instanceof ApiError && ['STATION_STALE','STATION_NO_LEASE'].includes(failure.code)) {
          channel.leaseId = null;
          channel.lastPublished = '';
        }
        setConnected([]);
        setError(failure instanceof Error ? failure.message : 'The display could not connect.');
      } finally {
        if (!paused()) timer = setTimeout(() => { void tick(); }, POLL_MS);
      }
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [stationId, active]);
  return { connected, error, supported: ticketDisplayPresentation(state, '').cart.supported };
}
