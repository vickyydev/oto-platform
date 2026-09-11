import { useOperator } from '@/auth/OperatorContext';
import { Button } from '@/components/ui/button';
import { TimerReset } from 'lucide-react';

/** Brief "Locking soon…" prompt shown in the final seconds before auto-logout. */
export function InactivityWarning() {
  const { warningActive, secondsLeft, stayActive, logout } = useOperator();
  if (!warningActive) return null;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-bottom-3 duration-300">
      <div className="flex items-center gap-4 rounded-2xl border border-amber-500/40 bg-background/95 shadow-2xl px-5 py-3 backdrop-blur">
        <span className="w-10 h-10 rounded-xl bg-amber-500/15 text-amber-300 flex items-center justify-center shrink-0">
          <TimerReset className="w-5 h-5" />
        </span>
        <div className="leading-tight">
          <div className="font-bold text-amber-200">Locking soon…</div>
          <div className="text-sm text-foreground/60 tabular-nums">
            Auto-lock in {secondsLeft}s with no activity
          </div>
        </div>
        <Button size="sm" className="h-9" onClick={stayActive}>
          Stay
        </Button>
        <Button size="sm" variant="ghost" className="h-9 text-foreground/60" onClick={logout}>
          Lock now
        </Button>
      </div>
    </div>
  );
}
