import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { checkin, bookingRedemption, paymentAttempt, product } from '@oto/db';
import {
  newId,
  PAYMENT_ATTEMPT_TAKEN_STATUSES,
  type OfflinePriceBasis,
  type PaymentAttemptView,
  type WalletGrantView,
} from '@oto/shared';
import { leaveAsBooked } from './checkin';
import { errors } from '../lib/errors';
import { audit } from './audit';
import type { BandView } from './bands';
import {
  BOOKING_CLAIM_WAIT_MS,
  linesOf,
  publishRedemption,
  redeemBooking,
  storedRedemptionOf,
  type BookingLineView,
  type BookingRow,
} from './bookings';
import {
  commitSale,
  finaliseSale,
  type CartLineInput,
  type CommitSaleInput,
  type SaleActor,
  type SaleView,
} from './sale';
import type { SalePrintingResult } from './sale-printing';
import type { Tx } from './tx';

/**
 * S2-12 (SCRUM-209 round 3) — REDEEMING AN ONLINE BOOKING AT THE COUNTER, whole.
 *
 * The prototype's `handleRedeemConfirm` (`imports/oto-pos/artifacts/oto-till/
 * src/pages/Till.tsx:376-468`) does five things in the browser: builds a sale
 * from the booking's regular lines with the booking's own tender, records it,
 * mints the bands (`issueBookingBands`, `mockApi.ts:2577-2626`), dispatches
 * the print jobs, and claims the booking (`redeemBooking`, `mockApi.ts:1020`).
 * Here those five are ONE transaction on the platform, in the order that makes
 * "once" true: the claim first — the booking's row lock, the paid-only
 * predicate and the unique redemption row (`redeemBooking`) — so a second till
 * racing the same QR waits on the lock, then reads a redeemed booking and is
 * refused by name before it has written a sale or minted a band.
 *
 * NEVER RE-PRICED. The family paid a figure online; the counter hands over what
 * that figure bought. The sale is priced from the booking's stored lines —
 * each line's kid unit, adult unit, free adults, socks and extras as the
 * booking site computed them — laid over the catalogue through the same OD-8
 * price basis an offline replay uses, at the booking's own rate mode and tier.
 * The sale's total must then equal the booking's paid total to the satang; if
 * the park's tax configuration has moved since (the one input the booking does
 * not store), the redemption is refused and nothing is written, rather than
 * filing a sale for a different sum than the money that paid for it.
 *
 * SETTLED BY THE PAID-ONLINE TENDER (`PAID_ONLINE_TENDER_CODE`), recorded as
 * `transfer` money: no drawer opens, and the till's cash-up leaves it out —
 * the money was counted on the day it was paid, under the booking's `WEB`
 * invoice (OD-A10). Wallet credit a package carries is recorded on the sale
 * exactly as a walk-in sale records it (OD-A7). Drop-off children get the
 * regular bands; their check-in notice stays on the till (OD-A8).
 *
 * BANDS AND PAPER come from the sale's own finalisation, the path every walk-in
 * sale takes (`routeSalePrinting` → `mintSaleBands`): two kid and two adult
 * bands for two kids and two adults, and the kids' bands name the visit's
 * children — with their allergy lines — when the till sends the visit it
 * confirmed, exactly as a walk-in does.
 */

export interface RedeemAtCounterArgs {
  bookingId: string;
  operatorId: string;
  /**
   * The account at the counter. Null at the self-service kiosk (S2-20 K1),
   * where nobody is signed in and `deviceCredentialId` is the actor.
   */
  actorAccountId: string | null;
  /**
   * S2-20 K1 — the kiosk's paired credential, when the redemption is
   * self-service: the sale names it (`pos.sale.device_credential_id`) and
   * `commitSale` checks it is live and paired to this kiosk station.
   */
  deviceCredentialId?: string | null;
  /**
   * The till, already checked to stand at the booking's branch. Null when the
   * session stands at none and named none: the booking's own refusals (not
   * paid, already redeemed) are answered first, then this one.
   */
  stationId: string | null;
  /** The visit reception confirmed at this till, whose children the kids' bands name. */
  visitId?: string | null;
  requestId?: string | null;
  /**
   * S2-20 K1 — the press this redemption is: the sale's action id
   * (`sale_action_unique`), its paid-online tender's and its print jobs'. The
   * kiosk sends the one it minted at the scan; the counter's route has its
   * idempotency key instead and sends none.
   */
  actionId?: string | null;
  /**
   * S2-20 K1 — `direct`: the bands are minted and the jobs written as rows,
   * but no box command is queued for the bands; the kiosk prints them itself
   * before its transaction commits. The rest of the paper (the receipt, a
   * credit voucher) is queued to the box as the counter's is, and prints
   * after the commit (SCRUM-504). `route` (the default) is the counter's.
   */
  printing?: 'route' | 'direct';
  /** The route's scope check on the branch the sale lands on. */
  assertBranchAllowed?: (branchId: string) => Promise<void>;
  now?: Date;
  /** SCRUM-504 — the bound on waiting behind another claim; `BOOKING_CLAIM_WAIT_MS` unless a test scales it. */
  claimWaitMs?: number;
}

