import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { branch, opsRun, type Db } from '@oto/db';
import { boothFunnelRatios, newId, parseDayStart, type BoothFunnel, type BoothReport } from '@oto/shared';
import {
  branchToday,
  claimDirtyDates,
  consumeDirtyClaim,
  releaseDirtyClaim,
  type DirtyClaim,
  type RollupBranchClock,
} from './analytics-rollup';
import type { ReportScope } from './analytics-reports';
import type { Exec, Tx } from './tx';

/**
 * S2-15b (SCRUM-216) round 5 — THE BOOTH'S DAY (plan
 * docs/progress/plans/analytics/PLAN.md §5, §7, §8 round 5; no prototype
 * screen — the plan and question 14 define it).
 *
 * `job:rollup.booth` writes `analytics.fact_booth_daily`: per branch, trading
 * day, booth, staff member signed in and prize, from `booth.spin` and the
 * vouchers the spins issued (`promo.voucher`):
 *
 *   spins               every press, the `#debug` distribution run left out
 *                       (`simulated`), whatever it landed on;
 *   vouchers_issued     the presses whose voucher reached the cloud;
 *   vouchers_redeemed   of those, the ones since redeemed — counted on the day
 *                       the voucher was SPUN, so a voucher redeemed a week
 *                       later re-marks that day (migration 0065's trigger) and
 *                       a day's redemption rate is its own vouchers';
 *   redemption_lag_sum_s  seconds from issue to redemption, summed over them;
 *   prize_cost_satang   what the prizes won cost the park, as frozen on each
 *                       voucher at issue (`promo.voucher.cost_satang`, the
 *                       prize's cost when the box drew it);
 *   uptime_s            not written yet: see QUESTIONS — the heartbeat history
 *                       it would be read from is kept two weeks, so it must be
 *                       frozen at the day's end rather than recomputed.
 *
 * Each run rolls today at every live branch and every day a booth fact marked
 * (`dirty_date` kind `booth`). A branch-day is computed and written under a
 * transaction-scoped advisory lock of its own; a row is written only where a
 * figure moved and a row the day no longer has is removed, so a replayed run
 * writes nothing.
 */

export const ROLLUP_BOOTH_JOB = 'job:rollup.booth';

/** Ours, distinct from the job runner's and the daily rollup's namespaces. */
const BOOTH_LOCK_NAMESPACE = 0x0b16;

const NO_ID = '00000000-0000-0000-0000-000000000000';

export interface BoothFactRow {
  boothId: string;
  staffAccountId: string | null;
  prizeId: string | null;
  spins: number;
  vouchersIssued: number;
  vouchersRedeemed: number;
  redemptionLagSumS: number;
  prizeCostSatang: number;
}

const factKey = (r: Pick<BoothFactRow, 'boothId' | 'staffAccountId' | 'prizeId'>) =>
  `${r.boothId}|${r.staffAccountId ?? NO_ID}|${r.prizeId ?? NO_ID}`;

/** One branch-day's booth facts, read from the spins and their vouchers. */
export async function boothFactsOf(db: Exec, branchId: string, date: string): Promise<BoothFactRow[]> {
  const { rows } = await db.execute<{
    booth_id: string;
    staff_account_id: string | null;
    prize_id: string | null;
    spins: number;
    issued: number;
    redeemed: number;
    lag: string | number;
    cost: string | number;
  }>(sql`
    select s.station_id as booth_id, s.staff_account_id, s.prize_id,
           count(*)::int as spins,
           count(v.id)::int as issued,
           (count(v.id) filter (where v.status = 'redeemed' and v.redeemed_at is not null))::int as redeemed,
           coalesce(sum(greatest(0, round(extract(epoch from (v.redeemed_at - v.issued_at)))))
                      filter (where v.status = 'redeemed' and v.redeemed_at is not null), 0)::bigint as lag,
           coalesce(sum(v.cost_satang) filter (where s.prize_id is not null), 0)::bigint as cost
      from booth.spin s
      left join promo.voucher v on v.id = s.voucher_id
     where s.branch_id = ${branchId}::uuid
       and s.business_date = ${date}::date
       and s.simulated = false
     group by s.station_id, s.staff_account_id, s.prize_id
     order by s.station_id, s.staff_account_id nulls first, s.prize_id nulls first`);
  return rows.map((r) => ({
    boothId: r.booth_id,
    staffAccountId: r.staff_account_id,
    prizeId: r.prize_id,
    spins: Number(r.spins),
    vouchersIssued: Number(r.issued),
    vouchersRedeemed: Number(r.redeemed),
    redemptionLagSumS: Number(r.lag),
    prizeCostSatang: Number(r.cost),
  }));
}

