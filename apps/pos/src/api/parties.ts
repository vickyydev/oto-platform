// S2-20 E4 — THE PARTY TAB on the platform (plan
// docs/progress/plans/events-kiosk/PLAN.md §3, §8, the E4 row of §9, Q3).
//
// The prototype's party screens — PartyDetail and its balance, ticket, F&B and
// edit forms, and the mobile party screens — called the in-memory mutators
// `updateParty`, `addPartyExtraCharge` and `addPartyPayment`. They call these
// instead:
//
//   PATCH /parties/:id           an edit, written back to the OTO App
//   POST  /parties/:id/charges   extra tickets or F&B on the tab: a ledger entry
//   POST  /parties/:id/payments  money against the balance, through the tender machine
//   POST  /parties/:id/payments/tender  a QR or a card, routed by the station (SCRUM-732)
//
// and each answers with the party as it now stands, mapped here into the
// prototype's `PartyBooking` so every screen keeps its exact rendering path:
// the design, the words and `lib/party.ts`'s arithmetic are the prototype's,
// only the data source changed. Each write carries ids minted when its press is
// first sent and kept for a retry of that press, so a press that went through
// twice is one charge, one payment or one edit.

import type { ApiResponse } from '@oto/api-types';
import type {
  EventDetailAnswer,
  PartyDetailAnswer,
  PartyEditFields,
  PartyKitchenPlan,
  PartyPlan,
  PartyPlanStatus,
  PartySettleAnswer,
  PartySettleBody,
  PartySettlePreviewBody,
  PartySettleQuote,
  PartyTenderBody,
  PartyWriteAnswer,
} from '@oto/shared';
import type { PartyEditPatch } from '@/components/parties/PartyEditForm';
import type { PartyBooking, PartyPaymentMethod } from '@/types';
import { paymentMethodKind } from '@/lib/payments';
import { currentLane } from '@/lib/lane';
import { apiBranchIdForSlug } from './catalogBridge';
import { api, ApiError, NetworkError } from './client';
import { EVENTS_NOT_LINKED, toOtoEvent } from './events';
import type { PaymentStartResult } from './payments';
import { salesApi } from './sales';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const satang = (baht: number): number => Math.round(baht * 100);

export const partiesApi = {
  get: (branchId: string, partyId: string) =>
    api.get<EventDetailAnswer>(`/parties/${encodeURIComponent(partyId)}?branchId=${branchId}`),
  update: (partyId: string, body: Record<string, unknown> & { editId: string }) =>
    api.patch<PartyWriteAnswer>(`/parties/${encodeURIComponent(partyId)}`, body, {
      idempotencyKey: `party-edit:${body.editId}`,
    }),
  charge: (partyId: string, body: Record<string, unknown> & { chargeId: string; actionId: string }) =>
    api.post<PartyWriteAnswer>(`/parties/${encodeURIComponent(partyId)}/charges`, body, {
      idempotencyKey: `party-charge:${body.chargeId}`,
      headers: { 'x-oto-action-id': body.actionId },
    }),
  pay: (partyId: string, body: Record<string, unknown> & { paymentId: string; actionId: string }) =>
    api.post<PartyWriteAnswer>(`/parties/${encodeURIComponent(partyId)}/payments`, body, {
      idempotencyKey: `party-payment:${body.paymentId}`,
      headers: { 'x-oto-action-id': body.actionId },
    }),
  /** SCRUM-804 — the party with the plan the OTO App published for it. */
  detail: (branchId: string, partyId: string) =>
    api.get<ApiResponse<'/parties/{id}', 'get'>>(`/parties/${encodeURIComponent(partyId)}?branchId=${branchId}`),
  /** SCRUM-804 — what settling it would come to, priced by the platform; writes nothing. */
  settlePreview: (partyId: string, body: PartySettlePreviewBody) =>
    api.post<ApiResponse<'/parties/{id}/settle/preview', 'post'>>(`/parties/${encodeURIComponent(partyId)}/settle/preview`, body),
  /** SCRUM-804 — settle it as one sale, under the ids of one press of Confirm. */
  settle: (partyId: string, body: PartySettleBody & { actionId: string }) =>
    api.post<ApiResponse<'/parties/{id}/settle', 'post'>>(`/parties/${encodeURIComponent(partyId)}/settle`, body, {
      idempotencyKey: `party-settle:${body.settlementId}`,
      headers: { 'x-oto-action-id': body.actionId },
    }),
  /** SCRUM-732 — a QR or a card against the balance, routed by the station. */
  startTender: (partyId: string, body: PartyTenderBody) =>
    api.post<ApiResponse<'/parties/{id}/payments/tender', 'post'>>(`/parties/${encodeURIComponent(partyId)}/payments/tender`, body, {
      idempotencyKey: `party-tender:${body.paymentId}`,
      ...(body.actionId ? { headers: { 'x-oto-action-id': body.actionId } } : {}),
    }),
};

