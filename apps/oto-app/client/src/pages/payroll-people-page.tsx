/**
 * The payroll staff roster (SCRUM-567, R2): the prototype's profile-roster,
 * one row per employee, counters that double as filters. Payroll roles only.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, ChevronRight, Search, Settings2, Users, Wand2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { canViewHrSalary, HR_PAY_HIDDEN_NOTE } from "@shared/hr-salary-permission";
import { WORKER_LABELS, type PayrollRosterRow } from "@shared/payroll-config";
import { ReasonDialog } from "@/components/payroll/reason-dialog";
import { errorText, payrollCall, refreshPayroll, usePayrollRoster } from "@/lib/payroll/api";

type Counter = "all" | "ready" | "attention" | "review" | "third-party";
const selectClass = "h-10 rounded-md border border-input bg-background px-3 text-sm";

export default function PayrollPeoplePage() {
  const { user } = useAuth();
  const roster = usePayrollRoster();
  const [query, setQuery] = useState("");
  const [branch, setBranch] = useState("");
  const [counter, setCounter] = useState<Counter>("all");
  const [showLeft, setShowLeft] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [notice, setNotice] = useState("");
  const rows = useMemo(() => (roster.data?.rows ?? []).filter((r) => showLeft || r.employmentState !== "LEFT"), [roster.data, showLeft]);
  if (!canViewHrSalary(user?.role)) return <div className="p-6"><p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{HR_PAY_HIDDEN_NOTE}.</p></div>;

  const isReady = (r: PayrollRosterRow) => !!r.readiness?.ready && r.validationErrors === 0 && r.reviewState === "reviewed";
  const thirdParty = (r: PayrollRosterRow) => r.warnings.some((w) => w.startsWith("Third-party"));
  const scoped = rows.filter((r) => !branch || r.homeBranchId === branch || r.lines.some((l) => l.costCentre === branch));
  const q = query.trim().toLowerCase();
  const visible = scoped.filter((r) => (!q || `${r.name} ${r.jobTitle} ${r.department ?? ""}`.toLowerCase().includes(q)) &&
    (counter === "all" || (counter === "ready" && isReady(r)) || (counter === "attention" && !isReady(r)) ||
      (counter === "review" && r.reviewState !== "reviewed") || (counter === "third-party" && thirdParty(r))));
  const counters: { id: Counter; label: string; value: number; tone: string }[] = [
    { id: "all", label: "People", value: scoped.length, tone: "text-foreground" },
    { id: "ready", label: "Ready", value: scoped.filter(isReady).length, tone: "text-emerald-700 dark:text-emerald-300" },
    { id: "attention", label: "Needs attention", value: scoped.filter((r) => !isReady(r)).length, tone: "text-amber-700 dark:text-amber-300" },
    { id: "review", label: "Needs review", value: scoped.filter((r) => r.reviewState !== "reviewed").length, tone: "text-amber-700 dark:text-amber-300" },
    { id: "third-party", label: "Third-party pay", value: scoped.filter(thirdParty).length, tone: "text-red-700 dark:text-red-300" },
  ];

  return <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6" data-testid="page-payroll-people">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-primary">Payroll</p>
        <h1 className="text-2xl font-semibold">Staff roster</h1>
        <p className="mt-1 text-sm text-muted-foreground">One payroll profile per person. Open a person to set job, split, pay method, extras and deductions.</p>
      </div>
      <div className="flex gap-2">
        <Link href="/payroll/setup"><Button variant="outline" size="sm"><Settings2 className="mr-1.5 h-4 w-4" />Payroll setup</Button></Link>
        {roster.data?.canDraft && <Button size="sm" variant="outline" onClick={() => setDrafting(true)} data-testid="button-draft-profiles"><Wand2 className="mr-1.5 h-4 w-4" />Propose drafts from HR data</Button>}
      </div>
    </div>
    {notice && <p role="status" className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">{notice}</p>}
    {roster.isLoading && <Skeleton className="h-64 w-full" />}
    {roster.error && <p className="rounded-lg border border-dashed p-4 text-sm">{errorText(roster.error)}</p>}
    {roster.data && <>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-5" role="group" aria-label="Roster counters">
        {counters.map((c) => <button key={c.id} type="button" aria-pressed={counter === c.id} onClick={() => setCounter(counter === c.id ? "all" : c.id)}
          className={`rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${counter === c.id ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-accent/40"}`}>
          <span className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground">{c.label}</span>
          <span className={`block text-2xl font-semibold tabular-nums ${c.tone}`}>{c.value}</span>
        </button>)}
      </div>
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative flex-1"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input aria-label="Search staff" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, job or department" className="pl-9" /></div>
        <select aria-label="Branch filter" value={branch} onChange={(e) => setBranch(e.target.value)} className={selectClass}>
          <option value="">All branches</option>{roster.data.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showLeft} onChange={(e) => setShowLeft(e.target.checked)} />Show people who left</label>
      </div>
      <p className="text-xs text-muted-foreground">As of {roster.data.asOf}. Showing {visible.length} of {rows.length} people.</p>
      {/* relative: the header's sr-only label is absolutely placed, and would otherwise widen the whole page on a phone (SCRUM-572). */}
      <div className="relative overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-muted/50 text-left text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            <tr><th className="px-4 py-2">Person</th><th className="px-3 py-2">Ready</th><th className="w-56 px-3 py-2">Where</th><th className="px-3 py-2 text-right">Pay</th><th className="px-3 py-2">Flags</th><th className="px-3 py-2"><span className="sr-only">Open</span></th></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.map((r) => {
              const href = `/payroll/people/${r.employeeId}`;
              const missing = r.readiness?.checks.filter((c) => !c.ok) ?? [];
              return <tr key={r.employeeId} className="align-top hover:bg-accent/30" data-testid={`roster-row-${r.employeeId}`}>
                <td className="px-4 py-3"><Link href={href} className="font-medium hover:underline">{r.name}</Link>
                  <p className="text-xs text-muted-foreground">{[r.jobTitle, r.department, r.workerType ? WORKER_LABELS[r.workerType] : null].filter(Boolean).join(" · ") || "—"}</p></td>
                <td className="px-3 py-3">{!r.hasProfile ? <Badge variant="outline">No profile</Badge> :
                  <span title={missing.map((c) => c.label).join(", ") || "All checks pass"} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${isReady(r) ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200" : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"}`}>
                    {isReady(r) ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                    {isReady(r) ? "Ready" : r.reviewState === "needs-review" ? "Needs review" : `${missing.length + r.validationErrors} to fix`}</span>}</td>
                <td className="px-3 py-3"><p className="text-xs">{roster.data!.branches.find((b) => b.id === r.homeBranchId)?.name ?? r.branchName ?? "—"}</p>
                  {r.allocationBadge && <p className="text-[11px] text-muted-foreground" data-testid="allocation-badge">{r.allocationBadge}</p>}</td>
                <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">{r.payLine ?? "—"}</td>
                <td className="px-3 py-3"><div className="flex flex-wrap gap-1">
                  {r.warnings.filter((w) => w !== "No payroll profile yet.").map((w) => <span key={w} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${w.startsWith("Third-party") ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"}`}><AlertTriangle className="h-3 w-3" />{w}</span>)}
                  {r.employmentState !== "ACTIVE" && <Badge variant="secondary">{r.employmentState === "LEFT" ? "Left" : "Leaving"}</Badge>}
                </div></td>
                <td className="px-3 py-3"><Link href={href} aria-label={`Open ${r.name}`} className="inline-flex rounded-md p-1 text-muted-foreground hover:bg-muted"><ChevronRight className="h-4 w-4" /></Link></td>
              </tr>;
            })}
          </tbody>
        </table>
        {!visible.length && <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground"><Users className="h-6 w-6" />No people match these filters.</div>}
      </div>
    </>}
    {drafting && <ReasonDialog open onOpenChange={setDrafting} title="Propose draft profiles from HR data" confirmLabel="Propose drafts"
      description="Creates a profile marked Needs review for each current employee without one: job title, dates, tax and SSO numbers, and the worker type's flags. No salary, day rate, food amount, bank account or advance is copied; those are offered on each profile and apply only when you save it."
      onConfirm={async (reason) => {
        const result = await payrollCall<{ created: number; skipped: number }>("POST", "/api/payroll/profiles/drafts", { reason });
        setNotice(`${result.created} draft profile${result.created === 1 ? "" : "s"} proposed; ${result.skipped} already had one.`);
        await refreshPayroll();
      }} />}
  </div>;
}
