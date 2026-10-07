import { generateKeyPairSync } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  benefitCredential,
  employee,
  idempotencyKey,
  signingKey,
  station,
  stationEvent,
} from '@oto/db';
import {
  createBoxAgent,
  memoryCredentialStore,
  type AgentFetch,
  type BoxAgent,
} from '@oto/box-agent';
import {
  BENEFIT_QR_NOT_A_SIGN_IN,
  BenefitScopeItemSchema,
  type BenefitScopeItem,
} from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  OTO_OPERATOR_NAME,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  createTestContext,
  operatorIdByName,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';
import { buildApp } from '../src/app';
import { loadEnv } from '../src/env';
import { boxStoreFor } from '../src/lib/box-store';
import { staffTokenKid } from '../src/lib/staff-token-key';
import { provisionVirtualBox } from '../src/services/box';

/**
 * S2-21 (SCRUM-218) round 2 — the staff benefit QR, through the real routes
 * (plan docs/progress/plans/benefits/PLAN.md §8 round 2).
 *
 * The round's acceptance, as the plan words it:
 *   - check 3's revoked case: "a revoked credential is refused with 'benefit
 *     revoked' and changes nothing" — at the cloud at once, and on the box
 *     from its next pull of the `benefits` scope;
 *   - check 6's "a benefit QR is refused at sign-in and at the gate reader" —
 *     sign-in and the till's badge path here; the gate reader and the booth
 *     badge path on the box (`packages/box-agent/test/gate-host.test.ts`,
 *     `booth.test.ts`, `benefit-credential.test.ts`).
 *
 * The box half is the real agent on the store the routes read, pulling
 * `GET /box/v1/cache` through `app.inject`, as the shift-token suite does.
 */

const keys = generateKeyPairSync('ed25519');
const PRIVATE_KEY = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const KID = staffTokenKid(keys.publicKey.export({ type: 'spki', format: 'pem' }).toString());

let ctx: TestContext;
let admin: string;
let manager: string;
let reception: string;
let foreignAdmin: string;
let operatorId: string;
let tillId: string;
let boxId: string;
let agent: BoxAgent;
const people: Record<'anan' | 'som' | 'nok' | 'lek' | 'dao', string> = {
  anan: '',
  som: '',
  nok: '',
  lek: '',
  dao: '',
};

let n = 0;
const idem = () => `benefits-r2-${Date.now()}-${n++}`;

async function call<T = Record<string, unknown>>(
  method: 'GET' | 'POST',
  url: string,
  cookie: string | null,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T; headers: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(method === 'POST' && cookie ? { 'idempotency-key': idem() } : {}),
      ...headers,
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return {
    status: res.statusCode,
    body: (res.body ? res.json() : {}) as T,
    headers: res.headers as Record<string, unknown>,
  };
}

interface Credential {
  id: string;
  employeeId: string;
  status: string;
  kid: string;
  revokedAt: string | null;
}

async function issue(employeeId: string, cookie = admin) {
  return call<{ credential: Credential; error?: { code: string; message: string } }>(
    'POST',
    '/benefits/credentials',
    cookie,
    { employeeId },
  );
}

async function qrOf(credentialId: string, cookie = admin) {
  return call<{ code: string; name: string; error?: { code: string } }>(
    'GET',
    `/benefits/credentials/${credentialId}/qr`,
    cookie,
  );
}

async function resolve(code: string, cookie = reception) {
  return call<{
    employeeId: string;
    name: string;
    benefitRole: string;
    profile: Record<string, unknown>;
    offline: { comp: boolean; standingDiscount: unknown; onlineOnly: string[] };
    error?: { code: string; message: string };
  }>('POST', '/benefits/resolve', cookie, { code });
}

async function auditRows(action: string, entityId?: string) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(
      entityId
        ? and(eq(auditLog.action, action), eq(auditLog.entityId, entityId))
        : eq(auditLog.action, action),
    );
}

