import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { format, parseISO } from "date-fns";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Plus,
  Play,
  FileText,
  Download,
  Calculator,
  AlertTriangle,
  CheckCircle,
  Clock,
  XCircle,
  Banknote,
  Building2,
  Users,
  RefreshCw,
  Eye,
  ArrowRight,
  ChevronRight,
  ChevronDown,
} from "lucide-react";

type PayrollPeriod = {
  id: string;
  operatorId: string;
  countryCode: string;
  periodType: string;
  startDate: string;
  endDate: string;
  cutoffAt: string | null;
  status: string;
  createdAt: string;
};

type PayrollRun = {
  id: string;
  payrollPeriodId: string;
  runNumber: number;
  status: string;
  notes: string | null;
  createdAt: string;
  finalizedAt: string | null;
};

type PayrollSummary = {
  id: string;
  payrollRunId: string;
  employeeId: string;
  grossPay: string;
  taxableIncome: string;
  totalDeductions: string;
  netPay: string;
  employerCost: string;
  currency: string;
  status: string;
};

type PayrollException = {
  id: string;
  payrollRunId: string;
  employeeId: string;
  exceptionType: string;
  severity: string;
  message: string;
  status: string;
  workDate: string | null;
};

type Employee = {
  id: string;
  fullName: string;
  branchId: string;
};

type Operator = {
  id: string;
  name: string;
};

function formatCurrency(amount: string | number): string {
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  return new Intl.NumberFormat("th-TH", {
    style: "currency",
    currency: "THB",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(num);
}

function getStatusBadge(status: string) {
  const statusConfig: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; label: string }> = {
    DRAFT: { variant: "secondary", label: "Draft" },
    OPEN: { variant: "default", label: "Open" },
    LOCKED: { variant: "outline", label: "Locked" },
    CLOSED: { variant: "secondary", label: "Closed" },
    RECONCILED: { variant: "outline", label: "Reconciled" },
    CALCULATED: { variant: "default", label: "Calculated" },
    FINALIZED: { variant: "default", label: "Finalized" },
    APPROVED: { variant: "default", label: "Approved" },
    REJECTED: { variant: "destructive", label: "Rejected" },
  };
  const config = statusConfig[status] || { variant: "outline" as const, label: status };
  return <Badge variant={config.variant}>{config.label}</Badge>;
}

function getSeverityBadge(severity: string) {
  const config: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; label: string }> = {
    LOW: { variant: "secondary", label: "Low" },
    MEDIUM: { variant: "outline", label: "Medium" },
    HIGH: { variant: "default", label: "High" },
    CRITICAL: { variant: "destructive", label: "Critical" },
  };
  const c = config[severity] || { variant: "outline" as const, label: severity };
  return <Badge variant={c.variant}>{c.label}</Badge>;
}