/**
 * WHAT STOPS A PARTY WRITE BEFORE ITS FORM OPENS: everything the till can know
 * before anybody is shown a bill or asked for money, so a refusal never arrives
 * after the guest was thanked for a payment nothing recorded.
 */
export function partyWriteBlocker(ctx: {
  branchSlug: string;
  /** The platform station a payment is taken at; only a payment needs one. */
  stationId?: string | null;
  needsStation?: boolean;
  online?: boolean;
}): { title: string; description: string } | null {
  if (!apiBranchIdForSlug(ctx.branchSlug)) {
    return { title: 'Not linked to the platform', description: EVENTS_NOT_LINKED };
  }
  const online = ctx.online ?? globalThis.navigator?.onLine !== false;
  if (!online || currentLane() === 'box') {
    return {
      title: 'No connection',
      description: "The party's tab is kept on the platform. Try again when this till is back online.",
    };
  }
  if (ctx.needsStation && !(ctx.stationId && UUID.test(ctx.stationId))) {
    return {
      title: 'Not a till',
      description: 'This device is not set up as a till on the platform, so it cannot take a payment.',
    };
  }
  return null;
}

export type PartyWriteOutcome =
  | { ok: true; party: PartyBooking; answer: PartyWriteAnswer }
  | {
      ok: false;
      message: string;
      /**
       * Nothing answered, or the platform faulted: the same ids may be sent
       * again, and are a replay if the first one landed. A definite refusal is
       * not: the next press asks afresh, under new ids.
       */
      retryable: boolean;
    };

function failureOf(err: unknown): { ok: false; message: string; retryable: boolean } {
  const retryable =
    err instanceof NetworkError ||
    !(err instanceof ApiError) ||
    err.status >= 500 ||
    err.code === 'IDEMPOTENCY_IN_FLIGHT';
  const message =
    err instanceof ApiError || err instanceof NetworkError ? err.message : err instanceof Error ? err.message : String(err);
  return { ok: false, message, retryable };
}

/** The party as the answer has it, in the prototype's shape under the till's branch slug. */
const partyOf = (answer: PartyWriteAnswer, branchSlug: string): PartyBooking =>
  toOtoEvent(answer.party, branchSlug) as unknown as PartyBooking;

/** The ids one press is made under: minted when its form opens, kept for every retry of it. */
export interface PartyWriteIds {
  id: string;
  actionId: string;
}

/** One line of a charge as the till's order lists it, in baht. */
export interface PartyChargeLine {
  name: string;
  qty: number;
  lineTotal: number;
}

/**
 * A REQUEST NOTHING ANSWERED MAY HAVE LANDED, so the till never says it did
 * not: it says the write is not confirmed and asks for the same press again,
 * which is sent as the same request under the same ids — the stored answer if
 * the first one landed. A definite no keeps the prototype's words.
 */
