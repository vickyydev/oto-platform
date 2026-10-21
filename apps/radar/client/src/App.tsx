import { Suspense, lazy, useEffect, type ReactNode } from "react";
import { Route, Switch } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import OpenFromLauncherPage from "@/pages/open-from-launcher";
import { launcherUrlFrom } from "@/lib/launcher";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { Loader2 } from "lucide-react";

const IntelligenceDashboard = lazy(() => import("@/pages/funtopia-dashboard"));
const VisitorSurveyPage = lazy(() => import("@/pages/visitor-survey"));
const QrLandingPage = lazy(() => import("@/pages/qr-landing"));
const QrRedeemPage = lazy(() => import("@/pages/qr-redeem"));

function PageLoader() {
  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

interface MeAnswer {
  signedIn: true;
  accountId: string;
  name: string | null;
}

/**
 * Private pages render only for a signed-in platform session holding
 * app:radar:access (the server refuses their data otherwise). Anyone else
 * sees how to get in: from the launcher.
 */
function SignedIn({ children }: { children: ReactNode }) {
  const me = useQuery<{ status: number; body: MeAnswer | { reason?: string; message?: string } | null }>({
    queryKey: ["/api/me", "gate"],
    queryFn: async () => {
      const res = await fetch("/api/me", { credentials: "include" });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    staleTime: 60_000,
  });
  // SCRUM-653 — the person's theme from their platform account, once the
  // platform has said who they are.
  const { adoptPlatformTheme } = useTheme();
  useEffect(() => {
    if (me.data?.status === 200) adoptPlatformTheme(me.data.body);
  }, [me.data, adoptPlatformTheme]);
  if (me.isLoading) return <PageLoader />;
  if (me.data?.status === 200) return <>{children}</>;
  const refusal = me.data?.body as { reason?: string; message?: string } | null | undefined;
  const launcherUrl = launcherUrlFrom(refusal);
  if (refusal?.reason === "no_access") {
    return (
      <OpenFromLauncherPage title="Radar is not open to your account" detail={refusal.message} launcherUrl={launcherUrl} />
    );
  }
  if (me.data && me.data.status >= 500) {
    return (
      <OpenFromLauncherPage title="Radar could not check your sign-in" detail={refusal?.message} launcherUrl={launcherUrl} />
    );
  }
  return <OpenFromLauncherPage launcherUrl={launcherUrl} />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <Toaster />
          <Suspense fallback={<PageLoader />}>
            <Switch>
              <Route path="/survey" component={VisitorSurveyPage} />
              <Route path="/c/:id" component={QrLandingPage} />
              <Route path="/redeem" component={QrRedeemPage} />
              <Route>
                <SignedIn><IntelligenceDashboard /></SignedIn>
              </Route>
            </Switch>
          </Suspense>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
