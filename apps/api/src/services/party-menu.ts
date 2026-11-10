import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { account, auditLog, branch, product, productCategory, type Db } from '@oto/db';
import {
  PARTY_MENU_CATEGORY_CODE,
  PARTY_MENU_CATEGORY_NAME,
  PARTY_MENU_CODE_PREFIX,
  deriveId,
  newId,
  partyMenuPriceProblem,
  type PartyMenuProductAnswer,
  type PartyMenuProductBody,
} from '@oto/shared';
import { errors } from '../lib/errors';
import { audit } from './audit';
import { findOtoAppUser, otoAppUserIsOperators } from './oto-app-users';
import { withTx, type Exec, type OpContext, type Tx } from './tx';

/**
 * SCRUM-828 — A NEW MENU ITEM ADDED FROM THE BEO, made a till product.
 *
 * The OTO App's server asks for it with its provisioning key, so the operator
 * is the key's and nothing in the body can name another (`credential:
 * 'otoapp-provision'`, `routes/otoapp-party-menu.ts`). What it makes:
 *
 *   - the operator's "Party menu" category, found by its code (`PARTY-MENU`)
 *     or made once: menu categories are operator-wide in this schema
 *     (`product_category` has no branch), so every park's party items share
 *     it, and each item is the branch's own (`product.branch_id`). Its tax
 *     area is F&B; where an item prints is the item's own, below;
 *   - the product: a `menu` item of the party's branch, its prep station the
 *     one the BEO named (so the party's slips print it in the kitchen or at
 *     the bar), its price the BEO's or 0 for a free / included / alternate
 *     item, and `beo_only` set, so the till's selling grids and its F&B menu
 *     never show it (`GET /branches/:branchId/menu` leaves it out);
 *   - its code, `PARTY-` and eight hex digits of its id, upper case, unique
 *     among the operator's live products (twelve digits in the unlikely case
 *     the eight are taken). The OTO App writes it to the BEO's line, and the
 *     party's plan and slips find the product by it like any catalogue item.
 *
 * **One press, one product.** The platform's replay store keeps no answer for
 * a machine credential (`plugins/idempotency.ts`, `unstorable`), so the
 * Idempotency-Key the app sends is honoured here instead: the product's id is
 * DERIVED from the operator and the key, so the same key can only ever name
 * the same product. A second arrival with the same body answers that product
 * (`replayed`); with a different body it is refused 409, as the replay store
 * refuses one. The creation's audit row holds the request's digest, under an
 * id derived the same way, which is what a second arrival is compared with.
 *
 * **Who made it.** The app names the user who pressed (`actorAppUserId`);
 * both audit rows carry the platform account stamped on that user as their
 * actor (`actorAccountOf`), and the app user's id beside it. Who pressed is
 * not part of the request's digest, so a retry by a colleague replays.
 */

/** Every party-menu write for one operator, one at a time. */
const lockOf = (operatorId: string) => `party-menu:${operatorId}`;

/** The code lengths tried, shortest first: eight hex digits, then twelve. */
export const PARTY_MENU_CODE_LENGTHS = [8, 12] as const;

/**
 * A BEO-made product's code: `PARTY-` and the last `length` hex digits of its
 * id, upper case (`PARTY-3F9A21C4`). The tail of an id `deriveId` makes is all
 * hash, so two products' codes collide only by chance; the service checks the
 * code is free before it takes it.
 */
export function partyMenuCode(productId: string, length: number = PARTY_MENU_CODE_LENGTHS[0]): string {
  const hex = productId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('partyMenuCode needs a uuid');
  if (!Number.isInteger(length) || length < 4 || length > 12) {
    throw new Error('partyMenuCode takes 4 to 12 hex digits');
  }
  return `${PARTY_MENU_CODE_PREFIX}${hex.slice(-length).toUpperCase()}`;
}

