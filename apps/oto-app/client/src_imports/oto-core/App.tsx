import { Switch, Route, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { ThemeProvider } from "@/components/theme-provider";
import { I18nProvider } from "@/lib/i18n";
import { ModeProvider, useMode } from "@/lib/mode";
import { BranchProvider } from "@/components/branch-switcher";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { Suspense, lazy, useEffect } from "react";
import { ChangePasswordModal } from "@/components/change-password-modal";

const LoginPage = lazy(() => import("@/pages/login"));
const TodayPage = lazy(() => import("@/pages/today"));
const ChecklistRunPage = lazy(() => import("@/pages/checklist-run"));
const LearnPage = lazy(() => import("@/pages/learn"));
const ModulePage = lazy(() => import("@/pages/module"));
const FindPage = lazy(() => import("@/pages/find"));
const SopArticlePage = lazy(() => import("@/pages/sop-article"));
const FixPage = lazy(() => import("@/pages/fix"));
const TroubleshootPage = lazy(() => import("@/pages/troubleshoot"));
const ReportIssuePage = lazy(() => import("@/pages/report-issue"));
const EscalatePage = lazy(() => import("@/pages/escalate"));
const DashboardPage = lazy(() => import("@/pages/dashboard"));
const DropoffCheckinPage = lazy(() => import("@/pages/dropoff-checkin"));
const ServiceCheckinPage = lazy(() => import("@/pages/service-checkin"));
const CheckinsPage = lazy(() => import("@/pages/checkins"));
const EventsPage = lazy(() => import("@/pages/events"));
const EventDetailPage = lazy(() => import("@/pages/event-detail"));
const TasksPage = lazy(() => import("@/pages/tasks"));
const TaskDetailPage = lazy(() => import("@/pages/task-detail"));
const VouchersPage = lazy(() => import("@/pages/vouchers"));
const RedeemPage = lazy(() => import("@/pages/redeem"));
const NotFound = lazy(() => import("@/pages/not-found"));

const ModuleChooserPage = lazy(() => import("@/pages/module-chooser"));

const StudioIndexPage = lazy(() => import("@/pages/studio/index"));
const StudioTasksPage = lazy(() => import("@/pages/studio/tasks"));
const StudioEventsPage = lazy(() => import("@/pages/studio/events"));
const StudioChecklistsPage = lazy(() => import("@/pages/studio/checklists"));
const StudioSopsPage = lazy(() => import("@/pages/studio/sops"));
const StudioQuizzesPage = lazy(() => import("@/pages/studio/quizzes"));
const StudioTroubleshootingPage = lazy(() => import("@/pages/studio/troubleshooting"));
const StudioDepartmentsPage = lazy(() => import("@/pages/studio/departments"));
const StudioUsersPage = lazy(() => import("@/pages/studio/users"));
const StudioVouchersPage = lazy(() => import("@/pages/studio/vouchers"));
const StudioSettingsPage = lazy(() => import("@/pages/studio/settings"));

const AdminUsersPage = lazy(() => import("@/pages/admin/users"));

function ProtectedRoute({ component: Component, requiredRole }: { component: React.ComponentType; requiredRole?: "manager" | "admin" }) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (!user) {
    return <Redirect to="/login" />;
  }

  if (requiredRole) {
    const roleHierarchy = { staff: 0, manager: 1, admin: 2 };
    const userRoleLevel = roleHierarchy[user.role as keyof typeof roleHierarchy] || 0;
    const requiredRoleLevel = roleHierarchy[requiredRole];
    
    if (userRoleLevel < requiredRoleLevel) {
      return <Redirect to="/" />;
    }
  }

  return <Component />;
}

function StudioRoute({ component: Component }: { component: React.ComponentType }) {
  const { user, isLoading } = useAuth();
  const { setMode, canAccessStudio } = useMode();

  useEffect(() => {
    if (canAccessStudio) {
      setMode("studio");
    }
  }, [canAccessStudio, setMode]);

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (!user) {
    return <Redirect to="/login" />;
  }

  if (!canAccessStudio) {
    return <Redirect to="/today" />;
  }

  return <Component />;
}

function PublicRoute({ component: Component }: { component: React.ComponentType }) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (user) {
    return <Redirect to="/" />;
  }

  return <Component />;
}

function HomeRedirect() {
  const { user, isLoading, hasMultipleModules, modules } = useAuth();

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (!user) {
    return <Redirect to="/login" />;
  }

  if (hasMultipleModules) {
    const lastModule = localStorage.getItem("oto-last-module");
    if (!lastModule) {
      return <Redirect to="/choose-module" />;
    }
    if (lastModule === "core" && modules.core) {
      return <Redirect to="/checkins" />;
    }
    if (lastModule === "hr" && modules.hr) {
      window.location.href = import.meta.env.VITE_HR_APP_URL || "/hr";
      return <LoadingScreen />;
    }
    if (lastModule === "studio" && modules.studio) {
      return <Redirect to="/studio" />;
    }
    return <Redirect to="/choose-module" />;
  }

  if (modules.studio && !modules.core) {
    return <Redirect to="/studio" />;
  }

  return <Redirect to="/checkins" />;
}

