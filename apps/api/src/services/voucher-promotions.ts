import { createHash, randomInt } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  account,
  boxCommand,
  branch,
  employee,
  member,
  printJob,
  printTemplate,
  product,
  productCategory,
  station,
  ticketPackage,
  voucher,
  voucherCampaign,
  voucherDefinition,
  type Db,
} from '@oto/db';
import {
  BOOTH_CODE_MINT_ATTEMPTS,
  PROMO_VOUCHER_MESSAGES,
  VoucherTargetSchema,
  boothStaffCode,
  boothStaffLabel,
  businessDate,
  formatVoucherDay,
  mintBoothCode,
  newId,
  parseDayStart,
  voucherWindowOf,
  type PrintKind,
  type PromoVoucherReport,
  type VoucherCampaignBody,
  type VoucherIssueBody,
  type VoucherTarget,
  type WalletView,
} from '@oto/shared';
import type { BoothVoucherData } from '@oto/print';
import { AppError } from '../lib/errors';
import { audit } from './audit';
import { boxSettings } from './box';
import { routeOnBox, templateTypeFor } from './print';
import type { Exec, Tx } from './tx';
import {
  VOUCHER_HOLD_LAPSE_MS,
  formatVoucherDate,
  formatVoucherDateTime,
  type RedemptionStation,
} from './vouchers';
import { voucherCreditWalletOf, walletViewOf } from './wallet';

/**
 * S2-14a ROUND 5 — PROMOTIONAL VOUCHERS (plan docs/progress/plans/wallet/PLAN.md
 * §2.7; SPRINT_2_PLAN §S2-14a, the promotional-vouchers paragraph).
 *
 * The landed voucher engine (`vouchers.ts`) is the model and stays the one
 * redemption path: a voucher is looked up, HELD on a cart, priced by the
 * platform from its definition, and USED UP in the transaction that closes the
 * sale. This file is what round 5 adds around it, and it never replaces any of
 * it:
 *
 *   - THE RULES a definition may carry — a window on the redeeming branch's
 *     trading day, a global and a per-customer redemption limit — and where
 *     they are decided (`promoWindowRefusal`, `assertPromoLimits`);
 *   - ISSUE: one voucher printed at the till on the voucher slip's template
 *     (`issueVoucherAtTill`), or a batch minted for a campaign
 *     (`mintVoucherCampaign`), every code unique and the batch auditable;
 *   - the WALLET CREDIT a wallet-credit voucher loaded, read and printed
 *     (`voucherCreditOf`, `printVoucherCredit`) — the load itself is the
 *     wallet service's, from `consumeSaleVouchers`;
 *   - FOREGONE REVENUE, its own line beside discounts (`promoVoucherReportOf`).
 *
 * THE LIMITS, AND WHY THE HOLD IS A RESERVATION. A limit counts redemptions,
 * and a redemption happens when a sale closes — after a card may already be on
 * its way. Counting only at the close would let two tills ring up the last use
 * and refuse one of them with the guest's money taken. So the count is taken
 * three times, each under one advisory lock per definition (`0x070f`, beside
 * the api's others: `0x070a` the job runner, `0x070b` the QR invoice number,
 * `0x070c` an operator's barcodes, `0x070d` a person's voucher look-ups,
 * `0x070e` the virtual box lease):
 *
 *   hold     used + on a sale rung up with it + held on a cart being rung up
 *            now (inside the hold-lapse window) — so the second till reaching
 *            for the last use counts the first's hold and is refused;
 *   Pay      used + on a sale rung up with it — the hold that lapsed while its
 *            cart sat is caught here, before any tender;
 *   use-up   used — the last net, which only a correction outside the api
 *            reaches, and which rolls the whole close back.
 *
 * The lock is taken AFTER the voucher's row, the order every path takes (the
 * hold locks the voucher, Pay's commit locks it in `resolveCartVoucher`, the
 * use-up updates it), and nothing locks a row while holding it, so it can
 * queue but not deadlock. A definition with no limit takes no lock at all: the
 * booth's vouchers never queue behind each other.
 *
 * PER CUSTOMER is keyed by the MEMBER: the closing sale's member, else the
 * member the voucher was issued to. A walk-in with neither is not held to it —
 * there is nobody to count against — which is the promo codes' own rule
 * (`promo-codes.ts`).
 */

type DefinitionRow = typeof voucherDefinition.$inferSelect;
type VoucherRow = typeof voucher.$inferSelect;

/** Whether a definition carries any rule this file decides. */
export function hasPromoRules(
  def: Pick<DefinitionRow, 'usageLimit' | 'perCustomerLimit' | 'validFrom' | 'validUntil'>,
): boolean {
  return (
    def.usageLimit !== null ||
    def.perCustomerLimit !== null ||
    def.validFrom !== null ||
    def.validUntil !== null
  );
}

// --- The trading day -------------------------------------------------------------

/** The branch's trading day at `now`, on its own clock and day start. */
export async function tradingDayAt(db: Exec, branchId: string, now: Date): Promise<string> {
  const [br] = await db
    .select({ timezone: branch.timezone, dayStart: branch.businessDayStart })
    .from(branch)
    .where(eq(branch.id, branchId))
    .limit(1);
  if (!br) throw new AppError(404, 'NOT_FOUND', 'Branch not found');
  return businessDate(now, br.timezone, parseDayStart(br.dayStart));
}

/**
 * THE WINDOW, on the redeeming branch's trading day — the date that already
 * chose the price, never the UTC day. Null when it is inside (or there is none).
 */