/** The product an Idempotency-Key names, in one operator: derived, never minted. */
export function partyMenuProductId(operatorId: string, idempotencyKey: string): string {
  return deriveId(operatorId, `party-menu-product:${idempotencyKey}`);
}

/** The id of the audit row that records a product's creation, derived from the product's. */
const creationAuditId = (productId: string) => deriveId(productId, 'party-menu-product:created');

export interface PartyMenuProductInput extends PartyMenuProductBody {
  /** From the provisioning key, never from the body. */
  operatorId: string;
  idempotencyKey: string;
}

/** What a request asks for, as one digest: a free item's price is 0 whether it came as null or 0. */
export function partyMenuRequestDigest(input: PartyMenuProductBody): string {
  const asked = {
    branchId: input.branchId.toLowerCase(),
    name: input.name,
    station: input.station,
    priceSatang: input.free ? 0 : input.priceSatang,
    free: input.free,
    source: { eventId: input.source.eventId, lineLabel: input.source.lineLabel },
  };
  return createHash('sha256').update(JSON.stringify(asked)).digest('hex');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The platform account of the OTO App user who pressed, for the audit rows:
 * the account stamped on that user (`otoapp.users.platform_user_id`), when
 * the user is in one of this operator's park groups and the account is this
 * operator's — the resolution `provisionExistingOtoAppUser` makes of the
 * administrator it names. Null when there is none (somebody with no suite
 * sign-in yet): anyone who may create a BEO may add an item, so nobody is
 * refused for it, and the rows keep the app user's id beside the null.
 */
export async function actorAccountOf(db: Exec, operatorId: string, appUserId: string): Promise<string | null> {
  if (!(await otoAppUserIsOperators(db, { operatorId, userId: appUserId }))) return null;
  const user = await findOtoAppUser(db, { id: appUserId });
  const stamped = user?.platformUserId ?? null;
  if (!stamped || !UUID.test(stamped)) return null;
  const [held] = await db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.id, stamped), eq(account.operatorId, operatorId)))
    .limit(1);
  return held?.id ?? null;
}

/** The operator's live "Party menu" category, made once. */
async function partyMenuCategory(tx: Tx, input: PartyMenuProductInput, ctx: OpContext): Promise<string> {
  const [held] = await tx
    .select({ id: productCategory.id })
    .from(productCategory)
    .where(
      and(
        eq(productCategory.operatorId, input.operatorId),
        eq(productCategory.code, PARTY_MENU_CATEGORY_CODE),
        isNull(productCategory.archivedAt),
      ),
    )
    .limit(1);
  if (held) return held.id;
  // After the operator's last top-level tab: on the till it is empty (its
  // items are BEO-only), and an empty tab is not shown there.
  const [last] = await tx
    .select({ sortOrder: productCategory.sortOrder })
    .from(productCategory)
    .where(
      and(
        eq(productCategory.operatorId, input.operatorId),
        isNull(productCategory.parentId),
        isNull(productCategory.archivedAt),
      ),
    )
    .orderBy(desc(productCategory.sortOrder))
    .limit(1);
  const id = newId();
  const row = {
    id,
    operatorId: input.operatorId,
    code: PARTY_MENU_CATEGORY_CODE,
    name: PARTY_MENU_CATEGORY_NAME,
    parentId: null,
    taxableCategory: 'fnb' as const,
    defaultPrepStation: 'kitchen' as const,
    sortOrder: (last?.sortOrder ?? -1) + 1,
  };
  await tx.insert(productCategory).values(row);
  await audit.record(tx, {
    actorAccountId: ctx.actorAccountId ?? null,
    operatorId: input.operatorId,
    branchId: input.branchId,
    action: 'menu_category.create',
    entityType: 'product_category',
    entityId: id,
    after: {
      ...row,
      via: 'otoapp_provision_key',
      reason: 'party_menu_product',
      actorAppUserId: input.actorAppUserId,
    },
    actionId: input.idempotencyKey,
    sourceApp: 'oto_app',
    requestId: ctx.requestId,
  });
  return id;
}

