import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useRoute, useLocation } from "wouter";
import { format } from "date-fns";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import {
  ArrowLeft,
  AlertTriangle,
  XCircle,
  Info,
  CheckCircle,
  Clock,
  User,
  Calendar,
  FileText,
} from "lucide-react";

interface PayrollException {
  id: string;
  payrollRunId: string;
  employeeId: string;
  type: string;
  severity: string;
  status: string;
  message: string;
  date: string | null;
  varianceMinutes: number | null;
  varianceAmount: string | null;
  scheduledMinutes: number | null;
  actualMinutes: number | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

interface Employee {
  id: string;
  fullName: string;
  branchId: string;
}

export default function PayrollExceptionDetailPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [, params] = useRoute("/payroll/runs/:runId/exceptions/:exceptionId");
  const runId = params?.runId;
  const exceptionId = params?.exceptionId;

  const [note, setNote] = useState("");
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  const { data: exception, isLoading, error } = useQuery<PayrollException>({
    queryKey: ["/api/payroll/exceptions", exceptionId],
    queryFn: async () => {
      const res = await fetch(`/api/payroll/runs/${runId}/exceptions/${exceptionId}`);
      if (!res.ok) throw new Error("Failed to fetch exception");
      return res.json();
    },
    enabled: !!exceptionId && !!runId,
  });

  const { data: employees = [] } = useQuery<Employee[]>({
    queryKey: ["/api/employees"],
  });

  const employee = employees.find((e) => e.id === exception?.employeeId);

