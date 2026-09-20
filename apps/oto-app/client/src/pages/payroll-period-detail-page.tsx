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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import {
  ArrowLeft,
  Play,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Clock,
  Users,
  Download,
  Settings,
  FileText,
} from "lucide-react";

interface PayrollPeriod {
  id: string;
  operatorId: string;
  month: number;
  year: number;
  startDate: string;
  endDate: string;
  cutoffDate: string;
  status: string;
  createdAt: string;
}

interface PayrollRun {
  id: string;
  payrollPeriodId: string;
  runNumber: number;
  status: string;
  totalEmployees: number;
  totalGross: string;
  totalNet: string;
  totalDeductions: string;
  createdAt: string;
  calculatedAt: string | null;
  finalizedAt: string | null;
}

interface PayrollException {
  id: string;
  severity: string;
  status: string;
}

export default function PayrollPeriodDetailPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [, params] = useRoute("/payroll/periods/:periodId");
  const periodId = params?.periodId;
  const [activeTab, setActiveTab] = useState("overview");

  const { data: period, isLoading: periodLoading, error: periodError } = useQuery<PayrollPeriod>({
    queryKey: ["/api/payroll/periods", periodId],
    queryFn: async () => {
      const res = await fetch(`/api/payroll/periods/${periodId}`);
      if (!res.ok) throw new Error("Failed to fetch period");
      return res.json();
    },
    enabled: !!periodId,
  });

  const { data: runs = [], isLoading: runsLoading } = useQuery<PayrollRun[]>({
    queryKey: ["/api/payroll/periods", periodId, "runs"],
    queryFn: async () => {
      const res = await fetch(`/api/payroll/periods/${periodId}/runs`);
      if (!res.ok) throw new Error("Failed to fetch runs");
      return res.json();
    },
    enabled: !!periodId,
  });

  const latestRun = runs.length > 0 ? runs[runs.length - 1] : null;

  const { data: exceptions = [] } = useQuery<PayrollException[]>({
    queryKey: ["/api/payroll/runs", latestRun?.id, "exceptions"],
    queryFn: async () => {
      const res = await fetch(`/api/payroll/runs/${latestRun?.id}/exceptions`);
      if (!res.ok) throw new Error("Failed to fetch exceptions");
      return res.json();
    },
    enabled: !!latestRun?.id,
  });

  const openExceptions = exceptions.filter((e) => e.status === "PENDING");
  const blockerCount = openExceptions.filter((e) => e.severity === "BLOCKER").length;
  const warningCount = openExceptions.filter((e) => e.severity === "WARNING").length;

  const runPayrollMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", `/api/payroll/periods/${periodId}/runs`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/periods", periodId, "runs"] });
      toast({ title: "Payroll run started", description: "A new payroll run has been initiated." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const getStatusBadge = (status: string) => {
    const statusMap: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; label: string }> = {
      DRAFT: { variant: "secondary", label: "Draft" },
      OPEN: { variant: "default", label: "Open" },
      LOCKED: { variant: "outline", label: "Locked" },
      CLOSED: { variant: "default", label: "Closed" },
    };
    const config = statusMap[status] || { variant: "secondary", label: status };
    return <Badge variant={config.variant}>{config.label}</Badge>;
  };

  const getRunStatusBadge = (status: string) => {
    const statusMap: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; label: string }> = {
      DRAFT: { variant: "secondary", label: "Draft" },
      CALCULATED: { variant: "outline", label: "Calculated" },
      REVIEWED: { variant: "default", label: "Reviewed" },
      FINALIZED: { variant: "default", label: "Finalized" },
    };
    const config = statusMap[status] || { variant: "secondary", label: status };
    return <Badge variant={config.variant}>{config.label}</Badge>;
  };

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  const isPayrollAdmin = user?.role === "global_admin" || user?.role === "operator_admin" || user?.role === "admin";

  if (periodLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (periodError || !period) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>Failed to load period details. Please try again.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/payroll/periods">
          <Button variant="ghost" size="icon" data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">
            {monthNames[period.month - 1]} {period.year}
          </h1>
          <div className="flex items-center gap-2 mt-1">
            {getStatusBadge(period.status)}
            <span className="text-muted-foreground">
              Cutoff: {format(new Date(period.cutoffDate), "d MMM yyyy")}
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

      <div className="flex flex-wrap gap-3">
        {isPayrollAdmin && (
          <Button
            onClick={() => runPayrollMutation.mutate()}
            disabled={runPayrollMutation.isPending}
            data-testid="button-run-payroll"
          >
            <Play className="mr-2 h-4 w-4" />
            {runPayrollMutation.isPending ? "Running..." : "Run Payroll"}
          </Button>
        )}

        {latestRun && isPayrollAdmin && (
          <Button
            variant="outline"
            disabled={blockerCount > 0 || latestRun.status === "FINALIZED"}
            data-testid="button-finalize"
          >
            <CheckCircle className="mr-2 h-4 w-4" />
            Finalize Latest Run
          </Button>
        )}

        {latestRun && (
          <>
            <Link href={`/payroll/runs/${latestRun.id}/exceptions`}>
              <Button variant="outline" data-testid="button-view-exceptions">
                <AlertTriangle className="mr-2 h-4 w-4" />
                View Exceptions
                {openExceptions.length > 0 && (
                  <Badge variant="secondary" className="ml-2">{openExceptions.length}</Badge>
                )}
              </Button>
            </Link>
            <Link href={`/payroll/runs/${latestRun.id}/employees`}>
              <Button variant="outline" data-testid="button-view-employees">
                <Users className="mr-2 h-4 w-4" />
                Employee Summaries
              </Button>
            </Link>
          </>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="overview" data-testid="tab-overview">Overview</TabsTrigger>
          <TabsTrigger value="runs" data-testid="tab-runs">Runs</TabsTrigger>
          <TabsTrigger value="exports" data-testid="tab-exports">Exports</TabsTrigger>
          <TabsTrigger value="settings" data-testid="tab-settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4 mt-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
                <CardTitle className="text-sm font-medium">Period Details</CardTitle>
                <Clock className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Start:</span>
                  <span>{format(new Date(period.startDate), "d MMM yyyy")}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">End:</span>
                  <span>{format(new Date(period.endDate), "d MMM yyyy")}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Cutoff:</span>
                  <span>{format(new Date(period.cutoffDate), "d MMM yyyy")}</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
                <CardTitle className="text-sm font-medium">Latest Run</CardTitle>
                <Play className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                {latestRun ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-lg font-bold">Run #{latestRun.runNumber}</span>
                      {getRunStatusBadge(latestRun.status)}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {latestRun.totalEmployees} employees
                    </p>
                    <Link href={`/payroll/runs/${latestRun.id}`}>
                      <Button variant="link" className="px-0" data-testid="link-view-run">
                        View Details
                      </Button>
                    </Link>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No runs yet</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
                <CardTitle className="text-sm font-medium">Totals</CardTitle>
                <FileText className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                {latestRun ? (
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Gross:</span>
                      <span className="font-medium">฿{Number(latestRun.totalGross || 0).toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Deductions:</span>
                      <span>฿{Number(latestRun.totalDeductions || 0).toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between text-sm font-bold">
                      <span>Net:</span>
                      <span>฿{Number(latestRun.totalNet || 0).toLocaleString()}</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">--</p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="runs" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Run History</CardTitle>
              <CardDescription>{runs.length} run(s) for this period</CardDescription>
            </CardHeader>
            <CardContent>
              {runs.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No payroll runs yet. Click "Run Payroll" to create the first run.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Run #</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Employees</TableHead>
                      <TableHead>Gross</TableHead>
                      <TableHead>Net</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runs.map((run) => (
                      <TableRow key={run.id} data-testid={`row-run-${run.id}`}>
                        <TableCell className="font-medium">#{run.runNumber}</TableCell>
                        <TableCell>{getRunStatusBadge(run.status)}</TableCell>
                        <TableCell>{run.totalEmployees}</TableCell>
                        <TableCell>฿{Number(run.totalGross || 0).toLocaleString()}</TableCell>
                        <TableCell>฿{Number(run.totalNet || 0).toLocaleString()}</TableCell>
                        <TableCell>{format(new Date(run.createdAt), "d MMM, HH:mm")}</TableCell>
                        <TableCell className="text-right">
                          <Link href={`/payroll/runs/${run.id}`}>
                            <Button variant="ghost" size="sm" data-testid={`button-view-run-${run.id}`}>
                              View
                            </Button>
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="exports" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Exports</CardTitle>
              <CardDescription>Generate and download export files</CardDescription>
            </CardHeader>
            <CardContent>
              {latestRun ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Card>
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <h4 className="font-medium">Bank Transfer CSV</h4>
                          <p className="text-sm text-muted-foreground">Export for bank payment processing</p>
                        </div>
                        <Link href={`/payroll/runs/${latestRun.id}/exports`}>
                          <Button variant="outline" size="sm" data-testid="button-bank-export">
                            <Download className="mr-2 h-4 w-4" />
                            Generate
                          </Button>
                        </Link>
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <h4 className="font-medium">Accounting Journal</h4>
                          <p className="text-sm text-muted-foreground">Export for accounting software</p>
                        </div>
                        <Link href={`/payroll/runs/${latestRun.id}/exports`}>
                          <Button variant="outline" size="sm" data-testid="button-journal-export">
                            <Download className="mr-2 h-4 w-4" />
                            Generate
                          </Button>
                        </Link>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  Run payroll first to generate exports.
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="settings" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Period Settings</CardTitle>
              <CardDescription>Configure payroll rules for this period</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-sm text-muted-foreground">
                Settings configuration will be available in a future update.
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
