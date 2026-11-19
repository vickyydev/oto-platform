import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { InboxCategoryKey } from '@oto/shared/inbox';
import type { Dashboard as DashboardData } from '@/api/inbox';
import { CATEGORY_DOT, CATEGORY_LABEL, durationLabel, responseScopeLabel } from '@/lib/view';

/** The figure that is also the list's one unanswered filter (SCRUM-1016). */
export const NEEDS_REPLY_LABEL = 'Needs reply';
export const MORE_FIGURES_LABEL = 'More figures';

const TOPICS: InboxCategoryKey[] = ['birthdays', 'general', 'marketing', 'gm'];

const v = (n: number | undefined) => (n === undefined ? '—' : String(n));

/**
 * The statistics in one slim row (SCRUM-1016, owner: "the statistics stay,
 * shown in a clean and aligned way"): Needs reply, New today, Avg reply,
 * Handled today, from the dashboard read (`GET /inbox/dashboard`, every 30 s).
 *
 * "Needs reply" is itself the unanswered filter, its pressed state shown, and
 * there is no second control for it anywhere. The other three figures are one
 * button that opens the rest (active, by topic, BEOs this week) in a small
 * panel, so they stay one tap away and off the page. While the read is out
 * each figure shows "—" (`aria-busy`); a refused read says so in the row and
 * leaves the filter working.
 *
 * `bar` sits inline in the desktop app bar; `card` is the phone and tablet
 * row under the tabs, as Main.dc.html draws it. A viewer without the
 * dashboard capability gets the filter alone, without figures.
 */
