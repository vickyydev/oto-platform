import { createHash } from 'node:crypto';
import { and, asc, eq, notInArray, sql } from 'drizzle-orm';
import { branch, dailySummary, hourlySummary, type Db, type DirtyDateKind } from '@oto/db';
import {
  ANALYTICS_FORMULA_VERSION,
  ANALYTICS_PLATFORM_SOURCE,
  PAYMENT_ATTEMPT_TAKEN_STATUSES,
  WALLET_TENDER_CODE,
  WALLET_TENDER_METHOD,
  analyticsChannelOfVoucherSource,
  businessDate,
  newId,
  parseDayStart,
  summariseAnalyticsDayV1,
  summariseAnalyticsHoursV1,
  type AnalyticsDayFigures,
  type AnalyticsSaleFacts,
  type AnalyticsSaleKind,
} from '@oto/shared';
import type { Exec, Tx } from './tx';

/**
 * S2-15b (SCRUM-216) round 2 — THE ROLLUP: each branch's trading days into
 * `analytics.daily_summary` and `analytics.hourly_summary` (plan
 * docs/progress/plans/analytics/PLAN.md §3-§5, §8 round 2).
 *
 * TWO JOBS, ONE FIGURE SET.
 *
 *   job:rollup.daily   every `ROLLUP_INTERVAL_S`: today at every live branch
 *                      (written provisional), every day a late fact marked
 *                      (`dirty_date` kind `sales`, claimed), and every day
 *                      still provisional once it has ended at its branch. It
 *                      hands each day it rolled to the hourly summariser
 *                      (kind `hourly`), and keeps `dim_date` current.
 *   job:rollup.hourly  the same interval: today, and every day the daily
 *                      rollup handed over, per wall-clock hour.
 *
 * Both read one set of per-sale facts (`saleFactsOf`) and apply formula
 * version 1 (`summariseAnalyticsDayV1` in `@oto/shared`), so a day's hours add
 * up to the day.
 *
 * SAFE TO RUN TWICE AT ONCE. A branch-day is computed and written under a
 * transaction-scoped advisory lock of its own, so two runs serialise on it and
 * the second finds the first's row; the upsert writes only when the figures'
 * fingerprint moved, so a replay writes nothing. A claimed dirty row is
 * consumed in the same transaction as the write it caused, and only if no
 * mark landed since it was claimed (`mark_count`); a run that fails releases
 * its claim, and a claim older than `DIRTY_CLAIM_STALE_S` is taken again.
 *
 * NEVER WRITTEN: a frozen row (the legacy fixture days), and any row of a
 * source other than `oto_pos`.
 */

export const ROLLUP_DAILY_JOB = 'job:rollup.daily';
export const ROLLUP_HOURLY_JOB = 'job:rollup.hourly';

/** A claim older than this is taken again: the run that held it is gone. */
export const DIRTY_CLAIM_STALE_S = 15 * 60;

/** How many marked days one run takes on, so a backlog is worked through over several runs. */
export const DIRTY_CLAIM_BATCH = 500;

/** The calendar a run keeps current: from a year back (or the first sale) to a year ahead. */
const DIM_DATE_DAYS = 365;

/** Ours, distinct from the job runner's own namespace (`jobs.ts`). */
const ROLLUP_LOCK_NAMESPACE = 0x0a16;

const SOURCE = ANALYTICS_PLATFORM_SOURCE;

export interface RollupBranchClock {
  id: string;
  operatorId: string;
  timezone: string;
  dayStartMinutes: number;
  live: boolean;
}

/** Every branch, live or archived: a late fact can still land on an archived branch's day. */
async function branchClocks(db: Exec): Promise<Map<string, RollupBranchClock>> {
  const rows = await db
    .select({
      id: branch.id,
      operatorId: branch.operatorId,
      timezone: branch.timezone,
      dayStart: branch.businessDayStart,
      archivedAt: branch.archivedAt,
    })
    .from(branch)
    .orderBy(asc(branch.id));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        operatorId: row.operatorId,
        timezone: row.timezone,
        dayStartMinutes: parseDayStart(row.dayStart),
        live: row.archivedAt === null,
      },
    ]),
  );
}

