import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { ArrowLeft, Loader2, ShieldAlert } from 'lucide-react';
import { useOperator } from '@/auth/OperatorContext';
import { LockScreen } from '@/components/auth/LockScreen';
import { Button } from '@/components/ui/button';

/**
 * Auth wall for the admin console (/admin). The console used to be reachable
 * without a session ("temporary dev access"); it now requires a signed-in
 * operator with the manager role:
 *  - session still resolving → spinner (no lock-screen flash on reload)
 *  - not signed in           → the standard lock-screen sign-in form
 *  - signed in, not manager  → access-denied screen (switch account / back)
 */
export function AdminAccessGate({ children }: { children: ReactNode }) {
  const { operator, sessionResolved, logout } = useOperator();

  if (!sessionResolved) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background text-foreground/50">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  if (!operator) return <LockScreen />;

  if (operator.role !== 'manager') {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-background px-6 text-center text-foreground">
        <span className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-red-500/10 text-red-400">
          <ShieldAlert className="w-8 h-8" />
        </span>
        <h1 className="text-2xl font-black tracking-tight">Manager access required</h1>
        <p className="max-w-sm text-sm text-foreground/50">
          The admin console is restricted to manager-role operators.{' '}
          <span className="text-foreground/80">{operator.name}</span> is signed in as staff.
        </p>
        <div className="mt-2 flex flex-col items-center gap-3 sm:flex-row">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-xl border border-foreground/10 px-4 py-2.5 text-sm font-medium text-foreground/70 transition-colors hover:border-foreground/30 hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to POS
          </Link>
          <Button variant="secondary" className="rounded-xl" onClick={() => logout()}>
            Sign in as a different user
          </Button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
