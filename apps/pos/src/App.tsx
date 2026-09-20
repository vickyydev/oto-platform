import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Till from "@/pages/Till";
import OrderStation from "@/pages/OrderStation";
import MerchStation from "@/pages/MerchStation";
import History from "@/pages/History";
import Today from "@/pages/Today";
import Events from "@/pages/Events";
import DropOff from "@/pages/DropOff";
import Messages from "@/pages/Messages";
import Book from "@/pages/Book";
import StationSetup from "@/pages/StationSetup";
import Admin from "@/pages/Admin";
import { AdminAccessGate } from "@/components/admin/AdminAccessGate";
import { MobileStock } from "@/components/mobile/stock/MobileStock";
import { OperatorProvider, useOperator } from "@/auth/OperatorContext";
import { StationProvider } from "@/station/StationContext";
import { CatalogStoreProvider } from "@/store/CatalogStoreContext";
import { BranchProvider } from "@/branch/BranchContext";
import { LockScreen } from "@/components/auth/LockScreen";
import { InactivityWarning } from "@/components/auth/InactivityWarning";
import { MobileShell } from "@/components/mobile/MobileShell";
import { useIsMobile } from "@/hooks/use-mobile";
import { useStaffTheme } from "@/lib/themePref";
import { LanguageProvider } from "@/i18n/LanguageContext";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/" component={Till} />
      <Route path="/order-station" component={OrderStation} />
      <Route path="/merch-station" component={MerchStation} />
      <Route path="/history" component={History} />
      <Route path="/today" component={() => <Today />} />
      {/* Legacy route kept so old links land on the End of Day tab. */}
      <Route path="/end-of-day" component={() => <Today initialTab="eod" />} />
      <Route path="/parties" component={Events} />
      <Route path="/drop-off" component={DropOff} />
      <Route path="/messages" component={Messages} />
      <Route path="/stock" component={MobileStock} />
      <Route path="/station-setup" component={StationSetup} />
      <Route component={NotFound} />
    </Switch>
  );
}

// Gate the entire POS behind an operator session: phone + password here, or a
// hand-off from the suite launcher (S2-02).
// On narrow phone viewports (< 768 px) the MobileShell is rendered in place of
// the standard iPad Router — same provider tree, additive only.
function AuthGate() {
  const { operator, locked, sessionResolved } = useOperator();
  const isMobile = useIsMobile();
  // Until the resume (and any launcher hand-off) has answered, the till knows
  // nothing: showing the sign-in form here would prompt an operator who has
  // just signed in next door, and flash it on every reload.
  if (!sessionResolved) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background text-foreground/50">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }
  // Signed out → sign in. Signed in but locked → unlock the same session
  // with the password (S2-01a); the shift is not ended by inactivity.
  if (!operator || locked) return <LockScreen />;
  if (isMobile) {
    return (
      <>
        <MobileShell />
        <InactivityWarning />
      </>
    );
  }
  return (
    <>
      <Router />
      <InactivityWarning />
    </>
  );
}

function App() {
  // The staff theme drives the document root so every staff surface AND every
  // portaled overlay (dialogs, popovers, toasts attach to <body>) follows it.
  // The customer display(s) override locally with their own .dark/.light wrapper.
  const [staffTheme] = useStaffTheme();
  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle("dark", staffTheme === "dark");
    el.classList.toggle("light", staffTheme === "light");
  }, [staffTheme]);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <CatalogStoreProvider>
          <BranchProvider>
          <LanguageProvider>
          <OperatorProvider>
            <StationProvider>
              <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
                <Switch>
                  {/* Public, self-driven customer booking engine — no operator login. */}
                  <Route path="/book" component={Book} />
                  {/* Admin console: a separate, responsive back-office site with
                      its own auth wall — signed-in manager-role operators only. */}
                  <Route path="/admin">
                    <AdminAccessGate>
                      <Admin />
                    </AdminAccessGate>
                  </Route>
                  <Route>
                    <AuthGate />
                  </Route>
                </Switch>
              </WouterRouter>
              <Toaster />
            </StationProvider>
          </OperatorProvider>
          </LanguageProvider>
          </BranchProvider>
        </CatalogStoreProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
