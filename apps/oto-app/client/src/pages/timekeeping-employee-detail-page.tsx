import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  ArrowLeft, 
  Clock, 
  AlertTriangle, 
  AlertCircle, 
  Timer, 
  KeyRound,
  UserCheck,
  Plus,
  Eye,
  CheckCircle,
  XCircle,
  Image
} from "lucide-react";
import { DatePicker } from "@/components/ui/date-picker";
import { EmployeeAvatar } from "@/components/employee-avatar";
import { ClickableEmployeeAvatar } from "@/components/clickable-employee-avatar";

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

function AnomalyBadge({ type }: { type: string }) {
  const configs: Record<string, { label: string; variant: "destructive" | "secondary" | "default"; icon: any }> = {
    OPEN_SESSION: { label: "No OUT", variant: "destructive", icon: AlertCircle },
    MISSING_IN: { label: "Missing IN", variant: "destructive", icon: AlertTriangle },
    MULTIPLE_IN: { label: "Multi IN", variant: "secondary", icon: AlertTriangle },
    MULTIPLE_OUT: { label: "Multi OUT", variant: "secondary", icon: AlertTriangle },
    LONG_SHIFT: { label: ">9h", variant: "default", icon: Timer },
    SCHEDULED_NO_SHOW: { label: "Absent", variant: "destructive", icon: AlertTriangle },
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

function StatCard({ icon: Icon, label, value, subtext }: { icon: any; label: string; value: string | number; subtext?: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Icon className="h-6 w-6 text-muted-foreground" />
          </div>
          <div>
            <p className="text-2xl font-bold">{value}</p>
            <p className="text-sm text-muted-foreground">{label}</p>
            {subtext && <p className="text-xs text-muted-foreground">{subtext}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
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
        <div className="space-y-4 py-4">
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
          <div className="grid grid-cols-2 gap-4">
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
        </div>
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
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split('T')[0];
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);

  const { data, isLoading, refetch } = useQuery<EmployeeDetailResponse>({
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
  });

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

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <Link href="/timekeeping-review">
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          {data?.employee && (
            <ClickableEmployeeAvatar
              employeeId={data.employee.id}
              fullName={data.employee.fullName}
              profilePhotoPath={data.employee.profilePhotoPath}
              size="lg"
            />
          )}
          <div>
            <h1 className="text-2xl font-medium flex items-center gap-2" data-testid="text-employee-name">
              {data?.employee?.fullName || "Employee"}
            </h1>
            <p className="text-muted-foreground">
              {data?.employee?.branchName || "Unknown Branch"}
              {data?.employee?.hasFaceEnrolled && (
                <Badge variant="outline" className="ml-2">
                  <UserCheck className="h-3 w-3 mr-1" />
                  Face Enrolled
                </Badge>
              )}
            </p>
          </div>
        </div>
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
      </div>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-lg">Date Range</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-4 flex-wrap">
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
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard 
          icon={Clock} 
          label="Total Hours" 
          value={data?.stats?.totalHours ? formatHours(data.stats.totalHours) : "-"} 
          subtext={`${data?.dateRange?.start} to ${data?.dateRange?.end}`}
        />
        <StatCard 
          icon={CheckCircle} 
          label="Sessions" 
          value={data?.stats?.totalSessions ?? "-"} 
        />
        <StatCard 
          icon={AlertTriangle} 
          label="Anomalies" 
          value={data?.stats?.totalAnomalies ?? "-"} 
        />
        <StatCard 
          icon={UserCheck} 
          label="Face Events" 
          value={data?.stats?.faceUsageCount ?? "-"} 
        />
        <StatCard 
          icon={KeyRound} 
          label="PIN Events" 
          value={data?.stats?.pinUsageCount ?? "-"} 
        />
      </div>

      <Card>
        <CardContent className="pt-6">
          <Tabs defaultValue="sessions">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="sessions" data-testid="tab-sessions">
                Sessions ({data?.sessions?.length || 0})
              </TabsTrigger>
              <TabsTrigger value="events" data-testid="tab-events">
                Raw Events ({data?.rawEvents?.length || 0})
              </TabsTrigger>
              <TabsTrigger value="anomalies" data-testid="tab-anomalies">
                Anomalies ({data?.anomalies?.length || 0})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="sessions" className="mt-4">
              {!data?.sessions?.length ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Clock className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No sessions found for this period</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>IN Time</TableHead>
                      <TableHead>IN Branch</TableHead>
                      <TableHead>OUT Time</TableHead>
                      <TableHead>OUT Branch</TableHead>
                      <TableHead>Duration</TableHead>
                      <TableHead>Auth</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.sessions.map((session) => (
                      <TableRow 
                        key={session.id}
                        className={!session.outEvent ? "bg-destructive/5" : ""}
                        data-testid={`row-session-${session.id}`}
                      >
                        <TableCell>{formatDate(session.date)}</TableCell>
                        <TableCell>{formatTime(session.inEvent?.eventTime)}</TableCell>
                        <TableCell className="text-muted-foreground">{session.inBranchName}</TableCell>
                        <TableCell>
                          {session.outEvent ? formatTime(session.outEvent.eventTime) : (
                            <Badge variant="destructive" className="text-xs">Open</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{session.outBranchName || "-"}</TableCell>
                        <TableCell>{formatDuration(session.durationMinutes)}</TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            {session.inEvent?.authMethod === "PIN" && (
                              session.inEvent?.photoEvidenceUrl ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-6 px-2 text-xs text-amber-600 border-amber-600"
                                  onClick={() => setPhotoPreviewUrl(session.inEvent.photoEvidenceUrl)}
                                >
                                  <KeyRound className="h-3 w-3 mr-1" /> IN
                                </Button>
                              ) : (
                                <Badge variant="outline" className="text-xs"><KeyRound className="h-3 w-3" /> IN</Badge>
                              )
                            )}
                            {session.outEvent?.authMethod === "PIN" && (
                              session.outEvent?.photoEvidenceUrl ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-6 px-2 text-xs text-amber-600 border-amber-600"
                                  onClick={() => setPhotoPreviewUrl(session.outEvent.photoEvidenceUrl)}
                                >
                                  <KeyRound className="h-3 w-3 mr-1" /> OUT
                                </Button>
                              ) : (
                                <Badge variant="outline" className="text-xs"><KeyRound className="h-3 w-3" /> OUT</Badge>
                              )
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </TabsContent>

            <TabsContent value="events" className="mt-4">
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
                      <TableHead>Auth Method</TableHead>
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
                          {event.authMethod === "PIN" ? (
                            <Badge variant="outline"><KeyRound className="h-3 w-3 mr-1" /> PIN</Badge>
                          ) : (
                            <Badge variant="outline"><UserCheck className="h-3 w-3 mr-1" /> Face</Badge>
                          )}
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

            <TabsContent value="anomalies" className="mt-4">
              {!data?.anomalies?.length ? (
                <div className="text-center py-8 text-muted-foreground">
                  <CheckCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No anomalies detected for this period</p>
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
                          ) : anomaly.description}
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
        </CardContent>
      </Card>

      {/* Photo Preview Dialog */}
      <Dialog open={!!photoPreviewUrl} onOpenChange={() => setPhotoPreviewUrl(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Image className="h-5 w-5" />
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
