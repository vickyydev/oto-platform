import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useBranchContext } from "@/hooks/use-branch-context";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { selectPresenceDelivery, remainingPresenceDeliveries, presenceRecoveryTargets, retryPresenceTarget, workingPresenceDeliveries, restorePresenceRequests, type PresenceTarget, type PresenceDelivery, type LocalPresenceDelivery } from "@/lib/presence-delivery";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmployeeAvatar } from "@/components/employee-avatar";
import {
  Clock,
  AlertTriangle,
  Bell,
  ArrowLeft,
  RefreshCw,
  Loader2,
  Eye,
  Building2,
  Users,
  Timer
} from "lucide-react";

interface WorkingEmployee {
  deliveries?: PresenceDelivery[];
  delivery?: PresenceDelivery | null;
  employeeId: string;
  fullName: string;
  nickname: string;
  displayName: string;
  profilePhotoPath: string | null;
  clockInAt: string;
  elapsedMinutes: number;
  status: "WORKING" | "ON_BREAK";
  branchId: string | null;
  branchName: string | null;
  departmentId: string | null;
  departmentName: string | null;
}

interface MissingEmployee {
  delivery?: PresenceDelivery | null;
  shiftDate: string;
  employeeId: string;
  fullName: string;
  nickname: string;
  displayName: string;
  profilePhotoPath: string | null;
  scheduledStart: string;
  scheduledEnd: string;
  shiftRowId: string;
  branchId: string | null;
  branchName: string | null;
  departmentId: string | null;
  departmentName: string | null;
}

interface LiveData {
  workingNow: WorkingEmployee[];
  missingClockIns: MissingEmployee[];
  currentlyWorkingCount: number;
  missingClockInsCount: number;
  timestamp: string;
}

interface Branch {
  id: string;
  name: string;
}

function DeliveryStatus({ delivery }: { delivery?: PresenceDelivery | null }) {
  if (!delivery) return null;
  return <div className="mt-1 text-xs" aria-live="polite">
    <span className={delivery.status === "Failed" ? "text-destructive" : "text-muted-foreground"}>Inbox: {delivery.status}</span>
    {delivery.status === "Delivered" && <span className="text-muted-foreground"> — Available in staff inbox; read status is separate.</span>}
    {delivery.failureMessage && <p className="text-muted-foreground">{delivery.failureMessage}</p>}
  </div>;
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function formatShiftTime(timeStr: string): string {
  const parts = timeStr.split(":");
  return `${parts[0]}:${parts[1]}`;
}

function formatElapsed(minutes: number): string {
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hrs === 0) return `${mins}m`;
  return `${hrs}h ${mins}m`;
}


