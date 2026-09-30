import { z } from 'zod';
import { TaxConfigSchema } from './catalog-shapes';
import { PAYMENT_METHOD_KINDS, type PaymentAttemptView } from './payments';
import { SALE_REPRINT_KINDS } from './print';
import { TIER_PROOF_TYPES } from './tier-proof';
import { STAFF_OFFLINE_SIGN_IN_DAYS, STAFF_TOKEN_TTL_S } from './staff-token';

/**
 * THE STATION BRIDGE — how a till and a customer display reach their box
 * (plan `docs/progress/plans/offline/PLAN.md` §2.2, Round 3, SCRUM-269).
 *
 * One contract, `/box/v1/station/:stationId/*`, written once in
 * `@oto/box-agent` (`station-bridge.ts`) and mounted twice: by the api for a
 * virtual box, where the platform session is the credential (OD-2), and by the
 * agent on a Raspberry Pi behind Caddy, where the credential is a BOX SESSION
 * the box issues at unlock. This file is the wire both mounts and the till
 * agree on, so a field added on one side is a compile error on the other.
 *
 * Nothing here is a price or a rule. The prices come from the one satang engine
 * (`cart-totals.ts`, `item-cart.ts`); the rules for who may unlock live in
 * `@oto/box-agent/staff-token`.
 */

/** Where the surface lives on either mount. */
export const STATION_BRIDGE_BASE = '/box/v1/station';

/**
 * The prefix every box session carries, so a bearer the bridge is handed says
 * which credential it is before anything is looked up: a box session starts
 * with this, a paired display's credential is 64 hex characters.
 */
export const BOX_SESSION_PREFIX = 'bs_';

/**
 * How stale each cached scope may grow (OD-5, OD-6).
 *
 * The catalogue numbers are the owner's to set, and the plan wants them as
 * Console settings. Until a column exists for them they are these defaults,
 * delivered to every counter box in its `station_config` scope
 * (`offlinePolicy`), so the box and the till read one value and changing the
 * default is one line here.
 */
export const OFFLINE_POLICY = {
  /** The catalogue sells normally this long after its last good pull. */
  catalogueBannerAfterS: 24 * 60 * 60,
  /** Past this a box refuses new sales: a week-old catalogue is more likely a cold spare. */
  catalogueRefuseAfterS: 7 * 24 * 60 * 60,
  /** A staff token's own life; the deny-list must be held as well. */
  staffTokenTtlS: STAFF_TOKEN_TTL_S,
  /** A fresh sign-in needs the person to have been seen on this box this recently. */
  freshSignInDays: STAFF_OFFLINE_SIGN_IN_DAYS,
  /** And a deny-list pulled within this, so a dismissal still reaches the counter (OD-6). */
  freshSignInDenyListMaxAgeS: 72 * 60 * 60,
} as const;

export type OfflinePolicy = { -readonly [K in keyof typeof OFFLINE_POLICY]: number };

/** Which way the till is working: through the platform, or through its box (OD-1). */
export const BRIDGE_LANES = ['platform', 'box'] as const;
export type BridgeLane = (typeof BRIDGE_LANES)[number];

/** How the catalogue on the box stands against OD-5. */
export const CATALOGUE_STATES = ['fresh', 'stale', 'refused', 'missing'] as const;
export type CatalogueState = (typeof CATALOGUE_STATES)[number];

/** Judge a catalogue's age against the policy (OD-5). One function, both mounts and the till. */
export function catalogueState(
  appliedAt: string | null,
  now: Date,
  policy: Pick<OfflinePolicy, 'catalogueBannerAfterS' | 'catalogueRefuseAfterS'> = OFFLINE_POLICY,
): CatalogueState {
  if (!appliedAt) return 'missing';
  const at = Date.parse(appliedAt);
  if (!Number.isFinite(at)) return 'missing';
  const ageS = Math.max(0, Math.floor((now.getTime() - at) / 1000));
  if (ageS >= policy.catalogueRefuseAfterS) return 'refused';
  if (ageS >= policy.catalogueBannerAfterS) return 'stale';
  return 'fresh';
}

const CacheAgeSchema = z.object({
  held: z.boolean(),
  appliedAt: z.string().nullable(),
  ageSeconds: z.number().int().nullable(),
});
export type BridgeCacheAge = z.infer<typeof CacheAgeSchema>;

