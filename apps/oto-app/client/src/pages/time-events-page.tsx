import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useBranchContext } from "@/hooks/use-branch-context";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatDate } from "@/lib/format-utils";
import { Clock, Filter, Plus, User, Trash2, Loader2, ArrowUpRight, ArrowDownRight, Camera, X, Check, ChevronsUpDown } from "lucide-react";
import { DatePicker } from "@/components/ui/date-picker";
import { ClickableEmployeeAvatar } from "@/components/clickable-employee-avatar";
import type { Employee, Branch } from "@shared/schema";

type OverrideAdvisor = {
  id: string;
  fullName: string;
  preferredName: string | null;
  isActive: boolean;
  accessPolicy: {
    branchScope: "ALL" | "SELECTED";
    branchIds: string[] | null;
  };
};

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

interface TimeEvent {
  id: string;
  employeeId: string;
  branchId: string;
  eventType: "IN" | "OUT";
  eventTime: string;
  authMethod: "FACE" | "PIN" | "ADMIN_OVERRIDE";
  confidenceScore: number | null;
  livenessScore: number | null;
  photoEvidenceUrl: string | null;
  notes: string | null;
  kioskDeviceId: string | null;
  createdAt: string;
  createdBy: string | null;
  identityType?: "EMPLOYEE" | "ADVISOR";
  displayName?: string;
  advisorSessionId?: string;
}

