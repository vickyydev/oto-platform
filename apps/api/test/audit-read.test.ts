import { hash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, branch, operator, role, roleAssignment } from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-03 dev evidence for the audit read surface: keyset pagination, the cap,
 * the outcome filter, and the masking rule — a child's medical note is hidden
 * from an administrator who does not hold `admin:audit:read_sensitive`, and
 * shown to one who does at the cost of a row of their own.
 */

interface Entry {
  id: string;
  action: string;
  after: Record<string, unknown> | null;
  createdAt: string;
}
interface Page {
  entries: Entry[];
  masked: boolean;
  nextCursor: string | null;
}

let ctx: TestContext;
let admin: string;
/** A branch manager: `admin:audit:read`, but never the sensitive one. */
let manager: string;
let reception: string;
let operatorId: string;
let childMedicalNote: string;

const PAGE_ACTION = 'test.page_row';
const PAGE_ROWS = 25;

beforeAll(async () => {
  ctx = await createTestContext();
  const [op] = await ctx.db.select().from(operator).limit(1);
  operatorId = op!.id;
  const [br] = await ctx.db.select().from(branch).where(eq(branch.operatorId, operatorId)).limit(1);
  const [managerRole] = await ctx.db.select().from(role).where(eq(role.name, 'branch_manager')).limit(1);

  const managerId = newId();
  await ctx.db.insert(account).values({
    id: managerId,
    operatorId,
    phone: normalizePhone('+66900000021')!,
    passwordHash: await hash('manager1234'),
    phoneVerifiedAt: new Date(),
    status: 'active',
  });
  await ctx.db.insert(roleAssignment).values({
    id: newId(),
    accountId: managerId,
    roleId: managerRole!.id,
    scopeType: 'branch',
    scopeId: br!.id,
  });

  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, '+66900000021', 'manager1234');
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);

  // A child with a medical note: the most sensitive text the park holds, and
  // the reason the masking rule exists.
  childMedicalNote = 'Carries an adrenaline pen in the blue bag';
  const member = await ctx.app.inject({
    method: 'POST',
    url: '/members',
    headers: { cookie: admin },
    payload: { phone: '+66655551111', nickname: 'AuditReadGuardian' },
  });
  expect(member.statusCode).toBe(200);
  const memberId = (member.json() as { member: { id: string } }).member.id;
  const child = await ctx.app.inject({
    method: 'POST',
    url: `/members/${memberId}/children`,
    headers: { cookie: admin },
    payload: { name: 'Nong Ploy', allergies: 'peanuts', medicalNotes: childMedicalNote },
  });
  expect(child.statusCode).toBe(200);

  // One timestamp for every page row, so the pagination case proves the id
  // tie-break rather than accidentally relying on distinct timestamps.
  //
  // They carry the manager's branch (SCRUM-249): `GET /audit` now answers a
  // branch-scoped reader with the rows of the branches they hold, and a row
  // with no branch at all is an operator-level event rather than one of
  // theirs. A branchless fixture would have made the pagination case go red
  // for a reason that has nothing to do with pagination.
  const stamp = new Date('2026-09-20T03:00:00.000Z');
  await ctx.db.insert(auditLog).values(
    Array.from({ length: PAGE_ROWS }, () => ({
      id: newId(),
      operatorId,
      branchId: br!.id,
      action: PAGE_ACTION,
      entityType: 'test',
      entityId: 'page',
      createdAt: stamp,
    })),
  );
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

