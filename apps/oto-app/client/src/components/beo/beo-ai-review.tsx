import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { AlertCircle, CalendarDays, CheckCircle2, ClipboardPaste, Gift, Loader2, MessageSquare, Music, Sparkles, Trash2, Utensils, Wallet } from "lucide-react";
import { BEO_AI_MENUS, beoAiMatchLabel, beoAiSourceLabel, type BeoAiApproveBody, type BeoAiCakeMode, type BeoAiMenu, type BeoAiReview } from "@shared/beoAiFill";
import { dayLabel } from "@/lib/beo-ai-date";
import {
  APPROVAL_LEAVES,
  APPROVAL_WRITES,
  addOnLinesOf,
  approveBodyOf,
  choiceGroupsOf,
  edited,
  fillBeyondApproval,
  initialReviewState,
  packageOf,
  packagePrices,
  priceBeside,
  sourceOf,
  thb,
  undecidedLines,
  type BeoAiDecision,
  type BeoAiReviewState,
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

/** The small mark beside a filled field. */
export function SourceMark({ field }: { field: { from: { source: "team" | "family" } | null; changed: boolean } | null }) {
  const source = sourceOf(field as Parameters<typeof sourceOf>[0]);
  if (!source) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-1.5 text-[10px] font-medium",
        source === "team" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        source === "family" && "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400",
        source === "staff" && "border-border bg-muted text-muted-foreground",
      )}
      data-source={source}
      data-testid="ai-review-source"
    >
      {beoAiSourceLabel(source)}
    </span>
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

