import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { ActivityLog, Employee, Branch } from "@shared/schema";
import { useBranchContext } from "@/hooks/use-branch-context";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  TrendingUp,
  DollarSign,
  UserMinus,
  Activity,
  ArrowRight,
  RefreshCw,
} from "lucide-react";
import { formatDate } from "@/lib/format-utils";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

const activityTypeLabels: Record<string, string> = {
  promotion: "Promotion",
  salary_change: "Salary Change",
  incentive_change: "Incentive Change",
  employment_ended: "Departed",
  resigned: "Resigned",
  terminated: "Terminated",
};

const activityTypeIcons: Record<string, React.ElementType> = {
  promotion: TrendingUp,
  salary_change: DollarSign,
  incentive_change: TrendingUp,
  employment_ended: UserMinus,
  resigned: UserMinus,
  terminated: UserMinus,
};

const activityTypeColors: Record<string, string> = {
  promotion: "text-emerald-600 dark:text-emerald-400",
  salary_change: "text-blue-600 dark:text-blue-400",
  incentive_change: "text-purple-600 dark:text-purple-400",
  employment_ended: "text-orange-600 dark:text-orange-400",
  resigned: "text-orange-600 dark:text-orange-400",
  terminated: "text-red-600 dark:text-red-400",
};

function getEmploymentEndedSubtype(summaryText: string | null): "resigned" | "terminated" | "employment_ended" {
  if (!summaryText) return "employment_ended";
  const lower = summaryText.toLowerCase();
  if (lower.includes("terminated")) return "terminated";
  if (lower.includes("resigned")) return "resigned";
  return "employment_ended";
}

function MovementsTableSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="flex items-center gap-4 p-4">
          <Skeleton className="h-8 w-8 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="h-6 w-20" />
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="text-center py-16">
      <Activity className="h-16 w-16 mx-auto mb-4 text-muted-foreground/50" />
      <h3 className="text-lg font-medium mb-2">No staff movements</h3>
      <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
        No promotions, compensation changes, or departures in the last 30 days.
      </p>
    </div>
  );
}

function parseChangeDetails(log: ActivityLog): { from: string; to: string } | null {
  if (log.metadataJson) {
    try {
      const meta = typeof log.metadataJson === "string" ? JSON.parse(log.metadataJson) : log.metadataJson;
      if (meta.oldValue !== undefined && meta.newValue !== undefined) {
        const formatVal = (v: any) => typeof v === "number" ? `฿${v.toLocaleString()}` : String(v);
        return { from: formatVal(meta.oldValue), to: formatVal(meta.newValue) };
      }
    } catch {}
  }
  if (log.summaryText) {
    const salaryMatch = log.summaryText.match(/salary changed from (฿[\d,]+) to (฿[\d,]+)/i);
    if (salaryMatch) return { from: salaryMatch[1], to: salaryMatch[2] };
    const posMatch = log.summaryText.match(/position changed from "(.+?)" to "(.+?)"/i);
    if (posMatch) return { from: posMatch[1], to: posMatch[2] };
    const incentiveMatch = log.summaryText.match(/incentive changed from "(.+?)" to "(.+?)"/i);
    if (incentiveMatch) return { from: incentiveMatch[1], to: incentiveMatch[2] };
  }
  return null;
}

function ActivityTypeBadge({ type, summaryText }: { type: string; summaryText?: string | null }) {
  const displayType = type === "employment_ended" ? getEmploymentEndedSubtype(summaryText ?? null) : type;
  const Icon = activityTypeIcons[displayType] || Activity;
  const color = activityTypeColors[displayType] || "text-muted-foreground";
  const label = activityTypeLabels[displayType] || type;

  return (
    <Badge variant="outline" className={`whitespace-nowrap ${color}`}>
      <Icon className="h-3 w-3 mr-1" />
      {label}
    </Badge>
  );
}