function injectTransport(): AgentFetch {
  return async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const res = await ctx.app.inject({
      method: init.method as 'GET',
      url: path,
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

/** The `benefits` scope as this box last applied it. */
async function heldScope(): Promise<BenefitScopeItem | null> {
  const held = await boxStoreFor(ctx.db).readBundle(boxId, 'benefits');
  const item = (held?.payload as { items?: unknown[] } | undefined)?.items?.[0];
  const parsed = BenefitScopeItemSchema.safeParse(item);
  return parsed.success ? parsed.data : null;
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { BENEFIT_QR_PRIVATE_KEY: PRIVATE_KEY } });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  foreignAdmin = await signInAs(
    ctx.app,
    SECOND_OPERATOR_ADMIN.phone,
    SECOND_OPERATOR_ADMIN.password,
  );
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  const rows = await ctx.db
    .select({ id: employee.id, name: employee.name })
    .from(employee)
    .where(eq(employee.operatorId, operatorId));
  const byName = (name: string) => rows.find((r) => r.name === name)!.id;
  people.anan = byName('Khun Anan (Owner)');
  people.som = byName('Som (Reception)');
  people.nok = byName('Nok (Reception)');
  people.lek = byName('Khun Lek (Manager)');
  people.dao = byName('Khun Dao (Manager)');

  const till = (await ctx.db.select().from(station)).find((s) => s.name === 'Reception Till 1')!;
  tillId = till.id;
  boxId = till.boxId!;
  agent = createBoxAgent({
    apiBaseUrl: 'http://virtual-box.test',
    credentials: memoryCredentialStore(),
    hostname: 'benefits-r2',
    fetch: injectTransport(),
    claimCode: async () => (await provisionVirtualBox(ctx.db, ctx.app.log))?.claimCode ?? null,
    store: boxStoreFor(ctx.db),
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  expect(agent.state.boxId).toBe(boxId);
}, 180_000);

afterAll(async () => {
  agent?.stop();
  await ctx?.close();
  await teardownAll();
});

describe('issuing a benefit QR (admin:benefit:credential_issue)', () => {
  let ananCredential: Credential;

  it('issues an Ed25519 QR under the benefit_qr key, publishes its public half, and audits no key material', async () => {
    const res = await issue(people.anan);
    expect(res.status).toBe(200);
    ananCredential = res.body.credential;
    expect(ananCredential).toMatchObject({ employeeId: people.anan, status: 'active', kid: KID });

    const [key] = await ctx.db
      .select()
      .from(signingKey)
      .where(and(eq(signingKey.purpose, 'benefit_qr'), eq(signingKey.kid, KID)));
    expect(key?.publicKey).toContain('BEGIN PUBLIC KEY');

    const qr = await qrOf(ananCredential.id);
    expect(qr.status).toBe(200);
    expect(qr.headers['cache-control']).toBe('no-store');
    expect(qr.body.name).toBe('Khun Anan (Owner)');
    expect(qr.body.code.startsWith(`OTO-BEN:v1:${people.anan}:${ananCredential.id}:`)).toBe(true);
    // Re-derived, and the same every time: the database holds no QR.
    expect((await qrOf(ananCredential.id)).body.code).toBe(qr.body.code);
    const [row] = await ctx.db
      .select()
      .from(benefitCredential)
      .where(eq(benefitCredential.id, ananCredential.id));
    expect(JSON.stringify(row)).not.toContain(qr.body.code);

    const [audited] = await auditRows('benefit.credential_issue', ananCredential.id);
    expect(audited).toBeTruthy();
    const written = JSON.stringify([audited!.before, audited!.after]);
    expect(written).not.toContain(qr.body.code);
    expect(written).not.toContain(qr.body.code.split('.').pop()!);
    expect(written).not.toContain(row!.codeHash);
    expect(written).not.toContain('PRIVATE KEY');
    expect(audited!.after).toMatchObject({ employeeId: people.anan, kid: KID });
  });

  it('refuses a second live QR for the same person, and anybody with no benefit role', async () => {
    const again = await issue(people.anan);
    expect(again.status).toBe(409);
    expect(again.body.error!.code).toBe('BENEFIT_CREDENTIAL_LIVE');
    const dao = await issue(people.dao);
    expect(dao.status).toBe(409);
    expect(dao.body.error!.code).toBe('BENEFIT_NO_ROLE');
    const rows = await ctx.db
      .select()
      .from(benefitCredential)
      .where(inArray(benefitCredential.employeeId, [people.anan, people.dao]));
    expect(rows).toHaveLength(1);
    expect(await auditRows('benefit.credential_issue')).toHaveLength(1);
  });

  it('replays a retried issue as the same QR record, never a second', async () => {
    const key = idem();
    const first = await call<{ credential: Credential }>(
      'POST',
      '/benefits/credentials',
      admin,
      { employeeId: people.som },
      { 'idempotency-key': key },
    );
    const second = await call<{ credential: Credential }>(
      'POST',
      '/benefits/credentials',
      admin,
      { employeeId: people.som },
      { 'idempotency-key': key },
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.credential.id).toBe(first.body.credential.id);
    expect(
      await ctx.db
        .select()
        .from(benefitCredential)
        .where(eq(benefitCredential.employeeId, people.som)),
    ).toHaveLength(1);
  });

  it('who may: a branch manager reads and cannot print, issue or revoke; reception resolves and nothing else', async () => {
    expect(
      (await call('GET', `/benefits/credentials?employeeId=${people.anan}`, manager)).status,
    ).toBe(200);
    expect((await issue(people.lek, manager)).status).toBe(403);
    expect((await qrOf(ananCredential.id, manager)).status).toBe(403);
    expect(
      (await call('POST', `/benefits/credentials/${ananCredential.id}/revoke`, manager, {})).status,
    ).toBe(403);
    expect((await call('GET', '/benefits/credentials', reception)).status).toBe(403);
    expect((await issue(people.lek, reception)).status).toBe(403);
    // Another operator's QR does not exist for them.
    expect((await qrOf(ananCredential.id, foreignAdmin)).status).toBe(404);
    expect(
      (await call('POST', `/benefits/credentials/${ananCredential.id}/revoke`, foreignAdmin, {}))
        .status,
    ).toBe(404);
    // Nothing was written by any refusal.
    expect(await auditRows('benefit.credential_revoke')).toHaveLength(0);
  });

  it('answers 503 naming the variable where the deployment has no benefit QR key', async () => {
    const bare = await buildApp({
      env: loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://unused/unused' }),
      db: ctx.db,
      fileStorage: null,
    });
    try {
      const cookie = await signInAs(bare, ADMIN.phone, ADMIN.password);
      const res = await bare.inject({
        method: 'POST',
        url: '/benefits/credentials',
        headers: { cookie },
        payload: { employeeId: people.lek },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('BENEFIT_QR_UNAVAILABLE');
      expect(res.json().error.message).toContain('BENEFIT_QR_PRIVATE_KEY');
    } finally {
      await bare.close();
    }
  });
});

describe('resolving a scanned QR (POST /benefits/resolve)', () => {
  let ananCode = '';
  let lekCode = '';

  beforeAll(async () => {
    const [anan] = (
      await call<{ credentials: Credential[] }>(
        'GET',
        `/benefits/credentials?employeeId=${people.anan}`,
        admin,
      )
    ).body.credentials;
    ananCode = (await qrOf(anan!.id)).body.code;
    const lek = (await issue(people.lek)).body.credential;
    lekCode = (await qrOf(lek.id)).body.code;
  });

  it('names the person and today’s profile — the owner’s comp, the manager’s stages with only comp and percent offline', async () => {
    const owner = await resolve(ananCode);
    expect(owner.status).toBe(200);
    expect(owner.body).toMatchObject({
      employeeId: people.anan,
      name: 'Khun Anan (Owner)',
      benefitRole: 'owner',
    });
    expect(owner.body.profile.comp).toBe(true);
    expect(owner.body.offline.comp).toBe(true);

    const mgr = await resolve(lekCode);
    expect(mgr.status).toBe(200);
    expect(mgr.body.benefitRole).toBe('manager');
    expect(mgr.body.profile.credit).toBeTruthy();
    expect(mgr.body.offline.comp).toBe(false);
    expect(mgr.body.offline.standingDiscount).toMatchObject({ percent: 30 });
    expect(mgr.body.offline.onlineOnly).toEqual(['freeItems', 'credit']);
  });

  it('refuses what this park did not issue in the prototype’s words', async () => {
    const mock = await resolve('OTO-BENEFIT-OP-4');
    expect(mock.status).toBe(404);
    expect(mock.body.error!.message).toBe('No staff benefit found for "OTO-BENEFIT-OP-4".');
    const tampered = lekCode.replace(people.lek, people.anan);
    const forged = await resolve(tampered);
    expect(forged.status).toBe(404);
    expect(forged.body.error!.code).toBe('BENEFIT_CREDENTIAL_INVALID');
    // Echoed up to its signature and no further: the signature on an altered
    // QR is still the genuine QR's own.
    expect(forged.body.error!.message).toBe(
      `No staff benefit found for "${tampered.slice(0, tampered.lastIndexOf('.'))}".`,
    );
  });

  it('a person who has left is refused, and their QR joins the box’s list', async () => {
    await ctx.db
      .update(employee)
      .set({ archivedAt: new Date() })
      .where(eq(employee.id, people.lek));
    try {
      const left = await resolve(lekCode);
      expect(left.status).toBe(409);
      expect(left.body.error!.code).toBe('BENEFIT_EMPLOYEE_LEFT');
      await agent.syncCache();
      expect((await heldScope())!.revokedEmployeeIds).toContain(people.lek);
    } finally {
      await ctx.db.update(employee).set({ archivedAt: null }).where(eq(employee.id, people.lek));
    }
  });
});

describe('check 3’s revoked case: refused with "benefit revoked", and nothing changes', () => {
  let credential: Credential;
  let code = '';

  beforeAll(async () => {
    credential = (await issue(people.nok)).body.credential;
    code = (await qrOf(credential.id)).body.code;
  });

  it('the box holds the scope: keys, no amounts, and the QR checks out offline before the revocation', async () => {
    await agent.syncCache();
    const scope = (await heldScope())!;
    expect(scope.keys.map((k) => k.kid)).toContain(KID);
    expect(
      scope.keys.every((k) => k.purpose === 'benefit_qr' && !k.publicKey.includes('PRIVATE')),
    ).toBe(true);
    const nok = scope.employees.find((e) => e.employeeId === people.nok)!;
    expect(nok.days[0]).toMatchObject({
      benefitRole: 'staff',
      comp: false,
      onlineOnly: ['freeItems'],
    });
    // Quotas stay in the cloud: no quota, no amount, no item list on the box.
    expect(JSON.stringify(scope)).not.toMatch(/quotaPerPeriod|amountSatang/);

    const onBox = await agent.scanner()!.deliver(tillId, { code, source: 'simulator' });
    expect(onBox.outcome).toBe('handled');
    expect((onBox.detail?.benefit as { name: string }).name).toBe('Nok (Reception)');
  });

  it('the till’s scan door hands the QR to the staff screen and never keeps that answer under a key; other scans still replay', async () => {
    const key = idem();
    const scanned = await call<{ outcome: string; detail?: { benefitCode?: string } }>(
      'POST',
      `/stations/${tillId}/scan`,
      admin,
      { code, source: 'camera' },
      { 'idempotency-key': key },
    );
    expect(scanned.status).toBe(200);
    expect(scanned.body.outcome).toBe('handled');
    expect(scanned.body.detail?.benefitCode).toBe(code);
    // Given back rather than kept: nothing under the key to replay for a day.
    expect(
      await ctx.db.select().from(idempotencyKey).where(eq(idempotencyKey.key, key)),
    ).toHaveLength(0);

    // `scannedCredential` keeps out only an answer that carries one: any other
    // scan's answer is kept, so a retried scan is not a second scan.
    const other = idem();
    const scan = () =>
      call(
        'POST',
        `/stations/${tillId}/scan`,
        admin,
        { code: 'NOT-A-CODE-OF-OURS', source: 'camera' },
        { 'idempotency-key': other },
      );
    const first = await scan();
    const again = await scan();
    expect(first.status).toBe(200);
    expect(again.headers['x-oto-replay']).toBe('true');
    expect(again.body).toEqual(first.body);
  });

  it('the cloud refuses it from the moment it is revoked; the box from its next pull', async () => {
    const revoked = await call<{ changed: boolean; credential: Credential }>(
      'POST',
      `/benefits/credentials/${credential.id}/revoke`,
      admin,
      {},
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body.changed).toBe(true);
    expect(revoked.body.credential.status).toBe('revoked');

    const [before] = await ctx.db
      .select()
      .from(benefitCredential)
      .where(eq(benefitCredential.id, credential.id));
    const cloud = await resolve(code);
    expect(cloud.status).toBe(409);
    expect(cloud.body.error!.code).toBe('BENEFIT_REVOKED');
    expect(cloud.body.error!.message).toMatch(/^Benefit revoked/);
    // Changes nothing: not even when it was last seen.
    const [after] = await ctx.db
      .select()
      .from(benefitCredential)
      .where(eq(benefitCredential.id, credential.id));
    expect(after).toEqual(before);
    // And it is no longer printable.
    expect((await qrOf(credential.id)).body.error!.code).toBe('BENEFIT_REVOKED');

    // The box, until it pulls, still holds yesterday's list — the bound is the
    // pull, as for a shift token. After the pull it refuses.
    await agent.syncCache();
    expect((await heldScope())!.revokedCredentialIds).toContain(credential.id);
    const onBox = await agent.scanner()!.deliver(tillId, { code, source: 'simulator' });
    expect(onBox.outcome).toBe('refused');
    expect(onBox.errorCode).toBe('BENEFIT_REVOKED');
    expect(String(onBox.detail?.message)).toMatch(/^Benefit revoked/);

    // The same through the till's own scan door, answered from the box's copy.
    const viaRoute = await call<{
      kind: string;
      outcome: string;
      errorCode: string;
      detail?: { benefitCode?: string };
    }>('POST', `/stations/${tillId}/scan`, admin, { code, source: 'camera' });
    expect(viaRoute.status).toBe(200);
    expect(viaRoute.body).toMatchObject({
      kind: 'benefit',
      outcome: 'refused',
      errorCode: 'BENEFIT_REVOKED',
    });
    expect(viaRoute.body.detail?.benefitCode).toBeUndefined();
  });

  it('revoking twice changes nothing and records nothing more', async () => {
    const again = await call<{ changed: boolean }>(
      'POST',
      `/benefits/credentials/${credential.id}/revoke`,
      admin,
      {},
    );
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    const rows = await auditRows('benefit.credential_revoke', credential.id);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify([rows[0]!.before, rows[0]!.after])).not.toContain(code);
    expect(rows[0]!.after).toMatchObject({ employeeId: people.nok, kid: KID });
  });

  it('a new QR can then be issued, and the revoked one stays refused', async () => {
    const fresh = await issue(people.nok);
    expect(fresh.status).toBe(200);
    expect(fresh.body.credential.id).not.toBe(credential.id);
    expect((await resolve((await qrOf(fresh.body.credential.id)).body.code)).status).toBe(200);
    expect((await resolve(code)).status).toBe(409);
  });
});

describe('check 6: a benefit QR is refused at sign-in (the gate reader and the booth: box suite)', () => {
  let code = '';

  beforeAll(async () => {
    const [anan] = (
      await call<{ credentials: Credential[] }>(
        'GET',
        `/benefits/credentials?employeeId=${people.anan}`,
        admin,
      )
    ).body.credentials;
    code = (await qrOf(anan!.id)).body.code;
  });

  it('sign-in: a QR read into the phone field opens no session and is no attempt on anybody', async () => {
    const failuresBefore = (await auditRows('auth.sign_in_failed')).length;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/sign-in',
      payload: { phone: code, password: 'anything' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: 'BENEFIT_NOT_A_SIGN_IN',
      message: BENEFIT_QR_NOT_A_SIGN_IN,
    });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((await auditRows('auth.sign_in_failed')).length).toBe(failuresBefore);
  });

  it('the till’s badge path: refused before the box sees it — no tape line, nothing handed to a screen', async () => {
    await takeStation(ctx.app, reception, tillId);
    const tapeBefore = await ctx.db
      .select({ id: stationEvent.id })
      .from(stationEvent)
      .where(eq(stationEvent.stationId, tillId))
      .orderBy(desc(stationEvent.receivedAt));
    const res = await call<{ outcome: string; handler: string | null; message: string }>(
      'POST',
      '/auth/badge',
      reception,
      { value: code, source: 'keyboard' },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      outcome: 'refused',
      handler: null,
      message: BENEFIT_QR_NOT_A_SIGN_IN,
    });
    const tapeAfter = await ctx.db
      .select({ id: stationEvent.id })
      .from(stationEvent)
      .where(eq(stationEvent.stationId, tillId));
    expect(tapeAfter.length).toBe(tapeBefore.length);
  });
});
