import {
  ASSISTANT_SUMMARY_MAX_BYTES,
  ASSISTANT_SUMMARY_ROWS,
  ASSISTANT_TOOLS,
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
 * WHAT A SUMMARY LEAVES OUT, on purpose: a child's allergy and medical text
 * unless the model asked for them (`include: ['allergies']`, §B.4); an Inbox
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

export interface PlatformToolAdapter {
  name: string;
  routes: readonly GetRouteTemplate[];
  description: string;
  /** The registry's own schema: the arguments are validated against it before any call. */
  input: z.ZodTypeAny;
  urls(input: never): string[];
  summarise(bodies: unknown[], input: never, now: Date): SummaryDraft;
  deepLink(input: never): { key: string; params: Record<string, string> } | null;
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

/** A member as the model reads it (lookup and get): never the email, never the tier evidence. */
function memberSummary(m: Obj, includeAllergies: boolean, now: Date): Obj {
  const children = arr(m.children).map((c) => {
    const child = obj(c);
    return {
      name: str(child.name),
      age: ageOf(child, now),
      // A flag, not the text, unless the question was about it (§B.4).
      medicalAlert: child.medicalAlert === true || hasText(child.allergies) || hasText(child.medicalNotes),
      hasAllergies: hasText(child.allergies),
      ...(includeAllergies
        ? { allergies: str(child.allergies), medicalNotes: str(child.medicalNotes) }
        : {}),
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

const MemberInclude = (input: { include?: readonly string[] | undefined }) => (input.include ?? []).includes('allergies');

// --- The ten -----------------------------------------------------------------------------

type Spec = (typeof ASSISTANT_TOOLS)[number];
type SpecOf<N extends Spec['name']> = Extract<Spec, { name: N }>;
type In<N extends Spec['name']> = z.infer<SpecOf<N>['input']>;

interface AdapterBody<N extends Spec['name']> {
  urls(input: In<N>): string[];
  summarise(bodies: unknown[], input: In<N>, now: Date): SummaryDraft;
  deepLink?(input: In<N>): { key: string; params: Record<string, string> } | null;
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
  };
}

const enc = encodeURIComponent;

export const PLATFORM_TOOL_ADAPTERS: readonly PlatformToolAdapter[] = [
  adapter('audit.search', {
    urls: (i) => [
      `/audit${query({ action: i.action, entityType: i.entityType, from: i.from, to: i.to, limit: ASSISTANT_SUMMARY_ROWS })}`,
    ],
    summarise: ([body], i) => {
      const b = obj(body);
      const entries = arr(b.entries).map((e) => {
        const r = obj(e);
        // Who, what, to what, when — never the before/after payloads.
        return {
          action: str(r.action),
          entityType: str(r.entityType),
          entityId: str(r.entityId),
          actorAccountId: str(r.actorAccountId),
          branchId: str(r.branchId),
          at: bangkokTime(r.createdAt),
        };
      });
      return {
        data: {
          period: {
            from: i.from ? bangkokTime(i.from) : null,
            to: i.to ? bangkokTime(i.to) : null,
          },
          masked: b.masked === true,
          shown: entries.length,
          moreOnTheScreen: b.nextCursor ? true : false,
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
  }),
  adapter('members.lookup', {
    urls: (i) => [`/members/lookup${query({ phone: i.phone })}`],
    summarise: ([body], i, now) => {
      const m = obj(body).member;
      return m
        ? { data: { found: true, member: memberSummary(obj(m), MemberInclude(i), now) }, rows: 1 }
        : { data: { found: false, member: null }, rows: 0 };
    },
  }),
  adapter('members.search', {
    urls: (i) => [`/members${query({ q: i.q, limit: ASSISTANT_SUMMARY_ROWS })}`],
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
    summarise: ([body], i, now) => {
      const b = obj(body);
      const businessDate = str(b.businessDate);
      return {
        data: {
          branchId: i.branchId,
          inside: { adults: num(b.adults) ?? 0, children: num(b.kids) ?? 0, total: num(b.total) ?? 0 },
          tradingDay: businessDate ? `${businessDate} (${dayWords(businessDate)})` : null,
          countedAt: bangkokTime(b.asOf),
          asOf: nowWords(now),
          // The gate behind the count has not been heard from lately: the figure may be behind.
          stale: b.stale === true,
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