/** `GET status` — what the till's lane arbiter and banner read. No personal data. */
export const BridgeStatusSchema = z.object({
  stationId: z.string().uuid(),
  boxId: z.string().uuid(),
  /**
   * The box's own link to the platform: `up` is the wire (the agent's
   * `linkUp`), `offline` the Console's switch. The till sells through the
   * platform while `lane` is `platform` (OD-1).
   */
  link: z.object({
    up: z.boolean(),
    offline: z.boolean(),
    lane: z.enum(BRIDGE_LANES),
  }),
  catalogue: CacheAgeSchema.extend({
    state: z.enum(CATALOGUE_STATES),
    version: z.string().nullable(),
    bannerAfterSeconds: z.number().int(),
    refuseAfterSeconds: z.number().int(),
  }),
  members: CacheAgeSchema,
  staff: CacheAgeSchema,
  denyList: CacheAgeSchema,
  /** Facts waiting to go up. "3 things to send" on the banner. */
  outboxDepth: z.number().int().min(0),
  receiptMark: z
    .object({ prefix: z.string().nullable(), highWaterMark: z.number().int().min(0) })
    .nullable(),
  serverTime: z.string(),
});
export type BridgeStatus = z.infer<typeof BridgeStatusSchema>;

/**
 * `POST unlock` — the till presents what it holds (OD-2).
 *
 * The staff token when it has a live one, and the password always. With no
 * usable token the box admits a FRESH sign-in for somebody it has seen in the
 * last thirty days, while it holds a deny-list pulled in the last 72 hours
 * (OD-6); the till names the account it is signing in, because the box's copy
 * of the staff list carries no phone numbers (`cacheBundle` in the api).
 */
export const BridgeUnlockRequestSchema = z
  .object({
    password: z.string().min(1).max(200),
    token: z.string().min(1).max(4096).nullish(),
    accountId: z.string().uuid().nullish(),
  })
  .strict();
export type BridgeUnlockRequest = z.infer<typeof BridgeUnlockRequestSchema>;

/** How a box session was opened. `platform` on a virtual box that took the platform session. */
export const BRIDGE_UNLOCK_METHODS = ['platform', 'offline_token', 'offline_sign_in'] as const;
export type BridgeUnlockMethod = (typeof BRIDGE_UNLOCK_METHODS)[number];

export const BridgeUnlockResponseSchema = z.object({
  /** The opaque box session; `Authorization: Bearer` on every till call to a Pi. */
  session: z.string(),
  accountId: z.string().uuid(),
  method: z.enum(BRIDGE_UNLOCK_METHODS),
  /** True for a fresh sign-in with no live token: its facts are marked `offlineFresh` (OD-6). */
  offlineFresh: z.boolean(),
  expiresAt: z.string(),
  /** When the box took the staff list this was decided from. What the banner reads. */
  cachedAt: z.string().nullable(),
  cacheAgeSeconds: z.number().int().nullable(),
  mustChangePassword: z.boolean(),
});
export type BridgeUnlockResponse = z.infer<typeof BridgeUnlockResponseSchema>;

// --- The record intents: members, children, visits ---------------------------
//
// A counter with no internet still has to sign a family up, add a child and
// confirm who is visiting (plan §2.8). Each of these is a FACT the box writes
// to its outbox, with a row in its local overlay so the next lookup finds it,
// in one store transaction. The ids are the till's (OD-12), so a create the
// till retries through a dropped reply meets itself.
//
// The payloads are the sync handlers' own (`apps/api/src/services/sync.ts`),
// declared here so the producer on the box and the applier in the cloud read
// one schema.

const Uuid = z.string().uuid();
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ContactChannel = z.enum(['whatsapp', 'telegram', 'line']);

/**
 * Marked on every fact made under a fresh offline sign-in (OD-6), so the
 * cloud's audit row says the person was admitted on a cached password with no
 * live shift token.
 */
const OfflineFresh = z.boolean().optional();

export const OfflineMemberCreatedSchema = z.object({
  memberId: Uuid,
  phone: z.string().min(4).max(32),
  nickname: z.string().min(1).max(120),
  name: z.string().max(200).nullish(),
  preferredChannel: ContactChannel.nullish(),
  createdVia: z.enum(['pos', 'booking', 'import']).default('pos'),
  offlineFresh: OfflineFresh,
});
export type OfflineMemberCreated = z.infer<typeof OfflineMemberCreatedSchema>;

export const OfflineMemberUpdatedSchema = z.object({
  memberId: Uuid,
  nickname: z.string().min(1).max(120).optional(),
  name: z.string().max(200).nullish(),
  email: z.string().email().max(200).nullish(),
  notes: z.string().max(2_000).nullish(),
  preferredChannel: ContactChannel.nullish(),
  offlineFresh: OfflineFresh,
});
export type OfflineMemberUpdated = z.infer<typeof OfflineMemberUpdatedSchema>;

/**
 * A tier change made at a counter with no internet (OD-11): an upgrade on a
 * checked document, or a downgrade by somebody holding
 * `pos:member:tier_downgrade`. The verification row's id is the box's, so a
 * replay files it once.
 */
