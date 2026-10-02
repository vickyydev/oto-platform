import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import {
  account,
  auditLog,
  employee,
  band,
  branch,
  branchHoliday,
  checkin,
  child,
  confirmationItem,
  dropOffPricing,
  fileObject,
  member,
  nanny,
  nannyShift,
  product,
  registration,
  sale,
  saleLine,
  station,
  supervisionPolicy,
  supervisionWaiver,
  visit,
} from '@oto/db';
import {
  DEFAULT_DROP_OFF_PRICING,
  DEFAULT_SUPERVISION_POLICY,
  buildAcknowledgedConfirmations,
  businessDate,
  confirmationsSatisfied,
  getRateModeForDate,
  newId,
  normalizePhone,
  parseDayStart,
  prepaidItemNotOnMenuRefusal,
  prepaidItemPriceRefusal,
  prepaidPaidMismatchRefusal,
  requirementLabel,
  resolveRequirement,
  waiverRefusal,
  type CreateRegistrationInput,
  type CreateWaiverInput,
  type DropOffPricingConfig,
  type FoodProvisionInput,
  type RegistrationChildInput,
  type SupervisionPolicy,
  type SupervisionRequirement,
} from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import { BandKeyMissingError, mintSaleBands } from './bands';
import { idInUse } from './client-id';
import { queueCheckinBandPrints, type SalePrintJobView } from './sale-printing';
import type { SmsSender } from './sms';
import type { Exec, Tx } from './tx';
import { loadChildPrepaid } from './wallet';

/**
 * S2-13 round 1 — CHILD CHECK-IN AND SUPERVISION, online (plan
 * docs/progress/plans/checkin/PLAN.md §2.1-2.2).
 *
 * The prototype's door flow, ported mutator by mutator from `mockApi.ts`:
 *
 *   - `registerWalkInChildren` (4716-4793) → `createRegistration`: ONE
 *     registration the siblings share, the consent and its confirmations
 *     stamped on it, each child `registered`, the food provision normalised
 *     the prototype's way (a prepaid mode that paid nothing is `none`);
 *   - `addChildToRegistration` → `addRegistrationChildren`, the add-sibling
 *     path of the AddDropOffModal;
 *   - `recordSupervisionWaiver` (4806-4829) → `recordWaiver`, with the two
 *     things the prototype only promised: it is checked again here against
 *     the policy (`waiverRefusal`), and only signed-in staff holding
 *     `pos:checkin:update` reach it (OD-C3 — the route says so);
 *   - `checkInFamilyWithPayment` (4958-5067) + `linkCheckInSaleId` →
 *     `checkInNow`: every child validated before any is written, then the
 *     stays put in the park, the sale linked, the bands minted through the
 *     landed `mintSaleBands` (no `WI-` code family — a band is a band) and
 *     queued for print, in ONE transaction;
 *   - `markCheckInsBooked` (5079-5101) → `leaveAsBooked`: the booked start
 *     and length, the sale linked, and no band.
 *
 * Every refusal is a sentence the counter can act on.
 */

type CheckinRow = typeof checkin.$inferSelect;
type RegistrationRow = typeof registration.$inferSelect;

export interface Actor {
  accountId: string;
  operatorId: string;
  requestId?: string;
  actionId?: string | null;
}

// --- Config ---------------------------------------------------------------------

export interface SupervisionConfig {
  policy: SupervisionPolicy;
  pricing: DropOffPricingConfig;
  photoRetentionDays: number;
}

/**
 * The branch's supervision policy, confirmations and drop-off pricing. A
 * branch created after migration 0043 has no rows until its config is saved,
 * and reads the prototype's seed — the same values 0043 gave every branch
 * that existed then — rather than nothing at all.
 */
export async function supervisionConfigOf(db: Exec, branchId: string): Promise<SupervisionConfig> {
  const [policyRow] = await db.select().from(supervisionPolicy).where(eq(supervisionPolicy.branchId, branchId)).limit(1);
  const items = await db
    .select()
    .from(confirmationItem)
    .where(and(eq(confirmationItem.branchId, branchId), isNull(confirmationItem.archivedAt)))
    .orderBy(asc(confirmationItem.sortOrder), asc(confirmationItem.code));
  const [pricingRow] = await db.select().from(dropOffPricing).where(eq(dropOffPricing.branchId, branchId)).limit(1);

  const policy: SupervisionPolicy = policyRow
    ? {
        bands: policyRow.bands,
        siblingWaiver: {
          enabled: policyRow.siblingWaiverEnabled,
          guardianMinAge: policyRow.guardianMinAge,
          waivableRequirement: policyRow.waivableRequirement,
          staffOnly: policyRow.waiverStaffOnly,
        },
        confirmations: items.map((i) => ({ id: i.code, text: i.text, required: i.required, order: i.sortOrder })),
      }
    : {
        ...DEFAULT_SUPERVISION_POLICY,
        confirmations: items.length
          ? items.map((i) => ({ id: i.code, text: i.text, required: i.required, order: i.sortOrder }))
          : DEFAULT_SUPERVISION_POLICY.confirmations,
      };
  const pricing: DropOffPricingConfig = pricingRow
    ? {
        oneTimeFee: { weekday: pricingRow.oneTimeFeeWeekdaySatang, weekend: pricingRow.oneTimeFeeWeekendSatang },
        nannyHourly: { weekday: pricingRow.nannyHourlyWeekdaySatang, weekend: pricingRow.nannyHourlyWeekendSatang },
        extraHour: { weekday: pricingRow.extraHourWeekdaySatang, weekend: pricingRow.extraHourWeekendSatang },
        fullDayHours: pricingRow.fullDayHours,
        nannyRatioSoftMax: policyRow?.nannyRatioSoftMax ?? DEFAULT_DROP_OFF_PRICING.nannyRatioSoftMax,
        prepaidFoodUnused: pricingRow.prepaidFoodUnused,
      }
    : DEFAULT_DROP_OFF_PRICING;
  return { policy, pricing, photoRetentionDays: policyRow?.photoRetentionDays ?? 30 };
}

export interface NannyView {
  id: string;
  name: string;
  /** A shift row covers now. */
  onShift: boolean;
  /** Children she covers who are not out yet (prototype `getNannyRoster`). */
  load: number;
  coveredNames: string[];
}

/** The branch's nannies with their live load (prototype `getNannyRoster`, mockApi.ts:4004-4026). */
export async function nannyRosterOf(db: Exec, branchId: string, now: Date = new Date()): Promise<NannyView[]> {
  const nannies = await db
    .select()
    .from(nanny)
    .where(and(eq(nanny.branchId, branchId), isNull(nanny.archivedAt)))
    .orderBy(asc(nanny.name));
  if (nannies.length === 0) return [];
  const ids = nannies.map((n) => n.id);
  const shifts = await db
    .select({ nannyId: nannyShift.nannyId })
    .from(nannyShift)
    .where(
      and(
        inArray(nannyShift.nannyId, ids),
        // A shift at another park is not a shift here.
        eq(nannyShift.branchId, branchId),
        lte(nannyShift.startsAt, now),
        gt(nannyShift.endsAt, now),
      ),
    );
  const onShift = new Set(shifts.map((s) => s.nannyId));
  const covered = await db
    .select({ nannyId: checkin.nannyId, childName: checkin.childName })
    .from(checkin)
    .where(and(inArray(checkin.nannyId, ids), ne(checkin.status, 'out')))
    .orderBy(asc(checkin.createdAt));
  return nannies.map((n) => {
    const names = covered.filter((c) => c.nannyId === n.id).map((c) => c.childName);
    return { id: n.id, name: n.name, onShift: onShift.has(n.id), load: names.length, coveredNames: names };
  });
}

// --- Views ----------------------------------------------------------------------

export interface CheckinView {
  id: string;
  registrationId: string;
  childId: string | null;
  childName: string;
  childAgeYears: number;
  dateOfBirth: string | null;
  allergies: string | null;
  foodRestrictions: string | null;
  mayOrderFood: boolean;
  foodProvision: FoodProvisionInput | null;
  service: SupervisionRequirement;
  status: 'registered' | 'in_park' | 'out';
  scheduledFor: string | null;
  bookedMinutes: number | null;
  nannyId: string | null;
  checkedInAt: string | null;
  saleId: string | null;
  bandId: string | null;
  visitId: string | null;
  photoFileId: string | null;
}

export interface RegistrationView {
  id: string;
  branchId: string;
  memberId: string | null;
  guardianName: string;
  guardianPhone: string | null;
  contactChannel: string;
  consentRecordedAt: string | null;
  acknowledgedConfirmations: { itemId: string; text: string; acknowledgedAt: string }[];
  source: string;
  photoFileId: string | null;
  createdAt: string;
  children: CheckinView[];
}

function checkinViewOf(row: CheckinRow): CheckinView {
  return {
    id: row.id,
    registrationId: row.registrationId,
    childId: row.childId,
    childName: row.childName,
    childAgeYears: row.childAgeYears,
    dateOfBirth: row.dateOfBirth,
    allergies: row.allergies,
    foodRestrictions: row.foodRestrictions,
    mayOrderFood: row.mayOrderFood,
    foodProvision: (row.foodProvision as FoodProvisionInput | null) ?? null,
    service: row.service,
    status: row.status,
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
    bookedMinutes: row.bookedMinutes,
    nannyId: row.nannyId,
    checkedInAt: row.checkedInAt?.toISOString() ?? null,
    saleId: row.saleId,
    bandId: row.bandId,
    visitId: row.visitId,
    photoFileId: row.photoFileId,
  };
}

async function registrationViewOf(db: Exec, row: RegistrationRow): Promise<RegistrationView> {
  const stays = await db
    .select()
    .from(checkin)
    .where(eq(checkin.registrationId, row.id))
    .orderBy(asc(checkin.createdAt), asc(checkin.id));
  return {
    id: row.id,
    branchId: row.branchId,
    memberId: row.memberId,
    guardianName: row.guardianName,
    guardianPhone: row.guardianPhone,
    contactChannel: row.contactChannel,
    consentRecordedAt: row.consentRecordedAt?.toISOString() ?? null,
    acknowledgedConfirmations: row.acknowledgedConfirmations,
    source: row.source,
    photoFileId: row.photoFileId,
    createdAt: row.createdAt.toISOString(),
    children: stays.map(checkinViewOf),
  };
}

/** One registration, inside the caller's operator. 404 for anybody else's. */
export async function loadRegistration(db: Exec, operatorId: string, id: string): Promise<RegistrationRow> {
  const [row] = await db
    .select()
    .from(registration)
    .where(and(eq(registration.id, id), eq(registration.operatorId, operatorId)))
    .limit(1);
  if (!row) throw errors.notFound('No such registration');
  return row;
}

export async function getRegistration(db: Exec, operatorId: string, id: string): Promise<RegistrationView> {
  return registrationViewOf(db, await loadRegistration(db, operatorId, id));
}

/**
 * The registrations still waiting for their children to be checked in, for
 * the AddDropOffModal (prototype `getRegistrationsAwaitingCheckIn`): every
 * registration at the branch with at least one child `registered`.
 */
