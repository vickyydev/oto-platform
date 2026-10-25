import { z } from 'zod';
import type { Db } from '@oto/db';
import { errors } from '../lib/errors';
import { PermissionDeniedError, type AuthContext } from '../plugins/session';
import { branchReach, holdsAtOwnDepartment, reachCovers } from './access-control';
import { operatorBranches } from './analytics-summary';
import { openConsoleOtoApp } from './console-otoapp';
import type { HandoffConfig } from './handoff';
import type { EffectivePermission } from './permissions';
import type { OpContext } from './tx';

export type StaffMetric = {
  status: 'ready';
  count: number;
  asOf: string;
} | {
  status: 'forbidden' | 'unavailable';
  count: null;
  asOf: null;
};

export type StaffPayroll = {
  status: 'ready';
  month: string;
  entities: Array<{
    id: string;
    name: string;
    version: number | null;
    status: 'not-started' | 'draft' | 'gm-confirmed' | 'locked' | 'paid' | 'superseded';
  }>;
} | {
  status: 'forbidden' | 'unavailable';
  month: null;
  entities: [];
};

export interface StaffSummary {
  generatedAt: string;
  branches: Array<{ id: string; name: string; timezone: string }>;
  selectedBranchId: string | null;
  date: string | null;
  source: 'ready' | 'not-configured' | 'not-provisioned' | 'unavailable' | 'unmapped-branch';
  working: StaffMetric;
  attendance: StaffMetric;
  leave: StaffMetric;
  payroll: StaffPayroll;
}

interface StaffSummaryInput {
  auth: AuthContext;
  effective: EffectivePermission[];
  branchId?: string;
  ctx: OpContext;
  handoff?: HandoffConfig;
  token: string;
  requestId: string;
  timeoutMs: number;
  now?: Date;
  open?: typeof openConsoleOtoApp;
}

const count = z.number().int().nonnegative();
const User = z.object({ id: z.string().min(1), platformUserId: z.string().uuid(), tenantId: z.string().uuid() });
const Branches = z.array(z.object({
  id: z.string().uuid(), tenantId: z.string().uuid(), coreBranchId: z.string().nullable().optional(),
}));
const Working = z.object({ currentlyWorkingCount: count, timestamp: z.string().datetime() });
const Payroll = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  entities: z.array(z.object({
    id: z.string().uuid(), name: z.string().min(1), version: z.number().int().positive().nullable(),
    status: z.enum(['not-started', 'draft', 'gm-confirmed', 'locked', 'paid', 'superseded']),
  }).refine(row => (row.status === 'not-started') === (row.version === null))),
}).refine(value => new Set(value.entities.map(row => row.id)).size === value.entities.length);

const noMetric = (status: 'forbidden' | 'unavailable' = 'unavailable'): StaffMetric => ({ status, count: null, asOf: null });
const noPayroll = (status: 'forbidden' | 'unavailable' = 'unavailable'): StaffPayroll => ({ status, month: null, entities: [] });

function clearHeadlines(summary: StaffSummary, source: StaffSummary['source']): void {
  summary.source = source;
  summary.working = noMetric();
  summary.attendance = noMetric();
  summary.leave = noMetric();
  summary.payroll = noPayroll();
}