export const OfflineMemberTierChangedSchema = z.discriminatedUnion('direction', [
  z.object({
    direction: z.literal('upgrade'),
    memberId: Uuid,
    verificationId: Uuid,
    toTier: z.string().min(1).max(64),
    evidenceType: z.enum(TIER_PROOF_TYPES),
    evidenceExpiresAt: IsoDate,
    note: z.string().max(500).nullish(),
    offlineFresh: OfflineFresh,
  }),
  z.object({
    direction: z.literal('downgrade'),
    memberId: Uuid,
    verificationId: Uuid,
    reason: z.string().trim().min(3).max(200),
    offlineFresh: OfflineFresh,
  }),
]);
export type OfflineMemberTierChanged = z.infer<typeof OfflineMemberTierChangedSchema>;

export const OfflineChildFields = {
  name: z.string().min(1).max(120),
  dateOfBirth: IsoDate.nullish(),
  ageYears: z.number().int().min(0).max(17).nullish(),
  allergies: z.string().max(1_000).nullish(),
  medicalNotes: z.string().max(1_000).nullish(),
  medicalAlert: z.boolean().optional(),
  dietary: z.string().max(1_000).nullish(),
  foodRestrictions: z.string().max(1_000).nullish(),
  notes: z.string().max(1_000).nullish(),
};

export const OfflineChildCreatedSchema = z.object({
  childId: Uuid,
  memberId: Uuid,
  ...OfflineChildFields,
  offlineFresh: OfflineFresh,
});
export type OfflineChildCreated = z.infer<typeof OfflineChildCreatedSchema>;

export const OfflineChildUpdatedSchema = z.object({
  childId: Uuid,
  ...OfflineChildFields,
  name: OfflineChildFields.name.optional(),
  offlineFresh: OfflineFresh,
});
export type OfflineChildUpdated = z.infer<typeof OfflineChildUpdatedSchema>;

export const OfflineVisitCreatedSchema = z.object({
  visitId: Uuid,
  memberId: Uuid.nullish(),
  visitDate: IsoDate,
  childIds: z.array(Uuid).max(20).default([]),
  status: z.enum(['draft', 'active', 'closed']).default('draft'),
  offlineFresh: OfflineFresh,
});
export type OfflineVisitCreated = z.infer<typeof OfflineVisitCreatedSchema>;

/**
 * The intents a till sends the bridge to write a record, and the fact each
 * becomes. The intent's payload is the fact's payload less `offlineFresh`,
 * which the BOX stamps from the session and a till cannot set.
 */
export const BRIDGE_RECORD_INTENTS = {
  'member.create': 'member.created',
  'member.update': 'member.updated',
  'member.tier_change': 'member.tier_changed',
  'child.create': 'child.created',
  'child.update': 'child.updated',
  'visit.create': 'visit.created',
} as const;
export type BridgeRecordIntent = keyof typeof BRIDGE_RECORD_INTENTS;

/** The till prices a cart on its box with this intent (plan §2.4 step 1). */
export const BRIDGE_CART_QUOTE_INTENT = 'cart.quote';

/**
 * The money intents' family names. Round 4 builds the ones in
 * `BRIDGE_SALE_INTENTS`; any other `sale.*` or `payment.*` a till sends is
 * refused politely rather than answered `unknown_intent`, so a till newer than
 * its box can still say what is happening in words a guest can hear.
 */
export const BRIDGE_MONEY_INTENT_PREFIXES = ['sale.', 'payment.'] as const;

/**
 * SELLING ON THE BOX LANE (offline plan §2.4, Round 4).
 *
 *   - `sale.finalise`: the whole sale and the money that closes it — cash, or
 *     nothing at all for a ฿0 comp — priced, numbered, banded, put on disk and
 *     printed by the box in one store transaction (`SaleQueue.record`);
 *   - `payment.start`: a card or the PAX QR on the counter's own terminal,
 *     which the box drives itself; an approval closes the sale the same way;
 *   - `payment.inquire`: ask the terminal what became of a tender with no
 *     final answer (a Digio terminal can be asked; a GHL card sale cannot);
 *   - `payment.confirm`: staff confirm, against the terminal's own screen and
 *     with the approval code typed, a GHL card sale that gave no answer (OD-3);
 *   - `payment.status`: where a terminal tender the box is holding stands —
 *     what the till polls while a guest finds a card;
 *   - `sale.reprint`: another copy of today's sale from this box's own log.
 */
export const BRIDGE_SALE_INTENTS = {
  finalise: 'sale.finalise',
  reprint: 'sale.reprint',
  paymentStart: 'payment.start',
  paymentInquire: 'payment.inquire',
  paymentConfirm: 'payment.confirm',
  paymentStatus: 'payment.status',
} as const;
export type BridgeSaleIntent = (typeof BRIDGE_SALE_INTENTS)[keyof typeof BRIDGE_SALE_INTENTS];

/**
 * The till tells its box the receipt number the platform gave an online sale
 * (OD-4), so the box's offline series continues from the higher of that and
 * the mark it last pulled — never re-issuing a number the counter has already
 * handed a guest.
 */
export const BRIDGE_RECEIPT_OBSERVED_INTENT = 'receipt.observed';

