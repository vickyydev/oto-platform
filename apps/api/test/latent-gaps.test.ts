import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { account, fileObject, member, roleAssignment } from '@oto/db';
import { newId } from '@oto/shared';
import {
  ADMIN,
  OTO_OPERATOR_NAME,
  RECEPTION,
  SECOND_OPERATOR_NAME,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { carriesSecret } from '../src/plugins/idempotency';

/**
 * SCRUM-255 — THE THREE GAPS THAT GRANT NOTHING ONLY BECAUSE NO ROUTE ASKS.
 *
 * Each is the shape of the escalation SCRUM-280/281 closed — an id taken from
 * a request and trusted without a tenancy check — and each was dormant only
 * because the route that would read it has not been written yet. Dormant is
 * not closed: the day that route lands, the row is already in the database and
 * already audited as a legitimate grant.
 *
 * (a) a record-scoped role assignment, validated by nobody;
 * (b) `POST /files`, which checked the permission and not whose record it was
 *     attaching to;
 * (c) the credential backstop, which matched eight field names whole.
 */

const STORAGE_ENV = {
  MINIO_ENDPOINT: 'localhost',
  MINIO_PORT: '9000',
  MINIO_USE_SSL: 'false',
  MINIO_ACCESS_KEY: 'oto',
  MINIO_SECRET_KEY: 'otosecret123',
  MINIO_BUCKET: 'oto-files-test',
};

let ctx: TestContext;
let adminCookie: string;
let receptionCookie: string;
let receptionAccountId: string;
/** A member of the OTHER operator. Nothing of ours may ever attach to it. */
let foreignMemberId: string;
/** One of ours, for the positive half. */
let ownMemberId: string;

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  opts: { cookie?: string; payload?: unknown } = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: opts.cookie ? { cookie: opts.cookie } : {},
    ...(opts.payload === undefined ? {} : { payload: opts.payload as never }),
  });
  return {
    statusCode: res.statusCode,
    body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {},
  };
}

const errorCode = (res: { body: Record<string, unknown> }): string =>
  (res.body as { error?: { code?: string } }).error?.code ?? '(no error)';

