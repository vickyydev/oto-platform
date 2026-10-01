import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  band,
  branch,
  checkin,
  child,
  fileObject,
  member,
  nanny,
  printJob,
  registration,
  sale,
  station,
  supervisionWaiver,
  ticketPackage,
} from '@oto/db';
import {
  DEFAULT_SUPERVISION_POLICY,
  newId,
  resolveGroupRequirements,
  resolveSupervisionOutcome,
  salePrintDocumentOf,
} from '@oto/shared';
import { configureBandKey, currentBandKey } from '../src/services/bands';
import { salePrintSnapshotOf } from '../src/services/sale-printing';
import {
  ADMIN,
  CHALONG_MANAGER,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-13 round 1 — the supervision gate online (plan
 * docs/progress/plans/checkin/PLAN.md §2.1-2.2), driven through the routes
 * the till calls where the prototype called `registerWalkInChildren`,
 * `recordSupervisionWaiver`, `checkInFamilyWithPayment` and
 * `markCheckInsBooked`.
 */

let ctx: TestContext;
let reception: string;
let chalongManager: string;
let branchId: string;
let operatorId: string;
let stationId: string;
let twoHoursId: string;
let maliId: string;
let maliChild: { id: string; name: string; allergies: string | null };

const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
  twoHoursId = pkg!.id;
  const [mali] = await ctx.db.select().from(member).where(eq(member.phone, '+66811111111'));
  maliId = mali!.id;
  const kids = await ctx.db
    .select({ id: child.id, name: child.name, allergies: child.allergies })
    .from(child)
    .where(eq(child.memberId, maliId));
  maliChild = kids.find((k) => !!k.allergies) ?? kids[0]!;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- Helpers --------------------------------------------------------------------

function childBody(over: Record<string, unknown> = {}) {
  return {
    checkinId: newId(),
    name: 'Mint',
    ageYears: 6,
    service: 'drop_off',
    allergies: 'Peanuts',
    foodRestrictions: null,
    foodProvision: { mode: 'none', paidSatang: 0 },
    ...over,
  };
}

function registrationBody(children: Record<string, unknown>[], over: Record<string, unknown> = {}) {
  return {
    id: newId(),
    branchId,
    stationId,
    guardianName: 'Ploy',
    guardianPhone: '0812345678',
    contactChannel: 'whatsapp',
    consentAcknowledged: true,
    acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
    children,
    ...over,
  };
}

async function register(children: Record<string, unknown>[], over: Record<string, unknown> = {}) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/registrations',
    headers: { cookie: reception },
    payload: registrationBody(children, over),
  });
  return res;
}

/** A finalised ticket sale carrying each named stay on its own drop-off line. */
async function paidSaleFor(
  stays: { checkinId: string; feeSatang: number; label?: string }[],
  extra: { adults?: number } = {},
): Promise<string> {
  const saleId = newId();
  const lines = stays.map((s) => ({
    id: s.checkinId,
    packageId: twoHoursId,
    kids: 1,
    adults: 0,
    serviceFee: s.feeSatang > 0 ? { label: s.label ?? 'Drop-off service', amountSatang: s.feeSatang } : null,
  }));
  if (extra.adults) lines.push({ id: newId(), packageId: twoHoursId, kids: 0, adults: extra.adults, serviceFee: null });
  const commit = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: { id: saleId, stationId, lines },
  });
  expect(commit.statusCode, commit.body).toBe(200);
  const fin = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    headers: { cookie: reception },
    payload: {},
  });
  expect(fin.statusCode, fin.body).toBe(200);
  return saleId;
}

async function checkInNow(saleId: string, entries: { checkinId: string; nannyId?: string | null }[], cookie = reception, headers: Record<string, string> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: '/checkin/check-in-now',
    headers: { cookie, ...headers },
    payload: { saleId, entries },
  });
}

async function stay(id: string) {
  const [row] = await ctx.db.select().from(checkin).where(eq(checkin.id, id));
  return row!;
}

async function auditOf(entityType: string, entityId: string) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, entityType), eq(auditLog.entityId, entityId)));
}

