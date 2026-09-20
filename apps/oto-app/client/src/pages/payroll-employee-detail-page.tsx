import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
import {
  ArrowLeft,
  AlertTriangle,
  User,
  DollarSign,
  Clock,
  FileText,
  Calendar,
  Download,
} from "lucide-react";

interface PayrollSummary {
  id: string;
  payrollRunId: string;
  employeeId: string;
  grossPay: string;
  totalDeductions: string;
  netPay: string;
  ssoEmployee: string;
  ssoEmployer: string;
  withholdingTax: string;
  workedDays: number;
  workedMinutes: number;
  scheduledMinutes: number;
  overtimeMinutes: number;
  status: string;
}

interface PayrollLineItem {
  id: string;
  employeeSummaryId: string;
  type: string;
  category: string;
  description: string;
  amount: string;
  quantity: number | null;
  rate: string | null;
}

interface DayReconciliation {
  id: string;
  date: string;
  scheduledMinutes: number;
  actualMinutes: number;
  varianceMinutes: number;
  status: string;
}

interface PayrollException {
  id: string;
  type: string;
  severity: string;
  status: string;
  message: string;
  date: string | null;
}

interface Employee {
  id: string;
  fullName: string;
  branchId: string;
  status: string;
  defaultMergeData?: {
    salaryThb?: number;
    positionTitle?: string;
  };
}

