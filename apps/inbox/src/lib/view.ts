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
  INBOX_CATEGORY_KEYS,
  INBOX_DAY_TIMEZONE,
  INBOX_TAB_LABELS,
  teamDestOf,
  type InboxCategoryKey,
  type InboxChannelKey,
  type InboxStatusKey,
  type InboxTab,
} from '@oto/shared/inbox';
import type {
  Assignee,
  ConversationRow,
  InboxEvent,
  InboxMe,
  Message,
  MoveDest,
  PrimaryAssignee,
  Team,
} from '@/api/inbox';

// --- The colour code ------------------------------------------------------------

export const CATEGORY_LABEL: Record<InboxCategoryKey, string> = {
  birthdays: 'Birthdays & Events',
  general: 'General',
  marketing: 'Marketing',
  /** The playbook's general-manager queue (SCRUM-220). */
  gm: 'GM',
};

/**
 * violet = Birthdays & Events, sky = General / reception, pink = Marketing;
 * amber = the GM queue (SCRUM-220 playbook), the GM team's seeded colour.
 */
export const CATEGORY_TINT: Record<InboxCategoryKey, string> = {
  birthdays: 'bg-violet-50 dark:bg-violet-500/15 text-violet-700 dark:text-violet-300 ring-violet-200 dark:ring-violet-500/30',
  general: 'bg-sky-50 dark:bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-sky-200 dark:ring-sky-500/30',
  marketing: 'bg-pink-50 dark:bg-pink-500/15 text-pink-700 dark:text-pink-300 ring-pink-200 dark:ring-pink-500/30',
  gm: 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-200 dark:ring-amber-500/30',
};

/** The stacked bar's segments (`CategoryMixCard`, :1825-1827). */
export const CATEGORY_BAR: Record<InboxCategoryKey, string> = {
  birthdays: 'bg-violet-500',
  general: 'bg-sky-500',
  marketing: 'bg-pink-500',
  gm: 'bg-amber-500',
};

/** The IT Brief's two statuses; the prototype stores Active as "new". */
export const STATUS_LABEL: Record<InboxStatusKey, string> = { active: 'Active', handled: 'Handled' };
export const STATUS_TINT: Record<InboxStatusKey, string> = {
  active: 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-300 ring-blue-200 dark:ring-blue-500/30',
  handled: 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-200 dark:ring-emerald-500/30',
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

/**
 * The filter's categories and statuses (`FilterSelect` options, :1447-1455),
 * from the colour code's labels; every category the api names, the GM queue
 * (SCRUM-220 playbook) among them.
 */
export const CATEGORY_OPTIONS: [InboxCategoryKey, string][] = INBOX_CATEGORY_KEYS.map(
  (k): [InboxCategoryKey, string] => [k, CATEGORY_LABEL[k]],
);
export const STATUS_OPTIONS: [InboxStatusKey, string][] = (['active', 'handled'] as const).map(
  (k): [InboxStatusKey, string] => [k, STATUS_LABEL[k]],
);

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
  'bg-violet-100 dark:bg-violet-500/25 text-violet-700 dark:text-violet-300',
  'bg-teal-100 dark:bg-teal-500/25 text-teal-700 dark:text-teal-300',
  'bg-emerald-100 dark:bg-emerald-500/25 text-emerald-700 dark:text-emerald-300',
  'bg-lime-100 dark:bg-lime-500/25 text-lime-700 dark:text-lime-300',
  'bg-orange-100 dark:bg-orange-500/25 text-orange-700 dark:text-orange-300',
  'bg-pink-100 dark:bg-pink-500/25 text-pink-700 dark:text-pink-300',
  'bg-amber-100 dark:bg-amber-500/25 text-amber-700 dark:text-amber-300',
  'bg-fuchsia-100 dark:bg-fuchsia-500/25 text-fuchsia-700 dark:text-fuchsia-300',
  'bg-rose-100 dark:bg-rose-500/25 text-rose-700 dark:text-rose-300',
  'bg-cyan-100 dark:bg-cyan-500/25 text-cyan-700 dark:text-cyan-300',
] as const;

export function tintFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PASTELS[h % PASTELS.length]!;
}

