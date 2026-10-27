import { and, asc, desc, eq, gte, inArray, or, sql, type SQL } from 'drizzle-orm';
import {
  auditLog, box, boxCommand, boxOutbox, dailySummary, dirtyDate, opsRun, paymentAttempt, paymentNotification, printJob,
  refund, sale, station, stationEvent, syncAnomaly, syncEvent, syncQuarantine, wallet, walletEntry, type Db,
} from '@oto/db';

/**
 * SCRUM-648 (S2-23 P5-6) — "WHAT HAPPENED TO THIS SALE".
 *
 * One action id, sale id, receipt number, refund, payment attempt or wallet,
 * followed through every record the platform keeps of it, in the order the
 * pipeline runs: till intent -> box session and lease -> device adapter call
 * -> outbox event (epoch, sequence) -> cloud apply or quarantine -> audit row
 * -> payment webhook and inquiry -> rollup effect.
 *
 * A stage with no record is returned as a GAP, never skipped and never
 * guessed: absent, purged (the station tape and `ops_run` keep 30 days) and
 * never-recorded all look the same from here, and the note says which ones
 * are possible. Records are PROJECTED — kinds, states, outcomes, codes,
 * sequence numbers and times — never a payload, a terminal frame, a QR
 * string, a phone or a name. Every read is scoped to the caller's operator;
 * the route checks `console:support:trace` at the anchor's park before any of
 * this is returned, and writes the data_access row.
 */

export const TRACE_KINDS = ['action', 'sale', 'refund', 'payment_attempt', 'receipt', 'wallet'] as const;
export type TraceKind = typeof TRACE_KINDS[number];
export const TRACE_STAGES = [
  'till_intent', 'box_session', 'device_call', 'outbox', 'cloud_apply', 'wallet_ledger', 'audit', 'payment', 'rollup',
] as const;
export type TraceStage = typeof TRACE_STAGES[number];
export const TRACE_STEP_STATUSES = ['recorded', 'failed', 'quarantined', 'pending', 'gap'] as const;
export type TraceStepStatus = typeof TRACE_STEP_STATUSES[number];

type Scalar = string | number | boolean | null;
export interface TraceStep {
  stage: TraceStage;
  label: string;
  status: TraceStepStatus;
  at: string | null;
  source: string | null;
  recordId: string | null;
  opsRunId: string | null;
  requestId: string | null;
  actionId: string | null;
  latencyMs: number | null;
  sincePreviousMs: number | null;
  /** This step is earlier than the one before it: a clock or ordering problem worth seeing. */
  outOfOrder: boolean;
  detail: Record<string, Scalar>;
  traceUrl: string | null;
  note: string | null;
}

export interface TraceAnchor {
  kind: TraceKind;
  id: string;
  operatorId: string;
  branchId: string | null;
  saleId: string | null;
  walletId: string | null;
  receiptNumber: string | null;
  actionIds: string[];
  /** Other records the same key named (a receipt number repeats across parks). */
  alsoMatched: number;
}

export interface SupportTrace {
  generatedAt: string;
  anchor: Omit<TraceAnchor, 'operatorId'>;
  steps: TraceStep[];
  gaps: TraceStage[];
}

const STAGE_LABEL: Record<TraceStage, string> = {
  till_intent: 'Till intent', box_session: 'Box session and lease', device_call: 'Device adapter call',
  outbox: 'Outbox event', cloud_apply: 'Cloud apply', wallet_ledger: 'Wallet ledger', audit: 'Audit record',
  payment: 'Payment webhook and inquiry', rollup: 'Rollup effect',
};
const GAP_NOTE: Record<TraceStage, string> = {
  till_intent: 'No till intent was recorded for this action. The station tape is kept for 30 days and reaches the cloud only from the virtual box; a Pi keeps it on the box.',
  box_session: 'No box session or lease event names this action. A Pi keeps its session document on the box.',
  device_call: 'No terminal command, print job or adapter run names this action (card-free sales print nothing; runs are kept 30 days).',
  outbox: 'No outbox event: the sale was not carried by a box journal, or the ledger row has been swept (365 days).',
  cloud_apply: 'Nothing was applied in the cloud for this action.',
  wallet_ledger: 'No wallet entry names this record.',
  audit: 'No audit row names this action or record.',
  payment: 'No payment attempt, gateway notification or inquiry is linked.',
  rollup: 'No rollup has been seen for this business day yet.',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | string | null | undefined): string | null => d == null ? null : new Date(d).toISOString();
