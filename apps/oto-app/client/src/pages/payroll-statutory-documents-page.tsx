/**
 * Tax & social-security documents (SCRUM-571, the company payroll's R6): the
 * prototype's payroll-statutory-documents-demo-page on real data — PND.1,
 * PND.1ก, 50 ทวิ, กท.20ก, the SSO forms and the EWF documents with their
 * deadlines, coverage, printable rendering from the engine's own HTML, filing
 * records and the EWF late-payment surcharge estimate.
 *
 * Owner decision 3 (2026-10-20): built exactly as the prototype has it. The
 * documents read locked PER-BRANCH payroll runs and a company month-end lock
 * writes none, so on our data every form has no source. The page says that
 * in plain words above the forms, names any locked company month-end of the
 * period that gives the documents nothing, and shows the engine's own
 * coverage words ("PROVISIONAL – 0 of 12 months; …"). Nothing is filled in.
 *
 * Payroll roles only; every save asks why; dialogs keep the DialogBody recipe
 * (ReasonDialog). No browser role switcher: the session decides.
 */
import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { AlertTriangle, Calculator, Download, ExternalLink, FileText, History, Info, Printer } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { canViewHrSalary, HR_PAY_HIDDEN_NOTE } from "@shared/hr-salary-permission";
import { STATUTORY_OUTSIDE_FILING_NOTE, type EwfSurchargeView, type StatutoryDocumentView, type StatutoryOfferView, type StatutoryView } from "@shared/payroll-statutory";
import { ReasonDialog } from "@/components/payroll/reason-dialog";
import { errorText, money, monthLabel, payrollCall, refreshPayroll } from "@/lib/payroll/api";
import { estimateEwfSurcharge, statutoryFileUrl, useStatutory } from "@/lib/payroll/statutory";

const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const parkMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
const prettyDate = (date: string) => { const d = new Date(`${date}T00:00:00Z`); return Number.isNaN(d.valueOf()) ? date : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }); };
const Empty = ({ children }: { children: ReactNode }) => <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{children}</p>;
const Note = ({ children }: { children: ReactNode }) => <p role="note" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm leading-6">{children}</p>;
function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return <div className="space-y-1.5"><Label htmlFor={htmlFor}>{label}</Label>{children}</div>;
}
function Section({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return <Card className="border-border shadow-sm">
    <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0 border-b border-border/70 pb-3">
      <div><CardTitle className="text-base">{title}</CardTitle>{description && <CardDescription className="mt-1 text-xs">{description}</CardDescription>}</div>{action}
    </CardHeader>
    <CardContent className="space-y-3 pt-4">{children}</CardContent>
  </Card>;
}
const STATE_LABEL = { "no-source": "No source", provisional: "Provisional", complete: "Complete" } as const;

export default function PayrollStatutoryDocumentsPage() {
  const { user } = useAuth();
  const [branchId, setBranchId] = useState("");
  const [kind, setKind] = useState<"month" | "year">("month");
  const [month, setMonth] = useState(parkMonth());
  const [year, setYear] = useState(parkMonth().slice(0, 4));
  const period = kind === "month" ? month : year;
  const view = useStatutory(branchId, period);
  if (!canViewHrSalary(user)) return <div className="p-6"><Empty>{HR_PAY_HIDDEN_NOTE}.</Empty></div>;
  const v = view.data;
  return <div className="mx-auto max-w-7xl space-y-5 p-4 sm:p-6" data-testid="page-payroll-statutory">
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-primary">Payroll</p>
      <h1 className="text-2xl font-semibold">Tax &amp; social-security documents</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">PND.1, PND.1ก, 50 ทวิ, กท.20ก, the SSO forms and the Employee Welfare Fund documents, with their deadlines. Documents are printable previews and labelled placeholders made only from locked payroll; nothing here files with an agency. <Link href="/payroll/history" className="underline">Locked months &amp; payslips</Link>.</p>
    </div>
    <div className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-3">
      <Field label="Branch" htmlFor="stat-branch"><select id="stat-branch" className={selectClass} value={v?.branchId ?? branchId} onChange={(e) => setBranchId(e.target.value)} data-testid="select-statutory-branch">
        {(v?.branches ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}{b.legalEntity ? ` · ${b.legalEntity}` : ""}</option>)}</select></Field>
      <Field label="Forms" htmlFor="stat-kind"><select id="stat-kind" className={selectClass} value={kind} onChange={(e) => setKind(e.target.value as "month" | "year")}>
        <option value="month">Monthly forms</option><option value="year">Annual forms</option></select></Field>
      {kind === "month"
        ? <Field label="Payroll month" htmlFor="stat-month"><Input id="stat-month" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field>
        : <Field label="Calendar year" htmlFor="stat-year"><Input id="stat-year" type="number" min="2000" max="2100" value={year} onChange={(e) => /^\d{4}$/.test(e.target.value) && setYear(e.target.value)} /></Field>}
    </div>
    {view.isLoading && <Skeleton className="h-64 w-full" />}
    {view.error && <Empty>{errorText(view.error)}</Empty>}
    {v && <StatutoryBody view={v} />}
  </div>;
}

