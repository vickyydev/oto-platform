import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { newId } from '@oto/shared';

/**
 * A FAKE OTO APP for the internal assistant's round I4 (SCRUM-591; plan
 * docs/progress/plans/internal-assistant-build/PLAN.md §B.3, §F.2).
 *
 * A small HTTP server, in the test's own process, that behaves as the OTO App
 * does at the seams the assistant touches — and nowhere else:
 *
 *   POST /api/auth/handoff   the app's launcher sign-in: refuses a foreign
 *                            Origin, exchanges the token at the REAL platform
 *                            api under test (`/auth/handoff/exchange`, through
 *                            `platform.inject`, with its own Origin), maps the
 *                            platform account to its user (`not_provisioned`,
 *                            `disabled`), answers `connect.sid`.
 *   every /api request       the liveness middleware: `GET /me` at the platform
 *                            with the person's own token; a 401 ends the app
 *                            session before the route runs.
 *   POST /api/logout         ends the app session; recorded.
 *   the tool routes          the seven GET routes the registry names, with the
 *                            app's own fences and the app's own refusal
 *                            sentences (pinned against the app's source by
 *                            `assistant-otoapp.test.ts`).
 *
 * The fixture data is set by the test (`users`, `employees`, …) and read at
 * request time. Everything the server saw is kept for assertions: requests
 * (method, path, request id, whether a cookie came), the sessions it opened,
 * the logouts, the tokens it was handed. Nothing here imports Vitest, so the
 * live eval can build the same world.
 *
 * FICTIONAL DATA ONLY. Every person below is a "ZZ" fixture.
 */

export type FakeOtoAppRole = 'staff' | 'manager' | 'admin' | 'operator_admin' | 'global_admin';

export interface FakeOtoAppUser {
  id: string;
  platformAccountId: string;
  role: FakeOtoAppRole;
  isActive: boolean;
  tenantId: string;
  /** Empty with `hasAllBranchesAccess`, as the app answers. */
  allowedBranchIds: string[];
  hasAllBranchesAccess: boolean;
  /** The employee record linked to this user (`employees.user_id`). */
  employeeId: string | null;
}

export interface FakeOtoAppEmployee {
  id: string;
  tenantId: string;
  fullName: string;
  nickname: string;
  branchId: string;
  status: 'active' | 'terminated';
  userId: string | null;
  /** Pay: the app strips it for non-payroll roles; the assistant must never pass it on. */
  salaryThb: number;
}

export interface FakeOtoAppAttendanceDay {
  date: string;
  hours: number;
  sessions: number;
}

export interface FakeOtoAppAnomaly {
  type: string;
  date: string;
}

export interface FakeOtoAppShift {
  date: string;
  start: string;
  end: string;
  employeeId: string;
  department: string;
  branchId: string;
}

export interface FakeOtoAppTimeOff {
  id: string;
  tenantId: string;
  employeeId: string;
  branchId: string;
  type: string;
  startDate: string;
  endDate: string;
  isHalfDay: boolean;
  halfDayPeriod: 'AM' | 'PM' | null;
  note: string | null;
}

export interface FakeOtoAppPayslip {
  fileId: string;
  entityName: string;
  month: string;
  version: number;
  status: string;
  net: number;
  lockedAt: string;
}

export interface FakeOtoAppPayrollRun {
  snapshotId: string;
  entityId: string;
  entityName: string;
  month: string;
  version: number;
  status: string;
  lockedAt: string;
  lockedBy: string;
  gmActor: string;
  people: number;
  totals: { gross: number; deductions: number; net: number; employer: number; totalCost: number };
}

export interface FakeOtoAppSession {
  sid: string;
  userId: string;
  platformAccountId: string;
  /** The platform session token the exchange answered: the liveness probe's credential. */
  platformToken: string;
}

export interface FakeOtoAppRequest {
  method: string;
  path: string;
  requestId: string | null;
  origin: string | null;
  /** The `connect.sid` the request carried, if any. */
  sid: string | null;
  status: number;
}