/** A team's chip, in its own colour (`team.colour`: violet, sky, pink). */
const TEAM_TINT: Record<string, string> = {
  violet: 'bg-violet-100 dark:bg-violet-500/25 text-violet-700 dark:text-violet-300',
  sky: 'bg-sky-100 dark:bg-sky-500/25 text-sky-700 dark:text-sky-300',
  pink: 'bg-pink-100 dark:bg-pink-500/25 text-pink-700 dark:text-pink-300',
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
    return { key: a.assignmentId, name: 'AI Assistant', initials: 'AI', tint: 'bg-indigo-100 dark:bg-indigo-500/25 text-indigo-700 dark:text-indigo-300' };
  }
  if (a.assigneeKind === 'team') {
    const team = me.teams.find((t) => t.id === a.teamId);
    const name = a.name ?? team?.name ?? 'Team';
    return { key: a.assignmentId, name, initials: initialsOf(name), tint: TEAM_TINT[team?.colour ?? ''] ?? 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200' };
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
    tint: manager ? 'bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900' : tintFor(accountId ?? key),
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
 * The park a conversation is actually at (test night 2026-10-21, U9): its own
 * branch, or — with none — the park of the reception desk it sits with, since
 * `teamDestOf` puts a general thread with no branch at the first park's desk.
 * A thread with Reception · Central Floresta as its team is at Central
 * Floresta, not "All branches". Null when neither names a park.
 */
export function effectiveBranchId(row: { branchId: string | null; teamId: string | null }, teams: readonly Team[]): string | null {
  if (row.branchId) return row.branchId;
  const desk = row.teamId ? teams.find((t) => t.id === row.teamId && t.kind === 'reception') : undefined;
  return desk?.branchId ?? null;
}

/**
 * The category badge says the topic ("General"); the team says who handles it
 * ("Reception · Central Floresta"). They are two things, and a reception
 * person misread them as one (test night U9), so the badge's tooltip says
 * which is which.
 */
export function categoryTitle(category: InboxCategoryKey, teamName: string | null): string {
  const topic = `Topic: ${CATEGORY_LABEL[category]} — what the conversation is about.`;
  return teamName ? `${topic} Team: ${teamName} — who handles it.` : topic;
}

/**
 * A Facebook or Instagram handle is the platform's numeric id, which reads
 * like a phone number (test night U9): it is labelled so nobody dials it.
 * Null on the channels whose handle is self-explaining (a WhatsApp number).
 */
export function handleLabel(channel: InboxChannelKey): string | null {
  if (channel === 'facebook') return 'Facebook ID';
  if (channel === 'instagram') return 'Instagram ID';
  return null;
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
export type ArchiveRange = 'today' | '7d' | '30d' | '90d' | 'all';
export const ARCHIVE_RANGES: [ArchiveRange, string][] = [
  ['today', 'Today'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['90d', '90 days'],
  ['all', 'All time'],
];
/**
 * `today` is the park's day, the one the dashboard's "Handled today" counts:
 * from midnight in Asia/Bangkok, which keeps no daylight saving, so the offset
 * is a fixed seven hours.
 */
const BANGKOK_OFFSET_MS = 7 * 3_600_000;
export function archiveFrom(range: ArchiveRange, now: Date = new Date()): string | undefined {
  if (range === 'all') return undefined;
  if (range === 'today') {
    const local = new Date(now.getTime() + BANGKOK_OFFSET_MS);
    return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - BANGKOK_OFFSET_MS).toISOString();
  }
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
      return null;
    // The bubbles say an answer; a rethought one (SCRUM-678) also says the assistant corrected itself.
    case 'ai_replied':
      return rethought(p) ? 'AI re-read the message before replying' : null;
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
    case 'released':
      // A Divert's four seat changes are said once, by its own "Diverted to …" pill.
      if (p.reason === 'divert') return null;
      if (e.kind === 'released') return `${actorOf(e, ctx)} removed ${assignee()} (${slot})`;
      return e.actorKind === 'account'
        ? `${actorOf(e, ctx)} added ${assignee()} as ${slot}`
        : `Assigned ${assignee()} as ${slot}`;
    case 'diverted':
      // The action names the new primary `toAccountId` (I2e `divert`).
      return `Diverted to ${personName(ctx, p.toAccountId) ?? assignee()} by ${actorOf(e, ctx)}`;
    case 'moved_team': {
      const to = teamName(ctx, p.toTeamId) ?? teamName(ctx, p.teamId);
      const from = teamName(ctx, p.fromTeamId);
      // The prototype's pill when a cross-team primary took it (:1158).
      if (p.followsPrimary === true && from && to) return `Auto-moved from ${from} → ${to} (follows primary owner)`;
      if (from && to) return `Moved from ${from} → ${to} by ${actorOf(e, ctx)}`;
      return `Moved${to ? ` to ${to}` : ''} by ${actorOf(e, ctx)}`;
    }
    case 'branch_set': {
      // The branch by name (test night U9): the api's `after.branchName` when
      // it is there, else the payload's `toBranchId` through the parks' desks.
      const after = p.after !== null && typeof p.after === 'object' ? (p.after as Record<string, unknown>) : {};
      const to = 'toBranchId' in p ? p.toBranchId : after.branchId;
      const name = str(after.branchName) ?? (typeof to === 'string' ? branchLabel(to, ctx.me.teams) : null);
      if (name !== null) return `Branch set to ${name === 'All' ? 'all branches' : name} by ${actorOf(e, ctx)}`;
      if (to === null) return `Branch set to all branches by ${actorOf(e, ctx)}`;
      return `Branch set by ${actorOf(e, ctx)}`;
    }
    // The per-thread pause and its undo (SCRUM-590 §A.3; test night U5): the
    // api's `ai_paused` says what it stopped (`turnsCancelled`,
    // `messagesWithdrawn`), `ai_resumed` carries nothing.
    case 'ai_paused': {
      const withdrawn = typeof p.messagesWithdrawn === 'number' && p.messagesWithdrawn > 0 ? p.messagesWithdrawn : 0;
      return `AI paused by ${actorOf(e, ctx)}${withdrawn > 0 ? ` · ${withdrawn} line${withdrawn === 1 ? '' : 's'} withdrawn` : ''}`;
    }
    case 'ai_resumed':
      return `AI resumed by ${actorOf(e, ctx)}`;
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
    case 'send_failed':
      // The channel's own refusal word, as the send job recorded it.
      return str(p.refusal) ? `Reply not sent · ${str(p.refusal)}` : 'Reply not sent';
    // The assistant's three (SCRUM-590 §D.3). Payloads carry ids and words only
    // (`ai-engine.ts`, `ai-turns.ts`), never a body.
    case 'ai_handover': {
      const team = teamName(ctx, p.reroutedTeamId);
      const intent = str(p.intent);
      const notes = turnNotes(p);
      return `AI handed over to ${team ?? 'the team'}${intent ? ` · ${intentWords(intent)}` : ''}${notes.map((n) => ` · ${n}`).join('')}`;
    }
    case 'ai_silent':
      // §B.3: the pill says only that the assistant left this one for a person.
      return 'AI left this one for the team';
    case 'ai_withdrawn':
      return `AI reply not sent · ${withdrawnWhy(p.reason)}`;
    case 'ai_shadow': {
      // What the shadow turn would have done (W5); its lines are the shadow row, never this pill.
      const did =
        p.action === 'answer'
          ? 'would have answered'
          : p.action === 'handover'
            ? 'would have handed over'
            : p.action === 'silent'
              ? 'would have stayed silent'
              : null;
      const intent = str(p.intent);
      return `AI in shadow${did ? ` · ${did}` : ''}${intent ? ` · ${intentWords(intent)}` : ''}`;
    }
    default:
      return e.kind.replace(/_/g, ' ');
  }
}

/** SCRUM-678: the turn was decided again after the reviewer read its first reply as off the topic. */
function rethought(p: Record<string, unknown>): boolean {
  return p.rethink !== null && typeof p.rethink === 'object' && (p.rethink as Record<string, unknown>).rethought === true;
}

/**
 * What the assistant did to its own reply on the way out, from the turn's
 * records (never text): it re-read the message (SCRUM-678), and the lines the
 * coherence review left out (SCRUM-677).
 */
function turnNotes(p: Record<string, unknown>): string[] {
  const notes: string[] = [];
  if (rethought(p)) notes.push('re-read the message');
  const c = p.coherence !== null && typeof p.coherence === 'object' ? (p.coherence as Record<string, unknown>) : null;
  const dropped = c?.state === 'reviewed' && Array.isArray(c.dropped) ? c.dropped.length : 0;
  if (dropped > 0) notes.push(`${dropped} line${dropped === 1 ? '' : 's'} left out`);
  return notes;
}

/** An intent word as staff read it: `birthday_party` → "birthday party". */
function intentWords(intent: string): string {
  return intent.replace(/_/g, ' ');
}

/**
 * Why an AI line was withdrawn before it left (§A.3), from the cancel reason
 * the api records (`cancelAiForThread`: STAFF_REPLY, ASSIGNED, HANDLED,
 * ERASED, PAUSED). The plan's wording, "a person replied", is the common one.
 */
export function withdrawnWhy(reason: unknown): string {
  switch (reason) {
    case 'ASSIGNED':
      return 'a person took the conversation';
    case 'HANDLED':
      return 'the conversation was handled';
    case 'PAUSED':
      return 'the assistant was paused';
    case 'ERASED':
      return 'the contact was erased';
    default:
      return 'a person replied';
  }
}

/**
 * The withdrawn bubbles of a thread, by message id, with the words under each
 * (`Not sent: a person replied`, plan §A.3) — read from the `ai_withdrawn`
 * events, which name the message.
 */
export function withdrawnNotes(messages: readonly Message[], events: readonly InboxEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) {
    if (e.kind !== 'ai_withdrawn' || typeof e.payload.messageId !== 'string') continue;
    out.set(e.payload.messageId, `Not sent: ${withdrawnWhy(e.payload.reason)}`);
  }
  // A withdrawn row whose event is on an older page still says it was not sent.
  for (const m of messages) {
    if (m.providerStatus === 'withdrawn' && !out.has(m.id)) out.set(m.id, `Not sent: ${withdrawnWhy(undefined)}`);
  }
  return out;
}

export type PillItem = { kind: 'pill'; at: string; id: string; text: string; event: string };

export type TimelineItem =
  | { kind: 'message'; at: string; message: Message }
  | PillItem
  /**
   * A shadow row: what the assistant would have said in shadow mode — never
   * sent (customer-AI test night, W5). `label` names a row that is no reply:
   * the reviewer's reading of a message the assistant re-read (SCRUM-678).
   */
  | { kind: 'shadow'; at: string; id: string; text: string; turnId: string | null; label?: string }
  /** A run of system pills from one actor and moment, said in one line, expandable (customer-AI test night, W7). */
  | { kind: 'group'; at: string; id: string; summary: string; pills: PillItem[] };

/**
 * A shadow turn (customer-AI test night, W5) is ONE message row the assistant
 * wrote and never sent — `authorKind` ai, `providerStatus` 'shadow', the
 * would-be lines joined by newlines — plus an `ai_shadow` pill whose payload
 * names the row (`messageId`) and the turn, never any text. The status is the
 * customer-AI lane's, read as a string until the api describes it.
 */
export const SHADOW_EVENT_KIND = 'ai_shadow';
export const SHADOW_MESSAGE_STATUS = 'shadow';
export const SHADOW_LABEL = 'Shadow suggestion — not sent';
/** SCRUM-678: the row holding the coherence reviewer's reading of the customer's message. */
export const RETHINK_READING_LABEL = 'How the assistant re-read the message — not sent';

/** The reading rows the thread's rethink records name (`rethink.readingMessageId`). */
function readingRows(events: readonly InboxEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    const r = e.payload.rethink;
    if (r !== null && typeof r === 'object' && typeof (r as Record<string, unknown>).readingMessageId === 'string') {
      out.add((r as Record<string, unknown>).readingMessageId as string);
    }
  }
  return out;
}

