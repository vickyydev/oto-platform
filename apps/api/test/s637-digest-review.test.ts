import { createHash } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { branch, operator, opsLast, opsRun } from '@oto/db';
import { newId } from '@oto/shared';
import {
  createConsoleDigestSender, runConsoleDigest, type DigestOptions, type DigestSender,
} from '../src/services/console-digest';
import { createJobRunner, type JobDefinition } from '../src/services/jobs';
import { JobFailedError } from '../src/services/job-failure';
import { recordRun } from '../src/services/ops';
import { overviewForScopeOf } from '../src/services/console';
import { createTestContext, teardownAll, type TestContext } from './helpers';

const names = ['console.digest.intent', 'console.digest.delivery', 'job:console.digest'];
const now = new Date('2026-10-25T00:30:00.000Z'); // Bangkok 07:30, after the actual 05:00 start.
const summary = 'ZZ TEST Park\nBusiness date: 2026-10-25\nRevenue unavailable\nUSD estimate unavailable: no_rate_configured';
const summaryHash = createHash('sha256').update(summary).digest('hex');
let ctx: TestContext;
const opA = newId();
const opB = newId();
const archivedOp = newId();
const parkA = newId();
const parkA2 = newId();
const parkB = newId();
const archivedOpPark = newId();

const accepted = () => vi.fn<DigestSender>().mockResolvedValue({ state: 'accepted', status: 202 });
const snapshot = () => vi.fn<DigestOptions['snapshot']>().mockResolvedValue({ statusSummary: summary });
const rows = () => ctx.db.select().from(opsRun).where(inArray(opsRun.name, names));
const run = (sender: DigestSender | undefined, options: Partial<DigestOptions> = {}) =>
  runConsoleDigest(ctx.db, { enabled: true, now, sender, snapshot: snapshot(), ...options });

async function failed(promise: Promise<unknown>): Promise<JobFailedError> {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(JobFailedError);
    return error as JobFailedError;
  }
  throw new Error('Expected a recorded digest failure');
}

async function rejectPhase(name: string) {
  await ctx.db.execute(sql`create or replace function core.zz_test_digest_record_guard() returns trigger
    language plpgsql as $$ begin raise exception 'ZZ TEST private record diagnostic'; end $$`);
  await ctx.db.execute(sql.raw(`create trigger zz_test_digest_record_guard before insert on core.ops_run
    for each row when (new.name = '${name}') execute function core.zz_test_digest_record_guard()`));
}
async function removeRecordGuard() {
  await ctx.db.execute(sql`drop trigger if exists zz_test_digest_record_guard on core.ops_run`);
  await ctx.db.execute(sql`drop function if exists core.zz_test_digest_record_guard()`);
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api,jobs' } });
  // This file owns an isolated disposable core DB, with no real delivery or sign-in.
  await ctx.db.update(operator).set({ archivedAt: now });
  await ctx.db.insert(operator).values([
    { id: opA, name: 'ZZ TEST Digest A' }, { id: opB, name: 'ZZ TEST Digest B' },
    { id: archivedOp, name: 'ZZ TEST Digest archived', archivedAt: now },
  ]);
  await ctx.db.insert(branch).values([
    { id: parkA, operatorId: opA, name: 'ZZ TEST Digest A1', code: 'zz-digest-a1', timezone: 'Asia/Bangkok', businessDayStart: '05:00' },
    { id: parkA2, operatorId: opA, name: 'ZZ TEST Digest A2', code: 'zz-digest-a2', timezone: 'America/New_York', businessDayStart: '05:00' },
    { id: parkB, operatorId: opB, name: 'ZZ TEST Digest B1', code: 'zz-digest-b1', timezone: 'Asia/Bangkok', businessDayStart: '05:00' },
    { id: archivedOpPark, operatorId: archivedOp, name: 'ZZ TEST Digest archived parent', code: 'zz-digest-archived' },
  ]);
});
beforeEach(async () => {
  await removeRecordGuard();
  await ctx.db.delete(opsLast).where(inArray(opsLast.name, names));
  await ctx.db.delete(opsRun).where(inArray(opsRun.name, names));
  await ctx.db.update(branch).set({ archivedAt: now }).where(inArray(branch.id, [parkA2, parkB]));
  await ctx.db.update(branch).set({ archivedAt: null }).where(eq(branch.id, parkA));
});
afterEach(async () => { await removeRecordGuard(); });
afterAll(async () => { await ctx?.close(); await teardownAll(); });

