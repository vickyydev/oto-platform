import { useMemo, useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { TaxReceipts, VatReport } from '@oto/shared';
import { downloadCsv } from '@/lib/csv';
import { defaultReportFilters, type ReportFilters, type VatSummaryPeriod } from '@/lib/reporting';
import { analyticsReportsApi, type ReportQuery } from '@/api/analyticsReports';
import { TaxableCategory } from '@/types';
import {
  ReportFilterBar,
  ReportCard,
  ExportCsvButton,
  EmptyRow,
  ReportLoadError,
  ShellBanner,
  csvBaht,
  thbFromSatang,
  categoryLabel,
  usePlatformReport,
} from './shared';

const CATEGORY_OPTIONS: TaxableCategory[] = ['tickets', 'fnb', 'bar', 'drop_off', 'parties', 'addons', 'merch'];

/** No figures yet, or none for the range. */
export const EMPTY_VAT_REPORT: VatReport = { from: '', to: '', branches: [], omitted: [], period: 'range', rows: [] };
export const EMPTY_TAX_RECEIPTS: TaxReceipts = { from: '', to: '', branches: [], omitted: [], rows: [] };

type ReceiptRow = TaxReceipts['rows'][number];

/**
 * The bulk export's narrowing, as the prototype's `taxReceiptRows` applied it:
 * transactions that touched the category, and were paid by the tender.
 */
export function filterTaxReceipts(rows: readonly ReceiptRow[], category: string, paymentMethod: string): ReceiptRow[] {
  return rows.filter(
    (r) =>
      (category === 'all' || r.categories.includes(category)) &&
      (paymentMethod === 'all' || r.paymentMethod === paymentMethod),
  );
}

/** Every tender token on the range's receipts, for the Payment filter (`taxReceiptPaymentMethods`). */
export function taxReceiptPaymentMethodsOf(rows: readonly ReceiptRow[]): string[] {
  return [...new Set(rows.map((r) => r.paymentMethod))].sort();
}

/**
 * Bulk tax-receipt export + a category-level VAT summary. S2-15b round 4: the
 * VAT summary is the platform's daily category rows
 * (`GET /analytics/reports/tax/vat`), and the receipts are every finalised and
 * refunded sale of the range with the tax figures its receipt printed
 * (`GET /analytics/reports/tax/receipts`) — not a stored/duplicated tax
 * ledger, and every figure is summed in satang before it is shown.
 */
export function TaxVatReportPanel() {
  const [filters, setFilters] = useState(defaultReportFilters());
  const [period, setPeriod] = useState<VatSummaryPeriod>('range');
  const loadVat = useMemo(() => (query: ReportQuery) => analyticsReportsApi.vat(query, period), [period]);
  const vat = usePlatformReport(filters, loadVat, EMPTY_VAT_REPORT, period);
  const receipts = usePlatformReport(filters, analyticsReportsApi.taxReceipts, EMPTY_TAX_RECEIPTS);
  return (
    <TaxVatReportView
      filters={filters}
      onFiltersChange={setFilters}
      period={period}
      onPeriodChange={setPeriod}
      vat={vat.data}
      receipts={receipts.data}
      error={vat.error ?? receipts.error}
    />
  );
}

/** The panel as drawn from its two answers. */
export function TaxVatReportView({
  filters,
  onFiltersChange,
  period,
  onPeriodChange,
  vat: vatReport,
  receipts: receiptReport,
  error = null,
}: {
  filters: ReportFilters;
  onFiltersChange: (next: ReportFilters) => void;
  period: VatSummaryPeriod;
  onPeriodChange: (next: VatSummaryPeriod) => void;
  vat: VatReport;
  receipts: TaxReceipts;
  error?: string | null;
}) {
  const [category, setCategory] = useState<TaxableCategory | 'all'>('all');
  const [paymentMethod, setPaymentMethod] = useState<string>('all');
  const setPeriod = onPeriodChange;

  const paymentMethodOptions = useMemo(() => taxReceiptPaymentMethodsOf(receiptReport.rows), [receiptReport]);
  const receipts = useMemo(
    () => filterTaxReceipts(receiptReport.rows, category, paymentMethod),
    [receiptReport, category, paymentMethod],
  );
  const vat = vatReport.rows;

  const totalTax = vat.reduce((s, r) => s + r.exclusiveTaxSatang + r.inclusiveTaxSatang, 0);
  const totalGross = vat.reduce((s, r) => s + r.grossSatang, 0);

  return (
    <div className="flex flex-col gap-5">
      <ReportFilterBar filters={filters} onChange={onFiltersChange} />
      <ReportLoadError error={error} />

      <ReportCard
        title={`VAT summary — ${thbFromSatang(totalTax)} tax on ${thbFromSatang(totalGross)} gross`}
        action={
          <div className="flex items-center gap-3">
            <div className="flex flex-col gap-1">
              <Label className="text-[11px] uppercase tracking-wide text-foreground/50">Group by</Label>
              <Select value={period} onValueChange={(v) => setPeriod(v as VatSummaryPeriod)}>
                <SelectTrigger className="h-9 w-[130px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="range">Whole range</SelectItem>
                  <SelectItem value="day">Day</SelectItem>
                  <SelectItem value="month">Month</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <ExportCsvButton
              onExport={() =>
                downloadCsv(
                  `vat-summary_${filters.startDate}_${filters.endDate}`,
                  ['Period', 'Category', 'Net base', 'Service charge', 'Exclusive tax', 'Inclusive tax', 'Gross'],
                  vat.map((r) => [
                    r.period ?? 'range',
                    categoryLabel(r.category),
                    csvBaht(r.netBaseSatang),
                    csvBaht(r.serviceChargeSatang),
                    csvBaht(r.exclusiveTaxSatang),
                    csvBaht(r.inclusiveTaxSatang),
                    csvBaht(r.grossSatang),
                  ])
                )
              }
            />
          </div>
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              {period !== 'range' && <TableHead>Period</TableHead>}
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Net base</TableHead>
              <TableHead className="text-right">Service</TableHead>
              <TableHead className="text-right">Excl. tax</TableHead>
              <TableHead className="text-right">Incl. tax</TableHead>
              <TableHead className="text-right">Gross</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {vat.length === 0 && <EmptyRow colSpan={period !== 'range' ? 7 : 6} />}
            {vat.map((r) => (
              <TableRow key={`${r.period}-${r.category}`}>
                {period !== 'range' && <TableCell className="text-xs text-foreground/60">{r.period}</TableCell>}
                <TableCell>{categoryLabel(r.category)}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(r.netBaseSatang)}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(r.serviceChargeSatang)}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(r.exclusiveTaxSatang)}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(r.inclusiveTaxSatang)}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(r.grossSatang)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ReportCard>

      <ReportCard
        title={`Bulk tax-receipt export (${receipts.length} transactions)`}
        action={
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label className="text-[11px] uppercase tracking-wide text-foreground/50">Category</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as TaxableCategory | 'all')}>
                <SelectTrigger className="h-9 w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  {CATEGORY_OPTIONS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {categoryLabel(c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[11px] uppercase tracking-wide text-foreground/50">Payment</Label>
              <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                <SelectTrigger className="h-9 w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All methods</SelectItem>
                  {paymentMethodOptions.map((m) => (
                    <SelectItem key={m} value={m} className="capitalize">
                      {m.replace('_', ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <ExportCsvButton
              label="Export all receipts"
              onExport={() =>
                downloadCsv(
                  `tax-receipts_${filters.startDate}_${filters.endDate}`,
                  [
                    'Kind',
                    'Transaction',
                    'At',
                    'Branch',
                    'Operator',
                    'Category',
                    'Payment method',
                    'Net subtotal',
                    'Service charge',
                    'Tax total',
                    'Grand total',
                    'Tax summary',
                  ],
                  receipts.map((r) => [
                    r.kind,
                    r.transactionId,
                    r.createdAt,
                    r.branchName,
                    r.operatorName,
                    r.categories.map((c) => categoryLabel(c)).join('; '),
                    r.paymentMethod,
                    csvBaht(r.netSubtotalSatang),
                    csvBaht(r.serviceChargeSatang),
                    csvBaht(r.taxTotalSatang),
                    csvBaht(r.grandTotalSatang),
                    r.taxSummaryLabel,
                  ])
                )
              }
            />
          </div>
        }
      >
        <ShellBanner>
          This is a bulk export of the tax data already computed at checkout — not a fiscal e-receipt/e-tax
          invoice. Thailand e-Tax Invoice submission (digital signing + RD gateway) is a backend integration
          out of scope for this front-end prototype.
        </ShellBanner>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Txn</TableHead>
              <TableHead>At</TableHead>
              <TableHead>Operator</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Payment</TableHead>
              <TableHead className="text-right">Subtotal</TableHead>
              <TableHead className="text-right">Tax</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {receipts.length === 0 && <EmptyRow colSpan={8} />}
            {receipts.slice(0, 150).map((r, i) => (
              <TableRow key={`${r.transactionId}-${i}`}>
                <TableCell className="font-mono text-xs">
                  {r.kind}/{r.transactionId}
                </TableCell>
                <TableCell className="text-xs text-foreground/60">
                  {new Date(r.createdAt).toLocaleString()}
                </TableCell>
                <TableCell>{r.operatorName}</TableCell>
                <TableCell className="text-xs text-foreground/60">
                  {r.categories.map((c) => categoryLabel(c)).join(', ')}
                </TableCell>
                <TableCell className="capitalize">{r.paymentMethod.replace('_', ' ')}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(r.netSubtotalSatang)}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(r.taxTotalSatang)}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(r.grandTotalSatang)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {receipts.length > 150 && (
          <p className="text-xs text-foreground/40">
            Showing the first 150 of {receipts.length} transactions on screen — the CSV export
            includes all of them.
          </p>
        )}
      </ReportCard>
    </div>
  );
}
