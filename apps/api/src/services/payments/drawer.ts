import { and, asc, eq, isNull } from 'drizzle-orm';
import { box, device, station, stationDevice, type Db } from '@oto/db';
import { newId, PaymentRoutingSchema } from '@oto/shared';
import { queueCommand } from '../fleet';
import type { Exec, OpContext } from '../tx';

/**
 * OPENING THE CASH DRAWER WHEN CASH IS TAKEN (S2-10a, SCRUM-206, decision O-4).
 *
 * The drawer has no network address and no box connection of its own: the
 * pulse rides the receipt printer's RJ11 (`DEVICE_INVENTORY.md` §7.3, and
 * `packages/box-agent/src/printing/queue.ts:100-115` — "whether a drawer
 * opens is a property of the SALE … while whether a drawer exists is a
 * property of the printer"). So the cloud does not talk to a drawer; it tells
 * the box that this sale took cash, and the box pulses the printer the station
 * prints its receipts on.
 *
 * WHY IT IS A `drawer_kick` BOX COMMAND AND NOT AN `edge.print_job` ROW, which
 * is a deliberate departure from the plan's sketch of O-4(a) and is worth the
 * paragraph.
 *
 * The plan reads `edge.print_job.kind` as free text (it is: no CHECK) and
 * concludes that a `drawer_kick` job needs no migration. True of the database
 * and false of everything above it: the column is `$type<PrintKind>()`, and
 * `PrintKind` is a closed union that exists in THREE copies — `@oto/shared`,
 * `@oto/print/templates/model.ts` and the renderer's `buildDocument` switch —
 * which `apps/api/test/print-api.test.ts` compares key for key. A tenth
 * printout would therefore mean a new word in a package this slice does not
 * own, a document builder for a job that never puts ink on paper, and a
 * vocabulary that S2-13 deletes again the moment a real receipt prints and
 * carries `finish.drawerKick` itself. `drawer_kick` is ALREADY a box command
 * kind, landed by Slice A in all four copies, and its own comment in
 * `packages/box-agent/src/protocol.ts:447-454` says why it is a command: "the
 * platform does not print a receipt on finalise yet, and a drawer that opens
 * only when there is paper to print would be a till nobody could take cash
 * at." This uses that.
 *
 * WHAT IS NOT BUILT HERE AND MUST BE, for the drawer to physically open: the
 * agent's `case 'drawer_kick'` in `packages/box-agent/src/agent.ts`, which is
 * owned by the box slices. Until it lands the command is delivered and
 * answered `UNKNOWN_COMMAND`, which `protocol.ts:414-416` calls survivable —
 * the sale is recorded, the money is recorded, and the Console shows the box
 * could not do it. The payload below already carries what that handler needs:
 * the station, the role the pulse rides, and `finish.drawerKick`, which is the
 * flag the print queue already honours (`queue.ts:103-113`).
 */

/** What the box is asked to do, resolved while the sale's transaction is open. */
export interface DrawerKick {
  boxId: string;
  branchId: string;
  stationId: string;
  /** The printer the pulse rides, as the cloud can see it. Null lets the box route it. */
  deviceId: string | null;
  saleId: string;
  attemptId: string;
  /** `x-oto-action-id` — the same one on the sale, the attempt and the Box log line. */
  actionId: string;
}

/**
 * The station device role the pulse rides.
 *
 * NOT `cash_drawer`, which is the role a drawer is ASSIGNED to so that a
 * station can say it has one. The bytes go to the receipt printer, because
 * that is what the RJ11 hangs off, and `ROLE_FOR_KIND` in the box's print
 * queue routes every receipt-shaped job the same way.
 */
const DRAWER_PULSE_ROLE = 'receipt';

/**
 * Should this station's drawer open, and what does the box need in order to
 * open it?
 *
 * Answers null — and writes nothing — when there is nothing to ask: a station
 * with no box, or one whose routing says this counter has no drawer. Reading
 * it takes the caller's handle so it can run inside the sale's transaction on
 * the station row that transaction already locked the sale against.
 *
 * A STATION THAT HAS NEVER BEEN CONFIGURED STILL KICKS. `payment_routing` is
 * absent on every station the platform has today, and the park's tills all
 * have a drawer; a rule that waited for the Console to say so would mean cash
 * taken at a counter nobody could open. `cash: 'none'` is how a station says
 * it has no drawer, and it is honoured.
 */