async function lockBoothDay(tx: Tx, branchId: string, date: string): Promise<void> {
  const key = createHash('sha256').update(`rollup:booth:${branchId}:${date}`).digest().readInt32BE(0);
  await tx.execute(sql`select pg_advisory_xact_lock(${BOOTH_LOCK_NAMESPACE}::int4, ${key}::int4)`);
}

export interface BoothDayOutcome {
  written: number;
  removed: number;
}

/** Recompute one branch-day's booth facts. A claimed dirty row is consumed with the write. */
export async function rollupBoothBranchDay(
  db: Db,
  clock: Pick<RollupBranchClock, 'id' | 'operatorId'>,
  date: string,
  now: Date,
  claim?: { claim: DirtyClaim; claimedBy: string },
): Promise<BoothDayOutcome> {
  return db.transaction(async (tx) => {
    await lockBoothDay(tx, clock.id, date);
    const facts = await boothFactsOf(tx, clock.id, date);
    const { rows: stored } = await tx.execute<{
      id: string;
      booth_id: string;
      staff_account_id: string | null;
      prize_id: string | null;
      spins: number;
      vouchers_issued: number;
      vouchers_redeemed: number;
      redemption_lag_sum_s: string | number;
      prize_cost_satang: string | number;
    }>(sql`
      select id, booth_id, staff_account_id, prize_id, spins, vouchers_issued, vouchers_redeemed,
             redemption_lag_sum_s, prize_cost_satang
        from analytics.fact_booth_daily
       where branch_id = ${clock.id}::uuid and business_date = ${date}::date`);
    const held = new Map(
      stored.map((r) => [factKey({ boothId: r.booth_id, staffAccountId: r.staff_account_id, prizeId: r.prize_id }), r]),
    );
    let written = 0;
    for (const f of facts) {
      const current = held.get(factKey(f));
      held.delete(factKey(f));
      if (current) {
        const same =
          Number(current.spins) === f.spins &&
          Number(current.vouchers_issued) === f.vouchersIssued &&
          Number(current.vouchers_redeemed) === f.vouchersRedeemed &&
          Number(current.redemption_lag_sum_s) === f.redemptionLagSumS &&
          Number(current.prize_cost_satang) === f.prizeCostSatang;
        if (same) continue;
        await tx.execute(sql`
          update analytics.fact_booth_daily
             set spins = ${f.spins}, vouchers_issued = ${f.vouchersIssued}, vouchers_redeemed = ${f.vouchersRedeemed},
                 redemption_lag_sum_s = ${f.redemptionLagSumS}, prize_cost_satang = ${f.prizeCostSatang},
                 computed_at = ${now.toISOString()}::timestamptz, updated_at = ${now.toISOString()}::timestamptz
           where id = ${current.id}::uuid`);
      } else {
        await tx.execute(sql`
          insert into analytics.fact_booth_daily
            (id, operator_id, branch_id, business_date, booth_id, staff_account_id, prize_id, spins, vouchers_issued,
             vouchers_redeemed, redemption_lag_sum_s, uptime_s, prize_cost_satang, computed_at, created_at, updated_at)
          values (${newId()}::uuid, ${clock.operatorId}::uuid, ${clock.id}::uuid, ${date}::date, ${f.boothId}::uuid,
                  ${f.staffAccountId}::uuid, ${f.prizeId}::uuid, ${f.spins}, ${f.vouchersIssued}, ${f.vouchersRedeemed},
                  ${f.redemptionLagSumS}, 0, ${f.prizeCostSatang}, ${now.toISOString()}::timestamptz,
                  ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)`);
      }
      written += 1;
    }
    // A row the day no longer has: its spins were removed (a demo reset).
    let removed = 0;
    for (const gone of held.values()) {
      await tx.execute(sql`delete from analytics.fact_booth_daily where id = ${gone.id}::uuid`);
      removed += 1;
    }
    if (claim) await consumeDirtyClaim(tx, claim.claim, claim.claimedBy);
    return { written, removed };
  });
}

export interface BoothRollupDetail extends Record<string, number> {
  branches: number;
  days: number;
  rowsWritten: number;
  rowsRemoved: number;
  claimed: number;
}

/**
 * `job:rollup.booth` — today at every live branch, and every day a booth fact
 * marked. One branch-day that cannot be written does not stop the others; the
 * run then fails loudly with the count and the day's claim is released.
 */
