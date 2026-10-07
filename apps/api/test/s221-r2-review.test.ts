import fs from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  authThrottle,
  benefitCredential,
  box,
  employee,
  idempotencyKey,
  role,
  roleAssignment,
  rolePermission,
  session,
  signingKey,
  station,
  stationEvent,
} from '@oto/db';
import {
  benefitCredentialHash,
  createBoxAgent,
  encodeBenefitCredential,
  memoryCredentialStore,
  type AgentFetch,
  type BoxAgent,
} from '@oto/box-agent';
import {
  BENEFIT_QR_NOT_A_SIGN_IN,
  BENEFIT_WORDS,
  BenefitScopeItemSchema,
  newId,
  normalizePhone,
  type BenefitScopeItem,
} from '@oto/shared';
import { hash } from '@node-rs/argon2';
import {
  ADMIN,
  BRANCH_MANAGER,
  OTO_OPERATOR_NAME,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  SECOND_OPERATOR_NAME,
  createTestContext,
  operatorIdByName,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { staffTokenKid } from '../src/lib/staff-token-key';
import { boxAuthFromRow, provisionVirtualBox } from '../src/services/box';
import { cacheBundle } from '../src/services/sync';

/**
 * SCRUM-218 review of lane I round 2 — the staff benefit QR, attacked from
 * outside the builder's own suite (`benefits-r2.test.ts`):
 *
 *   1. The crypto path. A forged payload, every tampered field, a signature
 *      under another operator's key, under a key that has not started and under
 *      a retired one, an expired QR and a longer-lived copy of a real one — each
 *      refused by the cloud AND by a real box agent, with nothing written.
 *   2. Revocation. Revoked, then scanned at the cloud (refused at once) and at a
 *      box holding a stale bundle, before and after its refresh; the bundle's
 *      version moves and its diff is the revocation and nothing else; a
 *      re-issue is a NEW credential and the old one stays dead everywhere.
 *   3. The `benefits` scope: exactly the plan's fields, no quotas or amounts,
 *      no person beyond those the scan screen can name, nothing of another
 *      operator's.
 *   4. The refusal points the api owns, driven: sign-in and the till's badge
 *      path (the gate reader and the booth: `packages/box-agent/test/
 *      s221-r2-review.test.ts`).
 *   5. Who may: `admin:benefit:credential_issue` and nothing else opens issue,
 *      print and revoke; idempotent issue and revoke by key; the audit rows.
 *
 * And across all of it: no key material and no printed QR in any audit row, in
 * any idempotency row, in any tape row or in any log line the api writes.
 */

// --- The log, captured --------------------------------------------------------
//
// The api's logger is pino on a SonicBoom over fd 1, silent under test. For
// this file it logs everything, and every line is kept here instead of being
// printed, so the last test can read them all.

const logLines: string[] = [];
const fsMutable = fs as unknown as {
  write: (...args: unknown[]) => unknown;
  writeSync: (...args: unknown[]) => unknown;
};
const realWrite = fsMutable.write;
const realWriteSync = fsMutable.writeSync;
const priorLogLevel = process.env.LOG_LEVEL;
const asText = (data: unknown): string =>
  typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
const byteLength = (data: unknown): number =>
  typeof data === 'string'
    ? Buffer.byteLength(data, 'utf8')
    : Buffer.isBuffer(data)
      ? data.length
      : 0;
fsMutable.write = (...args: unknown[]) => {
  const [fd, data] = args;
  if (fd !== 1 && fd !== 2) return realWrite.apply(fs, args);
  logLines.push(asText(data));
  const callback = args[args.length - 1];
  if (typeof callback === 'function') {
    process.nextTick(() => (callback as (err: null, n: number) => void)(null, byteLength(data)));
  }
  return undefined;
};
fsMutable.writeSync = (...args: unknown[]) => {
  const [fd, data] = args;
  if (fd !== 1 && fd !== 2) return realWriteSync.apply(fs, args);
  logLines.push(asText(data));
  return byteLength(data);
};
process.env.LOG_LEVEL = 'trace';

// --- Keys -----------------------------------------------------------------------

function keypair() {
  const pair = generateKeyPairSync('ed25519');
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { privateKeyPem, publicKeyPem, kid: staffTokenKid(publicKeyPem) };
}

/** The deployment's key: what `BENEFIT_QR_PRIVATE_KEY` holds. */
const PARK = keypair();
/** The second operator's own `benefit_qr` key. */
const FOREIGN = keypair();
/** A platform key published ahead of a rotation: `not_before` tomorrow. */
const NEXT = keypair();

const PEM_BODY = (pem: string) =>
  pem
    .replace(/-----[^-]+-----/g, '')
    .replace(/\s+/g, '')
    .slice(0, 40);

// --- State ------------------------------------------------------------------------

let ctx: TestContext;
let operatorId: string;
let secondOperatorId: string;
let tillId: string;
let boxId: string;
let agent: BoxAgent;
const cookies: Record<
  'admin' | 'manager' | 'reception' | 'foreign' | 'manageOnly' | 'issueOnly',
  string
> = { admin: '', manager: '', reception: '', foreign: '', manageOnly: '', issueOnly: '' };
const accountIds: Record<string, string> = {};
const people: Record<'anan' | 'som' | 'nok' | 'lek' | 'dao', string> = {
  anan: '',
  som: '',
  nok: '',
  lek: '',
  dao: '',
};
/** Every QR this file was handed or minted that verifies somewhere — none may be written down. */
const printed = new Set<string>();

let n = 0;
const idem = () => `s221-r2-review-${process.pid}-${Date.now()}-${n++}`;

interface Envelope {
  error?: { code: string; message: string; details?: unknown };
}

async function call<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  cookie: string | null,
  payload?: unknown,
  headers: Record<string, string | undefined> = {},
): Promise<{ status: number; body: T & Envelope; headers: Record<string, unknown> }> {
  const sent: Record<string, string> = {};
  if (cookie) sent.cookie = cookie;
  // A write carries a key unless the caller says otherwise with `undefined`.
  if (method !== 'GET' && cookie && !('idempotency-key' in headers))
    sent['idempotency-key'] = idem();
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) sent[k] = v;
  const res = await ctx.app.inject({
    method,
    url,
    headers: sent,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return {
    status: res.statusCode,
    body: (res.body ? res.json() : {}) as T & Envelope,
    headers: res.headers as Record<string, unknown>,
  };
}

interface Credential {
  id: string;
  employeeId: string;
  status: string;
  kid: string;
  expiresAt: string;
  revokedAt: string | null;
}

const issue = (employeeId: string, cookie = cookies.admin, key?: string) =>
  call<{ credential: Credential }>(
    'POST',
    '/benefits/credentials',
    cookie,
    { employeeId },
    key ? { 'idempotency-key': key } : {},
  );

async function qrOf(credentialId: string, cookie = cookies.admin) {
  const res = await call<{ code: string; name: string }>(
    'GET',
    `/benefits/credentials/${credentialId}/qr`,
    cookie,
  );
  if (res.status === 200) printed.add(res.body.code);
  return res;
}

/** Resolved with NO idempotency key, so "nothing written" means nothing at all. */
const resolve = (code: string, cookie = cookies.reception) =>
  call<{ employeeId: string; name: string; credentialId: string }>(
    'POST',
    '/benefits/resolve',
    cookie,
    { code },
    { 'idempotency-key': undefined },
  );

const revoke = (credentialId: string, cookie = cookies.admin, key?: string) =>
  call<{ changed: boolean; credential: Credential }>(
    'POST',
    `/benefits/credentials/${credentialId}/revoke`,
    cookie,
    {},
    key ? { 'idempotency-key': key } : {},
  );

const scanAtTill = (code: string) =>
  call<{
    kind: string;
    outcome: string;
    handler: string | null;
    errorCode: string | null;
    detail?: Record<string, unknown>;
  }>('POST', `/stations/${tillId}/scan`, cookies.admin, { code, source: 'camera' });

const onBox = (code: string) => agent.scanner()!.deliver(tillId, { code, source: 'simulator' });

async function heldScope(): Promise<BenefitScopeItem | null> {
  const held = await boxStoreFor(ctx.db).readBundle(boxId, 'benefits');
  const item = (held?.payload as { items?: unknown[] } | undefined)?.items?.[0];
  const parsed = BenefitScopeItemSchema.safeParse(item);
  return parsed.success ? parsed.data : null;
}

async function fullBundle() {
  const [row] = await ctx.db.select().from(box).where(eq(box.id, boxId));
  return cacheBundle(ctx.db, boxAuthFromRow(row!), {});
}

/** What a write would have touched: every credential row, and how many audit rows exist. */
async function writes() {
  const credentials = await ctx.db.select().from(benefitCredential).orderBy(benefitCredential.id);
  const audits = await ctx.db.select({ id: auditLog.id }).from(auditLog);
  return { credentials, audits: audits.length };
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

async function makeRoleAccount(phone: string, roleName: string, permissions: string[]) {
  const roleId = newId();
  await ctx.db
    .insert(role)
    .values({ id: roleId, operatorId, name: roleName, description: 'review' });
  await ctx.db
    .insert(rolePermission)
    .values(permissions.map((permission) => ({ id: newId(), roleId, permission })));
  const id = newId();
  await ctx.db.insert(account).values({
    id,
    operatorId,
    phone: normalizePhone(phone)!,
    passwordHash: await hash('review1234'),
    phoneVerifiedAt: new Date(),
    status: 'active',
  });
  await ctx.db.insert(roleAssignment).values({
    id: newId(),
    accountId: id,
    roleId,
    scopeType: 'operator',
    scopeId: operatorId,
  });
  accountIds[roleName] = id;
  return signInAs(ctx.app, phone, 'review1234');
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { BENEFIT_QR_PRIVATE_KEY: PARK.privateKeyPem } });
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  secondOperatorId = await operatorIdByName(ctx.db, SECOND_OPERATOR_NAME);
  cookies.admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  cookies.manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  cookies.reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  cookies.foreign = await signInAs(
    ctx.app,
    SECOND_OPERATOR_ADMIN.phone,
    SECOND_OPERATOR_ADMIN.password,
  );
  // Everything on Staff Benefits EXCEPT the credential: reads, manages, applies.
  cookies.manageOnly = await makeRoleAccount('+66900002211', 'review_benefit_manage_only', [
    'admin:benefit:read',
    'admin:benefit:manage',
    'pos:benefit:apply',
  ]);
  // The credential and nothing else.
  cookies.issueOnly = await makeRoleAccount('+66900002212', 'review_benefit_issue_only', [
    'admin:benefit:credential_issue',
  ]);
  const [adminRow] = await ctx.db
    .select({ id: account.id })
    .from(account)
    .where(eq(account.phone, normalizePhone(ADMIN.phone)!));
  accountIds.admin = adminRow!.id;

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

  // The second operator's own benefit key, and a platform key not started yet.
  await ctx.db.insert(signingKey).values([
    {
      id: newId(),
      operatorId: secondOperatorId,
      purpose: 'benefit_qr',
      kid: FOREIGN.kid,
      algorithm: 'ed25519',
      publicKey: FOREIGN.publicKeyPem,
      active: true,
    },
    {
      id: newId(),
      operatorId: null,
      purpose: 'benefit_qr',
      kid: NEXT.kid,
      algorithm: 'ed25519',
      publicKey: NEXT.publicKeyPem,
      active: true,
      notBefore: new Date(Date.now() + 2 * 86_400_000),
    },
  ]);

  const till = (await ctx.db.select().from(station)).find((s) => s.name === 'Reception Till 1')!;
  tillId = till.id;
  boxId = till.boxId!;
  agent = createBoxAgent({
    apiBaseUrl: 'http://virtual-box.test',
    credentials: memoryCredentialStore(),
    hostname: 's221-r2-review',
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
  fsMutable.write = realWrite;
  fsMutable.writeSync = realWriteSync;
  if (priorLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = priorLogLevel;
});

// --- 5 (first, because everything after needs a credential): who may ------------

describe('who may issue, print and revoke — admin:benefit:credential_issue, and nothing else', () => {
  it('a role with every other benefit permission is refused all three; reception and a branch manager too', async () => {
    for (const who of ['manageOnly', 'manager', 'reception'] as const) {
      const issued = await issue(people.anan, cookies[who]);
      expect(issued.status, `${who} issue`).toBe(403);
    }
    // No credential exists yet, and no refusal wrote one or audited an issue.
    expect((await writes()).credentials).toHaveLength(0);
    expect(
      await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'benefit.credential_issue')),
    ).toHaveLength(0);
  });

  it('a role with ONLY credential_issue issues, prints and revokes — and cannot read the list', async () => {
    const issued = await issue(people.som, cookies.issueOnly);
    expect(issued.status).toBe(200);
    const qr = await qrOf(issued.body.credential.id, cookies.issueOnly);
    expect(qr.status).toBe(200);
    expect(qr.body.code.startsWith(`OTO-BEN:v1:${people.som}:${issued.body.credential.id}:`)).toBe(
      true,
    );
    expect((await call('GET', '/benefits/credentials', cookies.issueOnly)).status).toBe(403);

    // Those without it cannot print or revoke what exists.
    for (const who of ['manageOnly', 'manager', 'reception'] as const) {
      expect((await qrOf(issued.body.credential.id, cookies[who])).status, `${who} qr`).toBe(403);
      expect((await revoke(issued.body.credential.id, cookies[who])).status, `${who} revoke`).toBe(
        403,
      );
    }
    const [row] = await ctx.db
      .select()
      .from(benefitCredential)
      .where(eq(benefitCredential.id, issued.body.credential.id));
    expect(row!.revokedAt).toBeNull();

    const revoked = await revoke(issued.body.credential.id, cookies.issueOnly);
    expect(revoked.status).toBe(200);
    expect(revoked.body.changed).toBe(true);
    const [audit] = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'benefit.credential_revoke'),
          eq(auditLog.entityId, issued.body.credential.id),
        ),
      );
    expect(audit!.actorAccountId).toBe(accountIds.review_benefit_issue_only);
  });

  it('the branch manager reads which QRs exist and never a code; the list holds no code for anybody', async () => {
    const list = await call<{ credentials: Credential[] }>(
      'GET',
      `/benefits/credentials?employeeId=${people.som}`,
      cookies.manager,
    );
    expect(list.status).toBe(200);
    expect(list.body.credentials).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('OTO-BEN:');
    const manageList = await call('GET', '/benefits/credentials', cookies.manageOnly);
    expect(manageList.status).toBe(200);
    expect(JSON.stringify(manageList.body)).not.toContain('OTO-BEN:');
  });
});

