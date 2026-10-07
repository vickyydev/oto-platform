import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  benefitApplication,
  benefitCredential,
  benefitUsage,
  employee,
  paymentAttempt,
  sale,
  saleDiscount,
  type BenefitRemovalReason,
  type BenefitUsageDelta,
  type Db,
} from '@oto/db';
import {
  applyStaffBenefits,
  BENEFIT_CHECKOUT_REFUSALS,
  BENEFIT_CHECKOUT_WORDS,
  BENEFIT_CREDENTIAL_REFUSALS,
  benefitLineRelief,
  benefitLinesOf,
  benefitPeriodKey,
  emptyBenefitUsage,
  isPaymentReversalPending,
  newId,
  offlineBenefitFacts,
  offlineBenefitProfile,
  PAYMENT_ATTEMPT_TAKEN_STATUSES,
  PAYMENT_ATTEMPT_TERMINAL_STATUSES,
  PRICING_ENGINE_VERSION,
  staffBenefitDiscount,
  type BenefitApplyResult,
  type BenefitBreakdown,
  type BenefitProfile,
  type BenefitRole,
  type BenefitUsageState,
  type CartBenefitInput,
  type ManualDiscount,
  type OfflineBenefitRecord,
  type TicketCartLine,
} from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import { resolveBenefitCredential, type ResolvedBenefit } from './benefit-credentials';
import { effectiveBenefitOn } from './benefits';
import type { Exec, Tx } from './tx';

/**
 * Staff benefits at checkout (S2-21, SCRUM-218, round 3 of
 * docs/progress/plans/benefits/PLAN.md §3, §4, §7 and §8).
 *
 * THE PROTOTYPE'S FLOW, ON THE PLATFORM. The prototype previews the benefit
 * live as the cart changes and never uses quota doing it
 * (`previewStaffBenefit`), then commits it last, at confirmation, against
 * current usage (`commitStaffBenefit`), folding the relief into one "Staff
 * benefit" manual discount (`OrderStation.tsx:109-141`). Here:
 *
 *   - **The preview is every quote.** A cart carrying the benefit
 *     (`CartBenefitSchema`: the QR and the till's application id) is priced
 *     with it: the QR verified, the person's profile for the sale's trading
 *     day, their usage, the engine (`priceCartBenefit`). Nothing is written.
 *   - **The application is the commit.** The quota is claimed inside the
 *     sale's own transaction, with one conditional statement per counter
 *     (`claimUsage`), and the application row and its "Staff benefit" row are
 *     written beside the sale (`applyCartBenefit`). The sale and the claim
 *     exist together or not at all (H1, H2).
 *   - **Removal is a release.** `DELETE /sales/:id/benefit` (before any money)
 *     and a void give the counters back (`releaseSaleBenefits`); a sale whose
 *     benefit was released cannot then be closed with it (`assertSaleBenefitsLive`).
 *
 * THE FIGURES ARE NEVER THE TILL'S (plan §4, H3): the relief is recomputed from
 * the stored profile and the stored usage on every pricing, and the till's
 * `expectedReliefSatang` can only turn a commit into a refusal.
 */

// --- The usage a person has --------------------------------------------------------

/** The counter key of a free item, and of the credit pool (`benefit_usage.item_key`). */
export const freeItemKey = (id: string): string => `free:${id}`;
export const CREDIT_KEY = 'credit';

interface UsageKey {
  itemKey: string;
  periodKind: 'daily' | 'monthly';
  periodKey: string;
}

/** Every counter a profile could draw on, on one trading day. */
function usageKeysOf(profile: BenefitProfile, businessDate: string): UsageKey[] {
  const keys: UsageKey[] = (profile.freeItems ?? []).map((f) => ({
    itemKey: freeItemKey(f.id),
    periodKind: f.period,
    periodKey: benefitPeriodKey(f.period, businessDate),
  }));
  if (profile.credit) {
    keys.push({
      itemKey: CREDIT_KEY,
      periodKind: profile.credit.period,
      periodKey: benefitPeriodKey(profile.credit.period, businessDate),
    });
  }
  return keys;
}

/**
 * What a person has used this period, less what one live application already
 * holds — the application's own claim does not count against itself, so an
 * order rung up again (a new sale id, the same scan) is priced as the first
 * was, and the commit gives that claim back before it claims again.
 */
