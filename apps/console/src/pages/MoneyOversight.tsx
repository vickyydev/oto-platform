import { useEffect, useState, type ReactNode } from 'react';
import { cashDaysForView, settlementDaysForView } from '@/lib/paymentViews';
import { Link } from 'wouter';
import { formatTHB } from '@oto/shared';
import {
  MONEY_RANGE_MAX_DAYS, moneyOversightApi, type MoneyCash, type MoneyCashDay, type MoneyCosts, type MoneyDiscounts,
  type MoneyFilters, type MoneyIntegrity, type MoneyIntegrityCheck, type MoneyRefunds, type MoneySales,
  type MoneySettlement, type MoneyTrace, type MoneyWallets,
} from '@/api/moneyOversight';
import { useSession } from '@/auth/SessionContext';
import { ErrorNote, Loading, PermissionRequired } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { CommandBar } from '@/components/redesign/CommandBar';
import { CodeTag, SelectChip, StatusChip, Tag } from '@/components/redesign/chips';
import { CardShell } from '@/components/redesign/layout';
import { EmptyNote, StatTile, UnreadNote } from '@/components/redesign/StatTile';
import type { Tone } from '@/components/Status';
import { formatExact } from '@/lib/time';
import { useWorkingAuthority } from '@/lib/workingAuthority';

/**
 * SCRUM-647 — Money oversight: the owner's read-only view of the money across
 * parks and tenders. Nothing on this page writes; every read is recorded on
 * the server. A figure that has no source yet is said to be not available —
 * never drawn as a zero.
 */

export interface Slot<T> { data: T | null; error: string | null }
export interface MoneyData {
  sales: Slot<MoneySales>;
  refunds: Slot<MoneyRefunds>;
  discounts: Slot<MoneyDiscounts>;
  cash: Slot<MoneyCash>;
  settlement: Slot<MoneySettlement>;
  wallets: Slot<MoneyWallets>;
  costs: Slot<MoneyCosts>;
  /** Null: the reader does not hold `console:money:investigate`, so the panel is not offered at all. */
  integrity: Slot<MoneyIntegrity> | null;
}

const SECTIONS = ['sales', 'refunds', 'discounts', 'cash', 'settlement', 'wallets', 'costs'] as const;
type SectionKey = (typeof SECTIONS)[number] | 'integrity';
const emptySlot = <T,>(): Slot<T> => ({ data: null, error: null });