function calendarDate(now: Date, timezone: string): string {
  // Staff's calendar day, rather than the Till's trading-day cutoff.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * Four headlines over the OTO App's own APIs as the current user. Core only
 * supplies owned/reachable park metadata. No employee or payroll table is
 * queried here, and a card's app refusal is never converted to a zero.
 */
export async function staffSummaryOf(db: Db, input: StaffSummaryInput): Promise<StaffSummary> {
  const { auth, effective } = input;
  const now = input.now ?? new Date();
  const readAt = () => (input.now ?? new Date()).toISOString();
  const accountRead = branchReach(effective, 'admin:account:read', auth.operatorId);
  if (accountRead.kind === 'branches' && accountRead.branchIds.length === 0) {
    throw new PermissionDeniedError('admin:account:read');
  }
  const appRead = branchReach(effective, 'app:oto_app:access', auth.operatorId);
  const departmentAppAccess = await holdsAtOwnDepartment(db, effective, 'app:oto_app:access', auth.operatorId);
  if (!departmentAppAccess && appRead.kind === 'branches' && appRead.branchIds.length === 0) {
    throw new PermissionDeniedError('app:oto_app:access');
  }

  const owned = await operatorBranches(db, auth.operatorId);
  const reachable = owned.filter(park => park.archivedAt === null && reachCovers(accountRead, park.id) &&
    (departmentAppAccess || reachCovers(appRead, park.id)))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  let selected = reachable.find(park => park.id === auth.branchId) ?? reachable[0];
  if (input.branchId) {
    const id = input.branchId.toLowerCase();
    const requested = owned.find(park => park.id === id && park.archivedAt === null);
    if (!requested) throw errors.notFound('Branch not found');
    if (!reachCovers(accountRead, id)) throw new PermissionDeniedError('admin:account:read');
    if (!departmentAppAccess && !reachCovers(appRead, id)) throw new PermissionDeniedError('app:oto_app:access');
    selected = requested;
  }

  const summary: StaffSummary = {
    generatedAt: now.toISOString(), branches: reachable.map(({ id, name, timezone }) => ({ id, name, timezone })),
    selectedBranchId: selected?.id ?? null, date: selected ? calendarDate(now, selected.timezone) : null,
    source: 'ready', working: noMetric(), attendance: noMetric(), leave: noMetric(), payroll: noPayroll(),
  };
  if (!selected) return summary;
  const selectedId = selected.id;
  if (!input.handoff?.origins.has('oto_app')) {
    summary.source = 'not-configured';
    return summary;
  }

  let session: Awaited<ReturnType<typeof openConsoleOtoApp>>;
  try {
    session = await (input.open ?? openConsoleOtoApp)({
      db, ctx: input.ctx, handoff: input.handoff, auth, effective, token: input.token,
      requestId: input.requestId, timeoutMs: input.timeoutMs, branchId: selectedId,
    });
  } catch (error) {
    // Inspect only our transport's finite error code, never upstream text.
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
    summary.source = code === 'OTO_APP_NOT_PROVISIONED' ? 'not-provisioned'
      : code === 'OTO_APP_NOT_CONFIGURED' ? 'not-configured' : 'unavailable';
    return summary;
  }

  const read = async (path: string): Promise<{ status: number; body: unknown }> => {
    try { return await session.get(path); }
    catch { return { status: 0, body: null }; }
  };
  try {
    const [who, branchList] = await Promise.all([read('/api/user'), read('/api/branches')]);
    const user = User.safeParse(who.body);
    if (who.status !== 200 || !user.success || user.data.platformUserId !== auth.accountId || branchList.status !== 200) {
      clearHeadlines(summary, 'unavailable');
      return summary;
    }
    const sourceBranches = Branches.safeParse(branchList.body);
    const mappings = sourceBranches.success ? sourceBranches.data.filter(park => park.coreBranchId === selectedId) : [];
    if (mappings.length !== 1 || mappings[0]!.tenantId !== user.data.tenantId) {
      clearHeadlines(summary, 'unmapped-branch');
      return summary;
    }
    const appBranchId = mappings[0]!.id;
    const date = summary.date!;
    const [live, attendance, leave, payroll] = await Promise.all([
      read(`/api/timekeeping/live?branchId=${appBranchId}`),
      read(`/api/timekeeping/review?date=${date}&branchId=${appBranchId}`),
      read(`/api/time-off?branchId=${appBranchId}&dateFrom=${date}&dateTo=${date}`),
      read('/api/payroll/month-status'),
    ]);
    const workingData = Working.safeParse(live.body);
    if (live.status === 403) summary.working = noMetric('forbidden');
    else if (live.status === 200 && workingData.success) {
      summary.working = { status: 'ready', count: workingData.data.currentlyWorkingCount, asOf: workingData.data.timestamp };
    }
    const attendanceData = z.object({ date: z.literal(date), issuesCount: count }).safeParse(attendance.body);
    if (attendance.status === 403) summary.attendance = noMetric('forbidden');
    else if (attendance.status === 200 && attendanceData.success) {
      summary.attendance = { status: 'ready', count: attendanceData.data.issuesCount, asOf: readAt() };
    }
    const leaveData = z.array(z.object({
      id: z.string().min(1), tenantId: z.literal(user.data.tenantId), branchId: z.literal(appBranchId),
    })).safeParse(leave.body);
    if (leave.status === 403) summary.leave = noMetric('forbidden');
    else if (leave.status === 200 && leaveData.success) {
      summary.leave = { status: 'ready', count: leaveData.data.length, asOf: readAt() };
    }
    const payrollData = Payroll.safeParse(payroll.body);
    if (payroll.status === 403) summary.payroll = noPayroll('forbidden');
    else if (payroll.status === 200 && payrollData.success) {
      summary.payroll = { status: 'ready', ...payrollData.data };
    }
    return summary;
  } catch {
    clearHeadlines(summary, 'unavailable');
    return summary;
  } finally {
    let closed = false;
    try { closed = await session.close(); } catch { /* Unconfirmed cleanup withholds all headlines. */ }
    if (!closed) clearHeadlines(summary, 'unavailable');
  }
}
