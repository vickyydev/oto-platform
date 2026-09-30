import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  account,
  boothConfigVersion,
  boothPrize,
  boothStaffAssignment,
  spin,
  station,
  voucher,
  voucherDefinition,
  voucherPrint,
  BOOTH_SPIN_OUTCOMES,
  VOUCHER_PRINT_REASONS,
  type Db,
} from '@oto/db';
import { newId } from '@oto/shared';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import type { BoxAuth } from './box';
import { audit } from './audit';
import { raiseAlert } from './ops';
import type { Tx } from './tx';
import type { EventHandler, PreparedEvent } from './sync';

/**
 * The cloud's side of the Lucky Wheel (S2-07a).
 *
 * A booth draws, prints and counts entirely on its own box — that is the whole
 * point of D2, and it is why nothing in this file is on the path a child's
 * press takes. What is here runs minutes or hours later, when the box gets its
 * uplink back and hands over what happened: three facts that file into
 * `booth.spin`, `promo.voucher` and `booth.voucher_print`, and the cache scope
 * that sends the published wheel the other way.
 *
 * **Everything below is a REPORT of something already done.** The paper is in
 * a visitor's hand before any of this runs, which decides how each handler
 * behaves when it cannot file what it is told:
 *
 *   - it never rewrites what the box said. A code the cloud already holds
 *     under another voucher is a collision, and the loser is quarantined for a
 *     person rather than quietly re-coded (D9) — the slip at reception is the
 *     authority, and there are two of them;
 *   - it never refuses an event for arriving out of order where it can file it
 *     anyway. A spin whose voucher has not landed yet is filed with a null
 *     `voucher_id`, and the voucher fills it in when it arrives;
 *   - tenancy comes from the CREDENTIAL, never from the payload, as it does for
 *     every other handler in `sync.ts`. A box writes into its own operator and
 *     its own branch or it writes nothing.
 *
 * **Refusals travel as `AppError`, which files them as `apply_failed`.**
 * `sync.ts` keeps `RefuseEvent` — the class that carries the finer quarantine
 * reason — unexported, and importing it here would put a runtime cycle through
 * the file every push runs. `classifyFailure` maps an `AppError` to
 * `apply_failed` and keeps its code and message, so the quarantine row a
 * person opens says `BOOTH_CODE_COLLISION` and names both booths. What is lost
 * is only the reason's precision: a collision is filed under `apply_failed`
 * rather than `conflict`, and the Failures tab groups it with the rest.
 */

// --- What a booth may say ----------------------------------------------------

/**
 * A press of the red button, as the box recorded it before the wheel moved.
 *
 * Every field is named as its column. `voucherId` is the one the cloud does
 * not simply trust: the box minted the voucher in the same transaction, but
 * the two facts can still reach the cloud in either order, so it is resolved
 * rather than written straight through — see `linkVoucherIfPresent`.
 */
const SpinRecordedSchema = z.object({
  spinId: z.string().uuid(),
  boothConfigVersionId: z.string().uuid(),
  outcome: z.enum(BOOTH_SPIN_OUTCOMES).default('prize'),
  prizeId: z.string().uuid().nullish(),
  voucherId: z.string().uuid().nullish(),
  /**
   * Who was signed in at the booth. Null is a real and expected value: a
   * sign-in problem must never take the booth down, and D13's standing
   * condition is what makes the gap visible without blocking a child.
   *
   * Taken from the payload rather than from the envelope's `actorAccountId`.
   * They answer different questions — the envelope's actor is who caused the
   * fact, and for a booth press that is a visitor the park has no record of,
   * while this is the staff member the booth's own overlay had signed in. The
   * box is the authority on the second, because the session is its own.
   */
  staffAccountId: z.string().uuid().nullish(),
  clockSuspect: z.boolean().default(false),
  simulated: z.boolean().default(false),
});

/**
 * A voucher minted on the box, with the code already on paper.
 *
 * `costSatang` and `expiresAt` are required — `expiresAt` required AND
 * nullable — because both are captured at issue, and a default here would be
 * the cloud inventing the value of something the park has already given away.
 * A box that does not send them is refused loudly rather than filed at zero
 * and "never expires".
 *
 * **Who issued it is NOT in the payload**, and that is the box's shape rather
 * than an omission: the fact is minted with `actorAccountId` set to whoever
 * the booth's own overlay had signed in, and reading a second copy out of the
 * payload would be two answers to one question. The handler takes the
 * envelope's.
 */
const VoucherIssuedSchema = z.object({
  voucherId: z.string().uuid(),
  voucherDefinitionId: z.string().uuid(),
  /** Upper case, no separator — `mintBoothCode` in `@oto/shared`. */
  code: z.string().min(4).max(32),
  /** The press this came out of, when the box knows it. */
  spinId: z.string().uuid().nullish(),
  costSatang: z.number().int().min(0),
  /** ISO 8601, or null for a definition that never expires. */
  expiresAt: z.string().datetime().nullable(),
  /**
   * Accepted only as `booth`, and only to refuse anything else.
   *
   * `promo.voucher.source` also holds `legacy` (the Radar import) and
   * `manual`, and neither is something a box may claim to be: a voucher that
   * arrived on this route was printed at a booth. The column is written from
   * here rather than from the payload; the field exists so that a box sending
   * a different value is quarantined instead of quietly filed as a booth
   * voucher.
   */
  source: z.literal('booth').optional(),
});