export async function registrationsAwaitingCheckIn(
  db: Exec,
  operatorId: string,
  branchId: string,
): Promise<RegistrationView[]> {
  const waiting = await db
    .selectDistinct({ id: checkin.registrationId })
    .from(checkin)
    .where(and(eq(checkin.operatorId, operatorId), eq(checkin.branchId, branchId), eq(checkin.status, 'registered')));
  if (waiting.length === 0) return [];
  const rows = await db
    .select()
    .from(registration)
    .where(inArray(registration.id, waiting.map((w) => w.id)))
    .orderBy(asc(registration.createdAt));
  const out: RegistrationView[] = [];
  for (const row of rows) out.push(await registrationViewOf(db, row));
  return out;
}

// --- Registration ---------------------------------------------------------------

/**
 * Prototype `registerWalkInChildren` normalisation: a prepaid mode that paid
 * nothing is `none`, so ordering is never authorised without payment, and
 * `mayOrderFood` follows the provision.
 */
function normaliseProvision(raw: FoodProvisionInput | null | undefined): {
  provision: FoodProvisionInput | null;
  mayOrderFood: boolean;
} {
  if (!raw) return { provision: null, mayOrderFood: false };
  const paid = raw.mode !== 'none' && raw.paidSatang <= 0 ? { mode: 'none' as const, paidSatang: 0 } : raw;
  // SCRUM-494 — nothing has been served at registration: every prepaid item
  // starts unserved (the design's `redeemedQty: 0`, `ChildFoodProvisionPicker`).
  const provision =
    paid.mode === 'prepaid_items' && paid.items
      ? { ...paid, items: paid.items.map((it) => ({ ...it, redeemedQty: 0 })) }
      : paid;
  return { provision, mayOrderFood: provision.mode !== 'none' && provision.paidSatang > 0 };
}

/**
 * SCRUM-494 — the prepaid items a parent pays for at registration, checked
 * against the park's menu: each is a menu item on sale at this park, at
 * today's price (the design prices them with `resolveRateToday(item.price)`),
 * and what was paid is the items' sum, unit × qty (`ChildFoodProvisionPicker`'s
 * `prepaidTotal`). The release refunds unserved items at these units, so they
 * are refused here rather than stored when they do not hold.
 */
async function assertPrepaidItems(
  tx: Tx,
  operatorId: string,
  branchId: string,
  childName: string,
  provision: FoodProvisionInput | null,
  now: Date,
): Promise<void> {
  if (!provision || provision.mode !== 'prepaid_items') return;
  const items = provision.items ?? [];
  const sum = items.reduce((s, it) => s + it.unitSatang * it.qty, 0);
  if (items.length > 0) {
    const [br] = await tx.select().from(branch).where(eq(branch.id, branchId)).limit(1);
    if (!br) throw errors.notFound('Branch not found');
    const holidays = await tx
      .select()
      .from(branchHoliday)
      .where(and(eq(branchHoliday.branchId, branchId), isNull(branchHoliday.archivedAt)));
    const day = businessDate(now, br.timezone, parseDayStart(br.businessDayStart));
    const mode = getRateModeForDate(
      day,
      holidays.map((h) => ({ name: h.name, startsOn: h.startsOn, endsOn: h.endsOn })),
    ).mode;
    const ids = [...new Set(items.map((it) => it.menuItemId))].filter((id) => UUID_RE.test(id));
    const rows = ids.length
      ? await tx
          .select()
          .from(product)
          .where(
            and(
              inArray(product.id, ids),
              eq(product.operatorId, operatorId),
              eq(product.kind, 'menu'),
              eq(product.active, true),
              isNull(product.archivedAt),
            ),
          )
      : [];
    const onMenu = new Map(
      rows.filter((r) => !r.branchId || r.branchId === branchId).map((r) => [r.id, r]),
    );
    for (const it of items) {
      const row = onMenu.get(it.menuItemId);
      if (!row) {
        throw new AppError(400, 'PREPAID_ITEM_NOT_ON_MENU', prepaidItemNotOnMenuRefusal(it.menuItemName, childName), {
          menuItemId: it.menuItemId,
        });
      }
      const today = mode === 'weekend' ? (row.priceWeekendSatang ?? row.priceSatang) : row.priceSatang;
      if (it.unitSatang !== today) {
        throw new AppError(400, 'PREPAID_ITEM_PRICE', prepaidItemPriceRefusal(row.name, childName, today), {
          menuItemId: it.menuItemId,
          unitSatang: it.unitSatang,
          menuSatang: today,
          pricingMode: mode,
        });
      }
    }
  }
  if (sum !== provision.paidSatang) {
    throw new AppError(400, 'PREPAID_PAID_MISMATCH', prepaidPaidMismatchRefusal(childName, sum, provision.paidSatang), {
      itemsSatang: sum,
      paidSatang: provision.paidSatang,
    });
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The server's own resolution of a child's service from the age, refusing a
 * gate that resolved something else. A mandatory requirement is the only
 * service it may carry; a child with no requirement may opt in to the same
 * flow at no fee ('none', R-86). A child the waiver covered never reaches a
 * registration — they stay a plain ticket.
 */
function assertService(c: RegistrationChildInput, policy: SupervisionPolicy): void {
  const base = resolveRequirement(c.ageYears, policy);
  if (base === c.service) return;
  throw errors.conflict(
    'SERVICE_MISMATCH',
    base === 'none'
      ? `${c.name} is ${c.ageYears} and needs no supervision — register them with no service, or leave them on a plain ticket.`
      : `${c.name} is ${c.ageYears} and needs ${requirementLabel(base)}, not ${requirementLabel(c.service)} — check the age, or accept a sibling waiver for them.`,
    { checkinId: c.checkinId, required: base },
  );
}

async function assertChildrenOfMember(
  db: Exec,
  operatorId: string,
  memberId: string | null,
  children: readonly RegistrationChildInput[],
): Promise<void> {
  const ids = children.map((c) => c.childId).filter((id): id is string => !!id);
  if (ids.length === 0) return;
  if (!memberId) throw errors.badRequest('A saved child needs the guardian it is saved under — send the memberId too.');
  const rows = await db
    .select({ id: child.id })
    .from(child)
    .innerJoin(member, eq(member.id, child.memberId))
    .where(
      and(
        inArray(child.id, ids),
        eq(child.memberId, memberId),
        eq(member.operatorId, operatorId),
        isNull(child.archivedAt),
      ),
    );
  if (rows.length !== new Set(ids).size) {
    throw errors.badRequest("One or more children are not on this guardian's saved list — look the guardian up again.");
  }
}

async function insertStays(
  tx: Tx,
  actor: Actor,
  reg: { id: string; branchId: string; visitId: string | null },
  children: readonly RegistrationChildInput[],
): Promise<void> {
  const ids = children.map((c) => c.checkinId);
  if (new Set(ids).size !== ids.length) throw errors.badRequest('Two children were sent under the same check-in id.');
  const taken = await tx.select({ id: checkin.id, registrationId: checkin.registrationId }).from(checkin).where(inArray(checkin.id, ids));
  for (const t of taken) {
    if (t.registrationId !== reg.id) throw idInUse(t.id);
  }
  const already = new Set(taken.map((t) => t.id));
  const now = new Date();
  for (const c of children) {
    if (already.has(c.checkinId)) continue;
    const { provision, mayOrderFood } = normaliseProvision(c.foodProvision);
    await assertPrepaidItems(tx, actor.operatorId, reg.branchId, c.name.trim(), provision, now);
    const values = {
      id: c.checkinId,
      operatorId: actor.operatorId,
      branchId: reg.branchId,
      registrationId: reg.id,
      childId: c.childId ?? null,
      childName: c.name.trim(),
      childAgeYears: c.ageYears,
      dateOfBirth: c.dateOfBirth ?? null,
      allergies: c.allergies?.trim() || null,
      foodRestrictions: c.foodRestrictions?.trim() || null,
      mayOrderFood,
      foodProvision: provision,
      service: c.service,
      status: 'registered' as const,
      visitId: reg.visitId,
    };
    await tx.insert(checkin).values(values);
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: reg.branchId,
      action: 'checkin.create',
      entityType: 'checkin',
      entityId: c.checkinId,
      requestId: actor.requestId,
      actionId: actor.actionId ?? null,
      after: {
        registrationId: reg.id,
        childId: values.childId,
        childName: values.childName,
        childAgeYears: values.childAgeYears,
        service: values.service,
        allergies: values.allergies,
        foodRestrictions: values.foodRestrictions,
        mayOrderFood,
        foodProvision: provision,
      },
    });
  }
}

/**
 * ONE REGISTRATION for the family left with the park, from the gate.
 *
 * Idempotent by its id (OD-12): the gate sends the same id again on a retry
 * and is answered with the registration that exists, so consent and payment
 * never make two. Writes the registration, one `registered` stay per child
 * and their audit rows together.
 */
export async function createRegistration(
  tx: Tx,
  actor: Actor,
  input: CreateRegistrationInput & { id: string },
  config: SupervisionConfig,
): Promise<RegistrationView> {
  const [br] = await tx.select().from(branch).where(eq(branch.id, input.branchId)).limit(1);
  if (!br || br.operatorId !== actor.operatorId) throw errors.notFound('Branch not found');
  if (input.memberId) {
    const [m] = await tx
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.id, input.memberId), eq(member.operatorId, actor.operatorId)))
      .limit(1);
    if (!m) throw errors.notFound('Member not found');
  }
  if (input.visitId) {
    const [v] = await tx
      .select({ id: visit.id })
      .from(visit)
      .where(and(eq(visit.id, input.visitId), eq(visit.operatorId, actor.operatorId)))
      .limit(1);
    if (!v) throw errors.notFound('Visit not found');
  }
  if (input.stationId) {
    const [st] = await tx.select({ id: station.id, branchId: station.branchId }).from(station).where(eq(station.id, input.stationId)).limit(1);
    if (!st || st.branchId !== input.branchId) throw errors.notFound('No such station at this park');
  }
  for (const c of input.children) assertService(c, config.policy);
  await assertChildrenOfMember(tx, actor.operatorId, input.memberId ?? null, input.children);

  const supervised = input.children.length > 0;
  if (supervised && !input.consentAcknowledged) {
    throw errors.conflict('CONSENT_REQUIRED', 'The guardian has not given consent yet — finish the form on the customer screen.');
  }
  if (supervised && !confirmationsSatisfied(config.policy, input.acknowledgedConfirmationIds)) {
    throw errors.conflict(
      'CONFIRMATIONS_REQUIRED',
      'Every confirmation has to be ticked on the customer screen before the children can be registered.',
    );
  }
  let guardianPhone: string | null = null;
  if (input.guardianPhone?.trim()) {
    guardianPhone = normalizePhone(input.guardianPhone);
    if (!guardianPhone) throw errors.badRequest("That phone number doesn't look right — check it with the guardian.");
  }

  const now = new Date();
  const acknowledged = buildAcknowledgedConfirmations(config.policy, input.acknowledgedConfirmationIds, now.toISOString());
  const row = {
    id: input.id,
    operatorId: actor.operatorId,
    branchId: input.branchId,
    memberId: input.memberId ?? null,
    guardianName: input.guardianName.trim(),
    guardianPhone,
    contactChannel: input.contactChannel,
    consentRecordedAt: input.consentAcknowledged ? now : null,
    acknowledgedConfirmations: acknowledged,
    source: 'till' as const,
    stationId: input.stationId ?? null,
    createdByAccountId: actor.accountId,
  };
  await tx.insert(registration).values(row);
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: input.branchId,
    action: 'registration.create',
    entityType: 'registration',
    entityId: input.id,
    requestId: actor.requestId,
    actionId: actor.actionId ?? null,
    after: {
      memberId: row.memberId,
      guardianName: row.guardianName,
      guardianPhone,
      contactChannel: row.contactChannel,
      consentRecordedAt: row.consentRecordedAt?.toISOString() ?? null,
      acknowledgedConfirmations: acknowledged,
      children: input.children.map((c) => ({ checkinId: c.checkinId, name: c.name, service: c.service })),
    },
  });
  await insertStays(tx, actor, { id: input.id, branchId: input.branchId, visitId: input.visitId ?? null }, input.children);
  return getRegistration(tx, actor.operatorId, input.id);
}

