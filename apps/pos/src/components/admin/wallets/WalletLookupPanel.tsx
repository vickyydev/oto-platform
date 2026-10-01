import { useRef, useState, type FormEvent } from 'react';
import { History, RotateCcw, ScanLine, Search, UserRound, Wallet } from 'lucide-react';
import { ApiError, idemKey } from '@/api/client';
import { lookupWallet, reactivateWallet, type ApiWalletRead } from '@/api/wallet';
import { useOperator } from '@/auth/OperatorContext';
import { toast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  WALLET_STATUS_LABEL,
  bahtOf,
  lapsedPartSatang,
  ledgerNewestFirst,
  reactivatableSatang,
  reactivationReasonError,
  walletEntryLabel,
  walletViewStatus,
} from '@/lib/walletView';

/**
 * S2-14a round 3 — THE WALLET VIEW (plan §2.5), in the admin console beside
 * the Wallet & Promo report, where the prototype's admin kept wallet credit.
 *
 * Scan or type a key — a band's code or short code, a voucher's `QR-…` — and
 * the platform's wallet comes back (`GET /wallets/lookup`, `pos:wallet:read`):
 * holder, keys, balance, status and when its credit expires, and the ledger
 * newest first with the counter popover's columns (kind · source · by · time).
 * An expired wallet offers Reactivate to those who hold `pos:wallet:reactivate`:
 * the reason is typed, the amount is exactly what the last expiry took, and the
 * platform writes and audits it (`POST /wallets/:id/reactivate`).
 */
