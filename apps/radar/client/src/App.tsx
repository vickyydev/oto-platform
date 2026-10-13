import { Suspense, lazy } from "react";
import { Route, Switch } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { Loader2 } from "lucide-react";

const IntelligenceDashboard = lazy(() => import("@/pages/funtopia-dashboard"));
const VisitorSurveyPage = lazy(() => import("@/pages/visitor-survey"));
const QrLandingPage = lazy(() => import("@/pages/qr-landing"));
const QrRedeemPage = lazy(() => import("@/pages/qr-redeem"));
const TaxInvoicesPage = lazy(() => import("@/pages/tax-invoices"));

function PageLoader() {
  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
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
              <Route path="/tax-invoices" component={TaxInvoicesPage} />
              <Route component={IntelligenceDashboard} />
            </Switch>
          </Suspense>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
