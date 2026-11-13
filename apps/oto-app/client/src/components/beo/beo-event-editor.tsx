import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EditableText } from "@/components/ui/editable-text";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { DatePicker } from "@/components/ui/date-picker";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { format, parseISO } from "date-fns";
import {
  CalendarDays,
  Users,
  Settings,
  UtensilsCrossed,
  Wine,
  Clock,
  Check,
  Circle,
  AlertCircle,
  User,
  Printer,
  Loader2,
  Save,
  Cake,
  ListTodo,
  Heart,
  MessageSquare,
  Trash2,
  Plus,
  Minus,
  X,
  Gift,
  Archive,
  ArchiveRestore,
  MapPin,
  Building2,
  DollarSign,
  Search,
  CheckCircle2,
  Sparkles,
  ClipboardPaste,
  Phone,
  Link2,
  ListChecks,
  RefreshCw,
  Download,
} from "lucide-react";
import { BeoTimelineEditor } from "./beo-timeline-editor";
import { BeoAiReviewDialog, SourceMark, type BeoAiPending } from "./beo-ai-review";
import { BeoFetchFromChatDialog } from "./beo-fetch-from-chat";
import { NO_DECLINED, fetchedMarksOf, type DeclinedChanges, type FetchAnswer, type FetchChange, type FetchFormValues, type FetchHeldCatalogue } from "@/lib/beo-fetch-from-chat";
import { aiFillCakeApply, aiFillCakeLine, aiFillCakeNotSaidNote, aiFillPartyDetailsShown } from "@/lib/beo-ai-preview";
import { legacyDepositFieldsOf } from "@shared/beoLegacyDeposit";
import { Checkbox } from "@/components/ui/checkbox";
import { CakeUnderNoCake } from "./beo-cake-under-no-cake";
import {
  REVIEW_TEAM_FIELDS,
  approvedSectionsOf,
  reviewTeamUnmatchedText,
  type ApprovedMarks,
  type ReviewHeld,
  type ReviewTeamField,
  type ReviewTeamProposal,
} from "@/lib/beo-ai-review";
import { BEO_AI_FROM_THE_CHAT, SET_MENU_CHOSEN_FROM_CHAT, choicesFromChatOnly } from "@shared/beoAiFill";
import { BeoPackageModule } from "./beo-package-module";
import { BeoParentExperienceModule } from "./beo-parent-experience-module";
import { PartyMenuItemDialog } from "./beo-party-menu-item";
import { BeoBillingSection, PartyDetailsTillTiles, tillBillingKey, useTillBilling } from "./beo-till-billing";
import { DEPOSIT_READ_AGAIN_MS, billingNamesDeposit, depositChangedIn, eventDepositOf, loadedDepositOf, sameOneDeposit, type EventDeposit } from "@/lib/beo-deposit-buffer";
import { depositMovedWords, type DepositSaveNote, type OneDeposit } from "@shared/partyDeposit";
import { beoBillingMutationScope } from "@/lib/beo-deposit-buffer";
import { bahtOfSatang, tillFiguresOf } from "@shared/tillBilling";
import type { PartyMenuLine } from "@shared/partyMenuItem";
import { isTemplateSetMenuLine, lineWithTillItem, lineWithoutTillItem } from "@shared/tillMenu";
import { TillCodeMark, TillMenuContext, TillMenuPick, tillCodeTitle, useTillMenu, useTillMenuIndex } from "./till-menu-picker";
import { isStartTime, needsStartTimeLine } from "@shared/eventStartTime";
import { ADULTS_SAME_AS_KIDS, adultsDifferOf, kitchenListsEqual, sameKitchenDishNames } from "@shared/kitchenAdults";
import { beoExtraChargeOf, beoKitchenChargesOf, type BeoExtraCharge } from "@shared/beoExtras";
import { BeoExtrasTotal, BeoPartyDateContext, ExtraPriceBox } from "./beo-extra-price";
import { ONE_OFF_EVENT_COLOR_OPTIONS } from "@/lib/event-types";
import { aiFillDateLine, dayLabel } from "@/lib/beo-ai-date";
import AssignmentSearchBar, { type AssignmentValue } from "@/components/core/AssignmentSearchBar";
import type { 
  Event, 
  BeoEventWithDetails, 
  BeoPartyHostAssignment,
  BeoSetupPlan,
  BeoKitchenPlan,
  BeoEventBilling,
} from "@shared/schema";

interface BeoEventEditorProps {
  eventId: string;
  onClose: () => void;
  onSave?: () => void;
  readOnly?: boolean;
  /**
   * SCRUM-660: "inbox" when the inbox's Create BEO opened this form: AI Fill
   * runs once on the conversation's confirmation message as it opens, into
   * the same preview a pasted message gets. Load into Editor writes only the
   * answer's timeline lines at once, as AI Fill always has; the rest waits for Save.
   */
  autoFill?: "inbox" | null;
  /** Told once the form has taken the auto fill, so it never runs twice. */
  onAutoFillTaken?: () => void;
}

/** What AI Fill proposes for a BEO field that assigns somebody (server/lib/beoTeamProposals.ts); the shapes live with the review (SCRUM-827). */
type AiTeamMatch = NonNullable<ReviewTeamProposal["match"]>;
type AiTeamProposal = ReviewTeamProposal;
type AiTeamField = ReviewTeamField;
type AiTeamProposals = Record<AiTeamField, AiTeamProposal | null>;
const AI_TEAM_FIELDS = REVIEW_TEAM_FIELDS;
const aiTeamUnmatchedText = reviewTeamUnmatchedText;

/** SCRUM-827: the chip a section wears once the chat filled it. */
function FromTheChat({ section }: { section: string }) {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400"
      data-testid={`ai-from-chat-${section}`}
    >
      {BEO_AI_FROM_THE_CHAT}
    </span>
  );
}

/** The inbox message an AI Fill read (Create BEO), shown above its preview so a person can check it. */
type AiFillInboxSource = {
  conversationId: string;
  messageId: string;
  body: string;
  authorName: string | null;
  sentAt: string | null;
  createdAt: string;
  /** Load into Editor also puts this message, as read, in Final Message to Parent (it was empty). */
  fillsFinalMessage?: boolean;
};

type SetupTask = {
  id: string;
  itemLabel: string;
  notes: string;
};

type MenuLine = {
  id: string;
  itemName: string;
  quantity: number;
  notes: string;
  included: boolean;
  price: number;
  source?: "set_menu" | "additional";
  groupId?: string;
  /** SCRUM-828: the till product a new item was made as; what the till's plan and slips find it by. */
  productCode?: string;
};

/** `qty` and `note` are the set menu's own (SCRUM-803); an older item has neither. */
type SetMenuTemplateItem =
  | { id: string; type: "always_included"; label: string; qty?: number | null; note?: string | null }
  | { id: string; type: "choice_group"; label: string; options: string[]; allowMultiple: boolean; qty?: number | null; note?: string | null };

type SetMenuTemplate = { id: string; name: string; items: SetMenuTemplateItem[]; isActive: boolean };

type PackageLineItem = {
  id: string;
  description: string;
  type: "included" | "extra";
  price: number;
  notes: string;
};

