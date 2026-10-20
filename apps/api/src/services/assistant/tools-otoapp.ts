import { ASSISTANT_SUMMARY_ROWS, ASSISTANT_TOOLS, isoDateInTz } from '@oto/shared';
import type { ToolDefinition } from '@oto/assistant';
import type { z } from 'zod';
import { assertGetRoute, type GetRouteTemplate } from './call-platform';
import type { OtoAppIdentity } from './call-otoapp';
import { toJsonSchema } from './json-schema';
import {
  arr,
  bangkokTime,
  clockOf,
  daysInclusive,
  dayWords,
  hoursBetween,
  monthWords,
  num,
  obj,
  periodSentence,
  query,
  str,
  weekdayWords,
  type Obj,
  type SummaryDraft,
} from './tools';

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
 * WHAT IS NOT HERE (plan "Concerns"; G2 approved 2026-10-21): no tool over
 * `/api/time-events` (attendance covers it) or `/api/checklists/today`, and no
 * read of a colleague's balance — `oto.employee_leave` carries the leave
 * RECORDS and says plainly that the balance is not readable here; "Anan's
 * clock events" and "today's checklists" have no tool and get the link. The
 * leave-balance routes were fenced to the person in the OTO App at SCRUM-595
 * (2f8848a0; `/api/time-events` at 92318de6), so `oto.my_leave` reads the
 * asker's OWN balance through the two branch lists the rota's "My Leave
 * Balance" reads, and summarises only their row (`ownBalance`, below).
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
  /**
   * The validated input with what the model may leave out filled in by the
   * clock (a period's default): what `urls`, `summarise` and `deepLink` read,
   * and what the tool-call row records as the arguments.
   */
  resolve(input: never, now: Date): never;
  urls(input: never, who: OtoAppIdentity): string[];
  summarise(bodies: unknown[], input: never, now: Date, who: OtoAppIdentity): SummaryDraft;
  deepLink(input: never): { key: string; params: Record<string, string> } | null;
}

type Spec = (typeof ASSISTANT_TOOLS)[number];
/** The registry's `oto.*` names: the seven this file must cover (the census counts them). */
type OtoName = Extract<Spec['name'], `oto.${string}`>;
type In<N extends OtoName> = z.infer<Extract<Spec, { name: N }>['input']>;

/** `R` is the resolved input: the registry's shape unless `resolve` narrows it (a filled default). */
interface AdapterBody<N extends OtoName, R> {
  resolve?(input: In<N>, now: Date): R;
  urls(input: R, who: OtoAppIdentity): string[];
  summarise(bodies: unknown[], input: R, now: Date, who: OtoAppIdentity): SummaryDraft;
  deepLink?(input: R): { key: string; params: Record<string, string> } | null;
}

function adapter<N extends OtoName, R = In<N>>(name: N, body: AdapterBody<N, R>): OtoAppToolAdapter {
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
    resolve: (body.resolve ?? ((i: In<N>) => i)) as OtoAppToolAdapter['resolve'],
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

/**
 * A period in words: each end as a day, the whole as a sentence ("1 to 20
 * October 2026"), and every month it touches (what grounds "this month").
 * The figures an answer uses for a period are all here, in the three languages.
 */
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
    words: from && to ? periodSentence(from, to) : null,
    days: daysInclusive(from, to),
    months: [...months],
  };
}

