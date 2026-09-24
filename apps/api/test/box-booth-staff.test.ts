import { randomInt } from 'node:crypto';
import { hash as argonHash, verify as verifyArgon2 } from '@node-rs/argon2';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import {
  account,
  auditLog,
  authThrottle,
  box,
  boothStaffAssignment,
  branch,
  employee,
  role,
  roleAssignment,
  rolePermission,
  station,
  type Db,
} from '@oto/db';
import { BOOTH_DEVICE_HEADER, boothStaffCode, newId } from '@oto/shared';
import {
  boxCredential,
  createBoxAgent,
  memoryCredentialStore,
  postgresBoxDriver,
  SqlBoxStore,
  type AgentFetch,
  type BoxAgent,
  type PgPoolLike,
} from '@oto/box-agent';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  OTO_OPERATOR_NAME,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { _resetThrottle } from '../src/services/auth';
import { BOOTH_BUCKET_FACTOR } from '../src/services/box-booth-staff';
import { attachInProcessBox, detachInProcessBox, issueClaimCode, provisionVirtualBox } from '../src/services/box';

/**
 * SCRUM-223 — a member of staff signs in at a booth with their own phone and
 * password, which the booth BOX forwards to `POST /box/v1/booth/staff/verify`
 * under its own credential.
 *
 * Two halves. The route on its own, against a booth box registered here, for
 * each of the four things that must be true and the throttle behind them. And
 * the whole relay, the way the staging demo runs it: a paired screen posts to
 * `/booth/staff/sign-in`, the api hands it to the booth on the virtual box in
 * this process, that booth's agent asks this route, and the answer is a
 * session with the person's name on the television and the slip.
 */

let ctx: TestContext;
let db: Db;
let operatorId: string;
let branchId: string;
let benchBox: string;
let benchBooth: string;
let boxAuthHeader: Record<string, string>;
let receptionId: string;
let blockedId: string;
let throttledId: string;

const BLOCKED = { phone: '+66900000077', password: 'blocked-pw-1' };
const THROTTLED = { phone: '+66900000078', password: 'throttled-pw-1' };

async function makeAccount(phone: string, password: string, nickname: string): Promise<string> {
  const employeeId = newId();
  await db.insert(employee).values({ id: employeeId, operatorId, name: `${nickname} (Test)`, nickname, phone, branchId });
  const id = newId();
  await db.insert(account).values({
    id,
    operatorId,
    employeeId,
    phone,
    passwordHash: await argonHash(password),
    status: 'active',
  });
  return id;
}

async function grantRole(accountId: string, roleName: string, permissions: string[] | null): Promise<void> {
  let roleId: string;
  if (permissions === null) {
    const [system] = await db.select({ id: role.id }).from(role).where(eq(role.name, roleName)).limit(1);
    roleId = system!.id;
  } else {
    roleId = newId();
    await db.insert(role).values({ id: roleId, operatorId, name: roleName, description: 'test role' });
    await db
      .insert(rolePermission)
      .values(permissions.map((permission) => ({ id: newId(), roleId, permission })));
  }
  await db.insert(roleAssignment).values({
    id: newId(),
    accountId,
    roleId,
    scopeType: 'branch',
    scopeId: branchId,
  });
}

