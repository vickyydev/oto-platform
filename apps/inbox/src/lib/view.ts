/**
 * The Inbox shell's words, colours and small arithmetic — pure, so the unit
 * tests read the real thing (test/view.test.ts).
 *
 * The labels and the colour code are the prototype's
 * (`imports/oto-asset-manager/artifacts/oto-org-chart/src/WhatsAppDemo.tsx`,
 * `CATEGORY_LABEL`, `CATEGORY_TINT`, `STATUS_*`, `CHANNEL_*`, `LANG_LABEL`,
 * :168-207) and `docs/features/inbox.md` "Colour code". The RULES — tabs,
 * tab membership, unanswered, the move destinations — are not here: they are
 * `@oto/shared/inbox`, which the api counts with too.
 */
import {
  INBOX_DAY_TIMEZONE,
  INBOX_TAB_LABELS,
  teamDestOf,
  type InboxCategoryKey,
  type InboxChannelKey,
  type InboxStatusKey,
  type InboxTab,
} from '@oto/shared/inbox';
import type { Assignee, ConversationRow, InboxEvent, InboxMe, Message, Team } from '@/api/inbox';

// --- The colour code ------------------------------------------------------------

export const CATEGORY_LABEL: Record<InboxCategoryKey, string> = {
  birthdays: 'Birthdays & Events',
  general: 'General',
  marketing: 'Marketing',
};

/** violet = Birthdays & Events, sky = General / reception, pink = Marketing. */
export const CATEGORY_TINT: Record<InboxCategoryKey, string> = {
  birthdays: 'bg-violet-50 text-violet-700 ring-violet-200',
  general: 'bg-sky-50 text-sky-700 ring-sky-200',
  marketing: 'bg-pink-50 text-pink-700 ring-pink-200',
};

/** The stacked bar's segments (`CategoryMixCard`, :1825-1827). */
export const CATEGORY_BAR: Record<InboxCategoryKey, string> = {
  birthdays: 'bg-violet-500',
  general: 'bg-sky-500',
  marketing: 'bg-pink-500',
};

/** The IT Brief's two statuses; the prototype stores Active as "new". */
export const STATUS_LABEL: Record<InboxStatusKey, string> = { active: 'Active', handled: 'Handled' };
export const STATUS_TINT: Record<InboxStatusKey, string> = {
  active: 'bg-blue-50 text-blue-700 ring-blue-200',
  handled: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
};
export const STATUS_DOT: Record<InboxStatusKey, string> = { active: 'bg-blue-500', handled: 'bg-emerald-500' };

/** The prototype's three, plus the platform's own channels in a neutral ink. */
export const CHANNEL_LABEL: Record<InboxChannelKey, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  facebook: 'Facebook',
  line: 'LINE',
  telegram: 'Telegram',
  webform: 'Web form',
};
export const CHANNEL_TINT: Record<InboxChannelKey, string> = {
  whatsapp: 'bg-emerald-500',
  instagram: 'bg-gradient-to-tr from-amber-400 via-pink-500 to-purple-500',
  facebook: 'bg-blue-600',
  line: 'bg-green-600',
  telegram: 'bg-sky-500',
  webform: 'bg-slate-400',
};

/** The filter's languages (`FilterSelect` options, :1456-1458). */
export const LANGUAGE_OPTIONS: [string, string][] = [
  ['en', 'English'],
  ['ru', 'Russian'],
  ['th', 'Thai'],
];

/** `LANG_LABEL` (:207): the code, upper case. */
export function langLabel(code: string | null | undefined): string {
  return code ? code.toUpperCase() : '—';
}

export const TAB_LABEL: Record<InboxTab, string> = INBOX_TAB_LABELS;

// --- People, teams and chips -------------------------------------------------------

/**
 * "Anna Volkova" → "AV"; one word → its first two letters. A desk in brackets
 * ("Demo Vera (Birthdays EN/RU backup)") is the seed's note, not the person,
 * and is left out, as the Console's `displayName` leaves it out.
 */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/·/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

/**
 * The pastel tints the prototype gives its people and contacts (:135-144,
 * `avatarTint`). Each person keeps one for good: picked from their id, so the
 * same person is the same colour on every screen and every day.
 */
export const PASTELS = [
  'bg-violet-100 text-violet-700',
  'bg-teal-100 text-teal-700',
  'bg-emerald-100 text-emerald-700',
  'bg-lime-100 text-lime-700',
  'bg-orange-100 text-orange-700',
  'bg-pink-100 text-pink-700',
  'bg-amber-100 text-amber-700',
  'bg-fuchsia-100 text-fuchsia-700',
  'bg-rose-100 text-rose-700',
  'bg-cyan-100 text-cyan-700',
] as const;