/**
 * The refusal a money intent meets when the box has nowhere to write it: an
 * api instance the virtual box is not running on, or a box with no store. The
 * copy stays the round-3 sentence the till already shows.
 */
export const BOX_LANE_PAYMENT_REFUSAL = {
  code: 'BOX_LANE_PAYMENT_UNAVAILABLE',
  message:
    'This counter is working without the internet, and taking payment offline is not switched on yet. Keep the order and take payment when the connection is back.',
} as const;

/**
 * What a till on the box lane says when its box did not answer either: the
 * sale was not taken anywhere, and the counter's own network is the thing to
 * look at.
 */
export const BOX_LANE_UNREACHABLE = {
  code: 'BOX_LANE_UNREACHABLE',
  message:
    'Neither the internet nor this counter’s box answered, so nothing was taken. Check the counter’s box and its network, then try again.',
} as const;

/**
 * WHAT CANNOT BE TAKEN ON THE BOX LANE, in the capability list's own reasons
 * (plan §2.8, `ARCHITECTURE.md` §17). Each is said in words a guest can hear;
 * the list is what they say it for:
 *
 *   - 2C2P QR — minting is a server call;
 *   - gift or prize voucher — single use across counters is server-validated;
 *   - wallet spend — refused until the wallet ticket adds the capped row (OD-14);
 *   - online booking redemption — kept for a box too old to redeem one; since
 *     S2-12 round 5 a box redeems from its own copy (`BRIDGE_BOOKING_INTENTS`);
 *   - refund, void — online only, with `pos:refund:approve`; a "refund
 *     requested" note queues on the till.
 *
 * Two more are this lane's own bounds rather than rows of the list: a split
 * tender (the box closes a sale with one payment; the ledger takes a split
 * online), and a counter with no terminal of the kind asked for.
 */
export const BOX_LANE_REFUSALS = {
  qr2c2p: {
    code: 'BOX_LANE_2C2P_QR_REFUSED',
    message:
      'A 2C2P QR is minted by the platform, so it cannot be offered while this counter is offline. Take cash, a card on the terminal or the PAX QR instead.',
  },
  voucher: {
    code: 'VOUCHER_NEEDS_INTERNET',
    message: 'Vouchers need the internet — take this one when the connection is back',
  },
  wallet: {
    code: 'BOX_LANE_WALLET_REFUSED',
    message:
      'Wallet spend needs the internet until wallets can be capped at the counter. Take another payment while this counter is offline.',
  },
  booking: {
    code: 'BOX_LANE_BOOKING_REFUSED',
    message:
      'Online bookings are redeemed with the internet. Keep the booking and redeem it when the connection is back.',
  },
  refund: {
    code: 'BOX_LANE_REFUND_REFUSED',
    message:
      'Refunds and voids need the internet and a manager who can approve them. Note the refund request — it is done when the connection is back.',
  },
  split: {
    code: 'BOX_LANE_SPLIT_REFUSED',
    message:
      'While this counter is offline a sale is paid in one go. Take the whole amount with one payment, or split it when the connection is back.',
  },
  noTerminal: {
    code: 'BOX_LANE_NO_TERMINAL',
    message: 'This counter has no terminal for that payment. Take another payment.',
  },
} as const;
export type BoxLaneRefusal = keyof typeof BOX_LANE_REFUSALS;

/** The refusal a quote meets when the box's catalogue is older than OD-5 allows. */
export const BOX_CATALOGUE_TOO_OLD = {
  code: 'BOX_CATALOGUE_TOO_OLD',
  message:
    'This counter has not had a price update for over a week, so it cannot sell offline. Connect it to the internet once to refresh its prices.',
} as const;

/** The member the bridge answers with: the till's `ApiMember`, from the box's copy. */
export interface BridgeChild {
  id: string;
  name: string;
  dateOfBirth: string | null;
  ageYears: number | null;
  allergies: string | null;
  medicalNotes: string | null;
  medicalAlert: boolean;
  dietary: string | null;
  foodRestrictions: string | null;
  notes: string | null;
  lastConfirmedAt: string | null;
}

export interface BridgeMember {
  id: string;
  phone: string;
  nickname: string;
  name: string | null;
  email: string | null;
  tierCode: string;
  preferredChannel: 'whatsapp' | 'telegram' | 'line' | null;
  notes: string | null;
  /** The box's copy carries no tier evidence (the bundle's doctrine), so this is null. */
  tierVerification: null;
  children: BridgeChild[];
  /** Set when a merge put children from two counters on this member (OD-7). */
  childrenReviewSince: string | null;
  /** Where the answer came from: the cache the box pulled, or its own offline overlay. */
  source: 'cache' | 'overlay';
}

// --- The cart a till prices on its box (plan §2.4 step 1) ---------------------
//
// The same body the till sends `POST /sales/quote` (`apps/api/src/routes/
// sales.ts`), so a till that switched lanes sends one cart either way. Like the
// platform's, it says what is on the order and never what it costs: every
// price comes from the box's cached catalogue through the one satang engine.