/** The add-sibling path: more children on a registration that is still waiting. */
export async function addRegistrationChildren(
  tx: Tx,
  actor: Actor,
  reg: RegistrationRow,
  children: readonly RegistrationChildInput[],
  config: SupervisionConfig,
): Promise<RegistrationView> {
  if (!reg.consentRecordedAt) {
    throw errors.conflict('CONSENT_REQUIRED', 'This registration has no consent on file — take the consent before adding a child.');
  }
  for (const c of children) assertService(c, config.policy);
  await assertChildrenOfMember(tx, actor.operatorId, reg.memberId, children);
  await insertStays(tx, actor, { id: reg.id, branchId: reg.branchId, visitId: null }, children);
  return getRegistration(tx, actor.operatorId, reg.id);
}

// --- The photo ------------------------------------------------------------------

/**
 * The combined child-and-guardian photo (OD-C2), uploaded through file storage
 * under the registration and attached here. A photo already on file is never
 * replaced (prototype `setCheckInPhoto`): the first one the counter took is the
 * one a pickup is checked against.
 */
export async function attachRegistrationPhoto(
  tx: Tx,
  actor: Actor,
  reg: RegistrationRow,
  input: { fileId: string; checkinIds: readonly string[] },
): Promise<RegistrationView> {
  const [file] = await tx.select().from(fileObject).where(eq(fileObject.id, input.fileId)).limit(1);
  if (!file || file.operatorId !== actor.operatorId || file.ownerEntityType !== 'registration' || file.ownerEntityId !== reg.id) {
    throw errors.notFound('No such photo on this registration');
  }
  const stays = input.checkinIds.length
    ? await tx
        .select()
        .from(checkin)
        .where(and(inArray(checkin.id, [...input.checkinIds]), eq(checkin.registrationId, reg.id)))
    : [];
  if (stays.length !== new Set(input.checkinIds).size) throw errors.notFound('One or more children are not on this registration');
  const before = { photoFileId: reg.photoFileId, children: stays.map((s) => ({ id: s.id, photoFileId: s.photoFileId })) };
  if (!reg.photoFileId) {
    await tx.update(registration).set({ photoFileId: file.id, updatedAt: new Date() }).where(eq(registration.id, reg.id));
  }
  for (const s of stays) {
    if (!s.photoFileId) await tx.update(checkin).set({ photoFileId: file.id, updatedAt: new Date() }).where(eq(checkin.id, s.id));
  }
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: reg.branchId,
    action: 'registration.photo',
    entityType: 'registration',
    entityId: reg.id,
    requestId: actor.requestId,
    actionId: actor.actionId ?? null,
    before,
    after: { fileId: file.id, checkinIds: stays.map((s) => s.id) },
  });
  return getRegistration(tx, actor.operatorId, reg.id);
}

// --- The waiver -----------------------------------------------------------------

export interface WaiverView {
  id: string;
  childName: string;
  childAgeYears: number;
  waivedRequirement: 'drop_off' | 'nanny';
  siblingName: string;
  siblingAgeYears: number;
  acceptedByAccountId: string;
  createdAt: string;
}

/**
 * A STAFF-ACCEPTED SIBLING WAIVER. The resolver OFFERS it (`waiverEligible`);
 * nothing applies it but a signed-in member of staff pressing accept, and the
 * policy is checked again here so a stale offer — an age edited after the
 * button was shown — is refused rather than recorded.
 */
export async function recordWaiver(
  tx: Tx,
  actor: Actor,
  input: CreateWaiverInput & { id: string },
  config: SupervisionConfig,
): Promise<WaiverView> {
  const [br] = await tx.select().from(branch).where(eq(branch.id, input.branchId)).limit(1);
  if (!br || br.operatorId !== actor.operatorId) throw errors.notFound('Branch not found');
  const refusal = waiverRefusal(
    { childAge: input.child.ageYears, siblingAge: input.sibling.ageYears, waivedRequirement: input.waivedRequirement },
    config.policy,
  );
  if (refusal) throw errors.conflict('WAIVER_REFUSED', refusal);
  const childIds = [input.child.childId, input.sibling.childId].filter((id): id is string => !!id);
  if (childIds.length) {
    const rows = await tx
      .select({ id: child.id })
      .from(child)
      .innerJoin(member, eq(member.id, child.memberId))
      .where(and(inArray(child.id, childIds), eq(member.operatorId, actor.operatorId)));
    if (rows.length !== new Set(childIds).size) throw errors.notFound('No such child');
  }
  if (input.registrationId) await loadRegistration(tx, actor.operatorId, input.registrationId);
  const row = {
    id: input.id,
    operatorId: actor.operatorId,
    branchId: input.branchId,
    registrationId: input.registrationId ?? null,
    childId: input.child.childId ?? null,
    childName: input.child.name.trim(),
    childAgeYears: input.child.ageYears,
    waivedRequirement: input.waivedRequirement,
    siblingChildId: input.sibling.childId ?? null,
    siblingName: input.sibling.name.trim(),
    siblingAgeYears: input.sibling.ageYears,
    acceptedByAccountId: actor.accountId,
    stationId: input.stationId ?? null,
  };
  const [written] = await tx.insert(supervisionWaiver).values(row).returning();
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: input.branchId,
    action: 'supervision_waiver.create',
    entityType: 'supervision_waiver',
    entityId: input.id,
    requestId: actor.requestId,
    actionId: actor.actionId ?? null,
    after: {
      childName: row.childName,
      childAgeYears: row.childAgeYears,
      waivedRequirement: row.waivedRequirement,
      siblingName: row.siblingName,
      siblingAgeYears: row.siblingAgeYears,
      acceptedByAccountId: actor.accountId,
    },
  });
  return waiverViewOf(written!);
}

export function waiverViewOf(row: typeof supervisionWaiver.$inferSelect): WaiverView {
  return {
    id: row.id,
    childName: row.childName,
    childAgeYears: row.childAgeYears,
    waivedRequirement: row.waivedRequirement as 'drop_off' | 'nanny',
    siblingName: row.siblingName,
    siblingAgeYears: row.siblingAgeYears,
    acceptedByAccountId: row.acceptedByAccountId,
    createdAt: row.createdAt.toISOString(),
  };
}

// --- After payment: check in now, or leave as booked ------------------------------

interface ChoiceContext {
  saleRow: typeof sale.$inferSelect;
  stays: CheckinRow[];
  /** Each stay's kids line on the sale. */
  lineOf: Map<string, typeof saleLine.$inferSelect>;
}

/**
 * Everything both choices check before either writes (the prototype's
 * "validate all before committing any"): the sale is closed and this
 * operator's, and every child is still `registered`, at the sale's park, and
 * on that sale under its own drop-off line.
 */
async function loadChoice(tx: Tx, actor: Actor, saleId: string, checkinIds: readonly string[]): Promise<ChoiceContext> {
  const [saleRow] = await tx
    .select()
    .from(sale)
    .where(and(eq(sale.id, saleId), eq(sale.operatorId, actor.operatorId)))
    .limit(1);
  if (!saleRow) throw errors.notFound('Sale not found');
  if (saleRow.status !== 'finalised') {
    throw errors.conflict('SALE_NOT_FINALISED', 'Take the payment first — the children are checked in once the sale is paid.');
  }
  const ids = [...new Set(checkinIds)];
  if (ids.length !== checkinIds.length) throw errors.badRequest('A child was named twice.');
  // Locked: two counters pressing "Check in now" for the same family get one
  // check-in and one refusal, never two bands.
  const stays = await tx
    .select()
    .from(checkin)
    .where(and(inArray(checkin.id, ids), eq(checkin.operatorId, actor.operatorId)))
    .for('update');
  if (stays.length !== ids.length) throw errors.notFound('No such check-in');
  const lines = await tx
    .select()
    .from(saleLine)
    .where(and(eq(saleLine.saleId, saleRow.id), inArray(saleLine.cartLineId, ids)))
    .orderBy(asc(saleLine.lineNo));
  const lineOf = new Map<string, typeof saleLine.$inferSelect>();
  for (const l of lines) {
    if (l.kind === 'kids' && !lineOf.has(l.cartLineId)) lineOf.set(l.cartLineId, l);
  }
  for (const s of stays) {
    if (s.branchId !== saleRow.branchId) throw errors.conflict('CHECKIN_OTHER_PARK', `${s.childName} was registered at another park.`);
    if (s.status !== 'registered') {
      throw errors.conflict('CHECKIN_NOT_REGISTERED', `${s.childName} is already ${s.status === 'in_park' ? 'checked in' : 'checked out'}.`);
    }
    if (s.saleId && s.saleId !== saleRow.id) {
      throw errors.conflict('CHECKIN_OTHER_SALE', `${s.childName} was paid for on another sale.`);
    }
    if (!lineOf.has(s.id)) {
      throw errors.conflict('CHECKIN_NOT_ON_SALE', `${s.childName} is not on this sale — add their drop-off line and take the payment again.`);
    }
  }
  return { saleRow, stays, lineOf };
}

export interface CheckInNowResult {
  saleId: string;
  children: CheckinView[];
  bands: { id: string; checkinId: string; childName: string }[];
  printJobs: SalePrintJobView[];
  notes: string[];
}

/**
 * "CHECK IN NOW" — ONE TRANSACTION: the stays go in the park with their timer
 * started, the sale is linked to each, their bands are minted on their own
 * lines through `mintSaleBands`, linked back, and queued for print.
 *
 * A band that cannot be minted takes the whole check-in back with it: a child
 * in the park with no band is the one outcome this must never leave behind.
 */
