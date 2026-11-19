import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, child, station } from '@oto/db';
import { displayCareRefusal } from '../src/services/members';
import {
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  createTestContext,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-1020 — A SAVED CHILD'S CARE NOTES, CHANGED BY THE FAMILY ON THE
 * CUSTOMER DISPLAY (the owner's answer of 19 November).
 *
 * The parent sees a saved child's allergy and medical notes on the paired
 * display and may update them there. The till carries the change out under
 * its own session when it writes the drop-off form, as it carries a new child
 * the family named there (SCRUM-1014), and these tests pin what the platform
 * makes of it:
 *
 *   - audited: the row names the customer display and the till session's own
 *     station, with the record before and after;
 *   - guarded: signed in, at a till, within the operator, on the same
 *     permission as every child edit;
 *   - the right family only: it names the family identified at that till, and
 *     a child of any other family is a 404;
 *   - the care notes only, and an empty note never replaces one that had text
 *     without the family's plain "no allergies".
 */

let ctx: TestContext;
let cookie: string;
let tillCookie: string;
let tillId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  tillCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  tillId = (await ctx.db.select().from(station)).find((s) => s.name === 'Reception Till 1')!.id;
  await takeStation(ctx.app, tillCookie, tillId);
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/** A member with one child carrying an allergy, as the till creates them. */
async function familyOf(phone: string, nickname: string, childName: string) {
  const created = await ctx.app.inject({ method: 'POST', url: '/members', headers: { cookie }, payload: { phone, nickname } });
  expect(created.statusCode, created.body).toBe(200);
  const memberId = created.json().member.id as string;
  const kid = await ctx.app.inject({ method: 'POST', url: `/members/${memberId}/children`, headers: { cookie },
    payload: { name: childName, ageYears: 5, allergies: 'ZZ TEST peanuts' } });
  expect(kid.statusCode, kid.body).toBe(200);
  return { memberId, childId: kid.json().child.id as string };
}

const fromDisplay = (childId: string, payload: Record<string, unknown>, headers: Record<string, string> = { cookie: tillCookie }) =>
  ctx.app.inject({ method: 'PATCH', url: `/members/children/${childId}`, headers,
    payload: { source: 'customer_display', ...payload } });

const auditOf = (childId: string) =>
  ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'child.update'), eq(auditLog.entityId, childId)));
const rowOf = async (childId: string) => (await ctx.db.select().from(child).where(eq(child.id, childId)))[0]!;

