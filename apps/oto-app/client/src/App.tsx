import { Switch, Route, Redirect, useLocation } from "wouter";
import { Suspense, lazy, useState } from "react";
import * as Sentry from "@sentry/react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { BranchProvider } from "@/hooks/use-branch-context";
import { ModeProvider, useMode } from "@/hooks/use-mode";
import { ModeSwitcher } from "@/components/mode-switcher";
import { BranchSelector } from "@/components/branch-selector";
import { I18nProvider } from "@/lib/i18n";
import { CoreLayout } from "@/components/layout/core-layout";
import { StudioLayout } from "@/components/layout/studio-layout";
import { GlobalUploadProgress } from "@/components/media/GlobalUploadProgress";
import { useNotificationCount, NotificationPanel } from "@/components/notification-bell";
import { Loader2, LogOut, KeyRound, CalendarDays, Moon, Sun, Link as LinkIcon, Smartphone, Camera, Lock, User, Bell, Video, VideoOff } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/components/theme-provider";
import { useSessionReplay } from "@/hooks/use-session-replay";
import { SessionReplayDialog } from "@/components/session-replay-dialog";

import AuthPage from "@/pages/auth-page";
import DashboardPage from "@/pages/dashboard-page";
import NotFound from "@/pages/not-found";

const TemplatesPage = lazy(() => import("@/pages/templates-page"));
const TemplateEditorPage = lazy(() => import("@/pages/template-editor-page"));
const TemplatePreviewPage = lazy(() => import("@/pages/template-preview-page"));
const EmployeesPage = lazy(() => import("@/pages/employees-page"));
const EmployeeEditorPage = lazy(() => import("@/pages/employee-editor-page"));
const ContractsPage = lazy(() => import("@/pages/contracts-page"));
const ContractWizardPage = lazy(() => import("@/pages/contract-wizard-page"));
const ContractDetailPage = lazy(() => import("@/pages/contract-detail-page"));
const SettingsPage = lazy(() => import("@/pages/settings-page"));
const SupplierTokensPage = lazy(() => import("@/pages/supplier-tokens-page"));
const BranchesPage = lazy(() => import("@/pages/branches-page"));
const SigningPage = lazy(() => import("@/pages/signing-page"));
const LetterSigningPage = lazy(() => import("@/pages/letter-signing-page"));
const ForgotPasswordPage = lazy(() => import("@/pages/forgot-password-page"));
const MyAccountPage = lazy(() => import("@/pages/my-account-page"));
const AttentionPage = lazy(() => import("@/pages/attention-page"));
const ReviewsPage = lazy(() => import("@/pages/reviews-page"));
const StaffMovementsPage = lazy(() => import("@/pages/staff-movements-page"));
const UsersPage = lazy(() => import("@/pages/users-page"));
const PoliciesPage = lazy(() => import("@/pages/policies-page"));
const PolicyEditorPage = lazy(() => import("@/pages/policy-editor-page"));
const PolicyPreviewPage = lazy(() => import("@/pages/policy-preview-page"));
const ChangePasswordPage = lazy(() => import("@/pages/change-password-page"));
const VerifyPhonePage = lazy(() => import("@/pages/verify-phone-page"));
const ActivityLogbookPage = lazy(() => import("@/pages/activity-logbook-page"));
const BulkEmployeeUploadPage = lazy(() => import("@/pages/bulk-employee-upload-page"));
const CasualWorkersPage = lazy(() => import("@/pages/casual-workers-page"));
const KioskPage = lazy(() => import("@/pages/kiosk-page"));
const ReceptionKioskPage = lazy(() => import("@/pages/kiosk/reception"));
const TimeEventsPage = lazy(() => import("@/pages/time-events-page"));
const TimekeepingReviewPage = lazy(() => import("@/pages/timekeeping-review-page"));
const TimekeepingEmployeeDetailPage = lazy(() => import("@/pages/timekeeping-employee-detail-page"));
const TimekeepingLivePage = lazy(() => import("@/pages/timekeeping-live-page"));
const DepartmentsPage = lazy(() => import("@/pages/departments-page"));
const LocationsPage = lazy(() => import("@/pages/locations-page"));
const RolesPage = lazy(() => import("@/pages/roles-page"));
const SchedulingPage = lazy(() => import("@/pages/scheduling-page"));
const AdvisorsPage = lazy(() => import("@/pages/advisors-page"));
const OperatorsPage = lazy(() => import("@/pages/operators-page"));
const PayrollPage = lazy(() => import("@/pages/payroll-page"));
const PayrollOverviewPage = lazy(() => import("@/pages/payroll-overview-page"));
const PayrollPeriodsPage = lazy(() => import("@/pages/payroll-periods-page"));
const PayrollPeriodDetailPage = lazy(() => import("@/pages/payroll-period-detail-page"));
const PayrollRunDetailPage = lazy(() => import("@/pages/payroll-run-detail-page"));
const PayrollExceptionsPage = lazy(() => import("@/pages/payroll-exceptions-page"));
const PayrollExceptionDetailPage = lazy(() => import("@/pages/payroll-exception-detail-page"));
const PayrollEmployeesPage = lazy(() => import("@/pages/payroll-employees-page"));
const PayrollEmployeeDetailPage = lazy(() => import("@/pages/payroll-employee-detail-page"));
const PayrollExportsPage = lazy(() => import("@/pages/payroll-exports-page"));
const PayrollStatutoryRulesPage = lazy(() => import("@/pages/payroll-statutory-rules-page"));
const MyPayslipsPage = lazy(() => import("@/pages/my-payslips-page"));
const OrgChartPage = lazy(() => import("@/pages/org-chart-page"));
const AccessPage = lazy(() => import("@/pages/access-page"));
const AccessConfigPage = lazy(() => import("@/pages/access-config-page"));
const PermissionsDebugPage = lazy(() => import("@/pages/permissions-debug-page"));
const PermissionsPage = lazy(() => import("@/pages/permissions-page"));
const AnalyticsPage = lazy(() => import("@/pages/analytics-page"));
const DataAdminIndexPage = lazy(() => import("@/pages/data/index-page"));
const DataAdminSchemaPage = lazy(() => import("@/pages/data/schema-page"));
const DataAdminListPage = lazy(() => import("@/pages/data/model-list-page"));
const DataAdminDetailPage = lazy(() => import("@/pages/data/model-detail-page"));
const DataAdminFormPage = lazy(() => import("@/pages/data/model-form-page"));