/**
 * Paper was produced for a voucher (D20).
 *
 * It travels as a fact rather than through the cloud's print-result route
 * because an offline booth has no cloud print job to report against: the job
 * was minted on the box, queued on the box and printed on the box, and the row
 * it produces here is the long-lived record of it. `edge.print_job` is swept
 * after 90 days; "how many times was this voucher printed, and who asked for
 * the second one" is asked when a family turns up at reception with two
 * copies, which can be a year later.
 */
const VoucherPrintedSchema = z.object({
  /**
   * **Which voucher's paper this was — by id or by code, and one is required.**
   *
   * `booth.voucher_print.voucher_id` is NOT NULL and there is no other way to
   * answer the question: `print_job_id` points into `edge.print_job`, which is
   * a BOX-local table the cloud never sees, so an outcome carrying only a job
   * id names a row this side cannot resolve.
   *
   * Both spellings, because the box has them at different moments. At the
   * press it holds the voucher id it just minted; after a restart it adopts
   * the jobs the last process left unprinted and has only what is stored on
   * the job — whose renderer input carries `voucherCode` and not the id. A
   * fact that could only be sent one way would be a fact a reboot cannot
   * send. The code resolves unambiguously: `promo.voucher (operator_id, code)`
   * is unique.
   */
  voucherId: z.string().uuid().optional(),
  /** See above. Upper case, no separator. */
  voucherCode: z.string().min(4).max(32).optional(),
  /**
   * `edge.print_job.id` on the box. No foreign key — see the column's note —
   * and, with the voucher, the key this handler dedupes on when the box mints
   * no row id of its own.
   */
  printJobId: z.string().uuid(),
  /** `printed` is paper; the rest are attempts that produced none. */
  status: z.enum(['printed', 'failed', 'queued', 'skipped']),
  /** `booth.voucher_print.id`, when the box minted one. */
  printId: z.string().uuid().optional(),
  reason: z.enum(VOUCHER_PRINT_REASONS).default('initial'),
  /** Null for the automatic first print; a reprint is staff-only. */
  requestedByAccountId: z.string().uuid().nullish(),
  /** When the box queued it. Defaults to when the outcome was reported. */
  queuedAt: z.string().datetime().optional(),
});

// --- Shared checks -----------------------------------------------------------

/**
 * The booth this event happened at.
 *
 * `sync.ts` has already refused any event naming a station that is not on this
 * box, so what is left to establish is that there IS one: `booth.spin.station_id`
 * is not nullable, and a spin that cannot be attributed to a booth is a spin
 * no report can read.
 */
function boothOf(event: PreparedEvent): string {
  const stationId = event.envelope.stationId;
  if (!stationId) {
    throw new AppError(
      422,
      'BOOTH_STATION_MISSING',
      'A booth fact has to name the booth it happened at',
    );
  }
  return stationId;
}

/**
 * An account this operator employs, or nothing.
 *
 * The foreign keys would catch an id that exists nowhere; what they would not
 * catch is a box naming an account belonging to ANOTHER operator, which is a
 * tenancy hole rather than a broken reference. Null in, null out: nobody
 * signed in is the expected state at a mall booth, not an error.
 */
async function assertOurAccount(
  tx: Tx,
  operatorId: string,
  accountId: string | null | undefined,
  field: string,
): Promise<string | null> {
  if (!accountId) return null;
  const [row] = await tx
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.id, accountId), eq(account.operatorId, operatorId)))
    .limit(1);
  if (!row) {
    throw new AppError(
      422,
      'BOOTH_ACCOUNT_NOT_OURS',
      `The account this event names as ${field} does not belong to this operator`,
    );
  }
  return row.id;
}

/**
 * Point a spin at its voucher, once both halves are here.
 *
 * The box mints them together; the cloud can see them in either order and in
 * either batch, and neither fact may fail because the other is late. So this
 * is called from BOTH handlers with whatever is known at the time, and it
 * writes only when it finds the voucher and the spin is still unlinked.
 *
 * Two guards, each for its own reason. The lookup, because `spin.voucher_id`
 * is a restricting foreign key and pointing it at a voucher that has not
 * arrived would take the press down with it — a spin refused for being one
 * batch ahead of its voucher is a press the park has no record of at all. And
 * `voucher_id is null` in the `where`, so that a spin already pointing at a
 * voucher is never re-pointed at another.
 *
 * **What that second guard does NOT do**, because it is easy to read it as
 * more than it is: it does not stop two DIFFERENT spins naming one voucher.
 * Each of them is unlinked, so each passes the `where`. What refuses the
 * second is `spin_voucher_unique`, the partial unique index on the column —
 * the write fails, the event is quarantined, and a person is left with two
 * presses claiming one printed slip rather than a database that has quietly
 * picked one.
 */