async function usageFor(
  db: Exec,
  employeeId: string,
  profile: BenefitProfile,
  businessDate: string,
  own: readonly BenefitUsageDelta[],
): Promise<BenefitUsageState> {
  const keys = usageKeysOf(profile, businessDate);
  const state = emptyBenefitUsage();
  if (keys.length === 0) return state;
  const rows = await db
    .select({
      itemKey: benefitUsage.itemKey,
      periodKey: benefitUsage.periodKey,
      qtyUsed: benefitUsage.qtyUsed,
      creditUsedSatang: benefitUsage.creditUsedSatang,
    })
    .from(benefitUsage)
    .where(
      and(
        eq(benefitUsage.employeeId, employeeId),
        inArray(
          benefitUsage.itemKey,
          keys.map((k) => k.itemKey),
        ),
        inArray(
          benefitUsage.periodKey,
          keys.map((k) => k.periodKey),
        ),
      ),
    );
  const ownOf = (key: UsageKey) =>
    own.find((d) => d.itemKey === key.itemKey && d.periodKey === key.periodKey);
  for (const key of keys) {
    const row = rows.find((r) => r.itemKey === key.itemKey && r.periodKey === key.periodKey);
    const mine = ownOf(key);
    if (key.itemKey === CREDIT_KEY) {
      state.creditUsedSatang = Math.max(0, (row?.creditUsedSatang ?? 0) - (mine?.creditSatang ?? 0));
    } else {
      state.freeItemsUsed[key.itemKey.slice('free:'.length)] = Math.max(
        0,
        (row?.qtyUsed ?? 0) - (mine?.qty ?? 0),
      );
    }
  }
  return state;
}

/** The counters an engine result moves, with the limit each is checked against. */
function deltasOf(
  profile: BenefitProfile,
  result: BenefitApplyResult,
  businessDate: string,
): BenefitUsageDelta[] {
  const deltas: BenefitUsageDelta[] = [];
  for (const used of result.freeItemUsageDeltas) {
    const benefit = (profile.freeItems ?? []).find((f) => f.id === used.benefitId);
    if (!benefit || used.qtyUsed <= 0) continue;
    deltas.push({
      itemKey: freeItemKey(benefit.id),
      periodKind: benefit.period,
      periodKey: benefitPeriodKey(benefit.period, businessDate),
      qty: used.qtyUsed,
      creditSatang: 0,
      limit: benefit.quotaPerPeriod,
    });
  }
  if (profile.credit && result.creditUsedDelta > 0) {
    deltas.push({
      itemKey: CREDIT_KEY,
      periodKind: profile.credit.period,
      periodKey: benefitPeriodKey(profile.credit.period, businessDate),
      qty: 0,
      creditSatang: result.creditUsedDelta,
      limit: profile.credit.amountSatang,
    });
  }
  return deltas;
}

// --- The live application of one scan ----------------------------------------------

type ApplicationRow = typeof benefitApplication.$inferSelect;

