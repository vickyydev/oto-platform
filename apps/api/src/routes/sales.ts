import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { member, sale } from '@oto/db';
import {
  REFUND_MODES,
  SALE_REPRINT_KINDS,
  TaxableCategorySchema,
  normalizePhone,
  type Permission,
} from '@oto/shared';
import type { App } from '../app';
import { AppError, errors } from '../lib/errors';
import { PermissionDeniedError } from '../plugins/session';
import { branchReach } from '../services/access-control';
import { findBandsByCode } from '../services/bands';
import { refundsOfSale } from '../services/refund-slices';
import { refundSale, settleGatewayRefunds, type RefundActor } from '../services/refunds';
import { reprintSale } from '../services/sale-printing';
import { gatewayFor } from '../services/payments/gateway';
import { opCtx, withTx } from '../services/tx';
import { queueDrawerKick, type DrawerKick } from '../services/payments/drawer';
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

/**
 * A park promo code as the till applied it. SCRUM-401 — ONLY `code` IS PRICED:
 * the service reads the code's value, scope, window, branch, stacking rule and
 * usage limits from the park's own definition (`services/promo-codes.ts`) and
 * refuses by name a code it has no live definition for. The rest is what the
 * till computed from its copy of that definition; it is accepted so the till's
 * payload validates, and it moves no money.
 */
const Promo = z
  .object({
    code: z.string().min(1).max(40),
    label: z.string().max(160),
    type: z.enum(['percent', 'fixed', 'free_item']),
    value: z.number().min(0).max(100_000_000),
    freeItemId: z.string().max(100).optional(),
    freeItemKind: z.enum(['menu', 'merch']).optional(),
    target: z.unknown().optional(),
  })
  .describe(
    "A promo code as the till applied it. Only the code is priced, from the park's own " +
      'definition; the type, value and target beside it are the till’s and move no money.',
  );

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
   * The ticket lines. No longer `.min(1)`: an F&B or shop order has none. A
   * cart carrying neither kind of line is refused by the service (`priceCart`)
   * unless a voucher's code on it gives it one — a free item's line, which the
   * platform puts on the bill — or it is a held hand-over prize's code alone,
   * a ฿0 sale of its own (S2-10b).
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
  /**
   * The sale's id, minted by the till (UUIDv7) with every line's (SCRUM-270,
   * OD-12). The same id with the same line ids is a replay, answered with the
   * sale under `x-oto-replay`; the same id with other line ids is refused
   * `409 SALE_LINES_DIFFER` (`commitSale`).
   */
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

/**
 * S2-11 — a refund, as History's Refund dialog sends it (`RefundModal.tsx`).
 * `lineIds` for a by-item refund, `amountSatang` for a custom one; a whole
 * refund names neither. What it may NOT name is where the money goes: that is
 * the platform's allocation, wallet → same tender → cash.
 */
const RefundBody = z
  .object({
    mode: z.enum(REFUND_MODES),
    lineIds: z.array(z.string().uuid()).min(1).max(200).optional(),
    amountSatang: z.number().int().min(1).max(10_000_000_000).optional(),
    /** Required, as a void's is. */
    reason: z.string().trim().min(1).max(120),
    note: z.string().max(500).nullish(),
    actionId: z.string().min(1).max(200).optional(),
  })
  .refine((b) => b.mode !== 'items' || (b.lineIds?.length ?? 0) > 0, {
    message: 'A by-item refund names the lines it covers',
    path: ['lineIds'],
  })
  .refine((b) => b.mode !== 'custom' || b.amountSatang !== undefined, {
    message: 'A custom refund names its amount',
    path: ['amountSatang'],
  });

