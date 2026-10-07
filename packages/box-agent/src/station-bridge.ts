import { createHash, randomBytes } from 'node:crypto';
import {
  BAND_FOOD_REFUSALS,
  BOOKING_REDEEMED_FACT,
  BOX_BOOKING_REFUSALS,
  BOOKING_EVENT_PASSES_NEED_INTERNET,
  BOOKING_EVENT_PASSES_ONLINE_ONLY,
  BOX_CATALOGUE_TOO_OLD,
  BOX_LANE_PAYMENT_REFUSAL,
  BOX_LANE_REFUSALS,
  BOX_SESSION_PREFIX,
  BRIDGE_BOOKING_INTENTS,
  BRIDGE_CART_QUOTE_INTENT,
  BridgeBookingLookupSchema,
  BridgeBookingRedeemSchema,
  PAID_ONLINE_TENDER_CODE,
  PAID_ONLINE_TENDER_METHOD,
  isoDateInTz,
  parseBookingQr,
  verifyBookingQr,
  wallClockMinutesInTz,
  type BridgeBookingRedeem,
  type BridgeBookingRedeemAnswer,
  type BridgeBookingView,
  type OfflineBookingRedeemed,
  BOX_WALLET_REFUSALS,
  BOX_STOCK_REFUSALS,
  STOCK_SNAPSHOT_REFUSE_AFTER_S,
  type StockFiledMark,
  type StockSnapshotItem,
  BRIDGE_WALLET_INTENTS,
  BridgeWalletLookupSchema,
  BridgeWalletSpendSchema,
  WALLET_SNAPSHOT_REFUSE_AFTER_S,
  WALLET_SPENT_FACT,
  WALLET_TENDER_CODE,
  WALLET_TENDER_METHOD,
  formatTHB,
  walletOfflineCapMessage,
  type BridgeTender,
  type BridgeWalletBalance,
  type BridgeWalletSpend,
  type BridgeWalletSpendAnswer,
  type BridgeWalletSpendView,
  type OfflineWalletSpent,
  type WalletSnapshotEntry,
  type WalletSnapshotItem,
  BRIDGE_MONEY_INTENT_PREFIXES,
  BRIDGE_RECEIPT_OBSERVED_INTENT,
  BRIDGE_RECORD_INTENTS,
  BRIDGE_SALE_INTENTS,
  BridgePaymentConfirmSchema,
  BridgePaymentInquireSchema,
  BridgePaymentStartSchema,
  BridgeReceiptObservedSchema,
  BridgeSaleFinaliseSchema,
  BridgeSaleReprintSchema,
  OFFLINE_POLICY,
  OfflineChildCreatedSchema,
  OfflineChildUpdatedSchema,
  OfflineMemberCreatedSchema,
  OfflineMemberTierChangedSchema,
  TIER_PROOF_TYPES,
  OfflineMemberUpdatedSchema,
  OfflineVisitCreatedSchema,
  bandShortCode,
  bridgeCartOf,
  childPhotosEnabled,
  BENEFIT_CREDENTIAL_REFUSALS,
  businessDate,
  catalogueState,
  normalizePhone,
  parseDayStart,
  planLedgerBands,
  type BoxLaneRefusal,
  type BridgeCart,
  type BridgeChild,
  type BridgeMember,
  type BridgePaymentStart,
  type BridgeRecordIntent,
  type BridgeSaleAnswer,
  type BridgeSaleBand,
  type BridgeSaleFinalise,
  type BridgeSaleView,
  type BridgeStatus,
  type BridgeUnlockMethod,
  type BridgeUnlockRequest,
  type BridgeUnlockResponse,
  type OfflinePolicy,
  type PaymentAttemptStatus,
  type PaymentAttemptView,
  type PaymentMethod,
  type PaymentProvider,
  type SalePrintSnapshot,
} from '@oto/shared';
import type {
  StationChannelMessage,
  StationIntent,
  StationSessionDocument,
  StationView,
} from './contract';
import {
  OfflinePriceError,
  offlineLedgerLines,
  priceOfflineSale,
  readOfflineCatalogue,
  type OfflineCatalogue,
  type OfflineItemLine,
  type OfflineLedgerLine,
  type OfflineQuote,
  type OfflineSalePricing,
} from './offline-pricing';
import type { OfflineReceiptFact, OfflineTenderFact } from './outbox';
import {
  OfflineSaleRefused,
  ReceiptSeriesUnavailable,
  ReprintRefused,
  type OfflineBandPlan,
  type OfflineSaleAnswer,
  type OfflineSaleRequest,
  type RecordedSale,
  type SaleQueue,
} from './sale-queue';
import {
  WALLET_SPEND_COUNTER_SCOPE,
  WALLET_SPEND_TOTAL_DAY,
  WALLET_SPEND_TOTAL_SCOPE,
  decideOfflineSpend,
  findSnapshotWallet,
  offlineWalletAllowance,
  readWalletSnapshot,
  type OfflineAllowance,
  type OfflineSpendRefusal,
} from './wallet-lane';
import {
  PROTOTYPE_SOCKS_ADD_ON_ID,
  STOCK_TAKEN_TOTAL_DAY,
  STOCK_TAKEN_TOTAL_SCOPE,
  planStock,
  readStockShares,
  readStockSnapshot,
  shareReflected,
  stockAsksOf,
  stockAvailable,
  stockOpenKey,
  stockShortages,
  stockShortRefusal,
  stockSizeRefusal,
  unreflectedUnits,
  type StockShortage,
} from './stock-lane';
import { uuidv7 } from './signing';
import {
  checkBenefitOnBox,
  readBenefitScope,
  type BenefitOnBox,
} from './benefit-credential';
import type { TerminalCommandOutcome, TerminalController, TerminalProtocol } from './terminal/index';
import { boxBlobs, type BlobStore } from './blob-store';
import { CheckinDesk, DeskRefusal, type BoxFoodOrder, type DeferredBand } from './checkin-desk';
import { EventsDesk, EventsDeskRefusal } from './events-desk';
import type { StationSessionManager } from './station-session';
import {
  OFFLINE_UNLOCK_REFUSALS,
  OfflineAuth,
  memoryThrottle,
  type OfflineStaffRecord,
  type OfflineThrottle,
  type StaffDenyList,
  type StaffSigningKey,
} from './staff-token';
import type {
  BoxOverlayKind,
  BoxStore,
  CachedBundle,
  EnvelopeSealer,
  OutboxRecord,
  OverlayRecord,
  OverlayWrite,
  QueuedFact,
} from './store';
import { sqliteWriterBusy } from './store-sqlite';
import { silentLog, type AgentLog } from './transport';

/**
 * THE STATION BRIDGE — how a till and a customer display reach their box
 * (offline plan §2.2, Round 3; SCRUM-269).
 *
 * One contract, `/box/v1/station/:stationId/*` (`@oto/shared` `station-bridge`),
 * written here once over the `StationSessionManager` that already runs every
 * station document, and mounted twice:
 *
 *   - by the api, for a VIRTUAL box (staging, CI). The platform session is the
 *     credential there (OD-2), the saved station is the standing, and the mount
 *     sits outside the `stationTrading` guard on purpose: it is the box's
 *     surface, so it keeps working with the offline toggle on, as a Pi would;
 *   - by the agent on a Raspberry Pi, on loopback, published on the counter's
 *     LAN by Caddy (`runner/bridge-server.ts`, `scripts/pi/Caddyfile`). The
 *     credential there is a BOX SESSION this file issues at unlock.
 *
 * What the bridge adds to the session manager is the counter's half of working
 * with no internet:
 *
 *   - UNLOCK (OD-2, OD-6). The staff token and the password are checked against
 *     the box's own copy of the staff list and the deny-list (`OfflineAuth`).
 *     A fresh sign-in with no live token is admitted for somebody this box has
 *     seen in thirty days, and only while it holds a deny-list pulled in the
 *     last 72 hours, so a dismissal still reaches the counter. Facts made under
 *     such a session carry `offlineFresh`.
 *   - READS from the box's cache: a member by phone, with the offline overlay
 *     laid over it, and a priced cart (`offline-pricing.ts`).
 *   - THE PRODUCERS: member, child, visit and tier-change facts, each written
 *     to the outbox and to the overlay in ONE store transaction, under the ids
 *     the till minted (OD-12), with the alias rule applied (OD-7).
 *
 *   - SELLING (Round 4, plan §2.4): `sale.finalise` takes cash or a ฿0 comp,
 *     `payment.*` drives the counter's own terminal — a card, the PAX QR
 *     flagged `awaiting_settlement`, a GHL card with no answer confirmed by
 *     staff with the typed approval code (OD-3) — and each closing is
 *     `SaleQueue.record`: one store transaction for the receipt number, the
 *     bands, the paper and the fact, then the drawer, then the printer. The
 *     cart is priced again here, and a total the till saw differently is
 *     refused before anything is numbered. What the capability list refuses
 *     offline is refused in its own reasons (`BOX_LANE_REFUSALS`).
 */

// --- Errors ----------------------------------------------------------------------

/** A refusal the mounts turn into `{ error: { code, message, details } }` with this status. */
export class BridgeError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** The session manager's refusals, as the api's `/stations/:id/*` routes already answer them. */
function refusalError(refusal: string, message: string, document: unknown): BridgeError {
  const status = refusal === 'not_permitted' ? 403 : refusal === 'unknown_intent' ? 400 : 409;
  return new BridgeError(status, `STATION_${refusal.toUpperCase()}`, message, { document });
}

// --- Who is calling --------------------------------------------------------------

/** A till standing at the station, with what it may do. */
export interface BridgeTillCaller {
  kind: 'till';
  accountId: string;
  /** Whether this account holds a permission at this station's branch. */
  can(permission: string): boolean;
  method: BridgeUnlockMethod;
  /** A fresh offline sign-in with no live token (OD-6): its facts are marked. */
  offlineFresh: boolean;
  jti: string | null;
}

/** A paired customer display, which may read the redacted document and answer its own prompts. */
export interface BridgeDisplayCaller {
  kind: 'display';
  credentialId: string;
}

export type BridgeCaller = BridgeTillCaller | BridgeDisplayCaller;

// --- What the bridge needs from its host ---------------------------------------------

/** A station on this box, as the config bundle (Pi) or the station row (api) says. */
export interface BridgeStation {
  id: string;
  name: string;
  kind: string;
  branchId: string;
  operatorId: string;
}

export interface BridgeBranch {
  id: string;
  operatorId: string;
  timezone: string;
  businessDayStart: string;
}

export interface BridgeHost {
  boxId: string;
  store: BoxStore;
  sessions: StationSessionManager;
  station(stationId: string): BridgeStation | null;
  branch(): BridgeBranch | null;
  /** The PUBLIC staff-token keys: the config bundle's on a Pi, `core.signing_key` in the api. */
  signingKeys(): Promise<readonly StaffSigningKey[]> | readonly StaffSigningKey[];
  /** The box's link: the agent's `linkUp` and the Console's switch. */
  link(): { up: boolean; offline: boolean };
  /**
   * Seals facts with the box's signing key, or null when this process does
   * not hold it — an api instance the virtual box's agent is not running on.
   * The record intents refuse by name rather than queue an unsigned fact.
   */
  sealer(): EnvelopeSealer | null;
  /** argon2id verification, injected: this package carries no native dependency. */
  verifyPassword(hash: string, password: string): Promise<boolean>;
  now(): Date;
  log?: AgentLog;
  /**
   * Where wrong passwords are counted. The api passes the platform's own
   * buckets, so five wrong guesses lock whichever door they were made at; a Pi
   * gets the store's `box_throttle`, which a restart does not clear.
   */
  throttle?: OfflineThrottle;
  /**
   * The box's sale queue (Round 4): the one transaction a sale taken here is
   * written in. Null where this process cannot write for the box — an api
   * instance the virtual box's agent is not running on — and a money intent
   * is then refused politely rather than taken with nowhere to put it.
   */
  sales?(): SaleQueue | null;
  /** The box's card terminals (Round 4), or null on a box built without them. */
  terminals?(): TerminalController | null;
  /**
   * The park key (S2-12 round 5), for a booking QR a till's own scanner read
   * and typed into the redeem field. A QR read at the box's scanner is checked
   * by the scan router and arrives as a booking id; without this a typed QR is
   * refused with "type the booking reference instead".
   */
  bandKey?(): string | Uint8Array | null;
  /**
   * S2-13 round 4 — the box's bounded photo store (`blob-store.ts`). Absent,
   * the store the agent registered for this box is used (`boxBlobs`), which is
   * how the api's mount for a virtual box keeps a photo where that box's
   * upload worker finds it.
   */
  blobs?(): BlobStore | null;
  /** `CHILD_PHOTOS_ENABLED`. Absent, the process environment decides (on unless switched off). */
  photosEnabled?(): boolean;
}

export interface StationBridgeOptions {
  /**
   * OD-6: a fresh sign-in with no live token, for somebody seen here in thirty
   * days while a deny-list pulled within 72 hours is held. On by the plan's
   * decision; a host can turn it off.
   */
  allowFreshSignIn?: boolean;
  maxFailures?: number;
  cooldownS?: number;
}

// --- The cache, read -------------------------------------------------------------

interface CachedMember {
  id: string;
  phone: string;
  nickname: string;
  name: string | null;
  tierCode: string;
  preferredChannel: 'whatsapp' | 'telegram' | 'line' | null;
  childrenReviewSince: string | null;
  aliasIds: string[];
  children: BridgeChild[];
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const s = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function itemsOf(bundle: CachedBundle | null): unknown[] {
  const items = rec(bundle?.payload)?.items;
  return Array.isArray(items) ? items : [];
}

function childOf(raw: unknown): BridgeChild | null {
  const c = rec(raw);
  const id = s(c?.id);
  if (!c || !id) return null;
  return {
    id,
    name: s(c.name) ?? '',
    dateOfBirth: s(c.dateOfBirth),
    ageYears: typeof c.ageYears === 'number' ? c.ageYears : null,
    allergies: s(c.allergies),
    medicalNotes: s(c.medicalNotes),
    medicalAlert: c.medicalAlert === true,
    dietary: s(c.dietary),
    foodRestrictions: s(c.foodRestrictions),
    notes: s(c.notes),
    lastConfirmedAt: s(c.lastConfirmedAt),
  };
}

function cachedMemberOf(raw: unknown): CachedMember | null {
  const m = rec(raw);
  const id = s(m?.id);
  const phone = s(m?.phone);
  if (!m || !id || !phone) return null;
  const channel = s(m.preferredChannel);
  return {
    id,
    phone,
    nickname: s(m.nickname) ?? '',
    name: s(m.name),
    tierCode: s(m.tierCode) ?? 'tourist',
    preferredChannel:
      channel === 'whatsapp' || channel === 'telegram' || channel === 'line' ? channel : null,
    childrenReviewSince: s(m.childrenReviewSince),
    aliasIds: Array.isArray(m.aliasIds)
      ? m.aliasIds.filter((x): x is string => typeof x === 'string')
      : [],
    children: (Array.isArray(m.children) ? m.children : [])
      .map(childOf)
      .filter((c): c is BridgeChild => !!c),
  };
}

function ageOf(appliedAt: string | null, now: Date): number | null {
  if (!appliedAt) return null;
  const at = Date.parse(appliedAt);
  return Number.isFinite(at) ? Math.max(0, Math.floor((now.getTime() - at) / 1000)) : null;
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

// --- Box sessions ------------------------------------------------------------------

interface HeldSession {
  stationId: string;
  accountId: string;
  method: BridgeUnlockMethod;
  offlineFresh: boolean;
  jti: string | null;
  expiresAt: number;
  permissions: ReadonlySet<string>;
}

/** Scope of the durable unlock throttle in `box_throttle`. */
const UNLOCK_THROTTLE_SCOPE = 'bridge_unlock';

/**
 * SCRUM-502 — how a prepaid press waits for the store's one writer
 * (`recordInTurn`): every 25 ms, for up to five seconds, the store's own
 * `busy_timeout`.
 */
const PREPAID_TURN_WAIT_MS = 25;
const PREPAID_TURN_ATTEMPTS = 200;

/**
 * Wrong passwords counted in the store's `box_throttle`, so pulling a Pi's
 * power lead does not hand a guesser five fresh tries. Falls back to memory on
 * a store without the booth runtime tables, which says so in its features.
 */
function storeThrottle(
  store: BoxStore,
  boxId: string,
  now: () => Date,
  maxFailures: number,
  cooldownS: number,
): OfflineThrottle {
  return {
    async check(accountId) {
      const held = await store.readThrottle(boxId, UNLOCK_THROTTLE_SCOPE, accountId);
      if (!held?.lockedUntil) return 0;
      const left = Math.ceil((Date.parse(held.lockedUntil) - now().getTime()) / 1000);
      return left > 0 ? left : 0;
    },
    async fail(accountId) {
      const held = await store.readThrottle(boxId, UNLOCK_THROTTLE_SCOPE, accountId);
      const lockExpired =
        held?.lockedUntil !== null &&
        held?.lockedUntil !== undefined &&
        Date.parse(held.lockedUntil) <= now().getTime();
      if (lockExpired) await store.clearThrottle(boxId, UNLOCK_THROTTLE_SCOPE, accountId);
      const failures = (lockExpired ? 0 : (held?.failures ?? 0)) + 1;
      if (failures >= maxFailures) {
        const lockedUntil = new Date(now().getTime() + cooldownS * 1000).toISOString();
        await store.recordThrottleFailure(boxId, UNLOCK_THROTTLE_SCOPE, accountId, {
          now: now().toISOString(),
          lockedUntil,
        });
        return { locked: true, retryAfterS: cooldownS, attemptsLeft: 0 };
      }
      await store.recordThrottleFailure(boxId, UNLOCK_THROTTLE_SCOPE, accountId, {
        now: now().toISOString(),
      });
      return { locked: false, retryAfterS: 0, attemptsLeft: maxFailures - failures };
    },
    async clear(accountId) {
      await store.clearThrottle(boxId, UNLOCK_THROTTLE_SCOPE, accountId);
    },
  };
}

// --- Selling on the box lane (plan §2.4, Round 4) ------------------------------------

const SALE_INTENT_TYPES: ReadonlySet<string> = new Set(Object.values(BRIDGE_SALE_INTENTS));

/**
 * What a till may name on the box lane and be told no, in the capability
 * list's words (plan §2.8): the 2C2P QR, vouchers, wallet spend, online
 * booking redemption, refunds and voids.
 */
const REFUSED_ON_BOX_LANE: Record<string, BoxLaneRefusal> = {
  'payment.gateway_qr': 'qr2c2p',
  'payment.2c2p': 'qr2c2p',
  'payment.voucher': 'voucher',
  'sale.voucher': 'voucher',
  // `payment.wallet` is no longer here: since S2-14a round 4 the box spends a
  // scanned wallet under the offline cap (`spendWallet`). A tender NAMED
  // `wallet` on `sale.finalise` or `payment.start` is still refused, in the
  // list's words — credit is scanned, never picked off the grid.
  // `booking.redeem` is no longer here: since S2-12 round 5 the box redeems a
  // paid booking from its own copy (`bookingRedeem`). A box without the store
  // tables to keep its redemption log still refuses it, in these same words.
  'sale.refund': 'refund',
  'payment.refund': 'refund',
  'sale.void': 'refund',
};

/** Where a terminal tender the box is holding stands, in the platform's attempt words. */
const UNRESOLVED: ReadonlySet<PaymentAttemptStatus> = new Set([
  'sent_to_terminal',
  'unknown',
  'inquiring',
  'awaiting_staff_confirmation',
]);

/** A terminal (or a person reading its screen) said yes: the money is taken. */
const SETTLED: ReadonlySet<PaymentAttemptStatus> = new Set(['approved', 'awaiting_settlement']);

/**
 * Mid-exchange words: only true while a call on this box is talking to the
 * terminal. One found with no such call was left by a power cut or a crash
 * between the write-ahead and the answer.
 */
const MID_EXCHANGE: ReadonlySet<PaymentAttemptStatus> = new Set(['sent_to_terminal', 'inquiring']);

/**
 * The sales whose money a call is handling right now, as `boxId:saleId`.
 *
 * Module-wide rather than per bridge, so two bridges over one box in one
 * process (the api's mount and the in-process agent's own) still see one
 * another. A process that restarts starts with none — which is exactly how a
 * held tender at `sent_to_terminal` is known to have lost its exchange.
 */
const salesInHand = new Set<string>();

/** The platform's words (`payments/attempt.ts`) for money that may yet move. */
const paymentInFlight = (): BridgeError =>
  new BridgeError(
    409,
    'PAYMENT_IN_FLIGHT',
    'A payment is still waiting for an answer. Resolve it before charging this balance again.',
  );

const attemptNotHeld = (): BridgeError =>
  new BridgeError(404, 'PAYMENT_ATTEMPT_NOT_FOUND', 'This box holds no such payment for that sale');

/**
 * Errors that mean nothing was sent to the terminal at all, so no money can
 * have moved. Anything else with no answer is UNKNOWN: a timer or a failed
 * read never proves money was not taken. On an INQUIRY none of them says
 * anything about the sale, and the tender stays where it was.
 */
const NOTHING_SENT = new Set([
  'TERMINAL_NOT_ON_THIS_BOX',
  'DEVICE_NO_ADDRESS',
  'TERMINAL_NOT_CONFIGURED',
  'TERMINAL_BAD_REQUEST',
]);

/**
 * A card or QR tender the box is driving on the counter's own terminal,
 * written down BEFORE a byte goes to the terminal (plan §6, "terminal
 * write-ahead"): a power cut mid-payment leaves this row, and the till asking
 * again is answered with the tender it left behind — never a second charge
 * after an unknown outcome.
 */
interface HeldTender {
  attemptId: string;
  saleId: string;
  stationId: string;
  actionId: string;
  method: string;
  kind: 'card' | 'qr';
  amountSatang: number;
  deviceId: string;
  protocol: TerminalProtocol;
  provider: PaymentProvider;
  status: PaymentAttemptStatus;
  terminalRef: string | null;
  tranRef: string | null;
  invoiceNo: string | null;
  approvalCode: string | null;
  last4: string | null;
  tid: string | null;
  mid: string | null;
  responseCode: string | null;
  responseText: string | null;
  reversalPending: boolean;
  startedAt: string;
  updatedAt: string;
  /** When the terminal or a person said yes: the tender's `paidAt`, kept for a close after a crash. */
  paidAt?: string | null;
  /** OD-3: the person who confirmed a no-answer card against the terminal's screen. */
  staffConfirmation?: { accountId: string; at: string; approvalCode: string; note?: string } | null;
  /** The sale the tender pays for, as the till sent it, so it can be closed later. */
  sale: BridgePaymentStart;
}

const heldTenderKey = (saleId: string) => `terminal_tender:${saleId}`;

/** A sale priced, lined and planned on the box, ready to take its money. */
interface PreparedSale {
  cart: BridgeCart;
  catalogue: OfflineCatalogue;
  pricing: OfflineSalePricing;
  lines: OfflineLedgerLine[];
  gross: number;
  businessDate: string;
  memberId: string | null;
  bandPlan: OfflineBandPlan[];
  /** S2-13 round 4: the supervised children's bands, minted at "Check in now", not here. */
  deferredBands: DeferredBand[];
  /** Everything the composer reads but the tenders, the number and the bands. */
  snapshot: Omit<SalePrintSnapshot, 'saleId' | 'receiptNumber' | 'at' | 'bands' | 'tenders'>;
  /** The cart as the fact carries it: what was sold, and what the box charged. */
  factCart: Record<string, unknown> & { expectedTotalSatang: number };
  /** S2-14b round 3: the counted sizes this sale takes, against the box's stock snapshot. */
  stock: BoxStock;
  /** SCRUM-498: the band holder and the prepaid lines this sale serves, checked. */
  food: BoxFoodOrder;
}

/**
 * S2-14b round 3 — WHAT A SALE TAKES OF THE COUNTED SHELVES, against the
 * snapshot it was guarded with. `demand` holds only sizes the snapshot names;
 * the platform takes the stock itself when the sale replays through finalise.
 */
interface BoxStock {
  snapshot: StockSnapshotItem | null;
  /** Units per stock item. */
  demand: Map<string, number>;
}

/**
 * The design's food-consent rule (`OrderStation.tsx:handleAdd`), as the
 * platform checks it at the commit: no food for a child whose parent did not
 * authorise it unless staff recorded the override. Prepaid lines are not
 * counted, as online.
 */
function assertFoodConsent(food: BoxFoodOrder, items: ReadonlyMap<string, OfflineItemLine>): void {
  const holder = food.holder;
  if (!holder || holder.mayOrderFood || holder.foodOverride) return;
  if ([...items].some(([lineId, item]) => item.kind === 'fnb_item' && !food.prepaid.has(lineId))) {
    throw new BridgeError(409, 'FOOD_NOT_AUTHORIZED', BAND_FOOD_REFUSALS.FOOD_NOT_AUTHORIZED, {
      checkinId: holder.checkinId,
    });
  }
}

/** The runtime value naming what a sale took of the counted shelves on this box. */
const stockTakenKey = (saleId: string) => `stock_taken:${saleId}`;

/** What the box keeps beside a sale in its log, to answer the till the same way twice. */
interface SaleMemo {
  view: Omit<BridgeSaleView, 'receiptNumber' | 'receiptSeries' | 'receiptSeq' | 'status'>;
  attempt: PaymentAttemptView | null;
  /** S2-13 round 4: the bands this sale left for "Check in now" (`checkin-desk.ts`). */
  deferredBands?: DeferredBand[];
  /** S2-14a round 4: the credit this sale took offline, answered again as it was the first time. */
  wallet?: { spend: BridgeWalletSpendView; attempt: PaymentAttemptView };
}

/**
 * CREDIT WRITTEN AHEAD FOR A SALE (S2-14a round 4). A credit press that does
 * not cover the order is counted against the wallet's day on this box in one
 * store transaction with this row, BEFORE the till is told; the press that
 * takes the rest in cash closes the sale with it and queues its fact. A
 * restart in between keeps both, so a retried press is answered from here and
 * the counter never moves twice.
 */
interface WalletHold {
  saleId: string;
  stationId: string;
  accountId: string;
  /** The credit press: the wallet tender's action id on the platform, and the spend's replay key. */
  actionId: string;
  attemptId: string;
  spendId: string;
  walletId: string;
  amountSatang: number;
  source: 'fnb_order' | 'merch_order';
  businessDate: string;
  snapshotBalanceSatang: number;
  /** What this box had filed against the wallet when the snapshot was built (any day). */
  reflectedSatang: number;
  capSatang: number;
  /** This wallet's day on this box once this credit is counted. */
  spentTodaySatang: number;
  /** This wallet's spends on this box across all days once this credit is counted (absent on a hold written before the all-days counter). */
  spentOnBoxSatang?: number;
  balanceAfterSatang: number;
  capLeftSatang: number;
  snapshotVersion: string | null;
  snapshotAt: string | null;
  at: string;
  /** Set when the sale it pays for was recorded: the hold is spent, and its fact is queued. */
  closed?: boolean;
}

const walletHoldKey = (saleId: string) => `wallet_hold:${saleId}`;

/** A wallet a scanned key names, with what it can spend at this counter now. */
interface WalletAtCounter {
  snapshot: WalletSnapshotItem;
  snapshotAt: string | null;
  wallet: WalletSnapshotEntry;
  capSatang: number;
  businessDate: string;
  spentTodaySatang: number;
  spentOnBoxSatang: number;
  reflectedSatang: number;
  allowance: OfflineAllowance;
}

// --- Redeeming an online booking on the box lane (S2-12 round 5) ----------------------

/** One priced line of a booking, as `POST /public/bookings` stored it and the bundle carries it. */
interface CachedBookingLine {
  packageId: string;
  name: string;
  kids: number;
  adults: number;
  kidUnitSatang: number;
  adultsFree: number;
  adultUnitSatang: number;
  socks: number;
  socksUnitSatang: number;
  addOns: Array<{ productId: string; name: string; unitSatang: number; quantity: number }>;
  lineTotalSatang: number;
}

/** A booking in the box's `bookings` scope (`bookingChange` in the api's `sync.ts`). */
interface CachedBooking {
  id: string;
  branchId: string;
  memberId: string | null;
  reference: string;
  bookingDate: string;
  status: string;
  totalSatang: number;
  createdAt: string;
  payload: Record<string, unknown>;
}

const n0 = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

function cachedBookingOf(raw: unknown): CachedBooking | null {
  const b = rec(raw);
  const id = s(b?.id);
  const reference = s(b?.reference);
  if (!b || !id || !reference) return null;
  return {
    id,
    branchId: s(b.branchId) ?? '',
    memberId: s(b.memberId),
    reference,
    bookingDate: s(b.bookingDate) ?? '',
    status: s(b.status) ?? 'pending',
    totalSatang: n0(b.totalSatang),
    createdAt: s(b.createdAt) ?? '',
    payload: rec(b.payload) ?? {},
  };
}

/** The lines a booking paid for — `linesOf` in the api's `bookings.ts`, over the cached copy. */
function bookingLinesOf(booking: CachedBooking): CachedBookingLine[] {
  const raw = booking.payload.lines;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const bag = rec(entry);
    if (!bag) return [];
    const addOns = (Array.isArray(bag.addOns) ? bag.addOns : []).flatMap((a) => {
      const add = rec(a);
      const quantity = n0(add?.quantity);
      if (!add || quantity <= 0) return [];
      return [
        {
          productId: s(add.productId) ?? s(add.id) ?? '',
          name: s(add.name) ?? '',
          unitSatang: n0(add.unitSatang),
          quantity,
        },
      ];
    });
    return [
      {
        packageId: s(bag.packageId) ?? '',
        name: s(bag.name) ?? '',
        kids: n0(bag.kids),
        adults: n0(bag.adults),
        kidUnitSatang: n0(bag.kidUnitSatang),
        adultsFree: n0(bag.adultsFree),
        adultUnitSatang: n0(bag.adultUnitSatang),
        socks: n0(bag.socks),
        socksUnitSatang: n0(bag.socksUnitSatang),
        addOns,
        lineTotalSatang: n0(bag.lineTotalSatang),
      },
    ];
  });
}

