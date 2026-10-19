/**
 * One person's payroll profile (SCRUM-567, R2): the prototype's
 * payroll-profile-editor and profile summary, on real data. Saving asks for a
 * reason, sends the revision it was read at, and marks the profile reviewed.
 * Proposals from HR data are shown beside the form and reach it only through
 * "Use" and a save. Payroll roles only.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useRoute } from "wouter";
import { AlertTriangle, ArrowLeft, CheckCircle2, History, Lightbulb, Plus, RotateCcw, Save, Trash2, Wand2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { canViewHrSalary, HR_PAY_HIDDEN_NOTE } from "@shared/hr-salary-permission";
import {
  OWNER_NON_OPERATIONAL, OWNER_NON_OPERATIONAL_LABEL, WORKER_DEFAULTS, WORKER_LABELS, allocationAt, resolvePayingAccount, validatePayrollProfile,
  type AllocationLine, type AllocationVersion, type EmployeePayrollProfile, type PaymentMethod, type PayrollProfileView,
  type PayrollSetupView, type ProfileCheckContext, type SalaryAdvanceProfile, type SeparatePayment, type WorkerType,
} from "@shared/payroll-config";
import { ReasonDialog } from "@/components/payroll/reason-dialog";
import { errorText, money, payrollCall, refreshPayroll, usePayrollProfile, usePayrollSetup } from "@/lib/payroll/api";
import { Field, NumberInput } from "@/pages/payroll-setup-page";

const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const todayIso = () => new Date().toISOString().slice(0, 10);
const tempId = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function YesNo({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return <Field label={label}><div className="flex overflow-hidden rounded-md border border-input" role="group" aria-label={label}>
    {[true, false].map((v) => <button key={String(v)} type="button" aria-pressed={value === v} onClick={() => onChange(v)}
      className={`h-10 flex-1 text-sm ${value === v ? "bg-primary text-primary-foreground" : "bg-background hover:bg-accent/50"}`}>{v ? "Yes" : "No"}</button>)}
  </div></Field>;
}
function Section({ title, description, children, action }: { title: string; description?: string; children: ReactNode; action?: ReactNode }) {
  return <Card className="border-border bg-card shadow-sm">
    <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0 border-b border-border/70 pb-3">
      <div><CardTitle className="text-base">{title}</CardTitle>{description && <CardDescription className="mt-1 text-xs">{description}</CardDescription>}</div>{action}
    </CardHeader>
    <CardContent className="space-y-4 pt-4">{children}</CardContent>
  </Card>;
}

/** The same check context the server builds: branches with payroll details, live entities and accounts. */
export function checkContext(setup: PayrollSetupView): ProfileCheckContext {
  const ctx: ProfileCheckContext = { branches: {}, entities: setup.entities.filter((e) => !e.archivedAt), accounts: setup.accounts.filter((a) => !a.archivedAt) };
  for (const b of setup.branches) {
    if (!b.detailsHistory.length) continue;
    ctx.branches[b.id] = { country: b.detailsHistory[0].details.country, detailsHistory: b.detailsHistory.map((v) => ({ effectiveFrom: v.effectiveFrom, defaultPayingAccountId: v.details.defaultPayingAccountId })) };
  }
  return ctx;
}

/** A form for someone with no profile yet: identity left blank, no pay; the branch's food default (plan §8). */
function newProfile(view: PayrollProfileView, setup: PayrollSetupView): EmployeePayrollProfile {
  const branch = setup.branches.find((b) => b.id === view.employee.branchId);
  const details = branch ? [...branch.detailsHistory].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] : undefined;
  const joinedOn = view.employee.startDate ?? "";
  return {
    linkedEmployeeId: view.employee.id, workerType: "monthly", jobTitle: "", ...WORKER_DEFAULTS.monthly,
    monthlySalary: 0, dayRate: 0, fixedFee: 0, joinedOn, lastWorkingDay: null, taxId: "", ssoNumber: "",
    foodAllowancePerDay: details?.foodAllowanceDefault ?? 0,
    paymentMethod: "bank-transfer", bankDetails: { bank: "", accountNumber: "", accountName: view.employee.name }, thirdPartyReason: "",
    allocations: branch && details?.details.payingEntityId ? [{ effectiveFrom: joinedOn || todayIso(), homeBranchId: branch.id,
      lines: [{ costCentre: branch.id, percent: 100, entityId: details.details.payingEntityId, payingAccountId: null }] }] : [],
    studentLoanMonthly: 0, advances: [], separatePayments: [], notes: "",
  };
}