/** The trading day in progress at the branch. */
export function branchToday(clock: Pick<RollupBranchClock, 'timezone' | 'dayStartMinutes'>, now: Date): string {
  return businessDate(now, clock.timezone, clock.dayStartMinutes);
}

// --- The dirty-day queue ------------------------------------------------------------

export interface DirtyClaim {
  id: string;
  branchId: string;
  businessDate: string;
  markCount: number;
}

/**
 * Claim marked days of one kind. `endedOnly` leaves a day that has not ended
 * at its branch where it is (the wallet liability job writes ended days only).
 * Rows a marker or another run is holding are skipped, not waited for.
 */
export async function claimDirtyDates(
  db: Exec,
  kind: DirtyDateKind,
  claimedBy: string,
  now: Date,
  opts: { endedOnly?: boolean; limit?: number } = {},
): Promise<DirtyClaim[]> {
  const stale = new Date(now.getTime() - DIRTY_CLAIM_STALE_S * 1000);
  const ended = opts.endedOnly
    ? sql`and dd.business_date < ((${now.toISOString()}::timestamptz at time zone b.timezone) - (b.business_day_start - time '00:00'))::date`
    : sql``;
  const { rows } = await db.execute<{ id: string; branch_id: string; business_date: string; mark_count: string | number }>(sql`
    update analytics.dirty_date d
       set claimed_at = ${now.toISOString()}::timestamptz, claimed_by = ${claimedBy}, updated_at = ${now.toISOString()}::timestamptz
     where d.id in (
       select dd.id
         from analytics.dirty_date dd
         join core.branch b on b.id = dd.branch_id
        where dd.kind = ${kind}
          and (dd.claimed_at is null or dd.claimed_at < ${stale.toISOString()}::timestamptz)
          ${ended}
        order by dd.business_date, dd.branch_id
        limit ${opts.limit ?? DIRTY_CLAIM_BATCH}
        for update of dd skip locked)
    returning d.id, d.branch_id, d.business_date::text as business_date, d.mark_count`);
  return rows.map((r) => ({
    id: r.id,
    branchId: r.branch_id,
    businessDate: String(r.business_date).slice(0, 10),
    markCount: Number(r.mark_count),
  }));
}

/**
 * The claim is spent: delete the row, unless a mark landed after it was
 * claimed — then the row stays, unclaimed by that mark, for the next run.
 */
export async function consumeDirtyClaim(db: Exec, claim: DirtyClaim, claimedBy: string): Promise<void> {
  await db.execute(sql`
    delete from analytics.dirty_date
     where id = ${claim.id}::uuid and claimed_by = ${claimedBy} and mark_count = ${claim.markCount}`);
}

/** The run could not do the work: let the next run take the day at once. */
export async function releaseDirtyClaim(db: Exec, claim: DirtyClaim, claimedBy: string): Promise<void> {
  await db.execute(sql`
    update analytics.dirty_date set claimed_at = null, claimed_by = null
     where id = ${claim.id}::uuid and claimed_by = ${claimedBy}`);
}

async function markDirty(tx: Tx, clock: RollupBranchClock, date: string, kind: DirtyDateKind, reason: string): Promise<void> {
  await tx.execute(
    sql`select analytics.mark_dirty_date(${clock.operatorId}::uuid, ${clock.id}::uuid, ${date}::date, ${kind}, ${reason})`,
  );
}