/** The first of the code's lengths no live product of the operator carries. */
async function freeCode(tx: Tx, operatorId: string, productId: string): Promise<string> {
  for (const length of PARTY_MENU_CODE_LENGTHS) {
    const code = partyMenuCode(productId, length);
    const [taken] = await tx
      .select({ id: product.id })
      .from(product)
      .where(and(eq(product.operatorId, operatorId), eq(product.code, code), isNull(product.archivedAt)))
      .limit(1);
    if (!taken) return code;
  }
  throw errors.conflict(
    'PARTY_MENU_CODE_TAKEN',
    'Every code this item could take is already on another product. Press the button again to make it under a new code.',
  );
}

/**
 * The item the BEO asked for, as a BEO-only till product. The same
 * Idempotency-Key with the same body answers the product it made; with a
 * different body it is refused.
 */
export async function createPartyMenuProduct(
  db: Db,
  ctx: OpContext,
  input: PartyMenuProductInput,
): Promise<PartyMenuProductAnswer> {
  const priceProblem = partyMenuPriceProblem(input);
  if (priceProblem) throw errors.badRequest(priceProblem, { field: 'priceSatang' });
  const productId = partyMenuProductId(input.operatorId, input.idempotencyKey);
  const digest = partyMenuRequestDigest(input);
  // Asked before the transaction, so a failed operation's own audit row names them too.
  const actorAccountId = await actorAccountOf(db, input.operatorId, input.actorAppUserId);
  const scope: OpContext = { ...ctx, operatorId: input.operatorId, branchId: input.branchId, actorAccountId };

  return withTx(db, scope, 'party_menu_product.create', async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockOf(input.operatorId)}, 0))`);

    // The key's product, if it made one: the same press again.
    const [had] = await tx.select().from(product).where(eq(product.id, productId)).limit(1);
    if (had) {
      const [created] = await tx
        .select({ after: auditLog.after })
        .from(auditLog)
        .where(eq(auditLog.id, creationAuditId(productId)))
        .limit(1);
      const askedBefore = (created?.after as { requestDigest?: unknown } | null)?.requestDigest;
      if (had.operatorId !== input.operatorId || askedBefore !== digest || !had.code || !had.categoryId) {
        throw errors.conflict('IDEMPOTENCY_MISMATCH', 'Idempotency-Key was already used with a different request');
      }
      return { productId: had.id, code: had.code, categoryId: had.categoryId, replayed: true };
    }

    const [br] = await tx
      .select({ id: branch.id })
      .from(branch)
      .where(and(eq(branch.id, input.branchId), eq(branch.operatorId, input.operatorId), isNull(branch.archivedAt)))
      .limit(1);
    if (!br) throw errors.notFound('Branch not found');

    const categoryId = await partyMenuCategory(tx, input, scope);
    const code = await freeCode(tx, input.operatorId, productId);
    const row = {
      id: productId,
      operatorId: input.operatorId,
      branchId: input.branchId,
      categoryId,
      kind: 'menu' as const,
      code,
      name: input.name,
      priceSatang: input.free ? 0 : input.priceSatang!,
      prepStationOverride: input.station,
      beoOnly: true,
      active: true,
    };
    await tx.insert(product).values(row);
    await audit.record(tx, {
      id: creationAuditId(productId),
      actorAccountId,
      operatorId: input.operatorId,
      branchId: input.branchId,
      action: 'party_menu_product.create',
      entityType: 'product',
      entityId: productId,
      after: {
        ...row,
        free: input.free,
        source: input.source,
        via: 'otoapp_provision_key',
        actorAppUserId: input.actorAppUserId,
        requestDigest: digest,
      },
      actionId: input.idempotencyKey,
      sourceApp: 'oto_app',
      requestId: ctx.requestId,
    });
    return { productId, code, categoryId, replayed: false };
  });
}
