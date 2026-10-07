/**
 * DEMO BRANCH 2'S OWN BOOTH, AND ITS DAY (S2-15b, SCRUM-216; plan
 * docs/progress/plans/analytics/PLAN.md §5, §8 round 5, hazard H12).
 *
 * WHY. Console > Booths > Report reads `analytics.fact_booth_daily`, which the
 * booth rollup fills from `booth.spin` and the vouchers the spins issued. The
 * demo day made no booth activity, so the report at Demo Branch 2 said "No
 * spins in these days" on every date the demo control had filled.
 *
 * WHAT IT WRITES. Once, when there is no such booth: a booth at Demo Branch 2
 * (`Demo Booth 1`, code prefix `DB`), its settings, a three-slice wheel of the
 * park's money vouchers with their cost prices, version 1 of that wheel, and
 * the demo cashier on its staff list. After that the Console owns the booth and
 * the seed writes none of it again (`ensureDemoBooth`). Per demo day: a handful
 * of presses at that booth (`DEMO_BOOTH_DAY`), each drawn from the wheel the
 * booth runs and with the voucher it printed. The demo day's
 * `voucher-discount` sale redeems one more voucher won at this booth that
 * morning (`writeDemoBoothPress`, from `demo-day.ts`), which is how some of the
 * day's vouchers are redeemed: a voucher is only ever used up by a sale.
 *
 * SHAPED AS THE BOOTH WRITES THEM. The rows are the ones `services/sync-booth.ts`
 * files when a booth's box reports a press: the spin (never `simulated` — H12
 * keeps simulated spins out of the figures, and these are presses the figures
 * are for), the voucher (source `booth`, its code minted by `mintBoothCode`
 * from the booth's prefix, its cost frozen from the prize and its expiry the
 * box's own rule), the paper (`booth.voucher_print`, the automatic first print,
 * printed), and the signed-in person's place on the day's roster
 * (`selfAssignBoothDuty`'s `self_assigned` row).
 *
 * WHAT IT NEVER TOUCHES. No real branch, booth, prize, wheel version or staff
 * list is written — FWBooth1 and the park's Booth 1 included. Three operator-wide
 * things are READ: the booth design (`Classic wheel`, a layout is shared by
 * every booth of the operator), the money voucher types the prizes point at,
 * and the live booths' code prefixes, so the demo booth is never made with a
 * prefix another booth prints under.
 *
 * A BOX NOBODY SEES. A spin names the box that filed it (`booth.spin.box_id`
 * is not null), so the booth stands on a box of its own: never registered, no
 * secret, no claim code, and archived from the start. Health's fleet, End of
 * Day's box check and the watchdog read live boxes only, so Demo Branch 2 never
 * shows a box waiting to be claimed (the promise `ensureDemoBranch` makes); and
 * with no secret and no claim code nothing can ever sign in as it, so no wheel
 * is ever served from it. The booth itself stays live, so Console > Booths at
 * Demo Branch 2 lists it with its wheel; it is `selected_staff` with nobody on
 * that list, so no till's station picker ever offers it.
 *
 * IDEMPOTENT, PER PRESS. A press's ids derive from the day's keys (`demoDayRef`
 * in `demo-day.ts`), so a rerun finds each press already filed and writes
 * nothing; a day pressed before this file existed gets its presses on the next
 * run. Each press is its own transaction under its own advisory lock, so two
 * presses of the control at once write each press once.
 */
import { createHash, randomInt } from 'node:crypto';
import {
  addDaysToIsoDate,
  BOOTH_CODE_MINT_ATTEMPTS,
  BoothConfigPrizeSchema,
  isoDateInTz,
  mintBoothCode,
  newId,
  satangFromBaht,
} from '@oto/shared';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../index';
import * as s from '../schema/index';
import { stableId, stableJson } from './stable-id';

const b = satangFromBaht;
type SeedWriter = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Demo Branch 2's booth. Found by name at the demo branch. */
export const DEMO_BOOTH_NAME = 'Demo Booth 1';
/**
 * Two letters or digits (`mintBoothCode`): the first two characters of every
 * code this booth prints, and distinct from the demo till's `D2` so the
 * branch's prefix index holds.
 */
