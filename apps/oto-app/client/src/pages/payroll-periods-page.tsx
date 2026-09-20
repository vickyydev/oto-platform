import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { format } from "date-fns";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import {
  Plus,
  AlertTriangle,
  Calendar,
  Building2,
  Eye,
  Edit,
  Lock,
  Unlock,
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
  createdAt: string;
}

export default function PayrollPeriodsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [selectedOperatorId, setSelectedOperatorId] = useState<string>("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newPeriodMonth, setNewPeriodMonth] = useState(new Date().getMonth() + 1);
  const [newPeriodYear, setNewPeriodYear] = useState(new Date().getFullYear());

  const { data: operators = [] } = useQuery<Operator[]>({
    queryKey: ["/api/operators"],
  });

  if (operators.length > 0 && !selectedOperatorId) {
    const defaultOp = user?.operatorId || operators[0]?.id;
    if (defaultOp) {
      setTimeout(() => setSelectedOperatorId(defaultOp), 0);
    }
  }

  const { data: periods = [], isLoading, error } = useQuery<PayrollPeriod[]>({
    queryKey: ["/api/payroll/periods", { operatorId: selectedOperatorId }],
    queryFn: async () => {
      const res = await fetch(`/api/payroll/periods?operatorId=${selectedOperatorId}`);
      if (!res.ok) throw new Error("Failed to fetch periods");
      return res.json();
    },
    enabled: !!selectedOperatorId,
  });

  const createPeriodMutation = useMutation({
    mutationFn: async (data: { operatorId: string; month: number; year: number }) => {
      return apiRequest("POST", "/api/payroll/periods", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/periods"] });
      setCreateDialogOpen(false);
      toast({ title: "Period created", description: "New payroll period has been created." });
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

  const isPayrollAdmin = user?.role === "global_admin" || user?.role === "operator_admin" || user?.role === "admin";

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

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
          <AlertDescription>Failed to load payroll periods. Please try again.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Payroll Periods</h1>
          <p className="text-muted-foreground">Manage monthly payroll periods</p>
        </div>

        <div className="flex items-center gap-4">
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

          {isPayrollAdmin && (
            <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
              <DialogTrigger asChild>
                <Button data-testid="button-create-period">
                  <Plus className="mr-2 h-4 w-4" />
                  Create Period
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create Payroll Period</DialogTitle>
                  <DialogDescription>
                    Create a new monthly payroll period for the selected operator.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid grid-cols-4 items-center gap-4">
                    <Label htmlFor="month" className="text-right">Month</Label>
                    <Select
                      value={String(newPeriodMonth)}
                      onValueChange={(v) => setNewPeriodMonth(Number(v))}
                    >
                      <SelectTrigger className="col-span-3" data-testid="select-month">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {monthNames.map((name, idx) => (
                          <SelectItem key={idx} value={String(idx + 1)}>
                            {name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-4 items-center gap-4">
                    <Label htmlFor="year" className="text-right">Year</Label>
                    <Input
                      id="year"
                      type="number"
                      value={newPeriodYear}
                      onChange={(e) => setNewPeriodYear(Number(e.target.value))}
                      className="col-span-3"
                      data-testid="input-year"
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    onClick={() => createPeriodMutation.mutate({
                      operatorId: selectedOperatorId,
                      month: newPeriodMonth,
                      year: newPeriodYear,
                    })}
                    disabled={createPeriodMutation.isPending}
                    data-testid="button-confirm-create"
                  >
                    {createPeriodMutation.isPending ? "Creating..." : "Create Period"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      {periods.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Calendar className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium">No Payroll Periods</h3>
            <p className="text-muted-foreground text-center mt-2">
              No payroll periods have been created for this operator yet.
              {isPayrollAdmin && " Click 'Create Period' to get started."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>All Periods</CardTitle>
            <CardDescription>{periods.length} payroll period(s) found</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead>Start Date</TableHead>
                  <TableHead>End Date</TableHead>
                  <TableHead>Cutoff</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {periods.map((period) => (
                  <TableRow key={period.id} data-testid={`row-period-${period.id}`}>
                    <TableCell className="font-medium">
                      {monthNames[period.month - 1]} {period.year}
                    </TableCell>
                    <TableCell>{format(new Date(period.startDate), "d MMM yyyy")}</TableCell>
                    <TableCell>{format(new Date(period.endDate), "d MMM yyyy")}</TableCell>
                    <TableCell>{format(new Date(period.cutoffDate), "d MMM yyyy")}</TableCell>
                    <TableCell>{getStatusBadge(period.status)}</TableCell>
                    <TableCell>{format(new Date(period.createdAt), "d MMM yyyy")}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Link href={`/payroll/periods/${period.id}`}>
                          <Button variant="ghost" size="icon" data-testid={`button-view-${period.id}`}>
                            <Eye className="h-4 w-4" />
                          </Button>
                        </Link>
                        {isPayrollAdmin && period.status === "DRAFT" && (
                          <Button variant="ghost" size="icon" data-testid={`button-edit-${period.id}`}>
                            <Edit className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
