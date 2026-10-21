import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useSearch, Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { formatDate } from "@/lib/format-utils";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  ArrowLeft, 
  Clock, 
  AlertTriangle, 
  AlertCircle, 
  UserCheck,
  Plus,
  CheckCircle,
  Image,
  CalendarDays,
  ChevronDown
} from "lucide-react";
import { DatePicker } from "@/components/ui/date-picker";
import { ClickableEmployeeAvatar } from "@/components/clickable-employee-avatar";
import { isAdminRole } from "@shared/permissions";

interface TimekeepingSession {
  id: string;
  employeeId: string;
  inEvent: any;
  outEvent: any | null;
  durationMinutes: number | null;
  date: string;
  inBranchName: string;
  outBranchName: string | null;
}

interface TimekeepingAnomaly {
  id: string;
  employeeId: string;
  type: string;
  description: string;
  relatedEventIds: string[];
  date: string;
  severity: string;
}

interface DailyTotal {
  date: string;
  totalMinutes: number;
  totalHours: number;
  sessionCount: number;
  hasLongShift: boolean;
}

interface EmployeeDetailResponse {
  employee: {
    id: string;
    fullName: string;
    branchId: string | null;
    branchName: string | null;
    hasFaceEnrolled: boolean;
    profilePhotoPath?: string | null;
  };
  dateRange: {
    start: string;
    end: string;
  };
  sessions: TimekeepingSession[];
  rawEvents: any[];
  dailyTotals: DailyTotal[];
  anomalies: TimekeepingAnomaly[];
  stats: {
    totalHours: number;
    totalSessions: number;
    totalAnomalies: number;
    pinUsageCount: number;
    faceUsageCount: number;
  };
}

interface LeaveBalancesResponse {
  year: number;
  balances: Array<{
    leaveTypeId: string;
    code: string;
    name: string;
    earned: number;
    used: number;
    balance: number;
    canClaim: boolean;
    isActive: boolean;
  }>;
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  return `${formatDate(date.toISOString())} ${date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

function formatDuration(minutes: number | null): string {
  if (minutes === null) return "-";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m}m`;
}

