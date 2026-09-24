import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { TaxableCategorySchema, type Permission } from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { PermissionDeniedError } from '../plugins/session';
import { branchReach } from '../services/access-control';
import { opCtx, withTx } from '../services/tx';
import { queueDrawerKick } from '../services/payments/drawer';
import {
  commitSale,
  finaliseSale,
  getSaleDetail,
  listSales,
  quoteSale,
  voidSale,
  type ActorContext,
  type CartInput,
  type CommitSaleInput,
} from '../services/sale';

/**
 * S2-09a (SCRUM-203) — the till's money path: price a cart, then record the
 * sale it becomes.
 *
 * WHAT IS GUARDED BY WHAT, and why the quote is not a read permission:
 * quoting a cart is the act of ringing one up, so it takes `pos:sale:create`
 * — reception's, not an administrator's. `pos:sale:discount` is checked
 * SEPARATELY, on any request carrying a manual discount or a promo code,
 * because "may take money" and "may decide how much less a guest pays" are
 * different questions and the park has no manager-approval step to catch the
 * difference later (R-08). `pos:sale:read` covers the two reads, and
 * `pos:sale:void` the till's cancel of a sale that took no money.
 *
 * THE BODY SHAPE IS THE TILL'S. `apps/pos/src/api/sales.ts` sends the cart
 * either flat or nested under `cart`, with the action id in the body; both are
 * accepted here so the two halves meet. What is NOT accepted from it is
 * authority over the money: the tier, the rate mode, the business date and
 * every ticket price are resolved on this side, and the till's own figures are
 * reconciled against them rather than used.
 */

const ComponentTarget = z.union([
  z.object({ kind: z.literal('kids') }),
  z.object({ kind: z.literal('adults') }),
  z.object({ kind: z.literal('socks') }),
  z.object({ kind: z.literal('addon'), addOnId: z.string().min(1).max(100) }),
]);

const AddOn = z.object({
  /**
   * A `pos.product` id where one exists; otherwise the prototype's own add-on
   * id (`a-locker`), which is why this is not a uuid. See the service.
   */
  id: z.string().min(1).max(100),
  name: z.string().max(160).optional(),
  unitSatang: z.number().int().min(0).max(100_000_000).optional(),
  quantity: z.number().int().min(1).max(99),
  taxCategoryOverride: TaxableCategorySchema.optional(),
  variantBreakdown: z
    .array(
      z.object({
        variantId: z.string().min(1).max(100),
        variantLabel: z.string().max(60),
        quantity: z.number().int().min(0).max(99),
      }),
    )
    .max(20)
    .optional(),
});

const CartLine = z.object({
  /** The till's own cart line id, so the receipt can group its rows again. */
  id: z.string().uuid(),
  packageId: z.string().uuid(),
  /** Display only — the label is frozen from the catalogue row. */
  packageName: z.string().max(160).optional(),
  /** Ignored: the tier is resolved from the member. Accepted so the till's payload validates. */
  tier: z.string().max(40).optional(),
  kids: z.number().int().min(0).max(50),
  adults: z.number().int().min(0).max(50),
  socks: z.number().int().min(0).max(50).default(0),
  addOns: z.array(AddOn).max(20).default([]),
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
  /** What the screen showed. Reconciled against the platform's price, never charged. */
  lineTotalSatang: z.number().int().min(0).optional(),
  stayHours: z.number().int().min(0).max(24).optional(),
  stayDurationLabel: z.string().max(60).optional(),
});

/**
 * S2-09b (SCRUM-204) — an F&B or shop line.
 *
 * WHAT IT MAY SAY: which item, how many, which options were chosen under which
 * question, what staff typed on it, and which size came off the shelf. There is
 * no price field on it and no tax field: the unit price is composed on the
 * platform from `pos.product` and `pos.modifier_option`, and `lineTotalSatang`
 * — like a ticket line's — can only cause a refusal.
 */
const CartItemLine = z.object({
  /** The till's own order-line id, so the receipt can group its rows again. */
  id: z.string().uuid(),
  productId: z.string().uuid(),
  quantity: z.number().int().min(1).max(99),
  /** The prototype's `SelectedModifier[]`: one entry per question answered. */
  modifiers: z
    .array(
      z.object({
        groupId: z.string().uuid(),
        optionIds: z.array(z.string().uuid()).max(20),
      }),
    )
    .max(12)
    .default([]),
  /** "no pickles" — follows the item to the kitchen or the bar, and to the receipt. */
  note: z.string().max(280).optional(),
  variant: z
    .object({
      variantId: z.string().min(1).max(100),
      variantLabel: z.string().min(1).max(60),
    })
    .nullish(),
  /** What the screen showed. Reconciled against the platform's price, never charged. */
  lineTotalSatang: z.number().int().min(0).optional(),
});

