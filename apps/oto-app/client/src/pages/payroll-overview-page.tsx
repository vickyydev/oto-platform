import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { format, startOfMonth, endOfMonth, subMonths, addMonths } from "date-fns";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAuth } from "@/hooks/use-auth";
import {
  ChevronLeft,
  ChevronRight,
  Calendar,
  Play,
  AlertTriangle,
  Users,
  FileText,
  Download,
  Plus,
  DollarSign,
  Clock,
  CheckCircle,
  XCircle,
  Building2,
} from "lucide-react";

interface Operator {
  id: string;
  name: string;
  status: string;
}

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
}

interface PayrollException {
  id: string;
  severity: string;
  status: string;
}

export default function PayrollOverviewPage() {
  const { user } = useAuth();
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [selectedOperatorId, setSelectedOperatorId] = useState<string>("");

  const selectedMonth = selectedDate.getMonth() + 1;
  const selectedYear = selectedDate.getFullYear();

  const { data: operators = [] } = useQuery<Operator[]>({
    queryKey: ["/api/operators"],
  });

  // Set default operator when loaded
  if (operators.length > 0 && !selectedOperatorId) {
    const defaultOp = user?.operatorId || operators[0]?.id;
    if (defaultOp) {
      setTimeout(() => setSelectedOperatorId(defaultOp), 0);
    }
  }

  const { data: periods = [], isLoading: periodsLoading, error: periodsError } = useQuery<PayrollPeriod[]>({
    queryKey: ["/api/payroll/periods", { operatorId: selectedOperatorId }],
    queryFn: async () => {
      const res = await fetch(`/api/payroll/periods?operatorId=${selectedOperatorId}`);
      if (!res.ok) throw new Error("Failed to fetch periods");
      return res.json();
    },
    enabled: !!selectedOperatorId,
  });

  const currentPeriod = periods.find(
    (p) => p.month === selectedMonth && p.year === selectedYear
  );

  const { data: runs = [], isLoading: runsLoading } = useQuery<PayrollRun[]>({
    queryKey: ["/api/payroll/periods", currentPeriod?.id, "runs"],
    queryFn: async () => {
      const res = await fetch(`/api/payroll/periods/${currentPeriod?.id}/runs`);
      if (!res.ok) throw new Error("Failed to fetch runs");
      return res.json();
    },
    enabled: !!currentPeriod?.id,
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

  const navigateMonth = (direction: "prev" | "next") => {
    setSelectedDate((prev) =>
      direction === "prev" ? subMonths(prev, 1) : addMonths(prev, 1)
    );
  };

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

  const isPayrollAdmin = user?.role === "global_admin" || user?.role === "operator_admin" || user?.role === "admin";

  if (periodsLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      </div>
    );
  }

  if (periodsError) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>Failed to load payroll data. Please try again.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Payroll Overview</h1>
          <p className="text-muted-foreground">Manage payroll periods, runs, and employee payments</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <Select value={selectedOperatorId} onValueChange={setSelectedOperatorId}>
            <SelectTrigger className="w-[200px]" data-testid="select-operator">
              <SelectValue placeholder="Select Operator" />
            </SelectTrigger>
            <SelectContent>
              {operators.map((op) => (
                <SelectItem key={op.id} value={op.id}>
                  {op.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2 border rounded-md p-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigateMonth("prev")}
            data-testid="button-prev-month"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-2 px-3">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium min-w-[120px] text-center">
              {format(selectedDate, "MMMM yyyy")}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigateMonth("next")}
            data-testid="button-next-month"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
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

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
            <CardTitle className="text-sm font-medium">Period Status</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {currentPeriod ? (
              <div className="space-y-2">
                {getStatusBadge(currentPeriod.status)}
                <p className="text-xs text-muted-foreground">
                  Cutoff: {format(new Date(currentPeriod.cutoffDate), "d MMM yyyy")}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No period created</p>
            )}
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
                <p className="text-xs text-muted-foreground">
                  {format(new Date(latestRun.createdAt), "d MMM yyyy HH:mm")}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No runs yet</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
            <CardTitle className="text-sm font-medium">Open Exceptions</CardTitle>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="text-2xl font-bold">{openExceptions.length}</div>
              <div className="flex gap-2 text-xs">
                {blockerCount > 0 && (
                  <Badge variant="destructive">{blockerCount} Blockers</Badge>
                )}
                {warningCount > 0 && (
                  <Badge variant="secondary">{warningCount} Warnings</Badge>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
            <CardTitle className="text-sm font-medium">Totals</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {latestRun ? (
              <div className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Gross:</span>
                  <span className="font-medium">฿{Number(latestRun.totalGross || 0).toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Net:</span>
                  <span className="font-bold">฿{Number(latestRun.totalNet || 0).toLocaleString()}</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">--</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap gap-3">
        {!currentPeriod && isPayrollAdmin && (
          <Button data-testid="button-create-period">
            <Plus className="mr-2 h-4 w-4" />
            Create Period
          </Button>
        )}
        
        {currentPeriod && isPayrollAdmin && (
          <Button data-testid="button-run-payroll">
            <Play className="mr-2 h-4 w-4" />
            Run Payroll
          </Button>
        )}

        {currentPeriod && (
          <Link href={`/payroll/periods/${currentPeriod.id}`}>
            <Button variant="outline" data-testid="button-view-period">
              <FileText className="mr-2 h-4 w-4" />
              View Period Details
            </Button>
          </Link>
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
            <Link href={`/payroll/runs/${latestRun.id}/exports`}>
              <Button variant="outline" data-testid="button-view-exports">
                <Download className="mr-2 h-4 w-4" />
                Exports
              </Button>
            </Link>
          </>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Quick Links</CardTitle>
          <CardDescription>Navigate to payroll management sections</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Link href="/payroll/periods">
              <Card className="hover-elevate cursor-pointer">
                <CardContent className="flex items-center gap-3 p-4">
                  <Calendar className="h-8 w-8 text-primary" />
                  <div>
                    <h3 className="font-medium">All Periods</h3>
                    <p className="text-sm text-muted-foreground">View and manage payroll periods</p>
                  </div>
                </CardContent>
              </Card>
            </Link>
            
            <Link href="/my-payslips">
              <Card className="hover-elevate cursor-pointer">
                <CardContent className="flex items-center gap-3 p-4">
                  <FileText className="h-8 w-8 text-primary" />
                  <div>
                    <h3 className="font-medium">My Payslips</h3>
                    <p className="text-sm text-muted-foreground">View your personal payslips</p>
                  </div>
                </CardContent>
              </Card>
            </Link>

            {isPayrollAdmin && (
              <Card className="hover-elevate cursor-pointer">
                <CardContent className="flex items-center gap-3 p-4">
                  <CheckCircle className="h-8 w-8 text-primary" />
                  <div>
                    <h3 className="font-medium">Finalized Runs</h3>
                    <p className="text-sm text-muted-foreground">View completed payroll runs</p>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