async function verifyAt(stationId: string, phone: string, password: string, headers = boxAuthHeader) {
  return ctx.app.inject({
    method: 'POST',
    url: '/box/v1/booth/staff/verify',
    headers,
    payload: { stationId, phone, password },
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
  db = ctx.db;
  operatorId = await operatorIdByName(db, OTO_OPERATOR_NAME);
  branchId = await branchIdByCode(db, CENTRAL_BRANCH_CODE);

  // A booth box of its own, as Console → Devices → Add a box makes one, with a
  // booth station on it — so nothing here rotates the virtual box's secret.
  benchBox = newId();
  await db.insert(box).values({ id: benchBox, operatorId, branchId, name: 'Bench box', slot: 'bench-test', role: 'booth' });
  benchBooth = newId();
  await db.insert(station).values({
    id: benchBooth,
    operatorId,
    branchId,
    boxId: benchBox,
    name: 'Bench Booth',
    kind: 'booth',
    codePrefix: 'BT',
  });
  const { code } = await issueClaimCode(db, benchBox);
  const registered = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/register',
    payload: { claimCode: code, agentVersion: '0.1.0', hostname: 'bench-pi' },
  });
  expect(registered.statusCode).toBe(200);
  const body = registered.json() as { boxId: string; secret: string };
  boxAuthHeader = { authorization: `Bearer ${boxCredential(body.boxId, body.secret)}` };

  const [reception] = await db.select({ id: account.id }).from(account).where(eq(account.phone, RECEPTION.phone)).limit(1);
  receptionId = reception!.id;
  await db.insert(boothStaffAssignment).values({ id: newId(), stationId: benchBooth, accountId: receptionId, addedBy: receptionId });

  // Somebody on the booth whose role does not carry booth:staff:sign_in.
  blockedId = await makeAccount(BLOCKED.phone, BLOCKED.password, 'Blocked');
  await grantRole(blockedId, 'test_no_booth', ['pos:member:read']);
  await db.insert(boothStaffAssignment).values({ id: newId(), stationId: benchBooth, accountId: blockedId, addedBy: receptionId });

  // Somebody on the booth with the reception role, for the throttle.
  throttledId = await makeAccount(THROTTLED.phone, THROTTLED.password, 'Pim');
  await grantRole(throttledId, 'reception', null);
  await db.insert(boothStaffAssignment).values({ id: newId(), stationId: benchBooth, accountId: throttledId, addedBy: receptionId });
});

