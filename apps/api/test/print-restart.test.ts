import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { account, station } from '@oto/db';
import { FIXTURES } from '@oto/print/fixtures';
import {
  EDGE_BOX_LOCAL_TABLES_SQL,
  SqlBoxStore,
  createPrinterSimulator,
  createPrintSubsystem,
  generateSyncKeyPair,
  postgresBoxDriver,
  sealEnvelope,
  type BoxConfigBundle,
  type BoxConfigDevice,
  type BoxConfigStation,
  type EnvelopeSealer,
  type PgPoolLike,
  type PrintJobOutcome,
  type PrintJobRecord,
  type PrintSubsystem,
} from '@oto/box-agent';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '@oto/box-agent/sqlite';
import { ADMIN, boxBySlot, createTestContext, teardownAll, type TestContext } from './helpers';

/**
 * S2-07a — the print queue survives a restart, and both dialects can hold it.
 *
 * Two things are proved here that cannot be proved in `packages/box-agent`:
 *
 *   - **The seam between the print subsystem and the store.** That package's
 *     tests run on Node's own runner with strip-only type stripping, which
 *     cannot parse `Bitmap1`'s parameter properties, so `@oto/print` — and
 *     therefore `printing/queue.ts` — cannot be imported there at all. Its
 *     `print-restart.test.ts` proves the durable half against the store; this
 *     proves the real `createPrintSubsystem` writing to it, dying, and being
 *     rebuilt on the same file with a real printer simulator behind it.
 *   - **The Postgres dialect of the new tables.** `SqlBoxStore` is one
 *     implementation for a Pi's SQLite file and the `edge` schema, and that
 *     claim is worth exactly as much as it is exercised. These tables have no
 *     migration yet, so this file creates them from the DDL the store exports
 *     for whoever writes one — which also makes it impossible for that DDL to
 *     drift from the SQL that reads it without a test going red.
 */

const RECEIPT = FIXTURES.find((f) => f.job.kind === 'receipt')!.job;
const AT = '2026-09-21T03:00:00.000Z';
const BOX = '018f0000-0000-7000-8000-00000000b0c5';

function deviceRow(): BoxConfigDevice {
  return {
    id: 'dev-receipt',
    role: 'receipt',
    kind: 'receipt_printer',
    label: 'Receipt Printer 1',
    transport: 'simulated',
    address: '192.168.88.202:9100',
    model: 'Welltech G4 (Xprinter XP-C260)',
    protocol: 'escpos',
    serialNumber: null,
    terminalId: null,
    merchantId: null,
  };
}

function bundleOf(devices: BoxConfigDevice[]): BoxConfigBundle {
  const only: BoxConfigStation = {
    id: 'station-1',
    name: 'Reception Till 1',
    kind: 'till',
    codePrefix: 'T1',
    capabilities: [],
    configVersion: 1,
    paymentRouting: null,
    offlineWalletCapSatang: null,
    accessScope: 'branch',
    devices,
  };
  return {
    configVersion: 'v1',
    box: { id: BOX, name: 'Box 1', slot: 'virtual-1', role: 'virtual', epoch: 1, status: 'online' },
    branch: {
      id: 'branch-1',
      code: 'HKT',
      name: 'HKT Central',
      operatorId: 'op-1',
      timezone: 'Asia/Bangkok',
      openingHours: null,
      businessDayStart: '06:00',
    },
    stations: [only],
    printTemplates: [],
    signingKeys: [],
    heartbeatIntervalS: 60,
    minSupportedAgentVersion: '0.1.0',
  };
}

