import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Edit, Loader2, Plus, Power, PowerOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

export type LeaveAccrualMethod = "YEARLY" | "WORKDAYS" | "NONE";
export type LeaveType = {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  accrualMethod: LeaveAccrualMethod;
  annualDays: number;
  waitingMonths: number;
  prorateByStartDate: boolean;
  daysWorkedRequired: number;
  daysOffEarned: number;
};

type LeaveTypeForm = Omit<LeaveType, "id" | "isActive"> & { isActive: boolean };
const emptyForm: LeaveTypeForm = {
  code: "",
  name: "",
  isActive: true,
  accrualMethod: "YEARLY",
  annualDays: 0,
  waitingMonths: 0,
  prorateByStartDate: false,
  daysWorkedRequired: 5,
  daysOffEarned: 2,
};

export function useLeaveTypes() {
  return useQuery<LeaveType[]>({ queryKey: ["/api/leave-types"] });
}

export function LeaveTypesManager() {
  const { toast } = useToast();
  const { data: leaveTypes = [], isLoading, isError, error } = useLeaveTypes();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<LeaveType | null>(null);
  const [form, setForm] = useState<LeaveTypeForm>(emptyForm);

  const saveMutation = useMutation({
    mutationFn: async (values: LeaveTypeForm) => {
      const body = {
        ...values,
        code: values.code.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^_+|_+$/g, ""),
        name: values.name.trim(),
      };
      const response = await apiRequest(editing ? "PATCH" : "POST", editing ? `/api/leave-types/${editing.id}` : "/api/leave-types", body);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/leave-types"] });
      toast({ title: editing ? "Leave type updated" : "Leave type created" });
      setOpen(false);
    },
    onError: (error: Error) => toast({ title: "Unable to save leave type", description: error.message, variant: "destructive" }),
  });

  const statusMutation = useMutation({
    mutationFn: async (type: LeaveType) => {
      const response = await apiRequest("PATCH", `/api/leave-types/${type.id}`, { isActive: !type.isActive });
      return response.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/leave-types"] }),
    onError: (error: Error) => toast({ title: "Unable to update leave type", description: error.message, variant: "destructive" }),
  });

  const openNew = () => {
    setEditing(null);
    setForm(emptyForm);
    setOpen(true);
  };
  const openEdit = (type: LeaveType) => {
    setEditing(type);
    setForm({
      code: type.code,
      name: type.name,
      isActive: type.isActive,
      accrualMethod: type.accrualMethod,
      annualDays: type.annualDays ?? 0,
      waitingMonths: type.waitingMonths ?? 0,
      prorateByStartDate: type.prorateByStartDate,
      daysWorkedRequired: type.daysWorkedRequired ?? 5,
      daysOffEarned: type.daysOffEarned ?? 2,
    });
    setOpen(true);
  };
  const setNumber = (key: "annualDays" | "waitingMonths" | "daysWorkedRequired" | "daysOffEarned", value: string) => {
    setForm((current) => ({ ...current, [key]: value === "" ? 0 : Number(value) }));
  };
  const valid = form.name.trim().length > 0
    && form.code.trim().length > 0
    && (form.accrualMethod !== "YEARLY" || (form.annualDays >= 0 && form.annualDays <= 365))
    && (form.accrualMethod !== "WORKDAYS" || (form.daysWorkedRequired >= 1 && form.daysOffEarned >= 1));

  return (
    <>
      <Card data-testid="card-leave-types">
        <CardHeader>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <CardTitle>Leave Types</CardTitle>
              <CardDescription>Create the leave categories employees earn and book. New employees start with no balance; accrual follows each type’s rules.</CardDescription>
            </div>
            <Button onClick={openNew} data-testid="button-add-leave-type"><Plus className="mr-2 h-4 w-4" />Add leave type</Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? <div className="text-sm text-muted-foreground">Loading leave types…</div> : isError ? (
            <p className="text-sm text-destructive">Could not load leave types: {error instanceof Error ? error.message : "Please try again."}</p>
          ) : leaveTypes.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">No leave types configured yet. Add one to define how staff earn and book leave.</div>
          ) : (
            <div className="space-y-3">
              {leaveTypes.map((type) => (
                <div key={type.id} className="flex items-center justify-between gap-3 rounded-lg border p-4" data-testid={`leave-type-${type.code}`}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{type.name}</span>
                      <Badge variant={type.isActive ? "default" : "secondary"}>{type.isActive ? "Active" : "Disabled"}</Badge>
                      <Badge variant="outline">{type.code}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {type.accrualMethod === "YEARLY" && `${type.annualDays} days per year${type.prorateByStartDate ? ", prorated from start date" : ""}`}
                      {type.accrualMethod === "WORKDAYS" && `Every ${type.daysWorkedRequired} days worked earns ${type.daysOffEarned} days off`}
                      {type.accrualMethod === "NONE" && "No automatic accrual"}
                      {type.waitingMonths > 0 && ` · Starts after ${type.waitingMonths} months`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="ghost" size="icon" aria-label={`Edit ${type.name}`} onClick={() => openEdit(type)}><Edit className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon" aria-label={`${type.isActive ? "Disable" : "Enable"} ${type.name}`} disabled={statusMutation.isPending} onClick={() => statusMutation.mutate(type)}>
                      {type.isActive ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit leave type" : "Create leave type"}</DialogTitle>
            <DialogDescription>Set the rules in plain language. New hires build their balance from their start date.</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="leave-type-name">Name</Label>
              <Input id="leave-type-name" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value, code: editing ? current.code : event.target.value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") }))} placeholder="e.g. Annual Leave" maxLength={100} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="leave-type-code">Booking code</Label>
              <Input id="leave-type-code" value={form.code} onChange={(event) => setForm((current) => ({ ...current, code: event.target.value }))} placeholder="e.g. ANNUAL" maxLength={60} disabled={!!editing} />
              <p className="text-xs text-muted-foreground">Used to store time-off records. Existing codes are preserved when a name changes.</p>
            </div>
            <div className="grid gap-2">
              <Label>How does this leave accrue?</Label>
              <Select value={form.accrualMethod} onValueChange={(value: LeaveAccrualMethod) => setForm((current) => ({ ...current, accrualMethod: value }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="YEARLY">A yearly entitlement</SelectItem>
                  <SelectItem value="WORKDAYS">Earned by days worked</SelectItem>
                  <SelectItem value="NONE">No automatic accrual</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.accrualMethod === "YEARLY" && (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="leave-type-annual-days">Entitlement per year (days)</Label>
                  <Input id="leave-type-annual-days" type="number" min={0} max={365} step="0.25" value={form.annualDays} onChange={(event) => setNumber("annualDays", event.target.value)} />
                </div>
                <div className="flex items-center justify-between gap-3 rounded-md border p-3">
                  <div><Label htmlFor="leave-type-prorate">Prorate for a mid-year start</Label><p className="text-xs text-muted-foreground">Earn a proportion of the yearly amount based on start date.</p></div>
                  <Switch id="leave-type-prorate" checked={form.prorateByStartDate} onCheckedChange={(checked) => setForm((current) => ({ ...current, prorateByStartDate: checked }))} />
                </div>
              </>
            )}
            {form.accrualMethod === "WORKDAYS" && (
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2"><Label htmlFor="leave-days-worked-required">Days worked required</Label><Input id="leave-days-worked-required" type="number" min={1} step="1" value={form.daysWorkedRequired} onChange={(event) => setNumber("daysWorkedRequired", event.target.value)} /></div>
                <div className="grid gap-2"><Label htmlFor="leave-days-earned">Days off earned</Label><Input id="leave-days-earned" type="number" min={0.25} step="0.25" value={form.daysOffEarned} onChange={(event) => setNumber("daysOffEarned", event.target.value)} /></div>
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor="leave-waiting-months">Waiting period from employee start date (months)</Label>
              <Input id="leave-waiting-months" type="number" min={0} max={120} step="1" value={form.waitingMonths} onChange={(event) => setNumber("waitingMonths", event.target.value)} />
              <p className="text-xs text-muted-foreground">Use 0 for accrual to start immediately. For example, 6 starts accruing after six months.</p>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!valid || saveMutation.isPending} onClick={() => saveMutation.mutate(form)}>
              {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{editing ? "Save changes" : "Create leave type"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}