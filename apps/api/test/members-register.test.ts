import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-246 — looking up the visitor at the counter and dumping the register
 * are different acts, and they now need different permissions.
 *
 * Every test here drives the real route through the real guard: reception
 * signs in with the seeded reception account and an administrator with the
 * seeded admin one, so what is proven is what a session actually gets, not
 * what a permission table says it should.
 */

let ctx: TestContext;
let reception: string;
let admin: string;

/** A child's allergy text, read once through the counter's own lookup. */
let allergyText: string;

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);

  const lookup = await ctx.app.inject({
    method: 'GET',
    url: '/members/lookup?phone=081-111-1111',
    headers: { cookie: reception },
  });
  const kid = lookup
    .json()
    .member.children.find((c: { allergies: string | null }) => c.allergies);
  allergyText = kid.allergies as string;
  expect(allergyText.length).toBeGreaterThan(3);
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('reception — the counter keeps its lookup and loses the register', () => {
  it('still finds one member by phone, with the children and their allergies', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=081-111-1111',
      headers: { cookie: reception },
    });
    expect(res.statusCode).toBe(200);
    const m = res.json().member;
    expect(m.nickname).toBe('Mali');
    expect(m.children.length).toBeGreaterThan(0);
    // The first-aid data reception is meant to see, on the member in front of
    // them: this is the act the ticket protects, not the one it closes.
    expect(res.body).toContain(allergyText);
  });

  it('cannot browse the register', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/members',
      headers: { cookie: reception },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(res.body).not.toContain(allergyText);
  });

  it('cannot reach the register by supplying a search term', async () => {
    for (const q of ['a', 'Mali', '%', '08']) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/members?q=${encodeURIComponent(q)}`,
        headers: { cookie: reception },
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('Mali');
    }
  });

  it('cannot pull the tier-verification records, which name members and phones', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/members/tier-verifications',
      headers: { cookie: reception },
    });
    expect(res.statusCode).toBe(403);
  });

  it('still reads one member by id, health notes included', async () => {
    const lookup = await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=081-111-1111',
      headers: { cookie: reception },
    });
    const id = lookup.json().member.id as string;
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/members/${id}`,
      headers: { cookie: reception },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(allergyText);
  });
});

describe('an administrator — the register still works, without the health notes', () => {
  it('lists the members, paged, with a total', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/members', headers: { cookie: admin } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.members.length).toBeGreaterThan(1);
    expect(body.total).toBe(body.members.length);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    // What the admin Members panel reads off each row.
    const mali = body.members.find((m: { nickname: string }) => m.nickname === 'Mali');
    expect(mali.phone).toBe('+66811111111');
    expect(mali.tierVerification.tier).toBe('thai');
  });

  it('carries no child medical field on any row', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/members', headers: { cookie: admin } });
    // The text itself is nowhere in the response — not under another key, not
    // nested somewhere a key-by-key check would miss.
    expect(res.body).not.toContain(allergyText);
    const rows = res.json().members as Array<{ children: Array<Record<string, unknown>> }>;
    const seen = new Set<string>();
    for (const row of rows) for (const c of row.children) for (const k of Object.keys(c)) seen.add(k);
    expect([...seen].sort()).toEqual(['ageYears', 'dateOfBirth', 'id', 'name']);
    for (const forbidden of [
      'allergies',
      'medicalNotes',
      'medicalAlert',
      'dietary',
      'foodRestrictions',
      'notes',
    ]) {
      expect(seen.has(forbidden)).toBe(false);
    }
  });

  it('counts the children it does not describe', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/members?q=Mali',
      headers: { cookie: admin },
    });
    const mali = res.json().members[0];
    expect(mali.nickname).toBe('Mali');
    expect(mali.childCount).toBe(mali.children.length);
    expect(mali.childCount).toBeGreaterThan(0);
    // Identity is enough to see the family; the allergy is a read away.
    expect(mali.children[0].name).toBeTruthy();
  });

  it('pages: a limit is honoured, and the pages do not overlap', async () => {
    const all = await ctx.app.inject({ method: 'GET', url: '/members', headers: { cookie: admin } });
    const total = all.json().total as number;
    expect(total).toBeGreaterThan(2);

    const first = await ctx.app.inject({
      method: 'GET',
      url: '/members?limit=2&offset=0',
      headers: { cookie: admin },
    });
    const second = await ctx.app.inject({
      method: 'GET',
      url: '/members?limit=2&offset=2',
      headers: { cookie: admin },
    });
    expect(first.json().members).toHaveLength(2);
    // `total` counts the matches, not the page.
    expect(first.json().total).toBe(total);
    expect(second.json().offset).toBe(2);
    const ids = (r: typeof first) => (r.json().members as Array<{ id: string }>).map((m) => m.id);
    expect(ids(first).some((id) => ids(second).includes(id))).toBe(false);
  });

  it('refuses a page size outside the range rather than answering with everything', async () => {
    for (const url of ['/members?limit=0', '/members?limit=5000', '/members?offset=-1']) {
      const res = await ctx.app.inject({ method: 'GET', url, headers: { cookie: admin } });
      expect(res.statusCode).toBe(400);
    }
  });

  it('treats a search term as text, not as a wildcard', async () => {
    const wildcard = await ctx.app.inject({
      method: 'GET',
      url: '/members?q=%25', // a literal %
      headers: { cookie: admin },
    });
    expect(wildcard.statusCode).toBe(200);
    expect(wildcard.json().members).toHaveLength(0);
    expect(wildcard.json().total).toBe(0);

    const underscore = await ctx.app.inject({
      method: 'GET',
      url: '/members?q=_',
      headers: { cookie: admin },
    });
    expect(underscore.json().members).toHaveLength(0);
  });

  it('searches by nickname and by phone', async () => {
    const byName = await ctx.app.inject({
      method: 'GET',
      url: '/members?q=Mali',
      headers: { cookie: admin },
    });
    expect(byName.json().members.map((m: { nickname: string }) => m.nickname)).toContain('Mali');

    const byPhone = await ctx.app.inject({
      method: 'GET',
      url: '/members?q=811111111',
      headers: { cookie: admin },
    });
    expect(byPhone.json().members[0].phone).toBe('+66811111111');
  });

  it('reads the record-checking list', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/members/tier-verifications',
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().verifications)).toBe(true);
  });

  it('reads one member in full, health notes included', async () => {
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/members?q=Mali',
      headers: { cookie: admin },
    });
    const id = list.json().members[0].id as string;
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/members/${id}`,
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(allergyText);
  });

  it('leaves an archived member out of the register', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/members',
      headers: { cookie: admin },
      payload: { phone: '0644445555', nickname: 'RegisterArchived' },
    });
    const id = created.json().member.id as string;

    const before = await ctx.app.inject({
      method: 'GET',
      url: '/members?q=RegisterArchived',
      headers: { cookie: admin },
    });
    expect(before.json().total).toBe(1);

    const archived = await ctx.app.inject({
      method: 'DELETE',
      url: `/members/${id}`,
      headers: { cookie: admin },
    });
    expect(archived.statusCode).toBe(200);

    const after = await ctx.app.inject({
      method: 'GET',
      url: '/members?q=RegisterArchived',
      headers: { cookie: admin },
    });
    expect(after.json().total).toBe(0);
    expect(after.json().members).toHaveLength(0);
  });
});
