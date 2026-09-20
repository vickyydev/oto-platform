import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import {
  Users,
  FileSignature,
  Plus,
  ArrowRight,
  AlertTriangle,
  Calendar,
  RefreshCw,
  TrendingUp,
  UserX,
  Activity,
  Package,
  Clock,
  AlertCircle,
} from "lucide-react";
import { Employee, ContractInstance, ActivityLog } from "@shared/schema";
import { useBranchContext } from "@/hooks/use-branch-context";
import { addDays, formatDistanceToNow } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface ActivitySummary {
  promotion: number;
  salary_change: number;
  incentive_change: number;
  employment_ended: number;
  total: number;
}

interface AttentionCounts {
  total: number;
  high: number;
  medium: number;
  low: number;
}

function DashboardCard({
  title,
  value,
  description,
  icon: Icon,
  loading,
  href,
  priority,
  severity,
}: {
  title: string;
  value: number | string;
  description?: string;
  icon: React.ElementType;
  loading?: boolean;
  href: string;
  priority?: boolean;
  severity?: "high" | "medium" | "low";
}) {
  const severityColors = {
    high: "border-red-500/50 dark:border-red-400/50",
    medium: "border-amber-500/50 dark:border-amber-400/50",
    low: "border-muted",
  };
  const severityTextColors = {
    high: "text-red-600 dark:text-red-400",
    medium: "text-amber-600 dark:text-amber-400",
    low: "",
  };

  const borderClass = severity ? severityColors[severity] : priority ? "border-primary/50" : "";
  const textClass = severity ? severityTextColors[severity] : "";

  return (
    <Link href={href}>
      <Card 
        className={`hover-elevate cursor-pointer transition-colors h-full ${borderClass}`} 
        data-testid={`card-${title.toLowerCase().replace(/\s+/g, "-")}`}
      >
        <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
          <Icon className={`h-4 w-4 ${severity ? textClass : priority ? "text-primary" : "text-muted-foreground"}`} />
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-8 w-20" />
          ) : (
            <div className={`text-2xl font-medium ${textClass}`}>{value}</div>
          )}
          {description && (
            <p className="text-xs text-muted-foreground mt-1">{description}</p>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const { selectedBranchId, isAllBranches } = useBranchContext();
  const { toast } = useToast();

  const { data: employees, isLoading: employeesLoading } = useQuery<Employee[]>({
    queryKey: ["/api/employees"],
  });

  const { data: contracts, isLoading: contractsLoading } = useQuery<ContractInstance[]>({
    queryKey: ["/api/contracts"],
  });

  const attentionCountsUrl = isAllBranches
    ? "/api/attention-items/counts"
    : `/api/attention-items/counts?branchId=${selectedBranchId}`;

  const { data: attentionCounts, isLoading: attentionLoading } = useQuery<AttentionCounts>({
    queryKey: [attentionCountsUrl],
  });

  const summaryUrl = isAllBranches
    ? "/api/activity-logs/summary?sinceDays=30"
    : `/api/activity-logs/summary?branchId=${selectedBranchId}&sinceDays=30`;

  const { data: activitySummary, isLoading: summaryLoading } = useQuery<ActivitySummary>({
    queryKey: [summaryUrl],
  });

  const recentUpdatesUrl = isAllBranches
    ? "/api/activity-logs?limit=8"
    : `/api/activity-logs?branchId=${selectedBranchId}&limit=8`;

  const { data: recentUpdates, isLoading: recentUpdatesLoading } = useQuery<{ logs: ActivityLog[]; totalCount: number }>({
    queryKey: [recentUpdatesUrl],
  });

  const assetsCountUrl = isAllBranches
    ? "/api/assets/unreturned/count"
    : `/api/assets/unreturned/count?branchId=${selectedBranchId}`;

  const { data: unreturnedAssetsData, isLoading: assetsLoading } = useQuery<{ count: number }>({
    queryKey: [assetsCountUrl],
  });

  // Timekeeping data for dashboard tiles - last 48 hours (yesterday + day before)
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const dayBeforeYesterday = new Date(today);
  dayBeforeYesterday.setDate(dayBeforeYesterday.getDate() - 2);
  const yesterdayStr = yesterday.toISOString().split('T')[0];
  const dayBeforeYesterdayStr = dayBeforeYesterday.toISOString().split('T')[0];
  const todayStr = today.toISOString().split('T')[0];
  
  // Query yesterday for issues
  const timekeepingYesterdayUrl = isAllBranches
    ? `/api/timekeeping/review?date=${yesterdayStr}`
    : `/api/timekeeping/review?date=${yesterdayStr}&branchId=${selectedBranchId}`;

  // Query day before yesterday for issues (48h window)
  const timekeepingDayBeforeUrl = isAllBranches
    ? `/api/timekeeping/review?date=${dayBeforeYesterdayStr}`
    : `/api/timekeeping/review?date=${dayBeforeYesterdayStr}&branchId=${selectedBranchId}`;

  const canViewTimekeeping = user?.role === "global_admin" || user?.role === "operator_admin" || user?.role === "admin" || user?.role === "manager";

  // Query yesterday's timekeeping data
  const { data: yesterdayTimekeepingData, isLoading: yesterdayLoading } = useQuery<{
    summaries: Array<{ isOpenSession: boolean; isLateArrival: boolean }>;
    issuesCount: number;
  }>({
    queryKey: [timekeepingYesterdayUrl],
    enabled: canViewTimekeeping,
  });

  // Query day before yesterday's timekeeping data (for 48h window)
  const { data: dayBeforeTimekeepingData, isLoading: dayBeforeLoading } = useQuery<{
    summaries: Array<{ isOpenSession: boolean; isLateArrival: boolean }>;
    issuesCount: number;
  }>({
    queryKey: [timekeepingDayBeforeUrl],
    enabled: canViewTimekeeping,
  });

  const liveTimekeepingUrl = isAllBranches
    ? "/api/timekeeping/live"
    : `/api/timekeeping/live?branchId=${selectedBranchId}`;

  const { data: liveTimekeepingData, isLoading: todayTimekeepingLoading } = useQuery<{
    currentlyWorkingCount: number;
  }>({
    queryKey: ["/api/timekeeping/live", isAllBranches ? "all" : selectedBranchId],
    queryFn: () => fetch(liveTimekeepingUrl, { credentials: "include" }).then(r => r.json()),
    enabled: canViewTimekeeping,
    refetchInterval: 60000,
  });

  // Sum issues from last 48 hours (yesterday + day before yesterday)
  const timekeepingLoading = yesterdayLoading || dayBeforeLoading;
  const timekeepingIssuesCount = (yesterdayTimekeepingData?.issuesCount || 0) + (dayBeforeTimekeepingData?.issuesCount || 0);
  const currentlyWorkingCount = liveTimekeepingData?.currentlyWorkingCount || 0;

  const refreshAttentionMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/attention-items/refresh");
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Attention items refreshed",
        description: data.message,
      });
      queryClient.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey[0];
          return typeof key === "string" && key.startsWith("/api/attention-items");
        },
      });
    },
    onError: () => {
      toast({
        title: "Refresh failed",
        description: "Could not refresh attention items",
        variant: "destructive",
      });
    },
  });

  const filteredEmployees = employees?.filter(e => {
    if (isAllBranches) return true;
    return e.branchId === selectedBranchId;
  }) || [];

  const activeEmployees = filteredEmployees.filter(e => e.status === "active");
  const leavingEmployees = filteredEmployees.filter(e => e.employmentState === "LEAVING");

  const filteredContracts = contracts?.filter(c => {
    if (isAllBranches) return true;
    return c.branchId === selectedBranchId;
  }) || [];

  const upcomingProbationReviews = activeEmployees.filter(e => {
    if (!e.probationEndDate || e.probationReviewCompletedAt) return false;
    const endDate = new Date(e.probationEndDate);
    const thirtyDaysFromNow = addDays(new Date(), 30);
    return endDate <= thirtyDaysFromNow;
  });

  const pendingUnsignedContracts = filteredContracts.filter(c => {
    if (c.status === "draft" || c.status === "finalized") return true;
    if (c.signingStatus === "awaiting_signature") return true;
    return false;
  });

  // Calculate employees without any signed/active contract
  const unsignedEmployees = activeEmployees.filter(emp => {
    const employeeContracts = filteredContracts.filter(c => c.employeeId === emp.id);
    const hasSignedContract = employeeContracts.some(c => 
      c.status === "active" || c.signingStatus === "signed"
    );
    return !hasSignedContract;
  });

  const attentionSeverity = attentionCounts?.high && attentionCounts.high > 0
    ? "high"
    : attentionCounts?.medium && attentionCounts.medium > 0
    ? "medium"
    : undefined;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-medium" data-testid="text-dashboard-title">
          Welcome back, {user?.fullName?.split(" ")[0]}
        </h1>
        <p className="text-muted-foreground">
          {isAllBranches ? "Company overview across all branches" : "Branch overview"}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {/* 1. Attention Required - single source of truth for all actionable items */}
        <DashboardCard
          title="Attention Required"
          value={attentionCounts?.total || 0}
          description={attentionCounts?.high ? `${attentionCounts.high} high priority` : "No urgent items"}
          icon={AlertTriangle}
          loading={attentionLoading}
          href="/attention"
          severity={attentionSeverity}
          priority
        />
        {/* 2. Timekeeping Issues - late arrivals from last 48 hours */}
        {canViewTimekeeping && (
          <DashboardCard
            title="Timekeeping Issues"
            value={timekeepingIssuesCount}
            description="Last 48 hours"
            icon={AlertCircle}
            loading={timekeepingLoading}
            href={`/timekeeping-review?date=${yesterdayStr}&issuesOnly=true`}
            severity={timekeepingIssuesCount > 0 ? "medium" : undefined}
          />
        )}
        {/* 3. Currently Working - employees with open sessions today */}
        {canViewTimekeeping && (
          <DashboardCard
            title="Currently Working"
            value={currentlyWorkingCount}
            description="On shift"
            icon={Clock}
            loading={todayTimekeepingLoading}
            href="/timekeeping/live"
          />
        )}
        {/* 4. Employees - active employee count */}
        <DashboardCard
          title="Employees"
          value={activeEmployees.length}
          description="Currently active"
          icon={Users}
          loading={employeesLoading}
          href="/employees?status=active"
        />
        {/* 5. Staff Movements - last 30 days activity */}
        <DashboardCard
          title="Staff Movements"
          value={activitySummary?.total || 0}
          description="Last 30 days"
          icon={TrendingUp}
          loading={summaryLoading}
          href="/staff-movements"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <div>
              <CardTitle>
                {user?.role === "staff" ? "Your Dashboard" : user?.role === "admin" ? "Admin Actions" : "Quick Actions"}
              </CardTitle>
              <CardDescription>
                {user?.role === "staff" 
                  ? "Overview of your branch activity" 
                  : user?.role === "admin"
                    ? "Company-wide management tools"
                    : "Common tasks you can perform"}
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {/* Staff role - read-only info links */}
            {user?.role === "staff" && (
              <Link href="/employees">
                <Button variant="outline" className="w-full justify-start" data-testid="button-view-employees">
                  <Users className="mr-2 h-4 w-4" />
                  View Employees
                  <ArrowRight className="ml-auto h-4 w-4" />
                </Button>
              </Link>
            )}
            {user?.role === "staff" && (
              <Link href="/contracts">
                <Button variant="outline" className="w-full justify-start" data-testid="button-view-contracts">
                  <FileSignature className="mr-2 h-4 w-4" />
                  View Contracts
                  <ArrowRight className="ml-auto h-4 w-4" />
                </Button>
              </Link>
            )}
            {user?.role === "staff" && (
              <Link href="/activity-logbook">
                <Button variant="outline" className="w-full justify-start" data-testid="button-view-activity">
                  <Activity className="mr-2 h-4 w-4" />
                  View Activity Log
                  <ArrowRight className="ml-auto h-4 w-4" />
                </Button>
              </Link>
            )}
            {/* Manager and Admin - can create */}
            {user?.role !== "staff" && !isAllBranches && (
              <Link href="/contracts/new">
                <Button className="w-full justify-start" data-testid="button-new-contract">
                  <Plus className="mr-2 h-4 w-4" />
                  Generate New Contract
                  <ArrowRight className="ml-auto h-4 w-4" />
                </Button>
              </Link>
            )}
            {user?.role !== "staff" && (
              <Link href="/employees/new">
                <Button variant="outline" className="w-full justify-start" data-testid="button-new-employee">
                  <Users className="mr-2 h-4 w-4" />
                  Add New Employee
                  <ArrowRight className="ml-auto h-4 w-4" />
                </Button>
              </Link>
            )}
            {user?.role !== "staff" && (
              <Button
                variant="outline"
                className="w-full justify-start"
                onClick={() => refreshAttentionMutation.mutate()}
                disabled={refreshAttentionMutation.isPending}
                data-testid="button-refresh-attention"
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${refreshAttentionMutation.isPending ? "animate-spin" : ""}`} />
                Refresh Attention Items
                <ArrowRight className="ml-auto h-4 w-4" />
              </Button>
            )}
            {/* Admin-only actions */}
            {user?.role === "admin" && (
              <Link href="/templates">
                <Button variant="outline" className="w-full justify-start" data-testid="button-manage-templates">
                  <FileSignature className="mr-2 h-4 w-4" />
                  Manage Templates
                  <ArrowRight className="ml-auto h-4 w-4" />
                </Button>
              </Link>
            )}
            {user?.role === "admin" && (
              <Link href="/users">
                <Button variant="outline" className="w-full justify-start" data-testid="button-manage-users">
                  <Users className="mr-2 h-4 w-4" />
                  Manage Users
                  <ArrowRight className="ml-auto h-4 w-4" />
                </Button>
              </Link>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-4 w-4" />
                Recent Updates
              </CardTitle>
              <CardDescription>Latest activity across the system</CardDescription>
            </div>
            <Link href="/activity-logbook">
              <Button variant="ghost" size="sm" data-testid="button-view-all-activity">
                View All
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            {recentUpdatesLoading ? (
              <div className="space-y-3">
                {[1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : recentUpdates?.logs && recentUpdates.logs.length > 0 ? (
              <div className="space-y-3">
                {recentUpdates.logs.map((log) => {
                  // Determine the link destination based on activity type and IDs
                  const getActivityLink = () => {
                    // Contract-related activities - link to contract detail
                    if (log.contractInstanceId) {
                      return `/contracts/${log.contractInstanceId}`;
                    }
                    // Employee-related activities - link to employee editor
                    if (log.employeeId) {
                      return `/employees/${log.employeeId}`;
                    }
                    // Template-related activities
                    if (log.templateId) {
                      return `/templates/${log.templateId}`;
                    }
                    // Policy-related activities - link to policies page
                    if (log.activityType.startsWith("policy_")) {
                      return "/policies";
                    }
                    // User-related activities - link to users page
                    if (["USER_CREATED", "USER_DISABLED", "USER_ENABLED", "USER_PASSWORD_RESET_BY_ADMIN"].includes(log.activityType)) {
                      return "/users";
                    }
                    // Attention item activities - link to dashboard (attention section)
                    if (log.attentionItemId || log.activityType.startsWith("attention_")) {
                      return "/";
                    }
                    return null;
                  };
                  
                  const link = getActivityLink();
                  // Sanitize display text to replace any "undefined" with "Unknown"
                  const displayText = (log.summaryText || "")
                    .replace(/undefined undefined/g, "Unknown")
                    .replace(/for undefined\b/g, "for Unknown")
                    .replace(/\bundefined\b/g, "Unknown");
                  const content = (
                    <div
                      className={`flex items-start justify-between gap-2 text-sm ${link ? "hover-elevate cursor-pointer rounded-md p-2 -m-2" : ""}`}
                      data-testid={`activity-item-${log.id}`}
                    >
                      <span className="text-foreground line-clamp-2">{displayText}</span>
                      <span className="text-muted-foreground text-xs whitespace-nowrap">
                        {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}
                      </span>
                    </div>
                  );
                  
                  return link ? (
                    <Link key={log.id} href={link}>
                      {content}
                    </Link>
                  ) : (
                    <div key={log.id}>{content}</div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">
                No recent activity to display
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
