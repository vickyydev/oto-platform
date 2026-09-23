import { and, eq } from 'drizzle-orm';
import { device, paymentAttempt, sale } from '@oto/db';
import {
  PAYMENT_METHOD_KINDS,
  PAYMENT_PROVIDERS,
  TaxableCategorySchema,
  type PaymentAttemptStatus,
} from '@oto/shared';
import { z } from 'zod';
import { errors } from '../../lib/errors';
import { audit } from '../audit';
import { commitSale, finaliseSale, type ActorContext, type CommitSaleInput } from '../sale';
import {
  findAttemptByAction,
  openAttempt,
  outstandingAfter,
  settleAttempt,
  tenderMethodOf,
} from './attempt';
import type { Tx } from '../tx';

/**
 * A SALE TAKEN WITH NO INTERNET, REPLAYED INTO THE LEDGER (S2-10a, Slice G).
 *
 * The box is the system of action and the mall's link is the unreliable part.
 * A counter that stops selling when the internet goes is the failure this whole
 * sprint exists to prevent — so the till takes the money, the box writes the
 * fact on its own disk, and this file is what happens when the link comes back.
 *
 * WHY IT IS HERE AND NOT IN `sale.ts`. Everything below goes through
 * `commitSale`, `finaliseSale` and the attempt service exactly as the counter's
 * own "Confirm Payment Received" does. That is deliberate and it is the whole
 * design: a replayed sale is priced by the same engine, numbered by the same
 * allocator and audited by the same helper as a sale rung up online, so there
 * is one ledger with one set of rules rather than a second, weaker path that
 * only runs on the days the internet was bad.
 *
 * THE FOUR RULES THIS PATH ADDS, each of which is a way money goes missing:
 *
 *  1. **The price is the platform's, not the box's.** The cart travels, not the
 *     totals. `expectedTotalSatang` is REQUIRED, it is compared, and a
 *     disagreement REFUSES the event — it lands in quarantine where a person
 *     can see it — rather than recording a sale at a price nobody quoted. A
 *     box's catalogue can be a week old; its arithmetic cannot be allowed to
 *     become the ledger's. Required rather than optional because an optional
 *     guard is not a guard: a box that simply omitted the field would have had
 *     its cart priced here and banked at whatever this engine said, with the
 *     money the box actually took never compared to it.
 *
 *     THE SECOND HALF OF THE SAME RULE is `recordTenders`: no tender may take
 *     the money on a sale past its gross. The comparison above catches a box
 *     that priced the CART differently; this catches a box that priced it the
 *     same and then sent more money than the cart is worth, which is the other
 *     way a replay banks a number nobody quoted.
 *  2. **The press is the key, not the event.** Every tender carries the
 *     `x-oto-action-id` minted where somebody pressed the button, and
 *     `payment_attempt_action_unique` is what makes the second arrival of the
 *     same press a no-op. The sync ledger's own `(box, epoch, box_seq)` index
 *     catches a re-send of the same EVENT; it does nothing about the same money
 *     arriving under a new event id, which is what a box that lost its
 *     acknowledgements and re-queued from its own records produces.
 *  3. **The receipt number is allocated here, inside the finalise
 *     transaction.** The box shows the guest a number minted from the
 *     high-water mark the cache bundle ships (`sync.ts`, the `receipt_series`
 *     scope), which is provisional: if the series moved on while the box was
 *     away, the number this path allocates is the next one after the mark and
 *     never a duplicate. Where the two differ, the audit row and a
 *     `late_arrival` anomaly carry both, because somebody holding the first is
 *     going to ask.
 *  4. **A late fact never edits a finalised sale.** `pos.sale_freeze` enforces
 *     it and this path is shaped for it: the box's own columns — `origin`,
 *     `box_seq`, `source_event_id` — are stamped while the sale is still
 *     `tendering`, and everything that arrives after the close lives on the
 *     attempt row.
 */

// --- What the box sends -----------------------------------------------------