/** One writer per branch-day per table, for the length of the transaction. */
async function lockBranchDay(tx: Tx, table: 'daily' | 'hourly', branchId: string, date: string): Promise<void> {
  const key = createHash('sha256').update(`rollup:${table}:${branchId}:${date}`).digest().readInt32BE(0);
  await tx.execute(sql`select pg_advisory_xact_lock(${ROLLUP_LOCK_NAMESPACE}::int4, ${key}::int4)`);
}

// --- The facts ------------------------------------------------------------------------

/**
 * WHAT KIND OF RECORD A SALE IS, in the prototype's terms. The lane the till
 * recorded it under decides (`sales_channel`: `fnb`, `shop`). Before SCRUM-343
 * every sale was recorded under `till`, F&B and shop orders included, so a
 * `till` sale with no ticket-side line and only F&B or merch items is read by
 * its lines.
 */
function saleKindOf(row: { sales_channel: string; ticket_lines: number; fnb_lines: number; merch_lines: number }): AnalyticsSaleKind {
  if (row.sales_channel === 'fnb') return 'fnb';
  if (row.sales_channel === 'shop') return 'merch';
  if (row.ticket_lines === 0 && row.fnb_lines > 0) return 'fnb';
  if (row.ticket_lines === 0 && row.merch_lines > 0) return 'merch';
  return 'ticket';
}

interface SaleFactRow extends Record<string, unknown> {
  id: string;
  sales_channel: string;
  gross_satang: string | number;
  discount_satang: string | number;
  service_satang: string | number;
  vat_satang: string | number;
  hour: number;
  ticket_lines: number;
  fnb_lines: number;
  merch_lines: number;
  drop_off: boolean;
  refunded: string | number;
  non_credit: string | number;
  credit_used: string | number;
  credit_restored: string | number;
  kids: number;
  adults: number;
  mix_1h: number;
  mix_2h: number;
  mix_full_day: number;
  comps: string | number;
  sources: string[] | null;
}

/**
 * ONE ROW PER COUNTED SALE OF A BRANCH-DAY, read from the ledger with the
 * plan's §4 data-reliability rules applied:
 *
 *   - the day is the sale's business date at its branch, never a UTC slice;
 *   - only `finalised` and `refunded` sales count (tendering, paid-but-open
 *     and voided never do); a refund, whenever it was made, reduces its own
 *     sale, so it lands on the original day;
 *   - participants are summed once per cart line (`pos.sale_line` is one row
 *     per unit and carries the line's counts on every unit);
 *   - a ticket line's hours are the hours recorded on the line at sale time;
 *   - a line is the drop-off service when it is the service-fee unit or the
 *     drop-off line of a child's stay (its cart line is the stay's id);
 *   - stored-value credit is told apart by method and code
 *     (`isStoredValueTender`).
 */