describe('idempotent issue and revoke by key, and the audit rows', () => {
  let ananCredential: Credential;

  it('the same key twice is one QR, one row and one audit row; the same key for someone else is a mismatch', async () => {
    const key = idem();
    const first = await issue(people.anan, cookies.admin, key);
    const second = await issue(people.anan, cookies.admin, key);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers['x-oto-replay']).toBe('true');
    expect(second.body).toEqual(first.body);
    ananCredential = first.body.credential;

    const other = await issue(people.lek, cookies.admin, key);
    expect(other.status).toBe(409);
    expect(other.body.error!.code).toBe('IDEMPOTENCY_MISMATCH');

    const rows = await ctx.db
      .select()
      .from(benefitCredential)
      .where(eq(benefitCredential.employeeId, people.anan));
    expect(rows).toHaveLength(1);
    expect(
      await ctx.db
        .select()
        .from(benefitCredential)
        .where(eq(benefitCredential.employeeId, people.lek)),
    ).toHaveLength(0);
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'benefit.credential_issue'), eq(auditLog.entityId, rows[0]!.id)),
      );
    expect(audits).toHaveLength(1);

    // What the replay store keeps is the record, never a scannable code.
    const [stored] = await ctx.db
      .select()
      .from(idempotencyKey)
      .where(and(eq(idempotencyKey.key, key), eq(idempotencyKey.accountId, accountIds.admin!)));
    expect(stored?.statusCode).toBe(200);
    expect(JSON.stringify(stored?.responseBody)).not.toContain('OTO-BEN:');
  });

  it('six issues racing for one person (distinct keys): one QR, five BENEFIT_CREDENTIAL_LIVE; five revokes racing: one change, one audit row', async () => {
    // Som's only QR was revoked above, so Som has none in use.
    const raced = await Promise.all(
      Array.from({ length: 6 }, () => issue(people.som, cookies.admin)),
    );
    const won = raced.filter((r) => r.status === 200);
    expect(won).toHaveLength(1);
    expect(raced.filter((r) => r.status === 409).map((r) => r.body.error!.code)).toEqual(
      Array.from({ length: 5 }, () => 'BENEFIT_CREDENTIAL_LIVE'),
    );
    const live = await ctx.db
      .select()
      .from(benefitCredential)
      .where(eq(benefitCredential.employeeId, people.som));
    expect(live.filter((r) => r.revokedAt === null)).toHaveLength(1);

    const id = won[0]!.body.credential.id;
    const revokes = await Promise.all(Array.from({ length: 5 }, () => revoke(id)));
    expect(revokes.every((r) => r.status === 200)).toBe(true);
    expect(revokes.filter((r) => r.body.changed)).toHaveLength(1);
    expect(
      await ctx.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'benefit.credential_revoke'), eq(auditLog.entityId, id))),
    ).toHaveLength(1);
  });

  it('issue: one row with whose QR, which key and until when — exactly that, and no secret', async () => {
    const [audit] = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'benefit.credential_issue'),
          eq(auditLog.entityId, ananCredential.id),
        ),
      );
    expect(audit).toMatchObject({
      actorAccountId: accountIds.admin,
      operatorId,
      entityType: 'benefit_credential',
    });
    expect(audit!.before).toBeNull();
    expect(Object.keys(audit!.after as object).sort()).toEqual(
      ['employeeId', 'employeeName', 'expiresAt', 'id', 'issuedAt', 'kid', 'version'].sort(),
    );
    expect(audit!.after).toMatchObject({
      id: ananCredential.id,
      employeeId: people.anan,
      employeeName: 'Khun Anan (Owner)',
      kid: PARK.kid,
      version: 1,
    });
  });

  it('revoke: a retried revoke by key is the same answer and one audit row; another key later is changed:false and none', async () => {
    const qr = await qrOf(ananCredential.id);
    expect(qr.status).toBe(200);
    const key = idem();
    const first = await revoke(ananCredential.id, cookies.admin, key);
    const second = await revoke(ananCredential.id, cookies.admin, key);
    expect(first.status).toBe(200);
    expect(first.body.changed).toBe(true);
    expect(second.headers['x-oto-replay']).toBe('true');
    expect(second.body).toEqual(first.body);
    const later = await revoke(ananCredential.id);
    expect(later.body.changed).toBe(false);
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'benefit.credential_revoke'),
          eq(auditLog.entityId, ananCredential.id),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.before).toEqual({ id: ananCredential.id, revokedAt: null });
    expect(Object.keys(audits[0]!.after as object).sort()).toEqual(
      ['employeeId', 'employeeName', 'expiresAt', 'id', 'kid', 'revokedAt', 'wasExpired'].sort(),
    );
    expect(audits[0]!.after).toMatchObject({ wasExpired: false, kid: PARK.kid });
  });
});

