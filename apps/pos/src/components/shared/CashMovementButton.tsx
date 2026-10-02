import { useEffect, useMemo, useState } from 'react';
import { Banknote, Loader2 } from 'lucide-react';
import type { CashMovementKind, CashMovementsAnswer } from '@oto/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { idemKey } from '@/api/client';
import { listCashMovements, recordCashMovement } from '@/api/endOfDay';
import { useOperator } from '@/auth/OperatorContext';
import { useBranch } from '@/branch/BranchContext';
import { cn } from '@/lib/utils';

/**
 * S2-15a round 1 — UI ADDITION: the "Cash" action on the station header
 * (SCRUM-215; the prototype has no paid-out or safe drop).
 *
 * Records cash taken out of the branch's takings today — a paid-out, approved
 * by somebody else who can approve one, or a safe drop, witnessed by somebody
 * else at the branch — against the ONE combined count the End of Day expects.
 * The person signed in is the one taking the cash out; the second person is
 * named from the branch's staff, as a refund names its approver
 * (`pos.refund.approved_by_account_id`). The platform refuses a missing,
 * self-named or unentitled second person in its own words, shown here.
 *
 * Same design language as the till's Refund dialog: a two-way choice of
 * outline buttons, the amount, a reason, the platform's refusal in amber.
 */