const ReprintBody = z.object({
  /** `TransactionDetail.tsx:171-197`: the receipt, a band group, the pick-up ticket, a shop receipt. */
  kind: z.enum(SALE_REPRINT_KINDS),
  /** Where to print it. Defaults to the station this session is at, then the sale's own. */
  stationId: z.string().uuid().optional(),
  reason: z.string().trim().max(200).optional(),
  actionId: z.string().min(1).max(200).optional(),
});

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
      config: { permission: 'pos:sale:create', target: { branchId: 'body.branchId' }, stationTrading: true },
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
      config: { permission: 'pos:sale:create', target: { branchId: 'body.branchId' }, stationTrading: true },
      schema: {
        description:
          'Record a ticket sale. It is written unfinalised and with no receipt number; ' +
          'the tender at /sales/:id/finalise closes it. A ฿0 comp has nothing to tender, ' +
          'so `finalise` may close it here; the ticket and F&B tills leave it open instead ' +
          'and close it at their confirm press, so it can still be voided until then. ' +
          'The till names the sale and every line: the same sale id with the same line ids ' +
          'answers with the recorded sale under x-oto-replay, and with other line ids is ' +
          'refused 409 SALE_LINES_DIFFER.',
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
      // What the code is, is the service's to decide: `priceCart` refuses a cart
      // whose codes add no line as empty, unless its one code is a held
      // hand-over prize, which is a ฿0 sale of its own (C2).
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
      config: { permission: 'pos:sale:update', stationTrading: true },
      schema: {
        description:
          'Take the tender and close the sale: record the payment attempt, allocate the ' +
          'receipt number, finalise. An empty body settles the balance in cash. A sale ' +
          'that owes nothing — a ฿0 comp, a voucher’s free item on its own — is closed ' +
          'with no payment recorded, and its voucher is used up here. The call that closes the ' +
          'sale also queues its paper (S2-11): `printing` carries the print jobs — a receipt; a ' +
          'kids band per child and an adult band per adult, each with its signed code; an item ' +
          'voucher per add-on; a prep ticket per kitchen or bar station — the bands issued, and ' +
          'the "not printed" notes for a station with no printer for a role. Printing never ' +
          'fails the sale.',
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
      let drawerKick: DrawerKick | null = null;
      const answer = await withTx(app.db, opCtx(req), 'sale.finalise', async (tx) => {
        const result = await finaliseSale(tx, actor, req.params.id, {
          tender,
          actionId:
            body.actionId ?? (typeof headerActionId === 'string' ? headerActionId : null) ?? null,
          ...(body.pickupCode ? { pickupCode: body.pickupCode } : {}),
        });
        const { drawerKick: kick, ...response } = result;
        drawerKick = kick;
        return response;
      });
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
      if (drawerKick) {
        await queueDrawerKick(app.db, opCtx(req), actor, drawerKick);
      }
      if (answer.replay) reply.header('x-oto-replay', 'true');
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
      config: { permission: 'pos:sale:void', stationTrading: true },
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

  /**
   * S2-11 — History's search box, for the two things a guest hands over at the
   * desk: a band, and a phone. A band is found by its full signed code (what a
   * scanner reads off the QR) or by its short code (`T1-7KMQ4X`, printed under
   * the QR and on the receipt); a phone is normalised the way every phone in
   * the platform is and finds every sale of the member(s) holding it. Scoped
   * exactly as the list is: one branch named and checked, or the branches the
   * caller's grants reach.
   */
  app.get(
    '/lookup',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Find sales by a band code or short code (`band`) or by a member phone in any format (`phone`) — one of the two. Answers the list shape of `GET /sales`, plus what matched. Branch-scoped as the list is.',
        querystring: z
          .object({
            band: z.string().trim().min(1).max(80).optional(),
            phone: z.string().trim().min(1).max(40).optional(),
            branchId: z.string().uuid().optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
          })
          .refine((q) => Boolean(q.band) !== Boolean(q.phone), {
            message: 'Search by a band or by a phone — one of the two',
          }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const branchId = req.query.branchId ?? auth.branchId ?? undefined;
      let branchIds: string[] | undefined;
      if (branchId) {
        await req.requirePermission('pos:sale:read', { branchId });
      } else {
        const reach = branchReach(await req.effectivePermissions(), 'pos:sale:read', auth.operatorId);
        if (reach.kind === 'branches') {
          if (reach.branchIds.length === 0) throw new PermissionDeniedError('pos:sale:read');
          branchIds = reach.branchIds;
        }
      }
      const scope = { branchId, branchIds, limit: req.query.limit, offset: 0 };
      if (req.query.band) {
        const bands = await findBandsByCode(app.db, auth.operatorId, req.query.band);
        const found = await listSales(app.db, auth.operatorId, {
          ...scope,
          saleIds: [...new Set(bands.map((b) => b.saleId))],
        });
        return {
          match: { by: 'band' as const, bandIds: bands.map((b) => b.id) },
          ...found,
        };
      }
      const phone = normalizePhone(req.query.phone ?? '');
      if (!phone) {
        throw new AppError(400, 'PHONE_INVALID', 'That is not a phone number this platform can read');
      }
      const members = await app.db
        .select({ id: member.id })
        .from(member)
        .where(and(eq(member.operatorId, auth.operatorId), eq(member.phone, phone)));
      const found = await listSales(app.db, auth.operatorId, {
        ...scope,
        memberIds: members.map((m) => m.id),
      });
      return { match: { by: 'phone' as const, phone, memberIds: members.map((m) => m.id) }, ...found };
    },
  );

  /**
   * S2-11 — REFUND A FINALISED SALE (`mockApi.ts:recordRefund`, with the plan's
   * manager approval). Reception may open the dialog — the route takes
   * `pos:refund:create` — and is refused `REFUND_APPROVAL_REQUIRED` at the
   * press unless the account also holds `pos:refund:approve` at the sale's
   * branch. Online only: a station forced offline is refused before the key is
   * claimed, and the till queues a "refund requested" note instead.
   */
  app.post(
    '/:id/refunds',
    {
      config: { permission: 'pos:refund:create', stationTrading: true },
      schema: {
        description:
          'Refund a finalised sale: the whole of what is left, chosen lines, or a custom amount, clamped to what is left, with a reason. Needs `pos:refund:approve` at the sale’s branch (403 `REFUND_APPROVAL_REQUIRED` without it). Numbered from the station’s refund series. The money goes back wallet → same tender → cash: a whole card tender is voided on its terminal (the answer arrives from the box; a refusal falls back to cash), a gateway QR is refunded through the gateway after the refund commits, cash is handed back. The sale walks paid → partially_refunded → refunded. Replaying the same `actionId` answers the refund it recorded.',
        params: z.object({ id: z.string().uuid() }),
        body: RefundBody,
      },
    },
    async (req, reply) => {
      const auth = req.requireAuth();
      const headerActionId = req.headers['x-oto-action-id'];
      const actor: RefundActor = {
        accountId: auth.accountId,
        operatorId: auth.operatorId,
        stationId: auth.stationId,
        requestId: req.id,
        assertBranchAllowed: async (branchId) => {
          await req.requirePermission('pos:refund:create', { branchId });
        },
        assertCanApprove: async (branchId) => {
          try {
            await req.requirePermission('pos:refund:approve', { branchId });
          } catch (err) {
            if (err instanceof PermissionDeniedError) {
              throw new AppError(
                403,
                'REFUND_APPROVAL_REQUIRED',
                'A refund needs a manager’s approval — ask a manager to make it',
              );
            }
            throw err;
          }
        },
      };
      const result = await withTx(app.db, opCtx(req), 'sale.refund', (tx) =>
        refundSale(tx, actor, req.params.id, {
          mode: req.body.mode,
          lineIds: req.body.lineIds,
          amountSatang: req.body.amountSatang,
          reason: req.body.reason,
          note: req.body.note ?? null,
          actionId:
            req.body.actionId ?? (typeof headerActionId === 'string' ? headerActionId : null) ?? null,
        }),
      );
      if (result.replay) reply.header('x-oto-replay', 'true');
      const gatewayPending = result.refund.tenderAllocation.some(
        (slice) => slice.route === 'gateway_refund' && slice.status === 'pending',
      );
      if (!gatewayPending) return result;
      // After the commit: a call to the gateway's server must not hold the
      // sale's row lock. The answer then carries the slice as it ended.
      await settleGatewayRefunds(app.db, opCtx(req), result.refund.id, gatewayFor(app.env, req.log).qr);
      const refreshed = (await refundsOfSale(app.db, req.params.id)).find((r) => r.id === result.refund.id);
      return refreshed ? { ...result, refund: refreshed } : result;
    },
  );

  /**
   * S2-11 — HISTORY'S REPRINT (`TransactionDetail.tsx:171-212`,
   * `mockApi.ts:recordReprint`). A new print job per printout, `reprint_of`
   * naming the original, an audit row each; a band reprint keeps the band and
   * its code and marks the paper it replaces.
   */
  app.post(
    '/:id/reprints',
    {
      config: { permission: 'pos:print:reprint', stationTrading: true },
      schema: {
        description:
          'Print a finalised sale’s paper again: `receipt` (or `merch_receipt`), `kids_bands`, `adult_bands`, or `prep` (the F&B pick-up tickets). Each copy is a new print job whose `reprintOf` names the original, with an audit row. A band keeps its id and code; its old print is marked replaced by a `reprinted` band event. Prints at the station this session is at unless `stationId` names another at the same park.',
        params: z.object({ id: z.string().uuid() }),
        body: ReprintBody,
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const [found] = await app.db.select().from(sale).where(eq(sale.id, req.params.id)).limit(1);
      if (!found || found.operatorId !== auth.operatorId) throw errors.notFound('Sale not found');
      await req.requirePermission('pos:print:reprint', { branchId: found.branchId });
      const headerActionId = req.headers['x-oto-action-id'];
      const actionId =
        req.body.actionId ?? (typeof headerActionId === 'string' ? headerActionId : null) ?? req.id;
      return withTx(app.db, opCtx(req), 'sale.reprint', async (tx) => {
        const [row] = await tx.select().from(sale).where(eq(sale.id, found.id)).limit(1);
        if (!row) throw errors.notFound('Sale not found');
        return reprintSale(
          tx,
          { accountId: auth.accountId, operatorId: auth.operatorId, requestId: req.id, stationId: auth.stationId },
          row,
          { kind: req.body.kind, stationId: req.body.stationId ?? null, reason: req.body.reason ?? null, actionId },
        );
      });
    },
  );

  app.get(
    '/:id',
    {
      config: { permission: 'pos:sale:read' },
      schema: {
        description:
          'One sale with its lines, discounts and payment attempts — the Sale detail view — and, since S2-11, its refunds (`refunds`, `refundStatus`, `refundableSatang`), its print jobs with reprints marked by `reprintOf` (`printJobs`) and its bands by short code (`bands`).',
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