// --- 1. The crypto path -------------------------------------------------------

describe('the crypto path: every forgery is refused by the cloud and by a box, and nothing is written', () => {
  let lek: Credential;
  let genuine = '';
  let exp = 0;
  const sign = (
    claims: { employeeId: string; credentialId: string; exp: number },
    key: { kid: string; privateKeyPem: string } = PARK,
  ) => encodeBenefitCredential(claims, key);

  beforeAll(async () => {
    lek = (await issue(people.lek)).body.credential;
    genuine = (await qrOf(lek.id)).body.code;
    exp = Math.floor(new Date(lek.expiresAt).getTime() / 1000);
    await agent.syncCache();
  });

  it('the genuine QR is accepted in both places — the baseline the forgeries are measured from', async () => {
    expect(genuine).toBe(sign({ employeeId: people.lek, credentialId: lek.id, exp }));
    expect((await resolve(genuine)).status).toBe(200);
    expect((await onBox(genuine)).outcome).toBe('handled');
  });

  it('each forgery: the cloud refuses it in the prototype’s words or the platform’s, a box refuses it, and no row moves', async () => {
    const before = await writes();
    const input = genuine.slice(0, genuine.lastIndexOf('.'));
    const signature = genuine.slice(genuine.lastIndexOf('.') + 1);
    const flip = (s: string) => `${s.slice(0, 10)}${s[10] === 'A' ? 'B' : 'A'}${s.slice(11)}`;
    const cases: Array<{
      what: string;
      code: string;
      cloud: { status: number; code: string };
      box: string;
    }> = [
      {
        what: 'an invented signature',
        code: `${input}.${'A'.repeat(86)}`,
        cloud: { status: 404, code: 'BENEFIT_CREDENTIAL_INVALID' },
        box: 'BENEFIT_CREDENTIAL_INVALID',
      },
      {
        what: 'one character of the signature changed',
        code: `${input}.${flip(signature)}`,
        cloud: { status: 404, code: 'BENEFIT_CREDENTIAL_INVALID' },
        box: 'BENEFIT_CREDENTIAL_INVALID',
      },
      {
        what: 'somebody else’s employee id',
        code: genuine.replace(people.lek, people.anan),
        cloud: { status: 404, code: 'BENEFIT_CREDENTIAL_INVALID' },
        box: 'BENEFIT_CREDENTIAL_INVALID',
      },
      {
        what: 'another credential id',
        code: genuine.replace(lek.id, newId()),
        cloud: { status: 404, code: 'BENEFIT_CREDENTIAL_INVALID' },
        box: 'BENEFIT_CREDENTIAL_INVALID',
      },
      {
        what: 'the expiry pushed out',
        code: genuine.replace(`:${exp}:`, `:${exp + 86_400 * 3650}:`),
        cloud: { status: 404, code: 'BENEFIT_CREDENTIAL_INVALID' },
        box: 'BENEFIT_CREDENTIAL_INVALID',
      },
      {
        what: 'a key id nobody holds',
        code: genuine.replace(`:${PARK.kid}.`, ':0000000000000000.'),
        cloud: { status: 404, code: 'BENEFIT_CREDENTIAL_UNKNOWN_KEY' },
        box: 'BENEFIT_CREDENTIAL_UNKNOWN_KEY',
      },
      {
        what: 'another key’s signature under this deployment’s key id',
        code: `${input}.${sign({ employeeId: people.lek, credentialId: lek.id, exp }, FOREIGN).split('.').pop()}`,
        cloud: { status: 404, code: 'BENEFIT_CREDENTIAL_INVALID' },
        box: 'BENEFIT_CREDENTIAL_INVALID',
      },
      {
        what: 'signed with the SECOND OPERATOR’s own benefit key',
        code: sign({ employeeId: people.lek, credentialId: lek.id, exp }, FOREIGN),
        cloud: { status: 404, code: 'BENEFIT_CREDENTIAL_UNKNOWN_KEY' },
        box: 'BENEFIT_CREDENTIAL_UNKNOWN_KEY',
      },
      {
        what: 'signed with a platform key whose not_before is two days away',
        code: sign({ employeeId: people.lek, credentialId: lek.id, exp }, NEXT),
        cloud: { status: 404, code: 'BENEFIT_CREDENTIAL_UNKNOWN_KEY' },
        box: 'BENEFIT_CREDENTIAL_UNKNOWN_KEY',
      },
      {
        what: 'a real credential, signed by the real key, already expired',
        code: sign({
          employeeId: people.lek,
          credentialId: lek.id,
          exp: Math.floor(Date.now() / 1000) - 60,
        }),
        cloud: { status: 409, code: 'BENEFIT_CREDENTIAL_EXPIRED' },
        box: 'BENEFIT_CREDENTIAL_EXPIRED',
      },
      {
        what: 'a format from a newer platform',
        code: genuine.replace('OTO-BEN:v1:', 'OTO-BEN:v2:'),
        cloud: { status: 404, code: 'BENEFIT_CREDENTIAL_SCHEMA_TOO_NEW' },
        box: 'BENEFIT_CREDENTIAL_SCHEMA_TOO_NEW',
      },
      {
        what: 'the signature cut off',
        code: input,
        cloud: { status: 404, code: 'BENEFIT_CREDENTIAL_MALFORMED' },
        box: 'BENEFIT_CREDENTIAL_MALFORMED',
      },
      {
        what: 'the prototype’s readable code with the new header',
        code: 'OTO-BEN:OP-4',
        cloud: { status: 404, code: 'BENEFIT_CREDENTIAL_MALFORMED' },
        box: 'BENEFIT_CREDENTIAL_MALFORMED',
      },
    ];
    for (const c of cases) {
      const cloud = await resolve(c.code);
      expect(cloud.status, c.what).toBe(c.cloud.status);
      expect(cloud.body.error?.code, c.what).toBe(c.cloud.code);
      if (c.cloud.code === 'BENEFIT_CREDENTIAL_EXPIRED') {
        expect(cloud.body.error!.message, c.what).toBe(BENEFIT_WORDS.expired);
      } else {
        expect(cloud.body.error!.message, c.what).toBe(BENEFIT_WORDS.notFound(c.code));
      }
      const scanned = await onBox(c.code);
      expect(scanned.kind, c.what).toBe('benefit');
      expect(scanned.outcome, c.what).toBe('refused');
      expect(scanned.errorCode, c.what).toBe(c.box);
      expect(scanned.detail?.benefit, c.what).toBeUndefined();
      expect(scanned.detail?.benefitCode, c.what).toBeUndefined();
    }
    expect(await writes()).toEqual(before);
  });

  it('a longer-lived copy of a real credential, signed with the real key, is refused by the cloud (its row says otherwise)', async () => {
    const before = await writes();
    const longer = sign({ employeeId: people.lek, credentialId: lek.id, exp: exp + 86_400 * 3650 });
    const res = await resolve(longer);
    expect(res.status).toBe(404);
    expect(res.body.error!.code).toBe('BENEFIT_NOT_FOUND');
    // A credential the platform never issued, under its own key: the same.
    const invented = sign({ employeeId: people.lek, credentialId: newId(), exp });
    expect((await resolve(invented)).body.error!.code).toBe('BENEFIT_NOT_FOUND');
    expect(await writes()).toEqual(before);
  });

  it('another operator’s administrator cannot use this park’s QR, and the box never carries another operator’s key', async () => {
    const before = await writes();
    const there = await resolve(genuine, cookies.foreign);
    expect(there.status).toBe(404);
    expect(there.body.error!.code).toBe('BENEFIT_NOT_FOUND');
    const scope = (await heldScope())!;
    const kids = scope.keys.map((k) => k.kid);
    expect(kids).toContain(PARK.kid);
    expect(kids).not.toContain(FOREIGN.kid);
    expect(kids).not.toContain(NEXT.kid);
    expect(await writes()).toEqual(before);
  });

  it('a retired key: the cloud refuses its QRs at once and a box from its next pull', async () => {
    try {
      await ctx.db
        .update(signingKey)
        .set({ retiredAt: new Date() })
        .where(and(eq(signingKey.purpose, 'benefit_qr'), eq(signingKey.kid, PARK.kid)));
      const cloud = await resolve(genuine);
      expect(cloud.status).toBe(404);
      expect(cloud.body.error!.code).toBe('BENEFIT_CREDENTIAL_UNKNOWN_KEY');
      // The box still holds the key until it pulls — the same bound as a revocation.
      expect((await onBox(genuine)).outcome).toBe('handled');
      await agent.syncCache();
      expect((await heldScope())!.keys.map((k) => k.kid)).not.toContain(PARK.kid);
      const scanned = await onBox(genuine);
      expect(scanned.outcome).toBe('refused');
      expect(scanned.errorCode).toBe('BENEFIT_CREDENTIAL_UNKNOWN_KEY');
    } finally {
      await ctx.db
        .update(signingKey)
        .set({ retiredAt: null })
        .where(and(eq(signingKey.purpose, 'benefit_qr'), eq(signingKey.kid, PARK.kid)));
      await agent.syncCache();
    }
    expect((await onBox(genuine)).outcome).toBe('handled');
  });

  it('through the till’s own scan door: every forgery refused, and the tape keeps no code', async () => {
    const forged = genuine.replace(people.lek, people.anan);
    const res = await scanAtTill(forged);
    expect(res.body).toMatchObject({ kind: 'benefit', outcome: 'refused' });
    expect(res.body.detail?.benefit).toBeUndefined();
    const ok = await scanAtTill(genuine);
    expect(ok.body).toMatchObject({ kind: 'benefit', outcome: 'handled', handler: 'benefit' });
    const tape = await ctx.db
      .select({ payload: stationEvent.payload })
      .from(stationEvent)
      .where(eq(stationEvent.stationId, tillId));
    const text = JSON.stringify(tape);
    expect(text).not.toContain(genuine);
    expect(text).not.toContain(genuine.split('.').pop()!);
    expect(text).not.toContain(forged);
  });
});