async function linkVoucherIfPresent(
  tx: Tx,
  spinId: string,
  voucherId: string,
  operatorId: string,
): Promise<void> {
  const [held] = await tx
    .select({ id: voucher.id })
    .from(voucher)
    .where(and(eq(voucher.id, voucherId), eq(voucher.operatorId, operatorId)))
    .limit(1);
  if (!held) return;
  await tx
    .update(spin)
    .set({ voucherId: held.id })
    .where(and(eq(spin.id, spinId), eq(spin.operatorId, operatorId), isNull(spin.voucherId)));
}

/**
 * Raise a booth condition on the POOL rather than on the transaction.
 *
 * **One of the two callers needs this; the other only tolerates it.** The
 * collision alert is raised by a handler that is about to throw, and its
 * savepoint is rolled back the moment it does — an alert written on that
 * handle would be undone along with the refusal it exists to report. Same
 * reasoning as the failure audit row `withTx` writes after a rollback, on a
 * separate connection, because by definition it has to outlive the
 * transaction that failed. The unattributed alert is on a path that succeeds
 * and would sit happily inside the transaction; it comes here because
 * `raiseAlert` takes the pool handle.
 *
 * What that costs, for both: the alert is on its own connection, so it commits
 * whatever happens to the batch afterwards. If the push transaction then
 * fails, the condition stands for work that was never filed, and the next push
 * re-raises it onto the same row rather than opening a second. An alert
 * somebody reads twice is a cheaper mistake than a collision nobody hears
 * about.
 */
async function raiseBoothAlert(
  db: Db,
  auth: BoxAuth,
  input: { key: string; category: string; summary: string; detail: Record<string, unknown> },
): Promise<void> {
  await raiseAlert(
    db,
    {
      key: input.key,
      category: input.category,
      severity: 'warning',
      subject: `${auth.name} (${auth.slot})`,
      summary: input.summary,
      detail: input.detail,
      operatorId: auth.operatorId,
      branchId: auth.branchId,
    },
    { flapWindowSeconds: 0 },
  );
}

/**
 * How a booth is named in an alert a person reads: "Booth 1 (B1)".
 *
 * `code_prefix` is nullable on `core.station` — a booth nobody has allocated
 * one to yet — and the name alone is what a person at the park calls it, so a
 * missing prefix drops the bracket rather than printing "(null)".
 */
function nameBooth(
  row: { name: string; codePrefix: string | null } | undefined,
  fallback: string,
): string {
  if (!row) return fallback;
  return row.codePrefix ? `${row.name} (${row.codePrefix})` : row.name;
}

// --- The handlers ------------------------------------------------------------

/**
 * The three booth facts, as `sync.ts` registers them.
 *
 * Typed against `EventHandler` with a type-only import, so registering them
 * costs `sync.ts` an import and a spread and puts no runtime cycle between the
 * two files.
 */