export interface RedeemAtCounterResult {
  booking: BookingRow;
  sale: SaleView;
  /** The paid-online tender that settled it. */
  attempt: PaymentAttemptView | null;
  /** What closing the sale put on paper: jobs, bands, notes. */
  printing: SalePrintingResult | null;
  bands: BandView[];
  /**
   * S2-14a — the wallets the redemption granted, exactly as a walk-in sale of
   * the same tickets grants them (OD-A7): the same finalise, the same law.
   */
  grants: WalletGrantView[];
}

/** The socks add-on's catalogue code, as the booking site priced the `socks` integer (`booking-checkout.ts`). */
const SOCKS_CODE = 'AO-SOCKS';

/** A rate pair that answers the same figure on any day: the booking already chose the day. */
const flat = (satang: number) => ({ weekday: satang, weekend: satang });

/**
 * THE PRICE BASIS THAT REPRODUCES A BOOKING'S LINES, unit for unit.
 *
 * Per package: the kid price is the line's `kidUnitSatang` under the booking's
 * tier; the adults are `free_adults` with the line's own free count and the
 * line's paid unit as the overflow price, or `set_price` at that unit when
 * none were free — which is exactly how `resolveAdultLine` answers them. Per
 * product: the unit each extra and the socks were paid at.
 *
 * Two lines naming the same package at different figures cannot share one
 * package row, so that case is refused rather than priced wrong; the booking
 * site writes one line per package, so it is not a case today.
 */
export function priceBasisOfBooking(
  tier: string,
  rateMode: 'weekday' | 'weekend',
  lines: readonly BookingLineView[],
  socksProductId: string | null,
): OfflinePriceBasis {
  const packages = new Map<string, OfflinePriceBasis['packages'][number]>();
  const products = new Map<string, OfflinePriceBasis['products'][number]>();
  for (const line of lines) {
    const adultRule =
      line.adultsFree > 0
        ? { kind: 'free_adults', freeAdults: line.adultsFree, overflow: 'set_price', price: flat(line.adultUnitSatang) }
        : { kind: 'set_price', price: flat(line.adultUnitSatang) };
    const entry = {
      id: line.packageId,
      prices: { [tier]: flat(line.kidUnitSatang) },
      adultRules: { [tier]: adultRule },
    };
    const held = packages.get(line.packageId);
    if (held && JSON.stringify(held) !== JSON.stringify(entry)) {
      throw errors.conflict(
        'BOOKING_LINES_AMBIGUOUS',
        'This booking prices the same ticket twice at different figures, so it cannot be redeemed at the counter — ask a manager',
        { packageId: line.packageId },
      );
    }
    packages.set(line.packageId, entry);
    for (const addOn of line.addOns) {
      products.set(addOn.productId, {
        id: addOn.productId,
        priceSatang: addOn.unitSatang,
        priceWeekendSatang: addOn.unitSatang,
      });
    }
    if (line.socks > 0 && socksProductId) {
      products.set(socksProductId, {
        id: socksProductId,
        priceSatang: line.socksUnitSatang,
        priceWeekendSatang: line.socksUnitSatang,
      });
    }
  }
  return {
    catalogueVersion: null,
    pricingMode: rateMode,
    tier,
    taxConfig: null,
    packages: [...packages.values()],
    products: [...products.values()],
    options: [],
  } as OfflinePriceBasis;
}

/** The cart the booking's lines make — ids minted here, figures from the booking. */
export function cartLinesOfBooking(lines: readonly BookingLineView[]): CartLineInput[] {
  return lines.map((line) => ({
    id: line.supervision?.checkinId ?? newId(),
    ...(line.supervision ? {
      serviceFee: { label: line.supervision.service === 'nanny' ? 'Nanny' : 'Drop-off', amountSatang: line.supervision.serviceFeeSatang },
      ...(line.supervision.foodProvision && line.supervision.foodProvision.mode !== 'none'
        ? { foodProvision: { mode: line.supervision.foodProvision.mode, paidSatang: line.supervision.foodProvision.paidSatang } } : {}),
    } : {}),
    packageId: line.packageId,
    kids: line.kids,
    adults: line.adults,
    socks: line.socks,
    addOns: line.addOns.map((a) => ({ id: a.productId, name: a.name, unitSatang: a.unitSatang, quantity: a.quantity })),
  }));
}

