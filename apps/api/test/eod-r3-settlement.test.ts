import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { schema } from '@oto/db';
import { businessDate, newId, PAID_ONLINE_TENDER_CODE } from '@oto/shared';
import { BRANCH_MANAGER, CENTRAL_BRANCH_CODE, RECEPTION, branchIdByCode,
  CHALONG_BRANCH_CODE, createTestContext, operatorIdByName, signInAs, teardownAll, OTO_OPERATOR_NAME,
  type TestContext } from './helpers';
import { matchSettlementEvidence, parse2c2pFixture, recordTerminalSettlement } from '../src/services/settlement';
import { SETTLEMENT_FIXTURE_IMPORT_JOB } from '../src/services/settlement-import-job';
import { resetDemoData } from '../src/services/demo-reset';
import type { BoxAuth } from '../src/services/box';

type Attempt = Parameters<typeof matchSettlementEvidence>[1][number];
const attempt = (patch: Partial<Attempt> = {}): Attempt => ({
  id: 'attempt-1', method: 'qr', methodCode: 'promptpay', stationId: 'station-1',
  provider: 'digio', status: 'awaiting_settlement', amountSatang: 69_000,
  deviceId: 'pax-1', tid: 'PAX-TID', approvalCode: null, invoiceNo: null,
  terminalRef: '000120', tranRef: null, paymentId: null, ...patch,
});

describe('S2-15a settlement evidence', () => {
  it('matches a PAX receipt by its reference and exact satang, never by amount alone', () => {
    const rows = [attempt()];
    expect(matchSettlementEvidence({ method: 'qr', amountSatang: 69_000, terminalRef: '000120', tid: 'PAX-TID' }, rows))
      .toEqual({ match: 'matched', attemptId: 'attempt-1' });
    expect(matchSettlementEvidence({ method: 'qr', amountSatang: 69_000 }, rows).match).toBe('unmatched');
    expect(matchSettlementEvidence({ method: 'qr', amountSatang: 69_001, terminalRef: '000120' }, rows).match).toBe('amount_mismatch');
    expect(matchSettlementEvidence({ method: 'qr', amountSatang: 69_000, terminalRef: '000120', tid: 'OTHER' }, rows).match)
      .toBe('reference_mismatch');
    expect(matchSettlementEvidence({ method: 'qr', amountSatang: 69_000, terminalRef: '000120', tid: 'PAX-TID' },
      [attempt({ tid: null })]).match).toBe('reference_mismatch');
    expect(matchSettlementEvidence({ method: 'qr', amountSatang: 69_000, terminalRef: '000120', tranRef: 'NEW', tid: 'PAX-TID' },
      rows).match).toBe('matched');
    expect(matchSettlementEvidence({ method: 'qr', amountSatang: 69_000, terminalRef: '000120', tranRef: 'WRONG' },
      [attempt({ tranRef: 'KNOWN' })]).match).toBe('reference_mismatch');
  });

  it('flags an ambiguous reference and never matches the same attempt twice', () => {
    const evidence = { method: 'qr' as const, amountSatang: 69_000, terminalRef: '000120' };
    expect(matchSettlementEvidence(evidence, [attempt(), attempt({ id: 'attempt-2' })]).match).toBe('ambiguous');
    expect(matchSettlementEvidence(evidence, [attempt()], new Set(['attempt-1'])).match).toBe('ambiguous');
  });

  it('parses bounded H/D fixture rows and refuses malformed or unsupported data', () => {
    const header = 'TYPE_TABLE,invoiceNo,tranRef,paymentID,amount,currencyCode,transactionType,method';
    const fixture = `${header}\r\nH,,,,,,,\r\nD,DEMO123,REF1,,690.00,THB,payment,qr\r\nD,UNKNOWN,,,95.00,THB,refund,card\r\n`;
    expect(parse2c2pFixture(fixture)).toEqual([
      { method: 'qr', amountSatang: 69_000, invoiceNo: 'DEMO123', tranRef: 'REF1', paymentId: null, transactionType: 'payment' },
      { method: 'card', amountSatang: 9_500, invoiceNo: 'UNKNOWN', tranRef: null, paymentId: null, transactionType: 'refund' },
    ]);
    expect(() => parse2c2pFixture(fixture.replace('THB', 'USD'))).toThrow();
    expect(() => parse2c2pFixture(fixture.replace('690.00', '690.001'))).toThrow();
    expect(() => parse2c2pFixture(`${header}\nD,DEMO123,,,690.00,THB,payment,qr\n`)).toThrow();
  });
});

