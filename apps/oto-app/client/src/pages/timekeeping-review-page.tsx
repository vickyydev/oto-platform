import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { useBranchContext } from "@/hooks/use-branch-context";
import { useAuth } from "@/hooks/use-auth";
import { formatDate } from "@/lib/format-utils";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { DatePicker } from "@/components/ui/date-picker";
import { 
  Clock, 
  AlertTriangle, 
  AlertCircle, 
  Search, 
  ArrowRight, 
  Timer, 
  KeyRound,
  UserX,
  User,
  Users,
  RefreshCw,
  Image,
  CheckCircle,
  XCircle,
  ClipboardCheck,
  Loader2,
  Pencil,
  Trash2
} from "lucide-react";
import { ClickableEmployeeAvatar } from "@/components/clickable-employee-avatar";

interface EmployeeDaySummary {
  employeeId: string;
  employeeName: string;
  branchId: string | null;
  branchName: string | null;
  profilePhotoPath?: string | null;
  date: string;
  firstInTime: string | null;
  lastOutTime: string | null;
  totalMinutes: number;
  totalHours: number;
  sessionCount: number;
  anomalies: string[];
  hasPinUsed: boolean;
  pinEventsCount: number;
  pinPhotoUrls: string[];
  faceEventsCount: number;
  isOpenSession: boolean;
  isMissingIn: boolean;
  isLongShift: boolean;
  isLateArrival: boolean;
  lateMinutes: number | null;
  scheduledStartTime: string | null;
  isOnShift?: boolean;
  isScheduledNoShow?: boolean;
  identityType?: "EMPLOYEE" | "ADVISOR";
  isOvernight?: boolean;
  branchTimezone?: string;
  advisorSessions?: AdvisorAttendanceSession[];
}

interface AdvisorAttendanceCorrection {
  id: string;
  action: "CREATE" | "EDIT" | "VOID";
  reason: string;
  changedByName: string;
  createdAt: string;
}

interface AdvisorAttendanceSession {
  id: string;
  checkInAt: string;
  checkOutAt: string | null;
  durationMinutes: number | null;
  isOvernight: boolean;
  corrections: AdvisorAttendanceCorrection[];
}

interface ReviewResponse {
  date: string;
  summaries: EmployeeDaySummary[];
  totalEmployees: number;
  issuesCount: number;
  longShiftsCount: number;
}

interface PendingIssue {
  id: string;
  employeeId: string;
  employeeName: string;
  employeePhotoPath?: string | null;
  branchId: string;
  branchName?: string | null;
  issueType: string;
  issueDate: string;
  userClockInAt?: string | null;
  reasonCode?: string | null;
  userNote?: string | null;
  status: string;
  createdAt: string;
}