export function WalletLookupPanel() {
  const { can } = useOperator();
  const [key, setKey] = useState('');
  const [read, setRead] = useState<ApiWalletRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // One key per reactivation gesture, so a retried press is the same write.
  const pressKey = useRef<string | null>(null);

  const find = async (event?: FormEvent) => {
    event?.preventDefault();
    const typed = key.trim();
    if (!typed || loading) return;
    setLoading(true);
    setError(null);
    try {
      setRead(await lookupWallet(typed));
      setReason('');
      setReasonError(null);
      pressKey.current = null;
    } catch (err) {
      setRead(null);
      setError(err instanceof Error ? err.message : 'The wallet could not be looked up.');
    } finally {
      setLoading(false);
    }
  };

  const reactivate = async () => {
    if (!read || saving) return;
    const refusal = reactivationReasonError(reason);
    setReasonError(refusal);
    if (refusal) return;
    setSaving(true);
    pressKey.current ??= idemKey();
    try {
      const answer = await reactivateWallet(read.wallet.id, reason.trim(), pressKey.current);
      setRead({ wallet: answer.wallet, ledger: answer.ledger });
      setReason('');
      pressKey.current = null;
      toast({ title: 'Credit reactivated', description: `${bahtOf(answer.wallet.balanceSatang)} is spendable again.` });
    } catch (err) {
      // A refusal is final for this press; a network fault keeps the key for the retry.
      if (err instanceof ApiError) pressKey.current = null;
      toast({
        title: "Couldn't reactivate",
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const view = read?.wallet ?? null;
  const status = view ? walletViewStatus(view) : null;
  const lapsedPart = view ? lapsedPartSatang(view) : 0;
  const ledger = read ? ledgerNewestFirst(read.ledger) : [];
  const back = view && read ? reactivatableSatang(view, read.ledger) : null;
  const mayReactivate = can('pos:wallet:reactivate');

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={(e) => void find(e)} className="flex gap-2">
        <div className="relative flex-1">
          <ScanLine className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground/40" />
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Scan a band or voucher, or type its code"
            aria-label="Wallet key"
            className="pl-9 font-mono"
            autoFocus
          />
        </div>
        <Button type="submit" disabled={!key.trim() || loading} className="gap-1.5">
          <Search className="h-4 w-4" />
          {loading ? 'Looking…' : 'Look up'}
        </Button>
      </form>

      {error && (
        <div role="alert" className="rounded-2xl border border-dashed border-red-500/25 bg-red-500/[0.03] px-6 py-8 text-center text-sm text-red-400">
          {error}
        </div>
      )}

      {!view && !error && (
        <div className="rounded-2xl border border-dashed border-foreground/15 bg-foreground/[0.02] px-6 py-12 text-center text-sm text-foreground/50">
          Scan a guest's band or credit voucher to see its balance and history.
        </div>
      )}

      {view && status && (
        <div className="flex flex-col gap-4 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/20 text-primary">
              <UserRound className="h-6 w-6" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-bold leading-tight">{view.holderName ?? 'Guest'}</div>
              <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                {view.keys.map((k) => (
                  <span key={`${k.kind}:${k.display}`} className="font-mono">
                    {k.kind === 'band' ? `#${k.display}` : k.display}
                  </span>
                ))}
              </div>
            </div>
            <Badge variant={status === 'active' ? 'secondary' : 'outline'} className={status === 'active' ? '' : 'border-red-500/30 text-red-400'}>
              {WALLET_STATUS_LABEL[status]}
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-3">
              <div className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-foreground/45">
                <Wallet className="h-3 w-3" />
                Balance
              </div>
              <div className="mt-1 text-lg font-bold tabular-nums">{bahtOf(view.balanceSatang)}</div>
              {lapsedPart > 0 && (
                <div className="mt-0.5 text-[11px] text-amber-500">
                  {bahtOf(lapsedPart)} expired — goes at day end; {bahtOf(view.balanceSatang - lapsedPart)} spendable
                </div>
              )}
            </div>
            <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-3">
              <div className="text-[11px] uppercase tracking-wide text-foreground/45">Credit expires</div>
              <div className="mt-1 text-sm font-semibold tabular-nums">
                {view.expiresAt ? new Date(view.expiresAt).toLocaleString() : 'Never'}
              </div>
            </div>
          </div>

          {back !== null && back > 0 && (
            <div className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-3">
              <div className="text-sm font-semibold">
                {bahtOf(back)} expired {mayReactivate ? '— bring it back?' : ''}
              </div>
              {mayReactivate ? (
                <div className="mt-2 flex flex-col gap-2">
                  <Textarea
                    value={reason}
                    onChange={(e) => {
                      setReason(e.target.value);
                      if (reasonError) setReasonError(null);
                    }}
                    placeholder="Why is this credit coming back?"
                    aria-label="Reason for reactivating"
                    maxLength={500}
                    rows={2}
                  />
                  {reasonError && <p className="text-xs text-red-400">{reasonError}</p>}
                  <Button onClick={() => void reactivate()} disabled={saving} className="gap-1.5 self-start">
                    <RotateCcw className="h-4 w-4" />
                    {saving ? 'Reactivating…' : `Reactivate ${bahtOf(back)}`}
                  </Button>
                </div>
              ) : (
                <p className="mt-1 text-xs text-foreground/50">Only a manager can bring expired credit back.</p>
              )}
            </div>
          )}

          <div className="border-t border-border/50 pt-3">
            <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              <History className="h-3 w-3" />
              Wallet history
            </div>
            <div className="space-y-1">
              {ledger.map((entry) => {
                const label = walletEntryLabel(entry);
                return (
                  <div key={entry.id} className="flex items-center justify-between text-xs">
                    <span className="capitalize text-muted-foreground">
                      {label.kind}
                      <span className="opacity-70"> · {label.source}</span>
                      {entry.actorName && <span className="opacity-60"> · {entry.actorName}</span>}
                      <span className="ml-1 opacity-40">
                        {new Date(entry.at).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className={`tabular-nums font-semibold ${entry.amountSatang < 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                        {entry.amountSatang > 0 ? '+' : '−'}
                        {bahtOf(Math.abs(entry.amountSatang))}
                      </span>
                      <span className="w-16 text-right tabular-nums text-foreground/40">{bahtOf(entry.balanceAfterSatang)}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