export function tintFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PASTELS[h % PASTELS.length]!;
}

/** A team's chip, in its own colour (`team.colour`: violet, sky, pink). */
const TEAM_TINT: Record<string, string> = {
  violet: 'bg-violet-100 text-violet-700',
  sky: 'bg-sky-100 text-sky-700',
  pink: 'bg-pink-100 text-pink-700',
};

export interface Chip {
  key: string;
  name: string;
  initials: string;
  tint: string;
}

/**
 * How an assignee shows: a person in their fixed pastel — the GM and any
 * other operator-wide reader in no team in `slate-800` (the prototype's
 * "Hanna · GM", :143) — a team (a reception desk) in its team colour, the AI
 * in indigo.
 */
export function assigneeChip(a: Assignee, me: Pick<InboxMe, 'people' | 'teams'>): Chip {
  if (a.assigneeKind === 'ai') {
    return { key: a.assignmentId, name: 'AI Assistant', initials: 'AI', tint: 'bg-indigo-100 text-indigo-700' };
  }
  if (a.assigneeKind === 'team') {
    const team = me.teams.find((t) => t.id === a.teamId);
    const name = a.name ?? team?.name ?? 'Team';
    return { key: a.assignmentId, name, initials: initialsOf(name), tint: TEAM_TINT[team?.colour ?? ''] ?? 'bg-slate-100 text-slate-700' };
  }
  return personChip(a.assignmentId, a.accountId, a.name, me);
}

/**
 * A person's chip, the same on the strip, the list and over their bubbles:
 * their fixed pastel, or `slate-800` for the GM and any other operator-wide
 * reader in no team.
 */
export function personChip(
  key: string,
  accountId: string | null,
  name: string | null,
  me: Pick<InboxMe, 'people'>,
): Chip {
  const person = accountId ? me.people.find((p) => p.accountId === accountId) : undefined;
  const shown = name ?? person?.name ?? 'Someone';
  const manager = person !== undefined && person.operatorWide && person.teamIds.length === 0;
  return {
    key,
    name: shown,
    initials: initialsOf(shown),
    tint: manager ? 'bg-slate-800 text-white' : tintFor(accountId ?? key),
  };
}

export function primaryOf(row: Pick<ConversationRow, 'assignments'>): Assignee | undefined {
  return row.assignments.find((a) => a.slot === 'primary');
}

export function supportsOf(row: Pick<ConversationRow, 'assignments'>): Assignee[] {
  return row.assignments.filter((a) => a.slot === 'support').sort((x, y) => x.slotIndex - y.slotIndex);
}

/** The contact as the list names them: their name, else their handle. */
export function contactName(c: ConversationRow['contact']): string {
  if (c.erased) return 'Erased contact';
  return c.displayName?.trim() || c.handle;
}

// --- Branches ----------------------------------------------------------------------

/**
 * The parks the filter offers. `GET /inbox/me` names no branches of its own,
 * but every park has its reception team ("Reception · Central"), so a park's
 * short name is its reception team's, after the dot.
 */
export function branchOptions(teams: readonly Team[]): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  for (const t of teams) {
    if (t.kind !== 'reception' || !t.branchId || out.some((o) => o.id === t.branchId)) continue;
    const short = t.name.includes('·') ? t.name.split('·').pop()!.trim() : t.name;
    out.push({ id: t.branchId, label: short });
  }
  return out;
}

/** A conversation's park; one with none is the prototype's "all" (:1590). */
export function branchLabel(branchId: string | null, teams: readonly Team[]): string {
  if (!branchId) return 'All';
  return branchOptions(teams).find((b) => b.id === branchId)?.label ?? 'Park';
}

/**
 * The move picker's current value (`CategoryBadge`, :994): the team the
 * conversation sits with, by `teamDestOf` from the shared rules.
 */
export function teamDestLabel(
  row: { category: InboxCategoryKey; branchId: string | null },
  me: Pick<InboxMe, 'teams' | 'defaultReceptionBranchId'>,
): string {
  const dest = teamDestOf(row, me.defaultReceptionBranchId);
  const team = me.teams.find(
    (t) => t.kind === dest.kind && (dest.kind !== 'reception' || t.branchId === dest.branchId),
  );
  return team?.name ?? CATEGORY_LABEL[row.category];
}

// --- Time ----------------------------------------------------------------------------

