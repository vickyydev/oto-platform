import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Loader2, RotateCcw, Merge } from "lucide-react";
import type { Branch, Department, Employee } from "@shared/schema";
import { isAdminRole, roleCanPerformAction } from "@shared/permissions";
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
 * SCRUM-794: the employee profile's two ways back from one person on two
 * profiles — Rehire on a Left profile, and an admin's Fold into another
 * profile — beside the status badge. Each calls its route on the server
 * (server/employee-rehire-routes.ts), which holds the rights and the reach.
 */

const KEEP = "__keep__";
type Counts = { shifts: number; checklists: number; tasks: number };
const countWords = (c: Counts) => `${c.shifts} shift(s), ${c.checklists} checklist(s), ${c.tasks} task(s)`;

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

const CONFIRM_WORD = "FOLD";

export function FoldIntoAction({ employee }: { employee: Employee }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const allowed = isAdminRole(user?.role) && roleCanPerformAction(user?.role, "settings.delete_data", "settings");

  const { data: people } = useQuery<Employee[]>({ queryKey: ["/api/employees"], enabled: open && allowed });
  const candidates = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (people ?? [])
      .filter((p) => p.id !== employee.id && p.branchId === employee.branchId)
      .filter((p) => !needle || `${p.fullName} ${p.nickname ?? ""}`.toLowerCase().includes(needle))
      .slice(0, 20);
  }, [people, search, employee.id, employee.branchId]);
  const target = (people ?? []).find((p) => p.id === targetId) ?? null;

  const preview = useQuery<{ moved: Counts; skipped: Counts; deleted: { profile: number; login: number } }>({
    queryKey: ["/api/employees", employee.id, "fold-into", targetId, "preview"],
    queryFn: async () => (await apiRequest("GET", `/api/employees/${employee.id}/fold-into/${targetId}/preview`)).json(),
    enabled: open && !!targetId,
    retry: false,
  });

  const fold = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/employees/${employee.id}/fold-into/${targetId}`);
      return res.json() as Promise<{ moved: Counts; skipped: Counts }>;
    },
    onSuccess: (answer) => {
      setOpen(false);
      const into = targetId!;
      queryClient.removeQueries({ queryKey: ["/api/employees", employee.id] });
      refreshEmployee(into);
      toast({
        title: "Profile folded",
        description: `Moved ${countWords(answer.moved)}; skipped ${countWords(answer.skipped)} already on the other profile. This profile is deleted.`,
      });
      setLocation(`/employees/${into}`);
    },
    onError: (error: Error) => {
      toast({ title: "Could not fold the profile", description: error.message, variant: "destructive" });
    },
  });

  if (!allowed) return null;

  const openDialog = () => {
    setSearch("");
    setTargetId(null);
    setTyped("");
    setOpen(true);
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={openDialog} data-testid="button-fold-into-profile">
        <Merge className="mr-2 h-4 w-4" />
        Fold into another profile
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Fold into another profile</DialogTitle>
            <DialogDescription>
              For a duplicate profile of the same person: its shifts, checklists and tasks move to the profile you choose, and this profile is deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="fold-search">The profile to keep (same branch)</Label>
              <Input id="fold-search" placeholder="Search by name" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="input-fold-search" />
              <div className="max-h-48 overflow-y-auto rounded-md border">
                {candidates.length === 0 && <p className="p-3 text-sm text-muted-foreground">No other profile in this branch matches.</p>}
                {candidates.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => { setTargetId(p.id); setTyped(""); }}
                    className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted ${p.id === targetId ? "bg-muted font-medium" : ""}`}
                    data-testid={`option-fold-target-${p.id}`}
                  >
                    <span>{p.fullName}{p.nickname ? ` (${p.nickname})` : ""}</span>
                    <span className="text-xs capitalize text-muted-foreground">{p.status}</span>
                  </button>
                ))}
              </div>
            </div>
            {target && (
              <div className="space-y-2 rounded-md border p-3 text-sm" data-testid="fold-preview">
                {preview.isLoading && <p className="text-muted-foreground">Counting what would move…</p>}
                {preview.error && <p className="text-destructive">{(preview.error as Error).message}</p>}
                {preview.data && (
                  <>
                    <p>Moves {countWords(preview.data.moved)} to {target.fullName}.</p>
                    <p className="text-muted-foreground">Skips {countWords(preview.data.skipped)} {target.fullName} already has.</p>
                    <p className="text-muted-foreground">
                      Deletes this profile{preview.data.deleted.login ? " and the login that belongs to it" : ""}.
                    </p>
                  </>
                )}
              </div>
            )}
            {target && preview.data && (
              <div className="space-y-2">
                <Label htmlFor="fold-confirm">Type {CONFIRM_WORD} to confirm</Label>
                <Input id="fold-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="input-fold-confirm" />
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => fold.mutate()}
              disabled={!target || !preview.data || typed.trim().toUpperCase() !== CONFIRM_WORD || fold.isPending}
              data-testid="button-confirm-fold"
            >
              {fold.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Fold
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