/** An instant as the park reads it, with the day in words: `2026-10-01 10:00 (1 October 2026 / …)`. */
function whenWords(iso: unknown): string | null {
  const at = bangkokTime(iso);
  return at ? `${at} (${dayWords(at.slice(0, 10))})` : null;
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

/** A leave record as the model reads it: type, the days and their count, never the note. */
function leaveRecord(r: Obj): Obj {
  const from = dayOf(r.startDate);
  const to = dayOf(r.endDate);
  const halfDay = r.isHalfDay === true;
  const span = daysInclusive(from, to);
  return {
    type: str(r.type) ?? str(r.timeOffType),
    from: from ? `${from} (${dayWords(from)})` : null,
    to: to ? `${to} (${dayWords(to)})` : null,
    weekdays: from && to ? `${weekdayWords(from)} – ${weekdayWords(to)}` : null,
    // The length an answer states: calendar days both ends included, a half day as 0.5.
    days: halfDay ? 0.5 : span,
    halfDay: halfDay ? (str(r.halfDayPeriod) ?? true) : false,
  };
}

const NO_BALANCE = 'The leave balance is not readable here; the leave screen shows it.';

/** `1 day`, `0.5 days`, `6 days`: a figure with its unit, as an answer states it. */
function days(n: number): string {
  return plural(n, 'day');
}

/** `1 late arrival`, `2 late arrivals`, `0 no-shows`: a count with its noun. */
function plural(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

/**
 * Each balance kind by name in the three languages the answers are written
 * in (the OTO App's own screens name them in English only), so a Thai or
 * Russian answer has the word and the guard reads it as grounded.
 */
const BALANCE_KINDS = {
  daysOff: { en: 'days off in lieu', th: 'วันหยุดชดเชย', ru: 'отгулы' },
  annual: { en: 'annual leave', th: 'ลาพักร้อน', ru: 'ежегодный отпуск' },
  business: { en: 'business leave', th: 'ลากิจ', ru: 'отпуск по личным делам' },
  publicHolidays: { en: 'public holidays', th: 'วันหยุดนักขัตฤกษ์', ru: 'государственные праздники' },
} as const;

/**
 * The asker's OWN leave balance, as the rota's "My Leave Balance" strip reads
 * it (apps/oto-app/client/src/pages/core/rota.tsx:322-344 and :934-962): the
 * row at the asker's employee id — the id `/api/my-time-off` answers, which
 * is how the rota finds its own — in each of the two branch lists,
 * `/api/leave-balances` (days off in lieu) and `/api/all-leave-balances`
 * (annual, business, public holidays). The app's person fence (SCRUM-595)
 * answers a staff session its own row only; a manager's answer is the
 * branch, and only their own row is read here, whatever else the lists held.
 * Every figure is stated with its kind and unit in words, so the guard
 * grounds it ("Annual leave: 6 days remaining of 10 days earned").
 */
function ownBalance(employeeId: string | null, daysOffList: unknown, allList: unknown): Obj {
  const pick = (list: unknown): Obj | null =>
    employeeId === null ? null : (arr(list).map(obj).find((r) => str(r.employeeId) === employeeId) ?? null);
  const off = pick(daysOffList);
  const all = pick(allList);
  if (!off && !all) {
    return { available: false, note: 'The leave balance did not come back for this person; the rota shows it.' };
  }
  const lines: string[] = [];
  const out: Obj = { available: true, unit: 'days' };
  if (off) {
    const balance = num(off.balance) ?? 0;
    const earned = num(off.daysEarned) ?? 0;
    const used = num(off.daysUsed) ?? 0;
    const words = `Days off in lieu: a balance of ${days(balance)} (${days(earned)} earned, ${days(used)} used)`;
    // The kind's name in the three languages: the Thai for a day off in lieu carries ชดเชย, a word
    // the answer guard reads as a promise unless the summary itself says it.
    out.daysOff = { kind: BALANCE_KINDS.daysOff, balance, earned, used, policy: str(off.policyName), words };
    lines.push(words);
  }
  if (all) {
    const annual = obj(all.annual);
    const business = obj(all.business);
    const holidays = obj(all.publicHolidays);
    const year = num(all.year);
    const a = {
      remaining: num(annual.balance) ?? 0,
      earned: num(annual.earned) ?? 0,
      used: num(annual.used) ?? 0,
      canClaim: annual.canClaim === true,
      waitingMonths: num(annual.waitingMonths),
      monthsEmployed: num(annual.totalMonthsEmployed),
    };
    const aWords = a.canClaim
      ? `Annual leave: ${days(a.remaining)} remaining of ${days(a.earned)} earned (${days(a.used)} used)`
      : `Annual leave: ${days(a.remaining)} accrued of ${days(a.earned)} earned (${days(a.used)} used), not yet claimable`;
    const b = { remaining: num(business.balance) ?? 0, earned: num(business.earned) ?? 0, used: num(business.used) ?? 0 };
    const bWords = `Business leave: ${days(b.remaining)} remaining of ${days(b.earned)} (${days(b.used)} used)`;
    const ph = num(holidays.remaining) ?? 0;
    const phWords = `Public holidays: ${days(ph)} remaining${year === null ? '' : ` in ${year}`}`;
    // "Holiday" as the rota's strip sums it: claimable annual leave plus the public holidays left.
    const holiday = (a.canClaim ? a.remaining : 0) + ph;
    out.year = year;
    out.annual = { kind: BALANCE_KINDS.annual, ...a, words: aWords };
    out.business = { kind: BALANCE_KINDS.business, ...b, words: bWords };
    out.publicHolidays = { kind: BALANCE_KINDS.publicHolidays, remaining: ph, words: phWords };
    out.holiday = { total: holiday, words: `Holiday, as the rota shows it: ${days(holiday)} (claimable annual leave plus public holidays remaining)` };
    lines.push(aWords, bWords, phWords);
  }
  out.words = lines.join('; ');
  return out;
}

/** A period with both ends given: the attendance call's, once the default is filled. */
type Period = { startDate: string; endDate: string };

export const OTOAPP_TOOL_ADAPTERS: readonly OtoAppToolAdapter[] = [
  adapter('oto.attendance', {
    // "This month" is the current Bangkok calendar month, the 1st to today — never the route's own
    // default, a rolling 30 days. Both dates always reach the route.
    resolve: (i, now): In<'oto.attendance'> & Period => {
      const today = isoDateInTz(now, BANGKOK);
      return { ...i, startDate: i.startDate ?? `${today.slice(0, 7)}-01`, endDate: i.endDate ?? today };
    },
    urls: (i) => [`/api/timekeeping/employee/${enc(i.employeeId)}${query({ startDate: i.startDate, endDate: i.endDate })}`],
    summarise: ([body], i) => {
      const b = obj(body);
      const employee = obj(b.employee);
      const stats = obj(b.stats);
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
          weekday: date ? weekdayWords(date) : null,
          hours: num(d.totalHours),
          sessions: num(d.sessionCount),
          longShift: d.hasLongShift === true,
        };
      });
      const name = str(employee.fullName) ?? 'this person';
      const period = periodWords(i.startDate, i.endDate);
      return {
        data: {
          employee: { id: str(employee.id), name: str(employee.fullName), branch: str(employee.branchName) },
          // The period asked for, in words. The route's own `dateRange` is not read: it renders the
          // Bangkok midnight as a UTC day, one day early ("2026-09-30 to 2026-10-20" for October).
          period,
          // S12: an empty period is one plain sentence, not a list of zeros.
          words:
            daysWorked === 0
              ? `No clock-ins on record for ${name} between ${String(period.words)}.`
              : `${name}: ${plural(daysWorked, 'day')} worked, ${plural(totalHours, 'hour')}, ${plural(byType['LATE_ARRIVAL'] ?? 0, 'late arrival')}, ${plural(byType['SCHEDULED_NO_SHOW'] ?? 0, 'no-show')} between ${String(period.words)}.`,
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
    // The records, then the balance as the rota's "My Leave Balance" strip reads it (rota.tsx:322-344):
    // the two branch lists for the park the rota opens on — the asker's own, else the first the app
    // lists for them (`defaultBranchId`). No park listed: no balance call, as the rota makes none
    // (`enabled: !!selectedBranchId`), and the summary says the balance did not come back.
    urls: (i, who) => {
      const park = who.defaultBranchId;
      return [
        `/api/my-time-off${query({ dateFrom: i.from, dateTo: i.to })}`,
        ...(park === null ? [] : [`/api/leave-balances${query({ branchId: park })}`, `/api/all-leave-balances${query({ branchId: park })}`]),
      ];
    },
    summarise: ([body, daysOffList, allList], i) => {
      const b = obj(body);
      const employeeId = str(b.employeeId);
      const records = arr(b.timeOff).map(obj);
      const shown = records.slice(0, ASSISTANT_SUMMARY_ROWS).map(leaveRecord);
      return {
        data: {
          employeeId,
          period: periodWords(i.from ?? null, i.to ?? null),
          records: records.length,
          leave: shown,
          weeklyOffDays: arr(b.weeklyOffDays).map(str).filter((d): d is string => d !== null),
          // The asker's own row only, picked by their employee id, whatever the lists held.
          balance: ownBalance(employeeId, daysOffList, allList),
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
          lockedAt: whenWords(p.lockedAt),
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
          lockedAt: whenWords(r.lockedAt),
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
    // The route needs a park for every scope, `me` included ("branchId, from, and to are required"):
    // the input's, else the asker's own — the one their access names, else the first the app lists
    // for them, as the rota screen opens (call-otoapp.ts `defaultBranchId`). Nothing is guessed: an
    // asker the app lists no park for sends none, and the route's own refusal comes back verbatim.
    urls: (i, who) => [`/api/rota${query({ scope: i.scope, branchId: i.branchId ?? who.defaultBranchId ?? undefined, from: i.from, to: i.to })}`],
    summarise: ([body], i, _now, who) => {
      const shifts = arr(body)
        .map(obj)
        .sort((a, b) => `${str(a.date)} ${str(a.start)}`.localeCompare(`${str(b.date)} ${str(b.start)}`));
      const shown = shifts.slice(0, ASSISTANT_SUMMARY_ROWS).map((s) => {
        const date = dayOf(s.date);
        // The app's shift rows carry a Postgres `time` (`10:00:00`); the answer writes `10:00`,
        // the date by its name and the shift's length, so the summary states each of those.
        const start = clockOf(s.start);
        const end = clockOf(s.end);
        return {
          date,
          day: date ? dayWords(date) : null,
          weekday: date ? weekdayWords(date) : null,
          start,
          end,
          hours: hoursBetween(start, end),
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
          branchId: i.branchId ?? who.defaultBranchId ?? null,
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