export async function checkInNow(
  tx: Tx,
  actor: Actor,
  input: {
    saleId: string;
    entries: readonly { checkinId: string; nannyId?: string | null; service?: SupervisionRequirement }[];
  },
  now: Date = new Date(),
  opts: { event?: 'check_in_now' | 'check_in_booked' } = {},
): Promise<CheckInNowResult> {
  const event = opts.event ?? 'check_in_now';
  // A retry of a check-in that landed (the answer was lost on the way back)
  // is answered with what it did, not refused: every child already in the
  // park on THIS sale with a band is exactly the state the first press left.
  const ids = input.entries.map((e) => e.checkinId);
  const current = await tx
    .select()
    .from(checkin)
    .where(and(inArray(checkin.id, ids), eq(checkin.operatorId, actor.operatorId)));
  if (
    current.length === ids.length &&
    current.every((s) => s.status === 'in_park' && s.saleId === input.saleId && !!s.bandId)
  ) {
    return {
      saleId: input.saleId,
      children: current.map(checkinViewOf),
      bands: current.map((s) => ({ id: s.bandId!, checkinId: s.id, childName: s.childName })),
      printJobs: [],
      notes: [],
    };
  }
  const { saleRow, stays, lineOf } = await loadChoice(tx, actor, input.saleId, input.entries.map((e) => e.checkinId));
  const nannyByEntry = new Map(input.entries.map((e) => [e.checkinId, e.nannyId ?? null]));
  /**
   * The service each child was PAID for: the Drop-Off / Nanny switch on the
   * till's cart line (prototype `checkInFamilyWithPayment` sets
   * `serviceType` from the paid input). Sent with the entry, it is the stay's
   * service from this check-in on; an entry without one keeps the stay's own.
   */
  const serviceByEntry = new Map(input.entries.map((e) => [e.checkinId, e.service]));
  const serviceOf = (s: CheckinRow): SupervisionRequirement => serviceByEntry.get(s.id) ?? s.service;

  // The nannies, all before any write (prototype checkInFamilyWithPayment):
  // on this park's roster AND on shift here now — the same rule every other
  // assignment path applies (`checkNannyFor`), against the paid service.
  for (const s of stays) {
    if (serviceOf(s) !== 'nanny') continue;
    const id = nannyByEntry.get(s.id) ?? s.nannyId;
    if (!id) throw errors.conflict('NANNY_REQUIRED', `Assign a nanny to ${s.childName} before checking them in.`);
    await checkNannyFor(tx, saleRow.branchId, id, s.id, now);
  }

  for (const s of stays) {
    const line = lineOf.get(s.id)!;
    const service = serviceOf(s);
    // Plain drop-off has no nanny: the table holds one on nanny-service stays only.
    const nannyId = service === 'nanny' ? (nannyByEntry.get(s.id) ?? s.nannyId) : null;
    const patch = {
      status: 'in_park' as const,
      checkedInAt: now,
      checkedInByAccountId: actor.accountId,
      scheduledFor: null,
      bookedMinutes: line.stayHours && line.stayHours > 0 ? line.stayHours * 60 : s.bookedMinutes,
      service,
      nannyId,
      saleId: saleRow.id,
      updatedAt: now,
    };
    await tx.update(checkin).set(patch).where(eq(checkin.id, s.id));
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: s.branchId,
      action: 'checkin.update',
      entityType: 'checkin',
      entityId: s.id,
      requestId: actor.requestId,
      actionId: actor.actionId ?? null,
      before: {
        status: s.status,
        saleId: s.saleId,
        service: s.service,
        nannyId: s.nannyId,
        scheduledFor: s.scheduledFor?.toISOString() ?? null,
        bookedMinutes: s.bookedMinutes,
      },
      // `scheduledFor: null` because the write above clears it: the audit
      // after has to say what the row now holds (S2-13 round 4, audit fix).
      after: {
        status: 'in_park',
        saleId: saleRow.id,
        service,
        nannyId,
        scheduledFor: null,
        bookedMinutes: patch.bookedMinutes,
        checkedInAt: now.toISOString(),
        event,
      },
    });
  }

  // The bands, through the landed path, named for each stay's child.
  const [stationRow] = await tx.select().from(station).where(eq(station.id, saleRow.stationId)).limit(1);
  let minted: (typeof band.$inferSelect)[];
  try {
    minted = (
      await mintSaleBands(
        tx,
        saleRow,
        stationRow?.codePrefix ?? '',
        { stationId: stationRow?.id ?? null, boxId: stationRow?.boxId ?? null, now },
        { checkins: stays.map((s) => ({ id: s.id, childId: s.childId })) },
      )
    ).minted;
  } catch (err) {
    if (err instanceof BandKeyMissingError) {
      throw new AppError(503, 'BAND_KEY_MISSING', 'No band can be issued on this deployment, so nobody was checked in — leave them as booked or try again later.');
    }
    throw err;
  }
  const stayOfLine = new Map([...lineOf.entries()].map(([checkinId, line]) => [line.id, checkinId]));
  const bandOf = new Map<string, string>();
  for (const b of minted) {
    const checkinId = b.saleLineId ? stayOfLine.get(b.saleLineId) : undefined;
    if (b.kind === 'kid' && checkinId && !bandOf.has(checkinId)) bandOf.set(checkinId, b.id);
  }
  for (const s of stays) {
    const bandId = bandOf.get(s.id);
    if (!bandId) {
      throw errors.conflict('BAND_NOT_ISSUED', `No band could be issued for ${s.childName}, so nobody was checked in.`);
    }
    await tx.update(checkin).set({ bandId, updatedAt: now }).where(eq(checkin.id, s.id));
  }

  /**
   * S2-14a — A PREPAID-CREDIT CHILD'S FOOD MONEY GOES ON THEIR OWN WALLET, in
   * this transaction (prototype `checkInFamilyWithPayment`,
   * `mockApi.ts:5030-5065`: the band is topped up and a `grant` /
   * `prepaid_food` entry written). The child's wallet carries the band just
   * minted; a load that cannot be written takes the check-in back with it,
   * because the family paid for that credit. The figure is the sale's: the
   * load reads this stay's `food_provision` line off the sale ledger and
   * refuses the check-in when the registration's figure disagrees with it
   * (`PREPAID_FOOD_MISMATCH`), so no credit exists that the sale did not
   * charge for.
   */
  const codeOf = new Map(minted.map((b) => [b.id, b.code]));
  for (const s of stays) {
    await loadChildPrepaid(
      tx,
      { accountId: actor.accountId, operatorId: actor.operatorId, requestId: actor.requestId ?? null },
      { stay: s, saleRow, bandCode: codeOf.get(bandOf.get(s.id)!) ?? null, now },
    );
  }

  const printed = await queueCheckinBandPrints(tx, saleRow, stays.map((s) => bandOf.get(s.id)!), {
    actorAccountId: actor.accountId,
    actionId: actor.actionId,
    requestId: actor.requestId,
    now,
  });

  const after = await tx.select().from(checkin).where(inArray(checkin.id, stays.map((s) => s.id))).orderBy(asc(checkin.createdAt), asc(checkin.id));
  return {
    saleId: saleRow.id,
    children: after.map(checkinViewOf),
    bands: stays.map((s) => ({ id: bandOf.get(s.id)!, checkinId: s.id, childName: s.childName })),
    printJobs: printed.jobs,
    notes: printed.notes,
  };
}

/**
 * "LEAVE AS BOOKED" — the children stay `registered` with the booked start and
 * length and the sale linked; NO band and no timer. They are checked in later
 * from the board (round 2), without a second payment.
 */
export async function leaveAsBooked(
  tx: Tx,
  actor: Actor,
  input: { saleId: string; scheduledFor?: string; entries: readonly { checkinId: string }[] },
  now: Date = new Date(),
): Promise<{ saleId: string; children: CheckinView[] }> {
  const { saleRow, stays, lineOf } = await loadChoice(tx, actor, input.saleId, input.entries.map((e) => e.checkinId));
  const scheduledFor = input.scheduledFor ? new Date(input.scheduledFor) : now;
  for (const s of stays) {
    const line = lineOf.get(s.id)!;
    const bookedMinutes = line.stayHours && line.stayHours > 0 ? line.stayHours * 60 : s.bookedMinutes;
    await tx
      .update(checkin)
      .set({ scheduledFor, bookedMinutes, saleId: saleRow.id, updatedAt: now })
      .where(eq(checkin.id, s.id));
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: s.branchId,
      action: 'checkin.update',
      entityType: 'checkin',
      entityId: s.id,
      requestId: actor.requestId,
      actionId: actor.actionId ?? null,
      before: { scheduledFor: s.scheduledFor?.toISOString() ?? null, saleId: s.saleId, bookedMinutes: s.bookedMinutes },
      after: { scheduledFor: scheduledFor.toISOString(), saleId: saleRow.id, bookedMinutes, event: 'leave_as_booked' },
    });
  }
  const after = await tx.select().from(checkin).where(inArray(checkin.id, stays.map((s) => s.id))).orderBy(asc(checkin.createdAt), asc(checkin.id));
  return { saleId: saleRow.id, children: after.map(checkinViewOf) };
}

// ================================================================================
// S2-13 round 2 — THE BOARD (plan §2.3). The prototype's DropOff page and its
// cards, moved from `mockApi.ts` onto these: `getCheckIns` → `boardOf`,
// `updateCheckIn` → `editCheckin`, `assignNanny` → `assignNanny`,
// `checkInFamilyBooked` → `checkInBooked`, `resendWaConfirmation` /
// `simulateWaConfirm` / `markWaConnectionFailed` → the contact-channel test.
// ================================================================================

/** The board's three status tabs (prototype `DropOff.tsx` TABS). */
export type BoardTab = 'registered' | 'in_park' | 'out';

/** Minutes left below which a child is "due soon" (prototype `lib/dropoff.ts` DUE_SOON_MINUTES). */
export const DUE_SOON_MINUTES = 15;

/**
 * THE CONTACT-CHANNEL TEST (R-95). There is no column for it — round 1's
 * migration carried none and this round adds none — so its state is the
 * newest `registration.contact` audit row for the registration: `pending`
 * when the connection check went out, `confirmed` when the guardian answered,
 * `failed` when staff could not reach them, `unverified` when the phone was
 * cleared. The audit rows are the record, exactly as they are for edits.
 */
export const CONTACT_ACTION = 'registration.contact';
export type ContactStatus = 'pending' | 'confirmed' | 'failed';

export interface ContactConnection {
  status: ContactStatus;
  sentAt: string | null;
  confirmedAt: string | null;
}

export interface BoardChild extends CheckinView {
  nannyName: string | null;
  checkedOutAt: string | null;
}

export interface BoardFamily {
  registrationId: string;
  branchId: string;
  memberId: string | null;
  guardianName: string;
  guardianPhone: string | null;
  contactChannel: string;
  consentRecordedAt: string | null;
  source: string;
  photoFileId: string | null;
  createdAt: string;
  /** Null = no connection check on record ("unverified" on the chip when a phone is set). */
  contact: ContactConnection | null;
  /** The family's canonical tab: in_park > registered > out (prototype `familyTab`). */
  tab: BoardTab;
  children: BoardChild[];
}

export interface BoardView {
  families: BoardFamily[];
  /** Per CHILD, as the prototype counts its tabs. */
  counts: Record<BoardTab, number>;
  /** Families whose channel is not confirmed (prototype `waFlaggedCount`). */
  unconfirmedFamilies: number;
  nannies: NannyView[];
  nannyRatioSoftMax: number;
  prepaidFoodUnused: 'refund' | 'forfeit';
}

export interface BoardFilter {
  tab?: BoardTab;
  service?: 'nanny' | 'drop_off';
  unconfirmed?: boolean;
  q?: string;
  /** In Park only: families with a child due soon or overdue (the ?due=1 hand-off). */
  due?: boolean;
}

function boardChildOf(row: CheckinRow, nannyName: string | null): BoardChild {
  return { ...checkinViewOf(row), nannyName, checkedOutAt: row.checkedOutAt?.toISOString() ?? null };
}

function tabOfStay(status: CheckinRow['status']): BoardTab {
  return status === 'in_park' ? 'in_park' : status === 'out' ? 'out' : 'registered';
}

