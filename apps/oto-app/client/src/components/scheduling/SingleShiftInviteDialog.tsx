import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, UserPlus } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  CASUAL_DAY_RATE_LABEL,
  OLD_CONTRACT_LABEL,
  SINGLE_SHIFT_MARK,
  SINGLE_SHIFT_REFUSALS,
  bahtText,
  type SingleShiftPayWay,
} from "@shared/singleShift";

/**
 * SCRUM-1038: a former employee invited to one shift, beside "Find staff from
 * other branches" in the shift's Assign Staff popover. The manager picks one of
 * the branch's former employees and how the shift is paid: on the old
 * contract (the default), or switched to a casual day rate they type. The
 * shift's single shifts already made are listed above, each with how it is
 * paid and a switch between the two ways; the payroll roles also see what the
 * shift is worth.
 */

export interface FormerEmployee {
  id: string;
  name: string;
  lastWorkingDay: string | null;
}

export interface SingleShift {
  id: string;
  assignmentId: string;
  employeeId: string;
  employeeName: string;
  shiftRowId: string | null;
  shiftDate: string;
  payWay: SingleShiftPayWay;
  casualDayRate: number | null;
  payLabel: string;
  pay?: { amount: number | null; formula: string };
  invitedBy: string | null;
  invitedAt: string;
  changedBy: string | null;
  changedAt: string;
}

export const singleShiftsKey = (branchId: string, from: string, to: string) =>
  ["/api/schedule/single-shift/invitations", branchId, from, to] as const;

