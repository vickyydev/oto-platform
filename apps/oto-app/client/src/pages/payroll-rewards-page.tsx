/**
 * Service charge and incentives (SCRUM-568, R3): the prototype's
 * company-service-policies, company-service-builder, company-incentive-builder
 * / -editor / -history and company-employee-incentives, on real data. Every
 * change is a new dated version (an older one is never overwritten), and
 * recipients are dated assignments to a person or a job title. Payroll roles
 * only; every save asks why; dialogs keep the DialogBody recipe.
 */
import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { History, Pencil, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { canViewHrSalary, HR_PAY_HIDDEN_NOTE } from "@shared/hr-salary-permission";
import { PAYROLL_DISCOUNTS, PAYROLL_DISCOUNT_LABELS, type CompanyIncentive, type CompanyIncentiveKind, type RewardsView, type ServicePolicy } from "@shared/payroll-month";
import { ReasonDialog } from "@/components/payroll/reason-dialog";
import { errorText, payrollCall, refreshPayroll, useRewards } from "@/lib/payroll/api";
import { Field, NumberInput } from "@/pages/payroll-setup-page";

const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const Empty = ({ children }: { children: ReactNode }) => <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{children}</p>;
const KINDS: { kind: CompanyIncentiveKind; label: string; hint: string }[] = [
  { kind: "revenue", label: "Share of sales", hint: "sales × rate% × eligible days ÷ employed days; a target must be exceeded" },
  { kind: "team-days", label: "Team pool by days worked", hint: "(sales × rate%) shared by worked days" },
  { kind: "unit-pool", label: "Team pool per unit", hint: "count × rate, shared by eligible days" },
  { kind: "unit", label: "Per item", hint: "items × rate × day fraction" },
  { kind: "kpi", label: "KPI bonus", hint: "a fixed bonus when the KPI condition holds" },
  { kind: "guarantee", label: "Guaranteed minimum", hint: "tops pay up to a minimum, after the other incentives" },
  { kind: "manual", label: "One-off with a reason", hint: "an amount entered each month" },
];
const BASES: ServicePolicy["basis"][] = ["calendar", "worked", "equal", "role-weight"];
const toggle = (list: string[], value: string) => list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
function Section({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return <Card className="border-border shadow-sm">
    <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0 border-b border-border/70 pb-3">
      <div><CardTitle className="text-base">{title}</CardTitle>{description && <CardDescription className="mt-1 text-xs">{description}</CardDescription>}</div>{action}
    </CardHeader>
    <CardContent className="space-y-3 pt-4">{children}</CardContent>
  </Card>;
}
function Checks({ options, value, onChange }: { options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  return <div className="flex flex-wrap gap-2">{options.map((o) => <label key={o.value} className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
    <input type="checkbox" checked={value.includes(o.value)} onChange={() => onChange(toggle(value, o.value))} />{o.label}</label>)}</div>;
}

export default function PayrollRewardsPage() {
  const { user } = useAuth();
  const rewards = useRewards();
  if (!canViewHrSalary(user)) return <div className="p-6"><Empty>{HR_PAY_HIDDEN_NOTE}.</Empty></div>;
  return <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6" data-testid="page-payroll-rewards">
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-primary">Setup</p>
      <h1 className="text-2xl font-semibold">Service charge &amp; incentives</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Each change starts from a date you choose and keeps the older terms for the months before it. <Link href="/payroll/month-end" className="underline">Go to month-end</Link>.</p>
    </div>
    {rewards.isLoading && <Skeleton className="h-64 w-full" />}
    {rewards.error && <Empty>{errorText(rewards.error)}</Empty>}
    {rewards.data && <><ServicePolicies view={rewards.data} /><Incentives view={rewards.data} /></>}
  </div>;
}

type PolicyDraft = { branchId: string; month: string; percent: number; basis: ServicePolicy["basis"]; excluded: ServicePolicy["excluded"]; streams: string[]; addBack: string[] };
function ServicePolicies({ view }: { view: RewardsView }) {
  const [dialog, setDialog] = useState<PolicyDraft | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const streams = view.streams.filter((s) => !s.archivedAt);
  const label = (key: string) => view.streams.find((s) => s.key === key)?.label ?? key;
  return <Section title="Service charge" description="Each branch's pool is a percent of last month's sales (gross less VAT and service charge, plus any add-backs), shared by days. People who are not eligible keep their share with the company (retain) or are taken out (remove).">
    {!view.branches.length && <Empty>No branch has payroll details yet.</Empty>}
    {view.branches.map((b) => {
      const versions = (view.policies[b.id] ?? []).filter((p) => !p.superseded).sort((x, y) => y.effectiveFrom.localeCompare(x.effectiveFrom) || (y.version ?? 0) - (x.version ?? 0));
      const current = versions[0];
      return <div key={b.id} className="space-y-2 rounded-lg border p-3" data-testid={`policy-${b.id}`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><p className="font-medium">{b.name}</p>
            {current ? <p className="text-xs text-muted-foreground">{current.percent}% of {current.streams.map(label).join(", ")} · shared by {current.basis} days · ineligible shares {current.excluded === "retain" ? "kept by the company" : "redistributed"} · sales from {current.effectiveFrom.slice(0, 7)} (version {current.version})</p>
              : <p className="text-xs text-amber-700">No service-charge policy: the month-end shows this as a blocking item.</p>}</div>
          <div className="flex gap-1">
            {versions.length > 1 && <Button size="sm" variant="ghost" onClick={() => setHistory(history === b.id ? null : b.id)}><History className="mr-1 h-4 w-4" />History</Button>}
            {view.canManage && <Button size="sm" variant="outline" onClick={() => setDialog({ branchId: b.id, month: new Date().toISOString().slice(0, 7), percent: current?.percent ?? 0, basis: current?.basis ?? "calendar",
              excluded: current?.excluded ?? "retain", streams: current?.streams ?? [], addBack: current?.addBack ?? [] })}><Pencil className="mr-1 h-4 w-4" />{current ? "Change" : "Set up"}</Button>}
          </div>
        </div>
        {history === b.id && <ul className="divide-y text-xs">{versions.map((v) => <li key={v.version} className="py-1">v{v.version} from {v.effectiveFrom.slice(0, 7)}: {v.percent}% · {v.basis} · {v.excluded} — {v.reason} ({v.who})</li>)}</ul>}
      </div>;
    })}
    {dialog && <ReasonDialog open onOpenChange={(o) => !o && setDialog(null)} title={`Service charge · ${view.branches.find((b) => b.id === dialog.branchId)?.name}`}
      description="A new version from the sales month you choose (paid in the month after). A version for the same month replaces the earlier one; months before keep theirs."
      onConfirm={async (reason) => {
        await payrollCall("POST", `/api/payroll/setup/rewards/service-policies/${dialog.branchId}`, { month: dialog.month, reason,
          policy: { percent: dialog.percent, basis: dialog.basis, excluded: dialog.excluded, streams: dialog.streams, addBack: dialog.addBack, roleWeights: {} } });
        await refreshPayroll();
      }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Sales month it starts from"><Input type="month" value={dialog.month} onChange={(e) => setDialog({ ...dialog, month: e.target.value })} /></Field>
        <Field label="Percent of sales"><NumberInput label="Percent" value={dialog.percent} onChange={(n) => setDialog({ ...dialog, percent: n })} /></Field>
        <Field label="Shared by"><select className={selectClass} value={dialog.basis} onChange={(e) => setDialog({ ...dialog, basis: e.target.value as ServicePolicy["basis"] })}>
          {BASES.map((b) => <option key={b} value={b}>{b === "calendar" ? "Employed days" : b === "worked" ? "Worked days" : b === "equal" ? "Equal shares" : "Role weights"}</option>)}</select></Field>
        <Field label="Shares of people not eligible"><select className={selectClass} value={dialog.excluded} onChange={(e) => setDialog({ ...dialog, excluded: e.target.value as ServicePolicy["excluded"] })}>
          <option value="retain">Kept by the company</option><option value="remove">Shared among the eligible</option></select></Field>
      </div>
      <Field label="Sales streams in the pool"><Checks options={streams.map((s) => ({ value: s.key, label: s.label }))} value={dialog.streams} onChange={(v) => setDialog({ ...dialog, streams: v })} /></Field>
      <Field label="Discounts added back"><Checks options={PAYROLL_DISCOUNTS.map((d) => ({ value: d, label: PAYROLL_DISCOUNT_LABELS[d] }))} value={dialog.addBack} onChange={(v) => setDialog({ ...dialog, addBack: v })} /></Field>
    </ReasonDialog>}
  </Section>;
}

type RuleDraft = {
  id?: string; name: string; kind: CompanyIncentiveKind; branches: string[]; streams: string[]; rate: number; target: number | null; cap: number | null;
  inputKey: string; kpiOperator: CompanyIncentive["kpiOperator"]; kpiTarget: number; partMonth: "" | "prorate" | "full"; enabled: boolean;
  from: string; splitDays: boolean; selected: { staffId: string; personalRate: number | null }[]; titles: { jobTitle: string; branches: string[] }[];
};
function Incentives({ view }: { view: RewardsView }) {
  const [dialog, setDialog] = useState<RuleDraft | null>(null);
  const name = (id: string | null) => view.people.find((p) => p.id === id)?.name ?? id ?? "";
  const branchName = (id: string) => view.branches.find((b) => b.id === id)?.name ?? id;
  const today = new Date().toISOString().slice(0, 10);
  const blank: RuleDraft = { name: "", kind: "revenue", branches: [], streams: [], rate: 0, target: null, cap: null, inputKey: "", kpiOperator: "lt", kpiTarget: 0,
    partMonth: "", enabled: true, from: `${today.slice(0, 7)}-01`, splitDays: false, selected: [], titles: [] };
  const edit = (rule: CompanyIncentive): RuleDraft => {
    const live = view.assignments.filter((a) => a.ruleId === rule.id && !a.superseded && !a.excluded && (!a.effectiveTo || a.effectiveTo >= today));
    return { id: rule.id, name: rule.name, kind: rule.kind, branches: rule.base.branches, streams: rule.base.streams, rate: rule.rate, target: rule.target, cap: rule.cap,
      inputKey: rule.inputKey, kpiOperator: rule.kpiOperator, kpiTarget: rule.kpiTarget, partMonth: rule.partMonth ?? "", enabled: rule.enabled !== false,
      from: `${today.slice(0, 7)}-01`, splitDays: false,
      selected: live.filter((a) => a.staffId).map((a) => ({ staffId: a.staffId!, personalRate: a.personalRate ?? null })),
      titles: live.filter((a) => !a.staffId && a.jobTitle).map((a) => ({ jobTitle: a.jobTitle!, branches: a.branches ?? [] })) };
  };
  return <Section title="Incentives" description="Rates here are percents (2 means 2%). A change starts on the 1st of the next open month unless you split the month by days."
    action={view.canManage && <Button size="sm" onClick={() => setDialog(blank)} data-testid="button-add-incentive"><Plus className="mr-1.5 h-4 w-4" />Add incentive</Button>}>
    {!view.rules.length && <Empty>No incentives yet.</Empty>}
    {view.rules.map((rule) => {
      const versions = view.versions.filter((v) => v.ruleId === rule.id && !v.superseded).sort((a, b) => b.version - a.version);
      const live = view.assignments.filter((a) => a.ruleId === rule.id && !a.superseded && (!a.effectiveTo || a.effectiveTo >= today));
      return <div key={rule.id} className="space-y-1 rounded-lg border p-3" data-testid={`incentive-${rule.id}`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><div className="flex items-center gap-2 font-medium">{rule.name}<Badge variant="outline">{KINDS.find((k) => k.kind === rule.kind)?.label}</Badge>{rule.enabled === false && <Badge variant="secondary">Off</Badge>}</div>
            <p className="text-xs text-muted-foreground">{rule.base.branches.map(branchName).join(" + ") || "—"} · {rule.base.streams.join(", ") || "—"} · rate {rule.rate}{rule.target !== null ? ` · target over ${rule.target.toLocaleString()}` : ""}{rule.cap !== null ? ` · cap ${rule.cap.toLocaleString()}` : ""}{rule.partMonth ? ` · part months ${rule.partMonth}` : ""}</p>
            <p className="text-xs">{live.filter((a) => !a.excluded).map((a) => a.staffId ? `${name(a.staffId)}${a.personalRate !== undefined ? ` (${a.personalRate})` : ""}` : `all ${a.jobTitle}${a.branches?.length ? ` at ${a.branches.map(branchName).join(", ")}` : ""}`).join(" · ") || "Nobody assigned"}</p>
            <p className="text-[11px] text-muted-foreground">{versions.map((v) => `v${v.version} ${v.effectiveFrom}${v.effectiveTo ? `–${v.effectiveTo}` : "→"}`).join(" · ")}</p></div>
          {view.canManage && <Button size="sm" variant="outline" onClick={() => setDialog(edit(rule))}><Pencil className="mr-1 h-4 w-4" />Change</Button>}
        </div>
      </div>;
    })}
    {dialog && <ReasonDialog open onOpenChange={(o) => !o && setDialog(null)} title={dialog.id ? `Change ${dialog.name}` : "Add an incentive"}
      description={KINDS.find((k) => k.kind === dialog.kind)?.hint}
      onConfirm={async (reason) => {
        await payrollCall("POST", "/api/payroll/setup/rewards/incentives", {
          terms: { id: dialog.id, name: dialog.name, kind: dialog.kind, base: { branches: dialog.branches, streams: dialog.streams, addBack: [] }, rate: dialog.rate, target: dialog.target, cap: dialog.cap,
            inputKey: dialog.inputKey, kpiOperator: dialog.kpiOperator, kpiTarget: dialog.kpiTarget, enabled: dialog.enabled, ...(dialog.partMonth ? { partMonth: dialog.partMonth } : {}) },
          from: dialog.from, splitDays: dialog.splitDays, titles: dialog.titles, reason,
          selected: dialog.selected.map((s) => ({ staffId: s.staffId, startDate: dialog.from, ...(s.personalRate !== null && Number.isFinite(s.personalRate) ? { personalRate: s.personalRate } : {}) })),
        });
        await refreshPayroll();
      }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><Input value={dialog.name} onChange={(e) => setDialog({ ...dialog, name: e.target.value })} /></Field>
        <Field label="Kind"><select className={selectClass} value={dialog.kind} disabled={!!dialog.id} onChange={(e) => setDialog({ ...dialog, kind: e.target.value as CompanyIncentiveKind })}>
          {KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</select></Field>
        <Field label={dialog.kind === "revenue" || dialog.kind === "team-days" ? "Rate (percent of sales)" : dialog.kind === "guarantee" ? "Minimum (฿)" : "Rate (฿)"}><NumberInput label="Rate" value={dialog.rate} onChange={(n) => setDialog({ ...dialog, rate: n })} /></Field>
        <Field label="Target sales (optional)" hint="Pays only when sales are MORE than this."><NumberInput label="Target" value={dialog.target} onChange={(n) => setDialog({ ...dialog, target: Number.isFinite(n) ? n : null })} /></Field>
        <Field label="Monthly cap (optional)"><NumberInput label="Cap" value={dialog.cap} onChange={(n) => setDialog({ ...dialog, cap: Number.isFinite(n) ? n : null })} /></Field>
        {(dialog.kind === "unit-pool" || dialog.kind === "unit" || dialog.kind === "kpi") && <Field label="Input name"><Input value={dialog.inputKey} onChange={(e) => setDialog({ ...dialog, inputKey: e.target.value })} /></Field>}
        {dialog.kind === "kpi" && <Field label="KPI condition"><div className="flex gap-2"><select className={selectClass} value={dialog.kpiOperator} onChange={(e) => setDialog({ ...dialog, kpiOperator: e.target.value as RuleDraft["kpiOperator"] })}>
          <option value="lt">under</option><option value="lte">at most</option><option value="gte">at least</option><option value="gt">over</option></select>
          <NumberInput label="KPI target" value={dialog.kpiTarget} onChange={(n) => setDialog({ ...dialog, kpiTarget: n })} /></div></Field>}
        <Field label="Part months" hint="Leave as entered; it is never assumed."><select className={selectClass} value={dialog.partMonth} onChange={(e) => setDialog({ ...dialog, partMonth: e.target.value as RuleDraft["partMonth"] })}>
          <option value="">Not set (eligible ÷ employed days)</option><option value="prorate">Prorate by calendar days</option><option value="full">Full</option></select></Field>
        <Field label="Starts"><Input type="date" value={dialog.from} onChange={(e) => setDialog({ ...dialog, from: e.target.value })} /></Field>
        <label className="flex items-center gap-2 text-sm"><Switch checked={dialog.splitDays} onCheckedChange={(v) => setDialog({ ...dialog, splitDays: v })} />Split the month by days</label>
        <label className="flex items-center gap-2 text-sm"><Switch checked={dialog.enabled} onCheckedChange={(v) => setDialog({ ...dialog, enabled: v })} />On</label>
      </div>
      {(dialog.kind === "revenue" || dialog.kind === "team-days" || dialog.target !== null) && <>
        <Field label="Branches whose sales count"><Checks options={view.branches.map((b) => ({ value: b.id, label: b.name }))} value={dialog.branches} onChange={(v) => setDialog({ ...dialog, branches: v })} /></Field>
        <Field label="Sales streams"><Checks options={view.streams.filter((s) => !s.archivedAt).map((s) => ({ value: s.key, label: s.label }))} value={dialog.streams} onChange={(v) => setDialog({ ...dialog, streams: v })} /></Field>
      </>}
      <Field label="People" hint="A personal rate replaces the rule's rate for that person.">
        <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">{view.people.map((p) => {
          const chosen = dialog.selected.find((s) => s.staffId === p.id);
          return <div key={p.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!chosen} onChange={() => setDialog({ ...dialog, selected: chosen ? dialog.selected.filter((s) => s.staffId !== p.id) : [...dialog.selected, { staffId: p.id, personalRate: null }] })} />
            <span className="flex-1">{p.name} <span className="text-muted-foreground">· {p.jobTitle}</span></span>
            {chosen && <div className="w-28"><NumberInput label={`${p.name} personal rate`} value={chosen.personalRate} onChange={(n) => setDialog({ ...dialog, selected: dialog.selected.map((s) => s.staffId === p.id ? { ...s, personalRate: Number.isFinite(n) ? n : null } : s) })} /></div>}
          </div>;
        })}</div>
      </Field>
      <Field label="Everyone with a job title">
        <div className="space-y-2">{dialog.titles.map((t, i) => <div key={i} className="flex flex-wrap items-center gap-2">
          <Input className="w-48" value={t.jobTitle} onChange={(e) => setDialog({ ...dialog, titles: dialog.titles.map((x, j) => j === i ? { ...x, jobTitle: e.target.value } : x) })} />
          <Checks options={view.branches.map((b) => ({ value: b.id, label: b.name }))} value={t.branches} onChange={(v) => setDialog({ ...dialog, titles: dialog.titles.map((x, j) => j === i ? { ...x, branches: v } : x) })} />
          <Button size="sm" variant="ghost" onClick={() => setDialog({ ...dialog, titles: dialog.titles.filter((_, j) => j !== i) })}>Remove</Button></div>)}
          <Button size="sm" variant="outline" onClick={() => setDialog({ ...dialog, titles: [...dialog.titles, { jobTitle: "", branches: [] }] })}><Plus className="mr-1 h-4 w-4" />Job title</Button></div>
      </Field>
    </ReasonDialog>}
  </Section>;
}
