import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { branch, checkin, product, registration, type FoodProvisionRow } from '@oto/db';
import {
  BookingSupervisionInputSchema,
  BookingSupervisionSnapshotSchema,
  isIsoDate,
  newId,
  resolveRequirement,
  type BookingSupervisionInput,
  type BookingSupervisionSnapshot,
  type SupervisionPolicy,
} from '@oto/shared';
import { errors } from '../lib/errors';
import { audit } from './audit';
import type { BookingRow } from './booking-payment';
import type { Exec, Tx } from './tx';

/** Resolve children and food from the branch catalogue, never from browser prices. */
export async function quoteBookingChild(
  exec: Exec,
  br: typeof branch.$inferSelect,
  value: BookingSupervisionInput,
  visitDate: string,
  mode: 'weekday' | 'weekend',
  policy: SupervisionPolicy,
  minutes: number,
): Promise<BookingSupervisionSnapshot> {
  const parsed = BookingSupervisionInputSchema.safeParse(value);
  if (!parsed.success) throw errors.badRequest('Check the supervised child details.');
  const child = parsed.data;
  let age = child.ageYears;
  if (child.dateOfBirth) {
    if (!isIsoDate(child.dateOfBirth) || child.dateOfBirth > visitDate) throw errors.badRequest('Check the child date of birth.');
    age = Number(visitDate.slice(0, 4)) - Number(child.dateOfBirth.slice(0, 4)) - (visitDate.slice(5) < child.dateOfBirth.slice(5) ? 1 : 0);
    if (age < 0 || age > 17) throw errors.badRequest('A supervised child must be under 18 on the visit date.');
  }
  const service = resolveRequirement(age, policy);
  if (service === 'nanny' && !child.nannyStartTime) throw errors.badRequest('Choose the nanny start time.');
  let food: FoodProvisionRow = { mode: 'none', paidSatang: 0 };
  if (child.foodProvision?.mode === 'prepaid_credit') {
    const amount = child.foodProvision.creditSatang ?? child.foodProvision.paidSatang;
    food = amount > 0 ? { mode: 'prepaid_credit', paidSatang: amount, creditSatang: amount } : food;
  } else if (child.foodProvision?.mode === 'prepaid_items') {
    const wanted = child.foodProvision.items ?? [];
    if (!wanted.length) throw errors.badRequest('Choose the prepaid food items.');
    const ids = wanted.map((i) => i.menuItemId);
    if (new Set(ids).size !== ids.length) throw errors.badRequest('A prepaid food item is listed twice.');
    const rows = await exec.select().from(product).where(and(
      eq(product.operatorId, br.operatorId), eq(product.kind, 'menu'), eq(product.active, true),
      isNull(product.archivedAt), or(isNull(product.branchId), eq(product.branchId, br.id)), inArray(product.id, ids),
    ));
    const items = wanted.map((item) => {
      const row = rows.find((p) => p.id === item.menuItemId);
      if (!row) throw errors.badRequest('A selected food item is no longer available at this park.');
      return { menuItemId: row.id, menuItemName: row.name, unitSatang: mode === 'weekend' ? row.priceWeekendSatang ?? row.priceSatang : row.priceSatang, qty: item.qty, redeemedQty: 0 };
    });
    food = { mode: 'prepaid_items', paidSatang: items.reduce((sum, i) => sum + i.unitSatang * i.qty, 0), items };
  }
  return { ...child, ageYears: age, service, minutes, serviceFeeSatang: 0, foodProvision: food };
}

/** Called under the booking lock, in the transaction that confirms its money. */
export async function registerPaidBookingChildren(tx: Tx, row: BookingRow, now: Date, requestId: string | null): Promise<Record<string, unknown>> {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  if (typeof payload.registrationId === 'string') return payload;
  const lines = Array.isArray(payload.lines) ? payload.lines as Array<Record<string, unknown>> : [];
  if (!lines.some((l) => l.supervision)) return payload;
  const regId = newId();
  const acknowledgements = payload.acknowledgedConfirmations as typeof registration.$inferInsert.acknowledgedConfirmations;
  const guardianName = typeof payload.parentName === 'string' ? payload.parentName : '';
  const phone = typeof payload.phone === 'string' ? payload.phone : null;
  const consentAt = typeof payload.consentRecordedAt === 'string' ? new Date(payload.consentRecordedAt) : null;
  if (!guardianName || !phone || !consentAt || !Number.isFinite(consentAt.getTime())) throw errors.badRequest('This supervised booking has no recorded guardian consent.');
  await tx.insert(registration).values({
    id: regId, operatorId: row.operatorId, branchId: row.branchId, memberId: row.memberId,
    guardianName, guardianPhone: phone, contactChannel: typeof payload.contactChannel === 'string' ? payload.contactChannel : 'whatsapp',
    consentRecordedAt: consentAt, acknowledgedConfirmations: acknowledgements ?? [], source: 'booking',
  });
  const [br] = await tx.select({ timezone: branch.timezone }).from(branch).where(eq(branch.id, row.branchId)).limit(1);
  const saved = [];
  for (const line of lines) {
    if (!line.supervision) { saved.push(line); continue; }
    const child = BookingSupervisionSnapshotSchema.parse(line.supervision);
    const checkinId = newId();
    // The booking date and chosen start are park-local. No timer starts here.
    const scheduledFor = child.nannyStartTime
      ? sql`(${row.bookingDate}::date + ${child.nannyStartTime}::time) at time zone ${br!.timezone}`
      : null;
    await tx.insert(checkin).values({
      id: checkinId, operatorId: row.operatorId, branchId: row.branchId, registrationId: regId,
      childName: child.childName, childAgeYears: child.ageYears, dateOfBirth: child.dateOfBirth ?? null,
      allergies: child.allergies || null, foodRestrictions: child.foodRestrictions || null,
      foodProvision: child.foodProvision ?? { mode: 'none', paidSatang: 0 },
      mayOrderFood: (child.foodProvision?.paidSatang ?? 0) > 0, service: child.service,
      status: 'registered', bookedMinutes: child.minutes, scheduledFor,
    });
    await audit.record(tx, { actorAccountId: null, operatorId: row.operatorId, branchId: row.branchId,
      action: 'checkin.create', entityType: 'checkin', entityId: checkinId, requestId,
      after: { registrationId: regId, bookingId: row.id, service: child.service, status: 'registered', bookedMinutes: child.minutes },
    });
    saved.push({ ...line, supervision: { ...child, checkinId } });
  }
  await audit.record(tx, { actorAccountId: null, operatorId: row.operatorId, branchId: row.branchId,
    action: 'registration.create', entityType: 'registration', entityId: regId, requestId,
    after: { bookingId: row.id, source: 'booking', children: saved.filter((l) => l.supervision).length, paidAt: now.toISOString() },
  });
  return { ...payload, registrationId: regId, lines: saved };
}
