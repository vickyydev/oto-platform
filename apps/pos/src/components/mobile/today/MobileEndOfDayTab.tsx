import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ReconSummary } from '@/components/eod/ReconSummary';
import { AmountInput } from '@/components/eod/AmountInput';
import { getEdcTerminals, getEndOfDay, getFloatCarryover, closeEndOfDay } from '@/mockApi';
import { recomputeEndOfDay, channelLabel, lineFlag, RECON_TOLERANCE_THB } from '@/lib/endOfDay';
import { useOperator } from '@/auth/OperatorContext';
import { EndOfDay as EndOfDayRecord } from '@/types';
import { Lock, Vault, Banknote } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Portrait-phone version of the End-of-Day cash-up tab.
 * Reuses the exact same getEndOfDay / recomputeEndOfDay / closeEndOfDay logic as
 * the iPad EndOfDayTab — only the layout differs: per-channel rows become vertical
 * cards with large numeric inputs for one-handed use, and sm: grid breakpoints are
 * replaced with single-column stacks.
 */
export function MobileEndOfDayTab({ date, branch }: { date: string; branch: string }) {
  const terminals = getEdcTerminals();
  const { operator } = useOperator();

  const [record, setRecord] = useState<EndOfDayRecord>(() => getEndOfDay(date, branch));

  useEffect(() => {
    setRecord(getEndOfDay(date, branch));
  }, [date, branch]);

  const readOnly = record.status === 'closed';

  const setActual = (channel: string, value: number | null) =>
    setRecord((prev) =>
      recomputeEndOfDay({
        ...prev,
        lines: prev.lines.map((l) => (l.channel === channel ? { ...l, actualTHB: value } : l)),
      }),
    );

  const setCounted = (countedTHB: number | null) =>
    setRecord((prev) =>
      recomputeEndOfDay({ ...prev, cashCount: { ...prev.cashCount, countedTHB } }),
    );

  const setVouchers = (patch: Partial<{ handedOut: number | null; redeemed: number | null }>) =>
    setRecord((prev) => ({ ...prev, vouchers: { ...prev.vouchers, ...patch } }));

  const onClose = () => {
    if (!operator) return;
    const result = closeEndOfDay(record, operator);
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

      {/* Summary verdict */}
      <ReconSummary record={record} />

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
          onChange={(e) => setRecord((prev) => ({ ...prev, notes: e.target.value }))}
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
              onChange={(v) => setRecord((prev) => ({ ...prev, floatLeftTHB: v }))}
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

      {/* Close Day button */}
      {!readOnly && (
        <Button
          size="lg"
          className="w-full h-14 gap-2 text-base"
          onClick={onClose}
          disabled={!operator}
        >
          <Lock className="w-4 h-4" />
          Close Day
        </Button>
      )}
    </div>
  );
}
