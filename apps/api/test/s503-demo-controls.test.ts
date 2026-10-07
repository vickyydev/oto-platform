import { and, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  branch,
  checkin,
  child,
  dropOffPricing,
  fileObject,
  guardian,
  member,
  nanny,
  registration,
  release,
  spin,
  station,
  supervisionPolicy,
  supervisionWaiver,
  ticketPackage,
} from '@oto/db';
import { DEMO_BOOTH_NAME, DEMO_BRANCH_CODE } from '@oto/db/seed';
import { newId } from '@oto/shared';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-503 — three walkthrough findings on the staging demo controls:
 *
 *   9  a re-press of "Add demo sales" after the demo booth was archived in the
 *      Console said "0 spins added, 0 already present" though the day's presses
 *      stood: they are counted by the day now, not at the newest booth only;
 *   8  a press the demo seed refuses (a code prefix another booth prints under)
 *      answers 409 in the api's error shape with the refusal's own words, not a
 *      500 the Console could only show as a generic error;
 *   7  the demo reset refused outright once a drop-off child had been checked
 *      in: the supervised stays now go with the rest of the day, and the reset
 *      still says, table by table, what it removed.
 */

let ctx: TestContext;
let admin: string;
let reception: string;
let hkt: string;
let chalong: string;

const post = (cookie: string, url: string, payload: Record<string, unknown> = {}) =>
  ctx.app.inject({ method: 'POST', url, headers: { cookie }, payload });

const pressDemoDay = () => post(admin, '/ops/test-controls/demo.day');

async function demoBranchId(): Promise<string> {
  return branchIdByCode(ctx.db, DEMO_BRANCH_CODE);
}

async function liveDemoBooth() {
  const [row] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, await demoBranchId()), eq(station.name, DEMO_BOOTH_NAME), isNull(station.archivedAt)));
  return row!;
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { OPS_TEST_CONTROLS: 'true' } });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  hkt = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- 9 ---------------------------------------------------------------------------------

describe('9 — a re-press after the demo booth was archived counts the day', () => {
  it('says the day’s six presses are already present, writes none, and leaves the archived booth’s rows', async () => {
    const first = await pressDemoDay();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().message).toMatch(/: 11 sales added, 0 already present; booth: 6 spins added, 0 already present/);

    // Archived in the Console, as the walkthrough did.
    const old = await liveDemoBooth();
    const archived = await ctx.app.inject({ method: 'DELETE', url: `/stations/${old.id}`, headers: { cookie: admin } });
    expect(archived.statusCode, archived.body).toBe(200);
    const demo = await demoBranchId();
    const spinsBefore = await ctx.db.select({ id: spin.id }).from(spin).where(eq(spin.branchId, demo));
    expect(spinsBefore).toHaveLength(6);

    const again = await pressDemoDay();
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().message).toMatch(
      /: 0 sales added, 11 already present; booth: 0 spins added, 6 already present\. Existing records and closed-day totals were kept\.$/,
    );
    // The press made the booth again, and filed nothing at it: the day stands where it was filed.
    const fresh = await liveDemoBooth();
    expect(fresh.id).not.toBe(old.id);
    expect(await ctx.db.select({ id: spin.id }).from(spin).where(eq(spin.stationId, fresh.id))).toEqual([]);
    expect(await ctx.db.select({ id: spin.id }).from(spin).where(eq(spin.branchId, demo))).toHaveLength(6);
  });
});

// --- 8 ---------------------------------------------------------------------------------

