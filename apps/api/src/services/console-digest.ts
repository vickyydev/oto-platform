import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { branch, operator, opsRun, type Db } from '@oto/db';
import { businessDate, newId, parseDayStart, wallClockMinutesInTz } from '@oto/shared';
import { operatorBranches, type SummaryBranch } from './analytics-summary';
import { JobFailedError } from './job-failure';
import { recordRun } from './ops';

export type DigestCode = 'snapshot' | 'intent-write' | 'transport-timeout' | 'transport-response' | 'receipt-write';
export type DigestSendResult =
  | { state: 'accepted'; status: number }
  | { state: 'not-dispatched'; code: DigestCode }
  | { state: 'uncertain'; code: DigestCode; status?: number };
export type DigestSender = (text: string) => Promise<DigestSendResult>;
export interface DigestScope {
  operatorId: string;
  available: readonly SummaryBranch[];
  selected: readonly SummaryBranch[];
  includeOperatorWide: false;
  now: Date;
}
export interface DigestGroup {
  operatorId: string;
  branchId: string;
  date: string;
  state: 'accepted' | 'already-accepted' | 'not-dispatched' | 'uncertain' | 'failed';
  intentId?: string;
  summaryHash?: string;
  code?: DigestCode;
}
export interface DigestDetail {
  mode: 'disabled' | 'not-configured' | 'completed';
  groups: DigestGroup[];
}
export interface DigestOptions {
  now: Date;
  enabled: boolean;
  sender?: DigestSender;
  snapshot: (db: Db, scope: DigestScope) => Promise<{ statusSummary: string }>;
}