export const DEMO_BOOTH_PREFIX = 'DB';
/** The box the booth stands on, by its slot at the demo branch. */
const DEMO_BOOTH_BOX_SLOT = 'demo-booth-1';
const DEMO_BOOTH_BOX_NAME = 'Demo booth box';
/** The operator's shared booth design the wheel is drawn with (seed/index.ts). */
const DEMO_BOOTH_LAYOUT_NAME = 'Classic wheel';

/**
 * The wheel: the park's three money vouchers, each with what the park gives up
 * when it is won — the face value, as the park's own seed costs them — so the
 * report's prize cost is a figure rather than "not costed yet". Weights in
 * basis points, adding to exactly 10,000 (D4).
 *
 * The first is the one the demo day cannot do without (its voucher sale spends
 * one). A long-lived database whose voucher types were since re-coded may lack
 * the others: the wheel is then made of the types it has, re-weighted to
 * 10,000, and a press of the day that would have drawn a missing one draws the
 * first instead (`prizeOf`).
 */
const DEMO_BOOTH_PRIZES = [
  { definition: 'spin-voucher-100', nameEn: '100 THB Voucher', nameTh: 'บัตรกำนัล 100 บาท', wheelLabel: '100 ฿', weightBp: 5000, sliceColor: '#FFE72E', costSatang: b(100) },
  { definition: 'spin-voucher-150', nameEn: '150 THB Voucher', nameTh: 'บัตรกำนัล 150 บาท', wheelLabel: '150 ฿', weightBp: 3000, sliceColor: '#FF8A3D', costSatang: b(150) },
  { definition: 'spin-voucher-200', nameEn: '200 THB Voucher', nameTh: 'บัตรกำนัล 200 บาท', wheelLabel: '200 ฿', weightBp: 2000, sliceColor: '#55B9FF', costSatang: b(200) },
] as const;

/** A voucher type's code, as the wheel's prizes name it. */
export type DemoBoothPrizeCode = (typeof DEMO_BOOTH_PRIZES)[number]['definition'];

const HOUR = 60;

/**
 * THE BOOTH'S DAY, in minutes after the branch's day start (05:00): a family
 * at the wheel every hour or two across the mall's afternoon. None of these
 * vouchers is redeemed the same day — the one that is belongs to the
 * `voucher-discount` sale, which wins it here at 11:10 and spends it at 13:55.
 *
 * `key` is half of every row's id. Never renumber one: a key changed orphans
 * a press on every database this has already run against.
 */
const DEMO_BOOTH_DAY: ReadonlyArray<{ key: string; atMinutes: number; prize: DemoBoothPrizeCode }> = [
  { key: 'press-1', atMinutes: 5 * HOUR + 35, prize: 'spin-voucher-150' }, // 10:35
  { key: 'press-2', atMinutes: 6 * HOUR + 50, prize: 'spin-voucher-100' }, // 11:50
  { key: 'press-3', atMinutes: 7 * HOUR + 40, prize: 'spin-voucher-200' }, // 12:40
  { key: 'press-4', atMinutes: 9 * HOUR + 25, prize: 'spin-voucher-100' }, // 14:25
  { key: 'press-5', atMinutes: 11 * HOUR + 15, prize: 'spin-voucher-150' }, // 16:15
];

interface DemoBoothPrize {
  id: string;
  voucherDefinitionId: string;
  costSatang: number;
  /** The prize's own expiry, else its type's (`resolveExpiry` on the box). */
  expiryDays: number | null;
}

export interface DemoBooth {
  stationId: string;
  boxId: string;
  branchId: string;
  operatorId: string;
  timezone: string;
  configVersionId: string;
  codePrefix: string;
  prizes: ReadonlyMap<DemoBoothPrizeCode, DemoBoothPrize>;
}

/** Who is signed in at the booth: an account, and the name the day's roster shows. */
export interface DemoBoothStaff {
  accountId: string;
  displayName: string;
}