// --- 2. Revocation -------------------------------------------------------------

describe('revocation: at once on the cloud, on a stale box from its next pull, and a re-issue is a new credential', () => {
  let first: Credential;
  let firstCode = '';

  beforeAll(async () => {
    first = (await issue(people.nok)).body.credential;
    firstCode = (await qrOf(first.id)).body.code;
    await agent.syncCache();
    expect((await onBox(firstCode)).outcome).toBe('handled');
  });

  it('revoked: refused by the cloud at once; a stale box still admits it (the documented bound) until it pulls; the bundle moves by the revocation alone', async () => {
    const bundleBefore = await fullBundle();
    const scopeBefore = (await heldScope())!;
    expect(scopeBefore.revokedCredentialIds).not.toContain(first.id);

    const revoked = await revoke(first.id);
    expect(revoked.status).toBe(200);

    const before = await writes();
    const cloud = await resolve(firstCode);
    expect(cloud.status).toBe(409);
    expect(cloud.body.error).toMatchObject({
      code: 'BENEFIT_REVOKED',
      message: BENEFIT_WORDS.revoked('Nok (Reception)'),
    });
    expect(await writes()).toEqual(before);

    // The box has not pulled: its copy is yesterday's list, and it says so by
    // admitting the QR — the bound the route description and the dialog state.
    expect((await heldScope())!.version).toBe(scopeBefore.version);
    expect((await onBox(firstCode)).outcome).toBe('handled');

    // The bundle a box would pull now: a new version, and the only change in
    // the benefits scope is this credential joining the revocation list.
    const bundleAfter = await fullBundle();
    expect(bundleAfter.bundleVersion).not.toBe(bundleBefore.bundleVersion);
    const itemBefore = bundleBefore.scopes.benefits!.items[0] as BenefitScopeItem;
    const itemAfter = bundleAfter.scopes.benefits!.items[0] as BenefitScopeItem;
    expect(itemAfter.version).not.toBe(itemBefore.version);
    expect(itemAfter.revokedCredentialIds).toEqual(
      [...itemBefore.revokedCredentialIds, first.id].sort(),
    );
    expect(itemAfter.keys).toEqual(itemBefore.keys);
    expect(itemAfter.employees).toEqual(itemBefore.employees);
    expect(itemAfter.revokedEmployeeIds).toEqual(itemBefore.revokedEmployeeIds);

    await agent.syncCache();
    expect((await heldScope())!.revokedCredentialIds).toContain(first.id);
    const scanned = await onBox(firstCode);
    expect(scanned.outcome).toBe('refused');
    expect(scanned.errorCode).toBe('BENEFIT_REVOKED');
    expect(scanned.detail?.message).toBe(BENEFIT_WORDS.revoked('Nok (Reception)'));
    const viaTill = await scanAtTill(firstCode);
    expect(viaTill.body).toMatchObject({ outcome: 'refused', errorCode: 'BENEFIT_REVOKED' });
  });

  it('re-issued: a NEW credential and a new code; the old stays dead at the cloud, at the box and at the print door', async () => {
    const second = await issue(people.nok);
    expect(second.status).toBe(200);
    expect(second.body.credential.id).not.toBe(first.id);
    const secondCode = (await qrOf(second.body.credential.id)).body.code;
    expect(secondCode).not.toBe(firstCode);
    expect(secondCode.includes(first.id)).toBe(false);

    const [oldRow] = await ctx.db
      .select()
      .from(benefitCredential)
      .where(eq(benefitCredential.id, first.id));
    expect(oldRow!.revokedAt).not.toBeNull();
    expect(oldRow!.codeHash).toBe(benefitCredentialHash(firstCode));

    expect((await resolve(secondCode)).status).toBe(200);
    expect((await resolve(firstCode)).body.error!.code).toBe('BENEFIT_REVOKED');
    expect((await qrOf(first.id)).body.error!.code).toBe('BENEFIT_REVOKED');

    // A fresh QR needs no pull to work on the box; the old one stays refused
    // before and after the next pull.
    expect((await onBox(secondCode)).outcome).toBe('handled');
    expect((await onBox(firstCode)).errorCode).toBe('BENEFIT_REVOKED');
    await agent.syncCache();
    const scope = (await heldScope())!;
    expect(scope.revokedCredentialIds).toContain(first.id);
    expect(scope.revokedCredentialIds).not.toContain(second.body.credential.id);
    expect((await onBox(firstCode)).errorCode).toBe('BENEFIT_REVOKED');
    expect((await onBox(secondCode)).outcome).toBe('handled');

    // Revoking the old one again changes nothing and records nothing.
    const audits = (await writes()).audits;
    const again = await revoke(first.id);
    expect(again.body.changed).toBe(false);
    expect((await writes()).audits).toBe(audits);
  });
});

