import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { AlertTriangle, CalendarClock, FileSignature, Loader2, Merge, UserPlus, X } from "lucide-react";
import type { Branch, Department, Employee, Template, TemplateAssignment } from "@shared/schema";
import { isAdminRole, roleCanPerformAction } from "@shared/permissions";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
 * SCRUM-794: one person, one profile, across two contracts.
 *
 *  - Onboard Again (beside Update Terms): as soon as the current contract has a
 *    last working day, and on a Left profile, a new employment is planned on
 *    the same profile — start date, department, branch, position, basis — and
 *    a draft contract is made for it. The profile's basic info, login and face
 *    are already set up, so the onboarding steps left are the contract's.
 *  - The planned employment's card: its start date, department and branch,
 *    its contract's status, the contract and the wizard, and Cancel before the
 *    start date.
 *  - Fold into another profile (an admin's): a duplicate profile made for the
 *    same person folded into the one that holds the login and the face.
 *
 * Each calls its route (server/employee-onboard-again-routes.ts), which holds
 * the rights and the reach.
 */

const KEEP = "__keep__";
type Counts = {
  shifts: number;
  duties: number;
  breaks: number;
  templateShifts: number;
  roles: number;
  checklists: number;
  tasks: number;
};
type RematchAnswer = { matched: number; stillPending: number } | { failed: true };

interface PlannedEmployment {
  id: string;
  startDate: string;
  positionTitle: string | null;
  employmentBasis: string | null;
  status: string;
  department: { id: string; name: string } | null;
  branch: { id: string; name: string } | null;
  contract: { id: string; status: string; signingStatus: string; sentAt: string | null; signedAt: string | null } | null;
  /** The platform switched the suite sign-in off when the last contract ended. */
  platformSignInOff?: boolean;
}

const PLATFORM_SIGN_IN_OFF =
  "The suite sign-in was switched off on the platform when the last contract ended, and the app cannot switch it back on. " +
  "A platform administrator reactivates the account on the Console's Login users page before the start date; that switches this login back on too, so the new shifts show in the app.";

const plannedKey = (employeeId: string) => ["/api/employees", employeeId, "onboard-again"];

const rematchWords = (rematch: RematchAnswer | undefined) => {
  if (!rematch) return "";
  if ("failed" in rematch) return " Pending approvals could not be matched just now; they stay pending.";
  if (rematch.matched === 0 && rematch.stillPending === 0) return "";
  return ` ${rematch.matched} pending approval(s) matched to a shift, ${rematch.stillPending} still pending.`;
};

const countWords = (c: Counts) =>
  `${c.shifts} shift(s) with ${c.duties} duty block(s) and ${c.breaks} break(s), ${c.templateShifts} weekly template shift(s), ` +
  `${c.roles} role(s), ${c.checklists} checklist(s), ${c.tasks} task(s)`;

const dayWords = (day: string) =>
  new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** Bangkok's calendar day, the one the server compares start dates with. */
const bangkokToday = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Bangkok" }).format(new Date());

function contractWords(contract: PlannedEmployment["contract"]): string {
  if (!contract) return "No contract";
  if (contract.signingStatus === "signed") {
    return contract.status === "active" ? "Signed, active" : "Signed, active from the start date";
  }
  if (contract.signingStatus === "awaiting_signature" || contract.sentAt) return "Sent, awaiting signature";
  if (contract.status === "finalized") return "Finalized, not sent yet";
  return "Draft";
}

function refreshEmployee(employeeId: string) {
  queryClient.invalidateQueries({ queryKey: ["/api/employees", employeeId] });
  queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
}

/** Whether a profile can be onboarded again: its current contract has a last day, or it has left. */
export function canOnboardAgain(employee: Employee) {
  return !!employee.lastWorkingDay || employee.status === "resigned" || employee.status === "terminated";
}

export function usePlannedEmployment(employee: Employee | undefined, enabled = true) {
  return useQuery<{ engagement: PlannedEmployment | null }>({
    queryKey: plannedKey(employee?.id ?? ""),
    enabled: !!employee && enabled,
  });
}

interface TemplateWithAssignments extends Template {
  assignments: TemplateAssignment[];
}

export function OnboardAgainAction({ employee, branches, departments, defaultTemplateId }: {
  employee: Employee;
  branches: Branch[] | undefined;
  departments: Department[] | undefined;
  /** The template the profile's latest contract was made from. */
  defaultTemplateId: string | null;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const allowed = roleCanPerformAction(user?.role, "hr.terminate_employee", "hr") && canOnboardAgain(employee);
  const planned = usePlannedEmployment(employee, allowed);
  const [open, setOpen] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [branchId, setBranchId] = useState(KEEP);
  const [positionTitle, setPositionTitle] = useState("");
  const [employmentBasis, setEmploymentBasis] = useState(KEEP);
  const [templateId, setTemplateId] = useState("");

  const { data: templates } = useQuery<TemplateWithAssignments[]>({
    queryKey: ["/api/templates/with-assignments"],
    enabled: open,
  });
  const effectiveBranchId = branchId === KEEP ? employee.branchId : branchId;
  // The templates the contract wizard offers for the branch.
  const branchTemplates = useMemo(() => (templates ?? []).filter((t) =>
    t.status === "active" && (!effectiveBranchId || t.assignments.some((a) => a.branchId === effectiveBranchId))), [templates, effectiveBranchId]);

  const lastDay = employee.lastWorkingDay ? new Date(employee.lastWorkingDay).toISOString().slice(0, 10) : null;

  const plan = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/employees/${employee.id}/onboard-again`, {
        startDate,
        departmentId,
        branchId: branchId === KEEP ? null : branchId,
        positionTitle: positionTitle.trim() || null,
        employmentBasis: employmentBasis === KEEP ? null : employmentBasis,
        templateId: templateId || null,
      });
      return res.json() as Promise<{
        started: boolean;
        login?: string;
        platformDeactivationDelivered?: boolean;
        platformSignInOff?: boolean;
        rematch?: RematchAnswer;
      }>;
    },
    onSuccess: (answer) => {
      setOpen(false);
      refreshEmployee(employee.id);
      queryClient.invalidateQueries({ queryKey: plannedKey(employee.id) });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", employee.id, "changes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", employee.id, "contracts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", employee.id, "onboarding-status"] });
      if (answer.started) {
        const login = answer.login === "reactivated" ? " The login is switched on again." : "";
        const platform = answer.platformDeactivationDelivered
          ? " The suite sign-in was switched off on the platform; if it is still off, a platform administrator reactivates it there."
          : "";
        toast({ title: "Onboarded again", description: `The new employment has started.${login}${platform}${rematchWords(answer.rematch)}` });
      } else {
        toast({
          title: "Onboard Again planned",
          description: `The new employment starts on ${dayWords(startDate)}. Its shifts can be added from that date, and a draft contract is ready.` +
            (answer.platformSignInOff ? ` ${PLATFORM_SIGN_IN_OFF}` : ""),
        });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Could not plan Onboard Again", description: error.message, variant: "destructive" });
    },
  });

  if (!allowed || planned.data?.engagement) return null;

  const openDialog = () => {
    const after = lastDay ? new Date(Date.parse(`${lastDay}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : bangkokToday();
    setStartDate(after);
    setDepartmentId(employee.primaryDepartmentId ?? "");
    setBranchId(KEEP);
    setPositionTitle((employee.defaultMergeData as { positionTitle?: string } | null)?.positionTitle ?? "");
    setEmploymentBasis(KEEP);
    setTemplateId(defaultTemplateId ?? "");
    setOpen(true);
  };
  const startTooEarly = !!lastDay && !!startDate && startDate <= lastDay;

  return (
    <>
      <Button variant="outline" onClick={openDialog} data-testid="button-onboard-again">
        <UserPlus className="mr-2 h-4 w-4" />
        Onboard Again
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Onboard Again</DialogTitle>
            <DialogDescription>
              Starts a new contract on this same profile. The basic info, login and face scan are already set up and stay as they are.
              {lastDay ? ` The current contract ends on its last working day, ${dayWords(lastDay)}.` : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-2">
              <Label>New start date</Label>
              <DatePicker value={startDate} onChange={setStartDate} data-testid="input-onboard-again-start-date" />
              {startTooEarly && (
                <p className="text-xs text-destructive">The new start date must be after the last working day.</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Department</Label>
              <Select value={departmentId} onValueChange={setDepartmentId}>
                <SelectTrigger data-testid="select-onboard-again-department"><SelectValue placeholder="Choose a department" /></SelectTrigger>
                <SelectContent>
                  {(departments ?? []).filter((d) => d.isActive).map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Branch</Label>
              <Select value={branchId} onValueChange={(value) => { setBranchId(value); setTemplateId(""); }}>
                <SelectTrigger data-testid="select-onboard-again-branch"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={KEEP}>Keep the current branch</SelectItem>
                  {(branches ?? []).filter((b) => b.id !== employee.branchId).map((b) => (
                    <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="onboard-again-position">Position</Label>
              <Input id="onboard-again-position" value={positionTitle} onChange={(e) => setPositionTitle(e.target.value)} data-testid="input-onboard-again-position" />
            </div>
            <div className="space-y-2">
              <Label>Employment type</Label>
              <Select value={employmentBasis} onValueChange={setEmploymentBasis}>
                <SelectTrigger data-testid="select-onboard-again-basis"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={KEEP}>Keep {employee.employmentBasis === "PART_TIME" ? "part-time" : "full-time"}</SelectItem>
                  <SelectItem value="FULL_TIME">Full-time</SelectItem>
                  <SelectItem value="PART_TIME">Part-time</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Contract template</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger data-testid="select-onboard-again-template"><SelectValue placeholder="Choose a template" /></SelectTrigger>
                <SelectContent>
                  {branchTemplates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                A draft contract is made from it, prefilled from the profile. Then Contract Sent and Contract Signed, as for any contract.
              </p>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              onClick={() => plan.mutate()}
              disabled={!startDate || !departmentId || !templateId || startTooEarly || plan.isPending}
              data-testid="button-confirm-onboard-again"
            >
              {plan.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Onboard Again
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function PlannedEmploymentCard({ employee }: { employee: Employee }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const isManager = user?.role !== "staff";
  const planned = usePlannedEmployment(employee, isManager);
  const engagement = planned.data?.engagement ?? null;
  const canCancel = roleCanPerformAction(user?.role, "hr.terminate_employee", "hr");

  const cancel = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/employees/${employee.id}/onboard-again/${engagement!.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: plannedKey(employee.id) });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", employee.id, "onboarding-status"] });
      toast({ title: "Onboard Again cancelled", description: "The planned employment will not start. The draft contract stays on the profile." });
    },
    onError: (error: Error) => {
      toast({ title: "Could not cancel", description: error.message, variant: "destructive" });
    },
  });

  if (!engagement) return null;
  const beforeStart = engagement.startDate > bangkokToday();

  return (
    <Card className="border-l-4 border-l-teal-500 bg-teal-500/5" data-testid="card-planned-employment">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle className="text-lg">Onboard Again planned</CardTitle>
              <CardDescription>A new contract on this profile; the login, face scan and history stay.</CardDescription>
            </div>
          </div>
          <Badge variant="secondary" data-testid="badge-planned-contract-status">{contractWords(engagement.contract)}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-muted-foreground">Starts</p>
            <p className="font-medium" data-testid="text-planned-start-date">{dayWords(engagement.startDate)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Department</p>
            <p className="font-medium" data-testid="text-planned-department">{engagement.department?.name ?? "Not found"}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Branch</p>
            <p className="font-medium">{engagement.branch?.name ?? "Not found"}</p>
          </div>
          {engagement.positionTitle && (
            <div>
              <p className="text-muted-foreground">Position</p>
              <p className="font-medium">{engagement.positionTitle}</p>
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Shifts in the new department can be added from the start date and show in the employee's app as soon as they are added.
          The current department's shifts and tasks carry on up to the last working day.
        </p>
        {engagement.platformSignInOff && (
          <div
            className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
            data-testid="text-planned-platform-sign-in-off"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <p><span className="font-medium">Platform sign-in is off.</span> {PLATFORM_SIGN_IN_OFF}</p>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {engagement.contract && (
            <Link href={`/contracts/${engagement.contract.id}`}>
              <Button size="sm" variant="outline" data-testid="button-open-planned-contract">
                <FileSignature className="mr-2 h-4 w-4" />
                Open contract
              </Button>
            </Link>
          )}
          {engagement.contract?.signingStatus !== "signed" && (
            <Link href={`/contracts/new?employeeId=${employee.id}&engagementId=${engagement.id}`}>
              <Button size="sm" variant="ghost" data-testid="button-planned-contract-wizard">
                Edit in the contract wizard
              </Button>
            </Link>
          )}
          {canCancel && beforeStart && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              onClick={() => { if (window.confirm("Cancel the planned employment? Nothing else changes.")) cancel.mutate(); }}
              disabled={cancel.isPending}
              data-testid="button-cancel-onboard-again"
            >
              <X className="mr-2 h-4 w-4" />
              Cancel plan
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
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
      return res.json() as Promise<{ moved: Counts; skipped: Counts; rematch?: RematchAnswer }>;
    },
    onSuccess: (answer) => {
      setOpen(false);
      const into = targetId!;
      queryClient.removeQueries({ queryKey: ["/api/employees", employee.id] });
      refreshEmployee(into);
      toast({
        title: "Profile folded",
        description: `Moved ${countWords(answer.moved)}; skipped ${countWords(answer.skipped)} already on the other profile. This profile is deleted.${rematchWords(answer.rematch)}`,
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
              For a duplicate profile of the same person: its shifts (with their duties and breaks), weekly template shifts, roles, checklists and tasks move to the profile you choose, and this profile is deleted.
              Keep the profile the person signs in and scans their face with.
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
                    className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted ${p.id === targetId ? "bg-muted font-medium" : ""}`}
                    data-testid={`option-fold-target-${p.id}`}
                  >
                    <span>{p.fullName}{p.nickname ? ` (${p.nickname})` : ""}</span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      {p.userId && <Badge variant="outline" className="text-[10px]">Login</Badge>}
                      {p.faceEnrollmentStatus === "ENROLLED" && <Badge variant="outline" className="text-[10px]">Face</Badge>}
                      <span className="capitalize">{p.status}</span>
                    </span>
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