export function isShadowMessage(m: Pick<Message, 'providerStatus'>): boolean {
  return (m.providerStatus as string | null) === SHADOW_MESSAGE_STATUS;
}

/** The turn behind a shadow row: the `ai_shadow` pill that names it. */
function shadowTurnId(events: readonly InboxEvent[], messageId: string): string | null {
  const e = events.find((x) => x.kind === SHADOW_EVENT_KIND && x.payload.messageId === messageId);
  return e ? str(e.payload.turnId) : null;
}

/**
 * Where an AI hand-over's pills sit (SCRUM-677). The api writes the hand-over
 * — and the routing it causes — at the moment the turn is decided, and the
 * turn's bubbles a millisecond apart after it, so by time the "AI handed
 * over" line landed between the bubbles. The event times are the audit's and
 * stay as written: only the PLACE moves. Every pill of the hand-over's moment
 * (same instant, not a person's) is placed after the last loaded bubble the
 * hand-over names (`messageIds`). Event id → the time to sort it by.
 */
function handoverPlaces(messages: readonly Message[], events: readonly InboxEvent[]): Map<string, string> {
  const at = new Map(messages.map((m) => [m.id, m.createdAt]));
  const out = new Map<string, string>();
  for (const h of events) {
    if (h.kind !== 'ai_handover' || !Array.isArray(h.payload.messageIds)) continue;
    let last: string | null = null;
    for (const id of h.payload.messageIds) {
      const t = typeof id === 'string' ? at.get(id) : undefined;
      if (t !== undefined && (last === null || t > last)) last = t;
    }
    if (last === null || last <= h.createdAt) continue;
    for (const e of events) if (e.createdAt === h.createdAt && e.actorKind !== 'account') out.set(e.id, last);
  }
  return out;
}

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
  const readings = readingRows(events);
  const items: TimelineItem[] = messages.map((m) =>
    isShadowMessage(m)
      ? {
          kind: 'shadow',
          at: m.createdAt,
          id: m.id,
          text: m.body ?? '',
          turnId: shadowTurnId(events, m.id),
          ...(readings.has(m.id) ? { label: RETHINK_READING_LABEL } : {}),
        }
      : { kind: 'message', at: m.createdAt, message: m },
  );
  for (const e of events) {
    if (!reachesStart && oldest !== undefined && e.createdAt < oldest) continue;
    const text = eventText(e, ctx);
    if (text !== null) items.push({ kind: 'pill', at: e.createdAt, id: e.id, text, event: e.kind });
  }
  const placed = handoverPlaces(messages, events);
  const keyOf = (item: TimelineItem) => (item.kind === 'pill' ? (placed.get(item.id) ?? item.at) : item.at);
  // Stable on ties: a pill written in the same instant as its message follows it.
  const sorted = items
    .map((item, i) => ({ item, i, key: keyOf(item) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i))
    .map(({ item }) => item);
  return collapsePills(sorted, new Map(events.map((e) => [e.id, e])), ctx);
}

