import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { EditableText } from "@/components/ui/editable-text";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Clock,
  User,
  Settings,
  UtensilsCrossed,
  Music,
  Phone,
  CheckCircle2,
  Circle,
  Users,
  AlertCircle,
  Loader2,
  Cake,
  ChevronDown,
  MapPin,
  Gift,
  Wine,
  Pencil,
  Trash2,
  Plus,
  Minus,
  Check,
  X,
  Link2,
  RefreshCw,
} from "lucide-react";
import type { BeoEventWithDetails, BeoTimelineItem } from "@shared/schema";

interface BeoDayOfViewProps {
  eventId: string;
  onClose?: () => void;
}

function formatTime(timeStr: string): string {
  const [hours, mins] = timeStr.split(":").map(Number);
  const period = hours >= 12 ? "PM" : "AM";
  const displayHours = hours % 12 || 12;
  return `${displayHours}:${mins.toString().padStart(2, "0")} ${period}`;
}

function getTimeFromOffset(startTime: string, offsetMinutes: number): string {
  const [hours, mins] = startTime.split(":").map(Number);
  const totalMinutes = hours * 60 + mins + offsetMinutes;
  const newHours = Math.floor(totalMinutes / 60) % 24;
  const newMins = totalMinutes % 60;
  return `${newHours.toString().padStart(2, "0")}:${newMins.toString().padStart(2, "0")}`;
}

function getCurrentMinuteOffset(startTime: string): number {
  const now = new Date();
  const [startHours, startMins] = startTime.split(":").map(Number);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startHours * 60 + startMins;
  return currentMinutes - startMinutes;
}

function timeToOffset(startTime: string, actualTime: string): number {
  const [sh, sm] = startTime.split(":").map(Number);
  const [ah, am] = actualTime.split(":").map(Number);
  return (ah * 60 + am) - (sh * 60 + sm);
}

const UNASSIGNED_VALUE = "__unassigned__";