const ManualDiscount = z.object({
  id: z.string().uuid(),
  scope: z.enum(['order', 'line']),
  targetLineId: z.string().uuid().optional(),
  targetComponent: ComponentTarget.optional(),
  targetLabel: z.string().max(120).optional(),
  type: z.enum(['percent', 'fixed', 'comp']),
  /** A percentage for `percent`, satang for `fixed`, ignored for `comp`. */
  value: z.number().min(0).max(100_000_000).default(0),
  /** Required: a discount with no reason is what the discounts report exists to stop. */
  reason: z.string().min(1).max(120),
  note: z.string().max(500).optional(),
  /**
   * The till names who applied it; the platform records the SESSION's account
   * instead, because that is the one it authenticated. Accepted so the till's
   * payload validates, and ignored.
   */
  appliedByAccountId: z.string().uuid().optional(),
  appliedByName: z.string().max(160).optional(),
  appliedAt: z.string().max(40).optional(),
});

const Promo = z.object({
  code: z.string().min(1).max(40),
  label: z.string().max(160),
  type: z.enum(['percent', 'fixed', 'free_item']),
  value: z.number().min(0).max(100_000_000),
  freeItemId: z.string().max(100).optional(),
  freeItemKind: z.enum(['menu', 'merch']).optional(),
  target: z.unknown().optional(),
});

/**
 * NOTHING HERE DECIDES A PRICE. The body says what was sold; the platform says
 * what it costs. `expectedTotalSatang` and a line's `lineTotalSatang` are the
 * only numbers a caller may send about money, and the only thing either can do
 * is cause a refusal.
 */
const Cart = z.object({
  branchId: z.string().uuid().optional(),
  stationId: z.string().uuid().optional(),
  /**
   * SCRUM-343 — WHICH LANE OF THE TILL THIS CART WAS RUNG UP ON. The three the
   * POS has: the ticket counter, the F&B station and the shop. Only these three
   * of `SALES_CHANNELS`, because the others are not a cart's to claim — a
   * kiosk's and a booth's channel is their station's kind, and a booking's is
   * written by the booking path.
   *
   * A CLAIM, NOT A FIELD THAT IS BELIEVED: `resolveSalesChannel` checks it
   * against the station's kind and capabilities and refuses a mismatch, so a
   * till that is not set up to sell food cannot file a sale under `fnb`.
   */
  channel: z.enum(['till', 'fnb', 'shop']).optional(),
  memberId: z.string().uuid().nullish(),
  /** Ignored for pricing; reported back when it differs from the platform's. */
  tier: z.string().max(40).optional(),
  /**
   * SCRUM-307 — the action id of a document check reception recorded through
   * `POST /sales/tier-claims`. A POINTER, and the one thing in this body that
   * can move a cart off the default tier: the tier itself is read from that
   * claim row, which names the account that made it and the branch it was made
   * at, so naming another session's claim resolves to nothing.
   */
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
  /**
   * The ticket lines. No longer `.min(1)`: an F&B or shop order has none, and
   * the service refuses a cart carrying neither kind of line.
   */
  lines: z.array(CartLine).max(50).default([]),
  /** S2-09b — the F&B and shop lines. */
  items: z.array(CartItemLine).max(100).default([]),
  /**
   * S2-09b — the pick-up code the till minted for this order. Required before a
   * sale carrying any F&B line can be finalised, and accepted again at the cash
   * step for a sale committed without one.
   */
  pickupCode: z.string().max(12).optional(),
  manualDiscounts: z.array(ManualDiscount).max(20).default([]),
  promos: z.array(Promo).max(10).default([]),
  /** Codes with no definition: refused by name. */
  promoCodes: z.array(z.string().min(1).max(40)).max(10).default([]),
  customerPhone: z.string().max(40).nullish(),
  customerNickname: z.string().max(120).nullish(),
  expectedTotalSatang: z.number().int().min(0).optional(),
});