async function bandDocument(saleId: string, bandId: string) {
  const [saleRow] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
  const snapshot = await salePrintSnapshotOf(ctx.db, saleRow!);
  const doc = salePrintDocumentOf(snapshot, { kind: 'kids_wristband', subjectType: 'band', subjectId: bandId }, false);
  return doc!.data as Record<string, unknown>;
}

// --- Config ------------------------------------------------------------------------

describe('GET /checkin/config', () => {
  it("answers the prototype's seeded policy, pricing and roster", async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/checkin/config?branchId=${branchId}`,
      headers: { cookie: reception },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.policy.bands.map((b: { minAge: number; maxAge: number | null; requirement: string }) => [b.minAge, b.maxAge, b.requirement])).toEqual([
      [0, 4, 'nanny'],
      [5, 8, 'drop_off'],
      [9, null, 'none'],
    ]);
    expect(body.policy.confirmations.map((c: { id: string }) => c.id)).toEqual(ALL_CONFIRMATIONS);
    expect(body.policy.siblingWaiver).toMatchObject({ enabled: true, guardianMinAge: 9, waivableRequirement: 'drop_off', staffOnly: true });
    expect(body.pricing.oneTimeFee).toEqual({ weekday: 22_500, weekend: 22_500 });
    expect(body.pricing.nannyHourly).toEqual({ weekday: 33_000, weekend: 33_000 });
    expect(body.pricing.extraHour).toEqual({ weekday: 30_000, weekend: 30_000 });
    expect(body.pricing.prepaidFoodUnused).toBe('refund');
    expect(body.nannies.map((n: { name: string }) => n.name).sort()).toEqual(['Aor', 'Bow', 'Jum', 'Pim']);
  });

  it('refuses a caller with no access at that park', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/checkin/config?branchId=${branchId}`,
      headers: { cookie: chalongManager },
    });
    expect(res.statusCode).toBe(403);
  });
});

// --- Registration ------------------------------------------------------------------

describe('POST /checkin/registrations', () => {
  it('registers a walk-in family once, with its consent, and a retry finds the same registration', async () => {
    const body = registrationBody([childBody()]);
    const first = await ctx.app.inject({ method: 'POST', url: '/checkin/registrations', headers: { cookie: reception }, payload: body });
    expect(first.statusCode, first.body).toBe(200);
    const reg = first.json();
    expect(reg.guardianPhone).toBe('+66812345678');
    expect(reg.consentRecordedAt).not.toBeNull();
    expect(reg.acknowledgedConfirmations.map((c: { itemId: string }) => c.itemId)).toEqual(ALL_CONFIRMATIONS);
    expect(reg.children).toHaveLength(1);
    expect(reg.children[0]).toMatchObject({ status: 'registered', service: 'drop_off', allergies: 'Peanuts' });

    const again = await ctx.app.inject({ method: 'POST', url: '/checkin/registrations', headers: { cookie: reception }, payload: body });
    expect(again.statusCode).toBe(200);
    expect(again.headers['x-oto-replay']).toBe('true');
    const rows = await ctx.db.select().from(registration).where(eq(registration.id, body.id));
    expect(rows).toHaveLength(1);
    expect(await ctx.db.select().from(checkin).where(eq(checkin.registrationId, body.id))).toHaveLength(1);
    expect((await auditOf('registration', body.id)).map((a) => a.action)).toContain('registration.create');
    expect((await auditOf('checkin', reg.children[0].id)).map((a) => a.action)).toContain('checkin.create');
  });

  it('refuses without consent, and without every confirmation', async () => {
    const noConsent = await register([childBody()], { consentAcknowledged: false });
    expect(noConsent.statusCode).toBe(409);
    expect(noConsent.json().error.code).toBe('CONSENT_REQUIRED');
    const missing = await register([childBody()], { acknowledgedConfirmationIds: ['confirm-15min'] });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error.code).toBe('CONFIRMATIONS_REQUIRED');
  });

  it('resolves the service again from the age and refuses a gate that disagrees', async () => {
    const res = await register([childBody({ ageYears: 3, service: 'drop_off' })]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SERVICE_MISMATCH');
    expect(res.json().error.message).toContain('needs a nanny');
    const waivedDown = await register([childBody({ ageYears: 6, service: 'none' })]);
    expect(waivedDown.statusCode).toBe(409);
    expect(waivedDown.json().error.message).toContain('sibling waiver');
  });

  it('lets a child with no requirement opt in at no fee (the safety flow without the fee)', async () => {
    const res = await register([childBody({ ageYears: 10, service: 'none' })]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().children[0].service).toBe('none');
  });

  it("refuses a saved child that is not on the guardian's list", async () => {
    const res = await register([childBody({ childId: maliChild.id })], { memberId: null });
    expect(res.statusCode).toBe(400);
  });

  it('normalises a prepaid mode that paid nothing to none', async () => {
    const res = await register([childBody({ foodProvision: { mode: 'prepaid_credit', paidSatang: 0 } })]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().children[0]).toMatchObject({ mayOrderFood: false, foodProvision: { mode: 'none', paidSatang: 0 } });
  });
});

