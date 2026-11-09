import { useEffect, useState } from 'react';
import { Flag, Hourglass, PauseCircle, RotateCcw, Wallet } from 'lucide-react';
import { HOLD_LABEL_MAX, HOLD_NOTE_MAX, type HeldSale, type HeldSaleKind } from '@oto/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { bahtLabel, type HeldSaleActions, type HeldSaleDesk, type HeldSalesState } from '@/lib/heldSales';

/**
 * SCRUM-774 — UI ADDITIONS, in the till's own design language:
 *
 *   - `HoldSaleButtons`: the payment step's "Hold sale" and "Save as partly
 *     paid", outline buttons above Back and Confirm, each with the reason it
 *     is shut written under it when it is;
 *   - `HoldSaleDialog`: whose sale it is (name or band) and an optional note;
 *   - `HeldSalesPanel`: the branch's Held sales list in the order panel, the
 *     card style of the left-behind sale above it, with Resume, Void (a held
 *     sale) and Cancel and refund (a part-paid one).
 *
 * Every refusal is the platform's sentence, shown where the press was made.
 */

export interface HoldButtonsProps {
  /** Null when the button can be pressed; otherwise why it cannot. */
  holdReason: string | null;
  partPaidReason: string | null;
  onHold: () => void;
  onSavePartPaid: () => void;
  /**
   * SCRUM-796 — Save as partly paid shows only once staff chose Partial
   * payment, or money is already paid on the sale (`partPaidShown` in
   * lib/heldSales). Left out, it shows as it always did.
   */
  showPartPaid?: boolean;
}

export function HoldSaleButtons({ holdReason, partPaidReason, onHold, onSavePartPaid, showPartPaid = true }: HoldButtonsProps) {
  return (
    <div className="mt-6 grid grid-cols-2 gap-3" data-testid="hold-sale-buttons">
      <div className="flex flex-col gap-1">
        <Button variant="outline" size="lg" className="h-14 gap-2" disabled={holdReason !== null} onClick={onHold}>
          <PauseCircle className="h-5 w-5" />
          Hold sale
        </Button>
        {holdReason && <p className="text-xs text-muted-foreground" data-testid="hold-sale-reason">{holdReason}</p>}
      </div>
      {showPartPaid && <div className="flex flex-col gap-1">
        <Button variant="outline" size="lg" className="h-14 gap-2" disabled={partPaidReason !== null} onClick={onSavePartPaid}>
          <Wallet className="h-5 w-5" />
          Save as partly paid
        </Button>
        {partPaidReason && <p className="text-xs text-muted-foreground" data-testid="part-paid-reason">{partPaidReason}</p>}
      </div>}
    </div>
  );
}