// --- Runs of system pills, in one line (customer-AI test night, W7) ----------------------------

/** Pills closer than this, from one actor, are one moment. */
export const PILL_GROUP_GAP_MS = 60_000;

/** One actor: the AI and the router act within the same moment; a person is themselves. */
function actorKeyOf(e: InboxEvent): string {
  return e.actorKind === 'account' ? `account:${e.actorAccountId ?? e.actorName ?? ''}` : 'auto';
}

/** The pill that heads a group's line when it is not a hand-over, most telling first. */
const HEADLINE_ORDER = ['ai_handover', 'ai_shadow', 'moved_team', 'diverted', 'branch_set', 'handled', 'reopened', 'routed', 'assigned', 'released'];

/**
 * One AI hand-over put about seven pills in a thread (classified, released,
 * moved, routed, assigned twice, handed over). Consecutive pills from one
 * actor within one moment collapse into one line — a hand-over says where it
 * went and who it seated, with the brochure; any other run leads with its
 * most telling pill and counts the rest — expandable to the pills. An
 * `ai_silent` pill stays on its own: its "Correct the assistant" must stay
 * in view.
 */
export function collapsePills(items: readonly TimelineItem[], eventsById: ReadonlyMap<string, InboxEvent>, ctx: PillContext): TimelineItem[] {
  const out: TimelineItem[] = [];
  let run: { item: PillItem; event: InboxEvent }[] = [];
  const flush = () => {
    if (run.length >= 2) {
      const first = run[0]!;
      out.push({ kind: 'group', at: first.item.at, id: `group:${first.item.id}`, summary: groupSummary(run, ctx), pills: run.map((r) => r.item) });
    } else {
      out.push(...run.map((r) => r.item));
    }
    run = [];
  };
  for (const item of items) {
    const event = item.kind === 'pill' ? eventsById.get(item.id) : undefined;
    if (item.kind !== 'pill' || event === undefined || item.event === 'ai_silent') {
      flush();
      out.push(item);
      continue;
    }
    const last = run[run.length - 1];
    if (last && (actorKeyOf(last.event) !== actorKeyOf(event) || Date.parse(item.at) - Date.parse(last.item.at) > PILL_GROUP_GAP_MS)) flush();
    run.push({ item, event });
  }
  flush();
  return out;
}

