/**
 * The playbook's inbox views and chips (SCRUM-220, Tom's playbook of
 * 2026-10-28) — pure, so the unit tests read the real thing
 * (test/playbook-ui.test.ts).
 *
 * The rail's dropdowns became rows of toggle chips (Branch, Source, Topic,
 * Status, Language), and above them sit the named inboxes the playbook works
 * in: All conversations, Birthdays & Events, GM and one per park. A named
 * view is nothing but a saved set of chips: opening one sets the chips, and
 * the view the rail marks is read back off the chips, so a chip changed by
 * hand (or by the dashboard's category legend) lands on a "modified All"
 * unless it happens to equal another view exactly.
 *
 * Each chip row is one value at a time: `GET /inbox/conversations` filters
 * one category, one branch, one number, one status and one language, so a
 * second chip in a row takes the first one's place. Across rows they combine.
 */
import type { InboxChannelKey } from '@oto/shared/inbox';
import type { ConversationRow, InboxMe } from '@/api/inbox';
import type { Filters } from './query';
import { CATEGORY_LABEL, CHANNEL_LABEL, branchOptions } from './view';

// --- The chips -----------------------------------------------------------------------

/** The filters a chip row holds, in the rail's order. */
export type ChipDim = 'branchId' | 'channelAccountId' | 'category' | 'status' | 'language';
export const CHIP_DIMS: readonly ChipDim[] = ['branchId', 'channelAccountId', 'category', 'status', 'language'];

/** A chip's press: on when it was off (in place of its row's other chip), off when it was on. */
export function toggleChip(f: Pick<Filters, ChipDim>, dim: ChipDim, value: string): Partial<Filters> {
  return { [dim]: f[dim] === value ? '' : value } as Partial<Filters>;
}

// --- The source: the number a conversation came in on ----------------------------------------

/** A number the Source row offers: its channel account, by its display name when it has one. */
export interface SourceOption {
  id: string;
  channel: InboxChannelKey;
  name: string | null;
}

/**
 * How a conversation's source reads: the number's display name ("Reception ·
 * Central Floresta"), else — a row the api could not name — its channel.
 */
export function sourceLabel(channel: InboxChannelKey, name: string | null | undefined): string {
  return name?.trim() || CHANNEL_LABEL[channel];
}

/** The Source row's order: WhatsApp numbers, then Instagram, then Facebook, then the rest; by label within a channel. */
const CHANNEL_ORDER: readonly InboxChannelKey[] = ['whatsapp', 'instagram', 'facebook', 'line', 'telegram', 'webform'];

function bySource(a: SourceOption, b: SourceOption): number {
  const c = CHANNEL_ORDER.indexOf(a.channel) - CHANNEL_ORDER.indexOf(b.channel);
  if (c !== 0) return c;
  return sourceLabel(a.channel, a.name).localeCompare(sourceLabel(b.channel, b.name));
}

/**
 * The numbers known so far, with `incoming` folded in: a new number joins, a
 * name fills a number known without one. The same array comes back when
 * nothing changed, so a list refresh that names no new number re-renders
 * nothing.
 */
export function mergeSources(prev: readonly SourceOption[], incoming: readonly SourceOption[]): SourceOption[] {
  let next: SourceOption[] | null = null;
  for (const s of incoming) {
    const list: SourceOption[] = next ?? (prev as SourceOption[]);
    const at = list.findIndex((x) => x.id === s.id);
    if (at < 0) {
      next = [...list, s];
    } else if (list[at]!.name === null && s.name !== null && s.name.trim() !== '') {
      next = list.map((x, i) => (i === at ? { ...x, name: s.name } : x));
    }
  }
  return next ? next.sort(bySource) : (prev as SourceOption[]);
}

/** The numbers a page of conversations names (`channelAccountId`, `channelAccountName`). */
export function sourcesOfRows(rows: readonly Pick<ConversationRow, 'channel' | 'channelAccountId' | 'channelAccountName'>[]): SourceOption[] {
  return rows.map((r) => ({ id: r.channelAccountId, channel: r.channel, name: r.channelAccountName }));
}

// --- The named views ----------------------------------------------------------------------------

export interface NamedView {
  /** `all`, `birthdays`, `gm`, or `branch:<id>`. */
  key: string;
  label: string;
  kind: 'all' | 'category' | 'branch';
  /** The chips the view sets; every other chip row is cleared. */
  chips: Partial<Pick<Filters, ChipDim>>;
}

export const ALL_VIEW_LABEL = 'All conversations';

/**
 * The playbook's inboxes, in its order: All conversations; Birthdays & Events
 * and GM, each while the operator has that team; then one per park, named as
 * the park's reception desk names it (`branchOptions`).
 */
export function namedViews(me: Pick<InboxMe, 'teams'>): NamedView[] {
  const out: NamedView[] = [{ key: 'all', label: ALL_VIEW_LABEL, kind: 'all', chips: {} }];
  for (const category of ['birthdays', 'gm'] as const) {
    if (me.teams.some((t) => t.kind === category)) {
      out.push({ key: category, label: CATEGORY_LABEL[category], kind: 'category', chips: { category } });
    }
  }
  for (const b of branchOptions(me.teams)) {
    out.push({ key: `branch:${b.id}`, label: b.label, kind: 'branch', chips: { branchId: b.id } });
  }
  return out;
}

/** Opening a view: its chips on, every other chip row off. The search, the unanswered toggle and the archive's filters stay. */
export function applyView(view: Pick<NamedView, 'chips'>): Partial<Filters> {
  const patch: Partial<Filters> = {};
  for (const dim of CHIP_DIMS) Object.assign(patch, { [dim]: '' });
  return { ...patch, ...view.chips };
}

/**
 * The view the chips stand on: the one whose chips they equal exactly, else
 * All, modified — the chips were changed by hand away from every view.
 */
export function currentView(f: Pick<Filters, ChipDim>, views: readonly NamedView[]): { key: string; modified: boolean } {
  for (const v of views) {
    if (CHIP_DIMS.every((dim) => (f[dim] ?? '') === (v.chips[dim] ?? ''))) return { key: v.key, modified: false };
  }
  return { key: 'all', modified: true };
}
