import { addDaysToIsoDate } from '@oto/shared';

/**
 * The change history of one role template or one staff member's benefit
 * (S2-21 round 1 — a UI addition, plan §1: "an 'effective from' date and a
 * change history on each template and each override"). Every saved version,
 * newest first: the trading days it counts on, what it gave, who saved it and
 * when. The platform keeps every version; nothing here is computed beyond the
 * words.
 */

export interface BenefitHistoryEntry {
  id: string;
  /** What the version gave, in the panel's own summary words. */
  summary: string;
  effectiveFrom: string;
  /** Exclusive; null runs on. Equal to `effectiveFrom`: replaced before it started. */
  effectiveTo: string | null;
  createdAt: string;
  createdBy: { name: string | null } | null;
}

type Status = 'in-force' | 'scheduled' | 'replaced' | 'ended';

function statusOf(e: BenefitHistoryEntry, today: string): Status {
  if (e.effectiveTo !== null && e.effectiveTo <= e.effectiveFrom) return 'replaced';
  if (e.effectiveFrom > today) return 'scheduled';
  if (e.effectiveTo === null || e.effectiveTo > today) return 'in-force';
  return 'ended';
}

const STATUS_CHIP: Record<Status, { label: string; className: string }> = {
  'in-force': { label: 'In force', className: 'bg-emerald-500/15 text-emerald-600' },
  scheduled: { label: 'Scheduled', className: 'bg-amber-500/15 text-amber-600' },
  replaced: {
    label: 'Replaced before it started',
    className: 'bg-foreground/5 text-foreground/50',
  },
  ended: { label: 'Ended', className: 'bg-foreground/5 text-foreground/50' },
};

/** "From 2026-10-08" while it runs on; "2026-01-01 – 2026-10-07" once a later change closed it (its last day). */
function rangeText(e: BenefitHistoryEntry): string {
  if (e.effectiveTo === null || e.effectiveTo <= e.effectiveFrom) return `From ${e.effectiveFrom}`;
  return `${e.effectiveFrom} – ${addDaysToIsoDate(e.effectiveTo, -1)}`;
}

export function BenefitHistoryList({
  entries,
  today,
  loading,
  error,
}: {
  entries: BenefitHistoryEntry[];
  today: string;
  loading?: boolean;
  error?: string | null;
}) {
  if (loading) return <p className="text-xs text-foreground/40">Loading history…</p>;
  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (entries.length === 0)
    return <p className="text-xs text-foreground/40">No changes saved yet.</p>;
  return (
    <div className="flex flex-col gap-2">
      {entries.map((e) => {
        const chip = STATUS_CHIP[statusOf(e, today)];
        return (
          <div
            key={e.id}
            className="flex flex-col gap-0.5 rounded-xl border border-foreground/10 bg-foreground/[0.02] px-3 py-2 text-xs"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium tabular-nums">{rangeText(e)}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs ${chip.className}`}>
                {chip.label}
              </span>
            </div>
            <div className="text-foreground/60">{e.summary}</div>
            <div className="text-foreground/40">
              {e.createdBy ? `Changed by ${e.createdBy.name ?? 'a staff account'}` : 'Seeded'} ·{' '}
              {new Date(e.createdAt).toLocaleString()}
            </div>
          </div>
        );
      })}
    </div>
  );
}