/** The platform api under test, as the fake reaches it: Fastify's `inject`. */
export interface PlatformHandle {
  inject(opts: {
    method: 'GET' | 'POST';
    url: string;
    headers?: Record<string, string>;
    payload?: unknown;
  }): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }>;
}

export interface FakeOtoAppData {
  branches: Map<string, { id: string; name: string; tenantId: string }>;
  users: Map<string, FakeOtoAppUser>;
  employees: FakeOtoAppEmployee[];
  attendance: Map<string, { days: FakeOtoAppAttendanceDay[]; anomalies: FakeOtoAppAnomaly[] }>;
  shifts: FakeOtoAppShift[];
  timeOff: FakeOtoAppTimeOff[];
  payslips: Map<string, FakeOtoAppPayslip[]>;
  payrollHistory: FakeOtoAppPayrollRun[];
  /** Employee ids whose attendance route answers 500: "a tool throws". */
  broken: Set<string>;
}

// --- The app's own words (apps/oto-app/server; pinned by the suite) -------------------------------

export const OTOAPP_WORDS = {
  /** `middleware/platformSignOn.ts` */
  notProvisioned:
    'Your account may open the OTO App, but nobody has said which OTO App user you are. ' +
    'An administrator has to link your platform account to your user here — Login Users, ' +
    'Apps, then link OTO App with the id of your OTO App user — after which this will work.',
  disabled: 'Your OTO App user has been disabled. Contact your administrator.',
  crossOrigin: 'A launcher sign-in has to be completed by the OTO App itself.',
  passwordChange: 'Change your password on the launcher first, then open the OTO App tile again.',
  /** `lib/platformSession.ts` */
  refusalFallback:
    'The launcher could not open the OTO App for you. Open the tile again, and tell an administrator if it keeps happening.',
  refusals: {
    expired: 'That sign-in from the launcher took too long and expired. Open the OTO App tile again.',
    replayed: 'That launcher link had already been used. Open the OTO App tile again.',
    revoked: 'The session was signed out before this app opened. Sign in on the launcher again.',
    audience:
      'The launcher sent a sign-in meant for a different app. Open the tile again, and tell an administrator if it keeps happening.',
    origin:
      "The launcher sent a sign-in meant for a different address. Tell an administrator: this app's address and the one the platform was given do not match.",
    signature:
      'That sign-in was not issued by the platform. Open the OTO App tile again, and tell an administrator if it keeps happening.',
  } as Record<string, string>,
  /** `auth.ts` requireAuth */
  authRequired: 'Authentication required',
  accountDisabled: 'Your account has been disabled. Contact your administrator.',
  /** `auth-middleware.ts` requireRole (the `error` key) */
  insufficient: 'Insufficient permissions',
  /** `routes.ts` */
  employeeNotFound: 'Employee not found',
  employeeBranchDenied: 'Access denied to this employee',
  employeeTimeOffBranchDenied: "Access denied to this employee's branch",
  tenantRequired: 'Tenant access required',
  noEmployeeRecord: 'Employee record not found for current user',
  rotaRequired: 'branchId, from, and to are required',
  rotaBranchDenied: "You don't have access to this branch",
  parkGroupRequired: 'Park group context required',
  /** `payroll/routes.ts` */
  payrollRoles: 'Payroll is for payroll roles only (hr.view_salary required).',
} as const;