export const BOOTH_HANDLERS: Record<string, EventHandler> = {
  /**
   * Every press of the button, win or not — the row the box wrote before the
   * wheel animated.
   *
   * **`business_date` comes from the batch's own resolution.** The column is
   * not nullable and has no default, deliberately: a spin at 00:30 belongs to
   * the trading day that is finishing, and a booth running past midnight must
   * not split one day across two. `prepareEvent` has already resolved it from
   * this branch's `business_day_start` — and from `received_at` instead of
   * `occurred_at` when the box's clock could not be trusted, which is also
   * when it files the `clock_recomputed` anomaly naming the day the other
   * clock would have given.
   *
   * The box sends its own `businessDate` beside the press, resolved the same
   * way from the same instant, and this handler does not read it: the two
   * disagree only when the box's clock does, and the cloud's is the one that
   * was not measured by the suspect clock. The schema does not declare it, so
   * zod strips it — the event is in `edge.sync_event` with its payload intact
   * for anybody who needs to compare the two.
   */
  'booth.spin_recorded': {
    schema: SpinRecordedSchema,
    async apply(tx, scope, event, payload: z.infer<typeof SpinRecordedSchema>) {
      const stationId = boothOf(event);
      const operatorId = scope.auth.operatorId;

      const [existing] = await tx
        .select({ id: spin.id, voucherId: spin.voucherId })
        .from(spin)
        .where(eq(spin.id, payload.spinId))
        .limit(1);
      if (existing) {
        // A re-send of a press already filed. Nothing else about a spin can
        // change — it is an immutable fact with two clocks on it — but if its
        // voucher arrived in the meantime, the link is still owed.
        if (!existing.voucherId && payload.voucherId) {
          await linkVoucherIfPresent(tx, payload.spinId, payload.voucherId, operatorId);
        }
        return { entityType: 'spin', entityId: existing.id };
      }

      /**
       * The wheel that drew. Not nullable on the row, and checked against THIS
       * booth rather than only for existence: a draw explained by another
       * booth's odds explains nothing.
       */
      const [version] = await tx
        .select({ id: boothConfigVersion.id })
        .from(boothConfigVersion)
        .where(
          and(
            eq(boothConfigVersion.id, payload.boothConfigVersionId),
            eq(boothConfigVersion.stationId, stationId),
          ),
        )
        .limit(1);
      if (!version) {
        throw new AppError(
          422,
          'BOOTH_CONFIG_VERSION_UNKNOWN',
          'That published wheel is not one this booth has ever run',
        );
      }

      if (payload.prizeId) {
        const [prize] = await tx
          .select({ id: boothPrize.id })
          .from(boothPrize)
          .where(and(eq(boothPrize.id, payload.prizeId), eq(boothPrize.stationId, stationId)))
          .limit(1);
        if (!prize) {
          throw new AppError(
            422,
            'BOOTH_PRIZE_NOT_ON_BOOTH',
            'That prize is not a slice of this booth’s wheel',
          );
        }
      }

      const staffAccountId = await assertOurAccount(
        tx,
        operatorId,
        payload.staffAccountId,
        'the staff member signed in at the booth',
      );

      await tx.insert(spin).values({
        id: payload.spinId,
        operatorId,
        branchId: scope.auth.branchId,
        stationId,
        boxId: scope.auth.boxId,
        boothConfigVersionId: version.id,
        outcome: payload.outcome,
        prizeId: payload.prizeId ?? null,
        // Left for `linkVoucherIfPresent`, which writes it only once the
        // voucher is actually here.
        voucherId: null,
        staffAccountId,
        /**
         * Either end may say the clock was doubtful. The box flags it past ten
         * minutes of drift (D11); `prepareEvent` overrules a box that claimed
         * `trusted` while reporting an offset outside the cloud's tolerance.
         * The row carries the doubt if either end saw it.
         */
        clockSuspect: payload.clockSuspect || event.clockTrust !== 'trusted',
        simulated: payload.simulated,
        occurredAt: event.occurredAt,
        businessDate: event.businessDate,
        actionId: event.envelope.actionId ?? null,
        sourceEventId: event.envelope.eventId,
      });

      if (payload.voucherId) {
        await linkVoucherIfPresent(tx, payload.spinId, payload.voucherId, operatorId);
      }

      await audit.record(tx, {
        actorAccountId: event.envelope.actorAccountId ?? null,
        operatorId,
        branchId: scope.auth.branchId,
        action: 'spin.record',
        entityType: 'spin',
        entityId: payload.spinId,
        // What was drawn, not what it is worth: an audit row is read on a
        // Console page, and the money is on the voucher.
        after: {
          stationId,
          prizeId: payload.prizeId ?? null,
          outcome: payload.outcome,
          businessDate: event.businessDate,
          staffAccountId,
          simulated: payload.simulated,
        },
        requestId: null,
        actionId: event.envelope.actionId ?? null,
        sourceEventId: event.envelope.eventId,
      });

      return { entityType: 'spin', entityId: payload.spinId };
    },
  },

  /**
   * A voucher the box minted, with the code already printed.
   *
   * The code is the one thing in this file the cloud may not correct, and the
   * collision check is the whole of D9: two vouchers claiming one code means
   * two people are holding paper for it, so the second is quarantined with
   * both booths named and neither is reassigned.
   */
  'promo.voucher_issued': {
    schema: VoucherIssuedSchema,
    async apply(tx, scope, event, payload: z.infer<typeof VoucherIssuedSchema>) {
      const stationId = boothOf(event);
      const operatorId = scope.auth.operatorId;
      const code = payload.code.toUpperCase();

      const [byId] = await tx
        .select({ id: voucher.id, code: voucher.code })
        .from(voucher)
        .where(and(eq(voucher.id, payload.voucherId), eq(voucher.operatorId, operatorId)))
        .limit(1);
      if (byId) {
        if (byId.code !== code) {
          /**
           * The same voucher, a different code. Not a collision — there is one
           * piece of paper — but the cloud must not follow the second value
           * either: the code on the slip is what reception will be shown, and
           * the first event arrived carrying it. Filed for a person instead.
           */
          throw new AppError(
            422,
            'BOOTH_VOUCHER_RECODED',
            'This voucher is already recorded under a different code, and a printed code is never rewritten',
          );
        }
        if (payload.spinId) {
          await linkVoucherIfPresent(tx, payload.spinId, byId.id, operatorId);
        }
        return { entityType: 'voucher', entityId: byId.id };
      }

      const [byCode] = await tx
        .select({ id: voucher.id, issuedAt: voucher.issuedAt })
        .from(voucher)
        .where(and(eq(voucher.operatorId, operatorId), eq(voucher.code, code)))
        .limit(1);
      if (byCode) {
        /**
         * D9. Which booth printed the code the cloud already holds is read
         * from the spin that claims that voucher — `promo.voucher` records the
         * branch a voucher was issued at, not the booth. A voucher whose spin
         * has not arrived yet therefore names no booth, and the alert says so
         * rather than guessing at one.
         */
        const [incumbent] = await tx
          .select({
            stationId: spin.stationId,
            name: station.name,
            codePrefix: station.codePrefix,
          })
          .from(spin)
          .innerJoin(station, eq(station.id, spin.stationId))
          .where(eq(spin.voucherId, byCode.id))
          .limit(1);
        const [sender] = await tx
          .select({ name: station.name, codePrefix: station.codePrefix })
          .from(station)
          .where(eq(station.id, stationId))
          .limit(1);
        const incumbentName = nameBooth(incumbent, 'a booth whose spin has not arrived yet');
        const senderName = nameBooth(sender, stationId);

        await raiseBoothAlert(scope.db, scope.auth, {
          key: `booth.code_collision:${operatorId}:${code}`,
          category: 'booth.code_collision',
          summary: `Voucher code ${code} was printed by ${incumbentName} and again by ${senderName} — both slips are in somebody's hands, and the second is waiting on Failures > Quarantine`,
          detail: {
            code,
            heldByVoucherId: byCode.id,
            heldByStationId: incumbent?.stationId ?? null,
            heldSince: byCode.issuedAt.toISOString(),
            refusedVoucherId: payload.voucherId,
            refusedStationId: stationId,
            boxId: scope.auth.boxId,
          },
        });

        throw new AppError(
          409,
          'BOOTH_CODE_COLLISION',
          `Voucher code ${code} is already held by ${incumbentName}; ${senderName} printed it too. Neither is reassigned — the paper is the authority`,
        );
      }

      const [definition] = await tx
        .select({ id: voucherDefinition.id })
        .from(voucherDefinition)
        .where(
          and(
            eq(voucherDefinition.id, payload.voucherDefinitionId),
            eq(voucherDefinition.operatorId, operatorId),
          ),
        )
        .limit(1);
      if (!definition) {
        throw new AppError(
          422,
          'BOOTH_VOUCHER_DEFINITION_UNKNOWN',
          'That voucher definition does not exist for this operator',
        );
      }

      /**
       * SCRUM-427 (audit T27) — the type must have been on a wheel this booth
       * has published, at some point.
       *
       * A real booth issues only what the published prize points at
       * (`packages/box-agent/src/booth.ts`), so a type no version of this
       * booth ever carried is a fact no booth could have produced. Any
       * version, not the current one, deliberately: a prize archived or
       * re-pointed since the publish is still on the wheel the box is
       * running, and a slip it printed last week under the old wheel is still
       * paper in somebody's hand. What the audit's stricter checks would have
       * quarantined — an expiry edit, a prefix change, an archived running
       * type — all pass here, because none of them takes a type off a
       * published bundle.
       *
       * Read from the frozen bundles rather than from the live `booth_prize`
       * rows, for the same reason `boothCacheItems` does: the bundle is what
       * the box drew from. `@>` is jsonb containment, so a prize carrying
       * fields this build has never heard of still matches on the one key
       * that matters.
       */
      const [onWheel] = await tx
        .select({ id: boothConfigVersion.id })
        .from(boothConfigVersion)
        .where(
          and(
            eq(boothConfigVersion.stationId, stationId),
            sql`${boothConfigVersion.bundle} @> ${JSON.stringify({
              prizes: [{ voucherDefinitionId: definition.id }],
            })}::jsonb`,
          ),
        )
        .limit(1);
      if (!onWheel) {
        throw new AppError(
          422,
          'BOOTH_VOUCHER_TYPE_NOT_ON_WHEEL',
          'That voucher type has never been on a published wheel of this booth',
        );
      }

      /**
       * From the envelope: the box mints this fact with `actorAccountId` set
       * to whoever its own overlay had signed in, and null when nobody was.
       * See the note on the schema for why the payload does not repeat it.
       */
      const issuedByAccountId = await assertOurAccount(
        tx,
        operatorId,
        event.envelope.actorAccountId,
        'the staff member who issued it',
      );

      const [created] = await tx
        .insert(voucher)
        .values({
          id: payload.voucherId,
          operatorId,
          branchId: scope.auth.branchId,
          voucherDefinitionId: definition.id,
          code,
          source: 'booth',
          status: 'issued',
          costSatang: payload.costSatang,
          issuedByAccountId,
          issuedAt: event.occurredAt,
          expiresAt: payload.expiresAt ? new Date(payload.expiresAt) : null,
        })
        .returning({ id: voucher.id });

      if (payload.spinId) {
        await linkVoucherIfPresent(tx, payload.spinId, created!.id, operatorId);
      }

      await audit.record(tx, {
        actorAccountId: event.envelope.actorAccountId ?? null,
        operatorId,
        branchId: scope.auth.branchId,
        action: 'voucher.issue',
        entityType: 'voucher',
        entityId: created!.id,
        after: {
          code,
          stationId,
          spinId: payload.spinId ?? null,
          costSatang: payload.costSatang,
          expiresAt: payload.expiresAt,
          issuedByAccountId,
        },
        requestId: null,
        actionId: event.envelope.actionId ?? null,
        sourceEventId: event.envelope.eventId,
      });

      if (!issuedByAccountId) {
        /**
         * D13. One condition with a count, not one alert per voucher: sixty
         * unattributed vouchers at one booth bump one row sixty times, because
         * what somebody has to act on is "this booth is giving prizes away
         * with nobody signed in", once.
         */
        await raiseBoothAlert(scope.db, scope.auth, {
          key: `booth.unattributed:${stationId}`,
          category: 'booth.unattributed',
          summary: `${scope.auth.name} is issuing booth vouchers with nobody signed in — the wheel keeps working, but the prizes are attributed to no one`,
          detail: { stationId, boxId: scope.auth.boxId, latestVoucherId: created!.id },
        });
      }

      return { entityType: 'voucher', entityId: created!.id };
    },
  },

  /**
   * Paper was produced for a voucher (D20).
   *
   * A voucher that is not here yet is refused rather than invented: the box
   * queues the issue before the print, so a print arriving alone means the
   * issue is in quarantine — and filing a print against a voucher the park has
   * no record of would hide exactly that.
   */
  'booth.voucher_printed': {
    schema: VoucherPrintedSchema,
    async apply(tx, scope, event, payload: z.infer<typeof VoucherPrintedSchema>) {
      const stationId = boothOf(event);
      const operatorId = scope.auth.operatorId;

      if (!payload.voucherId && !payload.voucherCode) {
        throw new AppError(
          422,
          'BOOTH_PRINT_NAMES_NO_VOUCHER',
          'A print outcome has to name the voucher it printed, by id or by code — a print job id is a row on the box that this side cannot see',
        );
      }
      const [held] = await tx
        .select({ id: voucher.id, printCount: voucher.printCount })
        .from(voucher)
        .where(
          and(
            eq(voucher.operatorId, operatorId),
            payload.voucherId
              ? eq(voucher.id, payload.voucherId)
              : eq(voucher.code, payload.voucherCode!.toUpperCase()),
          ),
        )
        .limit(1);
      if (!held) {
        throw new AppError(
          422,
          'BOOTH_VOUCHER_ABSENT',
          'No such voucher here yet — its issue has not arrived, or it was refused',
        );
      }

      /**
       * SCRUM-413 (audit L8) — the voucher has to be THIS booth's.
       *
       * The lookup above finds a code anywhere in the operator, so without
       * this one box could file a "reprint" against another branch's voucher
       * and corrupt the booth report's print funnel. A voucher's booth is the
       * press that won it: `promo.voucher` records the branch, and the spin
       * records the station and is pointed at its voucher by
       * `linkVoucherIfPresent` once both halves are here — which they are by
       * the time a print outcome arrives, because the box queues the press
       * and the voucher together, before the paper, and the cloud files a
       * batch in order. A print whose spin was itself refused is refused with
       * it, and can be replayed from Quarantine once the spin has been.
       */
      const [won] = await tx
        .select({ id: spin.id })
        .from(spin)
        .where(and(eq(spin.voucherId, held.id), eq(spin.stationId, stationId)))
        .limit(1);
      if (!won) {
        throw new AppError(
          422,
          'BOOTH_VOUCHER_NOT_THIS_BOOTHS',
          'That voucher was not won at this booth — no press here is linked to it — so its paper cannot be filed under it',
        );
      }

      /**
       * `queued` is a state, not an outcome.
       *
       * The box reports one while the paper is still owed and reports again
       * when it is settled, so filing a row for it would count one slip twice
       * — and incrementing `print_count` for it would say paper exists that
       * does not. The event is applied and writes nothing, which is the honest
       * answer: nothing has happened to this voucher's paper yet.
       */
      if (payload.status === 'queued') {
        return { entityType: 'voucher', entityId: held.id };
      }

      /**
       * One row per print job, whichever way it ended.
       *
       * The box mints no `booth.voucher_print.id` of its own today, so the key
       * is the job: one job is one attempt at one voucher's paper, and a
       * repeat report of the same job — a replayed quarantine row, a box that
       * reported twice — must not add a second. `printId` is honoured when a
       * box does send one.
       */
      const [existing] = await tx
        .select({ id: voucherPrint.id })
        .from(voucherPrint)
        .where(
          payload.printId
            ? eq(voucherPrint.id, payload.printId)
            : and(
                eq(voucherPrint.voucherId, held.id),
                eq(voucherPrint.printJobId, payload.printJobId),
              ),
        )
        .limit(1);
      if (existing) return { entityType: 'voucher_print', entityId: existing.id };

      const requestedByAccountId = await assertOurAccount(
        tx,
        operatorId,
        payload.requestedByAccountId,
        'the staff member who asked for the print',
      );
      /**
       * SCRUM-413 (audit L8) — a reprint is asked for by somebody on this
       * booth's staff list, or it is not one this booth made.
       *
       * The box lets nobody else sign in at the booth (`allowedStaff` on the
       * cache scope is `booth_staff_assignment`, served whole), so a fact
       * naming anyone else was not produced by the booth's own reprint. The
       * list is read as it is now: a member of staff taken off the booth
       * between asking for a copy and the box syncing it is quarantined for a
       * person to look at, which is the cheaper mistake. Null is the
       * automatic first print, and names nobody.
       */
      if (requestedByAccountId) {
        const [onStaff] = await tx
          .select({ id: boothStaffAssignment.id })
          .from(boothStaffAssignment)
          .where(
            and(
              eq(boothStaffAssignment.stationId, stationId),
              eq(boothStaffAssignment.accountId, requestedByAccountId),
            ),
          )
          .limit(1);
        if (!onStaff) {
          throw new AppError(
            422,
            'BOOTH_PRINT_REQUESTER_NOT_STAFF',
            'The account this print names as its requester is not on this booth’s staff list',
          );
        }
      }

      const printId = payload.printId ?? newId();
      await tx.insert(voucherPrint).values({
        id: printId,
        operatorId,
        branchId: scope.auth.branchId,
        boxId: scope.auth.boxId,
        stationId,
        voucherId: held.id,
        printJobId: payload.printJobId,
        reason: payload.reason,
        requestedByAccountId,
        queuedAt: payload.queuedAt ? new Date(payload.queuedAt) : event.occurredAt,
        actionId: event.envelope.actionId ?? null,
      });

      /**
       * Paper only.
       *
       * `print_count` answers "how many copies of this code exist", which is
       * what reception asks when a family arrives with two of them — so a
       * failed or skipped attempt leaves it alone. The `voucher_print` row
       * above is the record that the attempt happened at all, and the two
       * numbers differ by exactly the attempts that produced nothing.
       */
      const printed = payload.status === 'printed';
      if (printed) {
        await tx
          .update(voucher)
          .set({ printCount: sql`${voucher.printCount} + 1` })
          .where(eq(voucher.id, held.id));
      }

      await audit.record(tx, {
        actorAccountId: event.envelope.actorAccountId ?? null,
        operatorId,
        branchId: scope.auth.branchId,
        action: 'voucher.print',
        entityType: 'voucher',
        entityId: held.id,
        before: { printCount: held.printCount },
        after: {
          printCount: held.printCount + (printed ? 1 : 0),
          status: payload.status,
          reason: payload.reason,
          stationId,
          printJobId: payload.printJobId,
          requestedByAccountId,
        },
        requestId: null,
        actionId: event.envelope.actionId ?? null,
        sourceEventId: event.envelope.eventId,
      });

      return { entityType: 'voucher_print', entityId: printId };
    },
  },
};

