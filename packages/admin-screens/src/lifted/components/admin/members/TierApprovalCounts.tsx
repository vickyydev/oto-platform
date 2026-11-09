import { useCallback, useEffect, useRef, useState } from 'react';
import { Hand } from 'lucide-react';
import type { ApiTierApprovalCounts } from '../../../api/platform';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table';

/**
 * SCRUM-772 — how often each staff member has approved the Thai rate by hand.
 *
 * Since the owner's rule of 6 November the till confirms the Thai rate with
 * no document — "Confirm Thai rate" or "Cancel" — and the staff member on it
 * confirms alone, so the customer does not wait. This count is how that stays
 * answerable: one row per staff member, the last 30 days beside the total, so
 * a name that comes up far more often than expected is visible here. Each
 * confirmation itself is on the sale it priced, in the activity log and, once
 * saved to the member, in the records below.
 *
 * It reads on its own and fails on its own: the verification records below
 * still show when the count cannot be read.
 */
export interface TierApprovalCountsProps {
  load: () => Promise<ApiTierApprovalCounts>;
  /** Bumped by the page's Refresh, so both halves read again together. */
  refreshSignal: number;
  isCurrent?: () => boolean;
}

export function TierApprovalCounts({ load, refreshSignal, isCurrent }: TierApprovalCountsProps) {
  const mounted = useRef(false);
  const reads = useRef(0);
  useEffect(() => {
    const owner = reads;
    mounted.current = true;
    return () => {
      mounted.current = false;
      owner.current++;
    };
  }, []);
  const current = useCallback(() => mounted.current && (isCurrent?.() ?? true), [isCurrent]);
  const [counts, setCounts] = useState<ApiTierApprovalCounts | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!current()) return;
    const request = ++reads.current;
    setError(null);
    load()
      .then((answer) => {
        if (current() && request === reads.current) setCounts(answer);
      })
      .catch((err: unknown) => {
        if (current() && request === reads.current) {
          setError(err instanceof Error ? err.message : 'The approval counts could not be read.');
        }
      });
  }, [load, refreshSignal, current]);

  const fmtDay = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });

  return (
    <section aria-label="Thai rate approved by hand" className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Hand className="w-4 h-4 text-foreground/50" />
        Thai rate approved by hand
        <span className="font-normal text-foreground/40">· per staff member</span>
      </div>
      {error ? (
        <p role="status" className="text-sm text-foreground/50">
          The approval counts could not be read. {error}
        </p>
      ) : counts === null ? (
        <p className="text-sm text-foreground/50">Loading approvals…</p>
      ) : counts.staff.length === 0 ? (
        <p className="text-sm text-foreground/50">
          No approvals by hand yet. They appear here when staff press “Confirm Thai rate” at the till.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-foreground/10">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Staff member</TableHead>
                <TableHead className="w-32 text-right">Last {counts.days} days</TableHead>
                <TableHead className="w-24 text-right">Total</TableHead>
                <TableHead className="hidden w-40 sm:table-cell">Last approved</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {counts.staff.map((row) => (
                <TableRow key={row.accountId}>
                  <TableCell className="font-medium">{row.name ?? 'Unknown account'}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.recent}</TableCell>
                  <TableCell className="text-right tabular-nums text-foreground/70">{row.total}</TableCell>
                  <TableCell className="hidden text-sm tabular-nums text-foreground/70 sm:table-cell">
                    {fmtDay(row.lastApprovedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