export default function PayrollPersonPage() {
  const [, params] = useRoute("/payroll/people/:employeeId");
  const employeeId = params?.employeeId ?? "";
  const { user } = useAuth();
  const view = usePayrollProfile(employeeId);
  const setup = usePayrollSetup();
  if (!canViewHrSalary(user?.role)) return <div className="p-6"><p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{HR_PAY_HIDDEN_NOTE}.</p></div>;
  return <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6" data-testid="page-payroll-person">
    <Link href="/payroll/people" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />Staff roster</Link>
    {(view.isLoading || setup.isLoading) && <Skeleton className="h-96 w-full" />}
    {(view.error || setup.error) && <p className="rounded-lg border border-dashed p-4 text-sm">{errorText(view.error ?? setup.error)}</p>}
    {view.data && setup.data && <ProfileEditor key={`${view.data.employee.id}:${view.data.revision}`} view={view.data} setup={setup.data} />}
  </div>;
}

function ProfileEditor({ view, setup }: { view: PayrollProfileView; setup: PayrollSetupView }) {
  const initial = useMemo(() => structuredClone(view.profile ?? newProfile(view, setup)), [view, setup]);
  const [draft, setDraft] = useState<EmployeePayrollProfile>(initial);
  const [asOf, setAsOf] = useState(todayIso);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(initial), [initial]);
  const ctx = useMemo(() => checkContext(setup), [setup]);
  const errors = validatePayrollProfile(draft, ctx);
  const active = allocationAt(draft, asOf);
  const branchName = (id: string) => id === OWNER_NON_OPERATIONAL ? OWNER_NON_OPERATIONAL_LABEL : setup.branches.find((b) => b.id === id)?.name ?? "Unknown branch";
  const branchIds = Object.keys(ctx.branches);
  const defaultEntity = ctx.entities[0]?.id ?? "";
  const canEdit = view.canManage;

  const set = (patch: Partial<EmployeePayrollProfile>) => setDraft((d) => ({ ...d, ...patch }));
  const setVersion = (vi: number, patch: Partial<AllocationVersion>) => set({ allocations: draft.allocations.map((v, i) => i === vi ? { ...v, ...patch } : v) });
  const setLine = (vi: number, li: number, patch: Partial<AllocationLine>) => setVersion(vi, { lines: draft.allocations[vi].lines.map((l, i) => i === li ? { ...l, ...patch } : l) });
  const setAdvance = (i: number, patch: Partial<SalaryAdvanceProfile>) => set({ advances: draft.advances.map((a, r) => r === i ? { ...a, ...patch } : a) });
  const setPayment = (i: number, patch: Partial<SeparatePayment>) => set({ separatePayments: draft.separatePayments.map((p, r) => r === i ? { ...p, ...patch } : p) });

  function applyDefaults() {
    if (draft.workerType !== "owner-household") { set({ ...WORKER_DEFAULTS[draft.workerType] }); return; }
    const latestVersion = [...draft.allocations].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    const entityId = latestVersion?.lines[0]?.entityId ?? defaultEntity;
    const accountId = ctx.accounts.find((a) => a.entityId === entityId)?.id ?? null;
    set({ ...WORKER_DEFAULTS[draft.workerType], allocations: draft.allocations.map((v) => v === latestVersion ? { ...v, lines: [{ costCentre: OWNER_NON_OPERATIONAL, percent: 100, entityId, payingAccountId: accountId }] } : v) });
  }
  function addVersion() {
    const last = [...draft.allocations].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    const home = view.employee.branchId && ctx.branches[view.employee.branchId] ? view.employee.branchId : branchIds[0] ?? "";
    set({ allocations: [...draft.allocations, last ? { ...structuredClone(last), effectiveFrom: todayIso() }
      : { effectiveFrom: todayIso(), homeBranchId: home, lines: [{ costCentre: home, percent: 100, entityId: defaultEntity, payingAccountId: null }] }] });
  }
  function applySuggestion(field: string, value: string | number | null) {
    if (value == null) return;
    if (field.startsWith("bankDetails.")) { set({ bankDetails: { ...draft.bankDetails, [field.slice(12)]: String(value) } }); return; }
    if (field === "advance") {
      set({ advances: [...draft.advances, { id: tempId("adv"), principal: Number(value), outstandingBalance: Number(value), repaymentMode: "one-off", instalments: 1, monthlyRepayment: 0, startsOn: todayIso() }] });
      return;
    }
    if (field === "workerType") { set({ workerType: value as WorkerType, ...WORKER_DEFAULTS[value as WorkerType] }); return; }
    set({ [field]: typeof (draft as unknown as Record<string, unknown>)[field] === "number" ? Number(value) : value } as Partial<EmployeePayrollProfile>);
  }
  const ready = view.readiness;

  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold">{view.employee.name}</h1>
        <p className="text-sm text-muted-foreground">{view.employee.branchName ?? "No branch"} · {view.employee.employmentState === "ACTIVE" ? "Current" : view.employee.employmentState === "LEFT" ? "Left" : "Leaving"}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {view.reviewState === "needs-review" && <Badge className="bg-amber-100 text-amber-900 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-200">Needs review</Badge>}
        {view.reviewState === "reviewed" && <Badge variant="outline">Reviewed · revision {view.revision}</Badge>}
        {!view.profile && <Badge variant="outline">No profile yet</Badge>}
        {ready && <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${ready.ready ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200" : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"}`}>
          {ready.ready ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}{ready.status}</span>}
      </div>
    </div>
    {view.warnings.filter((w) => w !== "No payroll profile yet.").length > 0 && <div className="flex flex-wrap gap-1.5" aria-label="Profile review warnings">
      {view.warnings.filter((w) => w !== "No payroll profile yet.").map((w) => <span key={w} className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs ${w.startsWith("Third-party") ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"}`}><AlertTriangle className="h-3 w-3" />{w}</span>)}</div>}

    {view.suggestions.length > 0 && <Section title="Proposed from HR data" description="Read from the HR record and the old payroll tables. Nothing here applies until you use it and save the profile.">
      <ul className="divide-y rounded-md border">{view.suggestions.map((s, i) => <li key={i} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
        <span><Lightbulb className="mr-1 inline h-3.5 w-3.5 text-amber-600" /><span className="font-medium">{s.label}</span>: {typeof s.value === "number" && /salary|rate|food|advance/i.test(s.field) ? money(s.value) : String(s.value)} <span className="text-xs text-muted-foreground">({s.source})</span></span>
        {canEdit && <Button type="button" size="sm" variant="ghost" onClick={() => applySuggestion(s.field, s.value)}>Use</Button>}
      </li>)}</ul>
    </Section>}

    <fieldset disabled={!canEdit} className="space-y-4">
      <Section title="Worker type and pay" description="Defaults are explicit: choose a type then Apply defaults. Every flag remains overridable. Owner-household defaults also set the latest allocation to Owner – non-operational; earlier versions are preserved."
        action={<Button type="button" size="sm" variant="outline" onClick={applyDefaults}><Wand2 className="mr-1.5 h-4 w-4" />Apply {WORKER_LABELS[draft.workerType] ?? ""} defaults</Button>}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Worker type"><select className={selectClass} value={draft.workerType} onChange={(e) => set({ workerType: e.target.value as WorkerType })}>
            {(Object.keys(WORKER_DEFAULTS) as WorkerType[]).map((t) => <option key={t} value={t}>{WORKER_LABELS[t]}</option>)}</select></Field>
          <Field label="Department"><Input value={draft.department ?? ""} onChange={(e) => set({ department: e.target.value || undefined })} /></Field>
          <Field label="Job title" hint="Deduction rules match on this."><Input value={draft.jobTitle} onChange={(e) => set({ jobTitle: e.target.value })} data-testid="input-job-title" /></Field>
          <Field label="Monthly salary (THB)"><NumberInput label="Monthly salary" value={draft.monthlySalary} onChange={(monthlySalary) => set({ monthlySalary })} /></Field>
          <Field label="Day rate (THB)"><NumberInput label="Day rate" value={draft.dayRate} onChange={(dayRate) => set({ dayRate })} /></Field>
          <Field label="Fixed fee (THB)"><NumberInput label="Fixed fee" value={draft.fixedFee} onChange={(fixedFee) => set({ fixedFee })} /></Field>
          <Field label="Joining date"><Input type="date" value={draft.joinedOn} onChange={(e) => set({ joinedOn: e.target.value })} /></Field>
          <Field label="Last working day" hint="Leave blank if current"><Input type="date" value={draft.lastWorkingDay ?? ""} onChange={(e) => set({ lastWorkingDay: e.target.value || null })} /></Field>
          <Field label="Tax ID"><Input value={draft.taxId} onChange={(e) => set({ taxId: e.target.value })} /></Field>
          <Field label="SSO number"><Input value={draft.ssoNumber} onChange={(e) => set({ ssoNumber: e.target.value })} /></Field>
          <Field label="SSO title"><Input value={draft.ssoTitle ?? ""} onChange={(e) => set({ ssoTitle: e.target.value || undefined })} /></Field>
          <Field label="Given name"><Input value={draft.givenName ?? ""} onChange={(e) => set({ givenName: e.target.value || undefined })} /></Field>
          <Field label="Surname"><Input value={draft.surname ?? ""} onChange={(e) => set({ surname: e.target.value || undefined })} /></Field>
          <Field label="Date of birth"><Input type="date" value={draft.dateOfBirth ?? ""} onChange={(e) => set({ dateOfBirth: e.target.value || undefined })} /></Field>
          <Field label="Nationality"><Input value={draft.nationality ?? ""} onChange={(e) => set({ nationality: e.target.value || undefined })} /></Field>
          <Field label="Passport number"><Input value={draft.passportNumber ?? ""} onChange={(e) => set({ passportNumber: e.target.value || undefined })} /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <YesNo label="Food allowance" value={draft.foodAllowanceEligible} onChange={(foodAllowanceEligible) => set({ foodAllowanceEligible })} />
          <Field label="Food per day (THB)"><NumberInput label="Food per day" value={draft.foodAllowancePerDay} onChange={(foodAllowancePerDay) => set({ foodAllowancePerDay })} /></Field>
          <YesNo label="SSO" value={draft.ssoEligible} onChange={(ssoEligible) => set({ ssoEligible })} />
          <YesNo label="PND1" value={draft.pnd1Eligible} onChange={(pnd1Eligible) => set({ pnd1Eligible })} />
          <YesNo label="Service charge eligible" value={draft.serviceChargeEligible} onChange={(serviceChargeEligible) => set({ serviceChargeEligible })} />
          <YesNo label="OT eligible" value={draft.otEligible} onChange={(otEligible) => set({ otEligible })} />
          <Field label="PND3 withholding %"><NumberInput label="PND3 withholding percent" value={draft.pnd3WithholdingPercent} onChange={(pnd3WithholdingPercent) => set({ pnd3WithholdingPercent })} /></Field>
          <Field label="Cash handling fee %"><NumberInput label="Cash handling fee percent" value={draft.cashHandlingFeePercent} onChange={(cashHandlingFeePercent) => set({ cashHandlingFeePercent })} /></Field>
        </div>
      </Section>

      <Section title="Payment routing" description="Used by company runs for payment batches.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Payment method"><select className={selectClass} value={draft.paymentMethod} onChange={(e) => set({ paymentMethod: e.target.value as PaymentMethod })}>
            <option value="bank-transfer">Bank transfer</option><option value="cash">Cash</option><option value="third-party">Third-party transfer</option></select></Field>
          {draft.paymentMethod !== "cash" && <>
            <Field label="Bank"><Input value={draft.bankDetails.bank} onChange={(e) => set({ bankDetails: { ...draft.bankDetails, bank: e.target.value } })} /></Field>
            <Field label="Account name"><Input value={draft.bankDetails.accountName} onChange={(e) => set({ bankDetails: { ...draft.bankDetails, accountName: e.target.value } })} /></Field>
            <Field label="Account number"><Input value={draft.bankDetails.accountNumber} onChange={(e) => set({ bankDetails: { ...draft.bankDetails, accountNumber: e.target.value } })} /></Field>
          </>}
        </div>
        {draft.paymentMethod === "third-party" && <div className="rounded-lg border border-red-300 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/40">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-red-800 dark:text-red-200"><AlertTriangle className="h-4 w-4" />Pay goes to someone other than the employee. This is flagged red on every review screen.</p>
          <Field label="Third-party reason (mandatory)"><Input value={draft.thirdPartyReason} onChange={(e) => set({ thirdPartyReason: e.target.value })} placeholder="Who receives the pay and why" /></Field>
        </div>}
      </Section>

      <Section title="Dated cost allocation" description="Each version has a home (registered) branch and lines that must total 100%."
        action={<Button type="button" size="sm" variant="outline" onClick={addVersion} disabled={!branchIds.length}><Plus className="mr-1.5 h-4 w-4" />Add version</Button>}>
        {!branchIds.length && <p className="text-xs text-muted-foreground">No branch has payroll details yet. Add them in <Link href="/payroll/setup" className="underline">Payroll setup</Link>.</p>}
        <div className="grid items-end gap-3 rounded-lg bg-muted/50 p-3 sm:grid-cols-[200px_1fr]">
          <Field label="Preview as of"><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
          <div className="text-xs">{active ? <>
            <p className="font-semibold">Active from {active.effectiveFrom} · home {branchName(active.homeBranchId)}</p>
            <ul className="mt-1 space-y-0.5">{active.lines.map((line, i) => {
              const account = resolvePayingAccount(ctx, line, asOf);
              return <li key={i}>{branchName(line.costCentre)} {line.percent}% · {ctx.entities.find((e) => e.id === line.entityId)?.name ?? "No entity"} · paid from {account ? `${account.label} (${account.fileFormat})` : "unresolved account"}{line.payingAccountId ? " · override" : ""}</li>;
            })}</ul></> : <p className="text-muted-foreground">No allocation is effective on {asOf}.</p>}</div>
        </div>
        <p className="text-xs text-muted-foreground">Service charge follows the earning-month allocation; SSO and PIT are calculated once, on the home branch.</p>
        {draft.allocations.map((version, vi) => {
          const total = version.lines.reduce((s, l) => s + (Number.isFinite(l.percent) ? l.percent : 0), 0);
          return <div key={vi} className="space-y-2 rounded-lg border p-3">
            <div className="grid items-end gap-2 sm:grid-cols-[180px_1fr_auto_auto]">
              <Field label="Effective from"><Input type="date" value={version.effectiveFrom} onChange={(e) => setVersion(vi, { effectiveFrom: e.target.value })} /></Field>
              <Field label="Home / registered branch"><select className={selectClass} value={version.homeBranchId} onChange={(e) => setVersion(vi, { homeBranchId: e.target.value })}>
                {branchIds.map((id) => <option key={id} value={id}>{branchName(id)}</option>)}</select></Field>
              <span className={`rounded px-2 py-2 text-xs font-semibold tabular-nums ${Math.abs(total - 100) < 0.001 ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200" : "bg-red-100 text-red-800"}`}>Total {total}%</span>
              <Button type="button" size="icon" variant="ghost" aria-label={`Remove version ${version.effectiveFrom}`} disabled={draft.allocations.length <= 1}
                onClick={() => set({ allocations: draft.allocations.filter((_, i) => i !== vi) })}><Trash2 className="h-4 w-4" /></Button>
            </div>
            {version.lines.map((line, li) => <div key={li} className="grid items-end gap-2 rounded-md bg-muted/30 p-2 sm:grid-cols-[1.3fr_90px_1.2fr_1.3fr_auto]">
              <Field label="Cost centre"><select className={selectClass} value={line.costCentre} onChange={(e) => setLine(vi, li, { costCentre: e.target.value })}>
                {branchIds.map((id) => <option key={id} value={id}>{branchName(id)}</option>)}<option value={OWNER_NON_OPERATIONAL}>{OWNER_NON_OPERATIONAL_LABEL}</option></select></Field>
              <Field label="Percent"><NumberInput label="Allocation percent" value={line.percent} onChange={(percent) => setLine(vi, li, { percent })} /></Field>
              <Field label="Entity"><select className={selectClass} value={line.entityId} onChange={(e) => setLine(vi, li, { entityId: e.target.value, payingAccountId: null })}>
                <option value="">Choose…</option>{ctx.entities.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.country})</option>)}</select></Field>
              <Field label="Company account"><select className={selectClass} value={line.payingAccountId ?? ""} onChange={(e) => setLine(vi, li, { payingAccountId: e.target.value || null })}>
                <option value="">{line.costCentre === OWNER_NON_OPERATIONAL ? "Choose override…" : "Branch default"}</option>
                {ctx.accounts.filter((a) => a.entityId === line.entityId).map((a) => <option key={a.id} value={a.id}>{a.label} · {a.fileFormat}</option>)}</select></Field>
              <Button type="button" size="icon" variant="ghost" aria-label="Remove allocation line" disabled={version.lines.length <= 1}
                onClick={() => setVersion(vi, { lines: version.lines.filter((_, i) => i !== li) })}><Trash2 className="h-4 w-4" /></Button>
            </div>)}
            <Button type="button" size="sm" variant="ghost" onClick={() => setVersion(vi, { lines: [...version.lines, { costCentre: OWNER_NON_OPERATIONAL, percent: 0, entityId: version.lines[0]?.entityId ?? defaultEntity, payingAccountId: null }] })}>
              <Plus className="mr-1.5 h-4 w-4" />Add line</Button>
          </div>;
        })}
      </Section>

      <Section title="Deductions and separate payments" description="Applied by company runs.">
        <Field label="Student loan monthly (THB)"><div className="max-w-xs"><NumberInput label="Student loan monthly" value={draft.studentLoanMonthly} onChange={(studentLoanMonthly) => set({ studentLoanMonthly })} /></div></Field>
        <div className="flex items-center justify-between"><h4 className="text-sm font-semibold">Salary advances</h4>
          <Button type="button" size="sm" variant="outline" onClick={() => set({ advances: [...draft.advances, { id: tempId("adv"), principal: 0, outstandingBalance: 0, repaymentMode: "one-off", instalments: 1, monthlyRepayment: 0, startsOn: todayIso() }] })}><Plus className="mr-1.5 h-4 w-4" />Add advance</Button></div>
        {draft.advances.map((a, i) => <div key={a.id} className="grid items-end gap-2 rounded-md border p-2 sm:grid-cols-3 lg:grid-cols-[1fr_1fr_1fr_90px_1fr_1fr_auto]">
          <Field label="Principal"><NumberInput label="Principal" value={a.principal} onChange={(principal) => setAdvance(i, { principal })} /></Field>
          <Field label="Outstanding"><NumberInput label="Outstanding" value={a.outstandingBalance} onChange={(outstandingBalance) => setAdvance(i, { outstandingBalance })} /></Field>
          <Field label="Repayment"><select className={selectClass} value={a.repaymentMode} onChange={(e) => setAdvance(i, { repaymentMode: e.target.value as "one-off" | "instalments", instalments: e.target.value === "one-off" ? 1 : a.instalments })}>
            <option value="one-off">One-off</option><option value="instalments">Instalments</option></select></Field>
          <Field label="Months"><NumberInput label="Instalment months" step="1" value={a.instalments} onChange={(instalments) => setAdvance(i, { instalments })} /></Field>
          <Field label="Monthly repayment"><NumberInput label="Monthly repayment" value={a.monthlyRepayment} onChange={(monthlyRepayment) => setAdvance(i, { monthlyRepayment })} /></Field>
          <Field label="Repayment starts"><Input type="date" value={a.startsOn} onChange={(e) => setAdvance(i, { startsOn: e.target.value })} /></Field>
          <Button type="button" size="icon" variant="ghost" aria-label="Remove advance" onClick={() => set({ advances: draft.advances.filter((_, r) => r !== i) })}><Trash2 className="h-4 w-4" /></Button>
        </div>)}
        <div className="flex items-center justify-between"><h4 className="text-sm font-semibold">Recurring separate payments</h4>
          <Button type="button" size="sm" variant="outline" onClick={() => set({ separatePayments: [...draft.separatePayments, { id: tempId("pay"), description: "", amount: 0, withholdingPercent: 0 }] })}><Plus className="mr-1.5 h-4 w-4" />Add payment</Button></div>
        {draft.separatePayments.map((p, i) => <div key={p.id} className="grid items-end gap-2 rounded-md border p-2 sm:grid-cols-[2fr_1fr_1fr_auto]">
          <Field label="Description"><Input value={p.description} onChange={(e) => setPayment(i, { description: e.target.value })} /></Field>
          <Field label="Amount (THB)"><NumberInput label="Amount" value={p.amount} onChange={(amount) => setPayment(i, { amount })} /></Field>
          <Field label="Withholding %"><NumberInput label="Withholding percent" value={p.withholdingPercent} onChange={(withholdingPercent) => setPayment(i, { withholdingPercent })} /></Field>
          <Button type="button" size="icon" variant="ghost" aria-label="Remove separate payment" onClick={() => set({ separatePayments: draft.separatePayments.filter((_, r) => r !== i) })}><Trash2 className="h-4 w-4" /></Button>
        </div>)}
        <Field label="Notes"><textarea className="min-h-20 w-full rounded-md border border-input bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={draft.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
      </Section>
    </fieldset>

    {errors.length > 0 && <ul role="alert" className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive" data-testid="profile-errors">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
    {canEdit && <div className="flex flex-wrap items-center justify-end gap-2 rounded-lg border bg-card p-3">
      <Button type="button" variant="ghost" onClick={() => setDraft(structuredClone(initial))}><RotateCcw className="mr-1.5 h-4 w-4" />Discard</Button>
      <Button type="button" onClick={() => setSaving(true)} disabled={errors.length > 0} data-testid="button-save-profile"><Save className="mr-1.5 h-4 w-4" />{view.reviewState === "needs-review" ? "Review and save profile" : "Save profile"}</Button>
    </div>}

    <Section title="Timeline" description="Every save of this profile: who, when and why.">
      {!view.changes.length ? <p className="text-xs text-muted-foreground">No changes yet.</p> :
        <ul className="divide-y rounded-md border">{view.changes.map((c) => <li key={c.id} className="flex flex-wrap items-baseline gap-x-3 px-3 py-2 text-sm">
          <History className="h-3.5 w-3.5 text-muted-foreground" /><span className="font-medium">{c.kind === "profile-draft" ? "Draft proposed" : "Saved"}</span>
          <span className="text-muted-foreground">{new Date(c.at).toLocaleString()}</span><span>{c.who}</span><span className="text-muted-foreground">“{c.reason}”</span>
        </li>)}</ul>}
    </Section>

    {saving && <ReasonDialog open onOpenChange={setSaving} title="Save payroll profile"
      description={view.reviewState === "needs-review" ? "Saving marks this proposed profile as reviewed and puts its pay into effect for company runs." : undefined}
      onConfirm={async (reason) => {
        await payrollCall("PUT", `/api/payroll/profiles/${encodeURIComponent(view.employee.id)}`, { profile: { ...draft, lastWorkingDay: draft.lastWorkingDay || null }, revision: view.revision, reason });
        await refreshPayroll();
      }}>
      <p className="text-sm">{WORKER_LABELS[draft.workerType]} · {draft.workerType === "day-rate" ? `${money(draft.dayRate)}/day` : draft.workerType === "contractor" ? `${money(draft.fixedFee)} fee` : `${money(draft.monthlySalary)}/month`}</p>
    </ReasonDialog>}
  </div>;
}