describe('S2-15a settlement ledger', () => {
  let ctx: TestContext;
  let operatorId: string, branchId: string, stationId: string, boxId: string, deviceId: string;
  let managerCookie: string, receptionCookie: string, attemptId: string, gatewayAttemptId: string;
  const date = businessDate(new Date(), 'Asia/Bangkok', 5 * 60);
  const paidAt = new Date('2026-09-20T08:30:00.000Z');

  beforeAll(async () => {
    ctx = await createTestContext();
    operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
    branchId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
    const [counter] = await ctx.db.select({ id: schema.station.id, boxId: schema.station.boxId })
      .from(schema.station).where(and(eq(schema.station.branchId, branchId), eq(schema.station.kind, 'till'))).limit(1);
    stationId = counter!.id;
    boxId = counter!.boxId!;
    deviceId = newId();
    await ctx.db.insert(schema.device).values({ id: deviceId, operatorId, branchId, boxId,
      kind: 'terminal', label: 'Settlement test PAX', transport: 'simulated',
      protocol: 'digio_tlv', terminalId: 'TESTTID1', merchantId: 'TESTMID1' });
    attemptId = newId();
    await ctx.db.insert(schema.paymentAttempt).values({ id: attemptId, operatorId, branchId, stationId,
      deviceId, businessDate: date, method: 'qr', methodCode: 'promptpay', provider: 'digio',
      status: 'awaiting_settlement', amountSatang: 69_000, tid: 'TESTTID1', mid: 'TESTMID1',
      terminalRef: 'TESTREF1', approvalCode: '=1+1', paidAt });
    gatewayAttemptId = newId();
    await ctx.db.insert(schema.paymentAttempt).values({ id: gatewayAttemptId, operatorId, branchId, stationId,
      businessDate: date, method: 'qr', methodCode: 'promptpay', provider: '2c2p', status: 'approved',
      amountSatang: 15_000, invoiceNo: 'TESTINVOICE1', tranRef: 'TESTTRAN1', paidAt });
    managerCookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
    receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  });
  afterAll(async () => { await ctx?.close(); await teardownAll(); });

  it('requires settlement permission, queues once, then confirms only the matched PAX attempt', async () => {
    const url = `/branches/${branchId}/settlements/terminal-runs`;
    const payload = { date, deviceId };
    const denied = await ctx.app.inject({ method: 'POST', url, headers: { cookie: receptionCookie,
      'idempotency-key': newId() }, payload });
    expect(denied.statusCode).toBe(403);
    const key = newId();
    const first = await ctx.app.inject({ method: 'POST', url, headers: { cookie: managerCookie,
      'idempotency-key': key }, payload });
    expect(first.statusCode, first.body).toBe(200);
    const run = first.json() as { batchId: string; commandId: string };
    const replay = await ctx.app.inject({ method: 'POST', url, headers: { cookie: managerCookie,
      'idempotency-key': key }, payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    const [queued] = await ctx.db.select().from(schema.boxCommand).where(eq(schema.boxCommand.id, run.commandId));
    expect(queued?.kind).toBe('terminal_settle');

    const auth = { boxId, branchId, operatorId } as BoxAuth;
    const body = { outcome: 'settled' as const, deviceId, tid: 'TESTTID1', mid: 'TESTMID1',
      batchRef: 'TESTBATCH1', lines: [{ method: 'qr' as const, amountSatang: 69_000,
        terminalRef: 'TESTREF1' }] };
    await expect(ctx.db.transaction((tx) => recordTerminalSettlement(tx,
      { ...auth, boxId: newId() }, run.batchId, body))).rejects.toMatchObject({ statusCode: 404 });
    const siblingBoxes = await ctx.db.select({ id: schema.box.id }).from(schema.box)
      .where(eq(schema.box.branchId, branchId));
    const reassignedBoxId = siblingBoxes.find((b) => b.id !== boxId)!.id;
    await ctx.db.update(schema.device).set({ boxId: reassignedBoxId }).where(eq(schema.device.id, deviceId));
    await expect(ctx.db.transaction((tx) => recordTerminalSettlement(tx,
      { ...auth, boxId: reassignedBoxId }, run.batchId, body))).rejects.toMatchObject({ statusCode: 404 });
    const result = await ctx.db.transaction((tx) => recordTerminalSettlement(tx, auth, run.batchId, body));
    await ctx.db.update(schema.device).set({ boxId }).where(eq(schema.device.id, deviceId));
    expect(result).toMatchObject({ state: 'matched', matched: 1, unmatched: 0, replayed: false });
    const same = await ctx.db.transaction((tx) => recordTerminalSettlement(tx, auth, run.batchId, body));
    expect(same.replayed).toBe(true);
    await expect(ctx.db.transaction((tx) => recordTerminalSettlement(tx, auth, run.batchId,
      { ...body, lines: [{ ...body.lines[0]!, amountSatang: 69_001 }] })))
      .rejects.toMatchObject({ code: 'SETTLEMENT_REPLAY_CHANGED' });
    const [paid] = await ctx.db.select({ status: schema.paymentAttempt.status, paidAt: schema.paymentAttempt.paidAt,
      businessDate: schema.paymentAttempt.businessDate, amountSatang: schema.paymentAttempt.amountSatang })
      .from(schema.paymentAttempt).where(eq(schema.paymentAttempt.id, attemptId));
    expect(paid).toEqual({ status: 'approved', paidAt, businessDate: date, amountSatang: 69_000 });
    const [finished] = await ctx.db.select().from(schema.boxCommand).where(eq(schema.boxCommand.id, run.commandId));
    expect(finished?.state).toBe('succeeded');
    const [evidence] = await ctx.db.select({ terminalRef: schema.settlementLine.terminalRef })
      .from(schema.settlementLine).where(eq(schema.settlementLine.batchId, run.batchId));
    expect(evidence?.terminalRef).toBe('TESTREF1');
    const [audit] = await ctx.db.select({ id: schema.auditLog.id }).from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'settlement.run'), eq(schema.auditLog.entityId, run.batchId)));
    expect(audit?.id).toBeTruthy();
    const exportResponse = await ctx.app.inject({ method: 'GET',
      url: `/branches/${branchId}/settlements/export?date=${date}&tid=TESTTID1`,
      headers: { cookie: receptionCookie } });
    expect(exportResponse.statusCode).toBe(200);
    expect(exportResponse.headers['content-type']).toContain('text/csv');
    expect(exportResponse.body).toContain('business_date,tid,method,amount_satang,approval_code,invoice_no,tran_ref,status');
    expect(exportResponse.body).toContain('"\'=1+1"');
  });

  it('imports a fixture with a match and an unmatched line, without paying an attempt again', async () => {
    const csv = 'TYPE_TABLE,invoiceNo,tranRef,paymentID,amount,currencyCode,transactionType,method\r\n' +
      'H,,,,,,,\r\nD,TESTINVOICE1,TESTTRAN1,,150.00,THB,payment,qr\r\n' +
      'D,UNKNOWN,,,95.00,THB,refund,qr\r\n';
    const url = `/branches/${branchId}/settlements/2c2p-import`;
    const runs = () => ctx.db.select().from(schema.opsRun)
      .where(and(eq(schema.opsRun.name, SETTLEMENT_FIXTURE_IMPORT_JOB), eq(schema.opsRun.branchId, branchId)));
    const before = await runs();
    const denied = await ctx.app.inject({ method: 'POST', url, headers: { cookie: receptionCookie,
      'idempotency-key': newId() }, payload: { date, fileName: 'fixture.csv', csv } });
    expect(denied.statusCode).toBe(403);
    expect(await runs()).toHaveLength(before.length);
    const firstKey = newId();
    const res = await ctx.app.inject({ method: 'POST', url, headers: { cookie: managerCookie,
      'idempotency-key': firstKey }, payload: { date, fileName: 'fixture.csv', csv } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ state: 'attention', matched: 1, unmatched: 1, mismatched: 0 });
    const sameRequest = await ctx.app.inject({ method: 'POST', url, headers: { cookie: managerCookie,
      'idempotency-key': firstKey }, payload: { date, fileName: 'fixture.csv', csv } });
    expect(sameRequest.json()).toEqual(res.json());
    expect(await runs()).toHaveLength(before.length + 1);
    const replay = await ctx.app.inject({ method: 'POST', url, headers: { cookie: managerCookie,
      'idempotency-key': newId() }, payload: { date, fileName: 'fixture.csv', csv } });
    expect(replay.json()).toMatchObject({ replayed: true, batchId: res.json().batchId });
    const duplicate = await ctx.app.inject({ method: 'POST', url, headers: { cookie: managerCookie,
      'idempotency-key': newId() }, payload: { date, fileName: 'fixture-again.csv', csv: `${csv}\r\n` } });
    expect(duplicate.json()).toMatchObject({ state: 'attention', matched: 0, mismatched: 1 });
    const failed = await ctx.app.inject({ method: 'POST', url, headers: { cookie: managerCookie,
      'idempotency-key': newId() }, payload: { date, fileName: 'bad.csv', csv: 'PRIVATELOOKUPMARKER' } });
    expect(failed.statusCode).toBe(400);
    const newRuns = (await runs()).filter((run) => !before.some((old) => old.id === run.id));
    expect(newRuns.map((run) => run.outcome).sort()).toEqual(['failed', 'ok', 'ok', 'skipped']);
    expect(newRuns.map((run) => run.kind)).toEqual(['job', 'job', 'job', 'job']);
    expect(newRuns.find((run) => run.outcome === 'skipped'))
      .toMatchObject({ actionId: res.json().batchId, operatorId, branchId });
    expect(newRuns.find((run) => run.outcome === 'failed'))
      .toMatchObject({ errorCode: 'BAD_REQUEST', branchId });
    expect(JSON.stringify(newRuns)).not.toContain('PRIVATELOOKUPMARKER');
    expect(JSON.stringify(newRuns)).not.toContain('TESTINVOICE1');
    const [gateway] = await ctx.db.select({ status: schema.paymentAttempt.status, paidAt: schema.paymentAttempt.paidAt })
      .from(schema.paymentAttempt).where(eq(schema.paymentAttempt.id, gatewayAttemptId));
    expect(gateway).toEqual({ status: 'approved', paidAt });
    const summary = await ctx.app.inject({ method: 'GET', url: `/branches/${branchId}/settlements?date=${date}`,
      headers: { cookie: receptionCookie } });
    expect(summary.statusCode, summary.body).toBe(200);
    expect(summary.json().batches).toHaveLength(3);
    expect(summary.json().lines).toHaveLength(5);
  });

  it('exports every approved till card and QR payment, including a gateway invoice with no TID', async () => {
    const exportDate = '2030-01-02';
    const exportPaidAt = new Date('2030-01-02T08:30:00.000Z');
    const otherBranchId = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
    const [otherTill] = await ctx.db.select({ id: schema.station.id }).from(schema.station)
      .where(and(eq(schema.station.branchId, otherBranchId), eq(schema.station.kind, 'till'))).limit(1);
    await ctx.db.insert(schema.paymentAttempt).values([
      { id: newId(), operatorId, branchId, stationId, businessDate: exportDate,
        method: 'card', methodCode: 'card', provider: 'simulator', status: 'approved',
        amountSatang: 12_000, tid: 'EXPORT-TID', approvalCode: '=FORMULA', paidAt: exportPaidAt },
      { id: newId(), operatorId, branchId, stationId, businessDate: exportDate,
        method: 'qr', methodCode: 'promptpay', provider: '2c2p', status: 'approved',
        amountSatang: 15_000, invoiceNo: 'GATEWAYINVOICE1', tranRef: 'GATEWAY-REF', paidAt: exportPaidAt },
      { id: newId(), operatorId, branchId, stationId, businessDate: exportDate,
        method: 'card', methodCode: 'card', provider: 'digio', status: 'awaiting_settlement',
        amountSatang: 8_000, tid: 'EXPORT-TID', paidAt: exportPaidAt },
      { id: newId(), operatorId, branchId, stationId: null, businessDate: exportDate,
        method: 'qr', methodCode: 'promptpay', provider: '2c2p', status: 'approved',
        amountSatang: 9_000, invoiceNo: 'BOOKINGINVOICE1', paidAt: exportPaidAt },
      { id: newId(), operatorId, branchId, stationId, businessDate: exportDate,
        method: 'qr', methodCode: PAID_ONLINE_TENDER_CODE, provider: '2c2p', status: 'approved',
        amountSatang: 10_000, invoiceNo: 'ONLINEINVOICE1', paidAt: exportPaidAt },
      { id: newId(), operatorId, branchId: otherBranchId, stationId: otherTill!.id,
        businessDate: exportDate, method: 'card', methodCode: 'card', provider: 'simulator',
        status: 'approved', amountSatang: 7_000, tid: 'EXPORT-TID', paidAt: exportPaidAt },
    ]);
    const url = `/branches/${branchId}/settlements/export?date=${exportDate}`;
    const all = await ctx.app.inject({ method: 'GET', url, headers: { cookie: receptionCookie } });
    expect(all.statusCode, all.body).toBe(200);
    const rows = all.body.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe('business_date,tid,method,amount_satang,approval_code,invoice_no,tran_ref,status');
    expect(rows.some((row) => row.includes('"EXPORT-TID","card","12000","\'=FORMULA"'))).toBe(true);
    expect(rows.some((row) => row.includes('"","qr","15000"') && row.includes('"GATEWAYINVOICE1"'))).toBe(true);
    expect(all.body).not.toContain('BOOKINGINVOICE1');
    expect(all.body).not.toContain('ONLINEINVOICE1');
    expect(all.body).not.toContain('"8000"');
    expect(all.body).not.toContain('"7000"');

    const terminal = await ctx.app.inject({ method: 'GET', url: `${url}&tid=EXPORT-TID`,
      headers: { cookie: receptionCookie } });
    expect(terminal.statusCode).toBe(200);
    expect(terminal.body.replace(/^\uFEFF/, '').trim().split('\r\n')).toHaveLength(2);
    expect(terminal.body).not.toContain('GATEWAYINVOICE1');
  });

  it('serializes two batches that report the same attempt', async () => {
    const id = newId();
    await ctx.db.insert(schema.paymentAttempt).values({ id, operatorId, branchId, stationId,
      deviceId, businessDate: date, method: 'qr', methodCode: 'promptpay', provider: 'digio',
      status: 'awaiting_settlement', amountSatang: 7_000, tid: 'TESTTID1',
      terminalRef: 'RACE-REF', paidAt });
    const url = `/branches/${branchId}/settlements/terminal-runs`;
    const runs = await Promise.all([1, 2].map(async () => {
      const res = await ctx.app.inject({ method: 'POST', url, headers: { cookie: managerCookie,
        'idempotency-key': newId() }, payload: { date, deviceId } });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as { batchId: string };
    }));
    const auth = { boxId, branchId, operatorId } as BoxAuth;
    const body = { outcome: 'settled' as const, deviceId, tid: 'TESTTID1',
      lines: [{ method: 'qr' as const, amountSatang: 7_000, terminalRef: 'RACE-REF' }] };
    const results = await Promise.all(runs.map((run) =>
      ctx.db.transaction((tx) => recordTerminalSettlement(tx, auth, run.batchId, body))));
    expect(results.map((r) => r.matched).sort()).toEqual([0, 1]);
    expect(results.map((r) => r.mismatched).sort()).toEqual([0, 1]);
  });

  it('admits a schema-sized callback above Fastify’s default body limit', async () => {
    const lines = Array.from({ length: 6_000 }, (_, i) => ({ method: 'qr', amountSatang: 100,
      terminalRef: `REF${String(i).padStart(5, '0')}${'X'.repeat(56)}`,
      tranRef: 'Y'.repeat(128) }));
    const res = await ctx.app.inject({ method: 'POST', url: `/settlements/batches/${newId()}/terminal-result`,
      payload: { outcome: 'settled', deviceId, lines } });
    expect(res.statusCode).toBe(401);
  });
  it('resets settlement evidence before payment facts while keeping terminal configuration', async () => {
    const counts = await resetDemoData(ctx.db);
    expect(counts.settlement_batch).toBeGreaterThan(0);
    expect(counts.settlement_line).toBeGreaterThan(0);
    expect(counts.settlement_command).toBeGreaterThan(0);
    expect(await ctx.db.select().from(schema.settlementBatch)).toHaveLength(0);
    expect(await ctx.db.select().from(schema.settlementLine)).toHaveLength(0);
    expect(await ctx.db.select().from(schema.device).where(eq(schema.device.id, deviceId))).toHaveLength(1);
  });

});