export async function promoWindowRefusal(
  db: Exec,
  def: Pick<DefinitionRow, 'validFrom' | 'validUntil'>,
  branchId: string,
  now: Date,
): Promise<AppError | null> {
  if (!def.validFrom && !def.validUntil) return null;
  const day = await tradingDayAt(db, branchId, now);
  const where = voucherWindowOf({ validFrom: def.validFrom, validUntil: def.validUntil }, day);
  if (where === 'before') {
    return new AppError(409, 'VOUCHER_NOT_YET_VALID', PROMO_VOUCHER_MESSAGES.notYet(def.validFrom!), {
      validFrom: def.validFrom,
      businessDate: day,
    });
  }
  if (where === 'after') {
    return new AppError(409, 'VOUCHER_PROMOTION_ENDED', PROMO_VOUCHER_MESSAGES.ended(def.validUntil!), {
      validUntil: def.validUntil,
      businessDate: day,
    });
  }
  return null;
}

// --- The limits ------------------------------------------------------------------

const DEFINITION_LOCK_NAMESPACE = 0x070f;

/**
 * One definition's lock, as Postgres's two-integer form: the first four bytes
 * of the SHA-256 of its id. Exported so a test can hold it, as
 * `personMissLockId` is.
 */
export function definitionLockId(definitionId: string): [namespace: number, key: number] {
  return [
    DEFINITION_LOCK_NAMESPACE,
    createHash('sha256').update(definitionId).digest().readInt32BE(0),
  ];
}

/** Where the count is taken — see the note at the top of the file. `look` takes no lock. */
export type LimitStage = 'look' | 'hold' | 'apply' | 'consume';

/**
 * How many of a definition's vouchers — other than `exceptVoucherId` — are
 * taken at this stage, for everyone or for one member.
 *
 * "Taken" is used up, or (from the hold and Pay) on a sale rung up with it —
 * a sale that has its `applied` row and is still being paid for — or (from
 * the hold and a scan) held on a cart that has not been rung up and is still
 * inside the hold-lapse window, the same window `holdStateOf` lets a cart
 * keep a voucher for.
 *
 * Whose it is: a used voucher's closing sale's member, a held one's rung-up
 * sale's member, and otherwise the member it was issued to.
 */
async function takenCount(
  db: Exec,
  def: Pick<DefinitionRow, 'id'>,
  exceptVoucherId: string,
  stage: LimitStage,
  memberId: string | null,
  now: Date,
): Promise<number> {
  const rungUp = sql`(h.status in ('tendering','paid') and exists (
      select 1 from promo.voucher_redemption r
      where r.voucher_id = v.id and r.sale_id = h.id and r.kind = 'applied'))`;
  const lapsedBefore = new Date(now.getTime() - VOUCHER_HOLD_LAPSE_MS).toISOString();
  const cartNow = sql`(h.id is null and v.held_at > ${lapsedBefore}::timestamptz)`;
  const held =
    stage === 'consume'
      ? sql`false`
      : stage === 'apply'
        ? rungUp
        : sql`(${rungUp} or ${cartNow})`;
  const whose = memberId
    ? sql`and coalesce(case when v.status = 'redeemed' then s.member_id else h.member_id end, v.member_id) = ${memberId}::uuid`
    : sql``;
  const { rows } = await db.execute<{ n: number | string }>(sql`
    select count(*)::int as n
    from promo.voucher v
    left join pos.sale s on s.id = v.sale_id
    left join pos.sale h on h.id = v.held_sale_id
    where v.voucher_definition_id = ${def.id}::uuid
      and v.id <> ${exceptVoucherId}::uuid
      and (v.status = 'redeemed' or (v.status = 'issued' and v.held_sale_id is not null and ${held}))
      ${whose}`);
  return Number(rows[0]?.n ?? 0);
}

/**
 * THE LIMITS, decided. Throws the counter's words when this voucher would be
 * one redemption too many — for the promotion (VOUCHER_LIMIT_REACHED) or for
 * this guest (VOUCHER_CUSTOMER_LIMIT). Under the definition's lock except for a
 * scan (`look`), which only reads.
 */
export async function assertPromoLimits(
  db: Exec,
  def: Pick<DefinitionRow, 'id' | 'usageLimit' | 'perCustomerLimit'>,
  v: Pick<VoucherRow, 'id'>,
  check: { stage: LimitStage; memberId: string | null; now: Date },
): Promise<void> {
  if (def.usageLimit === null && def.perCustomerLimit === null) return;
  if (check.stage !== 'look') {
    const [namespace, key] = definitionLockId(def.id);
    await db.execute(sql`select pg_advisory_xact_lock(${namespace}::int4, ${key}::int4)`);
  }
  if (def.usageLimit !== null) {
    const taken = await takenCount(db, def, v.id, check.stage, null, check.now);
    if (taken >= def.usageLimit) {
      throw new AppError(409, 'VOUCHER_LIMIT_REACHED', PROMO_VOUCHER_MESSAGES.usedUp(def.usageLimit), {
        limit: def.usageLimit,
        taken,
      });
    }
  }
  if (def.perCustomerLimit !== null && check.memberId) {
    const taken = await takenCount(db, def, v.id, check.stage, check.memberId, check.now);
    if (taken >= def.perCustomerLimit) {
      throw new AppError(
        409,
        'VOUCHER_CUSTOMER_LIMIT',
        PROMO_VOUCHER_MESSAGES.perCustomer(def.perCustomerLimit),
        { limit: def.perCustomerLimit, taken },
      );
    }
  }
}

