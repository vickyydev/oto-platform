import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useRoute } from "wouter";
import { format } from "date-fns";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import {
  ArrowLeft,
  Play,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Users,
  Download,
  RefreshCw,
  DollarSign,
  FileText,
  Clock,
} from "lucide-react";

interface PayrollRun {
  id: string;
  payrollPeriodId: string;
  runNumber: number;
  status: string;
  totalEmployees: number;
  totalGross: string;
  totalNet: string;
  totalDeductions: string;
  totalSsoEmployee: string;
  totalSsoEmployer: string;
  totalTax: string;
  createdAt: string;
  calculatedAt: string | null;
  finalizedAt: string | null;
}

interface PayrollException {
  id: string;
  severity: string;
  status: string;
  type: string;
  message: string;
}

export default function PayrollRunDetailPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [, params] = useRoute("/payroll/runs/:runId");
  const runId = params?.runId;
  const [activeTab, setActiveTab] = useState("summary");

  const { data: run, isLoading: runLoading, error: runError } = useQuery<PayrollRun>({
    queryKey: ["/api/payroll/runs", runId],
    queryFn: async () => {
      const res = await fetch(`/api/payroll/runs/${runId}`);
      if (!res.ok) throw new Error("Failed to fetch run");
      return res.json();
    },
    enabled: !!runId,
  });

  const { data: exceptions = [] } = useQuery<PayrollException[]>({
    queryKey: ["/api/payroll/runs", runId, "exceptions"],
    queryFn: async () => {
      const res = await fetch(`/api/payroll/runs/${runId}/exceptions`);
      if (!res.ok) throw new Error("Failed to fetch exceptions");
      return res.json();
    },
    enabled: !!runId,
  });

  const openExceptions = exceptions.filter((e) => e.status === "PENDING");
  const blockerCount = openExceptions.filter((e) => e.severity === "BLOCKER").length;
  const warningCount = openExceptions.filter((e) => e.severity === "WARNING").length;

  const recalculateMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", `/api/payroll/runs/${runId}/recalculate`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/runs", runId] });
      toast({ title: "Recalculation complete", description: "Payroll run has been recalculated." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", `/api/payroll/runs/${runId}/finalize`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/runs", runId] });
      toast({ title: "Run finalized", description: "Payroll run has been finalized and payslips generated." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const getStatusBadge = (status: string) => {
    const statusMap: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; label: string }> = {
      DRAFT: { variant: "secondary", label: "Draft" },
      CALCULATED: { variant: "outline", label: "Calculated" },
      REVIEWED: { variant: "default", label: "Reviewed" },
      FINALIZED: { variant: "default", label: "Finalized" },
    };
    const config = statusMap[status] || { variant: "secondary", label: status };
    return <Badge variant={config.variant}>{config.label}</Badge>;
  };

  const isPayrollAdmin = user?.role === "global_admin" || user?.role === "operator_admin" || user?.role === "admin";

  if (runLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (runError || !run) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>Failed to load run details. Please try again.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Link href={`/payroll/periods/${run.payrollPeriodId}`}>
          <Button variant="ghost" size="icon" data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">
            Payroll Run #{run.runNumber}
          </h1>
          <div className="flex items-center gap-2 mt-1">
            {getStatusBadge(run.status)}
            <span className="text-muted-foreground">
              Created: {format(new Date(run.createdAt), "d MMM yyyy HH:mm")}
            </span>
          </div>
        </div>
      </div>

      {blockerCount > 0 && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertDescription>
            There are {blockerCount} BLOCKER exceptions that must be resolved before finalizing.
          </AlertDescription>
        </Alert>
      )}

      {warningCount > 0 && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            There are {warningCount} WARNING exceptions that require review.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
            <CardTitle className="text-sm font-medium">Employees</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{run.totalEmployees}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
            <CardTitle className="text-sm font-medium">Gross Pay</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">฿{Number(run.totalGross || 0).toLocaleString()}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
            <CardTitle className="text-sm font-medium">Deductions</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">฿{Number(run.totalDeductions || 0).toLocaleString()}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
            <CardTitle className="text-sm font-medium">Net Pay</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">฿{Number(run.totalNet || 0).toLocaleString()}</div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap gap-3">
        {isPayrollAdmin && run.status !== "FINALIZED" && (
          <Button
            variant="outline"
            onClick={() => recalculateMutation.mutate()}
            disabled={recalculateMutation.isPending}
            data-testid="button-recalculate"
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            {recalculateMutation.isPending ? "Recalculating..." : "Recalculate"}
          </Button>
        )}

        {isPayrollAdmin && run.status !== "FINALIZED" && (
          <Button
            onClick={() => finalizeMutation.mutate()}
            disabled={blockerCount > 0 || finalizeMutation.isPending}
            data-testid="button-finalize"
          >
            <CheckCircle className="mr-2 h-4 w-4" />
            {finalizeMutation.isPending ? "Finalizing..." : "Finalize Run"}
          </Button>
        )}

        <Link href={`/payroll/runs/${runId}/exceptions`}>
          <Button variant="outline" data-testid="button-view-exceptions">
            <AlertTriangle className="mr-2 h-4 w-4" />
            Exceptions
            {openExceptions.length > 0 && (
              <Badge variant="secondary" className="ml-2">{openExceptions.length}</Badge>
            )}
          </Button>
        </Link>

        <Link href={`/payroll/runs/${runId}/employees`}>
          <Button variant="outline" data-testid="button-view-employees">
            <Users className="mr-2 h-4 w-4" />
            Employee Summaries
          </Button>
        </Link>

        <Link href={`/payroll/runs/${runId}/exports`}>
          <Button variant="outline" data-testid="button-exports">
            <Download className="mr-2 h-4 w-4" />
            Exports
          </Button>
        </Link>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="summary" data-testid="tab-summary">Summary</TabsTrigger>
          <TabsTrigger value="statutory" data-testid="tab-statutory">Statutory</TabsTrigger>
          <TabsTrigger value="audit" data-testid="tab-audit">Audit Log</TabsTrigger>
        </TabsList>

        <TabsContent value="summary" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Run Summary</CardTitle>
              <CardDescription>Overview of this payroll run</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">Status</p>
                  <p className="font-medium">{run.status}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Created</p>
                  <p className="font-medium">{format(new Date(run.createdAt), "d MMM yyyy HH:mm")}</p>
                </div>
                {run.calculatedAt && (
                  <div>
                    <p className="text-sm text-muted-foreground">Calculated</p>
                    <p className="font-medium">{format(new Date(run.calculatedAt), "d MMM yyyy HH:mm")}</p>
                  </div>
                )}
                {run.finalizedAt && (
                  <div>
                    <p className="text-sm text-muted-foreground">Finalized</p>
                    <p className="font-medium">{format(new Date(run.finalizedAt), "d MMM yyyy HH:mm")}</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="statutory" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Statutory Contributions</CardTitle>
              <CardDescription>Social Security and Tax withholdings</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="p-4 border rounded-md">
                  <p className="text-sm text-muted-foreground">SSO (Employee)</p>
                  <p className="text-xl font-bold">฿{Number(run.totalSsoEmployee || 0).toLocaleString()}</p>
                </div>
                <div className="p-4 border rounded-md">
                  <p className="text-sm text-muted-foreground">SSO (Employer)</p>
                  <p className="text-xl font-bold">฿{Number(run.totalSsoEmployer || 0).toLocaleString()}</p>
                </div>
                <div className="p-4 border rounded-md">
                  <p className="text-sm text-muted-foreground">Withholding Tax</p>
                  <p className="text-xl font-bold">฿{Number(run.totalTax || 0).toLocaleString()}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Audit Log</CardTitle>
              <CardDescription>History of changes to this run</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-sm text-muted-foreground text-center py-8">
                Audit log entries will appear here.
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