/**
 * The cart, as the till had it when the money was taken.
 *
 * Deliberately a narrower copy of the one `routes/sales.ts` validates rather
 * than an import of it: the route's schema is the HTTP contract with a till
 * that can be updated in a browser refresh, and this is the wire contract with
 * a box that may be running last month's build. They are allowed to move at
 * different speeds, and every other handler in the sync path declares its own
 * payload beside itself for the same reason. Nothing here carries a price that
 * is charged — a line's `lineTotalSatang` can only cause a refusal.
 */
const OfflineCartSchema = z.object({
  memberId: z.string().uuid().nullish(),
  visitId: z.string().uuid().nullish(),
  channel: z.enum(['till', 'fnb', 'shop']).optional(),
  tier: z.string().max(40).optional(),
  tierClaimActionId: z.string().min(1).max(200).optional(),
  pricingMode: z.enum(['weekday', 'weekend']).optional(),
  socks: z
    .object({
      addOnId: z.string().min(1).max(100),
      unitSatang: z.number().int().min(0).optional(),
      label: z.string().max(60).optional(),
    })
    .optional(),
  lines: z
    .array(
      z.object({
        id: z.string().uuid(),
        packageId: z.string().uuid(),
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
              taxCategoryOverride: TaxableCategorySchema.optional(),
            }),
          )
          .max(20)
          .default([]),
        serviceFee: z
          .object({ label: z.string().max(120), amountSatang: z.number().int().min(0) })
          .nullish(),
        lineTotalSatang: z.number().int().min(0).optional(),
      }),
    )
    .max(50)
    .default([]),
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        productId: z.string().uuid(),
        quantity: z.number().int().min(1).max(99),
        modifiers: z
          .array(
            z.object({
              groupId: z.string().uuid(),
              optionIds: z.array(z.string().uuid()).max(20),
            }),
          )
          .max(12)
          .default([]),
        note: z.string().max(280).optional(),
        variant: z
          .object({ variantId: z.string().min(1).max(100), variantLabel: z.string().min(1).max(60) })
          .nullish(),
        lineTotalSatang: z.number().int().min(0).optional(),
      }),
    )
    .max(100)
    .default([]),
  pickupCode: z.string().max(12).optional(),
  manualDiscounts: z
    .array(
      z.object({
        id: z.string().uuid(),
        scope: z.enum(['order', 'line']),
        targetLineId: z.string().uuid().optional(),
        targetLabel: z.string().max(120).optional(),
        type: z.enum(['percent', 'fixed', 'comp']),
        value: z.number().min(0).max(100_000_000).default(0),
        reason: z.string().min(1).max(120),
        note: z.string().max(500).optional(),
      }),
    )
    .max(20)
    .default([]),
  promos: z
    .array(
      z.object({
        code: z.string().min(1).max(40),
        label: z.string().max(160),
        type: z.enum(['percent', 'fixed', 'free_item']),
        value: z.number().min(0).max(100_000_000),
        freeItemId: z.string().max(100).optional(),
        freeItemKind: z.enum(['menu', 'merch']).optional(),
      }),
    )
    .max(10)
    .default([]),
  note: z.string().max(500).nullish(),
  /**
   * What the till showed the guest. Compared; a disagreement refuses the event.
   *
   * NOT OPTIONAL. Every other field here describes what was sold; this one is
   * the only thing that says what the till believed it was charging for it, and
   * it is the whole of rule 1 at the top. A cart that arrives without it is
   * refused by this schema — `SYNC_PAYLOAD_INVALID`, quarantined with its
   * payload intact — which is a box somebody has to fix, and is strictly better
   * than a sale banked at a price only one end ever computed.
   *
   * `min(0)` rather than `positive()` so that a cart the till priced at nothing
   * gets the NAMED refusal in `replayOfflineSale` rather than a schema
   * complaint: it is a real thing a till can do and it deserves a real answer.
   */
  expectedTotalSatang: z.number().int().min(0),
});