describe('SCRUM-1020 — the family changes a saved child\'s care notes on the customer display', () => {
  it('is saved and audited as made on the customer display of this till, with before and after', async () => {
    const { memberId, childId } = await familyOf('0655552001', 'ZZ TEST Care One', 'ZZ TEST Nong Care');
    const res = await fromDisplay(childId, { memberId, allergies: 'ZZ TEST peanuts, eggs' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().child.allergies).toBe('ZZ TEST peanuts, eggs');
    expect((await rowOf(childId)).allergies).toBe('ZZ TEST peanuts, eggs');
    const rows = await auditOf(childId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.origin).toBe('customer_display');
    expect(rows[0]!.actorAccountId).toBeTruthy();
    expect(rows[0]!.before).toMatchObject({ allergies: 'ZZ TEST peanuts', memberId });
    expect(rows[0]!.after).toMatchObject({ allergies: 'ZZ TEST peanuts, eggs', medicalAlert: true,
      source: 'customer_display', stationId: tillId });
    expect(rows[0]!.after).not.toHaveProperty('confirmedNone');
  });

  it('empties a note only on the family\'s plain "no allergies", and records that they said so', async () => {
    const { memberId, childId } = await familyOf('0655552002', 'ZZ TEST Care Two', 'ZZ TEST Nong Clear');
    const unconfirmed = await fromDisplay(childId, { memberId, allergies: null });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error.code).toBe('CARE_NOTE_CLEAR_UNCONFIRMED');
    const blank = await fromDisplay(childId, { memberId, allergies: '   ' });
    expect(blank.statusCode).toBe(400);
    expect((await rowOf(childId)).allergies).toBe('ZZ TEST peanuts');
    expect(await auditOf(childId)).toHaveLength(0);

    const confirmed = await fromDisplay(childId, { memberId, allergies: null, confirmedNone: true });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const row = await rowOf(childId);
    expect(row.allergies).toBeNull();
    expect(row.medicalAlert).toBe(false);
    const [audited] = await auditOf(childId);
    expect(audited!.origin).toBe('customer_display');
    expect(audited!.before).toMatchObject({ allergies: 'ZZ TEST peanuts' });
    expect(audited!.after).toMatchObject({ allergies: null, confirmedNone: true, source: 'customer_display', stationId: tillId });
  });

  it('a note added where there was none needs no confirmation', async () => {
    const { memberId, childId } = await familyOf('0655552003', 'ZZ TEST Care Three', 'ZZ TEST Nong Notes');
    const res = await fromDisplay(childId, { memberId, medicalNotes: 'ZZ TEST inhaler in the bag' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await rowOf(childId)).medicalNotes).toBe('ZZ TEST inhaler in the bag');
  });

  it('the right family only: a child of another family is not found, and a change names the family', async () => {
    const mine = await familyOf('0655552004', 'ZZ TEST Care Four', 'ZZ TEST Nong Mine');
    const theirs = await familyOf('0655552005', 'ZZ TEST Care Five', 'ZZ TEST Nong Theirs');
    const crossed = await fromDisplay(theirs.childId, { memberId: mine.memberId, allergies: 'ZZ TEST changed' });
    expect(crossed.statusCode).toBe(404);
    const unnamed = await fromDisplay(theirs.childId, { allergies: 'ZZ TEST changed' });
    expect(unnamed.statusCode).toBe(400);
    expect((await rowOf(theirs.childId)).allergies).toBe('ZZ TEST peanuts');
    expect(await auditOf(theirs.childId)).toHaveLength(0);
  });

  it('the care notes only: the display changes nothing else of the record', async () => {
    const { memberId, childId } = await familyOf('0655552006', 'ZZ TEST Care Six', 'ZZ TEST Nong Name');
    for (const payload of [{ name: 'ZZ TEST Renamed' }, { allergies: 'ZZ TEST eggs', ageYears: 9 },
      { foodRestrictions: 'ZZ TEST halal' }, { medicalAlert: false }, {}]) {
      const res = await fromDisplay(childId, { memberId, ...payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const row = await rowOf(childId);
    expect(row.name).toBe('ZZ TEST Nong Name');
    expect(row.allergies).toBe('ZZ TEST peanuts');
    expect(await auditOf(childId)).toHaveLength(0);
  });

  it('guarded: signed in, standing at a till, within the operator', async () => {
    const { memberId, childId } = await familyOf('0655552007', 'ZZ TEST Care Seven', 'ZZ TEST Nong Guard');
    const anonymous = await fromDisplay(childId, { memberId, allergies: 'ZZ TEST eggs' }, {});
    expect(anonymous.statusCode).toBe(401);
    // A session at no till cannot claim the display (SCRUM-1014's rule).
    const noTill = await fromDisplay(childId, { memberId, allergies: 'ZZ TEST eggs' }, { cookie });
    expect(noTill.statusCode).toBe(400);
    const foreign = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
    const otherOperator = await fromDisplay(childId, { memberId, allergies: 'ZZ TEST eggs' }, { cookie: foreign });
    expect([400, 403, 404]).toContain(otherOperator.statusCode);
    expect((await rowOf(childId)).allergies).toBe('ZZ TEST peanuts');
    expect(await auditOf(childId)).toHaveLength(0);
  });

  it('staff edits are recorded exactly as before: no source, no origin, any field', async () => {
    const { childId } = await familyOf('0655552008', 'ZZ TEST Care Eight', 'ZZ TEST Nong Staff');
    const res = await ctx.app.inject({ method: 'PATCH', url: `/members/children/${childId}`, headers: { cookie: tillCookie },
      payload: { allergies: null, name: 'ZZ TEST Nong Staff Two' } });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await auditOf(childId);
    expect(row!.origin).toBeNull();
    expect(row!.after).not.toHaveProperty('source');
    expect(row!.after).toMatchObject({ allergies: null, name: 'ZZ TEST Nong Staff Two' });
  });
});

describe('SCRUM-1020 — the rule, read alone', () => {
  const before = { memberId: 'family-a', allergies: 'ZZ TEST peanuts', medicalNotes: null };
  it('answers each refusal in order: the family named, the family matched, care only, no silent clearing', () => {
    expect(displayCareRefusal({ before, memberId: undefined, fields: ['allergies'], patch: { allergies: 'x' }, confirmedNone: false })?.status).toBe(400);
    expect(displayCareRefusal({ before, memberId: 'family-b', fields: ['allergies'], patch: { allergies: 'x' }, confirmedNone: false })?.status).toBe(404);
    expect(displayCareRefusal({ before, memberId: 'family-a', fields: ['name'], patch: {}, confirmedNone: false })?.code).toBe('DISPLAY_CARE_ONLY');
    expect(displayCareRefusal({ before, memberId: 'family-a', fields: ['allergies'], patch: { allergies: '' }, confirmedNone: false })?.code)
      .toBe('CARE_NOTE_CLEAR_UNCONFIRMED');
    expect(displayCareRefusal({ before, memberId: 'family-a', fields: ['allergies'], patch: { allergies: '' }, confirmedNone: true })).toBeNull();
    // An empty medical note where there was none clears nothing.
    expect(displayCareRefusal({ before, memberId: 'family-a', fields: ['medicalNotes'], patch: { medicalNotes: null }, confirmedNone: false })).toBeNull();
    expect(displayCareRefusal({ before, memberId: 'family-a', fields: ['allergies'], patch: { allergies: 'ZZ TEST eggs' }, confirmedNone: false })).toBeNull();
  });
});