/** Prototype `familyTab`: the highest-priority status among the children. */
export function familyTabOf(children: readonly { status: string }[]): BoardTab {
  if (children.some((c) => c.status === 'in_park')) return 'in_park';
  if (children.some((c) => c.status === 'registered')) return 'registered';
  return 'out';
}

/** Prototype `remainingMinutes`: booked − elapsed, or null when it cannot be told. */
export function remainingMinutesOf(
  c: { status: string; checkedInAt: string | null; bookedMinutes: number | null },
  now: number,
): number | null {
  if (c.status !== 'in_park' || !c.checkedInAt || c.bookedMinutes == null) return null;
  return c.bookedMinutes - (now - new Date(c.checkedInAt).getTime()) / 60_000;
}

/** Prototype `dueState`, as a boolean: due soon or overdue. */
function isDue(rem: number | null): boolean {
  return rem != null && rem < DUE_SOON_MINUTES;
}

function unconfirmed(f: BoardFamily): boolean {
  return f.contact?.status !== 'confirmed';
}

/**
 * The prototype's board filter and sort (`DropOff.tsx` visibleFamilies), as a
 * pure function the route applies when asked and the till mirrors on its own
 * ten-second tick: tab, service, due, unconfirmed, search; In Park sorted by
 * the least time left, Upcoming by the earliest booked start (walk-ins last).
 */
export function filterBoard(families: readonly BoardFamily[], f: BoardFilter, now: number = Date.now()): BoardFamily[] {
  const q = f.q?.trim().toLowerCase() ?? '';
  const out: BoardFamily[] = [];
  for (const fam of families) {
    if (f.tab && fam.tab !== f.tab) continue;
    if (f.service && !fam.children.some((c) => c.service === f.service)) continue;
    if (f.due && fam.tab === 'in_park' && !fam.children.some((c) => isDue(remainingMinutesOf(c, now)))) continue;
    if (f.unconfirmed && !unconfirmed(fam)) continue;
    if (q && !fam.children.some((c) => `${c.childName} ${fam.guardianName} ${fam.guardianPhone ?? ''}`.toLowerCase().includes(q))) continue;
    out.push({ ...fam, children: [...fam.children].sort((a, b) => a.childName.localeCompare(b.childName)) });
  }
  if (f.tab === 'in_park') {
    const least = (fam: BoardFamily) => Math.min(...fam.children.map((c) => remainingMinutesOf(c, now) ?? Infinity));
    out.sort((a, b) => least(a) - least(b));
  }
  if (f.tab === 'registered') {
    const earliest = (fam: BoardFamily) =>
      Math.min(...fam.children.map((c) => (c.scheduledFor ? new Date(c.scheduledFor).getTime() : Infinity)));
    out.sort((a, b) => earliest(a) - earliest(b));
  }
  return out;
}

/** When the branch's current trading day began (its `business_day_start` on its own clock). */
async function tradingDayStartOf(db: Exec, branchId: string, now: Date): Promise<Date> {
  const [br] = await db
    .select({ timezone: branch.timezone, businessDayStart: branch.businessDayStart })
    .from(branch)
    .where(eq(branch.id, branchId))
    .limit(1);
  if (!br) throw errors.notFound('Branch not found');
  const day = businessDate(now, br.timezone, parseDayStart(br.businessDayStart));
  const result = await db.execute(
    sql`select ((${day}::date + ${br.businessDayStart}::time) at time zone ${br.timezone}) as "start"`,
  );
  const value = (result as unknown as { rows: Array<{ start: Date | string }> }).rows[0]!.start;
  return value instanceof Date ? value : new Date(value);
}

/** The newest `registration.contact` row per registration — the channel's state. */
async function contactsOf(db: Exec, registrationIds: readonly string[]): Promise<Map<string, ContactConnection | null>> {
  const out = new Map<string, ContactConnection | null>();
  if (registrationIds.length === 0) return out;
  const rows = await db
    .select({ entityId: auditLog.entityId, after: auditLog.after })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, 'registration'),
        eq(auditLog.action, CONTACT_ACTION),
        inArray(auditLog.entityId, [...registrationIds]),
      ),
    )
    .orderBy(asc(auditLog.createdAt), asc(auditLog.id));
  for (const r of rows) {
    const a = (r.after ?? {}) as { status?: string; sentAt?: string | null; confirmedAt?: string | null };
    out.set(
      r.entityId,
      a.status === 'pending' || a.status === 'confirmed' || a.status === 'failed'
        ? { status: a.status, sentAt: a.sentAt ?? null, confirmedAt: a.confirmedAt ?? null }
        : null,
    );
  }
  return out;
}

