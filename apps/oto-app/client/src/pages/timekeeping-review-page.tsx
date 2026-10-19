import type { AttendanceEvidence } from "@shared/attendance-evidence";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { useBranchContext } from "@/hooks/use-branch-context";
import { formatDate } from "@/lib/format-utils";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { DatePicker } from "@/components/ui/date-picker";
import { 
  Clock, 
  AlertTriangle, 
  Search, 
  ArrowRight, 
  User,
  RefreshCw,
  Image,
  CheckCircle,
  XCircle,
  Loader2,
  Pencil,
  Trash2,
  ArrowLeft,
  CalendarDays,
  ShieldCheck,
  SlidersHorizontal
} from "lucide-react";
import { ClickableEmployeeAvatar } from "@/components/clickable-employee-avatar";
import { AttendanceTypeTabs } from "@/components/attendance-type-tabs";
import type { AttendanceTabKey, AttendanceTypeCounts, AttendanceTypeKey } from "@/components/attendance-type-tabs";
import { EmployeeAvatar } from "@/components/employee-avatar";
import TimeEventsPage from "./time-events-page";
import TimekeepingLivePage from "./timekeeping-live-page";

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
  userProposedClockInAt?: string | null;
  reasonCode?: string | null;
  note?: string | null;
  attachment?: Omit<AttendanceEvidence, "objectName"> | null;
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
  const signals = [
    summary.isScheduledNoShow && "No-show",
    summary.isMissingIn && "Forgot clock-in",
    summary.isOpenSession && "Still clocked in",
    summary.isLateArrival && `Late${summary.lateMinutes ? ` · ${summary.lateMinutes}m` : ""}`,
    summary.isLongShift && "Long day",
    summary.anomalies.includes("MULTIPLE_IN") && "Multiple clock-ins",
    summary.anomalies.includes("MULTIPLE_OUT") && "Multiple clock-outs",
  ].filter(Boolean) as string[];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {signals.length ? signals.map((signal) => (
        <span key={signal} className="inline-flex items-center rounded-full border border-[#dfc8a8] bg-[#fbf1e3] px-2.5 py-1 text-xs font-medium text-[#805329] dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">{signal}</span>
      )) : <span className="text-sm text-[#68746f] dark:text-muted-foreground">On track</span>}
      {summary.isOvernight && <span className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground">Overnight</span>}
      {summary.hasPinUsed && (
        summary.pinPhotoUrls?.length && onPinPhotoClick ? (
          <Button variant="outline" size="sm" className="h-8 rounded-full border-[#cbd7d1] px-2.5 text-xs text-[#35594d] dark:text-emerald-200" onClick={(event) => { event.stopPropagation(); onPinPhotoClick(summary.pinPhotoUrls); }} onKeyDown={(event) => event.stopPropagation()} data-testid={`button-pin-photo-${summary.employeeId}`}>
            <Image className="mr-1 h-3.5 w-3.5" /> PIN photo ({summary.pinPhotoUrls.length})
          </Button>
        ) : <span className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground">PIN</span>
      )}
    </div>
  );
}

function summaryAttendanceTypes(summary: EmployeeDaySummary): AttendanceTypeKey[] {
  const types = new Set<AttendanceTypeKey>();
  if (summary.isLateArrival || summary.anomalies.includes("LATE_ARRIVAL")) types.add("late");
  if (summary.anomalies.includes("EARLY_DEPARTURE") || summary.anomalies.includes("EARLY_LEAVE")) types.add("early-leave");
  if (summary.isMissingIn || summary.anomalies.includes("MISSING_PUNCH") || summary.anomalies.includes("MISSING_CLOCK_OUT")) types.add("missed-punch");
  if (summary.isScheduledNoShow || summary.anomalies.includes("SCHEDULED_NO_SHOW") || summary.anomalies.includes("NO_SHOW")) types.add("no-show");
  if (summary.anomalies.includes("OVERTIME")) types.add("overtime");
  if (summary.anomalies.includes("UNSCHEDULED_WORK")) types.add("unscheduled-shifts");
  if (summary.anomalies.includes("CLOCK_TIME_REQUEST")) types.add("clock-time-requests");
  if (summary.anomalies.includes("LEAVE_CONFLICT")) types.add("leave-conflicts");
  return Array.from(types);
}