function isoToday(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}
function daysBefore(iso: string, days: number): string {
  const at = new Date(`${iso}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - days);
  return at.toISOString().slice(0, 10);
}
function rangeProblem(from: string, to: string): string | null {
  if (!from || !to) return 'Choose both dates.';
  if (from > to) return 'The start date must not be after the end date.';
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (days > MONEY_RANGE_MAX_DAYS) return `Money oversight reads at most ${MONEY_RANGE_MAX_DAYS} days at a time.`;
  return null;
}

export function MoneyOversight() {
  const { has } = useSession();
  if (!has('console:money:read')) {
    return <><CommandBar sectionId="money" /><PermissionRequired permission="console:money:read" /></>;
  }
  return <MoneyOversightBody canInvestigate={has('console:money:investigate')} />;
}

function MoneyOversightBody({ canInvestigate }: { canInvestigate: boolean }) {
  const working = useWorkingAuthority();
  const [branchId, setBranchId] = useState('');
  const [to, setTo] = useState(isoToday);
  const [from, setFrom] = useState(() => daysBefore(isoToday(), 6));
  const [refresh, setRefresh] = useState(0);
  const [parks, setParks] = useState<Array<{ branchId: string; name: string }>>([]);
  const [data, setData] = useState<MoneyData>(() => ({
    sales: emptySlot(), refunds: emptySlot(), discounts: emptySlot(), cash: emptySlot(), settlement: emptySlot(),
    wallets: emptySlot(), costs: emptySlot(), integrity: canInvestigate ? emptySlot() : null,
  }));
  const problem = rangeProblem(from, to);

  useEffect(() => {
    let live = true;
    const filters: MoneyFilters = { branchIds: branchId ? [branchId] : [], from, to };
    const keys: SectionKey[] = canInvestigate ? [...SECTIONS, 'integrity'] : [...SECTIONS];
    setData({
      sales: emptySlot(), refunds: emptySlot(), discounts: emptySlot(), cash: emptySlot(), settlement: emptySlot(),
      wallets: emptySlot(), costs: emptySlot(), integrity: canInvestigate ? emptySlot() : null,
    });
    if (problem) return () => { live = false; };
    for (const key of keys) {
      // Each section's answer lands in its own slot; the slot's type is the section's contract.
      const request: () => Promise<unknown> = () => moneyOversightApi[key](filters);
      void working.run(request).then((answer) => {
        if (!live || !working.isCurrent()) return;
        setData((current) => ({ ...current, [key]: { data: answer, error: null } }));
        if (key === 'sales' && !branchId) setParks((answer as MoneySales).scope.branches);
      }).catch((failure: unknown) => {
        if (!live || !working.isCurrent()) return;
        const message = failure instanceof Error ? failure.message : 'This section could not be read.';
        setData((current) => ({ ...current, [key]: { data: null, error: message } }));
      });
    }
    return () => { live = false; };
  }, [branchId, from, to, refresh, canInvestigate, problem, working.run, working.isCurrent]);

  return <>
    <CommandBar sectionId="money" badges={<Tag>Read only</Tag>}
      actions={<Button variant="outline" onClick={() => setRefresh((value) => value + 1)}>Refresh</Button>} />
    <div className="flex min-w-0 flex-wrap items-end gap-3">
      <SelectChip label="Park" showLabel value={branchId} onChange={setBranchId} anyLabel="All parks you can read"
        options={parks.map((park) => ({ value: park.branchId, label: park.name }))} />
      <label className="min-w-0 text-sm" htmlFor="money-from">From
        <input id="money-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)}
          className="ml-2 h-9 rounded-full border border-border bg-card px-3.5 text-[12.5px] font-semibold text-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
      </label>
      <label className="min-w-0 text-sm" htmlFor="money-to">To
        <input id="money-to" type="date" value={to} onChange={(event) => setTo(event.target.value)}
          className="ml-2 h-9 rounded-full border border-border bg-card px-3.5 text-[12.5px] font-semibold text-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
      </label>
    </div>
    {problem ? <p className="text-sm text-destructive" role="alert">{problem}</p>
      : <MoneyOversightContent data={data} onRetry={() => setRefresh((value) => value + 1)} />}
  </>;
}

// --- The page, from what was read (pure, so it can be rendered on its own) -----------------

const money = (satang: number) => formatTHB(satang);
const days = (n: number) => (n === 1 ? '1 day' : `${n} days`);
const recorded = (value: string | null) => (value ? formatExact(value, 'UTC') : 'Not recorded');

/** A slot's three honest states before its content: loading, could not be read, or read. */
function SlotBody<T>({ slot, what, onRetry, children }: { slot: Slot<T>; what: string; onRetry: () => void; children: (data: T) => ReactNode }) {
  if (slot.error) return <><ErrorNote message={slot.error} onRetry={onRetry} /><UnreadNote what={what} /></>;
  if (!slot.data) return <Loading what={what.toLowerCase()} />;
  return <>{children(slot.data)}</>;
}

/** Not available is its own state: a source that does not exist yet, or a day the source refused. */
export function NotAvailable({ children }: { children: ReactNode }) {
  return <StatusChip tone="idle" className="not-available" title="No figure: this is not a zero">Not available{children ? <> · {children}</> : null}</StatusChip>;
}

function TraceLink({ trace }: { trace: MoneyTrace | null }) {
  if (!trace) return null;
  return <Link href={trace.href} className="text-sm font-semibold text-primary-ink underline underline-offset-4"
    data-trace-kind={trace.kind} data-trace-id={trace.id}>Support trace</Link>;
}

const verdictWords: Record<'ok' | 'off' | 'pending', { tone: Tone; label: string }> = {
  ok: { tone: 'ok', label: 'Matched' }, off: { tone: 'down', label: 'Off' }, pending: { tone: 'warn', label: 'Not counted' },
};

function headline(data: MoneyData) {
  const cash = data.cash.data;
  const cashDays = cash?.branches.flatMap((b) => b.days) ?? [];
  const available = cashDays.filter((d): d is Extract<MoneyCashDay, { available: true }> => d.available);
  const settlementDays = data.settlement.data?.branches.flatMap((b) => b.days) ?? [];
  return {
    cashVariance: available.reduce((sum, d) => sum + d.totalDifferenceSatang, 0),
    cashOff: available.filter((d) => d.verdict === 'off').length,
    cashUnavailable: cashDays.length - available.length,
    cashAllUnavailable: cashDays.length > 0 && available.length === 0,
    unmatched: settlementDays.reduce((sum, d) => sum + d.unmatchedLines.length + d.unmatchedAttempts.length, 0),
    noFile: settlementDays.filter((d) => d.gateway.state === 'no_file').length,
  };
}

function Tile<T>({ slot, label, value, detail, tone }: { slot: Slot<T>; label: string; value: (data: T) => ReactNode; detail?: (data: T) => ReactNode; tone?: (data: T) => Tone | undefined }) {
  if (slot.error) return <StatTile label={label} value="Not read" tone="warn" detail="The request did not answer." />;
  if (!slot.data) return <StatTile label={label} value="…" detail="Loading" />;
  return <StatTile label={label} value={value(slot.data)} detail={detail?.(slot.data)} tone={tone?.(slot.data)} />;
}

export function MoneyOversightContent({ data, onRetry }: { data: MoneyData; onRetry: () => void }) {
  const [cashAttentionOnly, setCashAttentionOnly] = useState(false);
  const [settlementAttentionOnly, setSettlementAttentionOnly] = useState(false);
  const head = headline(data);
  return <div className="flex min-w-0 flex-col gap-5" data-money-page>
    <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Money at a glance">
      <Tile slot={data.sales} label="Sales" value={(d) => money(d.total.revenueSatang)}
        detail={(d) => d.total.provisional ? 'Includes days still provisional' : 'Stored daily summary'} />
      <Tile slot={data.refunds} label="Refunds and voids" value={(d) => money(d.refunds.totalSatang)}
        detail={(d) => `${d.refunds.count} refunds · ${d.voids.count} voids`} />
      <Tile slot={data.cash} label="Cash variance" value={() => head.cashAllUnavailable ? 'Not available' : money(head.cashVariance)}
        tone={() => (head.cashOff > 0 ? 'down' : undefined)}
        detail={(d) => `${days(head.cashOff)} off by more than ${money(d.toleranceSatang)}${head.cashUnavailable ? ` · ${head.cashUnavailable} not available` : ''}`} />
      <Tile slot={data.settlement} label="Settlement" value={() => `${head.unmatched} unmatched`}
        tone={() => (head.unmatched > 0 ? 'warn' : undefined)}
        detail={() => `${days(head.noFile)} with no 2C2P file imported`} />
      <Tile slot={data.wallets} label="Wallet liability" value={(d) => money(d.outstanding.projectionSatang)}
        detail={(d) => `Ledger ${money(d.outstanding.ledgerSatang)}`}
        tone={(d) => (d.outstanding.projectionSatang !== d.outstanding.ledgerSatang ? 'down' : undefined)} />
      <Tile slot={data.costs} label="Voucher and benefit cost" value={(d) => money(d.booths.prizeCostSatang + d.benefits.appliedSatang)}
        detail={(d) => d.booths.prizeCostIncomplete ? 'A prize has no cost set: short' : `Prizes ${money(d.booths.prizeCostSatang)} · benefits ${money(d.benefits.appliedSatang)}`} />
    </div>

    <CardShell title="Sales" note="Per park and business date, by revenue category, from the stored daily summary" id="money-sales">
      <SlotBody slot={data.sales} what="Sales" onRetry={onRetry}>{(d) => d.branches.length === 0
        ? <EmptyNote title="No park in this reading" />
        : d.branches.map((park) => <section key={park.branchId} className="min-w-0 rounded-2xl border p-4" data-money-park={park.branchId}>
          <h3 className="font-bold break-words">{park.name}</h3>
          <p className="text-sm text-muted-foreground">Source {park.source} · last rollup {recorded(park.lastRolledUpAt)}</p>
          <div className="min-w-0 overflow-x-auto"><table className="w-full text-left text-sm">
            <thead><tr>{['Date', 'Revenue', 'Tickets', 'F&B', 'Merch', 'Parties', 'Drop-off', 'Refunds', 'Discounts', 'Comps', ''].map((label) => <th key={label} className="p-2">{label}</th>)}</tr></thead>
            <tbody>{park.days.map((row) => <tr key={row.businessDate ?? 'total'}>
              <td className="p-2">{row.businessDate}</td>
              {[row.revenueSatang, row.ticketsSatang, row.fnbSatang, row.merchSatang, row.partiesSatang, row.dropoffSatang, row.refundsSatang, row.discountsSatang, row.compsSatang]
                .map((value, index) => <td key={index} className="p-2 tabular-nums">{money(value)}</td>)}
              <td className="p-2">{row.provisional ? <StatusChip tone="warn">Provisional</StatusChip> : row.rolledDays === 0 ? <Tag>No sales stored</Tag> : null}</td>
            </tr>)}</tbody>
          </table></div>
        </section>)}</SlotBody>
    </CardShell>

    <CardShell title="Refunds and voids" note="Refunds on their original sale's business date, with who approved them and why" id="money-refunds">
      <SlotBody slot={data.refunds} what="Refunds and voids" onRetry={onRetry}>{(d) => <>
        {d.refunds.rows.length === 0 ? <EmptyNote title="No refunds in these dates" /> : <ul className="divide-y divide-border" aria-label="Refunds">
          {d.refunds.rows.map((row) => <li key={row.number + row.branchId} className="min-w-0 space-y-1 py-2 text-sm">
            <p className="font-semibold break-words">{row.number} · {money(row.amountSatang)} · {row.reason}</p>
            <p className="text-muted-foreground">Approved by {row.approvedBy ?? 'an unnamed account'} · original sale {row.sale.receiptNumber ?? 'without a receipt number'} ({row.sale.businessDate}, {money(row.sale.grossSatang)}){row.pending ? ' · still settling' : ''}</p>
            <TraceLink trace={row.trace} />
          </li>)}
        </ul>}
        {d.refunds.truncated && <p className="text-sm text-muted-foreground">Showing the newest {d.refunds.rows.length} of {d.refunds.count}.</p>}
        {d.voids.rows.length === 0 ? <EmptyNote title="No voids in these dates" /> : <ul className="divide-y divide-border" aria-label="Voids">
          {d.voids.rows.map((row, index) => <li key={index} className="min-w-0 space-y-1 py-2 text-sm">
            <p className="font-semibold break-words">Void · {row.receiptNumber ?? 'cancelled before a receipt'} · {money(row.grossSatang)}</p>
            <p className="text-muted-foreground">By {row.voidedBy ?? 'an unnamed account'} · {row.reason ?? 'no reason recorded'} · {row.businessDate}</p>
            <TraceLink trace={row.trace} />
          </li>)}
        </ul>}
      </>}</SlotBody>
    </CardShell>

    <CardShell title="Discounts, comps and promotions" note="Revenue given up, from the stored report facts" id="money-discounts">
      <SlotBody slot={data.discounts} what="Discounts" onRetry={onRetry}>{(d) => <>
        <div className="grid gap-3 sm:grid-cols-4">
          <StatTile inset label="Revenue given up" value={money(d.foregoneSatang)} />
          <StatTile inset label="Comps" value={money(d.compSatang)} />
          <StatTile inset label="Manual discounts" value={money(d.manualDiscountSatang)} />
          <StatTile inset label="Promotions" value={money(d.promoSatang)} />
        </div>
        {d.byOperator.map((row) => <p key={row.appliedBy} className="text-sm break-words">{row.appliedBy}: comps {money(row.compTotalSatang)} ({row.compCount}) · discounts {money(row.discountTotalSatang)} ({row.discountCount})</p>)}
      </>}</SlotBody>
    </CardShell>

    <CardShell title="Cash days" note="Each park's End of Day as the POS reads it, against the ฿1 tolerance" id="money-cash">
      <label className="flex min-w-0 items-center gap-2 text-sm"><input type="checkbox" checked={cashAttentionOnly}
        onChange={event => setCashAttentionOnly(event.target.checked)} />Only cash days needing attention</label>
      <p className="text-xs text-muted-foreground">This refines the loaded park and date range only. Differences, not-counted and unavailable days remain; overview totals are unchanged.</p>
      <SlotBody slot={data.cash} what="Cash days" onRetry={onRetry}>{(d) => d.branches.map((park) => <section key={park.branchId} className="min-w-0 rounded-2xl border p-4">
        <h3 className="font-bold break-words">{park.name}</h3>
        <p className="text-xs text-muted-foreground">{cashDaysForView(park.days, cashAttentionOnly).length} of {park.days.length} loaded cash days</p>
        {park.days.length === 0 ? <EmptyNote title="No business day has started in these dates" /> : <ul className="divide-y divide-border">
          {cashDaysForView(park.days, cashAttentionOnly).map((day) => <li key={day.businessDate} className="min-w-0 py-2 text-sm" data-cash-day={day.businessDate} data-available={String(day.available)}>
            {day.available ? <>
              <p className="flex flex-wrap items-center gap-2 font-semibold">{day.businessDate}
                <Tag>{day.status === 'closed' ? 'Closed' : 'Open'}</Tag>
                <StatusChip tone={verdictWords[day.verdict].tone}>{verdictWords[day.verdict].label}</StatusChip></p>
              <p className="text-muted-foreground">Float {day.floatSatang === null ? 'not set' : money(day.floatSatang)} · paid-outs {money(day.paidOutSatang)} · safe drops {money(day.safeDropSatang)} · expected {money(day.totalExpectedSatang)} · counted {money(day.totalActualSatang)} · difference {money(day.totalDifferenceSatang)}{day.linesOff ? ` · ${day.linesOff} lines off` : ''}</p>
              {day.closedBy && <p className="text-muted-foreground">Closed by {day.closedBy} at {recorded(day.closedAt)}</p>}
            </> : <p className="flex flex-wrap items-center gap-2"><span className="font-semibold">{day.businessDate}</span>
              <NotAvailable>End of Day could not read this day</NotAvailable>
              <span className="text-muted-foreground break-words">{day.reason}</span></p>}
          </li>)}
        </ul>}
        {park.days.length > 0 && cashDaysForView(park.days, cashAttentionOnly).length === 0 && <EmptyNote title="No cash days need attention in this loaded range" />}
      </section>)}</SlotBody>
    </CardShell>

    <CardShell title="Settlement" note="Per terminal TID and the 2C2P reconciliation file, with unmatched lines either way" id="money-settlement">
      <label className="flex min-w-0 items-center gap-2 text-sm"><input type="checkbox" checked={settlementAttentionOnly}
        onChange={event => setSettlementAttentionOnly(event.target.checked)} />Only settlement days needing attention</label>
      <p className="text-xs text-muted-foreground">This refines the loaded park and date range only. Unmatched evidence, no file and batches not matched remain; overview totals are unchanged.</p>
      <SlotBody slot={data.settlement} what="Settlement" onRetry={onRetry}>{(d) => <>
        <p className="text-sm text-muted-foreground">2C2P files are imported in their documented test format only; the real provider file is not mapped yet, so a day with no file is shown as such, never as settled.</p>
        {d.branches.map((park) => <section key={park.branchId} className="min-w-0 rounded-2xl border p-4">
          <h3 className="font-bold break-words">{park.name}</h3>
          <p className="text-xs text-muted-foreground">{settlementDaysForView(park.days, settlementAttentionOnly).length} of {park.days.length} loaded settlement days</p>
          {settlementDaysForView(park.days, settlementAttentionOnly).map((day) => <div key={day.businessDate} className="min-w-0 space-y-1 border-t py-2 text-sm first:border-t-0" data-settlement-day={day.businessDate}>
            <p className="flex flex-wrap items-center gap-2 font-semibold">{day.businessDate}
              {day.terminals.map((t) => <Tag key={`${t.label}:${t.tid ?? ''}`}>{t.label} {t.tid ?? 'no TID'}: {t.state === 'not_run' ? 'not run' : t.state}</Tag>)}
              {day.gateway.state === 'no_file' ? <NotAvailable>No 2C2P file imported</NotAvailable> : <Tag>2C2P file: {day.gateway.state}</Tag>}
            </p>
            {day.unmatchedLines.map((line, index) => <p key={`l${index}`} className="flex flex-wrap items-center gap-2">File line {line.method} {money(line.amountSatang)} · {line.match.replace(/_/g, ' ')} <TraceLink trace={line.trace} /></p>)}
            {day.unmatchedAttempts.map((attempt, index) => <p key={`a${index}`} className="flex flex-wrap items-center gap-2">Taken {attempt.method} {money(attempt.amountSatang)}{attempt.tid ? ` on ${attempt.tid}` : ''} · no settlement line yet <TraceLink trace={attempt.trace} /></p>)}
          </div>)}
          {park.days.length > 0 && settlementDaysForView(park.days, settlementAttentionOnly).length === 0 && <EmptyNote title="No settlement days need attention in this loaded range" />}
        </section>)}
      </>}</SlotBody>
    </CardShell>

    <CardShell title="Wallet liability" note="Credit owed per business date as the liability job wrote it, and the balances beside their ledger" id="money-wallets">
      <SlotBody slot={data.wallets} what="Wallet liability" onRetry={onRetry}>{(d) => d.branches.map((park) => <section key={park.branchId} className="min-w-0 rounded-2xl border p-4">
        <h3 className="font-bold break-words">{park.name}</h3>
        <p className="text-sm">Balances now {money(park.outstanding.projectionSatang)} · ledger {money(park.outstanding.ledgerSatang)}</p>
        <ul className="text-sm">{park.days.map((day) => <li key={day.businessDate} className="flex flex-wrap items-center gap-2 py-1">
          <span className="font-semibold">{day.businessDate}</span>
          {day.written ? <span>granted {money(day.grantedSatang)} · spent {money(day.spentSatang)} · refunded {money(day.refundedSatang)} · expired {money(day.expiredSatang)} · owed {money(day.outstandingSatang)}</span>
            : <NotAvailable>{day.reason === 'day_not_ended' ? 'the day has not ended' : 'not written yet'}</NotAvailable>}
        </li>)}</ul>
      </section>)}</SlotBody>
    </CardShell>

    <CardShell title="Voucher and benefit cost" note="Booth prize vouchers and staff benefits, from their stored report facts" id="money-costs">
      <SlotBody slot={data.costs} what="Voucher and benefit cost" onRetry={onRetry}>{(d) => <div className="grid gap-3 sm:grid-cols-2">
        <StatTile inset label="Prize vouchers" value={money(d.booths.prizeCostSatang)}
          detail={`${d.booths.vouchersIssued} issued · ${d.booths.vouchersRedeemed} redeemed${d.booths.prizeCostIncomplete ? ' · a prize has no cost set' : ''}`} />
        <StatTile inset label="Staff benefits" value={money(d.benefits.appliedSatang)} detail={`${d.benefits.applications} applications`} />
      </div>}</SlotBody>
    </CardShell>

    {data.integrity && <IntegrityPanel slot={data.integrity} onRetry={onRetry} />}
  </div>;
}

const windowWords: Record<MoneyIntegrityCheck['window'], string> = {
  series_history: 'Whole series history', business_dates: 'Selected dates', now: 'As of now',
};

function IntegrityPanel({ slot, onRetry }: { slot: Slot<MoneyIntegrity>; onRetry: () => void }) {
  return <CardShell title="Money integrity" note="The failures that hide; each row opens in the support trace" id="money-integrity">
    <SlotBody slot={slot} what="Money integrity" onRetry={onRetry}>{(d) => <>
      <p className="text-xs text-muted-foreground">Support trace links open the Support tools page as it arrives on this deployment. Attempts count as stuck after {d.pendingMinutes} minutes.</p>
      {d.checks.map((check) => <section key={check.key} className="min-w-0 rounded-2xl border p-4" data-integrity-check={check.key}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-bold break-words">{check.label}</h3>
          <Tag>{windowWords[check.window]}</Tag>
          {check.rows.length === 0 ? <StatusChip tone="ok">None found</StatusChip> : <StatusChip tone="down">{check.rows.length}{check.truncated ? '+' : ''} found</StatusChip>}
        </div>
        {check.rows.length > 0 && <ul className="mt-2 divide-y divide-border">{check.rows.map((row, index) => <li key={index} className="min-w-0 space-y-1 py-2 text-sm">
          <p className="font-semibold break-words">{row.title}</p>
          <p className="text-muted-foreground break-words">{row.detail}{row.stationName ? ` · ${row.stationName}` : ''}</p>
          <p className="flex min-w-0 flex-wrap items-center gap-1.5">
            {row.saleId && <CodeTag>sale {row.saleId}</CodeTag>}
            {row.attemptId && <CodeTag>attempt {row.attemptId}</CodeTag>}
            {row.actionId && <CodeTag>action {row.actionId}</CodeTag>}
            {row.receiptNumber && <CodeTag>receipt {row.receiptNumber}</CodeTag>}
            {row.walletId && <CodeTag>wallet {row.walletId}</CodeTag>}
            <TraceLink trace={row.trace} />
          </p>
        </li>)}</ul>}
      </section>)}
    </>}</SlotBody>
  </CardShell>;
}