const num = (v: unknown): number | null => v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null;

/** Find what the key names, inside the caller's operator. Null: nothing does. */
export async function resolveTraceAnchor(db: Db, operatorId: string, kind: TraceKind, raw: string): Promise<TraceAnchor | null> {
  const id = raw.trim();
  const base = { kind, id, operatorId, walletId: null, alsoMatched: 0 };
  const fromSale = async (row: typeof sale.$inferSelect, alsoMatched = 0): Promise<TraceAnchor> => ({
    ...base, branchId: row.branchId, saleId: row.id, receiptNumber: row.receiptNumber, alsoMatched,
    actionIds: await saleActionIds(db, operatorId, row, kind === 'action' ? id : null),
  });
  const saleById = async (saleId: string | null) => {
    if (!saleId || !UUID.test(saleId)) return null;
    const [row] = await db.select().from(sale).where(and(eq(sale.operatorId, operatorId), eq(sale.id, saleId))).limit(1);
    return row ?? null;
  };

  if (kind === 'sale') { const row = await saleById(id); return row ? fromSale(row) : null; }
  if (kind === 'receipt') {
    const rows = await db.select().from(sale)
      .where(and(eq(sale.operatorId, operatorId), eq(sale.receiptNumber, id.toUpperCase())))
      .orderBy(desc(sale.occurredAt)).limit(5);
    return rows[0] ? fromSale(rows[0], rows.length - 1) : null;
  }
  if (kind === 'refund') {
    if (!UUID.test(id)) return null;
    const [row] = await db.select().from(refund).where(and(eq(refund.operatorId, operatorId), eq(refund.id, id))).limit(1);
    const parent = row ? await saleById(row.saleId) : null;
    return parent ? fromSale(parent) : null;
  }
  if (kind === 'payment_attempt') {
    if (!UUID.test(id)) return null;
    const [row] = await db.select().from(paymentAttempt)
      .where(and(eq(paymentAttempt.operatorId, operatorId), eq(paymentAttempt.id, id))).limit(1);
    if (!row) return null;
    const parent = await saleById(row.saleId);
    if (parent) return fromSale(parent);
    return { ...base, branchId: row.branchId, saleId: null, receiptNumber: null,
      actionIds: [...new Set([row.actionId, inquiryActionId(row.payload)].filter((a): a is string => !!a))] };
  }
  if (kind === 'wallet') {
    if (!UUID.test(id)) return null;
    const [row] = await db.select().from(wallet).where(and(eq(wallet.operatorId, operatorId), eq(wallet.id, id))).limit(1);
    if (!row) return null;
    const entries = await db.select({ actionId: walletEntry.actionId, branchId: walletEntry.branchId }).from(walletEntry)
      .where(and(eq(walletEntry.operatorId, operatorId), eq(walletEntry.walletId, row.id)))
      .orderBy(desc(walletEntry.createdAt)).limit(50);
    return { ...base, walletId: row.id, branchId: null, saleId: null, receiptNumber: null,
      actionIds: [...new Set(entries.map(e => e.actionId).filter((a): a is string => !!a))] };
  }
  // An action id: the sale it made, else the attempt or refund, else whatever else carries it.
  const [bySale] = await db.select().from(sale).where(and(eq(sale.operatorId, operatorId), eq(sale.actionId, id)))
    .orderBy(desc(sale.occurredAt)).limit(1);
  if (bySale) return fromSale(bySale);
  const [attempt] = await db.select().from(paymentAttempt)
    .where(and(eq(paymentAttempt.operatorId, operatorId), eq(paymentAttempt.actionId, id))).limit(1);
  if (attempt) {
    const parent = await saleById(attempt.saleId);
    if (parent) return fromSale(parent);
    return { ...base, branchId: attempt.branchId, saleId: null, receiptNumber: null,
      actionIds: [...new Set([id, inquiryActionId(attempt.payload)].filter((a): a is string => !!a))] };
  }
  const [byRefund] = await db.select().from(refund).where(and(eq(refund.operatorId, operatorId), eq(refund.actionId, id))).limit(1);
  if (byRefund) { const parent = await saleById(byRefund.saleId); if (parent) return fromSale(parent); }
  const [audited] = await db.select({ branchId: auditLog.branchId }).from(auditLog)
    .where(and(eq(auditLog.operatorId, operatorId), eq(auditLog.actionId, id))).limit(1);
  const [run] = audited ? [] : await db.select({ branchId: opsRun.branchId }).from(opsRun)
    .where(and(eq(opsRun.operatorId, operatorId), eq(opsRun.actionId, id))).limit(1);
  if (!audited && !run) return null;
  return { ...base, branchId: audited?.branchId ?? run?.branchId ?? null, saleId: null, receiptNumber: null, actionIds: [id] };
}

