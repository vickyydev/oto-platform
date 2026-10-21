import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { hash } from '@node-rs/argon2';
import { schema } from '@oto/db';
import { newId } from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  SECOND_OPERATOR_ADMIN,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-607 — reach. Each of these routes passed its guard and then acted on
 * something outside the caller's reach:
 *
 *   - `/admin/apps/*` and the account-owner path of `/files` read and changed
 *     an account with no branch tie asked, so a manager at one park reached a
 *     new hire at the other (the SCRUM-266 hole, on two more doors).
 *   - an operator administrator could retry the platform's own sweep and take
 *     the platform's own alert (`operator_id` null).
 *   - `POST /me/staff-token` minted for the seated station after the grant that
 *     seated it was gone.
 */

const keypair = generateKeyPairSync('ed25519');
const STAFF_TOKEN_PRIVATE_KEY = keypair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let ctx: TestContext;
let operatorId: string;
let central: string;
let chalong: string;
let admin: string;
let manager: string;
let delegate: string;
let secondOperatorAdmin: string;
/** A new hire at Chalong: an account, an employee record there, no role yet. */
let chalongHire: string;
/** The same at Central, which the Central manager and the delegate do reach. */
let centralHire: string;

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
const call = (method: Method, url: string, cookie: string, payload?: object) =>
  ctx.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });

async function systemRole(name: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: schema.role.id })
    .from(schema.role)
    .where(and(eq(schema.role.name, name), isNull(schema.role.operatorId)))
    .limit(1);
  return row!.id;
}

async function ownRole(name: string, permissions: string[]): Promise<string> {
  const id = newId();
  await ctx.db.insert(schema.role).values({ id, operatorId, name });
  for (const permission of permissions) {
    await ctx.db.insert(schema.rolePermission).values({ id: newId(), roleId: id, permission });
  }
  return id;
}

