import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, ChevronDown, ExternalLink, FileVideo, ImagePlus, Loader2, MessageSquarePlus, Paperclip, Plus, RefreshCw, Send, X } from "lucide-react";
import { useLocation } from "wouter";
import type { QaContext, QaReport, QaReportDetail } from "@shared/qa-reports";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/use-auth";
import { useBranchContext } from "@/hooks/use-branch-context";
import { apiRequest } from "@/lib/queryClient";
import { getQaLaunchContext, qaReporterScope, useQaConfig } from "@/components/qa-report-launcher";

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm"];
const STATUS_LABELS: Record<QaReport["status"], string> = {
  draft: "Draft saved", queued: "Waiting for review", processing: "Reviewing", complete: "Review ready", retrying: "Retrying", needs_configuration: "Waiting for setup",
};
const ASSESSMENT_LABELS: Record<QaReport["assessment"], string> = {
  reported: "Reported · not yet assessed", code_supported: "Supported by the code review", guidance: "Usage guidance", needs_investigation: "Needs investigation", related_report: "Related report found",
};
type PendingFile = { id: string; file: File; preview?: string; state: "ready" | "uploading" | "failed"; error?: string };
type Submission = { message: string; clientRequestId: string; reportId: string | null; context: QaContext };
const pending = (report?: QaReport) => !!report && ["draft", "queued", "processing", "retrying"].includes(report.status);
const readableDate = (value: string) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const fileSize = (size: number) => size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;

function jiraLink(value: string | null) {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" ? url.href : undefined; } catch { return undefined; }
}

export default function QaReportsPage() {
  const { user } = useAuth();
  return <QaReportConversation key={qaReporterScope(user)} />;
}