describe('SCRUM-637 branch morning digest — real receipts, injected transport only', () => {
  it('R1: disabled and missing destination perform no snapshot, dispatch or intent writes', async () => {
    const send = accepted(); const read = snapshot();
    expect(await run(send, { enabled: false, snapshot: read })).toEqual({ mode: 'disabled', groups: [] });
    expect(await run(undefined, { snapshot: read })).toEqual({ mode: 'not-configured', groups: [] });
    expect(send).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(await rows()).toEqual([]);
  });

  it('R2: before the actual local start sends nothing; the boundary and later startup catch up the current day only', async () => {
    const send = accepted();
    await run(send, { now: new Date('2026-10-24T21:59:59Z') });
    expect(send).not.toHaveBeenCalled();
    const result = await run(send, { now: new Date('2026-10-24T22:00:00Z') });
    expect(send).toHaveBeenCalledExactlyOnceWith(summary);
    expect(result.groups).toEqual([expect.objectContaining({ operatorId: opA, branchId: parkA, date: '2026-10-25', state: 'accepted' })]);
    await run(send, { now });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('R3: the same trusted snapshot and exact text use one selected live owned branch, without global buckets or fake grants', async () => {
    const send = accepted(); const read = snapshot();
    await run(send, { snapshot: read });
    expect(read).toHaveBeenCalledTimes(1);
    const [db, scope] = read.mock.calls[0]!;
    expect(db).toBe(ctx.db); expect(scope.operatorId).toBe(opA);
    expect(scope.available.map(b => b.id)).toEqual([parkA]);
    expect(scope.selected.map(b => b.id)).toEqual([parkA]);
    expect(scope.includeOperatorWide).toBe(false); expect(scope.now).toBe(now);
    expect(scope).not.toHaveProperty('effective'); expect(scope).not.toHaveProperty('auth');
    expect(send).toHaveBeenCalledExactlyOnceWith(summary);
    const records = await rows();
    expect(records).toHaveLength(2);
    expect(records.every(r => r.kind === 'console' && r.operatorId === opA && r.branchId === parkA)).toBe(true);
    const intent = records.find(r => r.name === names[0])!;
    const delivery = records.find(r => r.name === names[1])!;
    expect(intent.detail).toMatchObject({ version: 1, operatorId: opA, branchId: parkA, date: '2026-10-25', summaryHash });
    const intentId = (intent.detail as { intentId: string }).intentId;
    expect(intentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(delivery.detail).toMatchObject({ version: 1, intentId, date: '2026-10-25', state: 'accepted', status: 202, summaryHash });
    expect(JSON.stringify(records)).not.toContain(summary);
  });

  it('R4: independent timezone/branch/operator keys do not suppress one another; archived parents and branches never send', async () => {
    await ctx.db.update(branch).set({ archivedAt: null }).where(inArray(branch.id, [parkA2, parkB]));
    const send = accepted(); const read = snapshot();
    const result = await run(send, { snapshot: read });
    expect(send).toHaveBeenCalledTimes(3);
    expect(result.groups.map(g => [g.operatorId, g.branchId, g.date]).sort()).toEqual([
      [opA, parkA, '2026-10-25'], [opA, parkA2, '2026-10-24'], [opB, parkB, '2026-10-25'],
    ].sort());
    for (const [, scope] of read.mock.calls) {
      expect(scope.selected).toHaveLength(1);
      expect(scope.available.map(b => b.id).sort()).toEqual(scope.operatorId === opA ? [parkA, parkA2].sort() : [parkB]);
      expect(scope.selected[0]!.id).not.toBe(archivedOpPark);
    }
  });

  it('R5: accepted day receipts suppress another tick/Retry but not the next native date', async () => {
    const send = accepted(); await run(send); await run(send);
    expect(send).toHaveBeenCalledTimes(1);
    await run(send, { now: new Date('2026-10-26T00:30:00Z') });
    expect(send).toHaveBeenCalledTimes(2);
    expect((await rows()).filter(r => r.name === names[1])).toHaveLength(2);
  });

  it('R6: failed durable intent persistence dispatches zero requests and exposes only a safe code', async () => {
    await rejectPhase(names[0]!); const send = accepted();
    const error = await failed(run(send));
    expect(send).not.toHaveBeenCalled(); expect(await rows()).toEqual([]);
    expect(error.detail).toMatchObject({ groups: [expect.objectContaining({ branchId: parkA, state: 'failed', code: 'intent-write' })] });
    expect(JSON.stringify(error.detail)).not.toContain('private record diagnostic');
  });

  it('R7: snapshot refusal cannot become a zero digest or leave a dispatch intent', async () => {
    const send = accepted(); const read = snapshot().mockRejectedValue(new Error('ZZ TEST private snapshot diagnostic'));
    const error = await failed(run(send, { snapshot: read }));
    expect(send).not.toHaveBeenCalled(); expect(await rows()).toEqual([]);
    expect(error.detail).toMatchObject({ groups: [expect.objectContaining({ code: 'snapshot', state: 'failed' })] });
    expect(JSON.stringify(error.detail)).not.toContain('private snapshot diagnostic');
  });

  it('R8: an unknown response remains uncertain across another tick and does not resend', async () => {
    const send = vi.fn<DigestSender>().mockResolvedValue({ state: 'uncertain', code: 'transport-timeout' });
    await failed(run(send)); const second = await failed(run(send));
    expect(send).toHaveBeenCalledTimes(1);
    expect(second.detail).toMatchObject({ groups: [expect.objectContaining({ state: 'uncertain' })] });
    expect((await rows()).some(r => (r.detail as { state?: string })?.state === 'accepted')).toBe(false);
  });

  it('R9: acknowledgement followed by failed durable delivery recording is not claimed successful or resent', async () => {
    await rejectPhase(names[1]!); const send = accepted();
    await failed(run(send)); await removeRecordGuard(); await failed(run(send));
    expect(send).toHaveBeenCalledTimes(1);
    expect((await rows()).map(r => r.name)).toEqual([names[0]]);
  });

  it('R10: an orphaned intent after process death blocks a fresh worker without an absence-based guess', async () => {
    const intentId = newId();
    await recordRun(ctx.db, { kind: 'console', name: names[0]!, outcome: 'ok', operatorId: opA, branchId: parkA,
      startedAt: now, detail: { version: 1, operatorId: opA, branchId: parkA, date: '2026-10-25', intentId, summaryHash } });
    const send = accepted(); await failed(run(send));
    expect(send).not.toHaveBeenCalled();
  });

  it('R11: a proven predispatch refusal is recorded and may retry; already accepted siblings stay accepted', async () => {
    await ctx.db.update(branch).set({ archivedAt: null }).where(eq(branch.id, parkB));
    const send = vi.fn<DigestSender>().mockResolvedValueOnce({ state: 'accepted', status: 202 })
      .mockResolvedValueOnce({ state: 'not-dispatched', code: 'transport-response' })
      .mockResolvedValue({ state: 'accepted', status: 202 });
    await failed(run(send));
    const result = await run(send);
    expect(send).toHaveBeenCalledTimes(3);
    expect(result.groups.map(g => g.state).sort()).toEqual(['accepted', 'already-accepted']);
    expect((await rows()).filter(r => r.name === names[1] && (r.detail as { state?: string })?.state === 'accepted')).toHaveLength(2);
  });

  it('R12: two existing exclusive runners cannot send the same claimed day concurrently', async () => {
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn<DigestSender>().mockImplementation(async () => { await held; return { state: 'accepted', status: 202 }; });
    const job: JobDefinition = { name: names[2]!, description: 'ZZ TEST digest runner', intervalSeconds: 60, exclusive: true,
      run: async () => ({ detail: { ...await run(send) } }) };
    const firstRunner = createJobRunner({ db: ctx.db, env: ctx.app.env, log: ctx.app.log, jobs: [job], channels: [] });
    const secondRunner = createJobRunner({ db: ctx.db, env: ctx.app.env, log: ctx.app.log, jobs: [job], channels: [] });
    const first = firstRunner.runJob(job.name, { force: true });
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(await secondRunner.runJob(job.name, { force: true })).toBe('locked');
    } finally { release(); await first; }
    expect(await secondRunner.runJob(job.name, { force: true })).toBe('ok');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('R17: a changed clock between eligibility and the real Overview snapshot cannot send under the earlier date/start', async () => {
    const send = accepted();
    try {
      let failure: unknown;
      try {
        await run(send, { snapshot: async (db, scope) => {
          await db.update(branch).set({ businessDayStart: '08:00' }).where(eq(branch.id, parkA));
          // The real builder reloads the new clock and correctly shows the prior
          // native date at Bangkok 07:30. Digest must not send it as today's key.
          const result = await overviewForScopeOf(db, scope);
          expect(result.parks[0]!.businessDate).toBe('2026-10-24');
          return result;
        } });
      } catch (error) { failure = error; }
      expect(send).not.toHaveBeenCalled();
      expect(await rows()).toEqual([]);
      expect(failure).toBeInstanceOf(JobFailedError);
      expect((failure as JobFailedError).detail).toMatchObject({ groups: [expect.objectContaining({ state: 'failed', code: 'snapshot' })] });
    } finally {
      await ctx.db.update(branch).set({ businessDayStart: '05:00' }).where(eq(branch.id, parkA));
    }
  });

  it.each(['branch', 'operator'] as const)('R18: %s archived after the real snapshot leaves no dispatch or intent', async target => {
    const send = accepted();
    try {
      let failure: unknown;
      try {
        await run(send, { snapshot: async (db, scope) => {
          const result = await overviewForScopeOf(db, scope);
          if (target === 'branch') await db.update(branch).set({ archivedAt: now }).where(eq(branch.id, parkA));
          else await db.update(operator).set({ archivedAt: now }).where(eq(operator.id, opA));
          return result;
        } });
      } catch (error) { failure = error; }
      expect(send).not.toHaveBeenCalled();
      expect(await rows()).toEqual([]);
      expect(failure).toBeInstanceOf(JobFailedError);
      expect((failure as JobFailedError).detail).toMatchObject({ groups: [expect.objectContaining({ state: 'failed', code: 'snapshot' })] });
    } finally {
      await ctx.db.update(branch).set({ archivedAt: null }).where(eq(branch.id, parkA));
      await ctx.db.update(operator).set({ archivedAt: null }).where(eq(operator.id, opA));
    }
  });
});

describe('SCRUM-637 generic private HTTPS adapter — fake fetch only', () => {
  it('R13: absent/non-HTTPS/userinfo/fragment configuration creates no sender and performs zero requests', () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const url of [undefined, '', 'http://example.invalid/digest', 'https://user@example.invalid/digest', 'https://example.invalid/digest#fragment', 'https://example.invalid/digest#']) {
      expect(createConsoleDigestSender(url, { fetch: fetcher })).toBeUndefined();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('R14: sends only JSON text with redirects refused and cancels an unused response body', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue({ status: 202, redirected: false, body: { cancel } } as unknown as Response);
    const send = createConsoleDigestSender('https://example.invalid/digest', { fetch: fetcher })!;
    expect(typeof send).toBe('function');
    expect(await send(summary)).toEqual({ state: 'accepted', status: 202 });
    const [, options] = fetcher.mock.calls[0]!;
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: summary }) });
    expect(options?.signal).toBeInstanceOf(AbortSignal); expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('R15: a dispatched HTTP error/redirect response is not accepted or represented as a safe no-send', async () => {
    for (const response of [{ status: 500, redirected: false }, { status: 200, redirected: true }]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue({ ...response, body: null } as Response);
      const send = createConsoleDigestSender('https://example.invalid/digest', { fetch: fetcher })!;
      expect(await send(summary)).toMatchObject({ state: 'uncertain', code: 'transport-response' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('R16: the finite timeout aborts a stalled request and returns no raw URL or error', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error('ZZ TEST private transport diagnostic')), { once: true });
    }));
    const send = createConsoleDigestSender('https://example.invalid/digest', { fetch: fetcher, timeoutMs: 10 })!;
    const result = await send(summary);
    expect(result).toEqual({ state: 'uncertain', code: 'transport-timeout' });
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(JSON.stringify(result)).not.toContain('example.invalid');
    expect(JSON.stringify(result)).not.toContain('private transport diagnostic');
  });
});