async function nannyNamesOf(db: Exec, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map();
  const rows = await db.select({ id: nanny.id, name: nanny.name }).from(nanny).where(inArray(nanny.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * THE BOARD at one park (prototype `getCheckIns`, grouped by registration as
 * `DropOff.tsx` groups them): every family still waiting or in the park, and
 * the ones collected since this trading day began — the Out tab is today's
 * pickups, not every child the park ever released. Newest registration first.
 */
export async function boardOf(db: Exec, operatorId: string, branchId: string, now: Date = new Date()): Promise<BoardView> {
  const dayStart = await tradingDayStartOf(db, branchId, now);
  const stays = await db
    .select()
    .from(checkin)
    .where(
      and(
        eq(checkin.operatorId, operatorId),
        eq(checkin.branchId, branchId),
        or(ne(checkin.status, 'out'), gte(checkin.checkedOutAt, dayStart)),
      ),
    )
    .orderBy(asc(checkin.createdAt), asc(checkin.id));
  const regIds = [...new Set(stays.map((s) => s.registrationId))];
  const regs = regIds.length
    ? await db
        .select()
        .from(registration)
        .where(inArray(registration.id, regIds))
        .orderBy(desc(registration.createdAt), asc(registration.id))
    : [];
  const names = await nannyNamesOf(db, stays.map((s) => s.nannyId));
  const contacts = await contactsOf(db, regIds);
  const config = await supervisionConfigOf(db, branchId);

  const byReg = new Map<string, CheckinRow[]>();
  for (const s of stays) {
    const list = byReg.get(s.registrationId);
    if (list) list.push(s);
    else byReg.set(s.registrationId, [s]);
  }
  const counts: Record<BoardTab, number> = { registered: 0, in_park: 0, out: 0 };
  for (const s of stays) counts[tabOfStay(s.status)] += 1;

  const families: BoardFamily[] = regs.map((r) => {
    const children = (byReg.get(r.id) ?? []).map((s) => boardChildOf(s, s.nannyId ? (names.get(s.nannyId) ?? null) : null));
    return {
      registrationId: r.id,
      branchId: r.branchId,
      memberId: r.memberId,
      guardianName: r.guardianName,
      guardianPhone: r.guardianPhone,
      contactChannel: r.contactChannel,
      consentRecordedAt: r.consentRecordedAt?.toISOString() ?? null,
      source: r.source,
      photoFileId: r.photoFileId,
      createdAt: r.createdAt.toISOString(),
      contact: contacts.get(r.id) ?? null,
      tab: familyTabOf(children),
      children,
    };
  });
  return {
    families,
    counts,
    unconfirmedFamilies: families.filter(unconfirmed).length,
    nannies: await nannyRosterOf(db, branchId, now),
    nannyRatioSoftMax: config.pricing.nannyRatioSoftMax,
    prepaidFoodUnused: config.pricing.prepaidFoodUnused,
  };
}

/** The Today screen's "Drop-off kids in park" — every stay in the park now (prototype `getFloorReport`). */
export async function dropOffToday(
  db: Exec,
  operatorId: string,
  branchId: string,
): Promise<{ inPark: number; upcoming: number }> {
  const rows = await db
    .select({ status: checkin.status, n: sql<number>`count(*)::int` })
    .from(checkin)
    .where(and(eq(checkin.operatorId, operatorId), eq(checkin.branchId, branchId), ne(checkin.status, 'out')))
    .groupBy(checkin.status);
  const of = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
  return { inPark: of('in_park'), upcoming: of('registered') };
}

// --- The nanny rule -------------------------------------------------------------

/**
 * The server's answer to "may she take this child": on this park's roster,
 * not archived, and ON SHIFT — a shift row covering now. Anything else is
 * refused ("not on shift"). The soft ratio is never a refusal: over it, the
 * assignment stands and a warning comes back in the counter's words.
 */
async function checkNannyFor(
  db: Exec,
  branchId: string,
  nannyId: string,
  excludeCheckinId: string,
  now: Date,
): Promise<{ name: string; warning: string | null }> {
  const [row] = await db
    .select({ id: nanny.id, name: nanny.name })
    .from(nanny)
    .where(and(eq(nanny.id, nannyId), eq(nanny.branchId, branchId), isNull(nanny.archivedAt)))
    .limit(1);
  if (!row) throw errors.conflict('NANNY_NOT_ON_ROSTER', "That nanny is not on this park's roster.");
  const [shift] = await db
    .select({ id: nannyShift.id })
    .from(nannyShift)
    .where(
      and(
        eq(nannyShift.nannyId, nannyId),
        // The shift must be AT THIS PARK: one at another branch does not cover here.
        eq(nannyShift.branchId, branchId),
        lte(nannyShift.startsAt, now),
        gt(nannyShift.endsAt, now),
      ),
    )
    .limit(1);
  if (!shift) {
    throw errors.conflict('NANNY_NOT_ON_SHIFT', `${row.name} is not on shift — pick a nanny who is working now.`);
  }
  const [load] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(checkin)
    .where(and(eq(checkin.nannyId, nannyId), ne(checkin.status, 'out'), ne(checkin.id, excludeCheckinId)));
  const config = await supervisionConfigOf(db, branchId);
  const softMax = config.pricing.nannyRatioSoftMax;
  const after = Number(load?.n ?? 0) + 1;
  return {
    name: row.name,
    warning:
      after > softMax
        ? `${row.name} would be looking after ${after} children (over the suggested ${softMax}). Allowed — just double-check it's okay.`
        : null,
  };
}

async function loadStayForUpdate(tx: Tx, operatorId: string, id: string): Promise<CheckinRow> {
  const [row] = await tx
    .select()
    .from(checkin)
    .where(and(eq(checkin.id, id), eq(checkin.operatorId, operatorId)))
    .for('update')
    .limit(1);
  if (!row) throw errors.notFound('No such check-in');
  return row;
}

/** One stay, inside the caller's operator — the board's routes find the branch through it. */
export async function loadStay(db: Exec, operatorId: string, id: string): Promise<CheckinRow> {
  const [row] = await db
    .select()
    .from(checkin)
    .where(and(eq(checkin.id, id), eq(checkin.operatorId, operatorId)))
    .limit(1);
  if (!row) throw errors.notFound('No such check-in');
  return row;
}

async function boardChildById(db: Exec, id: string): Promise<BoardChild> {
  const [row] = await db.select().from(checkin).where(eq(checkin.id, id)).limit(1);
  const names = await nannyNamesOf(db, [row!.nannyId]);
  return boardChildOf(row!, row!.nannyId ? (names.get(row!.nannyId) ?? null) : null);
}

/**
 * ASSIGN A NANNY (prototype `assignNanny`, mockApi.ts:4835-4850): she must be
 * on shift (checked here, never trusted from the picker); the child moves to
 * the nanny service, as the prototype did. Over the soft ratio is a warning.
 */
export async function assignNanny(
  tx: Tx,
  actor: Actor,
  checkinId: string,
  nannyId: string,
  now: Date = new Date(),
): Promise<{ checkin: BoardChild; warnings: string[] }> {
  const stay = await loadStayForUpdate(tx, actor.operatorId, checkinId);
  if (stay.status === 'out') {
    throw errors.conflict('CHECKIN_OUT', `${stay.childName} has already been collected — no nanny is needed.`);
  }
  const { name, warning } = await checkNannyFor(tx, stay.branchId, nannyId, stay.id, now);
  if (stay.nannyId === nannyId && stay.service === 'nanny') {
    return { checkin: await boardChildById(tx, stay.id), warnings: warning ? [warning] : [] };
  }
  const names = await nannyNamesOf(tx, [stay.nannyId]);
  await tx.update(checkin).set({ nannyId, service: 'nanny', updatedAt: now }).where(eq(checkin.id, stay.id));
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: stay.branchId,
    action: 'checkin.update',
    entityType: 'checkin',
    entityId: stay.id,
    requestId: actor.requestId,
    actionId: actor.actionId ?? null,
    before: {
      nannyId: stay.nannyId,
      nannyName: stay.nannyId ? (names.get(stay.nannyId) ?? null) : null,
      ...(stay.service !== 'nanny' ? { service: stay.service } : {}),
    },
    after: { nannyId, nannyName: name, ...(stay.service !== 'nanny' ? { service: 'nanny' } : {}), event: 'assign_nanny' },
  });
  return { checkin: await boardChildById(tx, stay.id), warnings: warning ? [warning] : [] };
}

// --- The audited edit -----------------------------------------------------------

export interface CheckinEditInput {
  childName?: string;
  childAgeYears?: number;
  service?: SupervisionRequirement;
  bookedMinutes?: number | null;
  mayOrderFood?: boolean;
  foodRestrictions?: string | null;
  allergies?: string | null;
  nannyId?: string | null;
  guardianName?: string;
  guardianPhone?: string | null;
  contactChannel?: 'whatsapp' | 'telegram' | 'line';
}

export interface CheckinEditResult {
  checkin: BoardChild;
  /** How many fields changed — the prototype's "N fields updated" toast. */
  changed: number;
  warnings: string[];
  /** The registration's channel after the edit (a new phone or channel sends a fresh check). */
  contact: ContactConnection | null;
}

const blank = (v: string | null | undefined): string | null => (v?.trim() ? v.trim() : null);

/**
 * THE ONE AUDITED EDIT (prototype `updateCheckIn`, mockApi.ts:5380-5477).
 *
 * Every field the EditCheckInModal shows: the child's name and age (the
 * stay's snapshot AND, when the child is saved, the child record), service,
 * booked minutes, the food flags and allergies, the nanny, and the guardian's
 * name, phone and channel on the registration. Each write's before/after —
 * only the fields that changed — IS the change log (OD-C5): one
 * `checkin.update` row, a `child.update` row when the saved child changed, a
 * `registration.update` row when the guardian's details did. A nanny is
 * checked on shift here; leaving the nanny service releases her (the table
 * holds a nanny on nanny-service children only). A new phone or channel sends
 * a fresh connection check, and clearing the phone resets it, as the
 * prototype did.
 */
export async function editCheckin(
  tx: Tx,
  actor: Actor,
  checkinId: string,
  input: CheckinEditInput,
  deps: { sms: SmsSender | null; now?: Date },
): Promise<CheckinEditResult> {
  const now = deps.now ?? new Date();
  const stay = await loadStayForUpdate(tx, actor.operatorId, checkinId);
  const [reg] = await tx.select().from(registration).where(eq(registration.id, stay.registrationId)).for('update').limit(1);
  if (!reg) throw errors.notFound('No such registration');
  const warnings: string[] = [];

  // --- The stay ---
  const next = {
    childName: input.childName !== undefined ? input.childName.trim() : stay.childName,
    childAgeYears: input.childAgeYears ?? stay.childAgeYears,
    service: input.service ?? stay.service,
    bookedMinutes: input.bookedMinutes !== undefined ? input.bookedMinutes : stay.bookedMinutes,
    mayOrderFood: input.mayOrderFood ?? stay.mayOrderFood,
    foodRestrictions: input.foodRestrictions !== undefined ? blank(input.foodRestrictions) : stay.foodRestrictions,
    allergies: input.allergies !== undefined ? blank(input.allergies) : stay.allergies,
    nannyId: input.nannyId !== undefined ? input.nannyId : stay.nannyId,
  };
  if (!next.childName) throw errors.badRequest("The child's name can't be empty.");
  if (next.service !== 'nanny') next.nannyId = null;
  let nannyName: string | null = null;
  if (next.nannyId && next.nannyId !== stay.nannyId) {
    if (stay.status === 'out') {
      throw errors.conflict('CHECKIN_OUT', `${stay.childName} has already been collected — no nanny is needed.`);
    }
    const checked = await checkNannyFor(tx, stay.branchId, next.nannyId, stay.id, now);
    nannyName = checked.name;
    if (checked.warning) warnings.push(checked.warning);
  }
  const stayKeys = [
    'childName',
    'childAgeYears',
    'service',
    'bookedMinutes',
    'mayOrderFood',
    'foodRestrictions',
    'allergies',
    'nannyId',
  ] as const;
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const k of stayKeys) {
    if (next[k] !== stay[k]) {
      before[k] = stay[k];
      after[k] = next[k];
    }
  }
  let changed = Object.keys(after).length;
  if ('nannyId' in after) {
    const names = await nannyNamesOf(tx, [stay.nannyId, next.nannyId]);
    before.nannyName = stay.nannyId ? (names.get(stay.nannyId) ?? null) : null;
    after.nannyName = next.nannyId ? (nannyName ?? names.get(next.nannyId) ?? null) : null;
  }
  if (changed > 0) {
    await tx
      .update(checkin)
      .set({ ...next, updatedAt: now })
      .where(eq(checkin.id, stay.id));
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: stay.branchId,
      action: 'checkin.update',
      entityType: 'checkin',
      entityId: stay.id,
      requestId: actor.requestId,
      actionId: actor.actionId ?? null,
      before,
      after: { ...after, event: 'edit' },
    });
  }

  // --- The saved child: name, age, allergies and food restrictions follow the edit ---
  if (stay.childId && ['childName', 'childAgeYears', 'allergies', 'foodRestrictions'].some((k) => k in after)) {
    const [saved] = await tx.select().from(child).where(eq(child.id, stay.childId)).for('update').limit(1);
    if (saved) {
      const patch: Partial<typeof child.$inferInsert> = {};
      const was: Record<string, unknown> = {};
      if ('childName' in after && saved.name !== next.childName) {
        patch.name = next.childName;
        was.name = saved.name;
      }
      if ('childAgeYears' in after && saved.ageYears !== next.childAgeYears) {
        patch.ageYears = next.childAgeYears;
        was.ageYears = saved.ageYears;
      }
      if ('allergies' in after && saved.allergies !== next.allergies) {
        patch.allergies = next.allergies;
        was.allergies = saved.allergies;
      }
      if ('foodRestrictions' in after && saved.foodRestrictions !== next.foodRestrictions) {
        patch.foodRestrictions = next.foodRestrictions;
        was.foodRestrictions = saved.foodRestrictions;
      }
      if (Object.keys(patch).length) {
        await tx.update(child).set({ ...patch, updatedAt: now }).where(eq(child.id, saved.id));
        await audit.record(tx, {
          actorAccountId: actor.accountId,
          operatorId: actor.operatorId,
          branchId: stay.branchId,
          action: 'child.update',
          entityType: 'child',
          entityId: saved.id,
          requestId: actor.requestId,
          actionId: actor.actionId ?? null,
          before: was,
          after: { ...patch, source: 'checkin_board', checkinId: stay.id },
        });
      }
    }
  }

  // --- The registration: the guardian's name, phone and channel ---
  let contact: ContactConnection | null = (await contactsOf(tx, [reg.id])).get(reg.id) ?? null;
  if (input.guardianName !== undefined || input.guardianPhone !== undefined || input.contactChannel !== undefined) {
    let phone = reg.guardianPhone;
    if (input.guardianPhone !== undefined) {
      if (input.guardianPhone?.trim()) {
        phone = normalizePhone(input.guardianPhone);
        if (!phone) throw errors.badRequest("That phone number doesn't look right — check it with the guardian.");
      } else {
        phone = null;
      }
    }
    const nextReg = {
      guardianName: input.guardianName !== undefined ? input.guardianName.trim() : reg.guardianName,
      guardianPhone: phone,
      contactChannel: input.contactChannel ?? reg.contactChannel,
    };
    if (!nextReg.guardianName) throw errors.badRequest("The parent's name can't be empty.");
    const rBefore: Record<string, unknown> = {};
    const rAfter: Record<string, unknown> = {};
    for (const k of ['guardianName', 'guardianPhone', 'contactChannel'] as const) {
      if (nextReg[k] !== reg[k]) {
        rBefore[k] = reg[k];
        rAfter[k] = nextReg[k];
      }
    }
    if (Object.keys(rAfter).length) {
      changed += Object.keys(rAfter).length;
      await tx.update(registration).set({ ...nextReg, updatedAt: now }).where(eq(registration.id, reg.id));
      await audit.record(tx, {
        actorAccountId: actor.accountId,
        operatorId: actor.operatorId,
        branchId: reg.branchId,
        action: 'registration.update',
        entityType: 'registration',
        entityId: reg.id,
        requestId: actor.requestId,
        actionId: actor.actionId ?? null,
        before: rBefore,
        after: { ...rAfter, event: 'edit', checkinId: stay.id },
      });
      // The stored connection must never contradict the phone (prototype
      // updateCheckIn): a cleared phone resets it; a new one is tested again.
      const fresh = { ...reg, ...nextReg };
      if (!fresh.guardianPhone) {
        if (contact) {
          await recordContact(tx, actor, fresh, { status: 'unverified', sentAt: null, confirmedAt: null }, contact);
          contact = null;
        }
      } else if ('guardianPhone' in rAfter || 'contactChannel' in rAfter) {
        contact = await sendContactTest(tx, actor, fresh, deps.sms, now);
      }
    }
  }

  return { checkin: await boardChildById(tx, stay.id), changed, warnings, contact };
}

// --- The change log, read back from the audit rows ---------------------------------

export interface ChangeLogEntryView {
  id: string;
  field: string;
  oldValue: string;
  newValue: string;
  changedBy: string;
  changedById: string | null;
  changedAt: string;
}

const NONE = '—';

/** The prototype's change-log field names (mockApi.ts:5423-5433), in its order. */
const FIELD_LABELS: Record<string, string> = {
  childName: 'Child name',
  childAgeYears: 'Age',
  guardianName: 'Parent name',
  contactChannel: 'Contact method',
  guardianPhone: 'Phone',
  service: 'Service',
  mayOrderFood: 'May order food',
  foodRestrictions: 'Food restrictions',
  allergies: 'Allergies / medical',
  bookedMinutes: 'Booked play time',
  nannyName: 'Nanny',
  status: 'Status',
  scheduledFor: 'Booked start',
};

const STATUS_LABEL: Record<string, string> = { registered: 'Upcoming', in_park: 'In Park', out: 'Out' };
const SERVICE_LABEL: Record<string, string> = { nanny: 'Nanny', drop_off: 'Drop-Off', none: 'None' };

