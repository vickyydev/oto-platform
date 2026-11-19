// The prototype's small UI atoms (WhatsAppDemo.tsx :727-1026, :1773-1868),
// ported with their classes as they are and their data moved onto the api's
// shapes: `Avatar`, `StaffChip` (here `ChipView`), `StatusBadge`,
// `CategoryBadge`, `ChannelDot`, `EmptyState`; and the toggle pill as the
// rail's `FilterChip`, which took the place of the prototype's
// `FilterSelect` (SCRUM-220 playbook). The dashboard's `MetricCard` and
// `CategoryMixCard` gave way to the statistics row (SCRUM-1016).
import type { ReactNode } from 'react';
import { ChevronDown, type LucideIcon } from 'lucide-react';
import type { InboxCategoryKey, InboxChannelKey, InboxStatusKey } from '@oto/shared/inbox';
import {
  CATEGORY_LABEL,
  CATEGORY_TINT,
  CHANNEL_LABEL,
  CHANNEL_TINT,
  STATUS_DOT,
  STATUS_LABEL,
  STATUS_TINT,
  TRANSLATION_PENDING,
  type Chip,
} from '@/lib/view';

/**
 * The mark on a RU or TH template whose body is still the English source
 * (test night 2026-10-21, U1: English went to a Russian customer unknowingly).
 * The same words wherever a template is offered to a reply.
 */
export function TranslationNote() {
  return (
    <span className="rounded-full bg-amber-50 dark:bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-700 dark:text-amber-300 ring-1 ring-amber-200 dark:ring-amber-500/30">
      {TRANSLATION_PENDING}
    </span>
  );
}

/**
 * A contact's face: their initials on their tint, a soft square (Main.dc.html,
 * 44 px with a 14 px radius), so a face never reads as a person's round chip.
 */
export function Avatar({ initials, tint, size = 44 }: { initials: string; tint: string; size?: number }) {
  return (
    <div
      aria-hidden
      className={`flex shrink-0 items-center justify-center font-bold ${tint}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.32), borderRadius: Math.round(size * 0.32) }}
    >
      {initials}
    </div>
  );
}

/** `StaffChip` (:738-749): initials in a white disc, then the name. */
export function ChipView({ chip, withName = true }: { chip: Chip; withName?: boolean }) {
  return (
    <span
      className={`inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${chip.tint}`}
      title={withName ? undefined : chip.name}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-card/70 text-[9px] font-bold text-ink">
        {chip.initials}
      </span>
      {withName && <span className="truncate">{chip.name}</span>}
    </span>
  );
}

/**
 * `StatusBadge` (:931-962). With a live `picker` (the native select laid
 * over it) the badge takes the prototype's pointer, hover ring and hint.
 */
export function StatusBadge({
  status,
  picker,
  live = false,
}: {
  status: InboxStatusKey;
  picker?: ReactNode;
  live?: boolean;
}) {
  return (
    <span className="relative inline-flex">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${STATUS_TINT[status]}${
          live ? ' cursor-pointer hover:ring-field' : ''
        }`}
        title={live ? (status === 'handled' ? 'Click to reopen this conversation' : 'Click to mark as handled') : undefined}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} />
        {STATUS_LABEL[status]}
        {picker && <ChevronDown className="h-3 w-3 opacity-60" />}
      </span>
      {picker}
    </span>
  );
}

export function CategoryBadge({
  category,
  label,
  picker,
  live = false,
  title,
}: {
  category: InboxCategoryKey;
  /** The move picker shows the team ("Reception · Central"); the list shows the category. */
  label?: string;
  picker?: ReactNode;
  /** The picker is live: the prototype's pointer, hover ring and hint (:995-998). */
  live?: boolean;
  /** What the badge means, for a reader (`categoryTitle`: topic, not team); the live picker's hint wins. */
  title?: string;
}) {
  return (
    <span className="relative inline-flex">
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${CATEGORY_TINT[category]}${
          live ? ' cursor-pointer hover:ring-field' : ''
        }`}
        title={live ? 'Click to move this conversation to another team' : title}
      >
        {label ?? CATEGORY_LABEL[category]}
        {picker && <ChevronDown className="h-3 w-3 opacity-60" />}
      </span>
      {picker}
    </span>
  );
}

/** The channel's dot on a face; `ring` is the ground the face stands on, so the dot is cut out of it. */
export function ChannelDot({ channel, ring = 'ring-card' }: { channel: InboxChannelKey; ring?: string }) {
  return (
    <span
      title={CHANNEL_LABEL[channel]}
      className={`absolute -bottom-[3px] -right-[3px] h-3 w-3 rounded-full ring-2 ${ring} ${CHANNEL_TINT[channel]}`}
    />
  );
}

/**
 * The toggle pill (Filters.dc.html): the archive's choices on the Handled
 * tab, the Unread quick filter and every choice in the Filters sheet. A card
 * with a field border when off, inverted ink when on, the state in
 * `aria-pressed` (SCRUM-652); 44 px tall on a phone (SCRUM-1016).
 */
export const PILL =
  'inline-flex min-h-11 items-center rounded-full border px-3.5 text-[13.5px] font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral md:min-h-10';
export const PILL_ON = 'border-ink bg-ink text-on-ink';
export const PILL_OFF = 'border-field bg-card text-ink hover:bg-wash';

/**
 * One choice of the Filters sheet: a press adds it, a second press removes
 * it. `dot` is a small mark in the thing's own colour — a topic's, a
 * channel's — so the GM queue reads amber on its choice as in the views
 * column. `chipKey` names the choice for the markup tests (`dim:value`).
 */
export function FilterChip({
  chipKey,
  label,
  pressed,
  onClick,
  dot,
  title,
}: {
  chipKey: string;
  label: string;
  pressed: boolean;
  onClick: () => void;
  dot?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      data-chip={chipKey}
      aria-pressed={pressed}
      onClick={onClick}
      title={title ?? label}
      className={`${PILL} ${pressed ? PILL_ON : PILL_OFF} min-w-0 max-w-full gap-2`}
    >
      {dot && <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />}
      <span className="truncate">{label}</span>
    </button>
  );
}

export function EmptyState({ icon: Icon, title, subtitle }: { icon: LucideIcon; title: string; subtitle: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-band text-ink-muted">
        <Icon className="h-5 w-5" />
      </div>
      <div className="text-[14px] font-semibold text-ink">{title}</div>
      <div className="max-w-xs text-[12.5px] text-ink-muted">{subtitle}</div>
    </div>
  );
}

/** The eyebrow label: uppercase, letter-spaced, grey. */
export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`text-[10px] font-semibold uppercase tracking-[0.2em] text-ink-muted ${className}`}>{children}</div>
  );
}
