import { ASSISTANT_SUMMARY_ROWS, ASSISTANT_TOOLS, isoDateInTz } from '@oto/shared';
import type { ToolDefinition } from '@oto/assistant';
import type { z } from 'zod';
import { assertGetRoute, type GetRouteTemplate } from './call-platform';
import type { OtoAppIdentity } from './call-otoapp';
import { toJsonSchema } from './json-schema';
import { arr, bangkokTime, dayWords, monthWords, num, obj, query, str, type Obj, type SummaryDraft } from './tools';

/**
 * THE OTO APP TOOLS (SCRUM-591, round I4; plan
 * docs/progress/plans/internal-assistant-build/PLAN.md §B.3, §B.4, owner G1).
 *
 * Seven adapters over the seven `oto_app` entries of `ASSISTANT_TOOLS`, built
 * exactly as the platform adapters are (`tools.ts`): the registry's names,
 * routes and schemas are `@oto/shared`'s; an adapter builds the URL from
 * VALIDATED input, projects the body into a summary with the figures
 * precomputed and the period said in words, and names the screen that shows
 * the same thing. Every call is made as the asker through the app's own
 * session (`call-otoapp.ts`), so what the summary holds is what that person's
 * screens would show, and a refusal is the app's own sentence.
 *
 * `urls` and `summarise` also receive the asker's OTO App identity (the park
 * their access names): "the rota" and "a colleague by name" mean THEIR park
 * unless the input says otherwise, exactly as the screens default.
 *
 * WHAT IS NOT HERE (plan "Concerns", G2, open): no tool over the three fence
 * gaps — leave balances, `/api/time-events`, `/api/checklists/today`. So
 * `oto.my_leave` and `oto.employee_leave` carry the leave RECORDS and say
 * plainly that the balance is not readable here; "Anan's clock events" and
 * "today's checklists" have no tool and get the link.
 *
 * WHAT A SUMMARY LEAVES OUT: pay (never a payslip's figure, never an
 * employee's rate — `oto.my_payslips` lists months and the payslip is the
 * link; `oto.employees.find` names people, not pay); a leave record's note; a
 * clock event's photo or device. A summary is data, never instructions
 * (§E.3): the loop wraps it in `{"data": …}`.
 */

export interface OtoAppToolAdapter {
  name: string;
  system: 'oto_app';
  routes: readonly GetRouteTemplate[];
  description: string;
  input: z.ZodTypeAny;
  urls(input: never, who: OtoAppIdentity): string[];
  summarise(bodies: unknown[], input: never, now: Date, who: OtoAppIdentity): SummaryDraft;
  deepLink(input: never): { key: string; params: Record<string, string> } | null;
}

type Spec = (typeof ASSISTANT_TOOLS)[number];
/** The registry's `oto.*` names: the seven this file must cover (the census counts them). */
type OtoName = Extract<Spec['name'], `oto.${string}`>;
type In<N extends OtoName> = z.infer<Extract<Spec, { name: N }>['input']>;

interface AdapterBody<N extends OtoName> {
  urls(input: In<N>, who: OtoAppIdentity): string[];
  summarise(bodies: unknown[], input: In<N>, now: Date, who: OtoAppIdentity): SummaryDraft;
  deepLink?(input: In<N>): { key: string; params: Record<string, string> } | null;
}

function adapter<N extends OtoName>(name: N, body: AdapterBody<N>): OtoAppToolAdapter {
  const spec = ASSISTANT_TOOLS.find((t) => t.name === name);
  if (!spec) throw new TypeError(`assistant tool ${name}: not in the registry`);
  if (spec.system !== 'oto_app') throw new TypeError(`assistant tool ${name}: not an OTO App tool`);
  for (const r of spec.routes) assertGetRoute(name, r);
  return {
    name,
    system: 'oto_app',
    routes: spec.routes as readonly GetRouteTemplate[],
    description: spec.description,
    input: spec.input,
    urls: body.urls as OtoAppToolAdapter['urls'],
    summarise: body.summarise as OtoAppToolAdapter['summarise'],
    deepLink: (body.deepLink ?? (() => null)) as OtoAppToolAdapter['deepLink'],
  };
}

