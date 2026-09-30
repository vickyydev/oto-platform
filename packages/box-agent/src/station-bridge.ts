import { createHash, randomBytes } from 'node:crypto';
import {
  BOX_CATALOGUE_TOO_OLD,
  BOX_LANE_PAYMENT_REFUSAL,
  BOX_SESSION_PREFIX,
  BRIDGE_CART_QUOTE_INTENT,
  BRIDGE_MONEY_INTENT_PREFIXES,
  BRIDGE_RECORD_INTENTS,
  OFFLINE_POLICY,
  OfflineChildCreatedSchema,
  OfflineChildUpdatedSchema,
  OfflineMemberCreatedSchema,
  OfflineMemberTierChangedSchema,
  OfflineMemberUpdatedSchema,
  OfflineVisitCreatedSchema,
  bridgeCartOf,
  businessDate,
  catalogueState,
  normalizePhone,
  parseDayStart,
  type BridgeChild,
  type BridgeMember,
  type BridgeRecordIntent,
  type BridgeStatus,
  type BridgeUnlockMethod,
  type BridgeUnlockRequest,
  type BridgeUnlockResponse,
  type OfflinePolicy,
} from '@oto/shared';
import type {
  StationChannelMessage,
  StationIntent,
  StationSessionDocument,
  StationView,
} from './contract';
import {
  OfflinePriceError,
  priceOfflineCart,
  readOfflineCatalogue,
  type OfflineQuote,
} from './offline-pricing';
import { uuidv7 } from './signing';
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
  OverlayRecord,
  OverlayWrite,
  QueuedFact,
} from './store';
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
 * Nothing here can take money. `sale.*` and `payment.*` are round 4's and are
 * refused politely until then (`BOX_LANE_PAYMENT_REFUSAL`).
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
      const quote = await this.quote(station, intent.payload);
      return { document: await this.host.sessions.open(stationId), result: { quote } };
    }
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
    // The member's tier as this counter knows it: a tier changed here offline
    // (OD-11) prices the cart that follows, as it would online.
    const owner = cart.memberId ? await this.resolveMember(cart.memberId) : null;
    const memberTier = owner ? (s(owner.overlay?.record.tierCode) ?? owner.member.tierCode) : null;
    if (cart.memberId && memberTier === null) {
      throw new BridgeError(404, 'NOT_FOUND', 'Member not found');
    }
    try {
      const quote = priceOfflineCart(catalogue, cart, {
        now,
        timezone: branch.timezone,
        businessDayStart: branch.businessDayStart,
        memberTier,
      });
      return { ...quote, catalogueState: state, catalogueAppliedAt: bundle?.appliedAt ?? null };
    } catch (err) {
      if (err instanceof OfflinePriceError) {
        throw new BridgeError(
          err.code === 'SALE_LINE_PRICE_MISMATCH'
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
        if (!(await this.tierCodes()).includes(body.toTier)) {
          throw new BridgeError(400, 'VALIDATION', `Unknown tier "${body.toTier}"`);
        }
        const today = this.host.now().toISOString().slice(0, 10);
        if (body.evidenceExpiresAt < today) {
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
    const rows = await this.host.store.allOverlay(this.host.boxId);
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