async function read(cookie: string, query: string): Promise<Page> {
  const res = await ctx.app.inject({ method: 'GET', url: `/audit?${query}`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as Page;
}

describe('GET /audit — keyset pagination (S2-03)', () => {
  it('returns every row exactly once across pages', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const body = await read(manager, `action=${PAGE_ACTION}&limit=10${suffix}`);
      seen.push(...body.entries.map((e) => e.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(PAGE_ROWS);
    expect(new Set(seen).size).toBe(PAGE_ROWS);
  });

  it('refuses a cursor that is not one of ours', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/audit?cursor=bm90LWEtY3Vyc29y',
      headers: { cookie: manager },
    });
    expect(res.statusCode).toBe(400);
  });

  it('caps a page at 200', async () => {
    const over = await ctx.app.inject({
      method: 'GET',
      url: '/audit?limit=201',
      headers: { cookie: manager },
    });
    expect(over.statusCode).toBe(400);
    expect(over.json().error.code).toBe('VALIDATION');

    const atCap = await read(manager, 'limit=200');
    expect(atCap.entries.length).toBeLessThanOrEqual(200);
  });
});

describe('GET /audit — masking (S2-03)', () => {
  it("hides a child's medical note from an admin without the sensitive permission", async () => {
    const body = await read(manager, 'action=child.create&limit=10');
    expect(body.masked).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0);
    const after = body.entries[0]!.after!;
    expect(after.medicalNotes).toBe('[redacted]');
    expect(after.allergies).toBe('[redacted]');
    expect(after.name).toBe('[redacted]');
    // The shape of the change survives — only the contents go.
    expect(Object.keys(after)).toContain('medicalNotes');
    expect(JSON.stringify(body)).not.toContain(childMedicalNote);
  });

  it('shows it to an admin who holds it, and records that they looked', async () => {
    const body = await read(admin, 'action=child.create&limit=10');
    expect(body.masked).toBe(false);
    expect(body.entries[0]!.after!.medicalNotes).toBe(childMedicalNote);

    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'audit.read_sensitive'));
    expect(rows.length).toBeGreaterThan(0);
    const last = rows[rows.length - 1]!.after as { rows: number; filters: { action?: string } };
    expect(last.rows).toBeGreaterThan(0);
    expect(last.filters.action).toBe('child.create');
  });
});

describe('GET /audit — outcome and the new actions (S2-03)', () => {
  it('records a permission refusal under its own action', async () => {
    const denied = await ctx.app.inject({
      method: 'GET',
      url: '/audit',
      headers: { cookie: reception },
    });
    expect(denied.statusCode).toBe(403);

    const body = await read(manager, 'action=auth.permission_denied&limit=10');
    expect(body.entries.length).toBeGreaterThan(0);
  });

  it('separates failures from successes without an outcome column', async () => {
    const failures = await read(manager, 'outcome=failure&limit=200');
    const actions = failures.entries.map((e) => e.action);
    expect(actions).toContain('auth.permission_denied');
    expect(
      actions.every((a) => /[._](failed|denied|rejected)$/.test(a) || a === 'auth.locked_out'),
    ).toBe(true);

    const successes = await read(manager, 'outcome=success&limit=200');
    expect(successes.entries.map((e) => e.action)).not.toContain('auth.permission_denied');
  });

  it('records a refused sign-in, with no phone number anywhere in the row', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/sign-in',
      payload: { phone: RECEPTION.phone, password: 'not-the-password' },
    });
    expect(res.statusCode).toBe(401);

    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'auth.sign_in_failed'));
    expect(rows.length).toBeGreaterThan(0);
    const after = rows[rows.length - 1]!.after as { reason: string; phoneHash: string };
    expect(after.reason).toBe('bad_password');
    expect(after.phoneHash).toMatch(/^ph_[0-9a-f]{12}$/);
    expect(JSON.stringify(rows)).not.toContain('66900000002');
  });

  it('records the moment a bucket closes, once, without naming the bucket', async () => {
    const unknown = '+66900000099';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/auth/sign-in',
        payload: { phone: unknown, password: 'whatever1234' },
      });
      expect(res.statusCode).toBe(401);
    }
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'auth.locked_out'));
    // Five failures, one lockout: the transition, not every attempt after it.
    expect(rows).toHaveLength(1);
    expect((rows[0]!.after as { bucket: string }).bucket).toBe('phone');
    expect(JSON.stringify(rows)).not.toContain('66900000099');
  });
});