const DiscountComponentTargetSchema = z.union([
  z.object({ kind: z.literal('kids') }),
  z.object({ kind: z.literal('adults') }),
  z.object({ kind: z.literal('socks') }),
  z.object({ kind: z.literal('addon'), addOnId: z.string().min(1).max(100) }),
]);

const BridgeCartLineSchema = z.object({
  id: z.string().uuid(),
  packageId: z.string().uuid(),
  packageName: z.string().max(160).optional(),
  tier: z.string().max(40).optional(),
  kids: z.number().int().min(0).max(50),
  adults: z.number().int().min(0).max(50),
  socks: z.number().int().min(0).max(50).default(0),
  addOns: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        name: z.string().max(160).optional(),
        unitSatang: z.number().int().min(0).max(100_000_000).optional(),
        quantity: z.number().int().min(1).max(99),
        taxCategoryOverride: z.string().max(40).optional(),
      }),
    )
    .max(20)
    .default([]),
  serviceFee: z
    .object({ label: z.string().max(120), amountSatang: z.number().int().min(0) })
    .nullish(),
  foodProvision: z
    .object({
      mode: z.enum(['prepaid_items', 'prepaid_credit']),
      paidSatang: z.number().int().min(0),
    })
    .nullish(),
  promoItem: z
    .object({
      itemId: z.string().min(1).max(100),
      itemKind: z.enum(['menu', 'merch']),
      name: z.string().max(160),
      priceSatang: z.number().int().min(0),
    })
    .nullish(),
  lineTotalSatang: z.number().int().min(0).optional(),
  stayHours: z.number().int().min(0).max(24).optional(),
  stayDurationLabel: z.string().max(60).optional(),
});

const BridgeCartItemSchema = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  quantity: z.number().int().min(1).max(99),
  modifiers: z
    .array(z.object({ groupId: z.string().uuid(), optionIds: z.array(z.string().uuid()).max(20) }))
    .max(12)
    .default([]),
  note: z.string().max(280).optional(),
  variant: z
    .object({ variantId: z.string().min(1).max(100), variantLabel: z.string().min(1).max(60) })
    .nullish(),
  lineTotalSatang: z.number().int().min(0).optional(),
});

const BridgeManualDiscountSchema = z.object({
  id: z.string().uuid(),
  scope: z.enum(['order', 'line']),
  targetLineId: z.string().uuid().optional(),
  targetComponent: DiscountComponentTargetSchema.optional(),
  targetLabel: z.string().max(120).optional(),
  type: z.enum(['percent', 'fixed', 'comp']),
  value: z.number().min(0).max(100_000_000).default(0),
  reason: z.string().min(1).max(120),
  note: z.string().max(500).optional(),
  appliedByAccountId: z.string().uuid().optional(),
  appliedByName: z.string().max(160).optional(),
  appliedAt: z.string().max(40).optional(),
});

const BridgePromoSchema = z.object({
  code: z.string().min(1).max(40),
  label: z.string().max(160),
  type: z.enum(['percent', 'fixed', 'free_item']),
  value: z.number().min(0).max(100_000_000),
  freeItemId: z.string().max(100).optional(),
  freeItemKind: z.enum(['menu', 'merch']).optional(),
  target: z.unknown().optional(),
});

const BridgeCartBodySchema = z.object({
  memberId: z.string().uuid().nullish(),
  tier: z.string().max(40).optional(),
  tierClaimActionId: z.string().min(1).max(200).optional(),
  pricingMode: z.enum(['weekday', 'weekend']).optional(),
  pricingModeReason: z.string().max(160).optional(),
  socks: z
    .object({
      addOnId: z.string().min(1).max(100),
      unitSatang: z.number().int().min(0).optional(),
      label: z.string().max(60).optional(),
    })
    .optional(),
  lines: z.array(BridgeCartLineSchema).max(50).default([]),
  items: z.array(BridgeCartItemSchema).max(100).default([]),
  pickupCode: z.string().max(12).optional(),
  manualDiscounts: z.array(BridgeManualDiscountSchema).max(20).default([]),
  promos: z.array(BridgePromoSchema).max(10).default([]),
  promoCodes: z.array(z.string().min(1).max(40)).max(10).default([]),
  channel: z.enum(['till', 'fnb', 'shop']).optional(),
  expectedTotalSatang: z.number().int().min(0).optional(),
});

/** Flat, or nested under `cart` as the till nests it; the nested copy wins. */
export const BridgeCartSchema = BridgeCartBodySchema.extend({
  cart: BridgeCartBodySchema.optional(),
}).passthrough();
export type BridgeCart = z.infer<typeof BridgeCartBodySchema>;