export async function saleFactsOf(db: Exec, branchId: string, date: string): Promise<AnalyticsSaleFacts[]> {
  const taken = sql.join(
    PAYMENT_ATTEMPT_TAKEN_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  const credit = sql`(a.method = ${WALLET_TENDER_METHOD} or a.method_code = ${WALLET_TENDER_CODE})`;
  const { rows } = await db.execute<SaleFactRow>(sql`
    with day as (
      select s.id, s.sales_channel, s.gross_satang, s.discount_satang,
             s.service_charge_satang as service_satang,
             s.tax_inclusive_satang + s.tax_exclusive_satang as vat_satang,
             extract(hour from (s.occurred_at at time zone s.timezone))::int as hour
        from pos.sale s
       where s.branch_id = ${branchId}::uuid
         and s.business_date = ${date}::date
         and s.status in ('finalised', 'refunded')
    ),
    cart_lines as (
      select l.sale_id, l.cart_line_id,
             max(l.kid_count) as kids,
             max(l.adult_count) as adults,
             max(l.stay_hours) as hours,
             bool_or(l.ticket_package_id is not null) as ticket
        from pos.sale_line l
        join day on day.id = l.sale_id
       group by l.sale_id, l.cart_line_id
    )
    select day.id, day.sales_channel, day.gross_satang, day.discount_satang, day.service_satang, day.vat_satang, day.hour,
           (select count(*) from pos.sale_line l where l.sale_id = day.id
              and l.kind in ('kids', 'adults_paid', 'adults_free', 'socks', 'addon', 'service_fee', 'food_provision'))::int as ticket_lines,
           (select count(*) from pos.sale_line l where l.sale_id = day.id and l.kind = 'fnb_item')::int as fnb_lines,
           (select count(*) from pos.sale_line l where l.sale_id = day.id and l.kind = 'merch_item')::int as merch_lines,
           exists (
             select 1 from pos.sale_line l
              where l.sale_id = day.id
                and (l.kind = 'service_fee' or exists (select 1 from pos.checkin c where c.id = l.cart_line_id))
           ) as drop_off,
           coalesce((select sum(r.amount_satang) from pos.refund r where r.sale_id = day.id), 0)::bigint as refunded,
           coalesce((select sum(a.amount_satang) from pos.payment_attempt a
                      where a.sale_id = day.id and a.status in (${taken}) and not ${credit}), 0)::bigint as non_credit,
           coalesce((select sum(a.amount_satang) from pos.payment_attempt a
                      where a.sale_id = day.id and a.status in (${taken}) and ${credit}), 0)::bigint as credit_used,
           coalesce((select sum(e.amount_satang) from pos.wallet_entry e
                       join pos.refund r on r.id = e.refund_id
                      where r.sale_id = day.id and e.kind = 'refund'), 0)::bigint as credit_restored,
           coalesce((select sum(c.kids) from cart_lines c where c.sale_id = day.id), 0)::int as kids,
           coalesce((select sum(c.adults) from cart_lines c where c.sale_id = day.id), 0)::int as adults,
           coalesce((select sum(c.kids + c.adults) from cart_lines c
                      where c.sale_id = day.id and c.ticket and c.hours = 1), 0)::int as mix_1h,
           coalesce((select sum(c.kids + c.adults) from cart_lines c
                      where c.sale_id = day.id and c.ticket and c.hours = 2), 0)::int as mix_2h,
           coalesce((select sum(c.kids + c.adults) from cart_lines c
                      where c.sale_id = day.id and c.ticket and c.hours >= 3), 0)::int as mix_full_day,
           coalesce((select sum(d.amount_satang) from pos.sale_discount d
                      where d.sale_id = day.id and d.kind = 'manual' and d.discount_type = 'comp'), 0)::bigint as comps,
           (select array_agg(distinct v.source order by v.source)
              from promo.voucher_redemption vr
              join promo.voucher v on v.id = vr.voucher_id
             where vr.sale_id = day.id and vr.kind = 'consumed') as sources
      from day
     order by day.id`);
  return rows.map((r) => {
    const comps = Number(r.comps);
    return {
      saleId: r.id,
      kind: saleKindOf(r),
      dropOff: r.drop_off,
      hour: Number(r.hour),
      grossSatang: Number(r.gross_satang),
      refundedSatang: Number(r.refunded),
      nonCreditSatang: Number(r.non_credit),
      creditUsedSatang: Number(r.credit_used),
      creditRestoredSatang: Number(r.credit_restored),
      kids: Number(r.kids),
      adults: Number(r.adults),
      mixOneHour: Number(r.mix_1h),
      mixTwoHour: Number(r.mix_2h),
      mixFullDay: Number(r.mix_full_day),
      discountSatang: Math.max(0, Number(r.discount_satang) - comps),
      compSatang: comps,
      vatSatang: Number(r.vat_satang),
      serviceSatang: Number(r.service_satang),
      channels: (r.sources ?? []).map(analyticsChannelOfVoucherSource),
    };
  });
}

/** The fingerprint an unchanged recompute is recognised by: the figures as they would be written. */
export function dailyFingerprint(figures: AnalyticsDayFigures, provisional: boolean): string {
  const byChannel = Object.fromEntries(Object.entries(figures.byChannel).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256')
    .update(JSON.stringify({ formulaVersion: ANALYTICS_FORMULA_VERSION, provisional, ...figures, byChannel }))
    .digest('hex');
}

// --- One branch-day -------------------------------------------------------------------

export type RollupDayOutcome = 'written' | 'unchanged' | 'frozen';

/**
 * Recompute one branch-day into `daily_summary`, and hand it to the hourly
 * summariser. `claim`, when the day came off the dirty queue, is consumed in
 * the same transaction as the write.
 */
export async function rollupDailyBranchDay(
  db: Db,
  clock: RollupBranchClock,
  date: string,
  now: Date,
  claim?: { claim: DirtyClaim; claimedBy: string },
): Promise<RollupDayOutcome> {
  return db.transaction(async (tx) => {
    await lockBranchDay(tx, 'daily', clock.id, date);
    const [existing] = await tx
      .select({ frozen: dailySummary.frozen })
      .from(dailySummary)
      .where(and(eq(dailySummary.branchId, clock.id), eq(dailySummary.businessDate, date), eq(dailySummary.source, SOURCE)))
      .limit(1);
    if (existing?.frozen) {
      if (claim) await consumeDirtyClaim(tx, claim.claim, claim.claimedBy);
      return 'frozen';
    }
    const figures = summariseAnalyticsDayV1(await saleFactsOf(tx, clock.id, date));
    const provisional = date >= branchToday(clock, now);
    const values = {
      formulaVersion: ANALYTICS_FORMULA_VERSION,
      provisional,
      computedAt: now,
      ticketsSatang: figures.ticketsSatang,
      fnbSatang: figures.fnbSatang,
      merchSatang: figures.merchSatang,
      partiesSatang: figures.partiesSatang,
      dropoffSatang: figures.dropoffSatang,
      revenueSatang: figures.revenueSatang,
      txnCount: figures.txnCount,
      creditPaidSatang: figures.creditPaidSatang,
      guestsKids: figures.guestsKids,
      guestsAdults: figures.guestsAdults,
      mix1h: figures.mix1h,
      mix2h: figures.mix2h,
      mixFullDay: figures.mixFullDay,
      partiesCount: figures.partiesCount,
      refundsSatang: figures.refundsSatang,
      discountsSatang: figures.discountsSatang,
      compsSatang: figures.compsSatang,
      vatSatang: figures.vatSatang,
      serviceSatang: figures.serviceSatang,
      byChannel: figures.byChannel,
      inputFingerprint: dailyFingerprint(figures, provisional),
    };
    const d = dailySummary;
    const written = await tx
      .insert(d)
      .values({
        id: newId(),
        operatorId: clock.operatorId,
        branchId: clock.id,
        businessDate: date,
        source: SOURCE,
        ...values,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [d.branchId, d.businessDate, d.source],
        set: { ...values, updatedAt: now },
        setWhere: sql`not ${d.frozen} and ${d.inputFingerprint} is distinct from excluded.input_fingerprint`,
      })
      .returning({ id: d.id });
    // A day whose facts moved goes to the hourly summariser; today is rolled
    // there on every run regardless.
    if (written.length > 0 || claim) await markDirty(tx, clock, date, 'hourly', 'rollup.daily');
    if (claim) await consumeDirtyClaim(tx, claim.claim, claim.claimedBy);
    return written.length > 0 ? 'written' : 'unchanged';
  });
}

/**
 * Recompute one branch-day's hours into `hourly_summary`: every hour that had
 * a sale is upserted where a figure moved, and an hour that no longer has one
 * is removed.
 */
export async function rollupHourlyBranchDay(
  db: Db,
  clock: RollupBranchClock,
  date: string,
  now: Date,
  claim?: { claim: DirtyClaim; claimedBy: string },
): Promise<{ outcome: RollupDayOutcome; hoursWritten: number; hoursRemoved: number }> {
  return db.transaction(async (tx) => {
    await lockBranchDay(tx, 'hourly', clock.id, date);
    const [frozen] = await tx
      .select({ frozen: dailySummary.frozen })
      .from(dailySummary)
      .where(and(eq(dailySummary.branchId, clock.id), eq(dailySummary.businessDate, date), eq(dailySummary.source, SOURCE)))
      .limit(1);
    if (frozen?.frozen) {
      if (claim) await consumeDirtyClaim(tx, claim.claim, claim.claimedBy);
      return { outcome: 'frozen' as const, hoursWritten: 0, hoursRemoved: 0 };
    }
    const hours = summariseAnalyticsHoursV1(await saleFactsOf(tx, clock.id, date));
    const h = hourlySummary;
    let hoursWritten = 0;
    for (const hour of hours) {
      const values = {
        formulaVersion: ANALYTICS_FORMULA_VERSION,
        computedAt: now,
        ticketsSatang: hour.ticketsSatang,
        fnbSatang: hour.fnbSatang,
        merchSatang: hour.merchSatang,
        partiesSatang: hour.partiesSatang,
        dropoffSatang: hour.dropoffSatang,
        revenueSatang: hour.revenueSatang,
        txnCount: hour.txnCount,
        guests: hour.guests,
      };
      const written = await tx
        .insert(h)
        .values({
          id: newId(),
          operatorId: clock.operatorId,
          branchId: clock.id,
          businessDate: date,
          hour: hour.hour,
          source: SOURCE,
          ...values,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [h.branchId, h.businessDate, h.hour, h.source],
          set: { ...values, updatedAt: now },
          setWhere: sql`(${h.formulaVersion}, ${h.ticketsSatang}, ${h.fnbSatang}, ${h.merchSatang}, ${h.partiesSatang}, ${h.dropoffSatang}, ${h.revenueSatang}, ${h.txnCount}, ${h.guests})
            is distinct from (excluded.formula_version, excluded.tickets_satang, excluded.fnb_satang, excluded.merch_satang, excluded.parties_satang, excluded.dropoff_satang, excluded.revenue_satang, excluded.txn_count, excluded.guests)`,
        })
        .returning({ id: h.id });
      hoursWritten += written.length;
    }
    const keep = hours.map((hour) => hour.hour);
    const removed = await tx
      .delete(h)
      .where(
        and(
          eq(h.branchId, clock.id),
          eq(h.businessDate, date),
          eq(h.source, SOURCE),
          ...(keep.length > 0 ? [notInArray(h.hour, keep)] : []),
        ),
      )
      .returning({ id: h.id });
    if (claim) await consumeDirtyClaim(tx, claim.claim, claim.claimedBy);
    return {
      outcome: hoursWritten > 0 || removed.length > 0 ? ('written' as const) : ('unchanged' as const),
      hoursWritten,
      hoursRemoved: removed.length,
    };
  });
}

// --- The calendar -----------------------------------------------------------------------

/**
 * Keep `analytics.dim_date` current for every live branch: from a year back,
 * or the branch's first sale or first calendar row if earlier, to a year
 * ahead of its today, by the pricing resolver's rule (`getRateModeForDate`):
 * inside a live holiday range is `holiday`, Saturday and Sunday `weekend`,
 * the rest `weekday`. Only a day whose answer moved is written — a holiday
 * added or withdrawn changes its own days and nothing else.
 */
export async function refreshDimDate(db: Exec, now: Date): Promise<number> {
  const at = now.toISOString();
  const { rows } = await db.execute<{ id: string }>(sql`
    with live as (
      select b.id, b.operator_id,
             ((${at}::timestamptz at time zone b.timezone) - (b.business_day_start - time '00:00'))::date as today
        from core.branch b
       where b.archived_at is null
    ),
    span as (
      select live.id, live.operator_id,
             least(live.today - ${DIM_DATE_DAYS}::int,
                   coalesce((select min(s.business_date) from pos.sale s where s.branch_id = live.id), live.today),
                   coalesce((select min(dd.date) from analytics.dim_date dd where dd.branch_id = live.id), live.today)) as first_day,
             live.today + ${DIM_DATE_DAYS}::int as last_day
        from live
    ),
    days as (
      select span.id as branch_id, span.operator_id, g::date as day
        from span
       cross join lateral generate_series(span.first_day::timestamp, span.last_day::timestamp, interval '1 day') g
    ),
    computed as (
      select days.operator_id, days.branch_id, days.day,
             extract(isodow from days.day)::smallint as weekday,
             case when h.name is not null then 'holiday'
                  when extract(isodow from days.day) in (6, 7) then 'weekend'
                  else 'weekday' end as rate_mode,
             h.name as holiday_name
        from days
        left join lateral (
          select bh.name
            from pos.branch_holiday bh
           where bh.branch_id = days.branch_id and bh.archived_at is null
             and days.day between bh.starts_on and bh.ends_on
           order by bh.starts_on, bh.id
           limit 1
        ) h on true
    )
    insert into analytics.dim_date as dd (id, operator_id, branch_id, date, weekday, rate_mode, holiday_name, created_at, updated_at)
    select gen_random_uuid(), c.operator_id, c.branch_id, c.day, c.weekday, c.rate_mode, c.holiday_name,
           ${at}::timestamptz, ${at}::timestamptz
      from computed c
     -- Only a day that is new or whose answer moved: an unchanged day is not touched.
     where not exists (
       select 1 from analytics.dim_date cur
        where cur.branch_id = c.branch_id and cur.date = c.day and cur.weekday = c.weekday
          and cur.rate_mode = c.rate_mode and cur.holiday_name is not distinct from c.holiday_name)
    on conflict (branch_id, date) do update
       set weekday = excluded.weekday, rate_mode = excluded.rate_mode, holiday_name = excluded.holiday_name,
           updated_at = excluded.updated_at
    returning dd.id`);
  return rows.length;
}

// --- The jobs --------------------------------------------------------------------------

export interface DailyRollupDetail extends Record<string, number> {
  branches: number;
  days: number;
  written: number;
  unchanged: number;
  frozen: number;
  claimed: number;
  calendarDays: number;
}

interface PlannedDay {
  clock: RollupBranchClock;
  date: string;
  claim?: DirtyClaim;
}

function planKey(branchId: string, date: string): string {
  return `${branchId}|${date}`;
}

/** Days in date order, then branch, so a backlog is worked oldest first. */
function ordered(plan: Map<string, PlannedDay>): PlannedDay[] {
  return [...plan.values()].sort((a, b) => a.date.localeCompare(b.date) || a.clock.id.localeCompare(b.clock.id));
}

/**
 * `job:rollup.daily`. One branch-day that cannot be written does not stop the
 * others; the run then fails loudly with the count, so the Failures page
 * carries it, and the day's claim is released for the next run.
 */
export async function runDailyRollupJob(db: Db, now: Date): Promise<DailyRollupDetail> {
  const claimedBy = `${ROLLUP_DAILY_JOB}:${newId()}`;
  const clocks = await branchClocks(db);
  const plan = new Map<string, PlannedDay>();
  const live = [...clocks.values()].filter((c) => c.live);
  for (const clock of live) {
    const today = branchToday(clock, now);
    plan.set(planKey(clock.id, today), { clock, date: today });
  }
  // Every day still provisional once it has ended at its branch.
  const provisional = await db
    .select({ branchId: dailySummary.branchId, businessDate: dailySummary.businessDate })
    .from(dailySummary)
    .where(and(eq(dailySummary.provisional, true), eq(dailySummary.source, SOURCE)));
  for (const row of provisional) {
    const clock = clocks.get(row.branchId);
    if (!clock || row.businessDate >= branchToday(clock, now)) continue;
    plan.set(planKey(clock.id, row.businessDate), { clock, date: row.businessDate });
  }
  const claims = await claimDirtyDates(db, 'sales', claimedBy, now);
  for (const claim of claims) {
    const clock = clocks.get(claim.branchId);
    if (!clock) continue;
    const key = planKey(claim.branchId, claim.businessDate);
    plan.set(key, { ...(plan.get(key) ?? { clock, date: claim.businessDate }), claim });
  }

  const detail: DailyRollupDetail = {
    branches: live.length,
    days: 0,
    written: 0,
    unchanged: 0,
    frozen: 0,
    claimed: claims.length,
    calendarDays: 0,
  };
  let failed = 0;
  let firstError: unknown = null;
  for (const day of ordered(plan)) {
    detail.days += 1;
    try {
      const outcome = await rollupDailyBranchDay(
        db,
        day.clock,
        day.date,
        now,
        day.claim ? { claim: day.claim, claimedBy } : undefined,
      );
      detail[outcome] += 1;
    } catch (err) {
      failed += 1;
      firstError ??= err;
      if (day.claim) await releaseDirtyClaim(db, day.claim, claimedBy).catch(() => undefined);
    }
  }
  try {
    detail.calendarDays = await refreshDimDate(db, now);
  } catch (err) {
    failed += 1;
    firstError ??= err;
  }
  if (failed > 0) {
    throw new Error(`daily rollup: ${failed} of ${detail.days + 1} steps could not be written`, { cause: firstError });
  }
  return detail;
}

export interface HourlyRollupDetail extends Record<string, number> {
  branches: number;
  days: number;
  hoursWritten: number;
  hoursRemoved: number;
  frozen: number;
  claimed: number;
}

/** `job:rollup.hourly` — today at every live branch, and every day the daily rollup handed over. */
export async function runHourlyRollupJob(db: Db, now: Date): Promise<HourlyRollupDetail> {
  const claimedBy = `${ROLLUP_HOURLY_JOB}:${newId()}`;
  const clocks = await branchClocks(db);
  const plan = new Map<string, PlannedDay>();
  const live = [...clocks.values()].filter((c) => c.live);
  for (const clock of live) {
    const today = branchToday(clock, now);
    plan.set(planKey(clock.id, today), { clock, date: today });
  }
  const claims = await claimDirtyDates(db, 'hourly', claimedBy, now);
  for (const claim of claims) {
    const clock = clocks.get(claim.branchId);
    if (!clock) continue;
    const key = planKey(claim.branchId, claim.businessDate);
    plan.set(key, { ...(plan.get(key) ?? { clock, date: claim.businessDate }), claim });
  }
  const detail: HourlyRollupDetail = {
    branches: live.length,
    days: 0,
    hoursWritten: 0,
    hoursRemoved: 0,
    frozen: 0,
    claimed: claims.length,
  };
  let failed = 0;
  let firstError: unknown = null;
  for (const day of ordered(plan)) {
    detail.days += 1;
    try {
      const done = await rollupHourlyBranchDay(
        db,
        day.clock,
        day.date,
        now,
        day.claim ? { claim: day.claim, claimedBy } : undefined,
      );
      detail.hoursWritten += done.hoursWritten;
      detail.hoursRemoved += done.hoursRemoved;
      if (done.outcome === 'frozen') detail.frozen += 1;
    } catch (err) {
      failed += 1;
      firstError ??= err;
      if (day.claim) await releaseDirtyClaim(db, day.claim, claimedBy).catch(() => undefined);
    }
  }
  if (failed > 0) {
    throw new Error(`hourly rollup: ${failed} of ${detail.days} branch-days could not be written`, { cause: firstError });
  }
  return detail;
}
