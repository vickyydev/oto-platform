import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, child, member, visitChild } from '@oto/db';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-231 — the member and child details the screens could not show.
 *
 * The API has accepted all of this since Sprint 1: a member's full name, email
 * and staff notes, and a child's date of birth, medical notes, medical alert,
 * dietary needs, food restrictions and notes. The POS sent one field of it, so
 * a child could carry "No pork" and a medical alert on staging with nowhere to
 * read or correct either — which is worse than not holding it at all.
 *
 * These tests pin the API half of that contract, so the forms being wired to
 * it have something that cannot quietly stop accepting a field: every field
 * saves, comes back on the read the till and the admin screens actually make,
 * and lands in the audit row with what it was before.
 *
 * SCRUM-321 is here too, because it is the same question asked the other way:
 * what a PATCH that does NOT name a field must leave alone.
 */

let ctx: TestContext;
/** Reception holds `pos:member:update` and `pos:child:update` — the counter. */
let cookie: string;

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/** A member with one child, created the way the till creates them. */
async function familyOf(phone: string, nickname: string, childName: string) {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/members',
    headers: { cookie },
    payload: { phone, nickname },
  });
  expect(created.statusCode).toBe(200);
  const memberId = created.json().member.id as string;
  const kid = await ctx.app.inject({
    method: 'POST',
    url: `/members/${memberId}/children`,
    headers: { cookie },
    payload: { name: childName },
  });
  expect(kid.statusCode).toBe(200);
  return { memberId, childId: kid.json().child.id as string };
}

const readMember = async (id: string) => {
  const res = await ctx.app.inject({ method: 'GET', url: `/members/${id}`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json().member;
};

describe('SCRUM-231 — every child field saves and reads back', () => {
  let memberId: string;
  let childId: string;

  beforeAll(async () => {
    ({ memberId, childId } = await familyOf('0655550001', 'Fields Test', 'Nong Fields'));
  });

  it('saves the food restrictions and the medical alert, and hands both back', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/members/children/${childId}`,
      headers: { cookie },
      payload: { foodRestrictions: 'No pork', medicalAlert: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().child.foodRestrictions).toBe('No pork');
    expect(res.json().child.medicalAlert).toBe(true);

    // The read the screens make, not the row the write returned.
    const kid = (await readMember(memberId)).children.find(
      (c: { id: string }) => c.id === childId,
    );
    expect(kid.foodRestrictions).toBe('No pork');
    expect(kid.medicalAlert).toBe(true);
  });

  it('carries that edit before and after in the audit row', async () => {
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'child.update'), eq(auditLog.entityId, childId)));
    expect(rows).toHaveLength(1);
    const before = rows[0]!.before as { foodRestrictions: string | null; medicalAlert: boolean };
    const after = rows[0]!.after as { foodRestrictions: string | null; medicalAlert: boolean };
    expect(before.foodRestrictions).toBeNull();
    expect(before.medicalAlert).toBe(false);
    expect(after.foodRestrictions).toBe('No pork');
    expect(after.medicalAlert).toBe(true);
    expect(rows[0]!.actorAccountId).toBeTruthy();
  });

  it('saves the rest of what a first-aider and a kitchen need', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/members/children/${childId}`,
      headers: { cookie },
      payload: {
        dateOfBirth: '2019-04-02',
        allergies: 'Peanuts',
        medicalNotes: 'Inhaler in the blue bag',
        dietary: 'Vegetarian',
        notes: 'Shy with new staff',
      },
    });
    expect(res.statusCode).toBe(200);
    const kid = (await readMember(memberId)).children.find(
      (c: { id: string }) => c.id === childId,
    );
    expect(kid.dateOfBirth).toBe('2019-04-02');
    expect(kid.allergies).toBe('Peanuts');
    expect(kid.medicalNotes).toBe('Inhaler in the blue bag');
    expect(kid.dietary).toBe('Vegetarian');
    expect(kid.notes).toBe('Shy with new staff');
    // Untouched by a patch that did not name it.
    expect(kid.foodRestrictions).toBe('No pork');
  });

  /**
   * The rule the two child editors have to send under: typing an allergy
   * raises the medical alert by itself (that is what the counter wants when
   * nobody touched the switch), but an explicit switch wins over the guess.
   * Without this pinned, an editor that sends the allergy alone would flip an
   * alert a staff member had deliberately turned off.
   */
  it('derives the alert from a typed allergy, and lets an explicit switch win', async () => {
    const derived = await ctx.app.inject({
      method: 'PATCH',
      url: `/members/children/${childId}`,
      headers: { cookie },
      payload: { allergies: 'Peanuts, shellfish' },
    });
    expect(derived.json().child.medicalAlert).toBe(true);

    const explicit = await ctx.app.inject({
      method: 'PATCH',
      url: `/members/children/${childId}`,
      headers: { cookie },
      payload: { allergies: 'Peanuts, shellfish', medicalAlert: false },
    });
    expect(explicit.json().child.medicalAlert).toBe(false);
    expect(explicit.json().child.allergies).toBe('Peanuts, shellfish');
  });
});

