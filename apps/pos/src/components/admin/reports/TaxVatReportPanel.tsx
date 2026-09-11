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
import { downloadCsv } from '@/lib/csv';
import {
  defaultReportFilters,
  taxReceiptRows,
  taxReceiptPaymentMethods,
  vatSummary,
  VatSummaryPeriod,
} from '@/lib/reporting';
import { TaxableCategory } from '@/types';
import { ReportFilterBar, ReportCard, ExportCsvButton, EmptyRow, ShellBanner, thb, categoryLabel } from './shared';

const CATEGORY_OPTIONS: TaxableCategory[] = ['tickets', 'fnb', 'bar', 'drop_off', 'parties', 'addons', 'merch'];

/**
 * Bulk tax-receipt export + a category-level VAT summary. Every row is
 * recomputed live through computeTotals/computeFnbTotals/computeMerchTotals
 * → lib/tax.ts — this is not a stored/duplicated tax ledger, so it always
 * matches what the tax engine would print on the original receipt.
 */
export function TaxVatReportPanel() {
  const [filters, setFilters] = useState(defaultReportFilters());
  const [category, setCategory] = useState<TaxableCategory | 'all'>('all');
  const [paymentMethod, setPaymentMethod] = useState<string>('all');
  const [period, setPeriod] = useState<VatSummaryPeriod>('range');

  const paymentMethodOptions = useMemo(() => taxReceiptPaymentMethods(filters), [filters]);
  const receiptFilters = useMemo(() => ({ ...filters, category, paymentMethod }), [filters, category, paymentMethod]);
  const receipts = useMemo(() => taxReceiptRows(receiptFilters), [receiptFilters]);
  const vat = useMemo(() => vatSummary(filters, period), [filters, period]);

  const totalTax = vat.reduce((s, r) => s + r.exclusiveTax + r.inclusiveTax, 0);
  const totalGross = vat.reduce((s, r) => s + r.gross, 0);

  return (
    <div className="flex flex-col gap-5">
      <ReportFilterBar filters={filters} onChange={setFilters} />

      <ReportCard
        title={`VAT summary — ${thb(totalTax)} tax on ${thb(totalGross)} gross`}
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
                    r.netBase.toFixed(2),
                    r.serviceCharge.toFixed(2),
                    r.exclusiveTax.toFixed(2),
                    r.inclusiveTax.toFixed(2),
                    r.gross.toFixed(2),
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
                <TableCell className="text-right tabular-nums">{thb(r.netBase)}</TableCell>
                <TableCell className="text-right tabular-nums">{thb(r.serviceCharge)}</TableCell>
                <TableCell className="text-right tabular-nums">{thb(r.exclusiveTax)}</TableCell>
                <TableCell className="text-right tabular-nums">{thb(r.inclusiveTax)}</TableCell>
                <TableCell className="text-right tabular-nums">{thb(r.gross)}</TableCell>
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
                    r.branchId ?? '',
                    r.operatorName,
                    r.categories.map((c) => categoryLabel(c)).join('; '),
                    r.paymentMethod,
                    r.netSubtotal.toFixed(2),
                    r.serviceCharge.toFixed(2),
                    r.taxTotal.toFixed(2),
                    r.grandTotal.toFixed(2),
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
                <TableCell className="text-right tabular-nums">{thb(r.netSubtotal)}</TableCell>
                <TableCell className="text-right tabular-nums">{thb(r.taxTotal)}</TableCell>
                <TableCell className="text-right tabular-nums">{thb(r.grandTotal)}</TableCell>
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
