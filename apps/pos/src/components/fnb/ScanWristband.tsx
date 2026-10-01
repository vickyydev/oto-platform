import { useState } from 'react';
import { Wristband } from '@/types';
import { getWristbandByCode, getMockWristbands } from '@/mockApi';
import { ApiError } from '@/api/client';
import { scanWallet } from '@/api/wallet';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScanLine, UserRound, Wallet, AlertCircle, ArrowRight, Gift } from 'lucide-react';

interface ScanWristbandProps {
  onLoadTab: (wristband: Wristband) => void;
  /** When provided, shows the "continue as guest" fallback. Omit to hide it. */
  onGuest?: () => void;
  /** Override the default heading/subheading (e.g. for the History lookup). */
  title?: string;
  subtitle?: string;
  /** When set, an unknown code calls back here instead of showing the inline error. */
  onUnknownCode?: (code: string) => void;
}

export function ScanWristband({
  onLoadTab,
  onGuest,
  title = 'Scan Wristband',
  subtitle = "Scan or type a wristband code to load the customer's tab.",
  onUnknownCode,
}: ScanWristbandProps) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  // S2-14a round 2 — the demo bands carry the allergy and prepaid-item notes
  // the stations still show from this till's own list, but NO credit: the only
  // spendable balance is a platform wallet's, so a demo band reads ฿0 rather
  // than offering money the platform does not hold.
  const presets = getMockWristbands().map(withoutLocalCredit);

  const submit = async (value: string) => {
    if (looking) return;
    setLooking(true);
    const found = await loadScannedTab(value);
    setLooking(false);
    if (found.error) {
      setError(found.error);
      return;
    }
    const wb = found.wristband;
    if (!wb) {
      if (onUnknownCode) {
        setError(null);
        onUnknownCode(value.trim());
        return;
      }
      setError(`No tab found for "${value}". Try a code below or continue as guest.`);
      return;
    }
    setError(null);
    onLoadTab(wb);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    void submit(code);
  };

  return (
    <div className="h-full flex flex-col items-center justify-center p-6 animate-in fade-in duration-500">
      <div className="w-full max-w-2xl">
        <div className="flex flex-col items-center text-center mb-8">
          <div className="w-20 h-20 rounded-2xl bg-primary/20 text-primary flex items-center justify-center mb-4">
            <ScanLine className="w-10 h-10" />
          </div>
          <h2 className="text-3xl font-bold tracking-tight">{title}</h2>
          <p className="text-muted-foreground mt-2 text-lg">{subtitle}</p>
        </div>

        <form onSubmit={handleSubmit} className="flex gap-3 mb-3">
          <Input
            autoFocus
            inputMode="numeric"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Wristband code e.g. 1001"
            className="h-16 text-2xl px-5"
          />
          <Button type="submit" size="lg" className="h-16 px-8 text-xl gap-2" disabled={!code.trim() || looking}>
            Load Tab
            <ArrowRight className="w-5 h-5" />
          </Button>
        </form>

        {error && (
          <div className="flex items-center gap-2 text-destructive text-sm mb-4">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="mt-6">
          <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">
            Demo wristbands
          </div>
          <div className="grid grid-cols-2 gap-3">
            {presets.map((wb) => (
              <Card
                key={wb.id}
                role="button"
                tabIndex={0}
                onClick={() => void submit(wb.code)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void submit(wb.code);
                  }
                }}
                className="p-4 flex items-center gap-3 cursor-pointer select-none hover:border-primary/60 transition-all active:scale-[0.98]"
              >
                <div className="w-11 h-11 rounded-xl bg-muted text-muted-foreground flex items-center justify-center shrink-0">
                  <UserRound className="w-6 h-6" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-bold leading-tight truncate">{wb.customerNickname}</div>
                  <div className="text-xs text-muted-foreground font-mono">#{wb.code}</div>
                  {wb.foodProvision?.mode === 'prepaid_items' && (
                    <div className="mt-1 inline-flex items-center gap-1 rounded-md border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-300">
                      <Gift className="w-3 h-3" />
                      Prepaid food
                    </div>
                  )}
                </div>
                <div className="text-right shrink-0">
                  {wb.foodProvision?.mode === 'prepaid_credit' ? (
                    <>
                      <div className="flex items-center gap-1 text-xs text-violet-300 justify-end">
                        <Gift className="w-3 h-3" />
                        prepaid
                      </div>
                      <div className="font-bold tabular-nums text-violet-300">฿{wb.creditBalanceTHB}</div>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground justify-end">
                        <Wallet className="w-3 h-3" />
                        credit
                      </div>
                      <div className="font-bold tabular-nums text-primary">฿{wb.creditBalanceTHB}</div>
                    </>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </div>

        {onGuest && (
          <>
            <div className="mt-8 flex items-center gap-4">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs uppercase tracking-wide text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <Button
              variant="outline"
              size="lg"
              className="w-full h-16 text-xl gap-3 mt-6"
              onClick={onGuest}
            >
              <UserRound className="w-6 h-6" />
              No wristband — continue as guest
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** A band from this till's own demo list, with no spendable credit on it. */
function withoutLocalCredit(wb: Wristband): Wristband {
  return { ...wb, creditBalanceTHB: 0, ledger: undefined };
}

/**
 * THE PLATFORM FIRST (plan §2.3): a band's code, its short code or a
 * voucher's `QR-…` names a real wallet — balance, ledger, and the key the
 * confirm press spends. A key no wallet carries falls back to this till's
 * demo band list (allergy and food notes only); a key neither knows is the
 * unknown-code path (`wristband: null`, no error).
 *
 * A lookup that could not be made is never read as "no credit": when the
 * platform cannot be reached (round-2 gate, finding 6) the station still
 * loads the band it holds itself — its notes, with ฿0 credit, as the box
 * lane refuses credit anyway — and only a band it does not hold is refused,
 * in the platform's words when it answered and the connection's when it did not.
 */
export async function loadScannedTab(value: string): Promise<{ wristband: Wristband | null; error: string | null }> {
  const local = getWristbandByCode(value);
  try {
    const wb = await scanWallet(value);
    if (wb) return { wristband: wb, error: null };
  } catch (err) {
    if (local) return { wristband: withoutLocalCredit(local), error: null };
    const said = err instanceof ApiError ? err.message : null;
    return { wristband: null, error: said
      ? `The platform could not look this band up: ${said}`
      : 'Could not reach the platform to look this band up — check the connection and scan again.' };
  }
  return { wristband: local ? withoutLocalCredit(local) : null, error: null };
}