/** The till sends the cart nested under `cart`; a curl sends it flat. */
const CommitBody = Cart.extend({
  id: z.string().uuid().optional(),
  actionId: z.string().min(1).max(200).optional(),
  cart: Cart.optional(),
  /** The till's clock when Pay was pressed. Believed within the platform's tolerance. */
  occurredAt: z.string().max(40).optional(),
  visitId: z.string().uuid().nullish(),
  /** A tender token. Recording the money itself is S2-10a. */
  paymentMethod: z.string().max(40).nullish(),
  note: z.string().max(500).nullish(),
  finalise: z.boolean().default(false),
}).partial({ lines: true });

/** The till's cash step: what was taken, and what went back in change. */
const Tender = z.object({
  /** The tender token the branch is configured with. Cash today; S2-10a brings the EDC and the QR. */
  method: z.string().max(40).optional(),
  /** Which kind of tender that token is — the till's own classification of it. */
  kind: z.string().max(20).optional(),
  /** Satang this tender settles. Defaults to the whole outstanding balance. */
  amountSatang: z.number().int().min(0).optional(),
  /** What the guest handed over, when staff typed it. */
  tenderedSatang: z.number().int().min(0).optional(),
  /**
   * The change the TILL showed. The platform works its own out from what was
   * handed over, and records both when they differ — the same rule the cart's
   * totals follow: the till's figure is kept as a fact about the till, never
   * used as the answer.
   */
  changeSatang: z.number().int().min(0).optional(),
  reference: z.string().max(120).optional(),
});

/**
 * Sent flat or nested under `tender`; an empty body settles the balance in
 * cash. `nullish`, not `optional`: a POST with no payload at all arrives here
 * as `null`, and the till's cash step is allowed to be exactly that — a press
 * of the button with nothing typed into it.
 */
const FinaliseBody = Tender.extend({
  tender: Tender.optional(),
  actionId: z.string().min(1).max(200).optional(),
  /** S2-09b — the pick-up code, for a food order committed without one. */
  pickupCode: z.string().max(12).optional(),
}).nullish();