beforeAll(async () => {
  ctx = await createTestContext({ files: true, env: STORAGE_ENV });
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [rec] = await ctx.db
    .select({ id: account.id })
    .from(account)
    .where(eq(account.phone, RECEPTION.phone));
  receptionAccountId = rec!.id;

  /**
   * The foreign member is built here rather than seeded: the gap is in a
   * predicate, so one row belonging to somebody else is all it takes to show
   * it, and a fixture that owns its own data cannot be broken by a seed change
   * that has nothing to do with this.
   */
  const otherOperator = await operatorIdByName(ctx.db, SECOND_OPERATOR_NAME);
  foreignMemberId = newId();
  await ctx.db.insert(member).values({
    id: foreignMemberId,
    operatorId: otherOperator,
    phone: '+66900555001',
    nickname: 'Their member',
  });
  ownMemberId = newId();
  await ctx.db.insert(member).values({
    id: ownMemberId,
    operatorId: await operatorIdByName(ctx.db, OTO_OPERATOR_NAME),
    phone: '+66900555002',
    nickname: 'Our member',
  });
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// ---------------------------------------------------------------------------

describe('(a) a record-scoped grant is refused, not waved through (SCRUM-255)', () => {
  /**
   * The reproduction from the sweep, unchanged: another operator's id, in the
   * `scopeId` of a record-scoped assignment, on an account of ours. It used to
   * answer 200 and write the row, because `assertScopeOwned` returned without
   * checking anything for `record` and deferred to "the record's own route" —
   * a route that does not exist anywhere in the API.
   */
  it('refuses a record scope carrying another operator’s id', async () => {
    const otherOperator = await operatorIdByName(ctx.db, SECOND_OPERATOR_NAME);
    const res = await call('POST', `/accounts/${receptionAccountId}/role-assignments`, {
      cookie: adminCookie,
      payload: { roleName: 'staff', scopeType: 'record', scopeId: otherOperator },
    });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('SCOPE_NOT_SUPPORTED');
  });

  it('refuses a record scope carrying an id of our own, too', async () => {
    // Not a tenancy check that happens to pass: the scope itself cannot be
    // granted, because nothing would check it whoever owned the id.
    const res = await call('POST', `/accounts/${receptionAccountId}/role-assignments`, {
      cookie: adminCookie,
      payload: { roleName: 'staff', scopeType: 'record', scopeId: ownMemberId },
    });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('SCOPE_NOT_SUPPORTED');
  });

  it('writes no assignment at all — a refusal that leaves the row is not one', async () => {
    const rows = await ctx.db
      .select()
      .from(roleAssignment)
      .where(eq(roleAssignment.scopeType, 'record'));
    expect(rows).toHaveLength(0);
  });

  it('still grants the scopes that a route does check', async () => {
    // The half that matters: closing record scope must not make the three
    // real scopes any harder to hand out.
    const res = await call('POST', `/accounts/${receptionAccountId}/role-assignments`, {
      cookie: adminCookie,
      payload: {
        roleName: 'staff',
        scopeType: 'operator',
        scopeId: await operatorIdByName(ctx.db, OTO_OPERATOR_NAME),
      },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe('(b) a file attaches only to something of ours (SCRUM-255)', () => {
  const attach = (memberId: string, cookie: string) =>
    call('POST', '/files', {
      cookie,
      payload: {
        contentType: 'image/jpeg',
        ownerEntityType: 'member',
        ownerEntityId: memberId,
        filename: 'photo.jpg',
      },
    });

  it('refuses another operator’s member as not found, and never as not allowed', async () => {
    /**
     * `pos:member:update` was the whole check, so this used to pass on the
     * permission alone and write a `file_object` stamped with OUR operator id
     * pointing at THEIR member. 404 rather than 403, for the reason every
     * other by-id loader gives: the existence of another operator's row is not
     * ours to confirm.
     */
    const res = await attach(foreignMemberId, receptionCookie);
    expect(res.statusCode).toBe(404);
  });

  it('writes no file_object row for it', async () => {
    const rows = await ctx.db
      .select()
      .from(fileObject)
      .where(
        and(
          eq(fileObject.ownerEntityType, 'member'),
          eq(fileObject.ownerEntityId, foreignMemberId),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it('refuses a member id that is nobody’s the same way', async () => {
    const res = await attach(newId(), receptionCookie);
    expect(res.statusCode).toBe(404);
  });

  it('still attaches to one of our own members', async (t) => {
    // Needs a reachable MinIO to presign; the refusals above do not, because
    // the owner is resolved before storage is touched at all.
    const res = await attach(ownMemberId, receptionCookie);
    if (res.statusCode === 503) return t.skip();
    expect(res.statusCode).toBe(200);
    const rows = await ctx.db
      .select()
      .from(fileObject)
      .where(
        and(eq(fileObject.ownerEntityType, 'member'), eq(fileObject.ownerEntityId, ownMemberId)),
      );
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('(c) the credential backstop matches the shape, not a list (SCRUM-255)', () => {
  /**
   * Eight names matched whole was a list of the credentials that existed when
   * somebody wrote the list. These three are names this codebase already mints
   * under other spellings, and every one of them walked straight past it into
   * the replay store — a working credential sitting in Postgres for a day,
   * handed back to anyone holding the key.
   */
  it('refuses the store a field whose NAME was not on the list', () => {
    expect(carriesSecret({ boxSecret: 'deadbeef' })).toBe(true);
    expect(carriesSecret({ shiftToken: 'eyJhbGciOi' })).toBe(true);
    expect(carriesSecret({ sessionToken: 'abc123' })).toBe(true);
    expect(carriesSecret({ devicePassword: 'hunter2' })).toBe(true);
    expect(carriesSecret({ signingKey: 'MIIB' })).toBe(true);
    // And at depth, which is where a credential usually sits.
    expect(carriesSecret({ box: { id: 'x', boxSecret: 'deadbeef' } })).toBe(true);
    expect(carriesSecret({ credentials: [{ shiftToken: 'abc' }] })).toBe(true);
  });

  it('keeps the names it already caught', () => {
    for (const field of ['secret', 'token', 'password', 'temporaryPassword', 'claimCode', 'pairingCode', 'otp', 'apiKey']) {
      expect(carriesSecret({ [field]: 'value' }), field).toBe(true);
    }
  });

  it('leaves the facts alone — an over-match here costs the till its retries', () => {
    /**
     * This is the expensive half. A false positive drops the response body,
     * releases the key and logs at ERROR, so a widening that caught `code`
     * would do that to every 4xx this API returns — the error envelope is
     * `{ error: { code, message } }` — and to every sale that carries a
     * `tierCode`. Those are facts about a thing, not the thing.
     */
    expect(carriesSecret({ error: { code: 'BAD_REQUEST', message: 'no' } })).toBe(false);
    expect(carriesSecret({ tierCode: 'tourist' })).toBe(false);
    expect(carriesSecret({ branchCode: 'hkt-central' })).toBe(false);
    expect(carriesSecret({ errorCode: 'PRINTER_OFFLINE' })).toBe(false);
    expect(carriesSecret({ statusCode: '404' })).toBe(false);
    // An expiry is safe to replay; the thing it expires is not.
    expect(carriesSecret({ pairingCodeExpiresAt: '2026-09-23T00:00:00Z' })).toBe(false);
    expect(carriesSecret({ claimCodeOutstanding: 'yes' })).toBe(false);
    /**
     * The menu import's content hash — `v1.<file digest>.<menu digest>` — which
     * ends in `Token` and unlocks nothing. Matching it would drop the body of
     * the preview route, whose description is "Writes nothing", and log an
     * ERROR line accusing it of minting a credential: SCRUM-327's noise moved
     * to another route rather than removed. Dormant today only because nothing
     * sends that route an `Idempotency-Key`, which an import screen adding a
     * retry would change.
     */
    expect(carriesSecret({ previewToken: 'v1.9f2c.7ab1' })).toBe(false);
    // The `*key` names that identify rather than unlock.
    expect(carriesSecret({ publicKey: 'MCowBQ' })).toBe(false);
    expect(carriesSecret({ syncPublicKey: 'MCowBQ' })).toBe(false);
    expect(carriesSecret({ alertKey: 'box.offline' })).toBe(false);
    expect(carriesSecret({ objectKey: 'op/member/id.jpg' })).toBe(false);
    expect(carriesSecret({ idempotencyKey: 'abc' })).toBe(false);
    // An empty value is not a credential either.
    expect(carriesSecret({ boxSecret: '' })).toBe(false);
  });
});
