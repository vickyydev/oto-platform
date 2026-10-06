import { useMemo, useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { downloadCsv } from '@/lib/csv';
import {
  defaultReportFilters,
  salesByCategory,
  paymentMix,
  ticketSalesByTier,
  fnbSalesByItem,
  merchSalesByItem,
  ticketTypeSalesRows,
  ticketWeekdayWeekendSplit,
  eventCampRevenueRows,
  dropOffNannyRevenueRows,
} from '@/lib/reporting';
import {
  ReportFilterBar,
  ReportCard,
  ExportCsvButton,
  EmptyRow,
  ShellBanner,
  csvBaht,
  thbFromSatang,
  categoryLabel,
} from './shared';

/**
 * Sales report — revenue by taxable category, payment mix, ticket tier split
 * and top F&B/merch items. Every number is re-derived from the same satang
 * engine used at checkout (lib/cartWire.ts, SCRUM-271), summed in satang and
 * drawn in baht only by `thbFromSatang`; nothing here is a parallel total.
 */
export function SalesReportPanel() {
  const [filters, setFilters] = useState(defaultReportFilters());

  const categories = useMemo(() => salesByCategory(filters), [filters]);
  const payments = useMemo(() => paymentMix(filters), [filters]);
  const tiers = useMemo(() => ticketSalesByTier(filters), [filters]);
  const fnbItems = useMemo(() => fnbSalesByItem(filters).slice(0, 15), [filters]);
  const merchItems = useMemo(() => merchSalesByItem(filters).slice(0, 15), [filters]);
  const ticketTypes = useMemo(() => ticketTypeSalesRows(filters), [filters]);
  const weekdayWeekend = useMemo(() => ticketWeekdayWeekendSplit(filters), [filters]);
  const events = useMemo(() => eventCampRevenueRows(filters), [filters]);
  const dropOffNanny = useMemo(() => dropOffNannyRevenueRows(filters), [filters]);

  const totalGross = categories.reduce((s, c) => s + c.grossRevenueSatang, 0);

  return (
    <div className="flex flex-col gap-5">
      <ReportFilterBar filters={filters} onChange={setFilters} />

      <ReportCard
        title={`Revenue by category — ${thbFromSatang(totalGross)} total`}
        action={
          <ExportCsvButton
            onExport={() =>
              downloadCsv(
                `sales-by-category_${filters.startDate}_${filters.endDate}`,
                ['Category', 'Gross Revenue', '% of total', 'Tax Collected', 'Service Charge', 'Transactions'],
                categories.map((c) => [
                  categoryLabel(c.category),
                  csvBaht(c.grossRevenueSatang),
                  c.pctShare.toFixed(1),
                  csvBaht(c.taxCollectedSatang),
                  csvBaht(c.serviceChargeSatang),
                  c.count,
                ])
              )
            }
          />
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Gross</TableHead>
              <TableHead className="text-right">% of total</TableHead>
              <TableHead className="text-right">Tax</TableHead>
              <TableHead className="text-right">Service</TableHead>
              <TableHead className="text-right">Txns</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {categories.length === 0 && <EmptyRow colSpan={6} />}
            {categories.map((c) => (
              <TableRow key={c.category}>
                <TableCell>{categoryLabel(c.category)}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(c.grossRevenueSatang)}</TableCell>
                <TableCell className="text-right tabular-nums">{c.pctShare.toFixed(1)}%</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(c.taxCollectedSatang)}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(c.serviceChargeSatang)}</TableCell>
                <TableCell className="text-right tabular-nums">{c.count}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ReportCard>

      <ReportCard
        title="Payment method mix"
        action={
          <ExportCsvButton
            onExport={() =>
              downloadCsv(
                `payment-mix_${filters.startDate}_${filters.endDate}`,
                ['Method', 'Amount', 'Count'],
                payments.map((p) => [p.method, csvBaht(p.amountSatang), p.count])
              )
            }
          />
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Method</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">Count</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payments.length === 0 && <EmptyRow colSpan={3} />}
            {payments.map((p) => (
              <TableRow key={p.method}>
                <TableCell className="capitalize">{p.method.replace('_', ' ')}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(p.amountSatang)}</TableCell>
                <TableCell className="text-right tabular-nums">{p.count}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ReportCard>

      <ReportCard
        title="Ticket sales by tier"
        action={
          <ExportCsvButton
            onExport={() =>
              downloadCsv(
                `ticket-sales-by-tier_${filters.startDate}_${filters.endDate}`,
                ['Tier', 'Ticket Revenue', 'Drop-off Revenue', 'Sale Count'],
                tiers.map((t) => [t.tier, csvBaht(t.ticketRevenueSatang), csvBaht(t.dropOffRevenueSatang), t.saleCount])
              )
            }
          />
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tier</TableHead>
              <TableHead className="text-right">Ticket revenue</TableHead>
              <TableHead className="text-right">Drop-off revenue</TableHead>
              <TableHead className="text-right">Sales</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tiers.length === 0 && <EmptyRow colSpan={4} />}
            {tiers.map((t) => (
              <TableRow key={t.tier}>
                <TableCell className="capitalize">{t.tier}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(t.ticketRevenueSatang)}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(t.dropOffRevenueSatang)}</TableCell>
                <TableCell className="text-right tabular-nums">{t.saleCount}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ReportCard>

      <ReportCard
        title="Ticket type breakdown"
        action={
          <ExportCsvButton
            onExport={() =>
              downloadCsv(
                `ticket-type-breakdown_${filters.startDate}_${filters.endDate}`,
                ['Ticket type', 'Lines', 'Kids', 'Adults', 'Revenue'],
                ticketTypes.map((t) => [t.name, t.lineCount, t.kids, t.adults, csvBaht(t.revenueSatang)])
              )
            }
          />
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ticket type</TableHead>
              <TableHead className="text-right">Lines</TableHead>
              <TableHead className="text-right">Kids</TableHead>
              <TableHead className="text-right">Adults</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ticketTypes.length === 0 && <EmptyRow colSpan={5} />}
            {ticketTypes.map((t) => (
              <TableRow key={t.ticketTypeId}>
                <TableCell>{t.name}</TableCell>
                <TableCell className="text-right tabular-nums">{t.lineCount}</TableCell>
                <TableCell className="text-right tabular-nums">{t.kids}</TableCell>
                <TableCell className="text-right tabular-nums">{t.adults}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(t.revenueSatang)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ReportCard>

      <div className="grid gap-5 md:grid-cols-2">
        <ReportCard
          title="Weekday / weekend split"
          action={
            <ExportCsvButton
              onExport={() =>
                downloadCsv(
                  `weekday-weekend-split_${filters.startDate}_${filters.endDate}`,
                  ['Mode', 'Sales', 'Revenue'],
                  weekdayWeekend.map((w) => [w.mode, w.saleCount, csvBaht(w.revenueSatang)])
                )
              }
            />
          }
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mode</TableHead>
                <TableHead className="text-right">Sales</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {weekdayWeekend.length === 0 && <EmptyRow colSpan={3} />}
              {weekdayWeekend.map((w) => (
                <TableRow key={w.mode}>
                  <TableCell className="capitalize">{w.mode}</TableCell>
                  <TableCell className="text-right tabular-nums">{w.saleCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{thbFromSatang(w.revenueSatang)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ReportCard>

        <ReportCard
          title="Drop-off / nanny sessions"
          action={
            <ExportCsvButton
              onExport={() =>
                downloadCsv(
                  `dropoff-nanny_${filters.startDate}_${filters.endDate}`,
                  ['Service', 'Sessions', 'Hours', 'Fees'],
                  dropOffNanny.map((d) => [d.service, d.sessionCount, d.totalHours, csvBaht(d.feesSatang)])
                )
              }
            />
          }
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Service</TableHead>
                <TableHead className="text-right">Sessions</TableHead>
                <TableHead className="text-right">Hours</TableHead>
                <TableHead className="text-right">Fees</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dropOffNanny.length === 0 && <EmptyRow colSpan={4} />}
              {dropOffNanny.map((d) => (
                <TableRow key={d.service}>
                  <TableCell className="capitalize">{d.service.replace('_', ' ')}</TableCell>
                  <TableCell className="text-right tabular-nums">{d.sessionCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{d.totalHours}</TableCell>
                  <TableCell className="text-right tabular-nums">{thbFromSatang(d.feesSatang)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ReportCard>
      </div>

      <ReportCard
        title="Event / camp revenue (estimate)"
        action={
          <ExportCsvButton
            onExport={() =>
              downloadCsv(
                `event-camp-revenue_${filters.startDate}_${filters.endDate}`,
                ['Event', 'Type', 'Date', 'Passes sold', 'Attended', 'Est. revenue'],
                events.map((e) => [e.name, e.type, e.date, e.passesSold, e.attended, csvBaht(e.estimatedRevenueSatang)])
              )
            }
          />
        }
      >
        <ShellBanner>
          Estimate, not a ledger total: till-sold event passes carry no back-link to the event they were
          bought for, so revenue here is passes sold × the event's current entry price — not re-derived from
          the sales ledger.
        </ShellBanner>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Event</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Passes sold</TableHead>
              <TableHead className="text-right">Attended</TableHead>
              <TableHead className="text-right">Est. revenue</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.length === 0 && <EmptyRow colSpan={6} />}
            {events.map((e) => (
              <TableRow key={e.eventId}>
                <TableCell>{e.name}</TableCell>
                <TableCell className="capitalize">{e.type}</TableCell>
                <TableCell>{e.date}</TableCell>
                <TableCell className="text-right tabular-nums">{e.passesSold}</TableCell>
                <TableCell className="text-right tabular-nums">{e.attended}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(e.estimatedRevenueSatang)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ReportCard>

      <div className="grid gap-5 md:grid-cols-2">
        <ReportCard
          title="Top F&B items"
          action={
            <ExportCsvButton
              onExport={() =>
                downloadCsv(
                  `fnb-sales-by-item_${filters.startDate}_${filters.endDate}`,
                  ['Item', 'Qty', 'Revenue'],
                  fnbItems.map((i) => [i.name, i.qty, csvBaht(i.revenueSatang)])
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
              </TableRow>
            </TableHeader>
            <TableBody>
              {fnbItems.length === 0 && <EmptyRow colSpan={3} />}
              {fnbItems.map((i) => (
                <TableRow key={i.itemId}>
                  <TableCell>{i.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{i.qty}</TableCell>
                  <TableCell className="text-right tabular-nums">{thbFromSatang(i.revenueSatang)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ReportCard>

        <ReportCard
          title="Top merch items"
          action={
            <ExportCsvButton
              onExport={() =>
                downloadCsv(
                  `merch-sales-by-item_${filters.startDate}_${filters.endDate}`,
                  ['Item', 'Qty', 'Revenue'],
                  merchItems.map((i) => [i.name, i.qty, csvBaht(i.revenueSatang)])
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
              </TableRow>
            </TableHeader>
            <TableBody>
              {merchItems.length === 0 && <EmptyRow colSpan={3} />}
              {merchItems.map((i) => (
                <TableRow key={i.itemId}>
                  <TableCell>{i.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{i.qty}</TableCell>
                  <TableCell className="text-right tabular-nums">{thbFromSatang(i.revenueSatang)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ReportCard>
      </div>
    </div>
  );
}
