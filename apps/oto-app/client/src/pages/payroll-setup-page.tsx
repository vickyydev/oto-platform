/**
 * Payroll setup (SCRUM-567, R2): the prototype's setup hub
 * (payroll-setup-hub-demo-page, paying-configuration-editor, the settings
 * page's company and statutory sections, the deductions page, EWF settings),
 * on real data. Payroll roles only; every save asks for a reason. Pay
 * components, incentives and service charge arrive with month inputs (R3).
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link, useSearch } from "wouter";
import { AlertTriangle, Archive, Building2, History, Landmark, Pencil, Plus, Scale, ShieldCheck, Users, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/use-auth";
import { canViewHrSalary, HR_PAY_HIDDEN_NOTE } from "@shared/hr-salary-permission";
import {
  BANK_FILE_FORMATS, RULEBOOK_EWF_SETTINGS, rulebookThaiDeductionRules,
  type BranchDetails, type DeductionRule, type EwfSettings, type PayingAccount, type PayingEntity,
  type PayrollSetupBranch, type PayrollSetupView, type StatutoryRules,
} from "@shared/payroll-config";
import { ReasonDialog } from "@/components/payroll/reason-dialog";
import { errorText, money, payrollCall, refreshPayroll, usePayrollSetup, useSetupChanges } from "@/lib/payroll/api";

const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
/** The first of this month in the park timezone: branch details count from the month they start in. */
const monthStart = () => `${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7)}-01`;
const monthName = (date: string) => new Date(`${date.slice(0, 7)}-01T00:00:00Z`).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const latest = <T extends { effectiveFrom: string }>(items: T[]) => [...items].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <div className="min-w-0 space-y-1"><Label className="text-xs">{label}</Label>{children}{hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}</div>;
}
export function NumberInput({ value, onChange, label, step = "any" }: { value: number | null; onChange: (n: number) => void; label: string; step?: string }) {
  return <Input type="number" aria-label={label} step={step} min={0} value={value == null || !Number.isFinite(value) ? "" : value}
    onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))} />;
}
/** A rate stored as a decimal (0.05), edited as a percent (5). */
function PercentInput({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  return <NumberInput label={label} value={Number.isFinite(value) ? Math.round(value * 1e6) / 1e4 : Number.NaN} onChange={(n) => onChange(n / 100)} />;
}
function Section({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return <Card className="border-border shadow-sm">
    <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0 border-b border-border/70 pb-3">
      <div><CardTitle className="text-base">{title}</CardTitle>{description && <CardDescription className="mt-1 text-xs">{description}</CardDescription>}</div>{action}
    </CardHeader>
    <CardContent className="space-y-3 pt-4">{children}</CardContent>
  </Card>;
}
const Empty = ({ children }: { children: ReactNode }) => <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{children}</p>;

export default function PayrollSetupPage() {
  const { user } = useAuth();
  const seesPay = canViewHrSalary(user?.role);
  const setup = usePayrollSetup();
  if (!seesPay) return <div className="p-6"><Empty>{HR_PAY_HIDDEN_NOTE}.</Empty></div>;
  return <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6" data-testid="page-payroll-setup">
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-primary">Setup</p>
      <h1 className="text-2xl font-semibold">Payroll setup</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Company accounts, pay rules and country rates, one tab at a time. Each change starts from a date you choose and keeps a history of who changed what and why.</p>
      <div className="mt-2 flex flex-wrap gap-3 text-sm font-semibold">
        <Link href="/payroll/setup/rewards" className="text-primary underline underline-offset-2">Service charge &amp; incentives</Link>
        <Link href="/payroll/month-end" className="text-primary underline underline-offset-2">Month-end</Link>
      </div>
    </div>
    {setup.isLoading && <Skeleton className="h-64 w-full" />}
    {setup.error && <Empty>{errorText(setup.error)}</Empty>}
    {setup.data && <SetupTabs view={setup.data} />}
  </div>;
}

/** The tabs an address may open with (?tab=): the old statutory-rules address lands on its rates. */
const SETUP_TABS = ["company", "branches", "staff", "statutory", "deductions", "ewf", "streams", "history"] as const;

function SetupTabs({ view }: { view: PayrollSetupView }) {
  const asked = new URLSearchParams(useSearch()).get("tab");
  return <Tabs defaultValue={SETUP_TABS.find((t) => t === asked) ?? "company"} className="space-y-4">
    <TabsList className="flex h-auto flex-wrap justify-start">
      <TabsTrigger value="company">Company &amp; bank accounts</TabsTrigger>
      <TabsTrigger value="branches">Branch payroll details</TabsTrigger>
      <TabsTrigger value="staff">Staff roster</TabsTrigger>
      <TabsTrigger value="statutory">Statutory rates</TabsTrigger>
      <TabsTrigger value="deductions">Deduction rules</TabsTrigger>
      <TabsTrigger value="ewf">Welfare fund</TabsTrigger>
      <TabsTrigger value="streams">Revenue streams</TabsTrigger>
      <TabsTrigger value="history">Change history</TabsTrigger>
    </TabsList>
    <TabsContent value="company"><CompanyTab view={view} /></TabsContent>
    <TabsContent value="branches"><BranchesTab view={view} /></TabsContent>
    <TabsContent value="staff">
      <Section title="Staff roster" description="One payroll profile per person: job, split, pay method, extras and deductions.">
        <Link href="/payroll/people" className="inline-flex items-center gap-2 font-semibold text-primary underline underline-offset-2"><Users className="h-4 w-4" />Open the staff roster</Link>
      </Section>
    </TabsContent>
    <TabsContent value="statutory"><StatutoryTab view={view} /></TabsContent>
    <TabsContent value="deductions"><DeductionsTab view={view} /></TabsContent>
    <TabsContent value="ewf"><EwfTab view={view} /></TabsContent>
    <TabsContent value="streams"><StreamsTab view={view} /></TabsContent>
    <TabsContent value="history"><HistoryTab /></TabsContent>
  </Tabs>;
}

// ─── Company & bank accounts ─────────────────────────────────────────────────

type EntityDraft = { name: string; taxId: string; ssoEmployerNumber: string; defaultPayDay: number };
type AccountDraft = Omit<PayingAccount, "id" | "archivedAt">;

function CompanyTab({ view }: { view: PayrollSetupView }) {
  const [entityDialog, setEntityDialog] = useState<{ id?: string; draft: EntityDraft } | null>(null);
  const [accountDialog, setAccountDialog] = useState<{ id?: string; draft: AccountDraft } | null>(null);
  const [archive, setArchive] = useState<{ kind: "entities" | "accounts"; id: string; name: string } | null>(null);
  const entities = view.entities;
  return <div className="space-y-4">
    <Section title="Legal entities" description="The company that pays. Branches are cost centres of an entity, not employers."
      action={view.canManage && <Button size="sm" variant="outline" onClick={() => setEntityDialog({ draft: { name: "", taxId: "", ssoEmployerNumber: "", defaultPayDay: 28 } })} data-testid="button-add-entity"><Plus className="mr-1.5 h-4 w-4" />Add entity</Button>}>
      {!entities.length && <Empty>No legal entities yet. Add the company that pays, with its tax ID and SSO employer number.</Empty>}
      {entities.map((entity) => {
        const accounts = view.accounts.filter((a) => a.entityId === entity.id);
        return <div key={entity.id} className="space-y-3 rounded-lg border p-3" data-testid={`entity-${entity.id}`}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="flex items-center gap-2 font-medium"><Building2 className="h-4 w-4 text-muted-foreground" />{entity.name}
                <Badge variant="outline">{entity.country}</Badge>{entity.archivedAt && <Badge variant="secondary">Archived</Badge>}</p>
              <p className="text-xs text-muted-foreground">Tax ID {entity.taxId || "—"} · SSO employer {entity.ssoEmployerNumber || "—"} · pay day {entity.defaultPayDay}</p>
            </div>
            {view.canManage && !entity.archivedAt && <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => setEntityDialog({ id: entity.id, draft: { name: entity.name, taxId: entity.taxId ?? "", ssoEmployerNumber: entity.ssoEmployerNumber ?? "", defaultPayDay: entity.defaultPayDay } })}><Pencil className="mr-1 h-4 w-4" />Edit</Button>
              <Button size="sm" variant="ghost" onClick={() => setAccountDialog({ draft: { entityId: entity.id, label: "", bank: "", bankCode: "", accountName: entity.name, accountNumber: "", fileFormat: "GENERIC" } })}><Plus className="mr-1 h-4 w-4" />Bank account</Button>
              <Button size="sm" variant="ghost" aria-label={`Archive ${entity.name}`} onClick={() => setArchive({ kind: "entities", id: entity.id, name: entity.name })}><Archive className="h-4 w-4" /></Button>
            </div>}
          </div>
          {accounts.length === 0 ? <p className="text-xs text-muted-foreground">No company bank accounts yet.</p> :
            <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wider text-muted-foreground"><tr><th className="py-1">Account</th><th>Bank</th><th>Number</th><th>File</th><th /></tr></thead>
              <tbody className="divide-y">{accounts.map((account) => <tr key={account.id}>
                <td className="py-2"><Landmark className="mr-1 inline h-3.5 w-3.5 text-muted-foreground" />{account.label}{account.archivedAt && <Badge variant="secondary" className="ml-2">Archived</Badge>}</td>
                <td>{account.bank}{account.bankCode ? ` (${account.bankCode})` : ""}</td>
                <td className="tabular-nums">{account.accountNumber}</td>
                <td>{account.fileFormat}{account.scbProduct ? ` · ${account.scbProduct}` : ""}</td>
                <td className="text-right">{view.canManage && !account.archivedAt && <>
                  <Button size="sm" variant="ghost" onClick={() => setAccountDialog({ id: account.id, draft: { ...account } })}><Pencil className="h-4 w-4" /></Button>
                  <Button size="sm" variant="ghost" aria-label={`Archive ${account.label}`} onClick={() => setArchive({ kind: "accounts", id: account.id, name: account.label })}><Archive className="h-4 w-4" /></Button>
                </>}</td>
              </tr>)}</tbody>
            </table></div>}
        </div>;
      })}
    </Section>

    {entityDialog && <ReasonDialog open onOpenChange={(o) => !o && setEntityDialog(null)} title={entityDialog.id ? "Edit legal entity" : "Add legal entity"}
      description="Thailand payroll only. Malaysia is kept as dormant configuration."
      onConfirm={async (reason) => {
        const body = { ...entityDialog.draft, country: "TH", reason };
        await payrollCall(entityDialog.id ? "PATCH" : "POST", entityDialog.id ? `/api/payroll/setup/entities/${entityDialog.id}` : "/api/payroll/setup/entities", body);
        await refreshPayroll();
      }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><Field label="Legal name"><Input value={entityDialog.draft.name} onChange={(e) => setEntityDialog({ ...entityDialog, draft: { ...entityDialog.draft, name: e.target.value } })} data-testid="input-entity-name" /></Field></div>
        <Field label="Tax ID"><Input value={entityDialog.draft.taxId} onChange={(e) => setEntityDialog({ ...entityDialog, draft: { ...entityDialog.draft, taxId: e.target.value } })} /></Field>
        <Field label="SSO employer number"><Input value={entityDialog.draft.ssoEmployerNumber} onChange={(e) => setEntityDialog({ ...entityDialog, draft: { ...entityDialog.draft, ssoEmployerNumber: e.target.value } })} /></Field>
        <Field label="Default pay day" hint="Copied to each month's run; editable per run."><NumberInput label="Default pay day" step="1" value={entityDialog.draft.defaultPayDay} onChange={(n) => setEntityDialog({ ...entityDialog, draft: { ...entityDialog.draft, defaultPayDay: n } })} /></Field>
      </div>
    </ReasonDialog>}

    {accountDialog && <ReasonDialog open onOpenChange={(o) => !o && setAccountDialog(null)} title={accountDialog.id ? "Edit company bank account" : "Add company bank account"}
      onConfirm={async (reason) => {
        await payrollCall(accountDialog.id ? "PATCH" : "POST", accountDialog.id ? `/api/payroll/setup/accounts/${accountDialog.id}` : "/api/payroll/setup/accounts", { ...accountDialog.draft, reason });
        await refreshPayroll();
      }}>
      <AccountFields draft={accountDialog.draft} onChange={(draft) => setAccountDialog({ ...accountDialog, draft })} />
    </ReasonDialog>}

    {archive && <ReasonDialog open onOpenChange={(o) => !o && setArchive(null)} title={`Archive ${archive.name}?`} confirmLabel="Archive"
      description="Archived records stay in history and are no longer offered for new profiles."
      onConfirm={async (reason) => { await payrollCall("POST", `/api/payroll/setup/${archive.kind}/${archive.id}/archive`, { reason }); await refreshPayroll(); }} />}
  </div>;
}

function AccountFields({ draft, onChange }: { draft: AccountDraft; onChange: (d: AccountDraft) => void }) {
  const set = (patch: Partial<AccountDraft>) => onChange({ ...draft, ...patch });
  return <div className="grid gap-3 sm:grid-cols-2">
    <Field label="Label"><Input value={draft.label} onChange={(e) => set({ label: e.target.value })} data-testid="input-account-label" /></Field>
    <Field label="Bank"><Input value={draft.bank} onChange={(e) => set({ bank: e.target.value })} /></Field>
    <Field label="Bank code" hint="SCB is 014."><Input value={draft.bankCode ?? ""} onChange={(e) => set({ bankCode: e.target.value })} /></Field>
    <Field label="Account number"><Input value={draft.accountNumber} onChange={(e) => set({ accountNumber: e.target.value })} /></Field>
    <div className="sm:col-span-2"><Field label="Account name"><Input value={draft.accountName} onChange={(e) => set({ accountName: e.target.value })} /></Field></div>
    <Field label="Bank file format"><select className={selectClass} value={draft.fileFormat} onChange={(e) => set({ fileFormat: e.target.value as PayingAccount["fileFormat"] })}>
      {BANK_FILE_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}</select></Field>
    {draft.fileFormat === "SCB" && <Field label="SCB product"><select className={selectClass} value={draft.scbProduct ?? ""} onChange={(e) => set({ scbProduct: (e.target.value || undefined) as "PAY" | "SPN" | undefined })}>
      <option value="">Choose…</option><option value="PAY">PAY</option><option value="SPN">SPN</option></select></Field>}
    <Field label="Debit account (optional)"><Input value={draft.debitAccount ?? ""} onChange={(e) => set({ debitAccount: e.target.value })} /></Field>
    <Field label="Fee account (optional)"><Input value={draft.feeAccount ?? ""} onChange={(e) => set({ feeAccount: e.target.value })} /></Field>
  </div>;
}

// ─── Branch payroll details ──────────────────────────────────────────────────

type DetailsDraft = { effectiveFrom: string; foodAllowanceDefault: number | null; details: Partial<BranchDetails> };

function BranchesTab({ view }: { view: PayrollSetupView }) {
  const [dialog, setDialog] = useState<{ branch: PayrollSetupBranch; draft: DetailsDraft } | null>(null);
  const liveEntities = view.entities.filter((e) => !e.archivedAt);
  return <Section title="Branch payroll details" description="Each branch is a cost centre of a paying entity. Details are dated: a new version applies from its date, earlier months keep theirs.">
    {!view.branches.length && <Empty>This park group has no branches.</Empty>}
    {view.branches.map((branch) => {
      const current = latest(branch.detailsHistory);
      const entity = view.entities.find((e) => e.id === current?.details.payingEntityId);
      const account = view.accounts.find((a) => a.id === current?.details.defaultPayingAccountId);
      return <div key={branch.id} className="rounded-lg border p-3" data-testid={`branch-details-${branch.id}`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="font-medium">{branch.name}</p>
            {current ? <p className="text-xs text-muted-foreground">From {current.effectiveFrom} · {entity?.name ?? "No paying entity"} · default account {account?.label ?? "none"} · SSO branch {current.details.ssoBranchNumber || "—"} · food {money(current.foodAllowanceDefault)}/day · pay date {current.details.payDate}</p>
              : <p className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300"><AlertTriangle className="h-3.5 w-3.5" />No payroll details yet: profiles cannot be allocated to this branch.</p>}
          </div>
          {view.canManage && <Button size="sm" variant="outline" disabled={!liveEntities.length} onClick={() => setDialog({
            branch, draft: {
              effectiveFrom: monthStart(), foodAllowanceDefault: current?.foodAllowanceDefault ?? null,
              details: current ? { ...current.details } : { country: "TH", payDate: 28, name: branch.name, timezone: branch.timezone, payingEntityId: liveEntities[0]?.id },
            },
          })}><Plus className="mr-1.5 h-4 w-4" />New version</Button>}
        </div>
        {branch.detailsHistory.length > 1 && <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">History ({branch.detailsHistory.length})</summary>
          <ul className="mt-1 space-y-0.5">{[...branch.detailsHistory].reverse().map((v) => <li key={v.id}>{v.effectiveFrom} · {v.who || "—"} · {v.reason}</li>)}</ul></details>}
      </div>;
    })}
    {!liveEntities.length && view.branches.length > 0 && <p className="text-xs text-muted-foreground">Add a legal entity first; branch details name the entity that pays.</p>}
    {dialog && <ReasonDialog open onOpenChange={(o) => !o && setDialog(null)} title={`Payroll details: ${dialog.branch.name}`}
      onConfirm={async (reason) => {
        await payrollCall("POST", `/api/payroll/setup/branches/${dialog.branch.id}/details`, { ...dialog.draft, reason });
        await refreshPayroll();
      }}>
      <BranchDetailsFields view={view} draft={dialog.draft} onChange={(draft) => setDialog({ ...dialog, draft })} />
    </ReasonDialog>}
  </Section>;
}

function BranchDetailsFields({ view, draft, onChange }: { view: PayrollSetupView; draft: DetailsDraft; onChange: (d: DetailsDraft) => void }) {
  const d = draft.details;
  const setD = (patch: Partial<BranchDetails>) => onChange({ ...draft, details: { ...d, ...patch } });
  const accounts = view.accounts.filter((a) => !a.archivedAt && a.entityId === d.payingEntityId);
  const midMonth = /^d{4}-d{2}-d{2}$/.test(draft.effectiveFrom) && !draft.effectiveFrom.endsWith("-01");
  return <div className="grid gap-3 sm:grid-cols-2">
    {midMonth && <p role="alert" className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs sm:col-span-2" data-testid="warning-mid-month">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />Dated mid-month, these details do not count for {monthName(draft.effectiveFrom)}: a branch with no earlier details is left out of the whole {monthName(draft.effectiveFrom)} payroll, and its people with it. Choose {draft.effectiveFrom.slice(0, 8)}01 to include {monthName(draft.effectiveFrom)}.</p>}
    <Field label="Effective from" hint="Payroll reads branch details by month: use the 1st of the month they start in.">
      <Input type="date" value={draft.effectiveFrom} onChange={(e) => onChange({ ...draft, effectiveFrom: e.target.value })} data-testid="input-branch-effective-from" /></Field>
    <Field label="Country"><div className="flex h-10 items-center rounded-md border bg-muted/40 px-3 text-sm">Thailand · THB</div></Field>
    <Field label="Paying entity"><select className={selectClass} value={d.payingEntityId ?? ""} onChange={(e) => setD({ payingEntityId: e.target.value || undefined, defaultPayingAccountId: undefined })}>
      <option value="">Choose…</option>{view.entities.filter((e) => !e.archivedAt).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
    <Field label="Default paying account"><select className={selectClass} value={d.defaultPayingAccountId ?? ""} onChange={(e) => setD({ defaultPayingAccountId: e.target.value || undefined })}>
      <option value="">No default</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.label} · {a.fileFormat}</option>)}</select></Field>
    <Field label="SSO branch number" hint="Six digits, from the SSO registration."><Input value={d.ssoBranchNumber ?? ""} maxLength={6} onChange={(e) => setD({ ssoBranchNumber: e.target.value })} /></Field>
    <Field label="Food allowance default (per day)" hint="New profiles start from this."><NumberInput label="Food allowance default" value={draft.foodAllowanceDefault} onChange={(n) => onChange({ ...draft, foodAllowanceDefault: Number.isFinite(n) ? n : null })} /></Field>
    <Field label="Legal entity name"><Input value={d.legalEntity ?? ""} onChange={(e) => setD({ legalEntity: e.target.value })} /></Field>
    <Field label="Employer number"><Input value={d.employerNumber ?? ""} onChange={(e) => setD({ employerNumber: e.target.value })} /></Field>
    <Field label="Tax ID"><Input value={d.taxId ?? ""} onChange={(e) => setD({ taxId: e.target.value })} /></Field>
    <Field label="Payroll bank"><Input value={d.payrollBank ?? ""} onChange={(e) => setD({ payrollBank: e.target.value })} /></Field>
    <Field label="Pay date"><select className={selectClass} value={String(d.payDate ?? 28)} onChange={(e) => setD({ payDate: e.target.value === "last" ? "last" : Number(e.target.value) })}>
      <option value="last">Last day of the month</option>{Array.from({ length: 31 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}</select></Field>
    <div className="sm:col-span-2"><Field label="Address"><Input value={d.address ?? ""} onChange={(e) => setD({ address: e.target.value })} /></Field></div>
  </div>;
}

// ─── Statutory rates ─────────────────────────────────────────────────────────

function StatutoryTab({ view }: { view: PayrollSetupView }) {
  const company = view.ruleSets.filter((r) => r.branchId === null && r.country === "TH");
  const current = latest(company);
  const [dialog, setDialog] = useState<{ month: string; branchId: string; rules: StatutoryRules } | null>(null);
  if (!current) return <Empty>No Thai rule set yet.</Empty>;
  const r = current.rules;
  return <Section title="Statutory rates — Thailand" description="Company rates apply to every branch unless a branch has its own exception. Check new rates with your accountant before saving."
    action={view.canManage && <Button size="sm" variant="outline" onClick={() => setDialog({ month: new Date().toISOString().slice(0, 7), branchId: "", rules: structuredClone(r) })}><Plus className="mr-1.5 h-4 w-4" />New version</Button>}>
    <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
      <Stat icon={<ShieldCheck className="h-4 w-4" />} label="SSO" value={`${r.thSso.employeeRate * 100}% + ${r.thSso.employerRate * 100}% on wages capped ${money(r.thSso.wageCap)}`} />
      <Stat icon={<Scale className="h-4 w-4" />} label="PIT" value={`${r.thPit.brackets.length} brackets · expense ${r.thPit.employmentExpenseRate * 100}% capped ${money(r.thPit.employmentExpenseCap)} · allowance ${money(r.thPit.personalAllowance)}`} />
      <Stat icon={<Wallet className="h-4 w-4" />} label="Overtime" value={`${r.overtimeMultipliers.regular}× / ${r.overtimeMultipliers.restDay}× / ${r.overtimeMultipliers.publicHoliday}× · hourly base ${r.hourlyBase.monthlySalaryDays} days × ${r.hourlyBase.monthlyHoursPerDay} h`} />
      <Stat label="Proration" value={r.calendarProration.method === "actual-calendar-days" ? "Actual days in the month" : `Fixed divisor ${r.calendarProration.divisor}`} />
      <Stat label="Fixed allowances" value={r.allowances.length ? r.allowances.map((a) => `${a.name} ${money(a.amount)}`).join(", ") : "None"} />
      <Stat label="In force from" value={`${current.effectiveFrom}${current.who ? ` · ${current.who}` : ""}`} />
    </div>
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">All versions ({view.ruleSets.length})</summary>
      <ul className="mt-1 space-y-0.5">{[...view.ruleSets].reverse().map((v) => <li key={v.id}>{v.effectiveFrom} · {v.branchId ? `exception: ${view.branches.find((b) => b.id === v.branchId)?.name}` : "company"} · {v.who || "seeded"} · {v.reason}</li>)}</ul></details>
    {dialog && <ReasonDialog open onOpenChange={(o) => !o && setDialog(null)} title="New statutory rates version"
      description="Earlier months keep their old rates."
      onConfirm={async (reason) => {
        await payrollCall("POST", "/api/payroll/setup/rule-sets", { country: "TH", branchId: dialog.branchId || null, effectiveFrom: dialog.month, rules: dialog.rules, reason });
        await refreshPayroll();
      }}>
      <RulesFields view={view} dialog={dialog} onChange={setDialog} />
    </ReasonDialog>}
  </Section>;
}

function Stat({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  return <div className="rounded-lg border bg-muted/20 p-3"><p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{icon}{label}</p><p className="mt-1">{value}</p></div>;
}

function RulesFields({ view, dialog, onChange }: { view: PayrollSetupView; dialog: { month: string; branchId: string; rules: StatutoryRules }; onChange: (d: { month: string; branchId: string; rules: StatutoryRules }) => void }) {
  const r = dialog.rules;
  const set = (rules: StatutoryRules) => onChange({ ...dialog, rules });
  return <div className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Rates effective from (month)"><Input type="month" value={dialog.month} onChange={(e) => onChange({ ...dialog, month: e.target.value })} /></Field>
      <Field label="Applies to"><select className={selectClass} value={dialog.branchId} onChange={(e) => onChange({ ...dialog, branchId: e.target.value })}>
        <option value="">The company (every branch)</option>{view.branches.map((b) => <option key={b.id} value={b.id}>Exception: {b.name}</option>)}</select></Field>
    </div>
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="SSO wage cap (THB)"><NumberInput label="SSO wage cap" value={r.thSso.wageCap} onChange={(n) => set({ ...r, thSso: { ...r.thSso, wageCap: n } })} /></Field>
      <Field label="SSO employee rate (%)" hint="Employer is kept equal."><PercentInput label="SSO rate" value={r.thSso.employeeRate} onChange={(n) => set({ ...r, thSso: { ...r.thSso, employeeRate: n, employerRate: n } })} /></Field>
      <Field label="PIT expense rate (%)"><PercentInput label="PIT expense rate" value={r.thPit.employmentExpenseRate} onChange={(n) => set({ ...r, thPit: { ...r.thPit, employmentExpenseRate: n } })} /></Field>
      <Field label="PIT expense cap (THB)"><NumberInput label="PIT expense cap" value={r.thPit.employmentExpenseCap} onChange={(n) => set({ ...r, thPit: { ...r.thPit, employmentExpenseCap: n } })} /></Field>
      <Field label="PIT personal allowance (THB)"><NumberInput label="PIT personal allowance" value={r.thPit.personalAllowance} onChange={(n) => set({ ...r, thPit: { ...r.thPit, personalAllowance: n } })} /></Field>
      <Field label="Proration"><select className={selectClass} value={r.calendarProration.method} onChange={(e) => set({ ...r, calendarProration: { ...r.calendarProration, method: e.target.value as StatutoryRules["calendarProration"]["method"] } })}>
        <option value="actual-calendar-days">Actual days in the month</option><option value="fixed-divisor">Fixed divisor</option></select></Field>
      {(["regular", "restDay", "publicHoliday"] as const).map((k) => <Field key={k} label={`OT multiplier: ${k === "regular" ? "regular" : k === "restDay" ? "rest day" : "public holiday"}`}>
        <NumberInput label={`OT ${k}`} value={r.overtimeMultipliers[k]} onChange={(n) => set({ ...r, overtimeMultipliers: { ...r.overtimeMultipliers, [k]: n } })} /></Field>)}
    </div>
    {r.calendarProration.method === "fixed-divisor" && <p className="flex items-center gap-1.5 rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"><AlertTriangle className="h-4 w-4" />Fixed allowances still prorate by actual days in the month; only salary uses the divisor.</p>}
    <div className="space-y-2">
      <p className="text-sm font-semibold">PIT brackets</p>
      {r.thPit.brackets.map((b, i) => <div key={i} className="grid grid-cols-3 gap-2">
        <NumberInput label={`Bracket ${i + 1} from`} value={b.from} onChange={(n) => set({ ...r, thPit: { ...r.thPit, brackets: r.thPit.brackets.map((x, j) => j === i ? { ...x, from: n } : j === i - 1 ? { ...x, to: n } : x) } })} />
        {b.to === null ? <div className="flex h-10 items-center rounded-md border bg-muted/40 px-3 text-xs text-muted-foreground">No upper limit</div> : <div className="flex h-10 items-center px-1 text-xs text-muted-foreground">to {b.to.toLocaleString()}</div>}
        <PercentInput label={`Bracket ${i + 1} rate`} value={b.rate} onChange={(n) => set({ ...r, thPit: { ...r.thPit, brackets: r.thPit.brackets.map((x, j) => j === i ? { ...x, rate: n } : x) } })} />
      </div>)}
    </div>
    <div className="space-y-2">
      <div className="flex items-center justify-between"><p className="text-sm font-semibold">Fixed allowances</p>
        <Button type="button" size="sm" variant="ghost" onClick={() => set({ ...r, allowances: [...r.allowances, { id: `allowance-${r.allowances.length + 1}`, name: "", amount: 0, taxable: true, socialSecurity: true }] })}><Plus className="mr-1 h-4 w-4" />Add</Button></div>
      {r.allowances.map((a, i) => <div key={i} className="grid grid-cols-[1fr_120px_auto_auto] items-center gap-2">
        <Input aria-label="Allowance name" value={a.name} onChange={(e) => set({ ...r, allowances: r.allowances.map((x, j) => j === i ? { ...x, name: e.target.value } : x) })} />
        <NumberInput label="Allowance amount" value={a.amount} onChange={(n) => set({ ...r, allowances: r.allowances.map((x, j) => j === i ? { ...x, amount: n } : x) })} />
        <label className="flex items-center gap-1 text-xs"><Switch checked={a.socialSecurity} onCheckedChange={(v) => set({ ...r, allowances: r.allowances.map((x, j) => j === i ? { ...x, socialSecurity: v } : x) })} />SSO wage</label>
        <Button type="button" size="sm" variant="ghost" onClick={() => set({ ...r, allowances: r.allowances.filter((_, j) => j !== i) })}>Remove</Button>
      </div>)}
      {!r.allowances.length && <p className="text-xs text-muted-foreground">None. Fixed allowances go to monthly and owner-household workers, prorated by days in the month.</p>}
    </div>
  </div>;
}

// ─── Deduction rules ─────────────────────────────────────────────────────────

const ISSUE_LABELS: Record<DeductionRule["issue"], string> = { late: "Late arrival", "early-departure": "Early departure", "missed-punch": "Missed punch", "no-show": "No-show", "break-overrun": "Break overrun" };

function DeductionsTab({ view }: { view: PayrollSetupView }) {
  const [dialog, setDialog] = useState<{ scope: "company" | "branch"; branchId: string; effectiveFrom: string; rules: DeductionRule[] } | null>(null);
  const company = latest(view.deductionLists.filter((l) => l.scope === "company"));
  const exceptions = view.branches.map((b) => ({ branch: b, list: latest(view.deductionLists.filter((l) => l.branchId === b.id)) })).filter((x) => x.list);
  const open = (rules: DeductionRule[]) => setDialog({ scope: "company", branchId: "", effectiveFrom: new Date().toISOString().slice(0, 10), rules: structuredClone(rules) });
  return <Section title="Deduction rules" description="Only attendance problems a manager approved or corrected are charged. Excused ones never are."
    action={view.canManage && <div className="flex gap-2">
      {!company && <Button size="sm" variant="outline" onClick={() => open(rulebookThaiDeductionRules())}>Start from the rulebook's Thai tariffs</Button>}
      <Button size="sm" variant="outline" onClick={() => open(company?.rules ?? [])}><Plus className="mr-1.5 h-4 w-4" />New version</Button>
    </div>}>
    {!company ? <Empty>No deduction rules: nobody is charged for attendance. The rulebook's Thai tariffs can be loaded as a starting point; nothing is charged until they are saved with job titles.</Empty>
      : <RuleTable rules={company.rules} caption={`Company list from ${company.effectiveFrom} · ${company.who} · ${company.reason}`} />}
    {exceptions.map(({ branch, list }) => <RuleTable key={branch.id} rules={list!.rules} caption={`Exception for ${branch.name} from ${list!.effectiveFrom}`} />)}
    {dialog && <ReasonDialog open onOpenChange={(o) => !o && setDialog(null)} title="New deduction rules version"
      onConfirm={async (reason) => {
        await payrollCall("POST", "/api/payroll/setup/deduction-lists", { scope: dialog.scope, branchId: dialog.scope === "branch" ? dialog.branchId : null, effectiveFrom: dialog.effectiveFrom, rules: dialog.rules, reason });
        await refreshPayroll();
      }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Effective from"><Input type="date" value={dialog.effectiveFrom} onChange={(e) => setDialog({ ...dialog, effectiveFrom: e.target.value })} /></Field>
        <Field label="Applies to"><select className={selectClass} value={dialog.scope === "company" ? "" : dialog.branchId} onChange={(e) => setDialog({ ...dialog, scope: e.target.value ? "branch" : "company", branchId: e.target.value })}>
          <option value="">The company (every branch)</option>{view.branches.map((b) => <option key={b.id} value={b.id}>Exception: {b.name}</option>)}</select></Field>
      </div>
      <div className="space-y-3">{dialog.rules.map((rule, i) => {
        const patch = (p: Partial<DeductionRule>) => setDialog({ ...dialog, rules: dialog.rules.map((x, j) => j === i ? { ...x, ...p } : x) });
        return <div key={i} className="space-y-2 rounded-md border p-2">
          <div className="flex items-center justify-between gap-2"><Input aria-label="Rule name" value={rule.name} onChange={(e) => patch({ name: e.target.value })} />
            <label className="flex items-center gap-1 text-xs"><Switch checked={rule.enabled} onCheckedChange={(v) => patch({ enabled: v })} />On</label></div>
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Issue"><select className={selectClass} value={rule.issue} onChange={(e) => patch({ issue: e.target.value as DeductionRule["issue"] })}>{Object.entries(ISSUE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Amount (THB)"><NumberInput label="Amount" value={rule.amount} onChange={(n) => patch({ amount: n })} /></Field>
            <Field label="Monthly cap"><NumberInput label="Cap" value={rule.cap} onChange={(n) => patch({ cap: Number.isFinite(n) ? n : null })} /></Field>
            <Field label="Free occurrences"><NumberInput label="Free occurrences" step="1" value={rule.freeOccurrences} onChange={(n) => patch({ freeOccurrences: Number.isFinite(n) ? n : null })} /></Field>
            <Field label="Free minutes"><NumberInput label="Free minutes" step="1" value={rule.freeMinutes} onChange={(n) => patch({ freeMinutes: Number.isFinite(n) ? n : null })} /></Field>
            <Field label="Charged from"><select className={selectClass} value={rule.source} onChange={(e) => patch({ source: e.target.value as DeductionRule["source"] })}><option value="service-charge">Service charge</option><option value="salary">Salary</option></select></Field>
          </div>
          <Field label="Job titles it applies to (comma separated)" hint="Matched to the job title on each payroll profile. Empty charges nobody.">
            <Input value={(rule.jobTitles ?? []).join(", ")} onChange={(e) => patch({ jobTitles: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) })} /></Field>
          <Button type="button" size="sm" variant="ghost" onClick={() => setDialog({ ...dialog, rules: dialog.rules.filter((_, j) => j !== i) })}>Remove rule</Button>
        </div>;
      })}
      <Button type="button" size="sm" variant="outline" onClick={() => setDialog({ ...dialog, rules: [...dialog.rules, { id: `rule-${Date.now().toString(36)}`, name: "", enabled: true, issue: "late", freeOccurrences: 0, freeMinutes: null, method: "fixed", amount: 0, source: "service-charge", cap: null, roles: [], jobTitles: [], includeStaffIds: [], excludeStaffIds: [] }] })}><Plus className="mr-1 h-4 w-4" />Add rule</Button></div>
    </ReasonDialog>}
  </Section>;
}

function RuleTable({ rules, caption }: { rules: DeductionRule[]; caption: string }) {
  return <div className="overflow-x-auto rounded-lg border">
    <p className="border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{caption}</p>
    <table className="w-full min-w-[640px] text-sm"><tbody className="divide-y">{rules.map((r) => <tr key={r.id}>
      <td className="px-3 py-2">{r.name}{!r.enabled && <Badge variant="secondary" className="ml-2">Off</Badge>}</td>
      <td>{ISSUE_LABELS[r.issue]}</td><td>{money(r.amount)}{r.cap != null ? ` · cap ${money(r.cap)}` : ""}</td>
      <td className="text-xs text-muted-foreground">{r.freeOccurrences ? `${r.freeOccurrences} free` : ""}{r.freeMinutes ? ` · ${r.freeMinutes} min free` : ""}</td>
      <td className="text-xs">{r.jobTitles?.length ? r.jobTitles.join(", ") : <span className="text-amber-700 dark:text-amber-300">No job titles: charges nobody</span>}</td>
    </tr>)}</tbody></table>
  </div>;
}

// ─── Welfare fund ────────────────────────────────────────────────────────────

function EwfTab({ view }: { view: PayrollSetupView }) {
  const thai = view.entities.filter((e) => e.country === "TH" && !e.archivedAt);
  const [dialog, setDialog] = useState<{ entity: PayingEntity; effectiveFrom: string; settings: EwfSettings } | null>(null);
  const [remit, setRemit] = useState<{ entity: PayingEntity; month: string; amountPaid: number; paidOn: string } | null>(null);
  return <Section title="Employee Welfare Fund" description="Not configured until a start date is entered: until then the welfare fund contributes nothing. Enter the date and rates the accountant confirms.">
    {!thai.length && <Empty>Add a Thai legal entity first.</Empty>}
    {thai.map((entity) => {
      const versions = view.ewfSettings.filter((v) => v.entityId === entity.id);
      const current = latest(versions);
      const remittances = view.ewfRemittances.filter((r) => r.entityId === entity.id);
      return <div key={entity.id} className="space-y-2 rounded-lg border p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><p className="font-medium">{entity.name}</p>
            {current ? <p className="text-xs text-muted-foreground">From {current.effectiveFrom}: employee {current.settings.employeeRate * 100}% + employer {current.settings.employerRate * 100}% · headcount ≥ {current.settings.headcountThreshold} · provident fund {current.settings.providentFundAvailable ? "yes" : "no"}</p>
              : <Badge variant="outline">Not configured</Badge>}</div>
          {view.canManage && <div className="flex gap-1">
            <Button size="sm" variant="outline" onClick={() => setDialog({ entity, effectiveFrom: "", settings: current ? { ...current.settings } : { ...RULEBOOK_EWF_SETTINGS } })}><Plus className="mr-1 h-4 w-4" />{current ? "New version" : "Configure"}</Button>
            <Button size="sm" variant="ghost" onClick={() => setRemit({ entity, month: new Date().toISOString().slice(0, 7), amountPaid: 0, paidOn: "" })}>Record payment</Button>
          </div>}
        </div>
        {remittances.length > 0 && <ul className="text-xs text-muted-foreground">{remittances.map((r) => <li key={r.id}>{r.month}: {money(r.amountPaid)} paid {r.paidOn ?? "(date not entered)"} · {r.reason}</li>)}</ul>}
      </div>;
    })}
    {dialog && <ReasonDialog open onOpenChange={(o) => !o && setDialog(null)} title={`Welfare fund: ${dialog.entity.name}`}
      description="The rulebook's rates are filled in; the start date is never assumed."
      onConfirm={async (reason) => {
        await payrollCall("POST", "/api/payroll/setup/ewf-settings", { entityId: dialog.entity.id, effectiveFrom: dialog.effectiveFrom, settings: dialog.settings, reason });
        await refreshPayroll();
      }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Settings effective date" hint="As confirmed by the accountant."><Input type="date" value={dialog.effectiveFrom} onChange={(e) => setDialog({ ...dialog, effectiveFrom: e.target.value })} data-testid="input-ewf-date" /></Field>
        <Field label="Headcount threshold"><NumberInput label="Headcount threshold" step="1" value={dialog.settings.headcountThreshold} onChange={(n) => setDialog({ ...dialog, settings: { ...dialog.settings, headcountThreshold: n } })} /></Field>
        <Field label="Employee rate (%)"><PercentInput label="Employee rate" value={dialog.settings.employeeRate} onChange={(n) => setDialog({ ...dialog, settings: { ...dialog.settings, employeeRate: n } })} /></Field>
        <Field label="Employer rate (%)"><PercentInput label="Employer rate" value={dialog.settings.employerRate} onChange={(n) => setDialog({ ...dialog, settings: { ...dialog.settings, employerRate: n } })} /></Field>
        <label className="flex items-center gap-2 text-sm"><Switch checked={dialog.settings.providentFundAvailable} onCheckedChange={(v) => setDialog({ ...dialog, settings: { ...dialog.settings, providentFundAvailable: v } })} />A provident fund is available</label>
        <label className="flex items-center gap-2 text-sm"><Switch checked={dialog.settings.voluntaryBelowThreshold} onCheckedChange={(v) => setDialog({ ...dialog, settings: { ...dialog.settings, voluntaryBelowThreshold: v } })} />Contribute voluntarily below the threshold</label>
      </div>
    </ReasonDialog>}
    {remit && <ReasonDialog open onOpenChange={(o) => !o && setRemit(null)} title={`Welfare fund payment: ${remit.entity.name}`}
      onConfirm={async (reason) => {
        await payrollCall("PUT", "/api/payroll/setup/ewf-remittances", { entityId: remit.entity.id, month: remit.month, amountPaid: remit.amountPaid, paidOn: remit.paidOn || null, reason });
        await refreshPayroll();
      }}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Month covered"><Input type="month" value={remit.month} onChange={(e) => setRemit({ ...remit, month: e.target.value })} /></Field>
        <Field label="Amount paid (THB)"><NumberInput label="Amount paid" value={remit.amountPaid} onChange={(n) => setRemit({ ...remit, amountPaid: n })} /></Field>
        <Field label="Paid on"><Input type="date" value={remit.paidOn} onChange={(e) => setRemit({ ...remit, paidOn: e.target.value })} /></Field>
      </div>
    </ReasonDialog>}
  </Section>;
}

// ─── Revenue streams ─────────────────────────────────────────────────────────

function StreamsTab({ view }: { view: PayrollSetupView }) {
  const [dialog, setDialog] = useState<{ id?: string; key: string; label: string; archived?: boolean } | null>(null);
  return <Section title="Revenue streams" description="The streams service charge and incentives are worked out from, per branch and month."
    action={view.canManage && <Button size="sm" variant="outline" onClick={() => setDialog({ key: "", label: "" })}><Plus className="mr-1.5 h-4 w-4" />Add stream</Button>}>
    {!view.revenueStreams.length && <Empty>No revenue streams yet.</Empty>}
    <ul className="divide-y rounded-lg border">{view.revenueStreams.map((s) => <li key={s.id} className="flex items-center justify-between px-3 py-2 text-sm">
      <span>{s.label} <code className="ml-1 text-xs text-muted-foreground">{s.key}</code>{s.archivedAt && <Badge variant="secondary" className="ml-2">Archived</Badge>}</span>
      {view.canManage && <span className="flex gap-1">
        <Button size="sm" variant="ghost" onClick={() => setDialog({ id: s.id, key: s.key, label: s.label })}><Pencil className="h-4 w-4" /></Button>
        <Button size="sm" variant="ghost" onClick={() => setDialog({ id: s.id, key: s.key, label: s.label, archived: !s.archivedAt })}>{s.archivedAt ? "Restore" : "Archive"}</Button>
      </span>}
    </li>)}</ul>
    {dialog && <ReasonDialog open onOpenChange={(o) => !o && setDialog(null)} title={dialog.id ? (dialog.archived === undefined ? "Rename stream" : dialog.archived ? "Archive stream" : "Restore stream") : "Add revenue stream"}
      onConfirm={async (reason) => {
        if (dialog.id) await payrollCall("PATCH", `/api/payroll/setup/revenue-streams/${dialog.id}`, { label: dialog.label, ...(dialog.archived === undefined ? {} : { archived: dialog.archived }), reason });
        else await payrollCall("POST", "/api/payroll/setup/revenue-streams", { key: dialog.key, label: dialog.label, reason });
        await refreshPayroll();
      }}>
      {dialog.archived === undefined && <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Key" hint="Lower case, digits and dashes."><Input value={dialog.key} disabled={!!dialog.id} onChange={(e) => setDialog({ ...dialog, key: e.target.value })} /></Field>
        <Field label="Label"><Input value={dialog.label} onChange={(e) => setDialog({ ...dialog, label: e.target.value })} /></Field>
      </div>}
    </ReasonDialog>}
  </Section>;
}

// ─── History ─────────────────────────────────────────────────────────────────

function HistoryTab() {
  const changes = useSetupChanges();
  const rows = useMemo(() => changes.data ?? [], [changes.data]);
  return <Section title="Change history" description="Every setup change: who, when and why.">
    {changes.isLoading && <Skeleton className="h-24 w-full" />}
    {!changes.isLoading && !rows.length && <Empty>No setup changes yet.</Empty>}
    <ul className="divide-y rounded-lg border">{rows.map((c) => <li key={c.id} className="flex flex-wrap items-baseline gap-x-3 px-3 py-2 text-sm">
      <History className="h-3.5 w-3.5 text-muted-foreground" /><span className="font-medium">{c.subject.replace(/-/g, " ")}</span>
      <span className="text-muted-foreground">{new Date(c.at).toLocaleString()}</span><span>{c.who}</span><span className="text-muted-foreground">“{c.reason}”</span>
    </li>)}</ul>
  </Section>;
}
