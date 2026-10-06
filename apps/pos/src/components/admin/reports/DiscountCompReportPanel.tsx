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
import {
  defaultReportFilters,
  discountAndCompImpact,
  discountImpactByOperator,
  promoDiscountImpact,
  promoDiscountImpactByType,
} from '@/lib/reporting';
import { ReportFilterBar, ReportCard, ExportCsvButton, EmptyRow, ShellBanner, csvBaht, thbFromSatang } from './shared';

/**
 * Discount / comp impact report — every manual discount and comp applied at
 * the till, F&B, or merch station, plus a per-operator rollup ("who's
 * granting comps") and scanned promo-code impact. Manual rows come straight
 * off the recorded Sale/FnbOrder/MerchOrder.manualDiscounts; promo rows are
 * re-derived from the engine's applied promos (`ticketTotals`) — no separate
 * ledger. Every figure is satang until it is drawn (SCRUM-271).
 *
 * "Benefit" impact (guests getting a free menu/merch item via a scanned
 * `free_item` promo code) is scanned-promo revenue foregone, not a manual
 * discount/comp — it's broken out below by type so it's clearly attributable
 * alongside straightforward percent/fixed money-off codes.
 */
export function DiscountCompReportPanel() {
  const [filters, setFilters] = useState(defaultReportFilters());
  const rows = useMemo(() => discountAndCompImpact(filters), [filters]);
  const byOperator = useMemo(() => discountImpactByOperator(filters), [filters]);
  const promoRows = useMemo(() => promoDiscountImpact(filters), [filters]);
  const promoByType = useMemo(() => promoDiscountImpactByType(filters), [filters]);

  const totalComp = rows.filter((r) => r.type === 'comp').reduce((s, r) => s + r.amountSatang, 0);
  const totalDiscount = rows.filter((r) => r.type !== 'comp').reduce((s, r) => s + r.amountSatang, 0);
  const totalPromo = promoRows.reduce((s, r) => s + r.amountSatang, 0);
  const totalBenefit = promoByType.find((p) => p.type === 'free_item')?.amountSatang ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <ReportFilterBar filters={filters} onChange={setFilters} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-3">
          <div className="text-[11px] uppercase tracking-wide text-foreground/45">Total comps</div>
          <div className="mt-1 text-lg font-bold tabular-nums">{thbFromSatang(totalComp)}</div>
        </div>
        <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-3">
          <div className="text-[11px] uppercase tracking-wide text-foreground/45">Manual discounts</div>
          <div className="mt-1 text-lg font-bold tabular-nums">{thbFromSatang(totalDiscount)}</div>
        </div>
        <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-3">
          <div className="text-[11px] uppercase tracking-wide text-foreground/45">Promo codes</div>
          <div className="mt-1 text-lg font-bold tabular-nums">{thbFromSatang(totalPromo)}</div>
        </div>
        <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-3">
          <div className="text-[11px] uppercase tracking-wide text-foreground/45">Free-item benefit</div>
          <div className="mt-1 text-lg font-bold tabular-nums">{thbFromSatang(totalBenefit)}</div>
        </div>
        <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-3">
          <div className="text-[11px] uppercase tracking-wide text-foreground/45">Total impact</div>
          <div className="mt-1 text-lg font-bold tabular-nums">{thbFromSatang(totalComp + totalDiscount + totalPromo)}</div>
        </div>
      </div>

      <ReportCard
        title="Promo impact by type"
        action={
          <ExportCsvButton
            onExport={() =>
              downloadCsv(
                `promo-impact-by-type_${filters.startDate}_${filters.endDate}`,
                ['Type', 'Count', 'Amount'],
                promoByType.map((p) => [p.type, p.count, csvBaht(p.amountSatang)])
              )
            }
          />
        }
      >
        <ShellBanner>
          "Free item" is a benefit, not a money-off code: the guest receives a menu/merch item at ฿0,
          valued here at that item's cart price via the same scanned-discount math used at checkout.
        </ShellBanner>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Count</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {promoByType.length === 0 && <EmptyRow colSpan={3} />}
            {promoByType.map((p) => (
              <TableRow key={p.type}>
                <TableCell className="capitalize">
                  {p.type === 'free_item' ? 'Free item (benefit)' : p.type.replace('_', ' ')}
                </TableCell>
                <TableCell className="text-right tabular-nums">{p.count}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(p.amountSatang)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ReportCard>

      <ReportCard
        title="By operator"
        action={
          <ExportCsvButton
            onExport={() =>
              downloadCsv(
                `discount-comp-by-operator_${filters.startDate}_${filters.endDate}`,
                ['Operator', 'Comp count', 'Comp total', 'Discount count', 'Discount total'],
                byOperator.map((o) => [
                  o.appliedBy,
                  o.compCount,
                  csvBaht(o.compTotalSatang),
                  o.discountCount,
                  csvBaht(o.discountTotalSatang),
                ])
              )
            }
          />
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Operator</TableHead>
              <TableHead className="text-right">Comps</TableHead>
              <TableHead className="text-right">Comp ฿</TableHead>
              <TableHead className="text-right">Discounts</TableHead>
              <TableHead className="text-right">Discount ฿</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {byOperator.length === 0 && <EmptyRow colSpan={5} />}
            {byOperator.map((o) => (
              <TableRow key={o.appliedBy}>
                <TableCell>{o.appliedBy}</TableCell>
                <TableCell className="text-right tabular-nums">{o.compCount}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(o.compTotalSatang)}</TableCell>
                <TableCell className="text-right tabular-nums">{o.discountCount}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(o.discountTotalSatang)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ReportCard>

      <ReportCard
        title={`Promo code impact (${promoRows.length})`}
        action={
          <ExportCsvButton
            onExport={() =>
              downloadCsv(
                `promo-discount-impact_${filters.startDate}_${filters.endDate}`,
                ['Transaction', 'At', 'Operator', 'Code', 'Label', 'Type', 'Amount'],
                promoRows.map((r) => [
                  r.transactionId,
                  r.createdAt,
                  r.operatorName,
                  r.code,
                  r.label,
                  r.type,
                  csvBaht(r.amountSatang),
                ])
              )
            }
          />
        }
      >
        <p className="text-xs text-foreground/40">
          Ticket-only: promo codes are scanned at the till; F&B and merch orders have no scanned-discount field.
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Txn</TableHead>
              <TableHead>At</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {promoRows.length === 0 && <EmptyRow colSpan={5} />}
            {promoRows.slice(0, 150).map((r, i) => (
              <TableRow key={`${r.transactionId}-${r.code}-${i}`}>
                <TableCell className="font-mono text-xs">{r.transactionId}</TableCell>
                <TableCell className="text-xs text-foreground/60">
                  {new Date(r.createdAt).toLocaleString()}
                </TableCell>
                <TableCell>
                  {r.code}
                  <div className="text-xs text-foreground/40">{r.label}</div>
                </TableCell>
                <TableCell className="capitalize">{r.type.replace('_', ' ')}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(r.amountSatang)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ReportCard>

      <ReportCard
        title={`Transactions (${rows.length})`}
        action={
          <ExportCsvButton
            onExport={() =>
              downloadCsv(
                `discount-comp-transactions_${filters.startDate}_${filters.endDate}`,
                ['Source', 'Transaction', 'At', 'Operator', 'Type', 'Reason', 'Note', 'Amount', 'Applied by'],
                rows.map((r) => [
                  r.source,
                  r.transactionId,
                  r.createdAt,
                  r.operatorName,
                  r.type,
                  r.reason,
                  r.note ?? '',
                  csvBaht(r.amountSatang),
                  r.appliedBy,
                ])
              )
            }
          />
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Txn</TableHead>
              <TableHead>At</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Applied by</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && <EmptyRow colSpan={6} />}
            {rows.slice(0, 150).map((r, i) => (
              <TableRow key={`${r.transactionId}-${i}`}>
                <TableCell className="font-mono text-xs">
                  {r.source}/{r.transactionId}
                </TableCell>
                <TableCell className="text-xs text-foreground/60">
                  {new Date(r.createdAt).toLocaleString()}
                </TableCell>
                <TableCell>
                  <Badge variant={r.type === 'comp' ? 'secondary' : 'outline'} className="text-[10px] capitalize">
                    {r.type}
                  </Badge>
                </TableCell>
                <TableCell>
                  {r.reason}
                  {r.note && <div className="text-xs text-foreground/40">{r.note}</div>}
                </TableCell>
                <TableCell>{r.appliedBy}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(r.amountSatang)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ReportCard>
    </div>
  );
}
