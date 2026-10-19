/**
 * Payroll history (SCRUM-569, R4): the prototype's payroll-history-hub,
 * company-history and company-payslip-browser on real data. Every locked
 * version of every month, newest first; open one to see what was frozen —
 * totals, who confirmed and locked it, its audit at lock — and its files:
 * one payslip per person and the bank, cash and report files. A file opens
 * in a new tab exactly as frozen (payslips print to PDF from there), and the
 * opening is written to the run audit. Payroll roles only.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link, useSearch } from "wouter";
import { Download, FileText, History, LockKeyhole } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { canViewHrSalary, HR_PAY_HIDDEN_NOTE } from "@shared/hr-salary-permission";
import type { PayrollHistoryRow } from "@shared/payroll-month";
import { downloadsPath, errorText, historyFileUrl, money, monthLabel, useHistoryVersion, usePayrollHistory } from "@/lib/payroll/api";

const STATUS: Record<string, string> = { locked: "Locked", paid: "Paid", superseded: "Replaced by a newer version" };
const Empty = ({ children }: { children: ReactNode }) => <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{children}</p>;

export default function PayrollHistoryPage() {
  const { user } = useAuth();
  const search = new URLSearchParams(useSearch());
  const history = usePayrollHistory();
  const [picked, setPicked] = useState<{ entityId: string; month: string; version: number } | null>(() => {
    const entityId = search.get("entity"), month = search.get("month"), version = Number(search.get("version"));
    return entityId && month && version ? { entityId, month, version } : null;
  });
  if (!canViewHrSalary(user?.role)) return <div className="p-6"><Empty>{HR_PAY_HIDDEN_NOTE}.</Empty></div>;
  const rows = history.data ?? [];
  const key = (r: Pick<PayrollHistoryRow, "entityId" | "month" | "version">) => `${r.entityId}:${r.month}:${r.version}`;
  return <div className="mx-auto max-w-7xl space-y-5 p-4 sm:p-6" data-testid="page-payroll-history">
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-primary">Payroll</p>
      <h1 className="text-2xl font-semibold">Locked months &amp; payslips</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Every month the Owner locked, as it was frozen. A reopened month keeps its earlier version here unchanged. <Link href="/payroll/month-end" className="underline">Go to month-end</Link>.</p>
    </div>
    {history.isLoading && <Skeleton className="h-48 w-full" />}
    {history.error && <Empty>{errorText(history.error)}</Empty>}
    {history.data && !rows.length && <Empty>No locked months yet. A month appears here once the Owner locks it.</Empty>}
    <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
      {rows.length > 0 && <ul className="space-y-2" data-testid="history-list">{rows.map((r) => <li key={key(r)}>
        <button type="button" onClick={() => setPicked(r)} className={`w-full rounded-lg border p-3 text-left text-sm hover:bg-muted/50 ${picked && key(picked) === key(r) ? "border-primary bg-primary/5" : ""}`}>
          <span className="flex flex-wrap items-center gap-2"><strong>{monthLabel(r.month)}</strong> · v{r.version}<Badge variant={r.status === "superseded" ? "secondary" : "outline"}>{STATUS[r.status] ?? r.status}</Badge></span>
          <span className="block text-xs text-muted-foreground">{r.entityName} · {r.people} people · net {money(r.totals.net)}</span>
          <span className="block text-xs text-muted-foreground">Locked {new Date(r.lockedAt).toLocaleDateString("en-GB")} by {r.lockedBy} · GM {r.gmActor}</span>
        </button></li>)}</ul>}
      {picked && <VersionDetail {...picked} />}
    </div>
  </div>;
}

function VersionDetail({ entityId, month, version }: { entityId: string; month: string; version: number }) {
  const detail = useHistoryVersion(entityId, month, version);
  const [find, setFind] = useState("");
  const payslips = useMemo(() => (detail.data?.files ?? []).filter((f) => f.group === "Payslips" && f.employeeId)
    .filter((f) => !find.trim() || (f.name ?? "").toLowerCase().includes(find.trim().toLowerCase())).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")), [detail.data, find]);
  if (detail.isLoading) return <Skeleton className="h-64 w-full" />;
  if (detail.error || !detail.data) return <Empty>{errorText(detail.error)}</Empty>;
  const d = detail.data;
  const others = d.files.filter((f) => !(f.group === "Payslips" && f.employeeId));
  return <Card data-testid="history-version">
    <CardHeader className="border-b pb-3">
      <CardTitle className="flex flex-wrap items-center gap-2 text-base"><LockKeyhole className="h-4 w-4" />{d.entityName} · {monthLabel(d.month)} · version {d.version}
        <Badge variant="outline">{STATUS[d.status] ?? d.status}</Badge></CardTitle>
      <CardDescription className="text-xs">Locked {new Date(d.lockedAt).toLocaleString("en-GB")} by {d.lockedBy} · GM {d.gmActor} · source {d.sourceSignature.slice(0, 19)}… · engine {d.engineRevision}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4 pt-4">
      <div className="grid gap-2 sm:grid-cols-5">{([["Gross", d.totals.gross], ["Deductions", d.totals.deductions], ["Net pay", d.totals.net], ["Employer", d.totals.employer], ["Total cost", d.totals.totalCost]] as const).map(([label, value]) =>
        <div key={label} className="rounded-md border p-2"><p className="text-xs text-muted-foreground">{label}</p><p className="font-semibold tabular-nums">{money(value)}</p></div>)}</div>
      <p className="text-xs text-muted-foreground">Bank files {money(d.manifest.bankAmount)} + cash {money(d.manifest.cashAmount)} − net = {money(d.manifest.difference)}</p>
      <section>
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2"><h3 className="flex items-center gap-2 text-sm font-semibold"><FileText className="h-4 w-4" />Payslips ({payslips.length})</h3>
          <Input className="h-8 max-w-xs" placeholder="Find a person" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Find a person" /></div>
        <ul className="divide-y rounded-lg border text-sm" data-testid="history-payslips">{payslips.map((f) => <li key={f.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
          <span className="flex-1">{f.name ?? f.employeeId}</span><span className="tabular-nums">{money(f.total)}</span>
          <a className="underline" href={historyFileUrl(f.id)} target="_blank" rel="noreferrer">Open / print</a>
          <a className="inline-flex items-center gap-1 underline" href={historyFileUrl(f.id, true)}><Download className="h-3.5 w-3.5" />Save</a></li>)}
          {!payslips.length && <li className="px-3 py-3 text-muted-foreground">No payslip matches.</li>}</ul>
        <p className="mt-1 text-xs text-muted-foreground">Opening someone's payslip is recorded in the run audit.</p>
      </section>
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Bank, cash and report files</h3>
          <Link href={downloadsPath(d.entityId, d.month, d.version)} className="inline-flex items-center gap-1 text-sm underline" data-testid="history-downloads-link"><Download className="h-3.5 w-3.5" />Downloads and reconciliation</Link></div>
        <ul className="divide-y rounded-lg border text-sm">{others.map((f) => <li key={f.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
          <Badge variant="outline">{f.group}</Badge><span className="flex-1 break-all text-xs">{f.filename}</span>
          {f.total ? <span className="tabular-nums">{money(f.total)}</span> : null}
          <a className="inline-flex items-center gap-1 underline" href={historyFileUrl(f.id, true)}><Download className="h-3.5 w-3.5" />Save</a></li>)}</ul>
        <p className="mt-1 text-xs text-muted-foreground">{d.manifest.note}</p>
      </section>
      <details className="text-xs"><summary className="flex cursor-pointer items-center gap-1 font-semibold"><History className="h-3.5 w-3.5" />Audit at lock ({d.audit.length})</summary>
        <ul className="mt-1 divide-y">{d.audit.map((a) => <li key={a.id} className="py-1"><strong>{a.action}</strong> · {a.reason} · {a.who} · {new Date(a.at).toLocaleString("en-GB")}</li>)}</ul></details>
    </CardContent>
  </Card>;
}