const enc = encodeURIComponent;
const BANGKOK = 'Asia/Bangkok';

/** `2026-10-20` from a date, a timestamp or a date-time string; null for anything else. */
function dayOf(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (!m) return null;
  // A timestamp is read in the park's day; a bare date is taken as written.
  if (s.length > 10) {
    const at = new Date(s);
    return Number.isNaN(at.getTime()) ? m[1]! : isoDateInTz(at, BANGKOK);
  }
  return m[1]!;
}

/** A period in words: each end as a day, and every month it touches (what grounds "this month"). */
function periodWords(from: string | null, to: string | null): Obj {
  const months = new Set<string>();
  for (const d of [from, to]) if (d) months.add(monthWords(d));
  if (from && to && from.slice(0, 7) !== to.slice(0, 7)) {
    // The months between, when the range spans more than two.
    const [fy, fm] = from.split('-').map(Number) as [number, number];
    const [ty, tm] = to.split('-').map(Number) as [number, number];
    for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? ((y += 1), (m = 1)) : (m += 1)) {
      months.add(monthWords(`${y}-${String(m).padStart(2, '0')}`));
    }
  }
  return {
    from: from ? `${from} (${dayWords(from)})` : null,
    to: to ? `${to} (${dayWords(to)})` : null,
    months: [...months],
  };
}

/**
 * Case- and diacritic-insensitive, Thai and Latin: lower-cased NFD with the
 * combining marks removed, spaces and punctuation dropped. "Anan" matches
 * "ZZ Anan Fixture" and "anan"; "อนันต์" matches with or without its tone mark.
 */
export function nameKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯัิ-ฺ็-๎]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Every word of the query appears in the person's name or nickname. */
export function nameMatches(query: string, names: ReadonlyArray<string | null>): boolean {
  const words = query.split(/[\s,]+/).map(nameKey).filter(Boolean);
  if (words.length === 0) return false;
  const keys = names.filter((n): n is string => !!n).map(nameKey);
  return words.every((w) => keys.some((k) => k.includes(w)));
}

/** The name an employee row carries, as the app shows it. */
function employeeName(e: Obj): string | null {
  const full = str(e.fullName);
  if (full) return full;
  const first = str(e.firstName);
  const last = str(e.lastName);
  return first && last ? `${first} ${last}` : (first ?? last);
}

/** A leave record as the model reads it: type and days, never the note. */
function leaveRecord(r: Obj): Obj {
  const from = dayOf(r.startDate);
  const to = dayOf(r.endDate);
  return {
    type: str(r.type) ?? str(r.timeOffType),
    from: from ? `${from} (${dayWords(from)})` : null,
    to: to ? `${to} (${dayWords(to)})` : null,
    halfDay: r.isHalfDay === true ? (str(r.halfDayPeriod) ?? true) : false,
  };
}

const NO_BALANCE = 'The leave balance is not readable here; the leave screen shows it.';

