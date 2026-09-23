import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, child, member, memberTierVerification, operator, visit, visitChild } from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
let cookie: string;
/**
 * The register and the record-checking list are an administrator's screens
 * since SCRUM-246; reception holds the counter's lookup and not those. The
 * tests that read a list therefore sign in as an administrator.
 */
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

describe('SCRUM-30 — lookup by phone', () => {
  it('finds the seeded member with children from a Thai local-format phone', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=081-111-1111', // local format with dashes
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const m = res.json().member;
    expect(m.phone).toBe('+66811111111'); // stored E.164
    expect(m.nickname).toBe('Mali');
    expect(m.tierVerification.tier).toBe('thai');
    expect(m.children).toHaveLength(2);
    const ploy = m.children.find((c: { name: string }) => c.name === 'Nong Ploy');
    expect(ploy.allergies).toMatch(/Peanut/);
  });

  it('returns null for an unknown phone', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=0699999999',
      headers: { cookie },
    });
    expect(res.json().member).toBeNull();
  });
});

describe('SCRUM-31 — create and enrich', () => {
  it('creates from phone + name only', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/members',
      headers: { cookie },
      payload: { phone: '0622222333', nickname: 'Fern' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().member.phone).toBe('+66622222333');
    expect(res.json().member.tierCode).toBe('tourist'); // default tier
  });

  it('rejects a duplicate phone in any input format with a clear error', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/members',
      headers: { cookie },
      payload: { phone: '+66 62 222 2333', nickname: 'Fern Again' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MEMBER_PHONE_EXISTS');
  });

  it('enriches via PATCH', async () => {
    const found = await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=0622222333',
      headers: { cookie },
    });
    const id = found.json().member.id as string;
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/members/${id}`,
      headers: { cookie },
      payload: { email: 'fern@example.com', notes: 'Prefers Thai' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().member.email).toBe('fern@example.com');
  });
});

describe('SCRUM-32 — children and the visit draft', () => {
  it('confirming children creates a draft visit and stamps last_confirmed_at', async () => {
    const lookup = await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=0811111111',
      headers: { cookie },
    });
    const m = lookup.json().member;
    const childIds = m.children.map((c: { id: string }) => c.id);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/visits',
      headers: { cookie },
      payload: { memberId: m.id, childIds },
    });
    expect(res.statusCode).toBe(200);
    const visitId = res.json().id as string;

    const vRows = await ctx.db.select().from(visit).where(eq(visit.id, visitId));
    expect(vRows[0]!.status).toBe('draft');
    const vcRows = await ctx.db.select().from(visitChild).where(eq(visitChild.visitId, visitId));
    expect(vcRows).toHaveLength(2);
    const cRows = await ctx.db.select().from(child).where(eq(child.id, childIds[0]));
    expect(cRows[0]!.lastConfirmedAt).not.toBeNull();
  });

  it('rejects children that belong to another member', async () => {
    const mali = await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=0811111111',
      headers: { cookie },
    });
    const tom = await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=0866666666',
      headers: { cookie },
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/visits',
      headers: { cookie },
      payload: {
        memberId: tom.json().member.id,
        childIds: [mali.json().member.children[0].id],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('editing an allergy updates the child and is audited', async () => {
    const lookup = await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=0811111111',
      headers: { cookie },
    });
    const ploy = lookup.json().member.children.find((c: { name: string }) => c.name === 'Nong Ploy');
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/members/children/${ploy.id}`,
      headers: { cookie },
      payload: { allergies: 'Peanut + shellfish — EpiPen in bag' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().child.allergies).toMatch(/shellfish/);
    expect(res.json().child.medicalAlert).toBe(true);
  });

  it('the visit is visible via the API with its children', async () => {
    const lookup = await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=0811111111',
      headers: { cookie },
    });
    const m = lookup.json().member;
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/visits',
      headers: { cookie },
      payload: { memberId: m.id, childIds: [m.children[0].id] },
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/visits/${created.json().id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().visit.children).toHaveLength(1);
  });
});