/** The one line for a run of pills. */
export function groupSummary(run: readonly { item: Pick<PillItem, 'text'>; event: InboxEvent }[], ctx: PillContext): string {
  const seatName = (p: Record<string, unknown>): string | null =>
    personName(ctx, p.accountId) ?? teamName(ctx, p.teamId) ?? (p.assigneeKind === 'ai' ? 'the AI Assistant' : null);
  const handover = run.find((r) => r.event.kind === 'ai_handover');
  if (handover) {
    const p = handover.event.payload;
    const team = teamName(ctx, p.reroutedTeamId) ?? 'the team';
    const parts: string[] = [];
    if (Array.isArray(p.brochureFileIds) && p.brochureFileIds.length > 0) parts.push('brochure sent');
    parts.push(...turnNotes(p));
    const primary = run.find((r) => r.event.kind === 'assigned' && r.event.payload.slot === 'primary');
    const primaryName = primary ? seatName(primary.event.payload) : null;
    if (primaryName) parts.push(`${primaryName} primary`);
    const supports = run
      .filter((r) => r.event.kind === 'assigned' && r.event.payload.slot === 'support')
      .map((r) => seatName(r.event.payload))
      .filter((n): n is string => n !== null);
    if (supports.length > 0) parts.push(`${supports.join(' and ')} support`);
    return `AI handed over to ${team}${parts.length > 0 ? ` — ${parts.join(', ')}` : ''}`;
  }
  const rank = (kind: string) => {
    const i = HEADLINE_ORDER.indexOf(kind);
    return i < 0 ? HEADLINE_ORDER.length : i;
  };
  const head = [...run].sort((a, b) => rank(a.event.kind) - rank(b.event.kind))[0]!;
  return `${head.item.text} · ${run.length - 1} more`;
}

// --- A message's attachments (customer-AI test night, W7) ----------------------------------------

/** The birthday brochure, named from the assistant's own events (`brochureFileIds`). */
export const BROCHURE_NAME = 'Birthday brochure';

/** File id → name, for the files the thread's events name: today, the brochure. */
export function attachmentNames(events: readonly InboxEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) {
    if (e.kind !== 'ai_replied' && e.kind !== 'ai_handover') continue;
    const ids = e.payload.brochureFileIds;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) if (typeof id === 'string') out.set(id, BROCHURE_NAME);
  }
  return out;
}