/**
 * ONE TENDER, AS THE BOX TOOK IT.
 *
 * Cash is the ordinary case and carries what was handed over. A card tender
 * carries what the terminal on the counter said — the approval code, the last
 * four digits, the TID and the references — because offline that exchange
 * happened entirely between the box and a machine on a serial cable, and this
 * is the only time the cloud will ever hear about it.
 *
 * NO PAN, EVER, and no track data: the parser on the box reduces a masked PAN
 * to four digits and drops the cardholder name before the result leaves the
 * adapter (`packages/box-agent/src/terminal/`). A payload that carried one
 * would be refused by `last4`'s own shape, which is the cheapest possible
 * second net.
 */
const OfflineTenderSchema = z.object({
  /** `x-oto-action-id` — the press. THE replay key; see rule 2 at the top. */
  actionId: z.string().min(1).max(200),
  /** The park's own token for the tender: `cash`, `promptpay`, an acquirer's name. */
  methodCode: z.string().min(1).max(40),
  /** The till's classification, for a token this cloud has no row for. */
  kind: z.enum(PAYMENT_METHOD_KINDS).optional(),
  provider: z.enum(PAYMENT_PROVIDERS).optional(),
  amountSatang: z.number().int().positive().max(100_000_000),
  tenderedSatang: z.number().int().min(0).max(100_000_000).optional(),
  changeSatang: z.number().int().min(0).max(100_000_000).optional(),
  /**
   * `approved` for money that is ours, `awaiting_settlement` for money taken on
   * the terminal's OWN connection — a PAX QR, which the acquirer settles
   * without the platform ever seeing a gateway notification. Both count towards
   * the balance (`PAYMENT_ATTEMPT_TAKEN_STATUSES`); what is unsettled about the
   * second is the reconciliation, not the payment.
   */
  status: z.enum(['approved', 'awaiting_settlement']).default('approved'),
  /** The terminal that answered, as a `core.device`. Absent for cash. */
  deviceId: z.string().uuid().nullish(),
  terminalRef: z.string().max(32).nullish(),
  tranRef: z.string().max(64).nullish(),
  invoiceNo: z.string().max(20).nullish(),
  approvalCode: z.string().max(12).nullish(),
  /** Four digits at most, because that is all a box is allowed to keep. */
  last4: z
    .string()
    .regex(/^\d{1,4}$/)
    .nullish(),
  tid: z.string().max(20).nullish(),
  mid: z.string().max(20).nullish(),
  /** The vendor's response code, kept so a reconciliation can read the slip. */
  responseCode: z.string().max(8).nullish(),
  /** When the money became ours, by the box's clock. */
  paidAt: z.string().datetime().optional(),
  /** A slip number or the guest's reference, where staff typed one. */
  reference: z.string().max(64).nullish(),
});

export type OfflineTender = z.infer<typeof OfflineTenderSchema>;

/**
 * `sale.finalised` — a whole sale, with the money that closed it.
 *
 * ONE EVENT, not a sale event and a payment event, and that is the important
 * choice in this file. The cart and the tenders land in one savepoint or
 * neither lands: a box that could put a sale in the ledger and leave its money
 * behind — or the reverse — would produce exactly the two rows nobody can
 * reconcile afterwards. `payment.recorded` below exists for the money that
 * genuinely comes later.
 */
export const OfflineSalePayloadSchema = z.object({
  /** Minted at the till. Re-sending it finds the sale that exists. */
  saleId: z.string().uuid(),
  cart: OfflineCartSchema,
  tenders: z.array(OfflineTenderSchema).min(1).max(6),
  /**
   * The number the box showed at the counter, from the cached high-water mark.
   * Provisional: this path allocates the real one. See rule 3 at the top.
   */
  receipt: z
    .object({
      series: z.string().min(1).max(12),
      seq: z.number().int().min(1),
      number: z.string().min(1).max(40),
    })
    .nullish(),
  /** The offline staff token the box verified, by its `jti`, where it used one. */
  staffTokenJti: z.string().uuid().nullish(),
});