function QaReportConversation() {
  const { user } = useAuth();
  const { activeBranchId } = useBranchContext();
  const [, navigate] = useLocation();
  const cache = useQueryClient();
  const config = useQaConfig();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState("");
  const [uploadNotice, setUploadNotice] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const submission = useRef<Submission | null>(null);
  const operationLock = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const previews = useRef(new Set<string>());
  const threadEnd = useRef<HTMLDivElement>(null);
  const scope = qaReporterScope(user);
  const listKey = ["qa-report-history", scope];
  const detailKey = ["qa-report-detail", scope, selectedId];
  const enabled = !!user && config.data?.enabled === true;
  const reports = useQuery<{ reports: QaReport[] }>({
    queryKey: listKey,
    queryFn: async () => (await apiRequest("GET", "/api/qa-reports")).json(),
    enabled,
    refetchInterval: query => query.state.data?.reports.some(pending) ? 3_000 : false,
  });
  const detail = useQuery<QaReportDetail>({
    queryKey: detailKey,
    queryFn: async () => (await apiRequest("GET", `/api/qa-reports/${selectedId}`)).json(),
    enabled: enabled && !!selectedId,
    refetchInterval: query => pending(query.state.data?.report) ? 3_000 : false,
  });
  const report = detail.data?.report;
  const sourceContext: QaContext = getQaLaunchContext(scope) ?? {
    path: "/qa-reports", ...(activeBranchId ? { branchId: activeBranchId } : {}),
    browser: navigator.userAgent.slice(0, 300), viewport: { width: window.innerWidth, height: window.innerHeight },
    locale: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };

  useEffect(() => () => { for (const url of previews.current) URL.revokeObjectURL(url); }, []);
  useEffect(() => { threadEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [detail.data?.messages.length]);

  function updateDetail(value: QaReportDetail) {
    cache.setQueryData(["qa-report-detail", scope, value.report.id], value);
    void cache.invalidateQueries({ queryKey: listKey });
  }
  function discardFile(id: string) {
    setFiles(current => current.filter(item => {
      if (item.id !== id) return true;
      if (item.preview) { URL.revokeObjectURL(item.preview); previews.current.delete(item.preview); }
      return false;
    }));
  }
  function addFiles(incoming: File[]) {
    if (busy || submission.current) return;
    const accepted: PendingFile[] = [];
    let refused = false;
    for (const file of incoming) {
      if (!ACCEPTED_TYPES.includes(file.type) || file.size > MAX_FILE_SIZE || file.size === 0) { refused = true; continue; }
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      if (preview) previews.current.add(preview);
      accepted.push({ id: crypto.randomUUID(), file, preview, state: "ready" });
    }
    setFiles(current => [...current, ...accepted]);
    setError(refused ? "Use a PNG, JPEG, WebP, MP4 or WebM file, up to 25 MB each." : "");
  }
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const images = Array.from(event.clipboardData.files).filter(file => file.type.startsWith("image/"));
    if (images.length) { event.preventDefault(); addFiles(images); }
  }
  async function upload(reportId: string, item: PendingFile) {
    setFiles(current => current.map(file => file.id === item.id ? { ...file, state: "uploading", error: undefined } : file));
    const body = new FormData(); body.append("file", item.file);
    try {
      const response = await fetch(`/api/qa-reports/${reportId}/attachments`, { method: "POST", credentials: "include", headers: { "X-QA-Attachment-Id": item.id }, body });
      if (!response.ok) throw new Error("Upload unavailable");
      discardFile(item.id);
      return true;
    } catch {
      setFiles(current => current.map(file => file.id === item.id ? { ...file, state: "failed", error: "Not confirmed uploaded. You can retry this file." } : file));
      return false;
    }
  }
  async function analyze(reportId: string) {
    setPhase("Requesting review…");
    updateDetail(await (await apiRequest("POST", `/api/qa-reports/${reportId}/analyze`, {})).json());
  }
  async function send() {
    if (operationLock.current || (!message.trim() && !submission.current)) return;
    operationLock.current = true; setBusy(true); setError(""); setUploadNotice("");
    submission.current ??= { message: message.trim(), clientRequestId: crypto.randomUUID(), reportId: selectedId, context: sourceContext };
    const request = submission.current;
    try {
      setPhase("Saving your message…");
      const url = request.reportId ? `/api/qa-reports/${request.reportId}/messages` : "/api/qa-reports";
      const saved: QaReportDetail = await (await apiRequest("POST", url, request.reportId ? { message: request.message, clientRequestId: request.clientRequestId } : { message: request.message, clientRequestId: request.clientRequestId, context: request.context })).json();
      updateDetail(saved); setSelectedId(saved.report.id); submission.current = null; setMessage("");
      let missing = false;
      for (const file of files.filter(item => item.state !== "failed")) {
        setPhase("Uploading evidence…");
        if (!await upload(saved.report.id, file)) missing = true;
      }
      if (missing) {
        setUploadNotice("Your message is saved. Some evidence could not be uploaded; review will continue with the available information.");
        try {
          await apiRequest("POST", `/api/qa-reports/${saved.report.id}/messages`, { message: "Some supporting attachments could not be confirmed uploaded. Please assess the available evidence; I can retry the missing files.", clientRequestId: crypto.randomUUID() });
        } catch { /* The visible notice remains; the saved report can still be queued. */ }
      }
      await analyze(saved.report.id);
    } catch {
      setError(submission.current ? "We could not confirm your message was saved. Retry sends the same message safely." : "Your report is saved, but review could not be started. Retry review below.");
    } finally { operationLock.current = false; setBusy(false); setPhase(""); }
  }
  async function retryReview(file?: PendingFile) {
    if (!selectedId || operationLock.current) return;
    operationLock.current = true; setBusy(true); setError("");
    try {
      if (file && !await upload(selectedId, file)) { setError("That upload is still unavailable. Your saved report remains here."); return; }
      await analyze(selectedId);
      await detail.refetch();
    } catch { setError("Review is unavailable right now. Your report is saved; you can retry here."); }
    finally { operationLock.current = false; setBusy(false); setPhase(""); }
  }
  function selectReport(id: string | null) {
    if (busy || submission.current) return;
    if ((message.trim() || files.length) && !window.confirm("Leave this unsent message and its selected files?")) return;
    for (const file of files) if (file.preview) { URL.revokeObjectURL(file.preview); previews.current.delete(file.preview); }
    setFiles([]); setMessage(""); setError(""); setUploadNotice(""); setSelectedId(id); setHistoryOpen(false);
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground" data-testid="qa-report-page">
      <header className="border-b bg-card px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Button variant="ghost" size="icon" aria-label="Back to the app" data-testid="qa-report-back" onClick={() => navigate(getQaLaunchContext(scope)?.path ?? "/core")}><ArrowLeft className="h-5 w-5" /></Button>
            <div><h1 className="text-lg font-semibold sm:text-xl">Report an issue</h1><p className="text-xs text-muted-foreground sm:text-sm">Describe it once. Keep the evidence and follow-up together.</p></div>
          </div>
          {enabled && <Button variant="outline" size="sm" onClick={() => selectReport(null)} disabled={busy || !!submission.current} data-testid="qa-report-new"><Plus className="mr-1 h-4 w-4" />New report</Button>}
        </div>
      </header>
      {config.isLoading ? <div className="p-12 text-center" role="status"><Loader2 className="mx-auto h-6 w-6 animate-spin" />Loading reporting…</div> : !enabled ? (
        <div className="mx-auto max-w-lg p-8 text-center" data-testid="qa-report-unavailable"><MessageSquarePlus className="mx-auto mb-4 h-10 w-10 text-muted-foreground" /><h2 className="text-lg font-semibold">Reporting is not available right now</h2><p className="mt-2 text-sm text-muted-foreground">Return to the app and try again later.</p>{config.isError && <Button variant="outline" className="mt-4" onClick={() => void config.refetch()}>Try again</Button>}</div>
      ) : (
        <div className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-1 gap-5 p-4 sm:p-6 lg:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="min-w-0 rounded-xl border bg-card p-3 lg:self-start">
            <button className="flex w-full items-center justify-between p-2 text-sm font-semibold lg:pointer-events-none" onClick={() => setHistoryOpen(!historyOpen)} aria-expanded={historyOpen} data-testid="qa-report-history-toggle">Your reports <ChevronDown className="h-4 w-4 lg:hidden" /></button>
            <div className={`${historyOpen ? "block" : "hidden"} mt-2 space-y-1 lg:block`} data-testid="qa-report-history">
              {reports.isLoading && <p className="p-2 text-sm text-muted-foreground">Loading reports…</p>}
              {reports.isError && <div className="p-2 text-sm"><p>Could not load your reports.</p><Button variant="ghost" size="sm" onClick={() => void reports.refetch()}>Retry</Button></div>}
              {reports.data?.reports.length === 0 && <p className="p-2 text-sm text-muted-foreground">Your saved conversations will appear here.</p>}
              {reports.data?.reports.map(item => <button key={item.id} disabled={busy || !!submission.current} onClick={() => selectReport(item.id)} className={`w-full rounded-lg p-3 text-left transition-colors ${selectedId === item.id ? "bg-primary/10 ring-1 ring-primary/20" : "hover:bg-muted"}`} data-testid={`qa-report-history-${item.id}`} aria-current={selectedId === item.id ? "true" : undefined}><span className="block truncate text-sm font-medium">{item.title || "Untitled report"}</span><span className="mt-1 block text-xs text-muted-foreground">{STATUS_LABELS[item.status]} · {readableDate(item.updatedAt)}</span>{item.jiraKey && <span className="mt-1 block text-xs text-primary">{item.jiraKey}</span>}</button>)}
            </div>
          </aside>
          <section className="flex min-w-0 flex-col gap-4">
            {selectedId && detail.isLoading && <div className="rounded-xl border p-8 text-center" role="status">Loading conversation…</div>}
            {detail.isError && <div className="rounded-xl border p-4" role="alert">Could not load this conversation. <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>Try again</Button></div>}
            {report && <div className="rounded-xl border bg-card p-4" data-testid="qa-report-status"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="min-w-0 break-words font-semibold">{report.title || "Your report"}</h2><Badge variant="secondary">{STATUS_LABELS[report.status]}</Badge></div><p className="mt-2 text-sm font-medium" data-testid="qa-report-assessment">{ASSESSMENT_LABELS[report.assessment]}</p><p className="mt-1 text-xs text-muted-foreground">This is an assessment of the report and available evidence. It does not mean the issue has been reproduced or fixed.</p>{pending(report) && <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" />You can leave this page; your report is saved and will update here.</p>}{report.lastError && <p className="mt-3 text-sm text-destructive" role="alert">{report.lastError}</p>}<div className="mt-3 flex flex-wrap items-center gap-3">{jiraLink(report.jiraUrl) ? <a href={jiraLink(report.jiraUrl)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-primary underline underline-offset-4" data-testid="qa-report-jira-link">{report.jiraKey || "Open Jira report"}<ExternalLink className="h-3.5 w-3.5" /></a> : <span className="text-xs text-muted-foreground">Jira tracking will appear here when available.</span>}<Button size="sm" variant="outline" disabled={busy || report.status === "processing" || !!submission.current} onClick={() => void retryReview()} data-testid="qa-report-retry"><RefreshCw className="mr-2 h-3.5 w-3.5" />Retry review</Button></div></div>}
            <div className="min-h-[220px] flex-1 space-y-4 rounded-xl border bg-card p-4 sm:p-6" data-testid="qa-report-conversation">
              {!selectedId && <div className="py-5"><div className="mb-4 inline-flex rounded-xl bg-primary/10 p-3 text-primary"><MessageSquarePlus className="h-6 w-6" /></div><h2 className="text-xl font-semibold">What happened?</h2><p className="mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">Tell us what you were trying to do, what you expected, and what happened instead. Add a screenshot or a short video if it helps.</p><div className="mt-5 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3"><span>1. Describe the issue</span><span>2. Add evidence</span><span>3. Review and follow up</span></div></div>}
              {detail.data?.messages.map(item => <article key={item.id} className={`max-w-full rounded-xl p-4 ${item.role === "user" ? "ml-4 bg-primary/10 sm:ml-12" : "mr-4 border bg-background sm:mr-12"}`} data-testid={`qa-report-message-${item.role}`}><div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span className="font-medium">{item.role === "user" ? "You" : "Report assistant"}</span><time dateTime={item.createdAt}>{readableDate(item.createdAt)}</time></div><p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{item.content}</p></article>)}
              {!!detail.data?.attachments.length && <div className="border-t pt-4"><h3 className="mb-2 text-xs font-medium text-muted-foreground">Saved evidence</h3><div className="flex flex-wrap gap-2">{detail.data.attachments.map(item => <a key={item.id} href={`/api/qa-reports/${selectedId}/attachments/${item.id}`} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-muted" data-testid="qa-report-saved-attachment"><Paperclip className="h-4 w-4 shrink-0" /><span className="truncate">{item.name}</span><span className="shrink-0 text-xs text-muted-foreground">{fileSize(item.size)}</span></a>)}</div></div>}
              <div ref={threadEnd} />
            </div>
            <div className="rounded-xl border bg-card p-4" data-testid="qa-report-composer">
              <label htmlFor="qa-report-message" className="mb-2 block text-sm font-medium">{selectedId ? "Add details or ask a follow-up" : "Describe the issue"}</label>
              <Textarea id="qa-report-message" data-testid="qa-report-message-input" value={message} onChange={event => setMessage(event.target.value)} onPaste={paste} disabled={busy || !!submission.current || (!!selectedId && !report)} maxLength={12_000} rows={4} placeholder="I was trying to… I expected… Instead…" className="resize-y" />
              {!!files.length && <div className="mt-3 space-y-2" data-testid="qa-report-selected-files">{files.map(item => <div key={item.id} className="flex min-w-0 items-center gap-3 rounded-lg border p-2">{item.preview ? <img src={item.preview} alt="Selected screenshot preview" className="h-12 w-16 shrink-0 rounded object-cover" /> : <FileVideo className="h-8 w-8 shrink-0 text-muted-foreground" />}<div className="min-w-0 flex-1"><p className="truncate text-sm">{item.file.name}</p><p className="text-xs text-muted-foreground">{fileSize(item.file.size)}{item.state === "uploading" ? " · Uploading…" : ""}</p>{item.error && <p className="text-xs text-destructive">{item.error}</p>}</div>{item.state === "failed" && selectedId && <Button size="sm" variant="outline" disabled={busy || !!submission.current} onClick={() => void retryReview(item)} data-testid="qa-report-retry-upload">Retry</Button>}<Button variant="ghost" size="icon" aria-label={`Remove ${item.file.name}`} disabled={busy || !!submission.current} onClick={() => discardFile(item.id)}><X className="h-4 w-4" /></Button></div>)}</div>}
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Paste a screenshot, or attach images and short videos up to 25 MB each. Hide passwords, codes and personal information before uploading.</p>
              <p className="mt-1 text-xs text-muted-foreground" data-testid="qa-report-video-note">Video review samples the first 40 seconds; audio is not transcribed. Describe the issue in chat.</p>
              {uploadNotice && <p className="mt-3 text-sm text-muted-foreground" role="status">{uploadNotice}</p>}
              {error && <p className="mt-3 text-sm text-destructive" role="alert" data-testid="qa-report-error">{error}</p>}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><input ref={fileInput} type="file" className="hidden" accept={ACCEPTED_TYPES.join(",")} multiple onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} data-testid="qa-report-file-input" /><Button variant="outline" disabled={busy || !!submission.current} onClick={() => fileInput.current?.click()} data-testid="qa-report-attach"><ImagePlus className="mr-2 h-4 w-4" />Attach evidence</Button><Button disabled={busy || (!message.trim() && !submission.current) || (!!selectedId && !report)} onClick={() => void send()} data-testid="qa-report-send">{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : submission.current ? <RefreshCw className="mr-2 h-4 w-4" /> : <Send className="mr-2 h-4 w-4" />}{busy ? phase || "Saving…" : submission.current ? "Retry message" : selectedId ? "Send follow-up" : "Send report"}</Button></div>
              <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground"><CheckCircle2 className="h-3.5 w-3.5 shrink-0" />{selectedId ? "Follow-ups stay in this report." : "The current app page and selected branch are included."}</p>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
