/**
 * My payslips (SCRUM-569, R4): the prototype's payroll-my-payslips page,
 * reading company snapshots only. Everyone signed in sees the payslips of the
 * employee linked to their own account, from locked months only — a month
 * appears once the Owner locks it, and a reopened month shows its newest
 * locked version. Nobody else's payslip is reachable here.
 */
import type { ReactNode } from "react";
import { Download, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { errorText, money, monthLabel, myPayslipUrl, useMyPayslips } from "@/lib/payroll/api";

const Empty = ({ children }: { children: ReactNode }) => <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{children}</p>;

export default function PayrollMyPayslipsPage() {
  const slips = useMyPayslips();
  return <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6" data-testid="page-my-payslips">
    <div>
      <h1 className="text-2xl font-semibold">My payslips</h1>
      <p className="mt-1 text-sm text-muted-foreground">View or save the payslip approved for each month. A payslip appears once the month's payroll is locked.</p>
    </div>
    {slips.isLoading && <Skeleton className="h-40 w-full" />}
    {slips.error && <Empty>{errorText(slips.error)}</Empty>}
    {slips.data && !slips.data.employee && <Empty>Your sign-in is not linked to an employee record, so there are no payslips to show. Ask HR to link your account.</Empty>}
    {slips.data?.employee && <Card>
      <CardHeader className="border-b pb-3"><CardTitle className="flex items-center gap-2 text-base"><FileText className="h-4 w-4" />{slips.data.employee.name}</CardTitle>
        <CardDescription className="text-xs">Approved months only. Figures are frozen when the month is locked.</CardDescription></CardHeader>
      <CardContent className="pt-4">
        {!slips.data.payslips.length ? <Empty>No locked payslips yet.</Empty> :
          <ul className="divide-y text-sm" data-testid="my-payslips">{slips.data.payslips.map((p) => <li key={p.fileId} className="flex flex-wrap items-center gap-2 py-2">
            <span className="flex-1"><strong>{monthLabel(p.month)}</strong> · {p.entityName}{p.version > 1 && <span className="text-xs text-muted-foreground"> · corrected version {p.version}</span>}</span>
            <Badge variant="outline">{p.status === "paid" ? "Paid" : "Approved"}</Badge>
            <span className="font-semibold tabular-nums">{money(p.net)}</span>
            <a className="underline" href={myPayslipUrl(p.fileId)} target="_blank" rel="noreferrer">Open / print</a>
            <a className="inline-flex items-center gap-1 underline" href={myPayslipUrl(p.fileId, true)}><Download className="h-3.5 w-3.5" />Save</a></li>)}</ul>}
      </CardContent>
    </Card>}
  </div>;
}