export async function runBoothRollupJob(db: Db, now: Date): Promise<BoothRollupDetail> {
  const claimedBy = `${ROLLUP_BOOTH_JOB}:${newId()}`;
  const rows = await db
    .select({
      id: branch.id,
      operatorId: branch.operatorId,
      timezone: branch.timezone,
      dayStart: branch.businessDayStart,
      archivedAt: branch.archivedAt,
    })
    .from(branch);
  const clocks = new Map(
    rows.map((r) => [
      r.id,
      { id: r.id, operatorId: r.operatorId, timezone: r.timezone, dayStartMinutes: parseDayStart(r.dayStart), live: r.archivedAt === null },
    ]),
  );
  const plan = new Map<string, { clock: RollupBranchClock; date: string; claim?: DirtyClaim }>();
  const live = [...clocks.values()].filter((c) => c.live);
  for (const clock of live) {
    const today = branchToday(clock, now);
    plan.set(`${clock.id}|${today}`, { clock, date: today });
  }
  const claims = await claimDirtyDates(db, 'booth', claimedBy, now);
  for (const claim of claims) {
    const clock = clocks.get(claim.branchId);
    if (!clock) continue;
    const key = `${claim.branchId}|${claim.businessDate}`;
    plan.set(key, { ...(plan.get(key) ?? { clock, date: claim.businessDate }), claim });
  }
  const detail: BoothRollupDetail = { branches: live.length, days: 0, rowsWritten: 0, rowsRemoved: 0, claimed: claims.length };
  let failed = 0;
  let firstError: unknown = null;
  const ordered = [...plan.values()].sort((a, b) => a.date.localeCompare(b.date) || a.clock.id.localeCompare(b.clock.id));
  for (const day of ordered) {
    detail.days += 1;
    try {
      const done = await rollupBoothBranchDay(db, day.clock, day.date, now, day.claim ? { claim: day.claim, claimedBy } : undefined);
      detail.rowsWritten += done.written;
      detail.rowsRemoved += done.removed;
    } catch (err) {
      failed += 1;
      firstError ??= err;
      if (day.claim) await releaseDirtyClaim(db, day.claim, claimedBy).catch(() => undefined);
    }
  }
  if (failed > 0) {
    throw new Error(`booth rollup: ${failed} of ${detail.days} branch-days could not be written`, { cause: firstError });
  }
  return detail;
}

// --- Freshness -----------------------------------------------------------------------------

/**
 * When the booth figures of each branch were last brought up to date: the
 * start of the newest successful `job:rollup.booth` (each one rolls today at
 * every live branch), for a live branch that existed then. Null when it never
 * has. The Health page's booth line.
 */
export async function lastBoothRolledUpAt(
  db: Exec,
  branches: ReadonlyArray<{ id: string; archivedAt: Date | null; createdAt: Date }>,
): Promise<Map<string, Date | null>> {
  const [lastRun] = await db
    .select({ startedAt: opsRun.startedAt })
    .from(opsRun)
    .where(and(eq(opsRun.name, ROLLUP_BOOTH_JOB), eq(opsRun.outcome, 'ok')))
    .orderBy(desc(opsRun.startedAt))
    .limit(1);
  return new Map(
    branches.map((b) => [
      b.id,
      lastRun && b.archivedAt === null && lastRun.startedAt.getTime() >= b.createdAt.getTime() ? lastRun.startedAt : null,
    ]),
  );
}

// --- The report ----------------------------------------------------------------------------

interface FunnelSums {
  spins: number;
  prizesWon: number;
  vouchersIssued: number;
  vouchersRedeemed: number;
  lagSumS: number;
  prizeCostSatang: number;
  prizeCostIncomplete: boolean;
}

const emptySums = (): FunnelSums => ({
  spins: 0,
  prizesWon: 0,
  vouchersIssued: 0,
  vouchersRedeemed: 0,
  lagSumS: 0,
  prizeCostSatang: 0,
  prizeCostIncomplete: false,
});

function funnelOf(s: FunnelSums): BoothFunnel {
  return {
    spins: s.spins,
    prizesWon: s.prizesWon,
    vouchersIssued: s.vouchersIssued,
    vouchersRedeemed: s.vouchersRedeemed,
    ...boothFunnelRatios(s),
    prizeCostSatang: s.prizeCostSatang,
    prizeCostIncomplete: s.prizeCostIncomplete,
  };
}