describe('8 — a press the demo seed refuses answers 409 in the refusal’s own words', () => {
  it('a code prefix another live booth prints under: DEMO_DAY_REFUSED, its sentence, nothing written', async () => {
    const demoBooth = await liveDemoBooth();
    const [parkBooth] = await ctx.db
      .select()
      .from(station)
      .where(and(inArray(station.branchId, [hkt, chalong]), eq(station.kind, 'booth'), isNull(station.archivedAt)))
      .limit(1);
    expect(parkBooth, 'the seed has a booth at a live park').toBeTruthy();
    const [parkName] = await ctx.db.select({ name: branch.name }).from(branch).where(eq(branch.id, parkBooth!.branchId));
    // The demo booth retired, and a live park's booth took its prefix meanwhile.
    await ctx.db.update(station).set({ archivedAt: new Date() }).where(eq(station.id, demoBooth.id));
    await ctx.db.update(station).set({ codePrefix: 'DB' }).where(eq(station.id, parkBooth!.id));
    try {
      const spinsBefore = await ctx.db.select({ id: spin.id }).from(spin);
      const refused = await pressDemoDay();
      expect(refused.statusCode, refused.body).toBe(409);
      const { error } = refused.json() as { error: { code: string; message: string } };
      expect(error.code).toBe('DEMO_DAY_REFUSED');
      expect(error.message).toBe(
        `Code prefix DB is already used by ${parkBooth!.name} at ${parkName!.name}, so the demo booth cannot be made with it. ` +
          'Every booth needs a prefix of its own, because it starts every voucher code the booth prints.',
      );
      expect(await ctx.db.select({ id: spin.id }).from(spin)).toHaveLength(spinsBefore.length);
      expect(
        await ctx.db
          .select({ id: station.id })
          .from(station)
          .where(and(eq(station.branchId, await demoBranchId()), eq(station.name, DEMO_BOOTH_NAME), isNull(station.archivedAt))),
      ).toEqual([]);
    } finally {
      await ctx.db.update(station).set({ codePrefix: parkBooth!.codePrefix }).where(eq(station.id, parkBooth!.id));
      await ctx.db.update(station).set({ archivedAt: null }).where(eq(station.id, demoBooth.id));
    }
    // Put right, the next press is answered as before.
    const after = await pressDemoDay();
    expect(after.statusCode, after.body).toBe(200);
  });
});

// --- 7 ---------------------------------------------------------------------------------

const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];

/** A family walked up today: a member the session created, their child, a drop-off stay paid and checked in. */
async function droppedOff(): Promise<{ memberId: string; childId: string; registrationId: string; checkinId: string; saleId: string }> {
  const signedUp = await post(reception, '/members', { phone: '0655503001', nickname: 'S503 family' });
  expect(signedUp.statusCode, signedUp.body).toBe(200);
  const memberId = signedUp.json().member.id as string;
  const kid = await post(reception, `/members/${memberId}/children`, { name: 'Mint', ageYears: 6, allergies: 'Peanuts' });
  expect(kid.statusCode, kid.body).toBe(200);
  const childId = (kid.json().child?.id ?? kid.json().id) as string;

  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, hkt), eq(station.codePrefix, 'T1')));
  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, hkt), eq(ticketPackage.name, '2 Hours Play')));
  const registrationId = newId();
  const checkinId = newId();
  const reg = await post(reception, '/checkin/registrations', {
    id: registrationId,
    branchId: hkt,
    stationId: till!.id,
    memberId,
    guardianName: 'Ploy',
    guardianPhone: '0655503001',
    contactChannel: 'whatsapp',
    consentAcknowledged: true,
    acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
    children: [{ checkinId, childId, name: 'Mint', ageYears: 6, service: 'drop_off', allergies: 'Peanuts', foodRestrictions: null }],
  });
  expect(reg.statusCode, reg.body).toBe(200);
  const saleId = newId();
  const rung = await post(reception, '/sales', {
    id: saleId,
    stationId: till!.id,
    lines: [{ id: checkinId, packageId: pkg!.id, kids: 1, adults: 0, serviceFee: { label: 'Drop-off service', amountSatang: 22_500 } }],
  });
  expect(rung.statusCode, rung.body).toBe(200);
  const paid = await post(reception, `/sales/${saleId}/finalise`);
  expect(paid.statusCode, paid.body).toBe(200);
  const inPark = await post(reception, '/checkin/check-in-now', { saleId, entries: [{ checkinId, nannyId: null }] });
  expect(inPark.statusCode, inPark.body).toBe(200);
  return { memberId, childId, registrationId, checkinId, saleId };
}