export type OfflineSalePayload = z.infer<typeof OfflineSalePayloadSchema>;

/**
 * `payment.recorded` — money against a sale that is already a fact.
 *
 * The second half of a split tender taken after the first was pushed, a card
 * approval the terminal gave up minutes later, a PAX QR the guest paid while
 * the sale sat open. It requires its sale: see `replayOfflineTender`.
 */
export const OfflinePaymentPayloadSchema = z.object({
  saleId: z.string().uuid(),
  tender: OfflineTenderSchema,
});

export type OfflinePaymentPayload = z.infer<typeof OfflinePaymentPayloadSchema>;

// --- What the handler hands over --------------------------------------------

/** Everything about the event that the ledger takes from the CREDENTIAL, never the payload. */
export interface ReplayScope {
  operatorId: string;
  branchId: string;
  boxId: string;
  /** From the envelope, already checked to be a station of this box. */
  stationId: string;
  /** Who took the money. A sale with no account is refused before this. */
  actorAccountId: string;
  /** The instant the sync path decided this fact happened at. */
  occurredAt: Date;
  boxSeq: number;
  eventId: string;
  actionId: string | null;
}

export interface ReplayOutcome {
  saleId: string;
  /** True when this call closed the sale and numbered it. */
  finalised: boolean;
  receiptNumber: string | null;
  outstandingSatang: number;
  /** Attempts this call wrote. A replay writes none and says so. */
  recorded: number;
  /** The box showed one number and the ledger issued another. Both are named. */
  receiptDiffers: { box: string; ledger: string } | null;
}

/** The scope check a route makes on the branch, made here from the credential. */
function actorFor(scope: ReplayScope): ActorContext {
  return {
    accountId: scope.actorAccountId,
    operatorId: scope.operatorId,
    branchId: scope.branchId,
    async assertBranchAllowed(branchId) {
      // A box writes into its own branch or it writes nothing. The station was
      // already checked against this box; this catches a cart that names
      // another branch outright.
      if (branchId !== scope.branchId) {
        throw errors.conflict(
          'SYNC_BRANCH_NOT_OURS',
          'That sale is for another branch than the box that sent it',
          { branchId, boxBranchId: scope.branchId },
        );
      }
    },
  };
}

// --- The two replays --------------------------------------------------------

/**
 * A whole offline sale: price it, record its money, close it, number it.
 *
 * Every step is idempotent on its own key, because this function is going to
 * run more than once for some of these sales and a second charge at a counter
 * is not recoverable by anything a person can do afterwards:
 *
 *   the sale     on the till-minted `sale.id` (`commitSale` returns the row);
 *   each tender  on its press (`payment_attempt_action_unique`);
 *   the close    on `status = 'finalised'` (`finaliseSale` returns the sale).
 */
