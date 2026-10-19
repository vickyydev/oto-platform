/**
 * The payroll hub (SCRUM-572, R7): the prototype's hub (payroll-hub,
 * hub-frame, needs-attention) as the front door of the company payroll,
 * replacing the old overview. It shows where this month stands for each
 * paying company (its run, and the problems still open from the month's
 * check, the prototype's needs-attention count) and one card per payroll
 * page from the shared navigation table (lib/payroll/nav.ts), so the hub and
 * the sidebar list the same pages. Payroll roles only; anyone else is sent to
 * their own payslips by the router before this renders.
 */
import type { ReactNode } from "react";
import { Link } from "wouter";
import { AlertTriangle, ArrowRight, CalendarCheck, CheckCircle2, Download, FileSpreadsheet, FileText, History, Landmark, PlayCircle, Settings, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { canViewHrSalary, HR_PAY_HIDDEN_NOTE } from "@shared/hr-salary-permission";
import { downloadsPath, errorText, monthLabel, useMonthEnd, usePayrollSetup, usePreview } from "@/lib/payroll/api";
import { PAYROLL_HUB_CARDS, PAYROLL_PATHS, type PayrollEntryId } from "@/lib/payroll/nav";

const thisMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
const Empty = ({ children }: { children: ReactNode }) => <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{children}</p>;
const STATUS_LABEL: Record<string, string> = { draft: "Draft", "gm-confirmed": "GM confirmed", locked: "Locked", paid: "Paid", superseded: "Replaced by a newer version" };
const ICONS: Partial<Record<PayrollEntryId, typeof Users>> = {
  run: PlayCircle, people: Users, history: History, downloads: Download, documents: Landmark, setup: Settings, myPayslips: FileText,
};

export default function PayrollHubPage() {
  const { user } = useAuth();
  const setup = usePayrollSetup();
  const month = thisMonth();
  if (!canViewHrSalary(user?.role)) return <div className="p-6"><Empty>{HR_PAY_HIDDEN_NOTE}.</Empty></div>;
  const entities = (setup.data?.entities ?? []).filter((e) => !e.archivedAt);
  return <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6" data-testid="page-payroll-hub">
    <header>
      <p className="text-xs font-semibold uppercase tracking-wider text-primary">Payroll</p>
      <h1 className="text-2xl font-semibold">Payroll</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Run the month, look back at locked months and payslips, and keep the set-up behind them current. Nothing here moves money.</p>
    </header>

    <section aria-label={`${monthLabel(month)} at a glance`} className="space-y-2">
      <h2 className="text-sm font-semibold">{monthLabel(month)}</h2>
      {setup.isLoading && <Skeleton className="h-20 w-full" />}
      {setup.error && <Empty>{errorText(setup.error)}</Empty>}
      {setup.data && !entities.length && <Empty>No paying company yet. Add it in <Link href={PAYROLL_PATHS.setup} className="underline">Payroll setup</Link> to run a month.</Empty>}
      <div className="grid gap-3 md:grid-cols-2">{entities.map((e) => <MonthAtAGlance key={e.id} entityId={e.id} entityName={e.name} month={month} />)}</div>
    </section>

    <nav aria-label="Payroll pages" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="payroll-hub-cards">
      {PAYROLL_HUB_CARDS.map((entry) => {
        const Icon = ICONS[entry.id] ?? FileSpreadsheet;
        return <Link key={entry.id} href={entry.url} data-testid={`hub-card-${entry.id}`}
          className="group flex min-h-24 items-start gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Icon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1 font-semibold">{entry.title}<ArrowRight aria-hidden="true" className="h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" /></span>
            <span className="mt-0.5 block text-sm text-muted-foreground">{entry.description}</span>
          </span>
        </Link>;
      })}
    </nav>
    <p className="text-xs text-muted-foreground">Your own payslips are under <Link href={PAYROLL_PATHS.myPayslips} className="underline">My Payslips</Link>.</p>
  </div>;
}

/** One paying company's month: its run and the check's open problems (the prototype's needs-attention count). */
function MonthAtAGlance({ entityId, entityName, month }: { entityId: string; entityName: string; month: string }) {
  const view = useMonthEnd(entityId, month);
  const preview = usePreview(entityId, month, true);
  const run = view.data?.run;
  const problems = (preview.data?.result?.exceptions ?? []).filter((x) => x.severity !== "info");
  const blocking = problems.filter((x) => x.severity === "blocking").length;
  const open = preview.data?.openProblems ?? 0;
  return <Card data-testid={`hub-month-${entityId}`}>
    <CardContent className="space-y-2 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <CalendarCheck aria-hidden="true" className="h-4 w-4 text-primary" /><strong className="min-w-0 break-words">{entityName}</strong>
        {view.isLoading ? <Skeleton className="h-5 w-24" /> : run
          ? <Badge variant="outline">Version {run.version} · {STATUS_LABEL[run.status] ?? run.status}</Badge>
          : view.data && <Badge variant="secondary">Not started</Badge>}
      </div>
      {preview.isLoading && <Skeleton className="h-4 w-48" />}
      {preview.error && <p className="text-xs text-muted-foreground">The month cannot be checked yet: {errorText(preview.error)}</p>}
      {preview.data && (preview.data.frozen
        ? <p className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300"><CheckCircle2 aria-hidden="true" className="h-4 w-4" />Locked: the amounts are frozen.</p>
        : open === 0 && blocking === 0
          ? <p className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300" data-testid="hub-needs-attention"><CheckCircle2 aria-hidden="true" className="h-4 w-4" />No problems to fix.</p>
          : <p className="flex items-center gap-1.5 text-amber-800 dark:text-amber-300" data-testid="hub-needs-attention"><AlertTriangle aria-hidden="true" className="h-4 w-4" />
            {open} to check · {blocking} blocking · {problems.length - blocking} warnings</p>)}
      <Link href={`${PAYROLL_PATHS.run}?entity=${encodeURIComponent(entityId)}&month=${month}${preview.data && !preview.data.frozen && (open || blocking) ? "&tab=preview" : ""}`}
        className="inline-flex items-center gap-1 font-semibold text-primary underline underline-offset-2">Open month-end<ArrowRight aria-hidden="true" className="h-4 w-4" /></Link>
      {run && (run.status === "locked" || run.status === "paid") && <Link href={downloadsPath(entityId, month, run.version)} data-testid={`hub-downloads-${entityId}`}
        className="ml-4 inline-flex items-center gap-1 font-semibold text-primary underline underline-offset-2"><Download aria-hidden="true" className="h-4 w-4" />Downloads</Link>}
    </CardContent>
  </Card>;
}
