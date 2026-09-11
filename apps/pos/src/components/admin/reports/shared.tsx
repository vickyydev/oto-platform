import { ReactNode } from 'react';
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
import { ReportFilters, getBranchOptions } from '@/lib/reporting';

/** ฿ formatting shared by every report table/card. */
export function thb(n: number): string {
  return `฿${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Date-range + branch filter bar shared by every report panel. Pure
 * controlled component — the panel owns the `ReportFilters` state and
 * re-runs its lib/reporting.ts query whenever it changes.
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
    <div className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200/90">
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
