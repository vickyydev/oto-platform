import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { TouchKeypad } from '@/components/shared/TouchKeypad';
import type { RefundLineOption, RefundResult } from '@/components/history/RefundModal';
import type { RefundMode } from '@/lib/payments';
import { ArrowLeft, Undo2, RefreshCw, HandCoins, Wallet, Check } from 'lucide-react';

type Mode = 'full' | 'item' | 'custom';
type Step = 'scope' | 'reason' | 'confirm';

interface MobileRefundFlowProps {
  maxRefund: number;
  restorableCredit: number;
  lines: RefundLineOption[];
  reasons: string[];
  operatorName: string;
  refundMode?: RefundMode;
  onConfirm: (result: RefundResult) => void;
  onCancel: () => void;
}

export function MobileRefundFlow({
  maxRefund,
  restorableCredit,
  lines,
  reasons,
  operatorName,
  refundMode,
  onConfirm,
  onCancel,
}: MobileRefundFlowProps) {
  const [step, setStep] = useState<Step>('scope');
  const [mode, setMode] = useState<Mode>('full');
  const [selectedLineIds, setSelectedLineIds] = useState<string[]>([]);
  const [customValue, setCustomValue] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    setStep('scope');
    setMode('full');
    setSelectedLineIds([]);
    setCustomValue('');
    setReason('');
    setNote('');
  }, []);

  const toggleLine = (id: string) =>
    setSelectedLineIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const rawAmount = useMemo(() => {
    if (mode === 'full') return maxRefund;
    if (mode === 'item')
      return lines
        .filter((l) => selectedLineIds.includes(l.id))
        .reduce((acc, l) => acc + l.amount, 0);
    return Number(customValue) || 0;
  }, [mode, maxRefund, lines, selectedLineIds, customValue]);

  const amountTHB = Math.min(rawAmount, maxRefund);
  const scope: 'full' | 'partial' = amountTHB >= maxRefund ? 'full' : 'partial';
  const creditRestoredTHB = Math.min(amountTHB, restorableCredit);

  const canAdvanceScope =
    mode === 'full'
      ? true
      : mode === 'item'
        ? selectedLineIds.length > 0
        : Number(customValue) > 0;

  const canConfirm = !!reason && amountTHB > 0;

  const handleConfirm = () => {
    if (!canConfirm) return;
    onConfirm({ scope, amountTHB, creditRestoredTHB, reason, note: note.trim() || undefined });
  };

  const stepBack = () => {
    if (step === 'scope') onCancel();
    else if (step === 'reason') setStep('scope');
    else setStep('reason');
  };

  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 px-4 h-14 border-b bg-card/30">
        <button
          type="button"
          onClick={stepBack}
          className="w-9 h-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 font-bold">
            <Undo2 className="w-4 h-4 text-rose-400 shrink-0" />
            Refund
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {step === 'scope' ? 'How much to refund?' : step === 'reason' ? 'Why?' : 'Confirm refund'}
          </div>
        </div>
        {/* Step dots */}
        <div className="flex items-center gap-1.5 shrink-0">
          {(['scope', 'reason', 'confirm'] as Step[]).map((s, i) => (
            <div
              key={s}
              className={`w-2 h-2 rounded-full transition-colors ${
                step === s
                  ? 'bg-rose-400'
                  : (['scope', 'reason', 'confirm'] as Step[]).indexOf(step) > i
                    ? 'bg-rose-400/40'
                    : 'bg-muted'
              }`}
            />
          ))}
        </div>
      </div>

      {/* ── Step: Scope ── */}
      {step === 'scope' && (
        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          <div className="text-sm text-muted-foreground">
            Up to <span className="font-bold text-foreground">฿{maxRefund}</span> refundable · by{' '}
            {operatorName}
          </div>

          {/* Mode selector */}
          <div className="grid grid-cols-3 gap-2">
            {[
              { key: 'full' as Mode, label: 'Whole sale' },
              { key: 'item' as Mode, label: 'By item', disabled: lines.length === 0 },
              { key: 'custom' as Mode, label: 'Amount' },
            ].map(({ key, label, disabled }) => (
              <button
                key={key}
                type="button"
                disabled={disabled}
                onClick={() => setMode(key)}
                className={`h-14 rounded-xl border text-sm font-semibold transition-colors disabled:opacity-40 ${
                  mode === key
                    ? 'border-rose-400 bg-rose-500/15 text-rose-300'
                    : 'border-border hover:border-muted-foreground hover:text-foreground text-muted-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* By-item picker */}
          {mode === 'item' && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Choose items to refund</p>
              <div className="space-y-2">
                {lines.map((l) => {
                  const checked = selectedLineIds.includes(l.id);
                  return (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => toggleLine(l.id)}
                      className={`w-full flex items-center justify-between rounded-xl border p-4 text-left transition-colors ${
                        checked
                          ? 'border-rose-400 ring-1 ring-rose-400/40 bg-rose-500/10'
                          : 'border-border hover:bg-muted/50'
                      }`}
                    >
                      <span className="flex items-center gap-3 min-w-0">
                        <span
                          className={`w-6 h-6 rounded border-2 flex items-center justify-center shrink-0 ${
                            checked
                              ? 'bg-rose-500 border-rose-500 text-white'
                              : 'border-muted-foreground/40'
                          }`}
                        >
                          {checked && <Check className="w-3.5 h-3.5" />}
                        </span>
                        <span className="truncate font-medium">{l.label}</span>
                      </span>
                      <span className="font-bold tabular-nums shrink-0">฿{l.amount}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Custom amount */}
          {mode === 'custom' && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-muted-foreground">Amount to refund (฿)</p>
              <div className="flex items-baseline justify-between rounded-xl border bg-muted/40 px-5 h-16">
                <span className="text-4xl font-bold tabular-nums">฿{customValue || '0'}</span>
                {Number(customValue) > maxRefund && (
                  <span className="text-sm font-semibold text-amber-400">max ฿{maxRefund}</span>
                )}
              </div>
              <TouchKeypad value={customValue} onChange={setCustomValue} maxLength={6} />
            </div>
          )}

          {/* Amount summary before proceeding */}
          {amountTHB > 0 && (
            <div className="rounded-xl bg-rose-500/10 border border-rose-500/20 px-4 py-3 flex items-center justify-between">
              <span className="text-sm text-rose-300">Refund amount</span>
              <span className="text-2xl font-black tabular-nums text-rose-400">−฿{amountTHB}</span>
            </div>
          )}
        </div>
      )}

      {/* ── Step: Reason ── */}
      {step === 'reason' && (
        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          <div className="rounded-xl bg-rose-500/10 border border-rose-500/20 px-4 py-3 flex items-center justify-between">
            <span className="text-sm text-rose-300">Refund amount</span>
            <span className="text-2xl font-black tabular-nums text-rose-400">−฿{amountTHB}</span>
          </div>

          <div className="space-y-3">
            <p className="text-sm font-medium text-muted-foreground">
              Reason <span className="text-destructive">*</span>
            </p>
            <div className="flex flex-wrap gap-2">
              {reasons.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setReason(r)}
                  className={`px-4 h-10 rounded-full border text-sm font-semibold transition-colors ${
                    reason === r
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border hover:border-muted-foreground text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Note (optional)</p>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add context for the report…"
              rows={3}
              className="w-full rounded-xl border bg-muted/40 px-4 py-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/40 text-foreground placeholder:text-muted-foreground"
            />
          </div>
        </div>
      )}

      {/* ── Step: Confirm ── */}
      {step === 'confirm' && (
        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          <div className="space-y-3">
            <div className="rounded-xl border bg-card/50 p-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Refund amount</span>
                <span className="text-3xl font-black tabular-nums text-rose-400">−฿{amountTHB}</span>
              </div>
              <div className="border-t pt-3 space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Scope</span>
                  <span className="font-semibold capitalize">{scope}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Reason</span>
                  <span className="font-semibold">{reason}</span>
                </div>
                {note && (
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-muted-foreground shrink-0">Note</span>
                    <span className="font-medium text-right italic">"{note}"</span>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">By</span>
                  <span className="font-semibold">{operatorName}</span>
                </div>
              </div>
            </div>

            {creditRestoredTHB > 0 && (
              <div className="rounded-xl border border-primary/30 bg-primary/10 px-4 py-3 flex items-center gap-3">
                <Wallet className="w-5 h-5 text-primary shrink-0" />
                <div>
                  <div className="text-sm font-semibold text-primary">
                    ฿{creditRestoredTHB} back to wristband
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Credit will be restored automatically.
                  </div>
                </div>
              </div>
            )}

            {refundMode && (
              <div
                className={`rounded-xl border px-4 py-3 flex items-start gap-3 ${
                  refundMode === 'auto'
                    ? 'border-sky-500/30 bg-sky-500/10'
                    : 'border-amber-500/30 bg-amber-500/10'
                }`}
              >
                {refundMode === 'auto' ? (
                  <RefreshCw className="w-5 h-5 text-sky-400 shrink-0 mt-0.5" />
                ) : (
                  <HandCoins className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                )}
                <div className="text-sm">
                  {refundMode === 'auto' ? (
                    <span className="text-sky-300">Returns to the original card / QR automatically.</span>
                  ) : (
                    <span className="text-amber-300">Hand the refund back to the customer manually.</span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Footer CTA */}
      <div className="shrink-0 p-4 border-t bg-card/20">
        {step === 'scope' && (
          <Button
            className="w-full h-14 text-base"
            disabled={!canAdvanceScope || amountTHB === 0}
            onClick={() => setStep('reason')}
          >
            Next — choose reason
          </Button>
        )}
        {step === 'reason' && (
          <Button
            className="w-full h-14 text-base"
            disabled={!reason}
            onClick={() => setStep('confirm')}
          >
            Review refund
          </Button>
        )}
        {step === 'confirm' && (
          <Button
            className="w-full h-14 text-lg bg-rose-500 hover:bg-rose-600 text-white"
            disabled={!canConfirm}
            onClick={handleConfirm}
          >
            Confirm refund ฿{amountTHB}
          </Button>
        )}
      </div>
    </div>
  );
}