export default function PayrollPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [selectedOperatorId, setSelectedOperatorId] = useState<string>("");
  const [selectedPeriodId, setSelectedPeriodId] = useState<string>("");
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [createPeriodOpen, setCreatePeriodOpen] = useState(false);
  const [newPeriodStart, setNewPeriodStart] = useState("");
  const [newPeriodEnd, setNewPeriodEnd] = useState("");
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());

  const { data: operators = [] } = useQuery<Operator[]>({
    queryKey: ["/api/operators"],
  });

  const { data: employees = [] } = useQuery<Employee[]>({
    queryKey: ["/api/employees"],
  });

  const { data: periods = [], isLoading: periodsLoading } = useQuery<PayrollPeriod[]>({
    queryKey: ["/api/payroll/periods", { operatorId: selectedOperatorId }],
    queryFn: async () => {
      const res = await fetch(`/api/payroll/periods?operatorId=${selectedOperatorId}`);
      if (!res.ok) throw new Error("Failed to fetch periods");
      return res.json();
    },
    enabled: !!selectedOperatorId,
  });

  const selectedPeriod = periods.find((p) => p.id === selectedPeriodId);

  const { data: runs = [], isLoading: runsLoading } = useQuery<PayrollRun[]>({
    queryKey: ["/api/payroll/periods", selectedPeriodId, "runs"],
    enabled: !!selectedPeriodId,
  });

  const { data: summaries = [], isLoading: summariesLoading } = useQuery<PayrollSummary[]>({
    queryKey: ["/api/payroll/runs", selectedRunId, "summaries"],
    enabled: !!selectedRunId,
  });

  const { data: exceptions = [] } = useQuery<PayrollException[]>({
    queryKey: ["/api/payroll/runs", selectedRunId, "exceptions"],
    enabled: !!selectedRunId,
  });

  const createPeriodMutation = useMutation({
    mutationFn: async (data: { operatorId: string; startDate: string; endDate: string }) => {
      const res = await apiRequest("POST", "/api/payroll/periods", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/periods"] });
      setCreatePeriodOpen(false);
      toast({ title: "Period created successfully" });
    },
    onError: (error: any) => {
      toast({ title: "Error creating period", description: error.message, variant: "destructive" });
    },
  });

  const createRunMutation = useMutation({
    mutationFn: async (periodId: string) => {
      const res = await apiRequest("POST", `/api/payroll/periods/${periodId}/runs`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/periods", selectedPeriodId, "runs"] });
      toast({ title: "Run created successfully" });
    },
    onError: (error: any) => {
      toast({ title: "Error creating run", description: error.message, variant: "destructive" });
    },
  });

  const reconcileMutation = useMutation({
    mutationFn: async (runId: string) => {
      const res = await apiRequest("POST", `/api/payroll/runs/${runId}/reconcile`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/periods", selectedPeriodId, "runs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/runs", selectedRunId, "summaries"] });
      toast({ title: "Reconciliation complete" });
    },
    onError: (error: any) => {
      toast({ title: "Reconciliation failed", description: error.message, variant: "destructive" });
    },
  });

  const calculateMutation = useMutation({
    mutationFn: async (runId: string) => {
      const res = await apiRequest("POST", `/api/payroll/runs/${runId}/calculate`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/periods", selectedPeriodId, "runs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/runs", selectedRunId, "summaries"] });
      toast({ title: "Calculation complete" });
    },
    onError: (error: any) => {
      toast({ title: "Calculation failed", description: error.message, variant: "destructive" });
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: async (runId: string) => {
      const res = await apiRequest("POST", `/api/payroll/runs/${runId}/finalize`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/periods", selectedPeriodId, "runs"] });
      toast({ title: "Payroll finalized" });
    },
    onError: (error: any) => {
      toast({ title: "Finalization failed", description: error.message, variant: "destructive" });
    },
  });

  const generatePayslipsMutation = useMutation({
    mutationFn: async (runId: string) => {
      const res = await apiRequest("POST", `/api/payroll/runs/${runId}/payslips/generate`);
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: `Generated ${data.generated || 0} payslips` });
    },
    onError: (error: any) => {
      toast({ title: "Payslip generation failed", description: error.message, variant: "destructive" });
    },
  });

  const exportBankTransferMutation = useMutation({
    mutationFn: async ({ runId, format }: { runId: string; format: string }) => {
      const res = await apiRequest("POST", `/api/payroll/runs/${runId}/export/bank-transfer`, { format });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.filePath) {
        toast({ title: "Bank transfer file generated", description: data.filePath });
      }
    },
    onError: (error: any) => {
      toast({ title: "Export failed", description: error.message, variant: "destructive" });
    },
  });

  const getEmployeeName = (employeeId: string) => {
    const emp = employees.find((e) => e.id === employeeId);
    return emp?.fullName || employeeId.slice(0, 8);
  };

  const toggleRunExpanded = (runId: string) => {
    const newExpanded = new Set(expandedRuns);
    if (newExpanded.has(runId)) {
      newExpanded.delete(runId);
    } else {
      newExpanded.add(runId);
    }
    setExpandedRuns(newExpanded);
  };

  const selectedRun = runs.find((r) => r.id === selectedRunId);
  const openExceptions = exceptions.filter((e) => e.status === "OPEN");
  const totalGross = summaries.reduce((acc, s) => acc + parseFloat(s.grossPay), 0);
  const totalNet = summaries.reduce((acc, s) => acc + parseFloat(s.netPay), 0);

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Payroll</h1>
          <p className="text-muted-foreground">Manage payroll periods, calculate pay, and generate payslips</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-4 items-center">
        <div className="w-64">
          <Label className="text-sm text-muted-foreground">Operator</Label>
          <Select value={selectedOperatorId} onValueChange={(v) => { setSelectedOperatorId(v); setSelectedPeriodId(""); setSelectedRunId(""); }}>
            <SelectTrigger data-testid="select-operator">
              <SelectValue placeholder="Select operator" />
            </SelectTrigger>
            <SelectContent>
              {operators.map((op) => (
                <SelectItem key={op.id} value={op.id}>{op.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {selectedOperatorId && (
          <div className="w-64">
            <Label className="text-sm text-muted-foreground">Period</Label>
            <Select value={selectedPeriodId} onValueChange={(v) => { setSelectedPeriodId(v); setSelectedRunId(""); }}>
              <SelectTrigger data-testid="select-period">
                <SelectValue placeholder="Select period" />
              </SelectTrigger>
              <SelectContent>
                {periods.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {format(parseISO(p.startDate), "MMM yyyy")} - {getStatusBadge(p.status)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {selectedOperatorId && (
          <Dialog open={createPeriodOpen} onOpenChange={setCreatePeriodOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" data-testid="button-create-period">
                <Plus className="w-4 h-4 mr-2" />
                New Period
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Payroll Period</DialogTitle>
                <DialogDescription>Create a new monthly payroll period</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div>
                  <Label>Start Date</Label>
                  <DatePicker
                    value={newPeriodStart}
                    onChange={setNewPeriodStart}
                    data-testid="input-period-start"
                  />
                </div>
                <div>
                  <Label>End Date</Label>
                  <DatePicker
                    value={newPeriodEnd}
                    onChange={setNewPeriodEnd}
                    data-testid="input-period-end"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => createPeriodMutation.mutate({
                    operatorId: selectedOperatorId,
                    startDate: newPeriodStart,
                    endDate: newPeriodEnd,
                  })}
                  disabled={!newPeriodStart || !newPeriodEnd || createPeriodMutation.isPending}
                  data-testid="button-confirm-create-period"
                >
                  {createPeriodMutation.isPending ? "Creating..." : "Create Period"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {selectedPeriodId && selectedPeriod && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Banknote className="w-5 h-5" />
                  Period: {format(parseISO(selectedPeriod.startDate), "MMMM yyyy")}
                </CardTitle>
                <CardDescription>
                  {format(parseISO(selectedPeriod.startDate), "dd MMM")} - {format(parseISO(selectedPeriod.endDate), "dd MMM yyyy")}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                {getStatusBadge(selectedPeriod.status)}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => createRunMutation.mutate(selectedPeriodId)}
                  disabled={createRunMutation.isPending}
                  data-testid="button-create-run"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  New Run
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {runsLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : runs.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Calculator className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No payroll runs yet. Create a run to start processing.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {runs.map((run) => (
                  <Card key={run.id} className={run.id === selectedRunId ? "border-primary" : ""}>
                    <CardHeader className="py-3">
                      <div className="flex items-center justify-between">
                        <div
                          className="flex items-center gap-2 cursor-pointer"
                          onClick={() => {
                            setSelectedRunId(run.id);
                            toggleRunExpanded(run.id);
                          }}
                          data-testid={`run-${run.runNumber}`}
                        >
                          {expandedRuns.has(run.id) ? (
                            <ChevronDown className="w-4 h-4" />
                          ) : (
                            <ChevronRight className="w-4 h-4" />
                          )}
                          <span className="font-medium">Run #{run.runNumber}</span>
                          {getStatusBadge(run.status)}
                          <span className="text-sm text-muted-foreground">
                            {format(parseISO(run.createdAt), "dd MMM HH:mm")}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          {run.status === "DRAFT" && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => reconcileMutation.mutate(run.id)}
                              disabled={reconcileMutation.isPending}
                              data-testid={`button-reconcile-${run.runNumber}`}
                            >
                              <RefreshCw className="w-4 h-4 mr-1" />
                              Reconcile
                            </Button>
                          )}
                          {run.status === "RECONCILED" && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => calculateMutation.mutate(run.id)}
                              disabled={calculateMutation.isPending}
                              data-testid={`button-calculate-${run.runNumber}`}
                            >
                              <Calculator className="w-4 h-4 mr-1" />
                              Calculate
                            </Button>
                          )}
                          {run.status === "CALCULATED" && (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => finalizeMutation.mutate(run.id)}
                                disabled={finalizeMutation.isPending}
                                data-testid={`button-finalize-${run.runNumber}`}
                              >
                                <CheckCircle className="w-4 h-4 mr-1" />
                                Finalize
                              </Button>
                            </>
                          )}
                          {run.status === "FINALIZED" && (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => generatePayslipsMutation.mutate(run.id)}
                                disabled={generatePayslipsMutation.isPending}
                                data-testid={`button-generate-payslips-${run.runNumber}`}
                              >
                                <FileText className="w-4 h-4 mr-1" />
                                Payslips
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => exportBankTransferMutation.mutate({ runId: run.id, format: "GENERIC" })}
                                disabled={exportBankTransferMutation.isPending}
                                data-testid={`button-export-bank-${run.runNumber}`}
                              >
                                <Download className="w-4 h-4 mr-1" />
                                Export
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    </CardHeader>
                    {expandedRuns.has(run.id) && run.id === selectedRunId && (
                      <CardContent className="pt-0">
                        <Tabs defaultValue="summaries">
                          <TabsList>
                            <TabsTrigger value="summaries" data-testid="tab-summaries">
                              <Users className="w-4 h-4 mr-1" />
                              Employees ({summaries.length})
                            </TabsTrigger>
                            <TabsTrigger value="exceptions" data-testid="tab-exceptions">
                              <AlertTriangle className="w-4 h-4 mr-1" />
                              Exceptions ({openExceptions.length})
                            </TabsTrigger>
                          </TabsList>

                          <TabsContent value="summaries" className="mt-4">
                            {summariesLoading ? (
                              <Skeleton className="h-32 w-full" />
                            ) : summaries.length === 0 ? (
                              <div className="text-center py-6 text-muted-foreground">
                                No employee summaries. Run reconciliation first.
                              </div>
                            ) : (
                              <div className="space-y-4">
                                <div className="flex gap-4">
                                  <Card className="flex-1">
                                    <CardHeader className="py-3">
                                      <CardDescription>Total Gross</CardDescription>
                                      <CardTitle className="text-lg">{formatCurrency(totalGross)}</CardTitle>
                                    </CardHeader>
                                  </Card>
                                  <Card className="flex-1">
                                    <CardHeader className="py-3">
                                      <CardDescription>Total Net</CardDescription>
                                      <CardTitle className="text-lg">{formatCurrency(totalNet)}</CardTitle>
                                    </CardHeader>
                                  </Card>
                                  <Card className="flex-1">
                                    <CardHeader className="py-3">
                                      <CardDescription>Employees</CardDescription>
                                      <CardTitle className="text-lg">{summaries.length}</CardTitle>
                                    </CardHeader>
                                  </Card>
                                </div>

                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>Employee</TableHead>
                                      <TableHead className="text-right">Gross Pay</TableHead>
                                      <TableHead className="text-right">Deductions</TableHead>
                                      <TableHead className="text-right">Net Pay</TableHead>
                                      <TableHead>Status</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {summaries.map((summary) => (
                                      <TableRow key={summary.id} data-testid={`summary-row-${summary.employeeId.slice(0, 8)}`}>
                                        <TableCell className="font-medium">
                                          {getEmployeeName(summary.employeeId)}
                                        </TableCell>
                                        <TableCell className="text-right">
                                          {formatCurrency(summary.grossPay)}
                                        </TableCell>
                                        <TableCell className="text-right text-destructive">
                                          -{formatCurrency(summary.totalDeductions)}
                                        </TableCell>
                                        <TableCell className="text-right font-medium">
                                          {formatCurrency(summary.netPay)}
                                        </TableCell>
                                        <TableCell>{getStatusBadge(summary.status)}</TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>
                            )}
                          </TabsContent>

                          <TabsContent value="exceptions" className="mt-4">
                            {exceptions.length === 0 ? (
                              <div className="text-center py-6 text-muted-foreground flex flex-col items-center">
                                <CheckCircle className="w-8 h-8 mb-2 text-green-500" />
                                No exceptions found
                              </div>
                            ) : (
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>Employee</TableHead>
                                    <TableHead>Type</TableHead>
                                    <TableHead>Severity</TableHead>
                                    <TableHead>Message</TableHead>
                                    <TableHead>Status</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {exceptions.map((exc) => (
                                    <TableRow key={exc.id} data-testid={`exception-row-${exc.id.slice(0, 8)}`}>
                                      <TableCell>{getEmployeeName(exc.employeeId)}</TableCell>
                                      <TableCell>
                                        <Badge variant="outline">{exc.exceptionType.replace(/_/g, " ")}</Badge>
                                      </TableCell>
                                      <TableCell>{getSeverityBadge(exc.severity)}</TableCell>
                                      <TableCell className="max-w-xs truncate">{exc.message}</TableCell>
                                      <TableCell>{getStatusBadge(exc.status)}</TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            )}
                          </TabsContent>
                        </Tabs>
                      </CardContent>
                    )}
                  </Card>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {!selectedOperatorId && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Building2 className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>Select an operator to view payroll periods</p>
          </CardContent>
        </Card>
      )}

      {selectedOperatorId && !selectedPeriodId && periodsLoading && (
        <Card>
          <CardContent className="py-8">
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      )}

      {selectedOperatorId && !selectedPeriodId && !periodsLoading && periods.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Clock className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>No payroll periods found. Create a new period to get started.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