/** The socks add-on's catalogue code, as the booking site priced the `socks` integer. */
const SOCKS_CODE = 'AO-SOCKS';

type CataloguePackage = NonNullable<ReturnType<OfflineCatalogue['packages']['get']>>;

/** A rate pair that answers the same figure on any day: the booking already chose the day. */
const flat = (satang: number) => ({ weekday: satang, weekend: satang });

/**
 * THE CATALOGUE A BOOKING WAS PAID FROM, laid over the box's own — the box's
 * half of `priceBasisOfBooking` in the api's `booking-redemption.ts`, unit for
 * unit: each package at the line's kid unit under the booking's tier, its
 * adults `free_adults` with the line's free count and paid unit (or
 * `set_price` when none were free), each extra and the socks at what was paid.
 * The booking's tier is the default, so a walk-in booking is priced at it too.
 * The tax set-up is the box's current one — the one input a booking does not
 * store — and a total that no longer equals what was paid is refused.
 */
function bookingCatalogue(
  catalogue: OfflineCatalogue,
  tier: string,
  lines: readonly CachedBookingLine[],
  socksProductId: string | null,
): OfflineCatalogue {
  const packages = new Map(catalogue.packages);
  const set = new Map<string, string>();
  for (const line of lines) {
    const adultRule =
      line.adultsFree > 0
        ? { kind: 'free_adults', freeAdults: line.adultsFree, overflow: 'set_price', price: flat(line.adultUnitSatang) }
        : { kind: 'set_price', price: flat(line.adultUnitSatang) };
    const prices = { [tier]: flat(line.kidUnitSatang) };
    const adultRules = { [tier]: adultRule };
    const fingerprint = JSON.stringify([prices, adultRules]);
    const earlier = set.get(line.packageId);
    if (earlier !== undefined && earlier !== fingerprint) {
      throw new BridgeError(
        409,
        'BOOKING_LINES_AMBIGUOUS',
        'This booking prices the same ticket twice at different figures, so it cannot be redeemed at the counter — ask a manager',
        { packageId: line.packageId },
      );
    }
    set.set(line.packageId, fingerprint);
    const held = catalogue.packages.get(line.packageId);
    packages.set(line.packageId, {
      id: line.packageId,
      name: held?.name ?? (line.name || 'Ticket'),
      prices: prices as CataloguePackage['prices'],
      adultRules,
      active: true,
      archivedAt: null,
      hours: held?.hours ?? null,
      durationLabel: held?.durationLabel ?? null,
      // Gate access is the ticket's own setting, not the booking's price.
      gateAccess: held?.gateAccess ?? false,
    });
  }
  const products = new Map(catalogue.products);
  const paidAt = (productId: string, unit: number) => {
    const held = products.get(productId);
    if (held) {
      products.set(productId, {
        ...held,
        priceSatang: unit,
        priceWeekendSatang: unit,
        active: true,
        archivedAt: null,
      });
    }
  };
  for (const line of lines) {
    for (const addOn of line.addOns) paidAt(addOn.productId, addOn.unitSatang);
    if (line.socks > 0 && socksProductId) paidAt(socksProductId, line.socksUnitSatang);
  }
  return { ...catalogue, packages, products, defaultTier: tier };
}

/**
 * THE BOX'S REDEMPTION LOG — one row per booking per box, in the store's
 * runtime values, written BEFORE anything is sold (the write-ahead pattern the
 * offline cluster set for a terminal tender). Every till on this box reads the
 * same row, so a second till is told who redeemed it and when; and a box that
 * lost power between the row and the sale finds the row, with the sale's own
 * id and cart, and finishes that ONE sale rather than starting another.
 *
 *   claimed  the row is on disk; the sale may or may not be;
 *   done     the sale is recorded and the `booking.redeemed` fact is queued,
 *            written with this state in one store transaction.
 */
interface BookingRedemptionLog {
  bookingId: string;
  reference: string;
  /** The `booking.redeemed` fact's id, minted here. */
  redemptionId: string;
  saleId: string;
  /** The press that claimed it: the same press again is answered with its sale. */
  actionId: string;
  tenderActionId: string;
  stationId: string;
  stationName: string | null;
  accountId: string;
  staffName: string | null;
  /** When the counter claimed it, by the box's clock. The sale is dated to it. */
  at: string;
  state: 'claimed' | 'done';
  /** What the sale is priced from, kept so a recovery prices the same sale. */
  tier: string;
  lines: CachedBookingLine[];
  socksProductId: string | null;
  totalSatang: number;
  /** The sale as it is committed, under its ids. */
  sale: BridgeSaleFinalise;
  /** Once done: the number printed and the short codes handed over. */
  receiptNumber?: string | null;
  bandCodes?: string[];
}

const redemptionKey = (bookingId: string) => `booking_redemption:${bookingId}`;

/** The keys the platform reads as a booking redemption (`BookingSaleMarkSchema` in the api's `sync.ts`). */
const BOOKING_MARKER_KEYS = ['bookingId', 'bookingRedemptionId', 'bookingReference'] as const;

/** Whether a till's cart — flat, or nested under `cart` — names a booking. */
function cartNamesBooking(raw: unknown): boolean {
  const outer = rec(raw);
  if (!outer) return false;
  const inner = rec(outer.cart);
  return [outer, inner].some(
    (bag) => !!bag && BOOKING_MARKER_KEYS.some((k) => bag[k] !== undefined && bag[k] !== null),
  );
}

/** Bookings a call on this box is redeeming right now, as `boxId:bookingId` (see `salesInHand`). */
const bookingsInHand = new Set<string>();

/** Where inside a box redemption a test can pull the power lead. */
export type RedemptionCrashPoint = 'after_claim' | 'after_sale';

// --- The bridge ----------------------------------------------------------------------

export interface BridgeIntentAnswer {
  document: StationSessionDocument;
  /** What a record intent wrote, or a quote: the till reads it as the platform's own answer. */
  result?: Record<string, unknown>;
}

export class StationBridge {
  private readonly host: BridgeHost;
  private readonly options: Required<StationBridgeOptions>;
  private readonly log: AgentLog;
  private readonly held = new Map<string, HeldSession>();
  /**
   * Named crash points inside a box redemption (S2-12 round 5), called in
   * order. A test throws from one to prove a restart there recovers to exactly
   * one sale; nothing else sets it.
   */
  redemptionCrash: ((point: RedemptionCrashPoint) => void | Promise<void>) | null = null;

  constructor(host: BridgeHost, options: StationBridgeOptions = {}) {
    this.host = host;
    this.options = {
      allowFreshSignIn: options.allowFreshSignIn ?? true,
      maxFailures: options.maxFailures ?? 5,
      cooldownS: options.cooldownS ?? 300,
    };
    this.log = host.log ?? silentLog;
  }

  get boxId(): string {
    return this.host.boxId;
  }

  private deskInstance: CheckinDesk | null = null;
  private eventsDeskInstance: EventsDesk | null = null;

  /** S2-20 E3 — the events desk: check-in, check-out and reprint at an event on the box lane. */
  get eventsDesk(): EventsDesk {
    this.eventsDeskInstance ??= new EventsDesk({
      boxId: this.host.boxId,
      store: this.host.store,
      now: () => this.host.now(),
      log: this.log,
      sealer: () => this.host.sealer(),
      sales: () => this.host.sales?.() ?? null,
      tradingDay: () => this.tradingDay(),
    });
    return this.eventsDeskInstance;
  }

  /** The events overlay's end, after an `events` pull (S2-20 E3). */
  async pruneEventsOverlay(): Promise<number> {
    return this.eventsDesk.pruneOverlay();
  }

  /** The check-in desk (S2-13 round 4): the gate, the board and the release on the box lane. */
  get desk(): CheckinDesk {
    this.deskInstance ??= new CheckinDesk({
      eventBands: () => this.eventsDesk,
      boxId: this.host.boxId,
      store: this.host.store,
      now: () => this.host.now(),
      log: this.log,
      sealer: () => this.host.sealer(),
      sales: () => this.host.sales?.() ?? null,
      blobs: () => (this.host.blobs ? this.host.blobs() : boxBlobs(this.host.boxId)),
      photosEnabled: () =>
        this.host.photosEnabled ? this.host.photosEnabled() : childPhotosEnabled(process.env.CHILD_PHOTOS_ENABLED),
      resolveMember: async (memberId) => {
        const found = await this.resolveMember(memberId);
        if (!found) return null;
        const shown = await this.present(found.member, [], found.source);
        return { id: found.id, childIds: new Set(shown.children.map((c) => c.id)) };
      },
    });
    return this.deskInstance;
  }

  /** The row a photo this box holds was taken for: what the upload worker links it to. */
  async photoTarget(photoId: string) {
    return this.desk.photoTarget(photoId);
  }

  /** The check-in overlay's end, after a `checkin` pull (S2-13 round 4). */
  async pruneCheckinOverlay(): Promise<number> {
    return this.desk.pruneOverlay();
  }

  /** The station, or 404: a bridge serves only the stations on its own box. */
  station(stationId: string): BridgeStation {
    const found = this.host.station(stationId);
    if (!found) {
      throw new BridgeError(404, 'STATION_NOT_ON_BOX', 'That station is not on this box');
    }
    return found;
  }

  private async bundle(scope: CachedBundle['scope']): Promise<CachedBundle | null> {
    return this.host.store.readBundle(this.host.boxId, scope).catch(() => null);
  }

  /** The offline policy for a station: its `station_config` entry, else the plan's defaults. */
  async policy(stationId: string): Promise<OfflinePolicy> {
    const config = await this.bundle('station_config');
    const entry = itemsOf(config)
      .map(rec)
      .find((row) => row?.id === stationId);
    const sent = rec(entry?.offlinePolicy);
    const num = (key: keyof OfflinePolicy): number => {
      const value = sent?.[key];
      return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : OFFLINE_POLICY[key];
    };
    return {
      catalogueBannerAfterS: num('catalogueBannerAfterS'),
      catalogueRefuseAfterS: num('catalogueRefuseAfterS'),
      staffTokenTtlS: num('staffTokenTtlS'),
      freshSignInDays: num('freshSignInDays'),
      freshSignInDenyListMaxAgeS: num('freshSignInDenyListMaxAgeS'),
    };
  }

  // --- status -------------------------------------------------------------------

  async status(stationId: string): Promise<BridgeStatus> {
    this.station(stationId);
    const now = this.host.now();
    const [catalogue, members, staff, deny, receipts, policy, depth] = await Promise.all([
      this.bundle('catalogue'),
      this.bundle('members'),
      this.bundle('staff'),
      this.bundle('deny_list'),
      this.bundle('receipt_series'),
      this.policy(stationId),
      this.host.store.depth(this.host.boxId).catch(() => ({ queued: 0, oldestQueuedAt: null })),
    ]);
    const age = (bundle: CachedBundle | null) => ({
      held: !!bundle,
      appliedAt: bundle?.appliedAt ?? null,
      ageSeconds: ageOf(bundle?.appliedAt ?? null, now),
    });
    const link = this.host.link();
    const mark = itemsOf(receipts)
      .map(rec)
      .find((row) => row?.stationId === stationId);
    return {
      stationId,
      boxId: this.host.boxId,
      link: {
        up: link.up,
        offline: link.offline,
        lane: link.up && !link.offline ? 'platform' : 'box',
      },
      catalogue: {
        ...age(catalogue),
        state: catalogueState(catalogue?.appliedAt ?? null, now, policy),
        version: s(rec(itemsOf(catalogue)[0])?.version),
        bannerAfterSeconds: policy.catalogueBannerAfterS,
        refuseAfterSeconds: policy.catalogueRefuseAfterS,
      },
      members: age(members),
      staff: age(staff),
      denyList: age(deny),
      outboxDepth: depth.queued,
      receiptMark: mark
        ? {
            prefix: s(mark.prefix),
            highWaterMark: typeof mark.highWaterMark === 'number' ? mark.highWaterMark : 0,
          }
        : null,
      serverTime: now.toISOString(),
    };
  }

  // --- unlock and the box session ---------------------------------------------------

  /**
   * Unlock at this station against the box's own copy (OD-2, OD-6).
   *
   * `expectAccountId` is the platform session's account on the api mount: the
   * token or the account the till names must be the person whose session is
   * locked there, or Mali's till would open under Nok's name.
   */
  async unlock(
    stationId: string,
    request: BridgeUnlockRequest,
    opts: {
      expectAccountId?: string | null;
      /** For this unlock only: the api counts wrong passwords per platform session. */
      throttle?: OfflineThrottle;
    } = {},
  ): Promise<{ response: BridgeUnlockResponse; caller: BridgeTillCaller; session: string }> {
    const station = this.station(stationId);
    const now = this.host.now();
    const policy = await this.policy(stationId);
    const [staffBundle, denyBundle, keys] = await Promise.all([
      this.bundle('staff'),
      this.bundle('deny_list'),
      Promise.resolve(this.host.signingKeys()),
    ]);
    const staff = itemsOf(staffBundle) as OfflineStaffRecord[];
    const deny = (itemsOf(denyBundle)[0] as StaffDenyList | undefined) ?? null;

    const throttle =
      opts.throttle ??
      this.host.throttle ??
      (this.host.store.features().boothRuntime
        ? storeThrottle(
            this.host.store,
            this.host.boxId,
            () => this.host.now(),
            this.options.maxFailures,
            this.options.cooldownS,
          )
        : memoryThrottle({
            maxFailures: this.options.maxFailures,
            cooldownS: this.options.cooldownS,
            now: () => this.host.now(),
          }));

    /**
     * OD-6's added bound, checked before the password: a fresh sign-in needs a
     * deny-list pulled within 72 hours. A live token does not — the token's own
     * sixteen hours are its bound (OD-5) — so the bound is applied only when
     * the till has no token the box can verify, which is `OfflineAuth`'s
     * `offline_sign_in` path.
     */
    const denyAgeS = ageOf(denyBundle?.appliedAt ?? null, now);
    const denyFreshEnough = denyAgeS !== null && denyAgeS <= policy.freshSignInDenyListMaxAgeS;

    const auth = new OfflineAuth({
      boxId: this.host.boxId,
      branchId: station.branchId,
      snapshot: async () =>
        staffBundle ? { keys, staff, deny, cachedAt: staffBundle.appliedAt } : null,
      verifyPassword: (hash, password) => this.host.verifyPassword(hash, password),
      now: () => this.host.now(),
      throttle,
      maxFailures: this.options.maxFailures,
      cooldownS: this.options.cooldownS,
      allowOfflineSignIn: this.options.allowFreshSignIn && denyFreshEnough,
      offlineSignInDays: policy.freshSignInDays,
    });
    const result = await auth.unlock({
      token: request.token ?? null,
      password: request.password,
      accountId: request.accountId ?? opts.expectAccountId ?? null,
    });

    const record = (
      outcome: 'applied' | 'refused',
      errorCode: string | null,
      accountId: string | null,
    ) =>
      this.host.store
        .recordStationEvent(
          {
            stationId,
            boxId: this.host.boxId,
            kind: 'intent',
            source: 'till',
            intentType: 'bridge.unlock',
            outcome,
            errorCode,
            actorAccountId: accountId,
            payload: { keys: request.token ? ['password', 'token'] : ['password'] },
          },
          now.toISOString(),
        )
        .catch((err: unknown) => {
          this.log.warn(
            { err: String(err), module: 'station-bridge' },
            'an unlock could not be written to the station tape',
          );
        });

    if (!result.ok) {
      // The deny-list bound is its own sentence: "not recognised" would send
      // somebody the box has seen yesterday looking for the wrong fix.
      const staleDeny =
        !denyFreshEnough &&
        this.options.allowFreshSignIn &&
        (result.refusal === OFFLINE_UNLOCK_REFUSALS.NO_TOKEN ||
          result.refusal === 'STAFF_TOKEN_EXPIRED' ||
          result.refusal === OFFLINE_UNLOCK_REFUSALS.NOT_RECOGNISED);
      const code = staleDeny ? 'OFFLINE_DENY_LIST_STALE' : result.refusal;
      await record('refused', code, request.accountId ?? opts.expectAccountId ?? null);
      throw new BridgeError(
        result.refusal === OFFLINE_UNLOCK_REFUSALS.LOCKED_OUT ? 429 : 401,
        code,
        staleDeny
          ? 'This counter has not checked who may sign in for over three days — connect it to the internet once, then sign in.'
          : result.message,
        {
          ...(result.retryAfterS ? { retryAfterSeconds: result.retryAfterS } : {}),
          ...(result.attemptsLeft !== undefined ? { attemptsLeft: result.attemptsLeft } : {}),
        },
      );
    }
    if (opts.expectAccountId && result.accountId !== opts.expectAccountId) {
      await record('refused', 'STAFF_TOKEN_WRONG_ACCOUNT', opts.expectAccountId);
      throw new BridgeError(
        403,
        'STAFF_TOKEN_WRONG_ACCOUNT',
        'That shift token belongs to another account — sign out and sign in instead',
      );
    }
    if (result.claims && result.claims.sta !== stationId) {
      await record('refused', 'STAFF_TOKEN_WRONG_AUDIENCE', result.accountId);
      throw new BridgeError(
        403,
        'STAFF_TOKEN_WRONG_AUDIENCE',
        'That shift token was issued at another station',
      );
    }

    const member = staff.find((row) => row.accountId === result.accountId) as
      (OfflineStaffRecord & { permissions?: unknown }) | undefined;
    const permissions = new Set(
      Array.isArray(member?.permissions)
        ? (member.permissions as unknown[]).filter((p): p is string => typeof p === 'string')
        : [],
    );
    const offlineFresh = result.method === 'offline_sign_in';
    const expiresAt = result.claims
      ? result.claims.exp * 1000
      : now.getTime() + policy.staffTokenTtlS * 1000;
    const caller: BridgeTillCaller = {
      kind: 'till',
      accountId: result.accountId,
      can: (permission) => permissions.has(permission),
      method: result.method,
      offlineFresh,
      jti: result.claims?.jti ?? null,
    };
    const session = this.issue(stationId, {
      accountId: result.accountId,
      method: result.method,
      offlineFresh,
      jti: caller.jti,
      expiresAt,
      permissions,
    });
    await record('applied', null, result.accountId);
    return {
      caller,
      session,
      response: {
        session,
        accountId: result.accountId,
        method: result.method,
        offlineFresh,
        expiresAt: new Date(expiresAt).toISOString(),
        cachedAt: result.cachedAt,
        cacheAgeSeconds: ageOf(result.cachedAt, now),
        mustChangePassword: result.mustChangePassword,
      },
    };
  }