function inquiryActionId(payload: unknown): string | null {
  const inquiry = payload && typeof payload === 'object' ? (payload as { inquiry?: { actionId?: unknown } }).inquiry : undefined;
  return typeof inquiry?.actionId === 'string' ? inquiry.actionId : null;
}

/** The sale's own action, its attempts' (and their inquiries'), its refunds'. */
async function saleActionIds(db: Db, operatorId: string, row: typeof sale.$inferSelect, given: string | null) {
  const attempts = await db.select({ actionId: paymentAttempt.actionId, payload: paymentAttempt.payload }).from(paymentAttempt)
    .where(and(eq(paymentAttempt.operatorId, operatorId), eq(paymentAttempt.saleId, row.id)));
  const refunds = await db.select({ actionId: refund.actionId }).from(refund)
    .where(and(eq(refund.operatorId, operatorId), eq(refund.saleId, row.id)));
  return [...new Set([given, row.actionId, ...attempts.flatMap(a => [a.actionId, inquiryActionId(a.payload)]),
    ...refunds.map(r => r.actionId)].filter((a): a is string => !!a))];
}

// --- Gathering ---------------------------------------------------------------------

interface Raw { stage: TraceStage; at: Date | null; status?: TraceStepStatus; source: string; recordId: string | null;
  opsRunId?: string | null; requestId?: string | null; actionId?: string | null; latencyMs?: number | null;
  detail: Record<string, Scalar>; note?: string | null }

const RUN_DETAIL_KEYS = ['attemptId', 'saleId', 'protocol', 'mode', 'outcome', 'responseCode', 'elapsedMs', 'events',
  'applied', 'quarantined', 'duplicates', 'kind', 'command'] as const;
function runDetail(detail: unknown): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  if (!detail || typeof detail !== 'object') return out;
  for (const key of RUN_DETAIL_KEYS) {
    const v = (detail as Record<string, unknown>)[key];
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[key] = v;
  }
  return out;
}
function runStage(kind: string, name: string): TraceStage {
  if (name.startsWith('adapter:2c2p') || kind === 'webhook') return 'payment';
  if (kind === 'device' || kind === 'adapter') return 'device_call';
  if (kind === 'sync') return 'outbox';
  if (name.startsWith('job:rollup')) return 'rollup';
  return 'cloud_apply';
}

