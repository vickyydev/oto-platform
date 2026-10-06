import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ReconSummary } from '@/components/eod/ReconSummary';
import { AmountInput } from '@/components/eod/AmountInput';
import { CashMovementList } from '@/components/eod/CashMovementList';
import { EodReceiptCard } from '@/components/eod/EodReceiptCard';
import { ProvisionalBanner } from '@/components/eod/ProvisionalBanner';
import { StrandedList } from '@/components/eod/StrandedList';
import { SettlementPanel } from '@/components/eod/SettlementPanel';
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
import { channelLabel, lineFlag, RECON_TOLERANCE_THB } from '@/lib/endOfDay';
import { useOperator } from '@/auth/OperatorContext';
import { Lock, Vault, Banknote } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Portrait-phone version of the End-of-Day cash-up tab.
 * Reuses the exact same getEndOfDay / recomputeEndOfDay / closeEndOfDay logic as
 * the iPad EndOfDayTab — only the layout differs: per-channel rows become vertical
 * cards with large numeric inputs for one-handed use, and sm: grid breakpoints are
 * replaced with single-column stacks.
 *
 * S2-15a round 1 — the same platform record as the iPad tab (`useEndOfDay`): the
 * expected side, the carried float and the lock from `GET /branches/:id/end-of-day`,
 * Close Day through `POST …/end-of-day/close`, entries recomputed in satang with the
 * platform's own `recomputeEndOfDay`.
 *
 * S2-15a round 2 — the same additions as the iPad tab, stacked for one hand:
 * the provisional banner, who is still counted inside with a resolve per row
 * and the manager's override, and a closed day's receipt with Reprint.
 */
