/**
 * The app for a login whose employment has ended (SCRUM-769): "pay only".
 *
 * The person signs in as before (the launcher hand-off or the app's own
 * sign-in) and lands on My pay — their own payslips, the page every employee
 * already has — with the navigation cut to My pay and Logout. Any other
 * address sends them to My pay, which says in one plain line why. The token
 * pages for signing a contract or a letter stay open: they read no session,
 * and a leaver may still have a letter to sign.
 *
 * The server holds the same line on its own (server/lib/payOnlyAccess.ts):
 * every other route answers 403 EMPLOYMENT_ENDED. This shell is what the
 * person sees; the fence is what holds.
 *
 * It replaces the whole app below the sign-in, so none of the full app's
 * providers run for this person: no branch list, no sidebar counts, no
 * notification bell — nothing that would only be refused.
 */
import { Suspense, lazy, type ReactNode } from "react";
import { Link, Redirect, Route, Switch } from "wouter";
import { Loader2, LogOut, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ViewAsBanner } from "@/components/view-as-banner";
import { useAuth } from "@/hooks/use-auth";
import { PAYROLL_PATHS } from "@/lib/payroll/nav";
import { PAY_ONLY_MESSAGE, isPayOnly } from "@shared/payOnly";

const PayrollMyPayslipsPage = lazy(() => import("@/pages/payroll-my-payslips-page"));
const SigningPage = lazy(() => import("@/pages/signing-page"));
const LetterSigningPage = lazy(() => import("@/pages/letter-signing-page"));

/** Where a login in pay only lands, and the one page it has. */
export const PAY_ONLY_HOME = PAYROLL_PATHS.myPayslips;

function Loading() {
  return (
    <div className="flex items-center justify-center min-h-[200px]">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

/** The header: My pay and Logout, nothing else. */
export function PayOnlyShell({ children }: { children: ReactNode }) {
  const { user, logoutMutation } = useAuth();
  return (
    <div className="flex min-h-screen flex-col bg-background" data-testid="pay-only-shell">
      <header className="flex items-center gap-3 border-b p-3">
        <nav className="flex flex-1 items-center gap-1" aria-label="Main">
          <Link
            href={PAY_ONLY_HOME}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium"
            data-testid="nav-my-pay"
            aria-current="page"
          >
            <Wallet className="h-4 w-4" />
            My pay
          </Link>
        </nav>
        {user?.fullName && <span className="hidden text-sm text-muted-foreground sm:inline">{user.fullName}</span>}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => logoutMutation.mutate()}
          disabled={logoutMutation.isPending}
          data-testid="button-logout-pay-only"
        >
          <LogOut className="mr-2 h-4 w-4" />
          {logoutMutation.isPending ? "Logging out..." : "Logout"}
        </Button>
      </header>
      <p className="mx-auto mt-4 w-full max-w-3xl px-4 text-sm text-muted-foreground sm:px-6" role="status" data-testid="pay-only-notice">
        {PAY_ONLY_MESSAGE}
      </p>
      <main className="flex-1" role="main">
        {children}
      </main>
    </div>
  );
}

/** The routes of pay only: My pay, the two signing pages, and every other address sent to My pay. */
export function PayOnlyRoutes() {
  return (
    <Switch>
      <Route path="/sign/:token">
        {() => <Suspense fallback={<Loading />}><SigningPage /></Suspense>}
      </Route>
      <Route path="/letter-sign/:token">
        {() => <Suspense fallback={<Loading />}><LetterSigningPage /></Suspense>}
      </Route>
      <Route path={PAY_ONLY_HOME}>
        {() => (
          <PayOnlyShell>
            <Suspense fallback={<Loading />}><PayrollMyPayslipsPage /></Suspense>
          </PayOnlyShell>
        )}
      </Route>
      <Route>{() => <Redirect to={PAY_ONLY_HOME} replace />}</Route>
    </Switch>
  );
}

/**
 * Placed under the sign-in (`App.tsx`): a login in pay only gets the routes
 * above and nothing of the full app; everybody else gets `children`, as before.
 */
export function PayOnlyGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (!isPayOnly(user)) return <>{children}</>;
  return (
    <TooltipProvider>
      <Toaster />
      <ViewAsBanner />
      <PayOnlyRoutes />
    </TooltipProvider>
  );
}
