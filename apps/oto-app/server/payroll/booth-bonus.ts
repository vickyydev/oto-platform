import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { suiteProvisionConfig } from '../lib/suiteSignIn';
import {
  branches,
  employees,
  users,
  payrollBoothRules,
  payrollBoothPersonRates,
  payrollBoothBonuses,
} from '@shared/schema';
import {
  boothPageSchema,
  windows,
  withinWindow,
  type BoothRecord,
  type BoothReport,
  type BoothReportRow,
  type BoothSettings,
  type BonusWindow,
} from '@shared/booth-bonus';
import { PayrollRefusal, requireReason, recordChange, type PayrollActor } from './setup';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
import { namesOnSlip } from './booth-roster';
import { loadAttendanceFeed } from './attendance';

export const lockBoothBonuses = (tx: Tx, tenantId: string) =>
  tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('payroll-booth-bonus'),hashtext(${tenantId}))`,
  );

export async function boothSettings(
  tenantId: string,
  canManage: boolean,
  day: string,
): Promise<BoothSettings> {
  const rules = await db
    .select()
    .from(payrollBoothRules)
    .where(eq(payrollBoothRules.tenantId, tenantId))
    .orderBy(desc(payrollBoothRules.from));
  const rates = await db
    .select({
      id: payrollBoothPersonRates.employeeId,
      name: employees.fullName,
      from: payrollBoothPersonRates.from,
      until: payrollBoothPersonRates.until,
      rateSatang: payrollBoothPersonRates.rateSatang,
    })
    .from(payrollBoothPersonRates)
    .innerJoin(
      employees,
      and(eq(employees.id, payrollBoothPersonRates.employeeId), eq(employees.tenantId, tenantId)),
    )
    .where(
      and(eq(payrollBoothPersonRates.tenantId, tenantId), lte(payrollBoothPersonRates.from, day)),
    )
    .orderBy(
      desc(payrollBoothPersonRates.from),
      desc(payrollBoothPersonRates.createdAt),
      desc(payrollBoothPersonRates.id),
    );
  const seen = new Set<string>();
  const people = canManage
    ? await db
        .select({ id: employees.id, name: employees.fullName })
        .from(employees)
        .where(eq(employees.tenantId, tenantId))
        .orderBy(asc(employees.fullName))
    : [];
  return {
    canManage,
    today: day,
    people,
    rules: rules.map((r) => ({
      from: r.from,
      rateSatang: r.rateSatang,
      window: r.window as BonusWindow,
    })),
    rates: rates.flatMap((r) => {
      if (seen.has(r.id)) return [];
      seen.add(r.id);
      return r.rateSatang === null || (r.until && r.until < day)
        ? []
        : [
            {
              employeeId: r.id,
              name: r.name,
              rateSatang: r.rateSatang,
              from: r.from,
              until: r.until,
            },
          ];
    }),
  };
}

export async function saveBoothRule(
  tenantId: string,
  actor: PayrollActor,
  body: Record<string, unknown>,
) {
  const amount = z.number().int().min(0).max(2147483647);
  const parsed = z
    .object({
      from: z.string().date(),
      rateSatang: amount,
      window: z.enum(windows),
      overrides: z
        .array(z.object({ employeeId: z.string().min(1), rateSatang: amount.nullable() }))
        .max(300)
        .default([]),
    })
    .safeParse(body);
  if (!parsed.success)
    throw new PayrollRefusal(
      400,
      'Choose a start date, an amount in baht and a redemption time limit.',
    );
  const reason = requireReason(body.reason);
  return db.transaction(async (tx) => {
    await lockBoothBonuses(tx, tenantId);
    const [last] = await tx
      .select()
      .from(payrollBoothRules)
      .where(eq(payrollBoothRules.tenantId, tenantId))
      .orderBy(desc(payrollBoothRules.from))
      .limit(1);
    if (last && parsed.data.from <= last.from)
      throw new PayrollRefusal(409, 'Choose a start date after the last saved rule.');
    const { overrides, ...rule } = parsed.data;
    const ids = new Set(overrides.map((x) => x.employeeId));
    if (ids.size !== overrides.length) throw new PayrollRefusal(400, 'Choose each person once.');
    for (const item of overrides) {
      const [p] = await tx
        .select({ id: employees.id })
        .from(employees)
        .where(and(eq(employees.tenantId, tenantId), eq(employees.id, item.employeeId)))
        .limit(1);
      if (!p) throw new PayrollRefusal(400, 'Choose a person in this park group.');
      await tx
        .insert(payrollBoothPersonRates)
        .values({ tenantId, from: rule.from, ...item, reason });
    }
    const [saved] = await tx
      .insert(payrollBoothRules)
      .values({ tenantId, ...rule, reason })
      .returning();
    await recordChange(tx, tenantId, actor, {
      kind: 'setup',
      subject: 'booth-voucher-bonus',
      subjectId: saved.id,
      reason,
      oldValue: last ?? null,
      newValue: parsed.data,
    });
    return { id: saved.id };
  });
}

async function readFacts(coreId: string, month: string): Promise<BoothRecord[]> {
  const cfg = suiteProvisionConfig();
  if (!cfg)
    throw new PayrollRefusal(
      503,
      "Payroll cannot reach the till for this month's booth vouchers. Check the HR app's platform connection.",
    );
  const rows: BoothRecord[] = [];
  let after: string | null = null;
  do {
    const url = new URL(cfg.apiUrl + '/otoapp/payroll/booth-vouchers');
    url.searchParams.set('month', month);
    url.searchParams.set('branchId', coreId);
    if (after) url.searchParams.set('after', after);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${cfg.key}` },
      signal: AbortSignal.timeout(10000),
    }).catch(() => {
      throw new PayrollRefusal(
        503,
        'The till did not answer the booth voucher check. Please retry before confirming payroll.',
      );
    });
    if (!response.ok)
      throw new PayrollRefusal(
        503,
        'The till could not verify the booth voucher records. Please retry before confirming payroll.',
      );
    const page = boothPageSchema.safeParse(await response.json().catch(() => null));
    if (!page.success || (page.data.next !== null && page.data.next <= (after ?? '')))
      throw new PayrollRefusal(
        503,
        'The till returned an incomplete booth voucher report. Please retry.',
      );
    rows.push(...page.data.records);
    after = page.data.next;
  } while (after);
  return rows;
}

