import { hash } from '@node-rs/argon2';
import { and, eq, isNull, or } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema as s } from '@oto/db';
import { newId } from '@oto/shared';
import { holdsAtOwnDepartment } from '../src/services/access-control';
import { resolveEffectivePermissions } from '../src/services/permissions';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  RECEPTION,
  SECOND_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-592 — a department-scoped person signs in AND reaches their app.
 *
 * The launcher shows a tile for any app permission held at any scope, and
 * `POST /auth/handoff` checked the permission against the session's branch,
 * which a department grant never covers: an `inbox_agent` saw the Inbox tile
 * and was refused the click. The hand-off now also honours a department grant
 * at a department of the caller's own operator — and only that: operator- and
 * branch-granted callers are answered exactly as before, an account without
 * the app permission is still refused, and a department of another operator
 * counts for nothing.
 */

const KID = 'k1';
const SECRET = 'handoff-dept-test-secret-0123456789ab';
const POS_ORIGIN = 'https://pos.test';
const CONSOLE_ORIGIN = 'https://console.test';
const INBOX_ORIGIN = 'https://inbox.test';
const BOOTH_ORIGIN = 'https://booth.test';
const PASSWORD = 'deptseat1234';

let ctx: TestContext;
let oto: string;
let second: string;
let central: string;

async function roleId(operatorId: string, name: string): Promise<string> {
  const [r] = await ctx.db
    .select({ id: s.role.id })
    .from(s.role)
    .where(and(eq(s.role.name, name), or(isNull(s.role.operatorId), eq(s.role.operatorId, operatorId))))
    .limit(1);
  return r!.id;
}

/** An active, verified account with the given grants, inserted directly. */
async function person(
  operatorId: string,
  phone: string,
  grants: Array<{ role: string; scopeType: 'branch' | 'department'; scopeId: string }>,
): Promise<string> {
  const accountId = newId();
  await ctx.db.insert(s.account).values({
    id: accountId,
    operatorId,
    phone,
    passwordHash: await hash(PASSWORD),
    phoneVerifiedAt: new Date(),
    status: 'active',
  });
  for (const g of grants) {
    await ctx.db.insert(s.roleAssignment).values({
      id: newId(),
      accountId,
      roleId: await roleId(operatorId, g.role),
      scopeType: g.scopeType,
      scopeId: g.scopeId,
    });
  }
  return accountId;
}

async function dept(operatorId: string, branchId: string | null, name: string): Promise<string> {
  const id = newId();
  await ctx.db.insert(s.department).values({ id, operatorId, branchId, name });
  return id;
}

const handoff = (cookie: string, app: string) =>
  ctx.app.inject({ method: 'POST', url: '/auth/handoff', headers: { cookie }, payload: { app } });

