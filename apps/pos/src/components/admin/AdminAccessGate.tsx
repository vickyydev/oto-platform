import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { ArrowLeft, Loader2, ShieldAlert } from 'lucide-react';
import { useOperator } from '@/auth/OperatorContext';
import { LockScreen } from '@/components/auth/LockScreen';
import { ChangePasswordScreen } from '@/components/auth/ChangePasswordScreen';
import { Button } from '@/components/ui/button';
import { adminPanelPermissions } from '@/components/admin/adminSections';

/**
 * The front door of the admin console (/admin) — and what it is NOT.
 *
 * **This is not what protects anything.** The server is the authority: every
 * API route declares its own guard, `routes-guarded.test.ts` fails any route
 * that declares none, and a caller who arrives at one without the permission
 * is refused there. Driven on staging as reception with a forged
 * `/me/permissions` response, this gate opens and the console renders — and
 * then `PATCH .../ticket-packages` answers `403 Missing permission
 * catalog:package:update`, `GET /accounts` 403, `GET /operators` 403,
 * `GET /audit` 403. Nothing was written.
 *
 * What this gate is for is the other half: not offering a person a console
 * whose every button will refuse them. It decides what is OFFERED. Anything
 * that decides what may HAPPEN lives behind an API route.
 *
 * The bar is holding at least one permission that some panel here needs.
 * `admin:branch:read` does not count: every counter role holds it, so a bar
 * that accepted it would be no bar at all.
 */
export function AdminAccessGate({ children }: { children: ReactNode }) {
  const { operator, sessionResolved, mustChangePassword, can, logout } = useOperator();

  if (!sessionResolved) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background text-foreground/50">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  if (!operator) return <LockScreen adminMode />;

  // A temporary password refuses every guarded route, so there is no panel
  // here that would answer. Same form as the till shows (SCRUM-235).
  if (mustChangePassword) return <ChangePasswordScreen />;

  const usable = adminPanelPermissions.filter((p) => can(p));

  if (usable.length === 0) {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-background px-6 text-center text-foreground">
        <span className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-red-500/10 text-red-400">
          <ShieldAlert className="w-8 h-8" />
        </span>
        <h1 className="text-2xl font-black tracking-tight">Nothing here is yours to change</h1>
        <p className="max-w-sm text-sm text-foreground/50">
          The admin console configures the park — tickets, prices, tax, staff accounts.{' '}
          <span className="text-foreground/80">{operator.name}</span> holds none of the permissions
          those screens need. A manager can grant them in Login Users.
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
