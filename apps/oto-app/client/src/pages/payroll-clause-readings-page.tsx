/**
 * Incentive clauses from contracts (SCRUM-1075; owner approval, 26 November
 * 2026). Per person with an "Incentive / Commission Clause" on the HR
 * profile: the clause as written, the AI's reading in payroll's own terms and
 * in plain words, a worked example the PAYROLL ENGINE calculates on a month's
 * saved figures, and the questions a person must settle. A payroll manager or
 * admin approves the reading (it becomes an ordinary dated incentive rule),
 * corrects it, or marks the clause not an incentive. Nothing is paid until a
 * reading is approved, and an edited clause is flagged here while its
 * approved reading keeps paying. Every action asks why (ReasonDialog).
 */
import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { AlertTriangle, Bot, CheckCircle2, CircleDashed, PenLine, Sparkles, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { canViewHrSalary, HR_PAY_HIDDEN_NOTE } from "@shared/hr-salary-permission";
import {
  CLAUSE_STATE_LABEL, NOT_BONUS_KINDS,
  type ClauseBonusTerms, type ClausePart, type ClausePersonView, type ClauseReading, type ClauseReadingsView, type ClauseState,
} from "@shared/payroll-clause-reading";
import { ReasonDialog } from "@/components/payroll/reason-dialog";
import { ClauseMark } from "@/components/payroll/clause-mark";
import { errorText, money, monthBefore, monthLabel, payrollCall, refreshPayroll, useClauseExample, useClauseReadings } from "@/lib/payroll/api";
import { Field, NumberInput } from "@/pages/payroll-setup-page";

const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const Empty = ({ children }: { children: ReactNode }) => <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{children}</p>;
const thisMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
const NOT_BONUS_LABEL: Record<string, string> = { "service-charge": "Service charge", "salary-change": "Salary change", benefit: "Benefit", other: "Other" };


function StateBadge({ state }: { state: ClauseState }) {
  const tone = state === "approved" ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
    : state === "not-incentive" ? "" : "border-orange-500/50 bg-orange-500/10 text-orange-800 dark:text-orange-300";
  return <Badge variant="outline" className={tone} data-testid="clause-state">{CLAUSE_STATE_LABEL[state]}</Badge>;
}

export default function PayrollClauseReadingsPage() {
  const { user } = useAuth();
  const view = useClauseReadings();
  const [month, setMonth] = useState(monthBefore(thisMonth()));
  const [show, setShow] = useState<"all" | "open" | "approved">("all");
  const [bulk, setBulk] = useState(false);
  if (!canViewHrSalary(user)) return <div className="p-6"><Empty>{HR_PAY_HIDDEN_NOTE}.</Empty></div>;
  const data = view.data;
  const open = (p: ClausePersonView) => p.state !== "approved" && p.state !== "not-incentive";
  const people = (data?.people ?? []).filter((p) => show === "all" || (show === "open" ? open(p) : !open(p)));
  const unread = (data?.people ?? []).filter((p) => p.state === "not-read" || p.state === "changed");
  return <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6" data-testid="page-payroll-clauses">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-primary">Setup</p>
        <h1 className="text-2xl font-semibold">Incentive clauses from contracts</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">The AI reads a clause once, when it is new or changed, and says it in payroll's own terms. A payroll manager or admin approves the reading; it then becomes an incentive rule that the payroll engine calculates every month. Nothing is paid until a reading is approved. Service charge, salary changes and benefits written in a clause are flagged and never paid as a bonus.</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Worked examples on"><Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} data-testid="input-example-month" /></Field>
        <Link href="/payroll/setup/rewards" className="inline-flex h-10 items-center rounded-md border px-3 text-sm font-semibold hover:bg-muted">Service charge &amp; incentives</Link>
        <Link href="/payroll/month-end" className="inline-flex h-10 items-center rounded-md border px-3 text-sm font-semibold hover:bg-muted">Run payroll</Link>
      </div>
    </div>
    {view.isLoading && <Skeleton className="h-64 w-full" />}
    {view.error && <Empty>{errorText(view.error)}</Empty>}
    {data && <>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Button size="sm" variant={show === "all" ? "default" : "outline"} onClick={() => setShow("all")}>{data.people.length} with a clause</Button>
        <Button size="sm" variant={show === "open" ? "default" : "outline"} onClick={() => setShow("open")} data-testid="filter-open">{data.people.filter(open).length} need a person</Button>
        <Button size="sm" variant={show === "approved" ? "default" : "outline"} onClick={() => setShow("approved")}>{data.people.filter((p) => !open(p)).length} decided</Button>
        {data.canManage && data.aiConfigured && unread.length > 0 && <Button size="sm" variant="outline" className="ml-auto" onClick={() => setBulk(true)} data-testid="button-read-all">
          <Sparkles className="mr-1.5 h-4 w-4" />Read {unread.length} unread clause{unread.length === 1 ? "" : "s"} with AI</Button>}
      </div>
      {!data.aiConfigured && <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">The AI reader is not set up on this server. Readings can still be written by hand with Correct.</p>}
      {!people.length && <Empty>No clause here.</Empty>}
      {people.map((p) => <PersonCard key={p.employeeId} person={p} data={data} month={month} />)}
      {bulk && <ReasonDialog open onOpenChange={setBulk} title={`Read ${unread.length} clauses with AI`} confirmLabel="Read them"
        description="Each clause is read once and saved as a reading waiting for approval. Nothing is paid until a person approves a reading."
        onConfirm={async (reason) => {
          for (const p of unread) await payrollCall("POST", `/api/payroll/setup/rewards/clauses/${p.employeeId}/read`, { reason });
          await refreshPayroll();
        }} />}
    </>}
  </div>;
}

/** One bonus part's terms in plain words, with the park's own names. */
function termsText(b: ClauseBonusTerms, data: ClauseReadingsView): string {
  if (b.joinPool) return `Joins the approved team pool "${data.pools.find((p) => p.ruleId === b.joinPool)?.name ?? "a pool no longer approved"}".`;
  const label = (key: string) => data.streams.find((s) => s.key === key)?.label ?? key;
  const what = b.basis === "percent-of-revenue"
    ? `${b.percent ?? "?"}% of ${b.revenue?.streams.length ? b.revenue.streams.map(label).join(" + ") : "no sales stream chosen"} (sales less VAT and service charge) at ${b.revenue?.branches === "home" ? "the person's home branch" : "all branches"}`
    : `${b.bahtPerUnit ?? "?"} baht per ${b.unit?.described ?? "unit"}, counted ${b.unit?.counted === "per-person" ? "for this person" : "for the team"} as "${b.unit?.inputKey ?? "?"}"`;
  const gate = b.threshold !== null ? `; only when those sales exceed ${b.threshold.toLocaleString("en-US")}` : "";
  const cap = b.cap !== null ? `; at most ${b.cap.toLocaleString("en-US")} a month` : "";
  const share = b.sharing === "team" ? `; shared by ${b.team ?? "an unnamed team"}${b.split ? ` (${b.split === "days-worked" ? "by days worked" : "equally"})` : " (how is not said)"}` : "; the person's own";
  return `${what}${gate}${cap}${share}.`;
}

function PartRow({ part, data }: { part: ClausePart; data: ClauseReadingsView }) {
  const badge = part.type === "bonus" ? <Badge>Bonus</Badge>
    : part.type === "not-a-bonus" ? <Badge variant="outline" className="border-orange-500/50 text-orange-800 dark:text-orange-300">Not a bonus · {NOT_BONUS_LABEL[part.notBonusKind ?? "other"]}</Badge>
    : <Badge variant="destructive">Needs a person</Badge>;
  return <li className="space-y-0.5 px-3 py-2 text-sm" data-testid={`part-${part.type}`}>
    <div className="flex flex-wrap items-center gap-2">{badge}<span className="italic text-muted-foreground">“{part.quote}”</span></div>
    <p>{part.plainWords}</p>
    {part.type === "bonus" && part.bonus && <p className="text-xs text-muted-foreground">Payroll terms: {termsText(part.bonus, data)}</p>}
    {part.type === "not-a-bonus" && <p className="text-xs text-orange-800 dark:text-orange-300">Flagged for a person: never paid as a bonus by payroll.</p>}
    {part.type === "needs-a-person" && part.needsPersonWhy && <p className="text-xs text-destructive">{part.needsPersonWhy}</p>}
  </li>;
}

function PersonCard({ person, data, month }: { person: ClausePersonView; data: ClauseReadingsView; month: string }) {
  const [action, setAction] = useState<"read" | "approve" | "not" | null>(null);
  const [correcting, setCorrecting] = useState<ClauseReading | null>(null);
  const [from, setFrom] = useState(month);
  const [until, setUntil] = useState("");
  const reading = person.current;
  const waiting = reading?.status === "pending" ? reading : null;
  const decidedElsewhere = person.decided && person.decided.id !== reading?.id ? person.decided : null;
  const questions = [...(reading?.reading.questions ?? []), ...(person.teamRateQuestion ? [person.teamRateQuestion] : [])];
  const blank: ClauseReading = { summary: "", questions: [], parts: [{ type: "needs-a-person", quote: person.clauseText, plainWords: "", notBonusKind: null, needsPersonWhy: "", bonus: null }] };
  return <Card className="border-border shadow-sm" data-testid={`clause-${person.employeeId}`}>
    <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0 border-b border-border/70 pb-3">
      <div className="space-y-1">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {(person.state !== "not-incentive") && <ClauseMark title="Incentive read from a contract clause" />}
          <span data-testid="clause-person-name">{person.name}</span>
          {person.jobTitle && <span className="text-sm font-normal text-muted-foreground">{person.jobTitle}</span>}
        </CardTitle>
        <div className="flex flex-wrap gap-1.5"><StateBadge state={person.state} />
          {!person.hasProfile && <Badge variant="secondary">No payroll profile: cannot be paid</Badge>}
          {person.employeeStatus && person.employeeStatus !== "active" && <Badge variant="secondary">{person.employeeStatus}</Badge>}</div>
      </div>
      {data.canManage && <div className="flex flex-wrap gap-2">
        {data.aiConfigured && <Button size="sm" variant="outline" onClick={() => setAction("read")} data-testid="button-read"><Bot className="mr-1.5 h-4 w-4" />{reading ? "Read again" : "Read with AI"}</Button>}
        <Button size="sm" variant="outline" onClick={() => setCorrecting(structuredClone(reading?.reading ?? blank))} data-testid="button-correct"><PenLine className="mr-1.5 h-4 w-4" />Correct</Button>
        {waiting && <Button size="sm" onClick={() => { setFrom(month); setUntil(""); setAction("approve"); }} disabled={!person.hasProfile} data-testid="button-approve"><CheckCircle2 className="mr-1.5 h-4 w-4" />Approve</Button>}
        {waiting && <Button size="sm" variant="outline" onClick={() => { setFrom(month); setAction("not"); }} data-testid="button-not-incentive"><XCircle className="mr-1.5 h-4 w-4" />Not an incentive</Button>}
      </div>}
    </CardHeader>
    <CardContent className="space-y-3 pt-4">
      <div><p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">The clause as written</p>
        <blockquote className="mt-1 rounded-md border-l-4 border-orange-400 bg-muted/40 px-3 py-2 text-sm" data-testid="clause-text">{person.clauseText}</blockquote></div>
      {decidedElsewhere && <div className="rounded-lg border border-orange-500/40 bg-orange-500/10 p-3 text-sm" data-testid="clause-changed">
        <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" />
          {decidedElsewhere.clauseHash !== person.clauseHash ? "The clause changed after its reading was decided." : "A new reading waits for a person."} Payroll keeps paying the {decidedElsewhere.status === "approved" ? "approved" : "decided"} reading until a person decides a new one.</p>
        <p className="mt-1 text-xs">Decided {decidedElsewhere.decided ? `by ${decidedElsewhere.decided.who} on ${new Date(decidedElsewhere.decided.at).toLocaleDateString("en-GB")}` : ""}{decidedElsewhere.effectiveFrom ? `, paid from ${decidedElsewhere.effectiveFrom}${decidedElsewhere.effectiveTo ? ` to ${decidedElsewhere.effectiveTo}` : ""}` : ""}: {decidedElsewhere.reading.summary}</p>
        {decidedElsewhere.clauseHash !== person.clauseHash && <p className="mt-1 text-xs italic">It was read from: “{decidedElsewhere.clauseText}”</p>}
      </div>}
      {!reading ? <Empty>Not read yet. {data.aiConfigured ? "Read it with AI, or write the reading with Correct." : "Write the reading with Correct."}</Empty> : <>
        <div><p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          The reading{reading.source === "person" ? ", corrected by a person" : ", by the AI"} · {reading.status === "pending" ? "waiting for approval: not paid yet" : reading.status === "approved" ? `approved${reading.effectiveFrom ? `, paid from ${reading.effectiveFrom}${reading.effectiveTo ? ` to ${reading.effectiveTo}` : ""}` : ""}` : "not an incentive: nothing paid"}</p>
          <p className="mt-1 text-sm font-medium" data-testid="reading-summary">{reading.reading.summary}</p></div>
        <ul className="divide-y rounded-lg border">{reading.reading.parts.map((part, i) => <PartRow key={i} part={part} data={data} />)}</ul>
        {questions.length > 0 && <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3" data-testid="reading-questions">
          <p className="flex items-center gap-2 text-sm font-semibold"><CircleDashed className="h-4 w-4" />Questions for a person</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-6 text-sm">{questions.map((q) => <li key={q}>{q}</li>)}</ul></div>}
        {reading.status !== "not-incentive" && <Example readingId={reading.id} month={month} />}
        {reading.decided && <p className="text-xs text-muted-foreground">{reading.status === "approved" ? "Approved" : "Decided"} by {reading.decided.who} · {reading.decided.reason}</p>}
      </>}
    </CardContent>
    {action === "read" && <ReasonDialog open onOpenChange={(o) => !o && setAction(null)} title={`Read ${person.name}'s clause with AI`} confirmLabel="Read"
      description="The AI says the clause in payroll's own terms and lists what a person must confirm. The reading waits for approval; nothing is paid from it."
      onConfirm={async (reason) => { await payrollCall("POST", `/api/payroll/setup/rewards/clauses/${person.employeeId}/read`, { reason }); await refreshPayroll(); }} />}
    {action === "approve" && waiting && <ReasonDialog open onOpenChange={(o) => !o && setAction(null)} title={`Approve the reading of ${person.name}'s clause`} confirmLabel="Approve"
      description={`Each bonus part becomes a dated incentive rule for ${person.name} (a team pool is joined, not copied). The payroll engine then calculates it every month; parts that are not bonuses are not paid.${questions.length ? " Approving accepts the reading with the questions above still open." : ""}`}
      onConfirm={async (reason) => {
        await payrollCall("POST", `/api/payroll/setup/rewards/clause-readings/${waiting.id}/approve`, { from, until: until || null, reason }); await refreshPayroll();
      }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="First month paid" hint="A locked month cannot be chosen."><Input type="month" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} data-testid="input-approve-from" /></Field>
        <Field label="Last day paid (optional)" hint="Empty: until a person decides otherwise."><Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} data-testid="input-approve-until" /></Field>
      </div>
      <ul className="list-disc pl-5 text-xs">{waiting.reading.parts.filter((p) => p.type === "bonus").map((p, i) => <li key={i}>{p.plainWords}</li>)}</ul>
    </ReasonDialog>}
    {action === "not" && waiting && <ReasonDialog open onOpenChange={(o) => !o && setAction(null)} title={`${person.name}'s clause is not an incentive`} confirmLabel="Not an incentive"
      description="Payroll pays nothing from this clause. A reading this person had approved stops being paid from the month you choose."
      onConfirm={async (reason) => { await payrollCall("POST", `/api/payroll/setup/rewards/clause-readings/${waiting.id}/not-incentive`, { from, reason }); await refreshPayroll(); }}>
      <Field label="From month"><Input type="month" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></Field>
    </ReasonDialog>}
    {correcting && <CorrectDialog person={person} data={data} draft={correcting} onDraft={setCorrecting} onClose={() => setCorrecting(null)} />}
  </Card>;
}

/** The worked example: the payroll engine's own calculation of the reading on the month's saved figures. */
function Example({ readingId, month }: { readingId: string; month: string }) {
  const example = useClauseExample(readingId, month);
  return <div className="rounded-lg border bg-muted/20 p-3 text-sm" data-testid="worked-example">
    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Worked example · calculated by the payroll engine on {monthLabel(month)}'s saved figures</p>
    {example.isLoading && <Skeleton className="mt-2 h-10 w-full" />}
    {example.error != null && <p className="mt-1 text-destructive">{errorText(example.error)}</p>}
    {example.data && <>
      {example.data.lines.length > 0 && <ul className="mt-1 divide-y">{example.data.lines.map((l, i) => <li key={i} className="flex flex-wrap items-start gap-2 py-1.5">
        <span className="min-w-[12rem] flex-1"><span className="font-medium">{l.ruleName}</span>{l.joined && <Badge variant="outline" className="ml-1">team pool</Badge>}{!l.targetMet && <Badge variant="secondary" className="ml-1">threshold not passed</Badge>}
          <span className="block text-xs text-muted-foreground">{l.formula}</span></span>
        <span className="w-28 text-right font-semibold tabular-nums">{money(l.amount)}</span></li>)}</ul>}
      {example.data.lines.length > 0 && <p className="mt-1 flex justify-between border-t pt-1 font-semibold"><span>Would be paid for {monthLabel(month)}</span><span className="tabular-nums" data-testid="example-total">{money(example.data.total)}</span></p>}
      {example.data.inputs.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Typed each month: {example.data.inputs.join("; ")}.</p>}
      {example.data.problems.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-amber-800 dark:text-amber-300">{example.data.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      {!example.data.lines.length && !example.data.problems.length && <p className="mt-1 text-muted-foreground">Nothing to pay from this reading.</p>}
    </>}
  </div>;
}

const emptyBonus = (): ClauseBonusTerms => ({ basis: "percent-of-revenue", percent: null, bahtPerUnit: null, revenue: { described: "", streams: [], branches: "all" },
  unit: null, threshold: null, cap: null, sharing: "own", team: null, split: null, joinPool: null });
const nullable = (n: number) => Number.isFinite(n) ? n : null;

/** A person's own reading: every part, its type and its payroll terms. */
function CorrectDialog({ person, data, draft, onDraft, onClose }: { person: ClausePersonView; data: ClauseReadingsView; draft: ClauseReading; onDraft: (r: ClauseReading) => void; onClose: () => void }) {
  const setPart = (i: number, part: ClausePart) => onDraft({ ...draft, parts: draft.parts.map((p, j) => j === i ? part : p) });
  const setBonus = (i: number, change: Partial<ClauseBonusTerms>) => { const p = draft.parts[i]; setPart(i, { ...p, bonus: { ...(p.bonus ?? emptyBonus()), ...change } }); };
  const [questions, setQuestions] = useState(() => draft.questions.join("\n"));
  return <ReasonDialog open onOpenChange={(o) => !o && onClose()} title={`Correct the reading of ${person.name}'s clause`} confirmLabel="Save the corrected reading"
    description="Your reading replaces the AI's and waits for approval like any reading. Payroll's own checks still run on it."
    onConfirm={async (reason) => { await payrollCall("POST", `/api/payroll/setup/rewards/clauses/${person.employeeId}/correct`, { reading: draft, reason }); await refreshPayroll(); }}>
    <p className="rounded-md bg-muted/40 px-2 py-1 text-xs italic">“{person.clauseText}”</p>
    <Field label="What the clause pays, in plain words"><Textarea value={draft.summary} onChange={(e) => onDraft({ ...draft, summary: e.target.value })} data-testid="input-correct-summary" /></Field>
    {draft.parts.map((part, i) => {
      const b = part.bonus ?? emptyBonus();
      return <div key={i} className="space-y-2 rounded-lg border p-2" data-testid={`correct-part-${i}`}>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={`Part ${i + 1}`}><select className={selectClass} value={part.type} data-testid={`select-part-type-${i}`} onChange={(e) => {
            const type = e.target.value as ClausePart["type"];
            setPart(i, { ...part, type, bonus: type === "bonus" ? part.bonus ?? emptyBonus() : null, notBonusKind: type === "not-a-bonus" ? part.notBonusKind ?? "other" : null, needsPersonWhy: type === "needs-a-person" ? part.needsPersonWhy ?? "" : null });
          }}><option value="bonus">Bonus payroll pays</option><option value="not-a-bonus">Not a bonus</option><option value="needs-a-person">Needs a person</option></select></Field>
          <Field label="The clause's words"><Input value={part.quote} onChange={(e) => setPart(i, { ...part, quote: e.target.value })} /></Field>
        </div>
        <Field label="In plain words"><Input value={part.plainWords} onChange={(e) => setPart(i, { ...part, plainWords: e.target.value })} /></Field>
        {part.type === "not-a-bonus" && <Field label="Kind"><select className={selectClass} value={part.notBonusKind ?? "other"} onChange={(e) => setPart(i, { ...part, notBonusKind: e.target.value as ClausePart["notBonusKind"] })}>
          {NOT_BONUS_KINDS.map((k) => <option key={k} value={k}>{NOT_BONUS_LABEL[k]}</option>)}</select></Field>}
        {part.type === "needs-a-person" && <Field label="Why"><Input value={part.needsPersonWhy ?? ""} onChange={(e) => setPart(i, { ...part, needsPersonWhy: e.target.value })} /></Field>}
        {part.type === "bonus" && <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Join an approved team pool"><select className={selectClass} value={b.joinPool ?? ""} data-testid={`select-join-pool-${i}`} onChange={(e) => setBonus(i, { joinPool: e.target.value || null })}>
            <option value="">No: its own terms below</option>{data.pools.map((p) => <option key={p.ruleId} value={p.ruleId}>{p.name}</option>)}</select></Field>
          {!b.joinPool && <>
            <Field label="Based on"><select className={selectClass} value={b.basis} data-testid={`select-basis-${i}`} onChange={(e) => setBonus(i, e.target.value === "baht-per-unit"
              ? { basis: "baht-per-unit", revenue: null, percent: null, unit: b.unit ?? { described: "", inputKey: "", counted: "team-total" } }
              : { basis: "percent-of-revenue", unit: null, bahtPerUnit: null, revenue: b.revenue ?? { described: "", streams: [], branches: "all" } })}>
              <option value="percent-of-revenue">A percent of sales</option><option value="baht-per-unit">Baht per counted unit</option></select></Field>
            {b.basis === "percent-of-revenue" ? <Field label="Percent"><NumberInput label="Percent" value={b.percent} onChange={(n) => setBonus(i, { percent: nullable(n) })} /></Field>
              : <Field label="Baht per unit"><NumberInput label="Baht per unit" value={b.bahtPerUnit} onChange={(n) => setBonus(i, { bahtPerUnit: nullable(n) })} /></Field>}
            {b.basis === "percent-of-revenue" && <>
              <Field label="Sales described as"><Input value={b.revenue?.described ?? ""} onChange={(e) => setBonus(i, { revenue: { ...(b.revenue ?? { streams: [], branches: "all" }), described: e.target.value } })} /></Field>
              <Field label="At"><select className={selectClass} value={b.revenue?.branches ?? "all"} onChange={(e) => setBonus(i, { revenue: { ...(b.revenue ?? { described: "", streams: [] }), branches: e.target.value as "all" } })}>
                <option value="all">All branches</option><option value="home">The person's home branch</option></select></Field>
              <div className="sm:col-span-3"><Field label="Sales streams">
                <div className="flex flex-wrap gap-2">{data.streams.map((s) => <label key={s.key} className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
                  <input type="checkbox" checked={b.revenue?.streams.includes(s.key) ?? false} onChange={() => {
                    const list = b.revenue?.streams ?? [];
                    setBonus(i, { revenue: { ...(b.revenue ?? { described: "", branches: "all" }), streams: list.includes(s.key) ? list.filter((k) => k !== s.key) : [...list, s.key] } });
                  }} />{s.label}</label>)}</div></Field></div>
            </>}
            {b.basis === "baht-per-unit" && <>
              <Field label="Unit described as"><Input value={b.unit?.described ?? ""} onChange={(e) => setBonus(i, { unit: { ...(b.unit ?? { inputKey: "", counted: "team-total" }), described: e.target.value } })} /></Field>
              <Field label="Monthly count name" hint="Letters, digits and dashes."><Input value={b.unit?.inputKey ?? ""} onChange={(e) => setBonus(i, { unit: { ...(b.unit ?? { described: "", counted: "team-total" }), inputKey: e.target.value } })} /></Field>
              <Field label="Counted"><select className={selectClass} value={b.unit?.counted ?? "team-total"} onChange={(e) => setBonus(i, { unit: { ...(b.unit ?? { described: "", inputKey: "" }), counted: e.target.value as "team-total" } })}>
                <option value="team-total">For the team (one count)</option><option value="per-person">For this person</option></select></Field>
            </>}
            <Field label="Only when sales exceed (optional)"><NumberInput label="Threshold" value={b.threshold} onChange={(n) => setBonus(i, { threshold: nullable(n) })} /></Field>
            <Field label="At most a month (optional)"><NumberInput label="Cap" value={b.cap} onChange={(n) => setBonus(i, { cap: nullable(n) })} /></Field>
            <Field label="Who earns it"><select className={selectClass} value={b.sharing} data-testid={`select-sharing-${i}`} onChange={(e) => setBonus(i, { sharing: e.target.value as "own" })}>
              <option value="own">This person alone</option><option value="team">A team shares one pool</option></select></Field>
            {b.sharing === "team" && <>
              <Field label="Team"><Input value={b.team ?? ""} onChange={(e) => setBonus(i, { team: e.target.value || null })} data-testid={`input-team-${i}`} /></Field>
              <Field label="Shared"><select className={selectClass} value={b.split ?? ""} data-testid={`select-split-${i}`} onChange={(e) => setBonus(i, { split: (e.target.value || null) as "equal" | null })}>
                <option value="">Not said</option><option value="days-worked">By days worked</option><option value="equal">Equally</option></select></Field>
            </>}
          </>}
        </div>}
        <div className="flex justify-end"><Button type="button" size="sm" variant="ghost" disabled={draft.parts.length < 2} onClick={() => onDraft({ ...draft, parts: draft.parts.filter((_, j) => j !== i) })}>Remove this part</Button></div>
      </div>;
    })}
    <Button type="button" size="sm" variant="outline" onClick={() => onDraft({ ...draft, parts: [...draft.parts, { type: "bonus", quote: "", plainWords: "", notBonusKind: null, needsPersonWhy: null, bonus: emptyBonus() }] })}>Add a part</Button>
    <Field label="Questions still open (one a line)"><Textarea value={questions} onChange={(e) => { setQuestions(e.target.value); onDraft({ ...draft, questions: e.target.value.split("\n").map((q) => q.trim()).filter(Boolean) }); }} /></Field>
  </ReasonDialog>;
}