/**
 * What a scan says about a voucher's promotional rules, without a lock: the
 * window, then the limits as a hold would count them. Null when nothing stops it.
 */
export async function promoRefusal(
  db: Exec,
  v: VoucherRow,
  def: DefinitionRow,
  branchId: string,
  now: Date,
): Promise<AppError | null> {
  if (!hasPromoRules(def)) return null;
  const window = await promoWindowRefusal(db, def, branchId, now);
  if (window) return window;
  try {
    await assertPromoLimits(db, def, v, { stage: 'look', memberId: v.memberId, now });
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  return null;
}

// --- A definition's rules, checked on save (`voucher-definitions.ts`) --------------

/** The promotional rules a definition will hold after a write. */
export interface PromoRulesShape {
  target: VoucherTarget | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  validFrom: string | null;
  validUntil: string | null;
}

/**
 * The rules, checked whole as they will be after the write — the way
 * `settleValue` checks the value. A target is a discount's only, and must name
 * this operator's package, menu category or menu items; another kind's target
 * is refused when the caller sent one and cleared when the kind changed under
 * it. The tickets scope is stored as null, the landed default. The window
 * must not end before it starts.
 */
export async function settlePromoRules(
  exec: Exec,
  operatorId: string,
  kind: string,
  next: PromoRulesShape,
  explicitTarget: boolean,
): Promise<PromoRulesShape> {
  let target = next.target;
  if (kind !== 'discount') {
    if (explicitTarget && target !== null && target.kind !== 'tickets') {
      throw new AppError(
        400,
        'VOUCHER_TARGET_NOT_FOR_KIND',
        'Only an amount-off or percentage-off voucher comes off a category or an item — this kind is what it hands over.',
      );
    }
    target = null;
  }
  if (target) {
    const parsed = VoucherTargetSchema.safeParse(target);
    if (!parsed.success) {
      throw new AppError(400, 'VOUCHER_TARGET_INVALID', 'What this voucher comes off cannot be read.');
    }
    target = parsed.data;
    const notFound = (what: string) =>
      new AppError(400, 'VOUCHER_TARGET_NOT_FOUND', `No ${what} with that id at this operator.`);
    switch (target.kind) {
      case 'tickets':
        target = null;
        break;
      case 'ticketType': {
        const [row] = await exec
          .select({ id: ticketPackage.id })
          .from(ticketPackage)
          .where(and(eq(ticketPackage.id, target.ticketTypeId), eq(ticketPackage.operatorId, operatorId)))
          .limit(1);
        if (!row) throw notFound('ticket package');
        break;
      }
      case 'fnbCategory': {
        const [row] = await exec
          .select({ id: productCategory.id })
          .from(productCategory)
          .where(and(eq(productCategory.id, target.category), eq(productCategory.operatorId, operatorId)))
          .limit(1);
        if (!row) throw notFound('menu category');
        break;
      }
      case 'menuItems': {
        const ids = [...new Set(target.menuItemIds)];
        const rows = await exec
          .select({ id: product.id, kind: product.kind })
          .from(product)
          .where(and(eq(product.operatorId, operatorId), inArray(product.id, ids)));
        if (rows.length !== ids.length) throw notFound('menu item');
        if (rows.some((r) => r.kind !== 'menu')) {
          throw new AppError(
            400,
            'VOUCHER_TARGET_NOT_MENU',
            'An item voucher names menu items — a shop item cannot be aimed at on its own yet; use the shop scope.',
          );
        }
        target = { kind: 'menuItems', menuItemIds: ids };
        break;
      }
      case 'fnb':
      case 'merch':
        break;
    }
  }
  if (next.validFrom && next.validUntil && next.validFrom > next.validUntil) {
    throw new AppError(
      400,
      'VOUCHER_WINDOW_INVALID',
      `The promotion's last day (${formatVoucherDay(next.validUntil)}) is before its first (${formatVoucherDay(next.validFrom)}).`,
    );
  }
  return {
    target,
    usageLimit: next.usageLimit,
    perCustomerLimit: next.perCustomerLimit,
    validFrom: next.validFrom,
    validUntil: next.validUntil,
  };
}

/** How many of each definition's vouchers have been used, for the editor's "N of limit". */
export async function redemptionsByDefinition(
  db: Exec,
  operatorId: string,
  definitionIds: readonly string[],
): Promise<Map<string, number>> {
  if (definitionIds.length === 0) return new Map();
  const rows = await db
    .select({ id: voucher.voucherDefinitionId, n: sql<number>`count(*)::int` })
    .from(voucher)
    .where(
      and(
        eq(voucher.operatorId, operatorId),
        eq(voucher.status, 'redeemed'),
        inArray(voucher.voucherDefinitionId, [...definitionIds]),
      ),
    )
    .groupBy(voucher.voucherDefinitionId);
  return new Map(rows.map((r) => [r.id, Number(r.n)]));
}

// --- Issue -------------------------------------------------------------------------

/** A definition this operator may issue now, or the reason it may not. */
async function issuableDefinition(
  db: Exec,
  operatorId: string,
  definitionId: string,
  branchId: string,
  now: Date,
): Promise<DefinitionRow> {
  const [def] = await db
    .select()
    .from(voucherDefinition)
    .where(and(eq(voucherDefinition.id, definitionId), eq(voucherDefinition.operatorId, operatorId)))
    .limit(1);
  if (!def) throw new AppError(404, 'VOUCHER_DEFINITION_NOT_FOUND', 'No voucher definition with that id');
  if (def.archivedAt || !def.active) {
    throw new AppError(
      409,
      'VOUCHER_DEFINITION_INACTIVE',
      `${def.nameEn} cannot be issued — this voucher type is switched off`,
    );
  }
  // A promotion that has ended cannot be redeemed, so it is not issued either.
  // One that has not started yet may be: the paper is good from its first day.
  const window = await promoWindowRefusal(db, def, branchId, now);
  if (window && window.code === 'VOUCHER_PROMOTION_ENDED') throw window;
  return def;
}

/** When a voucher issued now lapses: the definition's days from now, or never. */
function expiryOf(def: DefinitionRow, now: Date): Date | null {
  return def.expiryDays ? new Date(now.getTime() + def.expiryDays * 86_400_000) : null;
}

/** Whether an error is the code-uniqueness violation the mint retries against. */
function isCodeCollision(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const c = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (c.code === '23505' && c.constraint === 'voucher_code_unique') return true;
    current = c.cause;
  }
  return false;
}