/** The cart a `cart.quote` intent carries, unwrapped. */
export function bridgeCartOf(payload: unknown): BridgeCart {
  const parsed = BridgeCartSchema.parse(payload);
  const inner = parsed.cart;
  if (inner) return inner;
  const { cart: _nested, ...flat } = parsed;
  return BridgeCartBodySchema.parse(flat);
}

// --- Selling on the box lane (plan §2.4, Round 4) ---------------------------------
//
// The till sends the same cart it would send `POST /sales`, under the ids it
// minted (OD-12): the sale, every line, the press. The box prices it again
// from its own catalogue — on this lane the box's figure authorises taking
// money (`ARCHITECTURE.md` §17) — and refuses a cart whose total the till saw
// differently, before anything is numbered or taken.

/** One tender as the till took it. `method` is the configured token staff chose. */
export const BridgeTenderSchema = z.object({
  /** `x-oto-action-id` — the press. The replay key on the platform (rule 2). */
  actionId: z.string().min(1).max(200),
  method: z.string().min(1).max(40),
  kind: z.enum(PAYMENT_METHOD_KINDS),
  amountSatang: z.number().int().min(0).max(100_000_000),
  tenderedSatang: z.number().int().min(0).max(100_000_000).optional(),
  changeSatang: z.number().int().min(0).max(100_000_000).optional(),
});
export type BridgeTender = z.infer<typeof BridgeTenderSchema>;

const BridgeSaleBaseSchema = z.object({
  /** Minted at the till, once per cart. The box and the platform both key on it. */
  saleId: Uuid,
  /** The Pay press — the sale's own action id. */
  actionId: z.string().min(1).max(200),
  /** The till's clock when Pay was pressed. The box's own is what it records. */
  occurredAt: z.string().max(40).optional(),
  visitId: Uuid.nullish(),
  note: z.string().max(500).nullish(),
  /**
   * The name the receipt prints beside "Staff". A till's box holds no staff
   * names (SCRUM-223), and the till knows who is signed in; it is printed and
   * kept for a reprint, and never sent to the platform, which prints its own.
   */
  staffName: z.string().max(120).nullish(),
  /** The children staff confirmed for this sale's visit, when the box's copy lacks the visit. */
  visitChildIds: z.array(Uuid).max(20).optional(),
  cart: z.record(z.unknown()),
});

/** `sale.finalise`: the sale and the money that closes it — one cash tender, or none for a ฿0 comp. */
export const BridgeSaleFinaliseSchema = BridgeSaleBaseSchema.extend({
  tender: BridgeTenderSchema.nullish(),
});
export type BridgeSaleFinalise = z.infer<typeof BridgeSaleFinaliseSchema>;

/** `payment.start`: a card or a QR on the counter's own terminal, for the whole balance. */
export const BridgePaymentStartSchema = BridgeSaleBaseSchema.extend({
  tender: BridgeTenderSchema.extend({ kind: z.enum(['card', 'qr']) }),
});
export type BridgePaymentStart = z.infer<typeof BridgePaymentStartSchema>;

/** `payment.inquire` and `payment.status`: what became of a tender with no final answer. */
export const BridgePaymentInquireSchema = z.object({
  saleId: Uuid,
  attemptId: Uuid,
});
export type BridgePaymentInquire = z.infer<typeof BridgePaymentInquireSchema>;

/**
 * `payment.confirm` (OD-3): a GHL card sale that gave no answer, confirmed by
 * staff against the terminal's own screen. `took` with the approval code typed
 * off it records the money and flags it for end-of-day reconciliation; `took:
 * false` records that nothing was taken.
 */
export const BridgePaymentConfirmSchema = z
  .object({
    saleId: Uuid,
    attemptId: Uuid,
    took: z.boolean(),
    approvalCode: z.string().trim().min(1).max(12).nullish(),
    last4: z.string().regex(/^\d{4}$/).nullish(),
    note: z.string().max(300).nullish(),
  })
  .refine((body) => !body.took || !!body.approvalCode, {
    message: 'Type the approval code from the terminal’s screen to confirm the payment',
    path: ['approvalCode'],
  });
export type BridgePaymentConfirm = z.infer<typeof BridgePaymentConfirmSchema>;

/** `receipt.observed`: the number the platform gave an online sale at this station (OD-4). */
export const BridgeReceiptObservedSchema = z.object({
  receiptNumber: z.string().min(3).max(40),
});

/** `sale.reprint`: another copy of a sale this box printed today. */
export const BridgeSaleReprintSchema = z.object({
  saleId: Uuid,
  kind: z.enum(SALE_REPRINT_KINDS),
  reason: z.string().max(200).nullish(),
});
export type BridgeSaleReprint = z.infer<typeof BridgeSaleReprintSchema>;

