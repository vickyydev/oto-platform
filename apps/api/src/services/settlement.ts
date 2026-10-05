import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { box, boxCommand, device, paymentAttempt, settlementBatch, settlementLine } from '@oto/db';
import { countsAsTillTakings, newId, type SettlementBatchState, type SettlementMatch, type SettlementSummary, type TerminalSettlementResultBody } from '@oto/shared';
import { errors } from '../lib/errors';
import { audit } from './audit';
import { branchClockFor } from './end-of-day';
import type { BoxAuth } from './box';
import type { Exec, Tx } from './tx';

type Attempt = Pick<typeof paymentAttempt.$inferSelect,
  'id' | 'method' | 'methodCode' | 'stationId' | 'provider' | 'status' | 'amountSatang' | 'deviceId' |
  'tid' | 'approvalCode' | 'invoiceNo' | 'terminalRef' | 'tranRef' | 'paymentId'>;

type Evidence = { method: 'card' | 'qr'; amountSatang: number; tid?: string | null; approvalCode?: string | null;
  invoiceNo?: string | null; terminalRef?: string | null; tranRef?: string | null; paymentId?: string | null };

/** References first; never match money on amount alone. */
export function matchSettlementEvidence(e: Evidence, attempts: readonly Attempt[], used: ReadonlySet<string> = new Set()):
  { match: SettlementMatch; attemptId: string | null } {
  const refs: Array<keyof Pick<Evidence, 'invoiceNo' | 'terminalRef' | 'tranRef' | 'paymentId' | 'approvalCode'>> =
    ['invoiceNo', 'tranRef', 'paymentId', 'terminalRef', 'approvalCode'];
  if (!refs.some((key) => e[key])) return { match: 'unmatched', attemptId: null };
  const candidates = attempts.filter((a) => a.method === e.method &&
    refs.some((key) => e[key] && a[key] === e[key]));
  if (!candidates.length) return { match: 'unmatched', attemptId: null };
  if (candidates.length !== 1 || used.has(candidates[0]!.id)) return { match: 'ambiguous', attemptId: null };
  const one = candidates[0]!;
  if (e.tid && e.tid !== one.tid) return { match: 'reference_mismatch', attemptId: one.id };
  if (refs.some((key) => e[key] && one[key] && e[key] !== one[key])) {
    return { match: 'reference_mismatch', attemptId: one.id };
  }
  if (one.amountSatang !== e.amountSatang) return { match: 'amount_mismatch', attemptId: one.id };
  return { match: 'matched', attemptId: one.id };
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const resultFingerprint = (b: TerminalSettlementResultBody) => hash(JSON.stringify([
  b.outcome, b.deviceId, b.tid ?? null, b.mid ?? null, b.batchRef ?? null, b.errorCode ?? null,
  b.lines.map((l) => [l.method, l.amountSatang, l.terminalRef ?? null, l.tranRef ?? null, l.approvalCode ?? null]),
]));

async function eligibleAttempts(db: Exec, operatorId: string, branchId: string, date: string, deviceId?: string) {
  return db.select({
    id: paymentAttempt.id, method: paymentAttempt.method, methodCode: paymentAttempt.methodCode,
    stationId: paymentAttempt.stationId, provider: paymentAttempt.provider, status: paymentAttempt.status,
    amountSatang: paymentAttempt.amountSatang, deviceId: paymentAttempt.deviceId, tid: paymentAttempt.tid,
    approvalCode: paymentAttempt.approvalCode, invoiceNo: paymentAttempt.invoiceNo,
    terminalRef: paymentAttempt.terminalRef, tranRef: paymentAttempt.tranRef, paymentId: paymentAttempt.paymentId,
  }).from(paymentAttempt).where(and(
    eq(paymentAttempt.operatorId, operatorId), eq(paymentAttempt.branchId, branchId),
    eq(paymentAttempt.businessDate, date), inArray(paymentAttempt.status, ['approved', 'awaiting_settlement']),
    inArray(paymentAttempt.method, ['card', 'qr']),
    ...(deviceId ? [eq(paymentAttempt.deviceId, deviceId)] : []),
  ));
}

async function previouslyMatchedAttemptIds(db: Exec, attempts: readonly Attempt[]): Promise<Set<string>> {
  if (!attempts.length) return new Set();
  const rows = await db.select({ attemptId: settlementLine.attemptId }).from(settlementLine).where(and(
    inArray(settlementLine.attemptId, attempts.map((a) => a.id)), eq(settlementLine.match, 'matched'),
  ));
  return new Set(rows.map((r) => r.attemptId).filter((id): id is string => id !== null));
}

async function serializeSettlementDay(tx: Tx, branchId: string, date: string): Promise<void> {
  // Different batches can report the same attempt concurrently. Hold one transaction lock
  // per branch/day while reading confirmed lines and writing new ones.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`settlement:${branchId}`}), hashtext(${date}))`);
}

export async function startTerminalSettlement(tx: Tx, input: {
  operatorId: string; branchId: string; date: string; deviceId: string; accountId: string;
  sourceKey: string; requestId?: string;
}) {
  await branchClockFor(tx, input.operatorId, input.branchId);
  const [terminal] = await tx.select().from(device).where(and(
    eq(device.id, input.deviceId), eq(device.operatorId, input.operatorId), eq(device.branchId, input.branchId),
    eq(device.kind, 'terminal'), isNull(device.archivedAt),
  )).limit(1);
  if (!terminal) throw errors.notFound('Terminal not found in this branch');
  const [ownerBox] = await tx.select({ id: box.id }).from(box).where(and(
    eq(box.id, terminal.boxId), eq(box.operatorId, input.operatorId), eq(box.branchId, input.branchId),
    isNull(box.archivedAt),
  )).limit(1);
  if (!ownerBox) throw errors.conflict('TERMINAL_BOX_UNAVAILABLE', 'This terminal has no active box');
  const [prior] = await tx.select().from(settlementBatch).where(and(
    eq(settlementBatch.operatorId, input.operatorId), eq(settlementBatch.branchId, input.branchId),
    eq(settlementBatch.source, 'terminal'), eq(settlementBatch.sourceKey, input.sourceKey),
  )).limit(1);
  if (prior) {
    if (prior.businessDate !== input.date || prior.deviceId !== input.deviceId || !prior.commandId) {
      throw errors.conflict('SETTLEMENT_REPLAY_CHANGED', 'This settlement action was already used for a different request');
    }
    return { batchId: prior.id, commandId: prior.commandId, state: 'pending' as const };
  }
  const batchId = newId();
  const commandId = newId();
  await tx.insert(boxCommand).values({
    id: commandId, boxId: ownerBox.id, kind: 'terminal_settle',
    payload: { batchId, deviceId: input.deviceId, businessDate: input.date },
    requestedByAccountId: input.accountId, actionId: input.sourceKey,
    // A result is delivered separately from the command acknowledgement.
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  await tx.insert(settlementBatch).values({
    id: batchId, operatorId: input.operatorId, branchId: input.branchId, businessDate: input.date,
    source: 'terminal', state: 'pending', sourceKey: input.sourceKey, deviceId: input.deviceId,
    commandId, tid: terminal.terminalId, mid: terminal.merchantId, createdByAccountId: input.accountId,
  });
  await audit.record(tx, { actorAccountId: input.accountId, operatorId: input.operatorId,
    branchId: input.branchId, action: 'settlement.run', entityType: 'settlement_batch', entityId: batchId,
    requestId: input.requestId, actionId: input.sourceKey,
    after: { source: 'terminal', businessDate: input.date, deviceId: input.deviceId, commandId } });
  return { batchId, commandId, state: 'pending' as const };
}

export async function recordTerminalSettlement(tx: Tx, auth: BoxAuth, batchId: string,
  body: TerminalSettlementResultBody, requestId?: string) {
  const [batch] = await tx.select().from(settlementBatch).where(and(
    eq(settlementBatch.id, batchId), eq(settlementBatch.operatorId, auth.operatorId),
    eq(settlementBatch.branchId, auth.branchId), eq(settlementBatch.source, 'terminal'),
  )).for('update').limit(1);
  if (!batch || !batch.deviceId || !batch.commandId) throw errors.notFound('Settlement batch not found');
  const [command] = await tx.select({ boxId: boxCommand.boxId }).from(boxCommand)
    .where(eq(boxCommand.id, batch.commandId)).limit(1);
  if (!command || command.boxId !== auth.boxId || body.deviceId !== batch.deviceId) {
    throw errors.notFound('Settlement batch not found for this box');
  }
  if ((batch.tid && body.tid && batch.tid !== body.tid) ||
      (batch.mid && body.mid && batch.mid !== body.mid)) {
    throw errors.conflict('TERMINAL_IDENTITY_CHANGED', 'The terminal batch names a different terminal identity');
  }
  const fingerprint = resultFingerprint(body);
  if (batch.resultHash) {
    if (batch.resultHash !== fingerprint) throw errors.conflict('SETTLEMENT_REPLAY_CHANGED', 'The recorded result differs from this retry');
    return { batchId, replayed: true, state: batch.state, matched: batch.matched,
      unmatched: batch.unmatched, mismatched: batch.mismatched };
  }
  await serializeSettlementDay(tx, auth.branchId, batch.businessDate);
  const attempts = await eligibleAttempts(tx, auth.operatorId, auth.branchId, batch.businessDate, batch.deviceId);
  const used = await previouslyMatchedAttemptIds(tx, attempts);
  let matched = 0, unmatched = 0, mismatched = 0;
  for (const [index, line] of body.lines.entries()) {
    const evidence = { ...line, tid: body.tid ?? batch.tid };
    const answer = matchSettlementEvidence(evidence, attempts, used);
    if (answer.match === 'matched' && answer.attemptId) {
      used.add(answer.attemptId);
      matched++;
      const a = attempts.find((row) => row.id === answer.attemptId)!;
      // It already counted as paid. Settlement confirms the fact; it does not pay again.
      if (a.status === 'awaiting_settlement' && a.provider === 'digio') {
        await tx.update(paymentAttempt).set({ status: 'approved' }).where(and(
          eq(paymentAttempt.id, a.id), eq(paymentAttempt.status, 'awaiting_settlement'),
        ));
        await audit.record(tx, { actorAccountId: null, operatorId: auth.operatorId, branchId: auth.branchId,
          action: 'payment.settlement_confirmed', entityType: 'payment_attempt', entityId: a.id,
          after: { batchId, status: 'approved' }, requestId });
      }
    } else if (answer.match === 'unmatched') unmatched++;
    else mismatched++;
    await tx.insert(settlementLine).values({ id: newId(), batchId, lineNo: index + 1,
      attemptId: answer.attemptId, method: line.method, amountSatang: line.amountSatang,
      tid: body.tid ?? batch.tid, approvalCode: line.approvalCode ?? null,
      terminalRef: line.terminalRef ?? null, tranRef: line.tranRef ?? null,
      invoiceNo: null, transactionType: 'payment', match: answer.match });
  }
  const missing = body.outcome === 'settled' && attempts.some((a) => !used.has(a.id));
  const state: SettlementBatchState = body.outcome === 'unsupported' ? 'unsupported' : body.outcome === 'failed' ? 'failed' :
    unmatched || mismatched || missing ? 'attention' : 'matched';
  await tx.update(settlementBatch).set({ state, resultHash: fingerprint, tid: body.tid ?? batch.tid,
    mid: body.mid ?? batch.mid, batchRef: body.batchRef ?? null, errorCode: body.errorCode ?? null,
    matched, unmatched, mismatched, completedAt: new Date(),
  }).where(eq(settlementBatch.id, batchId));
  await tx.update(boxCommand).set({ state: body.outcome === 'settled' ? 'succeeded' : 'failed',
    finishedAt: new Date(), result: { batchId, outcome: body.outcome, matched, unmatched, mismatched },
    errorCode: body.outcome === 'unsupported' ? 'UNSUPPORTED' : body.errorCode ?? null,
  }).where(eq(boxCommand.id, batch.commandId));
  await audit.record(tx, { actorAccountId: null, operatorId: auth.operatorId, branchId: auth.branchId,
    action: 'settlement.result', entityType: 'settlement_batch', entityId: batchId, requestId,
    after: { state, matched, unmatched, mismatched } });
  return { batchId, replayed: false, state, matched, unmatched, mismatched };
}

export async function settlementSummary(db: Exec, operatorId: string, branchId: string, date: string): Promise<SettlementSummary> {
  await branchClockFor(db, operatorId, branchId);
  const [devices, batches, attempts] = await Promise.all([
    db.select({ id: device.id, label: device.label, tid: device.terminalId,
      protocol: device.protocol, transport: device.transport }).from(device).where(and(
      eq(device.operatorId, operatorId), eq(device.branchId, branchId), eq(device.kind, 'terminal'), isNull(device.archivedAt),
    )),
    db.select({ batch: settlementBatch, commandState: boxCommand.state }).from(settlementBatch)
      .leftJoin(boxCommand, eq(boxCommand.id, settlementBatch.commandId)).where(and(
        eq(settlementBatch.operatorId, operatorId), eq(settlementBatch.branchId, branchId),
        eq(settlementBatch.businessDate, date),
      )).orderBy(asc(settlementBatch.createdAt)),
    eligibleAttempts(db, operatorId, branchId, date),
  ]);
  const batchIds = batches.map((r) => r.batch.id);
  const lines = batchIds.length ? await db.select().from(settlementLine)
    .where(inArray(settlementLine.batchId, batchIds)).orderBy(asc(settlementLine.createdAt), asc(settlementLine.lineNo)) : [];
  const matchedIds = new Set(lines.filter((l) => l.match === 'matched').map((l) => l.attemptId));
  return {
    branchId, date,
    devices: devices.map((d) => ({ id: d.id, label: d.label, tid: d.tid,
      provider: d.transport === 'simulated' ? 'simulator' as const : d.protocol === 'digio_tlv' ? 'digio' as const : 'ghl' as const })),
    batches: batches.map(({ batch: b, commandState }) => ({ id: b.id, source: b.source,
      state: b.state === 'pending' && ['failed', 'expired', 'cancelled'].includes(commandState ?? '') ? 'failed' : b.state,
      deviceId: b.deviceId, tid: b.tid, createdAt: b.createdAt.toISOString(), completedAt: b.completedAt?.toISOString() ?? null,
      matched: b.matched, unmatched: b.unmatched, mismatched: b.mismatched })),
    lines: lines.map((l) => ({ id: l.id, batchId: l.batchId, attemptId: l.attemptId, method: l.method,
      amountSatang: l.amountSatang, tid: l.tid, approvalCode: l.approvalCode,
      invoiceNo: l.invoiceNo, terminalRef: l.terminalRef, tranRef: l.tranRef,
      transactionType: l.transactionType, match: l.match })),
    unmatchedAttempts: attempts.filter((a) => !matchedIds.has(a.id)).map((a) => ({
      id: a.id, method: a.method as 'card' | 'qr', amountSatang: a.amountSatang, tid: a.tid,
      invoiceNo: a.invoiceNo, status: a.status as 'approved' | 'awaiting_settlement',
    })),
  };
}

function csvCell(value: string | number | null): string {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** A snapshot of approved till card/QR attempts for one actual TID. */
export async function settlementExport(db: Exec, operatorId: string, branchId: string, date: string, tid: string) {
  await branchClockFor(db, operatorId, branchId);
  const attempts = (await eligibleAttempts(db, operatorId, branchId, date))
    .filter((a) => a.status === 'approved' && a.tid === tid && countsAsTillTakings(a));
  if (attempts.length > 100_000) throw errors.badRequest('The settlement export is too large');
  const rows = ['business_date,tid,method,amount_satang,approval_code,invoice_no,tran_ref,status'];
  for (const a of attempts) rows.push([date, a.tid, a.method, a.amountSatang, a.approvalCode,
    a.invoiceNo, a.tranRef, a.status].map(csvCell).join(','));
  return { filename: `settlement_${date}_${hash(tid).slice(0, 8)}.csv`, csv: `\uFEFF${rows.join('\r\n')}\r\n` };
}

const GATEWAY_FIXTURE_HEADER = [
  'TYPE_TABLE', 'invoiceNo', 'tranRef', 'paymentID', 'amount', 'currencyCode', 'transactionType', 'method',
];

/** A strict, bounded H/D fixture while the real 2C2P field mapping is unverified. */
export function parse2c2pFixture(csv: string): Array<Evidence & { transactionType: string }> {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  const input = csv.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') {
      if (field) throw errors.badRequest('The settlement fixture has an invalid CSV quote');
      quoted = true;
    } else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') {
      row.push(field.replace(/\r$/, '')); field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
      if (rows.length > 10_002) throw errors.badRequest('The settlement fixture exceeds 10,000 detail rows');
    } else field += c;
  }
  if (quoted) throw errors.badRequest('The settlement fixture has an unfinished CSV quote');
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  if (rows[0]?.join('\u0000') !== GATEWAY_FIXTURE_HEADER.join('\u0000')) {
    throw errors.badRequest('This fixture needs the documented H/D header; real provider files require mapping before import');
  }
  if (rows[1]?.[0] !== 'H' || rows.slice(2).some((r) => r[0] !== 'D')) {
    throw errors.badRequest('The settlement fixture needs one H record followed by D records');
  }
  const details = rows.slice(2);
  if (details.length > 10_000) throw errors.badRequest('The settlement fixture exceeds 10,000 detail rows');
  return details.map((r) => {
    if (r.length !== GATEWAY_FIXTURE_HEADER.length || r[5] !== 'THB' || !['card', 'qr'].includes(r[7] ?? '')) {
      throw errors.badRequest('The settlement fixture has an invalid detail record');
    }
    const amount = r[4] ?? '';
    if (!/^\d{1,10}\.\d{2}$/.test(amount)) throw errors.badRequest('A settlement amount must have two decimal places');
    const [baht, satang] = amount.split('.');
    const amountSatang = Number(baht) * 100 + Number(satang);
    if (!Number.isSafeInteger(amountSatang) || amountSatang <= 0) throw errors.badRequest('A settlement amount must be positive');
    const bounded = (value: string | undefined) => {
      if (value && value.length > 128) throw errors.badRequest('A settlement reference is too long');
      return value || null;
    };
    const invoiceNo = bounded(r[1]);
    const transactionType = (r[6] ?? '').toLowerCase();
    if (!invoiceNo || !['payment', 'refund', 'chargeback'].includes(transactionType)) {
      throw errors.badRequest('The settlement fixture needs an invoice and a known transaction type');
    }
    return { method: r[7] as 'card' | 'qr', amountSatang, invoiceNo,
      tranRef: bounded(r[2]), paymentId: bounded(r[3]), transactionType };
  });
}

export async function import2c2pFixture(tx: Tx, input: {
  operatorId: string; branchId: string; date: string; fileName: string; csv: string;
  accountId: string; requestId?: string;
}) {
  await branchClockFor(tx, input.operatorId, input.branchId);
  const details = parse2c2pFixture(input.csv);
  await serializeSettlementDay(tx, input.branchId, input.date);
  const sourceKey = hash(input.csv);
  const [prior] = await tx.select().from(settlementBatch).where(and(
    eq(settlementBatch.operatorId, input.operatorId), eq(settlementBatch.branchId, input.branchId),
    eq(settlementBatch.source, '2c2p'), eq(settlementBatch.sourceKey, sourceKey),
  )).limit(1);
  if (prior) {
    if (prior.businessDate !== input.date) throw errors.conflict('SETTLEMENT_REPLAY_CHANGED', 'This file was already imported for another day');
    return { batchId: prior.id, replayed: true, state: prior.state,
      matched: prior.matched, unmatched: prior.unmatched, mismatched: prior.mismatched };
  }
  const batchId = newId();
  const attempts = (await eligibleAttempts(tx, input.operatorId, input.branchId, input.date))
    .filter((a) => a.invoiceNo && (a.provider === '2c2p' || a.provider === 'simulator'));
  const used = await previouslyMatchedAttemptIds(tx, attempts);
  let matched = 0, unmatched = 0, mismatched = 0;
  await tx.insert(settlementBatch).values({
    id: batchId, operatorId: input.operatorId, branchId: input.branchId,
    businessDate: input.date, source: '2c2p', state: 'pending', sourceKey,
    fileName: input.fileName, createdByAccountId: input.accountId,
  });
  for (const [index, detail] of details.entries()) {
    const answer = detail.transactionType === 'payment'
      ? matchSettlementEvidence(detail, attempts, used)
      : { match: 'unmatched' as const, attemptId: null };
    if (answer.match === 'matched' && answer.attemptId) { used.add(answer.attemptId); matched++; }
    else if (answer.match === 'unmatched') unmatched++;
    else mismatched++;
    await tx.insert(settlementLine).values({ id: newId(), batchId, lineNo: index + 1,
      attemptId: answer.attemptId, method: detail.method, amountSatang: detail.amountSatang,
      invoiceNo: detail.invoiceNo ?? null, tranRef: detail.tranRef ?? null, paymentId: detail.paymentId ?? null,
      transactionType: detail.transactionType, match: answer.match });
  }
  const missing = attempts.some((a) => !used.has(a.id));
  const state = unmatched || mismatched || missing ? 'attention' as const : 'matched' as const;
  await tx.update(settlementBatch).set({ state, matched, unmatched, mismatched, completedAt: new Date() })
    .where(eq(settlementBatch.id, batchId));
  await audit.record(tx, { actorAccountId: input.accountId, operatorId: input.operatorId, branchId: input.branchId,
    action: 'settlement.run', entityType: 'settlement_batch', entityId: batchId, requestId: input.requestId,
    after: { source: '2c2p', businessDate: input.date, fileHash: sourceKey, matched, unmatched, mismatched,
      fixtureFormat: true } });
  return { batchId, replayed: false, state, matched, unmatched, mismatched };
}