export const PARTY_CHARGE_NOT_CONFIRMED = {
  title: 'Charge not confirmed',
  description:
    "The platform has not confirmed it, so it may already be on the party's tab. The order is held as it was sent: press charge again — it is never charged twice.",
  variant: 'destructive' as const,
};
export const PARTY_PAYMENT_NOT_CONFIRMED = {
  title: 'Payment not confirmed',
  description:
    'The platform has not confirmed it, so it may already be recorded. Press Payment received again — it is never taken twice.',
  variant: 'destructive' as const,
};
/** A press on an order held for its answer that would change or leave it. */
export const PARTY_CHARGE_HELD = {
  title: 'Order held',
  description: 'This order is not confirmed yet. Press charge again to confirm it before changing or leaving it.',
};

/**
 * What came of a charge to a party's tab (the iPad's F&B and ticket modals,
 * the phone's F&B screen) — the payment's rule, for an order:
 *
 *   - charged: the order is on the tab, and the screen closes;
 *   - not charged and `held`: nothing answered, so it may be on the tab
 *     already. The screen holds the order exactly as it was sent — nothing
 *     added, changed, cleared or left — and its only press sends that order
 *     again, which is the same request under the same ids, until a definite
 *     answer comes;
 *   - not charged, not held: a definite no (or, before anything was sent, an
 *     order that was not held). The order is the till's again, to change or
 *     drop.
 *
 * The screen holds the order from the press itself, not only from an answer
 * that never came: while the request is on its way the order on screen is the
 * order sent, and nothing changes or leaves it (`usePartyChargeHold`).
 */
export type PartyChargeConfirmation = { charged: true } | { charged: false; held: boolean };

/** One press of a charge, told apart from another: the party, the kind, the order's lines and total. */
export const partyChargePress = (partyId: string, kind: 'ticket' | 'fnb', items: PartyChargeLine[], total: number): string =>
  JSON.stringify([partyId, kind, items.map((it) => [it.name, it.qty, satang(it.lineTotal)]), satang(total)]);

/** A charge's outcome as its screen acts on it. */
export function partyChargeConfirmationOf(outcome: PartyWriteOutcome): PartyChargeConfirmation {
  return outcome.ok ? { charged: true } : { charged: false, held: outcome.retryable };
}

/** `addPartyExtraCharge`, on the platform: the till's items and total, in satang. */
export async function chargePartyOnPlatform(args: {
  party: PartyBooking;
  kind: 'ticket' | 'fnb';
  items: PartyChargeLine[];
  total: number;
  stationId?: string | null;
  ids: PartyWriteIds;
}): Promise<PartyWriteOutcome> {
  const branchId = apiBranchIdForSlug(args.party.branchId);
  if (!branchId) return { ok: false, message: EVENTS_NOT_LINKED, retryable: false };
  try {
    const answer = await partiesApi.charge(args.party.id, {
      branchId,
      chargeId: args.ids.id,
      actionId: args.ids.actionId,
      kind: args.kind,
      items: args.items.map((it) => ({
        name: it.name.trim() || 'Item',
        qty: Math.max(0, Math.round(it.qty)),
        lineTotalSatang: Math.max(0, satang(it.lineTotal)),
      })),
      totalSatang: satang(args.total),
      ...(args.stationId && UUID.test(args.stationId) ? { stationId: args.stationId } : {}),
    });
    return { ok: true, party: partyOf(answer, args.party.branchId), answer };
  } catch (err) {
    return failureOf(err);
  }
}

/**
 * `addPartyPayment`, on the platform: the amount staff collected, the tender
 * they chose, and the balance the till showed — so a balance that moved under
 * the till is refused with nothing taken, rather than recorded short.
 */