/** The live application a till's application id names, if any (at most one, by index). */
async function liveApplication(db: Exec, operatorId: string, clientId: string): Promise<ApplicationRow | null> {
  const [row] = await db
    .select()
    .from(benefitApplication)
    .where(
      and(
        eq(benefitApplication.clientId, clientId),
        eq(benefitApplication.operatorId, operatorId),
        isNull(benefitApplication.removedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

// --- Pricing a cart with a benefit (every quote, and the commit) -------------------

export interface CartBenefitPricing {
  /** The till's application id (`benefit_application.client_id`). */
  applicationId: string;
  employeeId: string;
  credentialId: string;
  name: string;
  benefitRole: BenefitRole;
  /** The profile the relief was worked out from. */
  profile: BenefitProfile;
  result: BenefitApplyResult;
  cartLineIds: string[];
  /** The "Staff benefit" row, or null when the engine relieved nothing. */
  discount: ManualDiscount | null;
  /** The counters a commit claims. Empty offline, and for a comp or a standing percent. */
  deltas: BenefitUsageDelta[];
  /** The live application of this scan on another sale, which a commit moves. */
  live: ApplicationRow | null;
  /** Where the figures came from: the platform's own pricing, or a box's offline record (checked). */
  origin: 'cloud' | 'box';
  /** Stages the person has that were not applied: a box's offline record says so. */
  onlineOnly: OfflineBenefitRecord['onlineOnly'];
  /** What the till last showed it, from the cart; null when it did not say. */
  expectedReliefSatang: number | null;
}

/**
 * The benefit on a cart, priced: the QR verified (in the prototype's words
 * where it had them), the person's profile on the sale's trading day, their
 * usage this period less this scan's own live claim, and the engine on the
 * cart's menu lines. Writes nothing.
 *
 * A cart rung up anywhere but the F&B station is refused (R-70, plan Q5).
 */
export async function priceCartBenefit(
  db: Exec,
  input: {
    operatorId: string;
    businessDate: string;
    channel: string | null | undefined;
    benefit: CartBenefitInput;
    cartLines: readonly TicketCartLine[];
    now: Date;
  },
): Promise<CartBenefitPricing> {
  if (input.channel && input.channel !== 'fnb') {
    throw errors.conflict(BENEFIT_CHECKOUT_REFUSALS.FNB_ONLY, BENEFIT_CHECKOUT_WORDS.fnbOnly);
  }
  const resolved: ResolvedBenefit = await resolveBenefitCredential(db, {
    operatorId: input.operatorId,
    code: input.benefit.code,
    today: input.businessDate,
    now: input.now,
  });
  const live = await liveApplication(db, input.operatorId, input.benefit.applicationId);
  if (live) await assertMovable(db, live, resolved);
  const profile = resolved.profile;
  const usage = await usageFor(
    db,
    resolved.employeeId,
    profile,
    input.businessDate,
    live?.usageDeltas ?? [],
  );
  const { lines, cartLineIds } = benefitLinesOf(input.cartLines);
  const result = applyStaffBenefits(profile, usage, lines);
  return {
    applicationId: input.benefit.applicationId,
    employeeId: resolved.employeeId,
    credentialId: resolved.credentialId,
    name: resolved.name,
    benefitRole: resolved.benefitRole,
    profile,
    result,
    cartLineIds,
    discount: staffBenefitDiscount({
      applicationId: input.benefit.applicationId,
      result,
      cartLineIds,
      name: resolved.name,
      benefitRole: resolved.benefitRole,
    }),
    deltas: deltasOf(profile, result, input.businessDate),
    live,
    origin: 'cloud',
    onlineOnly: [],
    expectedReliefSatang: input.benefit.expectedReliefSatang ?? null,
  };
}

/**
 * A live application of this scan, on another order: movable while that order
 * took no money and is still open — the same order rung up again — and it must
 * be the same person's QR. One that paid for a closed sale is spent.
 */
async function assertMovable(db: Exec, live: ApplicationRow, resolved: { employeeId: string }): Promise<void> {
  if (live.employeeId !== resolved.employeeId) {
    throw errors.conflict(
      BENEFIT_CHECKOUT_REFUSALS.ALREADY_USED,
      'That benefit application names another staff member’s QR. Scan the QR again.',
    );
  }
  const [owner] = await db
    .select({ status: sale.status, receiptNumber: sale.receiptNumber })
    .from(sale)
    .where(eq(sale.id, live.saleId))
    .limit(1);
  if (owner && (owner.status === 'finalised' || owner.status === 'refunded')) {
    throw errors.conflict(
      BENEFIT_CHECKOUT_REFUSALS.ALREADY_USED,
      BENEFIT_CHECKOUT_WORDS.alreadyUsed(owner.receiptNumber),
      { saleId: live.saleId },
    );
  }
}

/**
 * An offline sale's benefit, CHECKED rather than believed (plan §4, H11, H12).
 *
 * A box applies only what carries no quota — the comp and the standing
 * percent — from its `benefits` scope, and records what it applied without
 * the QR. The replay re-derives the person's comp and standing percent from
 * the platform's own profile on the day the box priced it, re-runs the engine
 * with the engine version the box priced with, and refuses any disagreement
 * (`BENEFIT_OFFLINE_DRIFT`) — the same rule as a total that differs under the
 * same catalogue version: a defect, held for a person, never filed blind.
 *
 * The QR's revocation is NOT re-checked: the box checked it against the list
 * it held, the money was taken on that answer, and a revocation made since
 * does not unmake a sale (the bound is the plan's H7: the next pull).
 */
export async function priceOfflineCartBenefit(
  db: Exec,
  input: {
    operatorId: string;
    record: OfflineBenefitRecord;
    cartLines: readonly TicketCartLine[];
  },
): Promise<CartBenefitPricing> {
  const { record } = input;
  if (record.engineVersion !== PRICING_ENGINE_VERSION) {
    throw errors.conflict(
      BENEFIT_CHECKOUT_REFUSALS.OFFLINE_ENGINE,
      `This offline sale's staff benefit was priced with engine ${record.engineVersion}, which this platform does not have. Update the platform before replaying it.`,
    );
  }
  const [credential] = await db
    .select({ id: benefitCredential.id, employeeId: benefitCredential.employeeId })
    .from(benefitCredential)
    .where(
      and(
        eq(benefitCredential.id, record.credentialId),
        eq(benefitCredential.operatorId, input.operatorId),
      ),
    )
    .limit(1);
  if (!credential || credential.employeeId !== record.employeeId) {
    throw errors.conflict(
      BENEFIT_CREDENTIAL_REFUSALS.NOT_FOUND,
      'The staff benefit on this offline sale names a QR this park did not issue, so the sale was held for review.',
      { credentialId: record.credentialId, employeeId: record.employeeId },
    );
  }
  const effective = await effectiveBenefitOn(db, input.operatorId, record.employeeId, record.day);
  const facts = offlineBenefitFacts(effective.profile);
  const profile = offlineBenefitProfile(facts);
  const { lines, cartLineIds } = benefitLinesOf(input.cartLines);
  const result = applyStaffBenefits(profile, emptyBenefitUsage(), lines);
  const drift =
    !effective.benefitRole ||
    facts.comp !== record.isComp ||
    (facts.standingDiscount?.percent ?? null) !== (record.standingDiscount?.percent ?? null) ||
    result.compedSatang !== record.compedSatang ||
    result.discountSatang !== record.discountSatang ||
    result.totalReliefSatang !== record.totalReliefSatang ||
    result.freeItemsSatang !== 0 ||
    result.creditSatang !== 0;
  if (drift) {
    throw errors.conflict(
      BENEFIT_CHECKOUT_REFUSALS.OFFLINE_DRIFT,
      `The staff benefit this box applied offline (${record.name}, ${record.isComp ? 'comp' : `฿${record.totalReliefSatang / 100}`}) is not what the platform's own profile gives on ${record.day}, so the sale was held for review.`,
      {
        recorded: {
          isComp: record.isComp,
          compedSatang: record.compedSatang,
          discountSatang: record.discountSatang,
          totalReliefSatang: record.totalReliefSatang,
        },
        platform: {
          isComp: facts.comp,
          compedSatang: result.compedSatang,
          discountSatang: result.discountSatang,
          totalReliefSatang: result.totalReliefSatang,
        },
      },
    );
  }
  return {
    applicationId: record.applicationId,
    employeeId: record.employeeId,
    credentialId: record.credentialId,
    name: record.name,
    benefitRole: effective.benefitRole ?? record.benefitRole,
    profile,
    result,
    cartLineIds,
    discount: staffBenefitDiscount({
      applicationId: record.applicationId,
      result,
      cartLineIds,
      name: record.name,
      benefitRole: effective.benefitRole ?? record.benefitRole,
    }),
    deltas: [],
    live: await liveApplication(db, input.operatorId, record.applicationId),
    origin: 'box',
    onlineOnly: record.onlineOnly,
    expectedReliefSatang: null,
  };
}

/** The four amounts as the till draws them, with what came off the bill. Never the QR. */
export function benefitBreakdownOf(
  pricing: CartBenefitPricing,
  appliedSatang: number,
): BenefitBreakdown {
  const r = pricing.result;
  return {
    applicationId: pricing.applicationId,
    employeeId: pricing.employeeId,
    credentialId: pricing.credentialId,
    name: pricing.name,
    benefitRole: pricing.benefitRole,
    isComp: r.compedSatang > 0,
    compedSatang: r.compedSatang,
    freeItemsSatang: r.freeItemsSatang,
    creditSatang: r.creditSatang,
    discountSatang: r.discountSatang,
    totalReliefSatang: r.totalReliefSatang,
    appliedSatang,
    onlineOnly: pricing.onlineOnly,
    lines: benefitLineRelief(r, pricing.cartLineIds),
    engineVersion: r.engineVersion,
    source: pricing.origin === 'box' ? 'box' : 'platform',
  };
}

// --- The claim ---------------------------------------------------------------------

/** The refusal two tills meet at the last coffee (H1). */
function quotaExhausted(name: string, details?: Record<string, unknown>): AppError {
  return errors.conflict(
    BENEFIT_CHECKOUT_REFUSALS.QUOTA_EXHAUSTED,
    BENEFIT_CHECKOUT_WORDS.quotaExhausted(name),
    details,
  );
}

/**
 * Claim one counter, in ONE statement: insert the delta, or on the unique key
 * add it only while the total stays within the limit. Under READ COMMITTED a
 * second claimer blocks on the row the first is updating and then re-checks
 * the condition against the committed row — so the last unit goes to one of
 * them and the other is told, with exactly one row either way.
 */
async function claimUsage(
  tx: Tx,
  operatorId: string,
  employeeId: string,
  delta: BenefitUsageDelta,
): Promise<boolean> {
  if (delta.qty > delta.limit || delta.creditSatang > delta.limit) return false;
  const room =
    delta.itemKey === CREDIT_KEY
      ? sql`u.credit_used_satang + excluded.credit_used_satang <= ${delta.limit}`
      : sql`u.qty_used + excluded.qty_used <= ${delta.limit}`;
  const result = await tx.execute(sql`
    insert into promo.benefit_usage as u
      (id, operator_id, employee_id, item_key, period_kind, period_key, qty_used, credit_used_satang, version)
    values
      (${newId()}, ${operatorId}, ${employeeId}, ${delta.itemKey}, ${delta.periodKind}, ${delta.periodKey},
       ${delta.qty}, ${delta.creditSatang}, 1)
    on conflict (employee_id, item_key, period_key) do update
       set qty_used = u.qty_used + excluded.qty_used,
           credit_used_satang = u.credit_used_satang + excluded.credit_used_satang,
           version = u.version + 1,
           updated_at = now()
     where ${room}
    returning u.id`);
  return (result.rows?.length ?? 0) > 0;
}

/** Give a counter back exactly what one application took. Never below zero. */
async function releaseUsage(tx: Tx, employeeId: string, delta: BenefitUsageDelta): Promise<void> {
  await tx
    .update(benefitUsage)
    .set({
      qtyUsed: sql`greatest(${benefitUsage.qtyUsed} - ${delta.qty}, 0)`,
      creditUsedSatang: sql`greatest(${benefitUsage.creditUsedSatang} - ${delta.creditSatang}, 0)`,
      version: sql`${benefitUsage.version} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(benefitUsage.employeeId, employeeId),
        eq(benefitUsage.itemKey, delta.itemKey),
        eq(benefitUsage.periodKey, delta.periodKey),
      ),
    );
}

export interface BenefitActor {
  accountId: string;
  operatorId: string;
  requestId?: string | null;
  actionId?: string | null;
}

/** What the audit rows say about where it happened. */
interface Where {
  saleId: string;
  branchId: string;
  stationId: string;
  boxId: string | null;
}

/**
 * Close one live application and give its counters back. Audited
 * `benefit.remove` with the station and box, and why: taken off (`removed`),
 * its sale voided (`voided`), or moved to the order rung up again (`moved`).
 */
async function releaseApplication(
  tx: Tx,
  row: ApplicationRow,
  actor: BenefitActor,
  reason: BenefitRemovalReason,
  now: Date,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const [closed] = await tx
    .update(benefitApplication)
    .set({ removedAt: now, removedByAccountId: actor.accountId, removedReason: reason, updatedAt: now })
    .where(and(eq(benefitApplication.id, row.id), isNull(benefitApplication.removedAt)))
    .returning({ id: benefitApplication.id });
  if (!closed) return; // closed by somebody else first: their release gave the counters back
  for (const delta of row.usageDeltas) await releaseUsage(tx, row.employeeId, delta);
  const [person] = await tx
    .select({ name: employee.name })
    .from(employee)
    .where(eq(employee.id, row.employeeId))
    .limit(1);
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: row.operatorId,
    branchId: row.branchId,
    action: 'benefit.remove',
    entityType: 'benefit_application',
    entityId: row.id,
    requestId: actor.requestId ?? null,
    actionId: actor.actionId ?? null,
    before: { status: 'applied', saleId: row.saleId, usageDeltas: row.usageDeltas },
    after: {
      status: 'removed',
      reason,
      saleId: row.saleId,
      applicationId: row.clientId,
      employeeId: row.employeeId,
      employeeName: person?.name ?? null,
      stationId: row.stationId,
      boxId: row.boxId,
      releasedUsage: row.usageDeltas,
      totalReliefSatang: row.totalReliefSatang,
      ...extra,
    },
  });
}

/**
 * Apply a priced benefit to the sale being committed, in its transaction:
 * move this scan's live application off an order rung up before (giving its
 * counters back), refuse a relief smaller than the till showed, claim every
 * counter, and write the application. Returns the application's row id, which
 * the "Staff benefit" discount row links to — or null when the engine found
 * nothing to relieve, and nothing is written.
 *
 * Audited `benefit.apply` — whose QR, who processed it, the station and the
 * box, the four amounts and the counters — and, for an owner's comp, also
 * `benefit.comp`, marked sensitive (plan Q3's default: the audit is the
 * control, as for any manual comp under R-08).
 */
export async function applyCartBenefit(
  tx: Tx,
  pricing: CartBenefitPricing,
  actor: BenefitActor,
  where: Where & { businessDate: string },
  appliedSatang: number,
  allocations: unknown,
  now: Date,
): Promise<string | null> {
  // This scan's live application, locked: a second commit of the same scan
  // waits here, and then finds it moved.
  const [live] = await tx
    .select()
    .from(benefitApplication)
    .where(
      and(
        eq(benefitApplication.clientId, pricing.applicationId),
        eq(benefitApplication.operatorId, actor.operatorId),
        isNull(benefitApplication.removedAt),
      ),
    )
    .for('update')
    .limit(1);
  if (live) {
    await assertMovable(tx, live, pricing);
    if (live.saleId !== where.saleId) {
      // The earlier order must have taken no money: a benefit on a paid order
      // is that order's.
      const attempts = await tx
        .select({ status: paymentAttempt.status, payload: paymentAttempt.payload })
        .from(paymentAttempt)
        .where(eq(paymentAttempt.saleId, live.saleId));
      if (
        attempts.some(
          (a) =>
            PAYMENT_ATTEMPT_TAKEN_STATUSES.includes(a.status) ||
            !PAYMENT_ATTEMPT_TERMINAL_STATUSES.includes(a.status) ||
            isPaymentReversalPending(a.payload),
        )
      ) {
        throw errors.conflict(
          BENEFIT_CHECKOUT_REFUSALS.ALREADY_USED,
          BENEFIT_CHECKOUT_WORDS.alreadyUsed(null),
          { saleId: live.saleId },
        );
      }
      await releaseApplication(tx, live, actor, 'moved', now, { movedToSaleId: where.saleId });
    }
  }

  // The till was shown more than this: the last of it went to another order
  // since the quote. Said as what it is, before anything is claimed.
  if (
    pricing.expectedReliefSatang !== null &&
    pricing.result.totalReliefSatang < pricing.expectedReliefSatang
  ) {
    throw quotaExhausted(pricing.name, {
      expectedReliefSatang: pricing.expectedReliefSatang,
      reliefSatang: pricing.result.totalReliefSatang,
    });
  }
  // Nothing to relieve on this order: no row, no claim — the prototype
  // writes nothing when the total relief is ฿0 (`commitStaffBenefit`).
  if (!pricing.discount) return null;
  for (const delta of pricing.deltas) {
    if (!(await claimUsage(tx, actor.operatorId, pricing.employeeId, delta))) {
      throw quotaExhausted(pricing.name, { itemKey: delta.itemKey, periodKey: delta.periodKey });
    }
  }

  const id = newId();
  const r = pricing.result;
  try {
    await tx.insert(benefitApplication).values({
      id,
      clientId: pricing.applicationId,
      operatorId: actor.operatorId,
      branchId: where.branchId,
      saleId: where.saleId,
      businessDate: where.businessDate,
      employeeId: pricing.employeeId,
      credentialId: pricing.credentialId,
      benefitRole: pricing.benefitRole,
      profileSnapshot: pricing.profile,
      engineVersion: r.engineVersion,
      processedByAccountId: actor.accountId,
      stationId: where.stationId,
      boxId: where.boxId,
      origin: pricing.origin,
      isComp: r.compedSatang > 0,
      compedSatang: r.compedSatang,
      freeItemsSatang: r.freeItemsSatang,
      creditSatang: r.creditSatang,
      discountSatang: r.discountSatang,
      totalReliefSatang: r.totalReliefSatang,
      appliedSatang,
      usageDeltas: pricing.deltas,
      lineRelief: benefitLineRelief(r, pricing.cartLineIds),
      occurredAt: now,
    });
  } catch (err) {
    // The same scan committed on another order in the same instant: that
    // order has it, and this whole sale rolls back with its claim.
    if (String((err as { cause?: unknown })?.cause ?? err).includes('benefit_application_client_live_unique') ||
      String(err).includes('benefit_application_client_live_unique')) {
      throw quotaExhausted(pricing.name, { applicationId: pricing.applicationId });
    }
    throw err;
  }
  // "Is this card in use" — the round 2 column, set by the application.
  await tx
    .update(benefitCredential)
    .set({ lastSeenAt: now, updatedAt: now })
    .where(eq(benefitCredential.id, pricing.credentialId));

  const detail = {
    saleId: where.saleId,
    applicationId: pricing.applicationId,
    employeeId: pricing.employeeId,
    employeeName: pricing.name,
    benefitRole: pricing.benefitRole,
    credentialId: pricing.credentialId,
    processedByAccountId: actor.accountId,
    stationId: where.stationId,
    boxId: where.boxId,
    origin: pricing.origin,
    isComp: r.compedSatang > 0,
    compedSatang: r.compedSatang,
    freeItemsSatang: r.freeItemsSatang,
    creditSatang: r.creditSatang,
    discountSatang: r.discountSatang,
    totalReliefSatang: r.totalReliefSatang,
    appliedSatang,
    usage: pricing.deltas,
    allocations,
    businessDate: where.businessDate,
    engineVersion: r.engineVersion,
  };
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: where.branchId,
    action: 'benefit.apply',
    entityType: 'benefit_application',
    entityId: id,
    requestId: actor.requestId ?? null,
    actionId: actor.actionId ?? null,
    after: detail,
  });
  if (r.compedSatang > 0) {
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: where.branchId,
      action: 'benefit.comp',
      entityType: 'benefit_application',
      entityId: id,
      requestId: actor.requestId ?? null,
      actionId: actor.actionId ?? null,
      after: { ...detail, sensitive: true },
    });
  }
  return id;
}

// --- Taking it off, and the close that checks it ----------------------------------

/** Give back every live application on a sale. The void's half (H2). */
export async function releaseSaleBenefits(
  tx: Tx,
  saleId: string,
  actor: BenefitActor,
  reason: BenefitRemovalReason,
  now: Date,
): Promise<string[]> {
  const rows = await tx
    .select()
    .from(benefitApplication)
    .where(and(eq(benefitApplication.saleId, saleId), isNull(benefitApplication.removedAt)))
    .for('update');
  for (const row of rows) await releaseApplication(tx, row, actor, reason, now);
  return rows.map((r) => r.id);
}

export interface RemovedBenefitView {
  removed: boolean;
  saleId: string;
  /** The till's application id that was taken off, when one was. */
  applicationId: string | null;
  /** The counters given back. */
  released: BenefitUsageDelta[];
}

/**
 * `DELETE /sales/:id/benefit` — take the benefit off a rung-up sale before any
 * money is taken: its counters go back, the application is closed `removed`,
 * and the sale can no longer be closed with it (`assertSaleBenefitsLive`) — the
 * till rings the order up again without it. A closed sale's benefit stays used
 * (plan Q4's default: the prototype keeps usage on a refund too).
 */
export async function removeSaleBenefit(
  tx: Tx,
  actor: BenefitActor & { assertBranchAllowed?: (branchId: string) => Promise<void> },
  saleId: string,
  now: Date = new Date(),
): Promise<RemovedBenefitView> {
  const [row] = await tx.select().from(sale).where(eq(sale.id, saleId)).for('update').limit(1);
  if (!row || row.operatorId !== actor.operatorId) throw errors.notFound('Sale not found');
  await actor.assertBranchAllowed?.(row.branchId);
  if (row.status === 'finalised' || row.status === 'refunded') {
    throw errors.conflict(
      'SALE_FINALISED',
      'This sale is closed — a staff benefit used on a closed sale stays used',
    );
  }
  const attempts = await tx
    .select({ status: paymentAttempt.status, payload: paymentAttempt.payload })
    .from(paymentAttempt)
    .where(eq(paymentAttempt.saleId, saleId));
  if (attempts.some((a) => PAYMENT_ATTEMPT_TAKEN_STATUSES.includes(a.status))) {
    throw errors.conflict(
      'SALE_HAS_PAYMENT',
      'Money has been taken on this sale — its staff benefit cannot be taken off now',
    );
  }
  if (
    attempts.some(
      (a) => !PAYMENT_ATTEMPT_TERMINAL_STATUSES.includes(a.status) || isPaymentReversalPending(a.payload),
    )
  ) {
    throw errors.conflict(
      'PAYMENT_IN_FLIGHT',
      'A payment on this sale is still in progress — finish or cancel it before taking the benefit off',
    );
  }
  const [live] = await tx
    .select()
    .from(benefitApplication)
    .where(and(eq(benefitApplication.saleId, saleId), isNull(benefitApplication.removedAt)))
    .for('update')
    .limit(1);
  if (!live) return { removed: false, saleId, applicationId: null, released: [] };
  await releaseApplication(tx, live, actor, 'removed', now);
  return { removed: true, saleId, applicationId: live.clientId, released: live.usageDeltas };
}

/**
 * A sale is closed only with a benefit that still applies to it. Its "Staff
 * benefit" row names an application; if that application was taken off,
 * voided or moved to the order rung up again, closing this sale would give the
 * relief with nothing claimed for it — refused, and the till rings it up again.
 */
export async function assertSaleBenefitsLive(db: Exec, saleId: string): Promise<void> {
  const rows = await db
    .select({
      applicationId: saleDiscount.benefitApplicationId,
      removedAt: benefitApplication.removedAt,
      appliedTo: benefitApplication.saleId,
    })
    .from(saleDiscount)
    .innerJoin(benefitApplication, eq(benefitApplication.id, saleDiscount.benefitApplicationId))
    .where(and(eq(saleDiscount.saleId, saleId), isNotNull(saleDiscount.benefitApplicationId)));
  if (rows.some((r) => r.removedAt !== null || r.appliedTo !== saleId)) {
    throw errors.conflict(BENEFIT_CHECKOUT_REFUSALS.RELEASED, BENEFIT_CHECKOUT_WORDS.released, {
      saleId,
    });
  }
}

/** The benefit applied to a sale, for its answers and its read. Null when none. */
export async function saleBenefitOf(db: Exec | Db, saleId: string): Promise<BenefitBreakdown | null> {
  const [row] = await db
    .select({
      application: benefitApplication,
      name: employee.name,
    })
    .from(benefitApplication)
    .innerJoin(employee, eq(employee.id, benefitApplication.employeeId))
    .where(and(eq(benefitApplication.saleId, saleId), isNull(benefitApplication.removedAt)))
    .limit(1);
  if (!row) return null;
  const a = row.application;
  return {
    applicationId: a.clientId,
    employeeId: a.employeeId,
    credentialId: a.credentialId,
    name: row.name,
    benefitRole: a.benefitRole,
    isComp: a.isComp,
    compedSatang: a.compedSatang,
    freeItemsSatang: a.freeItemsSatang,
    creditSatang: a.creditSatang,
    discountSatang: a.discountSatang,
    totalReliefSatang: a.totalReliefSatang,
    appliedSatang: a.appliedSatang,
    onlineOnly: [],
    lines: a.lineRelief,
    engineVersion: a.engineVersion,
    source: a.origin === 'box' ? 'box' : 'platform',
  };
}