/** The sale as a box-lane answer gives it back: the till's `ApiSale`, from the box. */
export interface BridgeSaleView {
  id: string;
  status: 'tendering' | 'finalised';
  businessDate: string;
  occurredAt: string;
  receiptNumber: string | null;
  receiptSeries: string | null;
  receiptSeq: number | null;
  stationId: string;
  boxId: string;
  pricingMode: 'weekday' | 'weekend';
  customerTier: string;
  totals: {
    subtotalSatang: number;
    manualDiscountSatang: number;
    promoDiscountSatang: number;
    discountSatang: number;
    netSatang: number;
    serviceChargeSatang: number;
    taxInclusiveSatang: number;
    taxExclusiveSatang: number;
    grossSatang: number;
    unappliedDiscountSatang: number;
  };
  engineVersion: string;
  /** Where it was filed: the box's own queue, to reach the platform when the link is back. */
  origin: 'box';
}

/**
 * One band the box minted for a sale, as the till's confirmation reads it back
 * on the box lane. The platform's own sale read is unreachable offline, so this
 * is where the payment-done screen gets its band codes: the SHORT code the guest
 * holds (`T1-7KMQ4X`) and the child it names, so a band that fails to print can
 * be read out at the counter during an outage. Never the signed code, which is a
 * gate credential; `cartLineId` places each band on its bracelet row exactly as
 * the online screen does.
 */
export interface BridgeSaleBand {
  id: string;
  kind: 'kid' | 'adult';
  status: string;
  shortCode: string | null;
  cartLineId: string;
  saleLineId: string | null;
  childId: string | null;
  childName: string | null;
}

/** What `sale.finalise` and a closing `payment.*` answer with. */
export interface BridgeSaleAnswer {
  sale: BridgeSaleView;
  finalised: boolean;
  outstandingSatang: number;
  /** The tender this call took or is waiting on, in the platform's attempt shape. */
  attempt: PaymentAttemptView | null;
  /** True when the box had already recorded this sale and answered from its log. */
  replay: boolean;
  printing: { jobs: Array<{ id: string; kind: string; status: string }>; notes: string[] };
  drawer: 'opened' | 'failed' | 'not_asked';
  /** Everything still waiting to go up. "3 sales to send". */
  outboxDepth: number;
  /**
   * The bands this sale minted, once it is finalised — the codes the guest holds
   * and the children they name. Present on a finalised answer (and its replay),
   * absent on one still tendering. The confirmation reads them on the box lane
   * where the platform's sale read cannot be reached.
   */
  bands?: BridgeSaleBand[];
}

// --- Redeeming an online booking on the box lane (S2-12 round 5) --------------------------
//
// A family who booked and paid online arrives while the counter's box has no
// internet. The box holds the park key (it checks the booking QR itself), the
// bookings for today ±1 with their redemptions (the `bookings` cache scope),
// and the sale path that numbers, bands and prints offline (`SaleQueue`). So
// the same three stages the till runs online — find the booking, read its
// summary, Confirm & Issue — ride the bridge:
//
//   - `booking.lookup` answers the booking from the box's copy, in the
//     platform's own `GET /bookings/:id` shape, with the box's own local
//     redemption laid over it;
//   - `booking.redeem` claims it in the box's redemption log (one row per
//     booking per box, written BEFORE anything is sold), commits the sale from
//     the booking's paid lines with the paid-online tender through the box's
//     own sale path, and queues ONE `booking.redeemed` fact.
//
// SINGLE USE ACROSS TWO BOXES IS NOT MADE SAFE OFFLINE (OD-A9). Tills on one box
// share its log, so a second till is told who redeemed it and when. A second
// BOX redeeming the same booking is caught at sync: its event is quarantined
// with an alert naming both redemptions and is never applied blind.

export const BRIDGE_BOOKING_INTENTS = {
  lookup: 'booking.lookup',
  redeem: 'booking.redeem',
} as const;

/** The fact a box queues for a booking it redeemed (the sync handler's own name). */
export const BOOKING_REDEEMED_FACT = 'booking.redeemed';

/** `booking.lookup`: by the id a scan vouched for, the reference typed, or a QR read on this device. */
export const BridgeBookingLookupSchema = z
  .object({
    bookingId: Uuid.optional(),
    reference: z.string().trim().min(3).max(40).optional(),
    qr: z.string().trim().min(8).max(400).optional(),
  })
  .refine((body) => !!(body.bookingId || body.reference || body.qr), {
    message: 'Name the booking by its QR, its id or its reference',
  });
export type BridgeBookingLookup = z.infer<typeof BridgeBookingLookupSchema>;

/**
 * `booking.redeem` — Confirm & Issue on the box lane. `actionId` is the press:
 * the same press again is answered from the box's log with the sale it made.
 */
export const BridgeBookingRedeemSchema = z.object({
  bookingId: Uuid,
  actionId: z.string().min(1).max(200),
  /** The visit reception confirmed, whose children the kids' bands name. */
  visitId: Uuid.nullish(),
  /** The children staff confirmed, when the box's copy lacks the visit. */
  visitChildIds: z.array(Uuid).max(20).optional(),
  /** Printed beside "Staff" and read back on a second scan; never sent to the platform. */
  staffName: z.string().max(120).nullish(),
});
export type BridgeBookingRedeem = z.infer<typeof BridgeBookingRedeemSchema>;

