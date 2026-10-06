import { useEffect, useMemo, useState } from 'react';
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
  platformReportQuery,
  platformWalletCreditReport,
  promoUsageSummaryOf,
  type WalletCreditReport,
} from '@/lib/reporting';
import { ReportFilterBar, ReportCard, ExportCsvButton, EmptyRow, ShellBanner, csvBaht, thbFromSatang } from './shared';
import type { DiscountTransactions, PromoVoucherReport } from '@oto/shared';
import { voucherPromotionsApi } from '@/api/voucherPromotions';
import { analyticsReportsApi } from '@/api/analyticsReports';
import { getBranches, getDiscounts } from '@/store/catalogStore';

const EMPTY_REPORT: WalletCreditReport = {
  summary: { grantedSatang: 0, spentSatang: 0, refundedSatang: 0, expiredSatang: 0, netOutstandingSatang: 0, entryCount: 0 },
  rows: [],
  totalEntries: 0,
};

/**
 * Wallet-credit + promo-code usage report.
 *
 * S2-14a round 3 — the wallet half reads the PLATFORM's ledger
 * (`platformWalletCreditReport`, `GET /wallets/report`): the figures are the
 * entries summed by kind over the range's business dates, the live balance is
 * the sum of every wallet's balance today, and a wallet belongs to the park
 * that issued it, so the branch filter now applies to it. Round 5 adds the
 * promotional vouchers' foregone-revenue line, the platform's own figures
 * (`GET /vouchers/promotions/report`). S2-15b round 6 (closing sweep): the
 * promo-code usage card reads the platform too — each code's uses counted from
 * the sales (`GET /menu/discounts`, into the catalog) and the range's discount
 * value from the platform's promo rows (`GET /analytics/reports/discounts/transactions`),
 * no longer this browser's mock sales.
 *
 * Note: usedCount/usageLimit on each promo row are lifetime, network-wide
 * catalog counters, but totalDiscountValueSatang is scoped to the current date
 * range + branch filter — the two numbers describe different windows by
 * design, and the table header/CSV label reflect that.
 */