// --- 3. The `benefits` scope ---------------------------------------------------

describe('the benefits scope: the plan’s fields and nothing else', () => {
  it('exactly the item’s five fields, the keys’ four, a person’s three and a day’s six — no quota, no amount', async () => {
    await agent.syncCache();
    const scope = (await heldScope())!;
    expect(Object.keys(scope).sort()).toEqual(
      ['employees', 'keys', 'revokedCredentialIds', 'revokedEmployeeIds', 'version'].sort(),
    );
    for (const k of scope.keys) {
      expect(Object.keys(k).sort()).toEqual(['algorithm', 'kid', 'publicKey', 'purpose']);
      expect(k.purpose).toBe('benefit_qr');
      expect(k.algorithm).toBe('ed25519');
      expect(k.publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    }
    const allowed = new Set([
      'version',
      'keys',
      'revokedCredentialIds',
      'revokedEmployeeIds',
      'employees',
      'purpose',
      'kid',
      'algorithm',
      'publicKey',
      'employeeId',
      'name',
      'days',
      'from',
      'to',
      'benefitRole',
      'comp',
      'standingDiscount',
      'onlineOnly',
      'percent',
      'target',
      'kind',
      'category',
      'menuItemIds',
    ]);
    const seen = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          seen.add(key);
          walk(inner);
        }
      }
    };
    walk(scope);
    expect([...seen].filter((key) => !allowed.has(key))).toEqual([]);
    const text = JSON.stringify(scope);
    expect(text).not.toMatch(/quota|amount|satang|perPeriod|"period"|PRIVATE/i);
    for (const person of scope.employees) {
      for (const day of person.days) {
        for (const stage of day.onlineOnly) expect(['freeItems', 'credit']).toContain(stage);
      }
    }
  });

  it('names only the people a scan could name — those with a benefit from today on — and nothing more of them', async () => {
    const scope = (await heldScope())!;
    const staff = (
      await call<{
        staff: Array<{
          employeeId: string;
          name: string;
          current: { benefitRole: string | null } | null;
          upcoming: Array<{ benefitRole: string | null }>;
        }>;
      }>('GET', '/benefits/profiles', cookies.admin)
    ).body.staff;
    const withBenefit = staff
      .filter(
        (s) =>
          (s.current?.benefitRole ?? null) !== null ||
          s.upcoming.some((u) => u.benefitRole !== null),
      )
      .map((s) => ({ employeeId: s.employeeId, name: s.name }))
      .sort((a, b) => a.employeeId.localeCompare(b.employeeId));
    expect(
      scope.employees
        .map((e) => ({ employeeId: e.employeeId, name: e.name }))
        .sort((a, b) => a.employeeId.localeCompare(b.employeeId)),
    ).toEqual(withBenefit);

    // Not a phone, an email or a nickname of anybody, and nobody of another operator.
    const everyone = await ctx.db.select().from(employee);
    const text = JSON.stringify(scope);
    for (const person of everyone) {
      for (const field of [person.phone, person.email, person.nickname]) {
        if (field && field.length > 3) expect(text, field).not.toContain(field);
      }
      if (person.operatorId !== operatorId) expect(text).not.toContain(person.id);
    }
  });

  it('a person who has left is on the box’s list only while a QR of theirs could still verify', async () => {
    const lekLive = await ctx.db
      .select()
      .from(benefitCredential)
      .where(eq(benefitCredential.employeeId, people.lek));
    expect(lekLive.length).toBeGreaterThan(0);
    await ctx.db
      .update(employee)
      .set({ archivedAt: new Date() })
      .where(eq(employee.id, people.lek));
    try {
      await agent.syncCache();
      const scope = (await heldScope())!;
      expect(scope.revokedEmployeeIds).toEqual([people.lek]);
      // And they are no longer named among those with a benefit.
      expect(scope.employees.map((e) => e.employeeId)).not.toContain(people.lek);
      const lekCode = (await Promise.all(lekLive.map(async (r) => (await qrOf(r.id)).body)))[0]!;
      // Printing is refused for a person who has left.
      expect(lekCode.error?.code).toBe('BENEFIT_EMPLOYEE_LEFT');
    } finally {
      await ctx.db.update(employee).set({ archivedAt: null }).where(eq(employee.id, people.lek));
      await agent.syncCache();
    }
  });
});

