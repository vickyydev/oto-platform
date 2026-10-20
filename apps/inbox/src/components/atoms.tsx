// The prototype's small UI atoms (WhatsAppDemo.tsx :727-1026, :1773-1868),
// ported with their classes as they are and their data moved onto the api's
// shapes: `Avatar`, `StaffChip` (here `ChipView`), `StatusBadge`,
// `CategoryBadge`, `ChannelDot`, `MetricCard`, `CategoryMixCard`,
// `FilterSelect`, `EmptyState`.
import type { ReactNode } from 'react';
import { Building2, ChevronDown, Megaphone, PartyPopper, TrendingUp, type LucideIcon } from 'lucide-react';
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
  type Chip,
} from '@/lib/view';

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
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white/70 text-[9px] font-bold text-slate-700">
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
          live ? ' cursor-pointer hover:ring-slate-400' : ''
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
}: {
  category: InboxCategoryKey;
  /** The move picker shows the team ("Reception · Central"); the list shows the category. */
  label?: string;
  picker?: ReactNode;
  /** The picker is live: the prototype's pointer, hover ring and hint (:995-998). */
  live?: boolean;
}) {
  return (
    <span className="relative inline-flex">
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${CATEGORY_TINT[category]}${
          live ? ' cursor-pointer hover:ring-slate-400' : ''
        }`}
        title={live ? 'Click to move this conversation to another team' : undefined}
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
      className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full ring-2 ring-white ${CHANNEL_TINT[channel]}`}
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
      className={`min-w-0 rounded-xl border bg-white p-3 text-left transition ${
        active
          ? 'border-rose-300 ring-2 ring-rose-200'
          : clickable
            ? 'border-slate-200 hover:border-slate-300 hover:shadow-sm'
            : 'border-slate-200'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${tint}`}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 text-[10px] font-semibold uppercase leading-snug tracking-[0.16em] text-slate-500">{label}</div>
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <div className="text-xl font-semibold tracking-tight text-slate-900">{value}</div>
        {hint && (
          <span className={`hidden text-[10px] sm:inline ${active ? 'font-medium text-rose-600' : 'text-slate-400'}`}>
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
};
const CATEGORY_ICON_INK: Record<InboxCategoryKey, string> = {
  birthdays: 'text-violet-500',
  general: 'text-sky-500',
  marketing: 'text-pink-500',
};

/** "By category": the stacked violet / sky / pink bar with its icon-and-count legend (:1813-1836). */
export function CategoryMixCard({ data }: { data: Record<InboxCategoryKey, number> }) {
  const keys: InboxCategoryKey[] = ['birthdays', 'general', 'marketing'];
  const total = Math.max(1, data.birthdays + data.general + data.marketing);
  const w = (n: number) => `${Math.round((n / total) * 100)}%`;
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
          <TrendingUp className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 text-[10px] font-semibold uppercase leading-snug tracking-[0.16em] text-slate-500">By category</div>
      </div>
      <div
        className="mt-2 flex h-2 overflow-hidden rounded-full bg-slate-100"
        role="img"
        aria-label={keys.map((k) => `${CATEGORY_LABEL[k]} ${data[k]}`).join(', ')}
      >
        {keys.map((k) => (
          <div key={k} className={CATEGORY_BAR[k]} style={{ width: w(data[k]) }} />
        ))}
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-500">
        {keys.map((k) => {
          const Icon = CATEGORY_ICON[k];
          return (
            <span key={k} className="flex items-center gap-1" title={CATEGORY_LABEL[k]}>
              <Icon className={`h-3 w-3 ${CATEGORY_ICON_INK[k]}`} />
              {data[k]}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function FilterSelect({
  icon: Icon,
  label,
  value,
  onChange,
  options,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <div className="relative mb-1.5">
      <Icon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
      <select
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-7 text-[12.5px] text-slate-700 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
    </div>
  );
}

export function EmptyState({ icon: Icon, title, subtitle }: { icon: LucideIcon; title: string; subtitle: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        <Icon className="h-5 w-5" />
      </div>
      <div className="text-[14px] font-semibold text-slate-700">{title}</div>
      <div className="max-w-xs text-[12.5px] text-slate-500">{subtitle}</div>
    </div>
  );
}

/** The eyebrow label: uppercase, letter-spaced, grey. */
export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400 ${className}`}>{children}</div>
  );
}