/**
 * Demo Branch 2's booth, made once and found after.
 *
 * MADE ONCE. When there is no live `Demo Booth 1` at the demo branch, this
 * makes one: the box it stands on, the station, its settings, its prizes
 * (`DEMO_BOOTH_PRIZES`), version 1 of its wheel, and the demo cashier on its
 * staff list — all in one transaction, under one lock per operator, so two
 * presses at once make one booth. The prefix is checked first against the
 * Console's own rule: no two live booths of an operator share one.
 *
 * FOUND AFTER, AND LEFT ALONE. Once the booth exists the Console owns it: its
 * prizes, its wheel and its staff list are never written again, so a prize
 * somebody archived, renamed or re-costed, and a person somebody took off the
 * list, stay as they left them.
 *
 * WHAT A PRESS DRAWS. The slices of the wheel the booth runs — its latest
 * published version — read from that version's bundle, as a box draws from
 * the bundle it was served and never from the live prize rows a Console edit
 * may have changed since the publish. A slice is drawable as the box judges
 * one (`judgePrizes` in @oto/box-agent): active, weighted above zero, and
 * pointing at a voucher type. Its cost is the bundle's, and its expiry the
 * bundle's days, else its type's as the box reads them now (`resolveExpiry`).
 */
export async function ensureDemoBooth(
  db: Db,
  branch: { id: string; operatorId: string; timezone: string },
  staff: { accountId: string; addedByAccountId: string },
): Promise<DemoBooth> {
  const { id: branchId, operatorId } = branch;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${operatorId}), hashtext('demo-day/booth'))`);

    let [station] = await tx
      .select({ id: s.station.id, codePrefix: s.station.codePrefix, boxId: s.station.boxId })
      .from(s.station)
      .where(and(eq(s.station.branchId, branchId), eq(s.station.name, DEMO_BOOTH_NAME), isNull(s.station.archivedAt)))
      .limit(1);
    let made = false;
    if (!station) {
      station = await makeDemoBoothStation(tx, { branchId, operatorId });
      made = true;
    }
    if (!station.codePrefix) {
      throw new Error(`${DEMO_BOOTH_NAME} at the demo branch has no code prefix, so it prints no voucher. Give it one in Console > Booths.`);
    }
    if (!station.boxId) {
      throw new Error(`${DEMO_BOOTH_NAME} at the demo branch stands on no box, so nothing runs its wheel.`);
    }

    // The wheel the booth runs: its latest published version.
    let [version] = await tx
      .select({ id: s.boothConfigVersion.id, bundle: s.boothConfigVersion.bundle })
      .from(s.boothConfigVersion)
      .where(eq(s.boothConfigVersion.stationId, station.id))
      .orderBy(desc(s.boothConfigVersion.version))
      .limit(1);
    if (!version) {
      // A booth this run did not make, with no wheel published: somebody is
      // setting it up in the Console, and the seed does not publish for them.
      if (!made) {
        throw new Error(
          `${DEMO_BOOTH_NAME} at the demo branch has no published wheel. Publish it from Console > Booths, then add the demo day again.`,
        );
      }
      version = await makeDemoWheel(tx, { stationId: station.id, branchId, operatorId, staff });
    }

    const prizes = await drawableSlices(tx, operatorId, version.bundle);
    if (!prizes.has(DEMO_BOOTH_PRIZES[0].definition)) {
      throw new Error(
        `${DEMO_BOOTH_NAME}'s published wheel has no "${DEMO_BOOTH_PRIZES[0].nameEn}" slice to draw, and the demo day's voucher sale spends one. ` +
          'Put one back on the wheel and publish it from Console > Booths.',
      );
    }

    return {
      stationId: station.id,
      boxId: station.boxId,
      branchId,
      operatorId,
      timezone: branch.timezone,
      configVersionId: version.id,
      codePrefix: station.codePrefix,
      prizes,
    };
  });
}

/**
 * The booth's station, on a box of its own, made once. Refused before anything
 * is written when another live booth of the operator already prints under the
 * prefix: the Console's operator-wide rule (`assertBoothCodePrefixFree` in the
 * api's services/fleet.ts), because the prefix starts every code a booth
 * prints and two booths sharing one mint from one code space.
 */
async function makeDemoBoothStation(
  tx: SeedWriter,
  input: { branchId: string; operatorId: string },
): Promise<{ id: string; codePrefix: string | null; boxId: string | null }> {
  const { branchId, operatorId } = input;
  const [other] = await tx
    .select({ name: s.station.name, branchName: s.branch.name })
    .from(s.station)
    .innerJoin(s.branch, eq(s.branch.id, s.station.branchId))
    .where(
      and(
        eq(s.station.operatorId, operatorId),
        eq(s.station.kind, 'booth'),
        eq(s.station.codePrefix, DEMO_BOOTH_PREFIX),
        isNull(s.station.archivedAt),
      ),
    )
    .limit(1);
  if (other) {
    throw new Error(
      `Code prefix ${DEMO_BOOTH_PREFIX} is already used by ${other.name} at ${other.branchName}, so the demo booth cannot be made with it. ` +
        'Every booth needs a prefix of its own, because it starts every voucher code the booth prints.',
    );
  }

  // The box: archived from birth, never registered. See the note at the top.
  // A booth made again after the last was archived stands on the same box.
  let [box] = await tx
    .select({ id: s.box.id })
    .from(s.box)
    .where(and(eq(s.box.branchId, branchId), eq(s.box.slot, DEMO_BOOTH_BOX_SLOT)))
    .orderBy(asc(s.box.createdAt))
    .limit(1);
  if (!box) {
    box = { id: newId() };
    await tx.insert(s.box).values({
      id: box.id,
      operatorId,
      branchId,
      name: DEMO_BOOTH_BOX_NAME,
      slot: DEMO_BOOTH_BOX_SLOT,
      role: 'booth',
      status: 'unclaimed',
      archivedAt: new Date(),
    });
  }

  const id = newId();
  await tx.insert(s.station).values({
    id,
    operatorId,
    branchId,
    boxId: box.id,
    name: DEMO_BOOTH_NAME,
    kind: 'booth',
    codePrefix: DEMO_BOOTH_PREFIX,
    // A booth's behaviour is its kind; capabilities describe a till.
    capabilities: [],
    // Nobody is on its list, so no station picker offers it.
    accessScope: 'selected_staff',
  });
  return { id, codePrefix: DEMO_BOOTH_PREFIX, boxId: box.id };
}

/**
 * The new booth's wheel, made once with the booth: its settings, its prizes,
 * version 1 read back from them as the park's seed reads its own, and the demo
 * cashier on its staff list. Never run for a booth that already has a wheel.
 */
async function makeDemoWheel(
  tx: SeedWriter,
  input: { stationId: string; branchId: string; operatorId: string; staff: { accountId: string; addedByAccountId: string } },
): Promise<{ id: string; bundle: unknown }> {
  const { stationId, branchId, operatorId, staff } = input;

  const [layout] = await tx
    .select()
    .from(s.boothLayout)
    .where(and(eq(s.boothLayout.operatorId, operatorId), isNull(s.boothLayout.archivedAt)))
    .orderBy(sql`${s.boothLayout.name} = ${DEMO_BOOTH_LAYOUT_NAME} desc`, asc(s.boothLayout.createdAt))
    .limit(1);
  if (!layout) throw new Error('No booth design to give the demo booth. Run `pnpm db:seed` first.');

  await tx
    .insert(s.boothSettings)
    .values({ stationId, operatorId, branchId, layoutId: layout.id, buttonKey: 'Space', eligibility: 'none' })
    .onConflictDoNothing({ target: s.boothSettings.stationId });

  // The voucher types the wheel's prizes point at, by code (operator-wide).
  const types = new Map<string, string>();
  for (const row of await tx
    .select({ id: s.voucherDefinition.id, code: s.voucherDefinition.code })
    .from(s.voucherDefinition)
    .where(
      and(
        eq(s.voucherDefinition.operatorId, operatorId),
        inArray(s.voucherDefinition.code, DEMO_BOOTH_PRIZES.map((p) => p.definition)),
      ),
    )) {
    types.set(row.code, row.id);
  }
  if (!types.has(DEMO_BOOTH_PRIZES[0].definition)) {
    throw new Error(`No voucher type "${DEMO_BOOTH_PRIZES[0].definition}" for the demo booth's wheel. Run \`pnpm db:seed\` first.`);
  }
  const onWheel = DEMO_BOOTH_PRIZES.filter((p) => types.has(p.definition));
  // Re-weighted over the types present, to exactly 10,000 (D4); the first takes the rounding.
  const total = onWheel.reduce((sum, p) => sum + p.weightBp, 0);
  const weights = onWheel.map((p) => Math.floor((p.weightBp * 10_000) / total));
  weights[0]! += 10_000 - weights.reduce((sum, w) => sum + w, 0);
  for (const [sortOrder, p] of onWheel.entries()) {
    const { definition: code, ...fields } = p;
    await tx.insert(s.boothPrize).values({
      id: newId(),
      operatorId,
      branchId,
      stationId,
      voucherDefinitionId: types.get(code)!,
      textColor: '#111111',
      sortOrder,
      ...fields,
      weightBp: weights[sortOrder]!,
    });
  }

  // Version 1 of the wheel, read back from the rows as the park's seed does.
  const prizeRows = await tx
    .select()
    .from(s.boothPrize)
    .where(and(eq(s.boothPrize.stationId, stationId), isNull(s.boothPrize.archivedAt)))
    .orderBy(s.boothPrize.sortOrder);
  const bundle = {
    schemaVersion: 1,
    settings: { eligibility: 'none', buttonKey: 'Space', dailySpinCap: null },
    layout: {
      id: layout.id,
      name: layout.name,
      version: layout.version,
      design: layout.design,
      assetManifest: layout.assetManifest,
    },
    prizes: prizeRows.map((p) => ({
      id: p.id,
      nameEn: p.nameEn,
      nameTh: p.nameTh,
      wheelLabel: p.wheelLabel,
      weightBp: p.weightBp,
      active: p.active,
      dailyCap: p.dailyCap,
      expiryDays: p.expiryDays,
      costSatang: p.costSatang,
      sliceColor: p.sliceColor,
      textColor: p.textColor,
      sortOrder: p.sortOrder,
      voucherDefinitionId: p.voucherDefinitionId,
    })),
  };
  const id = newId();
  await tx.insert(s.boothConfigVersion).values({
    id,
    operatorId,
    branchId,
    stationId,
    version: 1,
    layoutId: layout.id,
    bundle,
    bundleHash: createHash('sha256').update(stableJson(bundle)).digest('hex'),
    // Nobody published it — it came from the demo seed, and the column says so.
    publishedByAccountId: null,
    note: 'Seeded demo wheel: the three money vouchers, at their face value.',
  });

  // The demo cashier may sign in here: the standing list a booth's box checks.
  await tx
    .insert(s.boothStaffAssignment)
    .values({ id: newId(), stationId, accountId: staff.accountId, addedBy: staff.addedByAccountId })
    .onConflictDoNothing({ target: [s.boothStaffAssignment.stationId, s.boothStaffAssignment.accountId] });

  return { id, bundle };
}