describe('Tier verification — proof checked at the counter (beyond the prototype)', () => {
  let memberId: string;

  it('records the verification with the staff account stamped server-side', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/members',
      headers: { cookie },
      payload: { phone: '0633334444', nickname: 'Tier Test' },
    });
    memberId = created.json().member.id as string;

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/members/${memberId}/tier-verification`,
      headers: { cookie },
      payload: { toTier: 'expat', evidenceType: 'Passport', evidenceExpiresAt: '2030-01-01' },
    });
    expect(res.statusCode).toBe(200);
    const m = res.json().member;
    expect(m.tierCode).toBe('expat'); // member upgraded
    expect(m.tierVerification.tier).toBe('expat');
    expect(m.tierVerification.proofType).toBe('Passport');
    expect(m.tierVerification.expiresAt).toBe('2030-01-01');
    // WHO checked comes from the session, never from the request body.
    expect(m.tierVerification.verifiedBy).toBeTruthy();
  });

  it('the record appears in the record-checking list with staff, time and expiry', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/members/tier-verifications',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const row = res
      .json()
      .verifications.find((v: { member: { phone: string } }) => v.member.phone === '+66633334444');
    expect(row).toBeTruthy();
    expect(row.fromTier).toBe('tourist');
    expect(row.toTier).toBe('expat');
    expect(row.evidenceType).toBe('Passport');
    expect(row.evidenceExpiresAt).toBe('2030-01-01');
    expect(row.expired).toBe(false);
    expect(row.verifiedBy).toBeTruthy();
    expect(row.verifiedAt).toBeTruthy();
  });

  it('writes an audit row for the verification', async () => {
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'member.tier_verify'));
    expect(rows.length).toBeGreaterThan(0);
    expect((rows[0]!.after as { toTier: string }).toTier).toBe('expat');
    expect(rows[0]!.actorAccountId).toBeTruthy();
  });

  it('rejects an already-expired document', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/members/${memberId}/tier-verification`,
      headers: { cookie },
      // A real document kind, so the refusal under test is the expiry and not
      // the kind: since SCRUM-315 the field is the four-name enum, and an
      // invented kind would have been refused before the date was read.
      payload: { toTier: 'thai', evidenceType: 'Residence certificate', evidenceExpiresAt: '2020-01-01' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/expired/i);
  });

  /**
   * SCRUM-315 — the document KIND is one of four names, not free text.
   *
   * The till has only ever sent one of the four, so this was a hole in the
   * contract rather than in behaviour: `evidence_type` is a durable column on
   * the member's record that a record check reads as "what was checked", and
   * a passport NUMBER typed into it would sit in a table nothing sweeps.
   */
  it('refuses a document number typed into the document kind', async () => {
    // Its own member, so the refusal under test is this route's and not a
    // dependency on what an earlier test left behind.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/members',
      headers: { cookie },
      payload: { phone: '0633334455', nickname: 'Proof Kind Test' },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().member.id as string;

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/members/${id}/tier-verification`,
      headers: { cookie },
      payload: {
        toTier: 'expat',
        evidenceType: 'Passport AA1234567',
        evidenceExpiresAt: '2030-01-01',
      },
    });
    expect(res.statusCode).toBe(400);
    // Nothing was written: no row at all, and the member never moved off the
    // full-price rate on a document kind that is not one.
    const rows = await ctx.db
      .select()
      .from(memberTierVerification)
      .where(eq(memberTierVerification.memberId, id));
    expect(rows).toHaveLength(0);
    const [row] = await ctx.db.select().from(member).where(eq(member.id, id));
    expect(row!.tierCode).toBe('tourist');
  });

  it('rejects an unknown tier', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/members/${memberId}/tier-verification`,
      headers: { cookie },
      payload: { toTier: 'vip', evidenceType: 'Passport', evidenceExpiresAt: '2030-01-01' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('hides an expired verification from the member (rate must be re-proven)', async () => {
    // Write an old verification directly — as if the document expired long ago.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/members',
      headers: { cookie },
      payload: { phone: '0633335555', nickname: 'Expired Test' },
    });
    const expiredMemberId = created.json().member.id as string;
    await ctx.db.insert(memberTierVerification).values({
      id: newId(),
      memberId: expiredMemberId,
      fromTier: 'tourist',
      toTier: 'expat',
      evidenceType: 'Residence certificate',
      evidenceExpiresAt: new Date('2024-01-01T00:00:00Z'),
    });

    const lookup = await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=0633335555',
      headers: { cookie },
    });
    expect(lookup.json().member.tierVerification).toBeNull(); // no discount without valid proof

    // …but the record stays visible for record checking, flagged expired.
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/members/tier-verifications',
      headers: { cookie: adminCookie },
    });
    const row = list
      .json()
      .verifications.find((v: { member: { phone: string } }) => v.member.phone === '+66633335555');
    expect(row.expired).toBe(true);
  });
});