function formatField(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return NONE;
  switch (key) {
    case 'service':
      return SERVICE_LABEL[String(value)] ?? String(value);
    case 'mayOrderFood':
      return value ? 'Yes' : 'No';
    case 'bookedMinutes':
      return `${String(value)} min`;
    case 'status':
      return STATUS_LABEL[String(value)] ?? String(value);
    default:
      return String(value);
  }
}

/**
 * THE CHANGE HISTORY of one stay (EditCheckInModal's detail view), read from
 * the audit rows filtered to it — its own `checkin.update` rows and the
 * guardian edits on its registration — one entry per field, oldest first,
 * stamped with who did it. No jsonb log exists anywhere (OD-C5). A row that
 * named a nanny by id only (the till's check-in) is given her name here.
 */
export async function checkinHistory(db: Exec, operatorId: string, checkinId: string): Promise<ChangeLogEntryView[]> {
  const stay = await loadStay(db, operatorId, checkinId);
  const rows = await db
    .select({
      id: auditLog.id,
      before: auditLog.before,
      after: auditLog.after,
      createdAt: auditLog.createdAt,
      actorAccountId: auditLog.actorAccountId,
      actorName: employee.name,
      actorNickname: employee.nickname,
    })
    .from(auditLog)
    .leftJoin(account, eq(account.id, auditLog.actorAccountId))
    .leftJoin(employee, eq(employee.id, account.employeeId))
    .where(
      and(
        eq(auditLog.operatorId, operatorId),
        or(
          and(eq(auditLog.entityType, 'checkin'), eq(auditLog.entityId, stay.id), eq(auditLog.action, 'checkin.update')),
          and(
            eq(auditLog.entityType, 'registration'),
            eq(auditLog.entityId, stay.registrationId),
            eq(auditLog.action, 'registration.update'),
          ),
        ),
      ),
    )
    .orderBy(asc(auditLog.createdAt), asc(auditLog.id));
  const nannyIds: string[] = [];
  for (const r of rows) {
    for (const side of [r.before, r.after] as (Record<string, unknown> | null)[]) {
      if (side && typeof side.nannyId === 'string') nannyIds.push(side.nannyId);
    }
  }
  const names = await nannyNamesOf(db, nannyIds);
  const out: ChangeLogEntryView[] = [];
  for (const r of rows) {
    const before = { ...((r.before ?? {}) as Record<string, unknown>) };
    const after = { ...((r.after ?? {}) as Record<string, unknown>) };
    for (const side of [before, after]) {
      if ('nannyId' in side && !('nannyName' in side)) {
        side.nannyName = typeof side.nannyId === 'string' ? (names.get(side.nannyId) ?? null) : null;
      }
    }
    for (const k of Object.keys(FIELD_LABELS)) {
      if (!(k in after)) continue;
      const oldValue = formatField(k, before[k]);
      const newValue = formatField(k, after[k]);
      if (oldValue === newValue) continue;
      out.push({
        id: `${r.id}:${k}`,
        field: FIELD_LABELS[k]!,
        oldValue,
        newValue,
        changedBy: r.actorNickname || r.actorName || (r.actorAccountId ? 'Staff' : 'System'),
        changedById: r.actorAccountId,
        changedAt: r.createdAt.toISOString(),
      });
    }
  }
  return out;
}

// --- Booked check-in, never a sale (R-90) ------------------------------------------

/**
 * CHECK IN A BOOKED FAMILY FROM THE BOARD (prototype `checkInFamilyBooked`,
 * mockApi.ts:5118-5230). The children were paid for already — "Leave as
 * booked" at the till linked their sale — so this takes NO payment and writes
 * NO sale: it validates every child first (still waiting, booked, paid for,
 * each nanny child with an on-shift nanny), records the guardian's consent if
 * it was not on file, and then runs the in-park process on the sale they were
 * paid on: in the park with the timer started, the band minted on their own
 * line and queued for print — the same one transaction as the till's
 * "Check in now", so a child never stands in the park without a band.
 */
export async function checkInBooked(
  tx: Tx,
  actor: Actor,
  input: { entries: readonly { checkinId: string; nannyId?: string | null }[]; consentAcknowledged?: boolean },
  now: Date = new Date(),
): Promise<CheckInNowResult & { saleIds: string[] }> {
  const ids = input.entries.map((e) => e.checkinId);
  if (new Set(ids).size !== ids.length) throw errors.badRequest('A child was named twice.');
  const stays = await tx
    .select()
    .from(checkin)
    .where(and(inArray(checkin.id, ids), eq(checkin.operatorId, actor.operatorId)))
    .for('update');
  if (stays.length !== ids.length) throw errors.notFound('No such check-in');
  if (new Set(stays.map((s) => s.branchId)).size !== 1) throw errors.badRequest('These children were registered at different parks.');
  const nannyOf = new Map(input.entries.map((e) => [e.checkinId, e.nannyId ?? null]));

  // --- Validate all before committing any ---
  for (const s of stays) {
    if (s.status !== 'registered') {
      throw errors.conflict(
        'CHECKIN_NOT_REGISTERED',
        `${s.childName} is already ${s.status === 'in_park' ? 'checked in' : 'checked out'}.`,
      );
    }
    if (!s.scheduledFor || !s.saleId) {
      throw errors.conflict(
        'CHECKIN_NOT_BOOKED',
        `${s.childName} has not been paid for yet — check them in at the till, where the payment is taken.`,
      );
    }
    if (s.service === 'nanny') {
      const id = nannyOf.get(s.id) ?? s.nannyId;
      if (!id) throw errors.conflict('NANNY_REQUIRED', `Assign a nanny to ${s.childName} before checking them in.`);
      await checkNannyFor(tx, s.branchId, id, s.id, now);
    }
  }
  const regIds = [...new Set(stays.map((s) => s.registrationId))];
  const regs = await tx.select().from(registration).where(inArray(registration.id, regIds)).for('update');
  if (regs.some((r) => !r.consentRecordedAt) && !input.consentAcknowledged) {
    throw errors.conflict('CONSENT_REQUIRED', "The guardian's consent isn't on file — tick the consent before checking them in.");
  }

  // --- Commit ---
  for (const r of regs) {
    if (r.consentRecordedAt) continue;
    await tx.update(registration).set({ consentRecordedAt: now, updatedAt: now }).where(eq(registration.id, r.id));
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: r.branchId,
      action: 'registration.update',
      entityType: 'registration',
      entityId: r.id,
      requestId: actor.requestId,
      actionId: actor.actionId ?? null,
      before: { consentRecordedAt: null },
      after: { consentRecordedAt: now.toISOString(), event: 'consent_at_check_in' },
    });
  }
  const bySale = new Map<string, { checkinId: string; nannyId: string | null }[]>();
  for (const s of stays) {
    const entry = { checkinId: s.id, nannyId: s.service === 'nanny' ? (nannyOf.get(s.id) ?? s.nannyId) : null };
    const list = bySale.get(s.saleId!);
    if (list) list.push(entry);
    else bySale.set(s.saleId!, [entry]);
  }
  const result: CheckInNowResult & { saleIds: string[] } = {
    saleId: '',
    saleIds: [],
    children: [],
    bands: [],
    printJobs: [],
    notes: [],
  };
  for (const [saleId, entries] of bySale) {
    const done = await checkInNow(tx, actor, { saleId, entries }, now, { event: 'check_in_booked' });
    result.saleIds.push(saleId);
    result.children.push(...done.children);
    result.bands.push(...done.bands);
    result.printJobs.push(...done.printJobs);
    result.notes.push(...done.notes);
  }
  result.saleId = result.saleIds[0] ?? '';
  return result;
}

// --- The contact-channel test (R-95) -------------------------------------------------

function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

async function recordContact(
  tx: Tx,
  actor: Actor,
  reg: Pick<RegistrationRow, 'id' | 'branchId' | 'contactChannel'>,
  next: { status: ContactStatus | 'unverified'; sentAt: string | null; confirmedAt: string | null },
  prev: ContactConnection | null,
): Promise<void> {
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: reg.branchId,
    action: CONTACT_ACTION,
    entityType: 'registration',
    entityId: reg.id,
    requestId: actor.requestId,
    actionId: actor.actionId ?? null,
    before: prev ? { ...prev } : { status: 'unverified' },
    after: { ...next, channel: reg.contactChannel },
  });
}

/**
 * SEND THE CONNECTION CHECK (prototype `resendWaConfirmation`): the
 * connection-check template, naming every child on the registration, through
 * the platform's CONSOLE messaging adapter — the one the booking confirmation
 * uses until real channels are their own ticket — and the registration's
 * channel goes `pending` for every sibling at once.
 */
export async function sendContactTest(
  tx: Tx,
  actor: Actor,
  reg: Pick<RegistrationRow, 'id' | 'branchId' | 'guardianName' | 'guardianPhone' | 'contactChannel'>,
  sms: SmsSender | null,
  now: Date = new Date(),
): Promise<ContactConnection> {
  if (!reg.guardianPhone) {
    throw errors.conflict('NO_PHONE', 'There is no phone number on this registration — add one, then send the check.');
  }
  if (!sms) {
    throw new AppError(503, 'MESSAGING_UNAVAILABLE', "Messages can't be sent from this deployment right now — try again later.");
  }
  const prev = (await contactsOf(tx, [reg.id])).get(reg.id) ?? null;
  const kids = await tx.select({ name: checkin.childName }).from(checkin).where(eq(checkin.registrationId, reg.id));
  const names = nameList(kids.map((k) => k.name).sort((a, b) => a.localeCompare(b)));
  const body =
    `Hi ${reg.guardianName}, ${names} has just been registered at Oto. Please tap the button below to confirm we have the right number — ` +
    "we'll use it for emergency updates during your child's session.";
  try {
    await sms.send(reg.guardianPhone, body);
  } catch {
    throw new AppError(502, 'MESSAGE_NOT_SENT', "The connection check didn't go out — try again in a moment.");
  }
  const next: ContactConnection = { status: 'pending', sentAt: now.toISOString(), confirmedAt: null };
  await recordContact(tx, actor, reg, next, prev);
  return next;
}

/**
 * The guardian's answer, recorded by staff (prototype `simulateWaConfirm` and
 * `markWaConnectionFailed`): confirmed only after a check went out; "couldn't
 * reach" at any time.
 */
export async function recordContactStatus(
  tx: Tx,
  actor: Actor,
  reg: RegistrationRow,
  status: 'confirmed' | 'failed',
  now: Date = new Date(),
): Promise<ContactConnection> {
  const prev = (await contactsOf(tx, [reg.id])).get(reg.id) ?? null;
  if (status === 'confirmed' && prev?.status !== 'pending') {
    throw errors.conflict('CONTACT_NOT_PENDING', 'Send the connection check first — then the guardian can confirm it.');
  }
  const next: ContactConnection =
    status === 'confirmed'
      ? { status, sentAt: prev?.sentAt ?? null, confirmedAt: now.toISOString() }
      : { status, sentAt: prev?.sentAt ?? null, confirmedAt: prev?.confirmedAt ?? null };
  await recordContact(tx, actor, reg, next, prev);
  return next;
}

export async function contactOf(db: Exec, registrationId: string): Promise<ContactConnection | null> {
  return (await contactsOf(db, [registrationId])).get(registrationId) ?? null;
}

