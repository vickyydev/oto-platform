import { useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Employee, Branch, EmployeeChange, Department } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrency } from "@/lib/format-utils";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, DollarSign, Briefcase, Building2, FileText, Users, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

const changeTypes = [
  { value: "salary_adjustment", label: "Salary Adjustment", icon: DollarSign },
  { value: "title_change", label: "Title/Position Change", icon: Briefcase },
  { value: "incentive_change", label: "Incentive Clause Update", icon: FileText },
  { value: "branch_transfer", label: "Branch Transfer", icon: Building2 },
] as const;

const updateTermsSchema = z.object({
  changeType: z.enum(["salary_adjustment", "title_change", "incentive_change", "branch_transfer"]),
  effectiveDate: z.string().min(1, "Effective date is required"),
  newSalary: z.number().optional(),
  newTitle: z.string().optional(),
  newIncentiveClause: z.string().optional(),
  newBranchId: z.string().optional(),
  newDepartmentId: z.string().optional(),
  note: z.string().optional(),
});

type UpdateTermsFormData = z.infer<typeof updateTermsSchema>;

interface UpdateTermsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: Employee;
  onSuccess?: (change: EmployeeChange) => void;
}

export function UpdateTermsModal({ open, onOpenChange, employee, onSuccess }: UpdateTermsModalProps) {
  const { toast } = useToast();
  const [showContractPrompt, setShowContractPrompt] = useState(false);
  const [lastChange, setLastChange] = useState<EmployeeChange | null>(null);
  const [transferResult, setTransferResult] = useState<{ deletedAssignments: number; deletedTimeOff: number } | null>(null);

  const { data: branches } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const mergeData = employee.defaultMergeData as any;

  const form = useForm<UpdateTermsFormData>({
    resolver: zodResolver(updateTermsSchema),
    defaultValues: {
      changeType: "salary_adjustment",
      effectiveDate: new Date().toISOString().split('T')[0],
      newSalary: mergeData?.salaryThb || undefined,
      newTitle: mergeData?.positionTitle || "",
      newIncentiveClause: employee.incentiveClauseText || "",
      newBranchId: employee.branchId || "",
      newDepartmentId: employee.primaryDepartmentId || "",
      note: "",
    },
  });

  const changeType = form.watch("changeType");
  const selectedBranchId = form.watch("newBranchId");

  // Fetch departments for selected branch when doing branch transfer
  const { data: branchDepartments } = useQuery<Department[]>({
    queryKey: ["/api/branches", selectedBranchId, "departments"],
    enabled: changeType === "branch_transfer" && !!selectedBranchId,
  });

  // Reset department when branch changes
  useEffect(() => {
    if (changeType === "branch_transfer" && selectedBranchId !== employee.branchId) {
      form.setValue("newDepartmentId", "");
    }
  }, [selectedBranchId, changeType, employee.branchId, form]);

  const createChangeMutation = useMutation({
    mutationFn: async (data: UpdateTermsFormData) => {
      const res = await apiRequest("POST", `/api/employees/${employee.id}/changes`, data);
      return await res.json();
    },
    onSuccess: (change: EmployeeChange) => {
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", employee.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", employee.id, "changes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activity"] });
      
      setLastChange(change);
      setShowContractPrompt(true);
      
      toast({
        title: "Terms updated",
        description: "Employee terms have been updated successfully.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Separate mutation for branch transfers (uses transfer endpoint with schedule cleanup)
  const transferMutation = useMutation({
    mutationFn: async (data: UpdateTermsFormData) => {
      const res = await apiRequest("POST", `/api/employees/${employee.id}/transfer`, {
        effectiveDate: data.effectiveDate,
        newBranchId: data.newBranchId,
        newDepartmentId: data.newDepartmentId || null,
        note: data.note,
      });
      return await res.json();
    },
    onSuccess: (result: { success: boolean; deletedAssignments: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", employee.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", employee.id, "changes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activity"] });
      queryClient.invalidateQueries({ queryKey: ["/api/schedule"] });
      
      setTransferResult({ 
        deletedAssignments: result.deletedAssignments || 0,
        deletedTimeOff: result.deletedTimeOff || 0
      });
      setShowContractPrompt(true);
      
      const removedItems = [];
      if (result.deletedAssignments > 0) removedItems.push(`${result.deletedAssignments} schedule assignment(s)`);
      if (result.deletedTimeOff > 0) removedItems.push(`${result.deletedTimeOff} time off request(s)`);
      
      toast({
        title: "Transfer completed",
        description: `Employee has been transferred successfully.${removedItems.length > 0 ? ` Removed: ${removedItems.join(', ')}.` : ''}`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Transfer failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: UpdateTermsFormData) => {
    if (data.changeType === "branch_transfer") {
      // Client-side validation for branch transfer
      if (!data.newBranchId) {
        toast({
          title: "Validation Error",
          description: "Please select a new branch",
          variant: "destructive",
        });
        return;
      }
      // Check if there's actually a change
      const branchChanged = data.newBranchId !== employee.branchId;
      const deptChanged = data.newDepartmentId !== (employee.primaryDepartmentId || "");
      if (!branchChanged && !deptChanged) {
        toast({
          title: "No Changes",
          description: "Please select a different branch or department",
          variant: "destructive",
        });
        return;
      }
      transferMutation.mutate(data);
    } else {
      createChangeMutation.mutate(data);
    }
  };

  const isPending = createChangeMutation.isPending || transferMutation.isPending;

  const handleClose = () => {
    form.reset();
    setShowContractPrompt(false);
    setLastChange(null);
    setTransferResult(null);
    onOpenChange(false);
    if (lastChange) {
      onSuccess?.(lastChange);
    }
  };

  const handleGenerateContract = () => {
    handleClose();
    window.location.href = `/contracts/new?employeeId=${employee.id}`;
  };

  if (showContractPrompt) {
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {transferResult ? "Transfer Complete" : "Generate New Contract?"}
            </DialogTitle>
            <DialogDescription>
              {transferResult 
                ? (() => {
                    const items = [];
                    if (transferResult.deletedAssignments > 0) items.push(`${transferResult.deletedAssignments} schedule assignment(s)`);
                    if (transferResult.deletedTimeOff > 0) items.push(`${transferResult.deletedTimeOff} time off request(s)`);
                    return `Employee has been transferred successfully.${items.length > 0 ? ` Removed: ${items.join(', ')}.` : ''}`;
                  })()
                : "The employment terms have been updated. Would you like to generate a new contract reflecting these changes?"
              }
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-muted-foreground">
              {transferResult
                ? "A new contract may be needed to reflect the change in work location."
                : "A new contract will supersede any existing active contract for this employee once signed."
              }
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={handleClose} data-testid="button-skip-contract">
              {transferResult ? "Done" : "Not Now"}
            </Button>
            <Button onClick={handleGenerateContract} data-testid="button-generate-contract">
              Generate Contract
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Update Employment Terms</DialogTitle>
          <DialogDescription>
            Record a change to {employee.fullName}'s employment terms
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="changeType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Change Type</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="select-change-type">
                        <SelectValue placeholder="Select change type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {changeTypes.map((type) => (
                        <SelectItem key={type.value} value={type.value}>
                          <div className="flex items-center gap-2">
                            <type.icon className="h-4 w-4" />
                            {type.label}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="effectiveDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Effective Date</FormLabel>
                  <FormControl>
                    <DatePicker
                      value={field.value || ""}
                      onChange={field.onChange}
                      data-testid="input-effective-date"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {changeType === "salary_adjustment" && (
              <FormField
                control={form.control}
                name="newSalary"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>New Monthly Salary (THB)</FormLabel>
                    <FormControl>
                      <CurrencyInput
                        placeholder="e.g., 50,000"
                        value={field.value}
                        onChange={field.onChange}
                        data-testid="input-new-salary"
                      />
                    </FormControl>
                    <FormDescription>
                      Current: {formatCurrency(mergeData?.salaryThb)} THB
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {changeType === "title_change" && (
              <FormField
                control={form.control}
                name="newTitle"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>New Position Title</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="e.g., Senior Developer"
                        {...field}
                        data-testid="input-new-title"
                      />
                    </FormControl>
                    <FormDescription>
                      Current: {mergeData?.positionTitle || "Not set"}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {changeType === "incentive_change" && (
              <FormField
                control={form.control}
                name="newIncentiveClause"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>New Incentive Clause</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Describe the incentive terms..."
                        className="min-h-[100px]"
                        {...field}
                        data-testid="input-new-incentive"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {changeType === "branch_transfer" && (
              <>
                <Alert variant="default" className="bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  <AlertDescription className="text-amber-800 dark:text-amber-200">
                    This is a permanent transfer. Future schedule assignments will be removed and user access will be updated.
                  </AlertDescription>
                </Alert>
                
                <FormField
                  control={form.control}
                  name="newBranchId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>New Branch</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-new-branch">
                            <SelectValue placeholder="Select branch" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {branches?.map((branch) => (
                            <SelectItem key={branch.id} value={branch.id}>
                              {branch.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        Current: {branches?.find(b => b.id === employee.branchId)?.name || "Not assigned"}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="newDepartmentId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>New Department (Optional)</FormLabel>
                      <Select 
                        onValueChange={(val) => field.onChange(val === "__none__" ? "" : val)} 
                        value={field.value || "__none__"}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-new-department">
                            <SelectValue placeholder="Select department" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="__none__">No department</SelectItem>
                          {branchDepartments?.map((dept) => (
                            <SelectItem key={dept.id} value={dept.id}>
                              {dept.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        {branchDepartments && branchDepartments.length === 0 
                          ? "No departments available for this branch"
                          : "Select the employee's new department at the destination branch"}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Note (Optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Add any additional notes about this change..."
                      {...field}
                      data-testid="input-change-note"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                data-testid="button-cancel-terms"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isPending}
                data-testid="button-save-terms"
              >
                {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {changeType === "branch_transfer" ? "Transfer Employee" : "Save Changes"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