/**
 * SCRUM-356 — a child taken off the saved list cannot open a new visit.
 *
 * `POST /visits` checked childIds against the guardian alone. Since SCRUM-337
 * the counter's lookup stops listing an archived child, so the till cannot
 * offer one — but a screen that was already open when the guardian asked for
 * the removal still holds the id, and that request was accepted. A
 * `visit_child` row is the record that this child WAS in the park that day,
 * so writing one for a child the guardian has removed is the one outcome the
 * archive exists to prevent.
 */
describe('SCRUM-356 — an archived child on a new visit', () => {
  let memberId: string;
  let archivedId: string;
  let siblingId: string;

  const openVisit = (childIds: string[]) =>
    ctx.app.inject({ method: 'POST', url: '/visits', headers: { cookie }, payload: { memberId, childIds } });

  /** Every visit this member has, which for this fixture is only what the tests open. */
  const visitsOfMember = () => ctx.db.select().from(visit).where(eq(visit.memberId, memberId));

  beforeAll(async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/members',
      headers: { cookie },
      payload: { phone: '0655552001', nickname: 'Visit Archive Test' },
    });
    expect(created.statusCode).toBe(200);
    memberId = created.json().member.id as string;

    const addChild = async (name: string) => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/members/${memberId}/children`,
        headers: { cookie },
        payload: { name },
      });
      expect(res.statusCode).toBe(200);
      return res.json().child.id as string;
    };
    archivedId = await addChild('Nong Removed');
    siblingId = await addChild('Nong Stays');

    // The guardian asks for the removal — the route SCRUM-337 added.
    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/members/children/${archivedId}`,
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(200);
  });

  it('refuses the visit, and writes no visit and no row saying the child was here', async () => {
    const res = await openVisit([archivedId]);
    // The same refusal a child who is not this member's gets, above: the route
    // does not say which of the two it was.
    expect(res.statusCode).toBe(400);

    expect(await visitsOfMember()).toHaveLength(0);
    const vc = await ctx.db.select().from(visitChild).where(eq(visitChild.childId, archivedId));
    expect(vc).toHaveLength(0);
    // Nor was the child re-confirmed on the way past.
    const [row] = await ctx.db.select().from(child).where(eq(child.id, archivedId));
    expect(row!.lastConfirmedAt).toBeNull();
    // And the removal stands — a refused visit changes nothing about the list.
    expect(row!.archivedAt).toBeTruthy();
  });

  it('refuses the whole visit when one of two named children is archived', async () => {
    const res = await openVisit([siblingId, archivedId]);
    expect(res.statusCode).toBe(400);
    // Not a partial visit with the sibling on it: nothing was written at all.
    expect(await visitsOfMember()).toHaveLength(0);
    const [sib] = await ctx.db.select().from(child).where(eq(child.id, siblingId));
    expect(sib!.lastConfirmedAt).toBeNull();
  });

  it('still opens the visit for the sibling who is on the list', async () => {
    const res = await openVisit([siblingId]);
    expect(res.statusCode).toBe(200);
    const rows = await ctx.db
      .select()
      .from(visitChild)
      .where(eq(visitChild.visitId, res.json().id as string));
    expect(rows.map((r) => r.childId)).toEqual([siblingId]);
  });
});