/** A till's prefix for the codes it prints — its own receipt prefix, as a booth's is its own. */
async function prefixOf(db: Exec, stationId: string): Promise<string> {
  const [row] = await db
    .select({ codePrefix: station.codePrefix })
    .from(station)
    .where(eq(station.id, stationId))
    .limit(1);
  const prefix = (row?.codePrefix ?? '').toUpperCase();
  return /^[0-9A-Z]{2}$/.test(prefix) ? prefix : 'TV';
}

/** The prefix a campaign's codes carry. A campaign has no till; the owner may rename it. */
export const CAMPAIGN_CODE_PREFIX = 'CP';

export interface IssuedVoucherView {
  voucher: {
    id: string;
    code: string;
    source: 'manual';
    definitionId: string;
    definitionCode: string;
    nameEn: string;
    kind: string;
    issuedAt: string;
    expiresAt: string | null;
    validFrom: string | null;
    validUntil: string | null;
    memberId: string | null;
  };
  print: { jobId: string | null; status: 'queued' | 'skipped' | 'none'; note: string | null };
}

/**
 * ISSUE ONE AT THE TILL: a voucher of a definition, minted here on the till's
 * own prefix (`mintBoothCode`, the booth's code scheme — eleven characters with
 * a check character, so every till classifies it as it classifies a booth's),
 * recorded as a `manual` voucher issued by the person at the till, audited,
 * and queued to print on the till's receipt printer as a voucher slip (the
 * booth voucher's template, `booth_voucher`). A collision on the code is drawn
 * again inside a savepoint, at most `BOOTH_CODE_MINT_ATTEMPTS` times.
 */
export async function issueVoucherAtTill(
  tx: Tx,
  actor: { accountId: string; operatorId: string; requestId?: string },
  at: RedemptionStation,
  input: VoucherIssueBody,
  now: Date = new Date(),
): Promise<IssuedVoucherView> {
  const def = await issuableDefinition(tx, actor.operatorId, input.definitionId, at.branchId, now);
  // Staging F4 — a promotion whose redemptions are all taken is not issued: the
  // slip would be refused at the first scan (`assertPromoLimits`), so the till
  // says so here, in the same words, before any code is minted or printed.
  if (def.usageLimit !== null) {
    const redeemed = (await redemptionsByDefinition(tx, actor.operatorId, [def.id])).get(def.id) ?? 0;
    if (redeemed >= def.usageLimit) {
      throw new AppError(409, 'VOUCHER_LIMIT_REACHED', PROMO_VOUCHER_MESSAGES.usedUp(def.usageLimit), {
        limit: def.usageLimit,
        taken: redeemed,
      });
    }
  }
  const memberId = input.memberId ?? null;
  if (memberId) {
    const [m] = await tx
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.id, memberId), eq(member.operatorId, actor.operatorId)))
      .limit(1);
    if (!m) throw new AppError(404, 'MEMBER_NOT_FOUND', 'Member not found');
  }
  const prefix = await prefixOf(tx, at.id);
  const id = newId();
  const expiresAt = expiryOf(def, now);
  let code: string | null = null;
  for (let attempt = 0; attempt < BOOTH_CODE_MINT_ATTEMPTS && !code; attempt += 1) {
    const candidate = mintBoothCode(prefix, (max) => randomInt(max));
    try {
      await tx.transaction(async (sp) => {
        await sp.insert(voucher).values({
          id,
          operatorId: actor.operatorId,
          branchId: at.branchId,
          voucherDefinitionId: def.id,
          code: candidate,
          source: 'manual',
          status: 'issued',
          costSatang: def.costSatang,
          issuedByAccountId: actor.accountId,
          issuedAt: now,
          expiresAt,
          memberId,
          createdAt: now,
          updatedAt: now,
        });
      });
      code = candidate;
    } catch (err) {
      if (!isCodeCollision(err)) throw err;
    }
  }
  if (!code) {
    throw new Error(`${BOOTH_CODE_MINT_ATTEMPTS} codes in a row collided — the random source is not random`);
  }
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: at.branchId,
    action: 'voucher.issue',
    entityType: 'voucher',
    entityId: id,
    requestId: actor.requestId ?? null,
    // The code is a bearer credential: its last four only, as every sale shows it.
    after: {
      definitionId: def.id,
      definitionCode: def.code,
      source: 'manual',
      stationId: at.id,
      codeLast4: code.slice(-4),
      memberId,
      expiresAt: expiresAt?.toISOString() ?? null,
    },
  });
  const print = await queueVoucherPrint(tx, {
    operatorId: actor.operatorId,
    branchId: at.branchId,
    stationId: at.id,
    kind: 'booth_voucher',
    subjectType: 'voucher',
    subjectId: id,
    actorAccountId: actor.accountId,
    actionId: `voucher:${id}:print`,
    now,
  });
  return {
    voucher: {
      id,
      code,
      source: 'manual',
      definitionId: def.id,
      definitionCode: def.code,
      nameEn: def.nameEn,
      kind: def.kind,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt?.toISOString() ?? null,
      validFrom: def.validFrom,
      validUntil: def.validUntil,
      memberId,
    },
    print,
  };
}