async function account(
  phone: string,
  password: string,
  opts: { worksAt?: string; grants?: Array<{ roleId: string; scopeType: 'operator' | 'branch'; scopeId: string }> } = {},
): Promise<string> {
  const id = newId();
  let employeeId: string | null = null;
  if (opts.worksAt) {
    employeeId = newId();
    await ctx.db.insert(schema.employee).values({ id: employeeId, operatorId, name: `Hire ${phone}`, branchId: opts.worksAt });
  }
  await ctx.db.insert(schema.account).values({ id, operatorId, employeeId, phone, status: 'active', passwordHash: await hash(password) });
  for (const g of opts.grants ?? []) {
    await ctx.db.insert(schema.roleAssignment).values({ id: newId(), accountId: id, ...g });
  }
  return id;
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { STAFF_TOKEN_PRIVATE_KEY } });
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  secondOperatorAdmin = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);

  chalongHire = await account('+66900060701', 'hire1234', { worksAt: chalong });
  centralHire = await account('+66900060702', 'hire1234', { worksAt: central });

  // Somebody who may hand out the Radar tile across the operator, and assign
  // access at Central only. Without the operator-wide tile `assertMayGrant`
  // refuses first, and the account check below would never be reached.
  const tile = await ownRole('Radar tile (607)', ['app:radar:access', 'app:oto_app:access']);
  const assigner = await ownRole('Central assigner (607)', ['admin:role:assign', 'admin:role:read']);
  await account('+66900060703', 'deleg1234', {
    grants: [
      { roleId: tile, scopeType: 'operator', scopeId: operatorId },
      { roleId: assigner, scopeType: 'branch', scopeId: central },
    ],
  });
  delegate = await signInAs(ctx.app, '+66900060703', 'deleg1234');
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('/admin/apps reaches only the accounts the caller manages (SCRUM-607)', () => {
  it('a manager reads the app identities of a hire at their park, not at the other', async () => {
    expect((await call('GET', `/admin/apps/users/${centralHire}`, manager)).statusCode).toBe(200);
    const res = await call('GET', `/admin/apps/users/${chalongHire}`, manager);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('OUT_OF_BRANCH_SCOPE');
  });

  it('linking an existing account at another park is refused, and nothing is linked', async () => {
    const res = await call('POST', '/admin/apps/radar/users', delegate, {
      externalUserId: 'radar-607',
      accountId: chalongHire,
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('OUT_OF_BRANCH_SCOPE');
    const links = await ctx.db.select().from(schema.appIdentity).where(eq(schema.appIdentity.accountId, chalongHire));
    expect(links).toEqual([]);
  });

  it('linking a hire at the delegate’s own park still works', async () => {
    const res = await call('POST', '/admin/apps/radar/users', delegate, {
      externalUserId: 'radar-607-central',
      accountId: centralHire,
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('changing the OTO App branches of, or unlinking, an account at another park is refused', async () => {
    const put = await call('PUT', `/admin/apps/oto_app/users/${chalongHire}/branches`, delegate, { branchIds: [central] });
    expect(put.statusCode, put.body).toBe(403);
    expect(put.json().error.code).toBe('OUT_OF_BRANCH_SCOPE');
    const del = await call('DELETE', `/admin/apps/radar/users/${chalongHire}`, delegate);
    expect(del.statusCode, del.body).toBe(403);
    expect(del.json().error.code).toBe('OUT_OF_BRANCH_SCOPE');
  });
});

describe('a staff photo is reached only by whoever manages the account (SCRUM-607)', () => {
  let chalongPhoto: string;

  beforeAll(async () => {
    chalongPhoto = newId();
    await ctx.db.insert(schema.fileObject).values({
      id: chalongPhoto,
      operatorId,
      bucket: 'oto',
      objectKey: `${operatorId}/account/${chalongHire}/photo.jpg`,
      contentType: 'image/jpeg',
      ownerEntityType: 'account',
      ownerEntityId: chalongHire,
    });
  });

  it('a manager at one park cannot register a photo on a hire at the other', async () => {
    const res = await call('POST', '/files', manager, {
      contentType: 'image/jpeg',
      ownerEntityType: 'account',
      ownerEntityId: chalongHire,
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('OUT_OF_BRANCH_SCOPE');
  });

  it('nor read one', async () => {
    const res = await call('GET', `/files/${chalongPhoto}/url`, manager);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('OUT_OF_BRANCH_SCOPE');
  });

  it('the operator administrator passes the check (storage is not configured in this suite)', async () => {
    const res = await call('GET', `/files/${chalongPhoto}/url`, admin);
    expect(res.statusCode, res.body).not.toBe(403);
    expect(res.statusCode).not.toBe(404);
  });
});

describe('the platform’s own runs and alerts are a platform-wide caller’s (SCRUM-607)', () => {
  const platformRun = async (): Promise<string> => {
    const id = newId();
    await ctx.db.insert(schema.opsRun).values({
      id,
      kind: 'job',
      name: 'job:housekeeping.handoff',
      outcome: 'failed',
      errorCode: 'TEST',
      errorMessage: 'the sweep fell over',
      startedAt: new Date(),
      finishedAt: new Date(),
      durationMs: 5,
      operatorId: null,
    });
    return id;
  };
  const platformAlert = async (key: string): Promise<string> => {
    const id = newId();
    await ctx.db.insert(schema.alert).values({
      id,
      key,
      category: 'ops.missing',
      severity: 'warning',
      subject: key,
      summary: `${key} has not succeeded for an hour`,
      operatorId: null,
    });
    return id;
  };

  it('an operator administrator gets 404 on a platform run and a platform alert', async () => {
    const run = await platformRun();
    expect((await call('POST', `/ops/runs/${run}/retry`, secondOperatorAdmin, {})).statusCode).toBe(404);
    const alertId = await platformAlert('ops.missing:job:platform-607');
    expect((await call('POST', `/ops/alerts/${alertId}/acknowledge`, secondOperatorAdmin, {})).statusCode).toBe(404);
    const [row] = await ctx.db.select().from(schema.alert).where(eq(schema.alert.id, alertId));
    expect(row!.status).toBe('open');
  });

  it('a platform-wide caller still retries and acknowledges them', async () => {
    const run = await platformRun();
    const retried = await call('POST', `/ops/runs/${run}/retry`, admin, {});
    // Found and passed through: this suite's api carries no jobs role, so the
    // route answers that nothing ran rather than "no such run".
    expect(retried.statusCode, retried.body).toBe(409);
    expect(retried.json().error.code).toBe('JOBS_ROLE_ABSENT');
    const alertId = await platformAlert('ops.missing:job:platform-607-ok');
    const taken = await call('POST', `/ops/alerts/${alertId}/acknowledge`, admin, {});
    expect(taken.statusCode, taken.body).toBe(200);
  });
});

describe('a shift token is minted only while the grant at the station’s park holds (SCRUM-607)', () => {
  async function seatedAtCentral(phone: string, tillName: string): Promise<{ cookie: string; accountId: string }> {
    const accountId = await account(phone, 'till1234', {
      grants: [{ roleId: await systemRole('reception'), scopeType: 'branch', scopeId: central }],
    });
    const cookie = await signInAs(ctx.app, phone, 'till1234');
    const [till] = await ctx.db
      .select({ id: schema.station.id })
      .from(schema.station)
      .where(and(eq(schema.station.branchId, central), eq(schema.station.name, tillName)))
      .limit(1);
    await takeStation(ctx.app, cookie, till!.id);
    return { cookie, accountId };
  }

  it('mints for an honest seated session', async () => {
    const { cookie } = await seatedAtCentral('+66900060704', 'Reception Till 1');
    const res = await call('POST', '/me/staff-token', cookie);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('refuses once the grant at that park is taken away, though the seat remains', async () => {
    const { cookie, accountId } = await seatedAtCentral('+66900060705', 'Counter 2');
    await ctx.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.accountId, accountId));
    const res = await call('POST', '/me/staff-token', cookie);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('STATION_OTHER_BRANCH');
  });
});
