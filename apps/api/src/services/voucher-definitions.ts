import { and, asc, count, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import {
  boothPrize,
  branch,
  product,
  station,
  ticketPackage,
  voucher,
  voucherDefinition,
  type Db,
  type VoucherKind,
  type VoucherOfflinePolicy,
  type VoucherValueType,
} from '@oto/db';
import { newId } from '@oto/shared';
import { AppError } from '../lib/errors';
import { pgErrorOf } from '../lib/scrub';
import { audit } from './audit';
import { withTx, type Exec, type OpContext } from './tx';

/**
 * Voucher types — what a booth prize is worth, set up by the park before any
 * wheel gives one away (SCRUM-400, S2-07d).
 *
 * The owner's rule of 24 September is the reason this file exists: "a prize
 * or a discount is set up by the park first, in the admin". Until now the six
 * launch types were seed rows the Console could read and nobody could change,
 * so a "50 THB off" prize needed an engineer, and the two free items and the
 * 1+1 ticket pointed at no product or package — which the till answers with
 * "not set up yet, ask a manager" (`resolveVoucherEffect` in `vouchers.ts`).
 *
 * **What a definition decides, and when it takes effect.** Three different
 * things, with three different moments:
 *
 *   - WHAT IT IS WORTH (kind, amount, percentage, the product or package) is
 *     read by the till at redemption, from this row (`vouchers.ts`). Editing
 *     it changes every voucher of the type that has not been redeemed yet,
 *     slips already printed included — the paper names the prize, the platform
 *     says what it is worth.
 *   - WHAT THE SLIP SAYS (title, instruction, terms). What decides is the
 *     wheel version a booth is running, not this row as it is now. A
 *     definition that version carries words for — it had a title or an
 *     instruction when that version was published (`slipWording` in
 *     `booth-admin.ts`) — prints that version's title, instruction and terms
 *     (`buildPrintJob` in `@oto/box-agent`), so any edit, clearing the title
 *     and the instruction included, waits for that booth's next publish. Any
 *     other definition prints the prize's own name, the generic line and
 *     this row's current terms, which reach the box on its cache scope, so an
 *     edit to them is on paper at the box's next pull. That includes a
 *     definition given its first title or instruction after that version
 *     was published: until the booth is published with it, its slip keeps
 *     the prize's name and the generic line while its terms follow the pull.
 *     A booth nobody has worded therefore publishes, and prints, what it
 *     always did.
 *   - HOW LONG IT LASTS (expiry) is read at issue: when a voucher is won the
 *     box takes the prize's own days from the wheel or, when the prize names
 *     none, this row's from its cache (`resolveExpiry` in `@oto/box-agent`),
 *     and the date goes onto the voucher. So a change applies to vouchers won
 *     after the box's next pull (within about a minute online), never to a
 *     slip already printed.
 *
 * **The rules the till needs are enforced here, on every save, against the
 * whole row.** A definition is checked as it will be AFTER the write — the
 * patch laid over what is stored — because a partial edit that leaves a free
 * product without its product is exactly the row the till refuses. So a free
 * product needs a product of this operator, a 1+1 needs a ticket package of
 * this operator, an amount needs more than zero, and a percentage needs more
 * than zero and at most 100 %. Fields a kind does not read are cleared, so a
 * type switched from "free product" to "amount off" does not keep a product
 * link nobody can see.
 *
 * **What is deliberately NOT a setting.** Whether a voucher combines with
 * another voucher or a promo code, which branch may redeem it and whether a
 * till may take it offline are platform rules for every booth voucher (owner,
 * 24 September; spec §8): one voucher per sale and no promo code beside it,
 * any branch of the operator (but a free product only at a park selling its
 * linked product, or one of its own with the same code once the linked one is
 * archived; a 1+1 only at a park with a live ticket package of the same name
 * — see `voucherDefinitionLinkOptions`), online only. `vouchers.ts` enforces all three whatever a definition says,
 * so offering them as switches here would be a screen promising behaviour the
 * till does not have. `offline_policy` is still accepted for the voucher
 * sources it does govern (the legacy import, manual issue); a booth voucher
 * ignores it.
 */

type DefinitionRow = typeof voucherDefinition.$inferSelect;

export interface VoucherDefinitionInput {
  code: string;
  nameEn: string;
  nameTh?: string | null;
  kind: VoucherKind;
  valueType?: VoucherValueType;
  valueSatang?: number | null;
  valueBp?: number | null;
  productId?: string | null;
  ticketPackageId?: string | null;
  /** Null never expires — which the owner allows per prize (24 September). */
  expiryDays?: number | null;
  offlinePolicy?: VoucherOfflinePolicy;
  singleUse?: boolean;
  costSatang?: number;
  titleEn?: string | null;
  titleTh?: string | null;
  instructionEn?: string | null;
  instructionTh?: string | null;
  termsEn?: string | null;
  termsTh?: string | null;
  active?: boolean;
}

/** One live prize on a live booth that points at a definition. */
export interface VoucherDefinitionUse {
  boothId: string;
  boothName: string;
  branchId: string;
  prizeId: string;
  prizeName: string;
  /**
   * The prize's Thai name. A slip prints the prize's own names where the type
   * has no title, so the Console's slip preview needs both to show that.
   */
  prizeNameTh: string | null;
  /** Switched on for the wheel. A switched-off prize is not drawn. */
  active: boolean;
}

/** What the linked product or package is, named, so a list can say it. */
export interface VoucherLinkView {
  id: string;
  name: string;
  /**
   * The product's code. Where this product is not on sale, the platform looks
   * for a live product of the redeeming park's own with this code
   * (`freeItemAtBranch` in vouchers.ts) — one that can exist only once this
   * one is archived, codes being unique among the operator's unarchived
   * products (`product_code_unique`). Null for a package, and for a product
   * that has no code.
   */
  code: string | null;
  branchId: string | null;
  branchName: string | null;
  /** On sale: active and not archived. The till refuses one that is not. */
  live: boolean;
}

/**
 * A definition as the Console reads it: the row, JSON-safe, with the product
 * or package it points at named and the booth prizes that point at it.
 */
export interface VoucherDefinitionView {
  id: string;
  code: string;
  nameEn: string;
  nameTh: string | null;
  kind: VoucherKind;
  valueType: VoucherValueType;
  valueSatang: number | null;
  valueBp: number | null;
  productId: string | null;
  ticketPackageId: string | null;
  expiryDays: number | null;
  offlinePolicy: VoucherOfflinePolicy;
  singleUse: boolean;
  costSatang: number;
  titleEn: string | null;
  titleTh: string | null;
  instructionEn: string | null;
  instructionTh: string | null;
  termsEn: string | null;
  termsTh: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  product: VoucherLinkView | null;
  ticketPackage: VoucherLinkView | null;
  usedBy: VoucherDefinitionUse[];
  /**
   * Vouchers of this type still in families' hands — issued, not yet used,
   * not voided and not past their date — counted when the type was read. It
   * is what an edit to the worth reprices (SCRUM-409), so the Console's
   * question says the number. Expiry is judged from `expires_at` against the
   * clock, as the till judges it (`vouchers.ts`), not from the status column:
   * nothing marks a lapsed row `expired` today (the schema allows the status
   * and the till refuses it), and a row carrying it is not counted either.
   */
  unredeemedVouchers: number;
}

// --- The value, whole --------------------------------------------------------

/** The columns that decide what a voucher is worth. */
interface ValueShape {
  kind: VoucherKind;
  valueType: VoucherValueType;
  valueSatang: number | null;
  valueBp: number | null;
  productId: string | null;
  ticketPackageId: string | null;
}

/**
 * The value types each kind can be. A discount is the one kind with a choice;
 * every other kind has exactly one, and it is filled in rather than asked for.
 */
const VALUE_TYPES_FOR: Record<VoucherKind, readonly VoucherValueType[]> = {
  discount: ['amount', 'percent'],
  free_item: ['item'],
  free_ticket: ['item'],
  wallet_credit: ['amount'],
  manual: ['none'],
};

/**
 * The value this definition will hold after the write, checked whole and
 * trimmed to what its kind reads.
 *
 * `explicitValueType` is the value type the CALLER sent, if any: a type the
 * kind cannot be is refused rather than quietly replaced, while a kind change
 * that says nothing about the value type takes the kind's own.
 */
async function settleValue(
  exec: Exec,
  operatorId: string,
  next: ValueShape,
  explicitValueType: VoucherValueType | undefined,
): Promise<ValueShape> {
  const allowed = VALUE_TYPES_FOR[next.kind];
  if (explicitValueType !== undefined && !allowed.includes(explicitValueType)) {
    throw new AppError(
      400,
      'VOUCHER_VALUE_TYPE_INVALID',
      `A ${next.kind} voucher cannot be worth "${explicitValueType}" — it is ${allowed.join(' or ')}.`,
    );
  }
  const valueType = allowed.includes(next.valueType) ? next.valueType : allowed[0]!;
  const none = { valueSatang: null, valueBp: null, productId: null, ticketPackageId: null };

  switch (next.kind) {
    case 'discount': {
      if (!allowed.includes(next.valueType)) {
        throw new AppError(
          400,
          'VOUCHER_VALUE_TYPE_INVALID',
          'A discount is an amount off or a percentage off — say which with `valueType`.',
        );
      }
      if (valueType === 'amount') {
        if (next.valueSatang === null || next.valueSatang <= 0) {
          throw new AppError(
            400,
            'VOUCHER_VALUE_MISSING',
            'An amount-off voucher needs an amount above zero (`valueSatang`).',
          );
        }
        return { ...none, kind: next.kind, valueType, valueSatang: next.valueSatang };
      }
      if (next.valueBp === null || next.valueBp <= 0 || next.valueBp > 10_000) {
        throw new AppError(
          400,
          'VOUCHER_VALUE_MISSING',
          'A percentage-off voucher needs a percentage above zero and at most 100 % (`valueBp`, in basis points).',
        );
      }
      return { ...none, kind: next.kind, valueType, valueBp: next.valueBp };
    }
    case 'free_item': {
      if (!next.productId) {
        throw new AppError(
          400,
          'VOUCHER_PRODUCT_MISSING',
          'A free-product voucher needs the product it hands over — link one before saving.',
        );
      }
      const [found] = await exec
        .select({ id: product.id })
        .from(product)
        .where(and(eq(product.id, next.productId), eq(product.operatorId, operatorId)))
        .limit(1);
      if (!found) {
        throw new AppError(400, 'VOUCHER_PRODUCT_NOT_FOUND', 'No product with that id at this operator.');
      }
      return { ...none, kind: next.kind, valueType, productId: found.id };
    }
    case 'free_ticket': {
      if (!next.ticketPackageId) {
        throw new AppError(
          400,
          'VOUCHER_PACKAGE_MISSING',
          'A 1+1 kids-ticket voucher needs the ticket package it applies to — link one before saving.',
        );
      }
      const [found] = await exec
        .select({ id: ticketPackage.id })
        .from(ticketPackage)
        .where(
          and(eq(ticketPackage.id, next.ticketPackageId), eq(ticketPackage.operatorId, operatorId)),
        )
        .limit(1);
      if (!found) {
        throw new AppError(
          400,
          'VOUCHER_PACKAGE_NOT_FOUND',
          'No ticket package with that id at this operator.',
        );
      }
      return { ...none, kind: next.kind, valueType, ticketPackageId: found.id };
    }
    case 'wallet_credit': {
      // Nothing redeems one yet (`resolveVoucherEffect` refuses it), and the
      // Console does not offer it; the rule it had before this file is kept.
      if (next.valueSatang === null || next.valueSatang <= 0) {
        throw new AppError(
          400,
          'VOUCHER_VALUE_MISSING',
          'A wallet credit needs an amount above zero (`valueSatang`).',
        );
      }
      return { ...none, kind: next.kind, valueType, valueSatang: next.valueSatang };
    }
    case 'manual':
      return { ...none, kind: next.kind, valueType };
  }
}

/**
 * Printed words, as stored: trimmed, and an empty field is "not written"
 * (null) rather than a blank line on the paper. `undefined` stays undefined —
 * a patch that does not name a field leaves it alone.
 */
function words(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// --- Reading -----------------------------------------------------------------

function isNonNull<T>(value: T | null): value is T {
  return value !== null;
}

/** Name the products, packages and prizes a set of definitions point at. */
async function viewsOf(
  exec: Exec,
  operatorId: string,
  rows: DefinitionRow[],
): Promise<VoucherDefinitionView[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const productIds = [...new Set(rows.map((r) => r.productId).filter(isNonNull))];
  const packageIds = [...new Set(rows.map((r) => r.ticketPackageId).filter(isNonNull))];

  const products = productIds.length
    ? await exec
        .select({
          id: product.id,
          name: product.name,
          code: product.code,
          branchId: product.branchId,
          branchName: branch.name,
          active: product.active,
          archivedAt: product.archivedAt,
        })
        .from(product)
        .leftJoin(branch, eq(branch.id, product.branchId))
        .where(and(eq(product.operatorId, operatorId), inArray(product.id, productIds)))
    : [];
  const packages = packageIds.length
    ? await exec
        .select({
          id: ticketPackage.id,
          name: ticketPackage.name,
          branchId: ticketPackage.branchId,
          branchName: branch.name,
          active: ticketPackage.active,
          archivedAt: ticketPackage.archivedAt,
        })
        .from(ticketPackage)
        .leftJoin(branch, eq(branch.id, ticketPackage.branchId))
        .where(and(eq(ticketPackage.operatorId, operatorId), inArray(ticketPackage.id, packageIds)))
    : [];

  /**
   * The live prizes on live booths that point at each definition — what an
   * edit or an archive here reaches. Archived prizes are left out: they are
   * off every wheel, and naming them would make a type look in use that is
   * not.
   */
  const uses = await exec
    .select({
      definitionId: boothPrize.voucherDefinitionId,
      prizeId: boothPrize.id,
      prizeName: boothPrize.nameEn,
      prizeNameTh: boothPrize.nameTh,
      active: boothPrize.active,
      boothId: station.id,
      boothName: station.name,
      branchId: station.branchId,
    })
    .from(boothPrize)
    .innerJoin(station, eq(station.id, boothPrize.stationId))
    .where(
      and(
        eq(boothPrize.operatorId, operatorId),
        isNull(boothPrize.archivedAt),
        isNull(station.archivedAt),
        inArray(boothPrize.voucherDefinitionId, ids),
      ),
    )
    .orderBy(asc(station.name), asc(boothPrize.sortOrder), asc(boothPrize.nameEn));

  /**
   * How many vouchers of each definition are still unredeemed: issued, not
   * used, not void, and not past their date by the api's clock — the reading
   * the till makes of `expires_at` (`vouchers.ts`), so a lapsed voucher still
   * marked `issued` (no job marks one `expired` yet) is not counted as out.
   * One grouped query for the whole list; a definition with none has no row
   * here.
   */
  const unredeemed = await exec
    .select({ definitionId: voucher.voucherDefinitionId, vouchers: count() })
    .from(voucher)
    .where(
      and(
        eq(voucher.operatorId, operatorId),
        inArray(voucher.voucherDefinitionId, ids),
        eq(voucher.status, 'issued'),
        or(isNull(voucher.expiresAt), gt(voucher.expiresAt, new Date())),
      ),
    )
    .groupBy(voucher.voucherDefinitionId);

  const productById = new Map(products.map((p) => [p.id, p]));
  const packageById = new Map(packages.map((p) => [p.id, p]));
  const unredeemedById = new Map(unredeemed.map((u) => [u.definitionId, u.vouchers]));

  return rows.map((row) => {
    const p = row.productId ? productById.get(row.productId) : undefined;
    const k = row.ticketPackageId ? packageById.get(row.ticketPackageId) : undefined;
    return {
      id: row.id,
      code: row.code,
      nameEn: row.nameEn,
      nameTh: row.nameTh,
      kind: row.kind,
      valueType: row.valueType,
      valueSatang: row.valueSatang,
      valueBp: row.valueBp,
      productId: row.productId,
      ticketPackageId: row.ticketPackageId,
      expiryDays: row.expiryDays,
      offlinePolicy: row.offlinePolicy,
      singleUse: row.singleUse,
      costSatang: row.costSatang,
      titleEn: row.titleEn,
      titleTh: row.titleTh,
      instructionEn: row.instructionEn,
      instructionTh: row.instructionTh,
      termsEn: row.termsEn,
      termsTh: row.termsTh,
      active: row.active,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      archivedAt: row.archivedAt?.toISOString() ?? null,
      product: p
        ? {
            id: p.id,
            name: p.name,
            code: p.code,
            branchId: p.branchId,
            branchName: p.branchName ?? null,
            live: p.active && p.archivedAt === null,
          }
        : null,
      ticketPackage: k
        ? {
            id: k.id,
            name: k.name,
            code: null,
            branchId: k.branchId,
            branchName: k.branchName ?? null,
            live: k.active && k.archivedAt === null,
          }
        : null,
      usedBy: uses
        .filter((u) => u.definitionId === row.id)
        .map((u) => ({
          boothId: u.boothId,
          boothName: u.boothName,
          branchId: u.branchId,
          prizeId: u.prizeId,
          prizeName: u.prizeName,
          prizeNameTh: u.prizeNameTh,
          active: u.active,
        })),
      unredeemedVouchers: unredeemedById.get(row.id) ?? 0,
    };
  });
}

async function viewOne(
  exec: Exec,
  operatorId: string,
  row: DefinitionRow,
): Promise<VoucherDefinitionView> {
  const [view] = await viewsOf(exec, operatorId, [row]);
  return view!;
}

export async function listVoucherDefinitions(
  db: Db,
  operatorId: string,
  includeArchived: boolean,
): Promise<{ definitions: VoucherDefinitionView[] }> {
  const rows = await db
    .select()
    .from(voucherDefinition)
    .where(
      and(
        eq(voucherDefinition.operatorId, operatorId),
        includeArchived ? undefined : isNull(voucherDefinition.archivedAt),
      ),
    )
    .orderBy(asc(voucherDefinition.nameEn), asc(voucherDefinition.code));
  return { definitions: await viewsOf(db, operatorId, rows) };
}

/** One definition of THIS operator, archived or not, or 404. */
export async function loadVoucherDefinition(
  db: Db,
  operatorId: string,
  id: string,
): Promise<DefinitionRow> {
  const [row] = await db.select().from(voucherDefinition).where(eq(voucherDefinition.id, id)).limit(1);
  if (!row || row.operatorId !== operatorId) {
    throw new AppError(404, 'VOUCHER_DEFINITION_NOT_FOUND', 'No voucher definition with that id');
  }
  return row;
}

export interface VoucherLinkOptions {
  products: Array<{
    id: string;
    name: string;
    code: string | null;
    kind: string;
    branchId: string | null;
    branchName: string | null;
    priceSatang: number;
  }>;
  packages: Array<{ id: string; name: string; branchId: string; branchName: string }>;
}

/**
 * What a definition can point at: the operator's products that are on sale
 * and its ticket packages, each with the branch it belongs to.
 *
 * Every branch, because a definition is the operator's. What the branch shown
 * beside a link means depends on the kind (`freeItemAtBranch` and
 * `packageAtBranch` in `vouchers.ts`):
 *   - a 1+1's package is honoured at every park that sells a package of the
 *     same name, so its branch is only where the link was made;
 *   - a free product is honoured at the park that sells the linked product,
 *     and at every park only when that product belongs to no branch. The
 *     till's fallback to a product of its own branch with the same `code`
 *     cannot reach another park while the linked row is live: a code belongs
 *     to one live row in the whole operator (`product_code_unique`). So for a
 *     free product the branch shown is the park that honours it.
 */
export async function voucherDefinitionLinkOptions(
  db: Db,
  operatorId: string,
): Promise<VoucherLinkOptions> {
  const products = await db
    .select({
      id: product.id,
      name: product.name,
      code: product.code,
      kind: product.kind,
      branchId: product.branchId,
      branchName: branch.name,
      priceSatang: product.priceSatang,
    })
    .from(product)
    .leftJoin(branch, eq(branch.id, product.branchId))
    .where(
      and(
        eq(product.operatorId, operatorId),
        eq(product.active, true),
        isNull(product.archivedAt),
        // An operator-wide product has no branch; a branch's product is offered
        // only while that branch is live.
        or(isNull(product.branchId), isNull(branch.archivedAt)),
      ),
    )
    .orderBy(asc(branch.name), asc(product.name));
  const packages = await db
    .select({
      id: ticketPackage.id,
      name: ticketPackage.name,
      branchId: ticketPackage.branchId,
      branchName: branch.name,
    })
    .from(ticketPackage)
    .innerJoin(branch, eq(branch.id, ticketPackage.branchId))
    .where(
      and(
        eq(ticketPackage.operatorId, operatorId),
        eq(ticketPackage.active, true),
        isNull(ticketPackage.archivedAt),
        isNull(branch.archivedAt),
      ),
    )
    .orderBy(asc(branch.name), asc(ticketPackage.name));
  return {
    products: products.map((p) => ({ ...p, branchName: p.branchName ?? null })),
    packages,
  };
}

// --- Writing -----------------------------------------------------------------

type Actor = { accountId: string; operatorId: string };

export async function createVoucherDefinition(
  db: Db,
  ctx: OpContext,
  actor: Actor,
  input: VoucherDefinitionInput,
): Promise<{ definition: VoucherDefinitionView }> {
  const value = await settleValue(
    db,
    actor.operatorId,
    {
      kind: input.kind,
      valueType: input.valueType ?? VALUE_TYPES_FOR[input.kind][0]!,
      valueSatang: input.valueSatang ?? null,
      valueBp: input.valueBp ?? null,
      productId: input.productId ?? null,
      ticketPackageId: input.ticketPackageId ?? null,
    },
    input.valueType,
  );
  const id = newId();
  try {
    return await withTx(db, ctx, 'voucher_definition.create', async (tx) => {
      await tx.insert(voucherDefinition).values({
        id,
        operatorId: actor.operatorId,
        code: input.code,
        nameEn: input.nameEn.trim(),
        nameTh: words(input.nameTh) ?? null,
        ...value,
        expiryDays: input.expiryDays ?? null,
        offlinePolicy: input.offlinePolicy ?? 'allow',
        singleUse: input.singleUse ?? true,
        costSatang: input.costSatang ?? 0,
        titleEn: words(input.titleEn) ?? null,
        titleTh: words(input.titleTh) ?? null,
        instructionEn: words(input.instructionEn) ?? null,
        instructionTh: words(input.instructionTh) ?? null,
        termsEn: words(input.termsEn) ?? null,
        termsTh: words(input.termsTh) ?? null,
        active: input.active ?? true,
      });
      const [row] = await tx
        .select()
        .from(voucherDefinition)
        .where(eq(voucherDefinition.id, id))
        .limit(1);
      await audit.record(tx, {
        actorAccountId: actor.accountId,
        operatorId: actor.operatorId,
        action: 'voucher_definition.create',
        entityType: 'voucher_definition',
        entityId: id,
        after: row,
        requestId: ctx.requestId,
      });
      return { definition: await viewOne(tx, actor.operatorId, row!) };
    });
  } catch (err) {
    throw definitionConflict(err);
  }
}

/**
 * Edit a definition. The value is checked as it will be after the edit — see
 * the note at the top of the file — so an edit that touches only the wording
 * of a free product with no product linked is refused until one is linked:
 * that row is a voucher the till cannot honour, and saving more of it would
 * hide that rather than fix it.
 *
 * An archived definition is not edited here; `restoreVoucherDefinition` brings
 * it back first. Its vouchers are still honoured (`vouchers.ts`), and a row
 * nobody can see in the list should not change under them.
 */
export async function updateVoucherDefinition(
  db: Db,
  ctx: OpContext,
  actor: Actor,
  before: DefinitionRow,
  patch: Partial<VoucherDefinitionInput>,
): Promise<{ definition: VoucherDefinitionView }> {
  if (before.archivedAt) {
    throw new AppError(
      409,
      'VOUCHER_DEFINITION_ARCHIVED',
      'This voucher type is archived. Restore it before changing it.',
    );
  }
  const value = await settleValue(
    db,
    actor.operatorId,
    {
      kind: patch.kind ?? before.kind,
      valueType: patch.valueType ?? before.valueType,
      valueSatang: patch.valueSatang !== undefined ? patch.valueSatang : before.valueSatang,
      valueBp: patch.valueBp !== undefined ? patch.valueBp : before.valueBp,
      productId: patch.productId !== undefined ? patch.productId : before.productId,
      ticketPackageId:
        patch.ticketPackageId !== undefined ? patch.ticketPackageId : before.ticketPackageId,
    },
    patch.valueType,
  );
  try {
    return await withTx(db, ctx, 'voucher_definition.update', async (tx) => {
      const set: Partial<typeof voucherDefinition.$inferInsert> = {
        ...value,
        updatedAt: new Date(),
      };
      if (patch.code !== undefined) set.code = patch.code;
      if (patch.nameEn !== undefined) set.nameEn = patch.nameEn.trim();
      if (patch.nameTh !== undefined) set.nameTh = words(patch.nameTh);
      if (patch.expiryDays !== undefined) set.expiryDays = patch.expiryDays;
      if (patch.offlinePolicy !== undefined) set.offlinePolicy = patch.offlinePolicy;
      if (patch.singleUse !== undefined) set.singleUse = patch.singleUse;
      if (patch.costSatang !== undefined) set.costSatang = patch.costSatang;
      if (patch.titleEn !== undefined) set.titleEn = words(patch.titleEn);
      if (patch.titleTh !== undefined) set.titleTh = words(patch.titleTh);
      if (patch.instructionEn !== undefined) set.instructionEn = words(patch.instructionEn);
      if (patch.instructionTh !== undefined) set.instructionTh = words(patch.instructionTh);
      if (patch.termsEn !== undefined) set.termsEn = words(patch.termsEn);
      if (patch.termsTh !== undefined) set.termsTh = words(patch.termsTh);
      if (patch.active !== undefined) set.active = patch.active;
      await tx.update(voucherDefinition).set(set).where(eq(voucherDefinition.id, before.id));
      const [row] = await tx
        .select()
        .from(voucherDefinition)
        .where(eq(voucherDefinition.id, before.id))
        .limit(1);
      await audit.record(tx, {
        actorAccountId: actor.accountId,
        operatorId: actor.operatorId,
        action: 'voucher_definition.update',
        entityType: 'voucher_definition',
        entityId: before.id,
        before,
        after: row,
        requestId: ctx.requestId,
      });
      return { definition: await viewOne(tx, actor.operatorId, row!) };
    });
  } catch (err) {
    throw definitionConflict(err);
  }
}

/**
 * Take a voucher type off the list. Archived, never deleted: every voucher of
 * the type points at this row, and those still in families' hands are still
 * honoured at the till (`resolveVoucherEffect` reads an archived definition
 * as readily as a live one).
 *
 * What it stops is NEW vouchers, at the next publish: a booth prize pointing
 * at an archived type cannot be published (`BOOTH_PRIZE_DEFINITION_INACTIVE`),
 * and a booth running a published wheel keeps printing it until then. The
 * list says which prizes point at it before anybody presses this.
 *
 * Archiving one that is already archived answers with it and records nothing,
 * so a double press is not a failure and not a second audit row.
 */
export async function archiveVoucherDefinition(
  db: Db,
  ctx: OpContext,
  actor: Actor,
  before: DefinitionRow,
): Promise<{ definition: VoucherDefinitionView }> {
  if (before.archivedAt) return { definition: await viewOne(db, actor.operatorId, before) };
  return withTx(db, ctx, 'voucher_definition.archive', async (tx) => {
    const archivedAt = new Date();
    await tx
      .update(voucherDefinition)
      .set({ archivedAt, active: false, updatedAt: archivedAt })
      .where(eq(voucherDefinition.id, before.id));
    const [row] = await tx
      .select()
      .from(voucherDefinition)
      .where(eq(voucherDefinition.id, before.id))
      .limit(1);
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      action: 'voucher_definition.archive',
      entityType: 'voucher_definition',
      entityId: before.id,
      before,
      after: row,
      requestId: ctx.requestId,
    });
    return { definition: await viewOne(tx, actor.operatorId, row!) };
  });
}