export function CashMovementButton({ className }: { className?: string }) {
  const { can, operator } = useOperator();
  const { branch } = useBranch();
  const [open, setOpen] = useState(false);
  if (!can('pos:cash:movement') || !branch.apiId || !operator) return null;
  return (
    <>
      <button type="button" className={className} title="Paid-out or safe drop" onClick={() => setOpen(true)}>
        <Banknote className="w-4 h-4" />
        Cash
      </button>
      {open && (
        <CashMovementDialog
          branchApiId={branch.apiId}
          branchName={branch.name}
          selfId={operator.id}
          selfName={operator.name}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}

/**
 * The Cash dialog's amount: the value and `onChange` are integer SATANG (the
 * platform's unit) while the field shows and takes BAHT, to the satang
 * (`1234.50`). Same look as the End of Day's `AmountInput` (which stays the
 * prototype's whole-number field); only this dialog takes baht and satang.
 */
function BahtAmountField({
  value,
  onChange,
  ariaLabel,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  ariaLabel: string;
}) {
  // The typed text is kept while it is being typed ("12." is not a number
  // yet) and re-derived only when the value changes from outside (a reset).
  const [text, setText] = useState<string>(() => (value === null ? '' : String(value / 100)));
  useEffect(() => {
    const typed = text === '' ? null : Math.round(Number(text) * 100);
    if (typed !== value) setText(value === null ? '' : String(value / 100));
    // Only an outside change should rewrite what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
        ฿
      </span>
      <Input
        type="number"
        inputMode="decimal"
        min={0}
        step={0.01}
        aria-label={ariaLabel}
        value={text}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          if (raw === '') return onChange(null);
          const baht = Number(raw);
          if (!Number.isFinite(baht) || baht < 0) return onChange(null);
          onChange(Math.round(baht * 100));
        }}
        className="h-11 text-right text-base tabular-nums [color-scheme:dark] pl-8"
      />
    </div>
  );
}

function CashMovementDialog({
  branchApiId,
  branchName,
  selfId,
  selfName,
  onOpenChange,
}: {
  branchApiId: string;
  branchName: string;
  selfId: string;
  selfName: string;
  onOpenChange: (open: boolean) => void;
}) {
  const [kind, setKind] = useState<CashMovementKind>('paid_out');
  const [amountSatang, setAmountSatang] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [secondId, setSecondId] = useState<string | null>(null);
  const [day, setDay] = useState<CashMovementsAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  // One action id per filled-in form, so a retried press records once.
  const [actionId, setActionId] = useState(() => idemKey());

  useEffect(() => {
    let live = true;
    listCashMovements(branchApiId)
      .then((answer) => live && setDay(answer))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : 'The branch’s staff could not be read.'));
    return () => {
      live = false;
    };
  }, [branchApiId]);

  const candidates = useMemo(
    () => (day?.people ?? []).filter((p) => p.accountId !== selfId && (kind === 'safe_drop' || p.canApprove)),
    [day, kind, selfId],
  );

  const change = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setActionId(idemKey());
    setError(null);
    setDone(null);
  };

  const ready = amountSatang !== null && amountSatang > 0 && reason.trim().length > 0 && secondId !== null && !busy;

  const submit = async () => {
    if (!ready || amountSatang === null) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await recordCashMovement(branchApiId, {
        kind,
        amountSatang,
        reason: reason.trim(),
        ...(kind === 'paid_out' ? { approverAccountId: secondId } : { witnessAccountId: secondId }),
        actionId,
      });
      setDone(`${kind === 'paid_out' ? 'Paid out' : 'Safe drop'} of ฿${(answer.movement.amountSatang / 100).toLocaleString()} recorded.`);
      setAmountSatang(null);
      setReason('');
      setSecondId(null);
      setActionId(idemKey());
      setDay((prev) => (prev ? { ...prev, movements: [...prev.movements, answer.movement] } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The cash movement could not be recorded.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Banknote className="w-5 h-5 text-primary" />
            Cash
          </DialogTitle>
          <DialogDescription>
            By {selfName} · {branchName} · taken off today’s expected cash at End of Day.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={kind === 'paid_out' ? 'default' : 'outline'}
              className="h-12"
              onClick={() => {
                change(setKind)('paid_out');
                setSecondId(null);
              }}
            >
              Paid out
            </Button>
            <Button
              type="button"
              variant={kind === 'safe_drop' ? 'default' : 'outline'}
              className="h-12"
              onClick={() => {
                change(setKind)('safe_drop');
                setSecondId(null);
              }}
            >
              Safe drop
            </Button>
          </div>

          <label className="flex flex-col gap-1.5 text-sm font-medium text-muted-foreground">
            Amount
            <BahtAmountField ariaLabel="Amount taken out" value={amountSatang} onChange={change(setAmountSatang)} />
          </label>

          <label className="flex flex-col gap-1.5 text-sm font-medium text-muted-foreground">
            <span>
              Reason <span className="text-destructive">*</span>
            </span>
            <Input
              value={reason}
              maxLength={500}
              placeholder={kind === 'paid_out' ? 'e.g. Ice from the shop next door' : 'e.g. Midday drop to the safe'}
              onChange={(e) => change(setReason)(e.target.value)}
              className="h-11 rounded-xl bg-muted/50"
            />
          </label>

          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">
              {kind === 'paid_out' ? 'Approved by' : 'Witnessed by'} <span className="text-destructive">*</span>
            </p>
            {day === null && !error ? (
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading the branch’s staff…
              </p>
            ) : candidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {kind === 'paid_out' ? 'Nobody else at this branch can approve a paid-out.' : 'Nobody else at this branch can witness.'}
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {candidates.map((p) => (
                  <Button
                    key={p.accountId}
                    type="button"
                    size="sm"
                    variant={secondId === p.accountId ? 'default' : 'outline'}
                    onClick={() => change(setSecondId)(p.accountId)}
                  >
                    {p.name ?? 'Unnamed'}
                  </Button>
                ))}
              </div>
            )}
          </div>

          {error && (
            <p role="alert" className="text-sm font-semibold text-amber-400">
              {error}
            </p>
          )}
          {done && (
            <p role="status" className="text-sm font-semibold text-emerald-400">
              {done}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" className="h-12" disabled={busy} onClick={() => onOpenChange(false)}>
              Done
            </Button>
            <Button type="button" className={cn('h-12 px-6 gap-2')} disabled={!ready} onClick={() => void submit()}>
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              Record
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
