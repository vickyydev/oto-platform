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
import { bridgeApi, hasBridgeOrigin, watchBridgeSnapshots } from '@/api/bridge';
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
  /**
   * SCRUM-763 — an opaque name for this sale, new with every sale and with
   * every load of the till (never the epoch, which starts at 0 again on a
   * reload). It rides on the first screen's prompt so a paired display can
   * tell the next guest from this one coming back to the first screen.
   */
  saleKey?: string;
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
  /**
   * SCRUM-764 — moves on with every answer the till takes that may leave the
   * screen as it was. The station keeps an answer on the screen until the till
   * publishes under a new request, and the screen waits while it does, so an
   * answer that changed nothing would otherwise leave the family waiting.
   */
  answerRevision?: number;
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
      ...(state.stage === 'identify' && state.saleKey ? { saleKey: state.saleKey } : {}),
    } : null,
  };
}

/** SCRUM-763 — the till's name for the sale on a first screen's prompt, as the box bounds it. */
const SALE_KEY_MAX = 64;

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
  /** SCRUM-763 — the sale the first screen belongs to, where the till names it; absent on every later screen. */
  saleKey?: string;
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
  // An unreadable name is no name: the stage rule stands for that screen.
  const namedSale = stage === 'identify' && document.prompt?.kind === 'identify' ? document.prompt.saleKey : undefined;
  const saleKey = typeof namedSale === 'string' && namedSale.trim().length > 0 && namedSale.length <= SALE_KEY_MAX
    ? namedSale : undefined;
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
    ...(saleKey ? { saleKey } : {}),
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
/** A refused claim waits this long, doubling to the cap, unless the till itself changes. */
const CLAIM_WAIT_FIRST_MS = 1_000;
const CLAIM_WAIT_MAX_MS = 30_000;
/**
 * THE PUBLISHER'S IDENTITY ON A STATION — the `holder` the lease is taken
 * under. The browser document keeps it through a paused or remounted till, and
 * since the reload fix it keeps it through a reload too: the id is written to
 * `sessionStorage` (this tab) with a `localStorage` copy keyed by station, so
 * a refreshed page comes back as the SAME holder and its lease and the display
 * carry on, rather than as "another till" the display refuses until the old
 * lease expires. Sign-out forgets it (`takeTicketDisplayLeaseForSignOut`): the
 * next shift on this browser is a new holder. The manager's takeover path on
 * the display is untouched — it is still the way to take a station from a
 * holder that is genuinely somebody else.
 */
const HOLDER_KEY_PREFIX = 'oto.display.holder.';
const holderKey = (stationId: string): string => `${HOLDER_KEY_PREFIX}${stationId}`;
type WebStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
function holderStores(): WebStorage[] {
  const found: WebStorage[] = [];
  for (const name of ['sessionStorage', 'localStorage'] as const) {
    try {
      const store = (globalThis as unknown as Record<string, WebStorage | undefined>)[name];
      if (store) found.push(store);
    } catch {
      // Blocked site data: the holder lives for this page only.
    }
  }
  return found;
}
const holders = new Map<string,string>();
function holderFor(stationId: string): string {
  let holder = holders.get(stationId);
  if (!holder) {
    // The tab's own memory first, then the browser's, then a new identity.
    for (const store of holderStores()) {
      try {
        const kept = store.getItem(holderKey(stationId));
        if (typeof kept === 'string' && kept.length > 0) { holder = kept; break; }
      } catch {
        // Try the next store.
      }
    }
    holder ??= crypto.randomUUID();
    holders.set(stationId, holder);
    for (const store of holderStores()) {
      try { store.setItem(holderKey(stationId), holder); } catch { /* best effort */ }
    }
  }
  return holder;
}
/** Forget every station's holder, in memory and in both stores — the shift has ended. */
export function forgetDisplayHolders(): void {
  holders.clear();
  for (const store of holderStores()) {
    try {
      const keys: string[] = [];
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key && key.startsWith(HOLDER_KEY_PREFIX)) keys.push(key);
      }
      for (const key of keys) store.removeItem(key);
    } catch {
      // Nothing to forget here.
    }
  }
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
  // The shift ends: the next sign-in on this browser is a new holder.
  forgetDisplayHolders();
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
export interface StationDisplayState {
  key: string;
  supported: boolean;
  presentation: (requestId: string) => DisplayPresentation;
}
/** The cleanup belongs to this handoff only; a late cleanup cannot end its successor. */
export type StationDisplayHandoff = (state: StationDisplayState) => () => void;
const clearedHandoff: StationDisplayState = { key: 'tender:finished', supported: false,
  presentation: () => ({ stage: 'welcome', step: null, cart: null, member: null, totals: null, payment: null, prompt: null }) };