export async function replayOfflineSale(
  tx: Tx,
  scope: ReplayScope,
  payload: OfflineSalePayload,
): Promise<ReplayOutcome> {
  const actor = actorFor(scope);
  const cart = payload.cart;

  /**
   * A CART THE TILL ITSELF PRICED AT NOTHING, refused before anything is
   * written.
   *
   * A fully comped sale is a real thing at a counter, and it cannot be
   * expressed as an offline event at all: `tenders` requires at least one
   * tender and every tender is a positive amount (the two schemas above), so a
   * ฿0 cart arrives here carrying money it says it does not owe. Rather than
   * commit a sale and then refuse its own tenders on the gross cap below —
   * which is the same outcome reached expensively, through a write that is
   * rolled back and a refusal naming the tender rather than the cart — it is
   * named here, where it is true.
   *
   * WHAT F NEEDS TO KNOW: a fully comped sale taken offline is not expressible
   * yet. Until the event can carry a sale with no tenders, a ฿0 cart must be
   * held on the till until the link is back, and this refusal is what says so
   * rather than quarantining it under a code about money.
   */
  if (cart.expectedTotalSatang === 0) {
    throw errors.conflict(
      'SALE_NOTHING_TO_PAY',
      'The till priced this cart at nothing, so there is no offline sale to bank — a fully comped sale cannot be taken with the link down',
      { saleId: payload.saleId },
    );
  }

  const input: CommitSaleInput = {
    id: payload.saleId,
    stationId: scope.stationId,
    branchId: scope.branchId,
    memberId: cart.memberId ?? null,
    visitId: cart.visitId ?? null,
    ...(cart.channel ? { channel: cart.channel } : {}),
    ...(cart.tier ? { tier: cart.tier } : {}),
    ...(cart.tierClaimActionId ? { tierClaimActionId: cart.tierClaimActionId } : {}),
    ...(cart.pricingMode ? { pricingMode: cart.pricingMode } : {}),
    ...(cart.socks ? { socks: cart.socks } : {}),
    lines: cart.lines,
    items: cart.items,
    ...(cart.pickupCode ? { pickupCode: cart.pickupCode } : {}),
    manualDiscounts: cart.manualDiscounts,
    promos: cart.promos,
    note: cart.note ?? undefined,
    actionId: scope.actionId,
    /**
     * The instant the sync path settled on, passed as BOTH the till's clock and
     * the platform's. `commitSale` compares the two and calls a minute's
     * disagreement skew — which every offline sale would trip, and the trading
     * day would then be the day the link came back rather than the day the
     * money was taken. The clock question has already been decided upstream,
     * where the box's own reported offset is available; re-deciding it here
     * from the api's wall clock would be answering it with the wrong evidence.
     */
    occurredAt: scope.occurredAt.toISOString(),
    /** Always, never conditionally: see rule 1 at the top of this file. */
    expectedTotalSatang: cart.expectedTotalSatang,
  };

  const committed = await commitSale(tx, actor, input, scope.occurredAt);

  /**
   * THE THREE COLUMNS ONLY A BOX SALE HAS, written while the sale is still
   * open.
   *
   * `commitSale` stamps `origin: 'cloud'` because it is the api's own writer
   * and has no way to know better; the columns for a box's are on the table and
   * nothing had ever filled them. They are written HERE rather than there
   * because this is the only caller that knows the answer — and BEFORE the
   * close, because `pos.sale_freeze` lets a finalised sale be rewritten in
   * seven columns and none of these is one of them.
   *
   * Skipped on a replay of a sale that is already closed, for the same reason.
   */
  if (!committed.replay) {
    await tx
      .update(sale)
      .set({
        origin: 'box',
        boxId: scope.boxId,
        boxSeq: scope.boxSeq,
        sourceEventId: scope.eventId,
        ...(payload.staffTokenJti ? { staffTokenJti: payload.staffTokenJti } : {}),
      })
      .where(eq(sale.id, payload.saleId));
  }

  const recorded = await recordTenders(tx, scope, payload.saleId, payload.tenders);
  return close(tx, scope, payload.saleId, recorded, payload.receipt ?? null, {
    committed: !committed.replay,
  });
}

/**
 * Money against a sale the cloud already holds.
 *
 * THE ORDERING GUARD, and what each half of it is actually worth — because the
 * two halves are not worth the same, and the difference is the thing to know
 * before anybody "simplifies" this.
 *
 *  - **The sale must exist.** A batch can arrive out of order — a re-send, a
 *    replay from the Console's Failures tab, a box whose queue was rebuilt —
 *    and then the money reaches the cloud before the sale it paid for.
 *    `pos.payment_attempt.sale_id` carries a foreign key, so an attempt naming
 *    a sale that is nowhere would be refused with or without this read. What
 *    this read adds is the RIGHT refusal: `apply_failed` with a name a person
 *    can act on, rather than a raw constraint error, and `apply_failed` rather
 *    than `poison` because the payload is perfectly well formed and the event
 *    it is waiting for may be in the next batch — so a replay fixes it, exactly
 *    as `visit.created` does for a child that has not arrived yet.
 *  - **The sale must be OURS.** This half is not a diagnosis, it is the ledger.
 *    A foreign key does not carry tenancy: a sale id belonging to another
 *    operator exists, and without this check one park's box would settle
 *    another park's sale and spend a receipt number on their station. The id
 *    arrives in a payload and the credential is the only thing that says whose
 *    money this is.
 */
