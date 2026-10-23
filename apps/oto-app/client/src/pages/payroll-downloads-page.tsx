/**
 * Payroll downloads (SCRUM-570, R5): the prototype's downloads-list and
 * company-outputs-panel for ONE locked version, on the files the lock stored.
 * The banner is bank files plus cash against net, read by the server from the
 * stored files' own bytes (never recomputed here). Files are grouped as the
 * prototype groups them; each opens or saves as the exact bytes frozen at
 * lock, and every download is written to the run audit. "Download all as
 * ZIP" is the stored bundle. The welfare fund says plainly when no workbook
 * was made. Payroll roles only.
 */
import type { ReactNode } from "react";
import { Link, useParams } from "wouter";
import { Archive, Download, ExternalLink, LockKeyhole } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { canViewHrSalary, HR_PAY_HIDDEN_NOTE } from "@shared/hr-salary-permission";
import type { EwfOutputState, PayrollDownloadsView } from "@shared/payroll-month";
import { errorText, historyFileUrl, money, monthLabel, useDownloads } from "@/lib/payroll/api";

const STATUS: Record<string, string> = { locked: "Locked", paid: "Paid", superseded: "Replaced by a newer version" };
const GROUP_NOTE: Record<string, string> = {
  "Bank files": "Test one small batch with SCB before the first real run. Each SCB TXT and its XLSX fallback are the same batch: upload only one.",
  "Welfare fund (EWF)": "One EWF workbook per company · all branches included",
};
const btn = "inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-semibold hover:bg-muted";
const Empty = ({ children }: { children: ReactNode }) => <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{children}</p>;

function ewfText(ewf: EwfOutputState | null): string | null {
  if (!ewf || ewf.status === "in-force" || ewf.status === "not-applicable") return null;
  if (ewf.status === "not-yet-in-force") return `Not in force for this month: the welfare fund settings start on ${new Date(`${ewf.from}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC" })}. No EWF workbook was made.`;
  return "Not configured. No EWF workbook was made: enter the accountant's welfare fund settings in Payroll setup, then reopen and lock the month to make one.";
}

export default function PayrollDownloadsPage() {
  const { user } = useAuth();
  const params = useParams<{ entityId: string; month: string; version: string }>();
  const version = Number(params.version);
  const downloads = useDownloads(params.entityId ?? "", params.month ?? "", Number.isInteger(version) ? version : 0);
  if (!canViewHrSalary(user)) return <div className="p-6"><Empty>{HR_PAY_HIDDEN_NOTE}.</Empty></div>;
  return <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6" data-testid="page-payroll-downloads">
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-primary">Payroll</p>
      <h1 className="text-2xl font-semibold">Downloads</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">The bank, social security, welfare fund, tax and report files of one locked month, exactly as they were frozen. Every download is recorded in the run audit. <Link href={`/payroll/history?entity=${params.entityId}&month=${params.month}&version=${params.version}`} className="underline">Back to locked months</Link>.</p>
    </div>
    {downloads.isLoading && <Skeleton className="h-64 w-full" />}
    {downloads.error && <Empty>{errorText(downloads.error)}</Empty>}
    {downloads.data && <DownloadsCard d={downloads.data} />}
  </div>;
}

function DownloadsCard({ d }: { d: PayrollDownloadsView }) {
  const r = d.reconciliation;
  const ewf = ewfText(d.ewf);
  return <Card data-testid="downloads-list">
    <CardHeader className="border-b pb-3">
      <CardTitle className="flex flex-wrap items-center gap-2 text-base"><LockKeyhole className="h-4 w-4" />{d.entityName} · {monthLabel(d.month)} · version {d.version}
        <Badge variant="outline">{STATUS[d.status] ?? d.status}</Badge></CardTitle>
      <CardDescription className="text-xs">Locked {new Date(d.lockedAt).toLocaleString("en-GB")} by {d.lockedBy}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4 pt-4">
      <div data-testid="downloads-reconciliation" className={`rounded-lg border p-3 text-sm ${r.reconciled ? "border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30" : "border-red-300 bg-red-50 dark:bg-red-950/30"}`}>
        Bank {money(r.bank, d.currency)} + cash and manual payments {money(r.cash, d.currency)} = {money(r.bank + r.cash, d.currency)} vs net {money(r.net, d.currency)} · difference <strong>{money(r.difference, d.currency)}</strong>
        <p className="mt-1 text-xs text-muted-foreground">Read from the stored files themselves: {r.bankFiles.map((b) => `${b.filename} (${b.transfers} ${b.transfers === 1 ? "transfer" : "transfers"}, ${money(b.amount, d.currency)})`).join(" · ") || "no bank files"}{r.cashFile ? ` · ${r.cashFile}` : ""}.</p>
        {r.problems.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-red-800 dark:text-red-200">{r.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        {d.note && <p className="mt-1 text-xs text-muted-foreground">{d.note}</p>}
      </div>
      {d.lockedBeforeR5 && <Empty>This month was locked before every download was stored. The files below are the ones its lock saved; no new files are made for it. Reopen and lock it again for the full set.</Empty>}
      {d.uploadIssues.length > 0 && <ul className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">{d.uploadIssues.map((i) => <li key={i}>{i}</li>)}</ul>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Files</h3>
        {d.allFiles && <a className={btn} href={historyFileUrl(d.allFiles.id, true)} data-testid="download-all"><Archive className="h-3.5 w-3.5" />Download all as ZIP</a>}
      </div>
      {d.groups.map((g) => <section key={g.group}>
        <h4 className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{g.group}</h4>
        {GROUP_NOTE[g.group] && <p className="mb-1 text-xs text-muted-foreground">{GROUP_NOTE[g.group]}</p>}
        <ul className="divide-y divide-border rounded-md border border-border">{g.files.map((f) => <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
          <span className="min-w-0"><span className="block break-all font-mono text-xs">{f.filename}</span>
            <span className="text-xs text-muted-foreground">{f.name ? `${f.name} · ` : ""}{f.rows} rows · {money(f.total, d.currency)}{f.note ? ` · ${f.note}` : ""}</span></span>
          <span className="flex gap-1">
            {/^text\//.test(f.mime) && <a className={btn} href={historyFileUrl(f.id)} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" />Open</a>}
            <a className={btn} href={historyFileUrl(f.id, true)}><Download className="h-3.5 w-3.5" />Download</a></span></li>)}</ul>
      </section>)}
      {ewf && <section data-testid="downloads-ewf">
        <h4 className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Welfare fund (EWF)</h4>
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">{ewf}</p>
      </section>}
    </CardContent>
  </Card>;
}