// --- The cache scope ---------------------------------------------------------

/**
 * One booth's published wheel, as the box caches it.
 *
 * This is the cloud's half of `BoothCacheEntrySchema` in `@oto/box-agent`,
 * which is the box's statement of what it needs to run a wheel. The agent
 * validates every entry against that schema and skips — by station id, with a
 * line in its log — anything it cannot read, so a field renamed on this side
 * takes the booth off the air rather than half-configuring it. The two shapes
 * are kept in step by `booth-sync.test.ts`, which applies a real bundle
 * through the real agent.
 */
export interface BoothCacheItem {
  stationId: string;
  /**
   * `booth_config_version.id`. The number alone will not do: the spin row the
   * box writes carries a NOT NULL reference to this row.
   */
  configVersionId: string;
  /** `booth_config_version.version` — the number the box reports and draws under. */
  version: number;
  /** SHA-256 over the canonical JSON of `bundle` AS STORED. */
  bundleHash: string;
  /**
   * `{ schemaVersion, settings, layout, prizes }`, plus `voucherDefinitions`
   * when a type the prizes use had a title or an instruction at the publish
   * (SCRUM-400), exactly as published. `settings` carries the booth's voucher
   * slip choices (`voucherShowLogo`, `voucherHeaderText`, `voucherFooterText`,
   * `voucherShowStaff`, `voucherShowTerms`, SCRUM-471) only where they differ
   * from today's slip; the box resolves them with `boothVoucherSlip` in
   * `@oto/shared`, and this passes them through untouched with the rest.
   */
  bundle: unknown;
  /**
   * Who may sign in AT THIS BOOTH — `booth.booth_staff_assignment`, not the
   * `staff` scope, which answers the much wider question of who may work at
   * the branch. Served whole: withdrawal of access travels on the deny-list,
   * which the `staff` scope may not be served without.
   */
  allowedStaff: string[];
  /**
   * The terms and the expiry for the paper, as they are now, for the
   * definitions this bundle's prizes point at — beside the frozen bundle,
   * because a booth with no internet still has to print a slip that says what
   * the prize is worth and when it runs out.
   *
   * The bundle carries only a prize's own days, so when a prize names none
   * the box reads its type's expiry from here, when a voucher is won. It
   * carries terms only for a type that had a title or an instruction when it
   * was published (SCRUM-400), and for those the box prints the bundle's, so
   * an edit waits for a publish; every other type's terms are printed from
   * here, a type worded since that publish included. A changed expiry, and
   * the changed terms of a type the running bundle carries no words for,
   * therefore reach paper at the box's next pull, with no publish — the rule
   * in full is the note at the top of `voucher-definitions.ts`.
   */
  voucherDefinitions: Array<{
    id: string;
    termsEn: string | null;
    termsTh: string | null;
    expiryDays: number | null;
  }>;
}