const MANAGER_ROLES: ReadonlySet<string> = new Set(['global_admin', 'operator_admin', 'admin', 'manager']);
const SALARY_ROLES: ReadonlySet<string> = new Set(['admin', 'global_admin', 'operator_admin']);
const ADMIN_ROLES: ReadonlySet<string> = new Set(['admin', 'global_admin', 'operator_admin']);

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cookieOf(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/** The platform's session token out of the exchange's Set-Cookie (what the app's `sessionTokenFromSetCookie` does). */
function platformTokenOf(setCookie: unknown): string | null {
  const list = Array.isArray(setCookie) ? setCookie : typeof setCookie === 'string' ? [setCookie] : [];
  for (const c of list) {
    const m = /(?:^|;\s*)oto_session=([^;]*)/.exec(String(c));
    if (m?.[1]) return decodeURIComponent(m[1]);
  }
  return null;
}

export class FakeOtoApp {
  readonly data: FakeOtoAppData = {
    branches: new Map(),
    users: new Map(),
    employees: [],
    attendance: new Map(),
    shifts: [],
    timeOff: [],
    payslips: new Map(),
    payrollHistory: [],
    broken: new Set(),
  };
  /** The platform api under test; set once the api is built (the fake starts first, for its port). */
  platform: PlatformHandle | null = null;
  readonly sessions = new Map<string, FakeOtoAppSession>();
  readonly logouts: Array<{ sid: string | null; requestId: string | null; hadSession: boolean }> = [];
  readonly requests: FakeOtoAppRequest[] = [];
  /** Every hand-off token the app was handed, and every sid it issued: the leak checks grep for them. */
  readonly tokensSeen: string[] = [];
  readonly sidsIssued: string[] = [];
  /** Liveness probes made, by platform token (counts only). */
  livenessProbes = 0;

  private constructor(
    private readonly server: Server,
    readonly origin: string,
  ) {}

  static async start(): Promise<FakeOtoApp> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const app = new FakeOtoApp(server, `http://127.0.0.1:${port}`);
    server.on('request', (req, res) => {
      void app.handle(req, res).catch((err: unknown) => {
        json(res, 500, { message: err instanceof Error ? err.message : 'fake OTO App failed' });
      });
    });
    return app;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  /** Forgets what was seen, keeps the fixture data and the live sessions. */
  resetObservations(): void {
    this.logouts.length = 0;
    this.requests.length = 0;
    this.tokensSeen.length = 0;
    this.sidsIssued.length = 0;
    this.livenessProbes = 0;
  }

  userByAccount(platformAccountId: string): FakeOtoAppUser | undefined {
    return this.data.users.get(platformAccountId);
  }

  private userById(id: string): FakeOtoAppUser | undefined {
    for (const u of this.data.users.values()) if (u.id === id) return u;
    return undefined;
  }

  private canAccessBranch(user: FakeOtoAppUser, branchId: string | null): boolean {
    if (user.hasAllBranchesAccess) return true;
    if (branchId === null) return false;
    return user.allowedBranchIds.includes(branchId);
  }

  private employeeInTenant(user: FakeOtoAppUser, id: string): FakeOtoAppEmployee | undefined {
    return this.data.employees.find((e) => e.id === id && e.tenantId === user.tenantId);
  }

  private ownEmployee(user: FakeOtoAppUser): FakeOtoAppEmployee | undefined {
    return this.data.employees.find((e) => e.tenantId === user.tenantId && e.userId === user.id);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin);
    const method = req.method ?? 'GET';
    const requestId = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : null;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    const sidRaw = cookieOf(req, 'connect.sid');
    const record = (status: number) => this.requests.push({ method, path: url.pathname, requestId, origin, sid: sidRaw, status });
    const end = res.end.bind(res);
    res.end = ((...args: unknown[]) => {
      record(res.statusCode);
      return (end as (...a: unknown[]) => ServerResponse)(...args);
    }) as typeof res.end;

    if (method === 'POST' && url.pathname === '/api/auth/handoff') return this.handoff(req, res, origin, requestId);

    // The liveness middleware, on every /api request that carries a session (platformSignOn.ts:466-494).
    let session = sidRaw ? (this.sessions.get(sidRaw) ?? null) : null;
    if (session && url.pathname.startsWith('/api')) {
      this.livenessProbes += 1;
      const alive = await this.alive(session.platformToken, requestId);
      if (!alive) {
        this.sessions.delete(session.sid);
        session = null;
      }
    }

    if (method === 'POST' && url.pathname === '/api/logout') {
      this.logouts.push({ sid: sidRaw, requestId, hadSession: session !== null });
      if (session) this.sessions.delete(session.sid);
      return json(res, 200, { ok: true, legacyLogin: false, launcherUrl: null });
    }

    if (method !== 'GET') return json(res, 404, { message: 'Not found' });

    // requireAuth (auth.ts:262-272)
    const user = session ? this.userById(session.userId) : undefined;
    if (!session || !user) return json(res, 401, { message: OTOAPP_WORDS.authRequired });
    if (!user.isActive) {
      this.sessions.delete(session.sid);
      return json(res, 401, { message: OTOAPP_WORDS.accountDisabled });
    }
    const requireManager = (): boolean => {
      if (!MANAGER_ROLES.has(user.role)) {
        json(res, 403, { error: OTOAPP_WORDS.insufficient });
        return false;
      }
      return true;
    };

    switch (true) {
      case url.pathname === '/api/user':
        return json(res, 200, {
          id: user.id,
          role: user.role,
          isActive: user.isActive,
          tenantId: user.tenantId,
          hasAllBranchesAccess: user.hasAllBranchesAccess,
          allowedBranchIds: user.allowedBranchIds,
          linkedEmployeeId: user.employeeId,
          mustChangePassword: false,
          phoneVerified: true,
        });

      case url.pathname === '/api/employees': {
        const branchId = url.searchParams.get('branchId');
        let rows = this.data.employees.filter((e) => e.tenantId === user.tenantId);
        if (!user.hasAllBranchesAccess) rows = rows.filter((e) => user.allowedBranchIds.includes(e.branchId));
        if (branchId) rows = rows.filter((e) => e.branchId === branchId);
        // hrPayResponse: pay stays only for payroll roles.
        return json(
          res,
          200,
          rows.map((e) => {
            const { salaryThb, ...rest } = e;
            return SALARY_ROLES.has(user.role) ? { ...rest, salaryThb } : rest;
          }),
        );
      }

      case /^\/api\/timekeeping\/employee\/[^/]+$/.test(url.pathname): {
        if (!requireManager()) return;
        const employeeId = decodeURIComponent(url.pathname.split('/')[4]!);
        if (this.data.broken.has(employeeId)) return json(res, 500, { message: 'fake OTO App: the deriver failed' });
        const employee = this.employeeInTenant(user, employeeId);
        if (!employee) return json(res, 404, { message: OTOAPP_WORDS.employeeNotFound });
        if (!this.canAccessBranch(user, employee.branchId)) return json(res, 403, { message: OTOAPP_WORDS.employeeBranchDenied });
        const start = url.searchParams.get('startDate') ?? '1970-01-01';
        const endParam = url.searchParams.get('endDate');
        const end = endParam ?? new Date().toISOString().slice(0, 10);
        const fixture = this.data.attendance.get(employeeId) ?? { days: [], anomalies: [] };
        const days = fixture.days.filter((d) => d.date >= start && d.date <= end).sort((a, b) => a.date.localeCompare(b.date));
        const anomalies = fixture.anomalies.filter((a) => a.date >= start && a.date <= end);
        const totalHours = Math.round(days.reduce((s, d) => s + d.hours, 0) * 100) / 100;
        const branch = this.data.branches.get(employee.branchId);
        return json(res, 200, {
          employee: {
            id: employee.id,
            fullName: employee.fullName,
            branchId: employee.branchId,
            branchName: branch?.name ?? null,
            hasFaceEnrolled: false,
          },
          dateRange: { start, end },
          sessions: days.map((d) => ({
            id: `s-${d.date}`,
            employeeId,
            inEvent: { id: `in-${d.date}`, eventTime: `${d.date}T02:00:00.000Z`, branchId: employee.branchId },
            outEvent: { id: `out-${d.date}`, eventTime: `${d.date}T11:00:00.000Z`, branchId: employee.branchId },
            durationMinutes: Math.round(d.hours * 60),
            date: d.date,
            inBranchName: branch?.name ?? 'Unknown',
            outBranchName: branch?.name ?? 'Unknown',
          })),
          rawEvents: [],
          dailyTotals: days.map((d) => ({
            date: d.date,
            totalMinutes: Math.round(d.hours * 60),
            totalHours: d.hours,
            sessionCount: d.sessions,
            hasLongShift: d.hours > 12,
          })),
          anomalies: anomalies.map((a, i) => ({
            id: `a-${i}`,
            employeeId,
            type: a.type,
            description: `fixture ${a.type}`,
            relatedEventIds: [],
            date: a.date,
            severity: 'medium',
          })),
          stats: {
            totalHours,
            totalSessions: days.reduce((s, d) => s + d.sessions, 0),
            totalAnomalies: anomalies.length,
            pinUsageCount: 0,
            faceUsageCount: days.length,
          },
        });
      }

      case url.pathname === '/api/my-time-off': {
        if (!user.tenantId) return json(res, 403, { message: OTOAPP_WORDS.tenantRequired });
        const mine = this.ownEmployee(user);
        if (!mine) return json(res, 404, { message: OTOAPP_WORDS.noEmployeeRecord });
        return json(res, 200, {
          timeOff: this.timeOffOf(mine.id, url.searchParams.get('dateFrom'), url.searchParams.get('dateTo')),
          weeklyOffDays: ['monday'],
          employeeId: mine.id,
        });
      }

      case /^\/api\/employees\/[^/]+\/time-off$/.test(url.pathname): {
        if (!requireManager()) return;
        const employeeId = decodeURIComponent(url.pathname.split('/')[3]!);
        const employee = this.employeeInTenant(user, employeeId);
        if (!employee) return json(res, 404, { message: OTOAPP_WORDS.employeeNotFound });
        if (!this.canAccessBranch(user, employee.branchId)) return json(res, 403, { message: OTOAPP_WORDS.employeeTimeOffBranchDenied });
        return json(res, 200, this.timeOffOf(employeeId, url.searchParams.get('dateFrom'), url.searchParams.get('dateTo')));
      }

      case url.pathname === '/api/rota': {
        if (!user.tenantId) return json(res, 403, { message: OTOAPP_WORDS.parkGroupRequired });
        const scope = url.searchParams.get('scope') ?? 'me';
        const branchId = url.searchParams.get('branchId');
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        if (!['me', 'department', 'branch'].includes(scope)) {
          return json(res, 400, { message: "Invalid scope. Must be 'me', 'department', or 'branch'" });
        }
        if (!branchId || !from || !to) return json(res, 400, { message: OTOAPP_WORDS.rotaRequired });
        const mine = this.ownEmployee(user);
        if (!ADMIN_ROLES.has(user.role) && !this.canAccessBranch(user, branchId) && mine?.branchId !== branchId) {
          return json(res, 403, { message: OTOAPP_WORDS.rotaBranchDenied });
        }
        const shifts = this.data.shifts
          .filter((s) => s.branchId === branchId && s.date >= from && s.date <= to)
          .filter((s) => scope !== 'me' || (mine !== undefined && s.employeeId === mine.id))
          .map((s) => {
            const e = this.data.employees.find((x) => x.id === s.employeeId);
            const b = this.data.branches.get(s.branchId);
            return {
              date: s.date,
              start: s.start,
              end: s.end,
              employeeName: e?.nickname ?? e?.fullName ?? 'Unknown',
              employeeId: s.employeeId,
              department: s.department,
              departmentId: 'd-1',
              roles: [],
              label: null,
              shiftRowId: 'r-1',
              assignmentId: `a-${s.employeeId}-${s.date}`,
              staffRequired: 1,
              staffRequiredByDay: null,
              isBorrowed: false,
              borrowedFromBranchId: null,
              branchId: s.branchId,
              branchName: b?.name ?? 'Unknown',
              breakStart: null,
              breakEnd: null,
              breakHasConflict: false,
              resolvedRoleName: 'Floor',
              roleSource: 'employee',
              shiftGroupName: null,
              shiftGroupId: null,
              colorIndex: null,
              dutyBlocks: [],
            };
          });
        return json(res, 200, shifts);
      }

      case url.pathname === '/api/payroll/history': {
        if (!SALARY_ROLES.has(user.role)) return json(res, 403, { message: OTOAPP_WORDS.payrollRoles });
        return json(res, 200, this.data.payrollHistory);
      }

      case url.pathname === '/api/payroll/me/payslips': {
        const mine = this.ownEmployee(user);
        if (!mine) return json(res, 200, { employee: null, payslips: [] });
        return json(res, 200, {
          employee: { id: mine.id, name: mine.nickname || mine.fullName },
          payslips: this.data.payslips.get(mine.id) ?? [],
        });
      }

      default:
        return json(res, 404, { message: 'Not found' });
    }
  }

  private timeOffOf(employeeId: string, from: string | null, to: string | null): FakeOtoAppTimeOff[] {
    return this.data.timeOff.filter(
      (t) =>
        t.employeeId === employeeId &&
        (!from || t.endDate.slice(0, 10) >= from) &&
        (!to || t.startDate.slice(0, 10) <= to),
    );
  }

  /** `platformSessionAlive`: GET /me with the person's own token; only a clear 401 ends the session. */
  private async alive(platformToken: string, requestId: string | null): Promise<boolean> {
    if (!this.platform) return true;
    const res = await this.platform.inject({
      method: 'GET',
      url: '/me',
      headers: { cookie: `oto_session=${platformToken}`, ...(requestId ? { 'x-request-id': requestId } : {}) },
    });
    return res.statusCode !== 401;
  }

  private async handoff(req: IncomingMessage, res: ServerResponse, origin: string | null, requestId: string | null): Promise<void> {
    // The app's own rule: a request with no Origin is a server and allowed; a foreign one is refused.
    if (origin && origin.replace(/\/$/, '').toLowerCase() !== this.origin) {
      return json(res, 403, { reason: 'cross_origin', message: OTOAPP_WORDS.crossOrigin });
    }
    let token = '';
    try {
      token = String((JSON.parse(await readBody(req)) as { token?: unknown }).token ?? '');
    } catch {
      token = '';
    }
    if (!token || token.length > 8192) return json(res, 400, { reason: 'no_token', message: OTOAPP_WORDS.refusalFallback });
    this.tokensSeen.push(token);
    if (!this.platform) return json(res, 503, { reason: 'unconfigured', message: 'fake OTO App: no platform to exchange at' });

    const exchanged = await this.platform.inject({
      method: 'POST',
      url: '/auth/handoff/exchange',
      headers: { origin: this.origin, 'content-type': 'application/json', ...(requestId ? { 'x-request-id': requestId } : {}) },
      payload: { token },
    });
    if (exchanged.statusCode !== 200) {
      let reason = 'unknown';
      try {
        const body = JSON.parse(exchanged.body) as { error?: { details?: { reason?: unknown } } };
        if (typeof body.error?.details?.reason === 'string') reason = body.error.details.reason;
      } catch {
        reason = 'unknown';
      }
      return json(res, 401, { reason, message: OTOAPP_WORDS.refusals[reason] ?? OTOAPP_WORDS.refusalFallback });
    }
    const body = JSON.parse(exchanged.body) as { accountId?: string; mustChangePassword?: boolean };
    if (!body.accountId) return json(res, 502, { reason: 'platform_unreadable', message: OTOAPP_WORDS.refusalFallback });
    if (body.mustChangePassword === true) {
      return json(res, 403, { reason: 'password_change_required', message: OTOAPP_WORDS.passwordChange });
    }
    const platformToken = platformTokenOf(exchanged.headers['set-cookie']);
    if (!platformToken) return json(res, 502, { reason: 'platform_unreadable', message: OTOAPP_WORDS.refusalFallback });

    const user = this.data.users.get(body.accountId);
    if (!user) return json(res, 403, { reason: 'not_provisioned', message: OTOAPP_WORDS.notProvisioned });
    if (!user.isActive) return json(res, 403, { reason: 'disabled', message: OTOAPP_WORDS.disabled });

    // connect.sid's shape: `s:<id>.<signature>`, URL-encoded on the wire.
    const sid = `s%3A${randomBytes(12).toString('base64url')}.${randomBytes(16).toString('base64url')}`;
    this.sessions.set(sid, { sid, userId: user.id, platformAccountId: body.accountId, platformToken });
    this.sidsIssued.push(sid);
    return json(res, 200, { ok: true }, { 'set-cookie': `connect.sid=${sid}; Path=/; HttpOnly; SameSite=Lax` });
  }
}