export async function saleRoutes(app: App): Promise<void> {
  /**
   * The acting account, carrying the scope check for whichever branch the cart
   * turns out to be for.
   *
   * The route guard cannot make that check: `requirePermission` with an empty
   * target falls back to the SESSION's branch, so a declared permission with
   * no target says yes to a cart written onto any branch at all. The target
   * below catches the flat `branchId`, and this closure catches the rest — a
   * cart nested under `cart`, and a cart naming no branch whose station
   * belongs to another one. The service calls it the moment the branch is
   * settled and before anything is written.
   */
  const actorOf = (req: FastifyRequest, permission: Permission): ActorContext => {
    const auth = req.requireAuth();
    return {
      accountId: auth.accountId,
      operatorId: auth.operatorId,
      branchId: auth.branchId,
      requestId: req.id,
      assertBranchAllowed: async (branchId: string) => {
        await req.requirePermission(permission, { branchId });
      },
    };
  };

  /**
   * Whoever prices or records a cart carrying a discount must be allowed to
   * give one — checked against the branch the cart is for, not only the
   * session's.
   */
  const requireDiscountPermission = async (
    req: FastifyRequest,
    cart: { manualDiscounts?: unknown[]; promos?: unknown[]; promoCodes?: unknown[]; branchId?: string },
    fallbackBranchId: string | null,
  ): Promise<void> => {
    const carries =
      (cart.manualDiscounts?.length ?? 0) > 0 ||
      (cart.promos?.length ?? 0) > 0 ||
      (cart.promoCodes?.length ?? 0) > 0;
    if (!carries) return;
    await req.requirePermission('pos:sale:discount', {
      branchId: cart.branchId ?? fallbackBranchId ?? undefined,
    });
  };

  app.post(
    '/quote',
    {
      config: { permission: 'pos:sale:create', target: { branchId: 'body.branchId' } },
      schema: {
        description:
          'Price a ticket cart with the platform engine — the one answer to what this costs',
        body: Cart,
      },
    },
    async (req) => {
      const actor = actorOf(req, 'pos:sale:create');
      await requireDiscountPermission(req, req.body, actor.branchId);
      return quoteSale(app.db, actor, req.body as CartInput);
    },
  );

  app.post(
    '/',
    {
      config: { permission: 'pos:sale:create', target: { branchId: 'body.branchId' } },
      schema: {
        description:
          'Record a ticket sale. It is written unfinalised and with no receipt number; ' +
          'the tender at /sales/:id/finalise closes it. A ฿0 comp has nothing to tender, ' +
          'so `finalise` may close it here; the ticket and F&B tills leave it open instead ' +
          'and close it at their confirm press, so it can still be voided until then.',
        body: CommitBody,
      },
    },
    async (req, reply) => {
      const actor = actorOf(req, 'pos:sale:create');
      const body = req.body;
      const cart = body.cart ?? (body as unknown as z.infer<typeof Cart>);
      // Either kind of line makes a cart: admission, or food and merchandise —
      // or a voucher's code on its own (S2-10b). A free-item voucher's line is
      // put on the bill by the platform, never sent by the till, so a guest
      // claiming only their Kids Pizza is a cart of no lines and one code.
      // Whether the code is such a voucher is the service's to decide: a cart
      // whose codes add no line is still refused as empty, by `priceCart`.
      if (
        (cart.lines?.length ?? 0) === 0 &&
        (cart.items?.length ?? 0) === 0 &&
        (cart.promoCodes?.length ?? 0) === 0
      ) {
        throw errors.badRequest('The cart is empty');
      }
      const stationId = body.stationId ?? cart.stationId;
      if (!stationId) throw errors.badRequest('A sale has to name the station that rang it up');
      await requireDiscountPermission(req, cart, actor.branchId);

      const headerActionId = req.headers['x-oto-action-id'];
      const input: CommitSaleInput = {
        ...(cart as unknown as CartInput),
        id: body.id,
        stationId,
        visitId: body.visitId ?? null,
        note: body.note ?? undefined,
        occurredAt: body.occurredAt,
        expectedTotalSatang: cart.expectedTotalSatang ?? body.expectedTotalSatang,
        finalise: body.finalise,
        actionId:
          body.actionId ?? (typeof headerActionId === 'string' ? headerActionId : null) ?? null,
      };
      // The sale, its lines, its discounts and the audit row are one
      // operation: a sale whose lines are missing is a receipt nobody can
      // reprint and a figure nobody can explain.
      const result = await withTx(app.db, opCtx(req), 'sale.create', (tx) =>
        commitSale(tx, actor, input),
      );
      if (result.replay) reply.header('x-oto-replay', 'true');
      return result;
    },
  );

  /**
   * THE TILL'S "CONFIRM PAYMENT RECEIVED". Calling it says the money was
   * taken: the tender is recorded and the sale is closed and numbered in one
   * transaction. The branch is not in the URL — it is the sale's own — so the
   * scope check happens when the row is loaded, through `assertBranchAllowed`.
   */
  app.post(
    '/:id/finalise',
    {
      config: { permission: 'pos:sale:update' },
      schema: {
        description:
          'Take the tender and close the sale: record the payment attempt, allocate the ' +
          'receipt number, finalise. An empty body settles the balance in cash. A sale ' +
          'that owes nothing — a ฿0 comp, a voucher’s free item on its own — is closed ' +
          'with no payment recorded, and its voucher is used up here.',
        params: z.object({ id: z.string().uuid() }),
        body: FinaliseBody,
      },
    },
    async (req, reply) => {
      const actor = actorOf(req, 'pos:sale:update');
      const body = req.body ?? {};
      // The till sends the tender both nested and flat; either reading is the
      // same tender, so the nested one wins and the flat one is the fallback.
      const tender = body.tender ?? {
        method: body.method,
        kind: body.kind,
        amountSatang: body.amountSatang,
        tenderedSatang: body.tenderedSatang,
        changeSatang: body.changeSatang,
        reference: body.reference,
      };
      const headerActionId = req.headers['x-oto-action-id'];
      const result = await withTx(app.db, opCtx(req), 'sale.finalise', (tx) =>
        finaliseSale(tx, actor, req.params.id, {
          tender,
          actionId:
            body.actionId ?? (typeof headerActionId === 'string' ? headerActionId : null) ?? null,
          ...(body.pickupCode ? { pickupCode: body.pickupCode } : {}),
        }),
      );
      /**
       * S2-10a (O-4) — THE DRAWER, once the money is committed and not before.
       *
       * Outside the transaction deliberately: the command is the box's own row
       * with its own audit entry, and a drawer asked to open for a sale that
       * then rolled back is a drawer open with nothing in it. It cannot fail
       * this request — `queueDrawerKick` answers null and logs instead — because
       * the money is already taken and the receipt is already numbered.
       *
       * It is handed this request's context for the actor, the branch and the
       * request id, and drops the idempotency claim off it before opening its
       * own transaction (`services/payments/drawer.ts`,
       * `withoutIdempotencyClaim`): the answer stored under the till's key must
       * stay the finalise's, or the retry replays a command instead of a sale.
       */
      const { drawerKick, ...answer } = result;
      if (drawerKick) {
        await queueDrawerKick(app.db, opCtx(req), actor, drawerKick);
      }
      if (result.replay) reply.header('x-oto-replay', 'true');
      return answer;
    },
  );

  /**
   * S2-10b — THE TILL'S CANCEL: void a sale that was rung up and took no money
   * (or only tenders that failed), so it can never be paid and a voucher it
   * held is free again. The rules are `voidSale`'s; like finalise, the branch
   * is the sale's own and is checked on the row once it is loaded.
   */
  app.post(
    '/:id/void',
    {
      config: { permission: 'pos:sale:void' },
      schema: {
        description:
          'Void a sale that was rung up and took no money — the till’s cancel. The sale is ' +
          'closed as void and can never be paid; a voucher it held is released. Refused when ' +
          'money was taken (that is a refund) or a tender is still in progress. Voiding a ' +
          'void sale answers it unchanged.',
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          /** Why — required: a void with no reason is what the voids report exists to stop. */
          reason: z.string().trim().min(1).max(120),
        }),
      },
    },
    async (req, reply) => {
      const actor = actorOf(req, 'pos:sale:void');
      const result = await withTx(app.db, opCtx(req), 'sale.void', (tx) =>
        voidSale(tx, actor, req.params.id, { reason: req.body.reason }),
      );
      if (result.replay) reply.header('x-oto-replay', 'true');
      return result;
    },
  );

  app.get(
    '/',
    {
      /**
       * SCRUM-297 — WHICH BRANCHES THIS ANSWER COVERS.
       *
       * Declared dynamic because the branch is not in the URL: it is the one
       * asked for, or the one the session happens to be sitting at, or — when
       * there is neither — nothing at all. A route-level `permission` with no
       * target is checked against `auth.branchId`, and that is the case this
       * ticket is about: a session with no branch made the guard ask about no
       * branch, and the handler then filtered by operator alone. Today only an
       * operator-wide holder gets that far, so nothing leaked; but the width
       * of the answer was coming from where the session happened to be seated
       * rather than from what the caller holds, and the seat is something the
       * caller sets for themselves (SCRUM-249).
       */
      config: { dynamicPermission: true },
      schema: {
        description: 'Sales for a branch and business-date range',
        querystring: z.object({
          branchId: z.string().uuid().optional(),
          stationId: z.string().uuid().optional(),
          memberId: z.string().uuid().optional(),
          status: z.enum(['tendering', 'paid', 'finalised', 'voided', 'refunded']).optional(),
          /** One trading day — the till's own list. Same thing as from = to. */
          businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const branchId = req.query.branchId ?? auth.branchId ?? undefined;
      let branchIds: string[] | undefined;
      if (branchId) {
        // One branch named: answered explicitly, and refused explicitly when
        // it is not one the caller holds.
        await req.requirePermission('pos:sale:read', { branchId });
      } else {
        const reach = branchReach(
          await req.effectivePermissions(),
          'pos:sale:read',
          auth.operatorId,
        );
        if (reach.kind === 'branches') {
          /**
           * Holding it nowhere is a refusal, not an empty day. A till that
           * showed "no sales" to somebody who may not see them would be the
           * worse of the two answers: one of them is read as the takings.
           */
          if (reach.branchIds.length === 0) throw new PermissionDeniedError('pos:sale:read');
          branchIds = reach.branchIds;
        }
      }
      return listSales(app.db, auth.operatorId, {
        ...req.query,
        branchId,
        branchIds,
        from: req.query.businessDate ?? req.query.from,
        to: req.query.businessDate ?? req.query.to,
      });
    },
  );

  app.get(
    '/:id',
    {
      config: { permission: 'pos:sale:read' },
      schema: {
        description: 'One sale with its lines and discounts — the Sale detail view',
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const detail = await getSaleDetail(app.db, auth.operatorId, req.params.id);
      const view = detail.sale as { branchId: string };
      // A sale at another branch is only readable by somebody scoped to it.
      await req.requirePermission('pos:sale:read', { branchId: view.branchId });
      return detail;
    },
  );
}
