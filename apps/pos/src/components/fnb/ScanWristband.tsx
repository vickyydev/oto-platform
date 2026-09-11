import { useState } from 'react';
import { Wristband } from '@/types';
import { getWristbandByCode, getMockWristbands } from '@/mockApi';
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
  const presets = getMockWristbands();

  const submit = (value: string) => {
    const wb = getWristbandByCode(value);
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
    submit(code);
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
          <Button type="submit" size="lg" className="h-16 px-8 text-xl gap-2" disabled={!code.trim()}>
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
                onClick={() => submit(wb.code)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    submit(wb.code);
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