export interface Attachment {
  fileId: string;
  /** The file's name, when anything names it: the api's `media` entry, else the thread's events; null means "Attachment". */
  name: string | null;
  /** A URL the api minted for it, when its `media` entry carries one; else the files api is asked on a press. */
  url: string | null;
  contentType: string | null;
}

/**
 * What a message carries, as the screen shows it: the file ids the row has
 * today, with a name where one is known, and — read optionally — the api's
 * `media` entries (`fileId`, `name`, `url`, `contentType`) when it adds them.
 */
export function attachmentsOf(
  m: Pick<Message, 'mediaFileIds' | 'audioFileId'>,
  names: ReadonlyMap<string, string> = new Map(),
): Attachment[] {
  const own = (m as { media?: unknown }).media;
  const entries = new Map<string, { name: string | null; url: string | null; contentType: string | null }>();
  if (Array.isArray(own)) {
    for (const raw of own) {
      if (raw === null || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const id = str(r.fileId) ?? str(r.id);
      if (id === null) continue;
      entries.set(id, { name: str(r.name), url: str(r.url), contentType: str(r.contentType) });
    }
  }
  const ids = [...m.mediaFileIds, ...(m.audioFileId ? [m.audioFileId] : [])];
  for (const id of entries.keys()) if (!ids.includes(id)) ids.push(id);
  return ids.map((fileId) => {
    const e = entries.get(fileId);
    return { fileId, name: e?.name ?? names.get(fileId) ?? null, url: e?.url ?? null, contentType: e?.contentType ?? null };
  });
}

// --- What the viewer may do, and the write switch ----------------------------------

/**
 * The write switch (plan §4.3, "How Cut A is marked"). While `GET /inbox/me`
 * says `writes: false`, every write control renders, disabled, with the reason
 * below; with `writes: true` (since I2f) the same controls are live (I3b).
 */
export type WriteMode = 'disabled' | 'live';
export const WRITES_PENDING_REASON = 'Coming with the channel connection';
/** Book Date and Create BEO, in both cuts (owner Q23). */
export const EVENT_ORDERS_REASON = 'With the event orders (open decision)';
/** The composer's emoji and attachment buttons: the reply route takes words and templates only. */
export const COMPOSER_EXTRAS_REASON = 'Not in this build yet';

export function writeMode(me: Pick<InboxMe, 'capabilities'>): WriteMode {
  return me.capabilities.writes ? 'live' : 'disabled';
}

// --- The move-team badge -----------------------------------------------------------

export type MoveOption = { value: string; label: string; dest: MoveDest };

/**
 * The move picker's four destinations (`CategoryBadge`, :1003-1008):
 * Birthdays & Events, each park's reception desk, Marketing — named by the
 * operator's own teams, in the prototype's order.
 */
export function moveOptions(me: Pick<InboxMe, 'teams'>): MoveOption[] {
  const out: MoveOption[] = [];
  const birthdays = me.teams.find((t) => t.kind === 'birthdays');
  if (birthdays) out.push({ value: 'birthdays', label: birthdays.name, dest: { kind: 'birthdays' } });
  for (const t of me.teams) {
    if (t.kind !== 'reception' || !t.branchId) continue;
    out.push({ value: `reception:${t.branchId}`, label: t.name, dest: { kind: 'reception', branchId: t.branchId } });
  }
  const marketing = me.teams.find((t) => t.kind === 'marketing');
  if (marketing) out.push({ value: 'marketing', label: marketing.name, dest: { kind: 'marketing' } });
  // The playbook's GM queue (SCRUM-220), operator-wide: after the prototype's four.
  const gm = me.teams.find((t) => t.kind === 'gm');
  if (gm) out.push({ value: 'gm', label: gm.name, dest: { kind: 'gm' } });
  return out;
}

/** The picker's current value: where `teamDestOf` puts the conversation. */
export function moveValue(
  row: { category: InboxCategoryKey; branchId: string | null },
  me: Pick<InboxMe, 'defaultReceptionBranchId'>,
): string {
  const dest = teamDestOf(row, me.defaultReceptionBranchId);
  return dest.kind === 'reception' ? `reception:${dest.branchId}` : dest.kind;
}

// --- The slot pickers ----------------------------------------------------------------

export type SlotOption = { value: string; label: string; assignee: PrimaryAssignee };

/**
 * Who a slot picker offers (`SlotPicker`, :810-818): every person who can
 * hold a place but those already on the conversation — one place per person
 * (:1142) — then, for the primary only, the reception desks, which a
 * reception thread is owned by (a phone, never a person's name).
 */
export function slotOptions(
  row: Pick<ConversationRow, 'assignments'>,
  me: Pick<InboxMe, 'people' | 'teams'>,
  slot: 'primary' | 'support',
): SlotOption[] {
  const seatedAccounts = new Set(row.assignments.flatMap((a) => (a.accountId ? [a.accountId] : [])));
  const seatedTeams = new Set(row.assignments.flatMap((a) => (a.teamId ? [a.teamId] : [])));
  const people: SlotOption[] = me.people
    .filter((p) => !seatedAccounts.has(p.accountId))
    .map((p) => ({ value: `account:${p.accountId}`, label: p.name ?? 'Someone', assignee: { kind: 'account', id: p.accountId } }));
  if (slot === 'support') return people;
  const desks: SlotOption[] = me.teams
    .filter((t) => t.kind === 'reception' && !seatedTeams.has(t.id))
    .map((t) => ({ value: `team:${t.id}`, label: t.name, assignee: { kind: 'team', id: t.id } }));
  return [...people, ...desks];
}

/** The branch select (:1953-1960): each park, then "All branches" (no branch). */
export function branchSelectOptions(teams: readonly Team[]): { value: string; label: string }[] {
  return [...branchOptions(teams).map((b) => ({ value: b.id, label: b.label })), { value: '', label: 'All branches' }];
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

/**
 * Where a plain landing opens (test night 2026-10-21, U8): an agent who holds
 * any active thread lands on My Inbox, their own tab; everyone else, and an
 * agent holding nothing, on the default. `mineCount` is the list's
 * `tabCounts.mine`, counted before filters; unknown counts as none.
 */
export function landingTab(tabs: readonly InboxTab[], mineCount: number | undefined): InboxTab {
  if (tabs.includes('mine') && mineCount !== undefined && mineCount > 0) return 'mine';
  return defaultTab(tabs);
}

// --- The support cap (test night U4) -----------------------------------------------------

/** The two support places (`InboxAssigneeSchema.slotIndex`: 1 and 2). */
export const INBOX_SUPPORT_PLACES = 2;
/** The api's own refusal (`INBOX_ACTION_MESSAGES.supportFull`), said before the press as a hint. */
export const SUPPORT_FULL_HINT = 'Both support places are taken. Remove someone first.';

/** "Support 2/2" when every place is taken, else null (the picker shows instead). */
export function supportCapLabel(supportCount: number): string | null {
  return supportCount >= INBOX_SUPPORT_PLACES ? `Support ${INBOX_SUPPORT_PLACES}/${INBOX_SUPPORT_PLACES}` : null;
}

// --- The assistant's state on a thread (test night U5) --------------------------------------

export type AiStateLine =
  | { kind: 'label'; text: string }
  | { kind: 'control'; text: string; paused: boolean; action: 'pause' | 'resume' };

/**
 * What the strip says about the assistant here, from the number's mode
 * (`detail.aiMode`) and the thread's pause: Off is a plain label with no
 * control ("AI on · Pause" showed where the assistant was off, U5); Shadow
 * says so, with only a Resume when a pause is left on it; Live has the
 * pause control.
 */
export function aiStateLine(mode: 'off' | 'shadow' | 'live', paused: boolean): AiStateLine {
  if (mode === 'off') return { kind: 'label', text: 'Assistant off on this number' };
  if (mode === 'shadow' && !paused) return { kind: 'label', text: 'Assistant in shadow' };
  return paused
    ? { kind: 'control', text: 'AI paused · Resume', paused: true, action: 'resume' }
    : { kind: 'control', text: 'AI on · Pause', paused: false, action: 'pause' };
}

/**
 * The thread's assistant state as the api will say it (customer-AI test
 * night, W4a): the chip said "AI on · Pause" after a person's reply and after
 * a hand-over, when the assistant would not answer. `aiState` is the
 * customer-AI lane's field, read optionally; absent, the U5 derivation from
 * the mode and the pause stands.
 */
export const AI_STATES = ['off', 'shadow', 'ready', 'paused', 'left_for_team', 'person_replied'] as const;
export type AiState = (typeof AI_STATES)[number];

export function aiStateLineFor(d: { aiMode: 'off' | 'shadow' | 'live'; aiPaused: boolean; aiState?: unknown }): AiStateLine {
  const state = (AI_STATES as readonly unknown[]).includes(d.aiState) ? (d.aiState as AiState) : null;
  switch (state) {
    case 'off':
      return { kind: 'label', text: 'Assistant off on this number' };
    case 'shadow':
      return { kind: 'label', text: 'Assistant in shadow' };
    case 'ready':
      return { kind: 'control', text: 'AI on · Pause', paused: false, action: 'pause' };
    case 'paused':
      return { kind: 'control', text: 'AI paused · Resume', paused: true, action: 'resume' };
    case 'left_for_team':
      return { kind: 'control', text: 'AI handed over · Resume', paused: true, action: 'resume' };
    case 'person_replied':
      return { kind: 'control', text: 'AI stopped: a person replied · Resume', paused: true, action: 'resume' };
    default:
      return aiStateLine(d.aiMode, d.aiPaused);
  }
}

// --- The outcome of an action, in a line (test night U6, U9) -----------------------------------

/**
 * What the branch step did on a birthday thread, from the api's answer: the
 * host it added, or why it did not (`hostSkipped`, the api lane's addition —
 * read optionally, so until it lands only "Host added" can be said). Null when
 * there is nothing to say (not a birthday, branch cleared, or the api did not
 * say).
 */
export function branchOutcome(
  result: {
    hostAdded?: boolean;
    hostSkipped?: string | null;
    host?: { accountId: string; name: string | null } | null;
    assignments?: readonly { assignmentId: string; slot: string; accountId: string | null; reason: string }[];
  },
  before: readonly Pick<Assignee, 'assignmentId'>[],
  me: Pick<InboxMe, 'people'>,
): string | null {
  switch (result.hostSkipped) {
    case 'no_host':
      return 'No host for this branch';
    case 'host_inactive':
      return 'The host is inactive';
    case 'already_on':
      return 'Already on the thread';
    case 'support_full':
      return 'Support is full';
    default:
      break;
  }
  if (!result.hostAdded) return null;
  const nameOf = (id: string | null | undefined) => (id ? (me.people.find((p) => p.accountId === id)?.name ?? null) : null);
  // The api's name for the host, else the new support place the answer lists.
  const seated = new Set(before.map((a) => a.assignmentId));
  const added = (result.assignments ?? []).find((a) => a.slot === 'support' && a.reason === 'auto' && !seated.has(a.assignmentId));
  const name = result.host?.name ?? nameOf(result.host?.accountId) ?? nameOf(added?.accountId);
  return name ? `Host added: ${name}` : 'Host added';
}

/**
 * Who a move seated, from the api's answer (test night U6: Mila became primary
 * and the GM joined as support without notice): "Now with X as primary · Y
 * added as support". Null when the answer names nobody.
 */
export function moveOutcome(
  result: { assignments?: readonly { slot: string; assigneeKind: string; accountId: string | null; teamId: string | null }[] },
  me: Pick<InboxMe, 'people' | 'teams'>,
): string | null {
  const name = (a: { assigneeKind: string; accountId: string | null; teamId: string | null }): string | null => {
    if (a.assigneeKind === 'ai') return 'the AI Assistant';
    if (a.assigneeKind === 'team') return me.teams.find((t) => t.id === a.teamId)?.name ?? null;
    return me.people.find((p) => p.accountId === a.accountId)?.name ?? null;
  };
  const slots = result.assignments ?? [];
  const primary = slots.find((a) => a.slot === 'primary');
  const supports = slots.filter((a) => a.slot === 'support').map(name).filter((n): n is string => n !== null);
  const parts: string[] = [];
  const p = primary ? name(primary) : null;
  if (p) parts.push(`Now with ${p} as primary`);
  if (supports.length > 0) parts.push(`${supports.join(' and ')} added as support`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

// --- Templates offered to a reply (test night U1) ----------------------------------------------

/** The words on a RU or TH row whose body is still the English source (`needsTranslation`). */
export const TRANSLATION_PENDING = 'English text — not translated yet';
/** The follow-up line: the one that works after a day, so it goes first. */
export const FOLLOW_UP_KEY = 'follow_up';

/**
 * The 24-hour refusal listed 27 templates in every language (U1). The
 * conversation's language comes first, `follow_up` at the top of it; the rest
 * wait under "Other languages". With no language known, everything is "own".
 */
export function offeredTemplates<T extends { key: string; language: string }>(
  list: readonly T[],
  language: string | null,
): { own: T[]; others: T[] } {
  const followUpFirst = (a: T, b: T) => Number(b.key === FOLLOW_UP_KEY) - Number(a.key === FOLLOW_UP_KEY);
  const own = (language ? list.filter((t) => t.language === language) : [...list]).sort(followUpFirst);
  const others = (language ? list.filter((t) => t.language !== language) : []).sort(followUpFirst);
  return { own, others };
}

/** A template row says `needsTranslation`; read optionally — the 409's rows may not carry it yet. */
export function needsTranslation(t: object): boolean {
  return (t as { needsTranslation?: unknown }).needsTranslation === true;
}

// --- The dashboard's average, by whose it is (test night U9) ---------------------------------

/**
 * The average response differs by viewer (18m 46s for an agent, 37m 31s for
 * the GM) without saying whose. The api lane adds `scope`; until it lands the
 * card says nothing, as before.
 */
export function responseScopeLabel(scope: unknown): string | null {
  switch (scope) {
    case 'mine':
      return 'your average';
    case 'team':
      return 'the team’s average';
    case 'all':
      return 'all';
    default:
      return null;
  }
}