/** A definition the till may issue now, as the till's Issue voucher picker lists it. */
export interface IssuableDefinitionView {
  id: string;
  code: string;
  nameEn: string;
  nameTh: string | null;
  kind: string;
  valueSatang: number | null;
  valueBp: number | null;
  validFrom: string | null;
  validUntil: string | null;
  usageLimit: number | null;
  redeemed: number;
}

/**
 * What the till at this branch may issue today: the operator's switched-on,
 * unarchived definitions whose promotion has not ended on the branch's
 * trading day. Read with the till's own permission (`pos:print:voucher`), so
 * reception picks from the park's list without the booth admin's read.
 */
export async function issuableDefinitionsAt(
  db: Exec,
  operatorId: string,
  branchId: string,
  now: Date = new Date(),
): Promise<{ definitions: IssuableDefinitionView[] }> {
  const day = await tradingDayAt(db, branchId, now);
  const rows = await db
    .select()
    .from(voucherDefinition)
    .where(
      and(
        eq(voucherDefinition.operatorId, operatorId),
        eq(voucherDefinition.active, true),
        isNull(voucherDefinition.archivedAt),
        sql`(${voucherDefinition.validUntil} is null or ${voucherDefinition.validUntil} >= ${day}::date)`,
      ),
    )
    .orderBy(asc(voucherDefinition.nameEn));
  const used = await redemptionsByDefinition(db, operatorId, rows.map((r) => r.id));
  return {
    definitions: rows.map((r) => ({
      id: r.id,
      code: r.code,
      nameEn: r.nameEn,
      nameTh: r.nameTh,
      kind: r.kind,
      valueSatang: r.valueSatang,
      valueBp: r.valueBp,
      validFrom: r.validFrom,
      validUntil: r.validUntil,
      usageLimit: r.usageLimit,
      redeemed: used.get(r.id) ?? 0,
    })),
  };
}

// --- A campaign --------------------------------------------------------------------

export interface VoucherCampaignView {
  id: string;
  name: string;
  branchId: string;
  definitionId: string;
  definitionCode: string;
  quantity: number;
  /** How many of its codes have been used — read when the answer was made. */
  redeemed: number;
  createdAt: string;
  createdByAccountId: string | null;
}

/**
 * MINT A CAMPAIGN: `quantity` vouchers of one definition, issued at one
 * branch, in one transaction — every code drawn on the campaign prefix and
 * inserted with ON CONFLICT DO NOTHING against `voucher_code_unique`, the
 * shortfall drawn again, at most `BOOTH_CODE_MINT_ATTEMPTS` rounds. The
 * campaign row and one audit row record the batch; the codes themselves never
 * enter an answer or an audit row (each is a bearer credential) and are read
 * by the manager through the export (`campaignCodesCsv`).
 */
export async function mintVoucherCampaign(
  tx: Tx,
  actor: { accountId: string; operatorId: string; requestId?: string },
  input: VoucherCampaignBody,
  now: Date = new Date(),
): Promise<{ campaign: VoucherCampaignView }> {
  const [br] = await tx
    .select({ id: branch.id })
    .from(branch)
    .where(and(eq(branch.id, input.branchId), eq(branch.operatorId, actor.operatorId), isNull(branch.archivedAt)))
    .limit(1);
  if (!br) throw new AppError(404, 'NOT_FOUND', 'Branch not found');
  const def = await issuableDefinition(tx, actor.operatorId, input.definitionId, br.id, now);
  if (def.codeMode === 'fixed') {
    throw new AppError(
      422,
      'VOUCHER_FIXED_CODE_CAMPAIGN',
      'This voucher type prints one fixed code, so it has no batch of codes to make',
    );
  }
  const campaignId = newId();
  const name = input.name.trim();
  await tx.insert(voucherCampaign).values({
    id: campaignId,
    operatorId: actor.operatorId,
    branchId: br.id,
    voucherDefinitionId: def.id,
    name,
    quantity: input.quantity,
    createdByAccountId: actor.accountId,
    createdAt: now,
    updatedAt: now,
  });
  const expiresAt = expiryOf(def, now);
  let made = 0;
  for (let round = 0; round < BOOTH_CODE_MINT_ATTEMPTS && made < input.quantity; round += 1) {
    const want = input.quantity - made;
    const rows = Array.from({ length: want }, () => ({
      id: newId(),
      operatorId: actor.operatorId,
      branchId: br.id,
      voucherDefinitionId: def.id,
      code: mintBoothCode(CAMPAIGN_CODE_PREFIX, (max) => randomInt(max)),
      source: 'campaign' as const,
      status: 'issued' as const,
      costSatang: def.costSatang,
      issuedByAccountId: actor.accountId,
      issuedAt: now,
      expiresAt,
      campaignId,
      createdAt: now,
      updatedAt: now,
    }));
    // In slices, so one statement never carries thousands of parameter sets.
    for (let i = 0; i < rows.length; i += 500) {
      const inserted = await tx
        .insert(voucher)
        .values(rows.slice(i, i + 500))
        .onConflictDoNothing({ target: [voucher.operatorId, voucher.code] })
        .returning({ id: voucher.id });
      made += inserted.length;
    }
  }
  if (made !== input.quantity) {
    throw new Error(`the campaign minted ${made} of ${input.quantity} codes — the random source is not random`);
  }
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: br.id,
    action: 'voucher_campaign.create',
    entityType: 'voucher_campaign',
    entityId: campaignId,
    requestId: actor.requestId ?? null,
    after: {
      name,
      definitionId: def.id,
      definitionCode: def.code,
      quantity: input.quantity,
      prefix: CAMPAIGN_CODE_PREFIX,
      expiresAt: expiresAt?.toISOString() ?? null,
    },
  });
  return {
    campaign: {
      id: campaignId,
      name,
      branchId: br.id,
      definitionId: def.id,
      definitionCode: def.code,
      quantity: input.quantity,
      redeemed: 0,
      createdAt: now.toISOString(),
      createdByAccountId: actor.accountId,
    },
  };
}