interface PendingIssuesResponse {
  issues: PendingIssue[];
  count: number;
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function formatHours(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}h ${m}m`;
}

function toDateTimeLocal(value: string | null, timezone: string): string {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

function zonedDateTimeToIso(value: string, timezone: string): string {
  const [datePart, timePart] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  const intendedUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (date: Date) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(date);
    const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - date.getTime();
  };
  let result = new Date(intendedUtc - offsetAt(new Date(intendedUtc)));
  result = new Date(intendedUtc - offsetAt(result));
  return result.toISOString();
}

function StatusBadges({ summary, onPinPhotoClick }: { summary: EmployeeDaySummary; onPinPhotoClick?: (urls: string[]) => void }) {
  const badges = [];
  
  if (summary.isOnShift) {
    badges.push(
      <Badge key="onshift" variant="secondary" className="text-xs">
        <Clock className="h-3 w-3 mr-1" />
        On Shift
      </Badge>
    );
  }
  
  if (summary.isOpenSession) {
    badges.push(
      <Badge key="open" variant="destructive" className="text-xs">
        <AlertCircle className="h-3 w-3 mr-1" />
        No OUT
      </Badge>
    );
  }
  if (summary.isOvernight) {
    badges.push(<Badge key="overnight" variant="secondary" className="text-xs">Overnight</Badge>);
  }
  
  if (summary.isMissingIn) {
    badges.push(
      <Badge key="missing" variant="destructive" className="text-xs">
        <AlertTriangle className="h-3 w-3 mr-1" />
        Missing IN
      </Badge>
    );
  }
  
  if (summary.anomalies.includes("MULTIPLE_IN")) {
    badges.push(
      <Badge key="multi-in" variant="secondary" className="text-xs">
        Multi IN
      </Badge>
    );
  }
  
  if (summary.anomalies.includes("MULTIPLE_OUT")) {
    badges.push(
      <Badge key="multi-out" variant="secondary" className="text-xs">
        Multi OUT
      </Badge>
    );
  }
  
  if (summary.isLongShift) {
    badges.push(
      <Badge key="long" className="text-xs bg-amber-500 text-white hover:bg-amber-600">
        <Timer className="h-3 w-3 mr-1" />
        {">"}9h
      </Badge>
    );
  }
  
  if (summary.isLateArrival) {
    const lateText = summary.lateMinutes && summary.lateMinutes >= 60
      ? `${Math.floor(summary.lateMinutes / 60)}h ${summary.lateMinutes % 60}m late`
      : `${summary.lateMinutes}m late`;
    badges.push(
      <Badge key="late" className="text-xs bg-orange-500 text-white hover:bg-orange-600">
        <Clock className="h-3 w-3 mr-1" />
        {lateText}
      </Badge>
    );
  }

  if (summary.isScheduledNoShow) {
    badges.push(
      <Badge key="noshow" variant="destructive" className="text-xs">
        <AlertTriangle className="h-3 w-3 mr-1" />
        Absent
      </Badge>
    );
  }
  
  if (summary.hasPinUsed) {
    const hasPhotos = summary.pinPhotoUrls && summary.pinPhotoUrls.length > 0;
    if (hasPhotos && onPinPhotoClick) {
      badges.push(
        <Button
          key="pin"
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs text-amber-600 border-amber-600"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onPinPhotoClick(summary.pinPhotoUrls);
          }}
          data-testid={`button-pin-photo-${summary.employeeId}`}
        >
          <KeyRound className="h-3 w-3 mr-1" />
          PIN ({summary.pinPhotoUrls.length})
        </Button>
      );
    } else {
      badges.push(
        <Badge key="pin" variant="outline" className="text-xs">
          <KeyRound className="h-3 w-3 mr-1" />
          PIN
        </Badge>
      );
    }
  }
  
  return <div className="flex flex-wrap gap-1">{badges}</div>;
}

function TableSkeleton() {
  return (
    <div className="space-y-2">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="flex items-center gap-4 p-4 border rounded-md">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div className="text-center py-12 text-muted-foreground">
      <Clock className="h-12 w-12 mx-auto mb-4 opacity-50" />
      <h3 className="font-medium text-lg">No time records found</h3>
      <p className="text-sm mt-1">
        {hasFilters 
          ? "Try adjusting your filters to see more results" 
          : "No employees have clocked in for the selected date"}
      </p>
    </div>
  );
}

export default function TimekeepingReviewPage() {
  const { user } = useAuth();
  const { selectedBranchId, isAllBranches } = useBranchContext();
  const { toast } = useToast();
  
  /**
   * Open on the day the link asked for, not on today.
   *
   * The dashboard's Timekeeping Issues tile links here as
   * `/timekeeping-review?date=<yesterday>&issuesOnly=true`, and both parameters
   * were being thrown away — the page always opened on today, which on a
   * quiet morning is an empty table where the issues the tile just counted
   * ought to be. The date picker below still moves freely from wherever it
   * lands; this only decides where it lands.
   */
  const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const requestedDate = params.get("date");
  const [date, setDate] = useState(() =>
    requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
      ? requestedDate
      : new Date().toISOString().split('T')[0],
  );
  const [issuesOnly, setIssuesOnly] = useState(params.get("issuesOnly") === "true");
  const [longShiftOnly, setLongShiftOnly] = useState(false);
  const [authMethodFilter, setAuthMethodFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [photoPreviewUrls, setPhotoPreviewUrls] = useState<string[] | null>(null);
  const [currentPhotoIndex, setCurrentPhotoIndex] = useState(0);
  const [resolveDialogOpen, setResolveDialogOpen] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState<PendingIssue | null>(null);
  const [resolveAction, setResolveAction] = useState<'approve' | 'reject' | null>(null);
  const [managerNote, setManagerNote] = useState("");
  const [advisorDialogOpen, setAdvisorDialogOpen] = useState(false);
  const [selectedAdvisor, setSelectedAdvisor] = useState<EmployeeDaySummary | null>(null);
  const [selectedAdvisorSession, setSelectedAdvisorSession] = useState<AdvisorAttendanceSession | null>(null);
  const [advisorAction, setAdvisorAction] = useState<"EDIT" | "VOID">("EDIT");
  const [advisorCheckIn, setAdvisorCheckIn] = useState("");
  const [advisorCheckOut, setAdvisorCheckOut] = useState("");
  const [advisorReason, setAdvisorReason] = useState("");

  const branchParam = isAllBranches ? undefined : selectedBranchId;

  // Query for pending issues requiring approval (filtered by selected branch)
  const pendingQueryUrl = branchParam 
    ? `/api/timekeeping/pending-issues?branchId=${branchParam}` 
    : "/api/timekeeping/pending-issues";
  const { data: pendingIssuesData, isLoading: pendingLoading, refetch: refetchPending } = useQuery<PendingIssuesResponse>({
    queryKey: ["/api/timekeeping/pending-issues", branchParam],
    queryFn: async () => {
      const response = await fetch(pendingQueryUrl, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch pending issues");
      return response.json();
    },
  });

  // Mutation for resolving issues
  const resolveMutation = useMutation({
    mutationFn: async ({ issueId, action, note }: { issueId: string; action: 'approve' | 'reject'; note: string }) => {
      const res = await apiRequest("POST", `/api/timekeeping/issues/${issueId}/resolve`, {
        action,
        managerNote: note || undefined,
      });
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: data.message,
        description: `Time entry for ${data.issue?.employeeName} has been ${resolveAction === 'approve' ? 'approved' : 'rejected'}.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/timekeeping/pending-issues", branchParam] });
      queryClient.invalidateQueries({ queryKey: ["/api/timekeeping/review"] });
      setResolveDialogOpen(false);
      setSelectedIssue(null);
      setResolveAction(null);
      setManagerNote("");
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to resolve issue",
        variant: "destructive",
      });
    },
  });

  const openResolveDialog = (issue: PendingIssue, action: 'approve' | 'reject') => {
    setSelectedIssue(issue);
    setResolveAction(action);
    setManagerNote("");
    setResolveDialogOpen(true);
  };

  const handleResolveConfirm = () => {
    if (!selectedIssue || !resolveAction) return;
    resolveMutation.mutate({
      issueId: selectedIssue.id,
      action: resolveAction,
      note: managerNote,
    });
  };

  const getReasonLabel = (code: string | null | undefined) => {
    const labels: Record<string, string> = {
      'FORGOT_TO_CLOCK_IN': 'Forgot to clock in',
      'DEVICE_ISSUE': 'Device was not working',
      'MANAGER_INSTRUCTED': 'Manager instructed',
      'LATE_ARRIVAL': 'Arrived late',
      'COVERING_ABSENT_STAFF': 'Covering absent staff',
      'EMERGENCY_TASK': 'Emergency / urgent task',
      'TRAINING': 'Training',
      'OTHER': 'Other reason',
    };
    return code ? labels[code] || code : '-';
  };

  const getIssueTypeLabel = (type: string) => {
    const labels: Record<string, { label: string; className: string }> = {
      'MISSING_CLOCK_IN': { label: 'Missed Clock-in', className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200' },
      'UNSCHEDULED_WORK': { label: 'Unscheduled Work', className: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-200' },
    };
    return labels[type] || null;
  };
  
  const { data, isLoading, refetch, isFetching } = useQuery<ReviewResponse>({
    queryKey: ["/api/timekeeping/review", date, branchParam, issuesOnly, longShiftOnly, authMethodFilter, searchQuery],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("date", date);
      if (branchParam) params.set("branchId", branchParam);
      if (issuesOnly) params.set("issuesOnly", "true");
      if (longShiftOnly) params.set("longShiftOnly", "true");
      if (authMethodFilter !== "all") params.set("authMethod", authMethodFilter);
      if (searchQuery) params.set("search", searchQuery);
      
      const response = await fetch(`/api/timekeeping/review?${params.toString()}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch timekeeping data");
      return response.json();
    },
  });

  const hasFilters = issuesOnly || longShiftOnly || authMethodFilter !== "all" || searchQuery.length > 0;

  const advisorCorrectionMutation = useMutation({
    mutationFn: async () => {
      if (!selectedAdvisorSession) throw new Error("Select a session");
      const response = await apiRequest("PATCH", `/api/timekeeping/advisor-sessions/${selectedAdvisorSession.id}`, {
        action: advisorAction,
        reason: advisorReason,
        ...(advisorAction === "EDIT" ? {
          checkInAt: zonedDateTimeToIso(advisorCheckIn, selectedAdvisor?.branchTimezone || "Asia/Bangkok"),
          checkOutAt: advisorCheckOut ? zonedDateTimeToIso(advisorCheckOut, selectedAdvisor?.branchTimezone || "Asia/Bangkok") : null,
        } : {}),
      });
      return response.json();
    },
    onSuccess: () => {
      toast({ title: advisorAction === "VOID" ? "Advisor session voided" : "Advisor session updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/timekeeping/review"] });
      setAdvisorDialogOpen(false);
    },
    onError: (error: any) => {
      toast({ title: "Correction failed", description: error.message, variant: "destructive" });
    },
  });

  const openAdvisorDialog = (summary: EmployeeDaySummary) => {
    const session = summary.advisorSessions?.[0] || null;
    setSelectedAdvisor(summary);
    setSelectedAdvisorSession(session);
    setAdvisorAction("EDIT");
    const timezone = summary.branchTimezone || "Asia/Bangkok";
    setAdvisorCheckIn(toDateTimeLocal(session?.checkInAt || null, timezone));
    setAdvisorCheckOut(toDateTimeLocal(session?.checkOutAt || null, timezone));
    setAdvisorReason("");
    setAdvisorDialogOpen(true);
  };

  const selectAdvisorSession = (sessionId: string) => {
    const session = selectedAdvisor?.advisorSessions?.find((item) => item.id === sessionId) || null;
    setSelectedAdvisorSession(session);
    const timezone = selectedAdvisor?.branchTimezone || "Asia/Bangkok";
    setAdvisorCheckIn(toDateTimeLocal(session?.checkInAt || null, timezone));
    setAdvisorCheckOut(toDateTimeLocal(session?.checkOutAt || null, timezone));
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-medium flex items-center gap-2" data-testid="text-timekeeping-review-title">
            <Clock className="h-8 w-8 text-foreground" />
            Timekeeping Review
          </h1>
          <p className="text-muted-foreground mt-1">
            {isAllBranches ? "Review time records across all branches" : "Review time records for selected branch"}
          </p>
        </div>
        <Button 
          variant="outline" 
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="button-refresh"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-lg">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            <div className="space-y-2">
              <Label>Date</Label>
              <DatePicker
                value={date}
                onChange={setDate}
                data-testid="input-date"
              />
            </div>

            <div className="space-y-2">
              <Label>Search Employee</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by name..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                  data-testid="input-search"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Auth Method</Label>
              <Select value={authMethodFilter} onValueChange={setAuthMethodFilter}>
                <SelectTrigger data-testid="select-auth-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Methods</SelectItem>
                  <SelectItem value="PIN">PIN Used</SelectItem>
                  <SelectItem value="FACE">Face Only</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-end gap-4">
              <div className="flex items-center gap-2">
                <Switch
                  id="issues-only"
                  checked={issuesOnly}
                  onCheckedChange={setIssuesOnly}
                  data-testid="switch-issues-only"
                />
                <Label htmlFor="issues-only" className="cursor-pointer">
                  Issues Only
                </Label>
              </div>
            </div>

            <div className="flex items-end gap-4">
              <div className="flex items-center gap-2">
                <Switch
                  id="long-shift"
                  checked={longShiftOnly}
                  onCheckedChange={setLongShiftOnly}
                  data-testid="switch-long-shift"
                />
                <Label htmlFor="long-shift" className="cursor-pointer">
                  {">"}9h Shifts
                </Label>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <Users className="h-6 w-6 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-bold" data-testid="text-total-employees">
                  {data?.totalEmployees ?? "-"}
                </p>
                <p className="text-sm text-muted-foreground">Employees with records</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
                <AlertCircle className="h-6 w-6 text-destructive" />
              </div>
              <div>
                <p className="text-2xl font-bold" data-testid="text-issues-count">
                  {data?.issuesCount ?? "-"}
                </p>
                <p className="text-sm text-muted-foreground">Issues to review</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10">
                <Timer className="h-6 w-6 text-amber-500" />
              </div>
              <div>
                <p className="text-2xl font-bold" data-testid="text-long-shifts-count">
                  {data?.longShiftsCount ?? "-"}
                </p>
                <p className="text-sm text-muted-foreground">Long shifts ({">"}9h)</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Pending Approvals Section */}
      {(pendingIssuesData?.count ?? 0) > 0 && (
        <Card className="border-amber-300 dark:border-amber-700 bg-amber-50/50 dark:bg-amber-950/20">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ClipboardCheck className="h-5 w-5 text-amber-600" />
                <CardTitle className="text-lg">Pending Approvals</CardTitle>
                <Badge variant="secondary" className="ml-2">{pendingIssuesData?.count}</Badge>
              </div>
              <Button variant="ghost" size="sm" onClick={() => refetchPending()} data-testid="button-refresh-pending">
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
            <CardDescription>
              Time corrections and unscheduled work awaiting your approval
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {pendingIssuesData?.issues.map((issue) => (
                <div 
                  key={issue.id}
                  className="flex items-center justify-between p-4 bg-background rounded-lg border"
                  data-testid={`row-pending-issue-${issue.id}`}
                >
                  <div className="flex items-center gap-4">
                    <ClickableEmployeeAvatar
                      employeeId={issue.employeeId}
                      fullName={issue.employeeName}
                      profilePhotoPath={issue.employeePhotoPath}
                      size="sm"
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{issue.employeeName}</p>
                        {getIssueTypeLabel(issue.issueType) && (
                          <Badge 
                            variant="secondary" 
                            className={`text-xs ${getIssueTypeLabel(issue.issueType)?.className}`}
                            data-testid={`badge-issue-type-${issue.id}`}
                          >
                            {getIssueTypeLabel(issue.issueType)?.label}
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {issue.branchName} - {formatDate(issue.issueDate)}
                      </p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-6">
                    <div className="text-right">
                      <p className="text-sm font-medium">
                        {issue.issueType === 'UNSCHEDULED_WORK' 
                          ? `Clock-in: ${issue.userClockInAt ? formatTime(issue.userClockInAt) : '-'}`
                          : `Requested clock-in: ${issue.userClockInAt ? formatTime(issue.userClockInAt) : '-'}`
                        }
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {getReasonLabel(issue.reasonCode)}
                        {issue.userNote && ` - "${issue.userNote}"`}
                      </p>
                    </div>
                    
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-green-600 border-green-300 hover:bg-green-50"
                        onClick={() => openResolveDialog(issue, 'approve')}
                        data-testid={`button-approve-${issue.id}`}
                      >
                        <CheckCircle className="h-4 w-4 mr-1" />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-destructive border-red-300 hover:bg-red-50"
                        onClick={() => openResolveDialog(issue, 'reject')}
                        data-testid={`button-reject-${issue.id}`}
                      >
                        <XCircle className="h-4 w-4 mr-1" />
                        Reject
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Resolve Confirmation Dialog */}
      <Dialog open={resolveDialogOpen} onOpenChange={setResolveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {resolveAction === 'approve' ? 'Approve Time Entry' : 'Reject Time Entry'}
            </DialogTitle>
            <DialogDescription>
              {selectedIssue && (
                <>
                  {resolveAction === 'approve' 
                    ? selectedIssue.issueType === 'UNSCHEDULED_WORK'
                      ? `Approve ${selectedIssue.employeeName}'s unscheduled work clock-in at ${selectedIssue.userClockInAt ? formatTime(selectedIssue.userClockInAt) : '-'} for ${formatDate(selectedIssue.issueDate)}?`
                      : `Approve ${selectedIssue.employeeName}'s clock-in time of ${selectedIssue.userClockInAt ? formatTime(selectedIssue.userClockInAt) : '-'} for ${formatDate(selectedIssue.issueDate)}?`
                    : selectedIssue.issueType === 'UNSCHEDULED_WORK'
                      ? `Reject ${selectedIssue.employeeName}'s unscheduled work entry?`
                      : `Reject ${selectedIssue.employeeName}'s requested time correction?`
                  }
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            {selectedIssue && (
              <div className="bg-muted p-3 rounded-lg text-sm space-y-1">
                <p><span className="text-muted-foreground">Employee:</span> {selectedIssue.employeeName}</p>
                <p><span className="text-muted-foreground">Date:</span> {formatDate(selectedIssue.issueDate)}</p>
                {selectedIssue.issueType === 'UNSCHEDULED_WORK' && (
                  <p><span className="text-muted-foreground">Type:</span> <span className="text-orange-600 font-medium">Unscheduled Work</span></p>
                )}
                <p><span className="text-muted-foreground">{selectedIssue.issueType === 'UNSCHEDULED_WORK' ? 'Clock-in time:' : 'Requested time:'}</span> {selectedIssue.userClockInAt ? formatTime(selectedIssue.userClockInAt) : '-'}</p>
                <p><span className="text-muted-foreground">Reason:</span> {getReasonLabel(selectedIssue.reasonCode)}</p>
                {selectedIssue.userNote && (
                  <p><span className="text-muted-foreground">Note:</span> {selectedIssue.userNote}</p>
                )}
              </div>
            )}
            
            <div className="space-y-2">
              <Label htmlFor="manager-note">Manager Note (optional)</Label>
              <Textarea
                id="manager-note"
                value={managerNote}
                onChange={(e) => setManagerNote(e.target.value)}
                placeholder="Add a note about this decision..."
                rows={2}
                data-testid="input-manager-note"
              />
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setResolveDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant={resolveAction === 'approve' ? 'default' : 'destructive'}
              onClick={handleResolveConfirm}
              disabled={resolveMutation.isPending}
              data-testid="button-confirm-resolve"
            >
              {resolveMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {resolveAction === 'approve' ? 'Approve' : 'Reject'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle>Daily Summary - {formatDate(date)}</CardTitle>
          <CardDescription>
            Employee and advisor attendance for the selected date
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <TableSkeleton />
          ) : !data?.summaries?.length ? (
            <EmptyState hasFilters={hasFilters} />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Person</TableHead>
                    {isAllBranches && <TableHead>Branch</TableHead>}
                    <TableHead>First IN</TableHead>
                    <TableHead>Last OUT</TableHead>
                    <TableHead>Total Hours</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.summaries.map((summary) => (
                    <TableRow
                      key={`${summary.identityType || "EMPLOYEE"}:${summary.employeeId}:${summary.branchId || "no-branch"}`}
                      className={summary.isOpenSession || summary.isMissingIn || summary.isLateArrival || summary.isScheduledNoShow ? "bg-destructive/5" : ""}
                      data-testid={`row-employee-${summary.employeeId}`}
                    >
                      <TableCell>
                        <div className="flex items-center gap-3">
                          {summary.identityType === "ADVISOR" ? (
                            <User className="h-8 w-8 rounded-full bg-muted p-2 text-muted-foreground" />
                          ) : (
                            <ClickableEmployeeAvatar employeeId={summary.employeeId} fullName={summary.employeeName} profilePhotoPath={summary.profilePhotoPath} size="sm" />
                          )}
                          <span className="font-medium">{summary.employeeName}</span>
                          {summary.identityType === "ADVISOR" && <Badge variant="outline">Advisor</Badge>}
                        </div>
                      </TableCell>
                      {isAllBranches && (
                        <TableCell className="text-muted-foreground">
                          {summary.branchName || "-"}
                        </TableCell>
                      )}
                      <TableCell>
                        {formatTime(summary.firstInTime)}
                      </TableCell>
                      <TableCell>
                        {formatTime(summary.lastOutTime)}
                      </TableCell>
                      <TableCell>
                        <span className={summary.isLongShift ? "font-bold text-amber-600" : ""}>
                          {summary.totalHours > 0 ? formatHours(summary.totalHours) : "-"}
                        </span>
                      </TableCell>
                      <TableCell>
                        <StatusBadges 
                          summary={summary} 
                          onPinPhotoClick={(urls) => {
                            setPhotoPreviewUrls(urls);
                            setCurrentPhotoIndex(0);
                          }}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        {summary.identityType === "ADVISOR" ? (
                          <Button variant="ghost" size="sm" onClick={() => openAdvisorDialog(summary)} data-testid={`button-correct-advisor-${summary.employeeId}`}>
                            <Pencil className="h-4 w-4 mr-1" />
                            Correct
                          </Button>
                        ) : <Link href={`/timekeeping-review/employee/${summary.employeeId}`}>
                          <Button variant="ghost" size="sm" data-testid={`button-view-${summary.employeeId}`}>
                            View Details
                            <ArrowRight className="h-4 w-4 ml-1" />
                          </Button>
                        </Link>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={advisorDialogOpen} onOpenChange={setAdvisorDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Correct Advisor attendance</DialogTitle>
            <DialogDescription>
              Edit or void {selectedAdvisor?.employeeName}'s attendance. A reason is required and the change will be audited.
            </DialogDescription>
          </DialogHeader>
          {selectedAdvisorSession && (
            <div className="space-y-4">
              {(selectedAdvisor?.advisorSessions?.length || 0) > 1 && (
                <div className="space-y-2">
                  <Label>Session</Label>
                  <Select value={selectedAdvisorSession.id} onValueChange={selectAdvisorSession}>
                    <SelectTrigger data-testid="select-advisor-session"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {selectedAdvisor?.advisorSessions?.map((session) => (
                        <SelectItem key={session.id} value={session.id}>
                          {formatTime(session.checkInAt)} – {formatTime(session.checkOutAt)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="flex gap-2">
                <Button type="button" variant={advisorAction === "EDIT" ? "default" : "outline"} onClick={() => setAdvisorAction("EDIT")}>
                  <Pencil className="h-4 w-4 mr-1" /> Edit times
                </Button>
                <Button type="button" variant={advisorAction === "VOID" ? "destructive" : "outline"} onClick={() => setAdvisorAction("VOID")}>
                  <Trash2 className="h-4 w-4 mr-1" /> Void session
                </Button>
              </div>
              {advisorAction === "EDIT" && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Times use the {selectedAdvisor?.branchTimezone || "Asia/Bangkok"} branch timezone.</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="advisor-check-in">Check-in</Label>
                    <Input id="advisor-check-in" type="datetime-local" value={advisorCheckIn} onChange={(event) => setAdvisorCheckIn(event.target.value)} data-testid="input-advisor-check-in" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="advisor-check-out">Check-out</Label>
                    <Input id="advisor-check-out" type="datetime-local" value={advisorCheckOut} onChange={(event) => setAdvisorCheckOut(event.target.value)} data-testid="input-advisor-check-out" />
                  </div>
                  </div>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="advisor-correction-reason">Reason</Label>
                <Textarea id="advisor-correction-reason" value={advisorReason} onChange={(event) => setAdvisorReason(event.target.value)} placeholder="Explain why this correction is needed" data-testid="input-advisor-correction-reason" />
              </div>
              {selectedAdvisorSession.corrections.length > 0 && (
                <div className="space-y-2 border-t pt-4">
                  <Label>Correction history</Label>
                  <div className="max-h-36 overflow-y-auto space-y-2">
                    {selectedAdvisorSession.corrections.map((correction) => (
                      <div key={correction.id} className="text-sm rounded-md bg-muted p-2">
                        <span className="font-medium">
                          {correction.action === "VOID"
                            ? "Voided"
                            : correction.action === "CREATE"
                              ? "Manual clock in"
                              : "Times edited"}
                        </span>
                        {" by "}{correction.changedByName} on {new Date(correction.createdAt).toLocaleString()}
                        <div className="text-muted-foreground">{correction.reason}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdvisorDialogOpen(false)}>Cancel</Button>
            <Button
              variant={advisorAction === "VOID" ? "destructive" : "default"}
              disabled={advisorCorrectionMutation.isPending || advisorReason.trim().length < 3 || (advisorAction === "EDIT" && !advisorCheckIn)}
              onClick={() => advisorCorrectionMutation.mutate()}
              data-testid="button-save-advisor-correction"
            >
              {advisorCorrectionMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {advisorAction === "VOID" ? "Void session" : "Save correction"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Photo Preview Dialog */}
      <Dialog open={!!photoPreviewUrls} onOpenChange={() => setPhotoPreviewUrls(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Image className="h-5 w-5" />
              PIN Authentication Photos
            </DialogTitle>
            <DialogDescription>
              {photoPreviewUrls && photoPreviewUrls.length > 1 
                ? `Photo ${currentPhotoIndex + 1} of ${photoPreviewUrls.length}`
                : "Photo captured during PIN fallback authentication"}
            </DialogDescription>
          </DialogHeader>
          {photoPreviewUrls && photoPreviewUrls[currentPhotoIndex] && (
            <div className="space-y-4">
              <div className="flex justify-center">
                <img
                  src={photoPreviewUrls[currentPhotoIndex]}
                  alt="PIN authentication evidence"
                  className="max-w-full max-h-96 rounded-lg border"
                />
              </div>
              {photoPreviewUrls.length > 1 && (
                <div className="flex justify-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPhotoIndex(Math.max(0, currentPhotoIndex - 1))}
                    disabled={currentPhotoIndex === 0}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPhotoIndex(Math.min(photoPreviewUrls.length - 1, currentPhotoIndex + 1))}
                    disabled={currentPhotoIndex === photoPreviewUrls.length - 1}
                  >
                    Next
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