export async function fetchSingleShifts(branchId: string, from: string, to: string): Promise<SingleShift[]> {
  const res = await fetch(`/api/schedule/single-shift/invitations?branchId=${encodeURIComponent(branchId)}&startDate=${from}&endDate=${to}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load single shifts");
  return res.json();
}

/** A typed rate as the server takes it: whole baht, more than zero; anything else is null. */
function rateOf(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isInteger(value) && value > 0 ? value : null;
}

function PayWayFields({ idPrefix, way, onWay, rate, onRate }: {
  idPrefix: string;
  way: SingleShiftPayWay;
  onWay: (way: SingleShiftPayWay) => void;
  rate: string;
  onRate: (rate: string) => void;
}) {
  return (
    <div className="space-y-2">
      <RadioGroup value={way} onValueChange={(v) => onWay(v as SingleShiftPayWay)} className="gap-1.5">
        <div className="flex items-center gap-2">
          <RadioGroupItem value="old_contract" id={`${idPrefix}-old-contract`} data-testid={`${idPrefix}-old-contract`} />
          <Label htmlFor={`${idPrefix}-old-contract`} className="font-normal">{OLD_CONTRACT_LABEL}</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="casual_day_rate" id={`${idPrefix}-casual`} data-testid={`${idPrefix}-casual`} />
          <Label htmlFor={`${idPrefix}-casual`} className="font-normal">{CASUAL_DAY_RATE_LABEL}</Label>
        </div>
      </RadioGroup>
      {way === "casual_day_rate" && (
        <div className="space-y-1 pl-6">
          <Label htmlFor={`${idPrefix}-rate`} className="text-xs">Day rate (THB) *</Label>
          <Input
            id={`${idPrefix}-rate`}
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            className="h-8 w-32"
            value={rate}
            onChange={(e) => onRate(e.target.value)}
            data-testid={`${idPrefix}-rate`}
          />
        </div>
      )}
    </div>
  );
}

function InvitedRow({ shift, onSaved }: { shift: SingleShift; onSaved: () => void }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [way, setWay] = useState<SingleShiftPayWay>(shift.payWay);
  const [rate, setRate] = useState(shift.casualDayRate ? String(shift.casualDayRate) : "");
  const change = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/schedule/single-shift/invitations/${shift.id}`, {
        payWay: way,
        casualDayRate: way === "casual_day_rate" ? rateOf(rate) : null,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Pay updated", description: `${shift.employeeName}'s single shift is now paid ${way === "old_contract" ? "on the old contract" : "on a casual day rate"}.` });
      setEditing(false);
      onSaved();
    },
    onError: (error: Error) => toast({ title: "Could not change the pay", description: error.message, variant: "destructive" }),
  });
  const canSave = way === "old_contract" || rateOf(rate) !== null;
  return (
    <div className="rounded-md border p-2 space-y-1.5" data-testid={`single-shift-${shift.employeeId}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{shift.employeeName}</span>
        <Badge variant="outline" className="text-[10px] px-1 py-0" data-testid={`single-shift-pay-${shift.employeeId}`}>{shift.payLabel}</Badge>
      </div>
      {shift.pay && (
        <p className="text-xs text-muted-foreground" data-testid={`single-shift-amount-${shift.employeeId}`}>
          {shift.pay.amount === null ? shift.pay.formula : `${bahtText(shift.pay.amount)} for the shift (${shift.pay.formula})`}
        </p>
      )}
      {editing ? (
        <div className="space-y-2 pt-1">
          <PayWayFields idPrefix={`single-shift-change-${shift.employeeId}`} way={way} onWay={setWay} rate={rate} onRate={setRate} />
          <div className="flex gap-2">
            <Button size="sm" className="h-7 text-xs" disabled={!canSave || change.isPending} onClick={() => change.mutate()}>
              {change.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}Save pay
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setEditing(false); setWay(shift.payWay); }}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="ghost" className="h-7 text-xs px-2" onClick={() => setEditing(true)}>Change pay</Button>
      )}
    </div>
  );
}

export interface SingleShiftInviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branchId: string;
  shiftRowId: string;
  date: string;
  weekStartFormatted: string;
  shiftLabel?: string;
  shiftTime: string;
  departmentName: string;
}

export function SingleShiftInviteDialog({
  open, onOpenChange, branchId, shiftRowId, date, weekStartFormatted, shiftLabel, shiftTime, departmentName,
}: SingleShiftInviteDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [chosen, setChosen] = useState<string | null>(null);
  const [way, setWay] = useState<SingleShiftPayWay>("old_contract");
  const [rate, setRate] = useState("");

  const former = useQuery<FormerEmployee[]>({
    queryKey: ["/api/schedule/single-shift/former-employees", branchId],
    queryFn: async () => {
      const res = await fetch(`/api/schedule/single-shift/former-employees?branchId=${encodeURIComponent(branchId)}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load former employees");
      return res.json();
    },
    enabled: open && !!branchId,
  });
  const shifts = useQuery<SingleShift[]>({
    queryKey: singleShiftsKey(branchId, date, date),
    queryFn: () => fetchSingleShifts(branchId, date, date),
    enabled: open && !!branchId && !!date,
  });
  const onThisShift = (shifts.data ?? []).filter((s) => s.shiftRowId === shiftRowId);
  const invitedThatDay = new Set((shifts.data ?? []).map((s) => s.employeeId));

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/schedule/single-shift/invitations", branchId] });
    queryClient.invalidateQueries({ queryKey: ["/api/schedule/week", branchId, weekStartFormatted] });
    queryClient.invalidateQueries({ queryKey: ["/api/rota", branchId] });
  };

  const invite = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/schedule/single-shift/invitations", {
        employeeId: chosen,
        shiftRowId,
        shiftDate: date,
        payWay: way,
        casualDayRate: way === "casual_day_rate" ? rateOf(rate) : null,
      });
      return res.json() as Promise<SingleShift>;
    },
    onSuccess: (made) => {
      toast({ title: "Single shift added", description: `${made?.employeeName ?? "The former employee"} is on this shift, ${made?.payLabel?.toLowerCase() ?? ""}.` });
      setChosen(null);
      setWay("old_contract");
      setRate("");
      refresh();
    },
    onError: (error: Error) => toast({ title: "Could not add the single shift", description: error.message, variant: "destructive" }),
  });

  const rateMissing = way === "casual_day_rate" && rateOf(rate) === null;
  const canInvite = !!chosen && !rateMissing && !invite.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            Invite a Former Employee
          </DialogTitle>
          <DialogDescription>
            One shift on the same profile, without rehiring. Their profile stays Left; they can clock in for this shift on its day only.
          </DialogDescription>
        </DialogHeader>

        <div className="text-sm text-muted-foreground mb-1 space-y-1">
          <div className="flex items-center gap-2">
            <Badge variant="outline">{departmentName}</Badge>
            {shiftLabel && <Badge variant="secondary">{shiftLabel}</Badge>}
          </div>
          <div>
            {new Date(date).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}
            {" • "}
            {shiftTime}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto space-y-4">
          {onThisShift.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">{SINGLE_SHIFT_MARK}</h4>
              {onThisShift.map((shift) => (
                <InvitedRow key={`${shift.id}:${shift.payWay}:${shift.casualDayRate ?? ""}`} shift={shift} onSaved={refresh} />
              ))}
            </div>
          )}

          {former.isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : former.error ? (
            <p className="text-sm text-destructive py-4 text-center">Failed to load former employees</p>
          ) : (former.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No former employees at this branch.</p>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <h4 className="text-sm font-medium">Former employee</h4>
                {(former.data ?? []).map((person) => {
                  const already = invitedThatDay.has(person.id);
                  return (
                    <Button
                      key={person.id}
                      variant="ghost"
                      size="sm"
                      disabled={already}
                      className={cn("w-full justify-between text-sm h-8", chosen === person.id && "bg-accent")}
                      onClick={() => setChosen(person.id)}
                      data-testid={`button-single-shift-${person.id}`}
                    >
                      <span>{person.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {already ? SINGLE_SHIFT_REFUSALS.sameDay.replace("This person already has", "Already has") : person.lastWorkingDay ? `Left after ${person.lastWorkingDay}` : "Left"}
                      </span>
                    </Button>
                  );
                })}
              </div>
              <div className="space-y-1">
                <h4 className="text-sm font-medium">How this shift is paid</h4>
                <PayWayFields idPrefix="single-shift-invite" way={way} onWay={setWay} rate={rate} onRate={setRate} />
              </div>
              <Button className="w-full" size="sm" disabled={!canInvite} onClick={() => invite.mutate()} data-testid="button-single-shift-invite">
                {invite.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                Invite for this shift
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