/** The operator's campaigns, newest first, with how many of each are used. */
export async function listVoucherCampaigns(
  db: Db,
  operatorId: string,
): Promise<{ campaigns: VoucherCampaignView[] }> {
  const rows = await db
    .select({ c: voucherCampaign, definitionCode: voucherDefinition.code })
    .from(voucherCampaign)
    .innerJoin(voucherDefinition, eq(voucherDefinition.id, voucherCampaign.voucherDefinitionId))
    .where(eq(voucherCampaign.operatorId, operatorId))
    .orderBy(sql`${voucherCampaign.createdAt} desc`);
  const ids = rows.map((r) => r.c.id);
  const used = ids.length
    ? await db
        .select({ id: voucher.campaignId, n: sql<number>`count(*)::int` })
        .from(voucher)
        .where(and(inArray(voucher.campaignId, ids), eq(voucher.status, 'redeemed')))
        .groupBy(voucher.campaignId)
    : [];
  const usedBy = new Map(used.map((u) => [u.id, Number(u.n)]));
  return {
    campaigns: rows.map(({ c, definitionCode }) => ({
      id: c.id,
      name: c.name,
      branchId: c.branchId,
      definitionId: c.voucherDefinitionId,
      definitionCode,
      quantity: c.quantity,
      redeemed: usedBy.get(c.id) ?? 0,
      createdAt: c.createdAt.toISOString(),
      createdByAccountId: c.createdByAccountId,
    })),
  };
}

/** A CSV field, quoted when it must be. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * A campaign's codes, one per row, for the manager to distribute: the code,
 * its status and its expiry. The one place the whole codes are handed out.
 */
export async function campaignCodesCsv(
  db: Db,
  operatorId: string,
  campaignId: string,
): Promise<{ filename: string; csv: string }> {
  const [c] = await db
    .select()
    .from(voucherCampaign)
    .where(and(eq(voucherCampaign.id, campaignId), eq(voucherCampaign.operatorId, operatorId)))
    .limit(1);
  if (!c) throw new AppError(404, 'NOT_FOUND', 'Campaign not found');
  const rows = await db
    .select({ code: voucher.code, status: voucher.status, expiresAt: voucher.expiresAt })
    .from(voucher)
    .where(eq(voucher.campaignId, c.id))
    .orderBy(asc(voucher.code));
  const lines = ['code,status,expires_at'];
  for (const r of rows) {
    lines.push([r.code, r.status, r.expiresAt?.toISOString() ?? ''].map(csvField).join(','));
  }
  const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'campaign';
  return { filename: `voucher-campaign-${slug}.csv`, csv: `${lines.join('\n')}\n` };
}

// --- Printing ----------------------------------------------------------------------

/**
 * Queue one print on a station's printer: the job row and — when the station
 * has a printer for the role — the box command that makes the box fetch the
 * document and print it (`GET /box/v1/print-jobs/:id/document`), exactly as a
 * sale's printouts are queued (`sale-printing.ts`), written on the caller's
 * transaction. With no printer the row is `skipped` and nothing is sent; with
 * no box at the station nothing is written and the answer says so.
 */