// --- 4. Refusal points the api owns, driven ------------------------------------

describe('a benefit QR opens no session: sign-in and the till’s badge path, each in its own words', () => {
  let code = '';

  beforeAll(async () => {
    const list = await call<{ credentials: Credential[] }>(
      'GET',
      `/benefits/credentials?employeeId=${people.nok}`,
      cookies.admin,
    );
    const live = list.body.credentials.find((c) => c.status === 'active')!;
    code = (await qrOf(live.id)).body.code;
  });

  it('sign-in: the QR in every shape a scanner types it is BENEFIT_NOT_A_SIGN_IN — no session, no throttle, no failure row', async () => {
    const sessionsBefore = (await ctx.db.select({ id: session.id }).from(session)).length;
    const throttleBefore = await ctx.db.select().from(authThrottle);
    const failuresBefore = (
      await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'auth.sign_in_failed'))
    ).length;
    for (const shape of [code, code.toLowerCase(), `  ${code}\r\n`, 'OTO-BEN:anything at all']) {
      for (let i = 0; i < 3; i += 1) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/auth/sign-in',
          payload: { phone: shape, password: 'whatever-it-is' },
        });
        expect(res.statusCode, shape).toBe(400);
        expect(res.json().error).toEqual({
          code: 'BENEFIT_NOT_A_SIGN_IN',
          message: BENEFIT_QR_NOT_A_SIGN_IN,
        });
        expect(res.headers['set-cookie']).toBeUndefined();
      }
    }
    expect((await ctx.db.select({ id: session.id }).from(session)).length).toBe(sessionsBefore);
    expect(await ctx.db.select().from(authThrottle)).toEqual(throttleBefore);
    expect(
      (await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'auth.sign_in_failed')))
        .length,
    ).toBe(failuresBefore);
    // Twelve refusals later, a real sign-in from the same address still works.
    expect(await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password)).toMatch(/=/);
  });

  it('the till’s badge path: refused in the till’s words, before the box — no tape row, nothing on the screens, the session unchanged', async () => {
    await takeStation(ctx.app, cookies.reception, tillId);
    const cursor = await call<{ next: number; scans: unknown[] }>(
      'GET',
      `/stations/${tillId}/scans?view=staff`,
      cookies.admin,
    );
    expect(cursor.status).toBe(200);
    const tapeBefore = (
      await ctx.db
        .select({ id: stationEvent.id })
        .from(stationEvent)
        .where(eq(stationEvent.stationId, tillId))
    ).length;
    const me = await call<{ account: { id: string } }>('GET', '/me', cookies.reception);
    expect(me.status).toBe(200);
    for (const value of [code, code.toLowerCase()]) {
      const res = await call<{ outcome: string; handler: string | null; message: string }>(
        'POST',
        '/auth/badge',
        cookies.reception,
        { value, source: 'keyboard' },
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        outcome: 'refused',
        handler: null,
        message: BENEFIT_QR_NOT_A_SIGN_IN,
      });
    }
    const after = await call<{ next: number; scans: unknown[] }>(
      'GET',
      `/stations/${tillId}/scans?view=staff&after=${cursor.body.next}`,
      cookies.admin,
    );
    expect(after.body.scans).toEqual([]);
    expect(
      (
        await ctx.db
          .select({ id: stationEvent.id })
          .from(stationEvent)
          .where(eq(stationEvent.stationId, tillId))
      ).length,
    ).toBe(tapeBefore);
    const still = await call<{ account: { id: string } }>('GET', '/me', cookies.reception);
    expect(still.status).toBe(200);
    expect(still.body.account.id).toBe(me.body.account.id);
  });
});

