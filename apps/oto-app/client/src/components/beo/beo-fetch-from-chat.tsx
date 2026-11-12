import { useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  applyFetchChanges,
  CATALOGUE_CHANGES_LINE,
  catalogueChangesCount,
  changeKey,
  changesCount,
  fetchCatalogueChangesOf,
  fetchChangesOf,
  nothingNewLine,
  offeredChanges,
  rememberDeclined,
  type DeclinedChanges,
  type FetchAnswer,
  type FetchCatalogueChange,
  type FetchChange,
  type FetchFormValues,
} from "@/lib/beo-fetch-from-chat";
import { ChatSays, SourceMark } from "./beo-ai-review";

/**
 * "FETCH FROM CHAT" ON THE BEO FORM (SCRUM-826).
 *
 * The button in the form's header reads the conversation again, as it is
 * now, and brings its changes here: first a warning (this may change typed
 * details), then the read, then the list — the field, what the form holds
 * and what the chat says, whose line it was — each accepted or declined
 * (accept all, decline all). Apply puts the accepted ones in the form,
 * unsaved until the form's own Save; the declined ones are remembered by
 * FIELD, so that field is not offered again — whatever the chat reads for it
 * — until the chat has a new line; a row left undecided is neither. What the chat says of the package, the set menu, the
 * food and the entertainment is listed too, to read: those are chosen in
 * their own sections, never applied here. A fetch that finds nothing new
 * anywhere says so. The rules are `lib/beo-fetch-from-chat.ts`'s.
 * SCRUM-903: under each row, the chat's own words for it, whose line they are
 * and when (the review's reason line, `ChatSays`).
 */

export const FETCH_WARNING =
  "This reads the conversation again, as it is now, and may change details typed in this form. Every change is listed first: nothing is changed until you accept it, and what you accept is saved only when you press Save.";

type Step =
  | { kind: "warn" }
  | { kind: "reading" }
  | { kind: "error"; message: string }
  | { kind: "review"; changes: FetchChange[]; catalogue: FetchCatalogueChange[]; held: number; chatMark: string | null; timeZone?: string };
type Decision = "accept" | "decline";