export function HoldSaleDialog({
  kind,
  open,
  defaultLabel,
  paidSatang,
  balanceSatang,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  kind: HeldSaleKind;
  open: boolean;
  defaultLabel: string;
  paidSatang: number;
  balanceSatang: number;
  busy: boolean;
  /** The platform's refusal of the last press, in its words. */
  error: string | null;
  onConfirm: (label: string, note: string) => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(defaultLabel);
  const [note, setNote] = useState('');
  useEffect(() => {
    if (open) {
      setLabel(defaultLabel);
      setNote('');
    }
  }, [open, defaultLabel]);
  const partPaid = kind === 'part_paid';
  const missing = label.trim() === '';
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent className="max-w-md" data-testid="hold-sale-dialog">
        <DialogHeader>
          <DialogTitle>{partPaid ? 'Save as partly paid' : 'Hold sale'}</DialogTitle>
          <DialogDescription>
            {partPaid
              ? `${bahtLabel(paidSatang)} paid, balance ${bahtLabel(balanceSatang)}. The sale goes to Held sales on every till at this branch; resuming it asks only for the balance. Bands and the receipt are issued when the balance is paid.`
              : `${bahtLabel(balanceSatang)} to pay. The sale goes to Held sales on every till at this branch. Nothing is issued while it is held, and it is cancelled as not collected if it is still there at midnight.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="hold-label">Customer’s name or band</Label>
            <Input
              id="hold-label"
              data-reads-scans=""
              value={label}
              maxLength={HOLD_LABEL_MAX}
              placeholder="e.g. Khun Anna, or band T1-7KMQ4X"
              onChange={(event) => setLabel(event.target.value)}
              autoFocus
            />
            {missing && <p className="text-xs text-muted-foreground">Say whose sale this is — the customer’s name or their band.</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hold-note">Note (optional)</Label>
            <Input
              id="hold-note"
              value={note}
              maxLength={HOLD_NOTE_MAX}
              placeholder="e.g. Back after lunch"
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-700 dark:text-rose-300" data-testid="hold-sale-error">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>Back</Button>
          <Button disabled={busy || missing} onClick={() => onConfirm(label.trim(), note.trim())}>
            {busy ? 'Saving…' : partPaid ? 'Save as partly paid' : 'Hold sale'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const timeOf = (iso: string, timeZone: string | undefined): string =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });

export type { HeldSaleActions } from '@/lib/heldSales';

export function HeldSalesPanel({
  held,
  timeZone,
  busyId,
  refusal,
  actionsFor,
  onResume,
  onVoid,
  onRefund,
  onDismissRefusal,
}: {
  held: HeldSalesState;
  timeZone?: string;
  busyId: string | null;
  refusal: string | null;
  actionsFor: (sale: HeldSale) => HeldSaleActions;
  onResume: (sale: HeldSale) => void;
  onVoid: (sale: HeldSale, reason: string) => void;
  onRefund: (sale: HeldSale, reason: string) => void;
  onDismissRefusal: () => void;
}) {
  const [asking, setAsking] = useState<{ sale: HeldSale; act: 'void' | 'refund' } | null>(null);
  const [reason, setReason] = useState('');
  if (!held.loaded && !held.error) return null;
  if (held.sales.length === 0 && !held.error && !refusal) return null;
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="held-sales">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-semibold">
          <Hourglass className="h-4 w-4" />
          Held sales
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <span data-testid="held-sales-counts">
            {held.counts.held} held · {held.counts.partPaid} partly paid
          </span>
          <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Read Held sales again" onClick={held.refresh}>
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {held.error && <p role="alert" className="mt-2 text-xs text-rose-700 dark:text-rose-300">Held sales could not be read — {held.error}</p>}
      {refusal && (
        <div role="alert" className="mt-2 rounded-md border border-rose-500/40 bg-rose-500/10 p-2 text-rose-700 dark:text-rose-300" data-testid="held-sales-refusal">
          <p className="text-sm font-semibold leading-snug">{refusal}</p>
          <Button variant="ghost" size="sm" className="mt-1 h-7 px-2" onClick={onDismissRefusal}>Dismiss</Button>
        </div>
      )}
      <ul className="mt-2 space-y-2">
        {held.sales.map((sale) => {
          const actions = actionsFor(sale);
          const partPaid = sale.kind === 'part_paid';
          const busy = busyId === sale.saleId;
          return (
            <li key={sale.holdId} className="rounded-md border border-border bg-background/60 p-2" data-testid="held-sale">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{sale.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {partPaid
                      ? `${bahtLabel(sale.paidSatang)} paid · balance ${bahtLabel(sale.balanceSatang)}`
                      : `${bahtLabel(sale.balanceSatang)} to pay`}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Held by {sale.heldBy.name ?? 'staff'} at {sale.heldStation.name ?? 'a till'} · {timeOf(sale.heldAt, timeZone)}
                  </div>
                  {sale.note && <div className="text-xs italic text-muted-foreground">“{sale.note}”</div>}
                  {sale.flaggedAt && (
                    <div className="mt-0.5 flex items-center gap-1 text-xs font-semibold text-rose-700 dark:text-rose-300">
                      <Flag className="h-3 w-3" /> Flagged for the manager — still partly paid at midnight
                    </div>
                  )}
                </div>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                    partPaid ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300' : 'bg-amber-500/20 text-amber-800 dark:text-amber-200',
                  )}
                >
                  {partPaid ? 'Partly paid' : 'Held'}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" className="h-8" disabled={busy || actions.resumeReason !== null} onClick={() => onResume(sale)}>
                  {partPaid ? 'Resume — take the balance' : 'Resume'}
                </Button>
                {partPaid ? (
                  <Button size="sm" variant="outline" className="h-8" disabled={busy || actions.refundReason !== null}
                    onClick={() => { setReason(''); setAsking({ sale, act: 'refund' }); }}>
                    Cancel and refund
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" className="h-8" disabled={busy || actions.voidReason !== null}
                    onClick={() => { setReason(''); setAsking({ sale, act: 'void' }); }}>
                    Void
                  </Button>
                )}
              </div>
              {[actions.resumeReason, partPaid ? actions.refundReason : actions.voidReason]
                .filter((r): r is string => r !== null)
                .map((r) => <p key={r} className="mt-1 text-xs text-muted-foreground">{r}</p>)}
            </li>
          );
        })}
      </ul>
      <Dialog open={asking !== null} onOpenChange={(next) => { if (!next) setAsking(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {asking?.act === 'refund'
                ? `Cancel and refund ${bahtLabel(asking.sale.paidSatang)}`
                : 'Void this held sale'}
            </DialogTitle>
            <DialogDescription>
              {asking?.act === 'refund'
                ? `${asking.sale.label}: everything paid on this sale goes back the normal way — the same tender, or cash — and the sale is closed. Nothing was issued for it.`
                : `${asking?.sale.label ?? ''}: the sale is closed as void and can never be paid. Nothing was issued for it.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="held-reason">Reason</Label>
            <Input id="held-reason" value={reason} maxLength={120} onChange={(event) => setReason(event.target.value)} autoFocus />
            {reason.trim() === '' && <p className="text-xs text-muted-foreground">A reason is required.</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAsking(null)}>Back</Button>
            <Button
              variant="destructive"
              disabled={reason.trim() === ''}
              onClick={() => {
                if (!asking) return;
                if (asking.act === 'refund') onRefund(asking.sale, reason.trim());
                else onVoid(asking.sale, reason.trim());
                setAsking(null);
              }}
            >
              {asking?.act === 'refund' ? 'Refund and cancel' : 'Void sale'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The list, bound to a till's `useHeldSaleDesk` — what the counter's and the phone's tills draw. */
export function HeldSaleDeskPanel({ desk, timeZone }: { desk: HeldSaleDesk; timeZone?: string }) {
  return (
    <HeldSalesPanel
      held={desk.held}
      {...(timeZone ? { timeZone } : {})}
      busyId={desk.busyId}
      refusal={desk.refusal}
      actionsFor={desk.actionsFor}
      onResume={(sale) => void desk.resume(sale)}
      onVoid={(sale, reason) => void desk.voidHeld(sale, reason)}
      onRefund={(sale, reason) => void desk.refundHeld(sale, reason)}
      onDismissRefusal={desk.dismissRefusal}
    />
  );
}

/** The hold dialog, bound to a till's `useHeldSaleDesk`. */
export function HeldSaleDeskDialog({
  desk,
  defaultLabel,
  paidSatang,
  balanceSatang,
}: {
  desk: HeldSaleDesk;
  defaultLabel: string;
  paidSatang: number;
  balanceSatang: number;
}) {
  return (
    <HoldSaleDialog
      kind={desk.holdKind ?? 'held'}
      open={desk.holdKind !== null}
      defaultLabel={defaultLabel}
      paidSatang={paidSatang}
      balanceSatang={balanceSatang}
      busy={desk.holdBusy}
      error={desk.holdError}
      onConfirm={(label, note) => void desk.confirmHold(label, note)}
      onClose={desk.closeHoldDialog}
    />
  );
}