describe('the box comes back with the vouchers it had not printed (S2-07a)', () => {
  /**
   * One box, opened twice on the same file, with everything in between thrown
   * away — the store, the subsystem, the simulator's session. A restart that
   * rebuilt only the subsystem would prove the row was on the disk; it would
   * not prove the box reads it.
   */
  function bootBox(file: string, at: string, opts: { registered?: boolean } = {}) {
    const db = new DatabaseSync(file);
    prepareSqliteBoxStore(db);
    const store = new SqlBoxStore({ driver: sqliteBoxDriver(db), now: () => new Date(at) });
    const sim = createPrinterSimulator({
      deviceId: 'dev-receipt',
      label: 'Receipt Printer 1',
      model: 'Welltech G4 (Xprinter XP-C260)',
      language: 'escpos',
      widthDots: 576,
      now: () => new Date(at),
    });
    const reported: PrintJobOutcome[] = [];
    const logged: string[] = [];
    let jobs: PrintSubsystem | null = null;
    // What the agent has: an id it does not know until it registers.
    let registered = opts.registered ?? true;
    return {
      db,
      store,
      sim,
      reported,
      logged,
      register() {
        registered = true;
      },
      async start(): Promise<PrintSubsystem> {
        await store.init(BOX);
        jobs = createPrintSubsystem({
          bundle: () => bundleOf([deviceRow()]),
          templates: () => [],
          open: async () => sim.connect(),
          now: () => new Date(at),
          report: (outcome) => {
            reported.push(outcome);
          },
          log: (_level, msg) => logged.push(msg),
          retryDelayMs: 0,
          durable: () => {
            const held = store.printJobs();
            return held && registered ? { jobs: held, boxId: BOX } : null;
          },
        });
        return jobs;
      },
      stop() {
        jobs = null;
        db.close();
      },
    };
  }

  function tempFile(name: string): string {
    return join(mkdtempSync(join(tmpdir(), 'oto-print-')), `${name}.sqlite`);
  }

  it('keeps three vouchers waiting on paper across a restart, then prints them', async () => {
    const file = tempFile('waiting');
    const first = bootBox(file, AT);
    const before = await first.start();
    first.sim.setFault('paper_out');

    for (const id of ['job-1', 'job-2', 'job-3']) {
      const outcome = await before.submit({ id, kind: 'receipt', job: RECEIPT });
      expect(outcome.status).toBe('queued');
      expect(outcome.errorCode).toBe('PRINTER_PAPER_OUT');
    }
    expect(before.pending()).toHaveLength(3);
    expect(first.sim.printouts()).toHaveLength(0);

    // Somebody presses Restart on Render. Before S2-07a the queue lived in
    // this object and the count came back 0 while the cloud rows stayed
    // `queued` for ever.
    first.stop();

    const second = bootBox(file, AT);
    const after = await second.start();
    expect(after.pending()).toHaveLength(0);
    await after.resume();
    expect(after.pending().map((job) => job.id)).toEqual(['job-1', 'job-2', 'job-3']);
    expect(after.pending()[0]?.lastError).toBe('PRINTER_PAPER_OUT');

    // And they are jobs, not just rows: the paper goes in and all three print.
    const printed = await after.tick();
    expect(printed.map((outcome) => outcome.status)).toEqual(['printed', 'printed', 'printed']);
    expect(second.sim.printouts()).toHaveLength(3);
    expect(after.pending()).toHaveLength(0);
    expect(await second.store.loadPendingPrintJobs(BOX)).toEqual([]);

    // Nothing was told to the cloud twice: the rows were already `queued`
    // before the restart, and the only thing new to say is that they printed.
    expect(second.reported.map((outcome) => outcome.status)).toEqual([
      'printed',
      'printed',
      'printed',
    ]);
    second.stop();
    rmSync(file, { force: true });
  });

  it('resumes without being asked, because the heartbeat already ticks', async () => {
    const file = tempFile('lazy');
    const first = bootBox(file, AT);
    const before = await first.start();
    first.sim.setFault('paper_out');
    await before.submit({ id: 'job-a', kind: 'receipt', job: RECEIPT });
    first.stop();

    // No `resume()` here. The agent ticks this queue on every heartbeat, and
    // a recovery that depended on somebody remembering a new call is a
    // recovery that would not have happened on the box in the mall.
    const second = bootBox(file, AT);
    const after = await second.start();
    const outcomes = await after.tick();
    expect(outcomes.map((outcome) => outcome.id)).toEqual(['job-a']);
    expect(outcomes[0]?.status).toBe('printed');
    second.stop();
    rmSync(file, { force: true });
  });

  it('never reprints a voucher that was going to the printer when the power went', async () => {
    const file = tempFile('interrupted');
    const first = bootBox(file, AT);
    await first.start();
    // The state the store is left in when a box dies mid-write: S2-06's queue
    // had already opened the socket, so some of that voucher is paper.
    await first.store.putPrintJob({
      id: 'job-cut',
      boxId: BOX,
      kind: 'receipt',
      role: 'receipt',
      stationId: 'station-1',
      deviceId: 'dev-receipt',
      copies: 1,
      job: RECEIPT,
      finish: null,
      templateId: null,
      templateVersion: null,
      actionId: null,
      state: 'sending',
      attempts: 1,
      nextAttemptAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      queuedAt: AT,
      updatedAt: AT,
    } satisfies PrintJobRecord);
    first.stop();

    const second = bootBox(file, AT);
    const after = await second.start();
    const recovered = await after.resume();

    expect(recovered.map((outcome) => outcome.status)).toEqual(['failed']);
    expect(recovered[0]?.errorCode).toBe('PRINT_INTERRUPTED');
    expect(recovered[0]?.deviceId).toBe('dev-receipt');
    expect(second.reported.map((outcome) => outcome.id)).toEqual(['job-cut']);

    // Reported once, printed never. A person pressing reprint is a different
    // act and mints its own job.
    expect(after.pending()).toHaveLength(0);
    await after.tick();
    expect(second.sim.printouts()).toHaveLength(0);
    expect(await second.store.loadInterruptedPrintJobs(BOX)).toEqual([]);
    second.stop();

    const third = bootBox(file, AT);
    const last = await third.start();
    await last.resume();
    expect(third.reported).toHaveLength(0);
    expect(third.sim.printouts()).toHaveLength(0);
    third.stop();
    rmSync(file, { force: true });
  });

  it('keeps nothing on the box once the paper is out of the machine', async () => {
    const file = tempFile('clean');
    const first = bootBox(file, AT);
    const jobs = await first.start();
    const outcome = await jobs.submit({ id: 'job-ok', kind: 'receipt', job: RECEIPT });

    expect(outcome.status).toBe('printed');
    // A receipt carries a member's name and a kids' band carries a child's
    // allergy line. The cloud's `edge.print_job` row is the history; this
    // table holds the work, and finished work is not work.
    expect(await first.store.loadPendingPrintJobs(BOX)).toEqual([]);
    first.stop();

    const second = bootBox(file, AT);
    const after = await second.start();
    await after.resume();
    expect(after.pending()).toHaveLength(0);
    second.stop();
    rmSync(file, { force: true });
  });

  it('still prints for a box with nowhere to keep a queue, and says so', async () => {
    const file = tempFile('memory-only');
    const db = new DatabaseSync(file);
    prepareSqliteBoxStore(db);
    // The virtual box's condition until a migration adds these to `edge`.
    for (const table of [
      'box_print_job',
      'box_counter',
      'box_staff_session',
      'box_throttle',
      'box_runtime',
    ]) {
      db.exec(`drop table ${table}`);
    }
    const store = new SqlBoxStore({ driver: sqliteBoxDriver(db), now: () => new Date(AT) });
    await store.init(BOX);
    expect(store.printJobs()).toBeNull();

    const sim = createPrinterSimulator({
      deviceId: 'dev-receipt',
      label: 'Receipt Printer 1',
      model: 'Welltech G4 (Xprinter XP-C260)',
      language: 'escpos',
      widthDots: 576,
    });
    const lines: string[] = [];
    const jobs = createPrintSubsystem({
      bundle: () => bundleOf([deviceRow()]),
      templates: () => [],
      open: async () => sim.connect(),
      log: (_level, msg) => lines.push(msg),
      durable: () => {
        const held = store.printJobs();
        return held ? { jobs: held, boxId: BOX } : null;
      },
    });

    const outcome = await jobs.submit({ id: 'job-mem', kind: 'receipt', job: RECEIPT });
    expect(outcome.status).toBe('printed');
    expect(sim.printouts()).toHaveLength(1);
    // Said once, when it first matters, and said at all: a queue that forgets
    // on restart is a real loss and this is the only place it is visible.
    expect(lines.filter((line) => line.includes('no durable print queue'))).toHaveLength(1);
    db.close();
    rmSync(file, { force: true });
  });

  /**
   * The trap this option shape exists to avoid.
   *
   * The agent builds the print subsystem at construction and learns its box id
   * later, at registration. A box id read once, up front, would be null on
   * every real box — the durable queue would never engage, every test that
   * passed one directly would still pass, and the fault would show up as three
   * vouchers missing after a restart in the park.
   */
  it('engages once the box knows its own id, not once at construction', async () => {
    const file = tempFile('unregistered');
    const first = bootBox(file, AT);
    const before = await first.start();
    first.sim.setFault('paper_out');
    await before.submit({ id: 'job-waiting', kind: 'receipt', job: RECEIPT });
    expect((await first.store.loadPendingPrintJobs(BOX)).map((job) => job.id)).toEqual([
      'job-waiting',
    ]);
    first.stop();

    // It comes back up and ticks before it has registered, which is the order
    // a box that cannot reach the cloud boots in.
    const second = bootBox(file, AT, { registered: false });
    const after = await second.start();
    expect(await after.tick()).toEqual([]);
    expect(after.pending()).toHaveLength(0);
    expect(second.logged.some((line) => line.includes('no durable print queue'))).toBe(true);

    // Registration lands. The early tick must not have been remembered as a
    // recovery that found nothing, or the voucher on the disk is never printed.
    second.register();
    const printed = await after.tick();
    expect(printed.map((outcome) => outcome.id)).toEqual(['job-waiting']);
    expect(printed[0]?.status).toBe('printed');
    expect(second.sim.printouts()).toHaveLength(1);
    second.stop();
    rmSync(file, { force: true });
  });
});