function StatutoryBody({ view }: { view: StatutoryView }) {
  const [filing, setFiling] = useState<{ offer?: StatutoryOfferView; document?: StatutoryDocumentView } | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  if (!view.branches.length) return <Empty>No branch has payroll details yet. Add them in <Link href="/payroll/setup" className="underline">Payroll setup</Link> first.</Empty>;
  async function generate(offer: StatutoryOfferView, reason: string) {
    const r = await payrollCall<{ message: string }>("POST", "/api/payroll/statutory/documents", { branchId: view.branchId, period: view.period, code: offer.code, staffId: offer.staffId, reason });
    setNotice({ error: false, text: r.message });
    await refreshPayroll();
  }
  return <div className="space-y-5">
    {view.source.notes.length > 0 && <div className="space-y-2" data-testid="statutory-source-notes">{view.source.notes.map((n) => <Note key={n}><AlertTriangle className="mr-2 inline h-4 w-4" />{n}</Note>)}</div>}
    {notice && <p role={notice.error ? "alert" : "status"} className={`rounded-lg border p-3 text-sm ${notice.error ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-emerald-500/40 bg-emerald-500/10"}`}>{notice.text}</p>}
    <Section title={`Forms · ${view.kind === "month" ? monthLabel(view.period) : view.period}`} description="Status and deadlines come from the branch's country template (Thailand). Missing months are never counted as zero.">
      <OfferTable view={view} onGenerate={generate} onRecord={(offer) => setFiling({ offer })} />
    </Section>
    {view.documents.length > 0 && <Section title="Rendered documents" description="Each opens exactly as it was rendered from its locked source. Opening or saving one is recorded.">
      <ul className="divide-y rounded-lg border text-sm">{view.documents.map((d) => <li key={d.id} className="space-y-1 px-3 py-2">
        <p className="flex flex-wrap items-center gap-2"><strong>{d.title}</strong>{d.provisional && <Badge variant="outline">Provisional</Badge>}{d.superseded && <Badge variant="secondary">Superseded</Badge>}{d.filing && <Badge>Filed {prettyDate(d.filing.filedOn)} · {d.filing.reference}</Badge>}</p>
        <p className="text-xs text-muted-foreground">Rendered {new Date(d.renderedAt).toLocaleString("en-GB")} by {d.renderedBy} · source {d.sourceRuns.map((r) => `${r.month} v${r.version}`).join(", ")}</p>
        <p className="flex flex-wrap gap-3 text-xs">{d.files.map((f) => <a key={f.index} className="inline-flex items-center gap-1 underline" href={statutoryFileUrl(d.id, f.index, f.index > 0)} target={f.index === 0 ? "_blank" : undefined} rel="noreferrer">
          {f.index === 0 ? <Printer className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}{f.index === 0 ? "Open / print" : f.name}</a>)}
          {!d.filing && view.canManage && <button type="button" className="underline disabled:opacity-50" disabled={d.provisional || d.superseded || d.code.startsWith("EWF")} onClick={() => setFiling({ document: d })}>Mark as filed</button>}</p>
        {d.provisional && <p className="text-xs text-muted-foreground">Provisional documents cannot be marked filed.</p>}
      </li>)}</ul>
      <p className="text-xs text-muted-foreground">Uploads are placeholders only. They are not submission-ready and have not been validated against an agency filing system.</p>
    </Section>}
    <Section title="Filing records" description="What was filed, when, with which reference and why — with the coverage this page showed when it was saved.">
      {!view.filings.length ? <Empty>No filing is recorded for this branch and period.</Empty>
        : <ul className="divide-y rounded-lg border text-sm" data-testid="statutory-filings">{view.filings.map((f) => <li key={f.id} className="px-3 py-2">
          <p className="flex flex-wrap items-center gap-2"><strong>{f.code}</strong>{f.staffId && <span className="text-xs">· {f.staffId}</span>}<Badge variant={f.coverageState === "complete" ? "default" : "outline"}>{STATE_LABEL[f.coverageState]}</Badge>
            {!f.documentId && <Badge variant="secondary">Filed outside the app</Badge>}</p>
          <p className="text-xs text-muted-foreground">Filed {prettyDate(f.filedOn)} · reference {f.reference} · recorded by {f.filedBy} on {new Date(f.createdAt).toLocaleString("en-GB")} · {f.reason}</p>
        </li>)}</ul>}
    </Section>
    {view.ewf.relevant && <EwfSection view={view} />}
    <details className="rounded-lg border bg-card p-3 text-xs"><summary className="flex cursor-pointer items-center gap-1 font-semibold"><History className="h-3.5 w-3.5" />Document history ({view.audit.length})</summary>
      {!view.audit.length ? <p className="mt-2 text-muted-foreground">No document events are recorded.</p>
        : <ul className="mt-2 divide-y">{view.audit.map((a) => <li key={a.id} className="py-1"><strong>{a.action}</strong> · {a.code}{a.staffId ? ` · ${a.staffId}` : ""}{a.reason ? ` · ${a.reason}` : ""} · {a.who} · {new Date(a.at).toLocaleString("en-GB")}</li>)}</ul>}
    </details>
    {filing && <FilingDialog view={view} target={filing} onClose={() => setFiling(null)} onSaved={(text) => setNotice({ error: false, text })} />}
  </div>;
}

