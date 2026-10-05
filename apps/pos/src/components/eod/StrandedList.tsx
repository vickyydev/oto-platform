import {
  STRANDED_REASON_LABEL,
  STRANDED_RESOLUTION_REASONS,
  type EodOverride,
  type EodStrandedRow,
  type StrandedResolutionReason,
} from '@oto/shared';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { Users } from 'lucide-react';

const timeOf = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function RowDetail({ row }: { row: EodStrandedRow }) {
  const title = row.kind === 'band' ? `Band ${row.bandCode ?? ''}`.trim() : (row.childName ?? 'Child');
  const parts: string[] = [];
  if (row.kind === 'band' && row.lastGateEvent) {
    parts.push(
      `Last ${row.lastGateEvent.kind} ${timeOf(row.lastGateEvent.at)}${row.lastGateEvent.stationName ? ` · ${row.lastGateEvent.stationName}` : ''}`,
    );
  }
  if (row.kind === 'checkin' && row.checkedInAt) parts.push(`Checked in ${timeOf(row.checkedInAt)}`);
  if (row.kind === 'checkin' && row.bandCode) parts.push(`Band ${row.bandCode}`);
  if (row.sale?.receiptNumber) parts.push(`Sale ${row.sale.receiptNumber}`);
  const guardian = [row.guardian?.name, row.guardian?.phone].filter(Boolean).join(' · ');
  return (
    <div className="min-w-0">
      <div className="text-sm font-medium">
        {title}
        {row.childrenWithBand > 0 && (
          <span className="font-normal text-muted-foreground">
            {' '}
            + {row.childrenWithBand} {row.childrenWithBand === 1 ? 'child' : 'children'}
          </span>
        )}
      </div>
      {parts.length > 0 && <div className="text-xs text-muted-foreground">{parts.join(' · ')}</div>}
      {guardian && <div className="text-xs text-muted-foreground">Guardian: {guardian}</div>}
    </div>
  );
}

/**
 * S2-15a round 2 — UI ADDITION. Who the branch still counts inside at close:
 * bands whose last gate passage was an entry, and children still checked in.
 * Each is cleared with the reason it is stranded; while any is left, Close Day
 * needs a manager's reason. On a closed day, the override is shown with the
 * rows it was given over. Same cards and muted rows as the rest of the tab.
 */
export function StrandedList({
  rows,
  override,
  readOnly,
  resolving,
  error,
  canOverride,
  overrideReason,
  onOverrideReason,
  onResolve,
  compact = false,
}: {
  rows: readonly EodStrandedRow[];
  override: EodOverride | null;
  readOnly: boolean;
  resolving: string | null;
  error: string | null;
  canOverride: boolean;
  overrideReason: string;
  onOverrideReason: (reason: string) => void;
  onResolve: (row: EodStrandedRow, reason: StrandedResolutionReason) => void;
  compact?: boolean;
}) {
  const shown = readOnly ? (override?.stranded ?? []) : rows;
  if (shown.length === 0) return null;
  return (
    <Card className={cn(compact ? 'p-4' : 'p-5', 'bg-card/50')}>
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-3">
        <Users className="w-4 h-4 text-primary" />
        Still counted inside
        <span className="font-normal">
          {readOnly ? '· at close' : '· resolve each before Close Day'}
        </span>
      </div>
      <div className="space-y-2">
        {shown.map((row) => (
          <div key={`${row.kind}:${row.subjectId}`} className="rounded-xl bg-muted/40 p-3 space-y-2">
            <RowDetail row={row} />
            {!readOnly && (
              <div className={cn('flex flex-wrap gap-2', compact && 'grid grid-cols-1')}>
                {STRANDED_RESOLUTION_REASONS.map((reason) => (
                  <Button
                    key={reason}
                    variant="outline"
                    size="sm"
                    className={compact ? 'h-10 w-full' : undefined}
                    disabled={resolving !== null}
                    onClick={() => onResolve(row, reason)}
                  >
                    {STRANDED_REASON_LABEL[reason]}
                  </Button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {error && !readOnly && (
        <p role="alert" className="mt-3 text-xs text-amber-600">
          {error}
        </p>
      )}
      {readOnly && override && (
        <div className="mt-3 rounded-xl bg-muted/50 px-4 py-3 text-sm">
          <span className="font-semibold">Closed by manager override.</span>{' '}
          <span className="text-muted-foreground">
            {override.reason} — {override.by.name ?? 'Unknown'}
          </span>
        </div>
      )}
      {!readOnly && (
        <div className="mt-4">
          {canOverride ? (
            <label className="flex flex-col gap-1.5 text-sm text-muted-foreground">
              Manager override — close with these still counted inside
              <Textarea
                value={overrideReason}
                placeholder="Why the day closes with people still counted inside…"
                onChange={(e) => onOverrideReason(e.target.value)}
                className="min-h-[64px] bg-muted/50 [color-scheme:dark]"
              />
            </label>
          ) : (
            <p className="text-xs text-muted-foreground">
              Resolve each one, or ask a manager to close the day with a reason.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