export function BeoFetchFromChatDialog({
  open,
  onClose,
  form,
  read,
  declined,
  onDeclined,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  /** What the form holds, read when the answer is diffed (so typing while it reads still counts). */
  form: () => FetchFormValues;
  /** The conversation read again, as it is now. */
  read: () => Promise<FetchAnswer>;
  /** The changes declined on earlier fetches of this form. */
  declined: DeclinedChanges;
  onDeclined: (next: DeclinedChanges) => void;
  /** The accepted changes as a patch of the form: unsaved until Save, as any edit. */
  onApply: (patch: Partial<FetchFormValues>, accepted: FetchChange[]) => void;
}) {
  const { toast } = useToast();
  const [step, setStep] = useState<Step>({ kind: "warn" });
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  useEffect(() => {
    if (open) {
      setStep({ kind: "warn" });
      setDecisions({});
    }
  }, [open]);

  const fetchNow = async () => {
    setStep({ kind: "reading" });
    let answer: FetchAnswer;
    try {
      answer = await read();
    } catch (err: unknown) {
      const message = err instanceof Error && err.message ? err.message : "The conversation could not be read just now.";
      setStep({ kind: "error", message });
      return;
    }
    const now = form();
    const all = fetchChangesOf(answer, now);
    const { offered, held } = offeredChanges(all, declined, answer.chatMark);
    const catalogue = fetchCatalogueChangesOf(answer.review, answer.held, now);
    setDecisions({});
    setStep({ kind: "review", changes: offered, catalogue, held, chatMark: answer.chatMark, timeZone: answer.review?.timeZone });
  };

  const decideAll = (decision: Decision) => {
    if (step.kind !== "review") return;
    setDecisions(Object.fromEntries(step.changes.map((c) => [changeKey(c), decision])));
  };
  const apply = () => {
    if (step.kind !== "review") return;
    const accepted = step.changes.filter((c) => decisions[changeKey(c)] === "accept");
    const refused = step.changes.filter((c) => decisions[changeKey(c)] === "decline");
    if (accepted.length > 0) onApply(applyFetchChanges(accepted), accepted);
    // The memory: a declined field is held on this chat; an accepted one is let go of it.
    if (refused.length > 0 || accepted.length > 0) onDeclined(rememberDeclined(declined, step.chatMark, refused, accepted));
    toast({
      title: accepted.length > 0 ? `${accepted.length} change${accepted.length === 1 ? "" : "s"} taken from the chat` : "Nothing changed",
      description:
        accepted.length > 0
          ? "Save the BEO to keep them."
          : refused.length > 0
            ? "The declined changes are not offered again until the chat changes."
            : "No change was accepted.",
    });
    onClose();
  };

  const busy = step.kind === "reading";
  const accepted = step.kind === "review" ? step.changes.filter((c) => decisions[changeKey(c)] === "accept").length : 0;
  const nothingNew = step.kind === "review" && step.changes.length === 0 && step.catalogue.length === 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col" data-testid="dialog-fetch-from-chat">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-primary" />
            Fetch from chat
          </DialogTitle>
          <DialogDescription>
            {step.kind === "review" && step.changes.length > 0
              ? "What the chat says now, beside what this form holds. Accept what should change; a declined change is not offered again until the chat changes."
              : "The conversation this birthday was booked from, read again as it is now: the details typed in this form to accept or decline, and what the chat says of the package, menu and entertainment to read."}
          </DialogDescription>
        </DialogHeader>

        {step.kind === "warn" && (
          <div
            className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm text-amber-800 dark:text-amber-200"
            data-testid="text-fetch-warning"
          >
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{FETCH_WARNING}</span>
          </div>
        )}

        {step.kind === "reading" && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2" data-testid="text-fetch-reading">
            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
            Reading the whole conversation…
          </div>
        )}

        {step.kind === "error" && (
          <p className="text-sm text-destructive" data-testid="text-fetch-error">
            {step.message}
          </p>
        )}

        {nothingNew && (
          <p className="text-sm text-muted-foreground" data-testid="text-fetch-same">
            {nothingNewLine(step.kind === "review" ? step.held : 0)}
          </p>
        )}

        {step.kind === "review" && step.changes.length === 0 && step.catalogue.length > 0 && (
          <p className="text-sm text-muted-foreground" data-testid="text-fetch-no-field">
            {step.held === 0
              ? "No detail typed in this form reads differently in the chat."
              : `No detail typed in this form reads differently in the chat. ${step.held} change${step.held === 1 ? "" : "s"} you declined earlier ${step.held === 1 ? "is" : "are"} not offered again until the chat changes.`}
          </p>
        )}

        {step.kind === "review" && (step.changes.length > 0 || step.catalogue.length > 0) && (
          <div className="flex-1 min-h-0 flex flex-col gap-2">
            {step.changes.length > 0 && (
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-sm font-medium" data-testid="text-fetch-count">
                  {changesCount(step.changes.length)}
                </span>
                <span className="inline-flex gap-1">
                  <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => decideAll("accept")} data-testid="button-fetch-accept-all">
                    <Check className="h-3.5 w-3.5 mr-1" />
                    Accept all
                  </Button>
                  <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => decideAll("decline")} data-testid="button-fetch-decline-all">
                    <X className="h-3.5 w-3.5 mr-1" />
                    Decline all
                  </Button>
                </span>
              </div>
            )}
            <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
              {step.changes.map((c) => {
                const key = changeKey(c);
                const decision = decisions[key];
                return (
                  <div
                    key={key}
                    className={cn(
                      "flex items-center gap-2 text-sm flex-wrap rounded-md border p-2",
                      decision === "accept" && "border-emerald-500/30 bg-emerald-500/5",
                      decision === "decline" && "opacity-60",
                    )}
                    data-testid={`fetch-change-${c.field}`}
                    data-decision={decision ?? "undecided"}
                  >
                    <span className="text-muted-foreground w-28 shrink-0">{c.label}:</span>
                    <span className="flex-1 min-w-[10rem] flex items-center gap-1.5 flex-wrap">
                      <span className="line-through text-muted-foreground" data-testid="text-fetch-was">{c.was}</span>
                      <span aria-hidden="true">→</span>
                      <span className="font-medium" data-testid="text-fetch-now">{c.now}</span>
                      {c.said && <span className="text-xs text-muted-foreground">{`— the chat says "${c.said}"`}</span>}
                      <SourceMark field={{ from: c.from, changed: false }} />
                    </span>
                    <ChatSays from={c.from} timeZone={step.timeZone} className="order-last basis-full" />
                    <span className="inline-flex gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant={decision === "accept" ? "default" : "outline"}
                        className="h-7 px-2 text-xs"
                        onClick={() => setDecisions((d) => ({ ...d, [key]: "accept" }))}
                        data-testid="button-fetch-accept"
                      >
                        Accept
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={decision === "decline" ? "default" : "outline"}
                        className="h-7 px-2 text-xs"
                        onClick={() => setDecisions((d) => ({ ...d, [key]: "decline" }))}
                        data-testid="button-fetch-decline"
                      >
                        Decline
                      </Button>
                    </span>
                  </div>
                );
              })}
              {/* The catalogue section: what the chat says there, to read — a fetch applies none of it. */}
              {step.catalogue.length > 0 && (
                <div className={cn("space-y-1.5", step.changes.length > 0 && "pt-2")} data-testid="fetch-catalogue">
                  <p className="text-sm font-medium" data-testid="text-fetch-catalogue-count">
                    {catalogueChangesCount(step.catalogue.length)}
                  </p>
                  {step.catalogue.map((c, i) => (
                    <div
                      key={`${c.section}-${i}`}
                      className="flex items-center gap-2 text-sm flex-wrap rounded-md border border-dashed p-2"
                      data-testid={`fetch-catalogue-${c.section}`}
                    >
                      <span className="text-muted-foreground w-28 shrink-0">{c.label}:</span>
                      <span className="flex-1 min-w-[10rem] flex items-center gap-1.5 flex-wrap">
                        <span className="line-through text-muted-foreground" data-testid="text-fetch-was">{c.was}</span>
                        <span aria-hidden="true">→</span>
                        <span className="font-medium" data-testid="text-fetch-now">{c.now}</span>
                        <SourceMark field={{ from: c.from, changed: false }} />
                      </span>
                      <ChatSays from={c.from} timeZone={step.timeZone} className="basis-full" />
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground" data-testid="text-fetch-catalogue-line">
                    {CATALOGUE_CHANGES_LINE}
                  </p>
                </div>
              )}
            </div>
            {step.changes.length > 0 && step.held > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="text-fetch-held">
                {`${step.held} change${step.held === 1 ? "" : "s"} you declined earlier ${step.held === 1 ? "is" : "are"} not offered again until the chat changes.`}
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {step.kind === "warn" && (
            <>
              <Button type="button" variant="outline" onClick={onClose} data-testid="button-fetch-cancel">
                Cancel
              </Button>
              <Button type="button" onClick={() => void fetchNow()} data-testid="button-fetch-read">
                <RefreshCw className="h-4 w-4 mr-2" />
                Read the chat
              </Button>
            </>
          )}
          {step.kind === "error" && (
            <>
              <Button type="button" variant="outline" onClick={onClose} data-testid="button-fetch-cancel">
                Close
              </Button>
              <Button type="button" onClick={() => void fetchNow()} data-testid="button-fetch-retry">
                <RefreshCw className="h-4 w-4 mr-2" />
                Try again
              </Button>
            </>
          )}
          {step.kind === "review" && step.changes.length === 0 && (
            // Nothing to accept: a catalogue change, when listed, is read here and chosen in its section.
            <Button type="button" variant="outline" onClick={onClose} data-testid="button-fetch-cancel">
              Close
            </Button>
          )}
          {step.kind === "review" && step.changes.length > 0 && (
            <>
              <Button type="button" variant="outline" onClick={onClose} data-testid="button-fetch-cancel">
                Cancel
              </Button>
              <Button type="button" onClick={apply} data-testid="button-fetch-apply">
                <Check className="h-4 w-4 mr-2" />
                {accepted > 0 ? `Apply ${accepted} accepted` : "Done"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