/**
 * The voucher definitions a published bundle's prizes point at.
 *
 * Read out of the bundle rather than off the booth's live `booth_prize` rows,
 * because the bundle is the frozen thing: a prize archived or re-pointed since
 * the publish is still on the wheel the box is running, and its definition is
 * still what the paper has to say.
 *
 * Walked defensively instead of parsed against `BoothConfigBundleSchema`. A
 * bundle this api cannot fully validate — one published by a newer build, with
 * a field this one has never heard of — must still reach the box, which
 * validates it itself; refusing to serve it here would take a working booth
 * off the air over a field nothing in this function reads.
 */
function definitionIdsIn(bundle: unknown): string[] {
  const prizes = (bundle as { prizes?: unknown })?.prizes;
  if (!Array.isArray(prizes)) return [];
  const ids = new Set<string>();
  for (const prize of prizes) {
    const id = (prize as { voucherDefinitionId?: unknown })?.voucherDefinitionId;
    if (typeof id === 'string' && id.length > 0) ids.add(id);
  }
  return [...ids];
}

/**
 * The `booth` cache scope: what each booth on this box should be running.
 *
 * **The bundle is served as stored and never re-serialised.** `bundle_hash` is
 * taken over the canonical JSON of the document that was published, and a
 * round trip through a zod object would drop any key this api does not know
 * about — so a box built after a field was added would disagree with the cloud
 * about the hash of every bundle carrying it. It is passed through whole, and
 * the box compares the hash.
 *
 * **A booth with nothing published contributes no item**, rather than one with
 * nulls in it: there is no wheel to run, the agent skips a scope entry that is
 * not there, and a half-populated one would be something for a reader to
 * interpret.
 *
 * One query per booth, which is one or two per box: a station list this small
 * does not earn a window function, and `booth_config_version_unique` on
 * (station, version) is the index each of them reads.
 *
 * **What is personal here, and what is not.** A published wheel is prize
 * names, colours, weights and printed terms — nothing about anybody. The
 * exception is `allowedStaff`, which is a list of opaque account ids and the
 * least a booth can be given and still refuse a sign-in: no name, no phone, no
 * PIN and no hash. Those live on the `staff` scope, which the api will not
 * serve without the deny-list beside it. Same rule as the rest of the bundle,
 * for the same reason: it is going to a Raspberry Pi in a shopping mall that
 * anybody can carry out of a storeroom.
 */