/**
 * What the presses draw, by voucher type: the first drawable slice of each of
 * the demo's types on a published bundle, in the bundle's slice order. Read
 * from the bundle, never from the live `booth_prize` rows (see
 * `ensureDemoBooth`), so every press names a slice of the very version that
 * drew it, at the cost that version froze.
 */
async function drawableSlices(
  tx: SeedWriter,
  operatorId: string,
  bundle: unknown,
): Promise<Map<DemoBoothPrizeCode, DemoBoothPrize>> {
  const read = BoothConfigPrizeSchema.array().safeParse((bundle as { prizes?: unknown } | null)?.prizes);
  if (!read.success) throw new Error(`${DEMO_BOOTH_NAME}'s published wheel could not be read.`);
  // As the box judges a slice before it draws: active, weighted above zero, and
  // winning a voucher type (a slice with none cannot be published).
  const drawable = read.data.filter((p) => p.active && p.weightBp > 0 && p.voucherDefinitionId !== null);
  const typeIds = [...new Set(drawable.map((p) => p.voucherDefinitionId!))];
  // The types as the box reads them now: their codes, and the expiry it falls back to.
  const types = new Map<string, { code: string; expiryDays: number | null }>();
  if (typeIds.length > 0) {
    for (const row of await tx
      .select({ id: s.voucherDefinition.id, code: s.voucherDefinition.code, expiryDays: s.voucherDefinition.expiryDays })
      .from(s.voucherDefinition)
      .where(and(eq(s.voucherDefinition.operatorId, operatorId), inArray(s.voucherDefinition.id, typeIds)))) {
      types.set(row.id, { code: row.code, expiryDays: row.expiryDays });
    }
  }
  const prizes = new Map<DemoBoothPrizeCode, DemoBoothPrize>();
  for (const slice of drawable) {
    const type = types.get(slice.voucherDefinitionId!);
    if (!type) continue;
    const code = type.code as DemoBoothPrizeCode;
    if (prizes.has(code) || !DEMO_BOOTH_PRIZES.some((p) => p.definition === code)) continue;
    prizes.set(code, {
      id: slice.id,
      voucherDefinitionId: slice.voucherDefinitionId!,
      costSatang: slice.costSatang,
      expiryDays: slice.expiryDays ?? type.expiryDays ?? null,
    });
  }
  return prizes;
}

