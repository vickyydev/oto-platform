import { createContext, useContext, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { AlertCircle, CalendarDays, CheckCircle2, ClipboardPaste, Gift, ListTodo, Loader2, MessageSquare, Music, Settings, Sparkles, Trash2, Users, Utensils, Wallet } from "lucide-react";
import { BEO_AI_MENUS, beoAiMatchLabel, beoAiSourceLabel, type BeoAiApproveBody, type BeoAiCakeMode, type BeoAiFrom, type BeoAiMenu, type BeoAiReview } from "@shared/beoAiFill";
import { dayLabel } from "@/lib/beo-ai-date";
import { aiReviewCakeNotSaidNote } from "@/lib/beo-ai-preview";
import {
  APPROVAL_WRITES,
  REVIEW_TEAM_FIELDS,
  addOnLinesOf,
  approvalResultWords,
  approveBodyOf,
  approvedMarksOf,
  catalogueIsEmpty,
  chatOffered,
  chatOfferWords,
  chatSaysOf,
  chatSaysWords,
  choiceGroupsOf,
  edited,
  editedText,
  initialReviewState,
  packageOf,
  packagePrices,
  priceBeside,
  requestFromsOf,
  reviewTeamUnmatchedText,
  sourceOf,
  thb,
  undecidedLines,
  useChatText,
  writtenSourcesOf,
  type ApproveAnswer,
  type ApprovedMarks,
  type BeoAiDecision,
  type BeoAiReviewState,
  type ReviewDetails,
  type ReviewHeld,
  type ReviewLine,
  type ReviewText,
  type Reviewed,
} from "@/lib/beo-ai-review";

/**
 * THE AI FILL'S REVIEW IN EDIT MODE (SCRUM-815).
 *
 * Create BEO's AI Fill read the whole conversation and matched it to the
 * park's catalogue; this is the BEO it proposes, as the BEO's own sections,
 * every field editable and marked with where it came from ("from the team",
 * "from the family", "changed here"). The chat's price is shown beside the
 * catalogue's where they differ; the catalogue's is the one kept. A line the
 * catalogue lacks is highlighted until the reviewer keeps it as a free line
 * or leaves it out. Nothing is written until "Approve and create"; "Load into
 * Editor" (the free-text fill of before) stays as the fallback.
 *
 * SCRUM-827 — ONE PASS: the rest of the BEO (the title, the booking name and
 * location, the special requests, decoration and activities, the setup plan,
 * the POS box, the timeline's steps and the team) is in this review too, each
 * value with its mark — the team's line, the family's line, the park's
 * default (the title, as the app names a party) — and Approve and create
 * writes it all at once; nothing opens after it. A text field the BEO
 * already holds keeps its value, with the chat's offered beside it to take
 * with one press (nothing typed is overwritten, SCRUM-826's rule).
 *
 * SCRUM-903 — every value the chat gave shows the chat's own words under it,
 * as the inbox's Book Date does: The chat says “…”, whose line it was and
 * when (`ChatSays`). With no message of the team's confirming the party yet
 * the review says so, and Load into Editor (the ruling message's free-text
 * fill) has nothing to load; with an empty catalogue every item is a line to
 * keep or leave out.
 */

/** What Create BEO's AI Fill answered when the park has a catalogue. */
export interface BeoAiPending {
  review: BeoAiReview;
  /** The free-text fill, for the fallback. */
  fill: unknown;
  source: { conversationId: string; messageId: string; authorName: string | null; sentAt: string | null; createdAt: string; body: string; fillsFinalMessage?: boolean } | null;
}

const MENU_LABEL: Record<BeoAiMenu, string> = { kids: "Kids", adults: "Adults", bar: "Bar" };
const CAKE_LABEL: Record<BeoAiCakeMode, string> = { INTERNAL: "The park's cake", EXTERNAL: "The family's own cake", NONE: "No cake" };
const SELECT = "h-8 rounded-md border border-input bg-background px-2 text-sm";

/** SCRUM-903: the park's time zone the conversation was read at, for when each line was written. */
const ReviewZone = createContext<string | undefined>(undefined);

/**
 * SCRUM-903: the chat's own words under a value, whose line they are and
 * when it was written — the reason line of the inbox's Book Date. Nothing
 * when the value carries no words of the chat's.
 */
export function ChatSays({ from, timeZone, indent = true, className }: { from: BeoAiFrom | null | undefined; timeZone?: string; indent?: boolean; className?: string }) {
  const zone = useContext(ReviewZone);
  const says = chatSaysOf(from, timeZone ?? zone);
  if (!says) return null;
  return (
    <div className={cn("flex items-center gap-1.5 flex-wrap text-xs text-muted-foreground", indent && "pl-[7.5rem]", className)} data-testid="text-ai-review-chat-says">
      <span className="min-w-0 break-words">{chatSaysWords(says)}</span>
      <SourceMark field={{ from: { source: says.source }, changed: false }} />
      {says.when && <span data-testid="text-ai-review-chat-says-when">{`· ${says.when}`}</span>}
    </div>
  );
}

/** The small mark beside a filled field. */
export function SourceMark({ field }: { field: { from: Pick<BeoAiFrom, "source"> & Partial<BeoAiFrom> | null; changed: boolean } | null }) {
  const source = sourceOf(field as Parameters<typeof sourceOf>[0]);
  if (!source) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-1.5 text-[10px] font-medium",
        source === "team" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        source === "family" && "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400",
        // SCRUM-827: a value the chat did not give — the park's own rule, or a template of the park's.
        source === "default" && "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400",
        source === "template" && "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-400",
        source === "staff" && "border-border bg-muted text-muted-foreground",
      )}
      data-source={source}
      data-testid="ai-review-source"
    >
      {beoAiSourceLabel(source)}
    </span>
  );
}

/** SCRUM-827: the marks a text field of the rest wears: every line it came from, or "changed here". */
function TextMarks({ field }: { field: ReviewText }) {
  if (field.changed) return <SourceMark field={{ from: null, changed: true }} />;
  if (!field.from) return null;
  const froms = field.froms.length > 0 ? field.froms : [field.from];
  return (
    <>
      {froms.map((f) => (
        <SourceMark key={f.source} field={{ from: f, changed: false }} />
      ))}
    </>
  );
}

