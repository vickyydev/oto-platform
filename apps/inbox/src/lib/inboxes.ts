/**
 * The list's filter choices (SCRUM-220, Tom's playbook of 2026-10-28; one
 * place for each since SCRUM-1016) — pure, so the unit tests read the real
 * thing (test/playbook-ui.test.ts, test/filters-1016.test.ts).
 *
 * The rail's dropdowns became rows of toggle choices — Topic, Park, Channel
 * (the number a conversation came in on), Language — in the desktop views
 * column and the phone's Filters sheet. The playbook's named inboxes stood
 * above them and only repeated them: a park view was the Park choice, the
 * Birthdays & Events and GM views the Topic choice, a test line's view its
 * Channel choice. SCRUM-1016 removed the list of views and kept every one of
 * them a choice: the SCRUM-789 General view is the Topic "Kept in General",
 * and each WhatsApp test line is offered under Channel from the start.
 *
 * Each row is one value at a time: `GET /inbox/conversations` filters one
 * category, one branch, one number and one language, so a second choice in a
 * row takes the first one's place. Across rows they combine.
 */
import { INBOX_CATEGORY_KEYS, type InboxChannelKey } from '@oto/shared/inbox';
import type { ConversationRow, InboxMe } from '@/api/inbox';
import type { Filters, TopicChoice } from './query';
import { CHANNEL_LABEL } from './view';

// --- The chips -----------------------------------------------------------------------

/** The filters a choice row holds; `category` and `inbox` together are the Topic row. */
export type ChipDim = 'branchId' | 'channelAccountId' | 'category' | 'language' | 'inbox';

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
/** Previously learned names cannot survive a newer server access restriction. */
export function inboxSourcesWithinAccess(sources: readonly SourceOption[], access: InboxMe['access']): SourceOption[] {
  if (access?.categories?.length === 0) return [];
  return sources.filter(source => !access?.channelAccountIds || access.channelAccountIds.includes(source.id));
}
export function inboxAccessSignature(access: InboxMe['access']): string {
  return JSON.stringify({ categories: access?.categories?.slice().sort() ?? null,
    channelAccountIds: access?.channelAccountIds?.slice().sort() ?? null, version: access?.version ?? 0 });
}
/** List and identity reads can finish in either order; an older page cannot restore revoked access. */
export function newestInboxAccess(page: InboxMe['access'], identity: InboxMe['access']): InboxMe['access'] {
  if (!page) return identity;
  if (!identity || page.version > identity.version) return page;
  if (identity.version > page.version) return identity;
  // Granting/revoking the administrator exception does not mutate the policy
  // row's version. Contradictory equal-version reads must fail closed.
  if (inboxAccessSignature(page) === inboxAccessSignature(identity)) return page;
  const intersect = <T extends string>(a: T[] | null, b: T[] | null): T[] | null =>
    a === null ? b : b === null ? a : a.filter(value => b.includes(value));
  return { version: page.version, categories: intersect(page.categories, identity.categories),
    channelAccountIds: intersect(page.channelAccountIds, identity.channelAccountIds) };
}
export function inboxItemWithinAccess(item: Pick<ConversationRow, 'category' | 'channelAccountId'>, access: InboxMe['access']): boolean {
  return (!access?.categories || access.categories.includes(item.category))
    && (!access?.channelAccountIds || access.channelAccountIds.includes(item.channelAccountId));
}
export function inboxFiltersWithinAccess(filters: Filters, access: InboxMe['access']): Filters {
  const category = filters.category && access?.categories && !access.categories.includes(filters.category) ? '' : filters.category;
  const channelAccountId = filters.channelAccountId && access?.channelAccountIds && !access.channelAccountIds.includes(filters.channelAccountId) ? '' : filters.channelAccountId;
  const inbox = filters.inbox && access?.categories && !access.categories.includes('general') ? '' : filters.inbox;
  return category === filters.category && channelAccountId === filters.channelAccountId && inbox === filters.inbox ? filters : { ...filters, category, channelAccountId, inbox };
}
/** Hide identity-owned choices until its fresh read agrees with a newer list policy. */
export function inboxMeWithinAccess(me: InboxMe, access: InboxMe['access']): InboxMe {
  const channelAllowed = (id: string) => access?.categories?.length !== 0
    && (!access?.channelAccountIds || access.channelAccountIds.includes(id));
  return { ...me, access,
    teams: me.teams.filter(team => !access?.categories || access.categories.includes(team.kind === 'reception' ? 'general' : team.kind)),
    testLines: me.testLines?.filter(line => channelAllowed(line.id)),
    simulator: me.simulator ? { ...me.simulator, channelAccounts: me.simulator.channelAccounts.filter(line => channelAllowed(line.id)) } : null,
    contactChannels: inboxAccessSignature(me.access) === inboxAccessSignature(access) ? me.contactChannels?.filter(line => channelAllowed(line.id)) : [],
    defaultReceptionBranchId: access?.categories && !access.categories.includes('general') ? null : me.defaultReceptionBranchId,
  };
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

// --- The Topic choices --------------------------------------------------------------------

/**
 * The topics the Topic row offers, inside the SCRUM-993 limits: every topic
 * the account may see, then "Kept in General" (SCRUM-789) while General is
 * one of them. An empty category list offers none.
 */
export function topicChoices(access: InboxMe['access']): Exclude<TopicChoice, ''>[] {
  const allowed = INBOX_CATEGORY_KEYS.filter((k) => !access?.categories || access.categories.includes(k));
  return allowed.includes('general') ? [...allowed, 'held'] : allowed;
}

// --- The Channel choices ------------------------------------------------------------------

/**
 * The numbers the Channel row offers: those known so far (the rows read, the
 * simulator's, the assistant's list) and every WhatsApp test line the api
 * names (SCRUM-908), so a test line is a choice before any of its threads is
 * read — inside the SCRUM-993 limits, as every other choice.
 */
export function channelChoices(
  sources: readonly SourceOption[],
  me: Partial<Pick<InboxMe, 'testLines' | 'access'>>,
): SourceOption[] {
  const lines = (me.testLines ?? []).map((l) => ({ id: l.id, channel: l.channel, name: l.displayName }));
  return inboxSourcesWithinAccess(mergeSources(sources, lines), me.access);
}

/** SCRUM-908: whether the viewer may press Start over on a conversation of this number. */
export function mayStartOver(me: Partial<Pick<InboxMe, 'testLines'>>, channelAccountId: string): boolean {
  return (me.testLines ?? []).some((l) => l.id === channelAccountId && l.startOver);
}
