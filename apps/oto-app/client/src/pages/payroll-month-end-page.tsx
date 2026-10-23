/**
 * Payroll month-end (SCRUM-568, R3; SCRUM-569, R4): the prototype's company
 * month-end page (payroll-company-month-end-demo-page with company-attendance,
 * company-inputs, company-input-boxes, company-input-sources, company-overview,
 * company-matrix and company-approvals) on real data: attendance reviews and
 * overtime decisions, month inputs with their sources, one-off adjustments,
 * the payroll feeds (leave valuations, OT bank, exits), the whole month
 * calculated with every person's lines, and the approvals — GM confirm, Owner
 * lock (which freezes the month and its payslips), mark paid and reopen.
 * Output files and downloads are R5's. Payroll roles only; every change asks
 * why; dialogs keep the DialogBody recipe.
 */
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Link, useSearch } from "wouter";
import { AlertTriangle, CalendarCheck, CheckCircle2, ChevronDown, ChevronRight, CircleDashed, Clock, Info, LockKeyhole, PenLine, Plus, RotateCcw, ShieldCheck, Trash2, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/use-auth";
import { canViewHrSalary, HR_PAY_HIDDEN_NOTE } from "@shared/hr-salary-permission";
import { PAYROLL_DISCOUNTS, PAYROLL_DISCOUNT_LABELS, type CompanyMonthInputs, type CompanyPerson, type MonthEndView, type MonthInputsView, type FeedsView, type PreviewView } from "@shared/payroll-month";
import { ReasonDialog } from "@/components/payroll/reason-dialog";
import {
  errorText, money, monthLabel, payrollCall, refreshPayroll, useFeeds, useMonthEnd, useMonthInputs, usePayrollSetup, usePreview, withBranchNames,
} from "@/lib/payroll/api";
import { Field, NumberInput } from "@/pages/payroll-setup-page";

const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const thisMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
const Empty = ({ children }: { children: ReactNode }) => <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{children}</p>;
function Section({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return <Card className="border-border shadow-sm">
    <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0 border-b border-border/70 pb-3">
      <div><CardTitle className="text-base">{title}</CardTitle>{description && <CardDescription className="mt-1 text-xs">{description}</CardDescription>}</div>{action}
    </CardHeader>
    <CardContent className="space-y-3 pt-4">{children}</CardContent>
  </Card>;
}
const net = (cell: { amount: number; vat: number; serviceCharge: number }) => Math.round((cell.amount - cell.vat - cell.serviceCharge) * 100) / 100;
const STATUS_LABEL: Record<string, string> = { draft: "Draft", "gm-confirmed": "GM confirmed", locked: "Locked", paid: "Paid", superseded: "Replaced by a newer version" };
/** A run's inputs change while it is a draft or GM confirmed; a locked or paid version takes none until the Owner reopens it. */
const editable = (view: MonthEndView) => !!view.run && (view.run.status === "draft" || view.run.status === "gm-confirmed");
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

export default function PayrollMonthEndPage() {
  const { user } = useAuth();
  const search = new URLSearchParams(useSearch());
  const [month, setMonth] = useState(search.get("month") ?? thisMonth());
  const setup = usePayrollSetup();
  const entities = (setup.data?.entities ?? []).filter((e) => !e.archivedAt);
  const [entityId, setEntityId] = useState(search.get("entity") ?? "");
  const entity = entityId || entities[0]?.id || "";
  if (!canViewHrSalary(user)) return <div className="p-6"><Empty>{HR_PAY_HIDDEN_NOTE}.</Empty></div>;
  return <div className="mx-auto max-w-7xl space-y-5 p-4 sm:p-6" data-testid="page-payroll-month-end">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-primary">Month-end</p>
        <h1 className="text-2xl font-semibold">Payroll for {monthLabel(month)}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Review attendance, enter the month's numbers and check the whole month. Then the GM confirms and the Owner locks it, which freezes the month and its payslips. Nothing here moves money.</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Month"><Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} data-testid="input-month" /></Field>
        <Field label="Paying company"><select className={selectClass} value={entity} onChange={(e) => setEntityId(e.target.value)} data-testid="select-entity">
          {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        <Link href="/payroll/setup/rewards" className="inline-flex h-10 items-center rounded-md border px-3 text-sm font-semibold hover:bg-muted">Service charge &amp; incentives</Link>
        <Link href="/payroll/history" className="inline-flex h-10 items-center rounded-md border px-3 text-sm font-semibold hover:bg-muted">Locked months &amp; payslips</Link>
      </div>
    </div>
    {setup.isLoading && <Skeleton className="h-64 w-full" />}
    {setup.data && !entities.length && <Empty>Add the paying company in <Link href="/payroll/setup" className="underline">Payroll setup</Link> first.</Empty>}
    {entity && <MonthTabs entityId={entity} month={month} initialTab={search.get("tab")} />}
  </div>;
}

/** The tabs an address may open with (?tab=), so the hub and the old run addresses land on the right step. */
const MONTH_TABS = ["attendance", "inputs", "adjustments", "feeds", "preview", "approvals"] as const;

function MonthTabs({ entityId, month, initialTab }: { entityId: string; month: string; initialTab: string | null }) {
  const [tab, setTab] = useState<string>(() => MONTH_TABS.find((t) => t === initialTab) ?? "attendance");
  const view = useMonthEnd(entityId, month);
  return <Tabs value={tab} onValueChange={setTab} className="space-y-4">
    <TabsList className="flex h-auto flex-wrap justify-start">
      <TabsTrigger value="attendance">1. Attendance</TabsTrigger>
      <TabsTrigger value="inputs">2. Inputs</TabsTrigger>
      <TabsTrigger value="adjustments">3. One-off adjustments</TabsTrigger>
      <TabsTrigger value="feeds">Leave, OT bank &amp; exits</TabsTrigger>
      <TabsTrigger value="preview">Check the month</TabsTrigger>
      <TabsTrigger value="approvals" data-testid="tab-approvals">Confirm &amp; lock</TabsTrigger>
    </TabsList>
    {view.isLoading && <Skeleton className="h-48 w-full" />}
    {view.error && <Empty>{errorText(view.error)}</Empty>}
    {view.data && <>
      <RunBanner view={view.data} />
      <TabsContent value="attendance"><AttendanceTab view={view.data} /></TabsContent>
      <TabsContent value="inputs"><InputsTab month={month} /></TabsContent>
      <TabsContent value="adjustments"><AdjustmentsTab view={view.data} /></TabsContent>
      <TabsContent value="feeds"><FeedsTab month={month} /></TabsContent>
      <TabsContent value="preview"><PreviewTab view={view.data} entityId={entityId} month={month} active={tab === "preview"} /></TabsContent>
      <TabsContent value="approvals"><ApprovalsTab view={view.data} active={tab === "approvals"} /></TabsContent>
    </>}
  </Tabs>;
}

function RunBanner({ view }: { view: MonthEndView }) {
  const [open, setOpen] = useState(false);
  return <div className="space-y-2">
    {view.run ? <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm" data-testid="run-banner"><CalendarCheck className="h-4 w-4 text-emerald-600" />
      Run version {view.run.version} · <Badge variant="outline">{STATUS_LABEL[view.run.status] ?? view.run.status}</Badge> · pay date {view.run.payDate}
      {view.run.gm && <span className="text-xs text-muted-foreground">· GM {view.run.gm.name}</span>}
      {view.run.owner && <span className="text-xs text-muted-foreground">· locked by {view.run.owner.name} {when(view.run.owner.at)}</span>}
      {view.run.paid && <span className="text-xs text-muted-foreground">· paid {when(view.run.paid.at)}</span>}
      {view.run.reopenReason && <span className="text-xs text-muted-foreground">· reopened: {view.run.reopenReason}</span>}</div>
      : <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
        <span>This month's run has not started. Attendance decisions and one-off adjustments are saved against the run.</span>
        {view.canManage && <Button size="sm" onClick={() => setOpen(true)} data-testid="button-start-run">Start the {monthLabel(view.month)} run</Button>}
      </div>}
    {view.excluded.length > 0 && <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
      <p className="flex items-center gap-2 font-semibold text-destructive"><AlertTriangle className="h-4 w-4" />{view.excluded.length} {view.excluded.length === 1 ? "person is" : "people are"} not in this month's payroll yet</p>
      <ul className="mt-1 list-disc pl-6 text-xs">{view.excluded.map((x) => <li key={x.employeeId}><Link href={`/payroll/people/${x.employeeId}`} className="underline">{x.name}</Link>: {x.reason}</li>)}</ul>
    </div>}
    {view.run && !editable(view) && <p className="flex items-center gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm"><LockKeyhole className="h-4 w-4" />
      Version {view.run.version} is {view.run.status === "paid" ? "locked and paid" : "locked"}. These amounts will not change; the Owner reopens the month into a new version to correct anything.</p>}
    {view.notes.map((note) => <p key={note} className="flex items-center gap-2 text-xs text-muted-foreground"><Info className="h-3.5 w-3.5" />{note}</p>)}
    {open && <ReasonDialog open onOpenChange={setOpen} title={`Start the ${monthLabel(view.month)} run`} confirmLabel="Start run"
      description={`Version 1, in draft, paid on day ${view.entity.defaultPayDay} (the company's default pay day).`}
      onConfirm={async (reason) => { await payrollCall("POST", `/api/payroll/month-end/${view.entity.id}/${view.month}/run`, { reason }); await refreshPayroll(); }} />}
  </div>;
}

// ─── 1. Attendance ───────────────────────────────────────────────────────────

type Day = MonthEndView["attendance"][number];
function AttendanceTab({ view }: { view: MonthEndView }) {
  const [all, setAll] = useState(false);
  const [review, setReview] = useState<{ day: Day; action: "confirm" | "override" | "excuse"; clockIn: string; clockOut: string } | null>(null);
  const [ot, setOt] = useState<{ day: Day; outcome: "Pay" | "Bank" | "Reject"; choice: boolean } | null>(null);
  const [undo, setUndo] = useState<MonthEndView["overtime"][number] | null>(null);
  const canEdit = view.canManage && editable(view);
  const decisionOf = (d: Day) => view.overtime.find((o) => o.dayKey === d.id);
  const open = (d: Day) => d.exceptions.some((e) => e.resolution === null);
  const days = view.attendance.filter((d) => all || open(d) || d.review || d.overtimeHours > 0).sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  const waiting = view.attendance.filter((d) => open(d) && !d.review).length;
  return <Section title="Attendance review" description="From the punch clock, the rota and the timekeeping reviews managers already made. A decision here is saved against this run only — the attendance record itself never changes."
    action={<Button size="sm" variant="outline" onClick={() => setAll(!all)}>{all ? "Only days to review" : "Show every day"}</Button>}>
    <p className="flex items-center gap-2 text-sm">{waiting ? <CircleDashed className="h-4 w-4 text-amber-600" /> : <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
      {waiting ? `${waiting} day${waiting === 1 ? "" : "s"} still to confirm` : "No unconfirmed attendance"}</p>
    {!days.length ? <Empty>{all ? "No attendance recorded this month." : "Nothing to review."}</Empty> :
      <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-sm">
        <thead className="text-left text-[11px] uppercase tracking-wider text-muted-foreground"><tr><th className="py-1">Person</th><th>Date</th><th>Rota</th><th>Clocked</th><th>Approved</th><th>Issues</th><th>This run</th><th>Overtime</th><th /></tr></thead>
        <tbody className="divide-y">{days.map((d) => <tr key={d.id} data-testid={`attendance-${d.id}`}>
          <td className="py-2 font-medium">{d.name}</td>
          <td className="tabular-nums">{d.date}{d.holiday && <Badge variant="outline" className="ml-1">Holiday</Badge>}{d.dayOff && <Badge variant="outline" className="ml-1">Day off</Badge>}</td>
          <td className="tabular-nums">{d.plannedClockIn ? `${d.plannedClockIn}–${d.plannedClockOut}` : "—"}</td>
          <td className="tabular-nums">{d.actualClockIn ?? "—"}–{d.actualClockOut ?? "—"}</td>
          <td className="tabular-nums">{d.effectiveClockIn ?? "—"}–{d.effectiveClockOut ?? "—"}{d.overtimeHours > 0 && <span className="ml-1 text-xs text-muted-foreground">+{d.overtimeHours}h</span>}</td>
          <td className="space-x-1">{d.exceptions.map((e, i) => <Badge key={i} variant={e.resolution ? "secondary" : "destructive"} title={e.reason}>{e.kind}{e.resolution ? ` · ${e.resolution}` : ""}</Badge>)}</td>
          <td>{d.review ? <span title={d.review.reason}>{d.review.action}{d.review.clockIn ? ` ${d.review.clockIn}–${d.review.clockOut}` : ""}</span> : "—"}</td>
          <td>{d.overtimeHours > 0 ? (decisionOf(d) ? <span className="inline-flex items-center gap-1" title={decisionOf(d)!.reason}>
            <Badge variant={decisionOf(d)!.outcome === "Reject" ? "secondary" : "outline"}>{decisionOf(d)!.outcome} {d.overtimeHours}h</Badge>
            {canEdit && <Button size="sm" variant="ghost" aria-label="Remove the overtime decision" onClick={() => setUndo(decisionOf(d)!)}><Trash2 className="h-3.5 w-3.5" /></Button>}</span>
            : canEdit ? <Button size="sm" variant="outline" onClick={() => setOt({ day: d, outcome: "Pay", choice: false })} data-testid={`button-overtime-${d.id}`}>{d.overtimeHours}h: decide</Button>
            : <span className="text-xs text-muted-foreground">{d.overtimeHours}h undecided</span>) : "—"}</td>
          <td className="text-right">{canEdit && <Button size="sm" variant="ghost" onClick={() => setReview({ day: d, action: "confirm", clockIn: d.effectiveClockIn ?? d.actualClockIn ?? "", clockOut: d.effectiveClockOut ?? d.actualClockOut ?? "" })}><PenLine className="mr-1 h-4 w-4" />Decide</Button>}</td>
        </tr>)}</tbody>
      </table></div>}
    {review && <ReasonDialog open onOpenChange={(o) => !o && setReview(null)} title={`${review.day.name} · ${review.day.date}`} confirmLabel="Save decision"
      description="Confirm counts the issues as they are; override corrects the times for this run; excuse never counts toward a deduction."
      onConfirm={async (reason) => {
        await payrollCall("PUT", `/api/payroll/month-end/${view.entity.id}/${view.month}/attendance/${encodeURIComponent(review.day.id)}`,
          { action: review.action, reason, ...(review.action === "override" ? { clockIn: review.clockIn, clockOut: review.clockOut } : {}) });
        await refreshPayroll();
      }}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Decision"><select className={selectClass} value={review.action} onChange={(e) => setReview({ ...review, action: e.target.value as "confirm" })}>
          <option value="confirm">Confirm</option><option value="override">Override times</option><option value="excuse">Excuse</option></select></Field>
        {review.action === "override" && <>
          <Field label="Clock in"><Input type="time" value={review.clockIn} onChange={(e) => setReview({ ...review, clockIn: e.target.value })} /></Field>
          <Field label="Clock out"><Input type="time" value={review.clockOut} onChange={(e) => setReview({ ...review, clockOut: e.target.value })} /></Field>
        </>}
      </div>
    </ReasonDialog>}
    {ot && <ReasonDialog open onOpenChange={(o) => !o && setOt(null)} title={`Overtime · ${ot.day.name} · ${ot.day.date} · ${ot.day.overtimeHours}h`} confirmLabel="Save decision"
      description="Pay adds the hours to this month's pay. Reject pays nothing for them. Bank takes them out of this month's pay to be taken as time off."
      onConfirm={async (reason) => {
        await payrollCall("PUT", `/api/payroll/month-end/${view.entity.id}/${view.month}/overtime/${encodeURIComponent(ot.day.id)}`, { outcome: ot.outcome, reason, employeeChoiceConfirmed: ot.choice });
        await refreshPayroll();
      }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Decision"><select className={selectClass} value={ot.outcome} onChange={(e) => setOt({ ...ot, outcome: e.target.value as "Pay" })}>
          <option value="Pay">Pay</option><option value="Bank">Bank as time off</option><option value="Reject">Reject</option></select></Field>
        <label className="flex items-center gap-2 pt-6 text-sm"><input type="checkbox" checked={ot.choice} onChange={(e) => setOt({ ...ot, choice: e.target.checked })} />The employee chose this</label>
      </div>
      {ot.outcome === "Bank" && <p role="note" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs">Banked hours are taken out of this month's pay. Company payroll runs do not credit the OT bank yet (a decision still open with the park), so these hours will not show in anyone's bank balance either.</p>}
    </ReasonDialog>}
    {undo && <ReasonDialog open onOpenChange={(o) => !o && setUndo(null)} title={`Remove the ${undo.outcome} decision for ${undo.name}?`} confirmLabel="Remove"
      onConfirm={async (reason) => { await payrollCall("POST", `/api/payroll/month-end/${view.entity.id}/${view.month}/overtime/${encodeURIComponent(undo.dayKey)}/remove`, { reason, exceptionIndex: undo.exceptionIndex }); await refreshPayroll(); }} />}
  </Section>;
}

// ─── 2. Inputs ───────────────────────────────────────────────────────────────

function InputsTab({ month }: { month: string }) {
  const inputs = useMonthInputs(month);
  if (inputs.isLoading) return <Skeleton className="h-48 w-full" />;
  if (inputs.error || !inputs.data) return <Empty>{errorText(inputs.error)}</Empty>;
  const view = inputs.data;
  return <div className="space-y-4">
    {view.locked.length > 0 && <p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">Locked runs: {view.locked.join(", ")}. Inputs that feed them cannot change until they are reopened.</p>}
    <SalesSection view={view} />
    <NumbersSection view={view} />
    <ChangeLog view={view} />
  </div>;
}

type SalesDraft = { branchId: string; month: string; streams: Record<string, { amount: number; vat: number; serviceCharge: number }>; discounts: Record<string, number> };
function SalesSection({ view }: { view: MonthInputsView }) {
  const [dialog, setDialog] = useState<SalesDraft | null>(null);
  const liveStreams = view.streams.filter((s) => !s.archivedAt);
  const block = (month: string, inputs: CompanyMonthInputs | null, title: string, hint: string) => <div className="space-y-2">
    <div><h4 className="text-sm font-semibold">{title}</h4><p className="text-xs text-muted-foreground">{hint}</p></div>
    <ul className="divide-y rounded-lg border">{view.branches.map((b) => {
      const revenue = inputs?.revenue[b.id];
      const total = revenue ? Object.values(revenue.streams).reduce((n, c) => n + net(c), 0) : null;
      return <li key={b.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
        <span className="min-w-[8rem] flex-1 font-medium">{b.name}</span>
        {total === null ? <span className="text-xs text-muted-foreground">Not entered</span> : <>
          <span className="font-semibold tabular-nums">{money(total)}</span>
          <Badge variant="outline" title="Typed in by a person from a till or accounting report">Manual</Badge>
          <span className="text-xs text-muted-foreground">{Object.keys(revenue!.streams).length} streams</span></>}
        {view.canManage && <Button size="sm" variant="outline" onClick={() => setDialog({ branchId: b.id, month,
          streams: Object.fromEntries(liveStreams.map((s) => [s.key, revenue?.streams[s.key] ?? { amount: 0, vat: 0, serviceCharge: 0 }])),
          discounts: Object.fromEntries(Object.entries(revenue?.discounts ?? {}).map(([k, v]) => [k, v ?? 0])) })}>{total === null ? "Enter sales" : "Change"}</Button>}
      </li>;
    })}</ul>
  </div>;
  return <Section title="Sales" description="Gross sales per branch and stream, with the VAT and service charge inside them. There is no live till connection yet: enter the figures from the till or accounting report and say where they came from.">
    {!view.branches.length && <Empty>No branch has payroll details yet.</Empty>}
    {!liveStreams.length && <Empty>Add the revenue streams in <Link href="/payroll/setup" className="underline">Payroll setup</Link> first.</Empty>}
    <div className="grid gap-4 xl:grid-cols-2">
      {block(view.month, view.inputs, `Incentives · ${monthLabel(view.month)} sales`, "Sales and target bonuses use this month's sales.")}
      {block(view.previousMonth, view.previous, `Service charge · ${monthLabel(view.previousMonth)} sales`, `Service charge paid now comes from ${monthLabel(view.previousMonth)} sales.`)}
    </div>
    {dialog && <ReasonDialog open onOpenChange={(o) => !o && setDialog(null)} title={`${view.branches.find((b) => b.id === dialog.branchId)?.name} · ${monthLabel(dialog.month)} sales`}
      description="Gross per stream, then the VAT and the service charge inside it. The reason should say where the figures came from."
      onConfirm={async (reason) => {
        const streams = Object.fromEntries(Object.entries(dialog.streams).filter(([, c]) => c.amount || c.vat || c.serviceCharge));
        await payrollCall("PUT", `/api/payroll/inputs/${dialog.month}/revenue/${dialog.branchId}`, { streams, discounts: dialog.discounts, reason });
        await refreshPayroll();
      }}>
      <div className="space-y-2">{liveStreams.map((s) => <div key={s.key} className="grid grid-cols-4 items-end gap-2">
        <p className="pb-2 text-sm font-medium">{s.label}</p>
        {(["amount", "vat", "serviceCharge"] as const).map((k) => <Field key={k} label={k === "amount" ? "Gross" : k === "vat" ? "VAT" : "Service charge"}>
          <NumberInput label={`${s.label} ${k}`} value={dialog.streams[s.key]?.[k] ?? 0} onChange={(n) => setDialog({ ...dialog, streams: { ...dialog.streams, [s.key]: { ...dialog.streams[s.key], [k]: n } } })} /></Field>)}
      </div>)}</div>
      <div className="grid gap-2 sm:grid-cols-2">{PAYROLL_DISCOUNTS.map((d) => <Field key={d} label={`Add back: ${PAYROLL_DISCOUNT_LABELS[d]}`}>
        <NumberInput label={d} value={dialog.discounts[d] ?? null} onChange={(n) => setDialog({ ...dialog, discounts: { ...dialog.discounts, [d]: n } })} /></Field>)}</div>
    </ReasonDialog>}
  </Section>;
}

type Override = { key: string; label: string; current: number | null };
function NumbersSection({ view }: { view: MonthInputsView }) {
  const [dialog, setDialog] = useState<(Override & { value: number }) | null>(null);
  const [custom, setCustom] = useState<{ type: "days" | "units" | "kpi" | "count"; person: string; key: string; value: number } | null>(null);
  const [personal, setPersonal] = useState<{ employeeId: string; pnd3Basis: string; ruleId: string; amount: number | null } | null>(null);
  const inputs = view.inputs;
  const name = (id: string) => view.people.find((p) => p.id === id)?.name ?? id;
  const rows: (Override & { source: string })[] = [];
  for (const [id, s] of Object.entries(inputs?.staff ?? {})) {
    if (s.daysWorked !== undefined) rows.push({ key: `days:${id}`, label: `${name(id)} · days worked`, current: s.daysWorked, source: inputs?.sources?.[`days:${id}`]?.kind ?? "Attendance" });
    for (const [k, v] of Object.entries(s.units)) rows.push({ key: `units:${id}:${k}`, label: `${name(id)} · items ${k}`, current: v, source: inputs?.sources?.[`units:${id}:${k}`]?.kind ?? "POS" });
    for (const [k, v] of Object.entries(s.kpis)) rows.push({ key: `kpi:${id}:${k}`, label: `${name(id)} · KPI ${k}`, current: v, source: inputs?.sources?.[`kpi:${id}:${k}`]?.kind ?? "Manual" });
    if (s.pnd3Basis) rows.push({ key: `pnd3:${id}`, label: `${name(id)} · PND.3 on ${s.pnd3Basis === "fee-only" ? "the fixed fee only" : "all earnings"}`, current: null, source: "Manual" });
    for (const [ruleId, b] of Object.entries(s.bonuses)) rows.push({ key: `bonus:${id}:${ruleId}`, label: `${name(id)} · one-off ${view.manualRules.find((r) => r.id === ruleId)?.name ?? ruleId} (${b.reason})`, current: b.amount, source: "Manual" });
  }
  for (const [k, v] of Object.entries(inputs?.counts ?? {})) rows.push({ key: `count:${k}`, label: `Count · ${k}`, current: v, source: inputs?.sources?.[`count:${k}`]?.kind ?? "Manual" });
  return <Section title="Other numbers" description="Days worked (when the punch clock is not the whole story), items, KPIs and counts the rules use, the contractor PND.3 basis and one-off rule amounts. The first value stays recorded; every change has a reason."
    action={view.canManage && <div className="flex gap-2">
      <Button size="sm" variant="outline" onClick={() => setCustom({ type: "days", person: view.people[0]?.id ?? "", key: "", value: 0 })}><Plus className="mr-1 h-4 w-4" />Enter a number</Button>
      <Button size="sm" variant="outline" onClick={() => setPersonal({ employeeId: view.people[0]?.id ?? "", pnd3Basis: "", ruleId: "", amount: null })}><Plus className="mr-1 h-4 w-4" />Person's inputs</Button>
    </div>}>
    {!rows.length ? <Empty>Nothing entered for {monthLabel(view.month)}: days worked come from the punch clock.</Empty> :
      <ul className="divide-y rounded-lg border">{rows.map((r) => <li key={r.key} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
        <span className="flex-1">{r.label}</span>{r.current !== null && <strong className="tabular-nums">{r.current.toLocaleString("en-US")}</strong>}
        <Badge variant="outline">{inputs?.sources?.[r.key]?.reason && inputs.sources[r.key].overridden !== false ? "Overridden" : r.source}</Badge>
        {view.canManage && /^(days|units|kpi|count):/.test(r.key) && <Button size="sm" variant="ghost" onClick={() => setDialog({ ...r, value: r.current ?? 0 })}><PenLine className="mr-1 h-4 w-4" />Override</Button>}
      </li>)}</ul>}
    {dialog && <ReasonDialog open onOpenChange={(o) => !o && setDialog(null)} title={`Override · ${dialog.label}`}
      description="The first original value is kept. Payslips show the source and your reason."
      onConfirm={async (reason) => { await payrollCall("POST", `/api/payroll/inputs/${view.month}/override`, { key: dialog.key, value: dialog.value, reason }); await refreshPayroll(); }}>
      <Field label="New value"><NumberInput label="New value" value={dialog.value} onChange={(n) => setDialog({ ...dialog, value: n })} /></Field>
    </ReasonDialog>}
    {custom && <ReasonDialog open onOpenChange={(o) => !o && setCustom(null)} title="Enter a number for this month"
      onConfirm={async (reason) => {
        const key = custom.type === "count" ? `count:${custom.key}` : custom.type === "days" ? `days:${custom.person}` : `${custom.type}:${custom.person}:${custom.key}`;
        await payrollCall("POST", `/api/payroll/inputs/${view.month}/override`, { key, value: custom.value, reason }); await refreshPayroll();
      }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="What"><select className={selectClass} value={custom.type} onChange={(e) => setCustom({ ...custom, type: e.target.value as "days" })}>
          <option value="days">Days worked (a person)</option><option value="units">Items (a person)</option><option value="kpi">KPI (a person)</option><option value="count">Count (the team)</option></select></Field>
        {custom.type !== "count" && <Field label="Person"><select className={selectClass} value={custom.person} onChange={(e) => setCustom({ ...custom, person: e.target.value })}>
          {view.people.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.jobTitle}</option>)}</select></Field>}
        {custom.type !== "days" && <Field label="Input name" hint="As the rule names it."><Input value={custom.key} onChange={(e) => setCustom({ ...custom, key: e.target.value })} /></Field>}
        <Field label="Value"><NumberInput label="Value" value={custom.value} onChange={(n) => setCustom({ ...custom, value: n })} /></Field>
      </div>
    </ReasonDialog>}
    {personal && <ReasonDialog open onOpenChange={(o) => !o && setPersonal(null)} title="A person's own inputs"
      description="A contractor's PND.3 basis, or the amount of a one-off rule this person is assigned to."
      onConfirm={async (reason) => {
        const body: Record<string, unknown> = { reason };
        if (personal.pnd3Basis) body.pnd3Basis = personal.pnd3Basis === "default" ? null : personal.pnd3Basis;
        if (personal.ruleId) body.bonus = { ruleId: personal.ruleId, amount: personal.amount };
        await payrollCall("PUT", `/api/payroll/inputs/${view.month}/people/${personal.employeeId}`, body); await refreshPayroll();
      }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Person"><select className={selectClass} value={personal.employeeId} onChange={(e) => setPersonal({ ...personal, employeeId: e.target.value })}>
          {view.people.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.jobTitle}</option>)}</select></Field>
        <Field label="Contractor PND.3 on"><select className={selectClass} value={personal.pnd3Basis} onChange={(e) => setPersonal({ ...personal, pnd3Basis: e.target.value })}>
          <option value="">No change</option><option value="default">All earnings (the default)</option><option value="fee-only">The fixed fee only</option></select></Field>
        <Field label="One-off rule"><select className={selectClass} value={personal.ruleId} onChange={(e) => setPersonal({ ...personal, ruleId: e.target.value })}>
          <option value="">None</option>{view.manualRules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
        {personal.ruleId && <Field label="Amount"><NumberInput label="Amount" value={personal.amount} onChange={(n) => setPersonal({ ...personal, amount: n })} /></Field>}
      </div>
    </ReasonDialog>}
  </Section>;
}

function ChangeLog({ view }: { view: MonthInputsView }) {
  if (!view.changes.length) return null;
  return <Section title="What changed" description="Every entry and override for this month and the one before, newest first. This log cannot be edited.">
    <ul className="divide-y text-sm">{view.changes.slice(0, 40).map((c) => <li key={c.id} className="flex flex-wrap gap-2 py-1.5">
      <span className="font-mono text-xs">{c.key}</span><span className="text-muted-foreground">{c.sourceKind}</span><span className="flex-1">{c.reason}</span>
      <span className="text-xs text-muted-foreground">{c.who} · {new Date(c.at).toLocaleString()}</span></li>)}</ul>
  </Section>;
}

// ─── 3. One-off adjustments ──────────────────────────────────────────────────

function AdjustmentsTab({ view }: { view: MonthEndView }) {
  const [add, setAdd] = useState<{ kind: "bonus" | "deduction"; employeeId: string; amount: number } | null>(null);
  const [override, setOverride] = useState<{ employeeId: string; component: string; amount: number } | null>(null);
  const [remove, setRemove] = useState<{ path: string; label: string } | null>(null);
  const base = `/api/payroll/month-end/${view.entity.id}/${view.month}`;
  const can = view.canManage && editable(view);
  return <div className="space-y-4">
    {!view.run && <Empty>Start the month's run to add one-off bonuses, deductions or overrides.</Empty>}
    <Section title="One-off bonuses and deductions" description="Only for things no system provides. The reason is shown on the payslip."
      action={can && <div className="flex gap-2"><Button size="sm" onClick={() => setAdd({ kind: "bonus", employeeId: view.people[0]?.id ?? "", amount: 0 })}><Plus className="mr-1 h-4 w-4" />Add bonus</Button>
        <Button size="sm" variant="outline" onClick={() => setAdd({ kind: "deduction", employeeId: view.people[0]?.id ?? "", amount: 0 })}><Plus className="mr-1 h-4 w-4" />Add deduction</Button></div>}>
      {!view.manual.length ? <Empty>No one-off bonuses or deductions this month.</Empty> :
        <ul className="divide-y rounded-lg border text-sm">{view.manual.map((m) => <li key={m.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
          <Badge variant={m.kind === "bonus" ? "default" : "secondary"}>{m.kind === "bonus" ? "Bonus" : "Deduction"}</Badge>
          <span className="flex-1"><strong>{m.name}</strong> · {money(m.amount)} · {m.reason}</span><span className="text-xs text-muted-foreground">{m.who}</span>
          {can && <Button size="sm" variant="ghost" aria-label="Remove item" onClick={() => setRemove({ path: `${base}/manual/${m.id}/remove`, label: `${m.kind} for ${m.name}` })}><Trash2 className="h-4 w-4" /></Button>}</li>)}</ul>}
    </Section>
    <Section title="Overrides" description="Set one pay component of one person to an amount, with a reason (for example a PND.1 figure from the accountant). The calculation shows the override and its reason."
      action={can && <Button size="sm" variant="outline" onClick={() => setOverride({ employeeId: view.people[0]?.id ?? "", component: "pnd1", amount: 0 })}><Plus className="mr-1 h-4 w-4" />Add override</Button>}>
      {!view.overrides.length ? <Empty>No overrides this month.</Empty> :
        <ul className="divide-y rounded-lg border text-sm">{view.overrides.map((o) => <li key={o.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
          <Badge variant="outline">{o.component}</Badge><span className="flex-1"><strong>{o.name}</strong> · {money(o.amount)} · {o.reason}</span>
          {can && <Button size="sm" variant="ghost" aria-label="Remove override" onClick={() => setRemove({ path: `${base}/overrides/${o.id}/remove`, label: `${o.component} override for ${o.name}` })}><Trash2 className="h-4 w-4" /></Button>}</li>)}</ul>}
    </Section>
    {add && <ReasonDialog open onOpenChange={(o) => !o && setAdd(null)} title={`Add a one-off ${add.kind}`} confirmLabel={`Add ${add.kind}`}
      onConfirm={async (reason) => { await payrollCall("POST", `${base}/manual`, { ...add, reason }); await refreshPayroll(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Person"><select className={selectClass} value={add.employeeId} onChange={(e) => setAdd({ ...add, employeeId: e.target.value })}>
          {view.people.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.jobTitle}</option>)}</select></Field>
        <Field label="Amount"><NumberInput label="Amount" value={add.amount} onChange={(n) => setAdd({ ...add, amount: n })} /></Field>
      </div>
    </ReasonDialog>}
    {override && <ReasonDialog open onOpenChange={(o) => !o && setOverride(null)} title="Override a pay component"
      onConfirm={async (reason) => { await payrollCall("POST", `${base}/overrides`, { ...override, reason }); await refreshPayroll(); }}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Person"><select className={selectClass} value={override.employeeId} onChange={(e) => setOverride({ ...override, employeeId: e.target.value })}>
          {view.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Component" hint="salary, food, overtime, sc, pnd1, sso, gross, net…"><Input value={override.component} onChange={(e) => setOverride({ ...override, component: e.target.value })} /></Field>
        <Field label="Amount"><NumberInput label="Amount" value={override.amount} onChange={(n) => setOverride({ ...override, amount: n })} /></Field>
      </div>
    </ReasonDialog>}
    {remove && <ReasonDialog open onOpenChange={(o) => !o && setRemove(null)} title={`Remove the ${remove.label}?`} confirmLabel="Remove"
      onConfirm={async (reason) => { await payrollCall("POST", remove.path, { reason }); await refreshPayroll(); }} />}
  </div>;
}

// ─── Leave, OT bank and exits ────────────────────────────────────────────────

function FeedsTab({ month }: { month: string }) {
  const feeds = useFeeds(month);
  const [value, setValue] = useState<FeedsView["unvalued"][number] | null>(null);
  const [payout, setPayout] = useState<{ employeeId: string; leaveTypeCode: string; date: string; days: number } | null>(null);
  const [reverse, setReverse] = useState<FeedsView["valuations"][number] | null>(null);
  const [exit, setExit] = useState<{ employeeId: string; resignationDate: string; lastWorkingDate: string } | null>(null);
  const [booking, setBooking] = useState<{ employeeId: string; date: string; hours: number } | null>(null);
  if (feeds.isLoading) return <Skeleton className="h-48 w-full" />;
  if (feeds.error || !feeds.data) return <Empty>{errorText(feeds.error)}</Empty>;
  const f = feeds.data;
  const paidTypes = f.leaveTypes.filter((t) => t.paid);
  return <div className="space-y-4">
    <Section title="Unpaid leave" description="Leave balances stay with Leave types. Payroll only puts a value on unpaid leave: its workdays at the person's daily rate, frozen when you value it (day rate, or monthly salary ÷ 30)."
      action={f.canManage && <Button size="sm" variant="outline" onClick={() => setPayout({ employeeId: f.people[0]?.id ?? "", leaveTypeCode: paidTypes[0]?.code ?? "", date: `${month}-28`, days: 1 })}><Plus className="mr-1 h-4 w-4" />Exit leave payout</Button>}>
      {f.unvalued.length > 0 && <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
        <p className="font-semibold">{f.unvalued.length} unpaid leave {f.unvalued.length === 1 ? "record is" : "records are"} not valued yet — not deducted until valued</p>
        <ul className="mt-2 divide-y">{f.unvalued.map((u) => <li key={u.timeOffId} className="flex flex-wrap items-center gap-2 py-1.5">
          <span className="flex-1">{u.name} · {u.startsOn}{u.endsOn !== u.startsOn ? ` to ${u.endsOn}` : ""}{u.halfDay ? " (half day)" : ""}</span>
          {f.canManage && <Button size="sm" onClick={() => setValue(u)}>Value</Button>}</li>)}</ul>
      </div>}
      {!f.valuations.length ? <Empty>Nothing valued yet.</Empty> :
        <ul className="divide-y rounded-lg border text-sm">{f.valuations.map((v) => <li key={v.id} className={`flex flex-wrap items-center gap-2 px-3 py-2 ${v.reversedAt ? "opacity-60" : ""}`}>
          <Badge variant={v.kind === "unpaid" ? "secondary" : "default"}>{v.kind === "unpaid" ? "Unpaid leave" : "Exit payout"}</Badge>
          <span className="flex-1">{v.name} · {v.leaveTypeCode} · {v.startsOn}{v.endsOn !== v.startsOn ? `–${v.endsOn}` : ""} · {v.days} days × {money(v.dailyRate)} = <strong>{money(v.amount)}</strong>
            {v.sourceMissing && <span className="ml-1 text-destructive">(the time off was removed in HR; left out)</span>}
            {v.reversedAt && <span className="ml-1">· reversed: {v.reversalReason}</span>}</span>
          {f.canManage && !v.reversedAt && <Button size="sm" variant="ghost" onClick={() => setReverse(v)}><RotateCcw className="mr-1 h-4 w-4" />Reverse</Button>}</li>)}</ul>}
    </Section>
    <Section title="OT bank" description="Time off taken against banked overtime.">
      <p role="note" className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-sm"><Info className="mt-0.5 h-4 w-4 shrink-0" />
        Company payroll runs do not put overtime into the bank yet: how banked overtime is credited is a decision still open with the park. Every balance is therefore 0 hours, and a booking is refused until that is decided.</p>
      {f.canManage && <Button size="sm" variant="outline" onClick={() => setBooking({ employeeId: f.people[0]?.id ?? "", date: `${month}-15`, hours: 4 })}><Clock className="mr-1 h-4 w-4" />Book time off from the bank</Button>}
      {f.bookings.length > 0 && <ul className="divide-y text-sm">{f.bookings.map((b) => <li key={b.id} className="py-1.5">{b.name} · {b.date} · {b.hours}h · {b.reason}</li>)}</ul>}
    </Section>
    <Section title="Leaving" description="Resignation and last working day, used for the exit payouts."
      action={f.canManage && <Button size="sm" variant="outline" onClick={() => setExit({ employeeId: f.people[0]?.id ?? "", resignationDate: `${month}-01`, lastWorkingDate: `${month}-28` })}><Plus className="mr-1 h-4 w-4" />Record a leaver</Button>}>
      {!f.offboarding.length ? <Empty>No one is recorded as leaving.</Empty> :
        <ul className="divide-y text-sm">{f.offboarding.map((o) => <li key={o.employeeId} className="py-1.5">{o.name} · resigned {o.resignationDate} · last day {o.lastWorkingDate} · {o.reason}</li>)}</ul>}
    </Section>
    {value && <ReasonDialog open onOpenChange={(o) => !o && setValue(null)} title={`Value ${value.name}'s unpaid leave`} confirmLabel="Value"
      description="The daily rate is frozen now; a later salary change does not move it."
      onConfirm={async (reason) => { await payrollCall("POST", "/api/payroll/feeds/leave-valuations", { kind: "unpaid", timeOffId: value.timeOffId, reason }); await refreshPayroll(); }} />}
    {payout && <ReasonDialog open onOpenChange={(o) => !o && setPayout(null)} title="Exit leave payout" description="Days × the frozen daily rate; taxable, not an SSO wage."
      onConfirm={async (reason) => { await payrollCall("POST", "/api/payroll/feeds/leave-valuations", { kind: "payout", ...payout, reason }); await refreshPayroll(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Person"><select className={selectClass} value={payout.employeeId} onChange={(e) => setPayout({ ...payout, employeeId: e.target.value })}>{f.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Leave type"><select className={selectClass} value={payout.leaveTypeCode} onChange={(e) => setPayout({ ...payout, leaveTypeCode: e.target.value })}>{paidTypes.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></Field>
        <Field label="Paid on"><Input type="date" value={payout.date} onChange={(e) => setPayout({ ...payout, date: e.target.value })} /></Field>
        <Field label="Days"><NumberInput label="Days" value={payout.days} onChange={(n) => setPayout({ ...payout, days: n })} /></Field>
      </div>
    </ReasonDialog>}
    {reverse && <ReasonDialog open onOpenChange={(o) => !o && setReverse(null)} title="Reverse this valuation?" confirmLabel="Reverse"
      onConfirm={async (reason) => { await payrollCall("POST", `/api/payroll/feeds/leave-valuations/${reverse.id}/reverse`, { reason }); await refreshPayroll(); }} />}
    {exit && <ReasonDialog open onOpenChange={(o) => !o && setExit(null)} title="Record a leaver"
      onConfirm={async (reason) => { await payrollCall("PUT", `/api/payroll/feeds/offboarding/${exit.employeeId}`, { ...exit, reason }); await refreshPayroll(); }}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Person"><select className={selectClass} value={exit.employeeId} onChange={(e) => setExit({ ...exit, employeeId: e.target.value })}>{f.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Resignation date"><Input type="date" value={exit.resignationDate} onChange={(e) => setExit({ ...exit, resignationDate: e.target.value })} /></Field>
        <Field label="Last working day"><Input type="date" value={exit.lastWorkingDate} onChange={(e) => setExit({ ...exit, lastWorkingDate: e.target.value })} /></Field>
      </div>
    </ReasonDialog>}
    {booking && <ReasonDialog open onOpenChange={(o) => !o && setBooking(null)} title="Book time off from the OT bank"
      onConfirm={async (reason) => { await payrollCall("POST", "/api/payroll/feeds/ot-bookings", { ...booking, reason }); await refreshPayroll(); }}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Person"><select className={selectClass} value={booking.employeeId} onChange={(e) => setBooking({ ...booking, employeeId: e.target.value })}>{f.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Date"><Input type="date" value={booking.date} onChange={(e) => setBooking({ ...booking, date: e.target.value })} /></Field>
        <Field label="Hours"><NumberInput label="Hours" value={booking.hours} onChange={(n) => setBooking({ ...booking, hours: n })} /></Field>
      </div>
    </ReasonDialog>}
  </div>;
}

// ─── Check the month (preview) ───────────────────────────────────────────────

const THIRD_PARTY = /third|someone else/i;

function PreviewTab({ view, entityId, month, active }: { view: MonthEndView; entityId: string; month: string; active: boolean }) {
  const preview = usePreview(entityId, month, active);
  const [show, setShow] = useState<"people" | "problems">("people");
  const [open, setOpen] = useState<string | null>(null);
  const [approve, setApprove] = useState<{ employeeId: string; name: string } | null>(null);
  const result = preview.data?.result;
  // Engine messages and formulas carry branch and person ids: both are shown as names.
  const names = useMemo(() => ({ ...Object.fromEntries(view.people.map((p) => [p.id, p.name])), ...(preview.data?.branchNames ?? {}) }), [view.people, preview.data]);
  const problems = useMemo(() => (result?.exceptions ?? []).filter((e) => e.severity !== "info"), [result]);
  if (preview.isLoading) return <Skeleton className="h-64 w-full" />;
  if (preview.error) return <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm"><p className="font-semibold">The month cannot be calculated yet</p><p>{errorText(preview.error)}</p></div>;
  if (!preview.data) return null;
  const { calculation, signature, timing, frozen } = preview.data;
  const blocking = problems.filter((e) => e.severity === "blocking").length;
  const approved = (id?: string) => !!id && view.thirdParty.some((a) => a.employeeId === id && a.current);
  return <div className="space-y-4">
    <p className="text-xs text-muted-foreground">{frozen
      ? `The frozen ${monthLabel(month)} of version ${preview.data.run?.version} · source ${signature.slice(0, 19)}…`
      : `${monthLabel(month)} from what is saved now · calculated in ${timing.loadMs + timing.calculateMs} ms · source ${signature.slice(0, 19)}…`}</p>
    {frozen && <p className="flex items-center gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm"><LockKeyhole className="h-4 w-4" />Locked: these are the amounts frozen at lock, not a new calculation.</p>}
    {preview.data.stale && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">Source data changed since GM confirmation (signature mismatch). GM must confirm again.</p>}
    {!result ? <Empty>No one is paid by this company in {monthLabel(month)}.</Empty> : <>
      <div className="grid gap-3 sm:grid-cols-5">{([["Gross", result.totals.gross], ["Deductions", result.totals.deductions], ["Net pay", result.totals.net], ["Employer cost", result.totals.employer], ["Total cost", result.totals.totalCost]] as const).map(([label, value]) =>
        <Card key={label}><CardContent className="p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="text-lg font-semibold tabular-nums">{money(value)}</p></CardContent></Card>)}</div>
      <div className="flex flex-wrap gap-2 text-sm">
        <Button size="sm" variant={show === "people" ? "default" : "outline"} onClick={() => setShow("people")}>{result.people.length} people</Button>
        <Button size="sm" variant={show === "problems" ? "default" : "outline"} onClick={() => setShow("problems")} data-testid="button-problems">{blocking} blocking · {problems.length - blocking} warnings</Button>
      </div>
      {show === "people" ? <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-sm" data-testid="preview-matrix">
        <thead className="text-left text-[11px] uppercase tracking-wider text-muted-foreground"><tr><th className="py-1">Person</th><th>Job</th><th>Split</th><th className="text-right">Days</th><th className="text-right">Gross</th><th className="text-right">Deductions</th><th className="text-right">Net</th><th className="text-right">Employer</th></tr></thead>
        <tbody className="divide-y">{result.people.map((p) => <Fragment key={p.id}>
          <tr>
            <td className="py-2 font-medium"><button type="button" className="inline-flex items-center gap-1 text-left hover:underline" aria-expanded={open === p.id}
              onClick={() => setOpen(open === p.id ? null : p.id)} data-testid={`person-${p.id}`}>
              {open === p.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}{p.name}</button></td>
            <td className="text-muted-foreground">{p.jobTitle}</td><td className="text-xs">{withBranchNames(p.allocationBadge, names)}</td>
            <td className="text-right tabular-nums">{p.daysWorked}/{p.employedDays}</td><td className="text-right tabular-nums">{money(p.gross)}</td>
            <td className="text-right tabular-nums">{money(p.deductions)}</td><td className="text-right font-semibold tabular-nums">{money(p.net)}</td><td className="text-right tabular-nums">{money(p.employer)}</td>
          </tr>
          {open === p.id && <tr><td colSpan={8} className="bg-muted/30 px-3 py-3"><PersonLines person={p} names={names} /></td></tr>}
        </Fragment>)}</tbody>
      </table></div> :
        <ul className="divide-y rounded-lg border text-sm" data-testid="problems-list">{problems.map((e) => <li key={e.id} className="flex flex-wrap items-start gap-2 px-3 py-2">
          <Badge variant={e.severity === "blocking" ? "destructive" : "outline"}>{e.severity}</Badge><span className="flex-1">{withBranchNames(e.message, names)}</span>
          {THIRD_PARTY.test(`${e.kind} ${e.message}`) && e.staffId && (approved(e.staffId)
            ? <Badge variant="secondary">Approved</Badge>
            : view.canManage && editable(view) && !frozen && <Button size="sm" variant="outline" onClick={() => setApprove({ employeeId: e.staffId!, name: result.people.find((p) => p.id === e.staffId)?.name ?? "" })}>Approve this payment</Button>)}
        </li>)}
          {!problems.length && <li className="px-3 py-4 text-center text-muted-foreground">No problems.</li>}</ul>}
      <Section title="Service charge" description="Each branch's pool from last month's sales, shared by the saved policy.">
        <ul className="divide-y text-sm">{calculation.service.map((s) => <li key={s.branchId} className="flex flex-wrap gap-3 py-1.5">
          <span className="flex-1 font-medium">{names?.[s.branchId] ?? s.branchId}</span><span>{s.earningMonth} sales base {money(s.revenueBase)} × {s.percent}%</span>
          <span>pool {money(s.pool)}</span><span>paid {money(s.paid)}</span><span>kept {money(s.retained)}</span></li>)}</ul>
      </Section>
    </>}
    {approve && <ReasonDialog open onOpenChange={(o) => !o && setApprove(null)} title={`Approve ${approve.name}'s payment to someone else`} confirmLabel="Approve"
      description="Approved for these payment details only: a later change of payee, bank, amount or reason needs approving again."
      onConfirm={async (reason) => { await payrollCall("PUT", `/api/payroll/month-end/${view.entity.id}/${view.month}/third-party/${approve.employeeId}`, { reason }); await refreshPayroll(); }} />}
  </div>;
}

/** One person's pay, line by line, as the payslip will show it. */
function PersonLines({ person, names }: { person: CompanyPerson; names?: Record<string, string> }) {
  const group = (category: "earning" | "deduction" | "employer", title: string) => {
    const lines = person.lines.filter((l) => l.category === category && l.amount !== 0);
    if (!lines.length) return null;
    return <div><p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      <ul className="divide-y rounded-md border bg-background">{lines.map((l) => <li key={l.id} className="flex flex-wrap items-start gap-2 px-2 py-1.5 text-xs">
        <span className="min-w-[10rem] flex-1"><span className="font-medium">{withBranchNames(l.label, names)}</span>{l.overridden && <Badge variant="outline" className="ml-1">Overridden</Badge>}
          <span className="block text-muted-foreground">{withBranchNames(l.formula, names)}</span></span>
        <span className="text-muted-foreground">{l.allocations.map((a) => `${names?.[a.costCentre] ?? (a.costCentre === "owner-non-operational" ? "Owner – non-operational" : a.costCentre)} ${money(a.amount)}`).join(" · ")}</span>
        <span className="w-28 text-right font-semibold tabular-nums">{category === "deduction" ? `−${money(l.amount)}` : money(l.amount)}</span></li>)}</ul></div>;
  };
  return <div className="grid gap-3 lg:grid-cols-3" data-testid={`lines-${person.id}`}>
    {group("earning", "Earnings")}{group("deduction", "Deductions")}{group("employer", "Paid by the company")}
    {person.warnings.length > 0 && <ul className="list-disc pl-5 text-xs text-amber-700 dark:text-amber-300 lg:col-span-3">{person.warnings.map((w) => <li key={w}>{withBranchNames(w, names)}</li>)}</ul>}
  </div>;
}

// ─── Confirm & lock (approvals) ──────────────────────────────────────────────

function ApprovalsTab({ view, active }: { view: MonthEndView; active: boolean }) {
  const preview = usePreview(view.entity.id, view.month, active && !!view.run);
  const [action, setAction] = useState<"confirm" | "confirm-anyway" | "lock" | "paid" | "reopen" | null>(null);
  const base = `/api/payroll/month-end/${view.entity.id}/${view.month}`;
  if (!view.run) return <Empty>Start the month's run first.</Empty>;
  const status = view.run.status;
  const data: PreviewView | undefined = preview.data;
  const blockers = (data?.result?.exceptions ?? []).filter((e) => e.severity === "blocking");
  const steps = [["draft", "Payroll draft"], ["gm-confirmed", "GM confirmed"], ["locked", "Owner locked"], ["paid", "Paid"]] as const;
  const idx = steps.findIndex(([s]) => s === status);
  const stale = !!data?.stale;
  const calls: Record<NonNullable<typeof action>, { title: string; label: string; description: string; run: (reason: string) => Promise<unknown> }> = {
    confirm: { title: "Confirm as GM", label: "Confirm as GM", description: "Records that attendance, inputs, flags and company totals were reviewed, and the exact sources reviewed. Any later change makes the confirmation stale.",
      run: (reason) => payrollCall("POST", `${base}/confirm`, { reason }) },
    "confirm-anyway": { title: `${data?.openProblems ?? 0} problem${data?.openProblems === 1 ? " is" : "s are"} still open. Confirm anyway?`, label: "Confirm anyway",
      description: "This records GM review only. The Owner still cannot lock while blocking problems remain.", run: (reason) => payrollCall("POST", `${base}/confirm`, { reason, confirmAnyway: true }) },
    lock: { title: "Lock and freeze", label: "Lock and freeze", description: "Locking freezes the result, the calculation, the payslips and the bank and cash files into this version. They never change afterwards.",
      run: (reason) => payrollCall("POST", `${base}/lock`, { reason }) },
    paid: { title: "Mark this month paid", label: "Mark paid", description: "Records that the bank transfers and cash payments were made. It checks the frozen bank files plus cash still equal net pay; it does not move money.",
      run: (reason) => payrollCall("POST", `${base}/paid`, { reason }) },
    reopen: { title: "Reopen into a new version", label: "Reopen", description: `Version ${view.run.version} and its payslips stay in history unchanged. Version ${view.run.version + 1} starts as a draft with every decision and adjustment copied.`,
      run: (reason) => payrollCall("POST", `${base}/reopen`, { reason, fromVersion: view.run!.version }) },
  };
  const current = action ? calls[action] : null;
  return <Section title="Confirm & lock" description="The GM confirms, then the Owner locks. Locking freezes the month: payslips are issued from the frozen version only.">
    <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">{steps.map(([s, l], i) => <li key={s} className={`rounded-lg border p-3 text-sm ${i <= idx ? "border-primary bg-primary/10 font-semibold" : "text-muted-foreground"}`}>{i + 1}. {l}</li>)}</ol>
    <div className="space-y-1 text-sm">
      <p>Version {view.run.version}{view.run.gm ? ` · GM: ${view.run.gm.name}` : ""}{view.run.owner ? ` · Owner: ${view.run.owner.name}` : ""}</p>
      {blockers.length > 0 && status !== "locked" && status !== "paid" && <p className="text-destructive"><Badge variant="destructive">{blockers.length} blockers</Badge> Lock is refused until every blocking exception is resolved.</p>}
      {stale && <p className="text-destructive"><Badge variant="destructive">Stale</Badge> Source data changed since GM confirmation (signature mismatch). GM must confirm again.</p>}
      {preview.isLoading && <p className="text-xs text-muted-foreground">Checking the month…</p>}
      {preview.error != null && <p className="text-xs text-destructive">{errorText(preview.error)}</p>}
    </div>
    <div className="grid gap-3 md:grid-cols-2">
      {(status === "draft" || stale) && <div className="rounded-lg border p-3">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4" />GM confirm</h3>
        {view.canConfirm ? <Button onClick={() => setAction((data?.openProblems ?? 0) > 0 ? "confirm-anyway" : "confirm")} data-testid="button-gm-confirm">Confirm as GM</Button>
          : <p className="text-xs text-muted-foreground">Only a payroll manager (admin, operator admin or global admin) confirms as GM.</p>}
      </div>}
      {status === "gm-confirmed" && <div className="rounded-lg border p-3">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><LockKeyhole className="h-4 w-4" />Owner lock</h3>
        {view.canLock ? <Button disabled={blockers.length > 0 || stale} onClick={() => setAction("lock")} data-testid="button-owner-lock">Lock and freeze</Button>
          : <p className="text-xs text-muted-foreground">Only the Owner (operator admin or global admin) locks a payroll month.</p>}
        <p className="mt-1 text-xs text-muted-foreground">Locking freezes result, calculation and outputs into an approved version.</p>
      </div>}
      {status === "locked" && <div className="rounded-lg border p-3">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Wallet className="h-4 w-4" />Paid</h3>
        {view.canLock ? <Button variant="outline" onClick={() => setAction("paid")} data-testid="button-mark-paid">Mark paid</Button>
          : <p className="text-xs text-muted-foreground">The Owner records the month as paid.</p>}
      </div>}
      {(status === "locked" || status === "paid") && <div className="rounded-lg border p-3">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><RotateCcw className="h-4 w-4" />Owner reopen</h3>
        {view.canLock ? <Button variant="outline" onClick={() => setAction("reopen")} data-testid="button-reopen">Reopen into version {view.run.version + 1}</Button>
          : <p className="text-xs text-muted-foreground">Only the Owner reopens a locked month.</p>}
        <p className="mt-1 text-xs text-muted-foreground">The approved version stays in history unchanged.</p>
      </div>}
    </div>
    {view.run.snapshotId && <p className="text-sm"><Link href={`/payroll/history?entity=${view.entity.id}&month=${view.month}&version=${view.run.version}`} className="underline">Open the frozen version and its payslips</Link>
      {" · "}<Link href={`/payroll/downloads/${view.entity.id}/${view.month}/${view.run.version}`} className="underline" data-testid="month-end-downloads-link">Downloads: bank, SSO and EWF files</Link></p>}
    {view.versions.length > 1 && <div><h3 className="text-sm font-semibold">Versions</h3>
      <ul className="mt-1 divide-y text-xs">{view.versions.map((v) => <li key={v.versionId} className="flex flex-wrap gap-2 py-1">
        <strong>v{v.version}</strong><Badge variant="outline">{STATUS_LABEL[v.status] ?? v.status}</Badge>
        {v.owner && <span>locked by {v.owner.name} {when(v.owner.at)}</span>}{v.reopenReason && <span className="text-muted-foreground">reopened: {v.reopenReason}</span>}
        {v.snapshotId && <Link href={`/payroll/history?entity=${view.entity.id}&month=${view.month}&version=${v.version}`} className="underline">frozen version</Link>}</li>)}</ul></div>}
    <div><h3 className="text-sm font-semibold">Run audit</h3>
      <ul className="mt-1 max-h-72 divide-y overflow-auto text-xs" data-testid="run-audit">{[...view.audit].reverse().map((a) => <li key={a.id} className="py-1">
        <strong>v{a.version} · {a.action}</strong> · {a.reason} · {a.who} · {when(a.at)}</li>)}
        {!view.audit.length && <li className="py-2 text-muted-foreground">No actions yet.</li>}</ul></div>
    {current && <ReasonDialog open onOpenChange={(o) => !o && setAction(null)} title={current.title} description={current.description} confirmLabel={current.label}
      onConfirm={async (reason) => { await current.run(reason); await refreshPayroll(); }} />}
  </Section>;
}
