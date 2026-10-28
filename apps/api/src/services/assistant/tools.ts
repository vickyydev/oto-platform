import {
  ASSISTANT_AUDIT_ACTIONS_SHOWN,
  ASSISTANT_AUDIT_ACTION_NAMES,
  ASSISTANT_SUMMARY_MAX_BYTES,
  ASSISTANT_SUMMARY_ROWS,
  ASSISTANT_TOOLS,
  assistantAuditActionsLine,
  dayOfWeekOfIsoDate,
  formatDisplayPhone,
  isoDateInTz,
  type AssistantToolSummary,
} from '@oto/shared';
import type { ToolDefinition } from '@oto/assistant';
import type { z } from 'zod';
import { assertGetRoute, type GetRouteTemplate } from './call-platform';
import { toJsonSchema } from './json-schema';

/**
 * THE PLATFORM TOOLS (SCRUM-591, round I2; plan
 * docs/progress/plans/internal-assistant-build/PLAN.md §B.4).
 *
 * Ten adapters over the ten platform entries of `ASSISTANT_TOOLS` — the
 * registry's names, routes, descriptions and input schemas are `@oto/shared`'s
 * and are not restated here. An adapter adds the server's half, which the
 * model never touches:
 *
 *   urls(input)       the URL(s) of the screen's own GET route(s), built from
 *                     VALIDATED input; every value is encoded, and the call
 *                     layer refuses a URL that is not one of the tool's
 *                     declared templates (`call-platform.ts`).
 *   summarise(...)    a projection of the body: named fields, at most 20 rows
 *                     with a `more` count, figures precomputed so the model
 *                     reports arithmetic the server did, times in Bangkok,
 *                     and the period said in words ("20 October 2026") so the
 *                     traceability guard can ground a date the answer names.
 *                     Never over 4 KB: past it, rows are cut and `truncated`
 *                     is set, and the model offers the link (§C).
 *   deepLink(input)   the screen that shows the same thing (§C), when the map
 *                     has one; the engine offers it when an ask ends short.
 *
 * WHAT A SUMMARY LEAVES OUT, on purpose: a child's medical NOTES unless the
 * model asked for them (`include: ['medical_notes']`, §B.4; the allergy text
 * is in every member summary since the test night of 2026-10-21, W5); an Inbox
 * message's words (only the customer's display name, the category and the
 * intent — the customer assistant's law that no body leaves the message
 * table holds here too); the audit trail's before/after payloads; a failure's
 * error text. A summary is data, never instructions (§E.3): the loop wraps it
 * in `{"data": …}`.
 *
 * NONE OVER THE FENCE GAPS (plan "Concerns", G2). The three gap routes are the
 * OTO App's (leave balances, time-events, today's checklists); no tool of
 * this round reaches the OTO App at all, and round I4 registers none over them.
 */

/** What one adapter produces before it is sized. */
export interface SummaryDraft {
  data: Record<string, unknown>;
  /** The array inside `data` that may be cut to fit, and the rows it had. */
  listKey?: string;
  /** Rows the route returned (the `rows` column). */
  rows: number;
  /** Rows the projection left out before sizing. */
  more?: number;
}

/**
 * What the engine knows of the asker on the platform side when it summarises
 * (test night 2026-10-21, W7): the parks their counter access reaches, so a
 * one-park count can say "1 of 3 you can see" and name the others. Read once
 * per ask from the asker's own grants (`pos:checkin:read`), never from a tool.
 */
export interface PlatformAsker {
  parks: ReadonlyArray<{ id: string; name: string; code: string }>;
}

export const NO_PLATFORM_ASKER: PlatformAsker = { parks: [] };

export interface PlatformToolAdapter {
  name: string;
  routes: readonly GetRouteTemplate[];
  description: string;
  /** The registry's own schema: the arguments are validated against it before any call. */
  input: z.ZodTypeAny;
  urls(input: never): string[];
  summarise(bodies: unknown[], input: never, now: Date, who: PlatformAsker): SummaryDraft;
  deepLink(input: never): { key: string; params: Record<string, string> } | null;
  /**
   * The phones of the members this call FOUND (the re-check of the test night
   * 2026-10-21, W5): for a lookup that found one, the phone as typed and the
   * member's own; for a get or a search, the members' own. The engine's link
   * gate keeps a `pos.member` link only on one of these — a lookup that found
   * nobody earns no History button for the phone the asker typed.
   */
  memberPhones(bodies: unknown[], input: never): string[];
}