  /** Mint an opaque session. Only its hash is kept. */
  issue(stationId: string, held: Omit<HeldSession, 'stationId'>): string {
    const token = `${BOX_SESSION_PREFIX}${randomBytes(32).toString('base64url')}`;
    this.held.set(sha256(token), { ...held, stationId });
    return token;
  }

  /**
   * The till behind a box session, or null.
   *
   * Re-checked against the deny-list the box holds NOW on every call: a pull
   * that brings a revocation ends the session at the next request rather than
   * at the token's expiry.
   */
  async authenticate(
    stationId: string,
    bearer: string | null | undefined,
  ): Promise<BridgeTillCaller | null> {
    if (!bearer || !bearer.startsWith(BOX_SESSION_PREFIX)) return null;
    const key = sha256(bearer);
    const held = this.held.get(key);
    if (!held || held.stationId !== stationId) return null;
    if (held.expiresAt <= this.host.now().getTime()) {
      this.held.delete(key);
      return null;
    }
    const deny = (itemsOf(await this.bundle('deny_list'))[0] as StaffDenyList | undefined) ?? null;
    if (
      !deny ||
      deny.revokedAccountIds.includes(held.accountId) ||
      (held.jti !== null && deny.revokedTokenIds.includes(held.jti))
    ) {
      this.held.delete(key);
      return null;
    }
    return {
      kind: 'till',
      accountId: held.accountId,
      can: (permission) => held.permissions.has(permission),
      method: held.method,
      offlineFresh: held.offlineFresh,
      jti: held.jti,
    };
  }

  /** Lock or sign-out: the session ends. Unknown tokens are not an error. */
  end(bearer: string | null | undefined): boolean {
    if (!bearer) return false;
    return this.held.delete(sha256(bearer));
  }

  /**
   * A paired display's credential, checked against the hashes this box holds
   * in its `station_config` scope. Nothing but the hash is on the box, so a
   * stolen card yields no display credential.
   */
  async displayCaller(
    stationId: string,
    bearer: string | null | undefined,
  ): Promise<BridgeDisplayCaller | null> {
    if (!bearer || !/^[0-9a-f]{64}$/i.test(bearer)) return null;
    const config = await this.bundle('station_config');
    const entry = itemsOf(config)
      .map(rec)
      .find((row) => row?.id === stationId);
    const displays = Array.isArray(entry?.displays) ? entry.displays : [];
    const hash = sha256(bearer.toLowerCase());
    for (const raw of displays) {
      const display = rec(raw);
      if (display && display.credentialHash === hash && typeof display.id === 'string') {
        return { kind: 'display', credentialId: display.id };
      }
    }
    return null;
  }

  // --- the document -------------------------------------------------------------------

  /**
   * The document for one screen. A display is handed the customer view
   * whatever it asks for; a till, or an observer the mount has already
   * admitted (`null`), the view it asked for.
   */
  async session(stationId: string, caller: BridgeCaller | null, view: StationView) {
    this.station(stationId);
    const document = await this.host.sessions.open(stationId);
    return this.host.sessions.snapshotFor(
      document,
      caller?.kind === 'display' ? 'customer' : view,
      null,
    );
  }

  subscribe(
    stationId: string,
    caller: BridgeCaller | null,
    view: StationView,
    send: (message: StationChannelMessage) => void,
  ): () => void {
    this.station(stationId);
    return this.host.sessions.subscribe(
      stationId,
      caller?.kind === 'display' ? 'customer' : view,
      send,
    );
  }

  async claim(
    stationId: string,
    caller: BridgeTillCaller,
    holder: string,
    actionId: string | null,
  ) {
    this.station(stationId);
    const result = await this.host.sessions.claim({
      stationId,
      holder,
      holderKind: 'till',
      accountId: caller.accountId,
      actionId,
    });
    if (!result.ok) throw refusalError(result.refusal, result.message, result.document);
    return result;
  }

  async renew(stationId: string, caller: BridgeTillCaller, leaseId: string) {
    this.station(stationId);
    const result = await this.host.sessions.renew(stationId, leaseId, {
      accountId: caller.accountId,
    });
    if (!result.ok) throw refusalError(result.refusal, result.message, result.document);
    return result;
  }

  async release(
    stationId: string,
    caller: BridgeTillCaller,
    leaseId: string,
    actionId: string | null,
  ) {
    this.station(stationId);
    const result = await this.host.sessions.release(stationId, leaseId, {
      accountId: caller.accountId,
      actionId,
    });
    if (!result.ok) throw refusalError(result.refusal, result.message, result.document);
    return result;
  }

  // --- intents --------------------------------------------------------------------------

  async intent(
    stationId: string,
    caller: BridgeCaller,
    intent: StationIntent,
  ): Promise<BridgeIntentAnswer> {
    const station = this.station(stationId);
    if (caller.kind === 'till' && intent.type in BRIDGE_RECORD_INTENTS) {
      const result = await this.record(station, caller, intent.type as BridgeRecordIntent, intent);
      return { document: await this.host.sessions.open(stationId), result };
    }
    if (caller.kind === 'till' && intent.type === BRIDGE_CART_QUOTE_INTENT) {
      if (!caller.can('pos:sale:create')) {
        throw new BridgeError(403, 'FORBIDDEN', 'Missing permission: pos:sale:create');
      }
      // S2-21 round 3 — pricing a staff benefit is applying one, as the
      // platform's quote route holds it.
      const sent = rec(intent.payload);
      if ((rec(sent?.cart)?.benefit ?? sent?.benefit) && !caller.can('pos:benefit:apply')) {
        throw new BridgeError(403, 'FORBIDDEN', 'Missing permission: pos:benefit:apply');
      }
      const quote = await this.quote(station, intent.payload);
      return { document: await this.host.sessions.open(stationId), result: { quote } };
    }
    if (caller.kind === 'till' && intent.type === BRIDGE_WALLET_INTENTS.spend) {
      const result = await this.spendWallet(station, caller, intent.payload);
      return { document: await this.host.sessions.open(stationId), result: { ...result } };
    }
    if (caller.kind === 'till' && intent.type === BRIDGE_WALLET_INTENTS.lookup) {
      const wallet = await this.walletLookup(station, caller, intent.payload);
      return { document: await this.host.sessions.open(stationId), result: { wallet } };
    }
    if (caller.kind === 'till' && SALE_INTENT_TYPES.has(intent.type)) {
      const result = await this.sell(station, caller, intent);
      return { document: await this.host.sessions.open(stationId), result };
    }
    if (caller.kind === 'till' && intent.type === BRIDGE_RECEIPT_OBSERVED_INTENT) {
      const result = await this.observeReceipt(station, caller, intent.payload);
      return { document: await this.host.sessions.open(stationId), result };
    }
    if (caller.kind === 'till' && intent.type === BRIDGE_BOOKING_INTENTS.lookup) {
      const booking = await this.bookingLookup(caller, intent.payload);
      return { document: await this.host.sessions.open(stationId), result: { booking } };
    }
    if (caller.kind === 'till' && intent.type === BRIDGE_BOOKING_INTENTS.redeem) {
      const result = await this.bookingRedeem(station, caller, intent.payload);
      return { document: await this.host.sessions.open(stationId), result: { ...result } };
    }
    if (caller.kind === 'till' && this.eventsDesk.handles(intent.type)) {
      try {
        const result = await this.eventsDesk.intent(station, caller, intent.type, intent.payload, intent.actionId ?? null);
        return { document: await this.host.sessions.open(stationId), result };
      } catch (err) {
        if (err instanceof EventsDeskRefusal) throw new BridgeError(err.status, err.code, err.message, err.details);
        throw err;
      }
    }
    if (caller.kind === 'till' && this.desk.handles(intent.type)) {
      try {
        const result = await this.desk.intent(
          station,
          caller,
          intent.type,
          intent.payload,
          intent.actionId ?? null,
        );
        return { document: await this.host.sessions.open(stationId), result };
      } catch (err) {
        if (err instanceof DeskRefusal) throw new BridgeError(err.status, err.code, err.message, err.details);
        throw err;
      }
    }
    const refusal = REFUSED_ON_BOX_LANE[intent.type];
    if (refusal) this.refuse(refusal);
    if (BRIDGE_MONEY_INTENT_PREFIXES.some((prefix) => intent.type.startsWith(prefix))) {
      throw new BridgeError(409, BOX_LANE_PAYMENT_REFUSAL.code, BOX_LANE_PAYMENT_REFUSAL.message);
    }
    const result = await this.host.sessions.applyIntent(stationId, intent, {
      source: caller.kind === 'display' ? 'display' : 'till',
      accountId: caller.kind === 'till' ? caller.accountId : null,
      ...(caller.kind === 'display' ? { deviceId: caller.credentialId } : {}),
    });
    if (!result.ok) {
      const document =
        caller.kind === 'display' && result.document
          ? this.host.sessions.snapshotFor(result.document, 'customer', null).document
          : result.document;
      throw refusalError(result.refusal, result.message, document);
    }
    return {
      document:
        caller.kind === 'display'
          ? this.host.sessions.snapshotFor(result.document, 'customer', null).document
          : result.document,
    };
  }

  // --- reads: a member by phone ------------------------------------------------------------

  private async cachedMembers(): Promise<{ members: CachedMember[]; appliedAt: string | null }> {
    const bundle = await this.bundle('members');
    return {
      members: itemsOf(bundle)
        .map(cachedMemberOf)
        .filter((m): m is CachedMember => !!m),
      appliedAt: bundle?.appliedAt ?? null,
    };
  }

  /**
   * The member a phone names, with their children: the box's cached copy,
   * with what this counter recorded offline laid over it (plan §2.3).
   *
   * THE ALIAS RULE, box side (OD-7). A member this counter signed up offline
   * and a member the platform already holds under the same phone are one
   * family: the platform's is the survivor, because it arrived first. So the
   * cache wins the lookup, and the children recorded offline under the other
   * id are shown under it — exactly where the platform will file them.
   */
  async lookup(
    stationId: string,
    caller: BridgeCaller,
    rawPhone: string,
  ): Promise<BridgeMember | null> {
    this.station(stationId);
    this.require(caller, 'pos:member:read');
    const phone = normalizePhone(rawPhone);
    if (!phone) return null;
    const { members } = await this.cachedMembers();
    const cached = members.find((m) => m.phone === phone) ?? null;
    const overlayMembers = await this.host.store.listOverlay(this.host.boxId, {
      kind: 'member',
      phone,
    });
    if (cached) {
      return this.present(cached, overlayMembers, 'cache');
    }
    const offline = overlayMembers[0];
    if (!offline) return null;
    const asCached = memberFromRecord(offline.record, offline.entityId, phone);
    return this.present(asCached, overlayMembers.slice(1), 'overlay', offline);
  }

  private async present(
    base: CachedMember,
    samePhone: readonly OverlayRecord[],
    source: BridgeMember['source'],
    own?: OverlayRecord,
  ): Promise<BridgeMember> {
    const ids = [base.id, ...base.aliasIds, ...samePhone.map((row) => row.entityId)];
    const edit = own ?? (await this.host.store.readOverlay(this.host.boxId, 'member', base.id));
    const merged = edit
      ? {
          ...base,
          ...memberFromRecord(edit.record, base.id, base.phone),
          children: base.children,
          aliasIds: base.aliasIds,
        }
      : base;
    const offlineChildren = await this.host.store.listOverlay(this.host.boxId, {
      kind: 'child',
      memberIds: ids,
    });
    const children = new Map(merged.children.map((c) => [c.id, c]));
    for (const row of offlineChildren) {
      const child = childOf({ ...row.record, id: row.entityId });
      if (!child) continue;
      if (row.record.archived === true) children.delete(child.id);
      else children.set(child.id, { ...(children.get(child.id) ?? {}), ...child });
    }
    return {
      id: merged.id,
      phone: merged.phone,
      nickname: merged.nickname,
      name: merged.name,
      email: null,
      tierCode: merged.tierCode,
      preferredChannel: merged.preferredChannel,
      notes: null,
      tierVerification: null,
      children: [...children.values()],
      childrenReviewSince: merged.childrenReviewSince,
      source,
    };
  }

  /**
   * A member id as the platform will file it: through the aliases the cache
   * carries, then through the phone a member recorded here shares with one the
   * platform already holds. Null when the box knows no such member at all.
   */
  private async resolveMember(memberId: string): Promise<{
    id: string;
    member: CachedMember;
    overlay: OverlayRecord | null;
    source: BridgeMember['source'];
  } | null> {
    const { members } = await this.cachedMembers();
    const direct = members.find((m) => m.id === memberId || m.aliasIds.includes(memberId));
    if (direct) {
      return {
        id: direct.id,
        member: direct,
        overlay: await this.host.store.readOverlay(this.host.boxId, 'member', direct.id),
        source: 'cache',
      };
    }
    const offline = await this.host.store.readOverlay(this.host.boxId, 'member', memberId);
    if (!offline) return null;
    const phone = offline.phone;
    const survivor = phone ? members.find((m) => m.phone === phone) : undefined;
    if (survivor) {
      return {
        id: survivor.id,
        member: survivor,
        overlay: await this.host.store.readOverlay(this.host.boxId, 'member', survivor.id),
        source: 'cache',
      };
    }
    return {
      id: memberId,
      member: memberFromRecord(offline.record, memberId, phone ?? ''),
      overlay: offline,
      source: 'overlay',
    };
  }

  // --- reads: a priced cart ---------------------------------------------------------------------

  private async quote(
    station: BridgeStation,
    payload: Record<string, unknown>,
  ): Promise<OfflineQuote> {
    const policy = await this.policy(station.id);
    const bundle = await this.bundle('catalogue');
    const now = this.host.now();
    const state = catalogueState(bundle?.appliedAt ?? null, now, policy);
    if (state === 'refused') {
      throw new BridgeError(409, BOX_CATALOGUE_TOO_OLD.code, BOX_CATALOGUE_TOO_OLD.message, {
        appliedAt: bundle?.appliedAt ?? null,
      });
    }
    const catalogue = readOfflineCatalogue(bundle?.payload ?? null);
    if (!catalogue) {
      throw new BridgeError(
        409,
        'BOX_CATALOGUE_MISSING',
        'This counter has no copy of the prices yet — connect it to the internet once.',
      );
    }
    const branch = this.host.branch();
    if (!branch) {
      throw new BridgeError(
        409,
        'BOX_NOT_CONFIGURED',
        'This counter has no branch configuration yet',
      );
    }
    let cart;
    try {
      cart = bridgeCartOf(payload);
    } catch (err) {
      throw new BridgeError(400, 'VALIDATION', 'That cart could not be read', {
        issue: String(err),
      });
    }
    const food = await this.foodOrder(station, cart, catalogue);
    // The member's tier as this counter knows it: a tier changed here offline
    // (OD-11) prices the cart that follows, as it would online.
    const owner = cart.memberId ? await this.resolveMember(cart.memberId) : null;
    const memberTier = owner ? (s(owner.overlay?.record.tierCode) ?? owner.member.tierCode) : null;
    if (cart.memberId && memberTier === null) {
      throw new BridgeError(404, 'NOT_FOUND', 'Member not found');
    }
    const benefit = await this.benefitOnBox(cart, branch, now);
    try {
      const pricing = priceOfflineSale(catalogue, cart, {
        now,
        timezone: branch.timezone,
        businessDayStart: branch.businessDayStart,
        memberTier,
        prepaid: food.prepaid,
        benefit,
      });
      assertFoodConsent(food, pricing.items);
      return { ...pricing.quote, catalogueState: state, catalogueAppliedAt: bundle?.appliedAt ?? null };
    } catch (err) {
      if (err instanceof OfflinePriceError) {
        throw new BridgeError(
          err.code === 'SALE_LINE_PRICE_MISMATCH' || err.code.startsWith('BENEFIT_')
            ? 409
            : err.code === 'VOUCHER_NEEDS_INTERNET'
              ? 409
              : 400,
          err.code,
          err.message,
          err.details,
        );
      }
      throw err;
    }
  }

  /**
   * S2-21 round 3 — the staff benefit QR on a cart, checked on this box:
   * against the `benefits` scope it last pulled, on the branch's trading day by
   * this box's clock (`checkBenefitOnBox`). Refused in the words the till
   * shows; a box with no scope refuses rather than admits a QR it cannot
   * check. Null when the cart carries none.
   */
  private async benefitOnBox(
    cart: BridgeCart,
    branch: BridgeBranch,
    now: Date,
  ): Promise<BenefitOnBox | null> {
    if (!cart.benefit) return null;
    const held = await this.bundle('benefits');
    let today: string | null = null;
    try {
      today = businessDate(now, branch.timezone, parseDayStart(branch.businessDayStart));
    } catch {
      today = null;
    }
    const verdict = checkBenefitOnBox(cart.benefit.code, {
      scope: held ? readBenefitScope(held.payload) : null,
      today,
      now,
    });
    if (!verdict.ok) {
      throw new BridgeError(
        verdict.refusal === BENEFIT_CREDENTIAL_REFUSALS.REVOCATION_UNKNOWN ? 503 : 409,
        verdict.refusal,
        verdict.message,
      );
    }
    return verdict.benefit;
  }

  /** SCRUM-498 — the band an F&B order names and its prepaid lines, checked on the box's copy (`CheckinDesk.foodOrder`). */
  private async foodOrder(
    station: BridgeStation,
    cart: BridgeCart,
    catalogue: OfflineCatalogue,
    mode: 'strict' | 'record' = 'strict',
  ): Promise<BoxFoodOrder> {
    try {
      return await this.desk.foodOrder(station, cart, (id) => catalogue.products.get(id)?.name ?? 'That item', mode);
    } catch (err) {
      if (err instanceof DeskRefusal) throw new BridgeError(err.status, err.code, err.message, err.details);
      throw err;
    }
  }

  // --- the producers ---------------------------------------------------------------------------------

  private require(caller: BridgeCaller, permission: string): asserts caller is BridgeTillCaller {
    if (caller.kind !== 'till' || !caller.can(permission)) {
      throw new BridgeError(403, 'FORBIDDEN', `Missing permission: ${permission}`);
    }
  }

  /**
   * One fact and its overlay row, in one store transaction.
   *
   * The fact is sealed with the box's own key inside the transaction that
   * claims its sequence (`enqueueMany`), and the overlay row is written in the
   * same one — so a lookup and the outbox cannot disagree about whether the
   * thing happened.
   */
  private async produce(
    station: BridgeStation,
    caller: BridgeTillCaller,
    fact: { type: string; payload: Record<string, unknown>; actionId: string | null },
    overlay: Omit<OverlayWrite, 'eventId'> | null,
  ): Promise<string> {
    const seal = this.host.sealer();
    if (!seal) {
      throw new BridgeError(
        503,
        'BOX_AGENT_ELSEWHERE',
        'This counter’s box is not running here, so it cannot record anything right now',
      );
    }
    if (overlay && !this.host.store.features().overlay) {
      throw new BridgeError(
        503,
        'BOX_OVERLAY_MISSING',
        'This box cannot keep an offline record yet — it needs updating',
      );
    }
    const now = this.host.now().toISOString();
    const payload = caller.offlineFresh ? { ...fact.payload, offlineFresh: true } : fact.payload;
    const queued: QueuedFact = {
      type: fact.type,
      payload,
      occurredAt: now,
      stationId: station.id,
      actorKind: 'account',
      actorAccountId: caller.accountId,
      actionId: fact.actionId,
    };
    return this.host.store.atomically(async (tx) => {
      const [record] = await tx.enqueueMany(this.host.boxId, [queued], seal, now);
      const eventId = record!.envelope.eventId;
      if (overlay) await tx.putOverlay(this.host.boxId, { ...overlay, eventId }, now);
      return eventId;
    });
  }