export async function traceOf(db: Db, anchor: TraceAnchor, opts: { traceUrlTemplate?: string; now?: Date } = {}): Promise<SupportTrace> {
  const op = anchor.operatorId;
  const ids = anchor.actionIds.length > 0 ? anchor.actionIds : ['\u0000none'];
  const raws: Raw[] = [];
  const [saleRow] = anchor.saleId
    ? await db.select().from(sale).where(and(eq(sale.operatorId, op), eq(sale.id, anchor.saleId))).limit(1) : [];

  // Till intent and the box session / lease, from the station tape.
  const tape = await db.select({ e: stationEvent }).from(stationEvent)
    .innerJoin(station, eq(station.id, stationEvent.stationId))
    .where(and(eq(station.operatorId, op), inArray(stationEvent.actionId, ids))).orderBy(asc(stationEvent.occurredAt)).limit(100);
  for (const { e } of tape) {
    raws.push({ stage: e.kind === 'intent' ? 'till_intent' : 'box_session', at: e.occurredAt, source: 'edge.station_event',
      recordId: e.id, actionId: e.actionId, status: e.outcome === 'refused' || e.kind === 'error' ? 'failed' : 'recorded',
      latencyMs: e.receivedAt && e.occurredAt ? e.receivedAt.getTime() - e.occurredAt.getTime() : null,
      detail: { kind: e.kind, intentType: e.intentType, outcome: e.outcome, errorCode: e.errorCode, sequence: num(e.sequence),
        stage: e.stage, source: e.source } });
  }

  // The device call: terminal / drawer commands, print jobs.
  const commands = await db.select({ c: boxCommand }).from(boxCommand).innerJoin(box, eq(box.id, boxCommand.boxId))
    .where(and(eq(box.operatorId, op), inArray(boxCommand.actionId, ids))).orderBy(asc(boxCommand.createdAt)).limit(50);
  for (const { c } of commands) {
    const mode = c.payload && typeof c.payload === 'object' ? (c.payload as { mode?: unknown }).mode : undefined;
    raws.push({ stage: 'device_call', at: c.createdAt, source: 'edge.box_command', recordId: c.id, actionId: c.actionId,
      status: c.state === 'failed' || c.errorCode ? 'failed' : c.state === 'succeeded' ? 'recorded' : 'pending',
      latencyMs: c.finishedAt ? c.finishedAt.getTime() - c.createdAt.getTime() : null,
      detail: { command: c.kind, state: c.state, mode: typeof mode === 'string' ? mode : null, attempts: c.attempts, errorCode: c.errorCode } });
  }
  const printConds: SQL[] = [inArray(printJob.actionId, ids)];
  if (anchor.saleId) printConds.push(and(eq(printJob.subjectType, 'sale'), eq(printJob.subjectId, anchor.saleId))!);
  const prints = await db.select().from(printJob).where(and(eq(printJob.operatorId, op), or(...printConds)))
    .orderBy(asc(printJob.queuedAt)).limit(50);
  for (const p of prints) {
    raws.push({ stage: 'device_call', at: p.queuedAt, source: 'edge.print_job', recordId: p.id, actionId: p.actionId,
      status: p.status === 'failed' ? 'failed' : p.status === 'queued' ? 'pending' : 'recorded',
      latencyMs: p.finishedAt && p.queuedAt ? p.finishedAt.getTime() - p.queuedAt.getTime() : null,
      detail: { printKind: p.kind, status: p.status, attempts: p.attempts, errorCode: p.errorCode, reprint: p.reprintOf !== null } });
  }

  // The outbox, the ledger, quarantine and anomalies.
  const eventConds: SQL[] = [inArray(syncEvent.actionId, ids)];
  if (saleRow?.sourceEventId) eventConds.push(eq(syncEvent.eventId, saleRow.sourceEventId));
  const events = await db.select().from(syncEvent).where(and(eq(syncEvent.operatorId, op), or(...eventConds)))
    .orderBy(asc(syncEvent.receivedAt)).limit(50);
  const eventIds = events.map(e => e.eventId);
  const batchIds = [...new Set(events.map(e => e.batchId).filter((b): b is string => !!b && UUID.test(b)))];
  for (const e of events) {
    raws.push({ stage: 'outbox', at: e.occurredAt, source: 'edge.sync_event', recordId: e.eventId, actionId: e.actionId,
      opsRunId: e.batchId && UUID.test(e.batchId) ? e.batchId : null, status: 'recorded',
      latencyMs: e.receivedAt && e.occurredAt ? e.receivedAt.getTime() - e.occurredAt.getTime() : null,
      detail: { type: e.type, journalEpoch: e.journalEpoch, sequence: num(e.boxSeq), clockTrust: e.clockTrust } });
  }
  const outbox = await db.select({ o: boxOutbox }).from(boxOutbox).innerJoin(box, eq(box.id, boxOutbox.boxId))
    .where(and(eq(box.operatorId, op), inArray(boxOutbox.actionId, ids))).limit(50);
  for (const { o } of outbox) {
    if (eventIds.includes(o.eventId)) continue;
    raws.push({ stage: 'outbox', at: o.createdAt, source: 'edge.box_outbox', recordId: o.eventId, actionId: o.actionId,
      status: o.state === 'acked' ? 'recorded' : o.state === 'quarantined' ? 'quarantined' : o.state === 'failed' ? 'failed' : 'pending',
      detail: { type: o.type, journalEpoch: o.journalEpoch, sequence: num(o.boxSeq), state: o.state, attempts: o.attempts } });
  }
  const quarantineConds: SQL[] = [inArray(syncQuarantine.actionId, ids)];
  if (eventIds.length) quarantineConds.push(inArray(syncQuarantine.eventId, eventIds));
  const quarantined = await db.select({ q: syncQuarantine }).from(syncQuarantine).innerJoin(box, eq(box.id, syncQuarantine.boxId))
    .where(and(eq(box.operatorId, op), or(...quarantineConds))).limit(50);
  for (const { q } of quarantined) {
    raws.push({ stage: 'cloud_apply', at: q.receivedAt, source: 'edge.sync_quarantine', recordId: q.id, actionId: q.actionId,
      opsRunId: q.batchId && UUID.test(q.batchId) ? q.batchId : null, status: q.status === 'open' ? 'quarantined' : 'recorded',
      detail: { reason: q.reason, status: q.status, errorCode: q.errorCode, journalEpoch: q.journalEpoch, sequence: num(q.boxSeq) } });
  }
  if (eventIds.length) {
    const anomalies = await db.select({ a: syncAnomaly }).from(syncAnomaly).innerJoin(box, eq(box.id, syncAnomaly.boxId))
      .where(and(eq(box.operatorId, op), inArray(syncAnomaly.eventId, eventIds))).limit(20);
    for (const { a } of anomalies) {
      raws.push({ stage: 'cloud_apply', at: a.detectedAt, source: 'edge.sync_anomaly', recordId: a.id, actionId: a.actionId,
        status: 'failed', detail: { anomaly: a.kind } });
    }
  }
  if (saleRow) {
    raws.push({ stage: 'cloud_apply', at: saleRow.receivedAt, source: 'pos.sale', recordId: saleRow.id, actionId: saleRow.actionId,
      status: 'recorded', latencyMs: saleRow.receivedAt && saleRow.occurredAt ? saleRow.receivedAt.getTime() - saleRow.occurredAt.getTime() : null,
      detail: { status: saleRow.status, origin: saleRow.origin, receiptNumber: saleRow.receiptNumber, businessDate: String(saleRow.businessDate),
        sequence: num(saleRow.boxSeq), clockTrust: saleRow.clockTrust } });
  }

  // The wallet's own ledger, when that is what was asked about.
  if (anchor.walletId) {
    const entries = await db.select().from(walletEntry)
      .where(and(eq(walletEntry.operatorId, op), eq(walletEntry.walletId, anchor.walletId))).orderBy(asc(walletEntry.createdAt)).limit(50);
    for (const w of entries) {
      raws.push({ stage: 'wallet_ledger', at: w.createdAt, source: 'pos.wallet_entry', recordId: w.id, actionId: w.actionId,
        status: 'recorded', detail: { kind: w.kind, source: w.source, amountSatang: num(w.amountSatang), balanceAfter: num(w.balanceAfter),
          offline: w.offline, saleId: w.saleId } });
    }
  }

  // The audit rows (actions only: their before/after stay on the masked activity read).
  const auditConds: SQL[] = [inArray(auditLog.actionId, ids)];
  if (anchor.saleId) auditConds.push(eq(auditLog.entityId, anchor.saleId));
  if (anchor.walletId) auditConds.push(eq(auditLog.entityId, anchor.walletId));
  if (eventIds.length) auditConds.push(inArray(auditLog.sourceEventId, eventIds));
  const audits = await db.select({ id: auditLog.id, action: auditLog.action, entityType: auditLog.entityType, createdAt: auditLog.createdAt,
    requestId: auditLog.requestId, actionId: auditLog.actionId, origin: auditLog.origin, actorType: auditLog.actorType })
    .from(auditLog).where(and(eq(auditLog.operatorId, op), or(...auditConds))).orderBy(asc(auditLog.createdAt)).limit(100);
  for (const a of audits) {
    // The trace's own data_access rows are reads of this record, not part of what happened to it.
    if (a.entityType === 'data_access') continue;
    raws.push({ stage: 'audit', at: a.createdAt, source: 'core.audit_log', recordId: a.id, requestId: a.requestId, actionId: a.actionId,
      status: 'recorded', detail: { action: a.action, entityType: a.entityType, origin: a.origin, actorType: a.actorType } });
  }

  // Payment: attempts, gateway notifications, and their runs.
  const attemptConds: SQL[] = [inArray(paymentAttempt.actionId, ids)];
  if (anchor.saleId) attemptConds.push(eq(paymentAttempt.saleId, anchor.saleId));
  const attempts = await db.select().from(paymentAttempt).where(and(eq(paymentAttempt.operatorId, op), or(...attemptConds)))
    .orderBy(asc(paymentAttempt.createdAt)).limit(20);
  for (const p of attempts) {
    raws.push({ stage: 'payment', at: p.createdAt, source: 'pos.payment_attempt', recordId: p.id, actionId: p.actionId,
      status: p.status === 'approved' ? 'recorded' : ['declined', 'cancelled', 'not_found'].includes(p.status) ? 'failed' : 'pending',
      latencyMs: p.paidAt ? p.paidAt.getTime() - p.createdAt.getTime() : null,
      detail: { method: p.method, provider: p.provider, status: p.status, amountSatang: num(p.amountSatang), offline: p.offline,
        inquiryActionId: inquiryActionId(p.payload) } });
  }
  const attemptIds = attempts.map(p => p.id);
  if (attemptIds.length) {
    const notes = await db.select({ id: paymentNotification.id, receivedAt: paymentNotification.receivedAt, respCode: paymentNotification.respCode,
      attemptId: paymentNotification.attemptId }).from(paymentNotification)
      .where(and(eq(paymentNotification.operatorId, op), inArray(paymentNotification.attemptId, attemptIds))).limit(20);
    for (const n of notes) {
      raws.push({ stage: 'payment', at: n.receivedAt, source: 'pos.payment_notification', recordId: n.id, status: 'recorded',
        detail: { respCode: n.respCode, attemptId: n.attemptId } });
    }
  }

  // Every run that names one of the actions, the batches that carried the events, and the gateway webhooks for the attempts.
  const runConds: SQL[] = [inArray(opsRun.actionId, ids)];
  if (batchIds.length) runConds.push(inArray(opsRun.id, batchIds));
  if (attemptIds.length) {
    runConds.push(and(eq(opsRun.kind, 'webhook'), sql`${opsRun.detail}->>'attemptId' in (${sql.join(attemptIds.map(a => sql`${a}`), sql`, `)})`)!);
  }
  const runs = await db.select().from(opsRun)
    .where(and(or(eq(opsRun.operatorId, op), sql`${opsRun.operatorId} is null`), or(...runConds)))
    .orderBy(asc(opsRun.startedAt)).limit(100);
  const runIds = new Set(runs.map(r => r.id));
  for (const r of runs) {
    const elapsed = num((r.detail as Record<string, unknown> | null)?.elapsedMs);
    raws.push({ stage: runStage(r.kind, r.name), at: r.startedAt, source: 'core.ops_run', recordId: r.id, opsRunId: r.id,
      requestId: r.requestId, actionId: r.actionId, status: r.outcome === 'failed' ? 'failed' : 'recorded',
      latencyMs: elapsed ?? r.durationMs ?? null, detail: { run: r.name, kind: r.kind, outcome: r.outcome, errorCode: r.errorCode,
        ...runDetail(r.detail) } });
  }

  // The rollup effect for the sale's (or the wallet's) business day.
  if (saleRow) {
    const day = String(saleRow.businessDate);
    const [pending] = await db.select().from(dirtyDate).where(and(eq(dirtyDate.operatorId, op), eq(dirtyDate.branchId, saleRow.branchId),
      eq(dirtyDate.businessDate, day), eq(dirtyDate.kind, 'sales'))).limit(1);
    if (pending) {
      raws.push({ stage: 'rollup', at: pending.markedAt, source: 'analytics.dirty_date', recordId: pending.id, status: 'pending',
        detail: { businessDate: day, reason: pending.reason, marks: num(pending.markCount), claimed: pending.claimedAt !== null },
        note: 'The day is marked for the next rollup and has not been recomputed yet.' });
    } else {
      const [summary] = await db.select({ id: dailySummary.id, computedAt: dailySummary.computedAt, provisional: dailySummary.provisional,
        source: dailySummary.source }).from(dailySummary)
        .where(and(eq(dailySummary.operatorId, op), eq(dailySummary.branchId, saleRow.branchId), eq(dailySummary.businessDate, day),
          gte(dailySummary.computedAt, saleRow.receivedAt ?? saleRow.createdAt))).orderBy(asc(dailySummary.computedAt)).limit(1);
      if (summary) {
        const [job] = await db.select().from(opsRun).where(and(eq(opsRun.name, 'job:rollup.daily'), eq(opsRun.outcome, 'ok'),
          gte(opsRun.finishedAt, summary.computedAt))).orderBy(asc(opsRun.finishedAt)).limit(1);
        raws.push({ stage: 'rollup', at: summary.computedAt, source: 'analytics.daily_summary', recordId: summary.id,
          opsRunId: job && !runIds.has(job.id) ? job.id : null, status: 'recorded', latencyMs: job?.durationMs ?? null,
          detail: { businessDate: day, source: summary.source, provisional: summary.provisional } });
      }
    }
  }

  return { generatedAt: (opts.now ?? new Date()).toISOString(), anchor: stripOperator(anchor), ...orderSteps(raws, anchor, opts.traceUrlTemplate) };
}

