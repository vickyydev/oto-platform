import { and, asc, eq, gt, inArray, isNull, lte, ne } from 'drizzle-orm';
import {
  band,
  branch,
  checkin,
  child,
  confirmationItem,
  dropOffPricing,
  fileObject,
  member,
  nanny,
  nannyShift,
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
  confirmationsSatisfied,
  normalizePhone,
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
import type { Exec, Tx } from './tx';

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
    .where(and(inArray(nannyShift.nannyId, ids), lte(nannyShift.startsAt, now), gt(nannyShift.endsAt, now)));
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
  const provision = raw.mode !== 'none' && raw.paidSatang <= 0 ? { mode: 'none' as const, paidSatang: 0 } : raw;
  return { provision, mayOrderFood: provision.mode !== 'none' && provision.paidSatang > 0 };
}

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
  for (const c of children) {
    if (already.has(c.checkinId)) continue;
    const { provision, mayOrderFood } = normaliseProvision(c.foodProvision);
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
  input: { saleId: string; entries: readonly { checkinId: string; nannyId?: string | null }[] },
  now: Date = new Date(),
): Promise<CheckInNowResult> {
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

  // The nannies, all before any write (prototype checkInFamilyWithPayment).
  const nannyIds = new Set<string>();
  for (const s of stays) {
    if (s.service !== 'nanny') continue;
    const id = nannyByEntry.get(s.id) ?? s.nannyId;
    if (!id) throw errors.conflict('NANNY_REQUIRED', `Assign a nanny to ${s.childName} before checking them in.`);
    nannyIds.add(id);
  }
  if (nannyIds.size) {
    const found = await tx
      .select({ id: nanny.id })
      .from(nanny)
      .where(and(inArray(nanny.id, [...nannyIds]), eq(nanny.branchId, saleRow.branchId), isNull(nanny.archivedAt)));
    if (found.length !== nannyIds.size) throw errors.conflict('NANNY_NOT_ON_ROSTER', "That nanny is not on this park's roster.");
  }

  for (const s of stays) {
    const line = lineOf.get(s.id)!;
    const nannyId = s.service === 'nanny' ? (nannyByEntry.get(s.id) ?? s.nannyId) : null;
    const patch = {
      status: 'in_park' as const,
      checkedInAt: now,
      checkedInByAccountId: actor.accountId,
      scheduledFor: null,
      bookedMinutes: line.stayHours && line.stayHours > 0 ? line.stayHours * 60 : s.bookedMinutes,
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
      before: { status: s.status, saleId: s.saleId, nannyId: s.nannyId, scheduledFor: s.scheduledFor?.toISOString() ?? null },
      after: { status: 'in_park', saleId: saleRow.id, nannyId, bookedMinutes: patch.bookedMinutes, checkedInAt: now.toISOString(), event: 'check_in_now' },
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