export default function PayrollEmployeeDetailPage() {
  const { user } = useAuth();
  const [, params] = useRoute("/payroll/runs/:runId/employees/:employeeId");
  const runId = params?.runId;
  const employeeId = params?.employeeId;
  const [activeTab, setActiveTab] = useState("breakdown");

  const { data: summaries = [] } = useQuery<PayrollSummary[]>({
    queryKey: ["/api/payroll/runs", runId, "summaries"],
    queryFn: async () => {
      const res = await fetch(`/api/payroll/runs/${runId}/summaries`);
      if (!res.ok) throw new Error("Failed to fetch summaries");
      return res.json();
    },
    enabled: !!runId,
  });

  const summary = summaries.find((s) => s.employeeId === employeeId);

  const { data: lineItems = [] } = useQuery<PayrollLineItem[]>({
    queryKey: ["/api/payroll/summaries", summary?.id, "line-items"],
    queryFn: async () => {
      const res = await fetch(`/api/payroll/summaries/${summary?.id}/line-items`);
      if (!res.ok) throw new Error("Failed to fetch line items");
      return res.json();
    },
    enabled: !!summary?.id,
  });

  const { data: reconciliations = [] } = useQuery<DayReconciliation[]>({
    queryKey: ["/api/payroll/runs", runId, "employees", employeeId, "reconciliations"],
    queryFn: async () => {
      const res = await fetch(`/api/payroll/runs/${runId}/employees/${employeeId}/reconciliations`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!runId && !!employeeId,
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

  const employeeExceptions = exceptions.filter((e) => e.employeeId === employeeId);

  const { data: employees = [] } = useQuery<Employee[]>({
    queryKey: ["/api/employees"],
  });

  const employee = employees.find((e) => e.id === employeeId);

  const earnings = lineItems.filter((li) => li.category === "EARNING");
  const deductions = lineItems.filter((li) => li.category === "DEDUCTION");

  const isLoading = !summary && summaries.length === 0;

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>Employee summary not found for this payroll run.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <Link href={`/payroll/runs/${runId}/employees`}>
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">
              {employee?.fullName || "Employee"}
            </h1>
            <p className="text-muted-foreground">
              {employee?.defaultMergeData?.positionTitle || "Employee"} • Payroll Details
            </p>
          </div>
        </div>

        <Button variant="outline" data-testid="button-download-payslip">
          <Download className="mr-2 h-4 w-4" />
          Download Payslip
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
            <CardTitle className="text-sm font-medium">Gross Pay</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">฿{Number(summary.grossPay || 0).toLocaleString()}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
            <CardTitle className="text-sm font-medium">Deductions</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">฿{Number(summary.totalDeductions || 0).toLocaleString()}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
            <CardTitle className="text-sm font-medium">Net Pay</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">฿{Number(summary.netPay || 0).toLocaleString()}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
            <CardTitle className="text-sm font-medium">Days Worked</CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary.workedDays}</div>
            <p className="text-xs text-muted-foreground">
              {Math.floor(summary.workedMinutes / 60)}h {summary.workedMinutes % 60}m total
            </p>
          </CardContent>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="breakdown" data-testid="tab-breakdown">Pay Breakdown</TabsTrigger>
          <TabsTrigger value="reconciliation" data-testid="tab-reconciliation">Day Reconciliation</TabsTrigger>
          <TabsTrigger value="exceptions" data-testid="tab-exceptions">
            Exceptions
            {employeeExceptions.length > 0 && (
              <Badge variant="secondary" className="ml-2">{employeeExceptions.length}</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="breakdown" className="space-y-4 mt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Earnings</CardTitle>
                <CardDescription>Income components</CardDescription>
              </CardHeader>
              <CardContent>
                {earnings.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No earnings recorded</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Description</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {earnings.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell>{item.description}</TableCell>
                          <TableCell className="text-right">
                            ฿{Number(item.amount || 0).toLocaleString()}
                          </TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="font-bold">
                        <TableCell>Total Earnings</TableCell>
                        <TableCell className="text-right">
                          ฿{earnings.reduce((sum, e) => sum + Number(e.amount || 0), 0).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Deductions</CardTitle>
                <CardDescription>Statutory and other deductions</CardDescription>
              </CardHeader>
              <CardContent>
                {deductions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No deductions recorded</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Description</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {deductions.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell>{item.description}</TableCell>
                          <TableCell className="text-right text-destructive">
                            -฿{Number(item.amount || 0).toLocaleString()}
                          </TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="font-bold">
                        <TableCell>Total Deductions</TableCell>
                        <TableCell className="text-right text-destructive">
                          -฿{deductions.reduce((sum, d) => sum + Number(d.amount || 0), 0).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Statutory Contributions</CardTitle>
              <CardDescription>Social Security and Tax details</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="p-4 border rounded-md">
                  <p className="text-sm text-muted-foreground">SSO (Employee)</p>
                  <p className="text-xl font-bold">฿{Number(summary.ssoEmployee || 0).toLocaleString()}</p>
                </div>
                <div className="p-4 border rounded-md">
                  <p className="text-sm text-muted-foreground">SSO (Employer)</p>
                  <p className="text-xl font-bold">฿{Number(summary.ssoEmployer || 0).toLocaleString()}</p>
                </div>
                <div className="p-4 border rounded-md">
                  <p className="text-sm text-muted-foreground">Withholding Tax</p>
                  <p className="text-xl font-bold">฿{Number(summary.withholdingTax || 0).toLocaleString()}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="reconciliation" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Daily Reconciliation</CardTitle>
              <CardDescription>Scheduled vs Actual time comparison by day</CardDescription>
            </CardHeader>
            <CardContent>
              {reconciliations.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No daily reconciliation data available.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Scheduled</TableHead>
                      <TableHead className="text-right">Actual</TableHead>
                      <TableHead className="text-right">Variance</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reconciliations.map((rec) => (
                      <TableRow key={rec.id}>
                        <TableCell>{format(new Date(rec.date), "EEE, d MMM")}</TableCell>
                        <TableCell className="text-right">
                          {Math.floor(rec.scheduledMinutes / 60)}h {rec.scheduledMinutes % 60}m
                        </TableCell>
                        <TableCell className="text-right">
                          {Math.floor(rec.actualMinutes / 60)}h {rec.actualMinutes % 60}m
                        </TableCell>
                        <TableCell className={`text-right ${rec.varianceMinutes < 0 ? "text-destructive" : rec.varianceMinutes > 0 ? "text-primary" : ""}`}>
                          {rec.varianceMinutes > 0 ? "+" : ""}{rec.varianceMinutes}m
                        </TableCell>
                        <TableCell>
                          <Badge variant={rec.status === "OK" ? "default" : "secondary"}>
                            {rec.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="exceptions" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Exceptions</CardTitle>
              <CardDescription>Issues requiring attention for this employee</CardDescription>
            </CardHeader>
            <CardContent>
              {employeeExceptions.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No exceptions for this employee.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Severity</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Message</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {employeeExceptions.map((exc) => (
                      <TableRow key={exc.id}>
                        <TableCell>
                          <Badge variant={exc.severity === "BLOCKER" ? "destructive" : "secondary"}>
                            {exc.severity}
                          </Badge>
                        </TableCell>
                        <TableCell>{exc.type}</TableCell>
                        <TableCell>{exc.date ? format(new Date(exc.date), "d MMM") : "Period"}</TableCell>
                        <TableCell className="max-w-[300px] truncate">{exc.message}</TableCell>
                        <TableCell>
                          <Badge variant={exc.status === "PENDING" ? "secondary" : "default"}>
                            {exc.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