// --- Helpers -----------------------------------------------------------------------------

export type Obj = Record<string, unknown>;
export const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

const EN_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const TH_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];
const RU_MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
/** The Russian month on its own ("октябрь 2026"), as a month is named without a day. */
const RU_MONTHS_NOMINATIVE = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

/**
 * A day in words, in the three languages the assistant answers in, so the
 * traceability guard can ground "20 October" (or its Thai or Russian form)
 * when the answer names the day a figure is for.
 */
export function dayWords(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  const [, y, mo, d] = m;
  const i = Number(mo) - 1;
  const day = Number(d);
  return `${day} ${EN_MONTHS[i]} ${y} / ${day} ${TH_MONTHS[i]} ${Number(y) + 543} / ${day} ${RU_MONTHS[i]} ${y}`;
}

/** A month in words ("October 2026", its Thai and Russian forms): what grounds "this month" in an answer. */
export function monthWords(isoMonth: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(isoMonth);
  if (!m) return isoMonth;
  const [, y, mo] = m;
  const i = Number(mo) - 1;
  return `${EN_MONTHS[i]} ${y} / ${TH_MONTHS[i]} ${Number(y) + 543} / ${RU_MONTHS_NOMINATIVE[i]} ${y}`;
}

const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TH_DAYS = ['วันอาทิตย์', 'วันจันทร์', 'วันอังคาร', 'วันพุธ', 'วันพฤหัสบดี', 'วันศุกร์', 'วันเสาร์'];
const RU_DAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

/** The weekday of a date, in the three languages ("Wednesday / วันพุธ / среда"): a rota answer says the day by its name. */
export function weekdayWords(isoDate: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const d = dayOfWeekOfIsoDate(isoDate);
  return `${EN_DAYS[d]} / ${TH_DAYS[d]} / ${RU_DAYS[d]}`;
}

/**
 * A period as a sentence, in the three languages, so the guard grounds the
 * words an answer uses for it: "1 to 20 October 2026" within one month,
 * "30 September 2026 to 20 October 2026" across months, one day on its own.
 */
export function periodSentence(from: string, to: string): string {
  const parse = (d: string) => /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  const f = parse(from);
  const t = parse(to);
  if (!f || !t) return `${from} to ${to}`;
  if (from === to) return dayWords(from);
  const [, fy, fm, fd] = f;
  const [, ty, tm, td] = t;
  const fi = Number(fm) - 1;
  const ti = Number(tm) - 1;
  if (fy === ty && fm === tm) {
    return [
      `${Number(fd)} to ${Number(td)} ${EN_MONTHS[ti]} ${ty}`,
      `${Number(fd)} ถึง ${Number(td)} ${TH_MONTHS[ti]} ${Number(ty) + 543}`,
      `с ${Number(fd)} по ${Number(td)} ${RU_MONTHS[ti]} ${ty}`,
    ].join(' / ');
  }
  return [
    `${Number(fd)} ${EN_MONTHS[fi]} ${fy} to ${Number(td)} ${EN_MONTHS[ti]} ${ty}`,
    `${Number(fd)} ${TH_MONTHS[fi]} ${Number(fy) + 543} ถึง ${Number(td)} ${TH_MONTHS[ti]} ${Number(ty) + 543}`,
    `с ${Number(fd)} ${RU_MONTHS[fi]} ${fy} по ${Number(td)} ${RU_MONTHS[ti]} ${ty}`,
  ].join(' / ');
}

/**
 * A clock time as the app's screens show it, `10:00`: from `10:00`, `10.00`
 * or a Postgres `time` such as `10:00:00` (what the rota's shift rows carry on
 * a deployment, where the fixture had `10:00`). Null for anything else.
 */
