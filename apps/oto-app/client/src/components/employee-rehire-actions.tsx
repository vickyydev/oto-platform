import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, RotateCcw } from "lucide-react";
import type { Branch, Department, Employee } from "@shared/schema";
import { roleCanPerformAction } from "@shared/permissions";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * SCRUM-794: Rehire on a Left profile, beside the status badge. It calls the
 * route on the server (server/employee-rehire-routes.ts), which holds the
 * right and the reach.
 */

const KEEP = "__keep__";

function refreshEmployee(employeeId: string) {
  queryClient.invalidateQueries({ queryKey: ["/api/employees", employeeId] });
  queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
}

export function RehireAction({ employee, branches, departments }: {
  employee: Employee;
  branches: Branch[] | undefined;
  departments: Department[] | undefined;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [positionTitle, setPositionTitle] = useState("");
  const [departmentId, setDepartmentId] = useState(KEEP);
  const [branchId, setBranchId] = useState(KEEP);

  const rehire = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/employees/${employee.id}/rehire`, {
        startDate,
        positionTitle: positionTitle.trim() || null,
        departmentId: departmentId === KEEP ? null : departmentId,
        branchId: branchId === KEEP ? null : branchId,
      });
      return res.json() as Promise<{ login: string; platformDeactivationDelivered: boolean }>;
    },
    onSuccess: (answer) => {
      setOpen(false);
      refreshEmployee(employee.id);
      queryClient.invalidateQueries({ queryKey: ["/api/employees", employee.id, "changes"] });
      const login = answer.login === "reactivated" ? " Their login is switched on again." : "";
      const platform = answer.platformDeactivationDelivered
        ? " Their suite sign-in was switched off on the platform; if it is still off, a platform administrator reactivates it there."
        : "";
      toast({ title: "Rehired", description: `The profile is active again.${login}${platform}` });
    },
    onError: (error: Error) => {
      toast({ title: "Could not rehire", description: error.message, variant: "destructive" });
    },
  });

  const left = employee.status === "resigned" || employee.status === "terminated";
  if (!left || !roleCanPerformAction(user?.role, "hr.terminate_employee", "hr")) return null;

  const openDialog = () => {
    setStartDate(new Date().toISOString().slice(0, 10));
    setPositionTitle((employee.defaultMergeData as { positionTitle?: string } | null)?.positionTitle ?? "");
    setDepartmentId(KEEP);
    setBranchId(KEEP);
    setOpen(true);
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={openDialog} data-testid="button-rehire-employee">
        <RotateCcw className="mr-2 h-4 w-4" />
        Rehire
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rehire</DialogTitle>
            <DialogDescription>
              Makes this profile active again and switches its login back on. Face enrolment, history, leave and documents stay as they are.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-2">
              <Label>Start date</Label>
              <DatePicker value={startDate} onChange={setStartDate} data-testid="input-rehire-start-date" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rehire-position">Position</Label>
              <Input id="rehire-position" value={positionTitle} onChange={(e) => setPositionTitle(e.target.value)} data-testid="input-rehire-position" />
            </div>
            <div className="space-y-2">
              <Label>Department</Label>
              <Select value={departmentId} onValueChange={setDepartmentId}>
                <SelectTrigger data-testid="select-rehire-department"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={KEEP}>Keep the current department</SelectItem>
                  {(departments ?? []).filter((d) => d.isActive).map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Branch</Label>
              <Select value={branchId} onValueChange={setBranchId}>
                <SelectTrigger data-testid="select-rehire-branch"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={KEEP}>Keep the current branch</SelectItem>
                  {(branches ?? []).map((b) => (
                    <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => rehire.mutate()} disabled={!startDate || rehire.isPending} data-testid="button-confirm-rehire">
              {rehire.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Rehire
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
