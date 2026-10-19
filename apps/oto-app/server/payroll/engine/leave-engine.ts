// The payroll half of the prototype's leave engine
// (imports/oto-app/client/src/lib/payroll-prototype/leave-engine.ts), per the
// plan's §2: only `effectiveLeavePolicy` and `leavePayrollInputs` (with
// `LeavePayoutInput` / `LeaveUnpaidInput`) are kept, verbatim. Accrual,
// balances, request warnings and the exit plan are not ported — SCRUM-560's
// engine is the only balance engine, and the exit payout becomes a service
// (R3). Those were also the only wall-clock reads in this file
// (`createLeaveExitPlanData`, prototype :335, :374, :376, :406, :409).
import type { BranchId, LeavePolicy, LeaveTypePolicy, PayrollWorld } from "./model";

export function effectiveLeavePolicy(data: PayrollWorld, branchId: BranchId, date: string): { effectiveFrom: string; policy: LeavePolicy } {
  const history = [...data.branches[branchId].leavePolicyHistory].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const active = [...history].reverse().find((entry) => entry.effectiveFrom <= date) ?? history[0];
  if (!active) throw new Error(`No leave policy is configured for ${branchId}.`);
  return active;
}

function leaveType(data: PayrollWorld, branchId: BranchId, typeId: string, date: string): LeaveTypePolicy | undefined {
  return effectiveLeavePolicy(data, branchId, date).policy.types.find((type) => type.id === typeId);
}

export type LeavePayoutInput = { entryId: string; typeId: string; typeName: string; date: string; days: number; rate: number; amount: number; taxable: boolean; socialSecurity: boolean; decidedBy: string };
export type LeaveUnpaidInput = { entryId: string; dates: string[]; days: number; rate: number; amount: number };

export function leavePayrollInputs(data: PayrollWorld, branchId: BranchId, month: string, staffId: string): { payouts: LeavePayoutInput[]; unpaid: LeaveUnpaidInput[] } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Leave payroll month must use YYYY-MM.");
  const daysInMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const start = `${month}-01`;
  const end = `${month}-${String(daysInMonth).padStart(2, "0")}`;
  const all = data.leaveLedger.filter((entry) =>
    entry.branchId === branchId && entry.staffId === staffId && entry.date >= start && entry.date <= end);
  const reversed = new Set(data.leaveLedger.filter((entry) => entry.linkedEntryId).map((entry) => entry.linkedEntryId));
  const relevant = Array.from(new Map(all.map((entry) => [entry.entryId, entry])).values()).filter((entry) =>
    entry.date >= start && entry.date <= end && !reversed.has(entry.entryId));
  const payouts = relevant.filter((entry) => entry.kind === "Paid out").map((entry) => {
    const type = leaveType(data, branchId, entry.typeId, entry.date);
    const days = Math.abs(entry.days);
    const rate = entry.rate ?? 0;
    return { entryId: entry.entryId, typeId: entry.typeId, typeName: type?.name ?? entry.typeId, date: entry.date, days, rate, amount: Math.round(days * rate * 100) / 100, taxable: entry.taxable ?? true, socialSecurity: entry.socialSecurity ?? false, decidedBy: entry.decidedBy ?? entry.actor };
  });
  const unpaid = relevant.filter((entry) => entry.kind === "Used" &&
    (entry.paidLeave === false || (entry.paidLeave === undefined && leaveType(data, branchId, entry.typeId, entry.date)?.paid === false)))
    .map((entry) => {
      const days = Math.abs(entry.days);
      const rate = entry.rate ?? 0;
      return { entryId: entry.entryId, dates: [entry.date], days, rate, amount: Math.round(days * rate * 100) / 100 };
    });
  return { payouts, unpaid };
}
