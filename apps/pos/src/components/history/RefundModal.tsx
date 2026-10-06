import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { TouchKeypad } from '@/components/shared/TouchKeypad';
import type { RefundMode } from '@/lib/payments';
import { refundAmountFor, type RefundItemOption } from '@/api/history';
import { Undo2, Wallet, RefreshCw, HandCoins, WifiOff } from 'lucide-react';

export interface RefundLineOption {
  id: string;
  label: string;
  amount: number;
}

export interface RefundResult {
  scope: 'full' | 'partial';
  amountTHB: number;
  creditRestoredTHB: number;
  reason: string;
  note?: string;
  // The line ids this refund covers, so a merch refund can return exactly those
  // units to stock. Whole-sale covers every line; a custom ฿ amount covers none.
  lineIds?: string[];
  /**
   * S2-11 — which of the three the refund was, and its amount in satang, so the
   * platform is sent exactly what the dialog showed. Optional because the
   * handheld's own flow (`MobileRefundFlow`) builds results without them.
   */
  mode?: Mode;
  amountSatang?: number;
}

interface RefundModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Largest amount that may still be refunded on this transaction. */
  maxRefund: number;
  /** F&B credit still restorable to the wristband. 0 for tickets. */
  restorableCredit: number;
  lines: RefundLineOption[];
  reasons: string[];
  operatorName: string;
  /**
   * Routing HINT for how this refund is returned, derived from the original tender's
   * kind (card/QR → auto back to source; cash/other → handed back manually). Advisory
   * only — it does not change what is recorded.
   */
  refundMode?: RefundMode;
  onConfirm: (result: RefundResult) => void;
  /**
   * S2-11 — THE PLATFORM DECIDES. Set by a caller that sends the refund and
   * waits for the answer: the dialog stays open on Confirm (`closeOnConfirm`
   * false), shows `busy` while the answer is out, and shows `error` — the
   * platform's own words, e.g. a refund that needs a manager's approval — when
   * it is refused. Left unset, it behaves as the prototype's did: it confirms
   * and closes.
   */
  closeOnConfirm?: boolean;
  busy?: boolean;
  error?: string | null;
  /**
   * S2-11 — REFUNDS ARE ONLINE ONLY. With the station offline the dialog says
   * so, and its button notes the request on this till instead of refunding;
   * the caller keeps the note (`lib/refundRequests.ts`).
   */
  offline?: boolean;
}

type Mode = 'full' | 'item' | 'custom';

/** Baht as the screen shows it, to satang as the platform counts it. */
const toSatang = (baht: number): number => Math.round(baht * 100);