/** The socks product the booking site priced `socks` from, if the park still has one. */
async function socksProductOf(tx: Tx, row: BookingRow): Promise<string | null> {
  const rows = await tx
    .select({ id: product.id, branchId: product.branchId })
    .from(product)
    .where(and(eq(product.operatorId, row.operatorId), eq(product.code, SOCKS_CODE), isNull(product.archivedAt)));
  const own = rows.find((r) => r.branchId === row.branchId) ?? rows.find((r) => !r.branchId);
  return own?.id ?? null;
}

/** The gateway invoice that paid the booking, for the tender's reconciliation. */
async function onlineInvoiceOf(tx: Tx, bookingId: string): Promise<string | null> {
  const [paid] = await tx
    .select({ invoiceNo: paymentAttempt.invoiceNo })
    .from(paymentAttempt)
    .where(
      and(
        sql`${paymentAttempt.payload} ->> 'bookingId' = ${bookingId}`,
        isNull(paymentAttempt.saleId),
        inArray(paymentAttempt.status, [...PAYMENT_ATTEMPT_TAKEN_STATUSES]),
      ),
    )
    .orderBy(desc(paymentAttempt.createdAt))
    .limit(1);
  return paid?.invoiceNo ?? null;
}

/**
 * Claim, sell, settle, mint and print — one transaction, the caller's.
 *
 * Throws (and so writes nothing) when the booking is not this operator's, is
 * already redeemed (by name: when, where, by whom), is not paid, has no lines
 * to issue against, or would be filed at a total other than what was paid.
 */