const CoreHomePage = lazy(() => import("@/pages/core/home"));
const CoreDashboardPage = lazy(() => import("@/pages/core/dashboard"));
const CoreCheckinsPage = lazy(() => import("@/pages/core/checkins"));
const CoreDropoffCheckinPage = lazy(() => import("@/pages/core/dropoff-checkin"));
const CoreFormBuilderPage = lazy(() => import("@/pages/core/form-builder"));
const CoreServiceCheckinPage = lazy(() => import("@/pages/core/service-checkin"));
const CoreReportIssuePage = lazy(() => import("@/pages/core/report-issue"));
const CoreEscalatePage = lazy(() => import("@/pages/core/escalate"));
const CoreEventsPage = lazy(() => import("@/pages/core/events"));
const CoreEventDetailPage = lazy(() => import("@/pages/core/event-detail"));
const VouchersMovedPage = lazy(() => import("@/pages/vouchers-moved"));
const CoreMyAvailabilityPage = lazy(() => import("@/pages/core/my-availability"));
const CoreChecklistRunPage = lazy(() => import("@/pages/core/checklist-run"));
const CoreTroubleshootPage = lazy(() => import("@/pages/core/troubleshoot"));
const CoreLearnPage = lazy(() => import("@/pages/core/learn"));
const CoreModuleChooserPage = lazy(() => import("@/pages/core/module-chooser"));
const CoreModulePage = lazy(() => import("@/pages/core/module"));
const CoreFindPage = lazy(() => import("@/pages/core/find"));
const CoreAskPage = lazy(() => import("@/pages/core/ask"));
const CoreTodayPage = lazy(() => import("@/pages/core/today"));
const CoreFixPage = lazy(() => import("@/pages/core/fix"));
const CoreFixBoardPage = lazy(() => import("@/pages/core/fix-board"));
const CoreSopArticlePage = lazy(() => import("@/pages/core/sop-article"));
const CoreRotaPage = lazy(() => import("@/pages/core/rota"));
const PublicCheckinFormPage = lazy(() => import("@/pages/public/checkin-form"));
const CampRegisterPage = lazy(() => import("@/pages/public/camp-register"));
const CampRulesPage = lazy(() => import("@/pages/public/camp-rules"));
const SupplierPortalPage = lazy(() => import("@/pages/public/supplier-portal"));
const GuestRsvpPage = lazy(() => import("@/pages/public/guest-rsvp"));
const ParentPortalPage = lazy(() => import("@/pages/public/parent-portal"));
const ParentInvitationWizardPage = lazy(() => import("@/pages/public/parent-invitation-wizard"));
const MenuSelectPage = lazy(() => import("@/pages/public/menu-select"));