  private async record(
    station: BridgeStation,
    caller: BridgeTillCaller,
    type: BridgeRecordIntent,
    intent: StationIntent,
  ): Promise<Record<string, unknown>> {
    const payload = { ...intent.payload };
    delete payload.offlineFresh;
    const actionId = intent.actionId ?? null;
    const factType = BRIDGE_RECORD_INTENTS[type];
    const invalid = (err: unknown): never => {
      throw new BridgeError(400, 'VALIDATION', 'That record could not be read', {
        issue: String(err),
      });
    };

    if (type === 'member.create') {
      this.require(caller, 'pos:member:create');
      const parsed = OfflineMemberCreatedSchema.safeParse(payload);
      if (!parsed.success) invalid(parsed.error);
      const body = parsed.data!;
      const phone = normalizePhone(body.phone);
      if (!phone) throw new BridgeError(400, 'VALIDATION', 'That phone number is not usable');
      // The same id again is the till retrying through a lost reply.
      const again = await this.host.store.readOverlay(this.host.boxId, 'member', body.memberId);
      if (again) {
        if (again.phone !== phone) {
          throw new BridgeError(409, 'ID_IN_USE', 'That id already names another member');
        }
        return {
          member: await this.present(
            memberFromRecord(again.record, again.entityId, phone),
            [],
            'overlay',
            again,
          ),
          replayed: true,
        };
      }
      const { members } = await this.cachedMembers();
      if (members.some((m) => m.id === body.memberId)) {
        throw new BridgeError(409, 'ID_IN_USE', 'That id already names another member');
      }
      const samePhone =
        members.find((m) => m.phone === phone) ??
        (await this.host.store.listOverlay(this.host.boxId, { kind: 'member', phone }))[0];
      if (samePhone) {
        throw new BridgeError(
          409,
          'MEMBER_PHONE_EXISTS',
          'A member with this phone already exists',
          {
            memberId: 'id' in samePhone ? samePhone.id : samePhone.entityId,
          },
        );
      }
      const record = {
        id: body.memberId,
        phone,
        nickname: body.nickname.trim(),
        name: body.name ?? null,
        tierCode: await this.defaultTier(),
        preferredChannel: body.preferredChannel ?? null,
      };
      const factPayload = { ...body, phone };
      await this.produce(
        station,
        caller,
        { type: factType, payload: factPayload, actionId },
        {
          kind: 'member',
          entityId: body.memberId,
          memberId: body.memberId,
          phone,
          record,
        },
      );
      const written = await this.host.store.readOverlay(this.host.boxId, 'member', body.memberId);
      return {
        member: await this.present(
          memberFromRecord(record, body.memberId, phone),
          [],
          'overlay',
          written ?? undefined,
        ),
      };
    }

    if (type === 'member.update') {
      this.require(caller, 'pos:member:update');
      const parsed = OfflineMemberUpdatedSchema.safeParse(payload);
      if (!parsed.success) invalid(parsed.error);
      const body = parsed.data!;
      const found = await this.resolveMember(body.memberId);
      if (!found) throw new BridgeError(404, 'NOT_FOUND', 'Member not found');
      const current = found.overlay
        ? { ...memberRecord(found.member), ...found.overlay.record }
        : memberRecord(found.member);
      const next = { ...current };
      for (const key of ['nickname', 'name', 'email', 'notes', 'preferredChannel'] as const) {
        if (body[key] !== undefined)
          next[key] = key === 'nickname' ? String(body.nickname).trim() : (body[key] ?? null);
      }
      await this.produce(
        station,
        caller,
        { type: factType, payload: { ...body, memberId: found.id }, actionId },
        {
          kind: 'member',
          entityId: found.id,
          memberId: found.id,
          phone: found.member.phone || null,
          record: next,
        },
      );
      return { member: await this.present(found.member, [], found.source) };
    }

    if (type === 'member.tier_change') {
      const parsed = OfflineMemberTierChangedSchema.safeParse(payload);
      if (!parsed.success) invalid(parsed.error);
      const body = parsed.data!;
      this.require(
        caller,
        body.direction === 'upgrade' ? 'pos:member:update' : 'pos:member:tier_downgrade',
      );
      const found = await this.resolveMember(body.memberId);
      if (!found) throw new BridgeError(404, 'NOT_FOUND', 'Member not found');
      const current = found.overlay
        ? { ...memberRecord(found.member), ...found.overlay.record }
        : memberRecord(found.member);
      let toTier: string;
      if (body.direction === 'upgrade') {
        if (!TIER_PROOF_TYPES.some((type) => type === body.evidenceType)) {
          throw new BridgeError(400, 'VALIDATION', 'Select Passport, Residence certificate or School card.');
        }
        if (!(await this.tierCodes()).includes(body.toTier)) {
          throw new BridgeError(400, 'VALIDATION', `Unknown tier "${body.toTier}"`);
        }
        const today = this.host.now().toISOString().slice(0, 10);
        if (body.evidenceExpiresAt && body.evidenceExpiresAt < today) {
          throw new BridgeError(
            400,
            'VALIDATION',
            'The document has already expired — it cannot verify a discounted rate',
          );
        }
        toTier = body.toTier;
      } else {
        toTier = await this.defaultTier();
        if (current.tierCode === toTier) {
          throw new BridgeError(
            409,
            'TIER_NOT_VERIFIED',
            'This member is already on the baseline rate — there is no verified tier to take back',
          );
        }
      }
      await this.produce(
        station,
        caller,
        { type: factType, payload: { ...body, memberId: found.id }, actionId },
        {
          kind: 'member',
          entityId: found.id,
          memberId: found.id,
          phone: found.member.phone || null,
          record: { ...current, tierCode: toTier },
        },
      );
      return { member: await this.present(found.member, [], found.source) };
    }

    if (type === 'child.create') {
      this.require(caller, 'pos:child:create');
      const parsed = OfflineChildCreatedSchema.safeParse(payload);
      if (!parsed.success) invalid(parsed.error);
      const body = parsed.data!;
      const found = await this.resolveMember(body.memberId);
      if (!found) throw new BridgeError(404, 'NOT_FOUND', 'Member not found');
      const again = await this.host.store.readOverlay(this.host.boxId, 'child', body.childId);
      if (again) return { child: childOf({ ...again.record, id: again.entityId }), replayed: true };
      if (found.member.children.some((c) => c.id === body.childId)) {
        throw new BridgeError(409, 'ID_IN_USE', 'That id already names another child');
      }
      const child: BridgeChild = {
        id: body.childId,
        name: body.name.trim(),
        dateOfBirth: body.dateOfBirth ?? null,
        ageYears: body.ageYears ?? null,
        allergies: body.allergies ?? null,
        medicalNotes: body.medicalNotes ?? null,
        medicalAlert: body.medicalAlert ?? Boolean(body.allergies),
        dietary: body.dietary ?? null,
        foodRestrictions: body.foodRestrictions ?? null,
        notes: body.notes ?? null,
        lastConfirmedAt: this.host.now().toISOString(),
      };
      // Named by the id the platform files it under — the survivor's, when the
      // family was signed up twice (OD-7).
      await this.produce(
        station,
        caller,
        { type: factType, payload: { ...body, memberId: found.id }, actionId },
        {
          kind: 'child',
          entityId: body.childId,
          memberId: found.id,
          phone: null,
          record: { ...child },
        },
      );
      return { child };
    }

    if (type === 'child.update') {
      this.require(caller, 'pos:child:update');
      const parsed = OfflineChildUpdatedSchema.safeParse(payload);
      if (!parsed.success) invalid(parsed.error);
      const body = parsed.data!;
      const located = await this.locateChild(body.childId);
      if (!located) throw new BridgeError(404, 'NOT_FOUND', 'Child not found');
      const next: Record<string, unknown> = { ...located.child };
      for (const key of Object.keys(body) as Array<keyof typeof body>) {
        if (key === 'childId' || key === 'offlineFresh') continue;
        if (body[key] !== undefined)
          next[key] = key === 'name' ? String(body.name).trim() : (body[key] ?? null);
      }
      if (body.allergies !== undefined && body.medicalAlert === undefined)
        next.medicalAlert = Boolean(body.allergies);
      next.lastConfirmedAt = this.host.now().toISOString();
      await this.produce(
        station,
        caller,
        { type: factType, payload: body, actionId },
        {
          kind: 'child',
          entityId: body.childId,
          memberId: located.memberId,
          phone: null,
          record: next,
        },
      );
      return { child: childOf({ ...next, id: body.childId }) };
    }

    // visit.create
    this.require(caller, 'pos:visit:create');
    const parsed = OfflineVisitCreatedSchema.safeParse({
      ...payload,
      visitDate: payload.visitDate ?? this.tradingDay(),
    });
    if (!parsed.success) invalid(parsed.error);
    const body = parsed.data!;
    let memberId: string | null = null;
    if (body.memberId) {
      const found = await this.resolveMember(body.memberId);
      if (!found) throw new BridgeError(404, 'NOT_FOUND', 'Member not found');
      memberId = found.id;
      const shown = await this.present(found.member, [], found.source);
      const saved = new Set(shown.children.map((c) => c.id));
      if (body.childIds.some((id) => !saved.has(id))) {
        throw new BridgeError(
          400,
          'VALIDATION',
          "One or more children are not on this member's saved list",
        );
      }
    } else if (body.childIds.length > 0) {
      throw new BridgeError(
        400,
        'VALIDATION',
        'Children on a visit need the member they are saved against',
      );
    }
    const again = await this.host.store.readOverlay(this.host.boxId, 'visit', body.visitId);
    if (again)
      return { id: body.visitId, visitDate: body.visitDate, status: body.status, replayed: true };
    await this.produce(
      station,
      caller,
      { type: factType, payload: { ...body, memberId }, actionId },
      {
        kind: 'visit',
        entityId: body.visitId,
        memberId,
        phone: null,
        record: {
          id: body.visitId,
          memberId,
          visitDate: body.visitDate,
          status: body.status,
          childIds: body.childIds,
        },
      },
    );
    return { id: body.visitId, visitDate: body.visitDate, status: body.status };
  }

  private async locateChild(
    childId: string,
  ): Promise<{ child: BridgeChild; memberId: string } | null> {
    const offline = await this.host.store.readOverlay(this.host.boxId, 'child', childId);
    const { members } = await this.cachedMembers();
    const owner = members.find((m) => m.children.some((c) => c.id === childId));
    const cached = owner?.children.find((c) => c.id === childId);
    if (offline) {
      const child = childOf({ ...(cached ?? {}), ...offline.record, id: childId });
      const memberId = offline.memberId ?? owner?.id;
      return child && memberId ? { child, memberId } : null;
    }
    return cached && owner ? { child: cached, memberId: owner.id } : null;
  }

  private async catalogueItem(): Promise<Record<string, unknown> | null> {
    return rec(itemsOf(await this.bundle('catalogue'))[0]);
  }

  private async assertOtherTender(method: string): Promise<void> {
    const catalogue = await this.catalogueItem();
    const methods = Array.isArray(catalogue?.paymentMethods) ? catalogue.paymentMethods.map(rec) : [];
    if (!methods.some((row) => row?.code === method && row.kind === 'other' && row.enabled === true)) {
      throw new BridgeError(409, 'PAYMENT_METHOD_UNAVAILABLE', 'Choose an enabled Other payment method from this box\'s current catalogue');
    }
  }

  private async tierCodes(): Promise<string[]> {
    const item = await this.catalogueItem();
    return (Array.isArray(item?.tiers) ? item.tiers : [])
      .map(rec)
      .filter((t): t is Record<string, unknown> => !!t && !t.archivedAt)
      .map((t) => s(t.code))
      .filter((c): c is string => !!c);
  }

  private async defaultTier(): Promise<string> {
    const item = await this.catalogueItem();
    const tiers = (Array.isArray(item?.tiers) ? item.tiers : []).map(rec);
    return s(tiers.find((t) => t && !t.archivedAt && t.isDefault === true)?.code) ?? 'tourist';
  }

  private tradingDay(): string {
    const branch = this.host.branch();
    const now = this.host.now();
    return branch
      ? businessDate(now, branch.timezone, parseDayStart(branch.businessDayStart))
      : now.toISOString().slice(0, 10);
  }

  // --- selling (plan §2.4, Round 4) ------------------------------------------------------------

  private refuse(which: BoxLaneRefusal, details?: Record<string, unknown>): never {
    const refusal = BOX_LANE_REFUSALS[which];
    throw new BridgeError(409, refusal.code, refusal.message, details);
  }

  /** The box's sale queue, or the polite refusal where nothing here can write a sale. */
  private saleQueue(): SaleQueue {
    const queue = this.host.sales?.() ?? null;
    if (!queue) {
      throw new BridgeError(503, BOX_LANE_PAYMENT_REFUSAL.code, BOX_LANE_PAYMENT_REFUSAL.message);
    }
    return queue;
  }