export async function payPartyOnPlatform(args: {
  party: PartyBooking;
  amount: number;
  method: PartyPaymentMethod;
  /**
   * The outstanding balance the till showed when staff fixed the amount to
   * collect, in baht — frozen with the amount, never re-read under the collect
   * step, so every retry of one press is the same request.
   */
  outstanding: number;
  stationId: string;
  ids: PartyWriteIds;
  /** A card taken on a terminal the platform cannot reach: what its slip says. */
  slip?: PartySlip;
}): Promise<PartyWriteOutcome> {
  const branchId = apiBranchIdForSlug(args.party.branchId);
  if (!branchId) return { ok: false, message: EVENTS_NOT_LINKED, retryable: false };
  try {
    const answer = await partiesApi.pay(args.party.id, {
      branchId,
      stationId: args.stationId,
      paymentId: args.ids.id,
      actionId: args.ids.actionId,
      amountSatang: satang(args.amount),
      tender: { method: args.method, kind: paymentMethodKind(args.method), ...args.slip },
      expectedOutstandingSatang: satang(args.outstanding),
    });
    return { ok: true, party: partyOf(answer, args.party.branchId), answer };
  } catch (err) {
    return failureOf(err);
  }
}

/** What staff are told while a routed tender does the collecting. */
export const PARTY_TENDER_HINT = {
  card: 'The card terminal takes the payment. It is recorded when the terminal answers.',
  qr: 'The customer scans the QR on their display. The payment is recorded when it is confirmed.',
} as const;

/** The approval code and TID read off a card terminal's own slip. */
export interface PartySlip {
  approvalCode: string;
  tid: string;
}

/** What one party press was handed by its payment screen once a routed tender has answered. */
export interface PartyTenderPress {
  ids: PartyWriteIds;
  slip?: PartySlip;
}

export type PartyTenderOutcome =
  | { ok: true; answer: PaymentStartResult }
  | { ok: false; message: string; retryable: boolean; code?: string; details?: unknown };

/**
 * SCRUM-732 — a QR or a card against the party's balance. The amount, the tender
 * and the balance shown are frozen as "Payment received" freezes them, and this
 * records nothing: the money counts once the attempt it answers with is paid.
 */
export async function startPartyTenderOnPlatform(args: {
  party: PartyBooking;
  amount: number;
  method: PartyPaymentMethod;
  outstanding: number;
  stationId: string | null | undefined;
  ids: PartyWriteIds;
}): Promise<PartyTenderOutcome> {
  const branchId = apiBranchIdForSlug(args.party.branchId);
  if (!branchId) return { ok: false, message: EVENTS_NOT_LINKED, retryable: false };
  if (!args.stationId || !UUID.test(args.stationId)) {
    return { ok: false, message: 'This device is not set up as a till on the platform, so it cannot take a payment.', retryable: false };
  }
  const kind = paymentMethodKind(args.method);
  try {
    const answer = await partiesApi.startTender(args.party.id, {
      branchId,
      stationId: args.stationId,
      paymentId: args.ids.id,
      actionId: args.ids.actionId,
      amountSatang: satang(args.amount),
      tender: { method: args.method, kind },
      expectedOutstandingSatang: satang(args.outstanding),
      ...(kind === 'qr' ? { requestQrPayload: true, qrDirection: 'show' as const } : {}),
    });
    return { ok: true, answer };
  } catch (err) {
    const failure = failureOf(err);
    return err instanceof ApiError ? { ...failure, code: err.code, details: err.details } : failure;
  }
}

/**
 * The tender a 409 PAYMENT_IN_FLIGHT names that this till may bring back on screen
 * and finish. One waiting for a person, from any counter: nothing but a person
 * closes it, and the counter that opened it may be gone. Otherwise the one tender
 * opened at this counter; another counter's is that counter's, as a colleague's
 * unpaid sale is theirs.
 */
export function inFlightTenderOf(
  details: unknown,
  stationId: string | null | undefined,
): { attemptId: string; paymentId: string } | null {
  const waiting = (details as { waiting?: unknown } | null | undefined)?.waiting;
  if (!Array.isArray(waiting)) return null;
  const tenders = waiting as { attemptId?: unknown; paymentId?: unknown; stationId?: unknown; status?: unknown }[];
  const chosen =
    tenders.find((t) => t.status === 'awaiting_staff_confirmation') ??
    (tenders.length === 1 && tenders[0]?.stationId === stationId ? tenders[0] : undefined);
  if (typeof chosen?.attemptId !== 'string' || typeof chosen.paymentId !== 'string') return null;
  return { attemptId: chosen.attemptId, paymentId: chosen.paymentId };
}