// --- The supervision config, audited (the admin panels) -------------------------------

/** Prototype `SupervisionPanel` validateBands: contiguous from 0, one open top band, covering 18. */
export function bandProblems(bands: readonly { label: string; minAge: number; maxAge: number | null }[]): string[] {
  const problems: string[] = [];
  if (bands.length === 0) return ['Add at least one age band so every child resolves to a rule.'];
  for (const b of bands) {
    if (!Number.isFinite(b.minAge) || b.minAge < 0) problems.push(`“${b.label || 'Unnamed band'}” has an invalid minimum age.`);
    if (b.maxAge !== null && b.maxAge < b.minAge) {
      problems.push(`“${b.label || 'Unnamed band'}” has a maximum age below its minimum.`);
    }
  }
  const sorted = [...bands].sort((a, b) => a.minAge - b.minAge);
  const openCount = sorted.filter((b) => b.maxAge === null).length;
  if (openCount > 1) problems.push('Only the highest band may have no upper bound.');
  else if (openCount === 1 && sorted[sorted.length - 1]!.maxAge !== null) {
    problems.push('The band with no upper bound must be the highest one.');
  }
  if (sorted[0]!.minAge !== 0) problems.push(`Bands should start at age 0 (lowest band starts at ${sorted[0]!.minAge}).`);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (prev.maxAge === null) {
      problems.push('A band with no upper bound must be last — ages after it can never resolve.');
      break;
    }
    if (cur.minAge <= prev.maxAge) {
      problems.push(`“${prev.label || prev.minAge}” and “${cur.label || cur.minAge}” overlap at age ${cur.minAge}.`);
    } else if (cur.minAge > prev.maxAge + 1) {
      problems.push(`Gap between ages ${prev.maxAge} and ${cur.minAge} — no band covers ${prev.maxAge + 1}.`);
    }
  }
  const top = sorted[sorted.length - 1]!;
  if (top.maxAge !== null && top.maxAge < 18) {
    problems.push(`No band covers ages above ${top.maxAge} — add an open-ended top band or extend it.`);
  }
  return problems;
}

async function assertBranchOf(db: Exec, operatorId: string, branchId: string): Promise<void> {
  const [br] = await db.select({ operatorId: branch.operatorId }).from(branch).where(eq(branch.id, branchId)).limit(1);
  if (!br || br.operatorId !== operatorId) throw errors.notFound('Branch not found');
}

/** The policy row, created from the prototype's seed when a branch has none yet. */
async function policyRowFor(tx: Tx, operatorId: string, branchId: string): Promise<typeof supervisionPolicy.$inferSelect> {
  const [row] = await tx
    .select()
    .from(supervisionPolicy)
    .where(eq(supervisionPolicy.branchId, branchId))
    .for('update')
    .limit(1);
  if (row) return row;
  const p = DEFAULT_SUPERVISION_POLICY;
  const [made] = await tx
    .insert(supervisionPolicy)
    .values({
      id: newId(),
      operatorId,
      branchId,
      bands: p.bands,
      siblingWaiverEnabled: p.siblingWaiver.enabled,
      waivableRequirement: p.siblingWaiver.waivableRequirement,
      guardianMinAge: p.siblingWaiver.guardianMinAge,
      waiverStaffOnly: p.siblingWaiver.staffOnly,
      nannyRatioSoftMax: DEFAULT_DROP_OFF_PRICING.nannyRatioSoftMax,
    })
    .returning();
  return made!;
}

export interface PolicyInput {
  bands: { id: string; label: string; minAge: number; maxAge: number | null; requirement: SupervisionRequirement }[];
  siblingWaiver: { enabled: boolean; guardianMinAge: number; waivableRequirement: SupervisionRequirement; staffOnly: boolean };
}

/** The age bands and the sibling waiver (SupervisionPanel), audited before/after. */
export async function savePolicy(tx: Tx, actor: Actor, branchId: string, input: PolicyInput): Promise<SupervisionConfig> {
  await assertBranchOf(tx, actor.operatorId, branchId);
  const problems = bandProblems(input.bands);
  if (problems.length) throw errors.badRequest(problems[0]!, { problems });
  const row = await policyRowFor(tx, actor.operatorId, branchId);
  const before = {
    bands: row.bands,
    siblingWaiver: {
      enabled: row.siblingWaiverEnabled,
      guardianMinAge: row.guardianMinAge,
      waivableRequirement: row.waivableRequirement,
      staffOnly: row.waiverStaffOnly,
    },
  };
  const bands = [...input.bands].sort((a, b) => a.minAge - b.minAge);
  await tx
    .update(supervisionPolicy)
    .set({
      bands,
      siblingWaiverEnabled: input.siblingWaiver.enabled,
      guardianMinAge: input.siblingWaiver.guardianMinAge,
      waivableRequirement: input.siblingWaiver.waivableRequirement,
      waiverStaffOnly: input.siblingWaiver.staffOnly,
      updatedAt: new Date(),
    })
    .where(eq(supervisionPolicy.id, row.id));
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId,
    action: 'supervision_policy.update',
    entityType: 'supervision_policy',
    entityId: row.id,
    requestId: actor.requestId,
    actionId: actor.actionId ?? null,
    before,
    after: { bands, siblingWaiver: input.siblingWaiver },
  });
  return supervisionConfigOf(tx, branchId);
}

/**
 * The confirmations checklist, replaced as the panel holds it: an item kept
 * is updated, a new one created, one taken off the list ARCHIVED (never
 * deleted — a registration's acknowledged items still name it). One audit row
 * per item that changed.
 */
export async function saveConfirmations(
  tx: Tx,
  actor: Actor,
  branchId: string,
  items: readonly { id: string; text: string; required: boolean; order: number }[],
): Promise<SupervisionConfig> {
  await assertBranchOf(tx, actor.operatorId, branchId);
  const codes = items.map((i) => i.id);
  if (new Set(codes).size !== codes.length) throw errors.badRequest('Two confirmations share the same id.');
  if (items.some((i) => !i.text.trim())) throw errors.badRequest('A confirmation needs its wording — fill it in or remove it.');
  const live = await tx
    .select()
    .from(confirmationItem)
    .where(and(eq(confirmationItem.branchId, branchId), isNull(confirmationItem.archivedAt)))
    .for('update');
  const byCode = new Map(live.map((r) => [r.code, r]));
  const now = new Date();
  const base = {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId,
    entityType: 'confirmation_item',
    requestId: actor.requestId,
    actionId: actor.actionId ?? null,
  };
  for (const r of live) {
    if (codes.includes(r.code)) continue;
    await tx.update(confirmationItem).set({ archivedAt: now, updatedAt: now }).where(eq(confirmationItem.id, r.id));
    await audit.record(tx, {
      ...base,
      action: 'confirmation_item.archive',
      entityId: r.id,
      before: { code: r.code, text: r.text, required: r.required, sortOrder: r.sortOrder },
      after: { archivedAt: now.toISOString() },
    });
  }
  for (const i of items) {
    const text = i.text.trim();
    const existing = byCode.get(i.id);
    if (!existing) {
      const id = newId();
      await tx.insert(confirmationItem).values({
        id,
        operatorId: actor.operatorId,
        branchId,
        code: i.id,
        text,
        required: i.required,
        sortOrder: i.order,
      });
      await audit.record(tx, {
        ...base,
        action: 'confirmation_item.create',
        entityId: id,
        after: { code: i.id, text, required: i.required, sortOrder: i.order },
      });
      continue;
    }
    if (existing.text === text && existing.required === i.required && existing.sortOrder === i.order) continue;
    await tx
      .update(confirmationItem)
      .set({ text, required: i.required, sortOrder: i.order, updatedAt: now })
      .where(eq(confirmationItem.id, existing.id));
    await audit.record(tx, {
      ...base,
      action: 'confirmation_item.update',
      entityId: existing.id,
      before: { text: existing.text, required: existing.required, sortOrder: existing.sortOrder },
      after: { text, required: i.required, sortOrder: i.order },
    });
  }
  return supervisionConfigOf(tx, branchId);
}

export interface PricingInput {
  oneTimeFee: { weekday: number; weekend: number };
  nannyHourly: { weekday: number; weekend: number };
  extraHour: { weekday: number; weekend: number };
  fullDayHours: number;
  nannyRatioSoftMax: number;
  prepaidFoodUnused: 'refund' | 'forfeit';
}

/**
 * Drop-off and nanny pricing (DropOffPricingPanel), in satang, audited. The
 * soft ratio lives on the policy row (it is the supervision rule the board
 * warns at), the rest on `pos.drop_off_pricing`; the panel saves them
 * together, so both are written here, in one transaction and one audit row.
 */
export async function savePricing(tx: Tx, actor: Actor, branchId: string, input: PricingInput): Promise<SupervisionConfig> {
  await assertBranchOf(tx, actor.operatorId, branchId);
  const now = new Date();
  const [row] = await tx
    .select()
    .from(dropOffPricing)
    .where(eq(dropOffPricing.branchId, branchId))
    .for('update')
    .limit(1);
  const values = {
    oneTimeFeeWeekdaySatang: input.oneTimeFee.weekday,
    oneTimeFeeWeekendSatang: input.oneTimeFee.weekend,
    nannyHourlyWeekdaySatang: input.nannyHourly.weekday,
    nannyHourlyWeekendSatang: input.nannyHourly.weekend,
    extraHourWeekdaySatang: input.extraHour.weekday,
    extraHourWeekendSatang: input.extraHour.weekend,
    fullDayHours: input.fullDayHours,
    prepaidFoodUnused: input.prepaidFoodUnused,
  };
  const policy = await policyRowFor(tx, actor.operatorId, branchId);
  let pricingId: string;
  let before: Record<string, unknown> | null = null;
  if (row) {
    pricingId = row.id;
    before = {
      oneTimeFee: { weekday: row.oneTimeFeeWeekdaySatang, weekend: row.oneTimeFeeWeekendSatang },
      nannyHourly: { weekday: row.nannyHourlyWeekdaySatang, weekend: row.nannyHourlyWeekendSatang },
      extraHour: { weekday: row.extraHourWeekdaySatang, weekend: row.extraHourWeekendSatang },
      fullDayHours: row.fullDayHours,
      nannyRatioSoftMax: policy.nannyRatioSoftMax,
      prepaidFoodUnused: row.prepaidFoodUnused,
    };
    await tx.update(dropOffPricing).set({ ...values, updatedAt: now }).where(eq(dropOffPricing.id, row.id));
  } else {
    pricingId = newId();
    await tx.insert(dropOffPricing).values({ id: pricingId, operatorId: actor.operatorId, branchId, ...values });
  }
  if (policy.nannyRatioSoftMax !== input.nannyRatioSoftMax) {
    await tx
      .update(supervisionPolicy)
      .set({ nannyRatioSoftMax: input.nannyRatioSoftMax, updatedAt: now })
      .where(eq(supervisionPolicy.id, policy.id));
  }
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId,
    action: row ? 'drop_off_pricing.update' : 'drop_off_pricing.create',
    entityType: 'drop_off_pricing',
    entityId: pricingId,
    requestId: actor.requestId,
    actionId: actor.actionId ?? null,
    before,
    after: { ...input },
  });
  return supervisionConfigOf(tx, branchId);
}