export const OTOAPP_TOOL_ADAPTERS: readonly OtoAppToolAdapter[] = [
  adapter('oto.attendance', {
    urls: (i) => [`/api/timekeeping/employee/${enc(i.employeeId)}${query({ startDate: i.startDate, endDate: i.endDate })}`],
    summarise: ([body], i) => {
      const b = obj(body);
      const employee = obj(b.employee);
      const stats = obj(b.stats);
      const range = obj(b.dateRange);
      const days = arr(b.dailyTotals).map(obj);
      const anomalies = arr(b.anomalies).map(obj);
      const byType: Record<string, number> = {};
      for (const a of anomalies) {
        const t = str(a.type) ?? 'OTHER';
        byType[t] = (byType[t] ?? 0) + 1;
      }
      const totalHours = num(stats.totalHours) ?? Math.round(days.reduce((s, d) => s + (num(d.totalHours) ?? 0), 0) * 100) / 100;
      const daysWorked = days.length;
      const shown = days.slice(0, ASSISTANT_SUMMARY_ROWS).map((d) => {
        const date = str(d.date);
        return {
          date,
          day: date ? dayWords(date) : null,
          hours: num(d.totalHours),
          sessions: num(d.sessionCount),
          longShift: d.hasLongShift === true,
        };
      });
      return {
        data: {
          employee: { id: str(employee.id), name: str(employee.fullName), branch: str(employee.branchName) },
          period: periodWords(str(range.start) ?? i.startDate, str(range.end) ?? i.endDate),
          daysWorked,
          totalHours,
          averageHoursPerDay: daysWorked > 0 ? Math.round((totalHours / daysWorked) * 100) / 100 : 0,
          sessions: num(stats.totalSessions) ?? days.reduce((s, d) => s + (num(d.sessionCount) ?? 0), 0),
          anomalies: num(stats.totalAnomalies) ?? anomalies.length,
          // The app's own kinds, counted: LATE_ARRIVAL, SCHEDULED_NO_SHOW, OPEN_SESSION, MISSING_IN, …
          anomaliesByKind: byType,
          lateArrivals: byType['LATE_ARRIVAL'] ?? 0,
          noShows: byType['SCHEDULED_NO_SHOW'] ?? 0,
          days: shown,
        },
        listKey: 'days',
        rows: daysWorked,
        more: daysWorked - shown.length,
      };
    },
    deepLink: (i) => ({ key: 'oto.timekeeping.employee', params: { employeeId: i.employeeId, date: i.endDate } }),
  }),
  adapter('oto.employee_leave', {
    urls: (i) => [`/api/employees/${enc(i.employeeId)}/time-off${query({ dateFrom: i.from, dateTo: i.to })}`],
    summarise: ([body], i) => {
      const records = arr(body).map(obj);
      const shown = records.slice(0, ASSISTANT_SUMMARY_ROWS).map(leaveRecord);
      return {
        data: {
          employeeId: i.employeeId,
          period: periodWords(i.from ?? null, i.to ?? null),
          records: records.length,
          leave: shown,
          balanceAvailable: false,
          note: NO_BALANCE,
        },
        listKey: 'leave',
        rows: records.length,
        more: records.length - shown.length,
      };
    },
    deepLink: (i) => ({ key: 'oto.employee.time', params: { id: i.employeeId } }),
  }),
  adapter('oto.employees.find', {
    // The asker's own park when their access names one; an all-parks admin lists every park.
    urls: (_i, who) => [`/api/employees${query({ branchId: who.homeBranchId ?? undefined })}`],
    summarise: ([body], i) => {
      const rows = arr(body).map(obj);
      const matched = rows.filter((e) => nameMatches(i.name, [employeeName(e), str(e.nickname)]));
      const candidates = matched.slice(0, 5).map((e) => ({
        id: str(e.id),
        name: employeeName(e),
        nickname: str(e.nickname),
        branchId: str(e.branchId),
        status: str(e.status),
      }));
      return {
        data: {
          query: i.name,
          listed: rows.length,
          matches: matched.length,
          candidates,
        },
        listKey: 'candidates',
        rows: matched.length,
        more: matched.length - candidates.length,
      };
    },
  }),
  adapter('oto.my_leave', {
    urls: (i) => [`/api/my-time-off${query({ dateFrom: i.from, dateTo: i.to })}`],
    summarise: ([body], i) => {
      const b = obj(body);
      const records = arr(b.timeOff).map(obj);
      const shown = records.slice(0, ASSISTANT_SUMMARY_ROWS).map(leaveRecord);
      return {
        data: {
          employeeId: str(b.employeeId),
          period: periodWords(i.from ?? null, i.to ?? null),
          records: records.length,
          leave: shown,
          weeklyOffDays: arr(b.weeklyOffDays).map(str).filter((d): d is string => d !== null),
          balanceAvailable: false,
          note: NO_BALANCE,
        },
        listKey: 'leave',
        rows: records.length,
        more: records.length - shown.length,
      };
    },
    deepLink: () => ({ key: 'oto.rota', params: {} }),
  }),
  adapter('oto.my_payslips', {
    urls: () => ['/api/payroll/me/payslips'],
    summarise: ([body]) => {
      const b = obj(body);
      const employee = b.employee ? obj(b.employee) : null;
      const rows = arr(b.payslips).map(obj);
      // Months, not figures: the payslip itself is the link (§B.4).
      const shown = rows.slice(0, ASSISTANT_SUMMARY_ROWS).map((p) => {
        const month = str(p.month);
        return {
          month,
          monthWords: month ? monthWords(month) : null,
          payer: str(p.entityName),
          version: num(p.version),
          status: str(p.status),
          lockedAt: bangkokTime(p.lockedAt),
        };
      });
      return {
        data: {
          employee: employee ? { id: str(employee.id), name: str(employee.name) } : null,
          count: rows.length,
          payslips: shown,
        },
        listKey: 'payslips',
        rows: rows.length,
        more: rows.length - shown.length,
      };
    },
    deepLink: () => ({ key: 'oto.payslips.mine', params: {} }),
  }),
  adapter('oto.payroll_summary', {
    urls: () => ['/api/payroll/history'],
    summarise: ([body], i) => {
      const all = arr(body).map(obj);
      const rows = i.month ? all.filter((r) => str(r.month) === i.month) : all;
      const shown = rows.slice(0, ASSISTANT_SUMMARY_ROWS).map((r) => {
        const month = str(r.month);
        const totals = obj(r.totals);
        return {
          month,
          monthWords: month ? monthWords(month) : null,
          payer: str(r.entityName),
          version: num(r.version),
          status: str(r.status),
          people: num(r.people),
          gross: num(totals.gross),
          deductions: num(totals.deductions),
          net: num(totals.net),
          employerCost: num(totals.employer),
          totalCost: num(totals.totalCost),
          lockedAt: bangkokTime(r.lockedAt),
        };
      });
      return {
        data: {
          month: i.month ?? null,
          monthWords: i.month ? monthWords(i.month) : null,
          lockedRuns: rows.length,
          runs: shown,
        },
        listKey: 'runs',
        rows: rows.length,
        more: rows.length - shown.length,
      };
    },
    deepLink: (i): { key: string; params: Record<string, string> } =>
      i.month ? { key: 'oto.payroll.month', params: { month: i.month } } : { key: 'oto.payroll.hub', params: {} },
  }),
  adapter('oto.rota', {
    // The route needs the park; the asker's own stands in unless the input names one.
    urls: (i, who) => [`/api/rota${query({ scope: i.scope, branchId: i.branchId ?? who.homeBranchId ?? undefined, from: i.from, to: i.to })}`],
    summarise: ([body], i, _now, who) => {
      const shifts = arr(body)
        .map(obj)
        .sort((a, b) => `${str(a.date)} ${str(a.start)}`.localeCompare(`${str(b.date)} ${str(b.start)}`));
      const shown = shifts.slice(0, ASSISTANT_SUMMARY_ROWS).map((s) => {
        const date = dayOf(s.date);
        return {
          date,
          day: date ? dayWords(date) : null,
          start: str(s.start),
          end: str(s.end),
          employeeId: str(s.employeeId),
          employee: str(s.employeeName),
          department: str(s.department),
          role: str(s.resolvedRoleName) || null,
          branch: str(s.branchName),
          borrowed: s.isBorrowed === true,
        };
      });
      return {
        data: {
          scope: i.scope,
          branchId: i.branchId ?? who.homeBranchId ?? null,
          period: periodWords(i.from, i.to),
          shifts: shifts.length,
          days: new Set(shifts.map((s) => dayOf(s.date)).filter(Boolean)).size,
          people: new Set(shifts.map((s) => str(s.employeeId)).filter(Boolean)).size,
          list: shown,
        },
        listKey: 'list',
        rows: shifts.length,
        more: shifts.length - shown.length,
      };
    },
    deepLink: () => ({ key: 'oto.rota', params: {} }),
  }),
];

export const OTOAPP_TOOLS: ReadonlyMap<string, OtoAppToolAdapter> = new Map(OTOAPP_TOOL_ADAPTERS.map((a) => [a.name, a]));

/** The definitions the model is offered when the OTO App tools are on: the seven, sorted by name (cache-stable, §D.2). */
export function otoAppToolDefinitions(): ToolDefinition[] {
  return [...OTOAPP_TOOL_ADAPTERS]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((a) => ({
      name: a.name,
      description: a.description,
      inputSchema: toJsonSchema(a.input) as ToolDefinition['inputSchema'],
    }));
}
