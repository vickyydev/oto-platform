import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DisplayCartSchema, DisplayMemberSchema, DisplayTotalsSchema, DisplayPaymentSchema,
  ChildReviewPromptSchema, ChildReviewDocumentPromptSchema, ChildReviewAnswerSchema,
  ConsentPromptSchema, ConsentDocumentPromptSchema, ConsentAnswerSchema,
  type DisplayCart, type DisplayTotals, type DisplayPayment, type DisplayLineBreakdown,
  type ChildReviewPrompt, type ChildReviewAnswer,
  type ConsentPrompt, type ConsentAnswer,
  type StationSessionDocument, type StationSessionStage,
} from '@oto/shared';
import { api, ApiError } from '@/api/client';
import { bridgeApi } from '@/api/bridge';
import { currentLane, isBoxLaneTrigger, noteLaneFailure } from './lane';
import type { ContactChannel, Member, Sale } from '@/types';
import { computeLineBreakdown, isAdultRulePriced, isTierPriced, unpricedCartLines } from './pricing';
import type { RateMode } from './pricingMode';
import type { OrderTotals } from '@/api/sales';
import { membersApi, type ApiChild } from '@/api/platform';
import type { SavedChild } from '@/types';

interface ContactDisplayAnswer {
  type: 'identify' | 'skip_identify' | 'contact_done';
  actionId: string;
  phone?: string;
  nickname?: string;
  contactChannel?: ContactChannel;
}
export type DisplayAnswer = ContactDisplayAnswer | ChildReviewAnswer | ConsentAnswer;
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
  /** Keep typed answers while an online price refresh temporarily hides their presentation. */
  quoteRefreshing?: boolean;
  payment?: DisplayPayment;
  voucherPrize?: { nameEn: string; nameTh: string | null } | null;
  nothingToPay?: boolean;
  childReview?: Omit<ChildReviewPrompt, 'kind' | 'requestId'>;
  reviewRevision?: number;
  consent?: Omit<ConsentPrompt, 'kind' | 'requestId'>;
  consentRevision?: string;
}

const roundMoney = (value: number) => Math.round(value * 100) / 100;
const earlyStages = ['identify', 'welcome', 'input'];