describe('POST /checkin/registrations/:id/children (add a sibling)', () => {
  it('adds a sibling to a waiting registration and refuses a mismatched service', async () => {
    const reg = (await register([childBody()])).json();
    const ok = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/registrations/${reg.id}/children`,
      headers: { cookie: reception },
      payload: { children: [childBody({ name: 'Mew', ageYears: 4, service: 'nanny' })] },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().children.map((c: { childName: string }) => c.childName).sort()).toEqual(['Mew', 'Mint']);
    const bad = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/registrations/${reg.id}/children`,
      headers: { cookie: reception },
      payload: { children: [childBody({ name: 'Nam', ageYears: 4, service: 'drop_off' })] },
    });
    expect(bad.statusCode).toBe(409);

    const waiting = await ctx.app.inject({ method: 'GET', url: `/checkin/registrations?branchId=${branchId}`, headers: { cookie: reception } });
    expect(waiting.statusCode).toBe(200);
    expect(waiting.json().registrations.some((r: { id: string }) => r.id === reg.id)).toBe(true);
  });
});

// --- The acceptance scenario, verbatim ------------------------------------------------

describe('acceptance: 0 adults + a 6-year-old, and a 9-year-old sibling', () => {
  it('gates and resolves drop_off; offers but never auto-applies the waiver; accepting audits with the sibling name', async () => {
    // The gate: a cart of kids and no adults resolves the six-year-old to drop-off.
    const policy = DEFAULT_SUPERVISION_POLICY;
    const alone = resolveGroupRequirements([{ id: 'six', age: 6 }], policy);
    expect(alone[0]).toMatchObject({ requirement: 'drop_off', waiverEligible: false });
    expect(resolveSupervisionOutcome('drop_off', false, true)).toMatchObject({ service: 'drop_off', needsConsent: true });

    // A nine-year-old sibling makes the waiver OFFERED — and nothing more.
    const both = resolveGroupRequirements([{ id: 'six', age: 6 }, { id: 'nine', age: 9 }], policy);
    expect(both.find((r) => r.id === 'six')).toMatchObject({ requirement: 'drop_off', waiverEligible: true });
    expect(resolveSupervisionOutcome('drop_off', false, true).service).toBe('drop_off');

    // Without a staff press the platform registers the six-year-old for drop-off …
    const reg = await register([childBody({ name: 'Six', ageYears: 6 })]);
    expect(reg.statusCode, reg.body).toBe(200);
    expect(reg.json().children[0].service).toBe('drop_off');
    expect(await ctx.db.select().from(supervisionWaiver).where(eq(supervisionWaiver.childName, 'Six'))).toHaveLength(0);

    // … and accepting the waiver is a staff act, audited with the sibling's name.
    const waiverId = newId();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/waivers',
      headers: { cookie: reception },
      payload: {
        id: waiverId,
        branchId,
        stationId,
        child: { name: 'Six', ageYears: 6 },
        sibling: { name: 'Nine', ageYears: 9 },
        waivedRequirement: 'drop_off',
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ siblingName: 'Nine', childName: 'Six', waivedRequirement: 'drop_off' });
    const rows = await auditOf('supervision_waiver', waiverId);
    expect(rows.map((r) => r.action)).toEqual(['supervision_waiver.create']);
    expect(rows[0]!.after).toMatchObject({ siblingName: 'Nine', siblingAgeYears: 9, childName: 'Six' });
  });
});