function stripOperator({ operatorId: _op, ...rest }: TraceAnchor) { return rest; }

/** The stages that apply to this anchor: a wallet has no till intent, an anchorless action no rollup. */
function stagesFor(anchor: TraceAnchor): TraceStage[] {
  if (anchor.walletId) return ['wallet_ledger', 'outbox', 'cloud_apply', 'audit', 'payment'];
  return TRACE_STAGES.filter(s => s !== 'wallet_ledger' && (s !== 'rollup' || anchor.saleId !== null));
}

export function orderSteps(raws: Raw[], anchor: TraceAnchor, template?: string): { steps: TraceStep[]; gaps: TraceStage[] } {
  const steps: TraceStep[] = [];
  const gaps: TraceStage[] = [];
  let previous: number | null = null;
  for (const stage of stagesFor(anchor)) {
    const here = raws.filter(r => r.stage === stage)
      .sort((a, b) => (a.at?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.at?.getTime() ?? Number.MAX_SAFE_INTEGER));
    if (here.length === 0) {
      gaps.push(stage);
      steps.push({ stage, label: STAGE_LABEL[stage], status: 'gap', at: null, source: null, recordId: null, opsRunId: null,
        requestId: null, actionId: null, latencyMs: null, sincePreviousMs: null, outOfOrder: false, detail: {}, traceUrl: null,
        note: GAP_NOTE[stage] });
      continue;
    }
    for (const r of here) {
      const at = r.at?.getTime() ?? null;
      steps.push({ stage, label: STAGE_LABEL[stage], status: r.status ?? 'recorded', at: iso(r.at), source: r.source,
        recordId: r.recordId, opsRunId: r.opsRunId ?? null, requestId: r.requestId ?? null, actionId: r.actionId ?? null,
        latencyMs: r.latencyMs ?? null, sincePreviousMs: at !== null && previous !== null ? at - previous : null,
        outOfOrder: at !== null && previous !== null && at < previous, detail: r.detail,
        traceUrl: template && r.requestId ? template.replace('{requestId}', encodeURIComponent(r.requestId)) : null,
        note: r.note ?? null });
      if (at !== null) previous = Math.max(previous ?? at, at);
    }
  }
  return { steps, gaps };
}
