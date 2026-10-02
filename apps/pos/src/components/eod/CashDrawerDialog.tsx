import { useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Banknote, Vault } from 'lucide-react';
import {
  CASH_MOVEMENT_LABELS,
  formatTHB,
  type CashDrawerView,
  type CashManualMovementKind,
  type CashSessionView,
} from '@oto/shared';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { recordDrawerMovement } from '@/api/cash';
import { AmountInput } from './AmountInput';
import { DrawerCountSection } from './DrawerCountSection';
import { cn } from '@/lib/utils';

/**
 * S2-15a round 1 — THE TILL'S CASH ACTION (UI addition; the prototype has no
 * drawer sessions). One dialog for this counter's drawer, in the End of Day's
 * own cards and words:
 *
 *   - closed: the float it will open with ("carried from … close" or the
 *     standard float) and Open drawer;
 *   - open: what the drawer should hold, piece by piece from the ledger; a
 *     paid-out (a manager approves on this screen with their own phone and
 *     password), a safe drop (a witness signs the same way) or a top-up; the
 *     movements so far; and the count that closes it — the same Cash count
 *     and Close out the drawer cards as the End of Day.
 *
 * Satang under the hood, baht on screen.
 */
export function CashDrawerDialog({
  open,
  onOpenChange,
  view,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: CashDrawerView | null;
  error: string | null;
}) {
  const session = view?.session?.status === 'open' ? view.session : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90dvh] p-0">
        <ScrollArea className="max-h-[90dvh]">
          <div className="p-6 space-y-4">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Banknote className="w-5 h-5 text-primary" />
                Cash drawer{view ? ` · ${view.station.name}` : ''}
              </DialogTitle>
              <DialogDescription>
                {!view
                  ? error ?? 'Reading the drawer…'
                  : session
                    ? `Open since ${new Date(session.openedAt).toLocaleTimeString()} · opened by ${session.openedBy.name ?? 'staff'}`
                    : 'The drawer is closed.'}
              </DialogDescription>
            </DialogHeader>

            {view && session && <DrawerSummary session={session} />}
            {view && session && <MovementForm session={session} />}
            {view && session && session.movements.length > 1 && <MovementList session={session} />}
            {view && <DrawerCountSection view={view} />}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function DrawerSummary({ session }: { session: CashSessionView }) {
  const e = session.expected;
  const cells: Array<[string, number, string?]> = [
    ['Float', e.floatSatang],
    ['Cash taken', e.cashInSatang],
    ['Cash refunds', -e.refundOutSatang],
    ['Paid-outs', -e.paidOutSatang],
    ['Safe drops', -e.safeDropSatang],
    ['Top-ups', e.topUpSatang],
  ];
  return (
    <div className="rounded-xl border border-border/60 bg-card/50 p-4">
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-xs">
        {cells.map(([label, v]) => (
          <div key={label} className="rounded-lg bg-muted/50 px-3 py-2">
            <div className="text-muted-foreground">{label}</div>
            <div className="text-sm font-semibold tabular-nums">
              {v < 0 ? '-' : ''}
              {formatTHB(Math.abs(v))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Expected in the drawer now</span>
        <span className="text-lg font-bold tabular-nums">{formatTHB(e.expectedSatang)}</span>
      </div>
    </div>
  );
}

const KINDS: Array<{ kind: CashManualMovementKind; Icon: typeof Vault; second: string | null }> = [
  { kind: 'paid_out', Icon: ArrowUpFromLine, second: 'Manager approving' },
  { kind: 'safe_drop', Icon: Vault, second: 'Witness' },
  { kind: 'top_up', Icon: ArrowDownToLine, second: null },
];

function MovementForm({ session }: { session: CashSessionView }) {
  const [kind, setKind] = useState<CashManualMovementKind>('paid_out');
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const second = KINDS.find((k) => k.kind === kind)!.second;
  const ready = amount !== null && amount > 0 && reason.trim().length > 0 && (!second || (phone.trim() && password));

  const submit = async () => {
    if (!ready || amount === null) return;
    setBusy(true);
    setMessage(null);
    try {
      await recordDrawerMovement(session.id, {
        kind,
        amountSatang: amount,
        reason: reason.trim(),
        ...(second ? { secondPerson: { phone: phone.trim(), password } } : {}),
      });
      setMessage({ ok: true, text: `${CASH_MOVEMENT_LABELS[kind]} of ${formatTHB(amount)} recorded` });
      setAmount(null);
      setReason('');
      setPassword('');
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'That could not be recorded.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-border/60 bg-card/50 p-4 space-y-3">
      <div className="inline-flex rounded-lg bg-muted p-1 gap-1">
        {KINDS.map(({ kind: k, Icon }) => (
          <button
            key={k}
            type="button"
            onClick={() => {
              setKind(k);
              setMessage(null);
            }}
            className={cn(
              'rounded-md px-3 h-9 flex items-center gap-1.5 text-sm font-semibold transition-colors',
              k === kind ? 'bg-background shadow' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="w-4 h-4" />
            {CASH_MOVEMENT_LABELS[k]}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1.5 text-sm text-muted-foreground">
          Amount
          <AmountInput ariaLabel={`${CASH_MOVEMENT_LABELS[kind]} amount`} satang value={amount} onChange={setAmount} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm text-muted-foreground">
          Reason
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={kind === 'paid_out' ? 'e.g. Ice delivery' : kind === 'safe_drop' ? 'e.g. Midday drop' : 'e.g. Coins from the safe'}
            className="h-11"
          />
        </label>
        {second && (
          <>
            <label className="flex flex-col gap-1.5 text-sm text-muted-foreground">
              {second} — phone
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="off" className="h-11" />
            </label>
            <label className="flex flex-col gap-1.5 text-sm text-muted-foreground">
              {second} — password
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
                className="h-11"
              />
            </label>
          </>
        )}
      </div>
      <div className="flex items-center justify-between gap-3">
        <p role="status" className={cn('text-sm', message?.ok ? 'text-emerald-400' : 'text-rose-400')}>
          {message?.text ?? ''}
        </p>
        <Button className="h-11 px-6" onClick={submit} disabled={busy || !ready}>
          Record {CASH_MOVEMENT_LABELS[kind].toLowerCase()}
        </Button>
      </div>
    </div>
  );
}

function MovementList({ session }: { session: CashSessionView }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/50 p-4">
      <div className="text-sm font-medium text-muted-foreground mb-2">In and out of the drawer</div>
      <ul className="divide-y divide-border/60 text-sm">
        {session.movements.map((m) => {
          const out = m.kind === 'paid_out' || m.kind === 'safe_drop' || m.kind === 'refund_out';
          const who = m.approver ? ` · approved by ${m.approver.name ?? 'manager'}` : m.witness ? ` · witnessed by ${m.witness.name ?? 'staff'}` : '';
          return (
            <li key={m.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="font-medium">{CASH_MOVEMENT_LABELS[m.kind]}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {new Date(m.createdAt).toLocaleTimeString()} · {m.actor.name ?? 'staff'}
                  {who}
                  {m.reason ? ` · ${m.reason}` : ''}
                </div>
              </div>
              <div className={cn('tabular-nums font-semibold', out ? 'text-rose-400' : '')}>
                {out ? '-' : ''}
                {formatTHB(m.amountSatang)}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
