import { useQuery } from "@tanstack/react-query";
import { MessageSquarePlus } from "lucide-react";
import { useLocation } from "wouter";
import type { QaContext } from "@shared/qa-reports";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useBranchContext } from "@/hooks/use-branch-context";
import { apiRequest } from "@/lib/queryClient";

type QaConfig = { enabled: boolean; version: string; acceptsVideo: boolean; audioTranscription: boolean };
let launchContext: { scope: string; context: QaContext } | null = null;

export const qaReporterScope = (user: { id: string; tenantId?: string } | null) => user ? `${user.id}:${user.tenantId ?? "unplaced"}` : "";

export function getQaLaunchContext(scope: string): QaContext | undefined {
  return launchContext?.scope === scope ? launchContext.context : undefined;
}

export function useQaConfig() {
  const { user } = useAuth();
  return useQuery<QaConfig>({
    queryKey: ["qa-report-config", qaReporterScope(user)],
    queryFn: async () => (await apiRequest("GET", "/api/qa-reports/config")).json(),
    enabled: !!user,
    staleTime: 60_000,
  });
}

export function QaReportLauncher() {
  const { user } = useAuth();
  const { activeBranchId } = useBranchContext();
  const [location, navigate] = useLocation();
  const { data } = useQaConfig();
  // The launcher belongs to signed-in work screens, never shared/signing links.
  const privateScreen = /^\/(?:core|studio|dashboard|employees|contracts|templates|settings|branches|operators|payroll|my-payslips|attention|reviews|staff-movements|users|policies|activity-logbook|time-attendance|timekeeping|timekeeping-review|advisors|analytics|data|scheduling|access|my-account|departments|events|locations|ops|org-chart|permissions|roles|setup)(?:\/|$)/.test(location) || location === "/";
  if (!user || !data?.enabled || !privateScreen) return null;

  function open() {
    if (!user) return;
    launchContext = {
      scope: qaReporterScope(user),
      context: {
        path: window.location.pathname,
        ...(activeBranchId ? { branchId: activeBranchId } : {}),
        role: user.role,
        browser: navigator.userAgent.slice(0, 300),
        locale: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      },
    };
    navigate("/qa-reports");
  }

  return (
    <div className="fixed bottom-20 right-4 z-40 md:bottom-6 md:right-6">
      <Button onClick={open} data-testid="qa-report-launcher" className="gap-2 rounded-full shadow-lg" aria-label="Report an issue">
        <MessageSquarePlus className="h-4 w-4" />
        <span>Report issue</span>
      </Button>
    </div>
  );
}