/** The handful of fictional fixtures a suite lays on the fake: a park group with two branches. */
export interface FakeOtoAppWorld {
  tenantId: string;
  central: string;
  chalong: string;
}

export function seedFakeOtoAppWorld(fake: FakeOtoApp): FakeOtoAppWorld {
  const tenantId = newId();
  const central = newId();
  const chalong = newId();
  fake.data.branches.set(central, { id: central, name: 'ZZ Central', tenantId });
  fake.data.branches.set(chalong, { id: chalong, name: 'ZZ Chalong', tenantId });
  return { tenantId, central, chalong };
}

/** An employee of the park group at one branch. */
export function fakeEmployee(
  fake: FakeOtoApp,
  world: FakeOtoAppWorld,
  opts: { fullName: string; nickname: string; branchId: string; userId?: string | null; salaryThb?: number },
): FakeOtoAppEmployee {
  const e: FakeOtoAppEmployee = {
    id: newId(),
    tenantId: world.tenantId,
    fullName: opts.fullName,
    nickname: opts.nickname,
    branchId: opts.branchId,
    status: 'active',
    userId: opts.userId ?? null,
    salaryThb: opts.salaryThb ?? 31000,
  };
  fake.data.employees.push(e);
  return e;
}

/** An OTO App user mapped to a platform account, at one branch (or every branch). */
export function fakeUser(
  fake: FakeOtoApp,
  world: FakeOtoAppWorld,
  opts: { platformAccountId: string; role: FakeOtoAppRole; branchId?: string | null; isActive?: boolean; employeeId?: string | null },
): FakeOtoAppUser {
  const all = opts.branchId === null || opts.branchId === undefined;
  const u: FakeOtoAppUser = {
    id: newId(),
    platformAccountId: opts.platformAccountId,
    role: opts.role,
    isActive: opts.isActive ?? true,
    tenantId: world.tenantId,
    allowedBranchIds: all ? [] : [opts.branchId!],
    hasAllBranchesAccess: all,
    employeeId: opts.employeeId ?? null,
  };
  fake.data.users.set(opts.platformAccountId, u);
  if (u.employeeId) {
    const e = fake.data.employees.find((x) => x.id === u.employeeId);
    if (e) e.userId = u.id;
  }
  return u;
}