/** Shares captured ticket rows and finite child review, never private profiles or issue records. */
export function ticketDisplayPresentation(state: TicketDisplayState, requestId: string) {
  const childReview = state.step === 8 && state.stage === 'input' && state.online === true && state.childReview
    ? ChildReviewPromptSchema.safeParse({ ...state.childReview, kind: 'child_review', requestId: requestId || 'pending' }) : null;
  const consent = state.step === 7 && state.stage === 'input' && state.online === true && state.consent
    ? ConsentPromptSchema.safeParse({ ...state.consent, kind: 'consent', requestId: requestId || 'pending' }) : null;
  const allowed = (state.step !== 7 || consent?.success === true) && (state.step !== 8 || childReview?.success === true);
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
    prompt: consent?.success && supported ? consent.data : childReview?.success && supported ? childReview.data : supported && (state.stage === 'identify' || state.stage === 'input') ? {
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
  childReview?: ChildReviewPrompt;
  consent?: ConsentPrompt;
}

/** Reject malformed public data before it reaches the customer renderer. */
export function readTicketDisplayView(document: StationSessionDocument): TicketDisplayView | null {
  if (!['identify', 'welcome', 'order', 'input', 'payment', 'thankyou'].includes(document.stage)
    || document.cart?.supported !== true) return null;
  const stage = document.stage as TicketDisplayView['stage'];
  const childReview = stage === 'input' && document.prompt?.kind === 'child_review'
    ? ChildReviewDocumentPromptSchema.safeParse(document.prompt) : null;
  const consent = stage === 'input' && document.prompt?.kind === 'consent'
    ? ConsentDocumentPromptSchema.safeParse(document.prompt) : null;
  if (childReview && !childReview.success || document.step === 8 && !childReview?.success
    || consent && !consent.success || document.step === 7 && !consent?.success) return null;
  const member = document.member == null ? null : DisplayMemberSchema.safeParse(document.member);
  const totals = document.totals == null ? null : DisplayTotalsSchema.safeParse(document.totals);
  const payment = document.payment == null ? null : DisplayPaymentSchema.safeParse(document.payment);
  if (member && !member.success || totals && !totals.success || payment && !payment.success) return null;
  if ((stage === 'identify' || stage === 'input') && !childReview?.success && !consent?.success) {
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
    childReview: childReview?.success ? childReview.data : undefined,
    consent: consent?.success ? consent.data : undefined,
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

/** A display correction never includes the private fields held by the till. */
export function childReviewPatch(draft: Pick<ChildReviewPrompt['slots'][number], 'name' | 'dateOfBirth' | 'ageYears'>, saved: SavedChild) {
  const patch: Record<string, unknown> = {};
  const name = draft.name.trim();
  if (name !== saved.childName.trim()) patch.name = name;
  if ((draft.dateOfBirth ?? '') !== (saved.dateOfBirth ?? '')) {
    patch.dateOfBirth = draft.dateOfBirth;
    patch.ageYears = draft.ageYears;
  } else if (draft.ageYears !== saved.childAge) patch.ageYears = draft.ageYears;
  return patch;
}

interface ChildReviewSaveOperation {
  scope: string;
  slotId: string;
  childId: string;
  actionId: string;
  key: string;
  patch: Record<string, unknown>;
  result?: ApiChild;
  inFlight?: Promise<boolean>;
  controller?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}
const CHILD_REVIEW_IDLE: ChildReviewPrompt['save'] = { status: 'idle', slotId: null, actionId: null };

/** Retains one profile correction until its reply is known or its visitor leaves. */
export function useChildReviewSave(options: {
  scope: string;
  paused: boolean;
  isCurrent: (scope: string, slotId: string, childId: string) => boolean;
  onSaved: (slotId: string, child?: ApiChild) => void;
}) {
  const current = useRef(options);
  current.current = options;
  const operation = useRef<ChildReviewSaveOperation | null>(null);
  const mounted = useRef(true);
  const [save, setSave] = useState<ChildReviewPrompt['save']>(CHILD_REVIEW_IDLE);
  const live = useCallback((op: ChildReviewSaveOperation, allowPaused = false) => mounted.current
    && operation.current === op && current.current.scope === op.scope
    && current.current.isCurrent(op.scope, op.slotId, op.childId) && (allowPaused || !current.current.paused), []);
  const adopt = useCallback((op: ChildReviewSaveOperation) => {
    if (!live(op) || !op.result) return false;
    operation.current = null;
    setSave(CHILD_REVIEW_IDLE);
    current.current.onSaved(op.slotId, op.result);
    return true;
  }, [live]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const op = operation.current;
      operation.current = null;
      clearTimeout(op?.timer);
      op?.controller?.abort();
    };
  }, []);
  const { scope, paused, isCurrent } = options;
  useEffect(() => {
    const op = operation.current;
    if (op && (op.scope !== scope || !isCurrent(op.scope, op.slotId, op.childId))) {
      operation.current = null;
      clearTimeout(op.timer);
      op.controller?.abort();
      setSave(CHILD_REVIEW_IDLE);
    } else if (op && !paused) adopt(op);
    // An unlock adopts an already received reply; it never starts another save.
  }, [scope, paused, isCurrent, adopt]);
  const run = async (op: ChildReviewSaveOperation): Promise<boolean> => {
    if (!live(op)) return false;
    if (op.result) return adopt(op);
    if (op.inFlight) return op.inFlight;
    setSave({ status: 'saving', slotId: op.slotId, actionId: op.actionId });
    if (!live(op)) {
      if (live(op, true)) setSave({ status: 'failed', slotId: op.slotId, actionId: op.actionId });
      return false;
    }
    const pending = (async () => {
      const controller = new AbortController();
      op.controller = controller;
      // An aborted reply leaves the write outcome unknown; retry the same key.
      op.timer = setTimeout(() => controller.abort(), 8_000);
      try {
        const result = await membersApi.updateChild(op.childId, op.patch, op.key, controller.signal);
        if (!live(op, true)) return false;
        if (controller.signal.aborted || result.child.id !== op.childId) {
          setSave({ status: 'failed', slotId: op.slotId, actionId: op.actionId });
          return false;
        }
        op.result = result.child;
        return adopt(op);
      } catch {
        if (live(op, true)) setSave({ status: 'failed', slotId: op.slotId, actionId: op.actionId });
        return false;
      } finally {
        clearTimeout(op.timer);
        op.timer = undefined;
        op.controller = undefined;
        op.inFlight = undefined;
      }
    })();
    op.inFlight = pending;
    return pending;
  };
  return {
    save,
    confirm: async (slotId: string, childId: string, patch: Record<string, unknown>, actionId: string) => {
      if (!mounted.current || current.current.paused || !current.current.isCurrent(options.scope, slotId, childId)) return false;
      const retained = operation.current;
      if (retained) return retained.scope === options.scope && retained.slotId === slotId
        && retained.childId === childId && retained.actionId === actionId ? run(retained) : false;
      if (!Object.keys(patch).length) { current.current.onSaved(slotId); return true; }
      const op: ChildReviewSaveOperation = { scope: options.scope, slotId, childId, actionId,
        key: `child-review:${actionId}`, patch: { ...patch } };
      operation.current = op;
      return run(op);
    },
    retry: async (slotId: string, actionId: string) => {
      const op = operation.current;
      return op?.slotId === slotId && op.actionId === actionId ? run(op) : false;
    },
  };
}

export function readDisplayAnswer(document: StationSessionDocument, requestId: string): DisplayAnswer | null {
  if (document.prompt?.requestId !== requestId) return null;
  if (document.prompt.kind === 'consent') {
    const prompt = ConsentDocumentPromptSchema.safeParse(document.prompt);
    const answer = ConsentAnswerSchema.safeParse(document.prompt.answer);
    return document.stage === 'input' && (document.step === 7 || document.step === null)
      && prompt.success && answer.success && answer.data.payload.requestId === requestId
      && answer.data.payload.visitorId === prompt.data.visitorId ? answer.data : null;
  }
  if (document.prompt.kind === 'child_review') {
    const prompt = ChildReviewDocumentPromptSchema.safeParse(document.prompt);
    const answer = ChildReviewAnswerSchema.safeParse(document.prompt.answer);
    return document.stage === 'input' && prompt.success && answer.success
      && answer.data.payload.requestId === requestId && answer.data.payload.visitorId === prompt.data.visitorId
      ? answer.data : null;
  }
  const answer = document.prompt.answer as Partial<ContactDisplayAnswer> | undefined;
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
  signingOut: boolean;
  claiming: Promise<string | undefined> | null;
  processing: { actionId: string; promptKey: string } | null;
}

let signOutPublisher: DisplayPublisher | null = null;

/** Capture only this browser's own publisher before the staff session ends. */
export function takeTicketDisplayLeaseForSignOut(): Promise<string | undefined> {
  const channel = signOutPublisher;
  signOutPublisher = null;
  if (!channel) return Promise.resolve(undefined);
  channel.signingOut = true;
  if (!channel.claiming) return Promise.resolve(channel.leaseId ?? undefined);
  // A claim already on the wire may have acquired the lease. Wait briefly
  // for its result, but a stalled connection must not prevent server sign-out.
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 3_000);
    void channel.claiming!.then((leaseId) => { clearTimeout(timer); resolve(leaseId); });
  });
}