let centralDesk: string;
let birthdays: string;
let foreignDept: string;

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      HANDOFF_SIGNING_KEY: `${KID}:${SECRET}`,
      HANDOFF_APP_ORIGINS: `pos=${POS_ORIGIN},console=${CONSOLE_ORIGIN},inbox=${INBOX_ORIGIN},booth=${BOOTH_ORIGIN}`,
      ALLOWED_ORIGINS: `${POS_ORIGIN},${CONSOLE_ORIGIN},${INBOX_ORIGIN},${BOOTH_ORIGIN}`,
    },
  });
  oto = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  second = await operatorIdByName(ctx.db, SECOND_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  centralDesk = await dept(oto, central, 'dept-seat central desk');
  birthdays = await dept(oto, null, 'dept-seat birthdays');
  foreignDept = await dept(second, null, 'dept-seat other operator');

  await person(oto, '+66810000591', [{ role: 'inbox_agent', scopeType: 'department', scopeId: centralDesk }]);
  await person(oto, '+66810000592', [{ role: 'inbox_agent', scopeType: 'department', scopeId: birthdays }]);
  // Holds a counter role at its own branch (so it signs in) and an inbox grant
  // naming ANOTHER operator's department — which assignment refuses; written
  // straight to the table to prove the hand-off does not trust it either.
  await person(oto, '+66810000593', [
    { role: 'reception', scopeType: 'branch', scopeId: central },
    { role: 'inbox_agent', scopeType: 'department', scopeId: foreignDept },
  ]);
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('a department-only agent reaches the Inbox (SCRUM-592)', () => {
  it.each([
    ['a department at a branch', '+66810000591'],
    ['a branchless department', '+66810000592'],
  ])('%s: sign-in → seat → hand-off → exchange → the Inbox', async (_label, phone) => {
    const launcher = await signInAs(ctx.app, phone, PASSWORD);
    const minted = await handoff(launcher, 'inbox');
    expect(minted.statusCode, minted.body).toBe(200);
    expect(minted.json()).toMatchObject({ audience: 'inbox', origin: INBOX_ORIGIN });

    const exchanged = await ctx.app.inject({
      method: 'POST',
      url: '/auth/handoff/exchange',
      headers: { origin: INBOX_ORIGIN },
      payload: { token: minted.json().token },
    });
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    const set = exchanged.headers['set-cookie'];
    const cookie = (Array.isArray(set) ? set[0]! : (set as string)).split(';')[0]!;

    const me = await ctx.app.inject({ method: 'GET', url: '/inbox/me', headers: { cookie } });
    expect(me.statusCode, me.body).toBe(200);
  });

  it('gains only app access: the same agent is refused every app its role does not carry', async () => {
    const launcher = await signInAs(ctx.app, '+66810000591', PASSWORD);
    for (const app of ['pos', 'console', 'booth']) {
      const res = await handoff(launcher, app);
      expect(res.statusCode, `${app}: ${res.body}`).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    }
  });
});

describe('the retired booth hand-off, asked for on a department grant (SCRUM-592, SCRUM-694)', () => {
  it('passes the permission check on the department grant, then is refused as retired', async () => {
    await person(oto, '+66810000594', [{ role: 'reception', scopeType: 'department', scopeId: centralDesk }]);
    const launcher = await signInAs(ctx.app, '+66810000594', PASSWORD);
    const minted = await handoff(launcher, 'booth');
    // 410, not 403: the department grant still carries app:booth:access (the
    // launcher's tile), and the Lucky Wheel takes no sign-on.
    expect(minted.statusCode, minted.body).toBe(410);
    expect(minted.json().error.code).toBe('HANDOFF_APP_RETIRED');
    expect(minted.json()).not.toHaveProperty('token');
  });
});

describe('everyone else is answered as before (SCRUM-592)', () => {
  it('an account without app:inbox:access is still refused the Inbox', async () => {
    const reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const res = await handoff(reception, 'inbox');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('branch-granted reception: a till token yes, a console token no — unchanged', async () => {
    const reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    expect((await handoff(reception, 'pos')).statusCode).toBe(200);
    const refused = await handoff(reception, 'console');
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('FORBIDDEN');
  });

  it('the operator-wide administrator: till and console tokens — unchanged', async () => {
    const admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    expect((await handoff(admin, 'pos')).statusCode).toBe(200);
    expect((await handoff(admin, 'console')).statusCode).toBe(200);
  });
});

describe('another operator’s department counts for nothing (SCRUM-592)', () => {
  it('refuses the Inbox to a grant naming a department outside the caller’s operator', async () => {
    const cookie = await signInAs(ctx.app, '+66810000593', PASSWORD);
    const res = await handoff(cookie, 'inbox');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('holdsAtOwnDepartment loads the department inside the operator it is asked about', async () => {
    const [acc] = await ctx.db
      .select({ id: s.account.id })
      .from(s.account)
      .where(eq(s.account.phone, '+66810000591'))
      .limit(1);
    const effective = await resolveEffectivePermissions(ctx.db, acc!.id);
    expect(await holdsAtOwnDepartment(ctx.db, effective, 'app:inbox:access', oto)).toBe(true);
    expect(await holdsAtOwnDepartment(ctx.db, effective, 'app:inbox:access', second)).toBe(false);
    expect(await holdsAtOwnDepartment(ctx.db, effective, 'app:pos:access', oto)).toBe(false);
  });
});