export function StatsRow({
  variant,
  data,
  error,
  figures = true,
  unansweredOnly,
  onToggleUnanswered,
}: {
  variant: 'bar' | 'card';
  data: DashboardData | null;
  error: string | null;
  /** The viewer may read the dashboard (`capabilities.dashboard`). */
  figures?: boolean;
  unansweredOnly: boolean;
  onToggleUnanswered: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);

  // The panel: focus moves in when it opens; Escape or a press outside closes
  // it, and focus goes back to the row it opened from.
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const away = (e: PointerEvent) => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const bar = variant === 'bar';
  const busy = figures && data === null && !error;
  const avg = data ? durationLabel(data.averageFirstResponseSeconds) : '—';
  const needs = figures ? v(data?.unanswered) : null;

  const needsButton = (
    <button
      type="button"
      onClick={onToggleUnanswered}
      aria-pressed={unansweredOnly}
      className={`flex shrink-0 flex-col items-center justify-center gap-0.5 transition ${
        bar ? 'min-h-11 rounded-xl px-3.5' : figures ? 'min-h-14 rounded-l-2xl px-1 py-2' : 'min-h-11 flex-1 rounded-2xl px-3 py-1.5'
      } ${unansweredOnly ? 'bg-needs text-needs-ink ring-2 ring-inset ring-coral' : 'text-coral-ink hover:bg-wash'}`}
    >
      {needs !== null && <span className={`${bar ? 'text-[18px]' : 'text-[19px]'} font-extrabold leading-none tracking-[-0.02em]`}>{needs}</span>}
      <span className="text-[11.5px] font-semibold leading-tight">{NEEDS_REPLY_LABEL}</span>
    </button>
  );

  const figure = (value: string, label: string, first = false) => (
    <span
      className={`flex flex-col items-center justify-center gap-0.5 ${bar ? 'shrink-0 px-4' : 'min-w-0 flex-1 px-1'} ${first ? '' : 'border-l border-line'}`}
    >
      <span className={`${bar ? 'text-[18px]' : 'text-[19px]'} font-extrabold leading-none tracking-[-0.02em] text-ink`}>{value}</span>
      <span className={`text-center text-[11.5px] leading-tight text-ink-muted ${bar ? 'whitespace-nowrap' : ''}`}>{label}</span>
    </span>
  );

  return (
    <section
      ref={root}
      aria-label="Today"
      aria-busy={busy}
      className={`relative ${bar ? 'flex items-stretch' : `${figures ? 'grid grid-cols-4' : 'flex'} rounded-2xl border border-line bg-card`}`}
    >
      {needsButton}
      {figures && !error && (
        <button
          ref={trigger}
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${v(data?.newToday)} new today, average reply ${avg}, ${v(data?.handledToday)} handled today. ${MORE_FIGURES_LABEL}`}
          className={`flex min-w-0 items-stretch transition hover:bg-wash ${bar ? 'rounded-xl' : 'col-span-3 rounded-r-2xl border-l border-line py-2'}`}
        >
          {figure(v(data?.newToday), 'New today', !bar)}
          {figure(avg, 'Avg reply')}
          {figure(v(data?.handledToday), 'Handled today')}
        </button>
      )}
      {figures && error && (
        <p role="alert" className={`flex items-center text-[12px] text-rose-700 dark:text-rose-300 ${bar ? 'px-3' : 'col-span-3 border-l border-line px-3'}`}>
          {error}
        </p>
      )}
      {open && data && (
        <div
          ref={panel}
          role="dialog"
          aria-label={MORE_FIGURES_LABEL}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
          }}
          className={`absolute top-full z-30 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-line bg-card p-4 text-ink shadow-pop focus:outline-none ${
            bar ? 'right-0' : 'left-0'
          }`}
        >
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[13px] font-bold">{MORE_FIGURES_LABEL}</h2>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="-mr-2 flex h-11 w-11 items-center justify-center rounded-xl text-ink-muted hover:bg-wash hover:text-ink"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <StatsMore data={data} />
        </div>
      )}
    </section>
  );
}

/**
 * What the row keeps one tap away (SCRUM-1016): the open conversations, whose
 * average the reply time is, the open conversations by topic, and the
 * birthdays booked since Monday. Read-outs only: the list behind each is
 * reached the way every other filter is — Topic under Filters, the Handled
 * tab with its range.
 */
export function StatsMore({ data }: { data: DashboardData }) {
  const scope = responseScopeLabel(data.scope);
  const total = Math.max(1, TOPICS.reduce((sum, k) => sum + data.byCategory[k], 0));
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 text-[13px]">
      <dt className="text-ink-muted">Active</dt>
      <dd className="m-0 text-right font-bold">{data.active}</dd>
      <dt className="text-ink-muted">
        Avg reply{scope && <span className="ml-1 text-[12px]">· {scope}</span>}
      </dt>
      <dd className="m-0 text-right font-bold">{durationLabel(data.averageFirstResponseSeconds)}</dd>
      <dt className="col-span-2 mt-1 text-[12px] font-bold text-ink-muted">By topic</dt>
      <dd className="col-span-2 m-0">
        <div
          role="img"
          aria-label={TOPICS.map((k) => `${CATEGORY_LABEL[k]} ${data.byCategory[k]}`).join(', ')}
          className="flex h-2 overflow-hidden rounded-full bg-band"
        >
          {TOPICS.map((k) => (
            <span key={k} className={CATEGORY_DOT[k]} style={{ width: `${Math.round((data.byCategory[k] / total) * 100)}%` }} />
          ))}
        </div>
        <ul className="mt-2 space-y-1">
          {TOPICS.map((k) => (
            <li key={k} data-topic={k} className="flex items-center gap-2">
              <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${CATEGORY_DOT[k]}`} />
              <span className="min-w-0 flex-1 truncate">{CATEGORY_LABEL[k]}</span>
              <span className="font-bold">{data.byCategory[k]}</span>
            </li>
          ))}
        </ul>
      </dd>
      <dt className="mt-1 text-ink-muted">
        BEOs created · week
        {data.weekStart && <span className="block text-[12px]">Since Monday {data.weekStart}</span>}
      </dt>
      <dd className="m-0 mt-1 text-right font-bold">{data.beosThisWeek}</dd>
    </dl>
  );
}