export async function replayOfflineTender(
  tx: Tx,
  scope: ReplayScope,
  payload: OfflinePaymentPayload,
): Promise<ReplayOutcome> {
  const [row] = await tx.select().from(sale).where(eq(sale.id, payload.saleId)).for('update').limit(1);
  if (!row) {
    throw errors.conflict(
      'SYNC_SALE_ABSENT',
      'That sale is not here yet, so there is nothing for this money to pay for',
      { saleId: payload.saleId },
    );
  }
  if (row.operatorId !== scope.operatorId || row.branchId !== scope.branchId) {
    throw errors.conflict('SYNC_SALE_NOT_OURS', 'That sale belongs to another park', {
      saleId: payload.saleId,
    });
  }
  if (row.status === 'voided' || row.status === 'refunded') {
    throw errors.conflict('SALE_CLOSED', `This sale is ${row.status} and cannot take a tender`, {
      saleId: payload.saleId,
    });
  }

  const recorded = await recordTenders(tx, scope, payload.saleId, [payload.tender]);
  return close(tx, scope, payload.saleId, recorded, null, { committed: false });
}

// --- The shared halves ------------------------------------------------------

interface Recorded {
  written: number;
  /** What was actually taken, for the audit row. */
  tenders: { method: string; amountSatang: number; status: PaymentAttemptStatus }[];
}

/**
 * Write each tender through the one writer of `pos.payment_attempt`, once.
 *
 * `findAttemptByAction` before the insert is what turns a second delivery of
 * the same press into an ordinary answer instead of a unique violation at the
 * bottom of a batch — the index is still the net underneath, and it is what
 * catches the race this read cannot see.
 *
 * THE CEILING: no tender may take the money on this sale past its gross, which
 * is the same line the counter's own path holds ("That tender is more than this
 * sale still owes", `sale.ts`). It is here because this path does not go
 * through that one — it opens and settles attempts directly — and without it
 * the only limit on what a box could bank against a sale was what it chose to
 * send. A box on last week's catalogue that agrees with this engine about the
 * CART and then sends more money than the cart costs would otherwise leave a
 * finalised sale carrying approved attempts over its gross, with nothing
 * quarantined and nothing to reconcile it against.
 *
 * Refused whole, not trimmed: the refusal throws inside the event's savepoint,
 * so the sale, its columns and every tender before this one roll back together
 * and the event lands on Failures with its payload intact. A partial write
 * would be the ledger deciding which half of somebody's money was real.
 */