/**
 * SCRUM-827: a text field of the rest of the BEO. What the BEO holds stays
 * in the field; the chat's text, where it differs, is offered under it with
 * its marks and taken with one press.
 */
function TextRow({
  label,
  field,
  onChange,
  multiline,
  type,
  testId,
  says,
}: {
  label: string;
  field: ReviewText;
  onChange: (next: ReviewText) => void;
  multiline?: boolean;
  type?: "text" | "time";
  testId: string;
  /** SCRUM-903: the lines the chat's text came from, each with its words (the field's own line when not given). */
  says?: BeoAiFrom[];
}) {
  const offered = chatOffered(field);
  const offer = chatOfferWords(field);
  return (
    <div className="space-y-0.5" data-testid={`ai-review-detail-${testId}`}>
      <div className="flex items-start gap-2 text-sm flex-wrap">
        <span className="text-muted-foreground w-28 shrink-0 pt-1.5">{label}:</span>
        {multiline ? (
          <textarea
            className="flex-1 min-w-[10rem] rounded-md border border-input bg-background px-2 py-1 text-sm"
            rows={2}
            value={field.value}
            onChange={(e) => onChange(editedText(field, e.target.value))}
            data-testid={`input-ai-review-${testId}`}
          />
        ) : (
          <Input
            type={type ?? "text"}
            className={cn("h-8", type === "time" ? "w-28" : "flex-1 min-w-[10rem]")}
            value={field.value}
            onChange={(e) => onChange(editedText(field, e.target.value))}
            data-testid={`input-ai-review-${testId}`}
          />
        )}
        <span className="inline-flex items-center gap-1 pt-1.5">
          <TextMarks field={field} />
        </span>
      </div>
      {offered && (
        <div className="pl-[7.5rem] flex items-center gap-2 text-xs text-muted-foreground flex-wrap" data-testid={`text-ai-review-chat-says-${testId}`}>
          {/* SCRUM-827: the park's default and a template are named as such, never called the chat's words. */}
          <span className="whitespace-pre-wrap">{offer.line}</span>
          {field.froms.map((f) => (
            <SourceMark key={f.source} field={{ from: f, changed: false }} />
          ))}
          <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => onChange(useChatText(field))} data-testid={`button-ai-review-use-chat-${testId}`}>
            {offer.button}
          </Button>
        </div>
      )}
      {field.chat !== null && (says ?? (field.chatFrom ? [field.chatFrom] : [])).map((from, i) => <ChatSays key={i} from={from} />)}
    </div>
  );
}

/** SCRUM-827: one line the chat gave (a task, a POS line item, a timeline step), with its mark, removable. */
function LineRow({ line, onChange, onRemove, extraLabel, testId }: {
  line: ReviewLine;
  onChange: (next: ReviewLine) => void;
  onRemove: () => void;
  /** What `extra` is, for its control: a task's notes, an item's kind, a step's time. */
  extraLabel: "notes" | "kind" | "time";
  testId: string;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2 text-sm flex-wrap" data-testid={testId}>
        {extraLabel === "time" && (
          <Input type="time" className="h-8 w-28" value={line.extra} onChange={(e) => onChange({ ...line, extra: e.target.value, changed: true })} />
        )}
        {extraLabel === "kind" && (
          <select className={cn(SELECT, "w-24")} value={line.extra} onChange={(e) => onChange({ ...line, extra: e.target.value, changed: true })}>
            <option value="included">Included</option>
            <option value="extra">Extra</option>
          </select>
        )}
        <Input className="h-8 flex-1 min-w-[8rem]" value={line.label} onChange={(e) => onChange({ ...line, label: e.target.value, changed: true })} />
        {extraLabel === "notes" && (
          <Input className="h-8 w-40" placeholder="Notes" value={line.extra} onChange={(e) => onChange({ ...line, extra: e.target.value, changed: true })} />
        )}
        {/* SCRUM-904: a POS line item's price, only as the chat names it (empty: none). */}
        {extraLabel === "kind" && (
          <Input
            type="number"
            min={0}
            className="h-8 w-24"
            placeholder="Price"
            value={typeof line.price === "number" ? line.price : ""}
            onChange={(e) => onChange({ ...line, price: e.target.value === "" ? null : Math.max(0, parseInt(e.target.value, 10) || 0), changed: true })}
            data-testid="input-ai-review-pos-item-price"
          />
        )}
        <SourceMark field={line} />
        <Button type="button" size="icon" variant="ghost" className="h-7 w-7" onClick={onRemove} aria-label="Remove the line">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ChatSays from={line.from} indent={false} />
    </div>
  );
}