export function MobileEndOfDayTab({ date, branch }: { date: string; branch: string }) {
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
      <Card className="p-4 bg-card/50">
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
    <div className="space-y-3 pb-4">
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
        <EodReceiptCard
          compact
          receipt={apiRecord.receipt ?? null}
          reprinting={reprinting}
          error={reprintError}
          onReprint={() => void reprint()}
        />
      )}
      <ProvisionalBanner compact boxes={provisional} onRecheck={() => void recheck()} />

      {/* Summary verdict */}
      <ReconSummary record={record} />

      <SettlementPanel key={`${apiRecord.branchId}:${date}`} branchId={apiRecord.branchId} date={date} canSettle={can('pos:payment:settle')} />

      {/* Per-channel reconciliation — mobile card stack instead of table */}
      <Card className="p-4 bg-card/50">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-3">
          <Vault className="w-4 h-4 text-primary" />
          Reconciliation by channel
        </div>
        <div className="space-y-3">
          {record.lines.map((line) => {
            const flag = lineFlag(line);
            const label = channelLabel(line.channel, terminals);
            const diffClass =
              flag === 'ok'
                ? 'text-emerald-400'
                : flag === 'off'
                  ? 'text-rose-400'
                  : 'text-muted-foreground';
            const diffText =
              line.actualTHB === null
                ? '—'
                : `${line.differenceTHB > 0 ? '+' : line.differenceTHB < 0 ? '-' : ''}฿${Math.abs(line.differenceTHB).toLocaleString()}`;

            return (
              <div key={line.channel} className="rounded-xl bg-muted/40 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{label}</span>
                  <span className={cn('text-sm font-semibold tabular-nums', diffClass)}>
                    {diffText}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                  <div>
                    <div>Expected</div>
                    <div className="text-base font-bold tabular-nums text-foreground">
                      ฿{line.expectedTHB.toLocaleString()}
                    </div>
                  </div>
                  <div>
                    <div>Actual</div>
                    {line.channel === 'cash' ? (
                      <div className="text-base font-bold tabular-nums text-foreground">
                        {line.actualTHB === null
                          ? 'from count'
                          : `฿${line.actualTHB.toLocaleString()}`}
                      </div>
                    ) : (
                      <AmountInput
                        ariaLabel={`Actual for ${label}`}
                        value={line.actualTHB}
                        disabled={readOnly}
                        onChange={(v) => setActual(line.channel, v)}
                        className="mt-0.5"
                      />
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Cash count */}
      <Card className="p-4 bg-card/50">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-3">
          <Banknote className="w-4 h-4 text-primary" />
          Cash count
          <span className="font-normal">· whole branch drawer</span>
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5 text-sm text-muted-foreground">
              Counted cash
              <AmountInput
                ariaLabel="Counted cash"
                value={record.cashCount.countedTHB}
                disabled={readOnly}
                onChange={setCounted}
              />
            </label>
            <div className="flex flex-col gap-1.5 text-sm text-muted-foreground">
              Float (start)
              <div
                className="h-11 rounded-xl bg-muted/30 border border-border/60 px-4 flex items-center justify-end text-base text-foreground tabular-nums"
                aria-label="Start-of-day float"
              >
                ฿{(record.cashCount.floatTHB ?? 0).toLocaleString()}
              </div>
              <span className="text-xs">{floatSourceLabel}</span>
            </div>
          </div>
          {/* Cash income / expected / diff — 3-up row */}
          <div className="grid grid-cols-3 gap-2 text-xs">
            {(() => {
              const income = record.cashCount.cashIncomeTHB;
              const diff = income === null ? null : income - expectedCash;
              const cashFlag =
                diff === null
                  ? 'pending'
                  : Math.abs(diff) <= RECON_TOLERANCE_THB
                    ? 'ok'
                    : 'off';
              return (
                <>
                  <div className="rounded-xl bg-muted/50 px-3 py-2">
                    <div className="text-muted-foreground">Income</div>
                    <div className="text-base font-bold tabular-nums">
                      {income === null ? '—' : `฿${income.toLocaleString()}`}
                    </div>
                    <div className="text-[10px] text-muted-foreground">counted − float</div>
                  </div>
                  <div className="rounded-xl bg-muted/50 px-3 py-2">
                    <div className="text-muted-foreground">Expected</div>
                    <div className="text-base font-bold tabular-nums">
                      ฿{expectedCash.toLocaleString()}
                    </div>
                    <div className="text-[10px] text-muted-foreground">from POS</div>
                  </div>
                  <div className="rounded-xl bg-muted/50 px-3 py-2">
                    <div className="text-muted-foreground">Diff</div>
                    <div
                      className={cn(
                        'text-base font-bold tabular-nums',
                        cashFlag === 'ok' && 'text-emerald-400',
                        cashFlag === 'off' && 'text-rose-400',
                        cashFlag === 'pending' && 'text-muted-foreground',
                      )}
                    >
                      {diff === null
                        ? '—'
                        : `${diff > 0 ? '+' : diff < 0 ? '-' : ''}฿${Math.abs(diff).toLocaleString()}`}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {cashFlag === 'ok' ? 'balanced' : cashFlag === 'off' ? 'over/short' : '—'}
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
          <CashMovementList movements={apiRecord.cashMovements} />
        </div>
      </Card>

      {/* Voucher counts */}
      <Card className="p-4 bg-card/50">
        <div className="text-sm font-medium text-muted-foreground mb-3">Voucher counts</div>
        <div className="grid grid-cols-2 gap-3">
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
      <Card className="p-4 bg-card/50">
        <label className="block text-sm font-medium text-muted-foreground mb-2">Notes</label>
        <Textarea
          value={record.notes ?? ''}
          disabled={readOnly}
          placeholder="Explain any discrepancy…"
          onChange={(e) => {
            const notes = e.target.value;
            setRecord((prev) => withNotes(prev, notes));
          }}
          className="min-h-[72px] bg-muted/50 [color-scheme:dark]"
        />
      </Card>

      {/* Close out the drawer */}
      <Card className="p-4 bg-card/50">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-3">
          <Vault className="w-4 h-4 text-primary" />
          Close out the drawer
          <span className="font-normal">· seeds tomorrow's float</span>
        </div>
        <div className="space-y-3">
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
            <div className="text-xl font-bold tabular-nums">
              {banked === null ? '—' : `฿${banked.toLocaleString()}`}
            </div>
            <div className="text-xs text-muted-foreground">counted − float left</div>
          </div>
        </div>
      </Card>

      {/* S2-15a round 2 — who is still counted inside, resolved here; the override on a closed day */}
      <StrandedList
        compact
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

      {/* Close Day button */}
      {!readOnly && closeError && (
        <p role="alert" className="text-xs text-amber-600">
          {closeError}
        </p>
      )}
      {!readOnly && (
        <Button
          size="lg"
          className="w-full h-14 gap-2 text-base"
          onClick={onClose}
          disabled={!operator || closing || closeBlocked}
        >
          <Lock className="w-4 h-4" />
          Close Day
        </Button>
      )}
    </div>
  );
}