describe('POST /checkin/waivers', () => {
  const waiver = (over: Record<string, unknown>) => ({
    branchId,
    child: { name: 'Kid', ageYears: 6 },
    sibling: { name: 'Big', ageYears: 9 },
    waivedRequirement: 'drop_off',
    ...over,
  });

  it('refuses a sibling under nine', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/checkin/waivers', headers: { cookie: reception }, payload: waiver({ sibling: { name: 'Big', ageYears: 8 } }) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'WAIVER_REFUSED', message: 'The sibling must be at least 9 to cover a younger child.' });
  });

  it('refuses after an age edit took the child out of the waivable band', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/checkin/waivers', headers: { cookie: reception }, payload: waiver({ child: { name: 'Kid', ageYears: 3 } }) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('check the age');
  });

  it('refuses a nanny waiver — only drop-off may be waived', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/checkin/waivers', headers: { cookie: reception }, payload: waiver({ child: { name: 'Kid', ageYears: 3 }, waivedRequirement: 'nanny' }) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('cannot be waived');
  });

  it('is staff-only: no session is 401, staff without access at the park is 403', async () => {
    const anon = await ctx.app.inject({ method: 'POST', url: '/checkin/waivers', payload: waiver({}) });
    expect(anon.statusCode).toBe(401);
    const other = await ctx.app.inject({ method: 'POST', url: '/checkin/waivers', headers: { cookie: chalongManager }, payload: waiver({}) });
    expect(other.statusCode).toBe(403);
  });
});

// --- After payment -------------------------------------------------------------------

