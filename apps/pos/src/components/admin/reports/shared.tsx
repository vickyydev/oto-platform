import { ReactNode, useEffect, useRef, useState } from 'react';
import { Download, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ReportFilters, getBranchOptions, platformReportQuery } from '@/lib/reporting';
import type { ReportQuery } from '@/api/analyticsReports';

/**
 * ฿ formatting shared by every report table/card — THE SCREEN EDGE. Every
 * money figure `lib/reporting.ts` returns is satang (SCRUM-271); it is turned
 * into baht here, once, as it is drawn.
 */
export function thbFromSatang(satang: number): string {
  return `฿${(satang / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * A satang figure as an export's cell: baht to two places, the text the
 * prototype's reports wrote (`.toFixed(2)`) — THE CSV EDGE, and the only place
 * a report figure is written out as baht.
 */
export function csvBaht(satang: number): string {
  return (satang / 100).toFixed(2);
}

/**
 * Date-range + branch filter bar shared by every report panel. Pure
 * controlled component — the panel owns the `ReportFilters` state and reads
 * its report again whenever it changes (the platform's, through
 * `usePlatformReport`, since S2-15b round 4).
 */
export function ReportFilterBar({
  filters,
  onChange,
}: {
  filters: ReportFilters;
  onChange: (next: ReportFilters) => void;
}) {
  const branches = getBranchOptions();
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4">
      <div className="flex flex-col gap-1">
        <Label className="text-[11px] uppercase tracking-wide text-foreground/50">From</Label>
        <Input
          type="date"
          value={filters.startDate}
          max={filters.endDate}
          onChange={(e) => onChange({ ...filters, startDate: e.target.value })}
          className="h-9 w-[150px]"
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-[11px] uppercase tracking-wide text-foreground/50">To</Label>
        <Input
          type="date"
          value={filters.endDate}
          min={filters.startDate}
          onChange={(e) => onChange({ ...filters, endDate: e.target.value })}
          className="h-9 w-[150px]"
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-[11px] uppercase tracking-wide text-foreground/50">Branch</Label>
        <Select
          value={filters.branchId}
          onValueChange={(v) => onChange({ ...filters, branchId: v })}
        >
          <SelectTrigger className="h-9 w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All branches</SelectItem>
            {branches.map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/** Small amber banner marking a report/section as a thin-history prototype shell. */
export function ShellBanner({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-700">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export function ExportCsvButton({ onExport, label = 'Export CSV' }: { onExport: () => void; label?: string }) {
  return (
    <Button variant="outline" size="sm" className="gap-1.5" onClick={onExport}>
      <Download className="h-3.5 w-3.5" />
      {label}
    </Button>
  );
}

export function ReportCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-foreground/80">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

export function EmptyRow({ colSpan, label = 'No data in this range.' }: { colSpan: number; label?: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="py-6 text-center text-sm text-foreground/40">
        {label}
      </td>
    </tr>
  );
}

const CATEGORY_LABELS: Record<string, string> = {
  tickets: 'Tickets',
  fnb: 'F&B',
  bar: 'Bar',
  drop_off: 'Drop-off',
  parties: 'Parties',
  addons: 'Add-ons',
  merch: 'Merch',
  stored_value: 'Stored value',
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

/** A platform report as a panel holds it: the answer (empty until one arrives) and why it could not be read. */
export interface PlatformReportState<T> {
  data: T;
  error: string | null;
  loading: boolean;
}

/**
 * S2-15b round 4 — read one platform report for the filter bar's dates and
 * branch, again whenever they (or `extraKey`) change. A branch only this
 * device knows answers `empty` with no request; a refusal keeps `empty` on
 * screen and says why, as the wallet report does.
 */
export function usePlatformReport<T>(
  filters: ReportFilters,
  load: (query: ReportQuery) => Promise<T>,
  empty: T,
  extraKey = '',
): PlatformReportState<T> {
  const [state, setState] = useState<PlatformReportState<T>>({ data: empty, error: null, loading: true });
  const loadRef = useRef(load);
  loadRef.current = load;
  const emptyRef = useRef(empty);
  emptyRef.current = empty;
  useEffect(() => {
    let live = true;
    const query = platformReportQuery(filters);
    if (!query) {
      setState({ data: emptyRef.current, error: null, loading: false });
      return;
    }
    setState((held) => ({ ...held, error: null, loading: true }));
    loadRef
      .current(query)
      .then((data) => {
        if (live) setState({ data, error: null, loading: false });
      })
      .catch((err: unknown) => {
        if (!live) return;
        setState({
          data: emptyRef.current,
          error: err instanceof Error ? err.message : 'The figures could not be loaded.',
          loading: false,
        });
      });
    return () => {
      live = false;
    };
  }, [filters, extraKey]);
  return state;
}

/** The figures could not be read: the panel stays empty and says why (S2-15b round 4). */
export function ReportLoadError({ error }: { error: string | null }) {
  if (!error) return null;
  return <ShellBanner>The figures could not be loaded from the platform — {error}</ShellBanner>;
}