function Row({ label, children, field }: { label: string; children: React.ReactNode; field?: Parameters<typeof SourceMark>[0]["field"] }) {
  return (
    <div className="flex items-center gap-2 text-sm flex-wrap">
      <span className="text-muted-foreground w-28 shrink-0">{label}:</span>
      {children}
      {field !== undefined && <SourceMark field={field} />}
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

/** The proposed BEO as the editor's own sections, editable. */
export function BeoAiReviewBody({
  review,
  state,
  onChange,
}: {
  review: BeoAiReview;
  state: BeoAiReviewState;
  onChange: (next: BeoAiReviewState) => void;
}) {
  const set = (patch: Partial<BeoAiReviewState>) => onChange({ ...state, ...patch });
  const pkg = packageOf(review, state.packageId.value);
  const proposedPkg = review.proposal.package;
  const groups = choiceGroupsOf(review, state.setMenuId.value);
  const count = (field: Reviewed<number> | null, key: "numChildren" | "numAdults", label: string) => (
    <Row label={label} field={field}>
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
  const time = (field: Reviewed<string> | null, key: "startTime" | "endTime", label: string) => (
    <Row label={label} field={field}>
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
        <Row label="Child" field={state.childName}>
          <Input
            className="h-8 flex-1 min-w-[10rem]"
            value={state.childName?.value ?? ""}
            onChange={(e) => set({ childName: edited(state.childName, e.target.value) })}
            data-testid="input-ai-review-childName"
          />
        </Row>
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
                <SourceMark field={{ from: review.ruling, changed: false }} />
              </div>
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
      </Section>

      <Section title="Package" icon={<Gift className="h-4 w-4" />}>
        <Row label="Package" field={state.packageId.value ? state.packageId : null}>
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
            <div key={line.id} className="flex items-center gap-2 text-sm flex-wrap" data-testid={`ai-review-addon-${line.id}`}>
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
          );
        })}
      </Section>

      <Section title="Kitchen Plan" icon={<Utensils className="h-4 w-4" />}>
        <Row label="Set menu" field={state.setMenuId.value ? state.setMenuId : null}>
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
                  if (!proposed?.said) return null;
                  return (
                    <div key={option} className="pl-[7.5rem] text-xs text-muted-foreground" data-testid="text-ai-review-match">
                      {beoAiMatchLabel(proposed.said, option, g.optionProductCodes[option] ?? g.productCode)}
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
        <Row label="Cake" field={state.cake}>
          <select
            className={SELECT}
            value={state.cake?.value.mode ?? ""}
            onChange={(e) =>
              set({
                cake: e.target.value
                  ? edited(state.cake, { notes: "", time: "", ...state.cake?.value, mode: e.target.value as BeoAiCakeMode })
                  : null,
              })
            }
            data-testid="select-ai-review-cake"
          >
            <option value="">Not said</option>
            {(Object.keys(CAKE_LABEL) as BeoAiCakeMode[]).map((m) => (
              <option key={m} value={m}>{CAKE_LABEL[m]}</option>
            ))}
          </select>
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
            <div key={o.key} className={cn("flex items-center gap-2 text-sm flex-wrap", freeLine(o.decision))} data-testid="ai-review-other-line">
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
          ))}
        </Section>
      )}

      {state.deposit && (
        <Section title="Deposit" icon={<Wallet className="h-4 w-4" />}>
          <Row label={state.deposit.value.paid ? "Deposit paid" : "Deposit asked"} field={state.deposit}>
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
  onClose,
  onFallback,
  onApproved,
}: {
  eventId: string;
  pending: BeoAiPending | null;
  /** SCRUM-814: the date the form holds, beside the one the confirmation names. */
  bookedDate: string | null;
  onClose: () => void;
  onFallback: (pending: BeoAiPending) => void;
  /**
   * After Approve and create is saved and the BEO read again: the part of the
   * same fill the approval does not write (`fillBeyondApproval`), for the
   * preview of before; null when there is none.
   */
  onApproved: (rest: Record<string, unknown> | null, pending: BeoAiPending) => void;
}) {
  const { toast } = useToast();
  const [state, setState] = useState<BeoAiReviewState | null>(null);
  const [opened, setOpened] = useState<BeoAiPending | null>(null);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (pending !== opened) {
    // A new proposal: the review starts from it.
    setOpened(pending);
    setState(pending ? initialReviewState(pending.review, { fill: pending.fill, bookedDate }) : null);
    setError(null);
  }
  if (!pending || !state) return null;
  const { review, source } = pending;
  const undecided = undecidedLines(state);
  const rest = fillBeyondApproval(pending.fill);
  // SCRUM-818: a message pasted into AI Fill, read as one line of the team's.
  const pasted = review.origin === "pasted";

  const approve = async () => {
    setApproving(true);
    setError(null);
    let body: BeoAiApproveBody;
    try {
      body = approveBodyOf(review, state, { conversationId: source?.conversationId ?? null, messageId: source?.messageId ?? null });
      await apiRequest("POST", `/api/events/${eventId}/beo/ai-fill/approve`, body);
    } catch (err: any) {
      setError(err?.message || "The BEO was not saved: the server could not be reached just now.");
      setApproving(false);
      return;
    }
    try {
      // The form reads the BEO again before the rest of the fill opens, so loading
      // the rest lands on what was approved, never under it.
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
    toast({ title: `BEO created from the ${pasted ? "pasted message" : "conversation"}`, description: `Saved: ${APPROVAL_WRITES}.` });
    setApproving(false);
    onApproved(fillBeyondApproval(pending.fill, body.otherLines), pending);
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
            <p className="flex items-center gap-1.5 flex-wrap">
              {pasted ? "Every field it fills is the team's:" : "Every field is the family's or the team's:"}
              <SourceMark field={{ from: { source: "team" }, changed: false }} />
              {!pasted && <SourceMark field={{ from: { source: "family" }, changed: false }} />}
              <SourceMark field={{ from: null, changed: true }} />
              {pasted ? "— a field you change is marked as changed here." : "— the family's are defaults for you to check."}
            </p>
          </div>
          <BeoAiReviewBody review={review} state={state} onChange={setState} />
          {review.finalMessage && (
            <p className="text-xs text-muted-foreground" data-testid="text-ai-review-final-message">
              Approve and create also puts the team's confirmation, word for word, in Final Message to Parent.
            </p>
          )}
          <p className="text-xs text-muted-foreground" data-testid="text-ai-review-leaves">
            {rest
              ? `Approve and create writes ${APPROVAL_WRITES}. It does not write ${APPROVAL_LEAVES}: what the ${pasted ? "pasted message" : "team's confirmation"} says of those opens next, to load into the editor as before and save.`
              : `Approve and create writes ${APPROVAL_WRITES}.`}
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
          <Button variant="outline" onClick={() => onFallback(pending)} disabled={approving} data-testid="button-ai-review-fallback">
            <ClipboardPaste className="h-4 w-4 mr-2" />
            Load into Editor instead
          </Button>
          <Button onClick={approve} disabled={approving || undecided > 0} data-testid="button-ai-review-approve">
            {approving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
            Approve and create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