/** What one press left: the voucher it printed. */
export interface DemoBoothPress {
  spinId: string;
  voucherId: string;
  code: string;
}

/**
 * One press of the red button, filed as `sync-booth.ts` files a box's report
 * of it: the voucher the box minted (status `issued`, the prize's cost frozen
 * on it, the box's expiry), the spin naming it, the automatic first print and
 * the person on the day's roster. On the caller's transaction, which holds the
 * press's lock. `key` names every id, so the same press is the same rows.
 */
export async function writeDemoBoothPress(
  writer: SeedWriter,
  booth: DemoBooth,
  input: {
    key: string;
    actionId: string;
    on: string;
    at: Date;
    prize: DemoBoothPrizeCode;
    staff: DemoBoothStaff;
  },
): Promise<DemoBoothPress> {
  const prize = prizeOf(booth, input.prize);
  const spinId = stableId(`${input.key}/spin`, input.at);
  const voucherId = stableId(`${input.key}/voucher`, input.at);

  // The box's expiry: to the end of the date the voucher was won on, plus the
  // days, in the branch's timezone (`resolveExpiry` in @oto/box-agent).
  const expiresAt =
    prize.expiryDays === null
      ? null
      : new Date(lastMomentOfDate(addDaysToIsoDate(isoDateInTz(input.at, booth.timezone), prize.expiryDays), booth.timezone));

  // A code the operator already holds is drawn again, as the box does
  // (`mintUnusedCode`): the unique index is what a repeat collides with.
  let code: string | null = null;
  for (let attempt = 0; attempt < BOOTH_CODE_MINT_ATTEMPTS && code === null; attempt += 1) {
    const candidate = mintBoothCode(booth.codePrefix, (max) => randomInt(max));
    const inserted = await writer
      .insert(s.voucher)
      .values({
        id: voucherId,
        operatorId: booth.operatorId,
        branchId: booth.branchId,
        voucherDefinitionId: prize.voucherDefinitionId,
        code: candidate,
        source: 'booth',
        status: 'issued',
        costSatang: prize.costSatang,
        issuedByAccountId: input.staff.accountId,
        issuedAt: input.at,
        expiresAt,
        // The automatic first print, below, came out: one copy of this code.
        printCount: 1,
      })
      .onConflictDoNothing({ target: [s.voucher.operatorId, s.voucher.code] })
      .returning({ id: s.voucher.id });
    if (inserted.length > 0) code = candidate;
  }
  if (code === null) throw new Error('Could not mint an unused voucher code for the demo booth.');

  await writer.insert(s.spin).values({
    id: spinId,
    operatorId: booth.operatorId,
    branchId: booth.branchId,
    stationId: booth.stationId,
    boxId: booth.boxId,
    boothConfigVersionId: booth.configVersionId,
    outcome: 'prize',
    prizeId: prize.id,
    voucherId,
    staffAccountId: input.staff.accountId,
    clockSuspect: false,
    // A child at the wheel, never the `#debug` distribution run (H12).
    simulated: false,
    occurredAt: input.at,
    businessDate: input.on,
    receivedAt: input.at,
    actionId: input.actionId,
  });

  await writer.insert(s.voucherPrint).values({
    id: stableId(`${input.key}/print`, input.at),
    operatorId: booth.operatorId,
    branchId: booth.branchId,
    boxId: booth.boxId,
    stationId: booth.stationId,
    voucherId,
    printJobId: stableId(`${input.key}/print-job`, input.at),
    reason: 'initial',
    // The automatic first print names nobody; a reprint would.
    requestedByAccountId: null,
    queuedAt: input.at,
    actionId: input.actionId,
  });

  // The signed-in person joins the day's roster, once (`selfAssignBoothDuty`).
  await writer
    .insert(s.boothDutyAssignment)
    .values({
      id: newId(),
      operatorId: booth.operatorId,
      branchId: booth.branchId,
      stationId: booth.stationId,
      businessDate: input.on,
      accountId: input.staff.accountId,
      displayName: input.staff.displayName,
      source: 'self_assigned',
    })
    .onConflictDoNothing();

  return { spinId, voucherId, code };
}