export async function redeemBookingAtCounter(
  tx: Tx,
  args: RedeemAtCounterArgs,
): Promise<RedeemAtCounterResult> {
  const now = args.now ?? new Date();

  // 1. THE CLAIM, before anything is priced, minted or printed. Waiting behind
  // another claim on the same booking is bounded (SCRUM-504): a kiosk holds the
  // row while its bands print, and the person here is told so by name.
  const claimed = await redeemBooking(tx, {
    bookingId: args.bookingId,
    operatorId: args.operatorId,
    actorAccountId: args.actorAccountId,
    stationId: args.stationId,
    bandCodes: [],
    requestId: args.requestId ?? null,
    now,
    deferPublish: true,
    claimWaitMs: args.claimWaitMs ?? BOOKING_CLAIM_WAIT_MS,
  });

  // A redemption is a sale, and a sale is numbered and printed at a till. Asked
  // after the claim so "booking not paid" and "already redeemed" are what the
  // counter hears first; this refusal rolls the claim back with it.
  const stationId = args.stationId;
  if (!stationId) {
    throw errors.badRequest('Redeem a booking at a till: this session is not standing at one');
  }

  // 2. THE SALE, from every line the family paid for. A supervised child's line
  // is filed under its stay's id, so finalising mints no band for it.
  const lines = linesOf(claimed).filter((l) => l.packageId && (l.kids > 0 || l.adults > 0));
  if (lines.length === 0) {
    throw errors.conflict(
      'BOOKING_NOTHING_TO_ISSUE',
      `Booking ${claimed.reference} carries no tickets, so there is nothing to issue at the counter`,
      { reference: claimed.reference },
    );
  }
  const payload = (claimed.payload ?? {}) as Record<string, unknown>;
  const tier = typeof payload.tier === 'string' && payload.tier ? payload.tier : 'tourist';
  const rateMode = payload.rateMode === 'weekend' ? 'weekend' : 'weekday';
  const socksProductId = lines.some((l) => l.socks > 0) ? await socksProductOf(tx, claimed) : null;
  const socksUnit = lines.find((l) => l.socks > 0)?.socksUnitSatang ?? 0;

  const actor: SaleActor = {
    accountId: args.actorAccountId,
    // S2-20 K1 — the kiosk's credential, checked by `commitSale` against this station.
    deviceCredentialId: args.deviceCredentialId ?? null,
    operatorId: args.operatorId,
    branchId: claimed.branchId,
    ...(args.requestId ? { requestId: args.requestId } : {}),
    ...(args.assertBranchAllowed ? { assertBranchAllowed: args.assertBranchAllowed } : {}),
  };
  const saleId = newId();
  const input: CommitSaleInput = {
    id: saleId,
    stationId,
    branchId: claimed.branchId,
    memberId: claimed.memberId,
    visitId: args.visitId ?? null,
    bookingId: claimed.id,
    ...(typeof payload.registrationId === 'string' ? { registrationId: payload.registrationId } : {}),
    lines: cartLinesOfBooking(lines),
    ...(lines.some((l) => l.socks > 0)
      ? {
          socks: socksProductId
            ? { addOnId: socksProductId }
            : { addOnId: 'booking-socks', unitSatang: socksUnit, label: 'Regular Socks' },
        }
      : {}),
    expectedTotalSatang: claimed.totalSatang,
    note: `Online booking ${claimed.reference}`,
    ...(args.actionId ? { actionId: args.actionId } : {}),
  };

  let committed;
  try {
    committed = await commitSale(tx, actor, input, now, {
      priceBasis: priceBasisOfBooking(tier, rateMode, lines, socksProductId),
    });
  } catch (err) {
    // The one refusal worth rewording: the platform would file a different
    // sum than the family paid. Everything else is already in words.
    if (err instanceof Error && (err as { code?: string }).code === 'SALE_TOTAL_MISMATCH') {
      throw errors.conflict(
        'BOOKING_TOTAL_DRIFT',
        `Booking ${claimed.reference} was paid ฿${(claimed.totalSatang / 100).toFixed(2)}, and the park's tax set-up has changed since, so the counter would file a different sum. Nothing was issued — ask a manager.`,
        { reference: claimed.reference, totalSatang: claimed.totalSatang, details: (err as { details?: unknown }).details ?? null },
      );
    }
    throw err;
  }
  // Belt and braces — `expectedTotalSatang` already held the commit to this.
  if (committed.sale.totals.grossSatang !== claimed.totalSatang) {
    throw errors.conflict('BOOKING_TOTAL_DRIFT', 'The redemption sale does not equal what the booking paid', {
      reference: claimed.reference,
      totalSatang: claimed.totalSatang,
      saleTotalSatang: committed.sale.totals.grossSatang,
    });
  }

  // 3. SETTLED AS PAID ONLINE; finalising mints the bands and queues the paper.
  const finalised = await finaliseSale(
    tx,
    actor,
    saleId,
    {
      onlineTender: {
        bookingId: claimed.id,
        bookingReference: claimed.reference,
        onlineInvoiceNo: await onlineInvoiceOf(tx, claimed.id),
      },
      ...(args.actionId ? { actionId: args.actionId } : {}),
      // S2-20 K1 — the kiosk prints the jobs itself, before it commits.
      ...(args.printing === 'direct' ? { printing: 'direct' as const } : {}),
    },
    now,
  );
  if (!finalised.finalised) {
    throw errors.conflict('BOOKING_SALE_OPEN', 'The redemption sale could not be closed — nothing was issued', {
      saleId,
      outstandingSatang: finalised.outstandingSatang,
    });
  }

  // Paid supervised children stay waiting: reception chooses check-in and the nanny.
  const stayIds = lines.flatMap((l) => l.supervision?.checkinId ? [l.supervision.checkinId] : []);
  if (stayIds.length) {
    const stays = await tx.select().from(checkin).where(inArray(checkin.id, stayIds));
    for (const stay of stays) {
      await leaveAsBooked(tx, actor, { saleId, entries: [{ checkinId: stay.id }],
        ...(stay.scheduledFor ? { scheduledFor: stay.scheduledFor.toISOString() } : {}),
      }, now);
    }
  }

  // 4. THE BANDS ON THE REDEMPTION — short codes only: a band's full code is a
  // gate credential, and this row is read back to anyone at a counter.
  const bands = finalised.printing?.bands ?? [];
  const shortCodes = bands.map((b) => b.shortCode).filter((c): c is string => !!c);
  const [redemptionRow] = await tx
    .update(bookingRedemption)
    .set({ bandCodes: shortCodes })
    .where(eq(bookingRedemption.bookingId, claimed.id))
    .returning();
  // The boxes at this branch are told now, with the bands on it (SCRUM-305).
  await publishRedemption(tx, claimed, storedRedemptionOf(redemptionRow!));

  await audit.record(tx, {
    actorAccountId: args.actorAccountId,
    operatorId: args.operatorId,
    branchId: claimed.branchId,
    action: 'booking.redeem.sale',
    entityType: 'booking',
    entityId: claimed.id,
    after: {
      reference: claimed.reference,
      saleId,
      totalSatang: claimed.totalSatang,
      tender: 'paid_online',
      bandIds: bands.map((b) => b.id),
      grantWalletIds: finalised.grants.map((g) => g.walletId),
      printJobIds: (finalised.printing?.jobs ?? []).map((j) => j.id),
      // S2-20 K1 — which surface: the counter, or the kiosk and its credential.
      surface: args.deviceCredentialId ? 'kiosk' : 'counter',
      ...(args.deviceCredentialId ? { stationId, deviceCredentialId: args.deviceCredentialId } : {}),
    },
    requestId: args.requestId ?? null,
    actionId: args.actionId ?? null,
  });

  return {
    booking: claimed,
    sale: finalised.sale,
    attempt: finalised.attempt,
    printing: finalised.printing,
    bands,
    grants: finalised.grants,
  };
}
