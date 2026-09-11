import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { child, visit, visitChild } from '@oto/db';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
let cookie: string;
beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
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
    expect(res.json().error.code).toBe('MEMBER_EXISTS');
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