describe('the same store over Postgres (S2-07a)', () => {
  let ctx: TestContext;
  let pool: pg.Pool;
  let store: SqlBoxStore;
  let boxId: string;
  let stationId: string;
  let accountId: string;
  let seal: EnvelopeSealer;

  beforeAll(async () => {
    ctx = await createTestContext();
    pool = new pg.Pool({ connectionString: ctx.app.env.DATABASE_URL });
    /**
     * The tables the migrations do not have yet, created from the DDL the
     * store hands over for whoever writes that migration. This is the only
     * place the Postgres spelling of these statements runs, so a column named
     * differently here than in `store-sql.ts` fails the file rather than the
     * booth.
     */
    await pool.query(EDGE_BOX_LOCAL_TABLES_SQL);

    // Scoped to the park (SCRUM-289).
    const seeded = await boxBySlot(ctx.db, 'virtual-1');
    boxId = seeded.id;
    const [till] = await ctx.db.select().from(station).limit(1);
    stationId = till!.id;
    const [admin] = await ctx.db
      .select()
      .from(account)
      .where(eq(account.phone, ADMIN.phone))
      .limit(1);
    accountId = admin!.id;

    store = new SqlBoxStore({ driver: postgresBoxDriver(pool as PgPoolLike) });
    await store.init(boxId);
    const keys = generateSyncKeyPair();
    seal = (draft) => sealEnvelope(draft, boxId, keys.privateKeyPem);
  });

  afterAll(async () => {
    await pool.end();
    await ctx.close();
    await teardownAll();
  });

  it('finds the tables and offers what they can hold', () => {
    expect(store.features()).toEqual({ printJobs: true, boothRuntime: true, overlay: true });
    expect(store.printJobs()).not.toBeNull();
  });

  it('round-trips a print job through jsonb without losing any of it', async () => {
    const record: PrintJobRecord = {
      id: '018f0000-0000-7000-8000-0000000000f1',
      boxId,
      kind: 'receipt',
      role: 'receipt',
      stationId,
      deviceId: null,
      copies: 2,
      job: RECEIPT,
      finish: { cut: 'partial', feedDots: 96 },
      templateId: null,
      templateVersion: null,
      actionId: 'act-1',
      state: 'queued',
      attempts: 1,
      nextAttemptAt: '2026-09-21T03:00:30.000Z',
      lastErrorCode: 'PRINTER_PAPER_OUT',
      lastErrorMessage: 'the roll is empty',
      queuedAt: '2026-09-21T03:00:00.000Z',
      updatedAt: '2026-09-21T03:00:00.000Z',
    };
    await store.putPrintJob(record);

    const [held] = await store.loadPendingPrintJobs(boxId);
    expect(held).toEqual(record);
    // The renderer's input is what came back, not something that looks like it.
    expect(held!.job).toEqual(RECEIPT);

    await store.updatePrintJob(record.id, { state: 'sending', deviceId: null, attempts: 2 });
    expect((await store.loadPendingPrintJobs(boxId))[0]!.lastErrorCode).toBe('PRINTER_PAPER_OUT');

    // The restart rule, on the dialect the Render demo actually runs.
    await store.init(boxId);
    expect(await store.loadPendingPrintJobs(boxId)).toEqual([]);
    const interrupted = await store.loadInterruptedPrintJobs(boxId);
    expect(interrupted.map((job) => job.id)).toEqual([record.id]);
    expect(interrupted[0]!.lastErrorCode).toBe('PRINT_INTERRUPTED');
    await store.deletePrintJob(record.id);
    expect(await store.loadInterruptedPrintJobs(boxId)).toEqual([]);
  });

  it('counts, locks and remembers the same way it does on a memory card', async () => {
    const key = { scope: 'booth_prize', key: 'prize-1', businessDate: '2026-09-21' };
    expect(await store.bumpCounter(boxId, key)).toBe(1);
    expect(await store.bumpCounter(boxId, key, 2)).toBe(3);
    expect(await store.readCounters(boxId, 'booth_prize', '2026-09-21')).toEqual({ 'prize-1': 3 });

    await store.writeStaffSession({
      stationId,
      boxId,
      accountId,
      credentialKind: 'pin',
      staffCode: 'S-014',
      signedInAt: '2026-09-21T03:00:00.000Z',
      lastSeenAt: '2026-09-21T03:00:00.000Z',
      expiresAt: null,
    });
    expect((await store.readStaffSession(stationId))?.accountId).toBe(accountId);

    await store.recordThrottleFailure(boxId, 'booth_pin', stationId, {
      now: '2026-09-21T03:00:00.000Z',
      lockedUntil: '2026-09-21T03:00:30.000Z',
    });
    const again = await store.recordThrottleFailure(boxId, 'booth_pin', stationId, {
      now: '2026-09-21T03:00:01.000Z',
    });
    expect(again.failures).toBe(2);
    expect(again.lockedUntil).toBe('2026-09-21T03:00:30.000Z');

    expect(await store.markTimeSeen(boxId, '2026-09-21T03:00:00.000Z')).toBe(
      '2026-09-21T03:00:00.000Z',
    );
    expect(await store.markTimeSeen(boxId, '1970-01-01T00:00:00.000Z')).toBe(
      '2026-09-21T03:00:00.000Z',
    );
  });

  it("queues a spin's two facts as one transaction, on the real journal", async () => {
    const before = (await store.depth(boxId)).queued;
    const pair = await store.enqueueMany(
      boxId,
      [
        { type: 'booth.spin_recorded', payload: { prizeId: 'p1' } },
        { type: 'promo.voucher_issued', payload: { code: 'B1K7M2QPXR' } },
      ],
      seal,
    );
    expect(pair.map((record) => record.envelope.boxSeq)).toEqual([
      pair[0]!.envelope.boxSeq,
      pair[0]!.envelope.boxSeq + 1,
    ]);
    expect((await store.depth(boxId)).queued).toBe(before + 2);

    let sealed = 0;
    await expect(
      store.atomically(async (tx) => {
        await tx.enqueueMany(
          boxId,
          [
            { type: 'booth.spin_recorded', payload: {} },
            { type: 'promo.voucher_issued', payload: {} },
          ],
          (draft) => {
            sealed += 1;
            if (sealed === 2) throw new Error('the signing key was unreadable');
            return seal(draft);
          },
        );
      }),
    ).rejects.toThrow();
    expect((await store.depth(boxId)).queued).toBe(before + 2);
  });
});