/** The Bangkok day of an instant, `YYYY-MM-DD` — the parks' day (shared `INBOX_DAY_TIMEZONE`). */
export function dayOf(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: INBOX_DAY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function clock(at: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: INBOX_DAY_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** The list row's stamp: 14:05 today, "Yesterday", a weekday this week, else "12 Oct". */
export function listTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '';
  const at = new Date(iso);
  const gap = daysBetween(dayOf(at), dayOf(now));
  if (gap <= 0) return clock(at);
  if (gap === 1) return 'Yesterday';
  if (gap < 7) return new Intl.DateTimeFormat('en-GB', { timeZone: INBOX_DAY_TIMEZONE, weekday: 'short' }).format(at);
  return new Intl.DateTimeFormat('en-GB', { timeZone: INBOX_DAY_TIMEZONE, day: 'numeric', month: 'short' }).format(at);
}

/** A bubble's stamp: the clock today, the date and clock before. */
export function bubbleTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const gap = daysBetween(dayOf(at), dayOf(now));
  if (gap <= 0) return clock(at);
  if (gap === 1) return `Yesterday ${clock(at)}`;
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: INBOX_DAY_TIMEZONE, day: 'numeric', month: 'short' }).format(at);
  return `${date} ${clock(at)}`;
}

/** The average first response, as the prototype's card shows it: "4m 12s". */
export function durationLabel(seconds: number | null): string {
  if (seconds === null) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** The archive's date range (:1497-1502) as the list route's `handledFrom`. */
export type ArchiveRange = '7d' | '30d' | '90d' | 'all';
export const ARCHIVE_RANGES: [ArchiveRange, string][] = [
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['90d', '90 days'],
  ['all', 'All time'],
];
export function archiveFrom(range: ArchiveRange, now: Date = new Date()): string | undefined {
  if (range === 'all') return undefined;
  const days = { '7d': 7, '30d': 30, '90d': 90 }[range];
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

// --- The timeline --------------------------------------------------------------------

export interface PillContext {
  me: Pick<InboxMe, 'people' | 'teams'>;
}

function personName(ctx: PillContext, accountId: unknown): string | null {
  if (typeof accountId !== 'string') return null;
  return ctx.me.people.find((p) => p.accountId === accountId)?.name ?? null;
}

function teamName(ctx: PillContext, teamId: unknown): string | null {
  if (typeof teamId !== 'string') return null;
  return ctx.me.teams.find((t) => t.id === teamId)?.name ?? null;
}

function actorOf(e: InboxEvent, ctx: PillContext): string {
  if (e.actorKind === 'ai') return 'AI';
  if (e.actorKind === 'customer') return 'the customer';
  if (e.actorKind === 'system') return 'the router';
  return e.actorName ?? personName(ctx, e.actorAccountId) ?? 'a team member';
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/**
 * A system event as its grey pill reads (:2019-2023), in the prototype's
 * wording where it has one ("Routed to …", "Marked as Handled by …",
 * "Reopened by …", "… added … as support"). Null for the events whose content
 * is already on the timeline as a bubble (`received`, `ai_replied`) — the
 * prototype has no pill for those.
 */
export function eventText(e: InboxEvent, ctx: PillContext): string | null {
  const p = e.payload;
  const slot = p.slot === 'primary' ? 'primary' : 'support';
  const assignee = () =>
    personName(ctx, p.accountId) ?? teamName(ctx, p.teamId) ?? (p.assigneeKind === 'ai' ? 'the AI Assistant' : 'someone');
  switch (e.kind) {
    case 'received':
    case 'ai_replied':
      return null;
    case 'classified': {
      const parts = ['AI'];
      if (str(p.language)) parts.push(`Language: ${langLabel(str(p.language))}`);
      if (str(p.intent)) parts.push(`Intent: ${str(p.intent)}`);
      return parts.length > 1 ? parts.join(' · ') : 'AI · Classified';
    }
    case 'routed': {
      const lang = str(p.language);
      const team = teamName(ctx, p.teamId) ?? 'the team';
      return `${lang ? `Language: ${langLabel(lang)} · ` : ''}Routed to ${team}`;
    }
    case 'assigned':
      return e.actorKind === 'account'
        ? `${actorOf(e, ctx)} added ${assignee()} as ${slot}`
        : `Assigned ${assignee()} as ${slot}`;
    case 'released':
      return `${actorOf(e, ctx)} removed ${assignee()} (${slot})`;
    case 'diverted':
      return `Diverted to ${assignee()} by ${actorOf(e, ctx)}`;
    case 'moved_team': {
      const to = teamName(ctx, p.toTeamId) ?? teamName(ctx, p.teamId);
      const from = teamName(ctx, p.fromTeamId);
      if (from && to) return `Moved from ${from} → ${to} by ${actorOf(e, ctx)}`;
      return `Moved${to ? ` to ${to}` : ''} by ${actorOf(e, ctx)}`;
    }
    case 'branch_set':
      return `Branch set by ${actorOf(e, ctx)}`;
    case 'handled':
      return e.actorKind === 'ai' ? 'Marked as Handled by AI · Auto-resolved' : `Marked as Handled by ${actorOf(e, ctx)}`;
    case 'reopened':
      return p.automatic === true ? 'Reopened · the customer wrote again' : `Reopened by ${actorOf(e, ctx)}`;
    case 'date_booked':
      return `Date blocked in POS by ${actorOf(e, ctx)}`;
    case 'beo_saved':
      return `BEO saved by ${actorOf(e, ctx)}`;
    case 'translated':
      return 'Translated';
    case 'pos_update':
      return 'Updated from the POS';
    case 'sla_breached':
      return 'Waiting longer than usual';
    case 'notice_mirrored':
      return 'Check-in notice sent from the till';
    default:
      return e.kind.replace(/_/g, ' ');
  }
}

export type TimelineItem =
  | { kind: 'message'; at: string; message: Message }
  | { kind: 'pill'; at: string; id: string; text: string };

/**
 * Messages and system pills in one column, oldest first (the prototype keeps
 * them in one array, :2017). Only the newest page of messages is loaded at
 * first, so a pill older than the oldest loaded message waits until that
 * earlier page is — unless the page already reaches the start of the thread.
 */
export function timeline(
  messages: readonly Message[],
  events: readonly InboxEvent[],
  reachesStart: boolean,
  ctx: PillContext,
): TimelineItem[] {
  const oldest = messages[0]?.createdAt;
  const items: TimelineItem[] = messages.map((m) => ({ kind: 'message', at: m.createdAt, message: m }));
  for (const e of events) {
    if (!reachesStart && oldest !== undefined && e.createdAt < oldest) continue;
    const text = eventText(e, ctx);
    if (text !== null) items.push({ kind: 'pill', at: e.createdAt, id: e.id, text });
  }
  // Stable on ties: a pill written in the same instant as its message follows it.
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (a.item.at < b.item.at ? -1 : a.item.at > b.item.at ? 1 : a.i - b.i))
    .map(({ item }) => item);
}

// --- What the viewer may do, and the write switch ----------------------------------

/**
 * The write switch (plan §4.3, "How Cut A is marked"). While `GET /inbox/me`
 * says `writes: false`, every write control renders, disabled, with the reason
 * below — the same component Cut B enables. If the api ever says `true` before
 * this shell carries the wiring (I3b), the controls are HIDDEN rather than
 * shown live: a button that looks pressable and does nothing is worse than
 * none.
 */
export type WriteMode = 'disabled' | 'hidden';
export const WRITES_PENDING_REASON = 'Coming with the channel connection';
/** Book Date and Create BEO, in both cuts (owner Q23). */
export const EVENT_ORDERS_REASON = 'With the event orders (open decision)';

export function writeMode(me: Pick<InboxMe, 'capabilities'>): WriteMode {
  return me.capabilities.writes ? 'hidden' : 'disabled';
}

/** Reads every conversation of the operator: the prototype's owner view. */
export function isOwnerView(me: Pick<InboxMe, 'roles'>): boolean {
  return me.roles.includes('owner');
}

/**
 * Who would see "Mark as Handled" (`canHandle`, :1873-1875): the owner, or
 * someone on the conversation — and, on the platform, anyone in its team
 * (feature doc: support "can read, reply and mark handled"; the plan's
 * `handle` route takes the actor on it or in its team).
 */
export function canHandle(
  row: Pick<ConversationRow, 'status' | 'mine' | 'teamId'>,
  me: Pick<InboxMe, 'roles' | 'teams'>,
): boolean {
  if (row.status === 'handled') return false;
  if (isOwnerView(me) || row.mine) return true;
  return me.teams.some((t) => t.member && t.id === row.teamId);
}

/** The tab to open on: Team, as the prototype opens (:1035), when the viewer has it. */
export function defaultTab(tabs: readonly InboxTab[]): InboxTab {
  return tabs.includes('team') ? 'team' : (tabs[0] ?? 'team');
}