describe('7 — the demo reset clears the supervised stays of a day of play', () => {
  it('a checked-in drop-off child, its collector, hand-back and waiver no longer stop the reset; configuration and photos stay', async () => {
    const stay = await droppedOff();
    const [stayRow] = await ctx.db.select().from(checkin).where(eq(checkin.id, stay.checkinId));
    expect(stayRow).toMatchObject({ status: 'in_park', saleId: stay.saleId, childId: stay.childId });
    expect(stayRow!.bandId).not.toBeNull();

    // An authorised collector, as the pickup sheet adds one.
    const collector = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/pickups/registrations/${stay.registrationId}/guardians`,
      headers: { cookie: reception },
      payload: { id: newId(), name: 'Khun Somchai', relationship: 'grandfather', source: 'in_person' },
    });
    expect(collector.statusCode, collector.body).toBe(200);
    const [receptionAccount] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, RECEPTION.phone));
    const [operatorRow] = await ctx.db.select({ operatorId: registration.operatorId }).from(registration).where(eq(registration.id, stay.registrationId));
    const operatorId = operatorRow!.operatorId;
    // The hand-back and a sibling waiver, as rounds 3 and 1 write them.
    await ctx.db.insert(release).values({
      id: newId(), operatorId, branchId: hkt, checkinId: stay.checkinId, guardianId: collector.json().id as string,
      collectorName: 'Khun Somchai', verifiedByAccountId: receptionAccount!.id,
    });
    await ctx.db.insert(supervisionWaiver).values({
      id: newId(), operatorId, branchId: hkt, registrationId: stay.registrationId, checkinId: stay.checkinId,
      childId: stay.childId, childName: 'Mint', childAgeYears: 6, waivedRequirement: 'drop_off',
      siblingName: 'Pim', siblingAgeYears: 10, acceptedByAccountId: receptionAccount!.id,
    });
    // The sign-up photo's file record, owned by the registration.
    const photoId = newId();
    await ctx.db.insert(fileObject).values({
      id: photoId, operatorId, bucket: 'oto-files-test', objectKey: `registration/${stay.registrationId}/photo.jpg`,
      contentType: 'image/jpeg', ownerEntityType: 'registration', ownerEntityId: stay.registrationId,
    });
    await ctx.db.update(registration).set({ photoFileId: photoId }).where(eq(registration.id, stay.registrationId));
    expect(await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityType, 'checkin'), eq(auditLog.entityId, stay.checkinId)))).not.toEqual([]);

    const policiesBefore = await ctx.db.select().from(supervisionPolicy);
    const pricingBefore = await ctx.db.select().from(dropOffPricing);
    const nanniesBefore = await ctx.db.select().from(nanny);
    expect(policiesBefore.length * pricingBefore.length * nanniesBefore.length).toBeGreaterThan(0);

    const reset = await post(admin, '/ops/demo-reset', { confirm: 'RESET DEMO DATA' });
    expect(reset.statusCode, reset.body).toBe(200);
    const { deleted } = reset.json() as { deleted: Record<string, number> };
    // Said table by table, as before: what was removed, and how many.
    expect(deleted).toMatchObject({ supervision_waiver: 1, release: 1, checkin: 1, guardian: 1, registration: 1 });
    expect(deleted.sale).toBeGreaterThanOrEqual(1);
    expect(deleted.band).toBeGreaterThanOrEqual(1);
    expect(deleted.member).toBeGreaterThanOrEqual(1);

    for (const table of [supervisionWaiver, release, checkin, guardian, registration]) {
      expect(await ctx.db.select().from(table)).toEqual([]);
    }
    expect(await ctx.db.select().from(member).where(eq(member.id, stay.memberId))).toEqual([]);
    expect(await ctx.db.select().from(child).where(eq(child.id, stay.childId))).toEqual([]);
    expect(
      await ctx.db
        .select()
        .from(auditLog)
        .where(inArray(auditLog.entityType, ['checkin', 'registration', 'guardian', 'release', 'supervision_waiver'])),
    ).toEqual([]);
    // Configuration stays exactly as it was, and so does the photo's file record.
    expect(await ctx.db.select().from(supervisionPolicy)).toEqual(policiesBefore);
    expect(await ctx.db.select().from(dropOffPricing)).toEqual(pricingBefore);
    expect(await ctx.db.select().from(nanny)).toEqual(nanniesBefore);
    expect(await ctx.db.select({ id: fileObject.id }).from(fileObject).where(eq(fileObject.id, photoId))).toHaveLength(1);
    // The seeded families come back untouched.
    expect(await ctx.db.select({ id: member.id }).from(member).where(eq(member.createdVia, 'import'))).not.toEqual([]);
  });
});
