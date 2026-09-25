import { createHash, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  account,
  alert,
  auditLog,
  boothConfigVersion,
  boothStaffAssignment,
  boxPrintJob,
  spin,
  station,
  syncQuarantine,
  voucher,
  voucherDefinition,
  voucherPrint,
  type Db,
} from '@oto/db';
import { mintBoothCode, newId, type RandomIndex } from '@oto/shared';
import { renderJob } from '@oto/print';
import { PROFILES } from '@oto/print/fixtures';
import {
  createBoxAgent,
  memoryCredentialStore,
  postgresBoxDriver,
  SqlBoxStore,
  type AgentFetch,
  type Booth,
  type BoxAgent,
  type PgPoolLike,
} from '@oto/box-agent';
import {
  ADMIN,
  CHALONG_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  teardownAll,
  type TestContext,
} from './helpers';
import { provisionVirtualBox } from '../src/services/box';

/**
 * S2-07a — the seam between a booth and the cloud, crossed for real.
 *
 * **Why this file builds no envelope.** S2-05 shipped three tests that each
 * hand-wrote the JSON a box would send, pushed it, and asserted the rows that
 * came out. All three passed. No Raspberry Pi could have synced at all,
 * because nothing in them ever ran the code that MINTS an envelope — the
 * sequence allocation, the canonical bytes, the signature — and the two ends
 * had drifted apart without a single test noticing.
 *
 * So every push below starts at the top: the real booth module draws a real
 * prize on the real in-process agent, its facts land on the real durable
 * outbox, and `flush()` sends them through the real `POST /box/v1/sync/push`.
 * The only things standing in for hardware are the socket — `app.inject` in
 * place of a wire — and the printer, which is the simulator every virtual box
 * uses.
 *
 * What that buys beyond the rows: the event NAMES and payload shapes are
 * checked by use. A handler registered under a type the booth does not queue,
 * or expecting a field the booth does not send, leaves this file with a
 * quarantined event instead of a row — which is exactly the failure a
 * hand-written envelope hides.
 */

let ctx: TestContext;
let agent: BoxAgent;
let booth: Booth;
let boothStationId: string;
let operatorId: string;
let branchId: string;

/**
 * The booth's randomness, so one test can make the box repeat itself.
 *
 * Null is `randomInt` from `node:crypto`, which is what a real box uses (D3)
 * and what every test here draws with except the collision, where the whole
 * point is a code that comes up twice.
 */
let drawWith: RandomIndex | null = null;

/** `app.inject` behind the agent's transport, as `box-agent.test.ts` does it. */
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