function SetMenuChoiceGroups({
  template,
  resolvedItems,
  hasResolved,
}: {
  template: Pick<SetMenuTemplate, "items">;
  resolvedItems: MenuLine[];
  hasResolved: boolean;
}) {
  const fixedItems = template.items.filter((item) => item.type === "always_included");
  const choiceGroups = template.items.filter((item) => item.type === "choice_group");
  const usedIds = new Set<string>();

  const fixedRows = fixedItems.map((item) => {
    const matched = resolvedItems.find((menuItem) =>
      menuItem.groupId === item.id ||
      (
        !menuItem.groupId &&
        menuItem.itemName === item.label &&
        (!menuItem.notes || !menuItem.notes.trim())
      ),
    );
    if (matched) usedIds.add(matched.id);
    return { item, matched };
  });

  const choiceRows = choiceGroups.map((group) => {
    const chosen = resolvedItems.filter((menuItem) => {
      const hasSavedGroup = menuItem.groupId === group.id;
      const isLegacyMatch =
        !menuItem.groupId &&
        menuItem.notes?.trim() === `(${group.label})`;
      if (hasSavedGroup || isLegacyMatch) {
        usedIds.add(menuItem.id);
        return true;
      }
      return false;
    });
    return { group, chosen };
  });

  const ungroupedItems = resolvedItems.filter((item) => !usedIds.has(item.id));

  return (
    <div className="p-3 space-y-2 border-b border-border/50">
      {fixedRows.length > 0 && (
        <div className="space-y-1" data-testid="set-menu-fixed-items">
          <p className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wide">Included items</p>
          {fixedRows.map(({ item, matched }) => (
            <div key={item.id} className="flex items-center gap-2 text-sm py-0.5">
              <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
              <span>{item.label}</span>
              {item.qty != null && <span className="font-medium" data-testid={`set-menu-item-qty-${item.id}`}>×{item.qty}</span>}
              {item.note && <span className="text-xs text-muted-foreground">{item.note}</span>}
              {hasResolved && !matched && (
                <span className="text-xs text-muted-foreground italic ml-1">not yet resolved</span>
              )}
              <Badge variant="outline" className="text-[10px] px-1.5 bg-emerald-500/10 text-emerald-600 border-emerald-500/30 ml-auto">Always</Badge>
            </div>
          ))}
        </div>
      )}

      {choiceRows.map(({ group, chosen }) => (
        <div key={group.id} className="flex items-start gap-2 text-sm py-0.5" data-testid={`set-menu-choice-group-${group.id}`}>
          {hasResolved && chosen.length > 0 ? (
            <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" />
          ) : (
            <Circle className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
          )}
          <div className="flex-1">
            <span className="font-medium">{group.label}</span>
            {group.qty != null && <span className="font-medium ml-1">×{group.qty}</span>}
            {hasResolved && chosen.length > 0 ? (
              <span className="text-emerald-600 ml-1" data-testid={`set-menu-choice-options-${group.id}`}>
                → {chosen.map((item) => item.itemName).join(", ")}
              </span>
            ) : (
              <span className="text-muted-foreground ml-1 italic">pending parent selection</span>
            )}
          </div>
          <Badge variant="outline" className="text-[10px] px-1.5 bg-blue-500/10 text-blue-600 border-blue-500/30 shrink-0">Choice</Badge>
        </div>
      ))}

      {ungroupedItems.length > 0 && (
        <div className="pt-1 space-y-1">
          <p className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wide">Other set menu items</p>
          {ungroupedItems.map((item) => (
            <div key={item.id} className="flex items-center gap-2 text-sm">
              <span>{item.itemName}</span>
              <Badge variant="outline" className="text-[10px] px-1.5 bg-blue-500/10 text-blue-600 border-blue-500/30">SET</Badge>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AiFillSection({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="border rounded-lg p-3 space-y-1.5">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        {icon}
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function AiFillRow({ label, value }: { label: string; value: any }) {
  if (value == null || value === "" || value === 0) return null;
  return (
    <div className="flex gap-2 text-sm">
      <span className="text-muted-foreground w-28 shrink-0">{label}:</span>
      <span className="font-medium">{String(value)}</span>
    </div>
  );
}

/**
 * One of Party Details' lines: what the POS team should know is included or
 * extra. It carries no price (SCRUM-822): what a party is charged is the
 * till's, read in the Billing section, so no price is typed here a second time.
 */
function PackageLineItemRow({ item, idx, packageItems, setPackageItems }: {
  item: PackageLineItem; idx: number; packageItems: PackageLineItem[]; setPackageItems: (items: PackageLineItem[]) => void;
}) {
  return (
    <div className="border rounded-md px-3 py-2 space-y-1.5" data-testid={`package-item-row-${idx}`}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border cursor-pointer transition-colors ${
            item.type === "included"
              ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/30 dark:text-emerald-400"
              : "bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400"
          }`}
          onClick={() => {
            const updated = [...packageItems];
            updated[idx] = { ...item, type: item.type === "included" ? "extra" : "included" };
            setPackageItems(updated);
          }}
          data-testid={`button-toggle-type-${idx}`}
        >
          {item.type === "included" ? "INCL" : "EXTRA"}
        </button>
        <EditableText
          className="flex-1 text-sm"
          value={item.description}
          onChange={(v) => {
            const updated = [...packageItems];
            updated[idx] = { ...item, description: v };
            setPackageItems(updated);
          }}
          onEnter={() => {
            const newItem: PackageLineItem = {
              id: `pi_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              description: "",
              type: item.type,
              price: 0,
              notes: "",
            };
            const updated = [...packageItems];
            updated.splice(idx + 1, 0, newItem);
            setPackageItems(updated);
            setTimeout(() => {
              const el = document.querySelector(`[data-testid="input-package-item-${idx + 1}"]`) as HTMLElement;
              if (el) el.click();
            }, 50);
          }}
          placeholder="e.g., 25 Extra Adults, Bubble Show, Neon Disco Party..."
          data-testid={`input-package-item-${idx}`}
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={() => {
            const updated = [...packageItems];
            updated[idx] = { ...item, notes: item.notes ? "" : " " };
            setPackageItems(updated);
          }}
          data-testid={`button-toggle-item-notes-${idx}`}
        >
          <MessageSquare className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
          onClick={() => setPackageItems(packageItems.filter((_, i) => i !== idx))}
          data-testid={`button-remove-item-${idx}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      {item.notes !== undefined && item.notes !== "" && (
        <EditableText
          className="text-xs ml-14"
          value={item.notes.trim()}
          onChange={(v) => {
            const updated = [...packageItems];
            updated[idx] = { ...item, notes: v };
            setPackageItems(updated);
          }}
          placeholder="Item note..."
          data-testid={`input-item-notes-${idx}`}
        />
      )}
    </div>
  );
}

function MenuLineItemRow({ item, idx, menuItems, setMenuItems, menuTab, charge }: {
  item: MenuLine; idx: number; menuItems: MenuLine[]; setMenuItems: React.Dispatch<React.SetStateAction<MenuLine[]>>; menuTab: string;
  /** SCRUM-949: the line's charge as its list decides it (the adults' copy of a kids' line). */
  charge?: BeoExtraCharge;
}) {
  const tillMenu = useTillMenuIndex();
  return (
    <div className="space-y-0.5" data-testid={`menu-item-${menuTab}-${idx}`}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border transition-colors ${
            item.source === "set_menu"
              ? "bg-blue-500/15 text-blue-600 border-blue-500/30 dark:text-blue-400 cursor-pointer"
              : "bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400 cursor-pointer"
          }`}
          onClick={() => {
            setMenuItems(prev => {
              const updated = [...prev];
              updated[idx] = { ...updated[idx], source: updated[idx].source === "set_menu" ? undefined : "set_menu" };
              return updated;
            });
          }}
          data-testid={`badge-menu-incl-${menuTab}-${idx}`}
        >
          {item.source === "set_menu" ? "SET" : "EXTRA"}
        </button>
        <Button
          variant="outline"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => {
            setMenuItems(prev => {
              const updated = [...prev];
              updated[idx] = { ...updated[idx], quantity: Math.max(1, updated[idx].quantity - 1) };
              return updated;
            });
          }}
          data-testid={`button-qty-minus-${menuTab}-${idx}`}
        >
          <Minus className="h-3 w-3" />
        </Button>
        <span className="w-6 text-center text-xs font-medium shrink-0" data-testid={`text-menu-qty-${menuTab}-${idx}`}>
          {item.quantity}
        </span>
        <Button
          variant="outline"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => {
            setMenuItems(prev => {
              const updated = [...prev];
              updated[idx] = { ...updated[idx], quantity: updated[idx].quantity + 1 };
              return updated;
            });
          }}
          data-testid={`button-qty-plus-${menuTab}-${idx}`}
        >
          <Plus className="h-3 w-3" />
        </Button>
        {/* SCRUM-949: an EXTRA line's price for each item, beside its count; never on a SET line. */}
        {item.source !== "set_menu" && (
          <ExtraPriceBox
            line={item}
            area="food"
            charge={charge}
            onPrice={(price) => setMenuItems(prev => prev.map((line, i) => (i === idx ? { ...line, price } : line)))}
            testId={`${menuTab}-${idx}`}
          />
        )}
        <div className="flex-1 flex items-center gap-1 min-w-0">
        <EditableText
          className="text-xs min-w-0"
          value={item.itemName}
          onChange={(v) => {
            setMenuItems(prev => {
              const updated = [...prev];
              updated[idx] = { ...updated[idx], itemName: v };
              return updated;
            });
          }}
          onEnter={() => {
            const newItem: MenuLine = {
              id: `menu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              itemName: "",
              quantity: 1,
              notes: "",
              included: item.included,
              price: 0,
            };
            setMenuItems(prev => {
              const updated = [...prev];
              updated.splice(idx + 1, 0, newItem);
              return updated;
            });
            setTimeout(() => {
              const el = document.querySelector(`[data-testid="input-menu-name-${menuTab}-${idx + 1}"]`) as HTMLElement;
              if (el) el.click();
            }, 50);
          }}
          placeholder="Item name"
          data-testid={`input-menu-name-${menuTab}-${idx}`}
        />
        {/* SCRUM-905: the till's own item for this line: its name and code written on, free typing kept.
            Not on a set-menu dish the template resolved: its code is the template's (Settings > Set menu templates). */}
        {!isTemplateSetMenuLine(item) && (
          <TillMenuPick
            code={item.productCode}
            onPick={(picked) => setMenuItems(prev => prev.map((line, i) => (i === idx ? lineWithTillItem(line, picked) : line)))}
            onClear={() => setMenuItems(prev => prev.map((line, i) => (i === idx ? lineWithoutTillItem(line) : line)))}
            testId={`button-till-menu-${menuTab}-${idx}`}
          />
        )}
        {item.source === "set_menu" && item.notes?.trim() && (
          <span className="text-xs text-muted-foreground shrink-0">{item.notes.trim()}</span>
        )}
        {item.productCode && (
          <span
            className="text-[10px] font-mono text-muted-foreground shrink-0"
            title={tillCodeTitle(tillMenu, item.productCode)}
            data-testid={`text-menu-code-${menuTab}-${idx}`}
          >
            {item.productCode}
          </span>
        )}
        <TillCodeMark code={item.productCode} testId={`text-menu-code-dead-${menuTab}-${idx}`} />
        </div>
        {!item.notes && (
          <button
            className="h-7 w-7 shrink-0 flex items-center justify-center text-muted-foreground hover:text-foreground rounded-md hover:bg-accent"
            onClick={() => {
              setMenuItems(prev => {
                const updated = [...prev];
                updated[idx] = { ...updated[idx], notes: " " };
                return updated;
              });
              setTimeout(() => {
                const el = document.querySelector(`[data-testid="input-menu-notes-${menuTab}-${idx}"]`) as HTMLInputElement;
                if (el) { el.value = ""; el.focus(); }
              }, 50);
            }}
            data-testid={`button-add-menu-notes-${menuTab}-${idx}`}
            title="Add note"
          >
            <MessageSquare className="h-3 w-3" />
          </button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-destructive hover:text-destructive"
          onClick={() => setMenuItems(menuItems.filter((_, i) => i !== idx))}
          data-testid={`button-remove-menu-item-${menuTab}-${idx}`}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
      {item.notes && item.source !== "set_menu" && (
        <div className="flex items-center gap-1 pl-[3.25rem]">
          <EditableText
            className="flex-1 text-xs"
            value={item.notes}
            onChange={(v) => {
              setMenuItems(prev => {
                const updated = [...prev];
                updated[idx] = { ...updated[idx], notes: v };
                return updated;
              });
            }}
            placeholder="Notes..."
            data-testid={`input-menu-notes-${menuTab}-${idx}`}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 text-muted-foreground"
            onClick={() => {
              setMenuItems(prev => {
                const updated = [...prev];
                updated[idx] = { ...updated[idx], notes: "" };
                return updated;
              });
            }}
            data-testid={`button-clear-menu-notes-${menuTab}-${idx}`}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
}

export function BeoEventEditor({ eventId, onClose, onSave, readOnly = false, autoFill = null, onAutoFillTaken }: BeoEventEditorProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const [expandedSections, setExpandedSections] = useState<string[]>(["event-info"]);
  const [isSaving, setIsSaving] = useState(false);
  
  const [showStartTimePicker, setShowStartTimePicker] = useState(false);
  const [showEndTimePicker, setShowEndTimePicker] = useState(false);
  const [tempStartTime, setTempStartTime] = useState("10:00");
  const [tempEndTime, setTempEndTime] = useState("12:00");
  const [timeError, setTimeError] = useState<string | null>(null);

  const [eventData, setEventData] = useState<Partial<Event>>({});
  const [partyHost, setPartyHost] = useState<Partial<BeoPartyHostAssignment>>({});
  const [packageName, setPackageName] = useState("");
  // SCRUM-822: kept as saved (no input types it any more): the till prices the party.
  const [packageBasePrice, setPackageBasePrice] = useState<number>(0);
  const [packageItems, setPackageItems] = useState<PackageLineItem[]>([]);
  const [prepaymentReceived, setPrepaymentReceived] = useState<number>(0);
  const [depositDate, setDepositDate] = useState("");
  const [packageNotes, setPackageNotes] = useState("");
  const [setupTasks, setSetupTasks] = useState<SetupTask[]>([]);
  const [setupReadyBy, setSetupReadyBy] = useState("");
  const [setupResponsible, setSetupResponsible] = useState("");
  const [setupResponsibleId, setSetupResponsibleId] = useState<string | null>(null);
  const [setupResponsibleType, setSetupResponsibleType] = useState<string | null>(null);
  const [setupNotes, setSetupNotes] = useState("");
  const [beoTasks, setBeoTasks] = useState<any[]>([]);
  const [kitchenRequired, setKitchenRequired] = useState(true);
  const [kidsMenu, setKidsMenu] = useState<MenuLine[]>([]);
  const [adultsMenu, setAdultsMenu] = useState<MenuLine[]>([]);
  // SCRUM-829: "Different for adults". Off, the adults eat the kids' menu and adultsMenu is
  // not shown or saved; on, adultsMenu is the adults' own list, started as a copy of the kids'.
  const [adultsDiffer, setAdultsDiffer] = useState(false);
  const [barItems, setBarItems] = useState<MenuLine[]>([]);
  const [barServiceTime, setBarServiceTime] = useState("");
  const [showBarTimePicker, setShowBarTimePicker] = useState(false);
  const [tempBarTime, setTempBarTime] = useState("12:00");
  const [menuTab, setMenuTab] = useState<"kids" | "adults">("kids");
  // SCRUM-828: the food list a "New item" is being made for; null while its dialog is closed.
  const [newItemMenu, setNewItemMenu] = useState<"kids" | "adults" | null>(null);
  const [setMenuEnabled, setSetMenuEnabled] = useState(false);
  const [setMenuTemplateId, setSetMenuTemplateId] = useState<string>("");
  const [showParentLinkDialog, setShowParentLinkDialog] = useState(false);
  const [kidsFoodTime, setKidsFoodTime] = useState("");
  const [adultsFoodTime, setAdultsFoodTime] = useState("");
  const [cakeMode, setCakeMode] = useState<string>("NONE");
  const [cakeQuantity, setCakeQuantity] = useState<number>(1);
  const [cakeNotes, setCakeNotes] = useState("");
  const [cakeTime, setCakeTime] = useState("");
  const [cakePrice, setCakePrice] = useState<number>(0);
  const [cakeIncluded, setCakeIncluded] = useState(true);
  const [locationText, setLocationText] = useState("");
  const [setupResponsibleSearch, setSetupResponsibleSearch] = useState("");
  const [showResponsibleDropdown, setShowResponsibleDropdown] = useState(false);
  const [showFoodTimePicker, setShowFoodTimePicker] = useState(false);
  const [tempFoodTime, setTempFoodTime] = useState("12:00");
  const [foodTimeTarget, setFoodTimeTarget] = useState<"kids" | "adults">("kids");
  const [showCakeTimePicker, setShowCakeTimePicker] = useState(false);
  const [tempCakeTime, setTempCakeTime] = useState("14:00");
  const [showReadyByTimePicker, setShowReadyByTimePicker] = useState(false);
  const [tempReadyByTime, setTempReadyByTime] = useState("09:00");
  const [showAiFill, setShowAiFill] = useState(false);
  const [aiFillStep, setAiFillStep] = useState<"paste" | "preview">("paste");
  const [aiFillText, setAiFillText] = useState("");
  const [aiFillParsed, setAiFillParsed] = useState<any>(null);
  const [aiFillLoading, setAiFillLoading] = useState(false);
  const [aiFillError, setAiFillError] = useState<string | null>(null);
  // SCRUM-660: the team AI Fill proposes is only assigned where a person ticks it.
  const [aiFillAccepted, setAiFillAccepted] = useState<Set<AiTeamField>>(new Set());
  // SCRUM-814: the date the message names replaces the booked one only where a person ticks it.
  const [aiFillUseDate, setAiFillUseDate] = useState(false);
  const [aiFillDepositConfirmed, setAiFillDepositConfirmed] = useState(false);
  // SCRUM-660: Create BEO's AI Fill — the inbox message it read, and why it did not run.
  const [aiFillSource, setAiFillSource] = useState<AiFillInboxSource | null>(null);
  const [aiFillNotice, setAiFillNotice] = useState<string | null>(null);
  const [aiFillInboxRunning, setAiFillInboxRunning] = useState(false);
  const [autoFillReady, setAutoFillReady] = useState(false);
  const autoFillTaken = useRef(false);
  // SCRUM-815: Create BEO's AI Fill matched to the park's catalogue, reviewed in edit mode before anything is written.
  const [aiReview, setAiReview] = useState<BeoAiPending | null>(null);
  // SCRUM-827: once the review's one pass is approved, where each filled field came from — the mark
  // it wears here until it is edited — and the sections the chat filled, which wear "from the chat".
  const [aiMarks, setAiMarks] = useState<ApprovedMarks>({});
  const aiSections = useMemo(() => approvedSectionsOf(aiMarks), [aiMarks]);
  const aiMark = (field: string) => {
    const source = aiMarks[field];
    if (!source) return null;
    return <SourceMark field={source === "staff" ? { from: null, changed: true } : { from: { source }, changed: false }} />;
  };
  /** A marked field the person edits is theirs now. */
  const aiTouched = (field: string) => {
    setAiMarks((m) => (m[field] && m[field] !== "staff" ? { ...m, [field]: "staff" } : m));
  };
  /** The Setup Who wears either mark (a person ticked, or a name typed); an edit lets both go. */
  const aiTouchedSetupWho = () => { aiTouched("setupResponsible"); aiTouched("team:setupResponsible"); };
  const aiSectionMark = (section: string) => (aiSections.includes(section) ? <FromTheChat section={section} /> : null);
  // SCRUM-826: "Fetch from chat" — its dialog, and the changes declined on it (held until the chat changes).
  const [fetchOpen, setFetchOpen] = useState(false);
  const [fetchDeclined, setFetchDeclined] = useState<DeclinedChanges>(NO_DECLINED);
  const responsibleSearchRef = useRef<HTMLInputElement>(null);

  const { data: entertainmentItems = [] } = useQuery<any[]>({
    queryKey: ["/api/events", eventId, "beo", "entertainment-items"],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/beo/entertainment-items`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!eventId,
  });

  const addEntItemMutation = useMutation({
    mutationFn: async (data: { customName: string; startTime?: string }) => {
      const res = await apiRequest("POST", `/api/events/${eventId}/beo/entertainment-items`, {
        ...data,
        sortOrder: entertainmentItems.length,
      });
      if (!res.ok) throw new Error("Failed to add entertainment item");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "beo", "entertainment-items"] }),
    onError: () => toast({ title: "Failed to add entertainment", variant: "destructive" }),
  });

  const updateEntItemMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<{ customName: string; startTime: string | null }> }) => {
      const res = await apiRequest("PUT", `/api/events/${eventId}/beo/entertainment-items/${id}`, data);
      if (!res.ok) throw new Error("Failed to update entertainment item");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "beo", "entertainment-items"] }),
    onError: () => toast({ title: "Failed to update entertainment", variant: "destructive" }),
  });

  const deleteEntItemMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/events/${eventId}/beo/entertainment-items/${id}`);
      if (!res.ok) throw new Error("Failed to delete entertainment item");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "beo", "entertainment-items"] }),
    onError: () => toast({ title: "Failed to remove entertainment", variant: "destructive" }),
  });

  const wasAwaitingParentSelection = useRef(false);

  const { data: beoData, isLoading, error: beoError } = useQuery<BeoEventWithDetails>({
    queryKey: ["/api/events", eventId, "beo"],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/beo`, { credentials: "include" });
      if (res.status === 401) throw new Error("Session expired. Open the OTO App from the launcher again to sign in.");
      if (!res.ok) throw new Error("Failed to fetch BEO data");
      return res.json();
    },
    enabled: !!eventId,
    retry: false,
    refetchOnWindowFocus: true,
  });

  // SCRUM-822: the party's money is the till's. The Billing section, the
  // Party Details box and the header read these figures; none is worked out here.
  // Read live: afresh when the BEO opens or the window comes back, and every minute while it is open.
  const tillBilling = useTillBilling(eventId);
  const tillFigures = tillFiguresOf(tillBilling.data);
  const canManageBilling = !readOnly && ["global_admin", "operator_admin", "admin", "manager"].includes(user?.role ?? "");
  const billingKey = ["/api/events", eventId, "beo", "billing"] as const;
  const { data: billingRow = null } = useQuery<BeoEventBilling | null>({ queryKey: billingKey, enabled: !!eventId });
  /**
   * SCRUM-840: the party's one deposit as this form last read it from the server (the BEO's read,
   * a billing write's answer, the deposit read again). Save and the Billing section send it back,
   * and Save says the person changed the deposit only when Party Details' is no longer this one.
   */
  const loadedDeposit = useRef<OneDeposit>({ amountThb: 0, date: null });
  /** The newest press of the billing module: an older answer arriving late never overwrites a newer one. */
  const billingPress = useRef(0);
  const billingMutation = useMutation({
    // The party's billing writes reach the server one at a time, in the order they were sent:
    // the deposit the till reads is the last one typed (BeoBillingSection sends it once).
    scope: beoBillingMutationScope(eventId),
    mutationFn: async ({ patch }: { patch: Partial<BeoEventBilling>; press: number }) => {
      // SCRUM-840: a deposit typed here travels with the deposit this BEO last read, so one that
      // moved meanwhile (the family paid through the chat) is kept and said, never written over.
      const body = billingNamesDeposit(patch) ? { ...patch, expectedDeposit: loadedDeposit.current } : patch;
      const res = await apiRequest("PUT", `/api/events/${eventId}/beo/billing`, body);
      return (await res.json()) as BeoEventBilling & { oneDeposit?: OneDeposit; depositSave?: DepositSaveNote };
    },
    onMutate: ({ patch }) => {
      queryClient.setQueryData<BeoEventBilling | null>(billingKey, (was) => (was ? { ...was, ...patch } : was));
    },
    onSuccess: (answer, { patch, press }) => {
      const { oneDeposit: depositNow, depositSave, ...written } = answer;
      const row = written as BeoEventBilling;
      // The deposit as the server holds it after this write is the one a later Save is judged by.
      if (depositNow) loadedDeposit.current = loadedDepositOf({ oneDeposit: depositNow });
      if (depositSave) {
        setPrepaymentReceived(depositSave.amountThb);
        setDepositDate(depositSave.date ?? "");
        setDepositReadAgain(depositSave.amountThb > 0 ? { amountThb: depositSave.amountThb, date: depositSave.date } : null);
        toast({ title: "The deposit was not changed", description: depositSave.message });
        void queryClient.invalidateQueries({ queryKey: billingKey, exact: true });
        void queryClient.invalidateQueries({ queryKey: tillBillingKey(eventId) });
        return;
      }
      if (press !== billingPress.current) return;
      queryClient.setQueryData(billingKey, row);
      if (billingNamesDeposit(patch)) {
        // SCRUM-813: one deposit. Party Details shows what the billing just wrote, so a later Save keeps it.
        setPrepaymentReceived(row.depositPaid ? (row.depositPaidAmount ?? 0) : 0);
        const paidAt: unknown = row.depositPaidAt;
        setDepositDate(typeof paidAt === "string" ? paidAt.slice(0, 10) : paidAt instanceof Date ? paidAt.toISOString().slice(0, 10) : "");
      }
      void queryClient.invalidateQueries({ queryKey: tillBillingKey(eventId) });
    },
    onError: (error: Error) => {
      toast({ title: "The billing was not saved", description: error.message, variant: "destructive" });
      void queryClient.invalidateQueries({ queryKey: billingKey });
    },
  });
  /** One billing write; settles when the server has answered, so the Billing section knows its deposit has landed. */
  const changeBilling = (patch: Partial<BeoEventBilling>) => {
    billingPress.current += 1;
    return billingMutation.mutateAsync({ patch, press: billingPress.current });
  };

  // SCRUM-839: while the party has no billing record the Financial Summary reads the event's own
  // deposit, as the BEO's read carries it. A deposit paid through the chat while the BEO is open
  // is read again on its own (no other field of the form is reloaded): the summary and Party
  // Details take the paid figure, so a later Save keeps it.
  const [depositReadAgain, setDepositReadAgain] = useState<EventDeposit | null | undefined>(undefined);
  useEffect(() => {
    setDepositReadAgain(undefined);
    // SCRUM-840: the deposit this form was opened with (the party's one deposit as the read says it).
    if (beoData) loadedDeposit.current = loadedDepositOf(beoData as Parameters<typeof loadedDepositOf>[0]);
  }, [beoData]);
  const eventDeposit = depositReadAgain !== undefined ? depositReadAgain : eventDepositOf(beoData);
  const readDepositAgain = async () => {
    void queryClient.invalidateQueries({ queryKey: billingKey, exact: true });
    try {
      const res = await fetch(`/api/events/${eventId}/beo`, { credentials: "include" });
      if (!res.ok) return;
      const read = (await res.json()) as {
        prepaymentAmount?: unknown;
        prepaymentDate?: unknown;
        oneDeposit?: { amountThb?: unknown; date?: unknown } | null;
        partyDetails?: { prepaymentReceived?: unknown; depositDate?: unknown } | null;
      };
      // A Save or a billing write of this screen's own on its way: its answer says the deposit, not this read.
      if (billingMutation.isPending || saveMutation.isPending) return;
      setDepositReadAgain(eventDepositOf(read));
      // SCRUM-840: Party Details takes the stored deposit whenever it is no longer the one this
      // form last read, whatever the field holds (a paid deposit is a fact, not a draft), and
      // says so. The deposit a later Save is judged by moves with it.
      const now = loadedDepositOf(read);
      if (!sameOneDeposit(now, loadedDeposit.current)) {
        loadedDeposit.current = now;
        setPrepaymentReceived(now.amountThb);
        setDepositDate(now.date ?? "");
        toast({ title: "Deposit updated", description: depositMovedWords(now.amountThb, "BEO") });
      }
    } catch {
      // The next read of the BEO shows it.
    }
  };
  // SCRUM-840: the stored deposit is read again while the BEO is open, the Billing section open
  // or not: when the window comes back, and when the till's figures (read every minute) show a
  // deposit that is not the one this form last read.
  const readDepositAgainRef = useRef(readDepositAgain);
  readDepositAgainRef.current = readDepositAgain;
  const beoRead = !!beoData;
  const tillDepositSatang = tillFigures && tillFigures.kind === "quote" ? tillFigures.depositSatang : null;
  const depositReadAt = useRef(0);
  useEffect(() => {
    if (readOnly || !beoRead) return;
    const onFocus = () => {
      // A window flicked back and forth asks once.
      if (Date.now() - depositReadAt.current < DEPOSIT_READ_AGAIN_MS) return;
      depositReadAt.current = Date.now();
      void readDepositAgainRef.current();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [readOnly, beoRead]);
  useEffect(() => {
    if (readOnly || !beoRead || tillDepositSatang === null) return;
    if (tillDepositSatang !== loadedDeposit.current.amountThb * 100) void readDepositAgainRef.current();
  }, [readOnly, beoRead, tillDepositSatang]);

  const { data: branches } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const { data: locations } = useQuery<{ id: string; name: string; capacity?: number | null }[]>({
    queryKey: ["/api/beo/locations", { branchId: beoData?.branchId }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (beoData?.branchId) params.append("branchId", beoData.branchId);
      const res = await fetch(`/api/beo/locations?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch locations");
      return res.json();
    },
    enabled: !!beoData?.branchId,
  });

  // SCRUM-905: the till's menu at the party's park, for the kitchen and bar plan pickers and
  // their "No longer on the till" marks; asked once either section is open.
  const tillMenu = useTillMenu(beoData?.branchId, {
    enabled: expandedSections.includes("kitchen-plan") || expandedSections.includes("bar-plan"),
    editable: !readOnly,
  });

  const { data: partyHostsData } = useQuery<{ source: "employee" | "user"; items: Array<{ id: string; fullName: string; nickname?: string | null }> }>({
    queryKey: ["/api/beo/party-hosts"],
  });
  const allEmployees = partyHostsData?.items;
  const partyHostSource = partyHostsData?.source ?? "employee";

  const { data: allDepartments } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ["/api/departments"],
  });

  type SetMenuSelectionRecord = { id: string; eventId: string; templateId: string; token: string; isSubmitted: boolean; submittedAt: string | null; selections: any };

  const { data: setMenuTemplates = [] } = useQuery<SetMenuTemplate[]>({
    queryKey: ["/api/beo/set-menu-templates"],
  });

  const { data: setMenuSelection, refetch: refetchSetMenuSelection } = useQuery<SetMenuSelectionRecord | null>({
    queryKey: ["/api/beo/set-menu-selections", eventId],
    queryFn: async () => {
      const res = await fetch(`/api/beo/set-menu-selections/${eventId}`, { credentials: "include" });
      if (res.status === 404) return null;
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!eventId && setMenuEnabled,
    retry: false,
    refetchInterval: (query) => query.state.data && !query.state.data.isSubmitted ? 5000 : false,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    const isAwaiting = setMenuSelection?.isSubmitted === false;
    const wasAwaiting = wasAwaitingParentSelection.current;
    wasAwaitingParentSelection.current = isAwaiting;

    if (wasAwaiting && !isAwaiting && setMenuSelection?.isSubmitted) {
      queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "beo"] });
    }
  }, [eventId, setMenuSelection]);

  const generateLinkMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/beo/set-menu-selections", { eventId, templateId: setMenuTemplateId });
      if (!res.ok) throw new Error("Failed to generate link");
      return res.json();
    },
    onSuccess: () => {
      refetchSetMenuSelection();
      setShowParentLinkDialog(true);
    },
    onError: () => toast({ title: "Failed to generate link", variant: "destructive" }),
  });

  const resetSelectionMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/beo/set-menu-selections/${eventId}/reset`);
      if (!res.ok) throw new Error("Failed to reset");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "beo"] });
      refetchSetMenuSelection();
      toast({ title: "Selections reset" });
    },
    onError: () => toast({ title: "Failed to reset selections", variant: "destructive" }),
  });

  const parentLinkUrl = setMenuSelection ? `${window.location.origin}/menu-select/${setMenuSelection.token}` : "";

  useEffect(() => {
    if (beoData) {
      setEventData({
        title: beoData.title,
        eventDate: beoData.eventDate,
        startTime: beoData.startTime,
        endTime: beoData.endTime,
        durationMinutes: beoData.durationMinutes,
        numChildren: beoData.numChildren,
        numAdults: beoData.numAdults,
        locationId: beoData.locationId,
        activities: beoData.activities,
        decoration: beoData.decoration,
        // SCRUM-827: Special Requests is a field of the form now (it was written by AI Fill and never shown here).
        specialRequests: beoData.specialRequests,
        internalStaffNotes: beoData.internalStaffNotes,
        childName: beoData.childName,
        bookingName: beoData.bookingName || beoData.parentName,
        whatsappPhoneRaw: beoData.whatsappPhoneRaw || beoData.whatsappPhoneE164,
        kidTurningAge: (beoData as any).kidTurningAge ?? undefined,
        eventType: (beoData as any).eventType,
        color: (beoData as any).color,
      } as any);
      setLocationText((beoData as any).locationText || "");
      if (beoData.partyHost) setPartyHost(beoData.partyHost);

      const sp = beoData.setupPlan as any;
      if (sp) {
        const spTasks = sp.setupTasks;
        if (spTasks && typeof spTasks === "object" && !Array.isArray(spTasks)) {
          setSetupReadyBy(spTasks.readyBy || "");
          setSetupResponsible(spTasks.responsible || "");
          setSetupResponsibleId(spTasks.responsibleId || null);
          setSetupResponsibleType(spTasks.responsibleType || null);
          if (Array.isArray(spTasks.simplifiedTasks)) {
            setSetupTasks(spTasks.simplifiedTasks.map((t: any) => ({
              id: t.id,
              itemLabel: t.itemLabel || "",
              notes: t.notes || "",
            })));
          }
        } else if (Array.isArray(spTasks)) {
          setSetupTasks(spTasks.map((t: any) => ({
            id: t.id,
            itemLabel: t.itemLabel || "",
            notes: t.notes || "",
          })));
        }
        if (sp.readyBy) setSetupReadyBy(sp.readyBy);
        if (sp.responsible) setSetupResponsible(sp.responsible);
        if (sp.simplifiedTasks && Array.isArray(sp.simplifiedTasks)) {
          setSetupTasks(sp.simplifiedTasks.map((t: any) => ({
            id: t.id,
            itemLabel: t.itemLabel || "",
            notes: t.notes || "",
          })));
        }
        setSetupNotes(sp.setupNotes || "");
      }

      const kp = beoData.kitchenPlan as any;
      if (kp) {
        setKitchenRequired(kp.foodRequired !== false);
        setCakeMode(kp.cakeMode || "NONE");
        setCakeQuantity(kp.cakeQuantity ?? 1);
        setCakeNotes(kp.cakeNotes || "");
        setCakeTime(kp.cakeTime || "");
        setSetMenuEnabled(kp.setMenuEnabled ?? false);
        setSetMenuTemplateId(kp.setMenuTemplateId || "");
        const menus = kp.menus;
        if (menus && typeof menus === "object") {
          setCakePrice(menus.cakePrice || 0);
          setCakeIncluded(menus.cakeIncluded !== false);
          setKidsFoodTime(menus.kidsFoodTime || "");
          setAdultsFoodTime(menus.adultsFoodTime || "");
          const mapMenu = (m: any) => ({
            id: m.id,
            itemName: m.itemName || "",
            quantity: m.quantity || 1,
            notes: m.notes || "",
            included: m.includedInPackage ?? m.included ?? true,
            price: m.price || 0,
            source: m.source,
            groupId: m.groupId,
            // SCRUM-828: a new item's till code rides with its line through every Save.
            ...(typeof m.productCode === "string" && m.productCode.trim() ? { productCode: m.productCode.trim() } : {}),
          });
          if (Array.isArray(menus.kids)) setKidsMenu(menus.kids.map(mapMenu));
          if (Array.isArray(menus.adults)) setAdultsMenu(menus.adults.map(mapMenu));
        }
        if (kp.cakePrice !== undefined) setCakePrice(kp.cakePrice);
        if (kp.cakeIncluded !== undefined) setCakeIncluded(kp.cakeIncluded);
        if (kp.simplifiedMenus) {
          // New saves always use menus. Keep this fallback for records returned by
          // older BEO endpoints, but never let stale legacy data override it.
          if (!Array.isArray(menus?.kids) && Array.isArray(kp.simplifiedMenus.kids)) setKidsMenu(kp.simplifiedMenus.kids.map((m: any) => ({ ...m, price: m.price || 0, source: m.source, groupId: m.groupId })));
          if (!Array.isArray(menus?.adults) && Array.isArray(kp.simplifiedMenus.adults)) setAdultsMenu(kp.simplifiedMenus.adults.map((m: any) => ({ ...m, price: m.price || 0, source: m.source, groupId: m.groupId })));
        }
        // SCRUM-829: the switch as saved; a BEO saved before it opens on only when its adults'
        // list holds lines that are not the kids' list, off when it is empty or the same.
        setAdultsDiffer(adultsDifferOf({
          kids: Array.isArray(menus?.kids) ? menus.kids : kp.simplifiedMenus?.kids,
          adults: Array.isArray(menus?.adults) ? menus.adults : kp.simplifiedMenus?.adults,
          adultsDiffer: menus?.adultsDiffer,
        }));
      }

      const bp = (beoData as any).barPlan;
      if (bp) {
        setBarServiceTime(bp.serviceTime || "");
        const mapBarItem = (m: any) => ({
          id: m.id || `bar_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          itemName: m.itemName || "",
          quantity: m.quantity || 1,
          notes: m.notes || "",
          included: false,
          price: m.price || 0,
          source: m.source,
          // SCRUM-905: a drink picked from the till's menu keeps its till code through every Save.
          ...(typeof m.productCode === "string" && m.productCode.trim() ? { productCode: m.productCode.trim() } : {}),
        });
        if (Array.isArray(bp.items)) setBarItems(bp.items.map(mapBarItem));
      }

      const pd = (beoData as any).partyDetails;
      if (pd) {
        setPackageName(pd.packageName || "");
        setPackageBasePrice(pd.packageBasePrice || 0);
        if (Array.isArray(pd.items)) setPackageItems(pd.items);
        setPrepaymentReceived(pd.prepaymentReceived || 0);
        setDepositDate(pd.depositDate || "");
        setPackageNotes(pd.notes || "");
      }

      if ((beoData as any).beoTasks) {
        setBeoTasks((beoData as any).beoTasks);
      }
    }
  }, [beoData]);

  const archiveMutation = useMutation({
    mutationFn: async ({ id, archived }: { id: string; archived: boolean }) => {
      const res = await apiRequest("POST", `/api/admin/events/${id}/archive`, { archived });
      return res.json();
    },
    onSuccess: (_, { archived }) => {
      queryClient.invalidateQueries({ predicate: (query) => 
        Array.isArray(query.queryKey) && (query.queryKey[0] === "/api/admin/events" || query.queryKey[0] === "/api/events")
      });
      toast({ title: archived ? "Event archived" : "Event restored" });
      onClose();
    },
    onError: (error: Error) => {
      toast({ title: "Failed to archive event", description: error.message, variant: "destructive" });
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        event: { ...eventData, locationText },
        partyHost,
        entertainment: { entertainmentRequired: false },
        setupPlan: {
          setupRequired: setupTasks.length > 0 || !!setupReadyBy,
          readyBy: setupReadyBy,
          responsible: setupResponsible,
          responsibleId: setupResponsibleId,
          responsibleType: setupResponsibleType,
          setupNotes,
          simplifiedTasks: setupTasks,
          setupTasks: [],
        },
        kitchenPlan: {
          foodRequired: kitchenRequired,
          cakeMode,
          cakeQuantity,
          cakeNotes,
          cakeTime,
          cakePrice,
          cakeIncluded,
          setMenuEnabled,
          setMenuTemplateId: setMenuTemplateId || null,
          setMenuSelectionSubmittedAt: beoData?.kitchenPlan?.setMenuSelectionStatus?.submittedAt ?? null,
          // SCRUM-829: with the switch off the adults' list IS the kids' list, so none is saved for them.
          menus: { kids: kidsMenu, adults: adultsDiffer ? adultsMenu : [], adultsDiffer, kidsFoodTime, adultsFoodTime },
          serviceSchedule: [],
        },
        barPlan: {
          serviceTime: barServiceTime,
          items: barItems,
        },
        billing: {},
        partyDetails: {
          packageName,
          packageBasePrice,
          items: packageItems,
          prepaymentReceived,
          depositDate,
          notes: packageNotes,
        },
        // SCRUM-840: Save says whether the person changed the deposit in this form, and which
        // deposit the form last read. The server writes the deposit only when it was changed, and
        // keeps one that moved meanwhile (the family paid through the chat), saying so
        // (server/lib/depositSaveGuard.ts).
        depositChanged: depositChangedIn({ prepaymentReceived, depositDate }, loadedDeposit.current),
        expectedDeposit: loadedDeposit.current,
      };
      const res = await apiRequest("PUT", `/api/events/${eventId}/beo`, payload);
      if (!res.ok) throw new Error("Failed to save BEO data");
      return res.json();
    },
    onSuccess: (saved: { oneDeposit?: OneDeposit; depositSave?: DepositSaveNote } | null) => {
      // The deposit as it stands after the Save: the field shows it at once, and the read that
      // follows brings the rest of the form.
      if (saved?.oneDeposit) {
        loadedDeposit.current = loadedDepositOf({ oneDeposit: saved.oneDeposit });
        setPrepaymentReceived(loadedDeposit.current.amountThb);
        setDepositDate(loadedDeposit.current.date ?? "");
      }
      queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "beo"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/events"] });
      if (saved?.depositSave) toast({ title: "BEO saved. The deposit was not changed", description: saved.depositSave.message });
      else toast({ title: "BEO data saved successfully" });
      onSave?.();
    },
    onError: (error: Error) => {
      toast({ title: "Failed to save", description: error.message, variant: "destructive" });
    },
  });

  const timeToMinutes = (time: string): number => {
    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
  };

  /**
   * SCRUM-836: a party has a start time. The saved BEO holds one and the form's is emptied:
   * the line under the field says so and Save writes nothing (it used to drop the emptied
   * time from the save and say "saved", the old time still there). A BEO from before the
   * rule that holds no start yet still saves its other fields.
   */
  const startTimeMissing = !eventData.startTime && !!beoData?.startTime;
  const startTimeLine = needsStartTimeLine(beoData?.eventType);

  const handleSave = async () => {
    if (readOnly) return;
    if (startTimeMissing) {
      toast({ title: "Not saved", description: `${startTimeLine}. Set the time, then save.`, variant: "destructive" });
      return;
    }
    if (eventData.startTime && eventData.endTime) {
      const startMinutes = timeToMinutes(eventData.startTime);
      const endMinutes = timeToMinutes(eventData.endTime);
      if (endMinutes <= startMinutes) {
        setTimeError("End time must be after start time");
        toast({ title: "Validation Error", description: "End time must be after start time", variant: "destructive" });
        return;
      }
    }
    setTimeError(null);
    setIsSaving(true);
    try {
      await saveMutation.mutateAsync();
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * SCRUM-828: a new item the server has already written to the kitchen plan
   * with its till code. It joins the list on screen as written (the same id,
   * so a retried press replaces its own line), and the next Save keeps it.
   */
  const addPartyMenuLine = (menu: "kids" | "adults", line: PartyMenuLine) => {
    const setMenu = menu === "adults" ? setAdultsMenu : setKidsMenu;
    const shown: MenuLine = {
      id: line.id,
      itemName: line.itemName,
      quantity: line.quantity,
      notes: line.notes,
      included: line.included,
      price: line.price,
      productCode: line.productCode,
      ...(line.source ? { source: line.source } : {}),
    };
    setMenu((prev) => (prev.some((m) => m.id === shown.id) ? prev.map((m) => (m.id === shown.id ? shown : m)) : [...prev, shown]));
    setMenuTab(menu);
    toast({ title: "New item added", description: `${line.itemName} is on the till as ${line.productCode}, for this party only.` });
  };

  const addSetupTask = () => {
    setSetupTasks(prev => [...prev, {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      itemLabel: "",
      notes: "",
    }]);
  };

  const updateSetupTask = (taskId: string, updates: Partial<SetupTask>) => {
    setSetupTasks(prev => prev.map(t => t.id === taskId ? { ...t, ...updates } : t));
  };

  const removeSetupTask = (taskId: string) => {
    setSetupTasks(prev => prev.filter(t => t.id !== taskId));
  };

  const addPackageItem = (type: "included" | "extra") => {
    setPackageItems([...packageItems, {
      id: `pi_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      description: "",
      type,
      price: 0,
      notes: "",
    }]);
  };

  // SCRUM-949: what the till will charge for the plan's EXTRA lines, line by line (shared/beoExtras.ts
  // mirrors the party settlement): the price boxes' hints and each plan's extras total.
  const extraCharges = useMemo(() => {
    const ctx = { till: tillMenu.index, partyDate: eventData.eventDate ?? null };
    return { kitchen: beoKitchenChargesOf(kidsMenu, adultsMenu, adultsDiffer, ctx), bar: barItems.map((line) => beoExtraChargeOf(line, "bar", ctx)) };
  }, [tillMenu.index, eventData.eventDate, kidsMenu, adultsMenu, adultsDiffer, barItems]);

  const kitchenTotal = useMemo(() => {
    // SCRUM-829: the adults' list counts only while it is the adults' own.
    const allMenuItems = [...kidsMenu, ...(adultsDiffer ? adultsMenu : [])];
    const extrasTotal = allMenuItems
      .filter(i => i.source !== 'set_menu')
      .reduce((sum, i) => sum + (i.price || 0), 0);
    const cakeExtra = cakeMode !== "NONE" && !cakeIncluded ? (cakePrice || 0) : 0;
    return extrasTotal + cakeExtra;
  }, [kidsMenu, adultsMenu, adultsDiffer, cakeMode, cakeIncluded, cakePrice]);

  // SCRUM-822: the party's total and what is outstanding are the till's
  // (tillFigures above), never Party Details' base price and extras added up here.
  /** The deposit typed in Party Details and not saved yet: the till reads the saved one. */
  const depositUnsaved = !!tillFigures && tillFigures.kind === "quote" && Math.round(prepaymentReceived * 100) !== tillFigures.depositSatang;

  const getBeoTaskStatus = (prefix: string) => {
    const task = beoTasks.find((t: any) => t.title?.startsWith(prefix));
    if (!task) return null;
    return task;
  };

  const toggleBeoTaskMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const task = beoTasks.find((t: any) => t.id === taskId);
      const newStatus = task?.status === "completed" ? "pending" : "completed";
      const res = await apiRequest("PATCH", `/api/tasks/${taskId}`, { status: newStatus });
      if (!res.ok) throw new Error("Failed to update task");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "beo"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
    },
  });

  const BeoTaskBadge = ({ prefix, label }: { prefix: string; label: string }) => {
    const task = getBeoTaskStatus(prefix);
    if (!task) return null;
    const isCompleted = task.status === "completed";
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          toggleBeoTaskMutation.mutate(task.id);
        }}
        className={`ml-auto flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border transition-colors ${
          isCompleted
            ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/30 dark:text-emerald-400"
            : "bg-muted text-muted-foreground border-border hover:bg-accent"
        }`}
        data-testid={`beo-task-toggle-${prefix.replace(/[^a-z]/gi, "").toLowerCase()}`}
      >
        {isCompleted ? <CheckCircle2 className="h-3 w-3" /> : <Circle className="h-3 w-3" />}
        {isCompleted ? "Done" : label}
      </button>
    );
  };

  const responsibleSearchResults = useMemo(() => {
    const query = setupResponsibleSearch.toLowerCase().trim();
    if (!query) return [];
    const results: { id: string; label: string; type: "employee" | "department" }[] = [];
    if (allEmployees) {
      for (const emp of allEmployees) {
        const name = emp.nickname || emp.fullName;
        if (name.toLowerCase().includes(query) || emp.fullName.toLowerCase().includes(query)) {
          results.push({ id: emp.id, label: emp.nickname ? `${emp.nickname} (${emp.fullName})` : emp.fullName, type: "employee" });
        }
        if (results.length >= 10) break;
      }
    }
    if (allDepartments) {
      for (const dept of allDepartments) {
        if (dept.name.toLowerCase().includes(query)) {
          results.push({ id: dept.id, label: `${dept.name} (Dept)`, type: "department" });
        }
      }
    }
    return results.slice(0, 12);
  }, [setupResponsibleSearch, allEmployees, allDepartments]);

  const getSectionStatus = (section: string): "complete" | "incomplete" | "warning" | "pending" => {
    switch (section) {
      case "event-info": {
        const hasDate = !!eventData.eventDate;
        const hasTime = !!eventData.startTime;
        const hasChildName = !!eventData.childName;
        const hasParentName = !!eventData.bookingName;
        const hasLocation = !!locationText;
        const hasKids = (eventData.numChildren || 0) > 0;
        const hasAdults = (eventData.numAdults || 0) > 0;
        const hasKidAge = !!((eventData as any).kidTurningAge);
        return hasDate && hasTime && hasChildName && hasParentName && hasLocation && hasKids && hasAdults && hasKidAge ? "complete" : "incomplete";
      }
      case "party-host":
        return (partyHost.assignedEmployeeId || partyHost.assignedUserId || partyHost.assignedRoleId) ? "complete" : "incomplete";
      case "party-details":
        return packageName ? "complete" : "incomplete";
      case "setup-plan":
        return setupTasks.length > 0 ? (setupTasks.every(t => t.itemLabel.trim()) ? "complete" : "warning") : "incomplete";
      case "kitchen-plan":
        if (!kitchenRequired) return "pending";
        return (kidsMenu.length > 0 || (adultsDiffer && adultsMenu.length > 0)) ? "complete" : "incomplete";
      case "timeline":
        return (beoData?.timeline?.length || 0) > 0 ? "complete" : "incomplete";
      default:
        return "complete";
    }
  };

  const StatusIcon = ({ status }: { status: "complete" | "incomplete" | "warning" | "pending" }) => {
    if (status === "complete") return <Check className="h-4 w-4 text-green-500" />;
    if (status === "pending") return <Circle className="h-4 w-4 text-muted-foreground" />;
    if (status === "warning") return <AlertCircle className="h-4 w-4 text-yellow-500" />;
    return <div className="h-4 w-4 rounded-full border-2 border-muted-foreground" />;
  };

  const { data: allRoles } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ["/api/beo/roles"],
  });

  const partyHostAssignmentValue = useMemo((): AssignmentValue[] => {
    if (partyHost.assignedRoleId) {
      const role = allRoles?.find(r => r.id === partyHost.assignedRoleId);
      return [{ type: "role", id: partyHost.assignedRoleId, label: role?.name || "Unknown Role" }];
    }
    const hostId = partyHost.assignedEmployeeId || partyHost.assignedUserId;
    if (hostId) {
      const emp = allEmployees?.find(e => e.id === hostId);
      return [{ type: "employee", id: hostId, label: emp?.nickname || emp?.fullName || "Unknown" }];
    }
    return [];
  }, [partyHost.assignedEmployeeId, partyHost.assignedUserId, partyHost.assignedRoleId, allEmployees, allRoles]);

  const entertainmentHostAssignmentValue = useMemo((): AssignmentValue[] => {
    const backupId = partyHost.backupEmployeeId || partyHost.backupUserId;
    if (!backupId) return [];
    const emp = allEmployees?.find(e => e.id === backupId);
    return [{ type: "employee", id: backupId, label: emp?.nickname || emp?.fullName || "Unknown" }];
  }, [partyHost.backupEmployeeId, partyHost.backupUserId, allEmployees]);

  const handlePartyHostChange = useCallback((values: AssignmentValue[]) => {
    if (values.length === 0) {
      setPartyHost(prev => ({ ...prev, assignedEmployeeId: undefined, assignedUserId: undefined, assignedRoleId: undefined, assignmentMode: "INDIVIDUAL" }));
    } else {
      const last = values[values.length - 1];
      if (last.type === "employee") {
        if (partyHostSource === "user") {
          setPartyHost(prev => ({ ...prev, assignedUserId: last.id, assignedEmployeeId: undefined, assignedRoleId: undefined, assignmentMode: "INDIVIDUAL" }));
        } else {
          setPartyHost(prev => ({ ...prev, assignedEmployeeId: last.id, assignedUserId: undefined, assignedRoleId: undefined, assignmentMode: "INDIVIDUAL" }));
        }
      } else if (last.type === "role") {
        setPartyHost(prev => ({ ...prev, assignedRoleId: last.id, assignedEmployeeId: undefined, assignedUserId: undefined, assignmentMode: "ROLE" }));
      }
    }
  }, [partyHostSource]);

  const handleEntertainmentHostChange = useCallback((values: AssignmentValue[]) => {
    if (values.length === 0) {
      setPartyHost(prev => ({ ...prev, backupEmployeeId: undefined, backupUserId: undefined }));
    } else {
      const last = values[values.length - 1];
      if (last.type === "employee") {
        if (partyHostSource === "user") {
          setPartyHost(prev => ({ ...prev, backupUserId: last.id, backupEmployeeId: undefined }));
        } else {
          setPartyHost(prev => ({ ...prev, backupEmployeeId: last.id, backupUserId: undefined }));
        }
      }
    }
  }, [partyHostSource]);

  const MandatoryLabel = ({ children }: { children: React.ReactNode }) => (
    <Label className="flex items-center gap-1">
      {children}
      <span className="text-destructive">*</span>
    </Label>
  );

  /** What the form holds now: AI Fill's baseline, so the model changes only what the message says. */
  const buildAiFillExistingData = () => ({
    event: {
      title: eventData.title,
      childName: eventData.childName,
      bookingName: eventData.bookingName,
      numChildren: eventData.numChildren,
      numAdults: eventData.numAdults,
      startTime: eventData.startTime,
      endTime: eventData.endTime,
      specialRequests: eventData.specialRequests,
      internalStaffNotes: eventData.internalStaffNotes,
      activities: eventData.activities,
      decoration: eventData.decoration,
      locationText,
    },
    setupPlan: {
      readyBy: setupReadyBy,
      responsible: setupResponsible,
      simplifiedTasks: setupTasks.map(t => ({ itemLabel: t.itemLabel, notes: t.notes })),
    },
    kitchenPlan: {
      kidsMenu: kidsMenu.map(m => ({ itemName: m.itemName, quantity: m.quantity, notes: m.notes, included: m.included, price: m.price })),
      // SCRUM-829: the adults' own list only; with the switch off they eat the kids' list above.
      adultsMenu: (adultsDiffer ? adultsMenu : []).map(m => ({ itemName: m.itemName, quantity: m.quantity, notes: m.notes, included: m.included, price: m.price })),
      cakeMode,
      cakeNotes,
      cakeTime,
      cakeIncluded,
      cakePrice,
      cakeQuantity,
    },
    partyDetails: {
      packageName,
      packageBasePrice,
      prepaymentReceived,
      depositDate,
      notes: packageNotes,
      items: packageItems.map(i => ({ description: i.description, type: i.type, price: i.price, notes: i.notes })),
    },
  });

  /** SCRUM-827: what the form holds of the rest of the BEO, so the review overwrites nothing typed. */
  const reviewHeld = (): ReviewHeld => ({
    title: eventData.title ?? "",
    bookingName: eventData.bookingName ?? "",
    locationText,
    specialRequests: eventData.specialRequests ?? "",
    activities: eventData.activities ?? "",
    decoration: eventData.decoration ?? "",
    setupReadyBy,
    setupResponsible,
    posName: packageName,
    posNotes: packageNotes,
    // SCRUM-904: the family's number and the setup notes the form holds, never overwritten.
    whatsapp: eventData.whatsappPhoneRaw ?? "",
    setupNotes,
  });

  /**
   * SCRUM-827: what the SAVED BEO holds of the rest. The approval writes a field
   * that differs from this — text typed before the review and not yet saved
   * among them, so the read-back after the approval does not lose it — and
   * never a saved value over itself.
   */
  const reviewSaved = (): ReviewHeld => {
    const rec = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
    const s = (v: unknown) => (typeof v === "string" ? v : "");
    const saved = rec(beoData);
    const sp = rec(saved?.setupPlan);
    const tasks = rec(sp?.setupTasks);
    const pd = rec(saved?.partyDetails);
    return {
      title: s(saved?.title),
      bookingName: s(saved?.bookingName) || s(saved?.parentName),
      locationText: s(saved?.locationText),
      specialRequests: s(saved?.specialRequests),
      activities: s(saved?.activities),
      decoration: s(saved?.decoration),
      setupReadyBy: s(sp?.readyBy) || s(tasks?.readyBy),
      setupResponsible: s(sp?.responsible) || s(tasks?.responsible),
      posName: s(pd?.packageName),
      posNotes: s(pd?.notes),
      whatsapp: s(saved?.whatsappPhoneRaw) || s(saved?.whatsappPhoneE164),
      setupNotes: s(sp?.setupNotes),
    };
  };

  /** AI Fill's review step on an answer the server validated: from a pasted message, or (with `source`) the inbox. */
  const openAiFillPreview = (fill: any, source: AiFillInboxSource | null) => {
    setAiFillParsed(fill);
    setAiFillAccepted(new Set());
    setAiFillUseDate(false);
    setAiFillDepositConfirmed(false);
    setAiFillSource(source);
    if (source) setAiFillText(source.body);
    setAiFillError(null);
    setAiFillStep("preview");
    setShowAiFill(true);
  };

  /**
   * SCRUM-660: Create BEO's AI Fill. The server reads the inbox conversation's
   * confirmation message as this person and answers the same preview a pasted
   * message gets; if it cannot, the form stays as it opened, with one line why.
   */
  const runInboxAiFill = async () => {
    setAiFillInboxRunning(true);
    setAiFillNotice(null);
    try {
      const res = await apiRequest("POST", `/api/events/${eventId}/beo/ai-fill/inbox`, { existingData: buildAiFillExistingData() });
      const body = await res.json();
      if (!body?.fill) throw new Error("AI Fill did not run: the answer could not be read.");
      // SCRUM-815: with the park's catalogue, the proposed BEO opens in the review's edit mode;
      // without one, the preview of before.
      if (body.review) setAiReview({ review: body.review, fill: body.fill, source: body.source ?? null });
      else openAiFillPreview(body.fill, body.source ?? null);
    } catch (err: any) {
      setAiFillNotice(err?.message || "AI Fill did not run: the server could not be reached just now.");
    } finally {
      setAiFillInboxRunning(false);
    }
  };

  /** SCRUM-826: what the form holds now, in the fields Fetch from chat compares. */
  const fetchFormValues = (): FetchFormValues => ({
    title: eventData.title ?? "",
    childName: eventData.childName ?? "",
    bookingName: eventData.bookingName ?? "",
    numChildren: typeof eventData.numChildren === "number" ? eventData.numChildren : null,
    numAdults: typeof eventData.numAdults === "number" ? eventData.numAdults : null,
    startTime: eventData.startTime ?? "",
    endTime: eventData.endTime ?? "",
    eventDate: eventData.eventDate ?? "",
    locationText,
    specialRequests: eventData.specialRequests ?? "",
    activities: eventData.activities ?? "",
    decoration: eventData.decoration ?? "",
    setupReadyBy,
    setupResponsible,
    cakeMode,
    cakeNotes,
    cakeTime,
    prepaymentReceived,
    depositDate,
    packageName,
    packageNotes,
    // SCRUM-904: the fields the conversation's read gives since Phase B.
    whatsappPhoneRaw: eventData.whatsappPhoneRaw ?? "",
    kidTurningAge: typeof (eventData as any).kidTurningAge === "number" ? (eventData as any).kidTurningAge : null,
    setupNotes,
    cakeQuantity,
    cakeIncluded: cakeIncluded ? "included" : "extra",
    cakePrice,
    kidsFoodTime,
    adultsFoodTime,
    barServiceTime,
  });

  /**
   * SCRUM-826: the conversation read again, as it is now, through the same
   * fill as Create BEO's (the server reads it as this person); the answer is
   * diffed against the form in the dialog and nothing lands but what is
   * accepted. The catalogue section the BEO holds — the applied package and
   * the entertainment selections (saved in their own sections, not by this
   * form's Save), the set menu and the food lines as the form holds them — is
   * read with it, so the dialog can list what the chat says there too.
   */
  const readChatForFetch = async (): Promise<FetchAnswer> => {
    const [res, snapshotRes, selectionsRes] = await Promise.all([
      apiRequest("POST", `/api/events/${eventId}/beo/ai-fill/inbox`, { existingData: buildAiFillExistingData(), purpose: "fetch" }),
      apiRequest("GET", `/api/beo/events/${eventId}/package-snapshot`),
      apiRequest("GET", `/api/beo/events/${eventId}/entertainment-selections`),
    ]);
    const body = await res.json();
    if (!body?.fill) throw new Error("The conversation could not be read: the answer could not be read.");
    const snapshot = (await snapshotRes.json()) as { templateId?: string | null; packageName?: string; items?: Array<{ label?: string }> } | null;
    const selections = (await selectionsRes.json()) as Array<{ templateId?: string | null; name?: string }>;
    const held: FetchHeldCatalogue = {
      package: snapshot ? { templateId: snapshot.templateId ?? null, name: snapshot.packageName ?? "" } : null,
      packageItems: (snapshot?.items ?? []).map((i) => i.label ?? "").filter(Boolean),
      setMenuTemplateId: setMenuTemplateId || null,
      // SCRUM-978: each line with its list, so a kids' choice is compared with the kids' lines only.
      menuLines: ([["kids", kidsMenu], ["adults", adultsMenu], ["bar", barItems]] as const).flatMap(([menu, lines]) =>
        lines.map((m) => ({ itemName: m.itemName, quantity: m.quantity, productCode: m.productCode ?? null, groupId: m.groupId ?? null, menu })),
      ),
      entertainment: (Array.isArray(selections) ? selections : []).map((s) => ({ templateId: s.templateId ?? null, name: s.name ?? "" })),
    };
    return { fill: body.fill, review: body.review ?? null, chatMark: body.chat?.newestMessageId ?? body.source?.messageId ?? null, held };
  };

  /**
   * SCRUM-826: the accepted changes into the form, as any edit — unsaved until
   * Save. SCRUM-827: each re-filled field wears the line it now came from (the
   * mark of before would say where the value no longer came from); a who
   * fetched as text is nobody linked, so the team's mark on it is let go.
   */
  const applyFetched = (patch: Partial<FetchFormValues>, accepted: FetchChange[] = []) => {
    // SCRUM-904: the setup notes, the cake's count, package and price, the food and bar times; the age and the number are the event's.
    const { setupNotes: setupNote, cakeQuantity: cakes, cakeIncluded: cakeIn, cakePrice: cakeCost, kidsFoodTime: kidsAt, adultsFoodTime: adultsAt, barServiceTime: barAt, ...rest } = patch;
    if (setupNote !== undefined) setSetupNotes(setupNote);
    if (typeof cakes === "number") setCakeQuantity(cakes);
    if (cakeIn) setCakeIncluded(cakeIn === "included");
    if (cakeCost !== undefined) setCakePrice(cakeCost);
    if (kidsAt !== undefined) setKidsFoodTime(kidsAt);
    if (adultsAt !== undefined) setAdultsFoodTime(adultsAt);
    if (barAt !== undefined) setBarServiceTime(barAt);
    const { locationText: loc, setupReadyBy: ready, setupResponsible: who, cakeMode: mode, cakeNotes: notes, cakeTime: at, prepaymentReceived: paid, depositDate: on, packageName: pkg, packageNotes: posNotes, ...event } = rest;
    if (Object.keys(event).length > 0) setEventData((prev) => ({ ...prev, ...event }));
    if (loc !== undefined) setLocationText(loc);
    if (ready !== undefined) setSetupReadyBy(ready);
    if (who !== undefined) {
      setSetupResponsible(who);
      setSetupResponsibleId(null);
      setSetupResponsibleType(null);
    }
    if (mode !== undefined) setCakeMode(mode);
    if (notes !== undefined) setCakeNotes(notes);
    if (at !== undefined) setCakeTime(at);
    if (paid !== undefined) setPrepaymentReceived(paid);
    if (on !== undefined) setDepositDate(on);
    if (pkg !== undefined) setPackageName(pkg);
    if (posNotes !== undefined) setPackageNotes(posNotes);
    if (accepted.length > 0) {
      setAiMarks((m) => {
        const next = { ...m, ...fetchedMarksOf(accepted) };
        if (who !== undefined) delete next["team:setupResponsible"];
        return next;
      });
    }
  };

  // SCRUM-660: once the form holds the event (the effect above filled it), Create BEO's AI Fill runs once.
  useEffect(() => {
    if (autoFill !== "inbox" || readOnly || autoFillTaken.current || !beoData) return;
    autoFillTaken.current = true;
    onAutoFillTaken?.();
    setAutoFillReady(true);
  }, [autoFill, readOnly, beoData, onAutoFillTaken]);

  useEffect(() => {
    if (!autoFillReady) return;
    setAutoFillReady(false);
    void runInboxAiFill();
    // Runs on the render after the form state was filled from the event, with that state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFillReady]);

  if (isLoading) {
    return <LoadingScreen message="Loading event details..." />;
  }

  if (beoError || !beoData) {
    return (
      <div className="flex flex-col items-center justify-center p-8 gap-4">
        <p className="text-muted-foreground">{beoError?.message || "Event not found"}</p>
        {beoError?.message?.includes("Session expired") && (
          <Button variant="outline" onClick={() => window.location.reload()}>
            Refresh Page
          </Button>
        )}
      </div>
    );
  }

  const handleAiFillParse = async () => {
    if (!aiFillText.trim()) return;
    setAiFillLoading(true);
    setAiFillError(null);
    try {
      // SCRUM-660: the open event names the park whose team a fill may propose, and its activity row.
      const res = await apiRequest("POST", "/api/ai/parse-beo", {
        text: aiFillText,
        existingData: buildAiFillExistingData(),
        eventId,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to parse BEO text");
      }
      const { review, ...parsed } = await res.json();
      // A pasted message: whatever the inbox gave before, this is what was read now.
      // SCRUM-818: matched to the park's catalogue, it opens the same review in edit
      // mode as Create BEO's conversation; without a park or a catalogue, the preview of before.
      if (review) {
        setShowAiFill(false);
        setAiFillSource(null);
        setAiReview({ review, fill: parsed, source: null });
      } else {
        openAiFillPreview(parsed, null);
      }
    } catch (err: any) {
      setAiFillError(err.message || "Failed to parse BEO text");
    } finally {
      setAiFillLoading(false);
    }
  };

  const handleAiFillApply = async () => {
    if (!aiFillParsed) return;
    const p = aiFillParsed;

    if (p.event) {
      const e = p.event;
      setEventData((prev) => ({
        ...prev,
        ...(e.title && { title: e.title }),
        ...(e.childName && { childName: e.childName }),
        ...(e.bookingName && { bookingName: e.bookingName }),
        ...(e.numChildren != null && { numChildren: e.numChildren }),
        ...(e.numAdults != null && { numAdults: e.numAdults }),
        ...(e.startTime && { startTime: e.startTime }),
        ...(e.endTime && { endTime: e.endTime }),
        ...(e.specialRequests && { specialRequests: e.specialRequests }),
        ...(e.internalStaffNotes && { internalStaffNotes: e.internalStaffNotes }),
        ...(e.activities && { activities: e.activities }),
        ...(e.decoration && { decoration: e.decoration }),
      }));
      if (e.locationText) setLocationText(e.locationText);
    }

    // SCRUM-814: the message's date is never applied silently: only when it differs from the
    // booked date and the reviewer ticked it.
    const dateLine = aiFillDateLine(p, eventData.eventDate);
    if (dateLine?.differs && aiFillUseDate) {
      setEventData((prev) => ({ ...prev, eventDate: dateLine.read }));
    }

    if (p.setupPlan) {
      const sp = p.setupPlan;
      if (sp.readyBy) setSetupReadyBy(sp.readyBy);
      if (sp.responsible) {
        setSetupResponsible(sp.responsible);
        setSetupResponsibleId(null);
        setSetupResponsibleType(null);
      }
      if (sp.simplifiedTasks?.length > 0) {
        setSetupTasks(sp.simplifiedTasks.map((t: any) => ({
          id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          itemLabel: t.itemLabel || "",
          notes: t.notes || "",
        })));
      }
    }

    // SCRUM-660: a person the message named, matched to one real person (or
    // department) of this park, is assigned only where the reviewer ticked it.
    const proposals: AiTeamProposals | undefined = p.proposals;
    const accepted = (field: AiTeamField): AiTeamMatch | null => {
      const proposal = proposals?.[field];
      return proposal?.match && aiFillAccepted.has(field) ? proposal.match : null;
    };
    const host = accepted("partyHost");
    if (host && host.kind === "employee") {
      setPartyHost(prev => partyHostSource === "user"
        ? prev
        : { ...prev, assignedEmployeeId: host.id, assignedUserId: undefined, assignedRoleId: undefined, assignmentMode: "INDIVIDUAL" });
    }
    const entertainer = accepted("entertainmentHost");
    if (entertainer && entertainer.kind === "employee" && partyHostSource !== "user") {
      setPartyHost(prev => ({ ...prev, backupEmployeeId: entertainer.id, backupUserId: undefined }));
    }
    const who = accepted("setupResponsible");
    if (who) {
      setSetupResponsible(who.label);
      setSetupResponsibleId(who.id);
      setSetupResponsibleType(who.kind);
    }

    if (p.kitchenPlan) {
      const kp = p.kitchenPlan;
      setKitchenRequired(true);
      // SCRUM-829: the adults eat the kids' menu unless the message says otherwise. The server's
      // read already folds an adults' list that only names the kids' dishes again (the model's
      // "adults eat the same as the kids" in their headcount); the same rule holds here for an
      // answer that still carries one (shared/kitchenAdults.ts). The adults' own list is only
      // one naming a dish of theirs, or leaving one of the kids' out.
      const adultsOwn = kp.adultsMenu?.length > 0 && !sameKitchenDishNames(kp.kidsMenu, kp.adultsMenu);
      if (kp.kidsMenu?.length > 0) {
        setKidsMenu(kp.kidsMenu.map((m: any) => ({
          id: `menu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          itemName: m.itemName || "",
          quantity: m.quantity || 1,
          notes: m.notes || "",
          included: m.included !== false,
          price: m.price || 0,
        })));
        if (!adultsOwn) {
          // The message's food, with nothing of the adults' own: the adults eat it too, the switch off.
          setAdultsMenu([]);
          setAdultsDiffer(false);
        }
      }
      if (adultsOwn) {
        // The message said the adults eat something different: their own list, the switch on.
        setAdultsMenu(kp.adultsMenu.map((m: any) => ({
          id: `menu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          itemName: m.itemName || "",
          quantity: m.quantity || 1,
          notes: m.notes || "",
          included: m.included !== false,
          price: m.price || 0,
        })));
        setAdultsDiffer(true);
      }
      // SCRUM-787: the cake's time and notes as the message gives them; its type only when the
      // message says whose cake it is, so a type it does not say leaves the form's as it was.
      const cake = aiFillCakeApply(kp);
      if (cake.mode) setCakeMode(cake.mode);
      if (cake.notes) setCakeNotes(cake.notes);
      if (cake.time) setCakeTime(cake.time);
      if (cake.included !== undefined) setCakeIncluded(cake.included);
      if (cake.price !== undefined) setCakePrice(cake.price);
      if (cake.quantity !== undefined) setCakeQuantity(cake.quantity);
    }

    if (p.partyDetails) {
      const pd = p.partyDetails;
      if (pd.packageName) setPackageName(pd.packageName);
      if (pd.packageBasePrice) setPackageBasePrice(pd.packageBasePrice);
      const deposit = legacyDepositFieldsOf(pd, aiFillText);
      if (aiFillDepositConfirmed && deposit.prepaymentReceived) {
        setPrepaymentReceived(deposit.prepaymentReceived);
        if (deposit.depositDate) setDepositDate(deposit.depositDate);
      }
      if (pd.notes) setPackageNotes(pd.notes);
      if (pd.items?.length > 0) {
        setPackageItems(pd.items.map((item: any) => ({
          id: `pi_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          description: item.description || "",
          type: item.type === "extra" ? "extra" as const : "included" as const,
          price: item.price || 0,
          notes: item.notes || "",
        })));
      }
    }

    if (p.timeline?.length > 0) {
      const startTime = p.event?.startTime || eventData.startTime || "10:00";
      const [sh, sm] = startTime.split(":").map(Number);
      const startMins = sh * 60 + sm;

      try {
        for (let i = 0; i < p.timeline.length; i++) {
          const t = p.timeline[i];
          const [th, tm] = (t.time || "00:00").split(":").map(Number);
          const itemMins = th * 60 + tm;
          const offset = itemMins - startMins;
          await apiRequest("POST", `/api/events/${eventId}/beo/timeline`, {
            label: t.label || "",
            offsetFromStartMinutes: offset,
            assignedToType: "PARTY_HOST",
            sortOrder: i + 1,
          });
        }
        queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "beo", "timeline"] });
      } catch (err) {
        console.error("Failed to create timeline items:", err);
      }
    }

    setShowAiFill(false);
    setAiFillStep("paste");
    setAiFillText("");
    setAiFillParsed(null);
    setAiFillAccepted(new Set());
    setAiFillUseDate(false);
    setAiFillSource(null);
    setAiFillNotice(null);
    toast({ title: "BEO data loaded", description: "AI-parsed data has been filled in. Review and save when ready." });
  };

  // SCRUM-814: the date the AI Fill read, beside the date the form holds.
  const aiFillDate = aiFillDateLine(aiFillParsed, eventData.eventDate);
  // SCRUM-787: the cake as the AI Fill read it, its type "not said" when the message does not say whose cake.
  const aiFillCake = aiFillCakeLine(aiFillParsed?.kitchenPlan);
  const aiFillDeposit = legacyDepositFieldsOf(aiFillParsed?.partyDetails ?? {}, aiFillText);
  // SCRUM-787: beside it, the form's own type that stays, and what to choose when that type is No Cake.
  const aiFillCakeNote = aiFillCakeNotSaidNote(aiFillCake, cakeMode);

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap mb-4">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-xl font-semibold" data-testid="text-event-title">{beoData.title || "Untitled Event"}</h2>
              {branches && branches.length > 1 && !readOnly ? (
                <Select
                  value={beoData.branchId || ""}
                  onValueChange={async (newBranchId) => {
                    await apiRequest("PATCH", `/api/admin/events/${eventId}`, { branchId: newBranchId });
                    queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "beo"] });
                    queryClient.invalidateQueries({ queryKey: ["/api/admin/events"] });
                  }}
                >
                  <SelectTrigger className="h-6 text-xs border-dashed w-auto gap-1 px-2" data-testid="select-event-branch">
                    <Building2 className="h-3 w-3 shrink-0" />
                    <SelectValue placeholder="Branch" />
                  </SelectTrigger>
                  <SelectContent>
                    {branches.map((b) => (
                      <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (beoData as any).branch?.name ? (
                <Badge variant="outline" className="text-xs" data-testid="badge-branch-name">
                  <Building2 className="h-3 w-3 mr-1" />
                  {(beoData as any).branch.name}
                </Badge>
              ) : null}
              {/* SCRUM-775: a birthday booked from the platform inbox's Book Date. */}
              {beoData.inboxConversationId ? (
                <Badge
                  variant="outline"
                  className="text-xs"
                  title="Booked from a conversation in the inbox"
                  data-testid="badge-from-inbox"
                >
                  <MessageSquare className="h-3 w-3 mr-1" />
                  From the inbox
                </Badge>
              ) : null}
              {/* SCRUM-822: from the till's figures, never the app's own. */}
              {tillFigures && tillFigures.expectedSatang > 0 && (
                <Badge
                  variant={tillFigures.depositSatang <= 0 && tillFigures.outstandingSatang > 0 ? "destructive" : tillFigures.outstandingSatang > 0 ? "outline" : "default"}
                  className={cn(
                    "text-xs font-mono",
                    tillFigures.depositSatang <= 0 && tillFigures.outstandingSatang > 0 && "bg-red-500",
                    tillFigures.depositSatang > 0 && tillFigures.outstandingSatang > 0 && "border-orange-500 text-orange-600 dark:text-orange-400",
                    tillFigures.outstandingSatang <= 0 && "bg-green-600",
                  )}
                  data-testid="badge-payment-status"
                >
                  {tillFigures.outstandingSatang <= 0
                    ? "Paid"
                    : tillFigures.depositSatang <= 0
                      ? "No Deposit"
                      : `${bahtOfSatang(tillFigures.outstandingSatang)} Due`}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {(() => {
                const d = new Date(beoData.eventDate + 'T00:00:00');
                const day = d.getDate();
                const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
                const month = months[d.getMonth()];
                const year = String(d.getFullYear()).slice(-2);
                return `${day} ${month} '${year}`;
              })()} at {beoData.startTime}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!readOnly && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setShowAiFill(true);
                  setAiFillStep("paste");
                  setAiFillText("");
                  setAiFillParsed(null);
                  setAiFillError(null);
                  setAiFillAccepted(new Set());
                  setAiFillSource(null);
                }}
                disabled={aiFillInboxRunning}
                data-testid="button-ai-fill-beo"
              >
                <Sparkles className="h-4 w-4 mr-1" />
                AI Fill
              </Button>
            )}
            {/* SCRUM-826: the conversation read again, its changes listed to accept or decline. */}
            {!readOnly && beoData.inboxConversationId && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setFetchOpen(true)}
                disabled={aiFillInboxRunning}
                title="Read the conversation again and review what changed"
                data-testid="button-fetch-from-chat"
              >
                <RefreshCw className="h-4 w-4 mr-1" />
                Fetch from chat
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                window.open(`/api/events/${eventId}/beo/pdf`, '_blank');
              }}
              data-testid="button-print-beo"
            >
              <Printer className="h-4 w-4 mr-1" />
              Print
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const res = await fetch(`/api/events/${eventId}/beo/pdf`, { credentials: 'include' });
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `BEO.pdf`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
              }}
              data-testid="button-download-beo"
            >
              <Download className="h-4 w-4 mr-1" />
              Download PDF
            </Button>
            {readOnly && (
              <Badge variant="secondary" className="text-xs" data-testid="badge-view-only">View Only</Badge>
            )}
          </div>
        </div>

        {/* SCRUM-660: Create BEO's AI Fill — reading the inbox, or the one line why it did not run. */}
        {aiFillInboxRunning && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground -mt-2 mb-2" data-testid="text-ai-fill-inbox-running">
            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
            AI Fill is reading the team's confirmation message from the inbox…
          </div>
        )}
        {aiFillNotice && !aiFillInboxRunning && (
          <div className="flex items-start gap-2 text-sm text-muted-foreground -mt-2 mb-2" data-testid="text-ai-fill-notice">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span className="flex-1">{aiFillNotice}</span>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setAiFillNotice(null)}
              aria-label="Dismiss"
              data-testid="button-dismiss-ai-fill-notice"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <div className="flex gap-2 flex-wrap mb-4">
          {[
            { key: "event-info", label: "Info" },
            { key: "party-host", label: "Host" },
            { key: "party-details", label: "POS" },
            { key: "setup-plan", label: "Setup" },
            { key: "kitchen-plan", label: "Kitchen" },
            { key: "timeline", label: "Timeline" },
          ].map(({ key, label }) => (
            <div key={key} className="flex items-center gap-1 text-sm">
              <StatusIcon status={getSectionStatus(key)} />
              <span>{label}</span>
            </div>
          ))}
        </div>

        <TillMenuContext.Provider value={tillMenu}>
        {/* SCRUM-949: the party's date, for the till's weekend price an EXTRA line's hint and the totals read. */}
        <BeoPartyDateContext.Provider value={eventData.eventDate ?? null}>
        <Accordion 
          type="multiple" 
          value={expandedSections}
          onValueChange={setExpandedSections}
          className="space-y-2"
        >
          {/* 1. Event Info */}
          <AccordionItem value="event-info" className="border rounded-lg">
            <AccordionTrigger className="px-4 hover:no-underline" data-testid="accordion-event-info">
              <div className="flex items-center gap-2">
                <CalendarDays className="h-4 w-4" />
                <span>Event Info</span>
                <StatusIcon status={getSectionStatus("event-info")} />
                {aiSectionMark("event-info")}
              </div>
            </AccordionTrigger>
            <AccordionContent className={`px-4 pb-4 ${readOnly ? "opacity-75 cursor-not-allowed" : ""}`}>
              <div className="grid gap-4">
                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1">Title{aiMark("title")}</Label>
                    <EditableText
                      value={eventData.title || ""}
                      onChange={(v) => { setEventData({ ...eventData, title: v }); aiTouched("title"); }}
                      placeholder="Event title..."
                      data-testid="input-event-title"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1">Activities{aiMark("activities")}</Label>
                    <EditableText
                      value={eventData.activities || ""}
                      onChange={(v) => { setEventData({ ...eventData, activities: v }); aiTouched("activities"); }}
                      placeholder="e.g., Games, Face Painting"
                      data-testid="input-event-activities"
                    />
                  </div>
                </div>
                <div className="grid sm:grid-cols-1 gap-4">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1">Decoration{aiMark("decoration")}</Label>
                    <EditableText
                      value={eventData.decoration || ""}
                      onChange={(v) => { setEventData({ ...eventData, decoration: v }); aiTouched("decoration"); }}
                      placeholder="e.g., Balloons, Streamers, Table Setup"
                      data-testid="input-event-decoration"
                    />
                  </div>
                  {/* SCRUM-827: the special requests the chat gave (and anything typed here), saved with the BEO. */}
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1">Special Requests{aiMark("specialRequests")}</Label>
                    <EditableText
                      value={eventData.specialRequests || ""}
                      onChange={(v) => { setEventData({ ...eventData, specialRequests: v }); aiTouched("specialRequests"); }}
                      placeholder="e.g., Nut allergy, a quiet corner for grandma"
                      multiline
                      data-testid="textarea-special-requests"
                    />
                  </div>
                </div>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <MandatoryLabel>Child / Guest of Honor Name{aiMark("childName")}</MandatoryLabel>
                    <EditableText
                      value={eventData.childName || ""}
                      onChange={(v) => { setEventData({ ...eventData, childName: v }); aiTouched("childName"); }}
                      placeholder="Birthday child or guest name"
                      data-testid="input-child-name"
                    />
                  </div>
                  <div className="space-y-1">
                    <MandatoryLabel>Parent / Booking Name{aiMark("bookingName")}</MandatoryLabel>
                    <EditableText
                      value={eventData.bookingName || ""}
                      onChange={(v) => { setEventData({ ...eventData, bookingName: v }); aiTouched("bookingName"); }}
                      placeholder="Parent or booking contact"
                      data-testid="input-booking-name"
                    />
                  </div>
                </div>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">WhatsApp Number</Label>
                    <div className="flex items-center gap-2">
                      <EditableText
                        value={eventData.whatsappPhoneRaw || ""}
                        onChange={(v) => setEventData({ ...eventData, whatsappPhoneRaw: v })}
                        placeholder="e.g., +1234567890"
                        data-testid="input-whatsapp-phone"
                      />
                      {eventData.whatsappPhoneRaw && eventData.whatsappPhoneRaw.replace(/[^0-9]/g, '').length > 0 && (
                        <a
                          href={`https://wa.me/${eventData.whatsappPhoneRaw.replace(/[^0-9]/g, '')}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center justify-center h-8 w-8 rounded-md text-green-600 hover:text-green-700 hover:bg-green-50 shrink-0"
                          data-testid="link-whatsapp-beo"
                        >
                          <Phone className="h-4 w-4" />
                        </a>
                      )}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <MandatoryLabel>Kid Turning Age</MandatoryLabel>
                    <input
                      type="number"
                      min={1}
                      value={(eventData as any).kidTurningAge ?? ""}
                      onChange={(e) => setEventData({ ...eventData, kidTurningAge: e.target.value === "" ? undefined : parseInt(e.target.value, 10) } as any)}
                      placeholder="e.g., 5"
                      className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      data-testid="input-kid-turning-age"
                    />
                  </div>
                </div>
                {(eventData as any).eventType === "studio_event" && (
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Calendar Color</Label>
                    <div className="flex flex-wrap gap-2" data-testid="picker-event-color">
                      {ONE_OFF_EVENT_COLOR_OPTIONS.map((c) => (
                        <button
                          key={c.value}
                          type="button"
                          title={c.label}
                          aria-label={c.label}
                          onClick={() => setEventData({ ...eventData, color: c.value } as any)}
                          className={`h-7 w-7 rounded-full border-2 transition-transform ${
                            (eventData as any).color === c.value ? "border-foreground scale-110" : "border-transparent"
                          }`}
                          style={{ backgroundColor: c.value }}
                          data-testid={`button-event-color-${c.label.toLowerCase()}`}
                        />
                      ))}
                    </div>
                  </div>
                )}
                <div className="grid sm:grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <MandatoryLabel>Date{aiMark("eventDate")}</MandatoryLabel>
                    <DatePicker
                      value={eventData.eventDate ? parseISO(eventData.eventDate) : undefined}
                      onChange={(date) => { setEventData({ ...eventData, eventDate: date ? format(date, "yyyy-MM-dd") : undefined }); aiTouched("eventDate"); }}
                      data-testid="input-event-date"
                    />
                  </div>
                  <div className="space-y-2">
                    <MandatoryLabel>Start Time{aiMark("startTime")}</MandatoryLabel>
                    <div className="flex items-center gap-1">
                      {eventData.startTime ? (
                        <>
                          <span className="text-sm font-mono bg-muted px-2 py-1 rounded">{eventData.startTime}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground"
                            onClick={() => { setTempStartTime(eventData.startTime || "10:00"); setShowStartTimePicker(true); }}
                            data-testid="button-start-time-edit"
                          >
                            <Settings className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            onClick={() => { setEventData({ ...eventData, startTime: undefined }); aiTouched("startTime"); }}
                            data-testid="button-start-time-clear"
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => { setTempStartTime("10:00"); setShowStartTimePicker(true); }}
                          data-testid="button-start-time"
                        >
                          <Clock className="h-3 w-3 mr-1" />
                          Set Time
                        </Button>
                      )}
                    </div>
                    {startTimeMissing && (
                      <p className="text-xs text-destructive" data-testid="text-start-time-needed">
                        {startTimeLine}. It was {beoData?.startTime}: nothing is saved until a time is set.
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label className="flex items-center gap-1">End Time{aiMark("endTime")}</Label>
                    <div className="flex items-center gap-1">
                      {eventData.endTime ? (
                        <>
                          <span className="text-sm font-mono bg-muted px-2 py-1 rounded">{eventData.endTime}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground"
                            onClick={() => { setTempEndTime(eventData.endTime || "17:00"); setShowEndTimePicker(true); }}
                            data-testid="button-end-time-edit"
                          >
                            <Settings className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            onClick={() => { setEventData({ ...eventData, endTime: undefined }); setTimeError(null); aiTouched("endTime"); }}
                            data-testid="button-end-time-clear"
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => {
                            if (eventData.startTime) {
                              const sm = timeToMinutes(eventData.startTime);
                              const em = Math.min(sm + 180, 23 * 60 + 59);
                              setTempEndTime(`${Math.floor(em / 60).toString().padStart(2, '0')}:${(em % 60).toString().padStart(2, '0')}`);
                            } else {
                              setTempEndTime("17:00");
                            }
                            setShowEndTimePicker(true);
                          }}
                          data-testid="button-end-time"
                        >
                          <Clock className="h-3 w-3 mr-1" />
                          Set Time
                        </Button>
                      )}
                    </div>
                    {timeError && <p className="text-xs text-destructive">{timeError}</p>}
                  </div>
                </div>

                {showStartTimePicker && (
                  <div className="flex items-center gap-2 p-2 border rounded-md bg-muted/30">
                    <input
                      type="time"
                      className="text-sm border rounded px-2 py-1 bg-background"
                      value={tempStartTime}
                      onChange={(e) => setTempStartTime(e.target.value)}
                      data-testid="input-start-time"
                    />
                    <Button type="button" size="sm" className="h-7 text-xs" disabled={!isStartTime(tempStartTime)} onClick={() => {
                      const updates: any = { startTime: tempStartTime };
                      if (!eventData.endTime) {
                        const startMins = timeToMinutes(tempStartTime);
                        const endMins = Math.min(startMins + 180, 23 * 60 + 59);
                        const endH = Math.floor(endMins / 60).toString().padStart(2, '0');
                        const endM = (endMins % 60).toString().padStart(2, '0');
                        updates.endTime = `${endH}:${endM}`;
                      }
                      setEventData({ ...eventData, ...updates });
                      setTimeError(null);
                      setShowStartTimePicker(false);
                      aiTouched("startTime");
                      if (updates.endTime) aiTouched("endTime");
                    }} data-testid="button-confirm-start-time">Confirm</Button>
                    <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowStartTimePicker(false)}>Cancel</Button>
                  </div>
                )}

                {showEndTimePicker && (
                  <div className="flex items-center gap-2 p-2 border rounded-md bg-muted/30">
                    <input
                      type="time"
                      className="text-sm border rounded px-2 py-1 bg-background"
                      value={tempEndTime}
                      onChange={(e) => setTempEndTime(e.target.value)}
                      data-testid="input-end-time"
                    />
                    <Button type="button" size="sm" className="h-7 text-xs" onClick={() => {
                      const startTime = eventData.startTime || "10:00";
                      const startMinutes = timeToMinutes(startTime);
                      const endMinutes = timeToMinutes(tempEndTime);
                      if (endMinutes <= startMinutes) {
                        setTimeError("End time must be after start time");
                        setShowEndTimePicker(false);
                        return;
                      }
                      setEventData({ ...eventData, endTime: tempEndTime });
                      setTimeError(null);
                      setShowEndTimePicker(false);
                      aiTouched("endTime");
                    }} data-testid="button-confirm-end-time">Confirm</Button>
                    <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowEndTimePicker(false)}>Cancel</Button>
                  </div>
                )}

                <div className="grid sm:grid-cols-3 gap-4">
                  <div className="space-y-1">
                    <MandatoryLabel>Location{aiMark("locationText")}</MandatoryLabel>
                    <EditableText
                      value={locationText}
                      onChange={(v) => { setLocationText(v); aiTouched("locationText"); }}
                      placeholder="e.g., Party Room A, Outdoor Area..."
                      data-testid="input-location-text"
                    />
                  </div>
                  <div className="space-y-1">
                    <MandatoryLabel>Expected Kids{aiMark("numChildren")}</MandatoryLabel>
                    <EditableText
                      type="number"
                      value={String(eventData.numChildren || "")}
                      onChange={(v) => { setEventData({ ...eventData, numChildren: parseInt(v) || 0 }); aiTouched("numChildren"); }}
                      placeholder="0"
                      data-testid="input-num-children"
                    />
                  </div>
                  <div className="space-y-1">
                    <MandatoryLabel>Expected Adults{aiMark("numAdults")}</MandatoryLabel>
                    <EditableText
                      type="number"
                      value={String(eventData.numAdults || "")}
                      onChange={(v) => { setEventData({ ...eventData, numAdults: parseInt(v) || 0 }); aiTouched("numAdults"); }}
                      placeholder="0"
                      data-testid="input-num-adults"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Final Message to Parent <span className="text-[10px] font-normal opacity-60 ml-1">— staff only, not printed</span></Label>
                  <EditableText
                    value={eventData.internalStaffNotes || ""}
                    onChange={(v) => setEventData({ ...eventData, internalStaffNotes: v })}
                    placeholder="Paste the final message sent to the parent..."
                    multiline
                    data-testid="textarea-internal-notes"
                  />
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* 2. Party Host (overflow overrides let search dropdowns escape accordion bounds) */}
          <AccordionItem value="party-host" className="border rounded-lg border-l-4 border-l-pink-500 bg-pink-500/5 overflow-visible [&>[data-state=open]]:overflow-visible">
            <AccordionTrigger className="px-4 hover:no-underline" data-testid="accordion-party-host">
              <div className="flex items-center gap-2">
                <User className="h-4 w-4 text-pink-500" />
                <span>Party Host</span>
                <StatusIcon status={getSectionStatus("party-host")} />
                {aiSectionMark("party-host")}
              </div>
            </AccordionTrigger>
            <AccordionContent className={`px-4 pb-4 overflow-visible ${readOnly ? "opacity-75 cursor-not-allowed" : ""}`}>
              <div className="grid gap-4">
                <div className="space-y-2">
                  <MandatoryLabel>Assigned Party Host{aiMark("team:partyHost")}</MandatoryLabel>
                  <AssignmentSearchBar
                    value={partyHostAssignmentValue}
                    onChange={(values) => { handlePartyHostChange(values); aiTouched("team:partyHost"); }}
                    employees={allEmployees || []}
                    roles={allRoles || []}
                    placeholder="Search employees or roles..."
                    showEveryone={false}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="flex items-center gap-1">Entertainment Host (Optional){aiMark("team:entertainmentHost")}</Label>
                  <AssignmentSearchBar
                    value={entertainmentHostAssignmentValue}
                    onChange={(values) => { handleEntertainmentHostChange(values); aiTouched("team:entertainmentHost"); }}
                    employees={(allEmployees || []).filter(e => e.id !== partyHost.assignedEmployeeId)}
                    placeholder="Search employees to assign as entertainment host..."
                    showEveryone={false}
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-medium">Entertainment Acts</Label>
                    {!readOnly && (
                      <button
                        type="button"
                        className="text-[10px] font-semibold px-2 py-0.5 rounded-full border cursor-pointer bg-pink-500/15 text-pink-600 border-pink-500/30 dark:text-pink-400 hover:bg-pink-500/25 transition-colors"
                        onClick={() => addEntItemMutation.mutate({ customName: "" })}
                        disabled={addEntItemMutation.isPending}
                        data-testid="button-add-entertainment-act"
                      >
                        + Add Act
                      </button>
                    )}
                  </div>
                  {entertainmentItems.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic" data-testid="text-no-entertainment-acts">
                      No entertainment acts yet. Add one and give it a time to put it on the Timeline.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {entertainmentItems.map((act: any, idx: number) => (
                        <div
                          key={act.id}
                          className="flex items-center gap-2 p-2 rounded-lg border bg-background"
                          data-testid={`entertainment-act-${idx}`}
                        >
                          <EditableText
                            className="flex-1 text-sm min-w-0"
                            value={act.customName || ""}
                            onChange={(v) => updateEntItemMutation.mutate({ id: act.id, data: { customName: v } })}
                            placeholder="Act name (e.g. Spiderman Show)..."
                            disabled={readOnly}
                            data-testid={`input-entertainment-act-name-${idx}`}
                          />
                          <div className="flex items-center gap-1 shrink-0">
                            {act.startTime ? (
                              <span className="text-xs font-mono bg-muted px-2 py-0.5 rounded flex items-center gap-1">
                                <Clock className="h-2.5 w-2.5" />
                                {act.startTime}
                              </span>
                            ) : (
                              <span className="text-[10px] text-muted-foreground/60">no time</span>
                            )}
                            {!readOnly && (
                              <input
                                type="time"
                                className="text-xs border rounded px-1.5 py-0.5 bg-background w-[88px]"
                                value={act.startTime || ""}
                                onChange={(e) => updateEntItemMutation.mutate({ id: act.id, data: { startTime: e.target.value || null } })}
                                title="Start time — auto-adds this act to the Timeline"
                                data-testid={`input-entertainment-act-time-${idx}`}
                              />
                            )}
                          </div>
                          {!readOnly && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                              onClick={() => deleteEntItemMutation.mutate(act.id)}
                              data-testid={`button-delete-entertainment-act-${idx}`}
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      ))}
                      <p className="text-[10px] text-muted-foreground/70">
                        Set a start time to auto-add the act to the Timeline. Changes sync when you save the BEO.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          {beoData.eventType === "birthday" && (
            <AccordionItem value="birthday-package" className="border rounded-lg border-l-4 border-l-indigo-500 bg-indigo-500/5">
              <AccordionTrigger className="px-4 hover:no-underline" data-testid="accordion-birthday-package">
                <div className="flex min-w-0 items-center gap-2">
                  <Gift className="h-4 w-4 shrink-0 text-indigo-500" />
                  <span>Birthday Package</span>
                  {aiSectionMark("birthday-package")}
                </div>
              </AccordionTrigger>
              <AccordionContent className="px-4 pb-4">
                <BeoPackageModule
                  eventId={eventId}
                  readOnly={readOnly}
                  section="package"
                  party={{ eventDate: eventData.eventDate ?? null, numChildren: eventData.numChildren ?? null, numAdults: eventData.numAdults ?? null }}
                  onPackageApplied={({ setMenuTemplateId: packageSetMenuId }) => {
                    // The package's set menu starts the kitchen plan's, as the
                    // server did; a set menu already chosen here stays.
                    if (packageSetMenuId && !setMenuTemplateId) {
                      setSetMenuEnabled(true);
                      setSetMenuTemplateId(packageSetMenuId);
                    }
                  }}
                />
              </AccordionContent>
            </AccordionItem>
          )}

          {/* 3. POS */}
          <AccordionItem value="party-details" className="border rounded-lg border-l-4 border-l-indigo-500 bg-indigo-500/5">
            <AccordionTrigger className="px-4 hover:no-underline" data-testid="accordion-party-details">
              <div className="flex items-center gap-2 w-full">
                <Gift className="h-4 w-4 text-indigo-500" />
                <span>POS</span>
                <StatusIcon status={getSectionStatus("party-details")} />
                {aiSectionMark("party-details")}
                {packageName && (
                  <Badge variant="secondary" className="ml-1 text-xs">{packageName}</Badge>
                )}
                {tillFigures && tillFigures.expectedSatang > 0 && (
                  <Badge variant="outline" className="ml-1 text-xs font-mono" data-testid="badge-party-details-total">
                    {bahtOfSatang(tillFigures.expectedSatang)}
                  </Badge>
                )}
                <BeoTaskBadge prefix="💰 POS Setup:" label="Mark POS Done" />
              </div>
            </AccordionTrigger>
            <AccordionContent className={`px-4 pb-4 ${readOnly ? "opacity-75 cursor-not-allowed" : ""}`}>
              <div className="space-y-4">
                {/* SCRUM-822: no price is typed here: the package's price for the party's day and every
                    charge are the till's (the tiles below and the Billing section). */}
                <div className="flex items-end gap-3">
                  <div className="flex-1 space-y-1">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1">POS Name{aiMark("posName")}</Label>
                    <EditableText
                      value={packageName}
                      onChange={(v) => { setPackageName(v); aiTouched("posName"); }}
                      placeholder="e.g., Platinum POS"
                      data-testid="input-package-name"
                    />
                  </div>
                </div>

                <Separator />

                <div className="space-y-2">
                  <Label className="text-sm font-medium">Line Items</Label>
                  <p className="text-xs text-muted-foreground" data-testid="text-party-details-lines-note">
                    What the POS team should know is included or extra. The prices are the till's.
                  </p>

                  {packageItems.length === 0 ? (
                    <div
                      className="text-sm text-muted-foreground text-center py-4 border border-dashed rounded-md cursor-pointer hover:bg-accent/30 hover:border-border transition-colors"
                      onClick={() => addPackageItem("included")}
                      data-testid="button-add-first-package-item"
                    >
                      No line items yet. Click to add the first.
                    </div>
                  ) : (
                    <>
                      {packageItems.map((item, idx) => (
                        <PackageLineItemRow
                          key={item.id}
                          item={item}
                          idx={idx}
                          packageItems={packageItems}
                          setPackageItems={setPackageItems}
                        />
                      ))}
                      <div className="flex gap-2 pt-1">
                        <button
                          className="text-[10px] font-semibold px-2 py-0.5 rounded-full border cursor-pointer bg-emerald-500/15 text-emerald-600 border-emerald-500/30 dark:text-emerald-400 hover:bg-emerald-500/25 transition-colors"
                          onClick={() => addPackageItem("included")}
                          data-testid="button-add-included-item"
                        >
                          + INCL
                        </button>
                        <button
                          className="text-[10px] font-semibold px-2 py-0.5 rounded-full border cursor-pointer bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400 hover:bg-amber-500/25 transition-colors"
                          onClick={() => addPackageItem("extra")}
                          data-testid="button-add-extra-item"
                        >
                          + EXTRA
                        </button>
                      </div>
                    </>
                  )}
                </div>

                <Separator />

                {/* SCRUM-822: Total and Outstanding are the till's; the deposit stays the BEO's one figure (SCRUM-813). */}
                <PartyDetailsTillTiles
                  reading={tillBilling.data}
                  loading={tillBilling.isLoading}
                  depositUnsaved={depositUnsaved}
                  deposit={
                    <>
                      <Label className="text-xs text-muted-foreground flex items-center gap-1">Deposit{aiMark("deposit")}</Label>
                      <EditableText
                        type="number"
                        className="font-mono text-lg font-bold"
                        value={String(prepaymentReceived || "")}
                        onChange={(v) => { setPrepaymentReceived(Number(v) || 0); aiTouched("deposit"); }}
                        placeholder="0"
                        data-testid="input-prepayment"
                      />
                      <DatePicker
                        value={depositDate}
                        onChange={setDepositDate}
                        placeholder="Deposit date"
                        className="h-7 text-xs"
                        data-testid="datepicker-deposit-date"
                      />
                    </>
                  }
                />

                <Separator />

                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground flex items-center gap-1">POS Notes{aiMark("posNotes")}</Label>
                  <EditableText
                    value={packageNotes}
                    onChange={(v) => { setPackageNotes(v); aiTouched("posNotes"); }}
                    placeholder="Any notes about the POS, billing, or special arrangements..."
                    multiline
                    data-testid="textarea-package-notes"
                  />
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* SCRUM-822: Billing — the till's figures on top, the app's own billing module kept whole below. */}
          <AccordionItem value="billing" className="border rounded-lg border-l-4 border-l-emerald-500 bg-emerald-500/5">
            <AccordionTrigger className="px-4 hover:no-underline" data-testid="accordion-billing">
              <div className="flex items-center gap-2 w-full">
                <DollarSign className="h-4 w-4 text-emerald-500" />
                <span>Billing</span>
                {tillFigures && (
                  <Badge variant="outline" className="ml-1 text-xs font-mono" data-testid="badge-billing-outstanding">
                    {tillFigures.outstandingSatang > 0 ? `${bahtOfSatang(tillFigures.outstandingSatang)} outstanding` : "Paid"}
                  </Badge>
                )}
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4">
              <BeoBillingSection
                eventId={eventId}
                billing={billingRow}
                onBillingChange={changeBilling}
                isManager={canManageBilling}
                eventDeposit={eventDeposit}
                onDepositMoved={() => void readDepositAgain()}
              />
            </AccordionContent>
          </AccordionItem>

          {/* 4. Setup Plan */}
          <AccordionItem value="setup-plan" className="border rounded-lg border-l-4 border-l-orange-500 bg-orange-500/5">
            <AccordionTrigger className="px-4 hover:no-underline" data-testid="accordion-setup-plan">
              <div className="flex items-center gap-2 w-full">
                <Settings className="h-4 w-4 text-orange-500" />
                <span>Setup Plan</span>
                <StatusIcon status={getSectionStatus("setup-plan")} />
                {aiSectionMark("setup-plan")}
                {setupTasks.length > 0 && (
                  <Badge variant="secondary" className="ml-1 text-xs">{setupTasks.length} tasks</Badge>
                )}
                <BeoTaskBadge prefix="🔧 Setup:" label="Mark Setup Done" />
              </div>
            </AccordionTrigger>
            <AccordionContent className={`px-4 pb-4 ${readOnly ? "opacity-75 cursor-not-allowed" : ""}`}>
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">What needs to be set up, by when, and who's responsible.</p>

                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="flex items-center gap-2">
                    <Label className="text-sm text-muted-foreground whitespace-nowrap flex items-center gap-1">Ready by{aiMark("setupReadyBy")}</Label>
                    <div className="flex items-center gap-1">
                      {setupReadyBy ? (
                        <>
                          <span className="text-sm font-mono bg-muted px-2 py-1 rounded">{setupReadyBy}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground"
                            onClick={() => { setTempReadyByTime(setupReadyBy); setShowReadyByTimePicker(true); }}
                            data-testid="button-ready-by-edit"
                          >
                            <Settings className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            onClick={() => setSetupReadyBy("")}
                            data-testid="button-ready-by-clear"
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => { setTempReadyByTime("09:00"); setShowReadyByTimePicker(true); }}
                          data-testid="input-setup-ready-by"
                        >
                          <Clock className="h-3 w-3 mr-1" />
                          Set Time
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 relative">
                    <Label className="text-sm text-muted-foreground whitespace-nowrap flex items-center gap-1">Who{aiMark(aiMarks["team:setupResponsible"] ? "team:setupResponsible" : "setupResponsible")}</Label>
                    <div className="flex-1 relative">
                      {setupResponsible && !showResponsibleDropdown ? (
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => {
                            setSetupResponsibleSearch("");
                            setShowResponsibleDropdown(true);
                            setTimeout(() => responsibleSearchRef.current?.focus(), 0);
                          }}
                          className="w-full rounded-md px-3 py-1.5 text-sm cursor-text transition-colors min-h-[32px] flex items-center hover:bg-accent/50 border border-transparent hover:border-border"
                          data-testid="input-setup-responsible"
                        >
                          {setupResponsible}
                        </div>
                      ) : (
                        <div className="relative">
                          <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
                          <input
                            ref={responsibleSearchRef}
                            type="text"
                            className="w-full rounded-md border border-input bg-background pl-8 pr-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring h-8"
                            value={showResponsibleDropdown ? setupResponsibleSearch : setupResponsible}
                            onChange={(e) => {
                              setSetupResponsibleSearch(e.target.value);
                              setShowResponsibleDropdown(true);
                            }}
                            onFocus={() => setShowResponsibleDropdown(true)}
                            onBlur={() => {
                              setTimeout(() => {
                                setShowResponsibleDropdown(false);
                                if (setupResponsibleSearch && !setupResponsible) {
                                  setSetupResponsible(setupResponsibleSearch);
                                  aiTouchedSetupWho();
                                }
                              }, 200);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") {
                                setShowResponsibleDropdown(false);
                                (e.target as HTMLInputElement).blur();
                              }
                              if (e.key === "Enter" && setupResponsibleSearch) {
                                setSetupResponsible(setupResponsibleSearch);
                                setShowResponsibleDropdown(false);
                                (e.target as HTMLInputElement).blur();
                                aiTouchedSetupWho();
                              }
                            }}
                            placeholder="Search employee, dept..."
                            data-testid="input-setup-responsible-search"
                          />
                          {showResponsibleDropdown && responsibleSearchResults.length > 0 && (
                            <div className="absolute z-50 top-full mt-1 w-full bg-popover border rounded-md shadow-lg max-h-48 overflow-y-auto">
                              {responsibleSearchResults.map((r) => (
                                <button
                                  key={`${r.type}-${r.id}`}
                                  type="button"
                                  className="w-full text-left px-3 py-2 text-sm hover:bg-accent flex items-center gap-2"
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    setSetupResponsible(r.label);
                                    setSetupResponsibleId(r.id);
                                    setSetupResponsibleType(r.type);
                                    setSetupResponsibleSearch("");
                                    setShowResponsibleDropdown(false);
                                    aiTouchedSetupWho();
                                  }}
                                  data-testid={`responsible-option-${r.type}-${r.id}`}
                                >
                                  {r.type === "employee" ? (
                                    <Users className="h-3.5 w-3.5 text-emerald-500" />
                                  ) : (
                                    <Building2 className="h-3.5 w-3.5 text-indigo-500" />
                                  )}
                                  {r.label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {setupResponsible && (
                        <button
                          className="absolute right-2 top-1.5 text-muted-foreground hover:text-foreground"
                          onClick={() => {
                            setSetupResponsible("");
                            setSetupResponsibleId(null);
                            setSetupResponsibleType(null);
                            setSetupResponsibleSearch("");
                            setShowResponsibleDropdown(true);
                            setTimeout(() => responsibleSearchRef.current?.focus(), 0);
                            aiTouchedSetupWho();
                          }}
                          data-testid="button-clear-responsible"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {showReadyByTimePicker && (
                  <div className="flex items-center gap-2 p-2 border rounded-md bg-muted/30">
                    <input
                      type="time"
                      className="text-sm border rounded px-2 py-1 bg-background"
                      value={tempReadyByTime}
                      onChange={(e) => setTempReadyByTime(e.target.value)}
                      data-testid="input-ready-by-time"
                    />
                    <Button type="button" size="sm" className="h-7 text-xs" onClick={() => { setSetupReadyBy(tempReadyByTime); setShowReadyByTimePicker(false); aiTouched("setupReadyBy"); }} data-testid="button-confirm-ready-by-time">Confirm</Button>
                    <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowReadyByTimePicker(false)}>Cancel</Button>
                  </div>
                )}

                {setupTasks.length === 0 ? (
                  <div
                    className="text-sm text-muted-foreground text-center py-4 border border-dashed rounded-md cursor-pointer hover:bg-accent/30 hover:border-border transition-colors"
                    onClick={addSetupTask}
                    data-testid="button-add-first-setup-task"
                  >
                    No setup tasks yet. Click to add the first.
                  </div>
                ) : (
                  <>
                    {setupTasks.map((task, idx) => (
                      <div key={task.id} className="border rounded-md px-3 py-2 space-y-1.5" data-testid={`setup-task-row-${idx}`}>
                        <div className="flex items-center gap-2">
                          <EditableText
                            className="flex-1 text-sm"
                            value={task.itemLabel}
                            onChange={(v) => updateSetupTask(task.id, { itemLabel: v })}
                            onEnter={() => {
                              addSetupTask();
                              setTimeout(() => {
                                const el = document.querySelector(`[data-testid="input-setup-item-${idx + 1}"]`) as HTMLElement;
                                if (el) el.click();
                              }, 50);
                            }}
                            placeholder="What needs to be set up..."
                            data-testid={`input-setup-item-${idx}`}
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0"
                            onClick={() => {
                              const updated = [...setupTasks];
                              updated[idx] = { ...task, notes: task.notes ? "" : " " };
                              setSetupTasks(updated);
                            }}
                            data-testid={`button-toggle-task-notes-${idx}`}
                          >
                            <MessageSquare className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
                            onClick={() => removeSetupTask(task.id)}
                            data-testid={`button-remove-task-${idx}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        {task.notes !== undefined && task.notes !== "" && (
                          <EditableText
                            className="text-xs"
                            value={task.notes.trim()}
                            onChange={(v) => updateSetupTask(task.id, { notes: v })}
                            placeholder="Notes (optional)"
                            data-testid={`input-setup-notes-${idx}`}
                          />
                        )}
                      </div>
                    ))}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={addSetupTask}
                      className="w-full mt-2"
                      data-testid="button-add-setup-task"
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      Add Task
                    </Button>
                  </>
                )}

                <details className="mt-2">
                  <summary className="text-sm text-muted-foreground cursor-pointer">General Setup Notes</summary>
                  <EditableText
                    value={setupNotes}
                    onChange={setSetupNotes}
                    placeholder="General setup notes..."
                    multiline
                    className="mt-2"
                    data-testid="textarea-setup-notes"
                  />
                </details>
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* 5. Kitchen Plan (items marked included or extra, no costs) */}
          <AccordionItem value="kitchen-plan" className="border rounded-lg border-l-4 border-l-blue-500 bg-blue-500/5">
            <AccordionTrigger className="px-4 hover:no-underline" data-testid="accordion-kitchen-plan">
              <div className="flex items-center gap-2 w-full">
                <UtensilsCrossed className="h-4 w-4 text-blue-500" />
                <span>Kitchen Plan</span>
                <StatusIcon status={getSectionStatus("kitchen-plan")} />
                {aiSectionMark("kitchen-plan")}
                <BeoTaskBadge prefix="🍽️ Kitchen:" label="Mark Kitchen Done" />
              </div>
            </AccordionTrigger>
            <AccordionContent className={`px-4 pb-4 ${readOnly ? "opacity-75 cursor-not-allowed" : ""}`}>
              <div className="grid gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant={!kitchenRequired ? "default" : "outline"}
                    size="sm"
                    onClick={() => setKitchenRequired(false)}
                    data-testid="button-food-not-needed"
                  >
                    Not Needed
                  </Button>
                  <Button
                    variant={kitchenRequired ? "default" : "outline"}
                    size="sm"
                    onClick={() => setKitchenRequired(true)}
                    data-testid="button-food-needed"
                  >
                    Needed
                  </Button>
                </div>

                {kitchenRequired && (
                  <>
                    <div className="space-y-2">
                      <Label>Menus</Label>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="flex gap-1">
                          <Button
                            variant={menuTab === "kids" ? "default" : "outline"}
                            size="sm"
                            onClick={() => setMenuTab("kids")}
                            data-testid="button-menu-tab-kids"
                          >
                            Kids Menu ({kidsMenu.length})
                          </Button>
                          <Button
                            variant={menuTab === "adults" ? "default" : "outline"}
                            size="sm"
                            onClick={() => setMenuTab("adults")}
                            data-testid="button-menu-tab-adults"
                          >
                            Adults Menu ({adultsDiffer ? adultsMenu.length : kidsMenu.length})
                          </Button>
                        </div>
                        <div className="flex items-center gap-2 ml-auto">
                          <span className="text-xs text-muted-foreground">Service:</span>
                          {(menuTab === "kids" ? kidsFoodTime : adultsFoodTime) ? (
                            <div className="flex items-center gap-1">
                              <span className="text-sm font-mono bg-muted px-2 py-1 rounded">{menuTab === "kids" ? kidsFoodTime : adultsFoodTime}</span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground"
                                onClick={() => { setFoodTimeTarget(menuTab); setTempFoodTime((menuTab === "kids" ? kidsFoodTime : adultsFoodTime) || "12:00"); setShowFoodTimePicker(true); }}
                                data-testid={`button-food-time-edit-${menuTab}`}
                              >
                                <Settings className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                onClick={() => menuTab === "kids" ? setKidsFoodTime("") : setAdultsFoodTime("")}
                                data-testid={`button-food-time-clear-${menuTab}`}
                              >
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          ) : (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => { setFoodTimeTarget(menuTab); setTempFoodTime("12:00"); setShowFoodTimePicker(true); }}
                              data-testid={`input-food-service-time-${menuTab}`}
                            >
                              <Clock className="h-3 w-3 mr-1" />
                              Set Time
                            </Button>
                          )}
                        </div>
                      </div>

                      {showFoodTimePicker && foodTimeTarget === menuTab && (
                        <div className="flex items-center gap-2 p-2 border rounded-md bg-muted/30">
                          <input
                            type="time"
                            className="text-sm border rounded px-2 py-1 bg-background"
                            value={tempFoodTime}
                            onChange={(e) => setTempFoodTime(e.target.value)}
                            data-testid="input-food-time"
                          />
                          <Button type="button" size="sm" className="h-7 text-xs" onClick={() => { if (foodTimeTarget === "kids") setKidsFoodTime(tempFoodTime); else setAdultsFoodTime(tempFoodTime); setShowFoodTimePicker(false); }} data-testid="button-confirm-food-time">Confirm</Button>
                          <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowFoodTimePicker(false)}>Cancel</Button>
                        </div>
                      )}

                      {(() => {
                        const isKids = menuTab === "kids";
                        const currentMenu = isKids ? kidsMenu : adultsMenu;
                        const setCurrentMenu = isKids ? setKidsMenu : setAdultsMenu;

                        if (isKids) {
                          const activeTemplates = setMenuTemplates.filter(t => t.isActive);
                          const selectedTemplate = setMenuTemplates.find(t => t.id === setMenuTemplateId);

                          return (
                            <div className="space-y-3">
                              {/* Set Menu Toggle */}
                              <div className="flex items-center gap-3 p-3 border rounded-md bg-muted/30">
                                <Switch
                                  checked={setMenuEnabled}
                                  onCheckedChange={(v) => {
                                    if (!v) {
                                      const hasSetMenuItems = [...kidsMenu, ...adultsMenu].some(m => m.source === "set_menu");
                                      if (hasSetMenuItems && !window.confirm("Disabling Set Menu will keep existing set-menu items in the menu. To clear them, use Reset Selections beside the parent link first; that also clears the parent's submitted choices and replaces the parent link with a new one. Continue?")) {
                                        return;
                                      }
                                      setSetMenuTemplateId("");
                                    }
                                    setSetMenuEnabled(v);
                                  }}
                                  data-testid="switch-set-menu-enabled"
                                />
                                <div>
                                  <Label className="text-sm font-medium">Set Menu</Label>
                                  <p className="text-xs text-muted-foreground">Attach a birthday package set menu and send a link to parents for their choices</p>
                                </div>
                              </div>

                              {setMenuEnabled && (
                                <>
                                  {/* Template Picker */}
                                  <div className="space-y-1">
                                    <Label className="text-xs text-muted-foreground">Set Menu Template</Label>
                                    <Select value={setMenuTemplateId} onValueChange={setSetMenuTemplateId}>
                                      <SelectTrigger className="text-sm" data-testid="select-set-menu-template">
                                        <SelectValue placeholder="Pick a template..." />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {activeTemplates.length === 0 ? (
                                          <SelectItem value="__none__" disabled>No templates — add one in Event Settings</SelectItem>
                                        ) : (
                                          activeTemplates.map(t => (
                                            <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                                          ))
                                        )}
                                      </SelectContent>
                                    </Select>
                                  </div>

                                  {selectedTemplate && (
                                    <>
                                      {/* SET MENU block */}
                                      {(() => {
                                        const resolvedMenu = kidsMenu.some((item) => item.source === "set_menu")
                                          ? kidsMenu
                                          : adultsMenu;
                                        const resolvedMenuTab = resolvedMenu === kidsMenu ? "kids" : "adults";
                                        const setResolvedMenu = resolvedMenuTab === "kids" ? setKidsMenu : setAdultsMenu;
                                        const resolvedSetMenuItems = resolvedMenu.filter(m => m.source === "set_menu");
                                        const hasResolved = setMenuSelection?.isSubmitted === true;
                                        return (
                                          <div className="border-2 border-emerald-500/40 rounded-lg overflow-hidden">
                                            <div className="bg-emerald-500/15 px-3 py-1.5 flex items-center gap-2">
                                              <ListChecks className="h-3.5 w-3.5 text-emerald-600" />
                                              <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wide">Set Menu</span>
                                              <Badge variant="outline" className="text-[10px] px-1.5 bg-emerald-500/10 text-emerald-600 border-emerald-500/30 ml-1">{selectedTemplate.name}</Badge>
                                              {/* SCRUM-927: choices read from the chat are not a parent's: no "Selections received". */}
                                              {setMenuSelection?.isSubmitted && (
                                                <Badge className="text-[10px] px-1.5 bg-emerald-500 text-white ml-auto" data-testid="badge-set-menu-selection">
                                                  {choicesFromChatOnly(setMenuSelection.selections) ? SET_MENU_CHOSEN_FROM_CHAT : "Selections received"}
                                                </Badge>
                                              )}
                                              {setMenuSelection && !setMenuSelection.isSubmitted && (
                                                <Badge variant="outline" className="text-[10px] px-1.5 ml-auto text-amber-600 border-amber-500/30 bg-amber-500/10">Awaiting parent</Badge>
                                              )}
                                            </div>

                                            <SetMenuChoiceGroups
                                              template={selectedTemplate}
                                              resolvedItems={resolvedSetMenuItems}
                                              hasResolved={hasResolved}
                                            />

                                            {/* Manager override: editable resolved items */}
                                            <div className="p-3 space-y-1.5">
                                              <div className="flex items-center gap-2">
                                                <p className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wide">
                                                  {hasResolved ? "Resolved Items (editable)" : "Manual Override"}
                                                </p>
                                              </div>
                                              {hasResolved ? (
                                                <>
                                                  {resolvedSetMenuItems.map((item, idx) => {
                                                    const absIdx = resolvedMenu.findIndex(m => m === item);
                                                    return (
                                                      <MenuLineItemRow
                                                        key={item.id}
                                                        item={item}
                                                        idx={absIdx >= 0 ? absIdx : idx}
                                                        menuItems={resolvedMenu}
                                                        setMenuItems={setResolvedMenu}
                                                        menuTab={resolvedMenuTab}
                                                      />
                                                    );
                                                  })}
                                                </>
                                              ) : (
                                                <p className="text-xs text-muted-foreground italic">Parent selections appear here after submission. You can also add items manually below.</p>
                                              )}
                                              <button
                                                className="text-[10px] font-semibold px-2 py-0.5 rounded-full border cursor-pointer bg-emerald-500/15 text-emerald-600 border-emerald-500/30 dark:text-emerald-400 hover:bg-emerald-500/25 transition-colors"
                                                onClick={() => {
                                                  const newItem: MenuLine = {
                                                    id: `menu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                                                    itemName: "",
                                                    quantity: 1,
                                                    notes: "",
                                                    included: true,
                                                    price: 0,
                                                    source: "set_menu",
                                                  };
                                                  setResolvedMenu(prev => [...prev, newItem]);
                                                }}
                                                data-testid="button-add-set-menu-item"
                                              >
                                                + Add item
                                              </button>
                                            </div>
                                          </div>
                                        );
                                      })()}

                                      {/* Parent link controls */}
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          className="text-xs h-8"
                                          onClick={() => {
                                            if (setMenuSelection && setMenuSelection.templateId === setMenuTemplateId) {
                                              setShowParentLinkDialog(true);
                                            } else {
                                              generateLinkMutation.mutate();
                                            }
                                          }}
                                          disabled={!setMenuTemplateId || generateLinkMutation.isPending}
                                          data-testid="button-get-parent-link"
                                        >
                                          {generateLinkMutation.isPending ? (
                                            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                          ) : (
                                            <Link2 className="h-3.5 w-3.5 mr-1.5" />
                                          )}
                                          Get Parent Link
                                        </Button>
                                        {setMenuSelection && (
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            className="text-xs h-8 text-muted-foreground"
                                            onClick={() => resetSelectionMutation.mutate()}
                                            disabled={resetSelectionMutation.isPending}
                                            data-testid="button-reset-selections"
                                          >
                                            {resetSelectionMutation.isPending ? (
                                              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                            ) : (
                                              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                                            )}
                                            Reset Selections
                                          </Button>
                                        )}
                                        {setMenuSelection?.isSubmitted && setMenuSelection.submittedAt && (
                                          <span className="text-xs text-muted-foreground" data-testid="text-set-menu-selection-date">
                                            {choicesFromChatOnly(setMenuSelection.selections) ? "Chosen from the chat" : "Received"} {new Date(setMenuSelection.submittedAt).toLocaleDateString()}
                                          </span>
                                        )}
                                      </div>
                                    </>
                                  )}
                                </>
                              )}

                              {/* Additional Items section */}
                              <div className="space-y-2">
                                {setMenuEnabled && (
                                  <div className="flex items-center gap-2">
                                    <Label className="text-xs text-muted-foreground uppercase tracking-wide">Additional Items</Label>
                                  </div>
                                )}
                                {(() => {
                                  const additionalItems = setMenuEnabled
                                    ? currentMenu.filter(m => m.source !== "set_menu")
                                    : currentMenu;
                                  const setAdditionalItems = (updater: (prev: MenuLine[]) => MenuLine[]) => {
                                    if (setMenuEnabled) {
                                      setKidsMenu(prev => {
                                        const setMenuItems = prev.filter(m => m.source === "set_menu");
                                        const additional = prev.filter(m => m.source !== "set_menu");
                                        const updatedAdditional = updater(additional);
                                        return [...setMenuItems, ...updatedAdditional];
                                      });
                                    } else {
                                      setKidsMenu(updater);
                                    }
                                  };
                                  return (
                                    <>
                                      {additionalItems.length === 0 && !setMenuEnabled ? (
                                        <div
                                          className="text-sm text-muted-foreground text-center py-4 border border-dashed rounded-md cursor-pointer hover:bg-accent/30 hover:border-border transition-colors"
                                          onClick={() => {
                                            // SCRUM-958 (SCRUM-940 point 2): the first line shows the EXTRA badge, so it is saved as one.
                                            setCurrentMenu([{
                                              id: `menu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                                              itemName: "",
                                              quantity: 1,
                                              notes: "",
                                              included: false,
                                              price: 0,
                                            }]);
                                            setTimeout(() => {
                                              const el = document.querySelector(`[data-testid="input-menu-name-kids-0"]`) as HTMLElement;
                                              if (el) el.click();
                                            }, 50);
                                          }}
                                          data-testid="button-add-first-menu-kids"
                                        >
                                          Nothing on the kids' menu yet. Click to add the first item.
                                        </div>
                                      ) : (
                                        <>
                                          {additionalItems.map((item, idx) => {
                                            const absIdx = setMenuEnabled
                                              ? currentMenu.findIndex(m => m === item)
                                              : idx;
                                            return (
                                              <MenuLineItemRow
                                                key={item.id}
                                                item={item}
                                                idx={absIdx >= 0 ? absIdx : idx}
                                                menuItems={currentMenu}
                                                setMenuItems={setCurrentMenu}
                                                menuTab="kids"
                                              />
                                            );
                                          })}
                                        </>
                                      )}
                                      <div className={`flex gap-2 pt-1 ${additionalItems.length === 0 && !setMenuEnabled ? "hidden" : ""}`}>
                                        <button
                                          className="text-[10px] font-semibold px-2 py-0.5 rounded-full border cursor-pointer bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400 hover:bg-amber-500/25 transition-colors"
                                          onClick={() => {
                                            const newItem: MenuLine = {
                                              id: `menu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                                              itemName: "",
                                              quantity: 1,
                                              notes: "",
                                              included: false,
                                              price: 0,
                                              source: setMenuEnabled ? "additional" : undefined,
                                            };
                                            setCurrentMenu(prev => [...prev, newItem]);
                                          }}
                                          data-testid="button-add-menu-extra-kids"
                                        >
                                          + EXTRA
                                        </button>
                                      </div>
                                      {!readOnly && (
                                        <div className="flex gap-2 pt-1">
                                          <button
                                            type="button"
                                            className="text-[10px] font-semibold px-2 py-0.5 rounded-full border cursor-pointer bg-violet-500/15 text-violet-600 border-violet-500/30 dark:text-violet-400 hover:bg-violet-500/25 transition-colors"
                                            onClick={() => setNewItemMenu("kids")}
                                            title="An item the till's menu does not have yet: it is added to the till for this party only"
                                            data-testid="button-add-party-menu-item-kids"
                                          >
                                            + NEW ITEM (not in the menu)
                                          </button>
                                        </div>
                                      )}
                                    </>
                                  );
                                })()}
                              </div>
                            </div>
                          );
                        }

                        // SCRUM-829: the adults' section starts from the kids' menu. With "Different
                        // for adults" off it IS the kids' list (shown as such, no option list of its
                        // own and nothing to type); on, it is the adults' own list, started as a copy
                        // of the kids' and changed here.
                        const switchAdults = (on: boolean) => {
                          if (on) {
                            setAdultsMenu(kidsMenu.map((line, index) => ({ ...line, id: `menu_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}` })));
                            setAdultsDiffer(true);
                            return;
                          }
                          if (
                            adultsMenu.length > 0 &&
                            !kitchenListsEqual(kidsMenu, adultsMenu) &&
                            !window.confirm("Turning this off makes the adults' menu the kids' menu again: the adults' own changes are dropped. Continue?")
                          ) {
                            return;
                          }
                          setAdultsMenu([]);
                          setAdultsDiffer(false);
                        };

                        return (
                          <div className="space-y-3">
                            <div className="flex items-center gap-3 p-3 border rounded-md bg-muted/30">
                              <Switch
                                checked={adultsDiffer}
                                onCheckedChange={switchAdults}
                                disabled={readOnly}
                                data-testid="switch-adults-differ"
                              />
                              <div>
                                <Label className="text-sm font-medium">Different for adults</Label>
                                <p className="text-xs text-muted-foreground">Off: the adults eat what was chosen for the kids. On: start from the kids' menu and change it for the adults.</p>
                              </div>
                            </div>

                            {!adultsDiffer ? (
                              <div className="space-y-1" data-testid="adults-menu-mirror">
                                <p className="text-xs text-muted-foreground italic" data-testid="text-adults-same-as-kids">{ADULTS_SAME_AS_KIDS}</p>
                                {kidsMenu.length === 0 ? (
                                  <p className="text-sm text-muted-foreground text-center py-4 border border-dashed rounded-md">Nothing on the kids' menu yet</p>
                                ) : (
                                  kidsMenu.map((item, index) => (
                                    <div key={item.id} className="flex items-center gap-2 text-sm py-0.5" data-testid={`adults-mirror-item-${index}`}>
                                      <span className="w-6 text-center text-xs font-medium shrink-0">{item.quantity}</span>
                                      <span className="text-xs">{item.itemName}</span>
                                      {item.notes?.trim() && <span className="text-xs text-muted-foreground shrink-0">{item.notes.trim()}</span>}
                                      {item.productCode && (
                                        <span className="text-[10px] font-mono text-muted-foreground shrink-0" title={tillCodeTitle(tillMenu.index, item.productCode)}>{item.productCode}</span>
                                      )}
                                      <TillCodeMark code={item.productCode} testId={`adults-mirror-code-dead-${index}`} />
                                    </div>
                                  ))
                                )}
                              </div>
                            ) : (
                              <>
                                {currentMenu.length === 0 ? (
                                  <div
                                    className="text-sm text-muted-foreground text-center py-4 border border-dashed rounded-md cursor-pointer hover:bg-accent/30 hover:border-border transition-colors"
                                    onClick={() => {
                                      // SCRUM-958 (SCRUM-940 point 2): the first line shows the EXTRA badge, so it is saved as one.
                                      setCurrentMenu([{
                                        id: `menu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                                        itemName: "",
                                        quantity: 1,
                                        notes: "",
                                        included: false,
                                        price: 0,
                                        source: setMenuEnabled ? "additional" : undefined,
                                      }]);
                                      setTimeout(() => {
                                        const el = document.querySelector(`[data-testid="input-menu-name-adults-0"]`) as HTMLElement;
                                        if (el) el.click();
                                      }, 50);
                                    }}
                                    data-testid="button-add-first-menu-adults"
                                  >
                                    Nothing on the adults' menu yet. Click to add the first item.
                                  </div>
                                ) : (
                                  <>
                                    {currentMenu.map((item, index) => (
                                      <MenuLineItemRow
                                        key={item.id}
                                        item={item}
                                        idx={index}
                                        menuItems={currentMenu}
                                        setMenuItems={setCurrentMenu}
                                        menuTab="adults"
                                        charge={extraCharges.kitchen.adults[index]}
                                      />
                                    ))}
                                  </>
                                )}
                                <div className={`flex gap-2 pt-1 ${currentMenu.length === 0 ? "hidden" : ""}`}>
                                  <button
                                    className="text-[10px] font-semibold px-2 py-0.5 rounded-full border cursor-pointer bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400 hover:bg-amber-500/25 transition-colors"
                                    onClick={() => {
                                      setCurrentMenu([...currentMenu, {
                                        id: `menu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                                        itemName: "",
                                        quantity: 1,
                                        notes: "",
                                        included: false,
                                        price: 0,
                                        source: setMenuEnabled ? "additional" : undefined,
                                      }]);
                                    }}
                                    data-testid="button-add-menu-extra-adults"
                                  >
                                    + EXTRA
                                  </button>
                                </div>
                                {!readOnly && (
                                  <div className="flex gap-2 pt-1">
                                    <button
                                      type="button"
                                      className="text-[10px] font-semibold px-2 py-0.5 rounded-full border cursor-pointer bg-violet-500/15 text-violet-600 border-violet-500/30 dark:text-violet-400 hover:bg-violet-500/25 transition-colors"
                                      onClick={() => setNewItemMenu("adults")}
                                      title="An item the till's menu does not have yet: it is added to the till for this party only"
                                      data-testid="button-add-party-menu-item-adults"
                                    >
                                      + NEW ITEM (not in the menu)
                                    </button>
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        );
                      })()}
                      {/* SCRUM-949: the kitchen's EXTRA lines as the till will charge them (the kids', and the adults' own). */}
                      <BeoExtrasTotal charges={[...extraCharges.kitchen.kids, ...extraCharges.kitchen.adults]} testId="text-kitchen-extras-total" />
                    </div>

                    <Separator />

                    <div className="space-y-2">
                      <Label className="flex items-center gap-1">Cake{aiMark("cake")}</Label>
                      <div className="flex gap-2 flex-wrap">
                        {["NONE", "INTERNAL", "EXTERNAL"].map((mode) => (
                          <Button
                            key={mode}
                            variant={cakeMode === mode ? "default" : "outline"}
                            size="sm"
                            onClick={() => { setCakeMode(mode); aiTouched("cake"); }}
                            data-testid={`button-cake-${mode.toLowerCase()}`}
                          >
                            {mode === "NONE" ? "No Cake" : mode === "INTERNAL" ? "Our Cake" : "Own Cake"}
                          </Button>
                        ))}
                      </div>
                      {/* SCRUM-787: a cake time or notes held under No Cake stays in sight, with what to choose to keep it. */}
                      <CakeUnderNoCake
                        cakeMode={cakeMode}
                        cakeTime={cakeTime}
                        cakeNotes={cakeNotes}
                        onClear={() => { setCakeTime(""); setCakeNotes(""); aiTouched("cake"); }}
                        disabled={readOnly}
                      />
                      {cakeMode !== "NONE" && (
                        <div className="space-y-2 mt-2">
                          <div className="flex gap-2 items-center flex-wrap">
                            <div className="flex items-center gap-1">
                              <Label className="text-xs text-muted-foreground whitespace-nowrap">Qty</Label>
                              <div className="flex items-center border rounded-md overflow-hidden">
                                {[1, 2, 3].map((q) => (
                                  <button
                                    key={q}
                                    type="button"
                                    onClick={() => setCakeQuantity(q)}
                                    data-testid={`button-cake-qty-${q}`}
                                    className={`px-2 py-0.5 text-xs font-semibold transition-colors ${cakeQuantity === q ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted text-foreground"}`}
                                  >
                                    {q}
                                  </button>
                                ))}
                              </div>
                            </div>
                            <button
                              type="button"
                              className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border cursor-pointer transition-colors ${
                                cakeIncluded
                                  ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/30 dark:text-emerald-400"
                                  : "bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400"
                              }`}
                              onClick={() => setCakeIncluded(!cakeIncluded)}
                              data-testid="button-cake-incl-toggle"
                            >
                              {cakeIncluded ? "INCL" : "EXTRA"}
                            </button>
                            <div className="flex items-center gap-1">
                              <Label className="text-xs text-muted-foreground whitespace-nowrap">Cake Time</Label>
                              {cakeTime ? (
                                <div className="flex items-center gap-1">
                                  <span className="text-sm font-mono bg-muted px-2 py-1 rounded">{cakeTime}</span>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 text-muted-foreground"
                                    onClick={() => { setTempCakeTime(cakeTime); setShowCakeTimePicker(true); }}
                                    data-testid="button-cake-time-edit"
                                  >
                                    <Settings className="h-3 w-3" />
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 text-muted-foreground hover:text-destructive"
                                    onClick={() => { setCakeTime(""); aiTouched("cake"); }}
                                    data-testid="button-cake-time-clear"
                                  >
                                    <X className="h-3 w-3" />
                                  </Button>
                                </div>
                              ) : (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-xs"
                                  onClick={() => { setTempCakeTime("14:00"); setShowCakeTimePicker(true); }}
                                  data-testid="input-cake-time"
                                >
                                  <Clock className="h-3 w-3 mr-1" />
                                  Set Time
                                </Button>
                              )}
                            </div>
                            {!cakeIncluded && (
                              <EditableText
                                type="number"
                                className="w-24 text-xs font-mono"
                                value={String(cakePrice || "")}
                                onChange={(v) => setCakePrice(Number(v) || 0)}
                                placeholder="Price ฿"
                                data-testid="input-cake-price"
                              />
                            )}
                          </div>
                          {showCakeTimePicker && (
                            <div className="flex items-center gap-2 p-2 border rounded-md bg-muted/30">
                              <input
                                type="time"
                                className="text-sm border rounded px-2 py-1 bg-background"
                                value={tempCakeTime}
                                onChange={(e) => setTempCakeTime(e.target.value)}
                                data-testid="input-cake-time-picker"
                              />
                              <Button type="button" size="sm" className="h-7 text-xs" onClick={() => { setCakeTime(tempCakeTime); setShowCakeTimePicker(false); aiTouched("cake"); }} data-testid="button-confirm-cake-time">Confirm</Button>
                              <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowCakeTimePicker(false)}>Cancel</Button>
                            </div>
                          )}
                          <EditableText
                            className="flex-1 min-w-[150px] text-sm"
                            value={cakeNotes}
                            onChange={(v) => { setCakeNotes(v); aiTouched("cake"); }}
                            placeholder="e.g., Dairy Queen (ordered on event day)"
                            data-testid="input-cake-notes"
                          />
                        </div>
                      )}
                    </div>

                  </>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* 6. Bar Plan */}
          <AccordionItem value="bar-plan" className="border rounded-lg border-l-4 border-l-teal-500 bg-teal-500/5">
            <AccordionTrigger className="px-4 hover:no-underline" data-testid="accordion-bar-plan">
              <div className="flex items-center gap-2">
                <Wine className="h-4 w-4 text-teal-500" />
                <span>Bar Plan</span>
                <StatusIcon status={barItems.length > 0 ? "complete" : "empty"} />
                {barItems.length > 0 && (
                  <Badge variant="secondary" className="ml-2 text-xs">{barItems.length} item{barItems.length !== 1 ? "s" : ""}</Badge>
                )}
              </div>
            </AccordionTrigger>
            <AccordionContent className={`px-4 pb-4 ${readOnly ? "opacity-75 cursor-not-allowed" : ""}`}>
              <div className="space-y-4">
                {/* Service Time */}
                <div className="flex items-center gap-3">
                  <Label className="text-sm font-medium w-28 shrink-0">Service Time</Label>
                  <div className="flex items-center gap-2">
                    {barServiceTime ? (
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-mono bg-muted px-2 py-1 rounded">{barServiceTime}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground"
                          onClick={() => { setTempBarTime(barServiceTime || "12:00"); setShowBarTimePicker(true); }}
                          disabled={readOnly}
                          data-testid="button-bar-time-edit"
                        >
                          <Settings className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => setBarServiceTime("")}
                          disabled={readOnly}
                          data-testid="button-bar-time-clear"
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => { setTempBarTime("12:00"); setShowBarTimePicker(true); }}
                        disabled={readOnly}
                        data-testid="button-bar-time-set"
                      >
                        <Clock className="h-3 w-3 mr-1" />
                        Set Time
                      </Button>
                    )}
                  </div>
                </div>

                {/* Time picker dialog */}
                {showBarTimePicker && (
                  <div className="flex items-center gap-2 p-2 border rounded-md bg-muted/30">
                    <input
                      type="time"
                      className="text-sm border rounded px-2 py-1 bg-background"
                      value={tempBarTime}
                      onChange={(e) => setTempBarTime(e.target.value)}
                      data-testid="input-bar-time"
                    />
                    <Button type="button" size="sm" className="h-7 text-xs" onClick={() => { setBarServiceTime(tempBarTime); setShowBarTimePicker(false); }}>
                      Confirm
                    </Button>
                    <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowBarTimePicker(false)}>
                      Cancel
                    </Button>
                  </div>
                )}

                {/* Bar Items */}
                <div className="space-y-2">
                  {barItems.map((item, idx) => (
                    <div key={item.id} className="space-y-0.5" data-testid={`bar-item-${idx}`}>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border transition-colors ${
                            item.source === "set_menu"
                              ? "bg-blue-500/15 text-blue-600 border-blue-500/30 dark:text-blue-400 cursor-pointer"
                              : "bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400 cursor-pointer"
                          }`}
                          onClick={() => {
                            if (readOnly) return;
                            setBarItems(prev => {
                              const u = [...prev];
                              u[idx] = { ...u[idx], source: u[idx].source === "set_menu" ? undefined : "set_menu" };
                              return u;
                            });
                          }}
                          data-testid={`bar-item-badge-${idx}`}
                        >
                          {item.source === "set_menu" ? "SET" : "EXTRA"}
                        </button>
                        <EditableText
                          className="min-w-[40px] flex-1 text-xs"
                          placeholder="Item name…"
                          value={item.itemName}
                          onChange={(v) => setBarItems(prev => { const u = [...prev]; u[idx] = { ...u[idx], itemName: v }; return u; })}
                          disabled={readOnly}
                          data-testid={`bar-item-name-${idx}`}
                        />
                        {/* SCRUM-905: the till's own drink for this line, its name and code written on. */}
                        <TillMenuPick
                          code={item.productCode}
                          prefer="bar"
                          onPick={(picked) => setBarItems(prev => prev.map((line, i) => (i === idx ? lineWithTillItem(line, picked) : line)))}
                          onClear={() => setBarItems(prev => prev.map((line, i) => (i === idx ? lineWithoutTillItem(line) : line)))}
                          testId={`button-till-menu-bar-${idx}`}
                        />
                        {item.productCode && (
                          <span
                            className="text-[10px] font-mono text-muted-foreground shrink-0"
                            title={tillCodeTitle(tillMenu.index, item.productCode)}
                            data-testid={`text-bar-code-${idx}`}
                          >
                            {item.productCode}
                          </span>
                        )}
                        <TillCodeMark code={item.productCode} testId={`text-bar-code-dead-${idx}`} />
                        <EditableText
                          type="number"
                          className="w-16 text-xs font-mono shrink-0"
                          placeholder="Qty"
                          value={String(item.quantity || 1)}
                          onChange={(v) => setBarItems(prev => { const u = [...prev]; u[idx] = { ...u[idx], quantity: parseInt(v) || 1 }; return u; })}
                          disabled={readOnly}
                          data-testid={`bar-item-qty-${idx}`}
                        />
                        {/* SCRUM-949: an EXTRA drink's price for each item, beside its count; never on a SET line. */}
                        {item.source !== "set_menu" && (
                          <ExtraPriceBox
                            line={item}
                            area="bar"
                            charge={extraCharges.bar[idx]}
                            onPrice={(price) => setBarItems(prev => prev.map((line, i) => (i === idx ? { ...line, price } : line)))}
                            testId={`bar-${idx}`}
                          />
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => setBarItems(prev => prev.filter((_, i) => i !== idx))}
                          disabled={readOnly}
                          data-testid={`bar-item-delete-${idx}`}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <EditableText
                        className="ml-14 text-xs text-muted-foreground"
                        placeholder="Notes (optional)…"
                        value={item.notes || ""}
                        onChange={(v) => setBarItems(prev => { const u = [...prev]; u[idx] = { ...u[idx], notes: v }; return u; })}
                        disabled={readOnly}
                        data-testid={`bar-item-notes-${idx}`}
                      />
                    </div>
                  ))}
                  <div className="flex gap-2 pt-1">
                    <button
                      className="text-[10px] font-semibold px-2 py-0.5 rounded-full border cursor-pointer bg-blue-500/15 text-blue-600 border-blue-500/30 dark:text-blue-400 hover:bg-blue-500/25 transition-colors"
                      onClick={() => setBarItems(prev => [...prev, {
                        id: `bar_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                        itemName: "",
                        quantity: 1,
                        notes: "",
                        included: false,
                        price: 0,
                        source: "set_menu",
                      }])}
                      disabled={readOnly}
                      data-testid="button-add-bar-set"
                    >
                      + SET
                    </button>
                    <button
                      className="text-[10px] font-semibold px-2 py-0.5 rounded-full border cursor-pointer bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400 hover:bg-amber-500/25 transition-colors"
                      onClick={() => setBarItems(prev => [...prev, {
                        id: `bar_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                        itemName: "",
                        quantity: 1,
                        notes: "",
                        included: false,
                        price: 0,
                      }])}
                      disabled={readOnly}
                      data-testid="button-add-bar-extra"
                    >
                      + EXTRA
                    </button>
                  </div>
                  {/* SCRUM-949: the bar's EXTRA lines as the till will charge them. */}
                  <BeoExtrasTotal charges={extraCharges.bar} testId="text-bar-extras-total" />
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* 7. Timeline (manual only) */}
          <AccordionItem value="timeline" className="border rounded-lg border-l-4 border-l-cyan-500 bg-cyan-500/5">
            <AccordionTrigger className="px-4 hover:no-underline" data-testid="accordion-timeline">
              <div className="flex items-center gap-2">
                <ListTodo className="h-4 w-4 text-cyan-500" />
                <span>Timeline</span>
                <StatusIcon status={getSectionStatus("timeline")} />
                {aiSectionMark("timeline")}
                <Badge variant="secondary" className="ml-2 text-xs">{beoData?.timeline?.length || 0} steps</Badge>
              </div>
            </AccordionTrigger>
            <AccordionContent className={`px-4 pb-4 ${readOnly ? "opacity-75 cursor-not-allowed" : ""}`}>
              {beoData && (
                <BeoTimelineEditor
                  eventId={eventId}
                  startTime={beoData.startTime}
                />
              )}
            </AccordionContent>
          </AccordionItem>

          {/* 7. Parent Experience */}
          <AccordionItem value="parent-experience" className="border rounded-lg border-l-4 border-l-rose-500 bg-rose-500/5">
            <AccordionTrigger className="px-4 hover:no-underline" data-testid="accordion-parent-experience">
              <div className="flex items-center gap-2">
                <Heart className="h-4 w-4 text-rose-500" />
                <span>Parent Experience</span>
              </div>
            </AccordionTrigger>
            <AccordionContent className={`px-4 pb-4 ${readOnly ? "opacity-75 cursor-not-allowed" : ""}`}>
              {beoData && (
                <BeoParentExperienceModule
                  eventId={eventId}
                  event={beoData}
                />
              )}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
        </BeoPartyDateContext.Provider>
        </TillMenuContext.Provider>
      </div>

      {!readOnly && (
        <div className="sticky bottom-0 border-t bg-background p-4 flex gap-2 justify-end">
          <Button
            variant="outline"
            size="icon"
            onClick={() => {
              const isArchived = beoData?.isArchived;
              archiveMutation.mutate({ id: eventId, archived: !isArchived });
            }}
            disabled={archiveMutation.isPending}
            data-testid="button-archive-beo"
          >
            {beoData?.isArchived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
          </Button>
          <Button variant="outline" onClick={onClose} data-testid="button-cancel">
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving} data-testid="button-save-beo">
            {isSaving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-2" />
                Save
              </>
            )}
          </Button>
        </div>
      )}

      <Dialog open={showAiFill} onOpenChange={(open) => {
        setShowAiFill(open);
        if (!open) {
          setAiFillStep("paste");
          setAiFillText("");
          setAiFillParsed(null);
          setAiFillError(null);
          setAiFillAccepted(new Set());
          setAiFillUseDate(false);
          setAiFillSource(null);
        }
      }}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              {aiFillStep === "paste" ? "AI Fill — Paste BEO Text" : "AI Fill — Review & Confirm"}
            </DialogTitle>
          </DialogHeader>

          {aiFillStep === "paste" ? (
            <div className="flex-1 flex flex-col gap-3 min-h-0">
              <p className="text-sm text-muted-foreground">
                Paste the BEO confirmation text below. The AI will extract event details, menu items, setup plan, timeline, and billing information.
              </p>
              <Textarea
                className="flex-1 min-h-[200px] font-mono text-sm"
                placeholder="Paste BEO confirmation text here..."
                value={aiFillText}
                onChange={(e) => setAiFillText(e.target.value)}
                data-testid="textarea-ai-fill-beo"
              />
              {aiFillError && (
                <p className="text-sm text-destructive">{aiFillError}</p>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setShowAiFill(false)}>Cancel</Button>
                <Button
                  onClick={handleAiFillParse}
                  disabled={aiFillLoading || !aiFillText.trim()}
                  data-testid="button-ai-parse-beo"
                >
                  {aiFillLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Parsing...
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4 mr-2" />
                      Parse with AI
                    </>
                  )}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="flex-1 flex flex-col gap-3 min-h-0 overflow-hidden">
              {aiFillParsed?.summary && (
                <div className="bg-muted/50 rounded-lg p-3 border">
                  <p className="text-sm font-medium">{aiFillParsed.summary}</p>
                </div>
              )}
              <div className="flex-1 overflow-y-auto space-y-3 pr-1">
                {/* SCRUM-660: the inbox message Create BEO's AI Fill read, to check before loading it. */}
                {aiFillSource && (
                  <div className="border rounded-lg p-3 space-y-1.5" data-testid="ai-fill-inbox-source">
                    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <MessageSquare className="h-4 w-4" />
                      Read from the inbox
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {`The team's confirmation message${aiFillSource.authorName ? ` from ${aiFillSource.authorName}` : ""}, ${format(parseISO(aiFillSource.sentAt ?? aiFillSource.createdAt), "d MMM yyyy, HH:mm")}. Check it is the right message before loading it.`}
                    </p>
                    <div
                      className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-2 text-sm"
                      data-testid="text-ai-fill-inbox-message"
                    >
                      {aiFillSource.body}
                    </div>
                    {aiFillSource.fillsFinalMessage && (
                      <p className="text-xs text-muted-foreground" data-testid="text-ai-fill-final-message">
                        Load into Editor also puts this message, word for word, in Final Message to Parent.
                      </p>
                    )}
                  </div>
                )}
                {aiFillParsed?.event && (
                  <AiFillSection title="Event Info" icon={<CalendarDays className="h-4 w-4" />}>
                    <AiFillRow label="Title" value={aiFillParsed.event.title} />
                    <AiFillRow label="Child" value={aiFillParsed.event.childName} />
                    <AiFillRow label="Booking Name" value={aiFillParsed.event.bookingName} />
                    {/* SCRUM-814: the message's date beside the booked one; marked when they differ, applied only when ticked. */}
                    {aiFillDate && (
                      <div
                        className={cn(
                          "flex gap-2 text-sm rounded-md",
                          aiFillDate.differs && "bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-1.5 -mx-1.5",
                        )}
                        data-testid="ai-fill-event-date"
                      >
                        <span className="text-muted-foreground w-28 shrink-0">Date:</span>
                        <div className="space-y-1 min-w-0">
                          <div>
                            <span className="font-medium">{dayLabel(aiFillDate.read)}</span>
                            {aiFillDate.readText && (
                              <span className="text-xs text-muted-foreground">{` — the message says "${aiFillDate.readText}"`}</span>
                            )}
                          </div>
                          {aiFillDate.differs ? (
                            <>
                              <div className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300" data-testid="text-ai-fill-date-differs">
                                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                                {aiFillDate.booked
                                  ? `The event is booked for ${dayLabel(aiFillDate.booked)}: not the same day.`
                                  : "The event has no date yet."}
                              </div>
                              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={aiFillUseDate}
                                  onChange={(e) => setAiFillUseDate(e.target.checked)}
                                  data-testid="checkbox-ai-fill-event-date"
                                />
                                {`Tick to make ${dayLabel(aiFillDate.read)} the event's date.`}
                              </label>
                            </>
                          ) : (
                            <div className="text-xs text-muted-foreground" data-testid="text-ai-fill-date-same">
                              The same day the event is booked for.
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    <AiFillRow label="Children" value={aiFillParsed.event.numChildren} />
                    <AiFillRow label="Adults" value={aiFillParsed.event.numAdults} />
                    <AiFillRow label="Time" value={aiFillParsed.event.startTime && aiFillParsed.event.endTime ? `${aiFillParsed.event.startTime} – ${aiFillParsed.event.endTime}` : aiFillParsed.event.startTime} />
                    <AiFillRow label="Location" value={aiFillParsed.event.locationText} />
                    <AiFillRow label="Special Requests" value={aiFillParsed.event.specialRequests} />
                    <AiFillRow label="Activities" value={aiFillParsed.event.activities} />
                    <AiFillRow label="Decoration" value={aiFillParsed.event.decoration} />
                  </AiFillSection>
                )}

                {aiFillParsed?.setupPlan && (
                  <AiFillSection title="Setup Plan" icon={<ListTodo className="h-4 w-4" />}>
                    <AiFillRow label="Ready By" value={aiFillParsed.setupPlan.readyBy} />
                    <AiFillRow label="Responsible" value={aiFillParsed.setupPlan.responsible} />
                    {aiFillParsed.setupPlan.simplifiedTasks?.length > 0 && (
                      <div className="mt-1">
                        <span className="text-xs text-muted-foreground">Tasks:</span>
                        <ul className="list-disc list-inside text-sm ml-2">
                          {aiFillParsed.setupPlan.simplifiedTasks.map((t: any, i: number) => (
                            <li key={i}>{t.itemLabel}{t.notes ? ` — ${t.notes}` : ""}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </AiFillSection>
                )}

                {aiFillParsed?.kitchenPlan && (
                  <AiFillSection title="Kitchen Plan" icon={<Cake className="h-4 w-4" />}>
                    {aiFillParsed.kitchenPlan.kidsMenu?.length > 0 && (
                      <div className="mt-1">
                        <span className="text-xs text-muted-foreground font-medium">Kids Menu:</span>
                        <ul className="list-disc list-inside text-sm ml-2">
                          {aiFillParsed.kitchenPlan.kidsMenu.map((m: any, i: number) => (
                            <li key={i}>{m.quantity}x {m.itemName}{m.included === false ? ` (+${m.price ?? 0}฿)` : ""}{m.notes ? ` — ${m.notes}` : ""}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {aiFillParsed.kitchenPlan.adultsMenu?.length > 0 && (
                      <div className="mt-1">
                        <span className="text-xs text-muted-foreground font-medium">Adults Menu:</span>
                        <ul className="list-disc list-inside text-sm ml-2">
                          {aiFillParsed.kitchenPlan.adultsMenu.map((m: any, i: number) => (
                            <li key={i}>{m.quantity}x {m.itemName}{m.included === false ? ` (+${m.price ?? 0}฿)` : ""}{m.notes ? ` — ${m.notes}` : ""}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {/* SCRUM-787: the cake type always shows beside a cake time, "not said" when the message does not say whose cake it is. */}
                    {aiFillCake && (
                      <div className="flex gap-2 text-sm" data-testid="ai-fill-cake-type">
                        <span className="text-muted-foreground w-28 shrink-0">Cake type:</span>
                        {aiFillCake.notSaid ? (
                          <span className="text-amber-700 dark:text-amber-300" data-testid="text-ai-fill-cake-not-said">
                            {aiFillCakeNote}
                          </span>
                        ) : (
                          <span className="font-medium">{aiFillCake.type}</span>
                        )}
                      </div>
                    )}
                    <AiFillRow label="Cake notes" value={aiFillCake?.notes ?? null} />
                    <AiFillRow label="Cake Time" value={aiFillCake?.time ?? null} />
                  </AiFillSection>
                )}

                {/* SCRUM-787: no empty Party Details box. */}
                {aiFillPartyDetailsShown(aiFillParsed?.partyDetails) && (
                  <AiFillSection title="Party Details" icon={<Gift className="h-4 w-4" />}>
                    <AiFillRow label="POS" value={aiFillParsed.partyDetails.packageName} />
                    <AiFillRow label="Base Price" value={aiFillParsed.partyDetails.packageBasePrice ? `${aiFillParsed.partyDetails.packageBasePrice.toLocaleString()}฿` : null} />
                    {aiFillParsed.partyDetails.items?.length > 0 && (
                      <div className="mt-1">
                        <span className="text-xs text-muted-foreground">Items:</span>
                        <ul className="list-disc list-inside text-sm ml-2">
                          {aiFillParsed.partyDetails.items.map((item: any, i: number) => (
                            <li key={i} className={item.type === "extra" ? "text-orange-600 dark:text-orange-400" : ""}>
                              {item.description}{item.type === "extra" ? ` (+${item.price ?? 0}฿)` : " (incl.)"}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <AiFillRow label="Deposit requested / not confirmed received" value={aiFillDeposit.depositRequested ? `${aiFillDeposit.depositRequested.toLocaleString()}฿` : null} />
                    {aiFillDeposit.prepaymentReceived && (
                      <div className="space-y-1" data-testid="ai-fill-deposit-review">
                        <AiFillRow label="Deposit received" value={`${aiFillParsed.partyDetails.prepaymentReceived.toLocaleString()}฿`} />
                        <p className="text-xs text-muted-foreground" data-testid="ai-fill-deposit-words">{aiFillParsed.partyDetails.depositWords}</p>
                        <label className="flex items-center gap-2 text-sm">
                          <Checkbox checked={aiFillDepositConfirmed} onCheckedChange={(checked) => setAiFillDepositConfirmed(checked === true)} data-testid="checkbox-ai-fill-deposit-received" />
                          I confirm this deposit was received. Apply it to the Deposit field.
                        </label>
                      </div>
                    )}
                    <AiFillRow label="Notes" value={aiFillParsed.partyDetails.notes} />
                  </AiFillSection>
                )}

                {/* SCRUM-660: whom the message names, matched to this park's people; assigned only when ticked. */}
                {AI_TEAM_FIELDS.some(({ field }) => aiFillParsed?.proposals?.[field]) && (
                  <AiFillSection title="Team" icon={<Users className="h-4 w-4" />}>
                    {AI_TEAM_FIELDS.map(({ field, label }) => {
                      const proposal: AiTeamProposal | null | undefined = aiFillParsed?.proposals?.[field];
                      if (!proposal) return null;
                      if (proposal.match) {
                        return (
                          <label key={field} className="flex items-start gap-2 text-sm cursor-pointer" data-testid={`ai-fill-team-${field}`}>
                            <span className="text-muted-foreground w-28 shrink-0">{label}:</span>
                            <input
                              type="checkbox"
                              className="mt-1 shrink-0"
                              checked={aiFillAccepted.has(field)}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                setAiFillAccepted(prev => {
                                  const next = new Set(prev);
                                  if (checked) next.add(field);
                                  else next.delete(field);
                                  return next;
                                });
                              }}
                              data-testid={`checkbox-ai-fill-team-${field}`}
                            />
                            <span>
                              <span className="font-medium">{proposal.match.label}</span>
                              <span className="text-xs text-muted-foreground">{` — the message says "${proposal.asked}". Tick to assign.`}</span>
                            </span>
                          </label>
                        );
                      }
                      return (
                        <div key={field} className="flex items-start gap-2 text-sm" data-testid={`ai-fill-team-${field}`}>
                          <span className="text-muted-foreground w-28 shrink-0">{label}:</span>
                          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
                          <span>
                            <span className="font-medium">{`"${proposal.asked}"`}</span>
                            <span className="text-xs text-amber-700 dark:text-amber-300">{` ${aiTeamUnmatchedText(field, proposal.why)}`}</span>
                          </span>
                        </div>
                      );
                    })}
                  </AiFillSection>
                )}

                {aiFillParsed?.timeline?.length > 0 && (
                  <AiFillSection title="Timeline" icon={<Clock className="h-4 w-4" />}>
                    <div className="space-y-1">
                      {aiFillParsed.timeline.map((t: any, i: number) => (
                        <div key={i} className="flex gap-2 text-sm">
                          <span className="font-mono text-muted-foreground w-12 shrink-0">{t.time}</span>
                          <span>{t.label}</span>
                        </div>
                      ))}
                    </div>
                  </AiFillSection>
                )}
              </div>

              <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
                <p className="text-sm text-amber-800 dark:text-amber-200">
                  This will replace existing data in the editor. Review the parsed data above, then click "Load into Editor" to fill the form.
                </p>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setAiFillStep("paste")} data-testid="button-ai-fill-back">
                  Back
                </Button>
                <Button onClick={handleAiFillApply} data-testid="button-ai-fill-confirm">
                  <ClipboardPaste className="h-4 w-4 mr-2" />
                  Load into Editor
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* SCRUM-815: the BEO proposed from the conversation, in edit mode; Load into Editor stays the fallback. */}
      <BeoAiReviewDialog
        eventId={eventId}
        pending={aiReview}
        bookedDate={eventData.eventDate || null}
        bookedCakeMode={cakeMode}
        held={reviewHeld()}
        saved={reviewSaved()}
        onClose={() => setAiReview(null)}
        onFallback={(pending) => {
          setAiReview(null);
          openAiFillPreview(pending.fill, pending.source);
        }}
        onApproved={(marks) => {
          // SCRUM-827: the one pass wrote everything; the form reads it back, wears each
          // field's mark, and opens the sections the chat filled. Nothing opens after this.
          setAiReview(null);
          setAiMarks(marks);
          setExpandedSections((prev) => [...new Set([...prev, ...approvedSectionsOf(marks)])]);
        }}
      />

      {/* SCRUM-826: Fetch from chat — the warning, the read, every change listed to accept or decline. */}
      <BeoFetchFromChatDialog
        open={fetchOpen}
        onClose={() => setFetchOpen(false)}
        form={fetchFormValues}
        read={readChatForFetch}
        declined={fetchDeclined}
        onDeclined={setFetchDeclined}
        onApply={applyFetched}
      />

      {/* SCRUM-828: a new item the till's menu does not have yet */}
      <PartyMenuItemDialog
        eventId={eventId}
        menu={newItemMenu ?? "kids"}
        open={newItemMenu !== null}
        onClose={() => setNewItemMenu(null)}
        onCreated={(line) => addPartyMenuLine(newItemMenu ?? "kids", line)}
      />

      {/* Parent Link Dialog */}
      <Dialog open={showParentLinkDialog} onOpenChange={setShowParentLinkDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link2 className="h-4 w-4" />
              Parent Menu Selection Link
            </DialogTitle>
            {/* SCRUM-978: the description the console asked for, for screen readers; nothing visible changes. */}
            <DialogDescription className="sr-only">The link the family opens to choose the party's set menu.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {setMenuSelection?.isSubmitted ? (
              <div className="flex items-center gap-2 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
                    {choicesFromChatOnly(setMenuSelection.selections) ? `${SET_MENU_CHOSEN_FROM_CHAT}: no parent has answered this link.` : "Selections received!"}
                  </p>
                  {setMenuSelection.submittedAt && (
                    <p className="text-xs text-muted-foreground">
                      {choicesFromChatOnly(setMenuSelection.selections) ? "Recorded on" : "Submitted on"} {new Date(setMenuSelection.submittedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
                <AlertCircle className="h-4 w-4 text-amber-600 shrink-0" />
                <p className="text-sm text-amber-700 dark:text-amber-400">Awaiting parent selections</p>
              </div>
            )}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Shareable Link</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={parentLinkUrl}
                  className="text-xs font-mono"
                  data-testid="input-parent-link-url"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard.writeText(parentLinkUrl);
                    toast({ title: "Link copied to clipboard" });
                  }}
                  data-testid="button-copy-parent-link"
                >
                  Copy
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Share this link with the parent so they can choose their set menu options.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowParentLinkDialog(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