describe('POST /checkin/check-in-now', () => {
  it('consent + payment make ONE registration; check-in puts the child in the park with a badged band', async () => {
    const reg = (await register([childBody({ name: 'Dao', ageYears: 6 })])).json();
    const stayId = reg.children[0].id as string;
    const saleId = await paidSaleFor([{ checkinId: stayId, feeSatang: 22_500 }], { adults: 0 });

    // Finalisation left the supervised child's band for the check-in choice.
    expect(await ctx.db.select().from(band).where(eq(band.saleId, saleId))).toHaveLength(0);

    const res = await checkInNow(saleId, [{ checkinId: stayId }]);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.children[0]).toMatchObject({ status: 'in_park', saleId, bookedMinutes: 120 });
    expect(body.bands).toHaveLength(1);

    const row = await stay(stayId);
    expect(row.bandId).toBe(body.bands[0].id);
    expect(row.checkedInAt).not.toBeNull();
    expect(await ctx.db.select().from(registration).where(eq(registration.guardianName, 'Ploy')).then((r) => r.filter((x) => x.id === reg.id))).toHaveLength(1);
    expect(await ctx.db.select().from(checkin).where(eq(checkin.registrationId, reg.id))).toHaveLength(1);

    const jobs = await ctx.db.select().from(printJob).where(and(eq(printJob.subjectType, 'band'), eq(printJob.subjectId, row.bandId!)));
    expect(jobs.map((j) => j.kind)).toEqual(['kids_wristband']);

    const doc = await bandDocument(saleId, row.bandId!);
    expect(doc).toMatchObject({ holderName: 'Dao', supervisionMode: 'DROP-OFF', allergy: 'Peanuts' });
    expect(doc.assignedNannyName).toBeUndefined();

    const audits = await auditOf('checkin', stayId);
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['checkin.create', 'checkin.update']));

    // A second press (a retry whose answer was lost) answers with what the first did: one band, never two.
    const again = await checkInNow(saleId, [{ checkinId: stayId }]);
    expect(again.statusCode).toBe(200);
    expect(again.json().bands[0].id).toBe(body.bands[0].id);
    expect(await ctx.db.select().from(band).where(eq(band.saleId, saleId))).toHaveLength(1);
  });

  it("a nanny child needs a nanny, and her band carries NANNY and the nanny's name", async () => {
    const reg = (await register([childBody({ name: 'Kai', ageYears: 3, service: 'nanny' })])).json();
    const stayId = reg.children[0].id as string;
    const saleId = await paidSaleFor([{ checkinId: stayId, feeSatang: 66_000, label: 'Nanny (2h)' }]);
    const missing = await checkInNow(saleId, [{ checkinId: stayId }]);
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error).toMatchObject({ code: 'NANNY_REQUIRED', message: 'Assign a nanny to Kai before checking them in.' });

    const [pim] = await ctx.db.select().from(nanny).where(and(eq(nanny.branchId, branchId), eq(nanny.name, 'Pim')));
    const res = await checkInNow(saleId, [{ checkinId: stayId, nannyId: pim!.id }]);
    expect(res.statusCode, res.body).toBe(200);
    const row = await stay(stayId);
    expect(row.nannyId).toBe(pim!.id);
    const doc = await bandDocument(saleId, row.bandId!);
    expect(doc).toMatchObject({ supervisionMode: 'NANNY', assignedNannyName: 'Pim', holderName: 'Kai' });
  });

  it("a saved child's band is named for the child and keeps the allergy line", async () => {
    const reg = (
      await register([childBody({ childId: maliChild.id, name: maliChild.name, ageYears: 6, allergies: maliChild.allergies })], { memberId: maliId })
    ).json();
    const stayId = reg.children[0].id as string;
    const saleId = await paidSaleFor([{ checkinId: stayId, feeSatang: 22_500 }]);
    const res = await checkInNow(saleId, [{ checkinId: stayId }]);
    expect(res.statusCode, res.body).toBe(200);
    const [b] = await ctx.db.select().from(band).where(eq(band.id, res.json().bands[0].id));
    expect(b!.childId).toBe(maliChild.id);
    const doc = await bandDocument(saleId, b!.id);
    expect(doc.holderName).toBe(maliChild.name);
    if (maliChild.allergies) expect(String(doc.allergy)).toContain(maliChild.allergies);
  });

  it('is atomic: a band that cannot be minted takes the whole check-in back', async () => {
    const reg = (await register([childBody({ name: 'Fah', ageYears: 7 })])).json();
    const stayId = reg.children[0].id as string;
    const saleId = await paidSaleFor([{ checkinId: stayId, feeSatang: 22_500 }]);
    const key = currentBandKey();
    configureBandKey(null);
    try {
      const res = await checkInNow(saleId, [{ checkinId: stayId }]);
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('BAND_KEY_MISSING');
    } finally {
      configureBandKey(key);
    }
    const row = await stay(stayId);
    expect(row).toMatchObject({ status: 'registered', saleId: null, bandId: null, checkedInAt: null });
    expect(await ctx.db.select().from(band).where(eq(band.saleId, saleId))).toHaveLength(0);
    const updates = (await auditOf('checkin', stayId)).filter((a) => a.action === 'checkin.update');
    expect(updates).toHaveLength(0);
  });

  it('refuses a child who is not on the sale, and a sale that is not paid', async () => {
    const reg = (await register([childBody({ name: 'Nok', ageYears: 6 })])).json();
    const stayId = reg.children[0].id as string;
    const otherSale = await paidSaleFor([{ checkinId: newId(), feeSatang: 0 }]);
    const notOn = await checkInNow(otherSale, [{ checkinId: stayId }]);
    expect(notOn.statusCode).toBe(409);
    expect(notOn.json().error.code).toBe('CHECKIN_NOT_ON_SALE');

    const openSale = newId();
    const commit = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: reception },
      payload: { id: openSale, stationId, lines: [{ id: stayId, packageId: twoHoursId, kids: 1, adults: 0 }] },
    });
    expect(commit.statusCode, commit.body).toBe(200);
    const unpaid = await checkInNow(openSale, [{ checkinId: stayId }]);
    expect(unpaid.statusCode).toBe(409);
    expect(unpaid.json().error.code).toBe('SALE_NOT_FINALISED');
  });

  it('refuses staff without access at the park', async () => {
    const reg = (await register([childBody({ name: 'Ice', ageYears: 6 })])).json();
    const saleId = await paidSaleFor([{ checkinId: reg.children[0].id, feeSatang: 22_500 }]);
    const res = await checkInNow(saleId, [{ checkinId: reg.children[0].id }], chalongManager);
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /checkin/leave-as-booked', () => {
  it('keeps the children registered with the booked start and length, and issues no band', async () => {
    const reg = (await register([childBody({ name: 'Pan', ageYears: 5 })])).json();
    const stayId = reg.children[0].id as string;
    const saleId = await paidSaleFor([{ checkinId: stayId, feeSatang: 22_500 }]);
    const scheduledFor = new Date().toISOString();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/leave-as-booked',
      headers: { cookie: reception },
      payload: { saleId, scheduledFor, entries: [{ checkinId: stayId }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = await stay(stayId);
    expect(row).toMatchObject({ status: 'registered', saleId, bandId: null, bookedMinutes: 120, checkedInAt: null });
    expect(row.scheduledFor?.toISOString()).toBe(scheduledFor);
    expect(await ctx.db.select().from(band).where(eq(band.saleId, saleId))).toHaveLength(0);
    expect((await auditOf('checkin', stayId)).some((a) => a.action === 'checkin.update')).toBe(true);
  });

  it('refuses a sale that is not this operator’s or does not exist', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/leave-as-booked',
      headers: { cookie: reception },
      payload: { saleId: newId(), entries: [{ checkinId: newId() }] },
    });
    expect(res.statusCode).toBe(404);
  });
});