beforeAll(async () => {
  ctx = await createTestContext();
  const [seeded] = await ctx.db
    .select({ id: station.id, operatorId: station.operatorId, branchId: station.branchId })
    .from(station)
    .where(eq(station.name, 'Booth 1'))
    .limit(1);
  boothStationId = seeded!.id;
  operatorId = seeded!.operatorId;
  branchId = seeded!.branchId;

  /**
   * One box for the file, on purpose.
   *
   * A second agent against the same box would register again and rotate its
   * signing key, and anything the first left queued would stop verifying —
   * which is a real property of the virtual box (see `POST /box/v1/sync/key`)
   * and not something to discover halfway through a collision test.
   *
   * Its timers are never started: `start()` would set a heartbeat, a poll and
   * a flush going for the life of the file, and each step here is called by
   * hand so that what a single flush did can be asserted.
   */
  const pool = (ctx.db as unknown as { $client: PgPoolLike }).$client;
  agent = createBoxAgent({
    apiBaseUrl: 'http://booth-sync.test',
    credentials: memoryCredentialStore(),
    hostname: 'booth-sync-test',
    fetch: injectTransport(),
    claimCode: async () => (await provisionVirtualBox(ctx.db as Db, ctx.app.log))?.claimCode ?? null,
    store: new SqlBoxStore({ driver: postgresBoxDriver(pool) }),
    booth: { randomIndex: (max) => (drawWith ? drawWith(max) : randomInt(max)) },
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  await agent.syncCache();

  const built = agent.booth();
  if (!built) {
    throw new Error('the agent built no booth module — no spin can be taken on this box');
  }
  booth = built;
  await booth.start();
  if (!booth.config()) {
    throw new Error(
      'the booth adopted no wheel: the `booth` cache scope reached it empty or unreadable',
    );
  }
});

afterAll(async () => {
  booth?.stop();
  agent?.stop();
  await ctx.close();
  await teardownAll();
});

describe('a spin crosses the seam (S2-07a)', () => {
  it('reaches the cloud as a spin, a voucher, and the code that is on the paper', async () => {
    const response = await booth.spin({ idempotencyKey: newId() });
    expect(response.spinId).toBeTruthy();
    expect(response.voucherCode, 'the box minted no code for a prize it drew').toBeTruthy();
    const code = response.voucherCode!;

    /**
     * The paper, before anything is sent.
     *
     * The durable job on the box is the renderer's INPUT, and that is where
     * the code is asserted — **not in the rendered bytes, which do not contain
     * it as text.** `@oto/print` rasterises: every character and the QR go to
     * the printer as dots, so a search for `B1…` in the output would fail on a
     * slip that says it perfectly. What is proved here instead is that the
     * job the printer was handed carries this code, and that it renders — the
     * bytes exist and a head could burn them.
     */
    const [job] = await ctx.db
      .select()
      .from(boxPrintJob)
      .where(eq(boxPrintJob.boxId, agent.state.boxId!))
      .orderBy(desc(boxPrintJob.queuedAt))
      .limit(1);
    expect(job, 'the booth queued no print job for a voucher it minted').toBeTruthy();
    expect(job!.kind).toBe('booth_voucher');
    const paper = job!.job as { kind: string; data: { voucherCode: string } };
    expect(paper.data.voucherCode, 'the printed slip carries a different code').toBe(code);
    expect(renderJob(job!.job as never, { device: PROFILES.escpos576! }).bytes.length).toBeGreaterThan(
      0,
    );

    // One flush, through the route a Pi uses.
    const flushed = await agent.outbox()!.flush();
    expect(flushed.state).toBe('pushed');
    if (flushed.state !== 'pushed') throw new Error('unreachable');

    /**
     * The two facts a press is made of, by name.
     *
     * Asserted here rather than as `quarantined === 0` for the whole batch,
     * because the batch also carries the print outcome — which is its own
     * question, and the test below is where it is asked. What this one must
     * show is that the spin and the voucher were not refused: a handler
     * registered under a name the booth does not queue, or expecting a field
     * it does not send, lands exactly here.
     */
    const refused = await ctx.db
      .select({
        type: syncQuarantine.type,
        code: syncQuarantine.errorCode,
        message: syncQuarantine.errorMessage,
      })
      .from(syncQuarantine)
      .where(inArray(syncQuarantine.type, ['booth.spin_recorded', 'promo.voucher_issued']));
    expect(
      refused.map((r) => `${r.type} — ${r.code}: ${r.message}`),
      'the cloud refused a fact the booth queued — the two ends disagree about its name or its shape',
    ).toEqual([]);

    const [row] = await ctx.db.select().from(spin).where(eq(spin.id, response.spinId)).limit(1);
    expect(row, 'the press reached the cloud as no spin row at all').toBeTruthy();
    expect(row!.stationId).toBe(boothStationId);
    expect(row!.boxId).toBe(agent.state.boxId);
    expect(row!.prizeId).toBe(response.prizeId);
    expect(row!.outcome).toBe('prize');
    // Tenancy from the credential, never from the payload.
    expect(row!.operatorId).toBe(operatorId);
    expect(row!.branchId).toBe(branchId);
    // NOT NULL with no default, resolved from the branch's business_day_start.
    expect(row!.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The wheel that drew, and it is this booth's.
    const [version] = await ctx.db
      .select({ stationId: boothConfigVersion.stationId, version: boothConfigVersion.version })
      .from(boothConfigVersion)
      .where(eq(boothConfigVersion.id, row!.boothConfigVersionId))
      .limit(1);
    expect(version!.stationId).toBe(boothStationId);
    expect(version!.version).toBe(response.configVersion);

    const [paperwork] = await ctx.db
      .select()
      .from(voucher)
      .where(and(eq(voucher.operatorId, operatorId), eq(voucher.code, code)))
      .limit(1);
    expect(paperwork, 'the code on the paper is a code the park has never heard of').toBeTruthy();
    expect(paperwork!.source).toBe('booth');
    expect(paperwork!.status).toBe('issued');
    expect(paperwork!.branchId).toBe(branchId);
    // The spin and the voucher, tied together whichever arrived first.
    expect(row!.voucherId).toBe(paperwork!.id);

    /**
     * The audit row carries the event it came from, which is what ties the
     * booth's own log, the box's queue and this row to one action.
     */
    const [entry] = await ctx.db
      .select({ sourceEventId: auditLog.sourceEventId, operatorId: auditLog.operatorId })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, response.spinId), eq(auditLog.action, 'spin.record')))
      .limit(1);
    expect(entry, 'a spin was filed with no audit row').toBeTruthy();
    expect(entry!.sourceEventId).toBeTruthy();
    expect(entry!.operatorId).toBe(operatorId);

    const [issue] = await ctx.db
      .select({ sourceEventId: auditLog.sourceEventId })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, paperwork!.id), eq(auditLog.action, 'voucher.issue')))
      .limit(1);
    expect(issue, 'a voucher was filed with no audit row').toBeTruthy();
    expect(issue!.sourceEventId).not.toBe(entry!.sourceEventId);
  });

  it('files a second press as a second spin, and a retried one as neither', async () => {
    const first = await booth.spin({ idempotencyKey: newId() });
    const second = await booth.spin({ idempotencyKey: newId() });
    expect(second.spinId).not.toBe(first.spinId);
    await agent.outbox()!.flush();

    const rows = await ctx.db
      .select({ id: spin.id })
      .from(spin)
      .where(eq(spin.boxId, agent.state.boxId!));
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([first.spinId, second.spinId]));

    /**
     * D7 from the other side: a network retry is one spin. The same key
     * presented again never reaches the draw, so there is no second fact to
     * send and nothing new arrives in the cloud.
     */
    const key = newId();
    const pressed = await booth.spin({ idempotencyKey: key });
    const retried = await booth.spin({ idempotencyKey: key });
    expect(retried.spinId).toBe(pressed.spinId);
    await agent.outbox()!.flush();
    expect(await ctx.db.select({ id: spin.id }).from(spin).where(eq(spin.id, pressed.spinId))).toHaveLength(
      1,
    );
  });

  it('quarantines a duplicate code and names both booths, rather than reassigning it', async () => {
    /**
     * A box whose random source repeated itself.
     *
     * The collision is staged where it actually comes from rather than by
     * editing a queued envelope, which could not work anyway: the payload is
     * hashed and signed as it is sealed, so a tampered one is refused for the
     * hash long before a handler sees the code. Fixing the draw makes the box
     * mint the same ten characters twice, which is what `booth-code.ts`'s own
     * arithmetic says to expect two or three times a decade — and what the
     * cloud sees is exactly what it would see from two booths: one code, two
     * vouchers, both printed.
     */
    drawWith = () => 0;
    const first = await booth.spin({ idempotencyKey: newId() });
    const second = await booth.spin({ idempotencyKey: newId() });
    drawWith = null;
    expect(second.voucherCode, 'the fixed draw did not repeat a code').toBe(first.voucherCode);
    const code = first.voucherCode!;

    const flushed = await agent.outbox()!.flush();
    expect(flushed.state).toBe('pushed');
    if (flushed.state !== 'pushed') throw new Error('unreachable');
    expect(flushed.quarantined).toBeGreaterThanOrEqual(1);

    // The code still belongs to the voucher that reached the cloud first.
    const held = await ctx.db
      .select({ id: voucher.id })
      .from(voucher)
      .where(and(eq(voucher.operatorId, operatorId), eq(voucher.code, code)));
    expect(held, 'one code, one voucher — the second was reassigned or filed anyway').toHaveLength(
      1,
    );

    const filed = await ctx.db
      .select({ message: syncQuarantine.errorMessage })
      .from(syncQuarantine)
      .where(eq(syncQuarantine.errorCode, 'BOOTH_CODE_COLLISION'));
    expect(filed, 'the loser was not quarantined').toHaveLength(1);
    expect(filed[0]!.message).toContain(code);

    const [raised] = await ctx.db
      .select({ summary: alert.summary })
      .from(alert)
      .where(eq(alert.category, 'booth.code_collision'))
      .limit(1);
    expect(raised, 'a collision was filed with nobody told about it').toBeTruthy();
    expect(raised!.summary).toContain(code);
    // Both booths named — which for one box drawing twice is this booth twice,
    // and a person reading the line can see that is what happened.
    expect(raised!.summary).toContain('Booth 1');

    // The press whose voucher was refused is still recorded: it happened.
    const [orphan] = await ctx.db.select().from(spin).where(eq(spin.id, second.spinId)).limit(1);
    expect(orphan, 'a press whose voucher was refused vanished from the record').toBeTruthy();
    expect(orphan!.voucherId).toBeNull();
  });

  it('carries the print outcome as a fact, not up the cloud print route (D20)', async () => {
    const drawn = await booth.spin({ idempotencyKey: newId() });
    expect(
      drawn.printState,
      'the simulated printer produced nothing, so there is no outcome to carry',
    ).toBe('printed');
    /**
     * Quarantined print outcomes that were already here before this flush.
     *
     * The collision test above refuses a voucher the box really did print, so
     * its `booth.voucher_printed` can never resolve and stays quarantined for
     * the life of the database — which is correct, and is what happens in the
     * park every time two booths mint one code. An unscoped count therefore
     * picks that row up and fails this test for the previous test's reason.
     * Asserting "no NEW refusal" says what this test is actually about: THIS
     * print outcome was accepted.
     */
    const before = new Set(
      (
        await ctx.db
          .select({ id: syncQuarantine.id })
          .from(syncQuarantine)
          .where(eq(syncQuarantine.type, 'booth.voucher_printed'))
      ).map((r) => r.id),
    );

    const flushed = await agent.outbox()!.flush();
    expect(flushed.state).toBe('pushed');
    if (flushed.state !== 'pushed') throw new Error('unreachable');

    /**
     * The refusal, in the words the cloud used, so that a failure here reads
     * as the contract mismatch it is rather than as "expected 1 to be 0".
     */
    const refused = (
      await ctx.db
        .select({
          id: syncQuarantine.id,
          code: syncQuarantine.errorCode,
          message: syncQuarantine.errorMessage,
        })
        .from(syncQuarantine)
        .where(eq(syncQuarantine.type, 'booth.voucher_printed'))
    ).filter((r) => !before.has(r.id));
    expect(
      refused.map((r) => `${r.code}: ${r.message}`),
      'the cloud refused the booth’s print outcome. `booth.voucher_printed` has to name the voucher it printed — `voucherId` at the press, or `voucherCode`, which is on the stored print job and so survives a restart. `print_job_id` alone names a row in `edge.print_job`, which is box-local and invisible from here',
    ).toEqual([]);

    const [issued] = await ctx.db
      .select({ id: voucher.id })
      .from(voucher)
      .where(and(eq(voucher.operatorId, operatorId), eq(voucher.code, drawn.voucherCode!)))
      .limit(1);
    expect(issued).toBeTruthy();

    const prints = await ctx.db
      .select()
      .from(voucherPrint)
      .where(eq(voucherPrint.voucherId, issued!.id));
    expect(
      prints,
      'the booth printed a voucher and the cloud holds no record of the paper',
    ).toHaveLength(1);
    expect(prints[0]!.boxId).toBe(agent.state.boxId);
    expect(prints[0]!.stationId).toBe(boothStationId);
    expect(prints[0]!.reason).toBe('initial');

    const [counted] = await ctx.db
      .select({ printCount: voucher.printCount })
      .from(voucher)
      .where(eq(voucher.id, issued!.id))
      .limit(1);
    expect(counted!.printCount).toBe(1);
  });
});

