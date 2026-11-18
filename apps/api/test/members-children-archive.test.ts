import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, child, member, operator, station, visit, visitChild } from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, RECEPTION, createTestContext, signInAs, takeStation, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-337 — "Remove from saved" removes a child from the member's list.
 *
 * The till has offered the button since the prototype and it deleted nothing:
 * it called the browser's in-memory removal, which for a real member is not
 * where the child lives. There was no route to call because a child is
 * archived rather than deleted, and nothing had asked for that yet.
 *
 * What these tests pin is the shape that makes the button safe to press at a
 * counter: the row is archived and not deleted, it vanishes from the reads the
 * screens make, a `visit_child` row still points at it because that child WAS
 * here that day, another operator's child is a 404, and a second press is a
 * success rather than a conflict staff cannot act on.
 */

let ctx: TestContext;
/** Reception holds `pos:child:update` — the permission this route is on. */
let cookie: string;
let adminCookie: string;

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
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
    payload: { name: childName, allergies: 'Peanuts' },
  });
  expect(kid.statusCode).toBe(200);
  return { memberId, childId: kid.json().child.id as string };
}

const archive = (childId: string, headers: Record<string, string> = { cookie }) =>
  ctx.app.inject({ method: 'DELETE', url: `/members/children/${childId}`, headers });

