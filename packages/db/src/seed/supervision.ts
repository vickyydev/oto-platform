/**
 * S2-13 — every branch's supervision config and the nanny roster.
 *
 * Migration 0043 gave every branch that existed when it ran the prototype's
 * config; a database built from empty runs the migrations BEFORE the seed
 * creates its branches, so the seed gives each branch the same rows, from the
 * same named constants (`DEFAULT_SUPERVISION_POLICY`, `DEFAULT_DROP_OFF_PRICING`
 * in `@oto/shared`, which are the prototype's `store/catalogStore.ts:678-712`).
 *
 * The roster is the prototype's (`mockApi.ts:3974-3979`): Pim, Jum and Bow on
 * shift, Aor not. A shift row covers the park's opening hours (10:00-20:00
 * Bangkok) for each of the next fourteen days from the day the seed runs;
 * feeding the roster from the staff rota is its own ticket (OD-C4).
 *
 * Keyed and safe to re-run: config rows are per branch (`ON CONFLICT DO
 * NOTHING`), a nanny is found by branch and name, and a shift by nanny and
 * start.
 */
import {
  DEFAULT_DROP_OFF_PRICING,
  DEFAULT_SUPERVISION_POLICY,
  newId,
} from '@oto/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../index';
import * as s from '../schema/index';

const ROSTER: { name: string; onShift: boolean }[] = [
  { name: 'Pim', onShift: true },
  { name: 'Jum', onShift: true },
  { name: 'Bow', onShift: true },
  { name: 'Aor', onShift: false },
];

/** Bangkok is UTC+7 with no daylight saving: 10:00 local is 03:00Z. */
const OPEN_UTC_HOUR = 3;
const CLOSE_UTC_HOUR = 13;
const SHIFT_DAYS = 14;

export async function seedSupervisionConfig(db: Db, branch: { id: string; operatorId: string }): Promise<void> {
  const policy = DEFAULT_SUPERVISION_POLICY;
  await db
    .insert(s.supervisionPolicy)
    .values({
      id: newId(),
      operatorId: branch.operatorId,
      branchId: branch.id,
      bands: policy.bands,
      siblingWaiverEnabled: policy.siblingWaiver.enabled,
      waivableRequirement: policy.siblingWaiver.waivableRequirement,
      guardianMinAge: policy.siblingWaiver.guardianMinAge,
      waiverStaffOnly: policy.siblingWaiver.staffOnly,
      nannyRatioSoftMax: DEFAULT_DROP_OFF_PRICING.nannyRatioSoftMax,
    })
    .onConflictDoNothing({ target: s.supervisionPolicy.branchId });
  for (const item of policy.confirmations) {
    await db
      .insert(s.confirmationItem)
      .values({
        id: newId(),
        operatorId: branch.operatorId,
        branchId: branch.id,
        code: item.id,
        text: item.text,
        required: item.required,
        sortOrder: item.order,
      })
      .onConflictDoNothing({
        target: [s.confirmationItem.branchId, s.confirmationItem.code],
        where: sql`archived_at is null`,
      });
  }
  const p = DEFAULT_DROP_OFF_PRICING;
  await db
    .insert(s.dropOffPricing)
    .values({
      id: newId(),
      operatorId: branch.operatorId,
      branchId: branch.id,
      oneTimeFeeWeekdaySatang: p.oneTimeFee.weekday,
      oneTimeFeeWeekendSatang: p.oneTimeFee.weekend,
      nannyHourlyWeekdaySatang: p.nannyHourly.weekday,
      nannyHourlyWeekendSatang: p.nannyHourly.weekend,
      extraHourWeekdaySatang: p.extraHour.weekday,
      extraHourWeekendSatang: p.extraHour.weekend,
      fullDayHours: p.fullDayHours,
      prepaidFoodUnused: p.prepaidFoodUnused,
    })
    .onConflictDoNothing({ target: s.dropOffPricing.branchId });
}

export async function seedNannyRoster(
  db: Db,
  branch: { id: string; operatorId: string },
  today: Date = new Date(),
): Promise<void> {
  for (const entry of ROSTER) {
    const [found] = await db
      .select({ id: s.nanny.id })
      .from(s.nanny)
      .where(and(eq(s.nanny.branchId, branch.id), eq(s.nanny.name, entry.name)))
      .limit(1);
    const nannyId = found?.id ?? newId();
    if (!found) {
      await db.insert(s.nanny).values({ id: nannyId, operatorId: branch.operatorId, branchId: branch.id, name: entry.name });
    }
    if (!entry.onShift) continue;
    for (let d = 0; d < SHIFT_DAYS; d++) {
      const day = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + d);
      const startsAt = new Date(day + OPEN_UTC_HOUR * 3_600_000);
      const endsAt = new Date(day + CLOSE_UTC_HOUR * 3_600_000);
      const [shift] = await db
        .select({ id: s.nannyShift.id })
        .from(s.nannyShift)
        .where(and(eq(s.nannyShift.nannyId, nannyId), eq(s.nannyShift.startsAt, startsAt)))
        .limit(1);
      if (!shift) {
        await db
          .insert(s.nannyShift)
          .values({ id: newId(), operatorId: branch.operatorId, nannyId, branchId: branch.id, startsAt, endsAt });
      }
    }
  }
}

/** Every branch's config; the roster at the operator's own parks only. */
export async function seedSupervision(db: Db, rosterOperatorId: string): Promise<void> {
  const branches = await db.select({ id: s.branch.id, operatorId: s.branch.operatorId }).from(s.branch);
  for (const br of branches) {
    await seedSupervisionConfig(db, br);
    if (br.operatorId === rosterOperatorId) await seedNannyRoster(db, br);
  }
}