export function WalletPromoReportPanel() {
  const [filters, setFilters] = useState(defaultReportFilters());
  const [report, setReport] = useState<WalletCreditReport>(EMPTY_REPORT);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setLoadError(null);
    platformWalletCreditReport(filters)
      .then((next) => { if (live) setReport(next); })
      .catch((err: unknown) => {
        if (!live) return;
        setReport(EMPTY_REPORT);
        setLoadError(err instanceof Error ? err.message : 'The wallet figures could not be loaded.');
      });
    return () => { live = false; };
  }, [filters]);
  const summary = report.summary;
  const ledger = report.rows;

  /**
   * The range's promo rows, from the platform. A branch only this device knows
   * reads as empty, as every report here does; a refusal empties the card's
   * value column and says why.
   */
  const [promoRows, setPromoRows] = useState<DiscountTransactions['promoRows']>([]);
  const [promoError, setPromoError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setPromoError(null);
    const query = platformReportQuery(filters);
    if (!query) {
      setPromoRows([]);
      return;
    }
    analyticsReportsApi
      .discountTransactions(query)
      .then((next) => {
        if (live) setPromoRows(next.promoRows);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setPromoRows([]);
        setPromoError(err instanceof Error ? err.message : 'The promo code figures could not be loaded.');
      });
    return () => {
      live = false;
    };
  }, [filters]);
  const promos = useMemo(() => promoUsageSummaryOf(getDiscounts(), promoRows), [promoRows]);

  /**
   * S2-14a round 5 — FOREGONE REVENUE FROM PROMOTIONAL VOUCHERS, its own line,
   * separate from discounts (`GET /vouchers/promotions/report`): what the sales
   * that used a voucher did not charge for it, per voucher type, and beside it
   * the credit wallet-credit vouchers loaded (stored value, in the ledger above).
   */
  const [foregone, setForegone] = useState<PromoVoucherReport | null>(null);
  const [foregoneError, setForegoneError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setForegoneError(null);
    const branchApiId =
      filters.branchId === 'all' ? null : (getBranches().find((b) => b.id === filters.branchId)?.apiId ?? undefined);
    if (branchApiId === undefined) {
      setForegone(null);
      return;
    }
    voucherPromotionsApi
      .report({ branchApiId, from: filters.startDate, to: filters.endDate })
      .then((next) => {
        if (live) setForegone(next);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setForegone(null);
        setForegoneError(err instanceof Error ? err.message : 'The voucher figures could not be loaded.');
      });
    return () => {
      live = false;
    };
  }, [filters]);

  const exportLedger = async () => {
    const all = await platformWalletCreditReport(filters, 1000);
    downloadCsv(
      `wallet-ledger_${filters.startDate}_${filters.endDate}`,
      ['Wristband', 'Customer', 'Kind', 'Amount', 'Source', 'At', 'By'],
      all.rows.map((r) => [
        r.wristbandCode,
        r.customerNickname,
        r.kind,
        csvBaht(r.amountSatang),
        r.source,
        r.at,
        r.by ?? '',
      ])
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <ReportFilterBar filters={filters} onChange={setFilters} />

      {loadError && (
        <ShellBanner>
          The wallet figures could not be loaded from the platform — {loadError}
        </ShellBanner>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          { label: 'Granted', value: summary.grantedSatang },
          { label: 'Spent', value: summary.spentSatang },
          { label: 'Refunded', value: summary.refundedSatang },
          { label: 'Expired', value: summary.expiredSatang },
          { label: 'Live balance (today)', value: summary.netOutstandingSatang },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-3">
            <div className="text-[11px] uppercase tracking-wide text-foreground/45">{s.label}</div>
            <div className="mt-1 text-lg font-bold tabular-nums">{thbFromSatang(s.value)}</div>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Movements are recorded at the park where they happened. Live balance is the credit remaining
        on wallets issued by the selected parks, including spending at other parks.
      </p>
      {(summary.reactivatedSatang ?? 0) > 0 && (
        <p className="-mt-3 text-xs text-foreground/50">
          Includes {thbFromSatang(summary.reactivatedSatang ?? 0)} of expired credit a manager reactivated in this range.
        </p>
      )}

      <ReportCard
        title={`Wallet ledger — ${ledger.length} of ${summary.entryCount} entries shown`}
        action={<ExportCsvButton onExport={() => { void exportLedger(); }} />}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Wristband</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>At</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ledger.length === 0 && <EmptyRow colSpan={6} />}
            {ledger.map((r, i) => (
              <TableRow key={`${r.wristbandCode}-${i}`}>
                <TableCell className="font-mono text-xs">{r.wristbandCode}</TableCell>
                <TableCell>{r.customerNickname}</TableCell>
                <TableCell className="capitalize">{r.kind}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(r.amountSatang)}</TableCell>
                <TableCell className="text-xs text-foreground/60">{r.source}</TableCell>
                <TableCell className="text-xs text-foreground/60">
                  {new Date(r.at).toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ReportCard>

      <ReportCard
        title={`Promotional vouchers — foregone revenue ${foregone ? thbFromSatang(foregone.summary.foregoneSatang) : ''}`}
        action={
          <ExportCsvButton
            onExport={() =>
              downloadCsv(
                `voucher-foregone-revenue_${filters.startDate}_${filters.endDate}`,
                ['Voucher', 'Code', 'Kind', 'Redemptions', 'Foregone revenue', 'Credit loaded'],
                (foregone?.rows ?? []).map((r) => [
                  r.nameEn,
                  r.definitionCode,
                  r.kind,
                  r.redemptions,
                  csvBaht(r.foregoneSatang),
                  csvBaht(r.creditLoadedSatang),
                ]),
              )
            }
          />
        }
      >
        {foregoneError && <ShellBanner>The voucher figures could not be loaded — {foregoneError}</ShellBanner>}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Voucher</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead className="text-right">Redemptions</TableHead>
              <TableHead className="text-right">Foregone revenue</TableHead>
              <TableHead className="text-right">Credit loaded</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(foregone?.rows.length ?? 0) === 0 && <EmptyRow colSpan={5} label="No vouchers were used in this range." />}
            {(foregone?.rows ?? []).map((r) => (
              <TableRow key={r.definitionId} data-testid="voucher-foregone-row">
                <TableCell>
                  <div className="font-medium">{r.nameEn}</div>
                  <div className="font-mono text-xs text-foreground/45">{r.definitionCode}</div>
                </TableCell>
                <TableCell className="capitalize">{r.kind.replace('_', ' ')}</TableCell>
                <TableCell className="text-right tabular-nums">{r.redemptions}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(r.foregoneSatang)}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(r.creditLoadedSatang)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="mt-2 text-xs text-foreground/50">
          Separate from discounts: manual discounts and promo codes are not in this line. Credit a wallet-credit voucher
          loaded is stored value — it is in the wallet ledger above until it is spent or expires.
        </p>
      </ReportCard>

      <ReportCard
        title="Promo code usage"
        action={
          <ExportCsvButton
            onExport={() =>
              downloadCsv(
                `promo-code-usage_${filters.startDate}_${filters.endDate}`,
                ['Code', 'Label', 'Type', 'Used', 'Limit', 'Active', 'Total discount value'],
                promos.map((p) => [
                  p.code,
                  p.label,
                  p.type,
                  p.usedCount,
                  p.usageLimit ?? '',
                  p.active ? 'yes' : 'no',
                  csvBaht(p.totalDiscountValueSatang),
                ])
              )
            }
          />
        }
      >
        {promoError && (
          <ShellBanner>
            The promo code figures could not be loaded from the platform — {promoError}
          </ShellBanner>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Label</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Used</TableHead>
              <TableHead className="text-right">Limit</TableHead>
              <TableHead className="text-right">Discount value (range)</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {promos.length === 0 && <EmptyRow colSpan={7} label="No promo codes have been used yet." />}
            {promos.map((p) => (
              <TableRow key={p.code}>
                <TableCell className="font-mono text-xs">{p.code}</TableCell>
                <TableCell>{p.label}</TableCell>
                <TableCell className="capitalize">{p.type.replace('_', ' ')}</TableCell>
                <TableCell className="text-right tabular-nums">{p.usedCount}</TableCell>
                <TableCell className="text-right tabular-nums">{p.usageLimit ?? '—'}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(p.totalDiscountValueSatang)}</TableCell>
                <TableCell>
                  <Badge variant={p.active ? 'secondary' : 'outline'} className="text-[10px]">
                    {p.active ? 'active' : 'inactive'}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ReportCard>
    </div>
  );
}