function pendingIssueAttendanceType(issue: PendingIssue): AttendanceTypeKey | null {
  if (issue.issueType === "MISSING_CLOCK_IN") return "clock-time-requests";
  if (issue.issueType === "UNSCHEDULED_WORK") return "unscheduled-shifts";
  return null;
}

function TableSkeleton() {
  return (
    <div className="divide-y divide-[#e6e8df] dark:divide-border">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-5">
          <Skeleton className="h-10 w-10 rounded-full" />
          <Skeleton className="h-4 w-36" />
          <Skeleton className="ml-auto h-4 w-24" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div className="mx-auto max-w-sm px-5 py-16 text-center">
      <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-[#e5ece5] text-[#315d50] dark:bg-muted dark:text-foreground"><Clock className="h-6 w-6" /></div>
      <h3 className="text-lg font-semibold text-[#263d36] dark:text-foreground">{hasFilters ? "No matching attendance" : "No attendance yet"}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {hasFilters
          ? "Try another name or show everyone to see the full day."
          : "Attendance will appear here when there are records for this day."}
      </p>
    </div>
  );
}

export default function TimekeepingReviewPage() {
  const [location, navigate] = useLocation();
  const search = useSearch();
  const requestedTab = new URLSearchParams(search).get("tab");
  const activeZone: "issues" | "clock" | "live" = requestedTab === "clock" || requestedTab === "live" ? requestedTab : "issues";
  const selectZone = (zone: "issues" | "clock" | "live") => {
    const params = new URLSearchParams(search);
    params.set("tab", zone);
    navigate(`${location}?${params.toString()}`);
    setAdvisorDetail(null);
    setAdvancedOpen(false);
  };
  const returnDate = new URLSearchParams(search).get("date");
  const { selectedBranchId, isAllBranches } = useBranchContext();
  const { toast } = useToast();
  
  /**
   * Open on the day the link asked for, not on today.
   *
   * The dashboard's Timekeeping Issues tile links here as
   * `/timekeeping-review?date=<yesterday>&issuesOnly=true`, and the employee
   * page's back link carries the day it was opened on. The date picker still
   * moves freely from wherever it lands; this only decides where it lands.
   * The roster opens issues-only; `?issuesOnly=false` opens the full day.
   */
  const [date, setDate] = useState(() => returnDate && /^\d{4}-\d{2}-\d{2}$/.test(returnDate) ? returnDate : new Date().toISOString().split('T')[0]);
  const [issuesOnly, setIssuesOnly] = useState(() => new URLSearchParams(search).get("issuesOnly") !== "false");
  const [attendanceTypeTab, setAttendanceTypeTab] = useState<AttendanceTabKey>("all");
  const [authMethodFilter, setAuthMethodFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [advisorDetail, setAdvisorDetail] = useState<EmployeeDaySummary | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
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
  const { data: pendingIssuesData, isLoading: pendingLoading, isError: pendingError, refetch: refetchPending } = useQuery<PendingIssuesResponse>({
    queryKey: ["/api/timekeeping/pending-issues", branchParam],
    queryFn: async () => {
      const response = await fetch(pendingQueryUrl, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch pending issues");
      return response.json();
    },
    enabled: activeZone === "issues",
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
      queryClient.invalidateQueries({ queryKey: ["/api/sidebar/badges"] });
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
      'MISSING_CLOCK_IN': { label: 'Forgot clock-in', className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200' },
      'UNSCHEDULED_WORK': { label: 'Unscheduled work', className: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-200' },
    };
    return labels[type] || null;
  };
  
  const { data, isLoading, isError, refetch, isFetching } = useQuery<ReviewResponse>({
    queryKey: ["/api/timekeeping/review", date, branchParam, authMethodFilter, searchQuery],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("date", date);
      if (branchParam) params.set("branchId", branchParam);
      if (authMethodFilter !== "all") params.set("authMethod", authMethodFilter);
      if (searchQuery) params.set("search", searchQuery);
      
      const response = await fetch(`/api/timekeeping/review?${params.toString()}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch timekeeping data");
      return response.json();
    },
    enabled: activeZone === "issues",
  });

  const hasFilters = issuesOnly || authMethodFilter !== "all" || searchQuery.length > 0;
  const actionableIssues = (pendingIssuesData?.issues || []).filter((issue) =>
    issue.issueType === "MISSING_CLOCK_IN" || issue.issueType === "UNSCHEDULED_WORK"
  );
  const isProblem = (summary: EmployeeDaySummary) =>
    summary.isScheduledNoShow || summary.isMissingIn || summary.isOpenSession ||
    summary.isLateArrival || summary.isLongShift || summary.anomalies.length > 0;
  const allRoster = data?.summaries || [];
  const problemCount = allRoster.filter(isProblem).length;
  const attendanceTypeCounts = allRoster.reduce<AttendanceTypeCounts>((counts, summary) => {
    for (const type of summaryAttendanceTypes(summary)) counts[type] = (counts[type] ?? 0) + 1;
    return counts;
  }, {});
  for (const issue of actionableIssues) {
    const type = pendingIssueAttendanceType(issue);
    if (type) attendanceTypeCounts[type] = (attendanceTypeCounts[type] ?? 0) + 1;
  }
  const typeFilteredPendingIssues = attendanceTypeTab === "all"
    ? actionableIssues
    : actionableIssues.filter((issue) => pendingIssueAttendanceType(issue) === attendanceTypeTab);
  const showPendingSection = attendanceTypeTab === "all" || attendanceTypeTab === "unscheduled-shifts" || attendanceTypeTab === "clock-time-requests";
  const showRosterSection = attendanceTypeTab === "all" ||
    allRoster.some((summary) => summaryAttendanceTypes(summary).includes(attendanceTypeTab));
  const rosterForType = attendanceTypeTab === "all"
    ? allRoster.filter((summary) => !issuesOnly || isProblem(summary))
    : allRoster.filter((summary) => summaryAttendanceTypes(summary).includes(attendanceTypeTab));
  const roster = rosterForType.sort((a, b) =>
    Number(isProblem(b)) - Number(isProblem(a)) || a.employeeName.localeCompare(b.employeeName)
  );

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
      queryClient.invalidateQueries({ queryKey: ["/api/sidebar/badges"] });
      setAdvisorDialogOpen(false);
      setAdvisorDetail(null);
      setAdvancedOpen(false);
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
    <div className="min-h-[100dvh] bg-[#f4f5ef] px-4 py-7 text-[#263d36] dark:bg-background dark:text-foreground sm:px-6 lg:px-10 lg:py-10">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8 flex flex-col gap-5 border-b border-[#dce2d9] pb-7 dark:border-border sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-[#6c857a]"><span className="h-2 w-2 rounded-full bg-[#bc8d57]" /> OTO / Daily operations</div>
            <h1 className="text-3xl font-semibold tracking-[-0.045em] sm:text-4xl" data-testid="text-timekeeping-review-title">Today’s attendance</h1>
            <p className="mt-2 text-sm text-[#667770] dark:text-muted-foreground">Decisions, daily records, and the team on shift — in one place.</p>
          </div>
          {activeZone === "issues" && <Button variant="outline" className="w-fit border-[#ccd7ce] bg-transparent text-[#375449] hover:bg-[#e5ebe2] dark:text-foreground" onClick={() => { refetch(); refetchPending(); }} disabled={isFetching} data-testid="button-refresh">
            <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? "animate-spin" : ""}`} /> Refresh
          </Button>}
        </header>

        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex w-full flex-wrap gap-1.5 rounded-xl border border-[#d9e0d7] bg-[#e9eee7] p-1.5 dark:border-border dark:bg-card sm:w-fit" role="tablist" aria-label="Attendance sections">
            <button type="button" role="tab" aria-selected={activeZone === "issues"} onClick={() => selectZone("issues")} className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-none sm:px-4 ${activeZone === "issues" ? "bg-[#345b4d] text-[#f7f7f0] shadow-sm" : "text-[#52665d] hover:bg-[#dce6da] dark:text-muted-foreground dark:hover:bg-muted"}`} data-testid="tab-issues">
              Issues <span className={`rounded-full px-2 py-0.5 text-xs tabular-nums ${activeZone === "issues" ? "bg-[#ffffff33]" : "bg-[#d8e0d6] dark:bg-muted"}`}>{pendingLoading || pendingError ? "—" : actionableIssues.length}</span>
            </button>
            <button type="button" role="tab" aria-selected={activeZone === "clock"} onClick={() => selectZone("clock")} className={`min-h-11 flex-1 rounded-lg px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-none sm:px-4 ${activeZone === "clock" ? "bg-[#345b4d] text-[#f7f7f0] shadow-sm" : "text-[#52665d] hover:bg-[#dce6da] dark:text-muted-foreground dark:hover:bg-muted"}`} data-testid="tab-clock">Clock</button>
            <button type="button" role="tab" aria-selected={activeZone === "live"} onClick={() => selectZone("live")} className={`min-h-11 flex-1 rounded-lg px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-none sm:px-4 ${activeZone === "live" ? "bg-[#345b4d] text-[#f7f7f0] shadow-sm" : "text-[#52665d] hover:bg-[#dce6da] dark:text-muted-foreground dark:hover:bg-muted"}`} data-testid="tab-live">Who’s in now</button>
          </div>
          {activeZone === "issues" && <div className="flex items-center gap-2 text-sm text-[#64796d] dark:text-muted-foreground"><CalendarDays className="h-4 w-4" /> {formatDate(date)} roster · All pending dates {isAllBranches ? "· All branches" : ""}</div>}
        </div>

        {activeZone === "issues" ? (
          <div role="tabpanel" className="space-y-6">
          <AttendanceTypeTabs
            counts={attendanceTypeCounts}
            value={attendanceTypeTab}
            onChange={setAttendanceTypeTab}
          />
          {showPendingSection && <section className="overflow-hidden rounded-2xl border border-[#d9e1d7] bg-[#fcfcf7] shadow-[0_8px_32px_-24px_rgba(29,59,43,.25)] dark:border-border dark:bg-card">
            <div className="flex flex-col gap-3 border-b border-[#e6e8df] bg-[#f9f8f1] px-5 py-7 dark:border-border dark:bg-card sm:flex-row sm:items-end sm:justify-between sm:px-8">
              <div>
                <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.19em] text-[#ad7c47]">Decisions</p>
                <h2 className="text-2xl font-semibold tracking-[-0.035em] sm:text-[28px]"><span className="tabular-nums text-[#a7713f]">{pendingLoading || pendingError ? "—" : typeFilteredPendingIssues.length}</span> need approval</h2>
                <p className="mt-1 text-sm text-[#6c7970] dark:text-muted-foreground">Only missed clock-ins and unscheduled work appear here.</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => refetchPending()} className="w-fit text-[#486459]" data-testid="button-refresh-pending"><RefreshCw className="mr-2 h-4 w-4" /> Check again</Button>
            </div>
            {pendingLoading ? <TableSkeleton /> : pendingError ? (
              <div className="px-6 py-16 text-center"><AlertTriangle className="mx-auto mb-3 h-7 w-7 text-[#a7713f]" /><h3 className="font-semibold">Approvals could not be loaded</h3><p className="mt-1 text-sm text-muted-foreground">Please try again before making a decision.</p><Button variant="outline" className="mt-5" onClick={() => refetchPending()}>Try again</Button></div>
            ) : typeFilteredPendingIssues.length === 0 ? (
              <div className="px-6 py-12 text-center"><div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-[#e9eee7] text-[#3c6b55]"><ShieldCheck className="h-7 w-7" /></div><h3 className="text-lg font-semibold">All caught up</h3><p className="mt-2 text-sm text-muted-foreground">No clock-ins or unscheduled work are waiting for a decision. The day roster is below.</p></div>
            ) : (
              <div className="divide-y divide-[#e9ebe3] dark:divide-border">
                {typeFilteredPendingIssues.map((issue) => (
                  <article key={issue.id} className="flex flex-col gap-5 px-5 py-5 transition-colors hover:bg-[#f8faf5] dark:hover:bg-muted/30 sm:px-8 lg:flex-row lg:items-center lg:justify-between" data-testid={`row-pending-issue-${issue.id}`}>
                    <div className="flex min-w-0 items-start gap-3.5">
                      <ClickableEmployeeAvatar employeeId={issue.employeeId} fullName={issue.employeeName} profilePhotoPath={issue.employeePhotoPath} size="sm" />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{issue.employeeName}</h3><Badge variant="secondary" className="border border-[#e5cfaf] bg-[#fbf0dd] text-[#805329] dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200" data-testid={`badge-issue-type-${issue.id}`}>{getIssueTypeLabel(issue.issueType)?.label}</Badge></div>
                        <p className="mt-1 text-sm text-[#64746b] dark:text-muted-foreground">{issue.branchName ? `${issue.branchName} · ` : ""}{formatDate(issue.issueDate)} · {issue.issueType === "UNSCHEDULED_WORK" ? "Clock-in" : "Requested clock-in"} {formatTime(issue.userProposedClockInAt || null)}</p>
                        <p className="mt-1 text-sm text-[#475b50] dark:text-muted-foreground">{getReasonLabel(issue.reasonCode)}{issue.note ? ` · “${issue.note}”` : ""}</p>
                        {issue.attachment && (
                          <a href={`/api/timekeeping/issues/${encodeURIComponent(issue.id)}/attachment`} target="_blank" rel="noreferrer" className="mt-1 inline-block break-all text-sm underline underline-offset-2" data-testid={`attachment-${issue.id}`}>
                            View attachment: {issue.attachment.fileName}
                          </a>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2 pl-[50px] lg:pl-0">
                      <Button size="sm" className="bg-[#345b4d] text-[#f8faf4] hover:bg-[#244638]" aria-label={`Approve ${issue.employeeName}'s time entry`} onClick={() => openResolveDialog(issue, "approve")} data-testid={`button-approve-${issue.id}`}><CheckCircle className="mr-1.5 h-4 w-4" /> Approve</Button>
                      <Button size="sm" variant="outline" className="border-[#d5dcd1] bg-transparent text-[#6f5149] hover:bg-[#f7ede7]" aria-label={`Reject ${issue.employeeName}'s time entry`} onClick={() => openResolveDialog(issue, "reject")} data-testid={`button-reject-${issue.id}`}><XCircle className="mr-1.5 h-4 w-4" /> Reject</Button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>}
          {showRosterSection && <section className="space-y-5">
            <div className="flex flex-col gap-5 rounded-2xl border border-[#d9e1d7] bg-[#fcfcf7] p-5 dark:border-border dark:bg-card sm:p-7">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                <div><p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.19em] text-[#749083]">Daily roster</p><h2 className="text-2xl font-semibold tracking-[-0.035em]">Today’s attendance</h2><p className="mt-1 text-sm text-[#68786e] dark:text-muted-foreground">Problems first, with the rest of the day close at hand.</p></div>
                <div className="flex gap-4 text-sm text-[#65766d] dark:text-muted-foreground"><span><strong className="text-lg font-semibold tabular-nums text-[#345b4d] dark:text-foreground" data-testid="text-total-employees">{data?.totalEmployees ?? "—"}</strong> people</span><span><strong className="text-lg font-semibold tabular-nums text-[#a7713f]" data-testid="text-issues-count">{data ? problemCount : "—"}</strong> with issues</span><span className="sr-only" data-testid="text-long-shifts-count">{data?.longShiftsCount ?? "—"}</span></div>
              </div>
              <div className="grid gap-3 border-t border-[#e6eae1] pt-5 dark:border-border sm:grid-cols-[180px_minmax(0,1fr)_160px]">
                <div><Label className="mb-1.5 block text-xs font-medium text-[#607269]">Date</Label><DatePicker value={date} onChange={setDate} data-testid="input-date" /></div>
                <div><Label htmlFor="roster-search" className="mb-1.5 block text-xs font-medium text-[#607269]">Find a person</Label><div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input id="roster-search" placeholder="Search by name" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9" data-testid="input-search" /></div></div>
                <div><Label className="mb-1.5 block text-xs font-medium text-[#607269]">Clocked in with</Label><Select value={authMethodFilter} onValueChange={setAuthMethodFilter}><SelectTrigger data-testid="select-auth-method"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Face / PIN</SelectItem><SelectItem value="PIN">PIN</SelectItem><SelectItem value="FACE">Face</SelectItem></SelectContent></Select></div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Button variant="outline" size="sm" onClick={() => setIssuesOnly(!issuesOnly)} className="border-[#cddbd0] bg-[#edf3eb] text-[#315b49] hover:bg-[#e2eee2] dark:bg-muted dark:text-foreground" data-testid="switch-issues-only"><SlidersHorizontal className="mr-2 h-4 w-4" /> {issuesOnly ? "Show everyone" : "Show issues"}</Button>
                <span className="text-xs text-[#78867a]">{issuesOnly ? "Showing people with attendance issues" : "Showing the full day roster"}</span>
              </div>
            </div>
            {advisorDetail ? (
              <div className="overflow-hidden rounded-2xl border border-[#d9e1d7] bg-[#fcfcf7] dark:border-border dark:bg-card">
                <div className="border-b border-[#e6eae1] p-5 dark:border-border sm:p-7">
                  <Button variant="ghost" size="sm" className="mb-4 -ml-2 text-[#456558]" onClick={() => { setAdvisorDetail(null); setAdvancedOpen(false); }}><ArrowLeft className="mr-2 h-4 w-4" /> Back to roster</Button>
                  <div className="flex items-start gap-4"><div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#e4ebe3]"><User className="h-5 w-5" /></div><div><p className="text-xs font-bold uppercase tracking-widest text-[#718b7b]">Advisor attendance</p><h3 className="mt-1 text-2xl font-semibold">{advisorDetail.employeeName}</h3><p className="mt-1 text-sm text-muted-foreground">{advisorDetail.branchName || "Branch not listed"} · {formatDate(date)}</p></div></div>
                </div>
                <div className="grid gap-5 p-5 sm:grid-cols-3 sm:p-7"><div><p className="text-xs text-muted-foreground">First clock-in</p><p className="mt-1 text-xl font-semibold tabular-nums">{formatTime(advisorDetail.firstInTime)}</p></div><div><p className="text-xs text-muted-foreground">Last clock-out</p><p className="mt-1 text-xl font-semibold tabular-nums">{formatTime(advisorDetail.lastOutTime)}</p></div><div><p className="text-xs text-muted-foreground">Total time</p><p className="mt-1 text-xl font-semibold tabular-nums">{advisorDetail.totalHours > 0 ? formatHours(advisorDetail.totalHours) : "—"}</p></div></div>
                <div className="border-t border-[#e6eae1] px-5 py-5 dark:border-border sm:px-7"><StatusBadges summary={advisorDetail} onPinPhotoClick={(urls) => { setPhotoPreviewUrls(urls); setCurrentPhotoIndex(0); }} /></div>
                <div className="border-t border-[#e6eae1] px-5 py-5 dark:border-border sm:px-7"><h4 className="mb-3 text-sm font-semibold">Sessions</h4>{advisorDetail.advisorSessions?.length ? <div className="space-y-2">{advisorDetail.advisorSessions.map((session) => <div key={session.id} className="flex flex-wrap justify-between gap-2 rounded-lg bg-[#f1f4ec] px-4 py-3 text-sm dark:bg-muted"><span className="tabular-nums">{formatTime(session.checkInAt)} – {formatTime(session.checkOutAt)}</span><span className="text-muted-foreground">{session.durationMinutes !== null ? formatHours(session.durationMinutes / 60) : "Still clocked in"}{session.isOvernight ? " · Overnight" : ""}</span></div>)}</div> : <p className="text-sm text-muted-foreground">No sessions recorded for this day.</p>}</div>
                <div className="border-t border-[#e6eae1] px-5 py-5 dark:border-border sm:px-7"><Button variant="ghost" size="sm" className="-ml-3 text-muted-foreground" onClick={() => setAdvancedOpen(!advancedOpen)} aria-expanded={advancedOpen}>Advanced {advancedOpen ? "−" : "+"}</Button>{advancedOpen && <div className="mt-3 rounded-lg border border-[#e3e8df] bg-[#f7f8f3] p-4 dark:border-border dark:bg-muted/30"><p className="mb-3 text-sm text-muted-foreground">Changes to advisor sessions require a reason and are recorded.</p><Button variant="outline" size="sm" disabled={!advisorDetail.advisorSessions?.length} onClick={() => openAdvisorDialog(advisorDetail)} data-testid={`button-correct-advisor-${advisorDetail.employeeId}`}><Pencil className="mr-2 h-4 w-4" /> Edit or void session</Button></div>}</div>
              </div>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-[#d9e1d7] bg-[#fcfcf7] dark:border-border dark:bg-card">
                {isLoading ? <TableSkeleton /> : isError ? <div className="px-6 py-16 text-center"><AlertTriangle className="mx-auto mb-3 h-7 w-7 text-[#a7713f]" /><h3 className="font-semibold">Attendance could not be loaded</h3><p className="mt-1 text-sm text-muted-foreground">Please try again to see the roster.</p><Button variant="outline" className="mt-5" onClick={() => refetch()}>Try again</Button></div> : !roster.length ? <EmptyState hasFilters={hasFilters} /> : (
                  <>
                    <div className="hidden grid-cols-[minmax(210px,1.6fr)_100px_100px_90px_minmax(200px,1.4fr)_22px] gap-4 border-b border-[#e7ebe2] bg-[#f8f9f4] px-6 py-3 text-[11px] font-bold uppercase tracking-[0.12em] text-[#839087] dark:border-border dark:bg-muted/30 lg:grid"><span>Person</span><span>First in</span><span>Last out</span><span>Hours</span><span>What to know</span><span /></div>
                    <div className="divide-y divide-[#e9ebe4] dark:divide-border">{roster.map((summary) => (
                      <div key={`${summary.identityType || "EMPLOYEE"}:${summary.employeeId}:${summary.branchId || "no-branch"}`} role="link" tabIndex={0} onClick={() => summary.identityType === "ADVISOR" ? (setAdvisorDetail(summary), setAdvancedOpen(false)) : navigate(`/timekeeping-review/employee/${summary.employeeId}?date=${encodeURIComponent(date)}`)} onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) { event.preventDefault(); summary.identityType === "ADVISOR" ? (setAdvisorDetail(summary), setAdvancedOpen(false)) : navigate(`/timekeeping-review/employee/${summary.employeeId}?date=${encodeURIComponent(date)}`); } }} className="group relative grid cursor-pointer gap-3 py-5 pl-5 pr-12 transition-colors hover:bg-[#f4f8f0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#49715c] dark:hover:bg-muted/30 lg:grid-cols-[minmax(210px,1.6fr)_100px_100px_90px_minmax(200px,1.4fr)_22px] lg:items-center lg:gap-4 lg:px-6" aria-label={summary.identityType === "ADVISOR" ? `Open ${summary.employeeName}'s advisor attendance` : `View details for ${summary.employeeName}`} data-testid={`row-employee-${summary.employeeId}`}>
                        <div className="flex min-w-0 items-center gap-3">{summary.identityType === "ADVISOR" ? <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#e4ebe3]"><User className="h-4 w-4" /></div> : <EmployeeAvatar employeeId={summary.employeeId} fullName={summary.employeeName} profilePhotoPath={summary.profilePhotoPath} size="sm" />}<div className="min-w-0"><p className="truncate font-semibold">{summary.employeeName}</p><p className="truncate text-xs text-[#7b897d]">{summary.identityType === "ADVISOR" ? "Advisor" : summary.branchName || (isAllBranches ? "Branch not listed" : "Employee")}</p></div></div>
                        <div className="flex gap-2 text-sm tabular-nums lg:block"><span className="text-muted-foreground lg:hidden">In</span>{formatTime(summary.firstInTime)}</div>
                        <div className="flex gap-2 text-sm tabular-nums lg:block"><span className="text-muted-foreground lg:hidden">Out</span>{formatTime(summary.lastOutTime)}</div>
                        <div className="flex gap-2 text-sm font-medium tabular-nums lg:block"><span className="text-muted-foreground lg:hidden">Total</span>{summary.totalHours > 0 ? formatHours(summary.totalHours) : "—"}</div>
                        <StatusBadges summary={summary} onPinPhotoClick={(urls) => { setPhotoPreviewUrls(urls); setCurrentPhotoIndex(0); }} />
                        <ArrowRight aria-hidden="true" className="absolute right-5 top-6 h-4 w-4 text-[#9aa99c] transition-transform group-hover:translate-x-1 lg:static" />
                        {summary.identityType !== "ADVISOR" && <span className="sr-only" data-testid={`button-view-${summary.employeeId}`}>View details</span>}
                      </div>
                    ))}</div>
                  </>
                )}
              </div>
            )}
          </section>}
          </div>
        ) : activeZone === "clock" ? (
          <div role="tabpanel" aria-label="Clock events"><TimeEventsPage embedded /></div>
        ) : (
          <div role="tabpanel" aria-label="Who’s in now"><TimekeepingLivePage embedded /></div>
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
                      ? `Approve ${selectedIssue.employeeName}'s unscheduled work clock-in at ${selectedIssue.userProposedClockInAt ? formatTime(selectedIssue.userProposedClockInAt) : '-'} for ${formatDate(selectedIssue.issueDate)}?`
                      : `Approve ${selectedIssue.employeeName}'s clock-in time of ${selectedIssue.userProposedClockInAt ? formatTime(selectedIssue.userProposedClockInAt) : '-'} for ${formatDate(selectedIssue.issueDate)}?`
                    : selectedIssue.issueType === 'UNSCHEDULED_WORK'
                      ? `Reject ${selectedIssue.employeeName}'s unscheduled work entry?`
                      : `Reject ${selectedIssue.employeeName}'s requested time correction?`
                  }
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          
          <DialogBody className="space-y-4">
            {selectedIssue && (
              <div className="bg-muted p-3 rounded-lg text-sm space-y-1">
                <p><span className="text-muted-foreground">Employee:</span> {selectedIssue.employeeName}</p>
                <p><span className="text-muted-foreground">Date:</span> {formatDate(selectedIssue.issueDate)}</p>
                {selectedIssue.issueType === 'UNSCHEDULED_WORK' && (
                  <p><span className="text-muted-foreground">Type:</span> <span className="text-orange-600 font-medium">Unscheduled Work</span></p>
                )}
                <p><span className="text-muted-foreground">{selectedIssue.issueType === 'UNSCHEDULED_WORK' ? 'Clock-in time:' : 'Requested time:'}</span> {selectedIssue.userProposedClockInAt ? formatTime(selectedIssue.userProposedClockInAt) : '-'}</p>
                <p><span className="text-muted-foreground">Reason:</span> {getReasonLabel(selectedIssue.reasonCode)}</p>
                {selectedIssue.attachment && (
                  <a href={`/api/timekeeping/issues/${encodeURIComponent(selectedIssue.id)}/attachment`} target="_blank" rel="noreferrer" className="block break-all underline">
                    View attachment: {selectedIssue.attachment.fileName}
                  </a>
                )}
                {selectedIssue.note && (
                  <p><span className="text-muted-foreground">Note:</span> {selectedIssue.note}</p>
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
          </DialogBody>
          
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

      <Dialog open={advisorDialogOpen} onOpenChange={setAdvisorDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Correct Advisor attendance</DialogTitle>
            <DialogDescription>
              Edit or void {selectedAdvisor?.employeeName}'s attendance. A reason is required and the change will be audited.
            </DialogDescription>
          </DialogHeader>
          {selectedAdvisorSession && (
            <DialogBody className="space-y-4">
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
              <div className="flex flex-wrap gap-2">
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
            </DialogBody>
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
              PIN photo evidence
            </DialogTitle>
            <DialogDescription>
              {photoPreviewUrls && photoPreviewUrls.length > 1 
                ? `Photo ${currentPhotoIndex + 1} of ${photoPreviewUrls.length}`
                : "Photo captured when PIN was used to clock in or out"}
            </DialogDescription>
          </DialogHeader>
          {photoPreviewUrls && photoPreviewUrls[currentPhotoIndex] && (
            <DialogBody className="space-y-4">
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
            </DialogBody>
          )}
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
}
