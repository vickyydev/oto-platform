import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { account, auditLog, branch, idempotencyKey, role, roleAssignment, rolePermission } from '@oto/db';
import { newId } from '@oto/shared';
import { assistantSettingOverridesOf, assistantSettingRatesOf } from '../src/services/assistant-settings';
import { ADMIN, SECOND_OPERATOR_ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/** SCRUM-638 house review: severity and prescribed fixes remain explicit; no model or message client is invoked. */
let ctx: TestContext;
let cookie: string, otherCookie: string, accountId: string, otherAccountId: string, operatorId: string, otherOperatorId: string;
let manageRole: string, parks: string[];
const permission = 'inbox:ai:manage';
const action = 'assistant_settings.update';
const path = '/assistant-settings';
const defaults = {
  internal: { personDailyCap: 11, dailyAskCap: 111, dailyTokenCap: 1234, concurrentPerPerson: 3, concurrentPerOperator: 17 },
  // SCRUM-677: the coherence review switch has no environment variable; it is on unless saved off.
  inbox: { dailyTurnCap: 91, dailyTokenCap: 4567, debounceSeconds: 7, debounceMaxSeconds: 7, firstBubbleMs: 123, bubbleGapMs: 456, coherenceReview: true },
};
const body = (overrides: Record<string, unknown> = {}, rates: unknown[] = [], expectedRevision = 0) => ({
  expectedRevision, schemaVersion: 1, overrides: { internal: {}, inbox: {}, ...overrides }, rates,
});
const read = (auth = cookie, query = '') => ctx.app.inject({ method: 'GET', url: path + query, headers: auth ? { cookie: auth } : {} });
const put = (payload: Record<string, unknown>, key = newId(), auth = cookie, query = '') => ctx.app.inject({
  method: 'PUT', url: path + query, headers: { ...(auth ? { cookie: auth } : {}), 'idempotency-key': key }, payload,
});
async function granted(scopeType: 'operator' | 'branch', scopeIds: Array<string | null>) {
  await ctx.db.delete(roleAssignment).where(eq(roleAssignment.accountId, accountId));
  if (scopeIds.length) await ctx.db.insert(roleAssignment).values(scopeIds.map(scopeId => ({
    id: newId(), accountId, roleId: manageRole, scopeType, scopeId,
  })));
}
async function routeReady() {
  const response = await read();
  // Deliberately before ALL new-table fixtures: original RED is missing HTTP behavior, never a missing table/import.
  expect(response.statusCode).toBe(200);
  return response.json();
}
async function resetSettings() {
  await routeReady();
  await ctx.db.execute(sql`delete from core.setting where key='assistant_settings' and operator_id in (${operatorId},${otherOperatorId})`);
  await ctx.db.delete(auditLog).where(and(eq(auditLog.action, action), inArray(auditLog.operatorId, [operatorId, otherOperatorId])));
}
const stored = async (owner = operatorId) => (await ctx.db.execute<{ value: unknown; revision: number; updated_by: string | null }>(sql`
  select value,revision,updated_by from core.setting where operator_id=${owner} and key='assistant_settings'`)).rows;
const audits = () => ctx.db.select().from(auditLog).where(and(eq(auditLog.action, action), eq(auditLog.operatorId, operatorId)));
const rate = (effectiveFrom = '2026-10-01T00:00:00.000Z', model = 'ZZ TEST model') => ({
  model, effectiveFrom, inputUsdPerMillion: 1.25, outputUsdPerMillion: 3.5, cacheReadUsdPerMillion: 0.125,
});

beforeAll(async () => {
  ctx = await createTestContext({ env: {
    INTERNAL_AI_ENABLED: 'false', INBOX_AI_ENABLED: 'false',
    INTERNAL_AI_PERSON_DAILY_CAP: '11', INTERNAL_AI_DAILY_ASK_CAP: '111', INTERNAL_AI_DAILY_TOKEN_CAP: '1234',
    INTERNAL_AI_CONCURRENT_PER_PERSON: '3', INTERNAL_AI_CONCURRENT_PER_OPERATOR: '17',
    INBOX_AI_DAILY_TURN_CAP: '91', INBOX_AI_DAILY_TOKEN_CAP: '4567', INBOX_AI_DEBOUNCE_S: '7', INBOX_AI_DEBOUNCE_MAX_S: '4',
    INBOX_AI_FIRST_BUBBLE_MS: '123', INBOX_AI_BUBBLE_GAP_MS: '456',
  } });
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  otherCookie = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  const [first] = await ctx.db.select().from(account).where(eq(account.phone, ADMIN.phone));
  const [second] = await ctx.db.select().from(account).where(eq(account.phone, SECOND_OPERATOR_ADMIN.phone));
  accountId = first!.id; operatorId = first!.operatorId;
  otherAccountId = second!.id; otherOperatorId = second!.operatorId;
  parks = (await ctx.db.select({ id: branch.id }).from(branch).where(eq(branch.operatorId, operatorId))).map(row => row.id);
  expect(parks.length).toBeGreaterThan(0);
  manageRole = newId();
  await ctx.db.insert(role).values({ id: manageRole, operatorId, name: 'ZZ TEST Assistant settings only' });
  await ctx.db.insert(rolePermission).values({ id: newId(), roleId: manageRole, permission });
});
beforeEach(async () => { await granted('operator', [operatorId]); });
afterAll(async () => { await ctx?.close(); await teardownAll(); });

describe('SCRUM-638 assistant settings HTTP adversarial review', () => {
  it.each(['GET', 'PUT'] as const)('R1 high: %s exists and authenticates; anonymous callers cannot inspect or save configuration', async method => {
    const response = method === 'GET' ? await read('') : await put(body(), newId(), '');
    expect(response.statusCode).toBe(401);
  });

  it('R2 high: branch-only access at the real seat and a union of every park cannot edit an operator setting; prescribe operatorOnly', async () => {
    await granted('branch', [parks[0]!]);
    expect((await read()).statusCode).toBe(403); expect((await put(body())).statusCode).toBe(403);
    await granted('branch', parks);
    expect((await read()).statusCode).toBe(403); expect((await put(body())).statusCode).toBe(403);
    await granted('operator', [otherOperatorId]);
    expect((await read()).statusCode).toBe(403);
    await granted('operator', []);
    expect((await read()).statusCode).toBe(403);
  });

  it('R3 high: no row is revision0/environment with all eleven native numeric defaults, the review switch on, and normalized debounce, without creating a row', async () => {
    await resetSettings(); const response = await read(); expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ operatorId, schemaVersion: 1, overrides: { internal: {}, inbox: {} }, effective: defaults,
      rates: [], source: 'environment', revision: 0, updatedAt: null, updatedBy: null });
    expect(await stored()).toEqual([]);
  });

  it('R4 high: store only the caller operator/fixed key/updater; successful PUT returns authoritative revision1 DTO inside its transaction', async () => {
    await resetSettings(); const response = await put(body({ internal: { personDailyCap: 2 } }));
    expect(response.statusCode).toBe(200); const answer = response.json();
    expect(answer).toMatchObject({ operatorId, schemaVersion: 1, source: 'operator', revision: 1, updatedBy: accountId,
      overrides: { internal: { personDailyCap: 2 }, inbox: {} }, effective: { internal: { ...defaults.internal, personDailyCap: 2 }, inbox: defaults.inbox }, rates: [] });
    expect(Number.isFinite(Date.parse(answer.updatedAt))).toBe(true);
    expect((await read()).json()).toEqual(answer);
    expect(await stored()).toEqual([{ value: { schemaVersion: 1, overrides: { internal: { personDailyCap: 2 }, inbox: {} }, rates: [] }, revision: 1, updated_by: accountId }]);
    expect(await stored(otherOperatorId)).toEqual([]);
    const trail = await audits(); expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ actorAccountId: accountId, operatorId, branchId: null, action, entityType: 'setting', entityId: operatorId });
  });

  it('R5 high: all zero-cap/pacing meanings survive, lower raw debounce-max is normalized only in effective values', async () => {
    await resetSettings(); const overrides = {
      internal: { personDailyCap: 0, dailyAskCap: 0, dailyTokenCap: 0, concurrentPerPerson: 1, concurrentPerOperator: 1 },
      inbox: { dailyTurnCap: 0, dailyTokenCap: 0, debounceSeconds: 20, debounceMaxSeconds: 0, firstBubbleMs: 0, bubbleGapMs: 0 },
    };
    const response = await put(body(overrides)); expect(response.statusCode).toBe(200);
    expect(response.json().overrides).toEqual(overrides);
    expect(response.json().effective).toEqual({ internal: overrides.internal, inbox: { ...overrides.inbox, debounceMaxSeconds: 20, coherenceReview: true } });
    expect(ctx.app.env.INTERNAL_AI_PERSON_DAILY_CAP).toBe(11); expect(ctx.app.env.INBOX_AI_DEBOUNCE_MAX_S).toBe(4);
  });

  it('SCRUM-677: the coherence review switch saves sparse like the numbers, off is explicit, and omitting it is on again', async () => {
    await resetSettings(); const off = await put(body({ inbox: { coherenceReview: false } }));
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ overrides: { inbox: { coherenceReview: false } }, effective: { inbox: { ...defaults.inbox, coherenceReview: false } } });
    expect(await assistantSettingOverridesOf(ctx.db, operatorId)).toEqual({ internal: {}, inbox: { coherenceReview: false } });
    const on = await put(body({}, [], 1)); expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ overrides: { inbox: {} }, effective: defaults });
    expect(await audits()).toHaveLength(2);
  });

  it('R6 medium: sparse replacement resets omitted fields to deployment defaults, without inventing a quota maximum', async () => {
    await resetSettings(); expect((await put(body({ internal: { dailyTokenCap: Number.MAX_SAFE_INTEGER, concurrentPerPerson: 100, concurrentPerOperator: 1000 },
      inbox: { debounceSeconds: 600, debounceMaxSeconds: 3600, firstBubbleMs: 120000, bubbleGapMs: 60000 } }))).statusCode).toBe(200);
    const reset = await put(body({}, [], 1)); expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ revision: 2, overrides: { internal: {}, inbox: {} }, effective: defaults });
  });

  it.each([
    ['operator', { operatorId: newId() }], ['key', { key: 'arbitrary' }], ['updater', { updatedBy: newId() }],
    ['version', { schemaVersion: 2 }], ['negative revision', { expectedRevision: -1 }], ['fractional revision', { expectedRevision: 0.5 }],
    ['unknown root override', { overrides: { internal: {}, inbox: {}, enabled: true } }],
    ['model selection', { overrides: { internal: { model: 'ZZ TEST forbidden' }, inbox: {} } }],
    ['negative cap', { overrides: { internal: { dailyAskCap: -1 }, inbox: {} } }],
    ['fractional cap', { overrides: { internal: { personDailyCap: 0.5 }, inbox: {} } }],
    ['unsafe cap', { overrides: { internal: { dailyTokenCap: Number.MAX_SAFE_INTEGER + 1 }, inbox: {} } }],
    ['zero person concurrency', { overrides: { internal: { concurrentPerPerson: 0 }, inbox: {} } }],
    ['person concurrency ceiling', { overrides: { internal: { concurrentPerPerson: 101 }, inbox: {} } }],
    ['operator concurrency ceiling', { overrides: { internal: { concurrentPerOperator: 1001 }, inbox: {} } }],
    ['debounce ceiling', { overrides: { internal: {}, inbox: { debounceSeconds: 601 } } }],
    ['debounce-max ceiling', { overrides: { internal: {}, inbox: { debounceMaxSeconds: 3601 } } }],
    ['first-bubble ceiling', { overrides: { internal: {}, inbox: { firstBubbleMs: 120001 } } }],
    ['bubble-gap ceiling', { overrides: { internal: {}, inbox: { bubbleGapMs: 60001 } } }],
    ['coherence review as a word', { overrides: { internal: {}, inbox: { coherenceReview: 'off' } } }],
    ['coherence review as a number', { overrides: { internal: {}, inbox: { coherenceReview: 0 } } }],
    ['coherence review as null', { overrides: { internal: {}, inbox: { coherenceReview: null } } }],
  ])('R7 high: strict body rejects %s rather than silently changing engine policy or coercing native units', async (_label, change) => {
    expect((await put({ ...body(), ...change })).statusCode).toBe(400);
  });

  it('R8 high: queries are strict and mandatory idempotency cannot be omitted; caller cannot choose a different operator/key', async () => {
    expect((await read(cookie, '?operatorId=' + otherOperatorId)).statusCode).toBe(400);
    expect((await put(body(), newId(), cookie, '?key=other')).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'PUT', url: path, headers: { cookie }, payload: body() })).statusCode).toBe(400);
  });

  it('R9 high: one successful retry is the same revision/response/audit; a mismatched key body conflicts', async () => {
    await resetSettings(); const key = newId(), payload = body({ inbox: { dailyTurnCap: 4 } });
    const first = await put(payload, key); expect(first.statusCode).toBe(200);
    const retry = await put(payload, key); expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json()); expect(retry.headers['x-oto-replay']).toBe('true');
    expect(await audits()).toHaveLength(1); expect((await stored())[0]!.revision).toBe(1);
    expect((await put(body({ inbox: { dailyTurnCap: 5 } }), key)).statusCode).toBe(409);
  });

  it('R10 high: revoked or narrowed authority refuses before a stored write replay, then current operator-wide authority can replay it', async () => {
    await resetSettings(); const key = newId(), payload = body();
    const first = await put(payload, key); expect(first.statusCode).toBe(200);
    await granted('branch', parks);
    const denied = await put(payload, key); expect(denied.statusCode).toBe(403); expect(denied.headers['x-oto-replay']).toBeUndefined();
    await granted('operator', []); expect((await put(payload, key)).statusCode).toBe(403);
    await granted('operator', [operatorId]); expect((await put(payload, key)).json()).toEqual(first.json());
    expect(await audits()).toHaveLength(1);
  });

  it('R11 high: stale revisions cannot overwrite a successful document; earlier successful keys replay even after a later revision', async () => {
    await resetSettings(); const key = newId(), original = body({ internal: { personDailyCap: 3 } });
    const first = await put(original, key); expect(first.statusCode).toBe(200);
    const second = await put(body({ internal: { personDailyCap: 4 } }, [], 1)); expect(second.statusCode).toBe(200);
    const stale = await put(body({ internal: { personDailyCap: 5 } }, [], 1)); expect(stale.statusCode).toBe(409);
    expect((await read()).json()).toEqual(second.json());
    expect((await put(original, key)).json()).toEqual(first.json()); expect(await audits()).toHaveLength(2);
  });

  it('R12 high: both initial saves wait at a real DB boundary, then exactly one revision0 write/audit succeeds', async () => {
    await resetSettings(); let release!: () => void, locked!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const holder = ctx.db.transaction(async tx => { await tx.execute(sql`lock table core.setting in share mode`); locked(); await held; });
    await ready;
    const replies = Promise.all([put(body({ internal: { personDailyCap: 3 } })), put(body({ internal: { personDailyCap: 4 } }))]);
    try {
      await vi.waitFor(async () => {
        const result = await ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity
          where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock'
          and (query like '%setting%' or query like '%pg_advisory%')`);
        expect(Number(result.rows[0]?.n)).toBe(2);
      }, { timeout: 5000, interval: 20 });
    } finally { release(); await holder; await replies; }
    const answers = await replies; expect(answers.map(r => r.statusCode).sort()).toEqual([200, 409]);
    const winner = answers.find(r => r.statusCode === 200)!;
    expect((await read()).json()).toEqual(winner.json()); expect((await stored())[0]!.revision).toBe(1); expect(await audits()).toHaveLength(1);
  });

  it('R13 high: audit failure rolls back document/revision and idempotent success; the same key can genuinely retry', async () => {
    await resetSettings(); const key = newId();
    await ctx.db.execute(sql`create function core.zz_test_638_refuse_audit() returns trigger language plpgsql as $$
      begin if new.action='assistant_settings.update' then raise exception 'ZZ TEST audit refusal'; end if; return new; end $$`);
    await ctx.db.execute(sql`create trigger zz_test_638_refuse_audit before insert on core.audit_log
      for each row execute function core.zz_test_638_refuse_audit()`);
    try {
      expect((await put(body(), key)).statusCode).toBe(500);
      expect(await stored()).toEqual([]); expect(await audits()).toHaveLength(0);
      expect(await ctx.db.select().from(idempotencyKey).where(and(eq(idempotencyKey.accountId, accountId), eq(idempotencyKey.key, key)))).toHaveLength(0);
    } finally {
      await ctx.db.execute(sql`drop trigger zz_test_638_refuse_audit on core.audit_log`);
      await ctx.db.execute(sql`drop function core.zz_test_638_refuse_audit()`);
    }
    expect((await put(body(), key)).statusCode).toBe(200); expect(await audits()).toHaveLength(1);
  });

  it('R14 high: two genuine operators retain independent documents/rates/revisions; no shared runtime config is mutated', async () => {
    await resetSettings(); expect((await read(otherCookie)).statusCode).toBe(200);
    const own = await put(body({ internal: { personDailyCap: 2 } }, [rate()])); expect(own.statusCode).toBe(200);
    const foreign = await put(body({ internal: { personDailyCap: 9 } }), newId(), otherCookie); expect(foreign.statusCode).toBe(200);
    expect(foreign.json()).toMatchObject({ operatorId: otherOperatorId, revision: 1, updatedBy: otherAccountId, rates: [], effective: { internal: { personDailyCap: 9 } } });
    expect((await read()).json()).toEqual(own.json()); expect((await stored())[0]!.revision).toBe(1);
    expect(ctx.app.env.INTERNAL_AI_PERSON_DAILY_CAP).toBe(11);
  });

  it('R15 high: unknown or invalid stored JSON is entirely invalid/defaulted; raw private fields never enter response or repair audit', async () => {
    await resetSettings(); const marker = 'ZZ TEST untrusted metadata';
    await ctx.db.execute(sql`insert into core.setting(operator_id,key,value,revision,updated_by)
      values (${operatorId},'assistant_settings',${JSON.stringify({ schemaVersion: 1, overrides: { internal: { personDailyCap: 2 }, inbox: {} }, rates: [], apiKey: marker })}::jsonb,7,${accountId})`);
    const invalid = await read(); expect(invalid.statusCode).toBe(200);
    expect(invalid.json()).toMatchObject({ source: 'invalid', revision: 7, overrides: { internal: {}, inbox: {} }, rates: [], effective: defaults });
    expect(invalid.body).not.toContain(marker); expect(invalid.body).not.toContain('apiKey');
    const repair = await put(body({}, [], 7)); expect(repair.statusCode).toBe(200); expect(repair.json().revision).toBe(8);
    expect(JSON.stringify(await audits())).not.toContain(marker); expect(JSON.stringify(await audits())).not.toContain('apiKey');
  });

  it('R16 medium: a malformed known numeric field does not partially apply otherwise valid overrides', async () => {
    await resetSettings();
    await ctx.db.execute(sql`insert into core.setting(operator_id,key,value) values (${operatorId},'assistant_settings',
      ${JSON.stringify({ schemaVersion: 1, overrides: { internal: { personDailyCap: 2 }, inbox: { bubbleGapMs: -1 } }, rates: [] })}::jsonb)`);
    const response = await read(); expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ source: 'invalid', effective: defaults, overrides: { internal: {}, inbox: {} }, rates: [] });
  });

  it('R17 high: versioned rates retain exact valid history; edits/removal/backdated changes conflict without a revision or audit change', async () => {
    await resetSettings(); const initial = rate();
    const created = await put(body({}, [initial])); expect(created.statusCode).toBe(200); expect(created.json().rates).toEqual([initial]);
    for (const rates of [[], [{ ...initial, outputUsdPerMillion: 9 }], [initial, rate('2026-09-01T00:00:00.000Z')]]) {
      expect((await put(body({}, rates, 1))).statusCode).toBe(409);
      expect((await read()).json()).toEqual(created.json());
    }
    const later = { ...rate('2026-11-01T00:00:00.000Z'), inputUsdPerMillion: 0, outputUsdPerMillion: 0, cacheReadUsdPerMillion: 0 };
    const changed = await put(body({}, [initial, later], 1)); expect(changed.statusCode).toBe(200);
    expect(changed.json().rates).toEqual([initial, later]); expect(changed.json().revision).toBe(2); expect(await audits()).toHaveLength(2);
  });

  it.each([
    ['duplicate version', [rate(), rate()]], ['trim duplicate', [rate(), rate(undefined, ' ZZ TEST model ')]],
    ['negative rate', [{ ...rate(), inputUsdPerMillion: -1 }]], ['unknown rate field', [{ ...rate(), apiKey: 'ZZ TEST rejected' }]],
    ['empty model', [rate(undefined, ' ')]], ['oversize model', [rate(undefined, 'x'.repeat(201))]],
    ['non-UTC date', [rate('2026-10-01T01:00:00+01:00')]], ['invalid date', [rate('2026-02-30T00:00:00.000Z')]],
  ])('R18 high: strict model-rate input rejects %s without selecting a model or exposing credentials', async (_label, rates) => {
    expect((await put(body({}, rates))).statusCode).toBe(400);
  });

  it('R19 medium: the maximum PostgreSQL revision refuses clearly before overflow; prescribe an integer-column capacity guard', async () => {
    await resetSettings();
    await ctx.db.execute(sql`insert into core.setting(operator_id,key,value,revision,updated_by)
      values (${operatorId},'assistant_settings',${JSON.stringify({ schemaVersion: 1, overrides: { internal: {}, inbox: {} }, rates: [] })}::jsonb,2147483647,${accountId})`);
    const before = await read(); expect(before.statusCode).toBe(200); const original = await stored();
    const response = await put(body({ internal: { dailyAskCap: 2 } }, [], 2147483647));
    expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('ASSISTANT_SETTINGS_REVISION');
    expect(await stored()).toEqual(original); expect((await read()).json()).toEqual(before.json()); expect(await audits()).toHaveLength(0);
  });

  it('R20 high: direct readers return only their exact operator validated sparse values/rates and re-read changes without shared mutation', async () => {
    await resetSettings(); const originalRate = rate(), foreignRate = rate(undefined, 'ZZ TEST other model');
    expect((await put(body({ internal: { personDailyCap: 0 } }, [originalRate]))).statusCode).toBe(200);
    expect((await put(body({ inbox: { dailyTurnCap: 8 } }, [foreignRate]), newId(), otherCookie)).statusCode).toBe(200);
    const original = await assistantSettingOverridesOf(ctx.db, operatorId);
    expect(original).toEqual({ internal: { personDailyCap: 0 }, inbox: {} });
    expect(await assistantSettingRatesOf(ctx.db, operatorId)).toEqual([originalRate]);
    expect(await assistantSettingOverridesOf(ctx.db, otherOperatorId)).toEqual({ internal: {}, inbox: { dailyTurnCap: 8 } });
    expect(await assistantSettingRatesOf(ctx.db, otherOperatorId)).toEqual([foreignRate]);
    const later = rate('2026-11-01T00:00:00.000Z');
    expect((await put(body({ inbox: { firstBubbleMs: 0 } }, [originalRate, later], 1))).statusCode).toBe(200);
    expect(await assistantSettingOverridesOf(ctx.db, operatorId)).toEqual({ internal: {}, inbox: { firstBubbleMs: 0 } });
    expect(await assistantSettingRatesOf(ctx.db, operatorId)).toEqual([originalRate, later]);
    expect(original).toEqual({ internal: { personDailyCap: 0 }, inbox: {} });
    expect(ctx.app.env.INTERNAL_AI_PERSON_DAILY_CAP).toBe(11);
  });

  it('R21 high: absent or invalid documents give empty direct-reader values, never trusted partial overrides/rates', async () => {
    await resetSettings();
    expect(await assistantSettingOverridesOf(ctx.db, operatorId)).toEqual({ internal: {}, inbox: {} });
    expect(await assistantSettingRatesOf(ctx.db, operatorId)).toEqual([]);
    await ctx.db.execute(sql`insert into core.setting(operator_id,key,value) values (${operatorId},'assistant_settings',
      ${JSON.stringify({ schemaVersion: 1, overrides: { internal: { personDailyCap: 2 }, inbox: {} }, rates: [rate()], unknown: 'ZZ TEST invalid metadata' })}::jsonb)`);
    expect(await assistantSettingOverridesOf(ctx.db, operatorId)).toEqual({ internal: {}, inbox: {} });
    expect(await assistantSettingRatesOf(ctx.db, operatorId)).toEqual([]);
    expect(await assistantSettingRatesOf(ctx.db, otherOperatorId)).toEqual([]);
  });

  it.each([
    ['overrides', assistantSettingOverridesOf], ['rates', assistantSettingRatesOf],
  ] as const)('R22 high: %s reader propagates an actual database read error; unavailable is not empty/default', async (_name, reader) => {
    await resetSettings(); const rollback = new Error('ZZ TEST restore the temporary table rename');
    let readFailure: unknown;
    await expect(ctx.db.transaction(async tx => {
      // Transaction-local test DDL is rolled back; no migration or shared DB is changed.
      await tx.execute(sql`alter table core.setting rename to zz_test_638_unavailable_setting`);
      try { await reader(tx, operatorId); } catch (error) { readFailure = error; }
      expect(readFailure).toBeDefined();
      throw rollback;
    })).rejects.toBe(rollback);
    expect((await read()).statusCode).toBe(200);
  });

  it('R23 medium: refuse UTC year zero before it becomes immutable history that PostgreSQL cannot price', async () => {
    await resetSettings();
    const response = await put(body({}, [rate('0000-01-01T00:00:00.000Z')]));
    expect(response.statusCode).toBe(400);
    expect(await stored()).toEqual([]); expect(await audits()).toHaveLength(0);
  });
});