async function queueVoucherPrint(
  tx: Tx,
  scope: {
    operatorId: string;
    branchId: string;
    stationId: string;
    kind: Extract<PrintKind, 'booth_voucher' | 'credit_voucher'>;
    subjectType: 'voucher' | 'wallet';
    subjectId: string;
    actorAccountId: string;
    actionId: string;
    now: Date;
  },
): Promise<IssuedVoucherView['print']> {
  const [st] = await tx
    .select({ boxId: station.boxId })
    .from(station)
    .where(eq(station.id, scope.stationId))
    .limit(1);
  if (!st?.boxId) {
    return { jobId: null, status: 'none', note: 'Not printed — this till has no box to print through' };
  }
  const role = 'receipt';
  const routed = await routeOnBox(tx, st.boxId, role, scope.stationId);
  const templateType = templateTypeFor(scope.kind);
  const [template] = templateType
    ? await tx
        .select({ id: printTemplate.id, version: printTemplate.version })
        .from(printTemplate)
        .where(
          and(
            eq(printTemplate.branchId, scope.branchId),
            eq(printTemplate.type, templateType as never),
            isNull(printTemplate.archivedAt),
          ),
        )
        .limit(1)
    : [];
  const jobId = newId();
  await tx.insert(printJob).values({
    id: jobId,
    operatorId: scope.operatorId,
    branchId: scope.branchId,
    boxId: st.boxId,
    stationId: scope.stationId,
    deviceId: routed?.deviceId ?? null,
    role,
    kind: scope.kind,
    templateId: template?.id ?? null,
    templateVersion: template?.version ?? null,
    copies: 1,
    status: routed ? 'queued' : 'skipped',
    ...(routed
      ? {}
      : {
          errorCode: 'NO_DEVICE_FOR_ROLE',
          errorMessage: `No ${role} printer is assigned to this station`,
          finishedAt: scope.now,
        }),
    subjectType: scope.subjectType,
    subjectId: scope.subjectId,
    requestedByAccountId: scope.actorAccountId,
    actionId: scope.actionId,
    queuedAt: scope.now,
  });
  if (!routed) {
    return {
      jobId,
      status: 'skipped',
      note: `${scope.kind === 'credit_voucher' ? 'Credit voucher' : 'Voucher'} not printed — no receipt printer at this station`,
    };
  }
  await tx.insert(boxCommand).values({
    id: newId(),
    boxId: st.boxId,
    kind: 'test_print',
    payload: {
      printJobId: jobId,
      kind: scope.kind,
      role,
      stationId: scope.stationId,
      deviceId: routed.deviceId,
      copies: 1,
      document: 'platform',
      subjectType: scope.subjectType,
    } as never,
    requestedByAccountId: scope.actorAccountId,
    actionId: scope.actionId,
    expiresAt: new Date(scope.now.getTime() + boxSettings().commandTtlS * 1000),
    createdAt: scope.now,
    updatedAt: scope.now,
  });
  return { jobId, status: 'queued', note: null };
}

/** The slip's terms, one line each, English then Thai. */
function termsOf(def: DefinitionRow): string[] {
  return [def.termsEn, def.termsTh]
    .filter((t): t is string => !!t)
    .flatMap((t) => t.split(/\r?\n/))
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * WHAT A TILL-PRINTED VOUCHER SAYS, built when the box asks for the job's
 * document (`buildPrintDocument` in `sale-printing.ts`): the booth slip's own
 * fields, filled from the voucher, its definition and the till, the way the
 * booth fills them (`buildPrintJob` in `@oto/box-agent`) — the definition's
 * title and instruction where it has them, its terms, the code twice (QR and
 * text), when it was printed, where and by whom, until when, and — round 5 —
 * the promotion's window when it has one.
 */
export async function tillVoucherDocumentOf(
  db: Exec,
  voucherId: string,
  stationId: string | null,
): Promise<BoothVoucherData | null> {
  const [row] = await db
    .select({ v: voucher, def: voucherDefinition, branchName: branch.name, timezone: branch.timezone })
    .from(voucher)
    .innerJoin(voucherDefinition, eq(voucherDefinition.id, voucher.voucherDefinitionId))
    .innerJoin(branch, eq(branch.id, voucher.branchId))
    .where(eq(voucher.id, voucherId))
    .limit(1);
  if (!row) return null;
  const { v, def } = row;
  const [st] = stationId
    ? await db.select({ name: station.name }).from(station).where(eq(station.id, stationId)).limit(1)
    : [];
  let staff: string | null = null;
  if (v.issuedByAccountId) {
    const [who] = await db
      .select({ name: employee.name, nickname: employee.nickname })
      .from(account)
      .leftJoin(employee, eq(employee.id, account.employeeId))
      .where(eq(account.id, v.issuedByAccountId))
      .limit(1);
    staff = boothStaffLabel(who?.nickname ?? who?.name ?? null, boothStaffCode(v.issuedByAccountId));
  }
  const instruction = [def.instructionEn, def.instructionTh].filter(Boolean).join('\n');
  const window =
    def.validFrom || def.validUntil
      ? `Valid ${def.validFrom ? `from ${formatVoucherDay(def.validFrom)}` : ''}${def.validFrom && def.validUntil ? ' ' : ''}${def.validUntil ? `until ${formatVoucherDay(def.validUntil)}` : ''}.`
      : null;
  return {
    venueLine: row.branchName,
    prizeLine: def.titleEn ?? def.nameEn,
    prizeLineThai: def.titleTh ?? def.nameTh,
    redemptionLine: [instruction || `Show this QR at OTO Reception to claim: ${def.nameEn}.`, window]
      .filter(Boolean)
      .join('\n'),
    terms: termsOf(def),
    voucherCode: def.fixedCode ?? v.code,
    issuedAt: formatVoucherDateTime(v.issuedAt, row.timezone),
    booth: st ? `${row.branchName} · ${st.name}` : row.branchName,
    staff,
    expiresAt: v.expiresAt ? formatVoucherDate(v.expiresAt, row.timezone) : null,
    // A till has no booth slip settings: the slip every booth printed before
    // SCRUM-471 — the logo, the Staff row and the terms, no header or footer.
    footerLine: '',
  };
}

// --- The credit a wallet-credit voucher loaded -----------------------------------

export interface VoucherCreditView {
  voucherId: string;
  /** Null while the voucher has loaded nothing (it is not used up yet). */
  wallet: WalletView | null;
  /** The wallet's ONE voucher QR — what the credit voucher prints and the till shows. */
  qrCode: string | null;
}

/** The wallet a wallet-credit voucher of this operator loaded, as the till shows it. */
export async function voucherCreditOf(
  db: Exec,
  operatorId: string,
  voucherId: string,
): Promise<VoucherCreditView> {
  const [v] = await db
    .select({ id: voucher.id })
    .from(voucher)
    .where(and(eq(voucher.id, voucherId), eq(voucher.operatorId, operatorId)))
    .limit(1);
  if (!v) throw new AppError(404, 'NOT_FOUND', 'Voucher not found');
  const row = await voucherCreditWalletOf(db, operatorId, voucherId);
  if (!row) return { voucherId, wallet: null, qrCode: null };
  const view = await walletViewOf(db, row);
  return {
    voucherId,
    wallet: view,
    qrCode: view.keys.find((k) => k.kind === 'voucher_qr')?.display ?? null,
  };
}

/**
 * PRINT THE CREDIT VOUCHER for the wallet a wallet-credit voucher loaded, on
 * the till's receipt printer: the landed credit voucher (`credit_voucher`,
 * subject the wallet), whose document the platform already builds
 * (`creditVoucherDocumentOf`). Refused while nothing is loaded.
 */
export async function printVoucherCredit(
  tx: Tx,
  actor: { accountId: string; operatorId: string; requestId?: string },
  at: RedemptionStation,
  voucherId: string,
  now: Date = new Date(),
): Promise<{ walletId: string; print: IssuedVoucherView['print'] }> {
  const credit = await voucherCreditOf(tx, actor.operatorId, voucherId);
  if (!credit.wallet) {
    throw new AppError(
      409,
      'VOUCHER_CREDIT_NOT_LOADED',
      'This voucher has not loaded any credit yet — ring it up first',
    );
  }
  if (credit.wallet.branchId && credit.wallet.branchId !== at.branchId) {
    throw new AppError(404, 'NOT_FOUND', 'Voucher not found');
  }
  const print = await queueVoucherPrint(tx, {
    operatorId: actor.operatorId,
    branchId: at.branchId,
    stationId: at.id,
    kind: 'credit_voucher',
    subjectType: 'wallet',
    subjectId: credit.wallet.id,
    actorAccountId: actor.accountId,
    actionId: `voucher:${voucherId}:credit-print:${newId()}`,
    now,
  });
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: at.branchId,
    action: 'voucher.credit_print',
    entityType: 'wallet',
    entityId: credit.wallet.id,
    requestId: actor.requestId ?? null,
    after: { voucherId, stationId: at.id, printJobId: print.jobId, status: print.status },
  });
  return { walletId: credit.wallet.id, print };
}