const EventsIndexPage = lazy(() => import("@/pages/events/index"));

const OpsPage = lazy(() => import("@/pages/ops/index"));
const SetupPage = lazy(() => import("@/pages/setup/index"));

const StudioIndexPage = lazy(() => import("@/pages/studio/index"));
const StudioTasksPage = lazy(() => import("@/pages/studio/tasks"));
const StudioChecklistsPage = lazy(() => import("@/pages/studio/checklists"));
const KnowledgeBasePage = lazy(() => import("@/pages/studio/knowledge-base"));
const StudioTroubleshootingPage = lazy(() => import("@/pages/studio/troubleshooting"));
const StudioQuizzesPage = lazy(() => import("@/pages/studio/quizzes"));
const StudioEventsPage = lazy(() => import("@/pages/studio/events"));
const CampDetailPage = lazy(() => import("@/pages/studio/camp-detail"));
const StudioEventSettingsPage = lazy(() => import("@/pages/studio/event-settings"));
const ChildrenDatabasePage = lazy(() => import("@/pages/studio/children"));


function PageLoader() {
  return (
    <div className="flex items-center justify-center h-full min-h-[200px]">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

function HRLayout({ children }: { children: React.ReactNode }) {
  const { user, logoutMutation } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [notifOpen, setNotifOpen] = useState(false);
  const unreadCount = useNotificationCount();
  const { isRecording, startRecording, stopRecording } = useSessionReplay();
  const [replayDialogOpen, setReplayDialogOpen] = useState(false);
  
  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  const getSidebarDefaultOpen = () => {
    const cookies = document.cookie.split(";");
    const sidebarCookie = cookies.find((c) => c.trim().startsWith("sidebar_state="));
    if (sidebarCookie) {
      return sidebarCookie.split("=")[1] === "true";
    }
    return true;
  };

  const initials = user?.fullName
    ? user.fullName
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "U";

  return (
    <SidebarProvider defaultOpen={getSidebarDefaultOpen()} style={style as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <div className="flex flex-col flex-1 overflow-hidden">
          <header className="flex items-center gap-4 p-3 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <SidebarTrigger data-testid="button-sidebar-toggle" />
              <BranchSelector compact />
            </div>
            <div className="flex-shrink-0">
              <ModeSwitcher />
            </div>
            <div className="flex items-center justify-end gap-2 flex-1 min-w-0">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" data-testid="button-user-menu-hr" className="relative">
                    <Avatar className="h-8 w-8">
                      {user?.profilePhotoPath && (
                        <AvatarImage src={user.profilePhotoPath} alt={user.fullName} />
                      )}
                      <AvatarFallback className="bg-primary text-primary-foreground text-sm">
                        {initials}
                      </AvatarFallback>
                    </Avatar>
                    {unreadCount > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[16px] h-[16px] rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold px-0.5">
                        {unreadCount > 9 ? "9+" : unreadCount}
                      </span>
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <div className="px-2 py-1.5 text-sm font-medium">{user?.fullName}</div>
                  <div className="px-2 pb-1.5 text-xs text-muted-foreground">{user?.email}</div>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setNotifOpen(true)} data-testid="menu-notifications-hr">
                    <Bell className="mr-2 h-4 w-4" />
                    Notifications
                    {unreadCount > 0 && (
                      <span className="ml-auto text-[10px] font-bold bg-destructive text-destructive-foreground rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                        {unreadCount > 99 ? "99+" : unreadCount}
                      </span>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <a href="/core/rota">
                      <CalendarDays className="mr-2 h-4 w-4" />
                      My Schedule
                    </a>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <a href="/my-account" data-testid="menu-my-account">
                      <User className="mr-2 h-4 w-4" />
                      My Account
                    </a>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <a href="/access">
                      <KeyRound className="mr-2 h-4 w-4" />
                      Vault
                    </a>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={toggleTheme} data-testid="menu-theme-toggle-hr">
                    {theme === "light" ? (
                      <Moon className="mr-2 h-4 w-4" />
                    ) : (
                      <Sun className="mr-2 h-4 w-4" />
                    )}
                    {theme === "light" ? "Dark Mode" : "Light Mode"}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => isRecording ? stopRecording() : setReplayDialogOpen(true)} data-testid="menu-session-replay-hr">
                    {isRecording ? (
                      <VideoOff className="mr-2 h-4 w-4" />
                    ) : (
                      <Video className="mr-2 h-4 w-4" />
                    )}
                    {isRecording ? "Stop Recording" : "Start Recording"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => logoutMutation.mutate()}
                    disabled={logoutMutation.isPending}
                    data-testid="button-logout-hr"
                  >
                    <LogOut className="mr-2 h-4 w-4" />
                    {logoutMutation.isPending ? "Logging out..." : "Logout"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>
          <main className="flex-1 overflow-auto bg-background" role="main">
            {children}
          </main>
        </div>
      </div>
      <NotificationPanel open={notifOpen} onOpenChange={setNotifOpen} />
      <SessionReplayDialog
        open={replayDialogOpen}
        onOpenChange={setReplayDialogOpen}
        onConfirm={(description) => {
          startRecording(description || undefined);
        }}
      />
    </SidebarProvider>
  );
}

type UserRole = "global_admin" | "operator_admin" | "admin" | "manager" | "staff";

function userHasAccess(userRole: string | undefined, requiredRoles: UserRole[]): boolean {
  if (!userRole) return false;
  
  // Global admin and legacy admin have access to everything
  if (userRole === "global_admin" || userRole === "admin") {
    return true;
  }
  
  // Operator admin has access to admin and below
  if (userRole === "operator_admin") {
    const operatorAdminAccess: UserRole[] = ["operator_admin", "admin", "manager", "staff"];
    return requiredRoles.some(r => operatorAdminAccess.includes(r));
  }
  
  // Manager has access to manager and staff routes
  if (userRole === "manager") {
    const managerAccess: UserRole[] = ["manager", "staff"];
    return requiredRoles.some(r => managerAccess.includes(r));
  }
  
  // Staff only has access to staff routes
  if (userRole === "staff") {
    return requiredRoles.includes("staff");
  }
  
  return false;
}

function ProtectedRoute({
  path,
  component: Component,
  requiredRole,
}: {
  path: string;
  component: () => React.JSX.Element;
  requiredRole?: UserRole | UserRole[];
}) {
  const { user, isLoading } = useAuth();
  const [location] = useLocation();

  if (isLoading) {
    console.log(`[auth-diag] ProtectedRoute ${path}: isLoading=true`);
    return (
      <Route path={path}>
        <div className="flex items-center justify-center min-h-screen bg-background">
          <Loader2 className="h-8 w-8 animate-spin text-primary" data-testid="loading-spinner" />
        </div>
      </Route>
    );
  }

  if (!user) {
    console.log(`[auth-diag] ProtectedRoute ${path}: user=null -> redirecting to /auth`);
    return (
      <Route path={path}>
        <Redirect to="/auth" />
      </Route>
    );
  }
  console.log(`[auth-diag] ProtectedRoute ${path}: user=${user.id} role=${user.role}`);

  if (user.mustChangePassword && location !== "/change-password") {
    return (
      <Route path={path}>
        <Redirect to="/change-password" />
      </Route>
    );
  }

  if (requiredRole) {
    const roles = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
    if (!userHasAccess(user.role, roles)) {
      // Staff should be redirected to Core instead of seeing AccessDenied
      if (user.role === "staff") {
        return (
          <Route path={path}>
            <Redirect to="/core" />
          </Route>
        );
      }
      return (
        <Route path={path}>
          <AccessDenied />
        </Route>
      );
    }
  }

  return <Route path={path} component={Component} />;
}

function AccessDenied() {
  const { canAccessMode } = useMode();
  const [, navigate] = useLocation();
  
  const redirectPath = canAccessMode("core") ? "/core" : "/auth";
  
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-background p-4">
      <h1 className="text-2xl font-bold mb-2">Access Denied</h1>
      <p className="text-muted-foreground mb-4">You don't have permission to access this page.</p>
      <button 
        onClick={() => navigate(redirectPath)}
        className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
        data-testid="button-go-back"
      >
        Go to {canAccessMode("core") ? "Core" : "Login"}
      </button>
    </div>
  );
}

function CoreProtectedLayout({ component: Component }: { component: React.ComponentType }) {
  const embedded = new URLSearchParams(window.location.search).get("embedded") === "1";
  if (embedded) {
    return (
      <Suspense fallback={<PageLoader />}>
        <Component />
      </Suspense>
    );
  }

  return (
    <CoreLayout>
      <Suspense fallback={<PageLoader />}>
        <Component />
      </Suspense>
    </CoreLayout>
  );
}

function StudioProtectedLayout({ component: Component }: { component: React.ComponentType }) {
  // Studio pages already include StudioLayout internally
  return (
    <Suspense fallback={<PageLoader />}>
      <Component />
    </Suspense>
  );
}

// The old Studio voucher page carried the Studio frame itself, as every Studio
// page does. The notice that replaced it is the same one the Core addresses
// show, so the frame is put around it here.
function StudioVouchersMovedPage() {
  return (
    <StudioLayout>
      <VouchersMovedPage />
    </StudioLayout>
  );
}

function HRProtectedLayout({ component: Component }: { component: React.ComponentType }) {
  return (
    <HRLayout>
      <Suspense fallback={<PageLoader />}>
        <Component />
      </Suspense>
    </HRLayout>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/auth" component={AuthPage} />
      <Route path="/forgot-password">
        {() => (
          <Suspense fallback={<PageLoader />}>
            <ForgotPasswordPage />
          </Suspense>
        )}
      </Route>
      <Route path="/sign/:token">
        {() => (
          <Suspense fallback={<PageLoader />}>
            <SigningPage />
          </Suspense>
        )}
      </Route>
      <Route path="/letter-sign/:token">
        {() => (
          <Suspense fallback={<PageLoader />}>
            <LetterSigningPage />
          </Suspense>
        )}
      </Route>
      <Route path="/kiosk/reception">
        {() => (
          <Suspense fallback={<PageLoader />}>
            <ReceptionKioskPage />
          </Suspense>
        )}
      </Route>
      <Route path="/kiosk/:branchId">
        {(params) => (
          <Suspense fallback={<PageLoader />}>
            <KioskPage branchId={params.branchId} />
          </Suspense>
        )}
      </Route>
      <Route path="/checkin/:branchId/:token">
        {() => (
          <Suspense fallback={<PageLoader />}>
            <PublicCheckinFormPage />
          </Suspense>
        )}
      </Route>
      <Route path="/supplier/:token">
        {() => (
          <Suspense fallback={<PageLoader />}>
            <SupplierPortalPage />
          </Suspense>
        )}
      </Route>
      <Route path="/rsvp/:token">
        {() => (
          <Suspense fallback={<PageLoader />}>
            <GuestRsvpPage />
          </Suspense>
        )}
      </Route>
      <Route path="/parent/:token">
        {() => (
          <Suspense fallback={<PageLoader />}>
            <ParentPortalPage />
          </Suspense>
        )}
      </Route>
      <Route path="/menu-select/:token">
        {() => (
          <Suspense fallback={<PageLoader />}>
            <MenuSelectPage />
          </Suspense>
        )}
      </Route>
      <Route path="/camp-register/:eventId">
        {() => (
          <Suspense fallback={<PageLoader />}>
            <CampRegisterPage />
          </Suspense>
        )}
      </Route>
      <Route path="/camp-rules">
        {() => (
          <Suspense fallback={<PageLoader />}>
            <CampRulesPage />
          </Suspense>
        )}
      </Route>
      <Route path="/parent/:token/invitation">
        {() => (
          <Suspense fallback={<PageLoader />}>
            <ParentInvitationWizardPage />
          </Suspense>
        )}
      </Route>
      <ProtectedRoute path="/change-password" component={() => (
        <Suspense fallback={<PageLoader />}>
          <ChangePasswordPage />
        </Suspense>
      )} />
      <ProtectedRoute path="/verify-phone" component={() => (
        <Suspense fallback={<PageLoader />}>
          <VerifyPhonePage />
        </Suspense>
      )} />
      <ProtectedRoute path="/my-account" component={() => (
        <Suspense fallback={<PageLoader />}>
          <MyAccountPage />
        </Suspense>
      )} />

      {/* Core routes - accessible by all authenticated users */}
      <ProtectedRoute path="/core" component={() => <Redirect to="/core/today" />} />
      <ProtectedRoute path="/core/dashboard" component={() => <CoreProtectedLayout component={CoreDashboardPage} />} />
      <ProtectedRoute path="/core/checkins" component={() => <CoreProtectedLayout component={CoreCheckinsPage} />} />
      <ProtectedRoute path="/core/checkins/dropoff" component={() => <CoreProtectedLayout component={CoreDropoffCheckinPage} />} />
      <ProtectedRoute path="/core/checkins/service" component={() => <CoreProtectedLayout component={CoreServiceCheckinPage} />} />
      <ProtectedRoute path="/core/issues/report" component={() => <CoreProtectedLayout component={CoreReportIssuePage} />} />
      <ProtectedRoute path="/core/issues/escalate" component={() => <CoreProtectedLayout component={CoreEscalatePage} />} />
      <ProtectedRoute path="/core/events" component={() => <CoreProtectedLayout component={CoreEventsPage} />} />
      <ProtectedRoute path="/core/events/:id" component={() => <CoreProtectedLayout component={CoreEventDetailPage} />} />
      {/* The old voucher module's addresses: vouchers live in the Console now, so each shows the notice */}
      <ProtectedRoute path="/core/vouchers" component={() => <CoreProtectedLayout component={VouchersMovedPage} />} />
      <ProtectedRoute path="/core/my-vouchers" component={() => <CoreProtectedLayout component={VouchersMovedPage} />} />
      <ProtectedRoute path="/core/my-availability" component={() => <CoreProtectedLayout component={CoreMyAvailabilityPage} />} />
      <ProtectedRoute path="/core/vouchers/redeem" component={() => <CoreProtectedLayout component={VouchersMovedPage} />} />
      <ProtectedRoute path="/core/checklist/:id" component={() => <CoreProtectedLayout component={CoreChecklistRunPage} />} />
      <ProtectedRoute path="/core/troubleshoot" component={() => <CoreProtectedLayout component={CoreTroubleshootPage} />} />
      <ProtectedRoute path="/core/learn" component={() => <CoreProtectedLayout component={CoreLearnPage} />} />
      <ProtectedRoute path="/core/modules" component={() => <CoreProtectedLayout component={CoreModuleChooserPage} />} />
      <ProtectedRoute path="/core/modules/:id" component={() => <CoreProtectedLayout component={CoreModulePage} />} />
      <ProtectedRoute path="/core/sop/:id" component={() => <CoreProtectedLayout component={CoreSopArticlePage} />} />
      <ProtectedRoute path="/core/find" component={() => <CoreProtectedLayout component={CoreFindPage} />} />
      <ProtectedRoute path="/core/ask" component={() => <CoreProtectedLayout component={CoreAskPage} />} />
      <ProtectedRoute path="/core/today" component={() => <CoreProtectedLayout component={CoreTodayPage} />} />
      <ProtectedRoute path="/core/fix" component={() => <CoreProtectedLayout component={CoreFixPage} />} />
      <ProtectedRoute path="/core/fix-board" component={() => <CoreProtectedLayout component={CoreFixBoardPage} />} />
      <ProtectedRoute path="/core/rota" component={() => <CoreProtectedLayout component={CoreRotaPage} />} />

      {/* Ops routes - accessible by managers and admin */}
      <ProtectedRoute path="/ops" component={() => <StudioProtectedLayout component={OpsPage} />} requiredRole={["manager", "admin"]} />

      {/* Setup routes - accessible by managers and admin */}
      <ProtectedRoute path="/setup" component={() => <StudioProtectedLayout component={SetupPage} />} requiredRole={["manager", "admin"]} />

      {/* Events routes - manager and admin only */}
      <ProtectedRoute path="/events" component={() => <StudioProtectedLayout component={EventsIndexPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/events/settings" component={() => <StudioProtectedLayout component={StudioEventSettingsPage} />} requiredRole={["manager", "admin"]} />

      {/* Studio routes - manager and admin only */}
      <ProtectedRoute path="/studio" component={() => <StudioProtectedLayout component={StudioIndexPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/studio/tasks/one-off" component={() => <StudioProtectedLayout component={StudioTasksPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/studio/tasks/recurring" component={() => <StudioProtectedLayout component={StudioTasksPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/studio/tasks" component={() => <Redirect to="/studio/tasks/one-off" />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/studio/checklists" component={() => <StudioProtectedLayout component={StudioChecklistsPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/studio/kb" component={() => <StudioProtectedLayout component={KnowledgeBasePage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/studio/kb/files" component={() => <StudioProtectedLayout component={KnowledgeBasePage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/studio/troubleshooting" component={() => <StudioProtectedLayout component={StudioTroubleshootingPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/studio/quizzes" component={() => <StudioProtectedLayout component={StudioQuizzesPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/studio/events/camp/:id" component={() => <StudioProtectedLayout component={CampDetailPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/studio/events/list" component={() => <StudioProtectedLayout component={StudioEventsPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/studio/events/kanban" component={() => <StudioProtectedLayout component={StudioEventsPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/studio/events/calendar/:month" component={() => <StudioProtectedLayout component={StudioEventsPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/studio/events/calendar" component={() => <StudioProtectedLayout component={StudioEventsPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/studio/events" component={() => <Redirect to="/studio/events/kanban" />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/studio/vouchers" component={() => <StudioProtectedLayout component={StudioVouchersMovedPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/studio/event-settings" component={() => <StudioProtectedLayout component={StudioEventSettingsPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/studio/children" component={() => <StudioProtectedLayout component={ChildrenDatabasePage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/studio/form-builder" component={() => <StudioProtectedLayout component={CoreFormBuilderPage} />} requiredRole="admin" />

      {/* HR routes - manager and admin only */}
      <ProtectedRoute path="/" component={() => <Redirect to="/core/today" />} />
      <ProtectedRoute path="/dashboard" component={() => <HRProtectedLayout component={DashboardPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/templates" component={() => <HRProtectedLayout component={TemplatesPage} />} requiredRole="admin" />
      <ProtectedRoute path="/templates/:id/preview" component={() => <HRProtectedLayout component={TemplatePreviewPage} />} requiredRole="admin" />
      <ProtectedRoute path="/templates/:id" component={() => <HRProtectedLayout component={TemplateEditorPage} />} requiredRole="admin" />
      <ProtectedRoute path="/employees" component={() => <HRProtectedLayout component={EmployeesPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/employees/bulk-upload" component={() => <HRProtectedLayout component={BulkEmployeeUploadPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/employees/casual" component={() => <HRProtectedLayout component={CasualWorkersPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/employees/:id" component={() => <HRProtectedLayout component={EmployeeEditorPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/contracts" component={() => <HRProtectedLayout component={ContractsPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/contracts/new" component={() => <HRProtectedLayout component={ContractWizardPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/contracts/:id" component={() => <HRProtectedLayout component={ContractDetailPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/branches" component={() => <HRProtectedLayout component={BranchesPage} />} requiredRole="admin" />
      <ProtectedRoute path="/departments" component={() => <HRProtectedLayout component={DepartmentsPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/locations" component={() => <HRProtectedLayout component={LocationsPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/roles" component={() => <HRProtectedLayout component={RolesPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/scheduling" component={() => <HRProtectedLayout component={SchedulingPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/org-chart" component={() => <HRProtectedLayout component={OrgChartPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/access" component={() => (
        <Suspense fallback={<PageLoader />}>
          <AccessPage />
        </Suspense>
      )} />
      <ProtectedRoute path="/permissions" component={() => <HRProtectedLayout component={PermissionsPage} />} requiredRole="admin" />
      <ProtectedRoute path="/settings/access" component={() => <HRProtectedLayout component={AccessConfigPage} />} requiredRole="admin" />
      <ProtectedRoute path="/settings/permissions-debug" component={() => <HRProtectedLayout component={PermissionsDebugPage} />} requiredRole="admin" />
      <ProtectedRoute path="/settings" component={() => <HRProtectedLayout component={SettingsPage} />} requiredRole="admin" />
      <ProtectedRoute path="/settings/supplier-tokens" component={() => <HRProtectedLayout component={SupplierTokensPage} />} requiredRole="admin" />
      <ProtectedRoute path="/operators" component={() => <HRProtectedLayout component={OperatorsPage} />} requiredRole={["global_admin", "admin"]} />
      <ProtectedRoute path="/payroll" component={() => <HRProtectedLayout component={PayrollOverviewPage} />} requiredRole={["global_admin", "operator_admin", "admin", "manager"]} />
      <ProtectedRoute path="/payroll/periods" component={() => <HRProtectedLayout component={PayrollPeriodsPage} />} requiredRole={["global_admin", "operator_admin", "admin"]} />
      <ProtectedRoute path="/payroll/periods/:periodId" component={() => <HRProtectedLayout component={PayrollPeriodDetailPage} />} requiredRole={["global_admin", "operator_admin", "admin"]} />
      <ProtectedRoute path="/payroll/runs/:runId" component={() => <HRProtectedLayout component={PayrollRunDetailPage} />} requiredRole={["global_admin", "operator_admin", "admin"]} />
      <ProtectedRoute path="/payroll/runs/:runId/exceptions" component={() => <HRProtectedLayout component={PayrollExceptionsPage} />} requiredRole={["global_admin", "operator_admin", "admin", "manager"]} />
      <ProtectedRoute path="/payroll/runs/:runId/exceptions/:exceptionId" component={() => <HRProtectedLayout component={PayrollExceptionDetailPage} />} requiredRole={["global_admin", "operator_admin", "admin", "manager"]} />
      <ProtectedRoute path="/payroll/runs/:runId/employees" component={() => <HRProtectedLayout component={PayrollEmployeesPage} />} requiredRole={["global_admin", "operator_admin", "admin"]} />
      <ProtectedRoute path="/payroll/runs/:runId/employees/:employeeId" component={() => <HRProtectedLayout component={PayrollEmployeeDetailPage} />} requiredRole={["global_admin", "operator_admin", "admin"]} />
      <ProtectedRoute path="/payroll/runs/:runId/exports" component={() => <HRProtectedLayout component={PayrollExportsPage} />} requiredRole={["global_admin", "operator_admin", "admin"]} />
      <ProtectedRoute path="/payroll/statutory-rules" component={() => <HRProtectedLayout component={PayrollStatutoryRulesPage} />} requiredRole={["global_admin", "operator_admin", "admin"]} />
      <ProtectedRoute path="/my-payslips" component={() => <HRProtectedLayout component={MyPayslipsPage} />} requiredRole={["staff", "manager", "operator_admin", "global_admin", "admin"]} />
      <ProtectedRoute path="/attention" component={() => <HRProtectedLayout component={AttentionPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/reviews" component={() => <HRProtectedLayout component={ReviewsPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/staff-movements" component={() => <HRProtectedLayout component={StaffMovementsPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/users" component={() => <HRProtectedLayout component={UsersPage} />} requiredRole="admin" />
      <ProtectedRoute path="/policies" component={() => <HRProtectedLayout component={PoliciesPage} />} requiredRole="admin" />
      <ProtectedRoute path="/policies/:id/preview" component={() => <HRProtectedLayout component={PolicyPreviewPage} />} requiredRole="admin" />
      <ProtectedRoute path="/policies/:id" component={() => <HRProtectedLayout component={PolicyEditorPage} />} requiredRole="admin" />
      <ProtectedRoute path="/activity-logbook" component={() => <HRProtectedLayout component={ActivityLogbookPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/time-attendance" component={() => <HRProtectedLayout component={TimeEventsPage} />} requiredRole="admin" />
      <ProtectedRoute path="/timekeeping-review" component={() => <HRProtectedLayout component={TimekeepingReviewPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/timekeeping-review/employee/:employeeId" component={() => <HRProtectedLayout component={TimekeepingEmployeeDetailPage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/timekeeping/live" component={() => <HRProtectedLayout component={TimekeepingLivePage} />} requiredRole={["manager", "admin"]} />
      <ProtectedRoute path="/advisors" component={() => <HRProtectedLayout component={AdvisorsPage} />} requiredRole="admin" />
      <ProtectedRoute path="/analytics" component={() => <HRProtectedLayout component={AnalyticsPage} />} requiredRole="admin" />

      {/* Data Admin routes */}
      <ProtectedRoute path="/data" component={() => <Suspense fallback={<PageLoader />}><DataAdminIndexPage /></Suspense>} requiredRole="admin" />
      <ProtectedRoute path="/data/schema" component={() => <Suspense fallback={<PageLoader />}><DataAdminSchemaPage /></Suspense>} requiredRole="admin" />
      <ProtectedRoute path="/data/:model/new" component={() => <Suspense fallback={<PageLoader />}><DataAdminFormPage /></Suspense>} requiredRole="admin" />
      <ProtectedRoute path="/data/:model/:id/edit" component={() => <Suspense fallback={<PageLoader />}><DataAdminFormPage /></Suspense>} requiredRole="admin" />
      <ProtectedRoute path="/data/:model/:id" component={() => <Suspense fallback={<PageLoader />}><DataAdminDetailPage /></Suspense>} requiredRole="admin" />
      <ProtectedRoute path="/data/:model" component={() => <Suspense fallback={<PageLoader />}><DataAdminListPage /></Suspense>} requiredRole="admin" />

      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <I18nProvider>
          <AuthProvider>
            <BranchProvider>
              <ModeProvider>
                <TooltipProvider>
                  <Toaster />
                  <GlobalUploadProgress />
                  <Router />
                </TooltipProvider>
              </ModeProvider>
            </BranchProvider>
          </AuthProvider>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

function ErrorFallback() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-background p-4">
      <h1 className="text-2xl font-bold mb-2">Something went wrong</h1>
      <p className="text-muted-foreground mb-4">An unexpected error has occurred. Please try refreshing the page.</p>
      <button 
        onClick={() => window.location.href = "/"}
        className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
      >
        Go Home
      </button>
    </div>
  );
}



export default App;