/**
 * What came of "Payment received" on a party's payment screen (the iPad's
 * balance modal, the phone's payment screen):
 *
 *   - recorded, with the money the platform recorded, in baht — what staff are
 *     told was collected and what the guest is thanked for, which is the
 *     collected amount floored to whole baht and capped at the balance;
 *   - not recorded and nothing answered (`retry`): the screen stays on the
 *     collect step, and the next press is the same request under the same ids
 *     — the stored answer if the first one landed;
 *   - not recorded, a definite no: the screen goes back to the bill as it now
 *     reads, and staff choose again.
 */
export type PartyPaymentConfirmation = { recorded: true; amount: number } | { recorded: false; retry: boolean };

/** One press of "Payment received", told apart from another: its amount, tender and the balance shown. */
export const partyPaymentPress = (amount: number, method: PartyPaymentMethod, shownOutstanding: number): string =>
  JSON.stringify([satang(amount), method, satang(shownOutstanding)]);

/** A payment's outcome as its screen acts on it; `asked` stands in only if an answer names no payment. */
export function partyPaymentConfirmationOf(outcome: PartyWriteOutcome, asked: number): PartyPaymentConfirmation {
  if (!outcome.ok) return { recorded: false, retry: outcome.retryable };
  const recorded = outcome.answer.payment?.amountSatang;
  return { recorded: true, amount: recorded === undefined ? asked : recorded / 100 };
}

// --- Edits ---------------------------------------------------------------------

/** "Nothing", however the form says it: absent, null or blank. */
const none = (v: unknown): unknown => (v === undefined || v === null || (typeof v === 'string' && v.trim() === '') ? null : v);
const same = (a: unknown, b: unknown) => JSON.stringify(none(a)) === JSON.stringify(none(b));

/**
 * The edit form's fields the OTO App does not hold yet, by what the form calls
 * them: changing one is not saved from the till, and the till says so.
 */
const KEPT_IN_OTO_APP: Array<[keyof PartyEditPatch, string]> = [
  ['kidDob', 'date of birth'],
  ['partyHost', 'party host'],
  ['entertainmentHost', 'entertainment host'],
  ['packageName', 'package name'],
  ['lineItems', 'line items'],
  ['posNotes', 'POS notes'],
  ['finalMessage', 'staff note'],
  ['kitchen', 'kitchen plan'],
  ['bar', 'bar plan'],
  ['timeline', 'run of show'],
];

/**
 * `updateParty`'s patch as the platform takes it: only what changed, in the
 * platform's words, and the names of what changed that the platform does not
 * write. The protected fields (id, branch, the ledgers) are never in it.
 */
export function partyEditOf(
  original: PartyBooking,
  patch: PartyEditPatch,
): { fields: PartyEditFields; keptInOtoApp: string[] } {
  const fields: Record<string, unknown> = {};
  const text = (v: string | undefined | null) => (v && v.trim() ? v.trim() : null);
  const put = (key: keyof PartyEditFields, before: unknown, after: unknown, value: unknown = after) => {
    if (!same(before, after)) fields[key] = value;
  };
  put('title', original.title, patch.title, patch.title.trim());
  put('status', original.status, patch.status);
  put('date', original.date, patch.date);
  put('startTime', original.startTime, patch.startTime);
  put('endTime', original.endTime, patch.endTime, text(patch.endTime));
  put('location', original.location, patch.location, text(patch.location));
  put('expectedKids', original.expectedKids, patch.expectedKids);
  put('expectedAdults', original.expectedAdults, patch.expectedAdults);
  put('childName', original.childName, patch.childName, text(patch.childName));
  put('kidAge', original.kidAge, patch.kidAge, patch.kidAge ?? null);
  put('parentName', original.parentName, patch.parentName, text(patch.parentName));
  put('whatsapp', original.whatsapp, patch.whatsapp, text(patch.whatsapp));
  put('decoration', original.decoration, patch.decoration, text(patch.decoration));
  put('activities', original.activities, patch.activities, text(patch.activities));
  put('basePriceSatang', original.basePrice, patch.basePrice, satang(patch.basePrice));
  put('depositSatang', original.deposit, patch.deposit, satang(patch.deposit));
  put('depositDate', original.depositDate, patch.depositDate, text(patch.depositDate));
  const keptInOtoApp = KEPT_IN_OTO_APP.filter(([key]) => !same(original[key], patch[key])).map(([, label]) => label);
  return { fields: fields as PartyEditFields, keptInOtoApp };
}