async function recordTenders(
  tx: Tx,
  scope: ReplayScope,
  saleId: string,
  tenders: readonly OfflineTender[],
): Promise<Recorded> {
  const [row] = await tx.select().from(sale).where(eq(sale.id, saleId)).limit(1);
  if (!row) throw new Error('the sale was not written');

  /**
   * What this sale can still take, counted down as the loop writes.
   *
   * Read from the attempts that are already on the row rather than from the
   * gross alone, so a `payment.recorded` arriving against a part-paid sale is
   * measured against what is left of it. A tender already recorded under its
   * own press is inside this figure and is skipped below, so a replay of a
   * whole event neither double-counts nor refuses itself.
   */
  let remainingSatang = await outstandingAfter(tx, row);

  const out: Recorded = { written: 0, tenders: [] };
  for (const tender of tenders) {
    const already = await findAttemptByAction(tx, scope.operatorId, tender.actionId);
    if (already) {
      if (already.saleId !== saleId) {
        throw errors.conflict(
          'ACTION_ID_REUSED',
          'That press already recorded a tender against another sale',
          { actionId: tender.actionId, saleId: already.saleId },
        );
      }
      continue;
    }

    if (tender.amountSatang > remainingSatang) {
      throw errors.conflict(
        'SALE_OVERTENDERED',
        'That tender is more than this sale still owes, so none of this sale was recorded',
        {
          saleId,
          actionId: tender.actionId,
          amountSatang: tender.amountSatang,
          outstandingSatang: Math.max(0, remainingSatang),
          grossSatang: row.grossSatang,
        },
      );
    }

    /**
     * A terminal this box is entitled to name.
     *
     * The tenancy of everything else on the row comes from the credential; the
     * device id is the one identifier that arrives in the payload, and a
     * foreign key alone would happily point an attempt at another park's EDC.
     * Checked against the BOX rather than only the operator, because a device
     * is wired to a counter: a box naming a terminal on another box's counter
     * is either a misconfiguration or a claim it has no business making.
     */
    if (tender.deviceId) {
      const [owned] = await tx
        .select({ id: device.id })
        .from(device)
        .where(
          and(
            eq(device.id, tender.deviceId),
            eq(device.operatorId, scope.operatorId),
            eq(device.boxId, scope.boxId),
          ),
        )
        .limit(1);
      if (!owned) {
        throw errors.conflict(
          'SYNC_DEVICE_NOT_ON_BOX',
          'That terminal is not on this box, so it cannot have taken this money',
          { deviceId: tender.deviceId },
        );
      }
    }

    const method = await tenderMethodOf(tx, scope.operatorId, tender.methodCode, tender.kind);
    const opened = await openAttempt(tx, {
      operatorId: scope.operatorId,
      branchId: scope.branchId,
      stationId: scope.stationId,
      ...(tender.deviceId ? { deviceId: tender.deviceId } : {}),
      // The trading day of the SALE, copied off the row rather than re-derived:
      // the money belongs to the day it was taken on, not to the day the link
      // came back, and the end of day groups on exactly these columns.
      businessDate: row.businessDate,
      saleId,
      method,
      methodCode: tender.methodCode,
      provider: tender.provider ?? (tender.deviceId ? 'simulator' : 'manual'),
      amountSatang: tender.amountSatang,
      ...(tender.tenderedSatang === undefined
        ? {}
        : {
            tenderedSatang: tender.tenderedSatang,
            changeSatang: tender.changeSatang ?? tender.tenderedSatang - tender.amountSatang,
          }),
      ...(tender.invoiceNo ? { invoiceNo: tender.invoiceNo } : {}),
      actionId: tender.actionId,
      /** The flag this whole slice is about: this money was taken with no link. */
      offline: true,
      payload: {
        ...(tender.kind ? { kind: tender.kind } : {}),
        ...(tender.reference ? { reference: tender.reference } : {}),
        ...(tender.responseCode ? { responseCode: tender.responseCode } : {}),
        takenByAccountId: scope.actorAccountId,
        actionId: tender.actionId,
        sourceEventId: scope.eventId,
      },
    });

    /**
     * The box journal position this money arrived at.
     *
     * Written here rather than through `openAttempt`, whose input has no field
     * for it: that service belongs to the cash tender's slice and is in flight
     * beside this one, and adding a column to another slice's API mid-sprint is
     * how two half-merges become one broken one. It is two statements instead
     * of one on a path that runs when a box reconnects, and the comment is the
     * standing note to fold it in when these slices land together.
     */
    await tx
      .update(paymentAttempt)
      .set({ boxSeq: scope.boxSeq })
      .where(eq(paymentAttempt.id, opened.id));

    await settleAttempt(tx, opened.id, {
      status: tender.status,
      paidAt: tender.paidAt ? new Date(tender.paidAt) : scope.occurredAt,
      ...(tender.terminalRef ? { terminalRef: tender.terminalRef } : {}),
      ...(tender.tranRef ? { tranRef: tender.tranRef } : {}),
      ...(tender.approvalCode ? { approvalCode: tender.approvalCode } : {}),
      ...(tender.last4 ? { last4: tender.last4 } : {}),
      ...(tender.tid ? { tid: tender.tid } : {}),
      ...(tender.mid ? { mid: tender.mid } : {}),
    });

    out.written += 1;
    remainingSatang -= tender.amountSatang;
    out.tenders.push({
      method: tender.methodCode,
      amountSatang: tender.amountSatang,
      status: tender.status,
    });
  }
  return out;
}

