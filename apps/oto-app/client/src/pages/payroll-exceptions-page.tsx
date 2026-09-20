import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
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
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import {
  ArrowLeft,
  AlertTriangle,
  XCircle,
  Info,
  Search,
  CheckCircle,
  Eye,
  Filter,
} from "lucide-react";

interface PayrollException {
  id: string;
  payrollRunId: string;
  employeeId: string;
  employeeName?: string;
  type: string;
  severity: string;
  status: string;
  message: string;
  date: string | null;
  varianceMinutes: number | null;
  varianceAmount: string | null;
  createdAt: string;
}

interface Employee {
  id: string;
  fullName: string;
  branchId: string;
}

export default function PayrollExceptionsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [, params] = useRoute("/payroll/runs/:runId/exceptions");
  const runId = params?.runId;

  const [searchTerm, setSearchTerm] = useState("");
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { data: exceptions = [], isLoading, error } = useQuery<PayrollException[]>({
    queryKey: ["/api/payroll/runs", runId, "exceptions"],
    queryFn: async () => {
      const res = await fetch(`/api/payroll/runs/${runId}/exceptions`);
      if (!res.ok) throw new Error("Failed to fetch exceptions");
      return res.json();
    },
    enabled: !!runId,
  });

  const { data: employees = [] } = useQuery<Employee[]>({
    queryKey: ["/api/employees"],
  });

  const employeeMap = new Map(employees.map((e) => [e.id, e.fullName]));

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

  const filteredExceptions = exceptions.filter((e) => {
    if (severityFilter !== "all" && e.severity !== severityFilter) return false;
    if (statusFilter !== "all" && e.status !== statusFilter) return false;
    if (typeFilter !== "all" && e.type !== typeFilter) return false;
    if (searchTerm) {
      const employeeName = employeeMap.get(e.employeeId) || "";
      if (!employeeName.toLowerCase().includes(searchTerm.toLowerCase()) &&
          !e.message.toLowerCase().includes(searchTerm.toLowerCase())) {
        return false;
      }
    }
    return true;
  });

  const toggleSelection = (id: string) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedIds(newSet);
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredExceptions.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredExceptions.map((e) => e.id)));
    }
  };

  const isPayrollAdmin = user?.role === "global_admin" || user?.role === "operator_admin" || user?.role === "admin";
  const canApprove = user?.role === "manager" || isPayrollAdmin;

  const uniqueTypes = [...new Set(exceptions.map((e) => e.type))];

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
          <AlertDescription>Failed to load exceptions. Please try again.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const blockerCount = exceptions.filter((e) => e.severity === "BLOCKER" && e.status === "PENDING").length;
  const warningCount = exceptions.filter((e) => e.severity === "WARNING" && e.status === "PENDING").length;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Link href={`/payroll/runs/${runId}`}>
          <Button variant="ghost" size="icon" data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Exceptions Queue</h1>
          <p className="text-muted-foreground">
            Review and resolve payroll exceptions
          </p>
        </div>
      </div>

      {blockerCount > 0 && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertDescription>
            {blockerCount} blocker exception(s) must be resolved before finalizing.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search employee or message..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
            data-testid="input-search"
          />
        </div>

        <Select value={severityFilter} onValueChange={setSeverityFilter}>
          <SelectTrigger className="w-[140px]" data-testid="select-severity">
            <SelectValue placeholder="Severity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Severities</SelectItem>
            <SelectItem value="BLOCKER">Blocker</SelectItem>
            <SelectItem value="WARNING">Warning</SelectItem>
            <SelectItem value="INFO">Info</SelectItem>
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[140px]" data-testid="select-status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="PENDING">Pending</SelectItem>
            <SelectItem value="APPROVED">Approved</SelectItem>
            <SelectItem value="REJECTED">Rejected</SelectItem>
            <SelectItem value="WAIVED">Waived</SelectItem>
          </SelectContent>
        </Select>

        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[160px]" data-testid="select-type">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            {uniqueTypes.map((type) => (
              <SelectItem key={type} value={type}>{type}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selectedIds.size > 0 && canApprove && (
        <div className="flex items-center gap-3 p-3 bg-muted rounded-md">
          <span className="text-sm font-medium">{selectedIds.size} selected</span>
          <Button size="sm" variant="outline" data-testid="button-bulk-approve">
            <CheckCircle className="mr-2 h-4 w-4" />
            Bulk Approve
          </Button>
          {isPayrollAdmin && (
            <Button size="sm" variant="outline" data-testid="button-bulk-waive">
              Bulk Waive
            </Button>
          )}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Exceptions</CardTitle>
          <CardDescription>
            {filteredExceptions.length} exception(s)
            {blockerCount > 0 && ` • ${blockerCount} blockers`}
            {warningCount > 0 && ` • ${warningCount} warnings`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {filteredExceptions.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <CheckCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <h3 className="text-lg font-medium">No Exceptions Found</h3>
              <p className="mt-2">
                {exceptions.length === 0
                  ? "There are no exceptions for this payroll run."
                  : "No exceptions match your current filters."}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">
                    <Checkbox
                      checked={selectedIds.size === filteredExceptions.length}
                      onCheckedChange={toggleSelectAll}
                      data-testid="checkbox-select-all"
                    />
                  </TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Employee</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Variance</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredExceptions.map((exception) => (
                  <TableRow key={exception.id} data-testid={`row-exception-${exception.id}`}>
                    <TableCell>
                      <Checkbox
                        checked={selectedIds.has(exception.id)}
                        onCheckedChange={() => toggleSelection(exception.id)}
                        data-testid={`checkbox-${exception.id}`}
                      />
                    </TableCell>
                    <TableCell>{getSeverityBadge(exception.severity)}</TableCell>
                    <TableCell className="font-medium">
                      {employeeMap.get(exception.employeeId) || "Unknown"}
                    </TableCell>
                    <TableCell>
                      {exception.date
                        ? format(new Date(exception.date), "d MMM")
                        : "Period"}
                    </TableCell>
                    <TableCell>{getTypeBadge(exception.type)}</TableCell>
                    <TableCell className="max-w-[200px] truncate" title={exception.message}>
                      {exception.message}
                    </TableCell>
                    <TableCell>
                      {exception.varianceMinutes !== null && (
                        <span className={exception.varianceMinutes < 0 ? "text-destructive" : ""}>
                          {exception.varianceMinutes > 0 ? "+" : ""}{exception.varianceMinutes}m
                        </span>
                      )}
                      {exception.varianceAmount && (
                        <span className="text-muted-foreground ml-1">
                          (฿{Number(exception.varianceAmount).toLocaleString()})
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{getStatusBadge(exception.status)}</TableCell>
                    <TableCell className="text-right">
                      <Link href={`/payroll/runs/${runId}/exceptions/${exception.id}`}>
                        <Button variant="ghost" size="icon" data-testid={`button-view-${exception.id}`}>
                          <Eye className="h-4 w-4" />
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
    </div>
  );
}
