// The prototype's small UI atoms (WhatsAppDemo.tsx :727-1026, :1773-1868),
// ported with their classes as they are and their data moved onto the api's
// shapes: `Avatar`, `StaffChip` (here `ChipView`), `StatusBadge`,
// `CategoryBadge`, `ChannelDot`, `MetricCard`, `CategoryMixCard`,
// `EmptyState`; and the toggle pill as the rail's `FilterChip`, which took
// the place of the prototype's `FilterSelect` (SCRUM-220 playbook).
import type { ReactNode } from 'react';
import { Briefcase, Building2, ChevronDown, Megaphone, PartyPopper, TrendingUp, type LucideIcon } from 'lucide-react';
import type { InboxCategoryKey, InboxChannelKey, InboxStatusKey } from '@oto/shared/inbox';
import {
  CATEGORY_BAR,
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

export function Avatar({ initials, tint, size = 40 }: { initials: string; tint: string; size?: number }) {
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold ${tint}`}
      style={{ width: size, height: size, fontSize: size * 0.35 }}
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
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white/70 dark:bg-slate-900/60 text-[9px] font-bold text-slate-700 dark:text-slate-200">
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
          live ? ' cursor-pointer hover:ring-slate-400 dark:hover:ring-slate-500' : ''
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
          live ? ' cursor-pointer hover:ring-slate-400 dark:hover:ring-slate-500' : ''
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

export function ChannelDot({ channel }: { channel: InboxChannelKey }) {
  return (
    <span
      title={CHANNEL_LABEL[channel]}
      className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full ring-2 ring-white dark:ring-slate-900 ${CHANNEL_TINT[channel]}`}
    />
  );
}

export function MetricCard({
  icon: Icon,
  label,
  value,
  tint,
  active,
  onClick,
  hint,
}: {
  icon: LucideIcon;
  label: string;
  value: number | string;
  tint: string;
  active?: boolean;
  onClick?: () => void;
  hint?: string;
}) {
  const clickable = Boolean(onClick);
  const Cmp: 'button' | 'div' = clickable ? 'button' : 'div';
  return (
    <Cmp
      type={clickable ? 'button' : undefined}
      onClick={onClick}
      aria-pressed={clickable ? Boolean(active) : undefined}
      className={`min-w-0 rounded-xl border bg-white dark:bg-slate-900 p-3 text-left transition ${
        active
          ? 'border-rose-300 dark:border-rose-500/50 ring-2 ring-rose-200 dark:ring-rose-500/30'
          : clickable
            ? 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-600 hover:shadow-sm'
            : 'border-slate-200 dark:border-slate-800'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${tint}`}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 text-[10px] font-semibold uppercase leading-snug tracking-[0.16em] text-slate-500 dark:text-slate-400">{label}</div>
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <div className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">{value}</div>
        {hint && (
          <span className={`hidden text-[10px] sm:inline ${active ? 'font-medium text-rose-600 dark:text-rose-400' : 'text-slate-400'}`}>
            {hint}
          </span>
        )}
      </div>
    </Cmp>
  );
}

const CATEGORY_ICON: Record<InboxCategoryKey, LucideIcon> = {
  birthdays: PartyPopper,
  general: Building2,
  marketing: Megaphone,
  gm: Briefcase,
};
const CATEGORY_ICON_INK: Record<InboxCategoryKey, string> = {
  birthdays: 'text-violet-500 dark:text-violet-400',
  general: 'text-sky-500',
  marketing: 'text-pink-500',
  gm: 'text-amber-500',
};

/** "By category": the stacked violet / sky / pink bar with its icon-and-count legend (:1813-1836). */
export function CategoryMixCard({
  data,
  selected = '',
  onPick,
}: {
  data: Record<InboxCategoryKey, number>;
  /** The category the list is filtered to, if any: its legend entry reads as pressed. */
  selected?: InboxCategoryKey | '';
  /** Present, each legend entry filters the list to its category (a second press clears it). */
  onPick?: (category: InboxCategoryKey) => void;
}) {
  const keys: InboxCategoryKey[] = ['birthdays', 'general', 'marketing', 'gm'];
  const total = Math.max(1, data.birthdays + data.general + data.marketing + data.gm);
  const w = (n: number) => `${Math.round((n / total) * 100)}%`;
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
          <TrendingUp className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 text-[10px] font-semibold uppercase leading-snug tracking-[0.16em] text-slate-500 dark:text-slate-400">By category</div>
      </div>
      <div
        className="mt-2 flex h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
        role="img"
        aria-label={keys.map((k) => `${CATEGORY_LABEL[k]} ${data[k]}`).join(', ')}
      >
        {keys.map((k) => (
          <div key={k} className={CATEGORY_BAR[k]} style={{ width: w(data[k]) }} />
        ))}
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400">
        {keys.map((k) => {
          const Icon = CATEGORY_ICON[k];
          if (!onPick) {
            return (
              <span key={k} className="flex items-center gap-1" title={CATEGORY_LABEL[k]}>
                <Icon className={`h-3 w-3 ${CATEGORY_ICON_INK[k]}`} />
                {data[k]}
              </span>
            );
          }
          const on = selected === k;
          return (
            <button
              key={k}
              type="button"
              onClick={() => onPick(k)}
              aria-pressed={on}
              title={on ? `Showing ${CATEGORY_LABEL[k]} only — click to clear` : `Show ${CATEGORY_LABEL[k]} only`}
              className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 transition ${
                on
                  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                  : 'hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200'
              }`}
            >
              <Icon className={`h-3 w-3 ${on ? '' : CATEGORY_ICON_INK[k]}`} />
              {data[k]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The toggle pill the archive's filters use (`ConversationList`, "Handled in
 * the last" and "Resolved by"), and since the playbook build (SCRUM-220) the
 * rail's chips: white with a slate ring when off, inverted when on, the state
 * in `aria-pressed` as the dashboard tiles carry it (SCRUM-652).
 */
export const PILL = 'rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 transition';
export const PILL_ON = 'bg-slate-900 text-white ring-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:ring-slate-100';
export const PILL_OFF = 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 ring-slate-200 dark:ring-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800';

/**
 * One chip of the rail's filters: a press adds it, a second press removes it.
 * `dot` is a small mark in the thing's own colour — a topic's bar colour, a
 * channel's, a status's — so the GM queue reads amber on its chip as on its
 * badge. `chipKey` names the chip for the markup tests (`dim:value`).
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
      className={`${PILL} ${pressed ? PILL_ON : PILL_OFF} inline-flex min-w-0 max-w-full items-center gap-1`}
    >
      {dot && <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />}
      <span className="truncate">{label}</span>
    </button>
  );
}

export function EmptyState({ icon: Icon, title, subtitle }: { icon: LucideIcon; title: string; subtitle: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400">
        <Icon className="h-5 w-5" />
      </div>
      <div className="text-[14px] font-semibold text-slate-700 dark:text-slate-200">{title}</div>
      <div className="max-w-xs text-[12.5px] text-slate-500 dark:text-slate-400">{subtitle}</div>
    </div>
  );
}

/** The eyebrow label: uppercase, letter-spaced, grey. */
export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400 ${className}`}>{children}</div>
  );
}