export default function StaffMovementsPage() {
  const { selectedBranchId, isAllBranches } = useBranchContext();
  const { user } = useAuth();
  const { toast } = useToast();
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const movementTypes = "promotion,salary_change,incentive_change,employment_ended";
  const activityUrl = isAllBranches
    ? `/api/activity-logs?limit=200&sinceDays=30&types=${movementTypes}`
    : `/api/activity-logs?branchId=${selectedBranchId}&limit=200&sinceDays=30&types=${movementTypes}`;

  const { data: activityLogsResponse, isLoading } = useQuery<{ logs: ActivityLog[]; totalCount: number }>({
    queryKey: [activityUrl],
  });

  const backfillMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/activity-logs/backfill-departures");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [activityUrl] });
      toast({
        title: "Historical data synced",
        description: `Found and added ${data.created} missing departure records.`,
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to sync historical data. Please try again.",
        variant: "destructive",
      });
    },
  });

  const activityLogs = activityLogsResponse?.logs;

  const { data: employees } = useQuery<Employee[]>({
    queryKey: ["/api/employees"],
  });

  const { data: branches } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const employeeMap = new Map(employees?.map((e) => [e.id, e]) || []);
  const branchMap = new Map(branches?.map((b) => [b.id, b]) || []);

  const filteredLogs = activityLogs?.filter(log => {
    if (typeFilter === "all") return true;
    if (typeFilter === "promotions") return log.activityType === "promotion";
    if (typeFilter === "compensation") return log.activityType === "salary_change" || log.activityType === "incentive_change";
    if (typeFilter === "resigned") return log.activityType === "employment_ended" && log.summaryText?.toLowerCase().includes("resigned");
    if (typeFilter === "terminated") return log.activityType === "employment_ended" && log.summaryText?.toLowerCase().includes("terminated");
    return true;
  }) || [];

  const departedLogs = activityLogs?.filter(l => l.activityType === "employment_ended") || [];
  const summaryStats = {
    promotions: activityLogs?.filter(l => l.activityType === "promotion").length || 0,
    compensation: activityLogs?.filter(l => l.activityType === "salary_change" || l.activityType === "incentive_change").length || 0,
    resigned: departedLogs.filter(l => getEmploymentEndedSubtype(l.summaryText) === "resigned").length,
    terminated: departedLogs.filter(l => getEmploymentEndedSubtype(l.summaryText) === "terminated").length,
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-medium flex items-center gap-2" data-testid="text-movements-title">
            <TrendingUp className="h-8 w-8" />
            Staff Movements
          </h1>
          <p className="text-muted-foreground mt-1">
            {isAllBranches ? "Activity across all branches (last 30 days)" : "Activity for selected branch (last 30 days)"}
          </p>
        </div>
        {user?.role === "admin" && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => backfillMutation.mutate()}
            disabled={backfillMutation.isPending}
            data-testid="button-sync-historical"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${backfillMutation.isPending ? "animate-spin" : ""}`} />
            {backfillMutation.isPending ? "Syncing..." : "Sync Historical Data"}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Filter:</span>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[180px]" data-testid="select-movement-filter">
              <SelectValue placeholder="All movements" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Movements</SelectItem>
              <SelectItem value="promotions">Promotions</SelectItem>
              <SelectItem value="compensation">Compensation Changes</SelectItem>
              <SelectItem value="resigned">Resigned</SelectItem>
              <SelectItem value="terminated">Terminated</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-wrap gap-4 text-sm ml-auto">
          <span className="flex items-center gap-1">
            <TrendingUp className="h-4 w-4 text-emerald-600" />
            {summaryStats.promotions} Promotions
          </span>
          <span className="flex items-center gap-1">
            <DollarSign className="h-4 w-4 text-blue-600" />
            {summaryStats.compensation} Compensation
          </span>
          <span className="flex items-center gap-1">
            <UserMinus className="h-4 w-4 text-orange-600" />
            {summaryStats.resigned} Resigned
          </span>
          <span className="flex items-center gap-1">
            <UserMinus className="h-4 w-4 text-red-600" />
            {summaryStats.terminated} Terminated
          </span>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <MovementsTableSkeleton />
          ) : filteredLogs.length === 0 ? (
            <EmptyState />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  {isAllBranches && <TableHead>Branch</TableHead>}
                  <TableHead>Event</TableHead>
                  <TableHead>Details</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredLogs.map((log) => {
                  const employee = employeeMap.get(log.employeeId || "");
                  const branch = branchMap.get(employee?.branchId || "");
                  const displayType = log.activityType === "employment_ended" 
                    ? getEmploymentEndedSubtype(log.summaryText) 
                    : log.activityType;
                  const Icon = activityTypeIcons[displayType] || Activity;
                  const iconColor = activityTypeColors[displayType] || "text-muted-foreground";
                  const changeDetails = parseChangeDetails(log);

                  return (
                    <TableRow key={log.id} data-testid={`movement-row-${log.id}`}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className={`flex h-8 w-8 items-center justify-center rounded-full bg-muted flex-shrink-0 ${iconColor}`}>
                            <Icon className="h-4 w-4" />
                          </div>
                          <div>
                            {employee ? (
                              <Link href={`/employees/${employee.id}`}>
                                <span className="font-medium text-foreground hover:underline cursor-pointer" data-testid={`link-employee-${log.id}`}>
                                  {employee.nickname || employee.fullName}
                                </span>
                              </Link>
                            ) : (
                              <p className="font-medium">Unknown</p>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      {isAllBranches && (
                        <TableCell>
                          <span className="text-sm">{branch?.name || "Unknown"}</span>
                        </TableCell>
                      )}
                      <TableCell>
                        <ActivityTypeBadge type={log.activityType} summaryText={log.summaryText} />
                      </TableCell>
                      <TableCell>
                        {changeDetails ? (
                          <div className="text-sm">
                            <span className="text-muted-foreground">{changeDetails.from}</span>
                            <ArrowRight className="inline h-3 w-3 mx-1 text-muted-foreground" />
                            <span className="font-medium">{changeDetails.to}</span>
                          </div>
                        ) : log.activityType === "employment_ended" ? (
                          <span className="text-sm text-muted-foreground">
                            {log.summaryText?.match(/ - (.+)$/)?.[1] || (getEmploymentEndedSubtype(log.summaryText ?? null) === "terminated" ? "Terminated" : "Resigned")}
                          </span>
                        ) : (
                          <span className="text-sm text-muted-foreground">{"\u2014"}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="text-sm">{formatDate(log.createdAt)}</span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