beforeEach(async () => {
  await _resetThrottle(db);
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('POST /box/v1/booth/staff/verify', () => {
  it('assigned and allowed: answers who it is, with the name and code the slip prints', async () => {
    const res = await verifyAt(benchBooth, '090 000 0002', RECEPTION.password);
    expect(res.statusCode).toBe(200);
    const [person] = await db
      .select({ name: employee.name, nickname: employee.nickname })
      .from(account)
      .innerJoin(employee, eq(employee.id, account.employeeId))
      .where(eq(account.id, receptionId))
      .limit(1);
    expect(res.json()).toEqual({
      accountId: receptionId,
      displayName: person!.nickname ?? person!.name,
      staffCode: boothStaffCode(receptionId),
    });
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'booth.staff_sign_in'), eq(auditLog.entityId, benchBooth)))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(row?.actorAccountId).toBe(receptionId);
    expect(JSON.stringify(row)).not.toContain(RECEPTION.password);
  });

  it('a wrong password and an unknown phone are the same 401, and neither is a 400', async () => {
    const wrong = await verifyAt(benchBooth, RECEPTION.phone, 'not-the-password');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('INVALID_CREDENTIALS');
    const unknown = await verifyAt(benchBooth, '+66911111111', 'whatever');
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
    const garbage = await verifyAt(benchBooth, 'not-a-phone', 'whatever');
    expect(garbage.statusCode).toBe(401);
  });

  it('no permission: the password is right, and the role may not sign in at a booth', async () => {
    const res = await verifyAt(benchBooth, BLOCKED.phone, BLOCKED.password);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('BOOTH_SIGN_IN_NOT_ALLOWED');
    // And a wrong password for the same person is the plain 401: the reason
    // is told only to somebody who proved they hold the password.
    const guess = await verifyAt(benchBooth, BLOCKED.phone, 'wrong');
    expect(guess.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('not assigned: a branch manager may sign in at booths, and is not on this one', async () => {
    const res = await verifyAt(benchBooth, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('BOOTH_STAFF_NOT_ASSIGNED');
  });

  it('a temporary password is refused until it is changed on the POS', async () => {
    await db.update(account).set({ mustChangePassword: true }).where(eq(account.id, throttledId));
    try {
      const res = await verifyAt(benchBooth, THROTTLED.phone, THROTTLED.password);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('MUST_CHANGE_PASSWORD');
    } finally {
      await db.update(account).set({ mustChangePassword: false }).where(eq(account.id, throttledId));
    }
  });

  it('five wrong passwords close the phone: the sixth attempt is refused even when right', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await verifyAt(benchBooth, THROTTLED.phone, `wrong-${i}`)).statusCode).toBe(401);
    }
    const locked = await verifyAt(benchBooth, THROTTLED.phone, THROTTLED.password);
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('BOOTH_STAFF_LOCKED');
    expect(locked.json().error.details.retryAfterS).toBeGreaterThan(0);
    // It is the sign-in screen's bucket too: one password, one budget.
    const pos = await ctx.app.inject({
      method: 'POST',
      url: '/auth/sign-in',
      payload: { phone: THROTTLED.phone, password: THROTTLED.password },
    });
    expect(pos.statusCode).toBe(429);
  });

  it('a right password for somebody who may not sign in here leaves the booth’s guesses counted', async () => {
    // One short of the booth's bucket, spread so that no single phone closes
    // first: the booth's count is the one under test.
    const perPhone = ctx.app.env.AUTH_MAX_FAILURES - 1;
    const ceiling = ctx.app.env.AUTH_MAX_FAILURES * BOOTH_BUCKET_FACTOR;
    let spent = 0;
    for (let phone = 1; spent < ceiling - 1; phone += 1) {
      for (let i = 0; i < perPhone && spent < ceiling - 1; i += 1, spent += 1) {
        const guess = await verifyAt(benchBooth, `+669111100${String(phone).padStart(2, '0')}`, `guess-${spent}`);
        expect(guess.statusCode).toBe(401);
      }
    }
    // A working account whose role may not sign in at a booth: the password is
    // right and the answer is 403 — and that must not reopen the booth.
    const blocked = await verifyAt(benchBooth, BLOCKED.phone, BLOCKED.password);
    expect(blocked.json().error.code).toBe('BOOTH_SIGN_IN_NOT_ALLOWED');
    // So the next wrong guess closes it, exactly as it would have without.
    expect((await verifyAt(benchBooth, '+66911110099', 'one-more')).statusCode).toBe(401);
    const closed = await verifyAt(benchBooth, RECEPTION.phone, RECEPTION.password);
    expect(closed.statusCode).toBe(429);
    expect(closed.json().error.code).toBe('BOOTH_STAFF_LOCKED');
  });

  it('only a sign-in that gets all the way in empties the booth’s count', async () => {
    const boothKey = `booth-staff:${benchBooth}`;
    const counted = async () =>
      (await db.select().from(authThrottle).where(eq(authThrottle.key, boothKey)))[0]?.failures ?? 0;
    for (let i = 0; i < 3; i += 1) {
      expect((await verifyAt(benchBooth, '+66911110077', `guess-${i}`)).statusCode).toBe(401);
    }
    expect(await counted()).toBe(3);
    // Right password, not on this booth's list: refused, and the count stands.
    expect((await verifyAt(benchBooth, BRANCH_MANAGER.phone, BRANCH_MANAGER.password)).statusCode).toBe(403);
    expect(await counted()).toBe(3);
    // On the list, with a role that may: in, and the booth starts again from nothing.
    expect((await verifyAt(benchBooth, RECEPTION.phone, RECEPTION.password)).statusCode).toBe(200);
    expect(await counted()).toBe(0);
  });

  it('a box may ask only about its own booths', async () => {
    const [booth1] = await db.select({ id: station.id }).from(station).where(eq(station.name, 'Booth 1')).limit(1);
    const res = await verifyAt(booth1!.id, RECEPTION.phone, RECEPTION.password);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('BOOTH_NOT_ON_THIS_BOX');
    const anonymous = await verifyAt(benchBooth, RECEPTION.phone, RECEPTION.password, {});
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('the staff scope a booth box pulls', () => {
  it('carries the name and code of the people on its booths, and nobody else’s', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/box/v1/cache?scopes=staff,deny_list',
      headers: boxAuthHeader,
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().scopes.staff.items as Array<Record<string, unknown>>;
    const reception = items.find((s) => s.accountId === receptionId);
    expect(reception?.staffCode).toBe(boothStaffCode(receptionId));
    expect(typeof reception?.displayName).toBe('string');
    const pim = items.find((s) => s.accountId === throttledId);
    expect(pim?.displayName).toBe('Pim');
    // Branch staff who may stand at this box but are on none of its booths
    // are carried — the booth station is open to the branch — without a name.
    const manager = items.find((s) => s.displayName === null);
    if (manager) expect(manager.staffCode).toBeNull();
  });
});

describe('the whole relay, as the staging demo runs it', () => {
  let agent: BoxAgent;
  let boothId: string;

  function injectTransport(): AgentFetch {
    return async (url, init) => {
      const res = await ctx.app.inject({
        method: init.method as 'GET',
        url: url.replace(/^https?:\/\/[^/]+/, ''),
        headers: init.headers,
        payload: init.body,
      });
      return {
        status: res.statusCode,
        json: async () => (res.body ? JSON.parse(res.body) : null),
        text: async () => res.body,
        header: (name) => {
          const value = res.headers[name.toLowerCase()];
          return typeof value === 'string' ? value : null;
        },
      };
    };
  }

  beforeAll(async () => {
    const [booth1] = await db.select().from(station).where(eq(station.name, 'Booth 1')).limit(1);
    boothId = booth1!.id;
    const pool = (db as unknown as { $client: PgPoolLike }).$client;
    agent = createBoxAgent({
      apiBaseUrl: 'http://relay.test',
      credentials: memoryCredentialStore(),
      hostname: 'relay-test',
      fetch: injectTransport(),
      claimCode: async () => (await provisionVirtualBox(db, ctx.app.log))?.claimCode ?? null,
      store: new SqlBoxStore({ driver: postgresBoxDriver(pool) }),
      booth: { randomIndex: (max) => randomInt(max), verifySecret: (h, s) => verifyArgon2(h, s) },
    });
    await agent.ensureRegistered();
    await agent.syncConfig();
    await agent.syncCache();
    await agent.booth()!.start();
    attachInProcessBox(agent);
  });

  afterAll(() => {
    agent?.booth()?.stop();
    agent?.stop();
    if (agent) detachInProcessBox(agent);
  });

  it('a paired screen signs reception in by phone and password, and shows the name', async () => {
    const adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const minted = await ctx.app.inject({
      method: 'POST',
      url: `/booths/${boothId}/pairing-codes`,
      headers: { cookie: adminCookie },
      payload: { label: 'Relay test screen' },
    });
    expect(minted.statusCode, minted.body).toBe(200);
    const paired = await ctx.app.inject({
      method: 'POST',
      url: '/booth/pair',
      payload: { code: (minted.json() as { pairingCode: string }).pairingCode },
    });
    expect(paired.statusCode, paired.body).toBe(200);
    const screen = { [BOOTH_DEVICE_HEADER]: (paired.json() as { deviceSecret: string }).deviceSecret };

    const signIn = await ctx.app.inject({
      method: 'POST',
      url: '/booth/staff/sign-in',
      headers: screen,
      payload: { mode: 'account', phone: RECEPTION.phone, password: RECEPTION.password },
    });
    expect(signIn.statusCode, signIn.body).toBe(200);
    expect(signIn.json()).toEqual({ ok: true });

    const status = await ctx.app.inject({ method: 'GET', url: '/booth/status', headers: screen });
    const body = status.json() as { staffSignedIn: boolean; staff: { code: string; method: string } };
    expect(body.staffSignedIn).toBe(true);
    expect(body.staff.code).toBe(boothStaffCode(receptionId));
    expect(body.staff.method).toBe('account');
    expect(JSON.stringify(body)).not.toContain(receptionId);

    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/booth/staff/sign-in',
      headers: screen,
      payload: { mode: 'account', phone: RECEPTION.phone, password: 'not-it' },
    });
    expect(wrong.json()).toEqual({ ok: false });

    // A reprint with somebody signed in goes to the box, which has nothing to
    // reprint yet — the path exists now, where it used to be a 404 route.
    const reprint = await ctx.app.inject({ method: 'POST', url: '/booth/reprint', headers: screen, payload: {} });
    expect(reprint.statusCode).toBe(404);
    expect(reprint.json().error.code).toBe('nothing_to_reprint');

    await ctx.app.inject({ method: 'POST', url: '/booth/staff/sign-out', headers: screen, payload: {} });
    const after = await ctx.app.inject({ method: 'GET', url: '/booth/status', headers: screen });
    expect((after.json() as { staff: unknown }).staff).toBeNull();
  });
});

// The branch row is read so the seed's shape is asserted, not assumed.
it('the bench booth sits at the seeded branch', async () => {
  const [row] = await db.select({ id: branch.id }).from(branch).where(eq(branch.id, branchId)).limit(1);
  expect(row?.id).toBe(branchId);
});