/** `YYYY-MM-DD` of a date in UTC, shifted by `days`. */
export function isoDay(base: Date, days = 0): string {
  const d = new Date(base.getTime() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * Attendance for an employee: every weekday from the 1st of `now`'s month to
 * `now`, 8.5 hours in one session, one LATE_ARRIVAL on the second working day.
 */
export function fakeAttendanceThisMonth(fake: FakeOtoApp, employeeId: string, now: Date): { days: number; hours: number } {
  const today = isoDay(now);
  const first = `${today.slice(0, 7)}-01`;
  const days: FakeOtoAppAttendanceDay[] = [];
  for (let d = new Date(`${first}T00:00:00Z`); isoDay(d) <= today; d = new Date(d.getTime() + 86_400_000)) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    days.push({ date: isoDay(d), hours: 8.5, sessions: 1 });
  }
  const anomalies: FakeOtoAppAnomaly[] = days[1] ? [{ type: 'LATE_ARRIVAL', date: days[1].date }] : [];
  fake.data.attendance.set(employeeId, { days, anomalies });
  return { days: days.length, hours: Math.round(days.length * 8.5 * 100) / 100 };
}

/** Shifts 10:00–19:00 at one branch for these employees, every day from `from` to `to` inclusive. */
export function fakeShifts(fake: FakeOtoApp, branchId: string, employeeIds: readonly string[], from: Date, to: Date): void {
  for (let d = new Date(from); isoDay(d) <= isoDay(to); d = new Date(d.getTime() + 86_400_000)) {
    for (const employeeId of employeeIds) {
      fake.data.shifts.push({ date: isoDay(d), start: '10:00', end: '19:00', employeeId, department: 'Floor', branchId });
    }
  }
}