describe('the booth cache scope (S2-07a)', () => {
  it('sends the booth the wheel it is meant to be running', async () => {
    const running = booth.config();
    expect(running, 'the booth cache scope carried nothing the agent could adopt').not.toBeNull();

    const [published] = await ctx.db
      .select({ version: boothConfigVersion.version, bundle: boothConfigVersion.bundle })
      .from(boothConfigVersion)
      .where(eq(boothConfigVersion.stationId, boothStationId))
      .orderBy(desc(boothConfigVersion.version))
      .limit(1);
    expect(running!.version).toBe(published!.version);

    /**
     * `{ schemaVersion, settings, layout, prizes }`, as the seed writes it and
     * as the agent's own `BoothCacheEntrySchema` insists on reading it. The
     * bundle is served as stored: what the box adopted is what was published,
     * slice for slice and in the publisher's order.
     */
    const bundle = published!.bundle as {
      prizes: { id: string; weightBp: number }[];
      settings: { buttonKey: string };
    };
    expect(running!.bundle.prizes.map((p) => p.id)).toEqual(bundle.prizes.map((p) => p.id));
    expect(running!.bundle.prizes.reduce((sum, p) => sum + p.weightBp, 0)).toBe(10_000);
    expect(running!.bundle.settings.buttonKey).toBe(bundle.settings.buttonKey);
  });
});