/**
 * Bring an archived voucher type back, switched on. The same guard in reverse:
 * one that is not archived answers with itself and records nothing.
 */
export async function restoreVoucherDefinition(
  db: Db,
  ctx: OpContext,
  actor: Actor,
  before: DefinitionRow,
): Promise<{ definition: VoucherDefinitionView }> {
  if (!before.archivedAt) return { definition: await viewOne(db, actor.operatorId, before) };
  return withTx(db, ctx, 'voucher_definition.restore', async (tx) => {
    await tx
      .update(voucherDefinition)
      .set({ archivedAt: null, active: true, updatedAt: new Date() })
      .where(eq(voucherDefinition.id, before.id));
    const [row] = await tx
      .select()
      .from(voucherDefinition)
      .where(eq(voucherDefinition.id, before.id))
      .limit(1);
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      action: 'voucher_definition.restore',
      entityType: 'voucher_definition',
      entityId: before.id,
      before,
      after: row,
      requestId: ctx.requestId,
    });
    return { definition: await viewOne(tx, actor.operatorId, row!) };
  });
}

/**
 * Unwrapped before it is read: Drizzle raises its own error with the
 * database's as `cause`, so a check against the top-level object sees neither
 * the SQLSTATE nor the constraint name (the note on `isUniqueViolation` in
 * `booth-admin.ts`).
 */
function definitionConflict(err: unknown): unknown {
  const pg = pgErrorOf(err);
  if (pg?.code === '23505' && pg.constraint === 'voucher_definition_code_unique') {
    return new AppError(
      409,
      'VOUCHER_DEFINITION_CODE_TAKEN',
      'That voucher code is already used by another definition — codes are how imports and reports name one',
    );
  }
  return err;
}
