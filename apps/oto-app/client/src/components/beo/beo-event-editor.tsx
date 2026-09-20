import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EditableText, type EditableTextHandle } from "@/components/ui/editable-text";
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
import { BeoParentExperienceModule } from "./beo-parent-experience-module";
import { ONE_OFF_EVENT_COLOR_OPTIONS } from "@/lib/event-types";
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
}

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
};

type SetMenuTemplateItem =
  | { id: string; type: "always_included"; label: string }
  | { id: string; type: "choice_group"; label: string; options: string[]; allowMultiple: boolean };

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

function PackageLineItemRow({ item, idx, packageItems, setPackageItems }: {
  item: PackageLineItem; idx: number; packageItems: PackageLineItem[]; setPackageItems: (items: PackageLineItem[]) => void;
}) {
  const priceRef = useRef<EditableTextHandle>(null);
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
          onTab={() => {
            if (item.type === "extra") {
              priceRef.current?.focus();
            }
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
        <EditableText
          ref={priceRef}
          type="number"
          className={`w-28 text-sm font-mono shrink-0 ${item.type === "included" ? "invisible" : ""}`}
          value={String(item.price || "")}
          onChange={(v) => {
            const updated = [...packageItems];
            updated[idx] = { ...item, price: Number(v) || 0 };
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
          placeholder="Price ฿"
          data-testid={`input-package-item-price-${idx}`}
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

function MenuLineItemRow({ item, idx, menuItems, setMenuItems, menuTab }: {
  item: MenuLine; idx: number; menuItems: MenuLine[]; setMenuItems: React.Dispatch<React.SetStateAction<MenuLine[]>>; menuTab: string;
}) {
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
        {item.source === "set_menu" && item.notes?.trim() && (
          <span className="text-xs text-muted-foreground shrink-0">{item.notes.trim()}</span>
        )}
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

export function BeoEventEditor({ eventId, onClose, onSave, readOnly = false }: BeoEventEditorProps) {
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
  const [barItems, setBarItems] = useState<MenuLine[]>([]);
  const [barServiceTime, setBarServiceTime] = useState("");
  const [showBarTimePicker, setShowBarTimePicker] = useState(false);
  const [tempBarTime, setTempBarTime] = useState("12:00");
  const [menuTab, setMenuTab] = useState<"kids" | "adults">("kids");
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
  const packagePriceRef = useRef<EditableTextHandle>(null);
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
      if (res.status === 401) throw new Error("Session expired. Please refresh and log in again.");
      if (!res.ok) throw new Error("Failed to fetch BEO data");
      return res.json();
    },
    enabled: !!eventId,
    retry: false,
    refetchOnWindowFocus: true,
  });

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
          menus: { kids: kidsMenu, adults: adultsMenu, kidsFoodTime, adultsFoodTime },
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
      };
      const res = await apiRequest("PUT", `/api/events/${eventId}/beo`, payload);
      if (!res.ok) throw new Error("Failed to save BEO data");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "beo"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/events"] });
      toast({ title: "BEO data saved successfully" });
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

  const handleSave = async () => {
    if (readOnly) return;
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

  const packageTotal = useMemo(() => {
    const extrasTotal = packageItems
      .filter(i => i.type === "extra")
      .reduce((sum, i) => sum + (i.price || 0), 0);
    return packageBasePrice + extrasTotal;
  }, [packageBasePrice, packageItems]);

  const kitchenTotal = useMemo(() => {
    const allMenuItems = [...kidsMenu, ...adultsMenu];
    const extrasTotal = allMenuItems
      .filter(i => i.source !== 'set_menu')
      .reduce((sum, i) => sum + (i.price || 0), 0);
    const cakeExtra = cakeMode !== "NONE" && !cakeIncluded ? (cakePrice || 0) : 0;
    return extrasTotal + cakeExtra;
  }, [kidsMenu, adultsMenu, cakeMode, cakeIncluded, cakePrice]);

  const outstandingBalance = packageTotal - prepaymentReceived;

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
        return (kidsMenu.length > 0 || adultsMenu.length > 0) ? "complete" : "incomplete";
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
      const existingData = {
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
          adultsMenu: adultsMenu.map(m => ({ itemName: m.itemName, quantity: m.quantity, notes: m.notes, included: m.included, price: m.price })),
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
      };
      const res = await apiRequest("POST", "/api/ai/parse-beo", { text: aiFillText, existingData });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to parse BEO text");
      }
      const parsed = await res.json();
      setAiFillParsed(parsed);
      setAiFillStep("preview");
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

    if (p.kitchenPlan) {
      const kp = p.kitchenPlan;
      setKitchenRequired(true);
      if (kp.kidsMenu?.length > 0) {
        setKidsMenu(kp.kidsMenu.map((m: any) => ({
          id: `menu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          itemName: m.itemName || "",
          quantity: m.quantity || 1,
          notes: m.notes || "",
          included: m.included !== false,
          price: m.price || 0,
        })));
      }
      if (kp.adultsMenu?.length > 0) {
        setAdultsMenu(kp.adultsMenu.map((m: any) => ({
          id: `menu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          itemName: m.itemName || "",
          quantity: m.quantity || 1,
          notes: m.notes || "",
          included: m.included !== false,
          price: m.price || 0,
        })));
      }
      if (kp.cakeMode && kp.cakeMode !== "NONE") {
        setCakeMode(kp.cakeMode);
        if (kp.cakeNotes) setCakeNotes(kp.cakeNotes);
        if (kp.cakeTime) setCakeTime(kp.cakeTime);
        setCakeIncluded(kp.cakeIncluded !== false);
        setCakePrice(kp.cakePrice || 0);
        if (kp.cakeQuantity !== undefined) setCakeQuantity(kp.cakeQuantity);
      }
    }

    if (p.partyDetails) {
      const pd = p.partyDetails;
      if (pd.packageName) setPackageName(pd.packageName);
      if (pd.packageBasePrice) setPackageBasePrice(pd.packageBasePrice);
      if (pd.prepaymentReceived) setPrepaymentReceived(pd.prepaymentReceived);
      if (pd.depositDate) setDepositDate(pd.depositDate);
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
    toast({ title: "BEO data loaded", description: "AI-parsed data has been filled in. Review and save when ready." });
  };

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
              {packageTotal > 0 && (
                <Badge
                  variant={prepaymentReceived <= 0 ? "destructive" : outstandingBalance > 0 ? "outline" : "default"}
                  className={cn(
                    "text-xs font-mono",
                    prepaymentReceived <= 0 && "bg-red-500",
                    prepaymentReceived > 0 && outstandingBalance > 0 && "border-orange-500 text-orange-600 dark:text-orange-400",
                    outstandingBalance <= 0 && "bg-green-600",
                  )}
                  data-testid="badge-payment-status"
                >
                  {prepaymentReceived <= 0
                    ? "No Deposit"
                    : outstandingBalance > 0
                      ? `${outstandingBalance.toLocaleString()}฿ Due`
                      : "Paid"}
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
                }}
                data-testid="button-ai-fill-beo"
              >
                <Sparkles className="h-4 w-4 mr-1" />
                AI Fill
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
              </div>
            </AccordionTrigger>
            <AccordionContent className={`px-4 pb-4 ${readOnly ? "opacity-75 cursor-not-allowed" : ""}`}>
              <div className="grid gap-4">
                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Title</Label>
                    <EditableText
                      value={eventData.title || ""}
                      onChange={(v) => setEventData({ ...eventData, title: v })}
                      placeholder="Event title..."
                      data-testid="input-event-title"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Activities</Label>
                    <EditableText
                      value={eventData.activities || ""}
                      onChange={(v) => setEventData({ ...eventData, activities: v })}
                      placeholder="e.g., Games, Face Painting"
                      data-testid="input-event-activities"
                    />
                  </div>
                </div>
                <div className="grid sm:grid-cols-1 gap-4">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Decoration</Label>
                    <EditableText
                      value={eventData.decoration || ""}
                      onChange={(v) => setEventData({ ...eventData, decoration: v })}
                      placeholder="e.g., Balloons, Streamers, Table Setup"
                      data-testid="input-event-decoration"
                    />
                  </div>
                </div>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <MandatoryLabel>Child / Guest of Honor Name</MandatoryLabel>
                    <EditableText
                      value={eventData.childName || ""}
                      onChange={(v) => setEventData({ ...eventData, childName: v })}
                      placeholder="Birthday child or guest name"
                      data-testid="input-child-name"
                    />
                  </div>
                  <div className="space-y-1">
                    <MandatoryLabel>Parent / Booking Name</MandatoryLabel>
                    <EditableText
                      value={eventData.bookingName || ""}
                      onChange={(v) => setEventData({ ...eventData, bookingName: v })}
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
                    <MandatoryLabel>Date</MandatoryLabel>
                    <DatePicker
                      value={eventData.eventDate ? parseISO(eventData.eventDate) : undefined}
                      onChange={(date) => setEventData({ ...eventData, eventDate: date ? format(date, "yyyy-MM-dd") : undefined })}
                      data-testid="input-event-date"
                    />
                  </div>
                  <div className="space-y-2">
                    <MandatoryLabel>Start Time</MandatoryLabel>
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
                            onClick={() => setEventData({ ...eventData, startTime: undefined })}
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
                  </div>
                  <div className="space-y-2">
                    <Label>End Time</Label>
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
                            onClick={() => { setEventData({ ...eventData, endTime: undefined }); setTimeError(null); }}
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
                    <Button type="button" size="sm" className="h-7 text-xs" onClick={() => {
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
                    }} data-testid="button-confirm-end-time">Confirm</Button>
                    <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowEndTimePicker(false)}>Cancel</Button>
                  </div>
                )}

                <div className="grid sm:grid-cols-3 gap-4">
                  <div className="space-y-1">
                    <MandatoryLabel>Location</MandatoryLabel>
                    <EditableText
                      value={locationText}
                      onChange={setLocationText}
                      placeholder="e.g., Party Room A, Outdoor Area..."
                      data-testid="input-location-text"
                    />
                  </div>
                  <div className="space-y-1">
                    <MandatoryLabel>Expected Kids</MandatoryLabel>
                    <EditableText
                      type="number"
                      value={String(eventData.numChildren || "")}
                      onChange={(v) => setEventData({ ...eventData, numChildren: parseInt(v) || 0 })}
                      placeholder="0"
                      data-testid="input-num-children"
                    />
                  </div>
                  <div className="space-y-1">
                    <MandatoryLabel>Expected Adults</MandatoryLabel>
                    <EditableText
                      type="number"
                      value={String(eventData.numAdults || "")}
                      onChange={(v) => setEventData({ ...eventData, numAdults: parseInt(v) || 0 })}
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
              </div>
            </AccordionTrigger>
            <AccordionContent className={`px-4 pb-4 overflow-visible ${readOnly ? "opacity-75 cursor-not-allowed" : ""}`}>
              <div className="grid gap-4">
                <div className="space-y-2">
                  <MandatoryLabel>Assigned Party Host</MandatoryLabel>
                  <AssignmentSearchBar
                    value={partyHostAssignmentValue}
                    onChange={handlePartyHostChange}
                    employees={allEmployees || []}
                    roles={allRoles || []}
                    placeholder="Search employees or roles..."
                    showEveryone={false}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Entertainment Host (Optional)</Label>
                  <AssignmentSearchBar
                    value={entertainmentHostAssignmentValue}
                    onChange={handleEntertainmentHostChange}
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
                      No entertainment acts yet. Add one to auto-sync its start time to the Timeline.
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

          {/* 3. POS */}
          <AccordionItem value="party-details" className="border rounded-lg border-l-4 border-l-indigo-500 bg-indigo-500/5">
            <AccordionTrigger className="px-4 hover:no-underline" data-testid="accordion-party-details">
              <div className="flex items-center gap-2 w-full">
                <Gift className="h-4 w-4 text-indigo-500" />
                <span>POS</span>
                <StatusIcon status={getSectionStatus("party-details")} />
                {packageName && (
                  <Badge variant="secondary" className="ml-1 text-xs">{packageName}</Badge>
                )}
                {packageTotal > 0 && (
                  <Badge variant="outline" className="ml-1 text-xs font-mono">
                    {packageTotal.toLocaleString()}฿
                  </Badge>
                )}
                <BeoTaskBadge prefix="💰 POS Setup:" label="Mark POS Done" />
              </div>
            </AccordionTrigger>
            <AccordionContent className={`px-4 pb-4 ${readOnly ? "opacity-75 cursor-not-allowed" : ""}`}>
              <div className="space-y-4">
                <div className="flex items-end gap-3">
                  <div className="flex-1 space-y-1">
                    <Label className="text-xs text-muted-foreground">POS Name</Label>
                    <EditableText
                      value={packageName}
                      onChange={setPackageName}
                      placeholder="e.g., Platinum POS"
                      onTab={() => packagePriceRef.current?.focus()}
                      data-testid="input-package-name"
                    />
                  </div>
                  <div className="space-y-1 w-36">
                    <Label className="text-xs text-muted-foreground">Base Price (฿)</Label>
                    <EditableText
                      ref={packagePriceRef}
                      type="number"
                      className="w-full font-mono"
                      value={String(packageBasePrice || "")}
                      onChange={(v) => setPackageBasePrice(Number(v) || 0)}
                      placeholder="0"
                      data-testid="input-package-base-price"
                    />
                  </div>
                </div>

                <Separator />

                <div className="space-y-2">
                  <Label className="text-sm font-medium">Line Items</Label>

                  {packageItems.length === 0 ? (
                    <div
                      className="text-sm text-muted-foreground text-center py-4 border border-dashed rounded-md cursor-pointer hover:bg-accent/30 hover:border-border transition-colors"
                      onClick={() => addPackageItem("included")}
                      data-testid="button-add-first-package-item"
                    >
                      Click here to add first item
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

                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1 p-3 rounded-md bg-primary/5 border">
                    <Label className="text-xs text-muted-foreground">Total</Label>
                    <p className="text-lg font-bold font-mono" data-testid="text-package-total">
                      {packageTotal.toLocaleString()}฿
                    </p>
                  </div>
                  <div className="space-y-1 p-3 rounded-md border">
                    <Label className="text-xs text-muted-foreground">Deposit</Label>
                    <EditableText
                      type="number"
                      className="font-mono text-lg font-bold"
                      value={String(prepaymentReceived || "")}
                      onChange={(v) => setPrepaymentReceived(Number(v) || 0)}
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
                  </div>
                  <div className={cn(
                    "space-y-1 p-3 rounded-md border",
                    prepaymentReceived <= 0 && packageTotal > 0 && "bg-red-500/10 border-red-500/30",
                    prepaymentReceived > 0 && outstandingBalance > 0 && "bg-orange-500/10 border-orange-500/30",
                    outstandingBalance <= 0 && packageTotal > 0 && "bg-green-500/10 border-green-500/30",
                  )}>
                    <Label className="text-xs text-muted-foreground">Outstanding</Label>
                    <p className={cn(
                      "text-lg font-bold font-mono",
                      prepaymentReceived <= 0 && packageTotal > 0 && "text-red-600 dark:text-red-400",
                      prepaymentReceived > 0 && outstandingBalance > 0 && "text-orange-600 dark:text-orange-400",
                      outstandingBalance <= 0 && packageTotal > 0 && "text-green-600 dark:text-green-400",
                    )} data-testid="text-outstanding-balance">
                      {prepaymentReceived <= 0 && packageTotal > 0
                        ? "No Deposit"
                        : `${outstandingBalance.toLocaleString()}฿`}
                    </p>
                  </div>
                </div>

                <Separator />

                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">POS Notes</Label>
                  <EditableText
                    value={packageNotes}
                    onChange={setPackageNotes}
                    placeholder="Any notes about the POS, billing, or special arrangements..."
                    multiline
                    data-testid="textarea-package-notes"
                  />
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* 4. Setup Plan */}
          <AccordionItem value="setup-plan" className="border rounded-lg border-l-4 border-l-orange-500 bg-orange-500/5">
            <AccordionTrigger className="px-4 hover:no-underline" data-testid="accordion-setup-plan">
              <div className="flex items-center gap-2 w-full">
                <Settings className="h-4 w-4 text-orange-500" />
                <span>Setup Plan</span>
                <StatusIcon status={getSectionStatus("setup-plan")} />
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
                    <Label className="text-sm text-muted-foreground whitespace-nowrap">Ready by</Label>
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
                    <Label className="text-sm text-muted-foreground whitespace-nowrap">Who</Label>
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
                    <Button type="button" size="sm" className="h-7 text-xs" onClick={() => { setSetupReadyBy(tempReadyByTime); setShowReadyByTimePicker(false); }} data-testid="button-confirm-ready-by-time">Confirm</Button>
                    <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowReadyByTimePicker(false)}>Cancel</Button>
                  </div>
                )}

                {setupTasks.length === 0 ? (
                  <div
                    className="text-sm text-muted-foreground text-center py-4 border border-dashed rounded-md cursor-pointer hover:bg-accent/30 hover:border-border transition-colors"
                    onClick={addSetupTask}
                    data-testid="button-add-first-setup-task"
                  >
                    Click here to add first task
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
                            Adults Menu ({adultsMenu.length})
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
                                      if (hasSetMenuItems && !window.confirm("Disabling Set Menu will keep existing set-menu items in the menu. Remove them first via Reset if needed. Continue?")) {
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
                                              {setMenuSelection?.isSubmitted && (
                                                <Badge className="text-[10px] px-1.5 bg-emerald-500 text-white ml-auto">Selections received</Badge>
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
                                          <span className="text-xs text-muted-foreground">
                                            Received {new Date(setMenuSelection.submittedAt).toLocaleDateString()}
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
                                            setCurrentMenu([{
                                              id: `menu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                                              itemName: "",
                                              quantity: 1,
                                              notes: "",
                                              included: true,
                                              price: 0,
                                            }]);
                                            setTimeout(() => {
                                              const el = document.querySelector(`[data-testid="input-menu-name-kids-0"]`) as HTMLElement;
                                              if (el) el.click();
                                            }, 50);
                                          }}
                                          data-testid="button-add-first-menu-kids"
                                        >
                                          Click here to add first item
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
                                    </>
                                  );
                                })()}
                              </div>
                            </div>
                          );
                        }

                        // Adults menu: keep Set Menu selections grouped here when the
                        // event uses an adults-only menu bucket.
                        const selectedTemplate = setMenuTemplates.find((template) => template.id === setMenuTemplateId);
                        const setMenuItems = currentMenu.filter((item) => item.source === "set_menu");
                        const additionalItems = setMenuEnabled
                          ? currentMenu.filter((item) => item.source !== "set_menu")
                          : currentMenu;
                        const hasResolved = setMenuSelection?.isSubmitted === true;

                        return (
                          <div className="space-y-3">
                            {setMenuEnabled && selectedTemplate && (
                              <div className="border-2 border-emerald-500/40 rounded-lg overflow-hidden">
                                <div className="bg-emerald-500/15 px-3 py-1.5 flex items-center gap-2">
                                  <ListChecks className="h-3.5 w-3.5 text-emerald-600" />
                                  <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wide">Set Menu</span>
                                  <Badge variant="outline" className="text-[10px] px-1.5 bg-emerald-500/10 text-emerald-600 border-emerald-500/30">{selectedTemplate.name}</Badge>
                                  {hasResolved ? (
                                    <Badge className="text-[10px] px-1.5 bg-emerald-500 text-white ml-auto">Selections received</Badge>
                                  ) : setMenuSelection ? (
                                    <Badge variant="outline" className="text-[10px] px-1.5 ml-auto text-amber-600 border-amber-500/30 bg-amber-500/10">Awaiting parent</Badge>
                                  ) : null}
                                </div>
                                <SetMenuChoiceGroups
                                  template={selectedTemplate}
                                  resolvedItems={setMenuItems}
                                  hasResolved={hasResolved}
                                />
                                {hasResolved && setMenuItems.length > 0 && (
                                  <div className="p-3 space-y-1.5">
                                    <p className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wide">Resolved items (editable)</p>
                                    {setMenuItems.map((item, index) => {
                                      const absoluteIndex = currentMenu.findIndex((menuItem) => menuItem === item);
                                      return (
                                        <MenuLineItemRow
                                          key={item.id}
                                          item={item}
                                          idx={absoluteIndex >= 0 ? absoluteIndex : index}
                                          menuItems={currentMenu}
                                          setMenuItems={setCurrentMenu}
                                          menuTab="adults"
                                        />
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            )}

                            {setMenuEnabled && (
                              <Label className="text-xs text-muted-foreground uppercase tracking-wide">Additional Items</Label>
                            )}
                            {additionalItems.length === 0 ? (
                              <div
                                className="text-sm text-muted-foreground text-center py-4 border border-dashed rounded-md cursor-pointer hover:bg-accent/30 hover:border-border transition-colors"
                                onClick={() => {
                                  setCurrentMenu([{
                                    id: `menu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                                    itemName: "",
                                    quantity: 1,
                                    notes: "",
                                    included: true,
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
                                Click here to add first item
                              </div>
                            ) : (
                              <>
                                {additionalItems.map((item, index) => {
                                  const absoluteIndex = currentMenu.findIndex((menuItem) => menuItem === item);
                                  return (
                                    <MenuLineItemRow
                                      key={item.id}
                                      item={item}
                                      idx={absoluteIndex >= 0 ? absoluteIndex : index}
                                      menuItems={currentMenu}
                                      setMenuItems={setCurrentMenu}
                                      menuTab="adults"
                                    />
                                  );
                                })}
                              </>
                            )}
                            <div className={`flex gap-2 pt-1 ${additionalItems.length === 0 ? "hidden" : ""}`}>
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
                          </div>
                        );
                      })()}
                    </div>

                    <Separator />

                    <div className="space-y-2">
                      <Label>Cake</Label>
                      <div className="flex gap-2 flex-wrap">
                        {["NONE", "INTERNAL", "EXTERNAL"].map((mode) => (
                          <Button
                            key={mode}
                            variant={cakeMode === mode ? "default" : "outline"}
                            size="sm"
                            onClick={() => setCakeMode(mode)}
                            data-testid={`button-cake-${mode.toLowerCase()}`}
                          >
                            {mode === "NONE" ? "No Cake" : mode === "INTERNAL" ? "Our Cake" : "Own Cake"}
                          </Button>
                        ))}
                      </div>
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
                                    onClick={() => setCakeTime("")}
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
                              <Button type="button" size="sm" className="h-7 text-xs" onClick={() => { setCakeTime(tempCakeTime); setShowCakeTimePicker(false); }} data-testid="button-confirm-cake-time">Confirm</Button>
                              <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowCakeTimePicker(false)}>Cancel</Button>
                            </div>
                          )}
                          <EditableText
                            className="flex-1 min-w-[150px] text-sm"
                            value={cakeNotes}
                            onChange={setCakeNotes}
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
                        <EditableText
                          type="number"
                          className="w-16 text-xs font-mono shrink-0"
                          placeholder="Qty"
                          value={String(item.quantity || 1)}
                          onChange={(v) => setBarItems(prev => { const u = [...prev]; u[idx] = { ...u[idx], quantity: parseInt(v) || 1 }; return u; })}
                          disabled={readOnly}
                          data-testid={`bar-item-qty-${idx}`}
                        />
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
                {aiFillParsed?.event && (
                  <AiFillSection title="Event Info" icon={<CalendarDays className="h-4 w-4" />}>
                    <AiFillRow label="Title" value={aiFillParsed.event.title} />
                    <AiFillRow label="Child" value={aiFillParsed.event.childName} />
                    <AiFillRow label="Booking Name" value={aiFillParsed.event.bookingName} />
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
                            <li key={i}>{m.quantity}x {m.itemName}{!m.included ? ` (+${m.price}฿)` : ""}{m.notes ? ` — ${m.notes}` : ""}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {aiFillParsed.kitchenPlan.adultsMenu?.length > 0 && (
                      <div className="mt-1">
                        <span className="text-xs text-muted-foreground font-medium">Adults Menu:</span>
                        <ul className="list-disc list-inside text-sm ml-2">
                          {aiFillParsed.kitchenPlan.adultsMenu.map((m: any, i: number) => (
                            <li key={i}>{m.quantity}x {m.itemName}{!m.included ? ` (+${m.price}฿)` : ""}{m.notes ? ` — ${m.notes}` : ""}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <AiFillRow label="Cake" value={aiFillParsed.kitchenPlan.cakeMode !== "NONE" ? `${aiFillParsed.kitchenPlan.cakeMode} — ${aiFillParsed.kitchenPlan.cakeNotes || ""}` : null} />
                    <AiFillRow label="Cake Time" value={aiFillParsed.kitchenPlan.cakeTime} />
                  </AiFillSection>
                )}

                {aiFillParsed?.partyDetails && (
                  <AiFillSection title="Party Details" icon={<Gift className="h-4 w-4" />}>
                    <AiFillRow label="POS" value={aiFillParsed.partyDetails.packageName} />
                    <AiFillRow label="Base Price" value={aiFillParsed.partyDetails.packageBasePrice ? `${aiFillParsed.partyDetails.packageBasePrice.toLocaleString()}฿` : null} />
                    {aiFillParsed.partyDetails.items?.length > 0 && (
                      <div className="mt-1">
                        <span className="text-xs text-muted-foreground">Items:</span>
                        <ul className="list-disc list-inside text-sm ml-2">
                          {aiFillParsed.partyDetails.items.map((item: any, i: number) => (
                            <li key={i} className={item.type === "extra" ? "text-orange-600 dark:text-orange-400" : ""}>
                              {item.description}{item.type === "extra" ? ` (+${item.price}฿)` : " (incl.)"}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <AiFillRow label="Prepayment" value={aiFillParsed.partyDetails.prepaymentReceived ? `${aiFillParsed.partyDetails.prepaymentReceived.toLocaleString()}฿` : null} />
                    <AiFillRow label="Notes" value={aiFillParsed.partyDetails.notes} />
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

      {/* Parent Link Dialog */}
      <Dialog open={showParentLinkDialog} onOpenChange={setShowParentLinkDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link2 className="h-4 w-4" />
              Parent Menu Selection Link
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {setMenuSelection?.isSubmitted ? (
              <div className="flex items-center gap-2 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">Selections received!</p>
                  {setMenuSelection.submittedAt && (
                    <p className="text-xs text-muted-foreground">
                      Submitted on {new Date(setMenuSelection.submittedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
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
