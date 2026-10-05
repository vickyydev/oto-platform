import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ReconTable } from '@/components/eod/ReconTable';
import { CashCountCard } from '@/components/eod/CashCountCard';
import { CashMovementList } from '@/components/eod/CashMovementList';
import { ReconSummary } from '@/components/eod/ReconSummary';
import { AmountInput } from '@/components/eod/AmountInput';
import { EodReceiptCard } from '@/components/eod/EodReceiptCard';
import { ProvisionalBanner } from '@/components/eod/ProvisionalBanner';
import { StrandedList } from '@/components/eod/StrandedList';
import { useEndOfDay } from '@/components/eod/useEndOfDay';
import {
  edcTerminalsOf,
  floatSourceLabelOf,
  screenEndOfDay,
  withActual,
  withCounted,
  withFloatLeft,
  withNotes,
  withVouchers,
} from '@/api/endOfDay';
import { useOperator } from '@/auth/OperatorContext';
import { Lock, Vault } from 'lucide-react';

/**
 * End of Day tab of the "Today" section: staff cash-up that matches the POS's recorded
 * revenue (expected, auto) against what's physically counted / read off the EDC
 * terminals (actual), per channel, flags discrepancies, records the float to leave for
 * tomorrow, and locks the day. Any logged-in operator can run and close it; closed days
 * are read-only. (Date/branch are owned by the Today section, not this tab.)
 *
 * S2-15a round 1 — on the platform's records (`useEndOfDay`, `api/endOfDay.ts`): the
 * expected side, the carried float, the branch's terminals and the lock all come from
 * `GET /branches/:id/end-of-day`, and Close Day is `POST …/end-of-day/close`. The
 * entries are kept in satang and recomputed with the platform's own
 * `recomputeEndOfDay`, so what is on screen is what gets locked. One combined cash
 * count for the whole branch, as the prototype has it.
 *
 * S2-15a round 2 — UI additions in the same cards and words: the provisional
 * banner (a box still holding records, or an uncorrected clock, refuses the
 * close), the list of who is still counted inside with a resolve per row and
 * the manager's override reason, and on a closed day the End of Day receipt
 * with Reprint and the override it was closed under.
 */
export function EndOfDayTab({ date, branch }: { date: string; branch: string }) {
  const { operator, can } = useOperator();
  const {
    record: apiRecord,
    setRecord,
    error,
    closeError,
    closing,
    close,
    overrideReason,
    setOverrideReason,
    resolving,
    resolveError,
    resolve,
    recheck,
    reprinting,
    reprintError,
    reprint,
  } = useEndOfDay(date, branch);

  if (!apiRecord) {
    return (
      <Card className="p-5 bg-card/50">
        <p role="status" className={error ? 'text-sm text-amber-600' : 'text-sm text-muted-foreground'}>
          {error ? `The End of Day could not be read from the platform — ${error}` : 'Loading End of Day…'}
        </p>
      </Card>
    );
  }

  const record = screenEndOfDay(apiRecord);
  const terminals = edcTerminalsOf(apiRecord);
  const readOnly = record.status === 'closed';

  const setActual = (channel: string, value: number | null) => setRecord((prev) => withActual(prev, channel, value));

  const setCounted = (countedTHB: number | null) => setRecord((prev) => withCounted(prev, countedTHB));

  const setVouchers = (patch: Partial<{ handedOut: number | null; redeemed: number | null }>) =>
    setRecord((prev) => withVouchers(prev, patch));

  const onClose = () => {
    if (!operator) return;
    void close();
  };

  const expectedCash = record.lines.find((l) => l.channel === 'cash')?.expectedTHB ?? 0;
  const closedAt = record.closedAt ? new Date(record.closedAt) : null;

  const floatSourceLabel = floatSourceLabelOf(apiRecord);

  const counted = record.cashCount.countedTHB;
  const banked =
    counted !== null && record.floatLeftTHB !== null ? counted - record.floatLeftTHB : null;

  const provisional = readOnly ? [] : (apiRecord.provisional ?? []);
  const stranded = readOnly ? [] : (apiRecord.stranded ?? []);
  const canOverride = can('pos:cash:approve');
  const closeBlocked = provisional.length > 0 || (stranded.length > 0 && !(canOverride && overrideReason.trim()));

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

      {/* S2-15a round 2 — the receipt of a closed day; the provisional banner of an open one */}
      {readOnly && (
        <EodReceiptCard receipt={apiRecord.receipt ?? null} reprinting={reprinting} error={reprintError} onReprint={() => void reprint()} />
      )}
      <ProvisionalBanner boxes={provisional} onRecheck={() => void recheck()} />

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
      </Card>

      {/* Cash count */}
      <CashCountCard
        cashCount={record.cashCount}
        expectedCashTHB={expectedCash}
        floatSourceLabel={floatSourceLabel}
        readOnly={readOnly}
        onCounted={setCounted}
      >
        <CashMovementList movements={apiRecord.cashMovements} />
      </CashCountCard>

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
          onChange={(e) => {
            const notes = e.target.value;
            setRecord((prev) => withNotes(prev, notes));
          }}
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
              onChange={(v) => setRecord((prev) => withFloatLeft(prev, v))}
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

      {/* S2-15a round 2 — who is still counted inside, resolved here; the override on a closed day */}
      <StrandedList
        rows={stranded}
        override={apiRecord.override ?? null}
        readOnly={readOnly}
        resolving={resolving}
        error={resolveError}
        canOverride={canOverride}
        overrideReason={overrideReason}
        onOverrideReason={setOverrideReason}
        onResolve={(row, reason) => void resolve(row, reason)}
      />

      {/* Close day */}
      {!readOnly && (
        <div className="flex flex-col items-end gap-2 pb-2">
          {closeError && (
            <p role="alert" className="text-xs text-amber-600">
              {closeError}
            </p>
          )}
          <Button size="lg" className="h-12 px-8 gap-2" onClick={onClose} disabled={!operator || closing || closeBlocked}>
            <Lock className="w-4 h-4" />
            Close Day
          </Button>
        </div>
      )}
    </div>
  );
}