/** A lock pauses this publisher without discarding the current visitor's prompt. */
type DisplayPresentation = Pick<StationSessionDocument, 'stage' | 'step' | 'cart' | 'member' | 'totals' | 'payment' | 'prompt'>;
interface StationDisplayState {
  key: string;
  supported: boolean;
  presentation: (requestId: string) => DisplayPresentation;
}

export function useTicketDisplay(stationId: string | null, state: TicketDisplayState, onAnswer: (answer: DisplayAnswer) => void | boolean | Promise<void | boolean>, active = true) {
  const refreshingInput = state.quoteRefreshing === true && (state.step === 7 || state.step === 8);
  return useStationDisplay(stationId, {
    key: `${state.sessionKey}:${state.stage}:${state.step}:${state.reviewRevision ?? 0}:${state.online === true}:${state.childReview?.visitorId ?? ''}:${state.consentRevision ?? ''}:${state.consent?.visitorId ?? ''}`,
    supported: ticketDisplayPresentation(state, '').cart.supported,
    presentation: requestId => ticketDisplayPresentation(state, requestId),
  }, active && !refreshingInput, onAnswer);
}

/** The ticket and guest order surfaces share one leased presentation publisher. */
export function useStationDisplay(stationId: string | null, state: StationDisplayState, active = true,
  onAnswer?: (answer: DisplayAnswer) => void | boolean | Promise<void | boolean>) {
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
      signingOut: false, claiming: null, processing: null,
    };
    publisher.current = channel;
    signOutPublisher = channel;
    return () => {
      if (publisher.current === channel) publisher.current = null;
      if (signOutPublisher === channel) signOutPublisher = null;
      if (channel.leaseId && !channel.signingOut) void bridgeApi.release(stationId, channel.leaseId).catch(() => undefined);
    };
  }, [stationId]);

  useEffect(() => {
    const channel = publisher.current;
    if (!stationId || !active || !channel || channel.stationId !== stationId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const base = `/stations/${stationId}`;
    const paused = () => stopped || channel.signingOut || !current.current.active || publisher.current !== channel;
    /**
     * Whether any display is watching, from the platform while it answers.
     * On the box lane (offline plan OD-10) the platform cannot say, and the
     * document is published to the box anyway: it is the box's document the
     * display follows, publishing to it is local and cheap, and the till never
     * waits on a display either way.
     */
    const watching = async (): Promise<ConnectedDisplay[] | 'unknown'> => {
      if (currentLane() === 'box') return 'unknown';
      try {
        const list = await api.get<{ displays: ConnectedDisplay[] }>(`${base}/displays`);
        return list.displays.filter(display => display.connected);
      } catch (failure) {
        if (!isBoxLaneTrigger(failure)) throw failure;
        noteLaneFailure(failure);
        return 'unknown';
      }
    };
    const tick = async () => {
      if (paused()) return;
      try {
        const seen = await watching();
        if (paused()) return;
        setConnected(seen === 'unknown' ? [] : seen);
        if (seen !== 'unknown' && !seen.length) return;
        // The lease, the document and the publish go to the BOX through the
        // station bridge (offline plan Round 3): the same session manager on a
        // virtual box, and the one a Pi serves on the counter's LAN.
        let document: StationSessionDocument;
        if (!channel.leaseId) {
          const acquisition = bridgeApi.lease(stationId, channel.holder);
          channel.claiming = acquisition.then((claimed) => claimed.lease.leaseId, () => undefined);
          const claimed = await acquisition;
          channel.leaseId = claimed.lease.leaseId;
          channel.claiming = null;
          if (paused()) return;
          channel.renewedAt = Date.now();
          document = claimed.document;
          channel.lastPublished = '';
        } else if (Date.now() - channel.renewedAt >= 15_000) {
          const renewed = await bridgeApi.renew(stationId, channel.leaseId);
          if (paused()) return;
          document = renewed.document;
          channel.renewedAt = Date.now();
        } else {
          document = (await bridgeApi.session(stationId)).document;
          if (paused()) return;
        }
        const latest = current.current;
        const key = latest.state.key;
        if (key !== channel.promptKey) {
          channel.promptKey = key;
          channel.requestId = crypto.randomUUID();
        }
        const answer = latest.onAnswer ? readDisplayAnswer(document, channel.requestId) : null;
        if (answer && channel.processing?.promptKey === key) return;
        if (answer && !channel.handled.has(answer.actionId)) {
          const processing = { actionId: answer.actionId, promptKey: key };
          channel.processing = processing;
          try {
            const consumed = await latest.onAnswer?.(answer);
            if (paused()) return;
            if (consumed !== false) channel.handled.add(answer.actionId);
          } finally {
            if (channel.processing === processing) channel.processing = null;
          }
          // React applies the resulting stage/contact state before the next publish.
          return;
        }
        const payload = latest.state.presentation(channel.requestId);
        const signature = JSON.stringify(payload);
        if (signature !== channel.lastPublished) {
          await bridgeApi.publish(stationId, { type: 'session.publish_display', leaseId: channel.leaseId,
            lastSeenSequence: document.sequence, actionId: crypto.randomUUID(), payload });
          if (paused()) return;
          channel.lastPublished = signature;
        }
        setError(null);
      } catch (failure) {
        channel.claiming = null;
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
  return { connected, error, supported: state.supported };
}