/**
 * Close the sale if the money covers it, and say what happened.
 *
 * `finaliseSale` is called with NO tender, which is the one thing that makes
 * this safe: a call that names none settles the balance in cash, so it is only
 * ever made once the attempts above have already brought the balance to zero.
 * A sale the box could not cover is left open with its money against it — which
 * is what the pending-payments job and the end of day are for, and is strictly
 * better than a cash tender this path invented to tidy the row away.
 */
async function close(
  tx: Tx,
  scope: ReplayScope,
  saleId: string,
  recorded: Recorded,
  boxReceipt: { series: string; seq: number; number: string } | null,
  flags: { committed: boolean },
): Promise<ReplayOutcome> {
  const [row] = await tx.select().from(sale).where(eq(sale.id, saleId)).limit(1);
  if (!row) throw new Error('the sale was not written');

  const outstanding = await outstandingAfter(tx, row);
  let finalised = row.status === 'finalised';
  let receiptNumber = row.receiptNumber;

  /**
   * `<= 0` rather than `=== 0`, and the ceiling in `recordTenders` is why that
   * is safe: nothing this path writes can take a sale past its gross, so a
   * negative balance is not a state a replayed sale can reach. The comparison
   * is written this way round so that a sale which somehow arrived here
   * over-paid is CLOSED rather than left open for ever — an unclosable sale is
   * money the end of day cannot count — and the refusal above is what makes
   * sure nobody has to rely on that.
   */
  if (!finalised && outstanding <= 0) {
    const result = await finaliseSale(
      tx,
      actorFor(scope),
      saleId,
      { actionId: scope.actionId },
      scope.occurredAt,
    );
    finalised = result.finalised;
    receiptNumber = result.sale.receiptNumber;
  }

  const receiptDiffers =
    boxReceipt && receiptNumber && boxReceipt.number !== receiptNumber
      ? { box: boxReceipt.number, ledger: receiptNumber }
      : null;

  /**
   * The one audit row that names the EVENT.
   *
   * `commitSale` and `finaliseSale` write their own — `sale.create`,
   * `sale.finalise` — and neither can carry `source_event_id`, because neither
   * knows it came from a box. This row is what ties the till's line, the box's
   * journal position and the ledger together, which is the acceptance criterion
   * the whole sync ledger was built for.
   */
  await audit.record(tx, {
    actorAccountId: scope.actorAccountId,
    operatorId: scope.operatorId,
    branchId: scope.branchId,
    action: 'sale.offline_replay',
    entityType: 'sale',
    entityId: saleId,
    requestId: null,
    actionId: scope.actionId,
    sourceEventId: scope.eventId,
    before: flags.committed ? null : { status: row.status, outstandingSatang: outstanding },
    after: {
      boxId: scope.boxId,
      boxSeq: scope.boxSeq,
      stationId: scope.stationId,
      status: finalised ? 'finalised' : row.status,
      committed: flags.committed,
      tenders: recorded.tenders,
      attemptsWritten: recorded.written,
      outstandingSatang: Math.max(0, outstanding),
      receiptNumber,
      /** What the guest was shown at the counter, when it is not this. */
      ...(receiptDiffers ? { boxReceiptNumber: receiptDiffers.box } : {}),
    },
  });

  return {
    saleId,
    finalised,
    receiptNumber,
    outstandingSatang: Math.max(0, outstanding),
    recorded: recorded.written,
    receiptDiffers,
  };
}