export async function resolveDrawerKick(
  db: Exec,
  input: {
    stationRow: typeof station.$inferSelect;
    saleId: string;
    attemptId: string;
    actionId: string | null;
  },
): Promise<DrawerKick | null> {
  const { stationRow } = input;
  if (!stationRow.boxId) return null;
  const routing = PaymentRoutingSchema.safeParse(stationRow.paymentRouting ?? {});
  if (routing.success && routing.data.cash === 'none') return null;

  // The printer as the cloud can see it, so the Console can say which one was
  // asked. The box re-resolves on its own side and its answer wins — it is the
  // one that knows what it can actually reach.
  const [routed] = await db
    .select({ deviceId: stationDevice.deviceId })
    .from(stationDevice)
    .innerJoin(device, eq(stationDevice.deviceId, device.id))
    .where(
      and(
        eq(stationDevice.stationId, stationRow.id),
        eq(stationDevice.role, DRAWER_PULSE_ROLE),
        eq(device.boxId, stationRow.boxId),
        isNull(device.archivedAt),
      ),
    )
    .orderBy(asc(stationDevice.deviceId))
    .limit(1);

  return {
    boxId: stationRow.boxId,
    branchId: stationRow.branchId,
    stationId: stationRow.id,
    deviceId: routed?.deviceId ?? null,
    saleId: input.saleId,
    attemptId: input.attemptId,
    /**
     * A command has to carry one, and a press that sent none still opened a
     * drawer. Minting it here says plainly that this id was the platform's and
     * not the till's — it will not match an attempt's `action_id`, because
     * there is nothing on the attempt to match.
     */
    actionId: input.actionId ?? newId(),
  };
}

/**
 * The context the kick runs under: the caller's, with the idempotency claim
 * taken off it.
 *
 * WHY, because it is the difference between a retry that works and a retry
 * that loses a sale. The till sends an `Idempotency-Key` on every finalise
 * (`apps/pos/src/api/sales.ts`, `saleFinaliseIdempotencyKey`), and the answer
 * stored under that key has to be the FINALISE's answer — it is what a
 * dropped-connection retry is replayed, and the till reads the sale and its
 * receipt number out of it. `withTx` writes whatever its transaction returned
 * into `idempotency_key.response_body` whenever the context carries a claim
 * (`services/tx.ts`), and `queueCommand` opens a transaction of its own. Hand
 * it the request's context and it runs second, under the same claim, and the
 * command's `{commandId, actionId}` overwrites the sale — so the retry is
 * answered 200 with no sale in it and nothing to print.
 *
 * One request, one stored answer. The kick keeps everything else the context
 * carries — the actor, the operator, the branch, the request id and the
 * logger — so its audit row and its log line still say which press opened the
 * drawer.
 */
function withoutIdempotencyClaim(ctx: OpContext): OpContext {
  const { idempotency: _theFinalisesClaim, ...rest } = ctx;
  return rest;
}

/**
 * Queue the kick, AFTER the sale's transaction has committed.
 *
 * The ordering is `requestTestPrint`'s and it is the right way round for the
 * same reason: a command whose sale is still uncommitted is a box being asked
 * to open a drawer for money that may yet roll back. `queueCommand` opens its
 * own transaction and writes its own audit row (`box.command.drawer_kick`),
 * which is why it cannot be folded into the caller's — and why it is given a
 * context with no idempotency claim on it, above.
 *
 * IT NEVER THROWS. An unclaimed box, an archived one, a queue that refused —
 * none of those is a reason to fail a sale whose money is already in the till
 * and whose receipt is already numbered. It is logged and the counter carries
 * on with the drawer opened by hand, which is what every till on earth does
 * when the pulse does not arrive.
 */
export async function queueDrawerKick(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  kick: DrawerKick,
): Promise<string | null> {
  try {
    const [boxRow] = await db.select().from(box).where(eq(box.id, kick.boxId)).limit(1);
    if (!boxRow) return null;
    const { commandId } = await queueCommand(db, withoutIdempotencyClaim(ctx), actor, boxRow, {
      kind: 'drawer_kick',
      payload: {
        saleId: kick.saleId,
        attemptId: kick.attemptId,
        stationId: kick.stationId,
        ...(kick.deviceId ? { deviceId: kick.deviceId } : {}),
        role: DRAWER_PULSE_ROLE,
        /** The flag the box's print queue already honours, so the pulse needs no new plumbing. */
        finish: { drawerKick: true },
      },
      actionId: kick.actionId,
    });
    return commandId;
  } catch (err) {
    ctx.log?.warn(
      { err, saleId: kick.saleId, boxId: kick.boxId, reqId: ctx.requestId },
      'the cash drawer could not be asked to open',
    );
    return null;
  }
}