export function clockOf(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = /^(\d{1,2})[.:](\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  if (h > 23 || Number(m[2]) > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** The hours between two clock times, to the hundredth; a shift that ends after midnight wraps. */
export function hoursBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const minutes = (t: string) => {
    const [h, m] = t.split(':').map(Number) as [number, number];
    return h * 60 + m;
  };
  let span = minutes(end) - minutes(start);
  if (span < 0) span += 24 * 60;
  return Math.round((span / 60) * 100) / 100;
}

/**
 * The ask's own calendar, as grounding for the internal answer's guard: a
 * model that names today's date, the year, this month or last month is
 * naming what the asker's clock says, not a figure it found. Today in Bangkok
 * (ISO, in words, its weekday), this month and last month as ISO ranges and
 * in words, each month by name.
 */
export function clockGrounding(now: Date): string {
  const today = isoDateInTz(now, BANGKOK);
  const [y, m] = today.split('-').map(Number) as [number, number];
  const thisFirst = `${today.slice(0, 7)}-01`;
  const lastYear = m === 1 ? y - 1 : y;
  const lastMonth = m === 1 ? 12 : m - 1;
  const lastKey = `${lastYear}-${String(lastMonth).padStart(2, '0')}`;
  const lastEnd = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
  const lastFirst = `${lastKey}-01`;
  const lastLast = `${lastKey}-${String(lastEnd).padStart(2, '0')}`;
  return [
    `today ${today} (${weekdayWords(today)}; ${dayWords(today)})`,
    `this month ${thisFirst} to ${today} (${periodSentence(thisFirst, today)}; ${monthWords(today)})`,
    `last month ${lastFirst} to ${lastLast} (${periodSentence(lastFirst, lastLast)}; ${monthWords(lastKey)})`,
  ].join('. ');
}

const EN_MONTH_PATTERNS = [
  'jan(?:uary)?', 'feb(?:ruary)?', 'mar(?:ch)?', 'apr(?:il)?', 'may', 'june?',
  'july?', 'aug(?:ust)?', 'sept?(?:ember)?', 'oct(?:ober)?', 'nov(?:ember)?', 'dec(?:ember)?',
];
const RU_MONTH_STEMS = ['январ', 'феврал', 'март', 'апрел', 'ма[йя]', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];

/**
 * The calendar the asker named in their own words (test night 2026-10-21,
 * W4): a month by name ("September", "กันยายน", "сентябрь") is the ISO month
 * of the ask's year — of last year when the month is still ahead — and a day
 * or month they typed in ISO form is itself. Link grounding only: a month the
 * asker typed may carry a month-end link (`oto.payroll.month`), as the
 * asker's own words already ground the figures the guard checks.
 */
export function questionCalendar(question: string, now: Date): string {
  const today = isoDateInTz(now, BANGKOK);
  const [year, thisMonth] = today.split('-').map(Number) as [number, number];
  const out = new Set<string>();
  const month = (i: number) => {
    const y = i + 1 > thisMonth ? year - 1 : year;
    const key = `${y}-${String(i + 1).padStart(2, '0')}`;
    out.add(`${key} (${monthWords(key)})`);
  };
  for (const [i, p] of EN_MONTH_PATTERNS.entries()) {
    // "May" only beside a day number, as the guard reads it: "you may" is ordinary English.
    const pattern = i === 4 ? /(?:\d\s*(?:st|nd|rd|th)?\s*May(?![A-Za-z]))|(?:(?<![A-Za-z])May\s*\d)/ : new RegExp(`(?<![A-Za-z])${p}(?![A-Za-z])`, 'i');
    if (pattern.test(question)) month(i);
  }
  for (const [i, name] of TH_MONTHS.entries()) if (question.includes(name)) month(i);
  for (const [i, stem] of RU_MONTH_STEMS.entries()) {
    if (new RegExp(`(?<!\\p{L})${stem}\\p{L}*`, 'iu').test(question)) month(i);
  }
  for (const typed of question.match(/\b\d{4}-(?:0[1-9]|1[0-2])(?:-\d{2})?\b/g) ?? []) out.add(typed);
  return [...out].join('; ');
}

/** The calendar days a range covers, both ends included; null when either end is not a date. */
export function daysInclusive(from: string | null, to: string | null): number | null {
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  const span = Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
  return span >= 0 ? span + 1 : null;
}

const BANGKOK = 'Asia/Bangkok';
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: BANGKOK, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** An instant as the park reads it: `2026-10-20 14:05` in Bangkok. */
export function bangkokTime(iso: unknown): string | null {
  const s = str(iso);
  if (!s) return null;
  const at = new Date(s);
  if (Number.isNaN(at.getTime())) return null;
  return `${isoDateInTz(at, BANGKOK)} ${clock.format(at)}`;
}

/** "Now", in the park's words: the date in three languages and the time. */
function nowWords(now: Date): string {
  return `${dayWords(isoDateInTz(now, BANGKOK))}, ${clock.format(now)} (Bangkok)`;
}

function ageOf(child: Obj, now: Date): number | null {
  const years = num(child.ageYears);
  if (years !== null) return years;
  const dob = str(child.dateOfBirth);
  if (!dob) return null;
  const today = isoDateInTz(now, BANGKOK);
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  const [by, bm, bd] = dob.split('-').map(Number) as [number, number, number];
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age >= 0 ? age : null;
}

/** The last four digits only (§B.4: "a masked phone"). */
function maskedPhone(phone: unknown): string | null {
  const s = str(phone);
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  return digits.length >= 4 ? `••• ${digits.slice(-4)}` : '•••';
}

const hasText = (v: unknown) => typeof v === 'string' && v.trim() !== '';

/**
 * A member as the model reads it (lookup and get): never the email, never the
 * tier evidence. A child's allergies are in it as written (W5: reception asks
 * for exactly that at the desk); the medical notes only when asked for.
 */
function memberSummary(m: Obj, includeMedicalNotes: boolean, now: Date): Obj {
  const children = arr(m.children).map((c) => {
    const child = obj(c);
    return {
      name: str(child.name),
      age: ageOf(child, now),
      // A flag for the notes, not their text, unless the question was about them (§B.4).
      medicalAlert: child.medicalAlert === true || hasText(child.allergies) || hasText(child.medicalNotes),
      hasAllergies: hasText(child.allergies),
      allergies: hasText(child.allergies) ? str(child.allergies) : null,
      hasMedicalNotes: hasText(child.medicalNotes),
      ...(includeMedicalNotes ? { medicalNotes: str(child.medicalNotes) } : {}),
    };
  });
  const phone = str(m.phone);
  return {
    id: str(m.id),
    name: str(m.name),
    nickname: str(m.nickname),
    phone: phone ? formatDisplayPhone(phone) : null,
    tier: str(m.tierCode),
    notes: str(m.notes),
    childCount: children.length,
    children,
  };
}

const MemberInclude = (input: { include?: readonly string[] | undefined }) => (input.include ?? []).includes('medical_notes');

/**
 * An audit instant as the route takes it (`z.string().datetime()`, UTC with
 * `Z`), from what the model gave (D1): a bare day is the park's whole day —
 * its start for `from`, its end for `to` — and an instant with no offset is
 * Bangkok time.
 */
export function auditInstant(given: string | undefined, end: 'from' | 'to'): string | undefined {
  if (!given) return undefined;
  const s = given.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(`${s}T${end === 'from' ? '00:00:00.000' : '23:59:59.999'}+07:00`).toISOString();
  }
  const withT = s.replace(' ', 'T');
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(withT) ? withT : `${withT}+07:00`;
  const at = new Date(zoned);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/** The audit action to filter by: the enum's name, else the free-text name (a guess until rows say otherwise). */
function auditAction(i: { action?: string | undefined; q?: string | undefined }): string | undefined {
  return i.action ?? (i.q?.trim() || undefined);
}

/**
 * The sentence for a filtered search that found nothing (D1): the filter
 * itself, and the names the audit does write, so the model cannot read
 * "nobody signed in" into "no rows for a name that was a guess".
 */
export function auditNothingMatched(action: string | undefined, from: string | null, to: string | null, guessed: boolean): string {
  const period = from || to ? ` between ${from ?? 'the start'} and ${to ?? 'now'}` : '';
  const filter = action ? `action=${action}` : 'these filters';
  const known = `the known actions are: ${assistantAuditActionsLine(ASSISTANT_AUDIT_ACTIONS_SHOWN)}`;
  if (!action) return `0 rows for ${filter}${period}: nothing matched the filter, which is not the same as nothing happening.`;
  return guessed
    ? `0 rows for ${filter}${period}: ${action} is not a name the audit writes, so that action was a guess; ${known}.`
    : `0 rows for ${filter}${period}: nothing of that kind matched, which is not the same as nothing happening. Other actions: ${known}.`;
}

// --- The ten -----------------------------------------------------------------------------

type Spec = (typeof ASSISTANT_TOOLS)[number];
type SpecOf<N extends Spec['name']> = Extract<Spec, { name: N }>;
type In<N extends Spec['name']> = z.infer<SpecOf<N>['input']>;

interface AdapterBody<N extends Spec['name']> {
  urls(input: In<N>): string[];
  summarise(bodies: unknown[], input: In<N>, now: Date, who: PlatformAsker): SummaryDraft;
  deepLink?(input: In<N>): { key: string; params: Record<string, string> } | null;
  memberPhones?(bodies: unknown[], input: In<N>): string[];
}

function adapter<N extends Spec['name']>(name: N, body: AdapterBody<N>): PlatformToolAdapter {
  const spec = ASSISTANT_TOOLS.find((t) => t.name === name);
  if (!spec) throw new TypeError(`assistant tool ${name}: not in the registry`);
  if (spec.system !== 'platform') throw new TypeError(`assistant tool ${name}: not a platform tool`);
  for (const r of spec.routes) assertGetRoute(name, r);
  return {
    name,
    routes: spec.routes as readonly GetRouteTemplate[],
    description: spec.description,
    input: spec.input,
    urls: body.urls as PlatformToolAdapter['urls'],
    summarise: body.summarise as PlatformToolAdapter['summarise'],
    deepLink: (body.deepLink ?? (() => null)) as PlatformToolAdapter['deepLink'],
    memberPhones: (body.memberPhones ?? (() => [])) as PlatformToolAdapter['memberPhones'],
  };
}

/** The phones of the members a route body holds: one under `member`, or each under `members`. */
function phonesOf(body: unknown): string[] {
  const b = obj(body);
  const members = b.member ? [b.member] : arr(b.members);
  return members.map((m) => str(obj(m).phone)).filter((p): p is string => p !== null);
}

const enc = encodeURIComponent;

export const PLATFORM_TOOL_ADAPTERS: readonly PlatformToolAdapter[] = [
  adapter('audit.search', {
    urls: (i) => [
      `/audit${query({
        action: auditAction(i),
        entityType: i.entityType,
        from: auditInstant(i.from, 'from'),
        to: auditInstant(i.to, 'to'),
        limit: ASSISTANT_SUMMARY_ROWS,
        // The total under the filter, so a page of 20 can say how many it is a page of.
        count: 'true',
      })}`,
    ],
    summarise: ([body], i) => {
      const b = obj(body);
      const entries = arr(b.entries).map((e) => {
        const r = obj(e);
        // Who (by name: the route resolves the employee behind the account; never an id, which the
        // model would echo), what, to what, when — never the before/after payloads.
        return {
          action: str(r.action),
          entityType: str(r.entityType),
          entityId: str(r.entityId),
          actor: str(r.actorName),
          branchId: str(r.branchId),
          at: bangkokTime(r.createdAt),
        };
      });
      const action = auditAction(i);
      const from = i.from ? bangkokTime(auditInstant(i.from, 'from')) : null;
      const to = i.to ? bangkokTime(auditInstant(i.to, 'to')) : null;
      const filtered = action !== undefined || i.entityType !== undefined || from !== null || to !== null;
      // D1: a zero after a filter says so, and names the actions the audit writes when the name was a guess.
      const guessed = action !== undefined && !(ASSISTANT_AUDIT_ACTION_NAMES as readonly string[]).includes(action);
      // The rows the filter matches in all (the route's `total`); the page is the latest of them.
      const total = num(b.total) ?? entries.length;
      return {
        data: {
          action: action ?? null,
          period: { from, to },
          masked: b.masked === true,
          total,
          shown: entries.length,
          moreOnTheScreen: b.nextCursor ? true : false,
          ...(total > entries.length
            ? { page: `Showing the latest ${entries.length} of ${total}: a count made from these rows is a page's count, not the total.` }
            : {}),
          ...(entries.length === 0 && filtered ? { nothingMatched: auditNothingMatched(action, from, to, guessed) } : {}),
          entries,
        },
        listKey: 'entries',
        rows: entries.length,
      };
    },
    deepLink: () => ({ key: 'console.activity', params: {} }),
  }),
  adapter('branches.list', {
    urls: () => ['/branches'],
    summarise: ([body]) => {
      const branches = arr(obj(body).branches).map((x) => {
        const r = obj(x);
        return { id: str(r.id), name: str(r.name), code: str(r.code) };
      });
      return { data: { count: branches.length, branches }, listKey: 'branches', rows: branches.length };
    },
    deepLink: () => ({ key: 'console.branches', params: {} }),
  }),
  adapter('checkin.board', {
    urls: (i) => [`/checkin/board${query({ branchId: i.branchId })}`],
    summarise: ([body], i, now) => {
      const b = obj(body);
      const counts = obj(b.counts);
      const children = arr(b.families).flatMap((f) =>
        arr(obj(f).children).map((c) => {
          const r = obj(c);
          // Name, where they are and what they are booked for — no allergy text on the board summary.
          return {
            name: str(r.childName),
            status: str(r.status),
            service: str(r.service),
            pickUpBy: bangkokTime(r.scheduledFor),
          };
        }),
      );
      const shown = children.slice(0, ASSISTANT_SUMMARY_ROWS);
      return {
        data: {
          branchId: i.branchId,
          asOf: nowWords(now),
          children: {
            registered: num(counts.registered) ?? 0,
            inPark: num(counts.in_park) ?? 0,
            collectedToday: num(counts.out) ?? 0,
          },
          familiesWithUnconfirmedContact: num(b.unconfirmedFamilies) ?? 0,
          names: shown,
        },
        listKey: 'names',
        rows: children.length,
        more: children.length - shown.length,
      };
    },
  }),
  adapter('inbox.dashboard', {
    // W6: the metric cards, within what the asker can see; every conversation by category, and each
    // category is one team's (`services/inbox/router.ts` TEAM_OF_CATEGORY), so "which team has the
    // most" is answered from the mix.
    urls: () => ['/inbox/dashboard'],
    summarise: ([body], _i, now) => {
      const b = obj(body);
      const by = obj(b.byCategory);
      const teams = [
        { team: 'birthdays', category: 'birthdays', conversations: num(by.birthdays) ?? 0 },
        { team: 'reception', category: 'general', conversations: num(by.general) ?? 0 },
        { team: 'marketing', category: 'marketing', conversations: num(by.marketing) ?? 0 },
        // The playbook's GM queue (SCRUM-220): the GM team's category.
        { team: 'gm', category: 'gm', conversations: num(by.gm) ?? 0 },
      ];
      const most = Math.max(...teams.map((t) => t.conversations));
      const leaders = teams.filter((t) => t.conversations === most && most > 0).map((t) => t.team);
      const avg = num(b.averageFirstResponseSeconds);
      const day = str(b.day);
      return {
        data: {
          day: day ? `${day} (${dayWords(day)})` : null,
          asOf: nowWords(now),
          newToday: num(b.newToday) ?? 0,
          unanswered: num(b.unanswered) ?? 0,
          handledToday: num(b.handledToday) ?? 0,
          active: num(b.active) ?? 0,
          averageFirstResponse:
            avg === null ? { seconds: null, words: 'no first response measured yet' } : { seconds: avg, minutes: Math.round(avg / 60), words: `about ${Math.round(avg / 60)} minutes` },
          // Every conversation the asker can see, any status, by the team whose category it is.
          byTeam: teams,
          mostConversations: leaders.length === 0 ? null : leaders,
          words:
            most === 0
              ? 'No conversations by any team.'
              : `${leaders.join(' and ')} ${leaders.length === 1 ? 'has' : 'have'} the most conversations: ${teams.map((t) => `${t.team} (${t.category}) ${t.conversations}`).join(', ')}.`,
        },
        rows: 1,
      };
    },
    deepLink: () => ({ key: 'inbox.queue', params: {} }),
  }),
  adapter('inbox.queue', {
    // Unanswered conversations on the asked tab, as the Inbox counts them
    // (`unanswered=true`: a customer line after the last staff reply).
    urls: (i) => [`/inbox/conversations${query({ tab: i.tab ?? 'team', unanswered: 'true', limit: 100 })}`],
    summarise: ([body], i, now) => {
      const b = obj(body);
      const rows = arr(b.conversations).map(obj);
      const tabCounts = obj(b.tabCounts);
      const exact = !b.nextCursor;
      const threads = rows.slice(0, 10).map((r) => {
        const contact = obj(r.contact);
        // A title, never a message: who, which desk, what about, when. The id is what grounds
        // an `inbox.thread` link (§C): a link to a conversation this summary never named is dropped.
        return {
          id: str(r.id),
          customer: str(contact.displayName) ?? 'unnamed',
          channel: str(r.channel),
          category: str(r.category),
          intent: str(r.intent),
          mine: r.mine === true,
          lastMessageAt: bangkokTime(r.lastMessageAt),
        };
      });
      return {
        data: {
          tab: i.tab ?? 'team',
          asOf: nowWords(now),
          unanswered: rows.length,
          unansweredIsExact: exact,
          openOnTabs: {
            mine: num(tabCounts.mine),
            team: num(tabCounts.team),
          },
          threads,
        },
        listKey: 'threads',
        rows: rows.length,
        more: rows.length - threads.length,
      };
    },
  }),
  adapter('me.whoami', {
    urls: () => ['/me', '/me/permissions'],
    summarise: ([me, perms]) => {
      const m = obj(me);
      const employee = obj(m.employee);
      const seat = obj(m.branch);
      const grants = arr(obj(perms).permissions).map(obj);
      const roles = new Map<string, { role: string; scopeType: string; scopeId: string | null; permissions: number }>();
      for (const g of grants) {
        const key = `${str(g.roleName)}|${str(g.scopeType)}|${str(g.scopeId)}`;
        const prior = roles.get(key);
        if (prior) prior.permissions += 1;
        else {
          roles.set(key, {
            role: str(g.roleName) ?? '',
            scopeType: str(g.scopeType) ?? '',
            scopeId: str(g.scopeId),
            permissions: 1,
          });
        }
      }
      const permissions = [...new Set(grants.map((g) => str(g.permission)).filter((p): p is string => !!p))].sort();
      return {
        data: {
          name: str(employee.name),
          nickname: str(employee.nickname),
          seatBranch: m.branch ? { id: str(seat.id), name: str(seat.name), code: str(seat.code) } : null,
          roles: [...roles.values()],
          permissionCount: permissions.length,
          permissions,
        },
        listKey: 'permissions',
        rows: grants.length,
      };
    },
    deepLink: () => ({ key: 'launcher.account', params: {} }),
  }),
  adapter('members.get', {
    urls: (i) => [`/members/${enc(i.memberId)}`],
    summarise: ([body], i, now) => ({
      data: { found: true, member: memberSummary(obj(obj(body).member), MemberInclude(i), now) },
      rows: 1,
    }),
    memberPhones: ([body]) => phonesOf(body),
  }),
  adapter('members.lookup', {
    urls: (i) => [`/members/lookup${query({ phone: i.phone })}`],
    summarise: ([body], i, now) => {
      const m = obj(body).member;
      return m
        ? { data: { found: true, member: memberSummary(obj(m), MemberInclude(i), now) }, rows: 1 }
        : { data: { found: false, member: null }, rows: 0 };
    },
    // W5: the till's History on the phone the asker typed — grounded by construction (it is their input).
    // The engine's link gate offers it only when this lookup found a member (`memberPhones`).
    deepLink: (i) => ({ key: 'pos.member', params: { phone: i.phone.trim() } }),
    memberPhones: ([body], i) => (obj(body).member ? [i.phone, ...phonesOf(body)] : []),
  }),
  adapter('members.search', {
    urls: (i) => [`/members${query({ q: i.q, limit: ASSISTANT_SUMMARY_ROWS })}`],
    memberPhones: ([body]) => phonesOf(body),
    summarise: ([body]) => {
      const b = obj(body);
      const matches = arr(b.members).map((x) => {
        const r = obj(x);
        return {
          id: str(r.id),
          name: str(r.name),
          nickname: str(r.nickname),
          phone: maskedPhone(r.phone),
          childCount: arr(r.children).length,
        };
      });
      const total = num(b.total) ?? matches.length;
      return {
        data: { total, shown: matches.length, matches },
        listKey: 'matches',
        rows: matches.length,
        more: Math.max(0, total - matches.length),
      };
    },
  }),
  adapter('occupancy.now', {
    urls: (i) => [`/branches/${enc(i.branchId)}/occupancy`],
    summarise: ([body], i, now, who) => {
      const b = obj(body);
      const businessDate = str(b.businessDate);
      const countedAt = bangkokTime(b.asOf);
      const stale = b.stale === true;
      // W7: this park among the parks the asker's counter access reaches, so a one-park figure is said
      // to be one park's, and the others are named for a "whole park" ask.
      const park = who.parks.find((p) => p.id === i.branchId) ?? null;
      const others = who.parks.filter((p) => p.id !== i.branchId);
      const parkName = park?.name ?? 'this park';
      return {
        data: {
          branchId: i.branchId,
          park: park ? { id: park.id, name: park.name, code: park.code } : null,
          parksYouCanSee: who.parks.length,
          otherParks: others.map((p) => ({ id: p.id, name: p.name })),
          scope:
            who.parks.length > 1
              ? `This count is for ${parkName} only, 1 of ${who.parks.length} parks you can see; the others are ${others.map((p) => p.name).join(', ')}. For the park as a whole, read each park and add them up, or say which park.`
              : `This count is for ${parkName}, the one park you can see.`,
          inside: { adults: num(b.adults) ?? 0, children: num(b.kids) ?? 0, total: num(b.total) ?? 0 },
          tradingDay: businessDate ? `${businessDate} (${dayWords(businessDate)})` : null,
          countedAt,
          asOf: nowWords(now),
          // The gate behind the count has not been heard from lately: the figure may be behind.
          stale,
          // S11: the stale flag in one plain line, as the answer should say it.
          staleWords: !stale
            ? null
            : countedAt === null
              ? 'This count is stale: no headcount has been taken yet today (no gate has reported).'
              : `This count is stale: the gate was last heard from at ${countedAt}, so the figure may be behind.`,
        },
        rows: 1,
      };
    },
  }),
  adapter('ops.failures', {
    urls: (i) => [`/ops/failures${query({ windowHours: i.windowHours ?? 24, limit: 50 })}`],
    summarise: ([body], i, now) => {
      const b = obj(body);
      const groups = arr(b.groups).map(obj);
      const byKind: Record<string, number> = {};
      let failures = 0;
      for (const g of groups) {
        const n = num(g.count) ?? 0;
        failures += n;
        const kind = str(g.kind) ?? 'unknown';
        byKind[kind] = (byKind[kind] ?? 0) + n;
      }
      const shown = groups.slice(0, ASSISTANT_SUMMARY_ROWS).map((g) => ({
        kind: str(g.kind),
        name: str(g.name),
        count: num(g.count),
        lastSeenAt: bangkokTime(g.lastSeenAt),
      }));
      return {
        data: {
          window: `the last ${i.windowHours ?? 24} hours, to ${nowWords(now)}`,
          failedRuns: failures,
          groups: groups.length,
          groupListComplete: !b.nextCursor,
          byKind,
          latest: shown,
        },
        listKey: 'latest',
        rows: groups.length,
        more: groups.length - shown.length,
      };
    },
    deepLink: () => ({ key: 'console.failures', params: {} }),
  }),
];

export const PLATFORM_TOOLS: ReadonlyMap<string, PlatformToolAdapter> = new Map(
  PLATFORM_TOOL_ADAPTERS.map((a) => [a.name, a]),
);

/** Bytes of a value as the model receives it. */
export function summaryBytes(summary: AssistantToolSummary): number {
  return Buffer.byteLength(JSON.stringify(summary), 'utf8');
}

/**
 * Sized for context (§B.4): at most 4 KB. Rows are cut from the end of the
 * draft's list until it fits, and `truncated` tells the model to offer the
 * link. A draft with nothing left to cut is replaced by a note.
 */
export function fitSummary(draft: SummaryDraft): AssistantToolSummary {
  const data: Obj = { ...draft.data };
  let more = draft.more ?? 0;
  let truncated = false;
  const build = (): AssistantToolSummary => ({
    data,
    ...(more > 0 ? { more } : {}),
    ...(truncated ? { truncated: true } : {}),
  });
  let summary = build();
  const list = draft.listKey ? data[draft.listKey] : undefined;
  if (Array.isArray(list)) {
    const rows = [...list];
    while (summaryBytes(summary) > ASSISTANT_SUMMARY_MAX_BYTES && rows.length > 0) {
      rows.pop();
      more += 1;
      truncated = true;
      data[draft.listKey!] = rows;
      summary = build();
    }
  }
  if (summaryBytes(summary) > ASSISTANT_SUMMARY_MAX_BYTES) {
    summary = { data: { note: 'The answer is too large to summarise here; offer the screen.' }, truncated: true };
  }
  return summary;
}

/** The definitions the model is offered: the ten, sorted by name (cache-stable, §D.2). */
export function platformToolDefinitions(): ToolDefinition[] {
  return [...PLATFORM_TOOL_ADAPTERS]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((a) => ({
      name: a.name,
      description: a.description,
      inputSchema: toJsonSchema(a.input) as ToolDefinition['inputSchema'],
    }));
}