/**
 * SCRUM-413 (audit L8) and SCRUM-427 (audit T27) — a booth fact is checked
 * against the booth it names before it is filed.
 *
 * The facts below are queued by hand on the real outbox and pushed through
 * the real route, because what is under test is a fact no honest booth
 * produces: the box prints only what it drew, and lets only its own staff
 * ask for a copy. The envelope is still sealed and signed by the agent, so
 * what reaches the handler is exactly what a box holding this credential
 * could send — the audit's probe forged its facts the same way.
 *
 * Last in the file on purpose: the wheel test publishes a second version of
 * Booth 1, which the agent would adopt at its next cache pull.
 */
describe('a booth fact is checked against the booth it names', () => {
  async function quarantinedIds(type: string): Promise<Set<string>> {
    const rows = await ctx.db
      .select({ id: syncQuarantine.id })
      .from(syncQuarantine)
      .where(eq(syncQuarantine.type, type));
    return new Set(rows.map((r) => r.id));
  }

  /** The refusals of one type filed since `before`, as their codes. */
  async function refusedSince(type: string, before: Set<string>): Promise<string[]> {
    const rows = await ctx.db
      .select({ id: syncQuarantine.id, code: syncQuarantine.errorCode })
      .from(syncQuarantine)
      .where(eq(syncQuarantine.type, type));
    return rows.filter((r) => !before.has(r.id)).map((r) => r.code ?? '');
  }

  async function accountByPhone(phone: string): Promise<string> {
    const [row] = await ctx.db
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.operatorId, operatorId), eq(account.phone, phone)))
      .limit(1);
    if (!row) throw new Error(`no seeded account with phone ${phone}`);
    return row.id;
  }

  /** Everything the booth has queued so far, sent — so the next flush carries only the forged facts. */
  async function drained(): Promise<void> {
    const flushed = await agent.outbox()!.flush();
    expect(['pushed', 'empty']).toContain(flushed.state);
  }

  /** A voucher won at this booth: its spin, its issue and its first print all filed. */
  async function wonHere(): Promise<{ id: string; code: string; printCount: number }> {
    // The box's own randomness, whatever an earlier test left the draw fixed at.
    drawWith = null;
    const drawn = await booth.spin({ idempotencyKey: newId() });
    expect(drawn.voucherCode).toBeTruthy();
    await drained();
    const [row] = await ctx.db
      .select({ id: voucher.id, printCount: voucher.printCount })
      .from(voucher)
      .where(and(eq(voucher.operatorId, operatorId), eq(voucher.code, drawn.voucherCode!)))
      .limit(1);
    expect(row, 'the press did not reach the cloud as a voucher').toBeTruthy();
    return { id: row!.id, code: drawn.voucherCode!, printCount: row!.printCount };
  }

  const printFact = (payload: Record<string, unknown>) =>
    agent.outbox()!.queue({
      type: 'booth.voucher_printed',
      stationId: boothStationId,
      actorKind: 'box',
      payload: { printJobId: newId(), status: 'printed', ...payload },
    });

  const printsOf = (voucherId: string, printJobId: string) =>
    ctx.db
      .select()
      .from(voucherPrint)
      .where(and(eq(voucherPrint.voucherId, voucherId), eq(voucherPrint.printJobId, printJobId)));

  it('SCRUM-413: a print of a voucher this booth never won is quarantined, and no paper is counted', async () => {
    // Another branch's voucher, as the audit's probe filed one: this box
    // "reprinting" a slip from the other park.
    const chalongId = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
    const [definition] = await ctx.db
      .select({ id: voucherDefinition.id })
      .from(voucherDefinition)
      .where(eq(voucherDefinition.operatorId, operatorId))
      .limit(1);
    const elsewhere = newId();
    await ctx.db.insert(voucher).values({
      id: elsewhere,
      operatorId,
      branchId: chalongId,
      voucherDefinitionId: definition!.id,
      code: mintBoothCode('CH', (max) => randomInt(max)),
      source: 'booth',
      status: 'issued',
      expiresAt: new Date(Date.now() + 14 * 86_400_000),
    });

    await drained();
    const before = await quarantinedIds('booth.voucher_printed');
    const job = newId();
    await printFact({
      voucherId: elsewhere,
      printJobId: job,
      reason: 'reprint',
      requestedByAccountId: await accountByPhone(RECEPTION.phone),
    });
    const flushed = await agent.outbox()!.flush();
    expect(flushed.state).toBe('pushed');
    if (flushed.state !== 'pushed') throw new Error('unreachable');
    expect(flushed.quarantined).toBe(1);
    expect(await refusedSince('booth.voucher_printed', before)).toEqual([
      'BOOTH_VOUCHER_NOT_THIS_BOOTHS',
    ]);
    expect(await printsOf(elsewhere, job)).toHaveLength(0);
    const [untouched] = await ctx.db
      .select({ printCount: voucher.printCount })
      .from(voucher)
      .where(eq(voucher.id, elsewhere));
    expect(untouched!.printCount).toBe(0);
  });

  it('SCRUM-413: a reprint asked for by somebody off this booth’s staff list is quarantined; by somebody on it, filed', async () => {
    const won = await wonHere();
    const admin = await accountByPhone(ADMIN.phone);
    const reception = await accountByPhone(RECEPTION.phone);
    // The seed puts reception on Booth 1's list; the administrator is not on it.
    const staff = (
      await ctx.db
        .select({ accountId: boothStaffAssignment.accountId })
        .from(boothStaffAssignment)
        .where(eq(boothStaffAssignment.stationId, boothStationId))
    ).map((s) => s.accountId);
    expect(staff).toContain(reception);
    expect(staff).not.toContain(admin);

    const job = newId();
    const before = await quarantinedIds('booth.voucher_printed');
    await printFact({
      voucherId: won.id,
      voucherCode: won.code,
      printJobId: job,
      reason: 'reprint',
      requestedByAccountId: admin,
    });
    const refused = await agent.outbox()!.flush();
    expect(refused.state).toBe('pushed');
    expect(await refusedSince('booth.voucher_printed', before)).toEqual([
      'BOOTH_PRINT_REQUESTER_NOT_STAFF',
    ]);
    expect(await printsOf(won.id, job)).toHaveLength(0);

    // The same copy, asked for by the person the booth would have signed in.
    await printFact({
      voucherId: won.id,
      voucherCode: won.code,
      printJobId: job,
      reason: 'reprint',
      requestedByAccountId: reception,
    });
    const filed = await agent.outbox()!.flush();
    expect(filed.state).toBe('pushed');
    if (filed.state !== 'pushed') throw new Error('unreachable');
    expect(filed.quarantined).toBe(0);
    const prints = await printsOf(won.id, job);
    expect(prints).toHaveLength(1);
    expect(prints[0]).toMatchObject({
      reason: 'reprint',
      requestedByAccountId: reception,
      stationId: boothStationId,
    });
    const [counted] = await ctx.db
      .select({ printCount: voucher.printCount })
      .from(voucher)
      .where(eq(voucher.id, won.id));
    expect(counted!.printCount).toBe(won.printCount + 1);
  });

  it('SCRUM-427: a voucher of a type no wheel of this booth ever carried is quarantined; one from an earlier wheel is filed', async () => {
    /**
     * Version 2 of Booth 1's wheel, with one prize taken off. Its type was on
     * version 1, and a slip printed under that wheel is still paper in a
     * visitor's hand — so it is honoured, while a type this operator has but
     * no wheel of this booth has ever shown is not.
     */
    const [current] = await ctx.db
      .select({
        version: boothConfigVersion.version,
        layoutId: boothConfigVersion.layoutId,
        bundle: boothConfigVersion.bundle,
      })
      .from(boothConfigVersion)
      .where(eq(boothConfigVersion.stationId, boothStationId))
      .orderBy(desc(boothConfigVersion.version))
      .limit(1);
    const bundle = current!.bundle as { prizes: { voucherDefinitionId: string | null }[] };
    const dropped = bundle.prizes.find((p) => p.voucherDefinitionId)!.voucherDefinitionId!;
    const next = {
      ...bundle,
      prizes: bundle.prizes.filter((p) => p.voucherDefinitionId !== dropped),
    };
    await ctx.db.insert(boothConfigVersion).values({
      id: newId(),
      operatorId,
      branchId,
      stationId: boothStationId,
      version: current!.version + 1,
      layoutId: current!.layoutId,
      bundle: next,
      bundleHash: createHash('sha256').update(JSON.stringify(next)).digest('hex'),
      publishedByAccountId: null,
      note: 'SCRUM-427 test: one prize taken off the wheel',
    });
    const never = newId();
    await ctx.db.insert(voucherDefinition).values({
      id: never,
      operatorId,
      code: `never-${never}`,
      nameEn: 'Never on this wheel',
      kind: 'discount',
      valueType: 'amount',
      valueSatang: 5000,
    });

    const issued = async (voucherDefinitionId: string): Promise<string> => {
      const voucherId = newId();
      await agent.outbox()!.queue({
        type: 'promo.voucher_issued',
        stationId: boothStationId,
        actorKind: 'device',
        payload: {
          voucherId,
          voucherDefinitionId,
          code: mintBoothCode('B1', (max) => randomInt(max)),
          source: 'booth',
          costSatang: 0,
          expiresAt: null,
        },
      });
      return voucherId;
    };
    await drained();
    const before = await quarantinedIds('promo.voucher_issued');
    const fromEarlierWheel = await issued(dropped);
    const fromNoWheel = await issued(never);
    const flushed = await agent.outbox()!.flush();
    expect(flushed.state).toBe('pushed');
    if (flushed.state !== 'pushed') throw new Error('unreachable');
    expect(flushed.quarantined).toBe(1);
    expect(await refusedSince('promo.voucher_issued', before)).toEqual([
      'BOOTH_VOUCHER_TYPE_NOT_ON_WHEEL',
    ]);
    expect(
      await ctx.db.select({ id: voucher.id }).from(voucher).where(eq(voucher.id, fromNoWheel)),
    ).toHaveLength(0);
    expect(
      await ctx.db
        .select({ id: voucher.id })
        .from(voucher)
        .where(eq(voucher.id, fromEarlierWheel)),
    ).toHaveLength(1);
  });
});
