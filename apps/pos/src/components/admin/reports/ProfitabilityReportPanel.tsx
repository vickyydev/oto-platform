import { useMemo, useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { downloadCsv } from '@/lib/csv';
import { defaultReportFilters, fnbProfitability, merchProfitability, ProfitabilityRow } from '@/lib/reporting';
import { ReportFilterBar, ReportCard, ExportCsvButton, EmptyRow, ShellBanner, thb } from './shared';

function ProfitabilityTable({ rows, exportName, filters }: { rows: ProfitabilityRow[]; exportName: string; filters: { startDate: string; endDate: string } }) {
  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
  const totalCogs = rows.reduce((s, r) => s + r.cogs, 0);
  const totalMargin = totalRevenue - totalCogs;

  return (
    <ReportCard
      title={`Revenue ${thb(totalRevenue)} · COGS ${thb(totalCogs)} · Margin ${thb(totalMargin)}`}
      action={
        <ExportCsvButton
          onExport={() =>
            downloadCsv(
              `${exportName}_${filters.startDate}_${filters.endDate}`,
              ['Item', 'Qty', 'Revenue', 'COGS', 'Margin', 'Margin %', 'Cost tracked'],
              rows.map((r) => [
                r.name,
                r.qty,
                r.revenue.toFixed(2),
                r.cogs.toFixed(2),
                r.margin.toFixed(2),
                r.marginPercent.toFixed(1),
                r.costTracked ? 'yes' : 'no',
              ])
            )
          }
        />
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Item</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Revenue</TableHead>
            <TableHead className="text-right">COGS</TableHead>
            <TableHead className="text-right">Margin</TableHead>
            <TableHead className="text-right">Margin %</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && <EmptyRow colSpan={6} />}
          {rows.map((r) => (
            <TableRow key={r.itemId}>
              <TableCell className="flex items-center gap-1.5">
                {r.name}
                {!r.costTracked && (
                  <Badge variant="outline" className="text-[10px] text-foreground/40">
                    no cost set
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{r.qty}</TableCell>
              <TableCell className="text-right tabular-nums">{thb(r.revenue)}</TableCell>
              <TableCell className="text-right tabular-nums">{thb(r.cogs)}</TableCell>
              <TableCell className="text-right tabular-nums">{thb(r.margin)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {r.costTracked ? `${r.marginPercent.toFixed(1)}%` : '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ReportCard>
  );
}

/**
 * Profitability report — F&B and merch margin against the catalog's optional
 * cost-to-park field (MenuItem.cost / MerchItem.cost). Items with no cost set
 * are flagged rather than silently treated as free.
 */
export function ProfitabilityReportPanel() {
  const [filters, setFilters] = useState(defaultReportFilters());
  const fnbRows = useMemo(() => fnbProfitability(filters), [filters]);
  const merchRows = useMemo(() => merchProfitability(filters), [filters]);
  const anyUntracked = [...fnbRows, ...merchRows].some((r) => !r.costTracked && r.qty > 0);

  return (
    <div className="flex flex-col gap-5">
      <ReportFilterBar filters={filters} onChange={setFilters} />
      {anyUntracked && (
        <ShellBanner>
          Some items sold in this range have no cost-to-park set in the catalog. Their COGS shows
          as ฿0 and margin is understated — set a cost on those items (Admin → F&B Menu / Merch)
          for an accurate figure.
        </ShellBanner>
      )}
      <ProfitabilityTable rows={fnbRows} exportName="fnb-profitability" filters={filters} />
      <ProfitabilityTable rows={merchRows} exportName="merch-profitability" filters={filters} />
    </div>
  );
}