/** `updateParty`, on the platform: the changed fields under the edit's id. */
export async function updatePartyOnPlatform(args: {
  party: PartyBooking;
  fields: PartyEditFields;
  stationId?: string | null;
  ids: PartyWriteIds;
}): Promise<PartyWriteOutcome> {
  const branchId = apiBranchIdForSlug(args.party.branchId);
  if (!branchId) return { ok: false, message: EVENTS_NOT_LINKED, retryable: false };
  try {
    const answer = await partiesApi.update(args.party.id, {
      branchId,
      editId: args.ids.id,
      actionId: args.ids.actionId,
      ...(args.stationId && UUID.test(args.stationId) ? { stationId: args.stationId } : {}),
      ...args.fields,
    });
    return { ok: true, party: partyOf(answer, args.party.branchId), answer };
  } catch (err) {
    return failureOf(err);
  }
}

// --- SCRUM-804: the party's plan, and settling it as one sale --------------------

/** The plan the OTO App published for a party, and why there is none. */
export interface PartyPlanRead {
  plan: PartyPlan | null;
  status: PartyPlanStatus;
  /**
   * SCRUM-906 — the party's whole kitchen plan, with or without a package:
   * every line, the cake, the bar. Absent from a platform that predates it.
   */
  kitchenPlan?: PartyKitchenPlan | null;
}

/**
 * `GET /parties/:id`'s plan: the package with its limits and prices, the
 * counts, the add-ons, the entertainment, the set menu and the food times — or
 * none, and why. Null when it could not be read at all (offline, not linked):
 * the party page then shows what it showed before.
 */
export async function readPartyPlanOnPlatform(party: Pick<PartyBooking, 'id' | 'branchId'>): Promise<PartyPlanRead | null> {
  const branchId = apiBranchIdForSlug(party.branchId);
  if (!branchId) return null;
  try {
    const answer = (await partiesApi.detail(branchId, party.id)) as Partial<PartyDetailAnswer> | undefined;
    if (!answer || typeof answer !== 'object' || !('planStatus' in answer) || !answer.planStatus) return null;
    return {
      plan: answer.plan ?? null,
      status: answer.planStatus,
      ...(answer.kitchenPlan !== undefined ? { kitchenPlan: answer.kitchenPlan } : {}),
    };
  } catch {
    return null;
  }
}

export type PartyCancelSettlementOutcome =
  | { ok: true; party: PartyBooking | null }
  | { ok: false; message: string };

/**
 * SCRUM-913 — "Cancel settlement" on a settlement that took money at the
 * till: the platform refuses the void (`SALE_HAS_PAYMENT`, money taken is
 * refunded, never voided), and its words name no way out. The party page
 * names it: a manager's refund of the money taken, from History, which
 * closes the settlement so the party can be settled again.
 */
export function cancelSettlementTakenRefusal(takenSatang: number | null): string {
  const taken =
    takenSatang !== null && takenSatang > 0
      ? `฿${(takenSatang / 100).toLocaleString('en-US', { minimumFractionDigits: takenSatang % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })} was already taken`
      : 'Money was already taken';
  return `${taken} on this settlement, so it can't be cancelled here. Have a manager refund it from History first: the refund closes the settlement. Nothing was changed.`;
}