function formatHours(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}h ${m}m`;
}

function authMethodLabel(method: unknown): string {
  switch (method) {
    case "FACE": return "Face";
    case "PIN": return "PIN";
    case "PHONE_FALLBACK": return "Phone";
    case "ADMIN_OVERRIDE": return "Override";
    default: return typeof method === "string" && method ? method : "Unknown";
  }
}

/**
 * One side of a shift's clock method: every method the server records gets its
 * own label (Phone and Override alongside PIN and Face), and any event that
 * carries photo evidence opens it, whatever method took it.
 */
function SessionAuthMethod({ event, direction, onPhotoClick }: {
  event: { authMethod?: string; photoEvidenceUrl?: string | null } | null;
  direction: "In" | "Out";
  onPhotoClick: (url: string) => void;
}) {
  if (!event) return null;
  const label = `${direction}: ${authMethodLabel(event.authMethod)}`;
  return event.photoEvidenceUrl ? (
    <Button variant="outline" size="sm" className="h-8 gap-1 text-xs" onClick={() => onPhotoClick(event.photoEvidenceUrl!)} aria-label={`View ${label} photo`}>
      <Image className="h-3 w-3" /> {label} · View photo
    </Button>
  ) : <Badge variant="outline" className="font-normal">{label}</Badge>;
}

function issueExplanation(issue: TimekeepingAnomaly): string {
  switch (issue.type) {
    case "OPEN_SESSION": return "No clock-out recorded yet.";
    case "MISSING_IN": return "A clock-out was recorded without an earlier clock-in.";
    case "MULTIPLE_IN": return "More than one clock-in was recorded before a clock-out.";
    case "MULTIPLE_OUT": return "More than one clock-out was recorded without a clock-in.";
    case "LONG_SHIFT": return "This day's recorded hours exceed nine hours.";
    default: return issue.description;
  }
}

function AnomalyBadge({ type }: { type: string }) {
  const configs: Record<string, { label: string; variant: "destructive" | "secondary" | "default"; icon: any }> = {
    OPEN_SESSION: { label: "Still clocked in", variant: "destructive", icon: AlertCircle },
    MISSING_IN: { label: "Forgot clock-in", variant: "destructive", icon: AlertTriangle },
    MULTIPLE_IN: { label: "Repeated clock-in", variant: "secondary", icon: AlertTriangle },
    MULTIPLE_OUT: { label: "Repeated clock-out", variant: "secondary", icon: AlertTriangle },
    LONG_SHIFT: { label: "Long day", variant: "secondary", icon: Clock },
    SCHEDULED_NO_SHOW: { label: "No-show", variant: "destructive", icon: AlertTriangle },
    LATE_ARRIVAL: { label: "Late", variant: "secondary", icon: Clock },
  };
  
  const config = configs[type] || { label: type, variant: "secondary", icon: AlertCircle };
  const Icon = config.icon;
  
  return (
    <Badge variant={config.variant} className="text-xs">
      <Icon className="h-3 w-3 mr-1" />
      {config.label}
    </Badge>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="flex items-center gap-4 p-4 border rounded-md">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

function AddOverrideDialog({ employeeId, branches, onSuccess }: { employeeId: string; branches: any[]; onSuccess: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [eventType, setEventType] = useState<"IN" | "OUT">("IN");
  const [branchId, setBranchId] = useState("");
  const [eventDate, setEventDate] = useState(new Date().toISOString().split('T')[0]);
  const [eventTime, setEventTime] = useState("09:00");
  const [notes, setNotes] = useState("");

  const overrideMutation = useMutation({
    mutationFn: async (data: any) => {
      return apiRequest("POST", "/api/time-events/override", data);
    },
    onSuccess: () => {
      toast({ title: "Override added", description: "The time event has been added successfully." });
      setOpen(false);
      onSuccess();
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message || "Failed to add override", variant: "destructive" });
    },
  });

  const handleSubmit = () => {
    if (!branchId) {
      toast({ title: "Error", description: "Please select a branch", variant: "destructive" });
      return;
    }

    const eventDateTime = new Date(`${eventDate}T${eventTime}:00+07:00`);
    
    overrideMutation.mutate({
      employeeId,
      branchId,
      eventType,
      eventTime: eventDateTime.toISOString(),
      notes: notes || undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="button-add-override">
          <Plus className="h-4 w-4 mr-2" />
          Add Missed Clock
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Missed Clock Event</DialogTitle>
          <DialogDescription>
            Add a missed clock-in or clock-out for this employee.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="space-y-2">
            <Label>Event Type</Label>
            <Select value={eventType} onValueChange={(v) => setEventType(v as "IN" | "OUT")}>
              <SelectTrigger data-testid="select-event-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="IN">Clock IN</SelectItem>
                <SelectItem value="OUT">Clock OUT</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Branch</Label>
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger data-testid="select-branch">
                <SelectValue placeholder="Select branch" />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b: any) => (
                  <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Date</Label>
              <DatePicker
                value={eventDate}
                onChange={setEventDate}
                data-testid="input-event-date"
              />
            </div>
            <div className="space-y-2">
              <Label>Time</Label>
              <Input 
                type="time" 
                value={eventTime} 
                onChange={(e) => setEventTime(e.target.value)}
                data-testid="input-event-time"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Notes (Optional)</Label>
            <Textarea 
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Reason for adding this override..."
              data-testid="input-notes"
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={overrideMutation.isPending} data-testid="button-submit-override">
            {overrideMutation.isPending ? "Adding..." : "Add Event"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function TimekeepingEmployeeDetailPage() {
  const { employeeId } = useParams<{ employeeId: string }>();
  const selectedDate = new URLSearchParams(useSearch()).get("date");
  const reviewHref = selectedDate && /^\d{4}-\d{2}-\d{2}$/.test(selectedDate)
    ? `/timekeeping-review?tab=issues&date=${encodeURIComponent(selectedDate)}`
    : "/timekeeping-review";
  const { user } = useAuth();
  const isAdmin = isAdminRole(user?.role);

  const [startDate, setStartDate] = useState(() => {
    if (selectedDate && /^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) return selectedDate;
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split('T')[0];
  });
  const [endDate, setEndDate] = useState(() => selectedDate && /^\d{4}-\d{2}-\d{2}$/.test(selectedDate) ? selectedDate : new Date().toISOString().split('T')[0]);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery<EmployeeDetailResponse>({
    queryKey: ["/api/timekeeping/employee", employeeId, startDate, endDate],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("startDate", startDate);
      params.set("endDate", endDate);
      
      const response = await fetch(`/api/timekeeping/employee/${employeeId}?${params.toString()}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch employee timekeeping data");
      return response.json();
    },
    enabled: !!employeeId,
  });

  const { data: branchesData } = useQuery<any[]>({
    queryKey: ["/api/branches"],
    enabled: isAdmin,
  });

  const leaveQuery = useQuery<LeaveBalancesResponse>({
    queryKey: [`/api/employees/${employeeId}/leave-balances-dynamic`],
    enabled: !!employeeId,
  });

  const dates = data ? Array.from(new Set([
    ...data.sessions.map((session) => session.date.slice(0, 10)),
    ...data.dailyTotals.map((total) => total.date.slice(0, 10)),
    ...data.anomalies.map((anomaly) => anomaly.date.slice(0, 10)),
  ])).sort((a, b) => b.localeCompare(a)) : [];

  if (isLoading) {
    return (
      <div className="p-6 max-w-7xl mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-8 w-48" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-6">
                <Skeleton className="h-16 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
        <Card>
          <CardContent className="pt-6">
            <TableSkeleton />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <main className="mx-auto max-w-5xl p-4 sm:p-6">
        <Link href={reviewHref} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to Today’s attendance
        </Link>
        <Card className="mt-8 border-destructive/30">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <AlertCircle className="h-8 w-8 text-destructive" />
            <h1 className="text-xl font-semibold">Attendance could not be loaded</h1>
            <p className="text-sm text-muted-foreground">Please try again. The time records have not been changed.</p>
            <Button variant="outline" onClick={() => refetch()}>Try again</Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 pb-16 sm:p-6 lg:p-8">
      <div className="space-y-5 border-b pb-6">
        <Link href={reviewHref} className="inline-flex min-h-10 items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground" data-testid="button-back">
          <ArrowLeft className="h-4 w-4" /> Today’s attendance
        </Link>
        <div className="flex items-center gap-4 sm:gap-5">
          {data?.employee && (
            <ClickableEmployeeAvatar
              employeeId={data.employee.id}
              fullName={data.employee.fullName}
              profilePhotoPath={data.employee.profilePhotoPath}
              size="lg"
            />
          )}
          <div className="min-w-0">
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Attendance story</p>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl" data-testid="text-employee-name">
              {data?.employee?.fullName || "Employee"}
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>{data?.employee?.branchName || "Branch not listed"}</span>
              {data?.employee?.hasFaceEnrolled && (
                <Badge variant="outline">
                  <UserCheck className="h-3 w-3 mr-1" />
                  Face ready
                </Badge>
              )}
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-5 rounded-xl border bg-muted/25 p-4 sm:p-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">In this period</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{formatHours(data.stats.totalHours || 0)} <span className="text-sm font-normal text-muted-foreground">worked</span></p>
          <p className="mt-1 text-sm text-muted-foreground">{data.stats.totalSessions} {data.stats.totalSessions === 1 ? "shift" : "shifts"} recorded · {data.stats.totalAnomalies} {data.stats.totalAnomalies === 1 ? "item" : "items"} to review</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-2">
              <Label>From</Label>
              <DatePicker
                value={startDate}
                onChange={setStartDate}
                data-testid="input-start-date"
              />
            </div>
            <div className="space-y-2">
              <Label>To</Label>
              <DatePicker
                value={endDate}
                onChange={setEndDate}
                data-testid="input-end-date"
              />
            </div>
        </div>
      </div>

      <section aria-labelledby="daily-attendance">
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <div>
            <h2 id="daily-attendance" className="text-xl font-semibold tracking-tight">Day by day</h2>
            <p className="mt-1 text-sm text-muted-foreground">Clock-ins, clock-outs and anything that needs a closer look.</p>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">{dates.length} {dates.length === 1 ? "day" : "days"}</span>
        </div>
        {!dates.length ? (
          <Card><CardContent className="flex flex-col items-center py-12 text-center">
            <CalendarDays className="mb-3 h-8 w-8 text-muted-foreground" />
            <p className="font-medium">No attendance in this period</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">Try a different date range to see clock activity and scheduled no-shows.</p>
          </CardContent></Card>
        ) : (
          <div className="space-y-3">
            {dates.map((date) => {
              const sessions = data.sessions.filter((session) => session.date.slice(0, 10) === date);
              const issues = data.anomalies.filter((anomaly) => anomaly.date.slice(0, 10) === date);
              const total = data.dailyTotals.find((item) => item.date.slice(0, 10) === date);
              const hasNoShow = issues.some((issue) => issue.type === "SCHEDULED_NO_SHOW");
              return (
                <Card key={date} className={issues.length ? "border-amber-500/35" : ""}>
                  <CardContent className="p-4 sm:p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
                      <div>
                        <h3 className="font-semibold">{formatDate(date)}</h3>
                        <p className="mt-0.5 text-xs text-muted-foreground">{sessions.length ? `${sessions.length} ${sessions.length === 1 ? "shift" : "shifts"}` : hasNoShow ? "Scheduled shift · no clock-in" : "Attendance record"}</p>
                      </div>
                      {total?.totalMinutes != null && total.totalMinutes > 0 && <p className="font-semibold tabular-nums">{formatDuration(total.totalMinutes)} <span className="text-xs font-normal text-muted-foreground">worked</span></p>}
                    </div>
                    <div className="space-y-4 pt-4">
                      {sessions.map((session) => (
                        <div key={session.id} className="space-y-2" data-testid={`row-session-${session.id}`}>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                            <span className="text-lg font-medium tabular-nums">{formatTime(session.inEvent?.eventTime)} <span className="text-muted-foreground">→</span> {session.outEvent ? formatTime(session.outEvent.eventTime) : "—"}</span>
                            {!session.outEvent && <Badge variant="destructive" className="text-xs">Still clocked in</Badge>}
                            {session.durationMinutes != null && <span className="text-sm text-muted-foreground">{formatDuration(session.durationMinutes)}</span>}
                          </div>
                          <p className="text-xs text-muted-foreground">{session.inBranchName}{session.outBranchName && session.outBranchName !== session.inBranchName ? ` → ${session.outBranchName}` : ""}</p>
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <SessionAuthMethod event={session.inEvent} direction="In" onPhotoClick={setPhotoPreviewUrl} />
                            <SessionAuthMethod event={session.outEvent} direction="Out" onPhotoClick={setPhotoPreviewUrl} />
                          </div>
                        </div>
                      ))}
                      {issues.length > 0 && <div className="space-y-2 border-t pt-3">
                        {issues.map((issue) => (
                          <div key={issue.id} className="flex flex-wrap items-start gap-2">
                            <AnomalyBadge type={issue.type} />
                            {issue.type === "SCHEDULED_NO_SHOW" && issue.description.match(/^Scheduled for (.+?) but/) ? (
                              <p className="text-sm text-muted-foreground">Scheduled {issue.description.match(/^Scheduled for (.+?) but/)![1]} · No clock-in recorded. <Link href="/scheduling" className="font-medium text-foreground underline underline-offset-2">View schedule</Link></p>
                            ) : <p className="text-sm text-muted-foreground">{issueExplanation(issue)}</p>}
                          </div>
                        ))}
                      </div>}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Leave balances</CardTitle>
          <CardDescription>Available leave for {leaveQuery.data?.year ?? "the current year"} · separate from attendance.</CardDescription>
        </CardHeader>
        <CardContent>
          {leaveQuery.isLoading ? <div className="space-y-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
            : leaveQuery.isError ? <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground"><p>Leave balances are unavailable right now. No balance is shown until it can be confirmed.</p><Button variant="outline" size="sm" onClick={() => leaveQuery.refetch()}>Try again</Button></div>
            : !leaveQuery.data?.balances?.length ? <p className="text-sm text-muted-foreground">No leave balances are configured for this employee.</p>
            : <div className="divide-y">{leaveQuery.data.balances.map((balance) => (
              <div key={balance.leaveTypeId} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0" data-testid={`leave-balance-${balance.code}`}>
                <div><p className="font-medium">{balance.name}</p><p className="text-xs text-muted-foreground">{!balance.isActive ? "Not active" : !balance.canClaim ? "Not yet available to claim" : `${balance.earned} earned · ${balance.used} used`}</p></div>
                <p className="text-right font-semibold tabular-nums">{balance.isActive ? `${balance.balance} days` : "—"}<span className="block text-xs font-normal text-muted-foreground">Balance</span></p>
              </div>
            ))}</div>}
        </CardContent>
      </Card>

      <details className="group rounded-xl border bg-card">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 font-medium marker:hidden sm:p-5">
          <span>Advanced <span className="ml-2 text-sm font-normal text-muted-foreground">Corrections and event details</span></span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <div className="space-y-5 border-t p-4 sm:p-5">
          {isAdmin && branchesData && (
            <AddOverrideDialog
              employeeId={employeeId!}
              branches={branchesData}
              onSuccess={() => {
                queryClient.invalidateQueries({ queryKey: ["/api/timekeeping/employee", employeeId] });
                refetch();
              }}
            />
          )}
          <div className="grid gap-3 rounded-lg bg-muted/40 p-4 text-sm sm:grid-cols-2">
            <p>Face events: <strong>{data.stats.faceUsageCount}</strong></p>
            <p>PIN events: <strong>{data.stats.pinUsageCount}</strong></p>
          </div>
          <Tabs defaultValue="events">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="events" data-testid="tab-events">Raw events ({data.rawEvents.length})</TabsTrigger>
              <TabsTrigger value="anomalies" data-testid="tab-anomalies">Issue details ({data.anomalies.length})</TabsTrigger>
            </TabsList>

            <TabsContent value="events" className="mt-4 overflow-x-auto">
              {!data?.rawEvents?.length ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Clock className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No events found for this period</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date/Time</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Branch</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead>Confidence</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Photo</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.rawEvents.map((event: any) => (
                      <TableRow key={event.id} data-testid={`row-event-${event.id}`}>
                        <TableCell>{formatDateTime(event.eventTime)}</TableCell>
                        <TableCell>
                          <Badge variant={event.eventType === "IN" ? "default" : "secondary"}>
                            {event.eventType}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{event.branchName}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{authMethodLabel(event.authMethod)}</Badge>
                        </TableCell>
                        <TableCell>
                          {event.confidenceScore ? `${event.confidenceScore}%` : "-"}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">
                          {event.createdBy ? "Admin Override" : "Self-service"}
                        </TableCell>
                        <TableCell>
                          {event.photoEvidenceUrl ? (
                            <Button 
                              variant="outline" 
                              size="sm"
                              className="text-amber-600 border-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950"
                              onClick={() => setPhotoPreviewUrl(event.photoEvidenceUrl)}
                              data-testid={`button-view-photo-${event.id}`}
                            >
                              <Image className="h-3 w-3 mr-1" />
                              View
                            </Button>
                          ) : "-"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </TabsContent>

            <TabsContent value="anomalies" className="mt-4 overflow-x-auto">
              {!data?.anomalies?.length ? (
                <div className="text-center py-8 text-muted-foreground">
                  <CheckCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No issues detected for this period</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Severity</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.anomalies.map((anomaly) => (
                      <TableRow key={anomaly.id} data-testid={`row-anomaly-${anomaly.id}`}>
                        <TableCell>{formatDate(anomaly.date)}</TableCell>
                        <TableCell>
                          <AnomalyBadge type={anomaly.type} />
                        </TableCell>
                        <TableCell>
                          {anomaly.type === "SCHEDULED_NO_SHOW" && anomaly.description.match(/^Scheduled for (.+?) but/) ? (
                            <>
                              <Link href="/scheduling" className="text-blue-600 dark:text-blue-400 underline">
                                Scheduled for {anomaly.description.match(/^Scheduled for (.+?) but/)![1]}
                              </Link>
                              {" but did not clock in"}
                            </>
                          ) : issueExplanation(anomaly)}
                        </TableCell>
                        <TableCell>
                          <Badge 
                            variant={anomaly.severity === "high" ? "destructive" : anomaly.severity === "medium" ? "secondary" : "outline"}
                          >
                            {anomaly.severity}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </details>

      {/* Photo Preview Dialog */}
      <Dialog open={!!photoPreviewUrl} onOpenChange={() => setPhotoPreviewUrl(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Image className="h-5 w-5" />
              Clock evidence photo
            </DialogTitle>
            <DialogDescription>
              Photo captured with this clock event.
            </DialogDescription>
          </DialogHeader>
          {photoPreviewUrl && (
            <DialogBody className="flex justify-center">
              <img
                src={photoPreviewUrl}
                alt="Clock event evidence"
                className="max-w-full max-h-96 rounded-lg border"
              />
            </DialogBody>
          )}
        </DialogContent>
      </Dialog>
    </main>
  );
}