describe('SCRUM-231 — the member fields the form did not offer', () => {
  it('saves a full name, an email and staff notes', async () => {
    const { memberId } = await familyOf('0655550002', 'Notes Test', 'Nong Notes');
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/members/${memberId}`,
      headers: { cookie },
      payload: {
        name: 'Somchai Jaidee',
        email: 'somchai@example.com',
        notes: 'Prefers the quiet corner; pays cash',
      },
    });
    expect(res.statusCode).toBe(200);
    const m = await readMember(memberId);
    expect(m.name).toBe('Somchai Jaidee');
    expect(m.email).toBe('somchai@example.com');
    expect(m.notes).toBe('Prefers the quiet corner; pays cash');
    // The nickname the till shows is untouched by a patch that did not name it.
    expect(m.nickname).toBe('Notes Test');
  });
});

describe('SCRUM-231 — a confirm at the counter still works', () => {
  it('edits an allergy and opens the visit with the child on it', async () => {
    const { memberId, childId } = await familyOf('0655550003', 'Walk In', 'Nong Walk');

    const edit = await ctx.app.inject({
      method: 'PATCH',
      url: `/members/children/${childId}`,
      headers: { cookie },
      payload: { allergies: 'Dairy' },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().child.allergies).toBe('Dairy');

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/visits',
      headers: { cookie },
      payload: { memberId, childIds: [childId] },
    });
    expect(created.statusCode).toBe(200);
    const visitId = created.json().id as string;
    const rows = await ctx.db.select().from(visitChild).where(eq(visitChild.visitId, visitId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.childId).toBe(childId);
    // Confirming is what stamps it: the details were re-read at the counter.
    const [row] = await ctx.db.select().from(child).where(eq(child.id, childId));
    expect(row!.lastConfirmedAt).toBeTruthy();
  });
});

/**
 * SCRUM-321 — the messaging channel nobody chose.
 *
 * The admin dialog opened with the WhatsApp chip lit for a member whose
 * channel was null and saved it on the way out, so an unrelated tier edit gave
 * a member a channel they had never picked. The screen is the fix; this is the
 * floor under it — the API must leave a field alone when the patch is silent
 * about it, so "send only what changed" is an honest thing for a form to do.
 */
describe('SCRUM-321 — a patch that does not name the channel', () => {
  it('leaves it null', async () => {
    const { memberId } = await familyOf('0655550004', 'Channel Test', 'Nong Channel');
    const [before] = await ctx.db.select().from(member).where(eq(member.id, memberId));
    expect(before!.preferredChannel).toBeNull();

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/members/${memberId}`,
      headers: { cookie },
      payload: { nickname: 'Channel Test', phone: '0655550004' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().member.preferredChannel).toBeNull();

    const [after] = await ctx.db.select().from(member).where(eq(member.id, memberId));
    expect(after!.preferredChannel).toBeNull();
  });

  it('sets one when the patch names it, and clears it again when told to', async () => {
    const { memberId } = await familyOf('0655550005', 'Channel Pick', 'Nong Pick');
    const set = await ctx.app.inject({
      method: 'PATCH',
      url: `/members/${memberId}`,
      headers: { cookie },
      payload: { preferredChannel: 'telegram' },
    });
    expect(set.json().member.preferredChannel).toBe('telegram');

    const cleared = await ctx.app.inject({
      method: 'PATCH',
      url: `/members/${memberId}`,
      headers: { cookie },
      payload: { preferredChannel: null },
    });
    expect(cleared.json().member.preferredChannel).toBeNull();
  });
});