function rowFor(map: Map<string, BoothReportRow>, id: string, label: string) {
  let row = map.get(id);
  if (!row) {
    row = { id, label, issued: 0, inside: 0, outside: 0, redeemed: 0, spendSatang: 0, sales: 0 };
    map.set(id, row);
  }
  return row;
}

export async function loadBoothReport(
  tenantId: string,
  month: string,
  feed?: { from: string; clockDays: Set<string> },
): Promise<BoothReport> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw new PayrollRefusal(400, 'Choose a payroll month.');
  const report: BoothReport = {
    month,
    active: false,
    awards: [],
    people: [],
    booths: [],
    flags: [],
  };
  const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0))
    .toISOString()
    .slice(0, 10);
  const [enabled] = await db
    .select({ from: payrollBoothRules.from })
    .from(payrollBoothRules)
    .where(and(eq(payrollBoothRules.tenantId, tenantId), lte(payrollBoothRules.from, lastDay)))
    .orderBy(asc(payrollBoothRules.from))
    .limit(1);
  if (!enabled) return report;
  report.active = true;
  const oldPay = await db.execute(sql`select 1 from payroll_incentive_clause_readings reading
    cross join lateral jsonb_array_elements(reading.rules) ref
    join payroll_incentive_assignments a on a.tenant_id=${tenantId} and a.rule_id::text=ref->>'ruleId'
    where reading.tenant_id=${tenantId} and reading.employee_id=a.employee_id and not a.superseded and not a.excluded
      and a.effective_from<=${lastDay}::date
      and (a.effective_to is null or a.effective_to>=greatest(${month + '-01'}::date, ${enabled.from}::date))
      and (reading.reading->'parts'->((ref->>'part')::int)->>'quote') ~* '(flyer|leaflet)'
      and (reading.reading->'parts'->((ref->>'part')::int)->>'quote') ~* '(return|redeem)' limit 1`);
  if (oldPay.rows.length)
    throw new PayrollRefusal(
      409,
      'Convert the approved returned-flyer readings to booth voucher bonuses before checking this month. The old team count would pay the same work twice.',
    );
  const parks = await db
    .select({ id: branches.id, core: branches.coreBranchId, timezone: branches.timezone })
    .from(branches)
    .where(eq(branches.tenantId, tenantId));
  const directory = await db
    .select({
      id: employees.id,
      name: employees.fullName,
      nickname: employees.nickname,
      accountId: users.platformUserId,
      start: employees.startDate,
      end: employees.lastWorkingDay,
    })
    .from(employees)
    .leftJoin(users, eq(users.id, employees.userId))
    .where(eq(employees.tenantId, tenantId));
  const staff = new Map(directory.map((p) => [p.id, p]));
  const facts: { branchId: string; fact: BoothRecord }[] = [];
  for (const park of parks.filter((p) => p.core))
    for (const fact of await readFacts(park.core!, month)) facts.push({ branchId: park.id, fact });
  if (!parks.some((p) => p.core))
    throw new PayrollRefusal(503, 'No park in this payroll group is linked to the new till.');
  const clockDays = feed?.clockDays ?? new Set<string>();
  const olderDays = new Map<string, Map<string, string>>();
  for (const { fact, branchId } of facts) {
    if (
      !fact.usedDay?.startsWith(month) ||
      fact.reversedAt ||
      (feed && fact.issuedDay >= feed.from)
    )
      continue;
    const roster = olderDays.get(fact.issuedDay) ?? new Map<string, string>();
    for (const id of namesOnSlip(fact, directory).ids) roster.set(id, branchId);
    olderDays.set(fact.issuedDay, roster);
  }
  const timezones = new Map(parks.map((p) => [p.id, p.timezone]));
  for (const [day, roster] of olderDays) {
    const people = [...roster].map(([id, rosterBranchId]) => ({
      id,
      rosterBranchId,
      weeklyOffDays: [],
    }));
    const attendance = await loadAttendanceFeed(tenantId, people, {
      from: day,
      to: day,
      today: lastDay,
      timezones,
      defaultTimezone: 'Asia/Bangkok',
    });
    for (const d of attendance.days)
      if (d.actualClockIn || d.effectiveClockIn) clockDays.add(d.staffId + '|' + d.date);
  }
  return db.transaction(async (tx) => {
    await lockBoothBonuses(tx, tenantId);
    const rules = await tx
      .select()
      .from(payrollBoothRules)
      .where(eq(payrollBoothRules.tenantId, tenantId))
      .orderBy(desc(payrollBoothRules.from));
    const rates = await tx
      .select()
      .from(payrollBoothPersonRates)
      .where(eq(payrollBoothPersonRates.tenantId, tenantId))
      .orderBy(
        desc(payrollBoothPersonRates.from),
        desc(payrollBoothPersonRates.createdAt),
        desc(payrollBoothPersonRates.id),
      );
    const voucherIds = facts.map(({ fact }) => fact.voucherId);
    if (!voucherIds.length) return report;
    const voucherList = sql`select value::uuid from jsonb_array_elements_text(${JSON.stringify(voucherIds)}::jsonb)`;
    const saved = await tx
      .select()
      .from(payrollBoothBonuses)
      .where(
        and(
          eq(payrollBoothBonuses.tenantId, tenantId),
          sql`${payrollBoothBonuses.voucherId} in (${voucherList})`,
        ),
      );
    const held = new Map(saved.map((s) => [s.voucherId + '|' + s.employeeId, s]));
    const frozenStaff = new Map<string, string[]>();
    for (const entry of saved) {
      const ids = frozenStaff.get(entry.voucherId) ?? [];
      ids.push(entry.employeeId);
      frozenStaff.set(entry.voucherId, ids);
    }
    const candidates: (typeof payrollBoothBonuses.$inferInsert)[] = [];
    const byPerson = new Map<string, BoothReportRow>(),
      byBooth = new Map<string, BoothReportRow>();
    // A re-issued voucher can move to another sale before lock. A frozen run already owns its payment.
    const locked = await tx.execute(sql`
      select distinct a->>'voucherId' as voucher_id, a->>'saleId' as sale_id, l.employee_id, ver.paid_at
      from payroll_run_snapshots s
      join payroll_run_versions ver on ver.id=s.run_version_id and ver.tenant_id=s.tenant_id and ver.status in ('locked','paid')
      join payroll_run_lines l on l.snapshot_id=s.id and l.tenant_id=s.tenant_id and l.component='incentive:booth-voucher'
      cross join lateral jsonb_array_elements(coalesce(s.world->'doc'->'boothAwards','[]'::jsonb)) a
      where s.tenant_id=${tenantId} and a->>'employeeId'=l.employee_id and (a->>'voucherId')::uuid in (${voucherList})`);
    for (const { fact } of facts)
      for (const reversal of fact.reversals) {
        const localDay = new Intl.DateTimeFormat('en-CA', {
          timeZone: fact.timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date(reversal.at));
        const nextMonth = new Date(
          Date.UTC(Number(reversal.usedDay.slice(0, 4)), Number(reversal.usedDay.slice(5, 7)), 1),
        )
          .toISOString()
          .slice(0, 7);
        const due = [nextMonth, localDay.slice(0, 7)].sort().at(-1);
        if (
          month === due &&
          locked.rows.some(
            (row) =>
              row.voucher_id === fact.voucherId &&
              row.sale_id === reversal.saleId &&
              row.paid_at &&
              new Date(String(row.paid_at)).getTime() < Date.parse(reversal.at),
          )
        ) {
          report.flags.push({
            voucherId: fact.voucherId,
            booth: fact.booth,
            reason: 'Refunded after pay — manager review',
          });
        }
      }
    const countedSales = new Set<string>();
    for (const { branchId, fact: f } of facts) {
      const policy = rules.find((r) => r.from <= f.issuedDay);
      if (!policy) continue;
      const matched = namesOnSlip(f, directory);
      const flag = (reason: string) =>
        report.flags.push({ voucherId: f.voucherId, booth: f.booth, reason });
      if (!f.staffLabel && !matched.ids.length) flag('Nobody on the printed roster');
      else if (matched.unmatched || !matched.ids.length) flag('Name not matched to a person');
      if (f.sharedCode && !f.saleId) flag('Shared code: a till sale cannot identify this slip');
      const liveSale =
        !!f.saleId &&
        !!f.usedAt &&
        !f.reversedAt &&
        ['paid', 'finalised'].includes(f.saleState ?? '');
      const update = (row: BoothReportRow, window: BonusWindow) => {
        if (f.issuedMonth !== month) return;
        row.issued++;
        if (!liveSale) return;
        row.redeemed++;
        if (withinWindow(f, window)) row.inside++;
        else row.outside++;
        const saleKey = row.id + '|' + f.saleId;
        if (!countedSales.has(saleKey)) {
          countedSales.add(saleKey);
          row.sales++;
          row.spendSatang += f.spendSatang;
        }
      };
      update(
        rowFor(byBooth, f.stationId + '|' + f.issuedDay, f.booth + ' · ' + f.issuedDay),
        policy.window as BonusWindow,
      );
      for (const id of frozenStaff.get(f.voucherId) ?? matched.ids) {
        const frozen = held.get(f.voucherId + '|' + id);
        const otherRun = locked.rows.some(
          (row) =>
            row.voucher_id === f.voucherId && row.employee_id === id && row.sale_id !== f.saleId,
        );
        const window = (frozen?.window ?? policy.window) as BonusWindow;
        update(rowFor(byPerson, id, staff.get(id)?.name ?? 'Unknown employee'), window);
        if (
          otherRun ||
          !liveSale ||
          !f.usedAt ||
          !f.usedDay?.startsWith(month) ||
          !f.saleId ||
          !withinWindow(f, window)
        )
          continue;
        const own = rates.find((r) => r.employeeId === id && r.from <= f.issuedDay);
        const rateSatang =
          frozen?.rateSatang ??
          (own && (!own.until || own.until >= f.issuedDay) ? own.rateSatang : null) ??
          policy.rateSatang;
        // The first-count row is immutable. Any later surviving sale is evidenced by this run's own snapshot.
        if (!frozen)
          candidates.push({
            tenantId,
            voucherId: f.voucherId,
            saleId: f.saleId,
            employeeId: id,
            branchId,
            stationId: f.stationId,
            issuedAt: new Date(f.issuedAt),
            usedAt: new Date(f.usedAt),
            month,
            rateSatang,
            window,
          });
        const noClockIn = !clockDays.has(id + '|' + f.issuedDay);
        if (noClockIn) flag('Named person has no clock-in on issue day');
        report.awards.push({
          voucherId: f.voucherId,
          employeeId: id,
          saleId: f.saleId,
          issuedAt: f.issuedAt,
          usedAt: f.usedAt,
          usedDay: f.usedDay,
          rateSatang,
          window,
          branchId,
          stationId: f.stationId,
          noClockIn,
        });
      }
    }
    for (let i = 0; i < candidates.length; i += 500)
      await tx
        .insert(payrollBoothBonuses)
        .values(candidates.slice(i, i + 500))
        .onConflictDoNothing();
    report.people = [...byPerson.values()].filter((x) => x.issued);
    report.booths = [...byBooth.values()].filter((x) => x.issued);
    return report;
  });
}