/**
 * THE `booking.redeemed` FACT. Its id (`redemptionId`) is minted on the box, so
 * a replay of the event — the same envelope again, or the same fact under a new
 * one — files it once. `saleId` is the sale the box committed for it, which
 * reaches the platform ahead of this fact as `sale.finalised`.
 */
export const OfflineBookingRedeemedSchema = z.object({
  redemptionId: Uuid,
  bookingId: Uuid,
  saleId: Uuid,
  reference: z.string().min(1).max(40),
  /** When the counter redeemed it, by the box's clock. */
  redeemedAt: z.string().datetime(),
  /** The SHORT codes of the bands handed over — never the signed ones. */
  bandCodes: z.array(z.string().min(1).max(40)).max(200).default([]),
  receiptNumber: z.string().max(40).nullish(),
  staffTokenJti: Uuid.nullish(),
  offlineFresh: OfflineFresh,
});
export type OfflineBookingRedeemed = z.infer<typeof OfflineBookingRedeemedSchema>;

/** The box-lane refusals of a booking, in the counter's words. */
export const BOX_BOOKING_REFUSALS = {
  unknown: {
    code: 'BOOKING_NOT_ON_BOX',
    message:
      'This counter is offline and has no copy of that booking, so it cannot be checked here. Please send the family to reception.',
  },
  qrUnchecked: {
    code: 'BOOKING_QR_UNCHECKED',
    message:
      'This counter cannot check that booking QR while it is offline — scan it at the counter’s own scanner, or type the booking reference instead.',
  },
  inProgress: {
    code: 'BOOKING_REDEMPTION_IN_PROGRESS',
    message: 'Another till on this counter is redeeming this booking right now. Wait a moment, then look it up again.',
  },
} as const;

/** The booking as a box-lane answer gives it back: the till's `PlatformBooking`, from the box. */
export interface BridgeBookingView {
  id: string;
  reference: string;
  branchId: string;
  branchName: string | null;
  memberId: string | null;
  bookingDate: string;
  createdAt: string;
  status: string;
  totalSatang: number;
  tier: string;
  rateMode: string | null;
  parentName: string | null;
  phone: string | null;
  paymentMethod: string | null;
  lines: Array<{
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
  }>;
  redemption: {
    at: string;
    branchName: string | null;
    stationName: string | null;
    staffName: string | null;
    bandCodes: string[];
  } | null;
  /** Where the answer came from: the cached copy, or this box's own redemption log. */
  source: 'cache' | 'log';
}

/** What `booking.redeem` answers: the sale the box committed for it, its bands, its paper. */
export interface BridgeBookingRedeemAnswer {
  booking: BridgeBookingView;
  sale: BridgeSaleView;
  bands: BridgeSaleBand[];
  printing: { jobs: Array<{ id: string; kind: string; status: string }>; notes: string[] };
  /** True when this press was already answered, and this is the log's answer again. */
  replay: boolean;
  outboxDepth: number;
}

// --- What the box priced from (OD-8) ---------------------------------------------------

/**
 * THE PRICES A BOX-LANE SALE WAS TAKEN AT, carried with the fact (OD-8).
 *
 * The platform re-prices every replayed sale with its own catalogue. When the
 * two disagree and the box priced from an OLDER catalogue version, the money
 * was taken at a price the park displayed: the sale is filed at the box's
 * price — re-priced here from exactly these rows — and an alert says so. The
 * same version at a different total is a defect, and stays quarantined.
 *
 * Only the rows the cart used, so the fact stays small.
 */
export const OfflinePriceBasisSchema = z.object({
  catalogueVersion: z.string().max(64).nullable(),
  pricingMode: z.enum(['weekday', 'weekend']),
  tier: z.string().min(1).max(40),
  taxConfig: TaxConfigSchema.nullable(),
  packages: z
    .array(
      z.object({
        id: Uuid,
        prices: z.record(
          z.string(),
          z.object({ weekday: z.number().int().min(0), weekend: z.number().int().min(0) }),
        ),
        adultRules: z.unknown().nullable(),
      }),
    )
    .max(50)
    .default([]),
  products: z
    .array(
      z.object({
        id: Uuid,
        priceSatang: z.number().int().min(0),
        priceWeekendSatang: z.number().int().min(0).nullable(),
      }),
    )
    .max(200)
    .default([]),
  options: z
    .array(
      z.object({
        id: Uuid,
        priceSatang: z.number().int(),
        priceWeekendSatang: z.number().int().nullable(),
      }),
    )
    .max(400)
    .default([]),
});
export type OfflinePriceBasis = z.infer<typeof OfflinePriceBasisSchema>;