/** The catalogue's price, and the chat's beside it where it names one. */
function PriceBeside({ chat, catalogue }: { chat: number | null; catalogue: Array<number | null> }) {
  const p = priceBeside(chat, catalogue);
  if (p.catalogue.length === 0 && p.chat === null) return null;
  return (
    <span className={cn("text-xs", p.differs ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")} data-testid="ai-review-price">
      {p.catalogue.length > 0 && <span data-testid="ai-review-price-catalogue">{`Catalogue ${p.catalogue.map(thb).join(" / ")}`}</span>}
      {p.chat !== null && (
        <span data-testid="ai-review-price-chat">{`${p.catalogue.length > 0 ? " · " : ""}Chat ${thb(p.chat)}`}</span>
      )}
      {p.differs && <span className="font-medium">{" · not the same: the catalogue's is kept"}</span>}
    </span>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="border rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        {icon}
        {title}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Row({
  label,
  children,
  field,
  says,
}: {
  label: string;
  children: React.ReactNode;
  field?: Parameters<typeof SourceMark>[0]["field"];
  /** SCRUM-903: the line the value came from, for the chat's words under it. */
  says?: BeoAiFrom | null;
}) {
  const row = (
    <div className="flex items-center gap-2 text-sm flex-wrap">
      <span className="text-muted-foreground w-28 shrink-0">{label}:</span>
      {children}
      {field !== undefined && <SourceMark field={field} />}
    </div>
  );
  if (!chatSaysOf(says)) return row;
  return (
    <div className="space-y-0.5">
      {row}
      <ChatSays from={says} />
    </div>
  );
}

/** Keep a line the catalogue lacks as a free line, or leave it out. */
function Decide({ decision, onDecide, keepLabel }: { decision: BeoAiDecision; onDecide: (d: BeoAiDecision) => void; keepLabel: string }) {
  return (
    <span className="inline-flex gap-1">
      <Button
        type="button"
        size="sm"
        variant={decision === "keep" ? "default" : "outline"}
        className="h-7 px-2 text-xs"
        onClick={() => onDecide("keep")}
        data-testid="button-ai-review-keep"
      >
        {keepLabel}
      </Button>
      <Button
        type="button"
        size="sm"
        variant={decision === "drop" ? "default" : "outline"}
        className="h-7 px-2 text-xs"
        onClick={() => onDecide("drop")}
        data-testid="button-ai-review-drop"
      >
        Leave out
      </Button>
    </span>
  );
}

const freeLine = (decision: BeoAiDecision) =>
  cn("rounded-md p-1.5 -mx-1.5", decision === null ? "bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800" : decision === "drop" ? "opacity-50" : "bg-muted/40");

/**
 * The proposed BEO as the editor's own sections, editable. SCRUM-903: on the
 * park's clock, for when each of the chat's lines was written.
 */
export function BeoAiReviewBody(props: Parameters<typeof ReviewSections>[0]) {
  return (
    <ReviewZone.Provider value={props.review.timeZone}>
      <ReviewSections {...props} />
    </ReviewZone.Provider>
  );
}

function ReviewSections({
  review,
  state,
  onChange,
  bookedCakeMode,
}: {
  review: BeoAiReview;
  state: BeoAiReviewState;
  onChange: (next: BeoAiReviewState) => void;
  /** SCRUM-787: the BEO's own cake type, which a cake whose type the chat does not say keeps. */
  bookedCakeMode?: string | null;
}) {
  const set = (patch: Partial<BeoAiReviewState>) => onChange({ ...state, ...patch });
  // SCRUM-827: the rest of the BEO, in the same review.
  const d = state.details;
  const setDetails = (patch: Partial<ReviewDetails>) => set({ details: { ...d, ...patch } });
  // SCRUM-903: a request field's reasons are each request's own line, not only the latest's.
  const REQUEST_KIND = { specialRequests: "special_request", activities: "activity", decoration: "decoration" } as const;
  const textRow = (field: keyof ReviewHeld, label: string, opts: { multiline?: boolean; type?: "text" | "time" } = {}) => (
    <TextRow
      label={label}
      field={d[field]}
      onChange={(next) => setDetails({ [field]: next } as Partial<ReviewDetails>)}
      testId={field}
      says={field in REQUEST_KIND ? requestFromsOf(review, REQUEST_KIND[field as keyof typeof REQUEST_KIND]) : undefined}
      {...opts}
    />
  );
  const lines = (field: "setupTasks" | "posItems" | "timeline", extraLabel: "notes" | "kind" | "time", testId: string) =>
    d[field].map((line, i) => (
      <LineRow
        key={line.key}
        line={line}
        extraLabel={extraLabel}
        testId={testId}
        onChange={(next) => {
          const list = [...d[field]];
          list[i] = next;
          setDetails({ [field]: list } as Partial<ReviewDetails>);
        }}
        onRemove={() => setDetails({ [field]: d[field].filter((_, j) => j !== i) } as Partial<ReviewDetails>)}
      />
    ));
  const pkg = packageOf(review, state.packageId.value);
  const proposedPkg = review.proposal.package;
  const groups = choiceGroupsOf(review, state.setMenuId.value);
  const count = (field: Reviewed<number> | null, key: "numChildren" | "numAdults", label: string) => (
    <Row label={label} field={field} says={field?.from}>
      <Input
        type="number"
        min={0}
        className="h-8 w-24"
        value={field?.value ?? ""}
        onChange={(e) => set({ [key]: e.target.value === "" ? null : edited(field, Math.max(0, parseInt(e.target.value, 10) || 0)) })}
        data-testid={`input-ai-review-${key}`}
      />
    </Row>
  );
  const time = (field: Reviewed<string> | null, key: "startTime" | "endTime" | "kidsFoodTime" | "adultsFoodTime" | "barServiceTime", label: string) => (
    <Row label={label} field={field} says={field?.from}>
      <Input
        type="time"
        className="h-8 w-28"
        value={field?.value ?? ""}
        onChange={(e) => set({ [key]: e.target.value ? edited(field, e.target.value) : null })}
        data-testid={`input-ai-review-${key}`}
      />
    </Row>
  );

  return (
    <div className="space-y-3">
      <Section title="Event Info" icon={<CalendarDays className="h-4 w-4" />}>
        {/* SCRUM-827: the party's name, as the app names one from the child and the age — the park's default. */}
        {textRow("title", "Title")}
        <Row label="Child" field={state.childName} says={state.childName?.from}>
          <Input
            className="h-8 flex-1 min-w-[10rem]"
            value={state.childName?.value ?? ""}
            onChange={(e) => set({ childName: edited(state.childName, e.target.value) })}
            data-testid="input-ai-review-childName"
          />
        </Row>
        {/* SCRUM-904: the age the child turns, as the chat gives it. */}
        {(state.childAge || review.proposal.event.childAge) && (
          <Row label="Age" field={state.childAge} says={state.childAge?.from}>
            <Input
              type="number"
              min={0}
              className="h-8 w-24"
              value={state.childAge?.value ?? ""}
              onChange={(e) => set({ childAge: e.target.value === "" ? null : edited(state.childAge, Math.max(0, parseInt(e.target.value, 10) || 0)) })}
              data-testid="input-ai-review-childAge"
            />
          </Row>
        )}
        {/* SCRUM-814: the confirmation's date beside the booked one; marked when they differ, applied only when ticked. */}
        {state.date && (
          <div
            className={cn(
              "flex gap-2 text-sm rounded-md",
              state.date.differs && "bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-1.5 -mx-1.5",
            )}
            data-testid="ai-review-event-date"
          >
            <span className="text-muted-foreground w-28 shrink-0">Date:</span>
            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">{dayLabel(state.date.read)}</span>
                {state.date.readText && (
                  <span className="text-xs text-muted-foreground">{`— the message says "${state.date.readText}"`}</span>
                )}
                <SourceMark field={{ from: state.date.from !== undefined ? state.date.from : review.ruling, changed: false }} />
              </div>
              {/* SCRUM-904: the chat's words for the date, whose line and when. */}
              <ChatSays from={state.date.from !== undefined ? state.date.from : review.ruling} indent={false} />
              {state.date.differs ? (
                <>
                  <div className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300" data-testid="text-ai-review-date-differs">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    {state.date.booked
                      ? `The event is booked for ${dayLabel(state.date.booked)}: not the same day.`
                      : "The event has no date yet."}
                  </div>
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={state.useDate}
                      onChange={(e) => set({ useDate: e.target.checked })}
                      data-testid="checkbox-ai-review-event-date"
                    />
                    {`Tick to make ${dayLabel(state.date.read)} the event's date.`}
                  </label>
                </>
              ) : (
                <div className="text-xs text-muted-foreground" data-testid="text-ai-review-date-same">
                  The same day the event is booked for.
                </div>
              )}
            </div>
          </div>
        )}
        {count(state.numChildren, "numChildren", "Children")}
        {count(state.numAdults, "numAdults", "Adults")}
        {time(state.startTime, "startTime", "Start")}
        {time(state.endTime, "endTime", "End")}
        {/* SCRUM-827: the rest of Event Info: the ruling's fields, and the chat's requests with their lines. */}
        {textRow("bookingName", "Booking name")}
        {/* SCRUM-904: the family's WhatsApp number the chat gives, beside the form's, never over it. */}
        {(d.whatsapp.value || d.whatsapp.chat) && textRow("whatsapp", "WhatsApp")}
        {textRow("locationText", "Location")}
        {textRow("activities", "Activities", { multiline: true })}
        {textRow("decoration", "Decoration", { multiline: true })}
        {textRow("specialRequests", "Special requests", { multiline: true })}
      </Section>

      {/* SCRUM-827: whom the message names, matched to this park's people; assigned only when ticked. */}
      <Section title="Team" icon={<Users className="h-4 w-4" />}>
        {REVIEW_TEAM_FIELDS.every(({ field }) => !d.team.proposals[field]) && (
          <p className="text-xs text-muted-foreground" data-testid="text-ai-review-no-team">
            The chat names nobody for the team. Choose the hosts in the form.
          </p>
        )}
        {REVIEW_TEAM_FIELDS.map(({ field, label }) => {
          const proposal = d.team.proposals[field];
          if (!proposal) return null;
          if (proposal.match) {
            const ticked = d.team.accepted.includes(field);
            return (
              <div key={field} className="space-y-0.5">
                <label className="flex items-start gap-2 text-sm cursor-pointer" data-testid={`ai-review-team-${field}`}>
                  <span className="text-muted-foreground w-28 shrink-0">{label}:</span>
                  <input
                    type="checkbox"
                    className="mt-1 shrink-0"
                    checked={ticked}
                    onChange={(e) =>
                      setDetails({
                        team: { ...d.team, accepted: e.target.checked ? [...d.team.accepted, field] : d.team.accepted.filter((f) => f !== field) },
                      })
                    }
                    data-testid={`checkbox-ai-review-team-${field}`}
                  />
                  <span className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-medium">{proposal.match.label}</span>
                    <span className="text-xs text-muted-foreground">{` — the message says "${proposal.asked}". Tick to assign.`}</span>
                    <SourceMark field={{ from: proposal.from ?? { source: "team", at: null, line: null }, changed: false }} />
                  </span>
                </label>
                {/* SCRUM-904: the chat's line that names them (the ruling message when the conversation did not). */}
                <ChatSays from={proposal.from ?? review.ruling} />
              </div>
            );
          }
          return (
            <div key={field} className="space-y-0.5" data-testid={`ai-review-team-${field}`}>
              <div className="flex items-start gap-2 text-sm">
                <span className="text-muted-foreground w-28 shrink-0">{label}:</span>
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
                <span>
                  <span className="font-medium">{`"${proposal.asked}"`}</span>
                  <span className="text-xs text-amber-700 dark:text-amber-300">{` ${reviewTeamUnmatchedText(field, proposal.why)}`}</span>
                </span>
              </div>
              <ChatSays from={proposal.from ?? review.ruling} />
            </div>
          );
        })}
      </Section>

      <Section title="Package" icon={<Gift className="h-4 w-4" />}>
        <Row
          label="Package"
          field={state.packageId.value ? state.packageId : null}
          says={proposedPkg && state.packageId.value === proposedPkg.templateId ? proposedPkg.from : null}
        >
          <select
            className={SELECT}
            value={state.packageId.value ?? ""}
            onChange={(e) => {
              const id = e.target.value || null;
              const next = review.catalogue.packages.find((p) => p.id === id);
              // A new package starts its own set menu, unless the reviewer chose one.
              const setMenuId = !state.setMenuId.changed && next?.setMenuTemplateId ? edited(state.setMenuId, next.setMenuTemplateId) : state.setMenuId;
              set({ packageId: edited(state.packageId, id), setMenuId });
            }}
            data-testid="select-ai-review-package"
          >
            <option value="">No package</option>
            {review.catalogue.packages.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </Row>
        {pkg && (
          <div className="pl-[7.5rem] space-y-0.5">
            <PriceBeside chat={proposedPkg?.templateId === pkg.id ? proposedPkg.chatPrice : null} catalogue={packagePrices(pkg)} />
            {proposedPkg?.said && proposedPkg.templateId === pkg.id && (
              <div className="text-xs text-muted-foreground" data-testid="text-ai-review-package-said">
                {beoAiMatchLabel(proposedPkg.said, pkg.name, null)}
              </div>
            )}
          </div>
        )}
        {addOnLinesOf(pkg).map((line) => {
          const q = state.addOns[line.id] ?? null;
          const proposed = review.proposal.addOns.find((a) => a.lineId === line.id);
          return (
            <div key={line.id} className="space-y-0.5">
              <div className="flex items-center gap-2 text-sm flex-wrap" data-testid={`ai-review-addon-${line.id}`}>
                <span className="w-28 shrink-0 text-muted-foreground">Add-on:</span>
                <span className="flex-1 min-w-[8rem]">{line.label}</span>
                <Input
                  type="number"
                  min={0}
                  className="h-8 w-20"
                  value={q?.value ?? 0}
                  onChange={(e) => set({ addOns: { ...state.addOns, [line.id]: edited(q, Math.max(0, parseInt(e.target.value, 10) || 0)) } })}
                  data-testid={`input-ai-review-addon-${line.id}`}
                />
                <PriceBeside chat={proposed?.chatPrice ?? null} catalogue={[line.unitPrice]} />
                <SourceMark field={q && q.value > 0 ? q : null} />
              </div>
              {q && q.value > 0 && <ChatSays from={proposed?.from} />}
            </div>
          );
        })}
      </Section>

      {/* SCRUM-827: the POS box (Party Details) and the setup plan, from the team's confirmation. */}
      <Section title="POS" icon={<Gift className="h-4 w-4" />}>
        {textRow("posName", "POS name")}
        {d.posItems.length === 0 && !d.posName.value && !d.posNotes.value && (
          <p className="text-xs text-muted-foreground" data-testid="text-ai-review-no-pos">The chat names nothing for the POS box.</p>
        )}
        {lines("posItems", "kind", "ai-review-pos-item")}
        {textRow("posNotes", "POS notes", { multiline: true })}
      </Section>

      <Section title="Setup Plan" icon={<Settings className="h-4 w-4" />}>
        {textRow("setupReadyBy", "Ready by", { type: "time" })}
        {textRow("setupResponsible", "Who")}
        {d.setupTasks.length === 0 && !d.setupReadyBy.value && !d.setupResponsible.value && !d.setupNotes.value && (
          <p className="text-xs text-muted-foreground" data-testid="text-ai-review-no-setup">The chat names no setup.</p>
        )}
        {lines("setupTasks", "notes", "ai-review-setup-task")}
        {/* SCRUM-904: the setup plan's notes, held text never overwritten. */}
        {(d.setupNotes.value || d.setupNotes.chat) && textRow("setupNotes", "Setup notes", { multiline: true })}
      </Section>

      <Section title="Kitchen Plan" icon={<Utensils className="h-4 w-4" />}>
        <Row
          label="Set menu"
          field={state.setMenuId.value ? state.setMenuId : null}
          says={review.proposal.setMenu && state.setMenuId.value === review.proposal.setMenu.templateId ? review.proposal.setMenu.from : null}
        >
          <select
            className={SELECT}
            value={state.setMenuId.value ?? ""}
            onChange={(e) => set({ setMenuId: edited(state.setMenuId, e.target.value || null) })}
            data-testid="select-ai-review-set-menu"
          >
            <option value="">No set menu</option>
            {review.catalogue.setMenus.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </Row>
        {groups.map((g) => {
          const c = state.choices[g.id] ?? null;
          const chosen = c?.value ?? [];
          const choose = (options: string[]) => set({ choices: { ...state.choices, [g.id]: edited(c, options) } });
          // The choice already recorded (the parent link, or an earlier approval), kept when this group is left unchosen on that set menu.
          const parent =
            review.parentSelection?.templateId === state.setMenuId.value
              ? review.parentSelection.choices.find((x) => x.itemId === g.id)?.options ?? []
              : [];
          return (
            <div key={g.id} className="space-y-0.5" data-testid={`ai-review-choice-${g.id}`}>
              <Row label={g.label} field={chosen.length > 0 ? c : null}>
                {g.allowMultiple ? (
                  <span className="inline-flex flex-wrap gap-x-3 gap-y-1" data-testid={`checkboxes-ai-review-choice-${g.id}`}>
                    {g.options.map((o) => (
                      <label key={o} className="flex items-center gap-1 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={chosen.includes(o)}
                          onChange={(e) => choose(e.target.checked ? g.options.filter((x) => x === o || chosen.includes(x)) : chosen.filter((x) => x !== o))}
                          data-testid={`checkbox-ai-review-choice-${g.id}`}
                        />
                        {o}
                      </label>
                    ))}
                  </span>
                ) : (
                  <select
                    className={SELECT}
                    value={chosen[0] ?? ""}
                    onChange={(e) => choose(e.target.value ? [e.target.value] : [])}
                    data-testid={`select-ai-review-choice-${g.id}`}
                  >
                    <option value="">Not chosen yet</option>
                    {g.options.map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                )}
              </Row>
              {c && !c.changed &&
                chosen.map((option) => {
                  const proposed = review.proposal.setMenu?.choices.find((x) => x.itemId === g.id && x.option === option);
                  if (!proposed) return null;
                  return (
                    <div key={option} className="space-y-0.5">
                      {proposed.said && (
                        <div className="pl-[7.5rem] text-xs text-muted-foreground" data-testid="text-ai-review-match">
                          {beoAiMatchLabel(proposed.said, option, g.optionProductCodes[option] ?? g.productCode)}
                        </div>
                      )}
                      <ChatSays from={proposed.from} />
                    </div>
                  );
                })}
              {chosen.length === 0 && parent.length > 0 && (
                <div className="pl-[7.5rem] text-xs text-muted-foreground" data-testid="text-ai-review-parent-choice">
                  {`Already recorded for this set menu: ${parent.join(", ")}. It stays unless you choose here.`}
                </div>
              )}
            </div>
          );
        })}
        {state.menuLines.map((l, i) => {
          const update = (patch: Partial<typeof l>) => {
            const menuLines = [...state.menuLines];
            menuLines[i] = { ...l, ...patch, changed: patch.decision !== undefined && Object.keys(patch).length === 1 ? l.changed : true };
            set({ menuLines });
          };
          return (
            <div key={l.key} className={cn("space-y-1", l.notInMenu && freeLine(l.decision))} data-testid={l.notInMenu ? "ai-review-not-in-menu" : "ai-review-menu-line"}>
              <div className="flex items-center gap-2 text-sm flex-wrap">
                <select className={cn(SELECT, "w-20")} value={l.menu} onChange={(e) => update({ menu: e.target.value as BeoAiMenu })} data-testid="select-ai-review-menu">
                  {BEO_AI_MENUS.map((m) => (
                    <option key={m} value={m}>{MENU_LABEL[m]}</option>
                  ))}
                </select>
                <Input
                  type="number"
                  min={1}
                  className="h-8 w-16"
                  value={l.quantity}
                  onChange={(e) => update({ quantity: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                />
                {l.notInMenu ? (
                  <Input className="h-8 flex-1 min-w-[8rem]" value={l.itemName} onChange={(e) => update({ itemName: e.target.value })} />
                ) : (
                  <span className="flex-1 min-w-[8rem]" data-testid="text-ai-review-match">{beoAiMatchLabel(l.itemName, l.matchedName, l.productCode)}</span>
                )}
                <SourceMark field={l} />
                <Button type="button" size="icon" variant="ghost" className="h-7 w-7" onClick={() => set({ menuLines: state.menuLines.filter((_, j) => j !== i) })} aria-label="Remove the line">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <ChatSays from={l.from} indent={false} />
              {/* SCRUM-904: the chat's note on the dish, written on its line. */}
              {l.notes !== undefined && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-xs text-muted-foreground">Note:</span>
                  <Input className="h-8 flex-1 min-w-[8rem]" value={l.notes} onChange={(e) => update({ notes: e.target.value })} data-testid="input-ai-review-menu-notes" />
                </div>
              )}
              {l.chatPrice !== null && <PriceBeside chat={l.chatPrice} catalogue={[]} />}
              {l.notInMenu && (
                <div className="flex items-center gap-2 text-xs text-amber-800 dark:text-amber-200 flex-wrap">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1">Not in the menu: keep it as a free line in the conversation's words, or leave it out.</span>
                  <Decide decision={l.decision} onDecide={(decision) => update({ decision })} keepLabel="Keep as a free line" />
                </div>
              )}
            </div>
          );
        })}
        <Row label="Cake" field={state.cake} says={state.cake?.from}>
          <select
            className={SELECT}
            value={state.cake?.value.mode ?? ""}
            onChange={(e) => {
              const mode = (e.target.value || null) as BeoAiCakeMode | null;
              // SCRUM-787: "Not said" keeps the cake's time and notes, with the BEO's own type.
              const keep = state.cake && (state.cake.value.time || state.cake.value.notes);
              set({ cake: mode || keep ? edited(state.cake, { notes: "", time: "", ...state.cake?.value, mode }) : null });
            }}
            data-testid="select-ai-review-cake"
          >
            <option value="">Not said</option>
            {(Object.keys(CAKE_LABEL) as BeoAiCakeMode[]).map((m) => (
              <option key={m} value={m}>{CAKE_LABEL[m]}</option>
            ))}
          </select>
          {state.cake && !state.cake.value.mode && (
            <span className="text-xs text-amber-700 dark:text-amber-300" data-testid="text-ai-review-cake-not-said">
              {aiReviewCakeNotSaidNote(state.cake.value, bookedCakeMode)}
            </span>
          )}
          {state.cake && (
            <>
              <Input
                className="h-8 flex-1 min-w-[8rem]"
                placeholder="Cake notes"
                value={state.cake.value.notes}
                onChange={(e) => set({ cake: edited(state.cake, { ...state.cake!.value, notes: e.target.value }) })}
              />
              <Input
                type="time"
                className="h-8 w-28"
                value={state.cake.value.time}
                onChange={(e) => set({ cake: edited(state.cake, { ...state.cake!.value, time: e.target.value }) })}
              />
            </>
          )}
        </Row>
        {/* SCRUM-904: how many cakes, whether it comes with the package and its price — only as the chat says them. */}
        {state.cake && (state.cake.value.quantity !== undefined || state.cake.value.included !== undefined || state.cake.value.price !== undefined) && (
          <div className="pl-[7.5rem] flex items-center gap-2 text-sm flex-wrap" data-testid="ai-review-cake-more">
            <span className="text-xs text-muted-foreground">Cakes:</span>
            <Input
              type="number"
              min={1}
              className="h-8 w-16"
              value={state.cake.value.quantity ?? ""}
              onChange={(e) => {
                const { quantity: _q, ...rest } = state.cake!.value;
                set({ cake: edited(state.cake, e.target.value === "" ? rest : { ...rest, quantity: Math.max(1, parseInt(e.target.value, 10) || 1) }) });
              }}
              data-testid="input-ai-review-cake-quantity"
            />
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={state.cake.value.included === true}
                onChange={(e) => set({ cake: edited(state.cake, { ...state.cake!.value, included: e.target.checked }) })}
                data-testid="checkbox-ai-review-cake-included"
              />
              In the package
            </label>
            <Input
              type="number"
              min={0}
              className="h-8 w-24"
              placeholder="Price"
              value={state.cake.value.price ?? ""}
              onChange={(e) => {
                const { price: _p, ...rest } = state.cake!.value;
                set({ cake: edited(state.cake, e.target.value === "" ? rest : { ...rest, price: Math.max(0, parseInt(e.target.value, 10) || 0) }) });
              }}
              data-testid="input-ai-review-cake-price"
            />
            <span className="text-xs text-muted-foreground">THB</span>
          </div>
        )}
        {/* SCRUM-904: when the kids' and the adults' food is served, and when the bar serves the drinks. */}
        {(state.kidsFoodTime || review.proposal.event.kidsFoodTime) && time(state.kidsFoodTime, "kidsFoodTime", "Kids' food")}
        {(state.adultsFoodTime || review.proposal.event.adultsFoodTime) && time(state.adultsFoodTime, "adultsFoodTime", "Adults' food")}
        {(state.barServiceTime || review.proposal.event.barServiceTime) && time(state.barServiceTime, "barServiceTime", "Bar service")}
      </Section>

      <Section title="Entertainment" icon={<Music className="h-4 w-4" />}>
        {state.entertainment.length === 0 && <p className="text-xs text-muted-foreground">The conversation names no entertainment.</p>}
        {state.entertainment.map((e, i) => {
          const t = e.templateId ? review.catalogue.entertainment.find((x) => x.id === e.templateId) : undefined;
          const update = (patch: Partial<typeof e>) => {
            const entertainment = [...state.entertainment];
            entertainment[i] = { ...e, ...patch, changed: patch.decision !== undefined && Object.keys(patch).length === 1 ? e.changed : true };
            set({ entertainment });
          };
          return (
            <div key={e.key} className={cn("space-y-1", e.notInCatalogue && freeLine(e.decision))} data-testid={e.notInCatalogue ? "ai-review-not-in-catalogue" : "ai-review-entertainment"}>
              <div className="flex items-center gap-2 text-sm flex-wrap">
                {e.notInCatalogue ? (
                  <Input className="h-8 flex-1 min-w-[8rem]" value={e.name} onChange={(ev) => update({ name: ev.target.value })} />
                ) : (
                  <select
                    className={cn(SELECT, "flex-1 min-w-[8rem]")}
                    value={e.templateId ?? ""}
                    onChange={(ev) => update({ templateId: ev.target.value || null })}
                    data-testid="select-ai-review-entertainment"
                  >
                    {review.catalogue.entertainment.map((x) => (
                      <option key={x.id} value={x.id}>{x.name}</option>
                    ))}
                  </select>
                )}
                <Input
                  type="number"
                  min={1}
                  className="h-8 w-16"
                  value={e.quantity}
                  onChange={(ev) => update({ quantity: Math.max(1, parseInt(ev.target.value, 10) || 1) })}
                />
                <SourceMark field={e} />
                <Button type="button" size="icon" variant="ghost" className="h-7 w-7" onClick={() => set({ entertainment: state.entertainment.filter((_, j) => j !== i) })} aria-label="Remove the line">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <ChatSays from={e.from} indent={false} />
              {/* SCRUM-904: a show the chat times is an Entertainment Act at that time as well, on the Timeline. */}
              {e.time !== undefined && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap" data-testid="ai-review-entertainment-act">
                  <span>Act at</span>
                  <Input type="time" className="h-8 w-28" value={e.time} onChange={(ev) => update({ time: ev.target.value })} data-testid="input-ai-review-entertainment-time" />
                  <span>{e.time ? "— added to Entertainment Acts, which puts it on the Timeline." : "— no time: not added as an act."}</span>
                </div>
              )}
              <PriceBeside chat={e.chatPrice} catalogue={t ? [t.price] : []} />
              {e.notInCatalogue && (
                <div className="flex items-center gap-2 text-xs text-amber-800 dark:text-amber-200 flex-wrap">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1">Not on the entertainment menu: keep it as a free line, or leave it out.</span>
                  <Decide decision={e.decision} onDecide={(decision) => update({ decision })} keepLabel="Keep as a free line" />
                </div>
              )}
            </div>
          );
        })}
      </Section>

      {state.otherLines.length > 0 && (
        <Section title="Not in the catalogue" icon={<AlertCircle className="h-4 w-4 text-amber-500" />}>
          {state.otherLines.map((o, i) => (
            <div key={o.key} className="space-y-0.5">
              <div className={cn("flex items-center gap-2 text-sm flex-wrap", freeLine(o.decision))} data-testid="ai-review-other-line">
                <span className="flex-1 min-w-[8rem]">{o.text}</span>
                {o.chatPrice !== null && <PriceBeside chat={o.chatPrice} catalogue={[]} />}
                <SourceMark field={{ from: o.from, changed: false }} />
                <Decide
                  decision={o.decision}
                  onDecide={(decision) => {
                    const otherLines = [...state.otherLines];
                    otherLines[i] = { ...o, decision };
                    set({ otherLines });
                  }}
                  keepLabel="Keep in Special Requests"
                />
              </div>
              <ChatSays from={o.from} indent={false} />
            </div>
          ))}
        </Section>
      )}

      {/* SCRUM-827: the chat's timed steps; the BEO's own steps are added from itself on approval. */}
      <Section title="Timeline" icon={<ListTodo className="h-4 w-4" />}>
        {d.timeline.length === 0 && <p className="text-xs text-muted-foreground" data-testid="text-ai-review-no-timeline">The chat gives no timed steps.</p>}
        {lines("timeline", "time", "ai-review-timeline-step")}
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground flex-wrap" data-testid="text-ai-review-timeline-auto">
          The park's own steps (guests arrive, the setup, the cake, the food) are added from the BEO when you approve.
          <SourceMark field={{ from: { source: "template", at: null, line: null }, changed: false }} />
        </p>
      </Section>

      {state.deposit && (
        <Section title="Deposit" icon={<Wallet className="h-4 w-4" />}>
          <Row label={state.deposit.value.paid ? "Deposit paid" : "Deposit asked"} field={state.deposit} says={state.deposit.from}>
            <Input
              type="number"
              min={0}
              className="h-8 w-28"
              value={state.deposit.value.amount}
              onChange={(e) => set({ deposit: edited(state.deposit, { ...state.deposit!.value, amount: Math.max(0, parseInt(e.target.value, 10) || 0) }) })}
              data-testid="input-ai-review-deposit"
            />
            <span className="text-xs text-muted-foreground">THB</span>
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={state.deposit.value.paid}
                onChange={(e) => set({ deposit: edited(state.deposit, { ...state.deposit!.value, paid: e.target.checked }) })}
                data-testid="checkbox-ai-review-deposit-paid"
              />
              Received
            </label>
            <Input
              type="date"
              className="h-8 w-36"
              value={state.deposit.value.date}
              onChange={(e) => set({ deposit: edited(state.deposit, { ...state.deposit!.value, date: e.target.value }) })}
            />
          </Row>
        </Section>
      )}
    </div>
  );
}

/**
 * The review dialog: the proposed BEO in edit mode, "Approve and create"
 * (one write of everything, server/lib/beoAiApprove.ts), and "Load into
 * Editor" as the fallback for the free-text fill.
 */
export function BeoAiReviewDialog({
  eventId,
  pending,
  bookedDate,
  bookedCakeMode,
  held,
  saved,
  onClose,
  onFallback,
  onApproved,
}: {
  eventId: string;
  pending: BeoAiPending | null;
  /** SCRUM-814: the date the form holds, beside the one the confirmation names. */
  bookedDate: string | null;
  /** SCRUM-787: the cake type the form holds, which a cake whose type is not said keeps. */
  bookedCakeMode?: string | null;
  /** SCRUM-827: what the form holds of the rest, so nothing typed is overwritten. */
  held?: ReviewHeld;
  /** What the saved BEO holds of it: the approval writes what differs from this, unsaved typed text included. */
  saved?: ReviewHeld;
  onClose: () => void;
  onFallback: (pending: BeoAiPending) => void;
  /**
   * SCRUM-827: after Approve and create is saved and the BEO read again — the
   * sources the approval recorded, by field, for the marks the form wears.
   * Nothing opens after this: the one pass wrote everything.
   */
  onApproved: (marks: ApprovedMarks, pending: BeoAiPending) => void;
}) {
  const { toast } = useToast();
  const [state, setState] = useState<BeoAiReviewState | null>(null);
  const [opened, setOpened] = useState<BeoAiPending | null>(null);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (pending !== opened) {
    // A new proposal: the review starts from it.
    setOpened(pending);
    setState(pending ? initialReviewState(pending.review, { fill: pending.fill, bookedDate, held, saved }) : null);
    setError(null);
  }
  if (!pending || !state) return null;
  const { review, source } = pending;
  const undecided = undecidedLines(state);
  // SCRUM-818: a message pasted into AI Fill, read as one line of the team's.
  const pasted = review.origin === "pasted";
  // SCRUM-903: no message of the team's confirms the party yet: the conversation was read alone.
  const unconfirmed = !pasted && review.ruling === null;

  const approve = async () => {
    setApproving(true);
    setError(null);
    let body: BeoAiApproveBody;
    let answer: ApproveAnswer = {};
    try {
      body = approveBodyOf(review, state, { conversationId: source?.conversationId ?? review.conversationId ?? null, messageId: source?.messageId ?? null });
      const res = await apiRequest("POST", `/api/events/${eventId}/beo/ai-fill/approve`, body);
      answer = ((await res.json().catch(() => ({}))) ?? {}) as ApproveAnswer;
    } catch (err: any) {
      setError(err?.message || "The BEO was not saved: the server could not be reached just now.");
      setApproving(false);
      return;
    }
    try {
      // The form reads the BEO again, so what it shows is what was approved.
      await Promise.all(
        [
          ["/api/events", eventId, "beo"],
          ["/api/events", eventId, "beo", "timeline"],
          ["/api/beo/events", eventId, "package-snapshot"],
          ["/api/beo/events", eventId, "entertainment-selections"],
          ["/api/beo/set-menu-selections", eventId],
          ["/api/admin/events"],
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    } catch {
      // The BEO is saved; a read that failed catches up on the next one.
    }
    // SCRUM-827 review: the chat's timed steps have no place on a party with no start time yet
    // (the timeline holds a step as minutes from the start); the answer says so, and so does this.
    // SCRUM-843: and a deposit that changed while the review was open stays as stored, and is said.
    toast({ title: `BEO created from the ${pasted ? "pasted message" : "conversation"}`, description: approvalResultWords(answer) });
    setApproving(false);
    // SCRUM-827: one pass — nothing opens after this; the form wears the sources' marks (not a step's, nor the deposit's, that was not written).
    onApproved(approvedMarksOf(writtenSourcesOf(body.sources, answer)), pending);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !approving && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            AI Fill — Review, edit and approve
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto space-y-3 pr-1">
          <div className="border rounded-lg p-3 space-y-1 text-xs text-muted-foreground" data-testid="ai-review-conversation">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <MessageSquare className="h-4 w-4" />
              {pasted ? "Read from the pasted message" : "Read from the whole conversation"}
            </div>
            {pasted ? (
              <p data-testid="text-ai-review-pasted">
                The pasted message is read as the team's confirmation and matched to the park's catalogue.
              </p>
            ) : (
              <p>
                {`${review.transcript.lines} message${review.transcript.lines === 1 ? "" : "s"} read${review.transcript.cut ? " (older ones were left out)" : ""}${
                  source ? `; the team's confirmation${source.authorName ? ` from ${source.authorName}` : ""} wins where the family and the team both speak.` : "."
                }`}
              </p>
            )}
            {unconfirmed && (
              <p className="text-amber-700 dark:text-amber-300" data-testid="text-ai-review-no-ruling">
                Nothing is confirmed by the team yet: no message of the team's names the date, the time and the party details. Every value is what the chat says so far — check each one before approving.
              </p>
            )}
            {catalogueIsEmpty(review) && (
              <p data-testid="text-ai-review-no-catalogue">
                {/* SCRUM-904: a catalogue that could not be read is not called empty. */}
                {review.catalogueUnread
                  ? "This park's catalogue could not be read just now: every package, dish and show the chat names is a line to keep or leave out. Try again in a moment to match them to the catalogue."
                  : "This park's catalogue is empty: every package, dish and show the chat names is a line to keep or leave out."}
              </p>
            )}
            <p className="flex items-center gap-1.5 flex-wrap">
              {pasted ? "Every field it fills is the team's, or the park's own:" : "Every field is the family's, the team's, or the park's own:"}
              <SourceMark field={{ from: { source: "team" }, changed: false }} />
              {!pasted && <SourceMark field={{ from: { source: "family" }, changed: false }} />}
              <SourceMark field={{ from: { source: "default" }, changed: false }} />
              <SourceMark field={{ from: null, changed: true }} />
              {pasted ? "— a field you change is marked as changed here." : "— the family's are defaults for you to check."}
            </p>
            <p data-testid="text-ai-review-reasons">Under each value, the chat's own words for it, whose line they are and when it was written.</p>
          </div>
          <BeoAiReviewBody review={review} state={state} onChange={setState} bookedCakeMode={bookedCakeMode} />
          {review.finalMessage && (
            <p className="text-xs text-muted-foreground" data-testid="text-ai-review-final-message">
              Approve and create also puts the team's confirmation, word for word, in Final Message to Parent.
            </p>
          )}
          <p className="text-xs text-muted-foreground" data-testid="text-ai-review-writes">
            {`Approve and create writes ${APPROVAL_WRITES} — everything above, in one go. Nothing opens after it; a field the BEO already holds keeps its value unless you take the chat's.`}
          </p>
        </div>
        {review.replaces.length > 0 && (
          <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-2 text-xs text-amber-800 dark:text-amber-200" data-testid="text-ai-review-replaces">
            {`This BEO already has its ${review.replaces.join(", ")}: approving replaces what the review fills.`}
          </div>
        )}
        {undecided > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="text-ai-review-undecided">
            {`Decide the ${undecided} line${undecided === 1 ? "" : "s"} the catalogue does not have before approving.`}
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter className="gap-2">
          {/* SCRUM-903: with no ruling message there is no free-text fill to load. */}
          {!unconfirmed && (
            <Button variant="outline" onClick={() => onFallback(pending)} disabled={approving} data-testid="button-ai-review-fallback">
              <ClipboardPaste className="h-4 w-4 mr-2" />
              Load into Editor instead
            </Button>
          )}
          <Button onClick={approve} disabled={approving || undecided > 0} data-testid="button-ai-review-approve">
            {approving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
            Approve and create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
