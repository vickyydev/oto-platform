import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRoute } from "wouter";
import { format } from "date-fns";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import {
  ArrowLeft,
  AlertTriangle,
  Search,
  Eye,
  Users,
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

interface Employee {
  id: string;
  fullName: string;
  branchId: string;
  status: string;
}

interface Branch {
  id: string;
  name: string;
}

export default function PayrollEmployeesPage() {
  const { user } = useAuth();
  const [, params] = useRoute("/payroll/runs/:runId/employees");
  const runId = params?.runId;

  const [searchTerm, setSearchTerm] = useState("");
  const [branchFilter, setBranchFilter] = useState<string>("all");

  const { data: summaries = [], isLoading, error } = useQuery<PayrollSummary[]>({
    queryKey: ["/api/payroll/runs", runId, "summaries"],
    queryFn: async () => {
      const res = await fetch(`/api/payroll/runs/${runId}/summaries`);
      if (!res.ok) throw new Error("Failed to fetch summaries");
      return res.json();
    },
    enabled: !!runId,
  });

  const { data: employees = [] } = useQuery<Employee[]>({
    queryKey: ["/api/employees"],
  });

  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const employeeMap = new Map(employees.map((e) => [e.id, e]));
  const branchMap = new Map(branches.map((b) => [b.id, b.name]));

  const filteredSummaries = summaries.filter((s) => {
    const emp = employeeMap.get(s.employeeId);
    if (!emp) return false;
    
    if (branchFilter !== "all" && emp.branchId !== branchFilter) return false;
    
    if (searchTerm) {
      if (!emp.fullName.toLowerCase().includes(searchTerm.toLowerCase())) {
        return false;
      }
    }
    return true;
  });

  const totals = filteredSummaries.reduce(
    (acc, s) => ({
      gross: acc.gross + Number(s.grossPay || 0),
      deductions: acc.deductions + Number(s.totalDeductions || 0),
      net: acc.net + Number(s.netPay || 0),
      sso: acc.sso + Number(s.ssoEmployee || 0),
      tax: acc.tax + Number(s.withholdingTax || 0),
    }),
    { gross: 0, deductions: 0, net: 0, sso: 0, tax: 0 }
  );

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>Failed to load employee summaries. Please try again.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <Link href={`/payroll/runs/${runId}`}>
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">Employee Summaries</h1>
            <p className="text-muted-foreground">
              View payroll breakdown for each employee
            </p>
          </div>
        </div>

        <Button variant="outline" data-testid="button-export">
          <Download className="mr-2 h-4 w-4" />
          Export CSV
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Employees</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{filteredSummaries.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Gross</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">฿{totals.gross.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Deductions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">฿{totals.deductions.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total SSO</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">฿{totals.sso.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Net</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">฿{totals.net.toLocaleString()}</div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search employee..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
            data-testid="input-search"
          />
        </div>

        <Select value={branchFilter} onValueChange={setBranchFilter}>
          <SelectTrigger className="w-[200px]" data-testid="select-branch">
            <SelectValue placeholder="All Branches" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Branches</SelectItem>
            {branches.map((branch) => (
              <SelectItem key={branch.id} value={branch.id}>
                {branch.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Employee Payroll</CardTitle>
          <CardDescription>{filteredSummaries.length} employee(s)</CardDescription>
        </CardHeader>
        <CardContent>
          {filteredSummaries.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <h3 className="text-lg font-medium">No Employees Found</h3>
              <p className="mt-2">
                {summaries.length === 0
                  ? "No employee summaries available for this run."
                  : "No employees match your current filters."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Employee</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead className="text-right">Worked Days</TableHead>
                    <TableHead className="text-right">Hours</TableHead>
                    <TableHead className="text-right">Gross</TableHead>
                    <TableHead className="text-right">SSO</TableHead>
                    <TableHead className="text-right">Tax</TableHead>
                    <TableHead className="text-right">Net</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredSummaries.map((summary) => {
                    const emp = employeeMap.get(summary.employeeId);
                    return (
                      <TableRow key={summary.id} data-testid={`row-employee-${summary.employeeId}`}>
                        <TableCell className="font-medium">
                          {emp?.fullName || "Unknown"}
                        </TableCell>
                        <TableCell>
                          {emp?.branchId ? branchMap.get(emp.branchId) || "—" : "—"}
                        </TableCell>
                        <TableCell className="text-right">{summary.workedDays}</TableCell>
                        <TableCell className="text-right">
                          {Math.floor(summary.workedMinutes / 60)}h {summary.workedMinutes % 60}m
                        </TableCell>
                        <TableCell className="text-right">
                          ฿{Number(summary.grossPay || 0).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          ฿{Number(summary.ssoEmployee || 0).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          ฿{Number(summary.withholdingTax || 0).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right font-bold">
                          ฿{Number(summary.netPay || 0).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <Link href={`/payroll/runs/${runId}/employees/${summary.employeeId}`}>
                            <Button variant="ghost" size="icon" data-testid={`button-view-${summary.employeeId}`}>
                              <Eye className="h-4 w-4" />
                            </Button>
                          </Link>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