function Router() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <Switch>
        <Route path="/checkin/dropoff">
          <DropoffCheckinPage />
        </Route>
        
        <Route path="/checkin/service">
          <ServiceCheckinPage />
        </Route>
        
        <Route path="/login">
          <PublicRoute component={LoginPage} />
        </Route>
        
        <Route path="/today">
          <ProtectedRoute component={TodayPage} />
        </Route>
        
        <Route path="/checklist/:id">
          <ProtectedRoute component={ChecklistRunPage} />
        </Route>
        
        <Route path="/learn/:id">
          <ProtectedRoute component={ModulePage} />
        </Route>
        
        <Route path="/learn">
          <ProtectedRoute component={LearnPage} />
        </Route>
        
        <Route path="/find">
          <ProtectedRoute component={FindPage} />
        </Route>
        
        <Route path="/sop/:id">
          <ProtectedRoute component={SopArticlePage} />
        </Route>
        
        <Route path="/fix/:id">
          <ProtectedRoute component={TroubleshootPage} />
        </Route>
        
        <Route path="/fix">
          <ProtectedRoute component={FixPage} />
        </Route>
        
        <Route path="/checkins">
          <ProtectedRoute component={CheckinsPage} />
        </Route>
        
        <Route path="/events/:id">
          <ProtectedRoute component={EventDetailPage} />
        </Route>
        
        <Route path="/events">
          <ProtectedRoute component={EventsPage} />
        </Route>
        
        <Route path="/tasks/:id">
          {(params) => <ProtectedRoute component={() => <TaskDetailPage params={params} />} />}
        </Route>
        
        <Route path="/tasks">
          <ProtectedRoute component={TasksPage} />
        </Route>
        
        <Route path="/vouchers">
          <ProtectedRoute component={VouchersPage} />
        </Route>
        
        <Route path="/redeem/:token">
          <RedeemPage />
        </Route>
        
        <Route path="/report-issue">
          <ProtectedRoute component={ReportIssuePage} />
        </Route>
        
        <Route path="/escalate">
          <ProtectedRoute component={EscalatePage} />
        </Route>
        
        <Route path="/dashboard">
          <ProtectedRoute component={DashboardPage} requiredRole="manager" />
        </Route>
        
        <Route path="/admin/users">
          <ProtectedRoute component={AdminUsersPage} requiredRole="admin" />
        </Route>
        
        <Route path="/studio/tasks">
          <StudioRoute component={StudioTasksPage} />
        </Route>
        
        <Route path="/studio/events">
          <StudioRoute component={StudioEventsPage} />
        </Route>
        
        <Route path="/studio/checklists">
          <StudioRoute component={StudioChecklistsPage} />
        </Route>
        
        <Route path="/studio/sops">
          <StudioRoute component={StudioSopsPage} />
        </Route>
        
        <Route path="/studio/quizzes">
          <StudioRoute component={StudioQuizzesPage} />
        </Route>
        
        <Route path="/studio/troubleshooting">
          <StudioRoute component={StudioTroubleshootingPage} />
        </Route>
        
        <Route path="/studio/departments">
          <StudioRoute component={StudioDepartmentsPage} />
        </Route>
        
        <Route path="/studio/users">
          <StudioRoute component={StudioUsersPage} />
        </Route>
        
        <Route path="/studio/vouchers">
          <StudioRoute component={StudioVouchersPage} />
        </Route>
        
        <Route path="/studio/settings">
          <StudioRoute component={StudioSettingsPage} />
        </Route>
        
        <Route path="/studio">
          <StudioRoute component={StudioIndexPage} />
        </Route>
        
        <Route path="/choose-module">
          <ProtectedRoute component={ModuleChooserPage} />
        </Route>
        
        <Route path="/">
          <HomeRedirect />
        </Route>
        
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function PasswordChangeWrapper() {
  const { user, mustChangePassword, refetch } = useAuth();
  
  const handlePasswordChanged = () => {
    refetch();
  };
  
  if (!user || !mustChangePassword) {
    return null;
  }
  
  // Render a full-screen overlay so no other content is visible behind the modal
  return (
    <div className="fixed inset-0 z-50 bg-background">
      <ChangePasswordModal 
        open={mustChangePassword} 
        onSuccess={handlePasswordChanged}
      />
    </div>
  );
}

function AppWithMode() {
  return (
    <ModeProvider>
      <BranchProvider>
        <Toaster />
        <PasswordChangeWrapper />
        <Router />
      </BranchProvider>
    </ModeProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="system" storageKey="oto-theme">
        <I18nProvider>
          <TooltipProvider>
            <AuthProvider>
              <AppWithMode />
            </AuthProvider>
          </TooltipProvider>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