export function useTicketDisplay(stationId: string | null, state: TicketDisplayState, onAnswer: (answer: DisplayAnswer) => void | boolean | Promise<void | boolean>, active = true) {
  const refreshingInput = state.quoteRefreshing === true && (state.step === 7 || state.step === 8);
  return useStationDisplay(stationId, {
    key: `${state.sessionKey}:${state.stage}:${state.step}:${state.reviewRevision ?? 0}:${state.online === true}:${state.childReview?.visitorId ?? ''}:${state.consentRevision ?? ''}:${state.consent?.visitorId ?? ''}:${state.answerRevision ?? 0}`,
    supported: ticketDisplayPresentation(state, '').cart.supported,
    presentation: requestId => ticketDisplayPresentation(state, requestId),
  }, active, onAnswer, refreshingInput);
}

/** The ticket and guest order surfaces share one leased presentation publisher. */
export function useStationDisplay(stationId: string | null, state: StationDisplayState, active = true,
  onAnswer?: (answer: DisplayAnswer) => void | boolean | Promise<void | boolean>, basePaused = false) {
  const [temporary, setTemporary] = useState<{ stationId: string; state: StationDisplayState | null } | null>(null);
  const target = useRef(stationId);
  target.current = stationId;
  const handover: StationDisplayHandoff = useCallback((next) => {
    if (!stationId || target.current !== stationId) return () => undefined;
    const owner = { stationId, state: next };
    setTemporary(owner);
    // If the base quote is still refreshing, clear the finished QR now and
    // restore the base only when it is ready. Never leave a paid code behind it.
    return () => setTemporary(held => held === owner ? { stationId, state: null } : held);
  }, [stationId]);
  const held = temporary?.stationId === stationId ? temporary : null;
  useEffect(() => {
    if (!basePaused) setTemporary(value => value?.state === null ? null : value);
  }, [basePaused, temporary]);
  const shown = held?.state ?? (held && basePaused ? clearedHandoff : state);
  const answer = held ? undefined : onAnswer;
  const publishing = active && (!basePaused || !!held);
  const current = useRef({ state: shown, onAnswer: answer, active: publishing });
  current.current = { state: shown, onAnswer: answer, active: publishing };
  const publisher = useRef<DisplayPublisher | null>(null);
  const wake = useRef<((ownChange?: boolean) => void) | null>(null);
  const presentationSignature = JSON.stringify({ key: shown.key, presentation: shown.presentation('') });
  useEffect(() => { wake.current?.(true); }, [presentationSignature]);
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
    if (!stationId || !publishing || !channel || channel.stationId !== stationId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const base = `/stations/${stationId}`;
    const paused = () => stopped || channel.signingOut || !current.current.active || publisher.current !== channel;
    /**
     * Whether any display is watching, from the platform while it answers.
     * A local box owns its own presence list. For the virtual box lane, the platform
     * cannot say. The document is published to the box anyway: it is the box's document the
     * display follows, publishing to it is local and cheap, and the till never
     * waits on a display either way.
     */
    const watching = async (): Promise<ConnectedDisplay[] | 'unknown'> => {
      if (hasBridgeOrigin()) {
        try { return (await bridgeApi.displays(stationId)).displays.filter(display => display.connected); }
        catch (failure) {
          // Older bundles have no presence read; keep their existing publisher.
          if (failure instanceof ApiError && failure.status === 404 && failure.code === 'NOT_FOUND') return 'unknown';
          throw failure;
        }
      }
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
    let running = false;
    let queued = false;
    let queuedOwnChange = false;
    let immediate: ReturnType<typeof setTimeout> | undefined;
    let documentCache: StationSessionDocument | null = null;
    /** Snapshots taken from the stream: a reply can tell whether one overtook it on the wire. */
    let delivered = 0;
    /** A lower number arrived on the stream: it may be late, or the box may have fallen. One read settles it. */
    let askBox = false;
    let streaming = false;
    let stopStream: (() => void) | null = null;
    let seenCache: ConnectedDisplay[] | 'unknown' = [];
    let watchedAt = -Infinity;
    let claimRefusals = 0;
    let claimWaitUntil = 0;
    const adoptSnapshot = (document: StationSessionDocument) => {
      if (documentCache && document.sequence < documentCache.sequence) { askBox = true; return; }
      documentCache = document;
      delivered += 1;
    };
    /**
     * A reply nothing overtook is the box's own word, even with a lower number:
     * a store restored from an earlier copy has fallen behind what this till
     * last saw, and quoting the old number would be refused for good. That box
     * has also lost what this till told it, so the presentation goes again.
     */
    const adoptReply = (document: StationSessionDocument, deliveredBefore: number) => {
      if (documentCache && document.sequence < documentCache.sequence) {
        if (delivered !== deliveredBefore) return;
        channel.lastPublished = '';
      }
      documentCache = document;
    };
    const noteClaimFailure = (failure: unknown) => {
      // A claim that never reached the box was not refused; the usual pace stands.
      if (!(failure instanceof ApiError)) return;
      claimWaitUntil = Date.now() + Math.min(CLAIM_WAIT_MAX_MS, CLAIM_WAIT_FIRST_MS * 2 ** claimRefusals);
      claimRefusals += 1;
    };
    /** The stream carries nothing a till uses until a display is there to answer it. */
    const followStream = (wanted: boolean) => {
      if (!wanted) {
        stopStream?.();
        stopStream = null;
        streaming = false;
        return;
      }
      stopStream ??= watchBridgeSnapshots(stationId, {
        onSnapshot: document => { adoptSnapshot(document); wakeNow(); },
        onState: value => { streaming = value; },
        onFailure: () => { /* The existing tick reads while the stream recovers. */ },
      });
    };
    const wakeNow = (ownChange = false) => {
      if (paused()) return;
      if (running) {
        queued = true;
        queuedOwnChange = queuedOwnChange || ownChange;
        return;
      }
      // The till's own change asks again at once; nothing else cuts a wait short.
      if (ownChange) claimWaitUntil = 0;
      else if (Date.now() < claimWaitUntil) return;
      clearTimeout(immediate);
      immediate = setTimeout(() => { void tick(false); }, 50);
    };
    wake.current = wakeNow;
    const tick = async (refresh = true) => {
      if (paused()) return;
      if (running) { queued = true; return; }
      running = true;
      clearTimeout(timer);
      try {
        if (Date.now() - watchedAt >= POLL_MS) {
          seenCache = await watching();
          watchedAt = Date.now();
        }
        const seen = seenCache;
        if (paused()) return;
        followStream(seen === 'unknown' || seen.length > 0);
        setConnected(seen === 'unknown' ? [] : seen);
        if (seen !== 'unknown' && !seen.length) return;
        // The lease, the document and the publish go to the BOX through the
        // station bridge (offline plan Round 3): the same session manager on a
        // virtual box, and the one a Pi serves on the counter's LAN.
        let document: StationSessionDocument;
        const deliveredBefore = delivered;
        if (!channel.leaseId) {
          const acquisition = bridgeApi.lease(stationId, channel.holder);
          channel.claiming = acquisition.then((claimed) => claimed.lease.leaseId, () => undefined);
          const claimed = await acquisition.catch((failure: unknown) => { noteClaimFailure(failure); throw failure; });
          claimRefusals = 0;
          claimWaitUntil = 0;
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
        } else if (documentCache && !askBox && (!refresh || streaming)) {
          document = documentCache;
        } else {
          askBox = false;
          document = (await bridgeApi.session(stationId)).document;
          if (paused()) return;
        }
        adoptReply(document, deliveredBefore);
        document = documentCache!;
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
          const deliveredBeforePublish = delivered;
          const published = await bridgeApi.publish(stationId, { type: 'session.publish_display', leaseId: channel.leaseId,
            lastSeenSequence: document.sequence, actionId: crypto.randomUUID(), payload });
          if (paused()) return;
          adoptReply(published.document, deliveredBeforePublish);
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
        running = false;
        if (!paused()) {
          const claimWait = claimWaitUntil - Date.now();
          timer = setTimeout(() => { void tick(); }, claimWait > 0 ? claimWait
            : !streaming && (seenCache === 'unknown' || seenCache.length) ? 500 : POLL_MS);
          if (queued) {
            const ownChange = queuedOwnChange;
            queued = false;
            queuedOwnChange = false;
            wakeNow(ownChange);
          }
        }
      }
    };
    void tick();
    return () => {
      stopped = true;
      stopStream?.();
      if (wake.current === wakeNow) wake.current = null;
      clearTimeout(immediate);
      clearTimeout(timer);
    };
  }, [stationId, publishing]);
  return { connected, error, supported: shown.supported, handover };
}