function StaffAssignSelect({
  value,
  staff,
  onChange,
  disabled,
  testId,
}: {
  value: string | null | undefined;
  staff?: Array<{ id: string; username: string; displayName: string }>;
  onChange: (userId: string | null) => void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <Select
      value={value || UNASSIGNED_VALUE}
      onValueChange={(v) => onChange(v === UNASSIGNED_VALUE ? null : v)}
      disabled={disabled}
    >
      <SelectTrigger className="h-8 text-sm" data-testid={testId}>
        <SelectValue placeholder="Unassigned" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNASSIGNED_VALUE}>Unassigned</SelectItem>
        {staff?.map((s) => (
          <SelectItem key={s.id} value={s.id}>{s.displayName || s.username}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const ROLE_ICONS: Record<string, typeof User> = {
  PARTY_HOST: User,
  SETUP_RESPONSIBLE: Settings,
  KITCHEN_RESPONSIBLE: UtensilsCrossed,
  ENTERTAINMENT: Music,
  SPECIFIC_USER: User,
};

const ROLE_LABELS: Record<string, string> = {
  PARTY_HOST: "Party Host",
  SETUP_RESPONSIBLE: "Setup",
  KITCHEN_RESPONSIBLE: "Kitchen",
  ENTERTAINMENT: "Entertainment",
  SPECIFIC_USER: "Assigned",
};

type KitchenMenuLine = {
  id: string;
  itemName: string;
  quantity: number;
  notes: string;
  included: boolean;
  price: number;
  source?: string;
  groupId?: string;
};

type SetMenuTemplateItem =
  | { id: string; type: "always_included"; label: string }
  | { id: string; type: "choice_group"; label: string; options: string[]; allowMultiple: boolean };

function DayOfSetMenuChoices({ template, menuItems }: {
  template: { name: string; items: SetMenuTemplateItem[] };
  menuItems: KitchenMenuLine[];
}) {
  const setItems = menuItems.filter((item) => item.source === "set_menu");
  if (setItems.length === 0) return null;

  const fixedItems = template.items
    .filter((item): item is Extract<SetMenuTemplateItem, { type: "always_included" }> => item.type === "always_included")
    .map((item) => setItems.find((menuItem) =>
      menuItem.groupId === item.id ||
      (!menuItem.groupId && menuItem.itemName === item.label && (!menuItem.notes || !menuItem.notes.trim())),
    ))
    .filter(Boolean) as KitchenMenuLine[];
  const choiceGroups = template.items.filter((item): item is Extract<SetMenuTemplateItem, { type: "choice_group" }> => item.type === "choice_group");

  return (
    <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3 space-y-2" data-testid="day-of-set-menu-choices">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="bg-blue-500/10 text-blue-700 border-blue-500/30">SET</Badge>
        <span className="text-sm font-medium">{template.name}</span>
      </div>
      {fixedItems.length > 0 && (
        <div data-testid="day-of-set-menu-fixed-items">
          <p className="text-xs font-medium text-muted-foreground">Included</p>
          <p className="text-sm">{fixedItems.map((item) => item.itemName).join(", ")}</p>
        </div>
      )}
      {choiceGroups.map((group) => {
        const choices = setItems.filter((item) => item.groupId === group.id || (!item.groupId && item.notes === `(${group.label})`));
        if (choices.length === 0) return null;
        return (
          <div key={group.id} data-testid={`day-of-set-menu-group-${group.id}`}>
            <p className="text-xs font-medium text-muted-foreground">{group.label}</p>
            <p className="text-sm">{choices.map((item) => item.itemName).join(", ")}</p>
          </div>
        );
      })}
    </div>
  );
}

function KitchenMenuItemRow({ item, idx, menuItems, menuTab, onSave }: {
  item: KitchenMenuLine;
  idx: number;
  menuItems: KitchenMenuLine[];
  menuTab: string;
  onSave: (updated: KitchenMenuLine[]) => void;
}) {
  return (
    <div className="space-y-0.5" data-testid={`menu-item-${menuTab}-${idx}`}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border cursor-pointer transition-colors ${item.source === "set_menu" ? "bg-blue-500/15 text-blue-600 border-blue-500/30 dark:text-blue-400" : "bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400"}`}
          onClick={() => {
            const updated = menuItems.map((m, i) => i === idx ? { ...m, source: m.source === "set_menu" ? undefined : "set_menu" } : m);
            onSave(updated);
          }}
          data-testid={`badge-menu-incl-${menuTab}-${idx}`}
        >
          {item.source === "set_menu" ? "SET" : "EXTRA"}
        </button>
        <Button variant="outline" size="icon" className="h-7 w-7 shrink-0"
          onClick={() => {
            const updated = menuItems.map((m, i) => i === idx ? { ...m, quantity: Math.max(1, m.quantity - 1) } : m);
            onSave(updated);
          }}
          data-testid={`button-qty-minus-${menuTab}-${idx}`}
        >
          <Minus className="h-3 w-3" />
        </Button>
        <span className="w-6 text-center text-xs font-medium shrink-0" data-testid={`text-menu-qty-${menuTab}-${idx}`}>{item.quantity}</span>
        <Button variant="outline" size="icon" className="h-7 w-7 shrink-0"
          onClick={() => {
            const updated = menuItems.map((m, i) => i === idx ? { ...m, quantity: m.quantity + 1 } : m);
            onSave(updated);
          }}
          data-testid={`button-qty-plus-${menuTab}-${idx}`}
        >
          <Plus className="h-3 w-3" />
        </Button>
        <EditableText
          className="flex-1 text-xs min-w-0"
          value={item.itemName}
          onChange={(v) => {
            const updated = menuItems.map((m, i) => i === idx ? { ...m, itemName: v } : m);
            onSave(updated);
          }}
          placeholder="Item name"
          data-testid={`input-menu-name-${menuTab}-${idx}`}
        />
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-destructive hover:text-destructive"
          onClick={() => {
            const updated = menuItems.filter((_, i) => i !== idx);
            onSave(updated);
          }}
          data-testid={`button-delete-menu-item-${menuTab}-${idx}`}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
      {item.notes && item.notes.trim() && (
        <EditableText
          className="text-xs text-muted-foreground ml-5"
          value={item.notes}
          onChange={(v) => {
            const updated = menuItems.map((m, i) => i === idx ? { ...m, notes: v } : m);
            onSave(updated);
          }}
          placeholder="Notes..."
          data-testid={`input-menu-notes-${menuTab}-${idx}`}
        />
      )}
    </div>
  );
}

export function BeoDayOfView({ eventId, onClose }: BeoDayOfViewProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const canEdit = !!user && user.role !== "staff";
  const [posExpanded, setPosExpanded] = useState(false);
  const [setupExpanded, setSetupExpanded] = useState(false);
  const [kitchenExpanded, setKitchenExpanded] = useState(false);
  const [barExpanded, setBarExpanded] = useState(false);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [sectionDone, setSectionDone] = useState<Record<string, boolean>>({});
  const [editingHost, setEditingHost] = useState(false);
  const [editingEntertainment, setEditingEntertainment] = useState(false);
  const [editingSetupResponsible, setEditingSetupResponsible] = useState(false);
  const [newSetupTask, setNewSetupTask] = useState("");
  const [addingSetupTask, setAddingSetupTask] = useState(false);
  const [localTimelineItems, setLocalTimelineItems] = useState<Array<{ id: string; label: string; offsetFromStartMinutes: number; assignedToType: string; isLocal: true }>>([]);
  const [menuTab, setMenuTab] = useState<"kids" | "adults">("kids");
  const [localKidsMenu, setLocalKidsMenu] = useState<KitchenMenuLine[]>([]);
  const [localAdultsMenu, setLocalAdultsMenu] = useState<KitchenMenuLine[]>([]);
  const [localKidsFoodTime, setLocalKidsFoodTime] = useState("");
  const [localAdultsFoodTime, setLocalAdultsFoodTime] = useState("");
  const [setMenuEnabled, setSetMenuEnabled] = useState(false);
  const [setMenuTemplateId, setSetMenuTemplateId] = useState("");
  const [showParentLinkDialog, setShowParentLinkDialog] = useState(false);
  const kitchenInitRef = useRef(false);
  const appliedSetMenuSubmissionRef = useRef<string | null>(null);

  type SetMenuTemplate = { id: string; name: string; items: SetMenuTemplateItem[]; isActive: boolean };
  type SetMenuSelectionRecord = { id: string; eventId: string; templateId: string; token: string; isSubmitted: boolean; submittedAt: string | null; selections: any };
  const wasAwaitingParentSelection = useRef(false);

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

  const { data: beoData, isLoading } = useQuery<BeoEventWithDetails>({
    queryKey: ["/api/events", eventId, "beo"],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/beo`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch BEO data");
      return res.json();
    },
    enabled: !!eventId,
    refetchInterval: 30000,
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

  const { data: staff } = useQuery<Array<{ id: string; username: string; displayName: string }>>({
    queryKey: ["/api/beo/staff"],
    enabled: !!eventId,
  });

  const completeMutation = useMutation({
    mutationFn: async (itemId: string) => {
      const res = await apiRequest("POST", `/api/events/${eventId}/beo/timeline/${itemId}/complete`);
      if (!res.ok) throw new Error("Failed to update item");
      return res.json();
    },
    onSuccess: (data: { isCompleted: boolean }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "beo"] });
      toast({ title: data.isCompleted ? "Step marked complete" : "Step marked incomplete" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update", description: error.message, variant: "destructive" });
    },
  });

  const toggleBeoTaskMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const tasks = (beoData as BeoEventWithDetails & { beoTasks?: Array<{ id: string; title: string; status: string }> })?.beoTasks || [];
      const task = tasks.find((t) => t.id === taskId);
      const newStatus = task?.status === "completed" ? "pending" : "completed";
      const res = await apiRequest("PATCH", `/api/tasks/${taskId}`, { status: newStatus });
      if (!res.ok) throw new Error("Failed to update task");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "beo"] });
    },
  });

  const invalidateBeo = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/events", eventId, "beo"] });
  };

  useEffect(() => {
    if (!beoData) return;
    const kp = (beoData as any).kitchenPlan;
    if (!kp) return;
    const submissionKey = kp.setMenuSelectionStatus?.isSubmitted
      ? String(kp.setMenuSelectionStatus.submittedAt || "submitted")
      : null;
    const hasNewParentResponse = submissionKey !== null && appliedSetMenuSubmissionRef.current !== submissionKey;
    if (kitchenInitRef.current && !hasNewParentResponse) return;
    const menus = kp.menus as { kids?: KitchenMenuLine[]; adults?: KitchenMenuLine[]; kidsFoodTime?: string; adultsFoodTime?: string; cakeIncluded?: boolean } | null;
    setLocalKidsMenu(menus?.kids || []);
    setLocalAdultsMenu(menus?.adults || []);
    setLocalKidsFoodTime(menus?.kidsFoodTime || "");
    setLocalAdultsFoodTime(menus?.adultsFoodTime || "");
    setSetMenuEnabled(kp.setMenuEnabled ?? false);
    setSetMenuTemplateId(kp.setMenuTemplateId || "");
    kitchenInitRef.current = true;
    appliedSetMenuSubmissionRef.current = submissionKey;
  }, [beoData]);

  const buildMenusPayload = (overrides: {
    kids?: KitchenMenuLine[];
    adults?: KitchenMenuLine[];
    kidsFoodTime?: string;
    adultsFoodTime?: string;
  } = {}) => {
    const existingMenus = ((beoData as any)?.kitchenPlan?.menus ?? {}) as Record<string, unknown>;
    return {
      ...existingMenus,
      kids: overrides.kids ?? localKidsMenu,
      adults: overrides.adults ?? localAdultsMenu,
      kidsFoodTime: overrides.kidsFoodTime ?? localKidsFoodTime,
      adultsFoodTime: overrides.adultsFoodTime ?? localAdultsFoodTime,
    };
  };

  const saveKidsMenu = (newKids: KitchenMenuLine[]) => {
    setLocalKidsMenu(newKids);
    kitchenPlanMutation.mutate({ menus: buildMenusPayload({ kids: newKids }) });
  };

  const saveAdultsMenu = (newAdults: KitchenMenuLine[]) => {
    setLocalAdultsMenu(newAdults);
    kitchenPlanMutation.mutate({ menus: buildMenusPayload({ adults: newAdults }) });
  };

  const onMutationError = (error: Error) => {
    toast({ title: "Failed to save", description: error.message, variant: "destructive" });
  };

  const partyHostMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await apiRequest("PUT", `/api/events/${eventId}/beo/party-host`, body);
      if (!res.ok) throw new Error("Failed to update assignment");
      return res.json();
    },
    onSuccess: invalidateBeo,
    onError: onMutationError,
  });

  const setupPlanMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await apiRequest("PUT", `/api/events/${eventId}/beo/setup-plan`, body);
      if (!res.ok) throw new Error("Failed to update setup plan");
      return res.json();
    },
    onSuccess: invalidateBeo,
    onError: onMutationError,
  });

  const kitchenPlanMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await apiRequest("PUT", `/api/events/${eventId}/beo/kitchen-plan`, {
        ...body,
        setMenuSelectionSubmittedAt: beoData?.kitchenPlan?.setMenuSelectionStatus?.submittedAt ?? null,
      });
      if (!res.ok) throw new Error("Failed to update kitchen plan");
      return res.json();
    },
    onSuccess: invalidateBeo,
    onError: onMutationError,
  });

  const eventNotesMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await apiRequest("PATCH", `/api/admin/events/${eventId}`, body);
      if (!res.ok) throw new Error("Failed to update notes");
      return res.json();
    },
    onSuccess: invalidateBeo,
    onError: onMutationError,
  });

  const addTimelineMutation = useMutation({
    mutationFn: async (data: { label: string; offsetFromStartMinutes: number; assignedToType: string }) => {
      const res = await apiRequest("POST", `/api/events/${eventId}/beo/timeline`, data);
      if (!res.ok) throw new Error("Failed to add step");
      return res.json();
    },
    onSuccess: invalidateBeo,
    onError: onMutationError,
  });

  const updateTimelineMutation = useMutation({
    mutationFn: async ({ id, ...data }: { id: string; label?: string; offsetFromStartMinutes?: number }) => {
      const res = await apiRequest("PATCH", `/api/events/${eventId}/beo/timeline/${id}`, data);
      if (!res.ok) throw new Error("Failed to update step");
      return res.json();
    },
    onSuccess: invalidateBeo,
    onError: onMutationError,
  });

  const deleteTimelineMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/events/${eventId}/beo/timeline/${id}`);
      if (!res.ok) throw new Error("Failed to delete step");
    },
    onSuccess: invalidateBeo,
    onError: onMutationError,
  });

  if (isLoading) {
    return <LoadingScreen message="Loading event..." />;
  }

  if (!beoData) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-muted-foreground">Event not found</p>
      </div>
    );
  }

  const getStaffName = (userId?: string | null) => {
    if (!userId) return null;
    const person = staff?.find((s) => s.id === userId);
    return person?.displayName || person?.username || "Unassigned";
  };

  const getResolvedHost = () => {
    if (beoData.partyHost?.assignedEmployeeName) {
      return beoData.partyHost.assignedEmployeeName;
    }
    if (beoData.partyHost?.resolvedUserName) {
      return beoData.partyHost.resolvedUserName;
    }
    if (beoData.partyHost?.assignmentMode === "INDIVIDUAL") {
      return getStaffName(beoData.partyHost.assignedUserId);
    }
    return getStaffName(beoData.partyHost?.resolvedUserId);
  };

  const getResolvedSetup = () => {
    if (beoData.setupPlan?.setupResponsibleMode === "INDIVIDUAL") {
      return getStaffName(beoData.setupPlan.setupResponsibleUserId);
    }
    return getStaffName(beoData.setupPlan?.setupResolvedUserId);
  };

  const getResolvedEntertainmentHost = () => {
    if (beoData.partyHost?.backupEmployeeName) {
      return beoData.partyHost.backupEmployeeName;
    }
    if (beoData.partyHost?.backupEmployeeId) {
      return getStaffName(beoData.partyHost.backupEmployeeId);
    }
    return getStaffName(beoData.partyHost?.backupUserId);
  };

  const getEntertainmentProgramName = () => {
    const r = (beoData.partyHost?.responsibilities || []).find((s: string) => s.startsWith("PROG:"));
    return r ? r.slice(5) : "";
  };

  const getEntertainmentTime = () => {
    const r = (beoData.partyHost?.responsibilities || []).find((s: string) => s.startsWith("ETIME:"));
    return r ? r.slice(6) : "";
  };

  const updateEntertainmentExtra = (programName: string, time: string) => {
    const others = (beoData.partyHost?.responsibilities || []).filter((s: string) => !s.startsWith("PROG:") && !s.startsWith("ETIME:"));
    const updated = [
      ...others,
      ...(programName ? [`PROG:${programName}`] : []),
      ...(time ? [`ETIME:${time}`] : []),
    ];
    partyHostMutation.mutate({ responsibilities: updated });
  };

  const currentOffset = getCurrentMinuteOffset(beoData.startTime);
  const deduplicatedTimeline = (() => {
    const raw = beoData.timeline?.slice() || [];
    const seen = new Set<string>();
    return raw.filter(item => {
      const key = `${item.label}::${item.offsetFromStartMinutes}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  })();
  const sortedTimeline = deduplicatedTimeline.sort((a, b) => a.offsetFromStartMinutes - b.offsetFromStartMinutes);

  const findCurrentIndex = () => {
    for (let i = sortedTimeline.length - 1; i >= 0; i--) {
      if (sortedTimeline[i].offsetFromStartMinutes <= currentOffset) {
        return i;
      }
    }
    return -1;
  };

  const currentIndex = findCurrentIndex();

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="flex-1 overflow-y-auto">
        <div className="p-4 space-y-4">
          {(beoData as any).title && (
            <h2 className="text-xl font-bold" data-testid="text-event-title">{(beoData as any).title}</h2>
          )}
          <div className="p-3 rounded-lg bg-muted space-y-3">
            {beoData.childName && (
              <div className="flex items-center gap-2">
                <Cake className="h-5 w-5 text-primary" />
                <span className="text-lg font-semibold" data-testid="text-child-name">{beoData.childName}</span>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {(beoData.parentName || beoData.bookingName) && (
                <div className="flex items-center gap-2">
                  <User className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium" data-testid="text-parent-name">{beoData.parentName || beoData.bookingName}</span>
                </div>
              )}
              {beoData.startTime && (
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium" data-testid="text-start-time">{beoData.startTime}</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium" data-testid="text-guest-counts">
                  {beoData.numChildren || 0} kids, {beoData.numAdults || 0} adults
                </span>
              </div>
            </div>
            {(beoData as any).kidTurningAge != null && (
              <div className="flex items-center gap-2">
                <Cake className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium" data-testid="text-kid-turning-age">Turning {(beoData as any).kidTurningAge}</span>
              </div>
            )}
            {beoData.activities && (
              <div className="flex items-center gap-2">
                <Music className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm" data-testid="text-activities">{beoData.activities}</span>
              </div>
            )}
            {(() => {
              const whatsappDisplay = beoData.whatsappPhoneRaw || beoData.whatsappPhoneE164;
              if (!whatsappDisplay) return null;
              const whatsappDigits = whatsappDisplay.replace(/[^0-9]/g, '');
              if (!whatsappDigits) return null;
              return (
                <a 
                  href={`https://wa.me/${whatsappDigits}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-green-600 hover:text-green-700 font-medium"
                  data-testid="link-whatsapp-parent"
                >
                  <Phone className="h-4 w-4" />
                  <span>{whatsappDisplay}</span>
                </a>
              );
            })()}
            {(() => {
              const locationLabel = beoData.locationText || beoData.location?.name;
              if (!locationLabel) return null;
              return (
                <a
                  href={`https://www.google.com/maps/search/${encodeURIComponent(locationLabel)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-muted-foreground hover:text-foreground"
                  data-testid="link-location-map"
                >
                  <MapPin className="h-4 w-4" />
                  <span className="text-sm">{locationLabel}</span>
                </a>
              );
            })()}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Card className="p-3">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <User className="h-4 w-4 text-blue-500" />
                  <span className="text-xs text-muted-foreground">Party Host</span>
                </div>
                {canEdit && !editingHost && (
                  <button
                    type="button"
                    onClick={() => setEditingHost(true)}
                    className="text-muted-foreground hover:text-foreground"
                    data-testid="button-edit-host"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
              </div>
              {editingHost ? (
                <StaffAssignSelect
                  value={beoData.partyHost?.assignedUserId || beoData.partyHost?.resolvedUserId}
                  staff={staff}
                  disabled={partyHostMutation.isPending}
                  testId="select-host"
                  onChange={(userId) => {
                    partyHostMutation.mutate(
                      userId
                        ? { assignmentMode: "INDIVIDUAL", assignedUserId: userId, assignedEmployeeId: null, assignedRoleId: null }
                        : { assignmentMode: "INDIVIDUAL", assignedUserId: null, assignedEmployeeId: null, assignedRoleId: null }
                    );
                    setEditingHost(false);
                  }}
                />
              ) : (
                <p className="font-medium text-sm truncate" data-testid="text-host-name">
                  {getResolvedHost() || (
                    <span className="text-yellow-600 flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" />
                      Unassigned
                    </span>
                  )}
                </p>
              )}
            </Card>
            <Card className="p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Music className="h-4 w-4 text-purple-500" />
                  <span className="text-xs text-muted-foreground">Entertainment</span>
                </div>
                {canEdit && !editingEntertainment && (
                  <button
                    type="button"
                    onClick={() => setEditingEntertainment(true)}
                    className="text-muted-foreground hover:text-foreground"
                    data-testid="button-edit-entertainment"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
              </div>
              {editingEntertainment ? (
                <StaffAssignSelect
                  value={beoData.partyHost?.backupUserId}
                  staff={staff}
                  disabled={partyHostMutation.isPending}
                  testId="select-entertainment"
                  onChange={(userId) => {
                    partyHostMutation.mutate({ backupUserId: userId, backupEmployeeId: null });
                    setEditingEntertainment(false);
                  }}
                />
              ) : (
                <p className="font-medium text-sm truncate" data-testid="text-entertainment-host-name">
                  {getResolvedEntertainmentHost() || (
                    <span className="text-muted-foreground text-xs">No host</span>
                  )}
                </p>
              )}
              <div className="space-y-1">
                <div className="flex items-center gap-1">
                  <span className="text-xs text-muted-foreground shrink-0">Program:</span>
                  {canEdit ? (
                    <EditableText
                      className="text-xs flex-1"
                      value={getEntertainmentProgramName()}
                      placeholder="Program name..."
                      onChange={(v) => updateEntertainmentExtra(v, getEntertainmentTime())}
                      data-testid="input-entertainment-program"
                    />
                  ) : (
                    <span className="text-xs">{getEntertainmentProgramName() || <span className="text-muted-foreground">—</span>}</span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
                  {canEdit ? (
                    <EditableText
                      type="time"
                      className="w-[70px] text-xs"
                      value={getEntertainmentTime()}
                      onChange={(v) => updateEntertainmentExtra(getEntertainmentProgramName(), v || "")}
                      data-testid="input-entertainment-time"
                    />
                  ) : (
                    <span className="text-xs">{getEntertainmentTime() ? formatTime(getEntertainmentTime()) : <span className="text-muted-foreground">—</span>}</span>
                  )}
                </div>
              </div>
            </Card>
          </div>

          <Separator />

          <div>
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Timeline
            </h3>
            {sortedTimeline.length === 0 && localTimelineItems.length === 0 ? (
              canEdit ? (
                <div
                  className="text-sm text-muted-foreground text-center py-4 border border-dashed rounded-md cursor-pointer hover:bg-accent/30 hover:border-border transition-colors"
                  onClick={() => setLocalTimelineItems([{ id: `local-${Date.now()}`, label: "", offsetFromStartMinutes: 0, assignedToType: "PARTY_HOST", isLocal: true }])}
                  data-testid="button-add-first-timeline-item"
                >
                  Click here to add first timeline step
                </div>
              ) : (
                <p className="text-muted-foreground text-center py-4">No timeline items</p>
              )
            ) : (
              <div className="space-y-1">
                {[...sortedTimeline, ...localTimelineItems].map((item, index) => {
                  const isLocalItem = "isLocal" in item && item.isLocal;
                  const realItem = isLocalItem ? null : (item as typeof sortedTimeline[number]);
                  const Icon = ROLE_ICONS[item.assignedToType] || User;
                  const isCurrent = !isLocalItem && index === currentIndex;
                  const isNext = !isLocalItem && index === currentIndex + 1;

                  return (
                    <div
                      key={item.id}
                      className={`flex items-center gap-3 p-3 rounded-lg transition-colors ${
                        isCurrent
                          ? "bg-primary/10 border-l-4 border-l-primary"
                          : isNext
                          ? "bg-muted/50"
                          : realItem?.isCompleted
                          ? "opacity-60"
                          : ""
                      }`}
                      data-testid={`timeline-item-${index}`}
                    >
                      <div className="flex flex-col items-center">
                        {canEdit ? (
                          <EditableText
                            type="time"
                            className="w-[70px] text-xs font-mono text-center"
                            value={getTimeFromOffset(beoData.startTime, item.offsetFromStartMinutes)}
                            onChange={(v) => {
                              if (!v) return;
                              const offset = timeToOffset(beoData.startTime, v);
                              if (isLocalItem) {
                                setLocalTimelineItems((prev) => prev.map((li) => li.id === item.id ? { ...li, offsetFromStartMinutes: offset } : li));
                              } else {
                                updateTimelineMutation.mutate({ id: item.id, offsetFromStartMinutes: offset });
                              }
                            }}
                            data-testid={`input-timeline-time-${index}`}
                          />
                        ) : (
                          <span className="text-sm font-mono font-medium">
                            {formatTime(getTimeFromOffset(beoData.startTime, item.offsetFromStartMinutes))}
                          </span>
                        )}
                        {isCurrent && (
                          <Badge variant="default" className="text-xs mt-1">NOW</Badge>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        {canEdit ? (
                          <EditableText
                            className="font-medium text-sm"
                            value={item.label}
                            placeholder="What happens at this time..."
                            onChange={(v) => {
                              if (isLocalItem) {
                                if (!v.trim()) {
                                  setLocalTimelineItems((prev) => prev.filter((li) => li.id !== item.id));
                                  return;
                                }
                                addTimelineMutation.mutate({
                                  label: v.trim(),
                                  offsetFromStartMinutes: item.offsetFromStartMinutes,
                                  assignedToType: item.assignedToType,
                                });
                                setLocalTimelineItems((prev) => prev.filter((li) => li.id !== item.id));
                              } else if (v.trim() && v !== item.label) {
                                updateTimelineMutation.mutate({ id: item.id, label: v.trim() });
                              }
                            }}
                            data-testid={`input-timeline-label-${index}`}
                          />
                        ) : (
                          <p className={`font-medium ${realItem?.isCompleted ? "line-through text-muted-foreground" : ""}`}>
                            {item.label}
                          </p>
                        )}
                        {realItem && (
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Icon className="h-3 w-3" />
                            <span>{ROLE_LABELS[item.assignedToType]}</span>
                            {realItem.isSystemGenerated ? (
                              <span className="text-[10px] opacity-50 ml-1">· auto</span>
                            ) : (
                              <span className="text-[10px] opacity-50 ml-1">· manual</span>
                            )}
                          </div>
                        )}
                      </div>
                      {!isLocalItem && (
                        <div className="flex items-center gap-0.5">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => completeMutation.mutate(item.id)}
                            disabled={completeMutation.isPending}
                            className="h-8 w-8"
                            data-testid={`button-complete-${index}`}
                          >
                            {completeMutation.isPending ? (
                              <Loader2 className="h-5 w-5 animate-spin" />
                            ) : realItem?.isCompleted ? (
                              <CheckCircle2 className="h-6 w-6 text-green-500" />
                            ) : (
                              <Circle className="h-5 w-5" />
                            )}
                          </Button>
                          {canEdit && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => deleteTimelineMutation.mutate(item.id)}
                              disabled={deleteTimelineMutation.isPending}
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              data-testid={`button-delete-timeline-${index}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {canEdit && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full mt-1"
                    onClick={() => {
                      const all = [...sortedTimeline, ...localTimelineItems];
                      const nextOffset = all.length > 0 ? all[all.length - 1].offsetFromStartMinutes + 15 : 0;
                      setLocalTimelineItems((prev) => [...prev, { id: `local-${Date.now()}`, label: "", offsetFromStartMinutes: nextOffset, assignedToType: "PARTY_HOST", isLocal: true }]);
                    }}
                    data-testid="button-add-timeline-step"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add Step
                  </Button>
                )}
              </div>
            )}
          </div>

          <Separator />

          {(() => {
            const setupPlan = beoData.setupPlan;
            const kitchenPlan = beoData.kitchenPlan;
            const beoTasks = (beoData as BeoEventWithDetails & { beoTasks?: Array<{ id: string; title: string; status: string }> }).beoTasks || [];
            const partyDetails = beoData.partyDetails;

            const getBeoTaskStatus = (prefix: string) => {
              const task = beoTasks.find((t) => t.title?.startsWith(prefix));
              if (!task) return null;
              return task;
            };

            const DoneToggle = ({ prefix, label }: { prefix: string; label: string }) => {
              const task = getBeoTaskStatus(prefix);
              const taskCompleted = task?.status === "completed";
              const localKey = prefix;
              const isCompleted = sectionDone[localKey] ?? taskCompleted ?? false;
              const handleToggle = (e: React.MouseEvent | React.KeyboardEvent) => {
                e.stopPropagation();
                if (task) {
                  toggleBeoTaskMutation.mutate(task.id);
                }
                setSectionDone(prev => ({ ...prev, [localKey]: !isCompleted }));
              };
              return (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={handleToggle}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleToggle(e); } }}
                  className={`flex items-center gap-1 text-xs font-medium px-3 py-1 rounded-full border cursor-pointer transition-colors ${
                    isCompleted
                      ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/30 dark:text-emerald-400"
                      : "bg-muted text-muted-foreground border-border hover:bg-accent"
                  }`}
                  data-testid={`beo-task-toggle-${prefix.replace(/[^a-z]/gi, "").toLowerCase()}`}
                >
                  {isCompleted ? <CheckCircle2 className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
                  {isCompleted ? "Done" : label}
                </span>
              );
            };

            type SetupTaskItem = { id?: string; itemLabel?: string; itemKey?: string; notes?: string };
            type SetupTasksShape = { readyBy?: string; responsible?: string; simplifiedTasks?: SetupTaskItem[] };
            const rawSetupTasks = setupPlan?.setupTasks;
            const isLegacyArray = Array.isArray(rawSetupTasks);
            const setupTasksData = isLegacyArray ? null : (rawSetupTasks as SetupTasksShape | null);
            const setupSimplifiedTasks: SetupTaskItem[] = isLegacyArray
              ? (rawSetupTasks as SetupTaskItem[])
              : (setupTasksData?.simplifiedTasks || []);
            const setupResponsible = setupTasksData?.responsible || null;

            const computedSetupReadyBy = setupPlan?.setupDeadlineOffsetMinutes != null
              ? formatTime(getTimeFromOffset(beoData.startTime, -(setupPlan.setupDeadlineOffsetMinutes)))
              : setupTasksData?.readyBy || null;

            const packageSnapshotData = beoData.packageSnapshot;
            const billingData = beoData.billing;
            const posLineItems = beoData.lineItems || [];
            const posPartyDetails = partyDetails as { packageName?: string; packageBasePrice?: number; items?: Array<{ id: string; description: string; type: "included" | "extra"; price: number; notes: string }>; prepaymentReceived?: number; depositDate?: string; notes?: string } | null;
            const hasPosData = !!packageSnapshotData || posLineItems.length > 0 || billingData?.packagePrice != null || !!posPartyDetails?.packageName || (posPartyDetails?.items && posPartyDetails.items.length > 0);

            const posPackageName = packageSnapshotData?.packageName || posPartyDetails?.packageName || null;
            const partyDetailsItems = posPartyDetails?.items || [];
            const includedItems = partyDetailsItems.filter(item => item.type === "included");
            const extraItems = partyDetailsItems.filter(item => item.type === "extra");
            const extrasTotal = extraItems.reduce((sum, item) => sum + (Number(item.price) || 0), 0);
            const packageBasePrice = Number(posPartyDetails?.packageBasePrice) || 0;
            const partyDetailsTotal = partyDetailsItems.length > 0 || posPartyDetails?.packageBasePrice != null
              ? extrasTotal + packageBasePrice
              : null;
            const lineItemsTotal = posLineItems.length > 0
              ? posLineItems.reduce((sum, li) => sum + (li.qty * li.unitPriceIncVat), 0)
              : null;
            const posPrice = billingData?.packagePrice ?? packageSnapshotData?.basePrice ?? lineItemsTotal ?? partyDetailsTotal;
            const depositPaid = Number(posPartyDetails?.prepaymentReceived) || 0;
            const outstanding = posPrice != null ? Number(posPrice) - depositPaid : null;

            return (
              <div className="space-y-3">
                {hasPosData && (
                  <div
                    className="rounded-lg border border-border/50 bg-card overflow-hidden"
                    style={{ borderLeft: "4px solid #7c3aed" }}
                    data-testid="section-pos"
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      className="w-full flex items-center justify-between p-3 text-left cursor-pointer"
                      onClick={() => setPosExpanded(!posExpanded)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPosExpanded(!posExpanded); } }}
                      data-testid="button-toggle-pos"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Gift className="h-5 w-5 text-purple-500 shrink-0" />
                        <span className="font-semibold text-base shrink-0">POS</span>
                        {posPrice != null && (
                          <Badge variant="outline" className="text-xs shrink-0" data-testid="text-pos-price">
                            ฿{Number(posPrice).toLocaleString()}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <DoneToggle prefix="💰 POS Setup:" label="Mark Done" />
                        <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform ${posExpanded ? "rotate-180" : ""}`} />
                      </div>
                    </div>
                    {posExpanded && (
                      <div className="px-3 pb-3 space-y-3" data-testid="content-pos">
                        {posPackageName && (
                          <div className="flex items-center justify-between">
                            <Badge variant="outline" className="text-xs font-medium" data-testid="badge-pos-package">
                              {posPackageName}
                            </Badge>
                            {packageBasePrice > 0 && (
                              <span className="text-sm font-mono tabular-nums shrink-0 ml-2">฿{packageBasePrice.toLocaleString()}</span>
                            )}
                          </div>
                        )}

                        {partyDetailsItems.length > 0 && (
                          <div className="space-y-1" data-testid="list-pos-items">
                            {includedItems.length > 0 && (
                              <div className="space-y-0.5">
                                <span className="text-[10px] text-emerald-500 font-semibold uppercase tracking-wider">Included</span>
                                {includedItems.map((item, idx) => (
                                  <div key={item.id || `incl-${idx}`} className="flex items-center gap-2 text-sm py-0.5 pl-1" data-testid={`row-pos-item-incl-${idx}`}>
                                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                                    <span className="text-muted-foreground">{item.description}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {extraItems.length > 0 && (
                              <div className="space-y-0.5 pt-1">
                                <span className="text-[10px] text-amber-500 font-semibold uppercase tracking-wider">Extras</span>
                                {extraItems.map((item, idx) => (
                                  <div key={item.id || `extra-${idx}`} className="flex items-center justify-between text-sm py-0.5 pl-1" data-testid={`row-pos-item-extra-${idx}`}>
                                    <div className="flex items-center gap-2 min-w-0">
                                      <div className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                                      <span className="truncate">{item.description}</span>
                                    </div>
                                    {item.price > 0 && (
                                      <span className="text-sm font-mono tabular-nums shrink-0 ml-2">฿{Number(item.price).toLocaleString()}</span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {(posPrice != null || depositPaid > 0) && (
                          <div className="border-t border-border/50 pt-2 space-y-1">
                            {posPrice != null && (
                              <div className="flex items-center justify-between text-sm">
                                <span className="text-muted-foreground">Total</span>
                                <span className="font-semibold">฿{Number(posPrice).toLocaleString()}</span>
                              </div>
                            )}
                            {depositPaid > 0 && (
                              <div className="flex items-center justify-between text-sm">
                                <span className="text-muted-foreground">Deposit paid{posPartyDetails?.depositDate ? ` (${posPartyDetails.depositDate})` : ""}</span>
                                <span className="text-emerald-500 font-medium">-฿{depositPaid.toLocaleString()}</span>
                              </div>
                            )}
                            {outstanding != null && depositPaid > 0 && (
                              <div className="flex items-center justify-between text-sm font-semibold pt-0.5 border-t border-dashed border-border/50">
                                <span>Outstanding</span>
                                <span className={outstanding > 0 ? "text-amber-500" : "text-emerald-500"} data-testid="text-pos-outstanding">
                                  ฿{outstanding.toLocaleString()}
                                </span>
                              </div>
                            )}
                          </div>
                        )}

                        {billingData?.posOrderRef && (
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span>POS Ref:</span>
                            <span className="font-mono">{billingData.posOrderRef}</span>
                          </div>
                        )}

                        {posPartyDetails?.notes && (
                          <div className="text-xs text-muted-foreground italic border-t border-border/50 pt-2" data-testid="text-pos-notes">
                            {posPartyDetails.notes}
                          </div>
                        )}

                        {!posPackageName && posPrice == null && partyDetailsItems.length === 0 && (
                          <p className="text-sm text-muted-foreground">No POS details available</p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div
                  className="rounded-lg border border-border/50 bg-card overflow-hidden"
                  style={{ borderLeft: "4px solid #f97316" }}
                  data-testid="section-setup-plan"
                >
                    <div
                      role="button"
                      tabIndex={0}
                      className="w-full flex items-center justify-between p-4 text-left cursor-pointer"
                      onClick={() => setSetupExpanded(!setupExpanded)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSetupExpanded(!setupExpanded); } }}
                      data-testid="button-toggle-setup-plan"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Settings className="h-5 w-5 text-orange-500 shrink-0" />
                        <span className="font-semibold text-base shrink-0">Setup Plan</span>
                        {computedSetupReadyBy && (
                          <Badge variant="outline" className="text-xs shrink-0" data-testid="badge-setup-ready-by">
                            Ready by {computedSetupReadyBy}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <DoneToggle prefix="🔧 Setup:" label="Mark Done" />
                        <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform ${setupExpanded ? "rotate-180" : ""}`} />
                      </div>
                    </div>
                    {setupExpanded && (
                      <div className="px-4 pb-4 space-y-2" data-testid="content-setup-plan">
                        <div className="flex items-center gap-2 py-1.5 px-3 rounded-md bg-muted/50">
                          <Clock className="h-4 w-4 text-orange-500 shrink-0" />
                          <span className="text-sm font-medium shrink-0">Ready by</span>
                          {canEdit ? (
                            <EditableText
                              type="time"
                              className="w-[90px] text-sm font-medium text-primary"
                              value={getTimeFromOffset(beoData.startTime, -(setupPlan?.setupDeadlineOffsetMinutes ?? 30))}
                              onChange={(v) => {
                                if (!v) return;
                                const offset = -timeToOffset(beoData.startTime, v);
                                setupPlanMutation.mutate({ setupDeadlineOffsetMinutes: offset });
                              }}
                              data-testid="input-setup-ready-by"
                            />
                          ) : (
                            <span className="text-sm font-medium text-primary">{computedSetupReadyBy}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-sm">
                          <User className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="text-muted-foreground shrink-0">Responsible:</span>
                          {canEdit ? (
                            <div className="flex-1">
                              <StaffAssignSelect
                                value={setupPlan?.setupResponsibleUserId || setupPlan?.setupResolvedUserId}
                                staff={staff}
                                disabled={setupPlanMutation.isPending}
                                testId="select-setup-plan-responsible"
                                onChange={(userId) => {
                                  setupPlanMutation.mutate(
                                    userId
                                      ? { setupResponsibleMode: "INDIVIDUAL", setupResponsibleUserId: userId }
                                      : { setupResponsibleMode: "INDIVIDUAL", setupResponsibleUserId: null }
                                  );
                                }}
                              />
                            </div>
                          ) : (
                            <span>{setupResponsible}</span>
                          )}
                        </div>
                        <div className="pt-1">
                          <p className="text-xs text-muted-foreground mb-1">Tasks:</p>
                          <div className="space-y-1">
                            {setupSimplifiedTasks.map((task, i) => (
                              <div key={task.id || i} className="flex items-start gap-2 py-0.5">
                                {canEdit ? (
                                  <>
                                    <EditableText
                                      className="flex-1 text-sm"
                                      value={task.itemLabel || task.itemKey || ""}
                                      onChange={(v) => {
                                        const updated = setupSimplifiedTasks.map((t, idx) => idx === i ? { ...t, itemLabel: v } : t);
                                        setupPlanMutation.mutate({ setupTasks: { simplifiedTasks: updated } });
                                      }}
                                      data-testid={`input-setup-task-${i}`}
                                    />
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const updated = setupSimplifiedTasks.filter((_, idx) => idx !== i);
                                        setupPlanMutation.mutate({ setupTasks: { simplifiedTasks: updated } });
                                      }}
                                      className="text-muted-foreground hover:text-destructive shrink-0 mt-1.5"
                                      data-testid={`button-delete-setup-task-${i}`}
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    <span className="text-sm">• {task.itemLabel || task.itemKey}</span>
                                    {task.notes && <span className="text-xs text-muted-foreground">({task.notes})</span>}
                                  </>
                                )}
                              </div>
                            ))}
                            {setupSimplifiedTasks.length === 0 && !canEdit && (
                              <p className="text-sm text-muted-foreground">No tasks added</p>
                            )}
                          </div>
                          {canEdit && (
                            addingSetupTask ? (
                              <div className="flex items-center gap-2 pt-1">
                                <input
                                  autoFocus
                                  value={newSetupTask}
                                  onChange={(e) => setNewSetupTask(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && newSetupTask.trim()) {
                                      setupPlanMutation.mutate({ setupTasks: { simplifiedTasks: [...setupSimplifiedTasks, { itemLabel: newSetupTask.trim() }] } });
                                      setNewSetupTask("");
                                      setAddingSetupTask(false);
                                    } else if (e.key === "Escape") {
                                      setNewSetupTask("");
                                      setAddingSetupTask(false);
                                    }
                                  }}
                                  placeholder="New task..."
                                  className="flex-1 h-8 text-sm rounded-md border border-input bg-background px-2"
                                  data-testid="input-new-setup-task"
                                />
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (newSetupTask.trim()) {
                                      setupPlanMutation.mutate({ setupTasks: { simplifiedTasks: [...setupSimplifiedTasks, { itemLabel: newSetupTask.trim() }] } });
                                    }
                                    setNewSetupTask("");
                                    setAddingSetupTask(false);
                                  }}
                                  className="text-green-600 hover:text-green-700"
                                  data-testid="button-save-new-setup-task"
                                >
                                  <Check className="h-4 w-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => { setNewSetupTask(""); setAddingSetupTask(false); }}
                                  className="text-muted-foreground hover:text-foreground"
                                  data-testid="button-cancel-new-setup-task"
                                >
                                  <X className="h-4 w-4" />
                                </button>
                              </div>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                className="w-full mt-1.5"
                                onClick={() => setAddingSetupTask(true)}
                                data-testid="button-add-setup-task"
                              >
                                <Plus className="h-3.5 w-3.5 mr-1.5" />
                                Add Task
                              </Button>
                            )
                          )}
                        </div>
                        <div className="pt-1">
                          <p className="text-xs text-muted-foreground">Notes:</p>
                          {canEdit ? (
                            <EditableText
                              multiline
                              className="text-sm"
                              value={setupPlan?.setupNotes || ""}
                              placeholder="Add setup notes..."
                              onChange={(v) => setupPlanMutation.mutate({ setupNotes: v })}
                              data-testid="input-setup-notes"
                            />
                          ) : (
                            <p className="text-sm">{setupPlan?.setupNotes}</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                <div
                  className="rounded-lg border border-border/50 bg-card overflow-hidden"
                  style={{ borderLeft: "4px solid #3b82f6" }}
                  data-testid="section-kitchen-plan"
                >
                    <div
                      role="button"
                      tabIndex={0}
                      className="w-full flex items-center justify-between p-4 text-left cursor-pointer"
                      onClick={() => setKitchenExpanded(!kitchenExpanded)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setKitchenExpanded(!kitchenExpanded); } }}
                      data-testid="button-toggle-kitchen-plan"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <UtensilsCrossed className="h-5 w-5 text-blue-500 shrink-0" />
                        <span className="font-semibold text-base shrink-0">Kitchen Plan</span>
                        {kitchenPlan && !kitchenPlan.foodRequired && localKidsMenu.length === 0 && localAdultsMenu.length === 0 && (
                          <Badge variant="outline" className="text-xs shrink-0">Not Required</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <DoneToggle prefix="🍽️ Kitchen:" label="Mark Done" />
                        <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform ${kitchenExpanded ? "rotate-180" : ""}`} />
                      </div>
                    </div>
                    {kitchenExpanded && (
                      <div className="px-4 pb-4 space-y-3" data-testid="content-kitchen-plan">
                        {canEdit && (
                          <div className="flex items-center justify-between py-1">
                            <span className="text-sm text-muted-foreground">Kitchen needed</span>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => kitchenPlanMutation.mutate({ foodRequired: false })}
                                className={`px-2 py-0.5 text-xs rounded border transition-colors ${kitchenPlan?.foodRequired === false ? "bg-destructive/10 text-destructive border-destructive/30 font-semibold" : "text-muted-foreground border-border hover:bg-muted"}`}
                                data-testid="button-kitchen-not-needed"
                              >
                                Not Needed
                              </button>
                              <button
                                type="button"
                                onClick={() => kitchenPlanMutation.mutate({ foodRequired: true })}
                                className={`px-2 py-0.5 text-xs rounded border transition-colors ${kitchenPlan?.foodRequired !== false ? "bg-green-500/10 text-green-700 border-green-500/30 font-semibold" : "text-muted-foreground border-border hover:bg-muted"}`}
                                data-testid="button-kitchen-needed"
                              >
                                Needed
                              </button>
                            </div>
                          </div>
                        )}
                        {kitchenPlan?.foodPackageName && (
                          <div>
                            <p className="text-xs text-muted-foreground">Food Package:</p>
                            <p className="text-sm font-medium">{kitchenPlan.foodPackageName}</p>
                          </div>
                        )}

                        {/* Set Menu Toggle (kids menu only) */}
                        {menuTab === "kids" && (canEdit || setMenuEnabled) && (
                          <div className="space-y-3">
                            <div className="flex items-center gap-3 p-3 border rounded-md bg-muted/30">
                              <Switch
                                checked={setMenuEnabled}
                                disabled={!canEdit}
                                onCheckedChange={(v) => {
                                  if (!v) {
                                    setSetMenuTemplateId("");
                                  }
                                  setSetMenuEnabled(v);
                                  kitchenPlanMutation.mutate({ setMenuEnabled: v, setMenuTemplateId: v ? setMenuTemplateId || null : null });
                                }}
                                data-testid="switch-set-menu-enabled"
                              />
                              <div>
                                <Label className="text-sm font-medium">Set Menu</Label>
                                <p className="text-xs text-muted-foreground">Attach a set menu template and send a link to parents/guests for their choices</p>
                              </div>
                            </div>

                            {setMenuEnabled && (
                              <>
                                <div className="space-y-1">
                                  <Label className="text-xs text-muted-foreground">Set Menu Template</Label>
                                  <Select
                                    value={setMenuTemplateId}
                                    onValueChange={(v) => {
                                      setSetMenuTemplateId(v);
                                      kitchenPlanMutation.mutate({ setMenuEnabled: true, setMenuTemplateId: v });
                                    }}
                                    disabled={!canEdit}
                                  >
                                    <SelectTrigger className="text-sm" data-testid="select-set-menu-template">
                                      <SelectValue placeholder="Pick a template..." />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {setMenuTemplates.filter(t => t.isActive).length === 0 ? (
                                        <SelectItem value="__none__" disabled>No templates — add one in Event Settings</SelectItem>
                                      ) : (
                                        setMenuTemplates.filter(t => t.isActive).map(t => (
                                          <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                                        ))
                                      )}
                                    </SelectContent>
                                  </Select>
                                </div>

                                {setMenuTemplateId && (
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
                                      disabled={!canEdit || generateLinkMutation.isPending}
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
                                        disabled={!canEdit || resetSelectionMutation.isPending}
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
                                )}
                              </>
                            )}
                          </div>
                        )}

                        {/* Menus section */}
                        {(localKidsMenu.length > 0 || localAdultsMenu.length > 0 || canEdit) && (
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="flex gap-1">
                                <Button
                                  variant={menuTab === "kids" ? "default" : "outline"}
                                  size="sm"
                                  onClick={() => setMenuTab("kids")}
                                  data-testid="button-menu-tab-kids"
                                >
                                  Kids Menu ({localKidsMenu.length})
                                </Button>
                                <Button
                                  variant={menuTab === "adults" ? "default" : "outline"}
                                  size="sm"
                                  onClick={() => setMenuTab("adults")}
                                  data-testid="button-menu-tab-adults"
                                >
                                  Adults Menu ({localAdultsMenu.length})
                                </Button>
                              </div>
                              {canEdit ? (
                                <div className="flex items-center gap-1 ml-auto">
                                  <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                                  <span className="text-xs text-muted-foreground">Service:</span>
                                  <EditableText
                                    type="time"
                                    className="w-[80px] text-xs font-mono"
                                    value={menuTab === "kids" ? localKidsFoodTime : localAdultsFoodTime}
                                    onChange={(v) => {
                                      if (menuTab === "kids") {
                                        setLocalKidsFoodTime(v);
                                        kitchenPlanMutation.mutate({ menus: buildMenusPayload({ kidsFoodTime: v }) });
                                      } else {
                                        setLocalAdultsFoodTime(v);
                                        kitchenPlanMutation.mutate({ menus: buildMenusPayload({ adultsFoodTime: v }) });
                                      }
                                    }}
                                    data-testid={`input-food-service-time-${menuTab}`}
                                  />
                                </div>
                              ) : (
                                (menuTab === "kids" ? localKidsFoodTime : localAdultsFoodTime) && (
                                  <span className="text-xs text-muted-foreground ml-auto">
                                    Service: {menuTab === "kids" ? localKidsFoodTime : localAdultsFoodTime}
                                  </span>
                                )
                              )}
                            </div>

                            {(() => {
                              const template = ((beoData as any).kitchenPlan?.setMenuTemplate || setMenuTemplates.find((item) => item.id === setMenuTemplateId)) as SetMenuTemplate | undefined;
                              const activeMenu = menuTab === "kids" ? localKidsMenu : localAdultsMenu;
                              return setMenuEnabled && template ? <DayOfSetMenuChoices template={template} menuItems={activeMenu} /> : null;
                            })()}

                            {canEdit ? (
                              <div className="space-y-1">
                                {(menuTab === "kids" ? localKidsMenu : localAdultsMenu).filter((item) => item.source !== "set_menu").length === 0 ? (
                                  <div
                                    className="text-sm text-muted-foreground text-center py-4 border border-dashed rounded-md cursor-pointer hover:bg-accent/30 hover:border-border transition-colors"
                                    onClick={() => {
                                      const newItem: KitchenMenuLine = { id: `menu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, itemName: "", quantity: 1, notes: "", included: true, price: 0 };
                                      if (menuTab === "kids") saveKidsMenu([newItem]);
                                      else saveAdultsMenu([newItem]);
                                    }}
                                    data-testid={`button-add-first-menu-${menuTab}`}
                                  >
                                    Click here to add first item
                                  </div>
                                ) : (
                                  <>
                                    {(menuTab === "kids" ? localKidsMenu : localAdultsMenu).filter((item) => item.source !== "set_menu").map((item, idx) => (
                                      <KitchenMenuItemRow
                                        key={item.id}
                                        item={item}
                                        idx={idx}
                                        menuItems={menuTab === "kids" ? localKidsMenu : localAdultsMenu}
                                        menuTab={menuTab}
                                        onSave={(updated) => {
                                          if (menuTab === "kids") saveKidsMenu(updated);
                                          else saveAdultsMenu(updated);
                                        }}
                                      />
                                    ))}
                                    <button
                                      className="text-[10px] font-semibold px-2 py-0.5 rounded-full border cursor-pointer bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400 hover:bg-amber-500/25 transition-colors"
                                      onClick={() => {
                                        const current = menuTab === "kids" ? localKidsMenu : localAdultsMenu;
                                        const newItem: KitchenMenuLine = { id: `menu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, itemName: "", quantity: 1, notes: "", included: false, price: 0 };
                                        const updated = [...current, newItem];
                                        if (menuTab === "kids") saveKidsMenu(updated);
                                        else saveAdultsMenu(updated);
                                      }}
                                      data-testid={`button-add-menu-extra-${menuTab}`}
                                    >
                                      + EXTRA
                                    </button>
                                  </>
                                )}
                              </div>
                            ) : (
                              <ul className="space-y-0.5">
                                {(menuTab === "kids" ? localKidsMenu : localAdultsMenu).filter((item) => item.source !== "set_menu").map((item, idx) => (
                                  <li key={idx} className="text-sm flex items-center gap-2">
                                    <span>{item.itemName}</span>
                                    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${item.source === "set_menu" ? "bg-blue-500/10 text-blue-600 border-blue-500/30" : "bg-amber-500/10 text-amber-600 border-amber-500/30"}`}>
                                      {item.source === "set_menu" ? "SET" : "EXTRA"}
                                    </Badge>
                                    {item.notes && <span className="text-xs text-muted-foreground">({item.notes})</span>}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}


                        {(kitchenPlan?.dietaryNotes || canEdit) && (
                          <div className="pt-1">
                            <p className="text-xs text-muted-foreground">Dietary Notes:</p>
                            {canEdit ? (
                              <EditableText
                                multiline
                                className="text-sm"
                                value={kitchenPlan?.dietaryNotes || ""}
                                placeholder="Add dietary notes..."
                                onChange={(v) => kitchenPlanMutation.mutate({ dietaryNotes: v })}
                                data-testid="input-dietary-notes"
                              />
                            ) : (
                              <p className="text-sm">{kitchenPlan?.dietaryNotes}</p>
                            )}
                          </div>
                        )}

                        {kitchenPlan?.serviceSchedule && Array.isArray(kitchenPlan.serviceSchedule) && (kitchenPlan.serviceSchedule as Array<{ time?: string; label?: string; description?: string }>).length > 0 && (
                          <div className="pt-1">
                            <p className="text-xs text-muted-foreground mb-1">Service Schedule:</p>
                            <div className="space-y-0.5">
                              {(kitchenPlan.serviceSchedule as Array<{ time?: string; label?: string; description?: string }>).map((entry, i: number) => (
                                <div key={i} className="text-sm">
                                  {entry.time ? `${entry.time} — ${entry.label || entry.description || ""}` : entry.label || entry.description || JSON.stringify(entry)}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {(kitchenPlan?.kitchenNotes || canEdit) && (
                          <div className="pt-1">
                            <p className="text-xs text-muted-foreground">Kitchen Notes:</p>
                            {canEdit ? (
                              <EditableText
                                multiline
                                className="text-sm"
                                value={kitchenPlan?.kitchenNotes || ""}
                                placeholder="Add kitchen notes..."
                                onChange={(v) => kitchenPlanMutation.mutate({ kitchenNotes: v })}
                                data-testid="input-kitchen-notes"
                              />
                            ) : (
                              <p className="text-sm">{kitchenPlan?.kitchenNotes}</p>
                            )}
                          </div>
                        )}
                        {!canEdit && !kitchenPlan?.foodPackageName && localKidsMenu.length === 0 && localAdultsMenu.length === 0 && !kitchenPlan?.dietaryNotes && !kitchenPlan?.kitchenNotes && (
                          <p className="text-sm text-muted-foreground">No kitchen details available</p>
                        )}
                      </div>
                    )}
                  </div>

                {(() => {
                  const barPlan = (beoData as any).barPlan;
                  const barItems: any[] = barPlan?.items || [];
                  if (!barPlan?.serviceTime && !barItems.length) return null;
                  return (
                    <div
                      className="rounded-lg border border-border/50 bg-card overflow-hidden"
                      style={{ borderLeft: "4px solid #14b8a6" }}
                      data-testid="section-bar-plan"
                    >
                      <div
                        role="button"
                        tabIndex={0}
                        className="w-full flex items-center justify-between p-4 text-left cursor-pointer"
                        onClick={() => setBarExpanded(!barExpanded)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setBarExpanded(!barExpanded); } }}
                        data-testid="button-toggle-bar-plan"
                      >
                        <div className="flex items-center gap-3">
                          <Wine className="h-5 w-5 text-teal-500" />
                          <span className="font-semibold text-base shrink-0">Bar Plan</span>
                          {barPlan?.serviceTime && (
                            <span className="text-sm text-muted-foreground">@ {barPlan.serviceTime}</span>
                          )}
                          <DoneToggle prefix="🍹 Bar:" label="Mark Done" />
                        </div>
                        <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform ${barExpanded ? "rotate-180" : ""}`} />
                      </div>
                      {barExpanded && (
                        <div className="px-4 pb-4 space-y-2" data-testid="content-bar-plan">
                          {barItems.map((item: any, idx: number) => (
                            <div key={item.id || idx} className="space-y-0.5" data-testid={`bar-day-item-${idx}`}>
                              <div className="flex items-center gap-2 text-sm">
                                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border shrink-0 ${item.source === "set_menu" ? "bg-blue-500/15 text-blue-600 border-blue-500/30 dark:text-blue-400" : "bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400"}`}>
                                  {item.source === "set_menu" ? "SET" : "EXTRA"}
                                </span>
                                <span className="font-mono text-muted-foreground shrink-0">{item.quantity || 1}x</span>
                                <span>{item.itemName}</span>
                              </div>
                              {item.notes && <p className="text-xs text-muted-foreground ml-16">{item.notes}</p>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}

                <div
                  className="rounded-lg border border-border/50 bg-card overflow-hidden"
                  style={{ borderLeft: "4px solid #f59e0b" }}
                  data-testid="section-important-notes"
                >
                    <div
                      role="button"
                      tabIndex={0}
                      className="w-full flex items-center justify-between p-4 text-left cursor-pointer"
                      onClick={() => setNotesExpanded(!notesExpanded)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setNotesExpanded(!notesExpanded); } }}
                      data-testid="button-toggle-important-notes"
                    >
                      <div className="flex items-center gap-3">
                        <AlertCircle className="h-5 w-5 text-amber-500" />
                        <span className="font-semibold text-base">Important Notes</span>
                      </div>
                      <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform ${notesExpanded ? "rotate-180" : ""}`} />
                    </div>
                    {notesExpanded && (
                      <div className="px-4 pb-4 space-y-3" data-testid="content-important-notes">
                        {(beoData.allergiesNotes || canEdit) && (
                          <div>
                            <p className="text-xs text-muted-foreground font-medium">Allergies & Dietary</p>
                            {canEdit ? (
                              <EditableText
                                multiline
                                className="text-sm"
                                value={beoData.allergiesNotes || ""}
                                placeholder="Add allergy/dietary notes..."
                                onChange={(v) => eventNotesMutation.mutate({ allergiesNotes: v })}
                                data-testid="input-allergies-notes"
                              />
                            ) : (
                              <p className="text-sm">{beoData.allergiesNotes}</p>
                            )}
                          </div>
                        )}
                        {(beoData.cakeNotes || canEdit) && (
                          <div>
                            <p className="text-xs text-muted-foreground font-medium">Cake Notes</p>
                            {canEdit ? (
                              <EditableText
                                multiline
                                className="text-sm"
                                value={beoData.cakeNotes || ""}
                                placeholder="Add cake notes..."
                                onChange={(v) => eventNotesMutation.mutate({ cakeNotes: v })}
                                data-testid="input-important-cake-notes"
                              />
                            ) : (
                              <p className="text-sm">{beoData.cakeNotes}</p>
                            )}
                          </div>
                        )}
                        {(beoData.specialRequests || canEdit) && (
                          <div>
                            <p className="text-xs text-muted-foreground font-medium">Special Requests</p>
                            {canEdit ? (
                              <EditableText
                                multiline
                                className="text-sm"
                                value={beoData.specialRequests || ""}
                                placeholder="Add special requests..."
                                onChange={(v) => eventNotesMutation.mutate({ specialRequests: v })}
                                data-testid="input-special-requests"
                              />
                            ) : (
                              <p className="text-sm">{beoData.specialRequests}</p>
                            )}
                          </div>
                        )}
                        {(beoData.internalStaffNotes || canEdit) && (
                          <div>
                            <p className="text-xs text-muted-foreground font-medium">Staff Notes</p>
                            {canEdit ? (
                              <EditableText
                                multiline
                                className="text-sm"
                                value={beoData.internalStaffNotes || ""}
                                placeholder="Add internal staff notes..."
                                onChange={(v) => eventNotesMutation.mutate({ internalStaffNotes: v })}
                                data-testid="input-internal-staff-notes"
                              />
                            ) : (
                              <p className="text-sm">{beoData.internalStaffNotes}</p>
                            )}
                          </div>
                        )}
                        {partyDetails?.notes && (
                          <div>
                            <p className="text-xs text-muted-foreground font-medium">Party Notes</p>
                            <p className="text-sm">{partyDetails.notes}</p>
                          </div>
                        )}
                        {setupPlan?.setupNotes && (
                          <div>
                            <p className="text-xs text-muted-foreground font-medium">Setup Notes</p>
                            <p className="text-sm">{setupPlan.setupNotes}</p>
                          </div>
                        )}
                        {kitchenPlan?.dietaryNotes && (
                          <div>
                            <p className="text-xs text-muted-foreground font-medium">Dietary Notes</p>
                            <p className="text-sm">{kitchenPlan.dietaryNotes}</p>
                          </div>
                        )}
                        {kitchenPlan?.kitchenNotes && (
                          <div>
                            <p className="text-xs text-muted-foreground font-medium">Kitchen Notes</p>
                            <p className="text-sm">{kitchenPlan.kitchenNotes}</p>
                          </div>
                        )}
                        {!canEdit && !beoData.allergiesNotes && !beoData.cakeNotes && !beoData.specialRequests && !beoData.internalStaffNotes && !partyDetails?.notes && !setupPlan?.setupNotes && !kitchenPlan?.dietaryNotes && !kitchenPlan?.kitchenNotes && (
                          <p className="text-sm text-muted-foreground">No notes available</p>
                        )}
                      </div>
                    )}
                  </div>

              </div>
            );
          })()}
        </div>
      </div>

      {onClose && (
        <div className="sticky bottom-0 border-t bg-background p-4">
          <Button variant="outline" onClick={onClose} className="w-full" data-testid="button-close-day-of">
            Close
          </Button>
        </div>
      )}

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
              <p className="text-xs text-muted-foreground">Share this link with the parent/guest so they can choose their set menu options.</p>
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