function OfferTable({ view, onGenerate, onRecord }: {
  view: StatutoryView; onGenerate: (offer: StatutoryOfferView, reason: string) => Promise<void>; onRecord: (offer: StatutoryOfferView) => void;
}) {
  const [rendering, setRendering] = useState<StatutoryOfferView | null>(null);
  if (!view.offers.length) return <Empty>No forms are due for this branch and period.</Empty>;
  return <>
    <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-left text-sm" data-testid="statutory-offers">
      <thead className="text-xs uppercase text-muted-foreground"><tr><th className="p-2">Form</th><th className="p-2">Deadline</th><th className="p-2">Source &amp; coverage</th><th className="p-2">Status</th><th className="p-2" /></tr></thead>
      <tbody className="divide-y">{view.offers.map((offer) => {
        const doc = view.documents.find((d) => d.id === offer.documentId);
        const status = offer.reminderOnly ? "Reminder only" : doc?.filing ? "Filed" : offer.filed ? "Filing recorded" : doc ? (doc.provisional ? "Provisional" : "Rendered") : offer.coverageState === "no-source" ? "No source" : offer.provisional ? "Provisional" : "Not rendered";
        return <tr key={offer.key} className="align-top" data-testid={`statutory-offer-${offer.code}`}>
          <td className="p-2"><strong>{offer.title}</strong><span className="block text-xs text-muted-foreground">{offer.code} · {offer.staffId ? `Individual · ${offer.staffId}` : "Employer"}</span></td>
          <td className="p-2">{prettyDate(offer.dueDate)}{offer.code === "PND1" && <span className="ml-1 inline-flex align-middle" title="Paper filing is due on the 7th; e-filing is due on the 15th." aria-label="Filing channels: paper filing due on the 7th; e-filing due on the 15th."><Info className="h-4 w-4 text-muted-foreground" /></span>}</td>
          <td className="p-2 text-xs">
            {offer.sourceRuns.length ? offer.sourceRuns.map((r) => <span key={`${r.month}:${r.version}`} className="mr-1 inline-block rounded bg-muted px-2 py-0.5">{r.month} v{r.version}</span>) : <span className="font-semibold">No locked source run</span>}
            <p className="mt-1">Locked {offer.coverage.locked.length} · Missing {offer.coverage.missing.join(", ") || "none"} · N/A {offer.coverage.notApplicable.length}</p>
            {offer.warnings.map((w) => <p key={w} className="mt-1 rounded bg-amber-500/10 px-2 py-1">{w}</p>)}
          </td>
          <td className="p-2"><Badge variant={status === "Filed" ? "default" : "outline"}>{status}</Badge></td>
          <td className="p-2">{offer.reminderOnly ? <span className="text-xs text-muted-foreground">Reminder only · no filing document</span> : <div className="flex flex-col gap-1">
            {view.canManage && <Button size="sm" variant="outline" disabled={!offer.sourceRuns.length} title={!offer.sourceRuns.length ? "A locked source run is required." : undefined} onClick={() => setRendering(offer)}><FileText className="mr-1 h-3.5 w-3.5" />{doc ? "Render again" : "Render"}</Button>}
            {doc && <a className="inline-flex items-center gap-1 text-xs underline" href={statutoryFileUrl(doc.id, 0)} target="_blank" rel="noreferrer"><Printer className="h-3.5 w-3.5" />Open / print</a>}
            {view.canManage && <Button size="sm" variant="ghost" onClick={() => onRecord(offer)}>Record a filing</Button>}
          </div>}</td>
        </tr>;
      })}</tbody>
    </table></div>
    {rendering && <ReasonDialog open onOpenChange={(o) => !o && setRendering(null)} title={`Render ${rendering.code}`} confirmLabel="Render"
      description="The document is made from its locked source runs only and stored as rendered."
      onConfirm={(reason) => onGenerate(rendering, reason)} />}
  </>;
}