const INTENT = 'console.digest.intent';
const DELIVERY = 'console.digest.delivery';
const codes = new Set<DigestCode>(['snapshot', 'intent-write', 'transport-timeout', 'transport-response', 'receipt-write']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;

function failed(detail: DigestDetail): JobFailedError {
  return new JobFailedError('CONSOLE_DIGEST_FAILED', 'The morning digest was not confirmed for every due branch', { ...detail });
}

/**
 * Existing exclusive job runner is the sole production caller. Its run lock
 * spans these append-only branch receipts and the overall job result. A local
 * intent is not a delivery: an unresolved intent blocks blind resending.
 */
export async function runConsoleDigest(db: Db, options: DigestOptions): Promise<DigestDetail> {
  if (options.enabled !== true) return { mode: 'disabled', groups: [] };
  if (!options.sender) return { mode: 'not-configured', groups: [] };
  const detail: DigestDetail = { mode: 'completed', groups: [] };
  let operators: { id: string }[];
  try {
    operators = await db.select({ id: operator.id }).from(operator)
      .where(isNull(operator.archivedAt)).orderBy(asc(operator.id));
  } catch {
    throw failed(detail);
  }

  for (const owner of operators) {
    let available: SummaryBranch[];
    try { available = (await operatorBranches(db, owner.id)).filter(b => b.archivedAt === null); }
    catch { throw failed(detail); }
    for (const selected of available) {
      let date: string;
      try {
        const start = parseDayStart(selected.businessDayStart);
        // Before today's local boundary the native date still names yesterday;
        // that is not a reason to send yesterday's missed morning.
        if (wallClockMinutesInTz(options.now, selected.timezone) < start) continue;
        date = businessDate(options.now, selected.timezone, start);
      } catch {
        // Invalid source clock metadata is unavailable, never a fabricated date.
        throw failed(detail);
      }
      const group: DigestGroup = { operatorId: owner.id, branchId: selected.id, date, state: 'failed' };
      detail.groups.push(group);
      let history: Awaited<ReturnType<typeof branchReceipts>>;
      try { history = await branchReceipts(db, group); }
      catch { group.code = 'receipt-write'; continue; }
      if (history.unresolved) { group.state = 'uncertain'; continue; }
      if (history.accepted) { group.state = 'already-accepted'; continue; }

      let text: string;
      try {
        const snapshot = await options.snapshot(db, {
          operatorId: owner.id, available, selected: [selected], includeOperatorWide: false, now: options.now,
        });
        if (typeof snapshot.statusSummary !== 'string' || snapshot.statusSummary.length === 0) throw new Error('Invalid summary');
        text = snapshot.statusSummary;
        // The shared builder refreshes its own source descriptors. Do not send
        // its new-clock summary under the earlier eligibility/date key, or send
        // after the branch or parent ceased to be live. Refuse before intent.
        const [current] = await db.select({ timezone: branch.timezone, businessDayStart: branch.businessDayStart })
          .from(branch).innerJoin(operator, and(eq(operator.id, branch.operatorId), isNull(operator.archivedAt)))
          .where(and(eq(branch.id, selected.id), eq(branch.operatorId, owner.id), isNull(branch.archivedAt))).limit(1);
        if (!current || current.timezone !== selected.timezone || current.businessDayStart !== selected.businessDayStart) {
          throw new Error('Digest scope changed');
        }
        const currentStart = parseDayStart(current.businessDayStart);
        if (wallClockMinutesInTz(options.now, current.timezone) < currentStart
          || businessDate(options.now, current.timezone, currentStart) !== date) throw new Error('Digest clock changed');
      } catch { group.code = 'snapshot'; continue; }
      group.intentId = newId();
      group.summaryHash = createHash('sha256').update(text).digest('hex');
      const identity = {
        version: 1, operatorId: group.operatorId, branchId: group.branchId, date,
        intentId: group.intentId, summaryHash: group.summaryHash,
      };
      try {
        // This completed operation means only that the local intent persisted.
        // A failed record must never be followed by a new outbound call.
        await recordRun(db, { kind: 'console', name: INTENT, outcome: 'ok',
          operatorId: group.operatorId, branchId: group.branchId, startedAt: options.now, detail: identity });
      } catch { group.code = 'intent-write'; continue; }

      let delivery: DigestSendResult;
      try { delivery = safeDelivery(await options.sender(text)); }
      catch { delivery = { state: 'uncertain', code: 'transport-response' }; }
      group.state = delivery.state;
      if ('code' in delivery) group.code = delivery.code;
      try {
        await recordRun(db, { kind: 'console', name: DELIVERY,
          outcome: delivery.state === 'accepted' ? 'ok' : 'failed',
          operatorId: group.operatorId, branchId: group.branchId, startedAt: options.now,
          detail: { ...identity, ...delivery } });
      } catch {
        // Even an observed acknowledgement cannot become a durable success when
        // its receipt failed. The earlier intent remains visibly unresolved.
        group.state = 'uncertain'; group.code = 'receipt-write';
      }
    }
  }
  if (detail.groups.some(g => g.state !== 'accepted' && g.state !== 'already-accepted')) throw failed(detail);
  return detail;
}

function safeDelivery(value: DigestSendResult): DigestSendResult {
  if (value?.state === 'accepted' && Number.isInteger(value.status) && value.status >= 200 && value.status < 300) return { state: 'accepted', status: value.status };
  if (value?.state === 'not-dispatched' && codes.has(value.code)) return { state: 'not-dispatched', code: value.code };
  if (value?.state === 'uncertain' && codes.has(value.code)) {
    const status = Number.isInteger(value.status) && value.status! >= 100 && value.status! <= 599 ? value.status : undefined;
    return { state: 'uncertain', code: value.code, ...(status === undefined ? {} : { status }) };
  }
  return { state: 'uncertain', code: 'transport-response' };
}

async function branchReceipts(db: Db, group: DigestGroup): Promise<{ accepted: boolean; unresolved: boolean }> {
  const rows = await db.select({ name: opsRun.name, outcome: opsRun.outcome, detail: opsRun.detail })
    .from(opsRun).where(and(eq(opsRun.kind, 'console'), inArray(opsRun.name, [INTENT, DELIVERY]),
      eq(opsRun.operatorId, group.operatorId), eq(opsRun.branchId, group.branchId)));
  const intents = new Map<string, string>();
  const terminal = new Map<string, 'accepted' | 'not-dispatched'>();
  let malformed = false;
  for (const row of rows) {
    const value = row.detail as Record<string, unknown> | null;
    if (!value || value.date !== group.date) continue;
    if (value.version !== 1 || value.operatorId !== group.operatorId || value.branchId !== group.branchId
      || typeof value.intentId !== 'string' || !uuid.test(value.intentId)
      || typeof value.summaryHash !== 'string' || !hash.test(value.summaryHash)) {
      malformed = true; continue;
    }
    if (row.name === INTENT && row.outcome === 'ok') intents.set(value.intentId, value.summaryHash);
  }
  for (const row of rows) {
    const value = row.detail as Record<string, unknown> | null;
    if (row.name !== DELIVERY || !value || value.version !== 1 || value.date !== group.date
      || value.operatorId !== group.operatorId || value.branchId !== group.branchId
      || typeof value.intentId !== 'string' || intents.get(value.intentId) !== value.summaryHash) continue;
    if (value.state === 'accepted' && row.outcome === 'ok' && Number.isInteger(value.status)
      && Number(value.status) >= 200 && Number(value.status) < 300) terminal.set(value.intentId, 'accepted');
    else if (value.state === 'not-dispatched' && row.outcome === 'failed' && codes.has(value.code as DigestCode)
      && terminal.get(value.intentId) !== 'accepted') terminal.set(value.intentId, 'not-dispatched');
  }
  return { accepted: [...terminal.values()].includes('accepted'),
    unresolved: malformed || [...intents.keys()].some(id => !terminal.has(id)) };
}

/** Private adapter seam; tests always inject fetch and never contact a webhook. */
export function createConsoleDigestSender(
  destination: string | undefined,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): DigestSender | undefined {
  if (!destination) return undefined;
  try {
    const url = new URL(destination);
    if (url.protocol !== 'https:' || url.username || url.password || url.href.includes('#')) return undefined;
  } catch { return undefined; }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  const fetcher = options.fetch ?? fetch;
  return async text => {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<DigestSendResult>(resolve => {
      timer = setTimeout(() => {
        timedOut = true; controller.abort(); resolve({ state: 'uncertain', code: 'transport-timeout' });
      }, timeoutMs);
    });
    const attempt = async (): Promise<DigestSendResult> => {
      try {
        const response = await fetcher(destination, { method: 'POST', redirect: 'error',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: controller.signal });
        // No response content is needed or logged. Disposal shares the same
        // overall timeout, including a body cancellation that itself stalls.
        if (response.body) await response.body.cancel();
        if (timedOut) return { state: 'uncertain', code: 'transport-timeout' };
        const status = response.status;
        if (!response.redirected && Number.isInteger(status) && status >= 200 && status < 300) return { state: 'accepted', status };
        return safeDelivery({ state: 'uncertain', code: 'transport-response', status });
      } catch {
        return { state: 'uncertain', code: timedOut ? 'transport-timeout' : 'transport-response' };
      }
    };
    try { return await Promise.race([attempt(), timeout]); }
    finally { clearTimeout(timer); }
  };
}