  const decisionMutation = useMutation({
    mutationFn: async (decision: { action: string; note: string }) => {
      return apiRequest("POST", `/api/payroll/runs/${runId}/exceptions/${exceptionId}/decision`, decision);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/exceptions", exceptionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/runs", runId, "exceptions"] });
      toast({ title: "Decision recorded", description: "Exception status has been updated." });
      setLocation(`/payroll/runs/${runId}/exceptions`);
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
      setActionInProgress(null);
    },
  });

  const handleDecision = (action: string) => {
    if (!note.trim() && action !== "approve") {
      toast({ title: "Note required", description: "Please provide a note for this decision.", variant: "destructive" });
      return;
    }
    setActionInProgress(action);
    decisionMutation.mutate({ action, note: note.trim() });
  };

  const getSeverityBadge = (severity: string) => {
    switch (severity) {
      case "BLOCKER":
        return <Badge variant="destructive"><XCircle className="w-3 h-3 mr-1" />Blocker</Badge>;
      case "WARNING":
        return <Badge variant="secondary"><AlertTriangle className="w-3 h-3 mr-1" />Warning</Badge>;
      case "INFO":
        return <Badge variant="outline"><Info className="w-3 h-3 mr-1" />Info</Badge>;
      default:
        return <Badge variant="outline">{severity}</Badge>;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "PENDING":
        return <Badge variant="secondary">Pending</Badge>;
      case "APPROVED":
        return <Badge variant="default"><CheckCircle className="w-3 h-3 mr-1" />Approved</Badge>;
      case "REJECTED":
        return <Badge variant="destructive">Rejected</Badge>;
      case "WAIVED":
        return <Badge variant="outline">Waived</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getTypeBadge = (type: string) => {
    const typeLabels: Record<string, string> = {
      MISSING_PUNCH: "Missing Punch",
      VARIANCE: "Variance",
      NEGATIVE_HOURS: "Negative Hours",
      EDITED_AFTER_CUTOFF: "Late Edit",
      OT_REQUIRES_APPROVAL: "OT Approval",
      OPEN_SESSION: "Open Session",
      LONG_SHIFT: "Long Shift",
    };
    return <Badge variant="outline">{typeLabels[type] || type}</Badge>;
  };

  const isPayrollAdmin = user?.role === "global_admin" || user?.role === "operator_admin" || user?.role === "admin";
  const canApprove = user?.role === "manager" || isPayrollAdmin;
  const isPending = exception?.status === "PENDING";

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  if (error || !exception) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>Failed to load exception details. Please try again.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Link href={`/payroll/runs/${runId}/exceptions`}>
          <Button variant="ghost" size="icon" data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Exception Detail</h1>
          <div className="flex items-center gap-2 mt-1">
            {getSeverityBadge(exception.severity)}
            {getTypeBadge(exception.type)}
            {getStatusBadge(exception.status)}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Exception Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground">Type</p>
              <p className="font-medium">{exception.type}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Severity</p>
              <p className="font-medium">{exception.severity}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Message</p>
              <p className="font-medium">{exception.message}</p>
            </div>
            <Separator />
            <div>
              <p className="text-sm text-muted-foreground">Created</p>
              <p className="font-medium">{format(new Date(exception.createdAt), "d MMM yyyy HH:mm")}</p>
            </div>
            {exception.resolvedAt && (
              <div>
                <p className="text-sm text-muted-foreground">Resolved</p>
                <p className="font-medium">{format(new Date(exception.resolvedAt), "d MMM yyyy HH:mm")}</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Evidence
            </CardTitle>
            <CardDescription>Time comparison for this date</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3 p-3 bg-muted rounded-md">
              <User className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="font-medium">{employee?.fullName || "Unknown Employee"}</p>
                <p className="text-sm text-muted-foreground">
                  {exception.date
                    ? format(new Date(exception.date), "EEEE, MMMM d, yyyy")
                    : "Period-level exception"}
                </p>
              </div>
            </div>

            {exception.scheduledMinutes !== null && (
              <div className="grid grid-cols-2 gap-4">
                <div className="p-3 border rounded-md">
                  <p className="text-sm text-muted-foreground">Scheduled</p>
                  <p className="text-xl font-bold">
                    {Math.floor((exception.scheduledMinutes || 0) / 60)}h {(exception.scheduledMinutes || 0) % 60}m
                  </p>
                </div>
                <div className="p-3 border rounded-md">
                  <p className="text-sm text-muted-foreground">Actual</p>
                  <p className="text-xl font-bold">
                    {Math.floor((exception.actualMinutes || 0) / 60)}h {(exception.actualMinutes || 0) % 60}m
                  </p>
                </div>
              </div>
            )}

            {exception.varianceMinutes !== null && (
              <div className="p-3 border rounded-md">
                <p className="text-sm text-muted-foreground">Variance</p>
                <p className={`text-xl font-bold ${exception.varianceMinutes < 0 ? "text-destructive" : "text-primary"}`}>
                  {exception.varianceMinutes > 0 ? "+" : ""}{exception.varianceMinutes} minutes
                </p>
                {exception.varianceAmount && (
                  <p className="text-sm text-muted-foreground">
                    ฿{Number(exception.varianceAmount).toLocaleString()} impact
                  </p>
                )}
              </div>
            )}

            <div className="text-sm text-muted-foreground text-center py-4">
              Detailed punch timeline will be shown here.
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4" />
              Resolution
            </CardTitle>
            <CardDescription>
              {isPending ? "Take action on this exception" : "Resolution details"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isPending ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="note">Note {exception.severity !== "INFO" && "(required for reject/waive)"}</Label>
                  <Textarea
                    id="note"
                    placeholder="Add a note explaining your decision..."
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={4}
                    data-testid="input-note"
                  />
                </div>

                <div className="flex flex-col gap-2">
                  {canApprove && exception.severity !== "BLOCKER" && (
                    <Button
                      onClick={() => handleDecision("approve")}
                      disabled={actionInProgress !== null}
                      data-testid="button-approve"
                    >
                      <CheckCircle className="mr-2 h-4 w-4" />
                      {actionInProgress === "approve" ? "Approving..." : "Approve"}
                    </Button>
                  )}

                  {canApprove && (
                    <Button
                      variant="outline"
                      onClick={() => handleDecision("reject")}
                      disabled={actionInProgress !== null || !note.trim()}
                      data-testid="button-reject"
                    >
                      <XCircle className="mr-2 h-4 w-4" />
                      {actionInProgress === "reject" ? "Rejecting..." : "Reject"}
                    </Button>
                  )}

                  {isPayrollAdmin && (
                    <Button
                      variant="secondary"
                      onClick={() => handleDecision("waive")}
                      disabled={actionInProgress !== null || !note.trim()}
                      data-testid="button-waive"
                    >
                      {actionInProgress === "waive" ? "Waiving..." : "Waive (Admin)"}
                    </Button>
                  )}
                </div>

                {exception.severity === "BLOCKER" && (
                  <Alert>
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                      Blocker exceptions cannot be directly approved. They must be waived by a payroll admin or the underlying issue must be fixed.
                    </AlertDescription>
                  </Alert>
                )}
              </>
            ) : (
              <div className="space-y-4">
                <div className="p-4 bg-muted rounded-md">
                  <div className="flex items-center gap-2 mb-2">
                    {getStatusBadge(exception.status)}
                  </div>
                  {exception.resolvedAt && (
                    <p className="text-sm text-muted-foreground">
                      {format(new Date(exception.resolvedAt), "d MMM yyyy 'at' HH:mm")}
                    </p>
                  )}
                </div>
                {exception.resolutionNote && (
                  <div>
                    <p className="text-sm text-muted-foreground">Resolution Note</p>
                    <p className="font-medium">{exception.resolutionNote}</p>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
