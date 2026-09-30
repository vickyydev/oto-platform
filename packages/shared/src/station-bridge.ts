import { z } from 'zod';
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
 * The money intents, which round 4 builds. Until then the bridge answers them
 * with a polite refusal rather than `unknown_intent`, so a till that switched
 * lanes mid-sale can say what is happening in words a guest can hear.
 */
export const BRIDGE_MONEY_INTENT_PREFIXES = ['sale.', 'payment.'] as const;

/** The refusal a money intent meets on the box lane this round. */
export const BOX_LANE_PAYMENT_REFUSAL = {
  code: 'BOX_LANE_PAYMENT_UNAVAILABLE',
  message:
    'This counter is working without the internet, and taking payment offline is not switched on yet. Keep the order and take payment when the connection is back.',
} as const;

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