export function RefundModal({
  open,
  onOpenChange,
  maxRefund,
  restorableCredit,
  lines,
  reasons,
  operatorName,
  refundMode,
  onConfirm,
  closeOnConfirm = true,
  busy = false,
  error = null,
  offline = false,
}: RefundModalProps) {
  const [mode, setMode] = useState<Mode>('full');
  const [selectedLineIds, setSelectedLineIds] = useState<string[]>([]);
  const [customValue, setCustomValue] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  // Reset to a clean slate each time the modal opens.
  useEffect(() => {
    if (open) {
      setMode('full');
      setSelectedLineIds([]);
      setCustomValue('');
      setReason('');
      setNote('');
    }
  }, [open]);

  const toggleLine = (id: string) =>
    setSelectedLineIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  // A refund can never exceed what's left to refund on the transaction — the
  // same clamp the platform applies (`refundAmountFor`), in satang, so the
  // figure on the button is the figure sent.
  const resolved = useMemo(() => {
    const options: RefundItemOption[] = lines.map((l) => ({
      id: l.id,
      label: l.label,
      lineIds: [l.id],
      amountSatang: toSatang(l.amount),
    }));
    return refundAmountFor({
      mode: mode === 'full' ? 'whole' : mode === 'item' ? 'items' : 'custom',
      remainingSatang: toSatang(maxRefund),
      options,
      selected: selectedLineIds,
      customSatang: toSatang(Number(customValue) || 0),
    });
  }, [mode, maxRefund, lines, selectedLineIds, customValue]);

  const amountTHB = resolved.amountSatang / 100;
  const scope: 'full' | 'partial' = resolved.amountSatang >= toSatang(maxRefund) ? 'full' : 'partial';
  // F&B credit is refunded first; only the F&B credit portion returns to the tab.
  const creditRestoredTHB = Math.min(amountTHB, restorableCredit);

  const canConfirm = !!reason && resolved.amountSatang > 0 && !busy;

  const handleConfirm = () => {
    if (!canConfirm) return;
    // Whole sale covers every line; by-item covers the picked lines; a custom
    // ฿ amount can't be mapped to specific items, so it restocks nothing.
    const lineIds =
      mode === 'full'
        ? lines.map((l) => l.id)
        : mode === 'item'
          ? selectedLineIds
          : undefined;
    onConfirm({
      scope,
      amountTHB,
      creditRestoredTHB,
      reason,
      note: note.trim() || undefined,
      lineIds,
      mode,
      amountSatang: resolved.amountSatang,
    });
    if (closeOnConfirm) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Undo2 className="w-5 h-5 text-rose-400" />
            Refund
          </DialogTitle>
          <DialogDescription>
            By {operatorName} · up to ฿{maxRefund} refundable · logged for the refunds report.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Scope */}
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Refund</p>
            <div className="grid grid-cols-3 gap-2">
              <Button
                type="button"
                variant={mode === 'full' ? 'default' : 'outline'}
                className="h-12"
                onClick={() => setMode('full')}
              >
                Whole sale
              </Button>
              <Button
                type="button"
                variant={mode === 'item' ? 'default' : 'outline'}
                className="h-12"
                disabled={lines.length === 0}
                onClick={() => setMode('item')}
              >
                By item
              </Button>
              <Button
                type="button"
                variant={mode === 'custom' ? 'default' : 'outline'}
                className="h-12"
                onClick={() => setMode('custom')}
              >
                Amount
              </Button>
            </div>
          </div>

          {/* By-item picker */}
          {mode === 'item' && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Choose items to refund</p>
              <div className="max-h-44 overflow-y-auto space-y-2 pr-1">
                {lines.map((l) => {
                  const checked = selectedLineIds.includes(l.id);
                  return (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => toggleLine(l.id)}
                      className={`w-full flex items-center justify-between rounded-lg border p-3 text-left transition-colors ${
                        checked
                          ? 'border-primary ring-1 ring-primary bg-primary/5'
                          : 'hover:bg-muted'
                      }`}
                    >
                      <span className="flex items-center gap-3 min-w-0">
                        <span
                          className={`w-5 h-5 rounded border flex items-center justify-center shrink-0 text-xs ${
                            checked ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground/40'
                          }`}
                        >
                          {checked ? '✓' : ''}
                        </span>
                        <span className="truncate">{l.label}</span>
                      </span>
                      <span className="font-bold tabular-nums shrink-0">฿{l.amount}</span>
                    </button>
                  );
                })}
              </div>
              {resolved.clamped && resolved.requestedSatang > 0 && (
                <p className="text-sm font-semibold text-amber-400">capped at ฿{maxRefund}</p>
              )}
            </div>
          )}

          {/* Custom amount */}
          {mode === 'custom' && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Amount to refund (฿)</p>
              <div className="flex items-baseline justify-between rounded-lg border bg-muted/40 px-4 h-14">
                <span className="text-3xl font-bold tabular-nums">฿{customValue || '0'}</span>
                {resolved.clamped && resolved.requestedSatang > 0 && (
                  <span className="text-sm font-semibold text-amber-400">capped at ฿{maxRefund}</span>
                )}
              </div>
              <TouchKeypad value={customValue} onChange={setCustomValue} maxLength={6} />
            </div>
          )}

          {/* Reason */}
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">
              Reason <span className="text-destructive">*</span>
            </p>
            <div className="flex flex-wrap gap-2">
              {reasons.map((r) => (
                <Button
                  key={r}
                  type="button"
                  size="sm"
                  variant={reason === r ? 'default' : 'outline'}
                  onClick={() => setReason(r)}
                >
                  {r}
                </Button>
              ))}
            </div>
          </div>

          {/* Note */}
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Note (optional)</p>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add context for the report…"
              rows={2}
            />
          </div>

          {/* Summary */}
          <div className="rounded-lg bg-muted p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Refund amount</span>
              <span className="text-2xl font-black text-rose-400 tabular-nums">−฿{amountTHB}</span>
            </div>
            {creditRestoredTHB > 0 && (
              <div className="flex items-center justify-between text-sm text-primary">
                <span className="flex items-center gap-2">
                  <Wallet className="w-4 h-4" />
                  Back to wristband
                </span>
                <span className="tabular-nums font-semibold">+฿{creditRestoredTHB}</span>
              </div>
            )}
            {refundMode && !offline && (
              <div className="flex items-start gap-2 text-sm text-muted-foreground border-t pt-2">
                {refundMode === 'auto' ? (
                  <RefreshCw className="w-4 h-4 mt-0.5 shrink-0 text-sky-400" />
                ) : (
                  <HandCoins className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" />
                )}
                <span>
                  {refundMode === 'auto'
                    ? 'Returns to the original card / QR automatically.'
                    : 'Hand the refund back to the customer manually.'}
                </span>
              </div>
            )}
            {offline && (
              <div
                className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300 border-t pt-2"
                data-testid="refund-online-only"
              >
                <WifiOff className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  Online only — this station is offline, so no refund can be made now. Note the
                  request on this till and make the refund when the station is back online.
                </span>
              </div>
            )}
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <Button
            className={`w-full h-14 text-lg text-white ${
              offline ? 'bg-amber-600 hover:bg-amber-700' : 'bg-rose-500 hover:bg-rose-600'
            }`}
            disabled={!canConfirm}
            onClick={handleConfirm}
          >
            {!reason
              ? 'Choose a reason to refund'
              : busy
                ? 'Refunding…'
                : offline
                  ? `Note refund request ฿${amountTHB}`
                  : `Refund ฿${amountTHB}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