export interface DemoBoothDayCounts {
  /** Presses this run filed. */
  written: number;
  /** Presses already filed for this day, left alone. */
  present: number;
}

/**
 * The booth's day (`DEMO_BOOTH_DAY`): each press filed once. A day the demo
 * control filled before the booth existed gets its presses on the next run;
 * a day that has them writes nothing.
 */
export async function seedDemoBoothDay(
  db: Db,
  booth: DemoBooth,
  input: {
    on: string;
    /** The day's keys (`demoDayRef` in demo-day.ts): `key` names ids, `action` the action ids. */
    ref: { key: (scenario: string) => string; action: (scenario: string) => string };
    instantAt: (minutesIntoDay: number) => Date;
    staff: DemoBoothStaff;
  },
): Promise<DemoBoothDayCounts> {
  const counts: DemoBoothDayCounts = { written: 0, present: 0 };
  for (const press of DEMO_BOOTH_DAY) {
    await db.transaction(async (writer) => {
      const scenario = `booth/${press.key}`;
      const actionId = input.ref.action(scenario);
      await writer.execute(sql`select pg_advisory_xact_lock(hashtext(${booth.operatorId}), hashtext(${actionId}))`);
      const at = input.instantAt(press.atMinutes);
      const key = input.ref.key(scenario);
      const [filed] = await writer
        .select({ id: s.spin.id })
        .from(s.spin)
        .where(eq(s.spin.id, stableId(`${key}/spin`, at)))
        .limit(1);
      if (filed) {
        counts.present += 1;
        return;
      }
      await writeDemoBoothPress(writer, booth, { key, actionId, on: input.on, at, prize: press.prize, staff: input.staff });
      counts.written += 1;
    });
  }
  return counts;
}

