import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
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
import { StationProvider, useStation } from "@/station/StationContext";
import { StationPicker } from "@/components/station/StationPicker";
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
      {/* The wizard and the settings have addresses of their own so that
          opening one without the permission is a refusal somebody can be shown
          and can screenshot, not a button that was simply never drawn. */}
      <Route path="/station-setup/new" component={StationSetup} />
      <Route path="/station-setup/settings" component={StationSetup} />
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
  const { station, fleetAvailable, resolved: stationResolved } = useStation();
  const [location] = useLocation();
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
  // The same wait again for the station question: a till that showed the
  // picker and then took it away half a second later, because this deployment
  // turns out to have no fleet, would be worse than a moment of nothing.
  if (!stationResolved) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background text-foreground/50">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }
  // The shift starts by picking a station (R-14): it is what decides which
  // printers, scanner and card machine this screen drives, so no selling
  // surface opens without one. The station screens themselves are let through,
  // because that is where an administrator goes to set one up. Deployments
  // whose API has no fleet routes yet are not gated at all.
  if (fleetAvailable && !station && !location.startsWith('/station-setup')) {
    return <StationPicker />;
  }
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