/** One stored fact row as the report reads it, with its names. */
export interface BoothReportFact {
  businessDate: string;
  branchId: string;
  branchName: string;
  boothId: string;
  boothName: string;
  staffAccountId: string | null;
  staffName: string | null;
  prizeId: string | null;
  prizeName: string | null;
  spins: number;
  vouchersIssued: number;
  vouchersRedeemed: number;
  redemptionLagSumS: number;
  prizeCostSatang: number;
}

/** The stored facts of the scope's branches and dates, oldest day first. */
export async function boothReportFacts(db: Exec, scope: ReportScope): Promise<BoothReportFact[]> {
  if (scope.branches.length === 0) return [];
  const ids = sql.join(
    scope.branches.map((b) => sql`${b.branchId}::uuid`),
    sql`, `,
  );
  const { rows } = await db.execute<{
    business_date: string;
    branch_id: string;
    branch_name: string;
    booth_id: string;
    booth_name: string;
    staff_account_id: string | null;
    staff_name: string | null;
    prize_id: string | null;
    prize_name: string | null;
    spins: number;
    vouchers_issued: number;
    vouchers_redeemed: number;
    redemption_lag_sum_s: string | number;
    prize_cost_satang: string | number;
  }>(sql`
    select f.business_date::text as business_date, f.branch_id, b.name as branch_name, f.booth_id, st.name as booth_name,
           f.staff_account_id, coalesce(e.nickname, e.name) as staff_name, f.prize_id, bp.name_en as prize_name,
           f.spins, f.vouchers_issued, f.vouchers_redeemed, f.redemption_lag_sum_s, f.prize_cost_satang
      from analytics.fact_booth_daily f
      join core.branch b on b.id = f.branch_id
      join core.station st on st.id = f.booth_id
      left join booth.booth_prize bp on bp.id = f.prize_id
      left join core.account a on a.id = f.staff_account_id
      left join core.employee e on e.id = a.employee_id
     where f.branch_id in (${ids})
       and f.business_date between ${scope.from}::date and ${scope.to}::date
     order by f.business_date, b.name, st.name, f.booth_id, f.prize_id nulls first, f.staff_account_id nulls first`);
  return rows.map((r) => ({
    businessDate: String(r.business_date).slice(0, 10),
    branchId: r.branch_id,
    branchName: r.branch_name,
    boothId: r.booth_id,
    boothName: r.booth_name,
    staffAccountId: r.staff_account_id,
    staffName: r.staff_name,
    prizeId: r.prize_id,
    prizeName: r.prize_name,
    spins: Number(r.spins),
    vouchersIssued: Number(r.vouchers_issued),
    vouchersRedeemed: Number(r.vouchers_redeemed),
    redemptionLagSumS: Number(r.redemption_lag_sum_s),
    prizeCostSatang: Number(r.prize_cost_satang),
  }));
}

function add(into: FunnelSums, f: BoothReportFact): void {
  into.spins += f.spins;
  if (f.prizeId) {
    into.prizesWon += f.spins;
    // A prize won with nothing paid for it: no cost set yet (zero is "not costed").
    if (f.spins > 0 && f.prizeCostSatang === 0) into.prizeCostIncomplete = true;
  }
  into.vouchersIssued += f.vouchersIssued;
  into.vouchersRedeemed += f.vouchersRedeemed;
  into.lagSumS += f.redemptionLagSumS;
  into.prizeCostSatang += f.prizeCostSatang;
}

const UNATTRIBUTED = 'Unattributed';