function FilingDialog({ view, target, onClose, onSaved }: { view: StatutoryView; target: { offer?: StatutoryOfferView; document?: StatutoryDocumentView }; onClose: () => void; onSaved: (text: string) => void }) {
  const [filedOn, setFiledOn] = useState(view.today);
  const [reference, setReference] = useState("");
  const doc = target.document;
  const offer = target.offer;
  const code = doc?.code ?? offer?.code ?? "";
  return <ReasonDialog open onOpenChange={(o) => !o && onClose()} title={doc ? `Mark ${code} as filed` : `Record a filing of ${code}`} confirmLabel="Save filing"
    description={doc ? "Records the filing of this rendered document. A filed document cannot be filed again; an amendment is a new document." : undefined}
    onConfirm={async (reason) => {
      await payrollCall("POST", "/api/payroll/statutory/filings", doc
        ? { documentId: doc.id, filedOn, reference, reason }
        : { branchId: view.branchId, period: view.period, code, staffId: offer?.staffId, filedOn, reference, reason });
      onSaved(`Filing saved for ${code}. No agency submission was made from the app.`);
      await refreshPayroll();
    }}>
    {!doc && offer && <Note>{STATUTORY_OUTSIDE_FILING_NOTE} Coverage now: {offer.coverageState === "no-source" ? "no source" : offer.coverageState}.</Note>}
    <Field label="Filing date" htmlFor="filed-date"><Input id="filed-date" type="date" value={filedOn} onChange={(e) => setFiledOn(e.target.value)} /></Field>
    <Field label="Reference" htmlFor="filed-reference"><Input id="filed-reference" value={reference} maxLength={200} onChange={(e) => setReference(e.target.value)} placeholder="The agency's receipt or reference number" /></Field>
  </ReasonDialog>;
}