  private parse<T>(
    schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: unknown } },
    payload: unknown,
  ): T {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new BridgeError(400, 'VALIDATION', 'That request could not be read', {
        issue: String(parsed.error),
      });
    }
    return parsed.data;
  }

  private async sell(
    station: BridgeStation,
    caller: BridgeTillCaller,
    intent: StationIntent,
  ): Promise<Record<string, unknown>> {
    switch (intent.type) {
      case BRIDGE_SALE_INTENTS.finalise:
        return { ...(await this.finaliseSale(station, caller, intent.payload)) };
      case BRIDGE_SALE_INTENTS.paymentStart:
        return { ...(await this.startPayment(station, caller, intent.payload)) };
      case BRIDGE_SALE_INTENTS.paymentInquire:
        return { ...(await this.inquirePayment(station, caller, intent.payload)) };
      case BRIDGE_SALE_INTENTS.paymentConfirm:
        return { ...(await this.confirmPayment(station, caller, intent.payload)) };
      case BRIDGE_SALE_INTENTS.paymentStatus:
        return { ...(await this.paymentStatus(station, caller, intent.payload)) };
      case BRIDGE_SALE_INTENTS.reprint:
        return this.reprintSale(caller, intent.payload, intent.actionId ?? null);
      default:
        throw new BridgeError(409, BOX_LANE_PAYMENT_REFUSAL.code, BOX_LANE_PAYMENT_REFUSAL.message);
    }
  }

  /**
   * Price the sale on the box, line it as the ledger will, and plan its bands.
   *
   * On this lane the box's figure authorises taking money (`ARCHITECTURE.md`
   * §17): the cart is priced again from the box's own catalogue with the one
   * satang engine, and a till that saw a different total is refused before
   * anything is numbered or taken — the platform's rule 1, held at the
   * counter rather than discovered at sync.
   */
  private async prepareSale(
    station: BridgeStation,
    caller: BridgeTillCaller,
    body: BridgeSaleFinalise | BridgePaymentStart,
    /**
     * `at`: price as at this moment rather than now — a held tender is closed at
     * the price it was charged at. `overlay`: the prices a booking was PAID at,
     * laid over the catalogue (S2-12 round 5), so a redemption is never
     * re-priced from today's list. `redeeming`: this is `booking.redeem`'s own
     * sale, the one cart allowed to name a booking.
     */
    opts: {
      at?: Date;
      overlay?: (catalogue: OfflineCatalogue) => OfflineCatalogue;
      redeeming?: boolean;
      /**
       * S2-14b round 3 — the stock guard. `refuse` (the default for a fresh
       * press) refuses a cart the box's snapshot cannot fill before anything
       * is numbered or taken; `skip` (a held tender closed at the price it was
       * charged, a booking's redemption, credit already written ahead) only
       * plans what the sale takes, as the platform skips its guard for a
       * booking or an offline replay — the money is already promised.
       */
      stockGuard?: 'refuse' | 'skip';
    } = {},
  ): Promise<PreparedSale> {
    // S2-12 closing audit — the booking marker is what the platform reads to
    // file a box's sale as a booking's redemption, settled paid online. Only
    // `booking.redeem` may write it: on an ordinary cart it would turn cash
    // into a redemption the caller was never allowed to make.
    if (!opts.redeeming && cartNamesBooking(body.cart)) {
      throw new BridgeError(
        400,
        'SALE_CART_NAMES_BOOKING',
        'This cart names an online booking. Redeem the booking with Confirm & Issue instead of ringing it up as a sale.',
      );
    }
    const policy = await this.policy(station.id);
    const bundle = await this.bundle('catalogue');
    const now = opts.at ?? this.host.now();
    if (catalogueState(bundle?.appliedAt ?? null, now, policy) === 'refused') {
      throw new BridgeError(409, BOX_CATALOGUE_TOO_OLD.code, BOX_CATALOGUE_TOO_OLD.message, {
        appliedAt: bundle?.appliedAt ?? null,
      });
    }
    const read = readOfflineCatalogue(bundle?.payload ?? null);
    const catalogue = read && opts.overlay ? opts.overlay(read) : read;
    if (!catalogue) {
      throw new BridgeError(
        409,
        'BOX_CATALOGUE_MISSING',
        'This counter has no copy of the prices yet — connect it to the internet once.',
      );
    }
    const branch = this.host.branch();
    if (!branch) {
      throw new BridgeError(409, 'BOX_NOT_CONFIGURED', 'This counter has no branch configuration yet');
    }
    let cart: BridgeCart;
    try {
      cart = bridgeCartOf(body.cart);
    } catch (err) {
      throw new BridgeError(400, 'VALIDATION', 'That cart could not be read', { issue: String(err) });
    }
    // Money already taken for this sale (a tender approved, credit held, a
    // booking paid): its food is recorded as served, never refused now.
    const moneyTaken = !!opts.at || !!opts.redeeming || opts.stockGuard === 'skip';
    const food = await this.foodOrder(station, cart, catalogue, moneyTaken ? 'record' : 'strict');
    if (cart.expectedTotalSatang === undefined) {
      throw new BridgeError(
        400,
        'VALIDATION',
        'The till has to say what it is charging for this cart before the box can take the money',
      );
    }
    if (cart.manualDiscounts.length > 0) this.require(caller, 'pos:sale:discount');
    // S2-21 round 3 — a staff benefit is applied by whoever may apply one.
    if (cart.benefit) this.require(caller, 'pos:benefit:apply');

    const owner = cart.memberId ? await this.resolveMember(cart.memberId) : null;
    if (cart.memberId && !owner) throw new BridgeError(404, 'NOT_FOUND', 'Member not found');
    const memberTier = owner ? (s(owner.overlay?.record.tierCode) ?? owner.member.tierCode) : null;
    const benefit = await this.benefitOnBox(cart, branch, now);

    let pricing: OfflineSalePricing;
    try {
      pricing = priceOfflineSale(catalogue, cart, {
        now,
        timezone: branch.timezone,
        businessDayStart: branch.businessDayStart,
        memberTier,
        prepaid: food.prepaid,
        benefit,
      });
    } catch (err) {
      if (err instanceof OfflinePriceError) {
        if (err.code === 'VOUCHER_NEEDS_INTERNET') this.refuse('voucher');
        throw new BridgeError(
          err.code === 'SALE_LINE_PRICE_MISMATCH' || err.code.startsWith('BENEFIT_') ? 409 : 400,
          err.code,
          err.message,
          err.details,
        );
      }
      throw err;
    }
    if (!moneyTaken) assertFoodConsent(food, pricing.items);
    const gross = pricing.quote.totals.grossSatang;
    if (cart.expectedTotalSatang !== gross) {
      throw new BridgeError(
        409,
        'SALE_TOTAL_MISMATCH',
        'The till and this counter priced the cart differently — nothing was taken. Refresh the order and try again.',
        { expectedTotalSatang: cart.expectedTotalSatang, boxTotalSatang: gross },
      );
    }
    const hasFnb = [...pricing.items.values()].some((item) => item.kind === 'fnb_item');
    const pickupCode = cart.pickupCode?.trim() || null;
    if (hasFnb && !pickupCode) {
      throw new BridgeError(
        400,
        'PICKUP_CODE_REQUIRED',
        'An order with food on it needs its pick-up code before it is paid',
      );
    }

    const lines = offlineLedgerLines(body.saleId, catalogue, pricing, pickupCode);
    const shown = owner ? await this.present(owner.member, [], owner.source) : null;
    const byId = new Map((shown?.children ?? []).map((c) => [c.id, c]));
    const visitChildIds = await this.visitChildIds(body.visitId ?? null, body.visitChildIds);
    /**
     * S2-13 round 4: THE SUPERVISED CHILDREN'S LINES, which finalisation
     * leaves alone, as the platform's does (`mintSaleBands`). A drop-off or
     * nanny child's line carries its stay's id, and its band waits for "Check
     * in now" (`checkin-desk.ts`), which mints and prints it; "Leave as
     * booked" mints none. Their children are not handed another line's band.
     */
    const cartLineIds = [...new Set(lines.map((l) => l.cartLineId).filter((id): id is string => !!id))];
    const supervised = await this.desk.supervisedLineIds(cartLineIds);
    const supervisedChildren = await this.desk.supervisedChildIds([...supervised]);
    const banded = visitChildIds
      .filter((id) => !supervisedChildren.has(id))
      .map((id) => byId.get(id))
      .filter((c): c is BridgeChild => !!c);
    let nextChild = 0;
    const bandPlan: OfflineBandPlan[] = [];
    const deferredBands: DeferredBand[] = [];
    for (const planned of planLedgerBands(lines)) {
      const cartLineId = planned.cartLineId ?? '';
      if (planned.kind === 'kid' && supervised.has(cartLineId)) {
        const line = lines.find((l) => l.id === planned.saleLineId);
        deferredBands.push({
          kind: 'kid',
          cartLineId,
          saleLineId: planned.saleLineId,
          childId: null,
          childName: null,
          allergies: null,
          medicalNotes: null,
          dietary: null,
          stayHours: line?.stayHours ?? null,
        });
        continue;
      }
      const child = planned.kind === 'kid' ? (banded[nextChild++] ?? null) : null;
      bandPlan.push({
        kind: planned.kind,
        cartLineId,
        saleLineId: planned.saleLineId,
        gateAccess: planned.gateAccess,
        childId: child?.id ?? null,
        childName: child?.name ?? null,
        allergies: child?.allergies ?? null,
        medicalNotes: child?.medicalNotes ?? null,
        dietary: child?.dietary ?? null,
      });
    }
    const stock = await this.stockFor(
      cart,
      opts.stockGuard ?? (opts.at || opts.redeeming ? 'skip' : 'refuse'),
      now,
    );
    const orderChildren = (body.visitId ? banded : [...(shown?.children ?? [])])
      .map((c) => ({ name: c.name, allergies: c.allergies, medicalNotes: c.medicalNotes }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const header = rec((await this.catalogueItem())?.receiptHeader);
    const sent = body.cart as Record<string, unknown>;
    const inner = rec(sent.cart);
    // S2-21 round 3 — the staff benefit QR the till sent stops here: the fact
    // carries what this box applied (`benefitRecord`), never the credential.
    const { benefit: _scannedQr, ...sentCart }: Record<string, unknown> = inner ?? sent;
    return {
      cart,
      catalogue,
      pricing,
      lines,
      gross,
      businessDate: pricing.quote.businessDate,
      memberId: owner?.id ?? null,
      bandPlan,
      deferredBands,
      snapshot: {
        timezone: branch.timezone,
        operatorName: s(header?.operatorName),
        branchName: s(header?.name),
        staffName: body.staffName ?? null,
        memberNickname: shown?.nickname ?? null,
        lines: lines.map((line) => ({
          id: line.id,
          kind: line.kind,
          label: line.label,
          quantity: line.quantity,
          grossSatang: line.grossSatang,
          ticket: line.ticket,
          payload: line.payload,
          stayHours: line.stayHours,
          stayDurationLabel: line.stayDurationLabel,
        })),
        subtotalSatang: pricing.quote.totals.subtotalSatang,
        grossSatang: gross,
        taxBreakdown: pricing.totals.taxBreakdown,
        orderChildren,
        // The prep ticket prints the band holder's own name and allergy line, as online.
        bandHolder: food.holder ? { name: food.holder.childName, allergiesMedical: food.holder.allergiesMedical } : null,
        note: body.note ?? null,
      },
      factCart: {
        ...sentCart,
        ...(pricing.benefitRecord ? { benefit: pricing.benefitRecord } : {}),
        // The survivor's id when the family was signed up twice (OD-7).
        ...(owner ? { memberId: owner.id } : {}),
        ...(body.visitId ? { visitId: body.visitId } : {}),
        ...(body.note ? { note: body.note } : {}),
        expectedTotalSatang: gross,
      },
      stock,
      food,
    };
  }

  // --- counted stock on the box lane (S2-14b round 3) ----------------------------------------

  /** The `stock` scope as this box holds it, with when it was written. */
  private async stockSnapshot(): Promise<{ snapshot: StockSnapshotItem | null; appliedAt: string | null }> {
    const bundle = await this.bundle('stock');
    return { snapshot: bundle ? readStockSnapshot(bundle.payload) : null, appliedAt: bundle?.appliedAt ?? null };
  }

  /**
   * This box's own counted sales of one size that the snapshot does not yet
   * reflect: the open shares whose journal position is above its filed mark,
   * judged against the epoch the box seals on now (`shareReflected`).
   * A first look, before the sale's transaction; `takeStockAhead` asks again
   * inside it, under the size's lock, and that answer is the one that holds.
   */
  private async unreflectedOnBox(stockItemId: string, mark: StockFiledMark | null): Promise<number> {
    if (!this.host.store.features().boothRuntime) return 0;
    const raw = await this.host.store.readRuntimeValue(this.host.boxId, stockOpenKey(stockItemId)).catch(() => null);
    const boxEpoch = await this.host.store
      .readState(this.host.boxId)
      .then((state) => state.journalEpoch)
      .catch(() => null);
    return unreflectedUnits(readStockShares(raw), mark, boxEpoch);
  }

  /**
   * THE GUARD, on the box: the counted sizes this cart takes, refused in the
   * counter's words when the snapshot less this box's own sales since cannot
   * fill them (`stock-lane.ts`).
   *
   * WHAT IS COUNTED. With a fresh snapshot (younger than
   * `STOCK_SNAPSHOT_REFUSE_AFTER_S`) the snapshot alone decides, exactly as the
   * platform does: an active stock item at this branch. A product it does not
   * stock — tracking switched off, or counted only at another branch — sells
   * uncounted. The catalogue's `stockItemId` marker is one column per product
   * (operator-wide) and survives tracking being switched off, so it is used
   * only when there is no fresh snapshot.
   *
   * HONEST WHEN IT CANNOT KNOW. With no snapshot, a stale one, or a store that
   * cannot keep a count, an item the old snapshot or the catalogue marker calls
   * counted is refused, never silently allowed. An item nobody counts sells as
   * it always did. `skip` plans without refusing anything.
   */
  private async stockFor(cart: BridgeCart, guard: 'refuse' | 'skip', now: Date): Promise<BoxStock> {
    const item = await this.catalogueItem();
    const rows = (Array.isArray(item?.products) ? item.products : [])
      .map(rec)
      .filter((p): p is Record<string, unknown> => !!p && !p.archivedAt);
    const byId = new Map(rows.map((p) => [s(p.id) ?? '', p]));
    const productOf = (id: string) => {
      const row = byId.get(id);
      return row ? { id, name: s(row.name) ?? 'This item' } : null;
    };
    const socksAddOn = cart.socks?.addOnId ?? null;
    const socksProductId = socksAddOn
      ? (productOf(socksAddOn)?.id ?? (socksAddOn === PROTOTYPE_SOCKS_ADD_ON_ID ? await this.socksProductId() : null))
      : null;
    const asks = stockAsksOf(cart, { socksProductId, productOf });
    const { snapshot, appliedAt } = await this.stockSnapshot();
    if (asks.length === 0) return { snapshot, demand: new Map() };
    if (guard === 'skip') return { snapshot, demand: snapshot ? planStock(asks, snapshot).demand : new Map() };

    const inSnapshot = new Set((snapshot?.items ?? []).map((e) => e.productId));
    const runtime = this.host.store.features().boothRuntime;
    const age = ageOf(appliedAt, now);
    const fresh = runtime && !!snapshot && age !== null && age < STOCK_SNAPSHOT_REFUSE_AFTER_S;
    if (!fresh) {
      // No trustworthy count: the catalogue's operator-wide marker is the only
      // hint left, so anything it (or an old copy) calls counted is refused.
      const tracked = asks.filter((a) => inSnapshot.has(a.productId) || !!s(byId.get(a.productId)?.stockItemId));
      if (tracked.length > 0) {
        const names = [...new Set(tracked.map((a) => a.label))];
        if (!runtime || !snapshot) {
          throw new BridgeError(409, BOX_STOCK_REFUSALS.unknown.code, BOX_STOCK_REFUSALS.unknown.message, { items: names });
        }
        throw new BridgeError(409, BOX_STOCK_REFUSALS.stale.code, BOX_STOCK_REFUSALS.stale.message, {
          appliedAt,
          items: names,
        });
      }
    }
    // A fresh snapshot alone decides what is counted here — the platform's
    // rule (an ACTIVE stock item at THIS branch). A product it does not stock
    // sells uncounted, as the platform sells it.
    if (!snapshot) return { snapshot, demand: new Map() };
    const plan = planStock(asks, snapshot);
    if (plan.sizeProblems.length > 0) {
      throw new BridgeError(409, BOX_STOCK_REFUSALS.size.code, stockSizeRefusal(plan.sizeProblems), {
        problems: plan.sizeProblems,
      });
    }
    const unreflected = new Map<string, number>();
    for (const id of plan.demand.keys()) unreflected.set(id, await this.unreflectedOnBox(id, snapshot.boxFiled));
    const shortages = stockShortages(plan.demand, snapshot, (id) => unreflected.get(id) ?? 0);
    if (shortages.length > 0) {
      throw new BridgeError(409, BOX_STOCK_REFUSALS.short.code, stockShortRefusal(shortages), { shortages });
    }
    return { snapshot, demand: plan.demand };
  }

  /**
   * THE BOX'S OWN DECREMENT, WRITTEN AHEAD: in the sale's store transaction,
   * once its facts are queued, each size's open shares gain this sale's share
   * WITH THE SALE'S JOURNAL POSITION (the highest of its facts) — all or
   * nothing with the sale, its number and its fact. The size's all-days count
   * is bumped first, one statement per size in a fixed order: that row is the
   * lock that makes two tills on this box selling the last unit at once
   * queue, so the second reads the first's share. Under `refuse` the open
   * shares above the snapshot's mark are checked again and a sale that no
   * longer fits rolls back with everything else. Under `record` (money already
   * taken) it never refuses — the platform records the shortfall when the sale
   * arrives. Shares the snapshot already reflects are dropped as it writes.
   */
  private async takeStockAhead(
    tx: BoxStore,
    stock: BoxStock,
    mode: 'refuse' | 'record',
    sale: { saleId: string; at: string; records: readonly OutboxRecord[] },
  ): Promise<void> {
    const snapshot = stock.snapshot;
    if (!snapshot || stock.demand.size === 0 || !tx.features().boothRuntime) return;
    const position = await this.positionOf(tx, sale.records);
    const mark = snapshot.boxFiled;
    // The epoch this box seals on NOW: a share on it is reflected only by a
    // mark on the same epoch (`shareReflected`), so a snapshot whose mark is on
    // an epoch the box has not adopted neither hides this box's sales nor
    // prunes the share this sale writes.
    const boxEpoch = (await tx.readState(this.host.boxId)).journalEpoch;
    const shortages: StockShortage[] = [];
    const shares: Array<{ stockItemId: string; quantity: number; takenOnBox: number }> = [];
    for (const [stockItemId, quantity] of [...stock.demand].sort(([a], [b]) => a.localeCompare(b))) {
      const after = await tx.bumpCounter(
        this.host.boxId,
        { scope: STOCK_TAKEN_TOTAL_SCOPE, key: stockItemId, businessDate: STOCK_TAKEN_TOTAL_DAY },
        quantity,
        sale.at,
      );
      shares.push({ stockItemId, quantity, takenOnBox: after });
      const open = readStockShares(await tx.readRuntimeValue(this.host.boxId, stockOpenKey(stockItemId))).filter(
        (s) => s.saleId !== sale.saleId && !shareReflected(s, mark, boxEpoch),
      );
      const unreflected = unreflectedUnits(open, mark, boxEpoch);
      open.push({ saleId: sale.saleId, journalEpoch: position.journalEpoch, boxSeq: position.boxSeq, quantity });
      await tx.writeRuntimeValue(this.host.boxId, stockOpenKey(stockItemId), JSON.stringify(open), sale.at);
      if (mode !== 'refuse') continue;
      const entry = snapshot.items.find((e) => e.stockItemId === stockItemId);
      if (!entry) continue;
      const available = stockAvailable(entry, unreflected);
      if (quantity > available) {
        shortages.push({
          stockItemId,
          name: entry.sizeLabel ? `${entry.itemName} ${entry.sizeLabel}` : entry.itemName,
          requested: quantity,
          available,
        });
      }
    }
    if (shortages.length > 0) {
      throw new BridgeError(409, BOX_STOCK_REFUSALS.short.code, stockShortRefusal(shortages), { shortages });
    }
    await tx.writeRuntimeValue(
      this.host.boxId,
      stockTakenKey(sale.saleId),
      JSON.stringify({ at: sale.at, snapshotVersion: snapshot.version, ...position, shares }),
      sale.at,
    );
  }

  /**
   * SCRUM-502 — TWO PRESSES FOR THE LAST PREPAID MEAL AT ONCE.
   *
   * A Pi's store is one SQLite connection with one writer at a time, so the
   * second press's transaction cannot open while the first press's is open, and
   * its till was shown the store's own error instead of the counter's answer.
   * Nothing of that press was written, so a sale that serves prepaid food waits
   * its turn and is recorded again: the prepaid count is then read after the
   * first press, and the counter's own rule decides — the meal is served, or it
   * was the last one and the press is refused as already served, in the
   * counter's words (`servePrepaidAhead`). Every other sale, and every other
   * fault, is answered as before. The wait is bounded like the store's own busy
   * wait (`busy_timeout`, five seconds); a store still busy after it says so.
   */
  private async recordInTurn(food: BoxFoodOrder, record: () => Promise<OfflineSaleAnswer>): Promise<OfflineSaleAnswer> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await record();
      } catch (err) {
        if (food.prepaid.size === 0 || !sqliteWriterBusy(err) || attempt >= PREPAID_TURN_ATTEMPTS) throw err;
        await new Promise((resolve) => setTimeout(resolve, PREPAID_TURN_WAIT_MS));
      }
    }
  }

  /** SCRUM-498 — the prepaid units the sale serves, counted in its transaction (`CheckinDesk.servePrepaidAhead`). */
  private async servePrepaidAhead(tx: BoxStore, food: BoxFoodOrder, mode: 'refuse' | 'record', at: string): Promise<void> {
    try {
      await this.desk.servePrepaidAhead(tx, food, mode, at);
    } catch (err) {
      if (err instanceof DeskRefusal) throw new BridgeError(err.status, err.code, err.message, err.details);
      throw err;
    }
  }

  /**
   * Where a sale sits in this box's journal: its epoch and the HIGHEST
   * position its facts took — the platform holds the sale whole (a wallet's
   * credit closing it included) only once its mark reaches the last of them.
   * From the box's own state when the queue returned nothing to read.
   */
  private async positionOf(tx: BoxStore, records: readonly OutboxRecord[]): Promise<StockFiledMark> {
    let top: StockFiledMark | null = null;
    for (const r of records) {
      if (!top || r.envelope.boxSeq > top.boxSeq) top = { journalEpoch: r.envelope.journalEpoch, boxSeq: r.envelope.boxSeq };
    }
    if (top) return top;
    const state = await tx.readState(this.host.boxId);
    return { journalEpoch: state.journalEpoch, boxSeq: Math.max(1, state.nextBoxSeq) };
  }

  /** The children a sale's visit names: the visit this counter recorded, else what the till confirmed. */
  private async visitChildIds(
    visitId: string | null,
    fromTill: readonly string[] | undefined,
  ): Promise<string[]> {
    if (visitId) {
      const held = await this.host.store
        .readOverlay(this.host.boxId, 'visit', visitId)
        .catch(() => null);
      const ids = held?.record.childIds;
      if (Array.isArray(ids)) return ids.filter((id): id is string => typeof id === 'string');
    }
    return [...(fromTill ?? [])];
  }

  /** The sale as the till's `ApiSale` reads it, before it has its number. */
  private saleViewOf(
    station: BridgeStation,
    saleId: string,
    sale: PreparedSale,
    at: string,
  ): SaleMemo['view'] {
    const quote = sale.pricing.quote;
    return {
      id: saleId,
      businessDate: quote.businessDate,
      occurredAt: at,
      stationId: station.id,
      boxId: this.host.boxId,
      pricingMode: quote.pricingMode,
      customerTier: quote.customerTier,
      totals: quote.totals,
      engineVersion: quote.engineVersion,
      origin: 'box',
    };
  }

  private attemptView(input: {
    attemptId: string;
    saleId: string;
    kind: 'cash' | 'card' | 'qr' | 'other';
    provider: PaymentProvider;
    status: PaymentAttemptStatus;
    amountSatang: number;
    tenderedSatang?: number | null;
    changeSatang?: number | null;
    terminalRef?: string | null;
    tid?: string | null;
    approvalCode?: string | null;
    last4?: string | null;
    invoiceNo?: string | null;
    tranRef?: string | null;
    actionId: string;
    inquirySupported?: boolean;
    reversalPending?: boolean;
    paidAt: string | null;
    createdAt: string;
  }): PaymentAttemptView {
    return {
      id: input.attemptId,
      saleId: input.saleId,
      method: input.kind as PaymentMethod,
      provider: input.provider,
      status: input.status,
      amountSatang: input.amountSatang,
      tenderedSatang: input.tenderedSatang ?? null,
      changeSatang: input.changeSatang ?? null,
      terminalRef: input.terminalRef ?? null,
      ...(input.inquirySupported === undefined ? {} : { inquirySupported: input.inquirySupported }),
      ...(input.reversalPending ? { reversalPending: true } : {}),
      tid: input.tid ?? null,
      approvalCode: input.approvalCode ?? null,
      last4: input.last4 ?? null,
      invoiceNo: input.invoiceNo ?? null,
      tranRef: input.tranRef ?? null,
      actionId: input.actionId,
      offline: true,
      paidAt: input.paidAt,
      createdAt: input.createdAt,
    };
  }

  /** The till's answer, from what the queue recorded and the memo kept beside it. */
  private answerOf(
    recorded: Pick<
      OfflineSaleAnswer,
      'receipt' | 'replay' | 'printing' | 'drawer' | 'outboxDepth' | 'memo' | 'bands'
    >,
  ): BridgeSaleAnswer {
    const memo = recorded.memo as unknown as SaleMemo | null;
    if (!memo?.view) {
      throw new BridgeError(
        409,
        'SALE_NOT_FROM_BRIDGE',
        'That sale was recorded on this box by something other than a till',
      );
    }
    return {
      // S2-14a round 4: the credit it took, as the platform's wallet answer carries it.
      ...(memo.wallet ? { walletSpend: memo.wallet.spend, walletAttempt: memo.wallet.attempt } : {}),
      sale: {
        ...memo.view,
        status: 'finalised',
        receiptNumber: recorded.receipt?.number ?? null,
        receiptSeries: recorded.receipt?.series ?? null,
        receiptSeq: recorded.receipt?.seq ?? null,
      },
      finalised: true,
      outstandingSatang: 0,
      attempt: memo.attempt,
      replay: recorded.replay,
      printing: {
        jobs: recorded.printing.jobs.map((job) => ({ id: job.id, kind: job.kind, status: job.status })),
        notes: recorded.printing.notes,
      },
      drawer: recorded.drawer,
      outboxDepth: recorded.outboxDepth,
      // The band codes, so the confirmation reads them on the box lane where the
      // platform's sale read cannot be reached: the SHORT code the guest holds,
      // never the signed one, with the child it names and the cart line that
      // places it on its bracelet row.
      bands: (recorded.bands ?? []).map((band): BridgeSaleBand => ({
        id: band.id,
        kind: band.kind,
        status: 'active',
        shortCode: bandShortCode(band.code),
        cartLineId: band.cartLineId,
        saleLineId: band.saleLineId,
        childId: band.childId,
        childName: band.childName ?? null,
      })),
    };
  }

  /** The sale this box already took under this id, answered as it was the first time. */
  private async answerAgain(queue: SaleQueue, saleId: string): Promise<BridgeSaleAnswer | null> {
    const held = await queue.recorded(saleId);
    if (!held) return null;
    const depth = await this.host.store
      .depth(this.host.boxId)
      .catch(() => ({ queued: 0, oldestQueuedAt: null }));
    return this.answerOf({
      receipt: held.receipt,
      replay: true,
      printing: { jobs: held.jobs, notes: held.notes },
      drawer: 'not_asked',
      outboxDepth: depth.queued,
      memo: held.memo,
      bands: held.bands,
    });
  }

  /**
   * Record the sale and its money on the box: one transaction, then the
   * drawer, then the paper (`SaleQueue.record`).
   */
  private async closeSale(
    station: BridgeStation,
    caller: BridgeTillCaller,
    body: BridgeSaleFinalise | BridgePaymentStart,
    sale: PreparedSale,
    tenders: OfflineTenderFact[],
    attempt: PaymentAttemptView | null,
    /**
     * `at`: when the sale happened, if not now — a held tender closed after a
     * crash happened when it was paid. `alongside` and `wallet` (S2-14a round
     * 4): the credit this sale took offline, written and queued inside the
     * sale's own transaction, and kept in its log for a retried press.
     */
    opts: {
      at?: string;
      alongside?: OfflineSaleRequest['alongside'];
      wallet?: SaleMemo['wallet'];
      /**
       * S2-14b round 3 — the counted stock this sale takes, written ahead in
       * its transaction: `refuse` checks the count again (a fresh press, no
       * money taken yet); `record` (the default: a card approved, a booking,
       * credit already held) never refuses.
       */
      stock?: 'refuse' | 'record';
    } = {},
  ): Promise<BridgeSaleAnswer> {
    const queue = this.saleQueue();
    const stockMode = opts.stock ?? 'record';
    // The stock is taken once the sale's facts have their journal positions,
    // still inside the sale's own transaction: each share is kept with them.
    const at = opts.at ?? this.host.now().toISOString();
    const afterQueued: NonNullable<OfflineSaleRequest['afterQueued']> = async (tx, queued) => {
      await this.takeStockAhead(tx, sale.stock, stockMode, queued);
      await this.servePrepaidAhead(tx, sale.food, stockMode, at);
    };
    const memo: SaleMemo = {
      view: this.saleViewOf(station, body.saleId, sale, at),
      attempt,
      ...(sale.deferredBands.length > 0 ? { deferredBands: sale.deferredBands } : {}),
      ...(opts.wallet ? { wallet: opts.wallet } : {}),
    };
    // The credit prints above the cash, as the platform's receipt lists it.
    const printedTenders = [
      ...(opts.wallet
        ? [
            {
              method: WALLET_TENDER_CODE,
              last4: null,
              amountSatang: opts.wallet.spend.amountSatang,
              tenderedSatang: null,
              changeSatang: null,
            },
          ]
        : []),
      ...tenders.map((tender) => ({
        method: tender.methodCode,
        last4: tender.last4 ?? null,
        amountSatang: tender.amountSatang,
        tenderedSatang: tender.tenderedSatang ?? null,
        changeSatang: tender.changeSatang ?? null,
      })),
    ];
    let recorded: OfflineSaleAnswer;
    try {
      recorded = await this.recordInTurn(sale.food, () => queue.record({
        saleId: body.saleId,
        stationId: station.id,
        actorAccountId: caller.accountId,
        cart: sale.factCart,
        tenders,
        staffTokenJti: caller.jti,
        ...(caller.offlineFresh ? { offlineFresh: true } : {}),
        occurredAt: at,
        actionId: body.actionId,
        catalogueVersion: sale.pricing.basis.catalogueVersion,
        engineVersion: sale.pricing.quote.engineVersion,
        priceBasis: sale.pricing.basis as unknown as Record<string, unknown>,
        printout: {
          snapshot: {
            ...sale.snapshot,
            tenders: printedTenders,
          },
          bands: sale.bandPlan,
          businessDate: sale.businessDate,
        },
        memo: memo as unknown as Record<string, unknown>,
        ...(opts.alongside ? { alongside: opts.alongside } : {}),
        afterQueued,
      }));
    } catch (err) {
      if (err instanceof OfflineSaleRefused) this.refuse('voucher');
      if (err instanceof ReceiptSeriesUnavailable) {
        throw new BridgeError(409, err.code, err.message);
      }
      throw err;
    }
    return this.answerOf(recorded);
  }

  /** `sale.finalise`: cash, Other, or nothing at all for a ฿0 comp. */
  private async finaliseSale(
    station: BridgeStation,
    caller: BridgeTillCaller,
    payload: Record<string, unknown>,
  ): Promise<BridgeSaleAnswer> {
    this.require(caller, 'pos:sale:create');
    this.require(caller, 'pos:sale:update');
    const body = this.parse(BridgeSaleFinaliseSchema, payload);
    const queue = this.saleQueue();
    return this.holdingSale(
      body.saleId,
      async () => {
        const again = await this.answerAgain(queue, body.saleId);
        if (again) return again;
        throw paymentInFlight();
      },
      async () => {
        const again = await this.answerAgain(queue, body.saleId);
        if (again) return again;
        /**
         * A card or QR tender this box holds for the sale comes first. One the
         * terminal approved closes the sale with THAT money — the till lost the
         * answer, and cash on top would take the family's money twice. One
         * with no final answer yet refuses the cash, as the platform does
         * (PAYMENT_IN_FLIGHT): it may yet have taken the money.
         */
        const held = await this.readHeld(body.saleId);
        if (held && SETTLED.has(held.status)) return this.closeHeld(station, caller, held);
        if (held && UNRESOLVED.has(held.status)) throw paymentInFlight();
        return this.finaliseHeldSale(station, caller, body);
      },
    );
  }

  /** `sale.finalise` once the sale is in this call's hands. */
  private async finaliseHeldSale(
    station: BridgeStation,
    caller: BridgeTillCaller,
    body: BridgeSaleFinalise,
  ): Promise<BridgeSaleAnswer> {
    const tender = body.tender ?? null;
    if (tender && tender.amountSatang > 0) {
      if (tender.method === 'wallet' || tender.method === WALLET_TENDER_CODE) this.refuse('wallet');
      if (tender.method === PAID_ONLINE_TENDER_CODE) {
        throw new BridgeError(400, 'VALIDATION', 'Paid online is recorded only from a booking redemption');
      }
      if (tender.kind === 'card' || tender.kind === 'qr') {
        throw new BridgeError(
          400,
          'VALIDATION',
          'A card or a QR is taken on the counter’s terminal (payment.start), not recorded by hand',
        );
      }
      if (tender.kind !== 'cash' && tender.kind !== 'other') this.refuse('noTerminal');
      if (tender.kind === 'other' && (tender.method === 'cash' || tender.tenderedSatang !== undefined || tender.changeSatang !== undefined)) {
        throw new BridgeError(400, 'VALIDATION', 'Other payment must not carry cash received or change');
      }
      if (tender.kind === 'other') await this.assertOtherTender(tender.method);
    }
    /**
     * S2-14a round 4 — credit already written ahead for this sale on this box
     * (`payment.wallet` that did not cover it): the press that takes the rest
     * in cash closes the sale with both, the credit's fact queued behind it.
     * S2-14b round 3: that sale was guarded for stock when its credit was
     * taken, so it is not refused for stock now.
     */
    const hold = await this.readWalletHold(body.saleId);
    const sale = await this.prepareSale(station, caller, body, hold && !hold.closed ? { stockGuard: 'skip' } : {});
    if (hold && !hold.closed) return this.closeWithCredit(station, caller, body, sale, hold, tender, false);
    const now = this.host.now().toISOString();
    if (sale.gross === 0) {
      if (tender && tender.amountSatang > 0) {
        throw new BridgeError(
          400,
          'VALIDATION',
          'This sale owes nothing, so there is no payment to take',
        );
      }
      // A ฿0 comp: closed with no tender, as the platform closes one (S2-09a).
      return this.closeSale(station, caller, body, sale, [], null, { stock: 'refuse' });
    }
    if (!tender) {
      throw new BridgeError(400, 'VALIDATION', 'A sale that owes money needs its payment');
    }
    if (tender.amountSatang !== sale.gross) {
      this.refuse('split', { amountSatang: tender.amountSatang, grossSatang: sale.gross });
    }
    const handed = tender.kind === 'cash' ? (tender.tenderedSatang ?? sale.gross) : null;
    if (handed !== null && handed < sale.gross) {
      throw new BridgeError(
        400,
        'VALIDATION',
        'The cash taken is less than the amount being settled, so this would leave negative change',
      );
    }
    const fact: OfflineTenderFact = {
      actionId: tender.actionId,
      methodCode: tender.method,
      kind: tender.kind,
      provider: 'manual',
      amountSatang: sale.gross,
      ...(handed === null ? {} : { tenderedSatang: handed, changeSatang: handed - sale.gross }),
      paidAt: now,
    };
    const attempt = this.attemptView({
      attemptId: uuidv7(),
      saleId: body.saleId,
      kind: tender.kind,
      provider: 'manual',
      status: 'approved',
      amountSatang: sale.gross,
      ...(handed === null ? {} : { tenderedSatang: handed, changeSatang: handed - sale.gross }),
      actionId: tender.actionId,
      paidAt: now,
      createdAt: now,
    });
    return this.closeSale(station, caller, body, sale, [fact], attempt, { stock: 'refuse' });
  }

  // --- credit on the box lane, under the cap (S2-14a round 4) ------------------------------

  /**
   * A credit press and the sale's or the cash tender's press must be two
   * keys: the platform files the credit under its own action id, and a cash
   * tender already filed under the same id would read as the credit already
   * filed — the credit silently dropped, the sale left tendering (the round 4
   * gate's observation under invariant (2)). Refused before anything moves.
   */
  private refuseSharedPressKey(other: string, walletActionId: string): void {
    if (other === walletActionId) {
      throw new BridgeError(400, 'VALIDATION', 'The credit press needs an action id of its own, not the sale’s or the cash tender’s', {
        actionId: walletActionId,
      });
    }
  }

  /** Where a refusal of credit is said, in the counter's words. */
  private walletRefusal(refusal: OfflineSpendRefusal, at: WalletAtCounter, askedSatang?: number): never {
    switch (refusal) {
      case 'cap':
        throw new BridgeError(409, BOX_WALLET_REFUSALS.cap.code, walletOfflineCapMessage(at.capSatang), {
          walletId: at.wallet.id,
          capSatang: at.capSatang,
          capLeftSatang: at.allowance.capLeftSatang,
          spentTodaySatang: at.spentTodaySatang,
        });
      case 'empty':
        throw new BridgeError(409, 'WALLET_EMPTY', 'This wallet has ฿0 left — take the order in cash or card.', {
          walletId: at.wallet.id,
          balanceSatang: 0,
        });
      case 'insufficient':
        throw new BridgeError(
          409,
          'WALLET_INSUFFICIENT',
          `This wallet has ${formatTHB(at.allowance.balanceLeftSatang)} left, not ${formatTHB(askedSatang ?? 0)}.`,
          { walletId: at.wallet.id, balanceSatang: at.allowance.balanceLeftSatang, amountSatang: askedSatang ?? null },
        );
      default:
        throw new BridgeError(400, 'VALIDATION', 'That is more credit than this order owes.', {
          amountSatang: askedSatang ?? null,
        });
    }
  }

  /** The cap at this station: its own `offline_wallet_cap_satang` where set, else the branch policy's. */
  private async walletCap(stationId: string, snapshot: WalletSnapshotItem): Promise<number> {
    const config = await this.bundle('station_config');
    const entry = itemsOf(config)
      .map(rec)
      .find((row) => row?.id === stationId);
    const own = entry?.offlineWalletCapSatang;
    return typeof own === 'number' && Number.isSafeInteger(own) && own >= 0 ? own : snapshot.capSatang;
  }

  /**
   * THE WALLET A KEY NAMES, from the box's snapshot, with what it can spend
   * here now — or the honest refusal: no counter to count it on, no copy (or a
   * key the copy does not hold), a copy too old to trust, credit expired.
   */
  private async walletAt(station: BridgeStation, key: string): Promise<WalletAtCounter> {
    if (!this.host.store.features().boothRuntime) {
      throw new BridgeError(503, BOX_WALLET_REFUSALS.noCounter.code, BOX_WALLET_REFUSALS.noCounter.message);
    }
    const now = this.host.now();
    const bundle = await this.bundle('wallets');
    const snapshot = bundle ? readWalletSnapshot(bundle.payload) : null;
    if (!bundle || !snapshot) {
      throw new BridgeError(409, BOX_WALLET_REFUSALS.unknown.code, BOX_WALLET_REFUSALS.unknown.message);
    }
    // A re-bound box must not spend against the previous park's cap or day.
    // The wallet identities may be operator-wide, but this copy's policy is
    // always for the station that is taking the payment.
    if (snapshot.branchId !== station.branchId) {
      throw new BridgeError(409, BOX_WALLET_REFUSALS.stale.code, BOX_WALLET_REFUSALS.stale.message);
    }
    const age = ageOf(bundle.appliedAt, now);
    if (age === null || age >= WALLET_SNAPSHOT_REFUSE_AFTER_S) {
      throw new BridgeError(409, BOX_WALLET_REFUSALS.stale.code, BOX_WALLET_REFUSALS.stale.message, {
        appliedAt: bundle.appliedAt,
      });
    }
    const match = findSnapshotWallet(snapshot, key);
    if (!match || !('found' in match)) {
      throw new BridgeError(404, BOX_WALLET_REFUSALS.unknown.code, BOX_WALLET_REFUSALS.unknown.message);
    }
    const wallet = match.found;
    const expiresAt = wallet.expiresAt ? Date.parse(wallet.expiresAt) : null;
    if (wallet.status !== 'active' || (expiresAt !== null && Number.isFinite(expiresAt) && expiresAt <= now.getTime())) {
      throw new BridgeError(
        409,
        'WALLET_EXPIRED',
        `This wallet's credit has expired — only a manager can bring it back. Take the order in cash or card.`,
        { walletId: wallet.id },
      );
    }
    const capSatang = await this.walletCap(station.id, snapshot);
    const businessDate = this.tradingDay();
    // Two counts of this wallet on this box: today's, for the cap, and every
    // day's, for the snapshot — a day's turn with the link still down must
    // not forget yesterday's unsynced credit (the round 4 gate's REJECT 2).
    const spentTodaySatang = await this.host.store.readCounter(this.host.boxId, {
      scope: WALLET_SPEND_COUNTER_SCOPE,
      key: wallet.id,
      businessDate,
    });
    const spentOnBoxSatang = await this.host.store.readCounter(this.host.boxId, {
      scope: WALLET_SPEND_TOTAL_SCOPE,
      key: wallet.id,
      businessDate: WALLET_SPEND_TOTAL_DAY,
    });
    // What the platform had filed from this box, on any day, when the copy was built.
    const reflectedSatang = wallet.boxSpentSatang;
    return {
      snapshot,
      snapshotAt: bundle.appliedAt,
      wallet,
      capSatang,
      businessDate,
      spentTodaySatang,
      spentOnBoxSatang,
      reflectedSatang,
      allowance: offlineWalletAllowance({
        snapshotBalanceSatang: wallet.balanceSatang,
        reflectedSatang,
        spentOnBoxSatang,
        spentTodaySatang,
        capSatang,
      }),
    };
  }

  /** `wallet.lookup`: what a scanned key's wallet can spend at this counter right now. */
  private async walletLookup(
    station: BridgeStation,
    caller: BridgeTillCaller,
    payload: Record<string, unknown>,
  ): Promise<BridgeWalletBalance> {
    this.require(caller, 'pos:wallet:read');
    const body = this.parse(BridgeWalletLookupSchema, payload);
    const at = await this.walletAt(station, body.key);
    return {
      walletId: at.wallet.id,
      balanceSatang: at.allowance.balanceLeftSatang,
      capLeftSatang: at.allowance.capLeftSatang,
      capSatang: at.capSatang,
      spendableSatang: at.allowance.allowedSatang,
      snapshotAt: at.snapshotAt,
      source: 'snapshot',
    };
  }

  private async readWalletHold(saleId: string): Promise<WalletHold | null> {
    if (!this.host.store.features().boothRuntime) return null;
    const raw = await this.host.store.readRuntimeValue(this.host.boxId, walletHoldKey(saleId)).catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as WalletHold;
    } catch {
      return null;
    }
  }

  /**
   * COUNT IT, under the cap, in the caller's store transaction — and refuse,
   * rolling the count back with everything else, when the counter it moved
   * says this credit no longer fits. The bump is one statement, so two tills on
   * this box spending one wallet at once cannot both fit under one allowance.
   */
  private async countCredit(tx: BoxStore, hold: WalletHold): Promise<void> {
    const after = await tx.bumpCounter(
      this.host.boxId,
      { scope: WALLET_SPEND_COUNTER_SCOPE, key: hold.walletId, businessDate: hold.businessDate },
      hold.amountSatang,
      hold.at,
    );
    // The all-days count moves with the day's, in the same transaction: both
    // or neither, and a refusal below rolls both back.
    const totalAfter = await tx.bumpCounter(
      this.host.boxId,
      { scope: WALLET_SPEND_TOTAL_SCOPE, key: hold.walletId, businessDate: WALLET_SPEND_TOTAL_DAY },
      hold.amountSatang,
      hold.at,
    );
    const before = after - hold.amountSatang;
    const totalBefore = totalAfter - hold.amountSatang;
    const allowance = offlineWalletAllowance({
      snapshotBalanceSatang: hold.snapshotBalanceSatang,
      reflectedSatang: hold.reflectedSatang,
      spentOnBoxSatang: totalBefore,
      spentTodaySatang: before,
      capSatang: hold.capSatang,
    });
    if (hold.amountSatang > allowance.capLeftSatang) {
      throw new BridgeError(409, BOX_WALLET_REFUSALS.cap.code, walletOfflineCapMessage(hold.capSatang), {
        walletId: hold.walletId,
        capSatang: hold.capSatang,
        capLeftSatang: allowance.capLeftSatang,
      });
    }
    if (hold.amountSatang > allowance.balanceLeftSatang) {
      throw new BridgeError(
        409,
        'WALLET_INSUFFICIENT',
        `This wallet has ${formatTHB(allowance.balanceLeftSatang)} left, not ${formatTHB(hold.amountSatang)}.`,
        { walletId: hold.walletId, balanceSatang: allowance.balanceLeftSatang },
      );
    }
    hold.spentTodaySatang = after;
    hold.spentOnBoxSatang = totalAfter;
    hold.balanceAfterSatang = allowance.balanceLeftSatang - hold.amountSatang;
    hold.capLeftSatang = allowance.capLeftSatang - hold.amountSatang;
  }

  /** The credit as the till's answer carries it. */
  private walletSpendView(hold: WalletHold): BridgeWalletSpendView {
    return {
      walletId: hold.walletId,
      amountSatang: hold.amountSatang,
      balanceAfterSatang: hold.balanceAfterSatang,
      capLeftSatang: hold.capLeftSatang,
      offline: true,
    };
  }

  /** The credit as an attempt, in the platform's words: method `wallet`, approved, offline. */
  private walletAttemptView(hold: WalletHold): PaymentAttemptView {
    return {
      id: hold.attemptId,
      saleId: hold.saleId,
      method: WALLET_TENDER_METHOD,
      provider: 'manual',
      status: 'approved',
      amountSatang: hold.amountSatang,
      tenderedSatang: null,
      changeSatang: null,
      terminalRef: null,
      tid: null,
      approvalCode: null,
      last4: null,
      invoiceNo: null,
      tranRef: null,
      actionId: hold.actionId,
      offline: true,
      paidAt: hold.at,
      createdAt: hold.at,
    };
  }

  /** The `wallet.spent` fact a closed sale's credit travels as. */
  private walletSpentFact(
    caller: BridgeTillCaller,
    hold: WalletHold,
    receipt: OfflineReceiptFact,
    at: string,
  ): QueuedFact {
    const payload: OfflineWalletSpent = {
      spendId: hold.spendId,
      walletId: hold.walletId,
      saleId: hold.saleId,
      actionId: hold.actionId,
      amountSatang: hold.amountSatang,
      source: hold.source,
      businessDate: hold.businessDate,
      snapshotBalanceSatang: hold.snapshotBalanceSatang,
      capSatang: hold.capSatang,
      spentTodaySatang: hold.spentTodaySatang,
      spentOnBoxSatang: hold.spentOnBoxSatang ?? null,
      snapshotVersion: hold.snapshotVersion,
      snapshotAt: hold.snapshotAt,
      receipt: { series: receipt.series, seq: receipt.seq, number: receipt.number },
      staffTokenJti: caller.jti,
      ...(caller.offlineFresh ? { offlineFresh: true } : {}),
    };
    return {
      type: WALLET_SPENT_FACT,
      stationId: hold.stationId,
      actorKind: 'account',
      actorAccountId: hold.accountId,
      actionId: hold.actionId,
      occurredAt: at,
      payload: payload as unknown as Record<string, unknown>,
    };
  }

  /**
   * CLOSE A SALE WITH ITS CREDIT: the rest in cash (or nothing, when the
   * credit covered it), recorded through `SaleQueue.record` in ONE store
   * transaction with the credit's count (for a press that was not written
   * ahead), its hold marked spent, and its `wallet.spent` fact queued right
   * behind `sale.finalised`.
   */
  private async closeWithCredit(
    station: BridgeStation,
    caller: BridgeTillCaller,
    body: BridgeSaleFinalise,
    sale: PreparedSale,
    hold: WalletHold,
    tender: BridgeTender | null,
    fresh: boolean,
  ): Promise<BridgeSaleAnswer> {
    const rest = sale.gross - hold.amountSatang;
    if (rest < 0) {
      throw new BridgeError(
        409,
        'WALLET_CREDIT_OVER_ORDER',
        `Credit of ${formatTHB(hold.amountSatang)} was already taken for this order, which now costs ${formatTHB(sale.gross)} — keep the order as it was rung up.`,
        { creditSatang: hold.amountSatang, grossSatang: sale.gross },
      );
    }
    let fact: OfflineTenderFact | null = null;
    let tenderAttempt: PaymentAttemptView | null = null;
    const now = this.host.now().toISOString();
    if (rest > 0) {
      if (!tender) throw new BridgeError(400, 'VALIDATION', 'A sale that owes money needs its payment');
      if (tender.method === 'wallet' || tender.method === WALLET_TENDER_CODE) this.refuse('wallet');
      if (tender.method === PAID_ONLINE_TENDER_CODE) {
        throw new BridgeError(400, 'VALIDATION', 'Paid online is recorded only from a booking redemption');
      }
      this.refuseSharedPressKey(tender.actionId, hold.actionId);
      if (tender.kind !== 'cash' && tender.kind !== 'other') {
        // The box closes a sale in one go with one direct payment beside the credit.
        this.refuse('split', { amountSatang: tender.amountSatang, outstandingSatang: rest, creditSatang: hold.amountSatang });
      }
      if (tender.kind === 'other' && (tender.method === 'cash' || tender.tenderedSatang !== undefined || tender.changeSatang !== undefined)) {
        throw new BridgeError(400, 'VALIDATION', 'Other payment must not carry cash received or change');
      }
      if (tender.kind === 'other') await this.assertOtherTender(tender.method);
      if (tender.amountSatang !== rest) {
        this.refuse('split', { amountSatang: tender.amountSatang, outstandingSatang: rest, creditSatang: hold.amountSatang });
      }
      const handed = tender.kind === 'cash' ? (tender.tenderedSatang ?? rest) : null;
      if (handed !== null && handed < rest) {
        throw new BridgeError(
          400,
          'VALIDATION',
          'The cash taken is less than the amount being settled, so this would leave negative change',
        );
      }
      fact = {
        actionId: tender.actionId,
        methodCode: tender.method,
        kind: tender.kind,
        provider: 'manual',
        amountSatang: rest,
        ...(handed === null ? {} : { tenderedSatang: handed, changeSatang: handed - rest }),
        paidAt: now,
      };
      tenderAttempt = this.attemptView({
        attemptId: uuidv7(),
        saleId: body.saleId,
        kind: tender.kind,
        provider: 'manual',
        status: 'approved',
        amountSatang: rest,
        ...(handed === null ? {} : { tenderedSatang: handed, changeSatang: handed - rest }),
        actionId: tender.actionId,
        paidAt: now,
        createdAt: now,
      });
    } else if (tender && tender.amountSatang > 0) {
      throw new BridgeError(400, 'VALIDATION', 'The credit covers this order, so there is no payment to take');
    }
    const memoWallet: NonNullable<SaleMemo['wallet']> = {
      spend: this.walletSpendView(hold),
      attempt: this.walletAttemptView(hold),
    };
    return this.closeSale(station, caller, body, sale, fact ? [fact] : [], tenderAttempt, {
      // The figures `countCredit` settles are only known inside the
      // transaction; the memo is read back from the log on a retry, so the
      // closed hold carries them too.
      alongside: async (tx, recorded) => {
        if (fresh) await this.countCredit(tx, hold);
        const closed: WalletHold = { ...hold, closed: true };
        await tx.writeRuntimeValue(this.host.boxId, walletHoldKey(hold.saleId), JSON.stringify(closed), recorded.at);
        memoWallet.spend = this.walletSpendView(hold);
        return [this.walletSpentFact(caller, hold, recorded.receipt, recorded.at)];
      },
      wallet: memoWallet,
      // A fresh press took no money yet; a held credit was guarded when it was taken.
      stock: fresh ? 'refuse' : 'record',
    });
  }

  /** A sale whose credit is written ahead and whose rest is still owed. */
  private async holdAnswer(
    station: BridgeStation,
    sale: PreparedSale,
    hold: WalletHold,
    replay: boolean,
  ): Promise<BridgeWalletSpendAnswer> {
    const depth = await this.host.store
      .depth(this.host.boxId)
      .catch(() => ({ queued: 0, oldestQueuedAt: null }));
    return {
      sale: {
        ...this.saleViewOf(station, hold.saleId, sale, hold.at),
        status: 'tendering',
        receiptNumber: null,
        receiptSeries: null,
        receiptSeq: null,
      },
      finalised: false,
      outstandingSatang: Math.max(0, sale.gross - hold.amountSatang),
      attempt: null,
      replay,
      printing: { jobs: [], notes: [] },
      drawer: 'not_asked',
      outboxDepth: depth.queued,
      walletSpend: this.walletSpendView(hold),
      walletAttempt: this.walletAttemptView(hold),
    };
  }

  /**
   * `payment.wallet` — "use credit" on the box lane (plan §2.6). The sale is
   * priced again from the box's own catalogue; the scanned key names a wallet
   * in the box's snapshot; the credit is min(what it holds here, what the cap
   * allows on this box today, what the order owes) — or an exact figure,
   * refused above any of those, never floored. Then, written ahead in a store
   * transaction exactly as an offline cash sale is:
   *
   *   - credit that covers the order (or a press that carries the cash for the
   *     rest) closes the sale at once: number, bands, paper, `sale.finalised`
   *     and `wallet.spent`, and the wallet's day on this box, all or none;
   *   - credit that does not is counted and held for the sale; the press that
   *     takes the rest in cash (`sale.finalise`) closes it.
   *
   * The same press again — a till retrying through a lost answer, a restart in
   * between — is answered from the box's log or the hold, and nothing is
   * counted twice.
   */
  private async spendWallet(
    station: BridgeStation,
    caller: BridgeTillCaller,
    payload: Record<string, unknown>,
  ): Promise<BridgeWalletSpendAnswer> {
    this.require(caller, 'pos:sale:create');
    this.require(caller, 'pos:sale:update');
    this.require(caller, 'pos:wallet:spend');
    const body: BridgeWalletSpend = this.parse(BridgeWalletSpendSchema, payload);
    this.refuseSharedPressKey(body.actionId, body.wallet.actionId);
    if (body.tender) this.refuseSharedPressKey(body.tender.actionId, body.wallet.actionId);
    const queue = this.saleQueue();
    const answer = await this.holdingSale<BridgeSaleAnswer>(
      body.saleId,
      async () => {
        const again = await this.answerAgain(queue, body.saleId);
        if (again) return again;
        throw paymentInFlight();
      },
      async () => {
        const again = await this.answerAgain(queue, body.saleId);
        if (again) return again;
        // Money already moving on the counter's terminal for this sale comes first.
        const held = await this.readHeld(body.saleId);
        if (held && (SETTLED.has(held.status) || UNRESOLVED.has(held.status))) throw paymentInFlight();
        // S2-14b round 3: credit already held for this sale was guarded for
        // stock when it was taken, so a press repeated after the shelf moved is
        // answered from the hold, not refused for stock.
        const earlier = await this.readWalletHold(body.saleId);
        const sale = await this.prepareSale(station, caller, body, earlier && !earlier.closed ? { stockGuard: 'skip' } : {});
        const tender = body.tender ?? null;
        if (earlier && !earlier.closed) {
          // Credit already taken for this sale on this box: said again, never
          // counted again. Cash for the rest in this press closes it.
          if (tender && tender.amountSatang > 0) {
            return this.closeWithCredit(station, caller, body, sale, earlier, tender, false);
          }
          return this.holdAnswer(station, sale, earlier, true);
        }
        if (sale.gross <= 0) {
          throw new BridgeError(400, 'VALIDATION', 'This order owes nothing, so there is no credit to take');
        }
        const channel = sale.cart.channel;
        if (channel !== 'fnb' && channel !== 'shop') {
          throw new BridgeError(
            409,
            'WALLET_NOT_HERE',
            'Credit pays for food and shop orders — take this sale in cash, card or QR.',
            { salesChannel: channel ?? null },
          );
        }
        const at = await this.walletAt(station, body.wallet.key);
        const decision = decideOfflineSpend(at.allowance, {
          ...(body.wallet.useCredit !== undefined ? { useCredit: body.wallet.useCredit } : {}),
          ...(body.wallet.amountSatang !== undefined ? { amountSatang: body.wallet.amountSatang } : {}),
          outstandingSatang: sale.gross,
        });
        if ('refusal' in decision) this.walletRefusal(decision.refusal, at, body.wallet.amountSatang);
        const now = this.host.now().toISOString();
        const hold: WalletHold = {
          saleId: body.saleId,
          stationId: station.id,
          accountId: caller.accountId,
          actionId: body.wallet.actionId,
          attemptId: uuidv7(),
          spendId: uuidv7(),
          walletId: at.wallet.id,
          amountSatang: decision.amountSatang,
          source: channel === 'shop' ? 'merch_order' : 'fnb_order',
          businessDate: at.businessDate,
          snapshotBalanceSatang: at.wallet.balanceSatang,
          reflectedSatang: at.reflectedSatang,
          capSatang: at.capSatang,
          spentTodaySatang: at.spentTodaySatang + decision.amountSatang,
          spentOnBoxSatang: at.spentOnBoxSatang + decision.amountSatang,
          balanceAfterSatang: at.allowance.balanceLeftSatang - decision.amountSatang,
          capLeftSatang: at.allowance.capLeftSatang - decision.amountSatang,
          snapshotVersion: at.snapshot.version || null,
          snapshotAt: at.snapshotAt,
          at: now,
        };
        if (hold.amountSatang === sale.gross || (tender && tender.amountSatang > 0)) {
          return this.closeWithCredit(station, caller, body, sale, hold, tender, true);
        }
        // The rest is owed to the next press: the credit is counted and held
        // for this sale, on disk, before the till is told.
        await this.host.store.atomically(async (tx) => {
          await this.countCredit(tx, hold);
          await tx.writeRuntimeValue(this.host.boxId, walletHoldKey(hold.saleId), JSON.stringify(hold), now);
        });
        this.log.info(
          { saleId: hold.saleId, walletId: hold.walletId, amountSatang: hold.amountSatang, capLeftSatang: hold.capLeftSatang },
          'credit taken offline under the cap; the rest of the order is owed',
        );
        return this.holdAnswer(station, sale, hold, false);
      },
    );
    return answer as BridgeWalletSpendAnswer;
  }

  /**
   * Run `fn` with this sale's money in this call's hands, or `busy` when
   * another call on this box already has it. One call at a time talks to the
   * terminal for a sale, closes it, or picks up a tender left behind; the
   * check and the claim have no await between them.
   */
  private async holdingSale<T>(
    saleId: string,
    busy: () => Promise<T>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = `${this.host.boxId}:${saleId}`;
    if (salesInHand.has(key)) return busy();
    salesInHand.add(key);
    try {
      return await fn();
    } finally {
      salesInHand.delete(key);
    }
  }

  /**
   * The tender this box holds for a sale.
   *
   * Read by a call holding the sale (`holdingSale`), bar the busy answer's
   * `peek`. So a tender found mid-exchange (`sent_to_terminal`, `inquiring`)
   * has no exchange behind it any more: the process that wrote it went down
   * before the terminal's answer landed. It is set down where the platform
   * sets a lost terminal result (`payments/terminal.ts`, `result_missing`):
   * `unknown` when the terminal can be asked about the sale by its own
   * reference, else `awaiting_staff_confirmation`, for a person to read the
   * terminal's screen (OD-3). Never `declined`: a power cut does not prove the
   * card was not charged.
   */
  private async readHeld(saleId: string, opts: { peek?: boolean } = {}): Promise<HeldTender | null> {
    if (!this.host.store.features().boothRuntime) return null;
    const raw = await this.host.store.readRuntimeValue(this.host.boxId, heldTenderKey(saleId));
    if (!raw) return null;
    let held: HeldTender;
    try {
      held = JSON.parse(raw) as HeldTender;
    } catch {
      return null;
    }
    if (!opts.peek && MID_EXCHANGE.has(held.status)) {
      const was = held.status;
      held.status = this.unknownStatus(held);
      held.updatedAt = this.host.now().toISOString();
      await this.writeHeld(held);
      this.log.warn(
        { saleId, attemptId: held.attemptId, deviceId: held.deviceId, was, now: held.status },
        'a terminal tender lost its exchange part-way; it waits to be asked about or confirmed, and is never sent again',
      );
    }
    return held;
  }

  private async writeHeld(held: HeldTender): Promise<void> {
    await this.host.store.writeRuntimeValue(
      this.host.boxId,
      heldTenderKey(held.saleId),
      JSON.stringify(held),
      held.updatedAt,
    );
  }

  /**
   * Can the terminal be asked about this tender? The platform's rule
   * (`payments/terminal.ts` `canInquire`, `payments/attempt.ts`): Digio for
   * everything, GHL for a QR but never a card — and only with the sale's own
   * reference, which the terminal's answer carries.
   */
  private canAsk(held: HeldTender): boolean {
    return (held.protocol === 'digio_tlv' || held.kind !== 'card') && !!held.terminalRef;
  }

  private heldAttempt(held: HeldTender): PaymentAttemptView {
    return this.attemptView({
      attemptId: held.attemptId,
      saleId: held.saleId,
      kind: held.kind,
      provider: held.provider,
      status: held.status,
      amountSatang: held.amountSatang,
      terminalRef: held.terminalRef,
      tid: held.tid,
      approvalCode: held.approvalCode,
      last4: held.last4,
      invoiceNo: held.invoiceNo,
      tranRef: held.tranRef,
      actionId: held.actionId,
      inquirySupported: this.canAsk(held),
      reversalPending: held.reversalPending,
      paidAt: null,
      createdAt: held.startedAt,
    });
  }

  /** A tender still open: the sale is not closed and owes its whole amount. */
  private async openAnswer(
    station: BridgeStation,
    held: HeldTender,
    sale: PreparedSale,
  ): Promise<BridgeSaleAnswer> {
    const depth = await this.host.store
      .depth(this.host.boxId)
      .catch(() => ({ queued: 0, oldestQueuedAt: null }));
    return {
      sale: {
        ...this.saleViewOf(station, held.saleId, sale, held.startedAt),
        status: 'tendering',
        receiptNumber: null,
        receiptSeries: null,
        receiptSeq: null,
      },
      finalised: false,
      outstandingSatang: sale.gross,
      attempt: this.heldAttempt(held),
      replay: false,
      printing: { jobs: [], notes: [] },
      drawer: 'not_asked',
      outboxDepth: depth.queued,
    };
  }

  /** The sale a held tender pays for, priced as at the press that started it. */
  private heldSale(
    station: BridgeStation,
    caller: BridgeTillCaller,
    held: HeldTender,
  ): Promise<PreparedSale> {
    return this.prepareSale(station, caller, held.sale, { at: new Date(held.startedAt) });
  }

  /**
   * What a call is told while another call has this sale's money in hand: the
   * sale, if the box has closed it; else the tender it names, read and never
   * moved on. A new press with no live tender on disk yet (none, or an
   * earlier one that already ended) is told a payment is under way.
   */
  private async busyAnswer(
    station: BridgeStation,
    caller: BridgeTillCaller,
    saleId: string,
    attemptId?: string,
  ): Promise<BridgeSaleAnswer> {
    const again = await this.answerAgain(this.saleQueue(), saleId);
    if (again) return again;
    const held = await this.readHeld(saleId, { peek: true });
    if (!held) throw paymentInFlight();
    if (attemptId !== undefined) {
      if (held.attemptId !== attemptId) throw attemptNotHeld();
    } else if (!UNRESOLVED.has(held.status) && !SETTLED.has(held.status)) {
      throw paymentInFlight();
    }
    return this.openAnswer(station, held, await this.heldSale(station, caller, held));
  }

  /**
   * Close the sale with a tender the terminal, or a person reading its
   * screen, already said yes to, whose sale was never written: the power went,
   * or the log refused, between the answer and the record. The money was
   * taken once. The sale closes with THAT tender and the terminal is asked
   * for nothing (plan §2.1, OD-3), dated when it was paid.
   */
  private async closeHeld(
    station: BridgeStation,
    caller: BridgeTillCaller,
    held: HeldTender,
  ): Promise<BridgeSaleAnswer> {
    const sale = await this.heldSale(station, caller, held);
    const paidAt = held.paidAt ?? held.updatedAt;
    this.log.warn(
      { saleId: held.saleId, attemptId: held.attemptId, status: held.status },
      'a terminal tender approved before its sale was written closes the sale now, with no second charge',
    );
    return this.closeSale(
      station,
      caller,
      held.sale,
      sale,
      [this.terminalTender(held)],
      { ...this.heldAttempt(held), paidAt },
      { at: paidAt },
    );
  }

  /**
   * The money a terminal's approval puts on the sale (OD-3): a PAX QR is
   * flagged `awaiting_settlement`, and a card a person confirmed carries who,
   * when and the code they typed.
   */
  private terminalTender(held: HeldTender): OfflineTenderFact {
    const staff = held.staffConfirmation ?? null;
    return {
      actionId: held.actionId,
      methodCode: held.method,
      kind: held.kind,
      provider: held.provider,
      amountSatang: held.amountSatang,
      status: held.kind === 'qr' ? 'awaiting_settlement' : 'approved',
      deviceId: held.deviceId,
      terminalRef: held.terminalRef,
      tranRef: held.tranRef,
      invoiceNo: held.invoiceNo,
      approvalCode: staff?.approvalCode ?? held.approvalCode,
      last4: held.last4,
      tid: held.tid,
      mid: held.mid,
      responseCode: held.responseCode,
      paidAt: held.paidAt ?? this.host.now().toISOString(),
      ...(staff
        ? {
            staffConfirmation: {
              accountId: staff.accountId,
              at: staff.at,
              approvalCode: staff.approvalCode,
              ...(staff.note ? { note: staff.note } : {}),
            },
          }
        : {}),
    };
  }

  /**
   * No final answer: `unknown` when the terminal can be asked (`canAsk`),
   * else a person confirms against its screen (OD-3) — a GHL card always, and
   * any tender whose exchange never brought back its reference.
   */
  private unknownStatus(held: HeldTender): PaymentAttemptStatus {
    return this.canAsk(held) ? 'unknown' : 'awaiting_staff_confirmation';
  }

  /**
   * Read a terminal's answer into the tender the box is holding, and close the
   * sale when it approved. A partial approval is voided on the terminal and the
   * sale is refused, as online: the platform has no way to take the difference.
   *
   * An INQUIRY that got no answer — the terminal gone, the request refused
   * before a byte went out — says nothing about the sale, so the tender stays
   * without a final answer; only a SALE that sent nothing is declined.
   */
  private async settleTerminal(
    station: BridgeStation,
    caller: BridgeTillCaller,
    held: HeldTender,
    sale: PreparedSale,
    outcome: TerminalCommandOutcome,
    mode: 'sale' | 'inquire',
  ): Promise<BridgeSaleAnswer> {
    const terminals = this.host.terminals?.() ?? null;
    const result = outcome.result;
    const now = this.host.now().toISOString();
    let status: PaymentAttemptStatus;
    if (!result) {
      status =
        mode === 'sale' && NOTHING_SENT.has(outcome.errorCode ?? '')
          ? 'declined'
          : this.unknownStatus(held);
      held.responseText = outcome.errorMessage ?? null;
    } else {
      held.terminalRef = result.terminalRef ?? held.terminalRef;
      held.tranRef = result.tranRef ?? held.tranRef;
      held.invoiceNo = result.invoiceNo ?? held.invoiceNo;
      held.approvalCode = result.approvalCode ?? held.approvalCode;
      held.last4 = result.last4 ?? held.last4;
      held.tid = result.tid ?? held.tid;
      held.mid = result.mid ?? held.mid;
      held.responseCode = result.responseCode;
      held.responseText = result.responseText;
      const short =
        result.outcome === 'partial_approval' ||
        (result.outcome === 'approved' &&
          result.approvedSatang !== null &&
          result.approvedSatang !== held.amountSatang);
      if (short) {
        const voided =
          terminals && held.tranRef
            ? await terminals.runCommand({
                mode: 'void',
                attemptId: held.attemptId,
                stationId: station.id,
                deviceId: held.deviceId,
                amountSatang: result.approvedSatang ?? held.amountSatang,
                tender: held.kind,
                tranRef: held.tranRef,
                approvalCode: held.approvalCode,
              })
            : null;
        held.reversalPending = voided?.result?.outcome !== 'approved';
        status = 'declined';
      } else if (result.outcome === 'approved') {
        status = held.kind === 'qr' ? 'awaiting_settlement' : 'approved';
      } else if (result.outcome === 'declined') {
        status = 'declined';
      } else if (result.outcome === 'cancelled') {
        status = 'cancelled';
      } else if (result.outcome === 'not_found') {
        status = 'not_found';
      } else {
        status = this.unknownStatus(held);
      }
    }
    held.status = status;
    held.updatedAt = now;
    if (SETTLED.has(status)) held.paidAt = now;
    // Written before the sale is: should recording it fail, the next call
    // finds a tender that took the money and closes the sale with it.
    await this.writeHeld(held);
    if (SETTLED.has(status)) {
      return this.closeSale(station, caller, held.sale, sale, [this.terminalTender(held)], {
        ...this.heldAttempt(held),
        paidAt: now,
      });
    }
    return this.openAnswer(station, held, sale);
  }

  /** `payment.start`: a card, or the PAX QR, on the counter's own terminal. */
  private async startPayment(
    station: BridgeStation,
    caller: BridgeTillCaller,
    payload: Record<string, unknown>,
  ): Promise<BridgeSaleAnswer> {
    this.require(caller, 'pos:sale:create');
    this.require(caller, 'pos:sale:update');
    this.require(caller, 'pos:payment:capture');
    const body = this.parse(BridgePaymentStartSchema, payload);
    const queue = this.saleQueue();
    return this.holdingSale(
      body.saleId,
      () => this.busyAnswer(station, caller, body.saleId),
      async () => {
        const again = await this.answerAgain(queue, body.saleId);
        if (again) return again;
        /**
         * A tender this box holds for this sale answers first, and the
         * terminal is sent nothing (plan §2.1, OD-3). One it approved closes
         * the sale with that money — the till lost the answer, not the charge.
         * One with no final answer is handed back to be inquired or confirmed.
         */
        const earlier = await this.readHeld(body.saleId);
        if (earlier && SETTLED.has(earlier.status)) return this.closeHeld(station, caller, earlier);
        if (body.tender.method === 'wallet') this.refuse('wallet');
        // S2-14b round 3: a tender still in flight may already hold the
        // guest's money, so its sale is answered, never refused for stock.
        const inFlight = !!earlier && UNRESOLVED.has(earlier.status);
        const sale = await this.prepareSale(station, caller, body, inFlight ? { stockGuard: 'skip' } : {});
        if (earlier && UNRESOLVED.has(earlier.status)) return this.openAnswer(station, earlier, sale);
        // S2-14a round 4: credit taken offline for this sale is closed with cash
        // on this lane — one payment beside the credit, as the box closes a sale.
        const credit = await this.readWalletHold(body.saleId);
        if (credit && !credit.closed) {
          this.refuse('split', {
            amountSatang: body.tender.amountSatang,
            outstandingSatang: sale.gross - credit.amountSatang,
            creditSatang: credit.amountSatang,
          });
        }
        if (sale.gross === 0) {
          throw new BridgeError(
            400,
            'VALIDATION',
            'This sale owes nothing, so there is no payment to take',
          );
        }
        if (body.tender.amountSatang !== sale.gross) {
          this.refuse('split', { amountSatang: body.tender.amountSatang, grossSatang: sale.gross });
        }
        if (!this.host.store.features().boothRuntime) {
          throw new BridgeError(503, BOX_LANE_PAYMENT_REFUSAL.code, BOX_LANE_PAYMENT_REFUSAL.message);
        }
        const terminals = this.host.terminals?.() ?? null;
        const role = body.tender.kind === 'card' ? 'card_terminal' : 'qr_terminal';
        const routed = terminals?.route(station.id, role) ?? null;
        if (!terminals || !routed) {
          // With no terminal QR on this counter, the only QR left is the 2C2P
          // gateway's — and minting that is a server call.
          if (body.tender.kind === 'qr') this.refuse('qr2c2p');
          this.refuse('noTerminal');
        }
        const protocol = routed.terminal.protocol;
        const now = this.host.now().toISOString();
        const held: HeldTender = {
          attemptId: uuidv7(),
          saleId: body.saleId,
          stationId: station.id,
          actionId: body.tender.actionId,
          method: body.tender.method,
          kind: body.tender.kind,
          amountSatang: sale.gross,
          deviceId: routed.device.id,
          protocol,
          provider: protocol === 'ghl_linkpos' ? 'ghl' : 'digio',
          status: 'sent_to_terminal',
          terminalRef: null,
          tranRef: null,
          invoiceNo: null,
          approvalCode: null,
          last4: null,
          tid: routed.device.terminalId ?? null,
          mid: routed.device.merchantId ?? null,
          responseCode: null,
          responseText: null,
          reversalPending: false,
          startedAt: now,
          updatedAt: now,
          paidAt: null,
          staffConfirmation: null,
          sale: body,
        };
        // Written down BEFORE a byte goes to the terminal (plan §6).
        await this.writeHeld(held);
        const outcome = await terminals.runCommand({
          mode: 'sale',
          attemptId: held.attemptId,
          stationId: station.id,
          deviceId: held.deviceId,
          role,
          amountSatang: held.amountSatang,
          tender: held.kind,
          requestQrPayload: held.kind === 'qr',
          qrDirection: 'show',
        });
        return this.settleTerminal(station, caller, held, sale, outcome, 'sale');
      },
    );
  }

  /** The held tender this call names, or a refusal in words. */
  private async heldFor(saleId: string, attemptId: string): Promise<HeldTender> {
    const held = await this.readHeld(saleId);
    if (!held || held.attemptId !== attemptId) throw attemptNotHeld();
    return held;
  }

  /** `payment.inquire`: ask the terminal what became of a tender with no final answer. */
  private async inquirePayment(
    station: BridgeStation,
    caller: BridgeTillCaller,
    payload: Record<string, unknown>,
  ): Promise<BridgeSaleAnswer> {
    this.require(caller, 'pos:payment:confirm');
    const body = this.parse(BridgePaymentInquireSchema, payload);
    const queue = this.saleQueue();
    return this.holdingSale(
      body.saleId,
      () => this.busyAnswer(station, caller, body.saleId, body.attemptId),
      async () => {
        const again = await this.answerAgain(queue, body.saleId);
        if (again) return again;
        const held = await this.heldFor(body.saleId, body.attemptId);
        if (SETTLED.has(held.status)) return this.closeHeld(station, caller, held);
        const sale = await this.heldSale(station, caller, held);
        if (held.status !== 'unknown') return this.openAnswer(station, held, sale);
        if (!this.canAsk(held)) {
          // Nothing to ask the terminal by: a person reads its screen instead.
          held.status = 'awaiting_staff_confirmation';
          held.updatedAt = this.host.now().toISOString();
          await this.writeHeld(held);
          return this.openAnswer(station, held, sale);
        }
        const terminals = this.host.terminals?.() ?? null;
        if (!terminals) this.refuse('noTerminal');
        held.status = 'inquiring';
        held.updatedAt = this.host.now().toISOString();
        await this.writeHeld(held);
        const outcome = await terminals.runCommand({
          mode: 'inquire',
          attemptId: held.attemptId,
          stationId: station.id,
          deviceId: held.deviceId,
          amountSatang: held.amountSatang,
          tender: held.kind,
          terminalRef: held.terminalRef,
          tranRef: held.tranRef,
        });
        return this.settleTerminal(station, caller, held, sale, outcome, 'inquire');
      },
    );
  }

  /**
   * `payment.confirm` (OD-3): a card sale that gave no answer, confirmed by a
   * person against the terminal's own screen with the approval code typed.
   * Recorded on the box, named on that person, and flagged for end-of-day
   * reconciliation — because refusing it would leave money taken and not
   * recorded.
   */
  private async confirmPayment(
    station: BridgeStation,
    caller: BridgeTillCaller,
    payload: Record<string, unknown>,
  ): Promise<BridgeSaleAnswer> {
    this.require(caller, 'pos:payment:confirm');
    const body = this.parse(BridgePaymentConfirmSchema, payload);
    const queue = this.saleQueue();
    return this.holdingSale(
      body.saleId,
      () => this.busyAnswer(station, caller, body.saleId, body.attemptId),
      async () => {
        const again = await this.answerAgain(queue, body.saleId);
        if (again) return again;
        const held = await this.heldFor(body.saleId, body.attemptId);
        // Confirmed (or approved) already, and the sale never written: close it with that.
        if (SETTLED.has(held.status)) return this.closeHeld(station, caller, held);
        const sale = await this.heldSale(station, caller, held);
        if (held.status !== 'awaiting_staff_confirmation') {
          throw new BridgeError(
            409,
            'ATTEMPT_NOT_AWAITING_CONFIRMATION',
            `This tender is ${held.status.replace(/_/g, ' ')}; there is nothing for a person to confirm`,
            { status: held.status },
          );
        }
        const now = this.host.now().toISOString();
        held.updatedAt = now;
        if (!body.took) {
          held.status = 'declined';
          await this.writeHeld(held);
          return this.openAnswer(station, held, sale);
        }
        held.status = 'approved';
        held.approvalCode = body.approvalCode ?? held.approvalCode;
        held.last4 = body.last4 ?? held.last4;
        held.paidAt = now;
        // Kept on the tender, so a close after a crash still says who confirmed it.
        held.staffConfirmation = {
          accountId: caller.accountId,
          at: now,
          approvalCode: body.approvalCode ?? '',
          ...(body.note ? { note: body.note } : {}),
        };
        await this.writeHeld(held);
        return this.closeSale(station, caller, held.sale, sale, [this.terminalTender(held)], {
          ...this.heldAttempt(held),
          paidAt: now,
        });
      },
    );
  }

  /**
   * `payment.status`: where the tender the box holds for a sale stands. A
   * tender that took the money but whose sale was never written is closed
   * here, by a caller who may close sales.
   */
  private async paymentStatus(
    station: BridgeStation,
    caller: BridgeTillCaller,
    payload: Record<string, unknown>,
  ): Promise<BridgeSaleAnswer> {
    this.require(caller, 'pos:sale:create');
    const body = this.parse(BridgePaymentInquireSchema, payload);
    const queue = this.saleQueue();
    return this.holdingSale(
      body.saleId,
      () => this.busyAnswer(station, caller, body.saleId, body.attemptId),
      async () => {
        const again = await this.answerAgain(queue, body.saleId);
        if (again) return again;
        const held = await this.heldFor(body.saleId, body.attemptId);
        if (SETTLED.has(held.status) && caller.can('pos:sale:update')) {
          return this.closeHeld(station, caller, held);
        }
        return this.openAnswer(station, held, await this.heldSale(station, caller, held));
      },
    );
  }

  /** `sale.reprint`: another copy of a sale this box took today (plan §2.8, Reprint). */
  private async reprintSale(
    caller: BridgeTillCaller,
    payload: Record<string, unknown>,
    actionId: string | null,
  ): Promise<Record<string, unknown>> {
    this.require(caller, 'pos:print:reprint');
    const body = this.parse(BridgeSaleReprintSchema, payload);
    const queue = this.saleQueue();
    try {
      const printed = await queue.reprint(body.saleId, body.kind, {
        today: this.tradingDay(),
        reason: body.reason ?? null,
        actionId,
      });
      return {
        jobs: printed.jobs.map((job) => ({ id: job.id, kind: job.kind, status: job.status })),
        notes: printed.notes,
      };
    } catch (err) {
      if (err instanceof ReprintRefused) {
        throw new BridgeError(
          err.code === 'NOT_ON_THIS_BOX' ? 404 : 409,
          `REPRINT_${err.code}`,
          err.message,
        );
      }
      throw err;
    }
  }

  /** `receipt.observed` (OD-4): the number the platform gave an online sale here. */
  private async observeReceipt(
    station: BridgeStation,
    caller: BridgeTillCaller,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.require(caller, 'pos:sale:create');
    const body = this.parse(BridgeReceiptObservedSchema, payload);
    const observed = await this.saleQueue().observeReceipt(station.id, body.receiptNumber);
    return { observed };
  }

  // --- redeeming an online booking (S2-12 round 5) ------------------------------------------

  private async cachedBookings(): Promise<CachedBooking[]> {
    return itemsOf(await this.bundle('bookings'))
      .map(cachedBookingOf)
      .filter((b): b is CachedBooking => !!b);
  }

  private async readRedemption(bookingId: string): Promise<BookingRedemptionLog | null> {
    if (!this.host.store.features().boothRuntime) return null;
    const raw = await this.host.store.readRuntimeValue(this.host.boxId, redemptionKey(bookingId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as BookingRedemptionLog;
    } catch {
      return null;
    }
  }

  /** `2026-09-22 14:05` at the branch, for a sentence read out at a counter. */
  private wallClock(iso: string): string {
    const at = new Date(iso);
    const timezone = this.host.branch()?.timezone;
    if (!timezone || Number.isNaN(at.getTime())) return iso;
    const minutes = wallClockMinutesInTz(at, timezone);
    return `${isoDateInTz(at, timezone)} ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(
      minutes % 60,
    ).padStart(2, '0')}`;
  }

  private async branchName(branchId: string | null): Promise<string | null> {
    if (!branchId || this.host.branch()?.id !== branchId) return null;
    return s(rec((await this.catalogueItem())?.receiptHeader)?.name);
  }

  /**
   * Who redeemed a booking and when, in the platform's `RedemptionView`: this
   * box's own log first — it is newer than any copy the platform sent — then
   * the redemption the cached booking carries. Null when neither has one. A log
   * row whose sale was never recorded (the power went between the claim and
   * the sale) is not a redemption yet: nothing was handed over, and the next
   * Confirm finishes that one sale.
   */
  private async redemptionOf(
    booking: CachedBooking,
    log: BookingRedemptionLog | null,
  ): Promise<BridgeBookingView['redemption']> {
    const issued = log && (log.state === 'done' || (await this.host.sales?.()?.recorded(log.saleId)));
    if (log && issued) {
      return {
        at: log.at,
        branchName: await this.branchName(this.host.branch()?.id ?? null),
        stationName: log.stationName,
        staffName: log.staffName,
        bandCodes: log.bandCodes ?? [],
      };
    }
    const cloud = rec(booking.payload.redemption);
    if (!cloud && booking.status !== 'redeemed') return null;
    const stationId = s(cloud?.stationId);
    return {
      at: s(cloud?.redeemedAt) ?? booking.createdAt,
      branchName: await this.branchName(s(cloud?.branchId) ?? booking.branchId),
      stationName: stationId ? (this.host.station(stationId)?.name ?? null) : null,
      // A box holds no staff names (SCRUM-223); the platform's answer names them.
      staffName: null,
      bandCodes: Array.isArray(cloud?.bandCodes)
        ? cloud.bandCodes.filter((c): c is string => typeof c === 'string')
        : [],
    };
  }

  /** The booking in the platform's `GET /bookings/:id` shape, from the box's copy. */
  private async bookingView(
    booking: CachedBooking,
    log: BookingRedemptionLog | null,
  ): Promise<BridgeBookingView> {
    const redemption = await this.redemptionOf(booking, log);
    const p = booking.payload;
    return {
      id: booking.id,
      reference: booking.reference,
      branchId: booking.branchId,
      branchName: await this.branchName(booking.branchId),
      memberId: booking.memberId,
      bookingDate: booking.bookingDate,
      createdAt: booking.createdAt,
      status: redemption ? 'redeemed' : booking.status,
      totalSatang: booking.totalSatang,
      tier: s(p.tier) ?? '',
      rateMode: s(p.rateMode),
      parentName: s(p.parentName),
      phone: s(p.phone),
      paymentMethod: s(p.paymentMethod),
      lines: bookingLinesOf(booking),
      redemption,
      source: log && redemption && log.state === 'done' ? 'log' : 'cache',
    };
  }

  /** "Booking OTO-… was already redeemed on … at …", with the first redemption in `details`. */
  private alreadyRedeemed(
    booking: Pick<CachedBooking, 'reference'>,
    redemption: NonNullable<BridgeBookingView['redemption']>,
  ): BridgeError {
    const where = [redemption.branchName, redemption.stationName, redemption.staffName]
      .filter(Boolean)
      .join(', ');
    return new BridgeError(
      409,
      'BOOKING_ALREADY_REDEEMED',
      `Booking ${booking.reference} was already redeemed on ${this.wallClock(redemption.at)}${
        where ? ` at ${where}` : ''
      }.`,
      { reference: booking.reference, redemption },
    );
  }

  /** `booking.lookup`: the booking a scan, a QR or a reference names, from this box's copy. */
  private async bookingLookup(
    caller: BridgeTillCaller,
    payload: Record<string, unknown>,
  ): Promise<BridgeBookingView> {
    this.require(caller, 'pos:booking:read');
    const body = this.parse(BridgeBookingLookupSchema, payload);
    let bookingId = body.bookingId ?? null;
    if (!bookingId && body.qr) {
      if (!parseBookingQr(body.qr)) {
        throw new BridgeError(
          422,
          'BOOKING_QR_SIGNATURE_INVALID',
          'This reads like a booking QR, but part of it is missing — type the booking reference instead',
        );
      }
      const key = this.host.bandKey?.() ?? null;
      if (!key) {
        throw new BridgeError(409, BOX_BOOKING_REFUSALS.qrUnchecked.code, BOX_BOOKING_REFUSALS.qrUnchecked.message);
      }
      const verdict = verifyBookingQr(body.qr, key);
      if (!verdict.ok) {
        throw new BridgeError(
          422,
          'BOOKING_QR_SIGNATURE_INVALID',
          'Not a booking this park issued — its signature does not match',
        );
      }
      bookingId = verdict.bookingId;
    }
    const bookings = await this.cachedBookings();
    const reference = body.reference?.trim().toUpperCase() ?? null;
    const found = bookingId
      ? bookings.find((b) => b.id === bookingId)
      : bookings.find((b) => b.reference.toUpperCase() === reference);
    if (!found) {
      throw new BridgeError(404, BOX_BOOKING_REFUSALS.unknown.code, BOX_BOOKING_REFUSALS.unknown.message);
    }
    return this.bookingView(found, await this.recoveredRedemption(caller, found.id));
  }

  /**
   * The box's log row for a booking, as a lookup reads it — finished first
   * when a restart left it short of its fact (SCRUM-477): the sale is on
   * disk, so the read that tells the next till "already redeemed" carries the
   * band codes and the fact follows its sale, whether or not anybody presses
   * Confirm again. Left alone while a call on this box is redeeming it.
   */
  private async recoveredRedemption(
    caller: BridgeTillCaller,
    bookingId: string,
  ): Promise<BookingRedemptionLog | null> {
    const log = await this.readRedemption(bookingId);
    if (!log || log.state === 'done') return log;
    const key = `${this.host.boxId}:${bookingId}`;
    if (bookingsInHand.has(key)) return log;
    bookingsInHand.add(key);
    try {
      const recorded = await this.host.sales?.()?.recorded(log.saleId);
      return recorded ? await this.finishRecordedRedemption(caller, log, recorded) : log;
    } finally {
      bookingsInHand.delete(key);
    }
  }

  /**
   * `booking.redeem` — Confirm & Issue with the box's link down.
   *
   * THE CLAIM COMES FIRST, as online: the box's redemption log row is on disk
   * before a receipt number is spent or a band is minted, and every till on
   * this box reads that row. So a second till is answered already-redeemed —
   * with who and when — rather than issuing a second set of bands. Then the
   * sale, through the box's own sale path (`SaleQueue.record`: number, bands,
   * paper and the `sale.finalised` fact in one transaction), from the lines the
   * family PAID for with the paid-online tender; then the `booking.redeemed`
   * fact and the log's `done`, in one store transaction.
   */
  private async bookingRedeem(
    station: BridgeStation,
    caller: BridgeTillCaller,
    payload: Record<string, unknown>,
  ): Promise<BridgeBookingRedeemAnswer> {
    this.require(caller, 'pos:booking:redeem');
    this.require(caller, 'pos:sale:create');
    const body = this.parse(BridgeBookingRedeemSchema, payload);
    const queue = this.saleQueue();
    // The log lives in the store's runtime values: a box without them keeps the
    // round-4 refusal rather than redeem with nowhere to write the claim.
    if (!this.host.store.features().boothRuntime) this.refuse('booking');
    const key = `${this.host.boxId}:${body.bookingId}`;
    if (bookingsInHand.has(key)) {
      const log = await this.readRedemption(body.bookingId);
      throw new BridgeError(409, BOX_BOOKING_REFUSALS.inProgress.code, BOX_BOOKING_REFUSALS.inProgress.message, {
        ...(log ? { stationName: log.stationName, staffName: log.staffName, at: log.at } : {}),
      });
    }
    bookingsInHand.add(key);
    try {
      return await this.redeemHeld(station, caller, body, queue);
    } finally {
      bookingsInHand.delete(key);
    }
  }

  private async redeemHeld(
    station: BridgeStation,
    caller: BridgeTillCaller,
    body: BridgeBookingRedeem,
    queue: SaleQueue,
  ): Promise<BridgeBookingRedeemAnswer> {
    const booking = (await this.cachedBookings()).find((b) => b.id === body.bookingId) ?? null;
    const held = await this.readRedemption(body.bookingId);
    if (held) {
      const recorded = await queue.recorded(held.saleId);
      const samePress = held.actionId === body.actionId;
      if (recorded && !samePress) {
        // Tills on one box share this log: the second is told who and when —
        // once the log is finished, when a restart left it short of its fact
        // (SCRUM-477), so the answer carries the band codes to read aloud.
        const finished = await this.finishRecordedRedemption(caller, held, recorded);
        const redemption = await this.redemptionOf(booking ?? this.bookingFromLog(finished), finished);
        throw this.alreadyRedeemed(finished, redemption!);
      }
      // The same press again — or a claim a restart left with no sale behind
      // it, which the next Confirm finishes under the SAME sale id.
      if (!recorded && booking) {
        // S2-12 closing audit — nothing was handed over under that claim, and
        // the box has since learnt the booking was redeemed elsewhere (a
        // counter online while the box was back). Finishing the claim now would
        // band a second family on one payment: refused, by who and when.
        const elsewhere = await this.redemptionOf(booking, null);
        if (elsewhere || booking.status !== 'paid') {
          if (elsewhere) throw this.alreadyRedeemed(booking, elsewhere);
          throw new BridgeError(
            409,
            'BOOKING_NOT_REDEEMABLE',
            `Booking ${booking.reference}: booking not paid. It is ${booking.status}, so it cannot be redeemed at the counter.`,
            { reference: booking.reference, status: booking.status, reason: 'not_paid' },
          );
        }
      }
      let claim = held;
      if (!recorded) {
        this.log.warn(
          { bookingId: held.bookingId, saleId: held.saleId, stationId: station.id },
          'a booking claimed on this box before a restart is finished now, under the sale it was claimed for',
        );
        // The sale is rung HERE, so the log — and so the who answer and the
        // fact — name this till and this person, not the claim's (SCRUM-477).
        if (held.stationId !== station.id || held.accountId !== caller.accountId) {
          claim = {
            ...held,
            stationId: station.id,
            stationName: station.name,
            accountId: caller.accountId,
            staffName: body.staffName ?? held.staffName,
          };
        }
      }
      return this.completeRedemption(station, caller, claim, booking, samePress && !!recorded);
    }

    if (!booking) {
      throw new BridgeError(404, BOX_BOOKING_REFUSALS.unknown.code, BOX_BOOKING_REFUSALS.unknown.message);
    }
    const already = await this.redemptionOf(booking, null);
    if (already) throw this.alreadyRedeemed(booking, already);
    if (booking.status === 'supervised_online_only') {
      throw new BridgeError(
        409,
        'BOOKING_NEEDS_INTERNET',
        'This supervised booking needs the internet. Reconnect at reception to redeem it and check the children in.',
        { reference: booking.reference, status: booking.status },
      );
    }
    // S2-20 E5 — a booking carrying event passes is redeemed with the link up
    // only: its passes are checked in against the OTO App, and its money is
    // filed with its tickets on the one sale the platform makes.
    if (booking.status === BOOKING_EVENT_PASSES_ONLINE_ONLY) {
      throw new BridgeError(409, BOOKING_EVENT_PASSES_NEED_INTERNET.code, BOOKING_EVENT_PASSES_NEED_INTERNET.message, {
        reference: booking.reference,
        status: booking.status,
      });
    }
    if (booking.status !== 'paid') {
      // The platform's own words (`redeemBooking` in `services/bookings.ts`).
      throw new BridgeError(
        409,
        'BOOKING_NOT_REDEEMABLE',
        `Booking ${booking.reference}: booking not paid. It is ${booking.status}, so it cannot be redeemed at the counter.`,
        { reference: booking.reference, status: booking.status, reason: 'not_paid' },
      );
    }
    const lines = bookingLinesOf(booking).filter((l) => l.packageId && (l.kids > 0 || l.adults > 0));
    if (lines.length === 0) {
      throw new BridgeError(
        409,
        'BOOKING_NOTHING_TO_ISSUE',
        `Booking ${booking.reference} carries no tickets, so there is nothing to issue at the counter`,
        { reference: booking.reference },
      );
    }

    const at = this.host.now().toISOString();
    const tier = s(booking.payload.tier) || (await this.defaultTier());
    const socksProductId = lines.some((l) => l.socks > 0) ? await this.socksProductId() : null;
    const socksUnit = lines.find((l) => l.socks > 0)?.socksUnitSatang ?? 0;
    const member = booking.memberId ? await this.resolveMember(booking.memberId) : null;
    const saleId = uuidv7();
    const redemptionId = uuidv7();
    const log: BookingRedemptionLog = {
      bookingId: booking.id,
      reference: booking.reference,
      redemptionId,
      saleId,
      actionId: body.actionId,
      tenderActionId: `paid-online:${redemptionId}`,
      stationId: station.id,
      stationName: station.name,
      accountId: caller.accountId,
      staffName: body.staffName ?? null,
      at,
      state: 'claimed',
      tier,
      lines,
      socksProductId,
      totalSatang: booking.totalSatang,
      sale: {
        saleId,
        actionId: body.actionId,
        occurredAt: at,
        visitId: body.visitId ?? null,
        note: `Online booking ${booking.reference}`,
        staffName: body.staffName ?? null,
        ...(body.visitChildIds ? { visitChildIds: body.visitChildIds } : {}),
        tender: null,
        cart: {
          ...(member ? { memberId: member.id } : {}),
          tier,
          lines: lines.map((line) => ({
            id: uuidv7(),
            packageId: line.packageId,
            packageName: line.name,
            tier,
            kids: line.kids,
            adults: line.adults,
            socks: line.socks,
            addOns: line.addOns.map((a) => ({
              id: a.productId,
              name: a.name,
              unitSatang: a.unitSatang,
              quantity: a.quantity,
            })),
          })),
          ...(lines.some((l) => l.socks > 0)
            ? {
                socks: socksProductId
                  ? { addOnId: socksProductId }
                  : { addOnId: 'booking-socks', unitSatang: socksUnit, label: 'Regular Socks' },
              }
            : {}),
          expectedTotalSatang: booking.totalSatang,
          // What the platform reads to file this sale as the booking's redemption.
          bookingId: booking.id,
          bookingRedemptionId: redemptionId,
          bookingReference: booking.reference,
        },
      },
    };
    // Priced BEFORE the claim is written, so a booking the counter cannot issue
    // (the park's tax set-up moved since it was paid) leaves no claim behind.
    await this.prepareBookingSale(station, caller, log);
    await this.host.store.writeRuntimeValue(this.host.boxId, redemptionKey(booking.id), JSON.stringify(log), at);
    await this.redemptionCrash?.('after_claim');
    return this.completeRedemption(station, caller, log, booking, false);
  }

  /** A booking the log names, when the cached copy has since gone (a newer pull). */
  private bookingFromLog(log: BookingRedemptionLog): CachedBooking {
    return {
      id: log.bookingId,
      branchId: this.host.branch()?.id ?? '',
      memberId: null,
      reference: log.reference,
      bookingDate: log.at.slice(0, 10),
      status: 'redeemed',
      totalSatang: log.totalSatang,
      createdAt: log.at,
      payload: { tier: log.tier, lines: log.lines },
    };
  }

  /** The socks product the booking site priced `socks` from, if the box's catalogue has it. */
  private async socksProductId(): Promise<string | null> {
    const item = await this.catalogueItem();
    const products = Array.isArray(item?.products) ? item.products.map(rec) : [];
    return s(products.find((p) => p && p.code === SOCKS_CODE && !p.archivedAt)?.id) ?? null;
  }

  /** The sale a redemption commits, priced from what the family paid, as at the claim. */
  private async prepareBookingSale(
    station: BridgeStation,
    caller: BridgeTillCaller,
    log: BookingRedemptionLog,
  ): Promise<PreparedSale> {
    try {
      return await this.prepareSale(station, caller, log.sale, {
        at: new Date(log.at),
        redeeming: true,
        overlay: (catalogue) => bookingCatalogue(catalogue, log.tier, log.lines, log.socksProductId),
      });
    } catch (err) {
      if (err instanceof BridgeError && (err.code === 'SALE_TOTAL_MISMATCH' || err.code === 'SALE_LINE_PRICE_MISMATCH')) {
        throw new BridgeError(
          409,
          'BOOKING_TOTAL_DRIFT',
          `Booking ${log.reference} was paid ฿${(log.totalSatang / 100).toFixed(2)}, and the park's tax set-up has changed since, so the counter would file a different sum. Nothing was issued — ask a manager.`,
          { reference: log.reference, totalSatang: log.totalSatang, details: err.details ?? null },
        );
      }
      throw err;
    }
  }

  /**
   * Finish a claimed redemption: the sale (once — `SaleQueue` answers a sale id
   * it already recorded from its log), then the `booking.redeemed` fact and
   * the log's `done` in one store transaction.
   */
  private async completeRedemption(
    station: BridgeStation,
    caller: BridgeTillCaller,
    log: BookingRedemptionLog,
    booking: CachedBooking | null,
    replay: boolean,
  ): Promise<BridgeBookingRedeemAnswer> {
    const queue = this.saleQueue();
    let answer = await this.answerAgain(queue, log.saleId);
    if (!answer) {
      const sale = await this.prepareBookingSale(station, caller, log);
      const tenders: OfflineTenderFact[] =
        sale.gross > 0
          ? [
              {
                actionId: log.tenderActionId,
                methodCode: PAID_ONLINE_TENDER_CODE,
                kind: 'other',
                provider: 'manual',
                amountSatang: sale.gross,
                paidAt: log.at,
                reference: log.reference,
              },
            ]
          : [];
      const attempt: PaymentAttemptView | null =
        sale.gross > 0
          ? {
              ...this.attemptView({
                attemptId: uuidv7(),
                saleId: log.saleId,
                kind: 'cash',
                provider: 'manual',
                status: 'approved',
                amountSatang: sale.gross,
                actionId: log.tenderActionId,
                paidAt: log.at,
                createdAt: log.at,
              }),
              method: PAID_ONLINE_TENDER_METHOD,
            }
          : null;
      answer = await this.closeSale(station, caller, log.sale, sale, tenders, attempt, { at: log.at });
    }
    await this.redemptionCrash?.('after_sale');

    let done = log;
    if (log.state !== 'done') {
      const bandCodes = (answer.bands ?? [])
        .map((b) => b.shortCode)
        .filter((c): c is string => !!c);
      done = await this.finishRedemption(log, { receiptNumber: answer.sale.receiptNumber, bandCodes }, caller);
    }
    const depth = await this.host.store
      .depth(this.host.boxId)
      .catch(() => ({ queued: 0, oldestQueuedAt: null }));
    return {
      booking: await this.bookingView(booking ?? this.bookingFromLog(done), done),
      sale: answer.sale,
      bands: answer.bands ?? [],
      printing: answer.printing,
      replay,
      outboxDepth: depth.queued,
    };
  }

  /**
   * The `booking.redeemed` fact and the log's `done`, in one store transaction
   * (S2-12 round 5), once the sale is recorded: `sold` is what it issued. The
   * fact names the till and the person the log names — who rang the sale —
   * and carries the caller's shift token only when the caller IS that person:
   * another till finishing a log a restart left short (SCRUM-477) does not
   * speak for anybody's token.
   */
  private async finishRedemption(
    log: BookingRedemptionLog,
    sold: { receiptNumber: string | null; bandCodes: string[] },
    caller: BridgeTillCaller,
  ): Promise<BookingRedemptionLog> {
    const seal = this.host.sealer();
    if (!seal) {
      throw new BridgeError(
        503,
        'BOX_AGENT_ELSEWHERE',
        'This counter’s box is not running here, so it cannot record anything right now',
      );
    }
    const done: BookingRedemptionLog = {
      ...log,
      state: 'done',
      receiptNumber: sold.receiptNumber,
      bandCodes: sold.bandCodes,
    };
    const own = caller.accountId === log.accountId;
    const fact: OfflineBookingRedeemed = {
      redemptionId: log.redemptionId,
      bookingId: log.bookingId,
      saleId: log.saleId,
      reference: log.reference,
      redeemedAt: log.at,
      bandCodes: sold.bandCodes,
      receiptNumber: sold.receiptNumber,
      staffTokenJti: own ? caller.jti : null,
      ...(own && caller.offlineFresh ? { offlineFresh: true } : {}),
    };
    const now = this.host.now().toISOString();
    const queued: QueuedFact = {
      type: BOOKING_REDEEMED_FACT,
      payload: fact as unknown as Record<string, unknown>,
      occurredAt: log.at,
      stationId: log.stationId,
      actorKind: 'account',
      actorAccountId: log.accountId,
      actionId: log.actionId.slice(0, 200),
    };
    await this.host.store.atomically(async (tx) => {
      await tx.enqueueMany(this.host.boxId, [queued], seal, now);
      await tx.writeRuntimeValue(this.host.boxId, redemptionKey(log.bookingId), JSON.stringify(done), now);
    });
    return done;
  }

  /**
   * A claim whose sale was rung and recorded, and whose fact never followed
   * (SCRUM-477): the power went between the two (`after_sale`), and the next
   * press is another till's. The cloud files the redemption from the sale
   * alone, but on the box the log stayed `claimed`, so the who answer could
   * not read the band codes aloud and the fact was never queued. Finished
   * here, before that till is answered, under the till that rang the sale —
   * the sale queue's own record of where it was rung, not the claim's.
   *
   * On an api instance the box's agent is not running on nothing can be
   * sealed; the answer still names the sale and its bands, and the log waits
   * for a press on the box itself.
   */
  private async finishRecordedRedemption(
    caller: BridgeTillCaller,
    log: BookingRedemptionLog,
    recorded: RecordedSale,
  ): Promise<BookingRedemptionLog> {
    if (log.state === 'done') return log;
    const rang = this.host.station(recorded.stationId);
    const sold = {
      receiptNumber: recorded.receipt.number,
      bandCodes: recorded.bands.map((b) => bandShortCode(b.code)).filter((c): c is string => !!c),
    };
    const by: BookingRedemptionLog = {
      ...log,
      stationId: recorded.stationId,
      stationName: rang?.name ?? (recorded.stationId === log.stationId ? log.stationName : null),
    };
    if (!this.host.sealer()) {
      this.log.warn(
        { bookingId: log.bookingId, saleId: log.saleId },
        'a booking sold on this box before a restart has no redemption fact yet, and this process cannot seal one',
      );
      return { ...by, receiptNumber: sold.receiptNumber, bandCodes: sold.bandCodes };
    }
    this.log.warn(
      { bookingId: log.bookingId, saleId: log.saleId, stationId: recorded.stationId },
      'a booking sold on this box before a restart is filed now: its redemption fact follows its sale',
    );
    return this.finishRedemption(by, sold, caller);
  }

  // --- the overlay's end -------------------------------------------------------------------

  /**
   * Let the cache speak for a record again (plan §2.3).
   *
   * A row is pruned once the fact that last changed it has been ACCEPTED by the
   * platform and a members pull has landed AFTER that — so the cache now holds
   * the platform's own copy, merged or not. A row whose fact was quarantined is
   * kept: the platform did not take it, and the counter should go on showing
   * what staff typed until a person has looked.
   */
  async pruneOverlay(): Promise<number> {
    // The member half only: the check-in kinds are pruned against their own
    // scope's pull (`pruneCheckinOverlay`, S2-13 round 4).
    const rows = (await this.host.store.allOverlay(this.host.boxId)).filter(
      (row) => row.kind === 'member' || row.kind === 'child' || row.kind === 'visit',
    );
    if (rows.length === 0) return 0;
    const members = await this.bundle('members');
    if (!members) return 0;
    const pulledAt = Date.parse(members.appliedAt);
    const states = await this.host.store.outboxStates(
      this.host.boxId,
      rows.map((r) => r.eventId).filter((id): id is string => !!id),
    );
    const done: Array<{ kind: BoxOverlayKind; entityId: string }> = [];
    for (const row of rows) {
      const state = row.eventId ? states.get(row.eventId) : undefined;
      if (!state || state.state !== 'acked' || !state.ackedAt) continue;
      if (Date.parse(state.ackedAt) >= pulledAt) continue;
      done.push({ kind: row.kind, entityId: row.entityId });
    }
    return this.host.store.deleteOverlay(this.host.boxId, done);
  }

  /** The member a fact names, for a test or a Console page: the survivor once an alias is known. */
  async survivorOf(memberId: string): Promise<string | null> {
    return (await this.resolveMember(memberId))?.id ?? null;
  }
}

function memberFromRecord(
  record: Record<string, unknown>,
  id: string,
  phone: string,
): CachedMember {
  const channel = s(record.preferredChannel);
  return {
    id,
    phone: s(record.phone) ?? phone,
    nickname: s(record.nickname) ?? '',
    name: s(record.name),
    tierCode: s(record.tierCode) ?? 'tourist',
    preferredChannel:
      channel === 'whatsapp' || channel === 'telegram' || channel === 'line' ? channel : null,
    childrenReviewSince: s(record.childrenReviewSince),
    aliasIds: [],
    children: [],
  };
}

function memberRecord(member: CachedMember): Record<string, unknown> {
  return {
    id: member.id,
    phone: member.phone,
    nickname: member.nickname,
    name: member.name,
    tierCode: member.tierCode,
    preferredChannel: member.preferredChannel,
    childrenReviewSince: member.childrenReviewSince,
  };
}

/** A fresh UUIDv7 in the box's own generator, for callers that mint on the box's behalf. */
export const bridgeId = (): string => uuidv7();