// --- The photo ----------------------------------------------------------------------

describe('the consent photo', () => {
  it('attaches an uploaded photo to the registration and its children, and refuses a foreign file', async () => {
    const reg = (await register([childBody({ name: 'Bee', ageYears: 6 })])).json();
    const fileId = newId();
    await ctx.db.insert(fileObject).values({
      id: fileId,
      operatorId,
      bucket: 'test',
      objectKey: `${operatorId}/registration/${reg.id}/${fileId}.jpg`,
      contentType: 'image/jpeg',
      ownerEntityType: 'registration',
      ownerEntityId: reg.id,
    });
    const ok = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/registrations/${reg.id}/photo`,
      headers: { cookie: reception },
      payload: { fileId, checkinIds: [reg.children[0].id] },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().photoFileId).toBe(fileId);
    expect(ok.json().children[0].photoFileId).toBe(fileId);

    const other = (await register([childBody({ name: 'Bow', ageYears: 6 })])).json();
    const foreign = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/registrations/${other.id}/photo`,
      headers: { cookie: reception },
      payload: { fileId, checkinIds: [] },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('registers an upload against a registration only inside the operator (storage absent → 503 after the owner checks)', async () => {
    const reg = (await register([childBody({ name: 'Ann', ageYears: 6 })])).json();
    const own = await ctx.app.inject({
      method: 'POST',
      url: '/files',
      headers: { cookie: reception },
      payload: { contentType: 'image/jpeg', ownerEntityType: 'registration', ownerEntityId: reg.id, filename: 'p.jpg' },
    });
    expect(own.statusCode).toBe(503);
    const missing = await ctx.app.inject({
      method: 'POST',
      url: '/files',
      headers: { cookie: reception },
      payload: { contentType: 'image/jpeg', ownerEntityType: 'registration', ownerEntityId: newId(), filename: 'p.jpg' },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('GET /checkin/registrations/:id', () => {
  it('reads one registration, and is 404 for an id that is nobody’s', async () => {
    const reg = (await register([childBody({ name: 'Joy', ageYears: 6 })])).json();
    const ok = await ctx.app.inject({ method: 'GET', url: `/checkin/registrations/${reg.id}`, headers: { cookie: reception } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().children[0].childName).toBe('Joy');
    const admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const missing = await ctx.app.inject({ method: 'GET', url: `/checkin/registrations/${newId()}`, headers: { cookie: admin } });
    expect(missing.statusCode).toBe(404);
  });
});
