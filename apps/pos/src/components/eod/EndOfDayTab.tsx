import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ReconTable } from '@/components/eod/ReconTable';
import { CashCountCard } from '@/components/eod/CashCountCard';
import { ReconSummary } from '@/components/eod/ReconSummary';
import { AmountInput } from '@/components/eod/AmountInput';
import { getEdcTerminals, getEndOfDay, getFloatCarryover, closeEndOfDay } from '@/mockApi';
import { recomputeEndOfDay, withCreditLine } from '@/lib/endOfDay';
import { creditLineKey, useCreditLine } from '@/components/eod/useCreditLine';
import { useOperator } from '@/auth/OperatorContext';
import { EndOfDay as EndOfDayRecord } from '@/types';
import { Lock, Vault } from 'lucide-react';

/**
 * End of Day tab of the "Today" section: staff cash-up that matches the POS's recorded
 * revenue (expected, auto) against what's physically counted / read off the EDC
 * terminals (actual), per channel, flags discrepancies, records the float to leave for
 * tomorrow, and locks the day. Any logged-in operator can run and close it; closed days
 * are read-only. (Date/branch are owned by the Today section, not this tab.)
 */
export function EndOfDayTab({ date, branch }: { date: string; branch: string }) {
  const terminals = getEdcTerminals();
  const { operator } = useOperator();

  const [record, setRecord] = useState<EndOfDayRecord>(() => getEndOfDay(date, branch));

  // Re-load whenever the date changes (or after closing) — picks up a locked record if
  // the day has been closed, otherwise a fresh open one with expected + carried float.
  useEffect(() => {
    setRecord(getEndOfDay(date, branch));
  }, [date, branch]);

  // S2-14a round 3 — the credit line is the platform's figure for this
  // business date (an open day only; a closed day keeps what was locked).
  const credit = useCreditLine(date, branch);
  useEffect(() => {
    if (credit.key !== creditLineKey(date, branch) || credit.expectedTHB === null) return;
    const expected = credit.expectedTHB;
    setRecord((prev) => (prev.date === date && prev.branchId === branch ? withCreditLine(prev, expected) : prev));
  }, [credit, date, branch, record.id, record.status]);

  const readOnly = record.status === 'closed';

  const setActual = (channel: string, value: number | null) =>
    setRecord((prev) =>
      recomputeEndOfDay({
        ...prev,
        lines: prev.lines.map((l) => (l.channel === channel ? { ...l, actualTHB: value } : l)),
      }),
    );

  const setCounted = (countedTHB: number | null) =>
    setRecord((prev) => recomputeEndOfDay({ ...prev, cashCount: { ...prev.cashCount, countedTHB } }));

  const setVouchers = (patch: Partial<{ handedOut: number | null; redeemed: number | null }>) =>
    setRecord((prev) => ({ ...prev, vouchers: { ...prev.vouchers, ...patch } }));

  const onClose = () => {
    if (!operator) return;
    const result = closeEndOfDay(record, operator);
    // null = already closed by someone else; reload to show the locked record.
    setRecord(result ?? getEndOfDay(date, branch));
  };

  const expectedCash = record.lines.find((l) => l.channel === 'cash')?.expectedTHB ?? 0;
  const closedAt = record.closedAt ? new Date(record.closedAt) : null;

  const carry = getFloatCarryover(date, branch);
  const floatSourceLabel = carry.fromDate
    ? `carried from ${carry.fromDate} close`
    : 'standard opening float (no prior close)';

  const counted = record.cashCount.countedTHB;
  const banked =
    counted !== null && record.floatLeftTHB !== null ? counted - record.floatLeftTHB : null;

  return (
    <div className="space-y-4">
      {/* Locked banner */}
      {readOnly && (
        <Card className="p-4 border border-border bg-muted/30 flex items-center gap-3">
          <Lock className="w-5 h-5 text-primary shrink-0" />
          <div className="text-sm">
            <span className="font-semibold">Day closed.</span>{' '}
            <span className="text-muted-foreground">
              Locked by {record.closedBy}
              {closedAt && ` · ${closedAt.toLocaleString()}`}. Read-only.
            </span>
          </div>
        </Card>
      )}

      {/* Summary bar */}
      <ReconSummary record={record} />

      {/* Reconciliation table */}
      <Card className="p-5 bg-card/50">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-3">
          <Vault className="w-4 h-4 text-primary" />
          Reconciliation by channel
          <span className="font-normal">· each EDC terminal listed by TID</span>
        </div>
        <ReconTable
          lines={record.lines}
          terminals={terminals}
          readOnly={readOnly}
          onActual={setActual}
        />
        {credit.error && !readOnly && (
          <p role="status" className="mt-3 text-xs text-amber-600">
            The credit line could not be read from the platform — {credit.error}
          </p>
        )}
      </Card>

      {/* Cash count */}
      <CashCountCard
        cashCount={record.cashCount}
        expectedCashTHB={expectedCash}
        floatSourceLabel={floatSourceLabel}
        readOnly={readOnly}
        onCounted={setCounted}
      />

      {/* Voucher counts */}
      <Card className="p-5 bg-card/50">
        <div className="text-sm font-medium text-muted-foreground mb-4">Voucher counts</div>
        <div className="grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-1.5 text-sm text-muted-foreground">
            Handed out
            <AmountInput
              prefix=""
              ariaLabel="Vouchers handed out"
              value={record.vouchers.handedOut}
              disabled={readOnly}
              onChange={(v) => setVouchers({ handedOut: v })}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm text-muted-foreground">
            Redeemed
            <AmountInput
              prefix=""
              ariaLabel="Vouchers redeemed"
              value={record.vouchers.redeemed}
              disabled={readOnly}
              onChange={(v) => setVouchers({ redeemed: v })}
            />
          </label>
        </div>
      </Card>

      {/* Notes */}
      <Card className="p-5 bg-card/50">
        <label className="block text-sm font-medium text-muted-foreground mb-2">Notes</label>
        <Textarea
          value={record.notes ?? ''}
          disabled={readOnly}
          placeholder="Explain any discrepancy (e.g. ฿500 over on EDC 2 — duplicate settlement)…"
          onChange={(e) => setRecord((prev) => ({ ...prev, notes: e.target.value }))}
          className="min-h-[88px] bg-muted/50 [color-scheme:dark]"
        />
      </Card>

      {/* Close out the drawer */}
      <Card className="p-5 bg-card/50">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-4">
          <Vault className="w-4 h-4 text-primary" />
          Close out the drawer
          <span className="font-normal">· seeds tomorrow's float</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
          <label className="flex flex-col gap-1.5 text-sm text-muted-foreground">
            Float left in drawer (for tomorrow)
            <AmountInput
              ariaLabel="Float left in drawer for tomorrow"
              value={record.floatLeftTHB}
              disabled={readOnly}
              onChange={(v) => setRecord((prev) => ({ ...prev, floatLeftTHB: v }))}
            />
          </label>
          <div className="rounded-xl bg-muted/50 px-4 py-3">
            <div className="text-sm text-muted-foreground">Cash to bank tonight</div>
            <div className="text-lg font-bold tabular-nums">
              {banked === null ? '—' : `฿${banked.toLocaleString()}`}
            </div>
            <div className="text-xs text-muted-foreground">counted − float left</div>
          </div>
        </div>
      </Card>

      {/* Close day */}
      {!readOnly && (
        <div className="flex justify-end pb-2">
          <Button size="lg" className="h-12 px-8 gap-2" onClick={onClose} disabled={!operator}>
            <Lock className="w-4 h-4" />
            Close Day
          </Button>
        </div>
      )}
    </div>
  );
}