describe('SCRUM-337 — archiving a saved child', () => {
  let memberId: string;
  let childId: string;
  let keptId: string;

  beforeAll(async () => {
    ({ memberId, childId } = await familyOf('0655551001', 'Archive Test', 'Nong Gone'));
    const sibling = await ctx.app.inject({
      method: 'POST',
      url: `/members/${memberId}/children`,
      headers: { cookie },
      payload: { name: 'Nong Stays' },
    });
    keptId = sibling.json().child.id as string;
  });

  it('stamps archived_at rather than deleting the row', async () => {
    const res = await archive(childId);
    expect(res.statusCode).toBe(200);
    expect(res.json().alreadyArchived).toBe(false);

    const [row] = await ctx.db.select().from(child).where(eq(child.id, childId));
    // Still there — a child is archived, never deleted (CLAUDE.md §3).
    expect(row).toBeTruthy();
    expect(row!.archivedAt).toBeTruthy();
    // And the rest of the record is untouched: this is a statement about the
    // saved list, not an erasure of what the child's allergies were.
    expect(row!.allergies).toBe('Peanuts');
  });

  it('records child.archive with what the row was and what it became', async () => {
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'child.archive'), eq(auditLog.entityId, childId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorAccountId).toBeTruthy();
    expect((rows[0]!.before as { archivedAt: string | null }).archivedAt).toBeNull();
    expect((rows[0]!.after as { archivedAt: string | null }).archivedAt).toBeTruthy();
  });

  it('is gone from the counter lookup and the member detail, and the sibling is not', async () => {
    const lookup = await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=0655551001',
      headers: { cookie },
    });
    const names = lookup.json().member.children.map((c: { id: string }) => c.id);
    expect(names).not.toContain(childId);
    expect(names).toContain(keptId);

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/members/${memberId}`,
      headers: { cookie },
    });
    expect(detail.json().member.children.map((c: { id: string }) => c.id)).toEqual([keptId]);
  });

  it('is gone from the register row an administrator browses', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/members?q=Archive Test',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const row = res.json().members.find((m: { id: string }) => m.id === memberId);
    expect(row.childCount).toBe(1);
    expect(row.children.map((c: { id: string }) => c.id)).toEqual([keptId]);
  });

  /**
   * The second press, which is the one the till can make by accident: the
   * button is on screen until the answer comes back, and a retry through a
   * dropped connection looks exactly the same from here.
   */
  it('answers success again and writes no second audit row', async () => {
    const again = await archive(childId);
    expect(again.statusCode).toBe(200);
    expect(again.json().alreadyArchived).toBe(true);

    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'child.archive'), eq(auditLog.entityId, childId)));
    expect(rows).toHaveLength(1);
  });

  it('is a 404 for a child id that was never real', async () => {
    const res = await archive(newId());
    expect(res.statusCode).toBe(404);
  });
});

/**
 * SCRUM-1014 — the family adds and removes saved children on the customer
 * display. The till carries each change out under its own session, as staff
 * do, and says where it came from: the audit row names the customer display
 * and the till session's own station — never one the request names — and a
 * session at no till cannot claim one at all.
 */
describe('SCRUM-1014 — a change the family made on the customer display', () => {
  let tillCookie: string;
  let tillId: string;

  beforeAll(async () => {
    tillCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    tillId = (await ctx.db.select().from(station)).find((s) => s.name === 'Reception Till 1')!.id;
    await takeStation(ctx.app, tillCookie, tillId);
  });

  const auditOf = async (action: string, entityId: string) =>
    ctx.db.select().from(auditLog).where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)));

  it('"Remove from saved" archives the child and names the display of this till', async () => {
    const { childId } = await familyOf('0655551003', 'Display Remove', 'Nong Display');
    const res = await ctx.app.inject({ method: 'DELETE', url: `/members/children/${childId}?source=customer_display`,
      headers: { cookie: tillCookie } });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await ctx.db.select().from(child).where(eq(child.id, childId));
    expect(row!.archivedAt).toBeTruthy();
    const rows = await auditOf('child.archive', childId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.origin).toBe('customer_display');
    expect(rows[0]!.actorAccountId).toBeTruthy();
    expect(rows[0]!.after).toMatchObject({ source: 'customer_display', stationId: tillId });
    expect((rows[0]!.after as { archivedAt: string | null }).archivedAt).toBeTruthy();
  });

  it('a new child the family typed is created and names the display of this till', async () => {
    const { memberId } = await familyOf('0655551004', 'Display Add', 'Nong First');
    const res = await ctx.app.inject({ method: 'POST', url: `/members/${memberId}/children`, headers: { cookie: tillCookie },
      payload: { name: 'Nong Added', ageYears: 4, source: 'customer_display' } });
    expect(res.statusCode, res.body).toBe(200);
    const id = res.json().child.id as string;
    const rows = await auditOf('child.create', id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.origin).toBe('customer_display');
    expect(rows[0]!.after).toMatchObject({ name: 'Nong Added', ageYears: 4, source: 'customer_display', stationId: tillId });
  });

  it('staff changes stay as they were: no source, no origin', async () => {
    const { childId } = await familyOf('0655551005', 'Staff Remove', 'Nong Staff');
    expect((await ctx.app.inject({ method: 'DELETE', url: `/members/children/${childId}`, headers: { cookie: tillCookie } })).statusCode).toBe(200);
    const [row] = await auditOf('child.archive', childId);
    expect(row!.origin).toBeNull();
    expect(row!.after).not.toHaveProperty('source');
  });

  it('a session at no till cannot claim the display, and nothing is written', async () => {
    const { memberId, childId } = await familyOf('0655551006', 'No Till', 'Nong Kept');
    const removed = await ctx.app.inject({ method: 'DELETE', url: `/members/children/${childId}?source=customer_display`,
      headers: { cookie } });
    expect(removed.statusCode).toBe(400);
    expect((await ctx.db.select().from(child).where(eq(child.id, childId)))[0]!.archivedAt).toBeNull();
    const added = await ctx.app.inject({ method: 'POST', url: `/members/${memberId}/children`, headers: { cookie },
      payload: { name: 'Nong Refused', source: 'customer_display' } });
    expect(added.statusCode).toBe(400);
    const other = await ctx.app.inject({ method: 'DELETE', url: `/members/children/${childId}?source=somewhere`,
      headers: { cookie: tillCookie } });
    expect(other.statusCode).toBe(400);
  });
});

/**
 * The visit is history and stays readable.
 *
 * A `visit_child` row is the record that this child was in the park on that
 * day. Taking them off the member's saved list afterwards says nothing about
 * that day, so the row — and the visit read that shows it — must survive.
 */
describe('SCRUM-337 — a visit that already named the child', () => {
  it('keeps the visit_child row, and the visit still reads', async () => {
    const { memberId, childId } = await familyOf('0655551002', 'Visited', 'Nong Visited');
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/visits',
      headers: { cookie },
      payload: { memberId, childIds: [childId] },
    });
    expect(created.statusCode).toBe(200);
    const visitId = created.json().id as string;

    expect((await archive(childId)).statusCode).toBe(200);

    const rows = await ctx.db.select().from(visitChild).where(eq(visitChild.visitId, visitId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.childId).toBe(childId);
    expect((await ctx.db.select().from(visit).where(eq(visit.id, visitId)))[0]).toBeTruthy();

    const read = await ctx.app.inject({
      method: 'GET',
      url: `/visits/${visitId}`,
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);
  });
});

/**
 * Tenancy, asked of the new route the way `members-visits.test.ts` asks it of
 * the PATCH beside it: a child id carries no operator of its own, so the
 * guardian is the only thing that proves the caller may touch the record —
 * and the refusal is 404, because the existence of another tenant's record is
 * not ours to confirm.
 */
describe("SCRUM-337 — another operator's child", () => {
  let strangerChildId: string;

  beforeAll(async () => {
    const [other] = await ctx.db
      .insert(operator)
      .values({ id: newId(), name: 'Other Park Co (archive)' })
      .returning();
    const [m] = await ctx.db
      .insert(member)
      .values({
        id: newId(),
        operatorId: other!.id,
        phone: '+66899998888',
        nickname: 'Not ours',
      })
      .returning();
    const [c] = await ctx.db
      .insert(child)
      .values({
        id: newId(),
        memberId: m!.id,
        name: 'Not our child',
        allergies: 'Cashew — EpiPen',
      })
      .returning();
    strangerChildId = c!.id;
  });

  it('refuses with 404 and leaves the child on their list', async () => {
    const res = await archive(strangerChildId);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');

    const [after] = await ctx.db.select().from(child).where(eq(child.id, strangerChildId));
    expect(after!.archivedAt).toBeNull();
  });
});
