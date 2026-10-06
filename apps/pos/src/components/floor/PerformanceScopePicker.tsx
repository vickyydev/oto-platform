import { cn } from '@/lib/utils';
import type { PerformanceScope } from '@/components/floor/usePerformance';

/**
 * S2-15b round 3 — UI ADDITION. The Branch choice beside the Today section's
 * Date: this branch, or "All branches" — every branch this account may read,
 * added up on the platform. Rendered only for somebody who may read more than
 * one; drawn as the Date field is (same label, height, radius and fill), in
 * the iPad's size or the phone's `compact` one.
 */
export function PerformanceScopePicker({
  branchName,
  scope,
  onScope,
  compact = false,
  className,
}: {
  branchName: string;
  scope: PerformanceScope;
  onScope: (scope: PerformanceScope) => void;
  compact?: boolean;
  className?: string;
}) {
  return (
    <label className={cn('flex flex-col gap-1 text-muted-foreground', compact ? 'text-xs' : 'text-sm', className)}>
      Branch
      <select
        value={scope}
        onChange={(e) => onScope(e.target.value === 'all' ? 'all' : 'branch')}
        className={cn(
          'rounded-xl bg-muted/50 border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 [color-scheme:dark]',
          compact ? 'h-9 px-3 text-sm' : 'h-11 px-4 text-base',
        )}
      >
        <option value="branch">{branchName}</option>
        <option value="all">All branches</option>
      </select>
    </label>
  );
}