export default function TimekeepingLivePage({ embedded = false }: { embedded?: boolean }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [location, setLocation] = useLocation();
  const { selectedBranchId, isAllBranches } = useBranchContext();

  // wouter's location is the path only — the query string never reaches it,
  // so ?tab=missing must be read from the window (SCRUM-563 capture finding).
  const urlParams = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const defaultTab = embedded ? "working" : urlParams.get("tab") === "missing" ? "missing" : "working";

  const [activeTab, setActiveTab] = useState(defaultTab);
  const [selectedBranch, setSelectedBranch] = useState<string>(
    isAllBranches ? "all" : (selectedBranchId || "all")
  );
  const [photoModalEmployee, setPhotoModalEmployee] = useState<{ name: string; photo: string } | null>(null);
  // A staff record can carry a photo path whose file is not in this
  // deployment's storage. Without this the enlarged view draws the browser's
  // broken-image icon under the person's name; the avatar behind it already
  // falls back to initials.
  const [photoModalFailed, setPhotoModalFailed] = useState(false);
  const [detailEmployee, setDetailEmployee] = useState<WorkingEmployee | null>(null);
  const [localDeliveries, setLocalDeliveries] = useState<Record<string, LocalPresenceDelivery>>({});
  const deliveryKey = (employee: PresenceTarget) => `${user?.id}:${employee.employeeId}:${employee.shiftRowId}:${employee.shiftDate}`;
  const deliveryFor = (employee: MissingEmployee) => selectPresenceDelivery(employee.delivery, localDeliveries[deliveryKey(employee)]);

  useEffect(() => {
    try { setLocalDeliveries(user?.id ? restorePresenceRequests(sessionStorage, user.id) : {}); }
    catch { setLocalDeliveries({}); }
  }, [user?.id]);

  const workingDeliveriesFor = (employee: WorkingEmployee) => workingPresenceDeliveries(
    employee.employeeId, selectedBranch === "all" ? null : selectedBranch, employee.deliveries || (employee.delivery ? [employee.delivery] : []), Object.values(localDeliveries),
    user?.hasAllBranchesAccess ? undefined : user?.allowedBranchIds || [],
  );

  const isManager = user?.role === "manager" || user?.role === "admin" || user?.role === "operator_admin" || user?.role === "global_admin";

  const { data: branches } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const liveUrl = selectedBranch === "all"
    ? "/api/timekeeping/live"
    : `/api/timekeeping/live?branchId=${selectedBranch}`;

  const { data: liveData, isLoading, isError, refetch, isRefetching } = useQuery<LiveData>({
    queryKey: ["/api/timekeeping/live", selectedBranch],
    queryFn: async () => (await apiRequest("GET", liveUrl)).json(),
    enabled: isManager,
    refetchInterval: 30000,
  });

  const recoveryTargets = presenceRecoveryTargets(Object.values(localDeliveries));
  const { data: recovery } = useQuery<{ deliveries: PresenceDelivery[] }>({
    queryKey: ["/api/timekeeping/live/deliveries/recovery", user?.id, selectedBranch, recoveryTargets],
    enabled: isManager,
    queryFn: async () => (await apiRequest("POST", "/api/timekeeping/live/deliveries/recovery", {
      ...(selectedBranch === "all" ? {} : { branchId: selectedBranch }), targets: recoveryTargets,
    })).json(),
    refetchInterval: 30000,
  });
  const visibleRetries = [
    ...(liveData?.missingClockIns || []).flatMap(employee => {
      const delivery = deliveryFor(employee);
      return delivery && delivery.status !== "Delivered" ? [delivery.requestKey] : [];
    }),
    ...(liveData?.workingNow || []).flatMap(employee => workingDeliveriesFor(employee)
      .filter(delivery => retryPresenceTarget(delivery)).map(delivery => delivery.requestKey)),
  ];
  const remainingDeliveries = remainingPresenceDeliveries(recovery?.deliveries || [], visibleRetries);

  const pingMutation = useMutation({
    mutationFn: async ({ employee, requestKey }: { employee: PresenceTarget; requestKey: string }) => {
      const response = await apiRequest("POST", "/api/timekeeping/live/ping", {
        employeeId: employee.employeeId, shiftRowId: employee.shiftRowId,
        shiftDate: employee.shiftDate, reason: "missing_clock_in", requestKey,
      });
      return response.json() as Promise<{ delivery: PresenceDelivery }>;
    },
    onSuccess: ({ delivery }, { employee }) => {
      const key = deliveryKey(employee);
      setLocalDeliveries(current => ({ ...current, [key]: delivery }));
      if (delivery.status === "Delivered") {
        try { sessionStorage.removeItem(`presence-ping:${key}`); sessionStorage.removeItem(`presence-ping-target:${key}`); } catch { /* The stored server attempt remains authoritative. */ }
      }
      queryClient.invalidateQueries({ queryKey: ["/api/timekeeping/live"] });
      queryClient.invalidateQueries({ queryKey: ["/api/timekeeping/live/deliveries/recovery"] });
      toast({ title: `Inbox: ${delivery.status}`, description: delivery.status === "Delivered" ? "Available in the staff inbox" : delivery.failureMessage || "Retry to finish this delivery", variant: delivery.status === "Failed" ? "destructive" : "default" });
    },
    onError: (_error, { employee, requestKey }) => {
      setLocalDeliveries(current => ({ ...current, [deliveryKey(employee)]: { ...employee, requestKey, status: "Pending", failureMessage: "Delivery could not be confirmed. Retry to check the same request.", unconfirmed: true } }));
      toast({ title: "Delivery could not be confirmed", description: "Retry safely using the same request", variant: "destructive" });
    },
  });

  function sendPing(employee: PresenceTarget & { delivery?: PresenceDelivery | null }, retry?: PresenceDelivery) {
    const key = deliveryKey(employee);
    const previous = retry || selectPresenceDelivery(employee.delivery, localDeliveries[key]);
    let requestKey = previous && previous.status !== "Delivered" ? previous.requestKey : "";
    if (previous?.status === "Delivered") {
      try { sessionStorage.removeItem(`presence-ping:${key}`); sessionStorage.removeItem(`presence-ping-target:${key}`); } catch { /* A fresh action still receives a fresh in-memory key. */ }
    }
    try { requestKey ||= sessionStorage.getItem(`presence-ping:${key}`) || ""; } catch { /* A same-screen retry still holds its request key. */ }
    requestKey ||= crypto.randomUUID();
    const pending: LocalPresenceDelivery = { employeeId: employee.employeeId, branchId: employee.branchId, shiftRowId: employee.shiftRowId,
      shiftDate: employee.shiftDate, requestKey, status: "Pending", failureMessage: null, unconfirmed: true };
    try {
      sessionStorage.setItem(`presence-ping:${key}`, requestKey);
      sessionStorage.setItem(`presence-ping-target:${key}`, JSON.stringify(pending));
    } catch { /* A same-screen retry still holds its request key and target. */ }
    setLocalDeliveries(current => ({ ...current, [key]: pending }));
    pingMutation.mutate({ employee, requestKey });
  }

  if (!isManager) {
    return (
      <div className="p-6 text-center">
        <AlertTriangle className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
        <h2 className="text-xl font-semibold">Not Authorized</h2>
        <p className="text-muted-foreground">You don't have permission to view this page.</p>
      </div>
    );
  }

  return (
    <div className={embedded ? "overflow-hidden rounded-2xl border border-[#d9e1d7] bg-[#fcfcf7] dark:border-border dark:bg-card" : "min-h-[100dvh] bg-background"}>
      <header className={embedded ? "border-b border-[#e6eae1] dark:border-border" : "sticky top-0 z-10 bg-background border-b"}>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-4 sm:p-5">
          <div className="flex items-center gap-2">
            {!embedded && <Button variant="ghost" size="icon" aria-label="Back to Today's attendance" onClick={() => setLocation("/timekeeping-review?tab=live")}>
              <ArrowLeft className="h-5 w-5" />
            </Button>}
            <div>
              {embedded ? <h2 className="text-xl font-semibold tracking-[-0.035em]">Working now <span className="ml-1 tabular-nums text-[#718b7b]">{liveData?.currentlyWorkingCount ?? "—"}</span></h2> : <h1 className="text-lg font-semibold">Live Timekeeping</h1>}
              <p className="text-xs text-muted-foreground">
                {liveData ? `Updated ${formatTime(liveData.timestamp)}` : "Live attendance · refreshes every 30 seconds"}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Embedded there is no Missing tab, but the not-clocked-in list
                and its inbox reminders still need a door: the full live page
                keeps them, so the embedded view links to it. */}
            {embedded && (
              <Button variant="outline" size="sm" onClick={() => setLocation("/timekeeping/live?tab=missing")} data-testid="link-missing-clock-ins">
                Not clocked in
                {liveData && liveData.missingClockInsCount > 0 && (
                  <Badge variant="destructive" className="ml-2 h-5 min-w-5 px-1.5">{liveData.missingClockInsCount}</Badge>
                )}
              </Button>
            )}
            <Select value={selectedBranch} onValueChange={setSelectedBranch}>
              <SelectTrigger className="w-[140px]" data-testid="select-branch">
                <SelectValue placeholder="All Branches" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Branches</SelectItem>
                {branches?.map((branch) => (
                  <SelectItem key={branch.id} value={branch.id}>
                    {branch.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh live attendance"
              onClick={() => refetch()}
              disabled={isRefetching}
              data-testid="button-refresh"
            >
              {isRefetching ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </header>

      {remainingDeliveries.length > 0 && <section className="border-b p-4 space-y-3" aria-label="Pending inbox deliveries">
        <h2 className="font-medium">Pending inbox deliveries</h2>
        {remainingDeliveries.map(delivery => {
          const target = retryPresenceTarget(delivery)!;
          return <div className="flex items-center justify-between gap-3" key={delivery.requestKey}>
            <div>
              <p className="text-sm font-medium">{delivery.employeeName || "Staff member"}</p>
              <p className="text-xs text-muted-foreground">{branches?.find(branch => branch.id === delivery.branchId)?.name || "Shift branch"} ? {delivery.shiftDate}</p>
              <DeliveryStatus delivery={delivery} />
            </div>
            <Button variant="outline" size="sm" disabled={pingMutation.isPending}
              onClick={() => sendPing(target, delivery)} data-testid={`button-retry-pending-${delivery.requestKey}`}>
              {pingMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Retry inbox delivery"}
            </Button>
          </div>;
        })}
      </section>}

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        {!embedded && <div className="border-b bg-muted/30">
          <TabsList className="w-full justify-start rounded-none h-auto p-0 bg-transparent">
            <TabsTrigger
              value="working"
              className="flex-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent py-3"
              data-testid="tab-working"
            >
              <Clock className="h-4 w-4 mr-2" />
              Working Now
              {liveData && (
                <Badge variant="secondary" className="ml-2">
                  {liveData.currentlyWorkingCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger
              value="missing"
              className="flex-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent py-3"
              data-testid="tab-missing"
            >
              <AlertTriangle className="h-4 w-4 mr-2" />
              Missing Clock-ins
              {liveData && liveData.missingClockInsCount > 0 && (
                <Badge variant="destructive" className="ml-2">
                  {liveData.missingClockInsCount}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>
        </div>}

        <TabsContent value="working" className="m-0">
          <div className="divide-y">
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 p-4">
                  <Skeleton className="h-12 w-12 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                </div>
              ))
            ) : isError ? (
              <div className="p-8 text-center"><AlertTriangle className="mx-auto mb-3 h-9 w-9 text-[#a7713f]" /><p className="font-medium">Live attendance could not be loaded.</p><Button variant="outline" className="mt-4" onClick={() => refetch()}>Try again</Button></div>
            ) : !liveData?.workingNow?.length ? (
              /**
               * This screen only ever shows now — that is what makes it live,
               * and a date picker here would be a different screen. So when it
               * is empty it says where the past is instead, because an empty
               * panel with no explanation reads as a broken one.
               */
              <div className="p-8 text-center text-muted-foreground">
                <Users className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p>No one is currently clocked in</p>
                {/* Embedded, this list is already a tab of Today's attendance,
                    so a link back to that page would go nowhere; the sibling
                    tabs carry the date picker and the punch log instead. */}
                {embedded ? (
                  <p className="text-sm mt-2" data-testid="text-attendance-history-hint">
                    This tab shows the present moment only. The Issues and Clock tabs
                    show earlier days and clock-ins.
                  </p>
                ) : (
                <p className="text-sm mt-2">
                  This screen shows the present moment only.{" "}
                  <button
                    type="button"
                    className="underline underline-offset-2 hover:text-foreground"
                    onClick={() => setLocation("/timekeeping-review")}
                    data-testid="link-attendance-history"
                  >
                    Open Attendance
                  </button>{" "}
                  to pick a day and see earlier clock-ins.
                </p>
                )}
              </div>
            ) : (
              liveData.workingNow.map((emp) => (
                <div
                  key={emp.employeeId}
                  className="flex items-center gap-3 p-4 hover-elevate cursor-pointer"
                  onClick={() => setDetailEmployee(emp)}
                  data-testid={`row-working-${emp.employeeId}`}
                >
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      if (emp.profilePhotoPath) {
                        setPhotoModalEmployee({ name: emp.displayName, photo: emp.profilePhotoPath });
                      }
                    }}
                  >
                    <EmployeeAvatar
                      employeeId={emp.employeeId}
                      fullName={emp.fullName}
                      profilePhotoPath={emp.profilePhotoPath}
                      size="md"
                      workStatus="CLOCKED_IN"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium truncate" data-testid={`text-name-${emp.employeeId}`}>{emp.displayName}</p>
                      {workingDeliveriesFor(emp).map(delivery => {
                        const target = retryPresenceTarget(delivery);
                        return <div key={delivery.requestKey}>
                          <span className="text-xs text-muted-foreground">{branches?.find(branch => branch.id === delivery.branchId)?.name || "Shift branch"} ? {delivery.shiftDate}</span>
                          <DeliveryStatus delivery={delivery} />
                          {target && <Button variant="outline" size="sm" disabled={pingMutation.isPending}
                            onClick={event => { event.stopPropagation(); sendPing(target, delivery); }}
                            data-testid={`button-retry-working-${delivery.requestKey}`}>
                            {pingMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Retry inbox delivery"}
                          </Button>}
                        </div>;
                      })}
                      <Badge
                        variant={emp.status === "ON_BREAK" ? "outline" : "secondary"}
                        className="text-[10px] px-1.5 py-0"
                        data-testid={`badge-status-${emp.employeeId}`}
                      >
                        {emp.status === "ON_BREAK" ? "On Break" : "Working"}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-1 text-sm text-muted-foreground flex-wrap">
                      <span>{emp.departmentName || "No department set"}</span>
                      <span>·</span>
                      <span>In {formatTime(emp.clockInAt)}</span>
                      <span>·</span>
                      <Timer className="h-3 w-3 inline" />
                      <span>{formatElapsed(emp.elapsedMinutes)}</span>
                    </div>
                  </div>
                   <Button variant="ghost" size="icon" aria-label={`View ${emp.displayName}`} onClick={(event) => { event.stopPropagation(); setDetailEmployee(emp); }} data-testid={`button-view-${emp.employeeId}`}>
                    <Eye className="h-4 w-4" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </TabsContent>

        {!embedded && <TabsContent value="missing" className="m-0">
          <div className="divide-y">
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 p-4">
                  <Skeleton className="h-12 w-12 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                </div>
              ))
            ) : !liveData?.missingClockIns?.length ? (
              <div className="p-8 text-center text-muted-foreground">
                <Clock className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p>Everyone scheduled is clocked in</p>
              </div>
            ) : (
              liveData.missingClockIns.map((emp) => (
                <div
                  key={`${emp.employeeId}-${emp.shiftRowId}`}
                  className="flex items-center gap-3 p-4"
                  data-testid={`row-missing-${emp.employeeId}`}
                >
                  <div
                    className="cursor-pointer"
                    onClick={() => {
                      if (emp.profilePhotoPath) {
                        setPhotoModalEmployee({ name: emp.displayName, photo: emp.profilePhotoPath });
                      }
                    }}
                  >
                    <EmployeeAvatar
                      employeeId={emp.employeeId}
                      fullName={emp.fullName}
                      profilePhotoPath={emp.profilePhotoPath}
                      size="md"
                      workStatus="SCHEDULED_TO_WORK"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate" data-testid={`text-name-missing-${emp.employeeId}`}>{emp.displayName}</p>
                    <DeliveryStatus delivery={deliveryFor(emp)} />
                    <div className="flex items-center gap-1 text-sm text-muted-foreground flex-wrap">
                      <span>{emp.departmentName || "No department set"}</span>
                      <span>·</span>
                      <span>Shift {formatShiftTime(emp.scheduledStart)}–{formatShiftTime(emp.scheduledEnd)}</span>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => sendPing(emp)}
                    disabled={pingMutation.isPending}
                    data-testid={`button-ping-${emp.employeeId}`}
                  >
                    {pingMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <Bell className="h-4 w-4 mr-1" />
                        {deliveryFor(emp) && deliveryFor(emp)?.status !== "Delivered" ? "Retry" : "Ping"}
                      </>
                    )}
                  </Button>
                </div>
              ))
            )}
          </div>
        </TabsContent>}
      </Tabs>

      <Dialog
        open={!!photoModalEmployee}
        onOpenChange={() => {
          setPhotoModalEmployee(null);
          setPhotoModalFailed(false);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{photoModalEmployee?.name}</DialogTitle>
          </DialogHeader>
          <DialogBody>
          {photoModalEmployee?.photo && !photoModalFailed && (
            <img
              src={photoModalEmployee.photo}
              alt={photoModalEmployee.name}
              onError={() => setPhotoModalFailed(true)}
              className="w-full max-h-80 object-contain rounded-md"
            />
          )}
          {photoModalEmployee?.photo && photoModalFailed && (
            <p className="text-sm text-muted-foreground text-center py-8" data-testid="photo-unavailable">
              This photograph is not stored on this deployment.
            </p>
          )}
          </DialogBody>
        </DialogContent>
      </Dialog>

      <Dialog open={!!detailEmployee} onOpenChange={() => setDetailEmployee(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Staff Details</DialogTitle>
          </DialogHeader>
          {detailEmployee && (
            <DialogBody className="space-y-4">
              <div className="flex items-center gap-3">
                <EmployeeAvatar
                  employeeId={detailEmployee.employeeId}
                  fullName={detailEmployee.fullName}
                  profilePhotoPath={detailEmployee.profilePhotoPath}
                  size="lg"
                  workStatus="CLOCKED_IN"
                />
                <div>
                  <p className="text-lg font-semibold">{detailEmployee.displayName}</p>
                  <Badge
                    variant={detailEmployee.status === "ON_BREAK" ? "outline" : "secondary"}
                    className="text-xs"
                  >
                    {detailEmployee.status === "ON_BREAK" ? "On Break" : "Working"}
                  </Badge>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <span>Clocked in at {formatTime(detailEmployee.clockInAt)}</span>
                  <span className="text-muted-foreground">({formatElapsed(detailEmployee.elapsedMinutes)})</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <span>{detailEmployee.departmentName || "No department set"}</span>
                </div>
                {detailEmployee.branchName && (
                  <div className="flex items-center gap-2 text-sm">
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                    <span>{detailEmployee.branchName}</span>
                  </div>
                )}
              </div>
            </DialogBody>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