// --- Where a scanned QR travels ----------------------------------------------------

describe('where a scanned QR travels: never the replay store, never the customer view', () => {
  it('a benefit QR scanned at the till with an Idempotency-Key leaves no copy of itself in the replay store', async () => {
    const list = await call<{ credentials: Credential[] }>(
      'GET',
      `/benefits/credentials?employeeId=${people.lek}`,
      cookies.admin,
    );
    const live = list.body.credentials.find((c) => c.status === 'active')!;
    const code = (await qrOf(live.id)).body.code;
    const key = idem();
    const res = await call<{ outcome: string; detail?: Record<string, unknown> }>(
      'POST',
      `/stations/${tillId}/scan`,
      cookies.admin,
      { code, source: 'camera' },
      { 'idempotency-key': key },
    );
    expect(res.body.outcome).toBe('handled');
    // The staff screen is handed the QR so it can apply free items or credit
    // with the cloud — and that answer must not be kept for a day under a key.
    const [stored] = await ctx.db
      .select()
      .from(idempotencyKey)
      .where(and(eq(idempotencyKey.key, key), eq(idempotencyKey.accountId, accountIds.admin!)));
    expect(JSON.stringify(stored?.responseBody ?? null)).not.toContain(code.split('.').pop()!);
  });

  it('a genuine QR the box refuses (its holder has no benefit from today on) reaches the customer view without its code', async () => {
    const list = await call<{ credentials: Credential[] }>(
      'GET',
      `/benefits/credentials?employeeId=${people.nok}`,
      cookies.admin,
    );
    const live = list.body.credentials.find((c) => c.status === 'active')!;
    const code = (await qrOf(live.id)).body.code;
    // Nok's role taken away from today; her QR is not revoked, so it applies
    // again the day a role is given back — a live credential.
    const removed = await call('PUT', `/benefits/profiles/${people.nok}`, cookies.admin, {
      benefitRole: null,
      override: null,
    });
    expect(removed.status).toBe(200);
    await agent.syncCache();
    try {
      const cursor = await call<{ next: number }>(
        'GET',
        `/stations/${tillId}/scans?view=customer`,
        cookies.admin,
      );
      const res = await scanAtTill(code);
      expect(res.body).toMatchObject({ kind: 'benefit', outcome: 'refused' });
      const heard = await call<{ scans: Array<Record<string, unknown>> }>(
        'GET',
        `/stations/${tillId}/scans?view=customer&after=${cursor.body.next}`,
        cookies.admin,
      );
      expect(heard.body.scans.length).toBeGreaterThan(0);
      expect(JSON.stringify(heard.body.scans)).not.toContain(code.split('.').pop()!);
    } finally {
      await call('PUT', `/benefits/profiles/${people.nok}`, cookies.admin, {
        benefitRole: 'staff',
        override: null,
      });
      await agent.syncCache();
    }
  });
});