/**
 * SCRUM-876 — "CANCEL SETTLEMENT" ON THE PARTY PAGE. A settlement left at its
 * balance step is an open sale with only the party's deposit on it. It is
 * voided on the platform through the ordinary void of an unpaid sale: the
 * deposit's record goes with the sale and the deposit stays the party's,
 * nothing is refunded, and the party may be settled again. The party is read
 * back afterwards so the page shows the settlement released; a read that
 * fails after a void that went through still answers ok, with no party, and
 * the host's own re-read brings the released party back.
 */
export async function cancelSettlementOnPlatform(args: {
  party: Pick<PartyBooking, 'id' | 'branchId'>;
  saleId: string;
  reason: string;
}): Promise<PartyCancelSettlementOutcome> {
  const branchId = apiBranchIdForSlug(args.party.branchId);
  if (!branchId) return { ok: false, message: EVENTS_NOT_LINKED };
  try {
    await salesApi.voidSale(args.saleId, args.reason);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'SALE_HAS_PAYMENT') {
      const taken = (err.details as { takenSatang?: unknown } | undefined)?.takenSatang;
      return { ok: false, message: cancelSettlementTakenRefusal(typeof taken === 'number' ? taken : null) };
    }
    return { ok: false, message: failureOf(err).message };
  }
  try {
    const answer = (await partiesApi.detail(branchId, args.party.id)) as PartyDetailAnswer;
    return { ok: true, party: toOtoEvent(answer.event, args.party.branchId) as unknown as PartyBooking };
  } catch {
    return { ok: true, party: null };
  }
}

/** What staff confirmed on the Settle form. */
export interface PartySettleForm {
  kids: number;
  adults: number;
  socksGiven: number;
  addOnIds: string[];
  entertainmentIds: string[];
}

export type PartySettlePreviewOutcome = { ok: true; quote: PartySettleQuote } | { ok: false; message: string; code?: string };

/** The settlement's figures as the platform prices them — never the till's own arithmetic. */
export async function previewSettlementOnPlatform(args: {
  party: Pick<PartyBooking, 'id' | 'branchId'>;
  form: PartySettleForm;
  stationId?: string | null;
}): Promise<PartySettlePreviewOutcome> {
  const branchId = apiBranchIdForSlug(args.party.branchId);
  if (!branchId) return { ok: false, message: EVENTS_NOT_LINKED };
  try {
    const answer = await partiesApi.settlePreview(args.party.id, {
      branchId,
      ...(args.stationId && UUID.test(args.stationId) ? { stationId: args.stationId } : {}),
      ...args.form,
    });
    return { ok: true, quote: answer.quote };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      ...(err instanceof ApiError ? { code: err.code } : {}),
    };
  }
}

/** The ids one press of Confirm is made under: kept for its retries, new for another press. */
export interface PartySettleIds {
  settlementId: string;
  saleId: string;
  actionId: string;
}

export type PartySettleOutcome =
  | { ok: true; answer: PartySettleAnswer }
  | { ok: false; message: string; retryable: boolean; code?: string; details?: unknown };

/** `POST /parties/:id/settle`: the party rung up as one sale, the deposit on it, the balance to take. */
export async function settlePartyOnPlatform(args: {
  party: Pick<PartyBooking, 'id' | 'branchId'>;
  form: PartySettleForm;
  stationId: string;
  expectedTotalSatang: number;
  ids: PartySettleIds;
}): Promise<PartySettleOutcome> {
  const branchId = apiBranchIdForSlug(args.party.branchId);
  if (!branchId) return { ok: false, message: EVENTS_NOT_LINKED, retryable: false };
  try {
    const answer = await partiesApi.settle(args.party.id, {
      branchId,
      stationId: args.stationId,
      settlementId: args.ids.settlementId,
      saleId: args.ids.saleId,
      actionId: args.ids.actionId,
      expectedTotalSatang: args.expectedTotalSatang,
      ...args.form,
    });
    return { ok: true, answer };
  } catch (err) {
    const failure = failureOf(err);
    return err instanceof ApiError ? { ...failure, code: err.code, details: err.details } : failure;
  }
}
