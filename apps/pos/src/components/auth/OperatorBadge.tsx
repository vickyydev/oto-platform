import { useOperator } from '@/auth/OperatorContext';
import { Button } from '@/components/ui/button';
import { UserRound, Lock } from 'lucide-react';

/**
 * Top-corner chip showing the signed-in operator plus a manual Lock button.
 * The button now locks rather than signs out (S2-01a) — exactly what its
 * label always said; signing out is offered on the lock screen itself.
 */
export function OperatorBadge() {
  const { operator, lockNow } = useOperator();
  if (!operator) return null;

  // Show just the operator's nickname (e.g. "Som"), dropping the parenthetical
  // desk/role suffix carried in the seed name (e.g. "Som (Reception)").
  const nickname = operator.name.replace(/\s*\([^)]*\)\s*$/, '').trim();

  return (
    <div className="flex items-center gap-2 shrink-0">
      <div className="flex items-center gap-2 rounded-full border bg-card/60 pl-2 pr-3 h-9">
        <span className="w-6 h-6 rounded-full bg-primary/15 text-primary flex items-center justify-center shrink-0">
          <UserRound className="w-3.5 h-3.5" />
        </span>
        <span className="text-sm font-bold leading-tight">{nickname}</span>
      </div>
      <Button
        variant="outline"
        size="icon"
        className="h-9 w-9"
        onClick={lockNow}
        title="Lock screen"
        aria-label="Lock screen"
      >
        <Lock className="w-4 h-4" />
      </Button>
    </div>
  );
}