/**
 * The prize a press draws: the one asked for, or — on a wheel without it, its
 * voucher type missing or its slice taken off the wheel — the first prize, which
 * `ensureDemoBooth` makes sure the running wheel has.
 */
function prizeOf(booth: DemoBooth, code: DemoBoothPrizeCode): DemoBoothPrize {
  return booth.prizes.get(code) ?? booth.prizes.get(DEMO_BOOTH_PRIZES[0].definition)!;
}

/** Every press the demo booth has on a trading day, whichever run filed it. */
export async function demoBoothSpinsOn(db: Db, booth: Pick<DemoBooth, 'stationId'>, on: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(s.spin)
    .where(and(eq(s.spin.stationId, booth.stationId), eq(s.spin.businessDate, on)));
  return Number(row?.n ?? 0);
}

/**
 * The last instant of a calendar date in a timezone, as the box computes a
 * voucher's expiry (`lastMomentOfDate` in @oto/box-agent's booth.ts): a binary
 * search for the moment the zone's date turns over.
 */
function lastMomentOfDate(isoDate: string, timeZone: string): number {
  const nextMidnightUtc = Date.parse(`${addDaysToIsoDate(isoDate, 1)}T00:00:00.000Z`);
  let onTheDate = nextMidnightUtc - 15 * 3_600_000;
  let pastIt = nextMidnightUtc + 13 * 3_600_000;
  while (pastIt - onTheDate > 1) {
    const middle = Math.floor((onTheDate + pastIt) / 2);
    if (isoDateInTz(new Date(middle), timeZone) > isoDate) pastIt = middle;
    else onTheDate = middle;
  }
  return onTheDate;
}
