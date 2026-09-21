import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useBranchContext } from "@/hooks/use-branch-context";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmployeeAvatar } from "@/components/employee-avatar";
import {
  Clock,
  AlertTriangle,
  ChevronRight,
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


export default function TimekeepingLivePage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [location, setLocation] = useLocation();
  const { selectedBranchId, isAllBranches } = useBranchContext();

  const urlParams = new URLSearchParams(location.split("?")[1] || "");
  const defaultTab = urlParams.get("tab") || "working";

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

  const isManager = user?.role === "manager" || user?.role === "admin" || user?.role === "operator_admin" || user?.role === "global_admin";

  const { data: branches } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const liveUrl = selectedBranch === "all"
    ? "/api/timekeeping/live"
    : `/api/timekeeping/live?branchId=${selectedBranch}`;

  const { data: liveData, isLoading, refetch, isRefetching } = useQuery<LiveData>({
    queryKey: ["/api/timekeeping/live", selectedBranch],
    queryFn: () => fetch(liveUrl, { credentials: "include" }).then((r) => r.json()),
    refetchInterval: 30000,
  });

  const pingMutation = useMutation({
    mutationFn: async (data: { employeeId: string; shiftRowId: string }) => {
      return apiRequest("/api/timekeeping/live/ping", {
        method: "POST",
        body: JSON.stringify({
          employeeId: data.employeeId,
          shiftRowId: data.shiftRowId,
          reason: "missing_clock_in",
        }),
      });
    },
    onSuccess: () => {
      toast({ title: "Ping sent", description: "Staff has been notified" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to send ping", variant: "destructive" });
    },
  });

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
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 bg-background border-b">
        <div className="flex items-center justify-between gap-2 p-4">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => setLocation("/")}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-lg font-semibold">Live Timekeeping</h1>
              <p className="text-xs text-muted-foreground">
                {liveData ? `Updated ${formatTime(liveData.timestamp)}` : "Loading..."}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
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

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <div className="border-b bg-muted/30">
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
        </div>

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
                  <Button variant="ghost" size="icon" data-testid={`button-view-${emp.employeeId}`}>
                    <Eye className="h-4 w-4" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </TabsContent>

        <TabsContent value="missing" className="m-0">
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
                    <div className="flex items-center gap-1 text-sm text-muted-foreground flex-wrap">
                      <span>{emp.departmentName || "No department set"}</span>
                      <span>·</span>
                      <span>Shift {formatShiftTime(emp.scheduledStart)}–{formatShiftTime(emp.scheduledEnd)}</span>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => pingMutation.mutate({ employeeId: emp.employeeId, shiftRowId: emp.shiftRowId })}
                    disabled={pingMutation.isPending}
                    data-testid={`button-ping-${emp.employeeId}`}
                  >
                    {pingMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <Bell className="h-4 w-4 mr-1" />
                        Ping
                      </>
                    )}
                  </Button>
                </div>
              ))
            )}
          </div>
        </TabsContent>
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
        </DialogContent>
      </Dialog>

      <Dialog open={!!detailEmployee} onOpenChange={() => setDetailEmployee(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Staff Details</DialogTitle>
          </DialogHeader>
          {detailEmployee && (
            <div className="space-y-4">
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
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