// --- Foregone revenue ------------------------------------------------------------

/**
 * FOREGONE REVENUE FROM PROMOTIONAL VOUCHERS — its own line, separate from
 * discounts — over the trading days `from`..`to` of the REDEEMING sale, at the
 * branches given (null: every branch of the operator).
 *
 * One row per definition: the vouchers used up on a sale in the range, and
 * what those sales did not charge for them — each voucher's own discount row
 * (`pos.sale_discount`, kind `promo`, carrying the voucher's whole code), which
 * is the engine's own figure, so the line reconciles with the redemptions to
 * the satang. A wallet-credit voucher's credit is reported beside it
 * (`creditLoadedSatang`, the `promo_voucher` grant its load wrote), never in
 * it: loaded credit is stored value, owed until it is spent or expires.
 */
export async function promoVoucherReportOf(
  db: Exec,
  operatorId: string,
  filters: { branchIds: readonly string[] | null; from: string; to: string },
): Promise<PromoVoucherReport> {
  const branchFilter =
    filters.branchIds === null
      ? sql`true`
      : filters.branchIds.length === 0
        ? sql`false`
        : sql`s.branch_id in (${sql.join(
            filters.branchIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`;
  const { rows } = await db.execute<{
    id: string;
    code: string;
    name_en: string;
    kind: string;
    redemptions: number | string;
    foregone: number | string;
    credit: number | string;
  }>(sql`
    select d.id, d.code, d.name_en, d.kind,
      count(v.id)::int as redemptions,
      coalesce(sum(coalesce(fg.amount, 0)), 0)::bigint as foregone,
      coalesce(sum(coalesce(we.amount_satang, 0)), 0)::bigint as credit
    from promo.voucher v
    join promo.voucher_definition d on d.id = v.voucher_definition_id
    join pos.sale s on s.id = v.sale_id
    left join lateral (
      select sum(sd.amount_satang) as amount from pos.sale_discount sd
      where sd.sale_id = s.id and sd.kind = 'promo' and sd.code = v.code
    ) fg on true
    left join pos.wallet_entry we
      on we.operator_id = v.operator_id and we.action_id = 'voucher:' || v.id::text || ':load'
    where v.operator_id = ${operatorId}::uuid
      and v.status = 'redeemed'
      and s.business_date between ${filters.from}::date and ${filters.to}::date
      and ${branchFilter}
    group by d.id, d.code, d.name_en, d.kind
    order by foregone desc, d.name_en asc`);
  const out = rows.map((r) => ({
    definitionId: r.id,
    definitionCode: r.code,
    nameEn: r.name_en,
    kind: r.kind,
    redemptions: Number(r.redemptions),
    foregoneSatang: Number(r.foregone),
    creditLoadedSatang: Number(r.credit),
  }));
  return {
    range: { from: filters.from, to: filters.to },
    summary: {
      redemptions: out.reduce((n, r) => n + r.redemptions, 0),
      foregoneSatang: out.reduce((n, r) => n + r.foregoneSatang, 0),
      creditLoadedSatang: out.reduce((n, r) => n + r.creditLoadedSatang, 0),
    },
    rows: out,
  };
}