export default function TimeEventsPage() {
  const { toast } = useToast();
  const { selectedBranchId: selectedBranch } = useBranchContext();
  const { user } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "manager";
  const isAdmin = user?.role === "admin";

  const [filterAuthMethod, setFilterAuthMethod] = useState<string>("all");
  const [filterEventType, setFilterEventType] = useState<string>("all");
  const [filterDateFrom, setFilterDateFrom] = useState<string>("");
  const [filterDateTo, setFilterDateTo] = useState<string>("");
  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false);
  const [overridePickerOpen, setOverridePickerOpen] = useState(false);
  const [overrideSubject, setOverrideSubject] = useState<string>("");
  const [overrideBranchId, setOverrideBranchId] = useState<string>("");
  const [overrideEventType, setOverrideEventType] = useState<"IN" | "OUT">("IN");
  const [overrideEventTime, setOverrideEventTime] = useState<string>("");
  const [overrideNotes, setOverrideNotes] = useState<string>("");
  const [overrideReasonCode, setOverrideReasonCode] = useState<string>("NORMAL");
  const [overrideReasonNotes, setOverrideReasonNotes] = useState<string>("");
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);

  const buildQueryUrl = () => {
    const params = new URLSearchParams();
    if (selectedBranch && selectedBranch !== "all") params.set("branchId", selectedBranch);
    if (filterAuthMethod && filterAuthMethod !== "all") params.set("authMethod", filterAuthMethod);
    if (filterEventType && filterEventType !== "all") params.set("eventType", filterEventType);
    if (filterDateFrom) params.set("dateFrom", filterDateFrom + "T00:00:00");
    if (filterDateTo) params.set("dateTo", filterDateTo + "T23:59:59");
    return `/api/time-events?${params.toString()}`;
  };

  const { data: eventsData, isLoading: eventsLoading } = useQuery<{
    events: TimeEvent[];
    total: number;
    limit: number;
    offset: number;
  }>({
    queryKey: ["/api/time-events", selectedBranch, filterAuthMethod, filterEventType, filterDateFrom, filterDateTo],
    queryFn: async () => {
      const res = await fetch(buildQueryUrl(), { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch events");
      return res.json();
    },
  });

  const { data: employees } = useQuery<Employee[]>({
    queryKey: ["/api/employees", selectedBranch],
    queryFn: async () => {
      const url = selectedBranch ? `/api/employees?branchId=${selectedBranch}` : "/api/employees";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch employees");
      return res.json();
    },
  });

  const { data: advisors } = useQuery<OverrideAdvisor[]>({
    queryKey: ["/api/timekeeping/override-advisors"],
    queryFn: async () => {
      const res = await fetch("/api/timekeeping/override-advisors", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch advisors");
      return res.json();
    },
  });

  const { data: branches } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const overrideMutation = useMutation({
    mutationFn: async (data: {
      identityType: "EMPLOYEE" | "ADVISOR";
      employeeId?: string;
      personId?: string;
      branchId: string;
      eventType: "IN" | "OUT";
      eventTime: string;
      notes?: string;
      reasonCode?: string;
      reasonNotes?: string;
    }) => {
      const res = await apiRequest("POST", "/api/time-events/override", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/time-events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/timekeeping/review"] });
      toast({ title: "Override added", description: "Time event has been added." });
      setOverrideDialogOpen(false);
      setOverrideSubject("");
      setOverrideBranchId("");
      setOverrideEventTime("");
      setOverrideNotes("");
      setOverrideReasonCode("NORMAL");
      setOverrideReasonNotes("");
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message || "Failed to add override.", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/time-events/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/time-events"] });
      toast({ title: "Deleted", description: "Time event has been deleted." });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message || "Failed to delete event.", variant: "destructive" });
    },
  });

  const getEmployee = (employeeId: string) => {
    return employees?.find(e => e.id === employeeId);
  };

  const getEmployeeName = (employeeId: string) => {
    const employee = getEmployee(employeeId);
    return employee?.nickname || employee?.fullName || "Unknown";
  };

  const getBranchName = (branchId: string) => {
    const branch = branches?.find(b => b.id === branchId);
    return branch?.name || "Unknown";
  };

  const selectedOverrideName = overrideSubject.startsWith("EMPLOYEE:")
    ? employees?.find(employee => `EMPLOYEE:${employee.id}` === overrideSubject)?.fullName
    : advisors?.find(advisor => `ADVISOR:${advisor.id}` === overrideSubject)?.preferredName ||
      advisors?.find(advisor => `ADVISOR:${advisor.id}` === overrideSubject)?.fullName;

  const handleAddOverride = () => {
    if (!overrideSubject || !overrideEventTime) {
      toast({ title: "Error", description: "Please fill in all required fields.", variant: "destructive" });
      return;
    }

    const [identityType, subjectId] = overrideSubject.split(":") as ["EMPLOYEE" | "ADVISOR", string];
    const employee = identityType === "EMPLOYEE" ? employees?.find(e => e.id === subjectId) : undefined;
    const branchId = identityType === "ADVISOR" ? overrideBranchId : employee?.branchId;
    if (!branchId) {
      toast({
        title: "Error",
        description: identityType === "ADVISOR" ? "Please select a branch." : "Employee has no branch assigned.",
        variant: "destructive",
      });
      return;
    }

    overrideMutation.mutate({
      identityType,
      ...(identityType === "ADVISOR" ? { personId: subjectId } : { employeeId: subjectId }),
      branchId,
      eventType: overrideEventType,
      eventTime: identityType === "ADVISOR"
        ? zonedDateTimeToIso(overrideEventTime, branches?.find(branch => branch.id === branchId)?.timezone || "Asia/Bangkok")
        : overrideEventTime,
      notes: overrideNotes || undefined,
      reasonCode: overrideReasonCode !== "NORMAL" ? overrideReasonCode : undefined,
      reasonNotes: overrideReasonNotes || undefined,
    });
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold" data-testid="page-title">Time & Attendance</h1>
          <p className="text-muted-foreground">View and manage employee clock in/out records</p>
        </div>
        {isAdmin && (
          <Button onClick={() => setOverrideDialogOpen(true)} data-testid="button-add-override">
            <Plus className="mr-2 h-4 w-4" />
            Add Override
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Filter className="h-5 w-5" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="space-y-2">
              <Label>Auth Method</Label>
              <Select value={filterAuthMethod} onValueChange={setFilterAuthMethod}>
                <SelectTrigger data-testid="select-auth-method">
                  <SelectValue placeholder="All methods" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All methods</SelectItem>
                  <SelectItem value="FACE">Face</SelectItem>
                  <SelectItem value="PIN">PIN</SelectItem>
                  <SelectItem value="ADMIN_OVERRIDE">Override</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Event Type</Label>
              <Select value={filterEventType} onValueChange={setFilterEventType}>
                <SelectTrigger data-testid="select-event-type">
                  <SelectValue placeholder="All types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  <SelectItem value="IN">Clock In</SelectItem>
                  <SelectItem value="OUT">Clock Out</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>From Date</Label>
              <DatePicker
                value={filterDateFrom}
                onChange={setFilterDateFrom}
                data-testid="input-date-from"
              />
            </div>
            <div className="space-y-2">
              <Label>To Date</Label>
              <DatePicker
                value={filterDateTo}
                onChange={setFilterDateTo}
                data-testid="input-date-to"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Time Events
          </CardTitle>
          <CardDescription>
            {eventsData?.total || 0} events found
          </CardDescription>
        </CardHeader>
        <CardContent>
          {eventsLoading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map(i => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : eventsData?.events && eventsData.events.length > 0 ? (
            <div className="space-y-2">
              {eventsData.events.map(event => (
                <div
                  key={event.id}
                  className="flex items-center justify-between gap-4 p-4 border rounded-lg hover-elevate"
                  data-testid={`time-event-row-${event.id}`}
                >
                  <div className="flex items-center gap-4">
                    {(() => {
                      const emp = event.identityType === "EMPLOYEE" ? getEmployee(event.employeeId) : undefined;
                      return emp ? (
                        <ClickableEmployeeAvatar
                          employeeId={emp.id}
                          fullName={emp.fullName}
                          profilePhotoPath={emp.profilePhotoPath}
                          size="md"
                        />
                      ) : (
                        <div className="flex items-center justify-center w-10 h-10 rounded-full bg-muted">
                          <User className="h-5 w-5 text-muted-foreground" />
                        </div>
                      );
                    })()}
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-muted">
                      {event.eventType === "IN" ? (
                        <ArrowDownRight className="h-4 w-4 text-green-600" />
                      ) : (
                        <ArrowUpRight className="h-4 w-4 text-red-600" />
                      )}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium" data-testid={`text-employee-name-${event.id}`}>
                          {event.displayName || getEmployeeName(event.employeeId)}
                        </span>
                        {event.identityType === "ADVISOR" && <Badge variant="outline">Advisor</Badge>}
                        <Badge variant={event.eventType === "IN" ? "default" : "secondary"}>
                          {event.eventType}
                        </Badge>
                        <Badge variant="outline">
                          {event.authMethod === "ADMIN_OVERRIDE" ? "Override" : event.authMethod}
                        </Badge>
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {formatDate(event.eventTime)} at{" "}
                        {new Date(event.eventTime).toLocaleTimeString()}
                        {selectedBranch === "all" && (
                          <span> • {getBranchName(event.branchId)}</span>
                        )}
                        {event.notes && <span> • {event.notes}</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {event.confidenceScore && (
                      <span className="text-xs text-muted-foreground">
                        {Math.round(event.confidenceScore * 100)}% match
                      </span>
                    )}
                    {event.photoEvidenceUrl && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-amber-600 border-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950"
                        onClick={() => setPhotoPreviewUrl(event.photoEvidenceUrl)}
                        data-testid={`button-view-photo-${event.id}`}
                      >
                        <Camera className="h-3 w-3 mr-1" />
                        View Photo
                      </Button>
                    )}
                    {isAdmin && event.identityType !== "ADVISOR" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => deleteMutation.mutate(event.id)}
                        disabled={deleteMutation.isPending}
                        data-testid={`button-delete-event-${event.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              <Clock className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No time events found</p>
              <p className="text-sm">Adjust filters or check back later</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={overrideDialogOpen}
        onOpenChange={(open) => {
          setOverrideDialogOpen(open);
          if (!open) setOverridePickerOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Time Override</DialogTitle>
            <DialogDescription>
              Manually add a clock event for staff or an Advisor who missed a punch
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="override-person-picker">Staff or Advisor</Label>
              <Popover open={overridePickerOpen} onOpenChange={setOverridePickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    id="override-person-picker"
                    variant="outline"
                    role="combobox"
                    aria-expanded={overridePickerOpen}
                    className="w-full justify-between font-normal"
                    data-testid="select-override-employee"
                  >
                    <span className={`flex items-center gap-2 ${selectedOverrideName ? "" : "text-muted-foreground"}`}>
                      {selectedOverrideName || "Select staff or advisor"}
                      {overrideSubject.startsWith("ADVISOR:") && <Badge variant="outline">Advisor</Badge>}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  className="w-[var(--radix-popover-trigger-width)] p-0"
                  align="start"
                  style={{ pointerEvents: "auto" }}
                >
                  <Command>
                    <CommandInput placeholder="Type a name to search..." data-testid="input-override-person-search" />
                    <CommandList className="max-h-72">
                      <CommandEmpty>No staff or Advisor found.</CommandEmpty>
                      <CommandGroup>
                        {employees?.map(employee => {
                          const value = `EMPLOYEE:${employee.id}`;
                          return (
                            <CommandItem
                              key={value}
                              value={value}
                              keywords={[employee.fullName, employee.nickname || ""]}
                              onSelect={() => {
                                setOverrideSubject(value);
                                setOverrideBranchId("");
                                setOverridePickerOpen(false);
                              }}
                            >
                              <Check className={`mr-2 h-4 w-4 ${overrideSubject === value ? "opacity-100" : "opacity-0"}`} />
                              {employee.fullName}
                            </CommandItem>
                          );
                        })}
                        {advisors?.filter(advisor => advisor.isActive).map(advisor => {
                          const value = `ADVISOR:${advisor.id}`;
                          const name = advisor.preferredName || advisor.fullName;
                          return (
                            <CommandItem
                              key={value}
                              value={value}
                              keywords={[advisor.fullName, advisor.preferredName || "", "advisor"]}
                              onSelect={() => {
                                setOverrideSubject(value);
                                const canUseSelectedBranch = selectedBranch && selectedBranch !== "all" && (
                                  advisor.accessPolicy.branchScope === "ALL" ||
                                  advisor.accessPolicy.branchIds?.includes(selectedBranch)
                                );
                                setOverrideBranchId(canUseSelectedBranch ? selectedBranch : "");
                                setOverridePickerOpen(false);
                              }}
                            >
                              <Check className={`mr-2 h-4 w-4 ${overrideSubject === value ? "opacity-100" : "opacity-0"}`} />
                              <span className="flex flex-1 items-center gap-2">
                                {name}
                                <Badge variant="outline">Advisor</Badge>
                              </span>
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
            {overrideSubject.startsWith("ADVISOR:") && (
              <div className="space-y-2">
                <Label>Branch</Label>
                <Select value={overrideBranchId} onValueChange={setOverrideBranchId}>
                  <SelectTrigger data-testid="select-override-branch">
                    <SelectValue placeholder="Select branch" />
                  </SelectTrigger>
                  <SelectContent>
                    {branches?.filter(branch => {
                      const advisor = advisors?.find(item => `ADVISOR:${item.id}` === overrideSubject);
                      return advisor?.accessPolicy?.branchScope === "ALL" ||
                        advisor?.accessPolicy?.branchIds?.includes(branch.id);
                    }).map(branch => (
                      <SelectItem key={branch.id} value={branch.id}>{branch.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label>Event Type</Label>
              <Select value={overrideEventType} onValueChange={(v) => setOverrideEventType(v as "IN" | "OUT")}>
                <SelectTrigger data-testid="select-override-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="IN">Clock In</SelectItem>
                  <SelectItem value="OUT">Clock Out</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Event Time</Label>
              <Input
                type="datetime-local"
                value={overrideEventTime}
                onChange={(e) => setOverrideEventTime(e.target.value)}
                data-testid="input-override-time"
              />
            </div>
            <div className="space-y-2">
              <Label>Reason Code</Label>
              <Select value={overrideReasonCode} onValueChange={setOverrideReasonCode}>
                <SelectTrigger data-testid="select-override-reason">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NORMAL">Normal / No Specific Reason</SelectItem>
                  <SelectItem value="FAMILY_EMERGENCY">Family Emergency</SelectItem>
                  <SelectItem value="MEDICAL">Medical</SelectItem>
                  <SelectItem value="OFF_SITE_EVENT">Off-site Event</SelectItem>
                  <SelectItem value="EQUIPMENT_FAILURE">Equipment Failure</SelectItem>
                  <SelectItem value="EARLY_RELEASE">Early Release</SelectItem>
                  <SelectItem value="OTHER">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {overrideReasonCode !== "NORMAL" && (
              <div className="space-y-2">
                <Label>Reason Details (Optional)</Label>
                <Input
                  placeholder="Additional details..."
                  value={overrideReasonNotes}
                  onChange={(e) => setOverrideReasonNotes(e.target.value)}
                  data-testid="input-override-reason-notes"
                />
              </div>
            )}
            <div className="space-y-2">
              <Label>Admin Notes (Optional)</Label>
              <Input
                placeholder="Internal notes for this override..."
                value={overrideNotes}
                onChange={(e) => setOverrideNotes(e.target.value)}
                data-testid="input-override-notes"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOverrideDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleAddOverride}
                disabled={overrideMutation.isPending}
                data-testid="button-submit-override"
              >
                {overrideMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Add Override
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Photo Preview Dialog */}
      <Dialog open={!!photoPreviewUrl} onOpenChange={() => setPhotoPreviewUrl(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Camera className="h-5 w-5" />
              PIN Authentication Photo
            </DialogTitle>
            <DialogDescription>
              Photo captured during PIN fallback authentication
            </DialogDescription>
          </DialogHeader>
          {photoPreviewUrl && (
            <div className="flex justify-center">
              <img
                src={photoPreviewUrl}
                alt="PIN authentication evidence"
                className="max-w-full max-h-96 rounded-lg border"
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