/**
 * S2-01d, finding B4 — a member id is not permission to read that member.
 * Ids travel: into a copied URL, a support request, an audit row, the memory
 * of somebody who used to work at the other operator. Reception here holds
 * every member and child permission there is, and still must not reach a
 * record belonging to another operator.
 *
 * Every refusal is 404 and not 403. The existence of another tenant's record
 * is not ours to confirm, and the answer must be the same as for an id that
 * was never real.
 */
describe('tenancy — another operator\'s member (S2-01d)', () => {
  let strangerMemberId: string;
  let strangerChildId: string;

  beforeAll(async () => {
    const [other] = await ctx.db
      .insert(operator)
      .values({ id: newId(), name: 'Other Park Co' })
      .returning();
    const [m] = await ctx.db
      .insert(member)
      .values({
        id: newId(),
        operatorId: other!.id,
        phone: '+66899999999',
        nickname: 'Not ours',
        notes: 'Reception at the other operator wrote this',
      })
      .returning();
    strangerMemberId = m!.id;
    const [c] = await ctx.db
      .insert(child)
      .values({
        id: newId(),
        memberId: strangerMemberId,
        name: 'Not our child',
        // The one class of data that must never cross a tenancy boundary.
        allergies: 'Cashew — EpiPen',
        medicalNotes: 'Asthma inhaler in the blue bag',
        medicalAlert: true,
      })
      .returning();
    strangerChildId = c!.id;
  });

  it('does not read the member, the notes or the medical data by id', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/members/${strangerMemberId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(res.body).not.toContain('Cashew');
    expect(res.body).not.toContain('Asthma');
  });

  it('does not find the member by phone', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=0899999999',
      headers: { cookie },
    });
    expect(res.json().member).toBeNull();
  });

  it('does not list the member, even for an administrator of this operator', async () => {
    // Driven as an administrator: reception no longer holds the register at
    // all (SCRUM-246), so asking as reception would prove the guard and say
    // nothing about tenancy. The account that MAY browse still sees only its
    // own operator's members.
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/members?q=Not ours',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().members).toHaveLength(0);
    expect(res.json().total).toBe(0);

    const asReception = await ctx.app.inject({
      method: 'GET',
      url: '/members?q=Not ours',
      headers: { cookie },
    });
    expect(asReception.statusCode).toBe(403);
  });

  it('does not enrich or archive the member', async () => {
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/members/${strangerMemberId}`,
      headers: { cookie },
      payload: { notes: 'overwritten' },
    });
    expect(patched.statusCode).toBe(404);

    const archived = await ctx.app.inject({
      method: 'DELETE',
      url: `/members/${strangerMemberId}`,
      headers: { cookie },
    });
    expect(archived.statusCode).toBe(404);

    const [after] = await ctx.db.select().from(member).where(eq(member.id, strangerMemberId));
    expect(after!.notes).toBe('Reception at the other operator wrote this');
    expect(after!.archivedAt).toBeNull();
  });

  it('does not upgrade the member to a discounted tier', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/members/${strangerMemberId}/tier-verification`,
      headers: { cookie },
      payload: { toTier: 'thai', evidenceType: 'Passport', evidenceExpiresAt: '2030-01-01' },
    });
    // 404, and reached for the tenancy reason: the body itself is valid.
    expect(res.statusCode).toBe(404);
  });

  it('does not add a child to the member', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/members/${strangerMemberId}/children`,
      headers: { cookie },
      payload: { name: 'Planted' },
    });
    expect(res.statusCode).toBe(404);
    const rows = await ctx.db.select().from(child).where(eq(child.memberId, strangerMemberId));
    expect(rows).toHaveLength(1);
  });

  it('does not edit the child, whose id carries no operator of its own', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/members/children/${strangerChildId}`,
      headers: { cookie },
      payload: { allergies: 'none' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    const [after] = await ctx.db.select().from(child).where(eq(child.id, strangerChildId));
    expect(after!.allergies).toBe('Cashew — EpiPen');
  });
});