// --- Last: nothing written down anywhere ----------------------------------------

describe('no key material and no printed QR in any audit row, tape row or log line', () => {
  it('every audit row, station event and (outside the scan door) replay row of this run', async () => {
    expect(printed.size).toBeGreaterThan(3);
    const secrets = [
      ...[...printed].flatMap((code) => [
        code,
        code.split('.').pop()!,
        benefitCredentialHash(code),
      ]),
      PEM_BODY(PARK.privateKeyPem),
      'PRIVATE KEY',
    ];
    const audits = JSON.stringify(await ctx.db.select().from(auditLog));
    const tape = JSON.stringify(await ctx.db.select().from(stationEvent));
    for (const secret of secrets) {
      expect(audits.includes(secret), `audit: ${secret.slice(0, 24)}`).toBe(false);
      expect(tape.includes(secret), `tape: ${secret.slice(0, 24)}`).toBe(false);
    }
    // The replay store is held to it route by route above (issue, revoke and
    // the till's scan door); here, every row written by a route that is not
    // the scan door.
    const replays = await ctx.db.select().from(idempotencyKey);
    const notScans = JSON.stringify(
      replays.filter((r) => !JSON.stringify(r.responseBody ?? null).includes('"codeFingerprint"')),
    );
    for (const secret of secrets) {
      expect(notScans.includes(secret), `replay: ${secret.slice(0, 24)}`).toBe(false);
    }
  });

  it('every log line the api wrote, at every level', async () => {
    // Let the logger's buffer drain.
    for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setImmediate(r));
    expect(logLines.length).toBeGreaterThan(50);
    const text = logLines.join('');
    for (const code of printed) {
      expect(text.includes(code), 'a printed QR in a log line').toBe(false);
      expect(text.includes(code.split('.').pop()!), 'a QR signature in a log line').toBe(false);
      expect(text.includes(benefitCredentialHash(code)), 'a code hash in a log line').toBe(false);
    }
    expect(text.includes(PEM_BODY(PARK.privateKeyPem))).toBe(false);
    expect(text).not.toContain('PRIVATE KEY');
  });
});