/** Console > Booths > Report: the funnel per booth, per prize, per staff member and per day. */
export async function boothReportOf(db: Exec, scope: ReportScope): Promise<BoothReport> {
  const facts = await boothReportFacts(db, scope);
  const booths = new Map<string, { head: { boothId: string; name: string; branchId: string; branchName: string }; sums: FunnelSums }>();
  const prizes = new Map<string, { head: { boothId: string; prizeId: string; name: string }; sums: FunnelSums }>();
  const staff = new Map<string, { head: { boothId: string; accountId: string | null; name: string }; sums: FunnelSums }>();
  const days = new Map<string, { head: { boothId: string; businessDate: string }; sums: FunnelSums }>();
  for (const f of facts) {
    const booth = booths.get(f.boothId) ?? {
      head: { boothId: f.boothId, name: f.boothName, branchId: f.branchId, branchName: f.branchName },
      sums: emptySums(),
    };
    add(booth.sums, f);
    booths.set(f.boothId, booth);
    if (f.prizeId) {
      const key = `${f.boothId}|${f.prizeId}`;
      const prize = prizes.get(key) ?? {
        head: { boothId: f.boothId, prizeId: f.prizeId, name: f.prizeName ?? 'Prize' },
        sums: emptySums(),
      };
      add(prize.sums, f);
      prizes.set(key, prize);
    }
    const staffKey = `${f.boothId}|${f.staffAccountId ?? ''}`;
    const person = staff.get(staffKey) ?? {
      head: { boothId: f.boothId, accountId: f.staffAccountId, name: f.staffAccountId ? (f.staffName ?? 'Unnamed account') : UNATTRIBUTED },
      sums: emptySums(),
    };
    add(person.sums, f);
    staff.set(staffKey, person);
    const dayKey = `${f.boothId}|${f.businessDate}`;
    const day = days.get(dayKey) ?? { head: { boothId: f.boothId, businessDate: f.businessDate }, sums: emptySums() };
    add(day.sums, f);
    days.set(dayKey, day);
  }
  const parks =
    scope.branches.length === 0
      ? []
      : await db
          .select({ id: branch.id, archivedAt: branch.archivedAt, createdAt: branch.createdAt })
          .from(branch)
          .where(inArray(branch.id, scope.branches.map((b) => b.branchId)));
  const times = [...(await lastBoothRolledUpAt(db, parks)).values()];
  // The whole answer is at least as fresh as its stalest branch.
  const oldest =
    times.length === 0 || times.some((t) => t === null)
      ? null
      : times.reduce((a, b) => (a!.getTime() <= b!.getTime() ? a : b));
  return {
    from: scope.from,
    to: scope.to,
    branches: scope.branches,
    omitted: scope.omitted,
    booths: [...booths.values()]
      .map((b) => ({ ...b.head, ...funnelOf(b.sums) }))
      .sort((a, b) => a.branchName.localeCompare(b.branchName) || a.name.localeCompare(b.name) || a.boothId.localeCompare(b.boothId)),
    prizes: [...prizes.values()]
      .map((p) => ({ ...p.head, ...funnelOf(p.sums) }))
      .sort((a, b) => a.boothId.localeCompare(b.boothId) || b.prizesWon - a.prizesWon || a.name.localeCompare(b.name)),
    staff: [...staff.values()]
      .map((s) => ({ ...s.head, ...funnelOf(s.sums) }))
      .sort((a, b) => a.boothId.localeCompare(b.boothId) || b.spins - a.spins || a.name.localeCompare(b.name)),
    days: [...days.values()]
      .map((d) => ({ ...d.head, ...funnelOf(d.sums) }))
      .sort((a, b) => a.businessDate.localeCompare(b.businessDate) || a.boothId.localeCompare(b.boothId)),
    lastRolledUpAt: oldest?.toISOString() ?? null,
  };
}

/** A CSV cell, guarded against formula injection as the settlement export is. */
function csvCell(value: string | number | null): string {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * The booth funnel as a CSV, one row per trading day, booth, staff member and
 * prize — the fact as stored, with names — for the scope's branches and dates.
 */
export async function boothReportCsv(db: Exec, scope: ReportScope): Promise<{ filename: string; csv: string }> {
  const facts = await boothReportFacts(db, scope);
  const header = [
    'Trading day',
    'Branch',
    'Booth',
    'Staff',
    'Prize',
    'Spins',
    'Prizes won',
    'Vouchers issued',
    'Vouchers redeemed',
    'Redemption rate (%)',
    'Mean redemption lag (minutes)',
    'Prize cost (THB)',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const f of facts) {
    const { redemptionRate, meanRedemptionLagS } = boothFunnelRatios({
      vouchersIssued: f.vouchersIssued,
      vouchersRedeemed: f.vouchersRedeemed,
      lagSumS: f.redemptionLagSumS,
    });
    lines.push(
      [
        f.businessDate,
        f.branchName,
        f.boothName,
        f.staffAccountId ? (f.staffName ?? 'Unnamed account') : UNATTRIBUTED,
        f.prizeId ? (f.prizeName ?? 'Prize') : 'No prize',
        f.spins,
        f.prizeId ? f.spins : 0,
        f.vouchersIssued,
        f.vouchersRedeemed,
        redemptionRate === null ? '' : (redemptionRate * 100).toFixed(1),
        meanRedemptionLagS === null ? '' : (meanRedemptionLagS / 60).toFixed(1),
        (f.prizeCostSatang / 100).toFixed(2),
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return { filename: `booth-report_${scope.from}_${scope.to}.csv`, csv: `\uFEFF${lines.join('\r\n')}\r\n` };
}
