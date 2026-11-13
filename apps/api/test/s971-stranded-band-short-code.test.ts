import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { schema } from '@oto/db';
import {
  bandShortCode,
  businessDate,
  mintBandCode,
  newId,
  ulidFromUuid,
  type EndOfDayRecord,
  type StrandedResolveAnswer,
} from '@oto/shared';
import {
  CENTRAL_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-971 (point 5 of SCRUM-969) — END OF DAY NAMES A STRANDED BAND BY ITS
 * SHORT CODE.
 *
 * The row for somebody still counted inside at close carried the band's
 * stored code, which is the signed gate credential (`T1.<ulid>.<signature>`):
 * a long string staff do not know, on a screen and on the closed day's
 * record. It now carries the short code printed under the band's QR and on
 * the receipt — `T1-7KMQ4X`, the one History and the door check-in name a
 * band by (`bandShortCode`) — for an adult band still inside and for a child
 * checked in with a band. The field keeps its name, `bandCode`.
 *
 * A file of its own: the End of Day tests that pin the refusal sentence
 * belong to another lane.
 */

const TZ = 'Asia/Bangkok';
const DAY_START = 5 * 60;
const D = businessDate(new Date(), TZ, DAY_START);
/** Any key will do: the short code is read from the code, never checked against its signature here. */
const KEY = 'zz-test-scrum-971-band-key-0123456789';

let ctx: TestContext;
let operatorId: string;
let central: string;
let till1: { id: string; boxId: string };
let gateStation: string;
let receptionId: string;
let receptionCookie: string;

const minted = (prefix: string) => {
  const id = newId();
  return { id, code: mintBandCode(prefix, ulidFromUuid(id), KEY) };
};

const getDay = async () => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/branches/${central}/end-of-day?date=${D}`,
    headers: { cookie: receptionCookie },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as EndOfDayRecord;
};

beforeAll(async () => {
  ctx = await createTestContext();
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  const [t1] = await ctx.db
    .select()
    .from(schema.station)
    .where(and(eq(schema.station.branchId, central), eq(schema.station.codePrefix, 'T1')))
    .limit(1);
  till1 = { id: t1!.id, boxId: t1!.boxId! };
  gateStation = newId();
  await ctx.db.insert(schema.station).values({
    id: gateStation,
    operatorId,
    branchId: central,
    boxId: till1.boxId,
    name: 'ZZ TEST SCRUM-971 lane',
    kind: 'gate',
  });
  const [reception] = await ctx.db
    .select({ id: schema.account.id })
    .from(schema.account)
    .where(and(eq(schema.account.operatorId, operatorId), eq(schema.account.phone, RECEPTION.phone)))
    .limit(1);
  receptionId = reception!.id;
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  await takeStation(ctx.app, receptionCookie, till1.id);
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('SCRUM-971 — a stranded band is named by its short code, never its credential', () => {
  const entered = new Date(Date.now() - 60_000);
  const adult = minted('T1');
  const kid = minted('T1');
  let checkinId: string;

  it('an adult band still inside and a child checked in with a band are listed by their short codes', async () => {
    const saleId = newId();
    await ctx.db.insert(schema.sale).values({
      id: saleId,
      operatorId,
      branchId: central,
      stationId: till1.id,
      businessDate: D,
      businessDayStart: '05:00',
      timezone: TZ,
      occurredAt: entered,
      createdByAccountId: receptionId,
      pricingMode: 'weekday',
      pricingModeReason: 'Weekday pricing',
      customerTier: 'tourist',
      engineVersion: 's971-test',
      taxConfig: {},
      taxBreakdown: {},
      subtotalSatang: 0,
      netSatang: 0,
      grossSatang: 0,
      receiptSeries: 'ZZ971',
      receiptSeq: Math.floor(Math.random() * 1e9),
      receiptNumber: `ZZ971-${saleId.slice(-6)}`,
      status: 'finalised',
      finalisedAt: entered,
    });
    await ctx.db.insert(schema.band).values([
      { id: adult.id, operatorId, branchId: central, saleId, kind: 'adult', gateAccess: true, code: adult.code },
      { id: kid.id, operatorId, branchId: central, saleId, kind: 'kid', gateAccess: false, code: kid.code },
    ]);
    await ctx.db
      .insert(schema.bandEvent)
      .values({ id: newId(), bandId: adult.id, kind: 'entry', stationId: gateStation, detail: {}, createdAt: entered });
    const registrationId = newId();
    await ctx.db.insert(schema.registration).values({
      id: registrationId,
      operatorId,
      branchId: central,
      guardianName: 'ZZ TEST Khun Malee',
      guardianPhone: '+66811112971',
      acknowledgedConfirmations: [],
    });
    checkinId = newId();
    await ctx.db.insert(schema.checkin).values({
      id: checkinId,
      operatorId,
      branchId: central,
      registrationId,
      childName: 'ZZ TEST Ploy',
      childAgeYears: 6,
      service: 'drop_off',
      status: 'in_park',
      checkedInAt: entered,
      saleId,
      bandId: kid.id,
    });

    const rec = await getDay();
    const bandRow = rec.stranded!.find((r) => r.subjectId === adult.id)!;
    const childRow = rec.stranded!.find((r) => r.subjectId === checkinId)!;
    expect(bandRow).toMatchObject({ kind: 'band', bandCode: bandShortCode(adult.code) });
    expect(childRow).toMatchObject({ kind: 'checkin', bandCode: bandShortCode(kid.code) });
    // The short line printed under the QR: the prefix, a dash, six characters.
    expect(bandRow.bandCode).toMatch(/^T1-[0-9A-Z]{6}$/);
    expect(childRow.bandCode).toMatch(/^T1-[0-9A-Z]{6}$/);
    // Never the credential, nor any piece of its signature.
    const body = JSON.stringify(rec.stranded);
    for (const code of [adult.code, kid.code]) {
      expect(body.includes(code)).toBe(false);
      expect(body.includes(code.slice(code.lastIndexOf('.') + 1))).toBe(false);
    }
  });

  it('resolving the band answers and audits the short code too, never the credential', async () => {
    const actionId = newId();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${central}/end-of-day/stranded/resolve`,
      headers: { cookie: receptionCookie, 'idempotency-key': newId() },
      payload: { date: D, kind: 'band', subjectId: adult.id, reason: 'band_lost', actionId },
    });
    expect(res.statusCode, res.body).toBe(200);
    const answer = res.json() as StrandedResolveAnswer;
    expect(answer.stranded.find((r) => r.subjectId === checkinId)).toMatchObject({ bandCode: bandShortCode(kid.code) });
    expect(res.body.includes(kid.code)).toBe(false);

    const rows = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'gate.manual_resolution'), eq(schema.auditLog.entityId, answer.resolutionId)));
    expect(rows.length).toBe(1);
    const audited = JSON.stringify([rows[0]!.before, rows[0]!.after]);
    expect(audited.includes(bandShortCode(adult.code)!)).toBe(true);
    expect(audited.includes(adult.code)).toBe(false);
  });
});