export async function boothCacheItems(db: Db, auth: BoxAuth): Promise<BoothCacheItem[]> {
  const booths = await db
    .select({ id: station.id })
    .from(station)
    .where(
      and(eq(station.boxId, auth.boxId), eq(station.kind, 'booth'), isNull(station.archivedAt)),
    )
    .orderBy(asc(station.name));

  const items: BoothCacheItem[] = [];
  for (const booth of booths) {
    const [current] = await db
      .select({
        id: boothConfigVersion.id,
        version: boothConfigVersion.version,
        bundle: boothConfigVersion.bundle,
        bundleHash: boothConfigVersion.bundleHash,
      })
      .from(boothConfigVersion)
      .where(eq(boothConfigVersion.stationId, booth.id))
      /**
       * The current wheel is the highest version there is. No `active` flag,
       * deliberately: a second source of truth about which one is live is the
       * thing that goes wrong at three in the afternoon.
       */
      .orderBy(desc(boothConfigVersion.version))
      .limit(1);
    if (!current) continue;

    const staff = await db
      .select({ accountId: boothStaffAssignment.accountId })
      .from(boothStaffAssignment)
      .where(eq(boothStaffAssignment.stationId, booth.id))
      .orderBy(asc(boothStaffAssignment.accountId));

    const wanted = definitionIdsIn(current.bundle);
    const definitions = wanted.length
      ? await db
          .select({
            id: voucherDefinition.id,
            termsEn: voucherDefinition.termsEn,
            termsTh: voucherDefinition.termsTh,
            expiryDays: voucherDefinition.expiryDays,
          })
          .from(voucherDefinition)
          .where(
            and(
              eq(voucherDefinition.operatorId, auth.operatorId),
              inArray(voucherDefinition.id, wanted),
            ),
          )
          .orderBy(asc(voucherDefinition.id))
      : [];

    items.push({
      stationId: booth.id,
      configVersionId: current.id,
      version: current.version,
      bundleHash: current.bundleHash,
      bundle: current.bundle,
      allowedStaff: staff.map((s) => s.accountId),
      voucherDefinitions: definitions,
    });
  }
  return items;
}