function EwfSection({ view }: { view: StatutoryView }) {
  const [dueDate, setDueDate] = useState(view.ewf.remittanceDue ?? "");
  const [asOfDate, setAsOfDate] = useState(view.today);
  const [principal, setPrincipal] = useState(view.ewf.frozenPrincipal !== null ? String(Math.max(0, view.ewf.frozenPrincipal - (view.ewf.paid?.amountPaid ?? 0))) : "");
  const [result, setResult] = useState<EwfSurchargeView | null>(null);
  const [error, setError] = useState<unknown>(null);
  async function estimate() {
    setError(null); setResult(null);
    try { setResult(await estimateEwfSurcharge(dueDate, asOfDate, principal)); } catch (e) { setError(e); }
  }
  return <Section title="Employee Welfare Fund (EWF)" description="Reminders use locked per-branch months and the recorded remittance only. No filing or payment happens here.">
    <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="statutory-ewf-lines">
      {view.ewf.lines.map((line) => <li key={line}>{line}</li>)}
      {view.ewf.remittanceDue && <li>Monthly สกล.3 remittance deadline: {prettyDate(view.ewf.remittanceDue)}.</li>}
      <li>{view.ewf.paid?.paidOn ? `Recorded remittance: ${money(view.ewf.paid.amountPaid)} paid on ${prettyDate(view.ewf.paid.paidOn)}.` : "No paid amount or date is recorded for this month (Payroll setup → EWF remittances)."}</li>
    </ul>
    <div className="grid gap-4 rounded-lg border p-4 md:grid-cols-2">
      <div className="space-y-2">
        <h3 className="flex items-center gap-2 font-semibold"><Calculator className="h-4 w-4" />Late-payment surcharge estimate</h3>
        <p className="text-xs text-muted-foreground">5% of the unpaid employee + employer principal for every full month late, plus one month when the remaining part is at least 15 days. Under 15 days is dropped. Simple, not compounded.</p>
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Due date" htmlFor="ewf-due"><Input id="ewf-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
          <Field label="Calculate as of" htmlFor="ewf-asof"><Input id="ewf-asof" type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} /></Field>
          <Field label="Unpaid principal (THB)" htmlFor="ewf-principal"><Input id="ewf-principal" inputMode="decimal" type="number" min="0" step="0.01" value={principal} onChange={(e) => setPrincipal(e.target.value)} placeholder="Employee + employer" /></Field>
        </div>
        {view.ewf.frozenPrincipal === null && <p className="text-xs text-muted-foreground">No frozen EWF amount exists to fill in the principal; the estimate uses only the figures entered here.</p>}
        <Button size="sm" variant="outline" onClick={() => void estimate()} data-testid="button-ewf-estimate">Estimate</Button>
        {error != null && <p role="alert" className="text-sm text-destructive">{errorText(error)}</p>}
        {result && <p className="text-sm font-medium" data-testid="ewf-estimate">As of {result.asOfDate}: principal {money(result.unpaidPrincipal)} × 5% × {result.chargeableMonths} chargeable month(s) = estimated {money(result.surcharge)}. Not compounded and not a payable ledger entry.</p>}
      </div>
      <div className="space-y-1 text-sm"><h3 className="font-semibold">Filing information</h3>
        <p>Head-office or branch-area filing may be available; verify the applicable office. The app does not file.</p>
        <a className="inline-flex items-center gap-1 underline" href="https://eservice.labour.go.th/" target="_blank" rel="noreferrer">eService · eservice.labour.go.th <ExternalLink className="h-3 w-3" /></a>
      </div>
    </div>
  </Section>;
}
