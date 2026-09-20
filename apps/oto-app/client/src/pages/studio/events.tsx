import { useState, useEffect, useMemo, type ReactNode } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { StudioLayout } from "@/components/layout/studio-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DndContext, DragEndEvent, DragOverlay, DragStartEvent, closestCenter, PointerSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, horizontalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Plus, CalendarDays, Pencil, Trash2, Search, X, ClipboardList, Camera, MessageCircle, Loader2, Sparkles, Check, List, Columns, Calendar, ChevronLeft, ChevronRight, ChevronDown, ChevronsLeftRight, ChevronsRightLeft, Settings, DollarSign, Cake, Users, UserRound, Clock, ExternalLink, CircleCheck, CircleAlert, Package, Music, Archive, ArchiveRestore, Activity, GripVertical, MapPin, PartyPopper, Palette, ArrowRight, Banknote, Baby } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { startOfMonth, endOfMonth, startOfWeek, endOfWeek, eachDayOfInterval, isSameMonth, isSameDay, addMonths, subMonths, differenceInDays, addDays } from "date-fns";
import { useAuth } from "@/lib/auth";
import { EVENT_TYPE_LABELS, EVENT_TYPE_LABELS_SHORT, ONE_OFF_EVENT_COLOR_OPTIONS, DEFAULT_ONE_OFF_EVENT_COLOR, OTHER_EVENT_LEGEND_COLORS, getEventCalendarColor } from "@/lib/event-types";
import { useLocation, useRoute } from "wouter";
import { useBranchContext } from "@/hooks/use-branch-context";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { format, parseISO } from "date-fns";
import type { Event, InsertEvent, Department, Branch, EventStatus, BeoLocation } from "@shared/schema";
import { AIEventAssistant } from "@/components/ai-event-assistant";
import { BeoEventEditor, BeoTimelineEditor, BeoDayOfView } from "@/components/beo";
import { getCountries, getCountryCallingCode } from "libphonenumber-js";

// Color options for status columns
const STATUS_COLORS = [
  { value: "blue", label: "Blue", class: "bg-blue-500" },
  { value: "yellow", label: "Yellow", class: "bg-yellow-500" },
  { value: "green", label: "Green", class: "bg-green-500" },
  { value: "red", label: "Red", class: "bg-red-500" },
  { value: "purple", label: "Purple", class: "bg-purple-500" },
  { value: "pink", label: "Pink", class: "bg-pink-500" },
  { value: "orange", label: "Orange", class: "bg-orange-500" },
  { value: "gray", label: "Gray", class: "bg-gray-500" },
];

const getStatusColorClass = (color: string) => {
  return STATUS_COLORS.find(c => c.value === color)?.class || "bg-gray-500";
};

// Popular countries that appear at the top of the list
const POPULAR_COUNTRIES = ["+66", "+1", "+44", "+65", "+86", "+81", "+82", "+61", "+33", "+49", "+7"];
const POPULAR_COUNTRY_CODES = new Set(["TH", "US", "GB", "SG", "CN", "JP", "KR", "AU", "FR", "DE", "RU"]);

// Get all countries with their calling codes, sorted alphabetically
const getAllCountries = () => {
  const displayNames = new Intl.DisplayNames(["en"], { type: "region" });
  return getCountries()
    .filter(code => !POPULAR_COUNTRY_CODES.has(code))
    .map(code => ({
      code,
      name: displayNames.of(code) || code,
      callingCode: getCountryCallingCode(code),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

const allCountries = getAllCountries();

interface PendingTask {
  id: string;
  title: string;
  description?: string;
  dueTime: string;
  departmentId?: string;
  departmentName?: string;
  requiresPhotoEvidence: boolean;
  requiresQuestionsAnswered: boolean;
  isExisting?: boolean; // true if this task already exists on the server
}

type EventFormData = Omit<InsertEvent, "id" | "branchId" | "tenantId" | "createdByUserId" | "updatedByUserId" | "updatedAt" | "whatsappPhoneE164" | "whatsappParseValid" | "whatsappParseError"> & {
  whatsappCountryCode?: string;
};

const defaultFormData: EventFormData = {
  eventType: "birthday",
  title: "",
  eventDate: format(new Date(), "yyyy-MM-dd"),
  startTime: "14:00",
  endTime: "",
  childName: "",
  bookingName: "",
  parentName: "",
  whatsappPhoneRaw: "",
  whatsappCountryCode: "+66",
  numChildren: 10,
  numAdults: 5,
  programName: "",
  allergiesNotes: "",
  cakeNotes: "",
  specialRequests: "",
  totalValue: null,
  prepaymentAmount: null,
  prepaymentDate: null,
  prepaymentMethod: null,
  status: "upcoming",
};

type ViewMode = "list" | "kanban" | "calendar";

// Fallback statuses for loading state only (actual defaults come from backend)
const FALLBACK_STATUSES = [
  { id: "fallback-upcoming", name: "Upcoming", value: "upcoming", color: "blue", sortOrder: 0, isDefault: true },
  { id: "fallback-in_progress", name: "In Progress", value: "in_progress", color: "yellow", sortOrder: 1, isDefault: true },
  { id: "fallback-completed", name: "Completed", value: "completed", color: "green", sortOrder: 2, isDefault: true },
  { id: "fallback-cancelled", name: "Cancelled", value: "cancelled", color: "gray", sortOrder: 3, isDefault: true },
];

const DroppableColumnStatic = ({ id, children }: { id: string; children: ReactNode }) => {
  const { isOver, setNodeRef } = useDroppable({ id });
  return (
    <div 
      ref={setNodeRef} 
      className={`space-y-2 flex-1 min-h-[100px] rounded-lg transition-all duration-150 ${isOver ? "ring-2 ring-primary ring-offset-2 ring-offset-background bg-accent/20" : ""}`}
    >
      {children}
    </div>
  );
};

const SortableColumnWrapper = ({ id, children }: { id: string; children: (dragHandleProps: { listeners: any; attributes: any }) => ReactNode }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `col-${id}`,
    data: { type: "column", statusId: id },
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div ref={setNodeRef} style={style}>
      {children({ listeners, attributes })}
    </div>
  );
};

export default function StudioEventsPage({ Layout }: { Layout?: ({ children }: { children: ReactNode }) => JSX.Element }) {
  const LayoutWrapper = Layout || StudioLayout;
  const { user } = useAuth();
  const { toast } = useToast();
  const { activeBranchId, setActiveBranchId } = useBranchContext();
  const [, navigate] = useLocation();
  const [isCalendarWithMonth, calendarParams] = useRoute("/studio/events/calendar/:month");
  const [isCalendar] = useRoute("/studio/events/calendar");
  const [isList] = useRoute("/studio/events/list");
  const viewMode: ViewMode = isList ? "list" : (isCalendar || isCalendarWithMonth) ? "calendar" : "kanban";

  // Derive calendar month from URL path segment, defaulting to current month
  const calendarMonth = (() => {
    const m = calendarParams?.month;
    if (m && /^\d{4}-\d{2}$/.test(m)) {
      const [year, month] = m.split("-").map(Number);
      return new Date(year, month - 1, 1);
    }
    return new Date();
  })();

  const setCalendarMonth = (d: Date) => {
    navigate(`/studio/events/calendar/${format(d, "yyyy-MM")}`);
  };

  const [searchQuery, setSearchQuery] = useState("");
  const [eventTypeFilter, setEventTypeFilter] = useState<string>("all");
  const [branchFilter, setBranchFilter] = useState<string>(activeBranchId || "all"); // "all" or specific branchId
  const [showTypeSelector, setShowTypeSelector] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showOneOffWizard, setShowOneOffWizard] = useState(false);
  const [oneOffEventType, setOneOffEventType] = useState<"studio_event" | "workshop">("studio_event");
  const [editingEvent, setEditingEvent] = useState<Event | null>(null);
  const [deleteEventId, setDeleteEventId] = useState<string | null>(null);
  const [formData, setFormData] = useState<EventFormData>(defaultFormData);
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(activeBranchId);
  
  // Task creation state
  const [pendingTasks, setPendingTasks] = useState<PendingTask[]>([]);
  const [tasksToDelete, setTasksToDelete] = useState<string[]>([]); // IDs of existing tasks to delete
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [taskDueTime, setTaskDueTime] = useState("10:00");
  const [taskDepartmentId, setTaskDepartmentId] = useState("");
  const [taskRequiresPhoto, setTaskRequiresPhoto] = useState(false);
  const [taskRequiresQuestions, setTaskRequiresQuestions] = useState(false);
  
  // AI Event Assistant state
  const [showAIAssistant, setShowAIAssistant] = useState(false);
  
  // Settings and status management state
  const [showSettingsSheet, setShowSettingsSheet] = useState(false);
  const [showAddStatusDialog, setShowAddStatusDialog] = useState(false);
  const [editingStatus, setEditingStatus] = useState<{ id: string; name: string; color: string } | null>(null);
  const [collapsedColumns, setCollapsedColumns] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('events-collapsed-columns');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });
  const [newStatusName, setNewStatusName] = useState("");
  const [newStatusColor, setNewStatusColor] = useState("blue");
  const isMobile = useIsMobile();
  const [selectedMobileStatusValue, setSelectedMobileStatusValue] = useState<string>("");
  const [optimisticEventStatuses, setOptimisticEventStatuses] = useState<Record<string, string>>({});
  const [activeEventId, setActiveEventId] = useState<string | null>(null);
  const [activeColumnId, setActiveColumnId] = useState<string | null>(null);
  
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 3 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } })
  );
  
  // Persist collapsed columns to localStorage
  useEffect(() => {
    localStorage.setItem('events-collapsed-columns', JSON.stringify([...collapsedColumns]));
  }, [collapsedColumns]);

  // Sync branch filter with global branch context
  useEffect(() => {
    setBranchFilter(activeBranchId || "all");
  }, [activeBranchId]);
  
  // One-off event form state (simple form, no wizard)
  const [oneOffFormData, setOneOffFormData] = useState({
    title: "",
    eventDate: format(new Date(), "yyyy-MM-dd"),
    startTime: "14:00",
    endTime: "",
    description: "",
    location: "",
    maxParticipants: null as number | null,
    branchId: activeBranchId as string | null,
    color: DEFAULT_ONE_OFF_EVENT_COLOR as string,
  });
  // Custom info fields (e.g., F&B info, special requirements)
  const [oneOffInfoFields, setOneOffInfoFields] = useState<Array<{
    id: string;
    title: string;
    description: string;
  }>>([]);
  const [showInfoFieldForm, setShowInfoFieldForm] = useState(false);
  const [infoFieldTitle, setInfoFieldTitle] = useState("");
  const [infoFieldDescription, setInfoFieldDescription] = useState("");
  // Tasks with full birthday-style fields
  const [oneOffTasks, setOneOffTasks] = useState<Array<{
    id?: string;
    title: string;
    description?: string;
    dueTime: string;
    departmentId?: string;
    departmentName?: string;
    requiresPhotoEvidence: boolean;
    requiresQuestionsAnswered: boolean;
  }>>([]);
  const [showOneOffTaskForm, setShowOneOffTaskForm] = useState(false);
  const [oneOffTaskTitle, setOneOffTaskTitle] = useState("");
  const [oneOffTaskDescription, setOneOffTaskDescription] = useState("");
  const [oneOffTaskDueTime, setOneOffTaskDueTime] = useState("10:00");
  const [oneOffTaskDepartmentId, setOneOffTaskDepartmentId] = useState("");
  const [oneOffTaskRequiresPhoto, setOneOffTaskRequiresPhoto] = useState(false);
  const [oneOffTaskRequiresQuestions, setOneOffTaskRequiresQuestions] = useState(false);
  const [editingOneOffEvent, setEditingOneOffEvent] = useState<Event | null>(null);
  const [originalOneOffTaskIds, setOriginalOneOffTaskIds] = useState<string[]>([]);
  const [savingOneOffEvent, setSavingOneOffEvent] = useState(false);
  // Bookings are added after event creation, not during
  const [oneOffBookings, setOneOffBookings] = useState<Array<{
    id?: string;
    name: string;
    phone: string;
    email: string;
    groupSize: number;
    notes: string;
    arrived: boolean;
  }>>([]);

  // Camp event form state
  const [showCampSheet, setShowCampSheet] = useState(false);
  const [editingCampEvent, setEditingCampEvent] = useState<Event | null>(null);
  const [showCampStartCal, setShowCampStartCal] = useState(false);
  const [showCampEndCal, setShowCampEndCal] = useState(false);
  const [campQuickView, setCampQuickView] = useState<Event | null>(null);

  const { data: campQuickViewRegs = [] } = useQuery<any[]>({
    queryKey: [`/api/admin/events/${campQuickView?.id}/registrations`],
    queryFn: async () => {
      const res = await fetch(`/api/admin/events/${campQuickView!.id}/registrations`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!campQuickView?.id,
  });

  const { data: allEmployees = [] } = useQuery<any[]>({
    queryKey: ["/api/employees"],
    queryFn: async () => {
      const res = await fetch("/api/employees", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const [campFormData, setCampFormData] = useState({
    title: "",
    eventDate: format(new Date(), "yyyy-MM-dd"),
    campEndDate: format(new Date(), "yyyy-MM-dd"),
    startTime: "10:00",
    endTime: "15:00",
    programName: "",
    specialRequests: "",
    numChildren: null as number | null,
    branchId: activeBranchId as string | null,
    campDayHosts: {} as Record<string, string>,
  });
  
  // Viewing/managing studio event state
  const [viewingStudioEvent, setViewingStudioEvent] = useState<Event | null>(null);
  const [studioEventDetails, setStudioEventDetails] = useState<any>(null);
  const [studioEventTasks, setStudioEventTasks] = useState<any[]>([]);
  const [studioEventBookings, setStudioEventBookings] = useState<any[]>([]);
  const [loadingStudioData, setLoadingStudioData] = useState(false);
  
  // Booking form state
  const [showBookingSheet, setShowBookingSheet] = useState(false);
  const [editingBooking, setEditingBooking] = useState<any>(null);
  const [bookingFormData, setBookingFormData] = useState({
    bookingName: "",
    adultNames: "",
    kidNames: "",
    adultsCount: 1,
    kidsCount: 0,
    amountTotal: 0,
    amountPaid: 0,
    paymentMethod: "",
    paymentDate: "",
    posReference: "",
    sourceChannel: "",
    whatsappPhone: "",
    internalNotes: "",
  });
  const [savingBooking, setSavingBooking] = useState(false);
  
  // BEO Editor state
  const [showBeoEditor, setShowBeoEditor] = useState(false);
  const [showBeoDayOf, setShowBeoDayOf] = useState(false);
  
  // Calendar event preview state
  const [previewEvent, setPreviewEvent] = useState<Event | null>(null);

  // When branchFilter is "all", don't filter by branch to fetch all events
  // Otherwise, use the selected branchFilter value
  const queryBranchId = branchFilter === "all" ? null : branchFilter;
  const branchParam = queryBranchId ? `&branchId=${queryBranchId}` : "";

  const [showArchived, setShowArchived] = useState(false);

  const { data: events, isLoading } = useQuery<Event[]>({
    queryKey: ["/api/admin/events", { range: "all", branchId: queryBranchId, includeArchived: showArchived }],
    queryFn: async () => {
      const archiveParam = showArchived ? "&includeArchived=true" : "";
      const res = await fetch(`/api/admin/events?range=all${branchParam}${archiveParam}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch events");
      return res.json();
    },
    enabled: !!user,
  });

  const { data: departments } = useQuery<Department[]>({
    queryKey: ["/api/departments"],
    enabled: !!user,
  });

  const { data: branches } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
    enabled: !!user,
  });

  // Fetch dynamic event statuses
  const { data: eventStatuses } = useQuery<Array<{ id: string; name: string; value: string; color: string; sortOrder: number; isDefault: boolean }>>({
    queryKey: ["/api/admin/event-statuses"],
    enabled: !!user,
  });

  const { data: beoLocations = [] } = useQuery<BeoLocation[]>({
    queryKey: ["/api/beo/locations"],
    enabled: !!user,
  });

  const locationsById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const loc of beoLocations) {
      map[loc.id] = loc.name;
    }
    return map;
  }, [beoLocations]);

  // Use fetched statuses or fallback (backend will return defaults if none exist)
  const statuses = eventStatuses && eventStatuses.length > 0 ? eventStatuses : FALLBACK_STATUSES;

  const eventActivityParams = new URLSearchParams();
  if (queryBranchId) eventActivityParams.append("branchId", queryBranchId);
  eventActivityParams.append("limit", "30");

  const { data: recentEventActivities = [] } = useQuery<{
    id: string;
    title: string | null;
    eventType: string | null;
    eventDate: string | null;
    status: string | null;
    branchId: string | null;
    description: string;
    userName: string | null;
    employeeNickname: string | null;
    updatedAt: string;
  }[]>({
    queryKey: ["/api/events/activities", { branchId: queryBranchId }],
    queryFn: async () => {
      const res = await fetch(`/api/events/activities/recent?${eventActivityParams.toString()}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!user,
  });

  const formatActivityDate = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHrs = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHrs < 24) return `${diffHrs}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  };

  const createMutation = useMutation({
    mutationFn: async (data: { eventData: EventFormData; tasks: PendingTask[]; branchId?: string | null }) => {
      // First create the event with branchId - use provided branchId or fall back to activeBranchId
      const eventPayload = { ...data.eventData, branchId: data.branchId || activeBranchId };
      const res = await apiRequest("POST", "/api/admin/events", eventPayload);
      const createdEvent = await res.json();
      
      // Then create all the tasks linked to this event
      for (const task of data.tasks) {
        await apiRequest("POST", `/api/events/${createdEvent.id}/tasks`, {
          title: task.title,
          description: task.description,
          dueDate: data.eventData.eventDate,
          dueTime: task.dueTime,
          departmentId: task.departmentId || undefined,
          requiresPhotoEvidence: task.requiresPhotoEvidence,
          requiresQuestionsAnswered: task.requiresQuestionsAnswered,
        });
      }
      
      return createdEvent;
    },
    onSuccess: (createdEvent) => {
      queryClient.invalidateQueries({ predicate: (query) => 
        Array.isArray(query.queryKey) && (query.queryKey[0] === "/api/admin/events" || query.queryKey[0] === "/api/events")
      });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks/today"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks/grouped"] });
      if (createdEvent.branchId && activeBranchId) setActiveBranchId(createdEvent.branchId);
      setShowCreateDialog(false);
      setFormData(defaultFormData);
      setPendingTasks([]);
      setSelectedBranchId(activeBranchId);
      resetTaskForm();
      toast({ title: "Event created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create event", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data, newTasks, deletedTaskIds }: { 
      id: string; 
      data: Partial<EventFormData> & { branchId?: string | null }; 
      newTasks: PendingTask[];
      deletedTaskIds: string[];
    }) => {
      // Update the event
      const res = await apiRequest("PATCH", `/api/admin/events/${id}`, data);
      const updatedEvent = await res.json();
      
      // Delete removed existing tasks
      for (const taskId of deletedTaskIds) {
        await apiRequest("DELETE", `/api/tasks/${taskId}`);
      }
      
      // Create new tasks
      for (const task of newTasks) {
        await apiRequest("POST", `/api/events/${id}/tasks`, {
          title: task.title,
          description: task.description,
          dueDate: data.eventDate || updatedEvent.eventDate,
          dueTime: task.dueTime,
          departmentId: task.departmentId || undefined,
          requiresPhotoEvidence: task.requiresPhotoEvidence,
          requiresQuestionsAnswered: task.requiresQuestionsAnswered,
        });
      }
      
      return updatedEvent;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: (query) => 
        Array.isArray(query.queryKey) && (query.queryKey[0] === "/api/admin/events" || query.queryKey[0] === "/api/events")
      });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks/today"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks/grouped"] });
      setEditingEvent(null);
      setFormData(defaultFormData);
      setPendingTasks([]);
      setTasksToDelete([]);
      toast({ title: "Event updated successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update event", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/admin/events/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: (query) => 
        Array.isArray(query.queryKey) && (query.queryKey[0] === "/api/admin/events" || query.queryKey[0] === "/api/events")
      });
      setDeleteEventId(null);
      toast({ title: "Event cancelled successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to cancel event", description: error.message, variant: "destructive" });
    },
  });

  const filteredEvents = events?.filter(event => {
    // Camp events are calendar-only — hide from list and kanban
    if ((viewMode === "list" || viewMode === "kanban") && event.eventType === "camp") {
      return false;
    }
    // Filter by event type
    if (eventTypeFilter !== "all" && event.eventType !== eventTypeFilter) {
      return false;
    }
    // Filter by branch
    if (branchFilter !== "all" && event.branchId !== branchFilter) {
      return false;
    }
    // Filter by search query
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      event.title.toLowerCase().includes(query) ||
      event.childName?.toLowerCase().includes(query) ||
      event.parentName?.toLowerCase().includes(query)
    );
  }) || [];
  
  // Helper to get branch name
  const getBranchName = (branchId: string) => {
    return branches?.find(b => b.id === branchId)?.name || "Unknown";
  };

  const getCalendarColor = (event: Event) => {
    const branch = branches?.find((candidate) => candidate.id === event.branchId);
    return getEventCalendarColor({
      eventType: event.eventType,
      color: event.color,
      branchCalendarColor: branch?.calendarColor,
      branchId: branch?.id || event.branchId,
      branchName: branch?.name,
    });
  };
  
  // Check if showing multiple branches
  const showingMultipleBranches = branchFilter === "all";

  // Update event status mutation for kanban view (must be before early return)
  const updateStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const res = await apiRequest("PATCH", `/api/admin/events/${id}`, { status });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: (query) => 
        Array.isArray(query.queryKey) && (query.queryKey[0] === "/api/admin/events" || query.queryKey[0] === "/api/events")
      });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update status", description: error.message, variant: "destructive" });
    },
  });

  const reorderStatusMutation = useMutation({
    mutationFn: async (orderedIds: string[]) => {
      const res = await apiRequest("POST", "/api/admin/event-statuses/reorder", { orderedIds });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/event-statuses"] });
    },
  });

  // Archive/unarchive event mutation
  const archiveMutation = useMutation({
    mutationFn: async ({ id, archived }: { id: string; archived: boolean }) => {
      const res = await apiRequest("POST", `/api/admin/events/${id}/archive`, { archived });
      return res.json();
    },
    onSuccess: (_, { archived }) => {
      queryClient.invalidateQueries({ predicate: (query) => 
        Array.isArray(query.queryKey) && (query.queryKey[0] === "/api/admin/events" || query.queryKey[0] === "/api/events")
      });
      toast({ title: archived ? "Event archived" : "Event restored", description: archived ? "Event has been moved to the archive" : "Event has been restored to the board" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to archive event", description: error.message, variant: "destructive" });
    },
  });

  // Create new event status (Kanban column)
  const createStatusMutation = useMutation({
    mutationFn: async (data: { name: string; color: string }) => {
      const res = await apiRequest("POST", "/api/admin/event-statuses", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/event-statuses"] });
      setShowAddStatusDialog(false);
      setNewStatusName("");
      setNewStatusColor("blue");
      toast({ title: "Status created", description: "New column added to Kanban board" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create status", description: error.message, variant: "destructive" });
    },
  });

  // Update event status (Kanban column)
  const updateStatusConfigMutation = useMutation({
    mutationFn: async ({ id, name, color }: { id: string; name: string; color: string }) => {
      const res = await apiRequest("PATCH", `/api/admin/event-statuses/${id}`, { name, color });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/event-statuses"] });
      setEditingStatus(null);
      toast({ title: "Status updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update status", description: error.message, variant: "destructive" });
    },
  });

  // Delete event status (Kanban column)
  const deleteStatusMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/admin/event-statuses/${id}`);
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/event-statuses"] });
      toast({ title: "Status deleted", description: "Column removed from Kanban board" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete status", description: error.message, variant: "destructive" });
    },
  });

  const openEditDialog = async (event: Event) => {
    // Parse country code from stored phone number using regex for more robust matching
    let countryCode = "+66";
    let phoneNumber = event.whatsappPhoneRaw || "";
    if (phoneNumber) {
      // Normalize by stripping spaces and dashes
      phoneNumber = phoneNumber.replace(/[\s\-()]/g, "");
      
      // Try to match a country code prefix (+1 to +999)
      const codeMatch = phoneNumber.match(/^(\+\d{1,4})/);
      if (codeMatch) {
        // Check common codes first for better UI mapping
        const commonCodes = ["+66", "+1", "+44", "+65", "+86", "+81", "+82", "+61", "+33", "+49", "+7"];
        const matchedCode = commonCodes.find(code => phoneNumber.startsWith(code));
        if (matchedCode) {
          countryCode = matchedCode;
          phoneNumber = phoneNumber.substring(matchedCode.length);
        } else {
          // Use detected code even if not in our list, fallback to +66 in UI
          countryCode = codeMatch[1];
          phoneNumber = phoneNumber.substring(codeMatch[1].length);
        }
      }
      // If no + prefix, assume it's just the national number, keep default +66
    }
    
    setFormData({
      eventType: event.eventType,
      title: event.title,
      eventDate: event.eventDate,
      startTime: event.startTime,
      endTime: event.endTime || "",
      childName: event.childName || "",
      bookingName: event.bookingName || "",
      parentName: event.parentName || "",
      whatsappPhoneRaw: phoneNumber,
      whatsappCountryCode: countryCode,
      numChildren: event.numChildren || 0,
      numAdults: event.numAdults || 0,
      programName: event.programName || "",
      allergiesNotes: event.allergiesNotes || "",
      cakeNotes: event.cakeNotes || "",
      specialRequests: event.specialRequests || "",
      totalValue: event.totalValue || null,
      prepaymentAmount: event.prepaymentAmount || null,
      prepaymentDate: event.prepaymentDate || null,
      prepaymentMethod: event.prepaymentMethod || null,
      status: event.status,
    });
    setSelectedBranchId(event.branchId);
    setEditingEvent(event);
    setPendingTasks([]);
    setTasksToDelete([]);
    resetTaskForm();
    
    // Fetch existing tasks for this event
    setLoadingTasks(true);
    try {
      const res = await fetch(`/api/events/${event.id}/tasks`, { credentials: "include" });
      if (res.ok) {
        const existingTasks = await res.json();
        const mappedTasks: PendingTask[] = existingTasks.map((t: any) => ({
          id: t.id,
          title: t.title,
          description: t.description || undefined,
          dueTime: t.dueTime || "10:00",
          departmentId: t.departmentId || undefined,
          departmentName: departments?.find(d => d.id === t.departmentId)?.name,
          requiresPhotoEvidence: t.requiresPhotoEvidence || false,
          requiresQuestionsAnswered: t.requiresQuestionsAnswered || false,
          isExisting: true,
        }));
        setPendingTasks(mappedTasks);
      }
    } catch (error) {
      console.error("Failed to fetch tasks:", error);
    } finally {
      setLoadingTasks(false);
    }
  };

  const resetTaskForm = () => {
    setTaskTitle("");
    setTaskDescription("");
    setTaskDueTime("10:00");
    setTaskDepartmentId("");
    setTaskRequiresPhoto(false);
    setTaskRequiresQuestions(false);
    setShowTaskForm(false);
  };

  // Open BEO editor directly for birthday/private events
  const openBeoEditor = (event: Event) => {
    setViewingStudioEvent(event);
    setShowBeoEditor(true);
  };

  const openStudioEventView = async (event: Event) => {
    setViewingStudioEvent(event);
    setLoadingStudioData(true);
    
    try {
      // Fetch studio event details, tasks, and bookings in parallel
      const [detailsRes, tasksRes, bookingsRes] = await Promise.all([
        fetch(`/api/events/${event.id}/studio-details`, { credentials: "include" }),
        fetch(`/api/events/${event.id}/studio-tasks`, { credentials: "include" }),
        fetch(`/api/events/${event.id}/bookings`, { credentials: "include" }),
      ]);
      
      if (detailsRes.ok) {
        const details = await detailsRes.json();
        setStudioEventDetails(details);
      }
      if (tasksRes.ok) {
        const tasks = await tasksRes.json();
        setStudioEventTasks(tasks);
      }
      if (bookingsRes.ok) {
        const bookings = await bookingsRes.json();
        setStudioEventBookings(bookings);
      }
    } catch (error) {
      console.error("Failed to fetch studio event data:", error);
      toast({ title: "Failed to load event details", variant: "destructive" });
    } finally {
      setLoadingStudioData(false);
    }
  };

  const toggleBookingArrival = async (bookingId: string, currentArrived: boolean) => {
    try {
      const res = await apiRequest("PATCH", `/api/bookings/${bookingId}`, {
        arrived: !currentArrived,
      });
      if (res.ok) {
        const updated = await res.json();
        setStudioEventBookings(prev => prev.map(b => b.id === bookingId ? updated : b));
        toast({ title: currentArrived ? "Check-in removed" : "Checked in" });
      }
    } catch (error) {
      toast({ title: "Failed to update check-in", variant: "destructive" });
    }
  };

  // Booking form helpers
  const openAddBooking = () => {
    setEditingBooking(null);
    setBookingFormData({
      bookingName: "",
      adultNames: "",
      kidNames: "",
      adultsCount: 1,
      kidsCount: 0,
      amountTotal: 0,
      amountPaid: 0,
      paymentMethod: "",
      paymentDate: "",
      posReference: "",
      sourceChannel: "",
      whatsappPhone: "",
      internalNotes: "",
    });
    setShowBookingSheet(true);
  };

  const openEditBooking = (booking: any) => {
    setEditingBooking(booking);
    setBookingFormData({
      bookingName: booking.bookingName || "",
      adultNames: booking.adultNames || "",
      kidNames: booking.kidNames || "",
      adultsCount: booking.adultsCount || 1,
      kidsCount: booking.kidsCount || 0,
      amountTotal: booking.amountTotal || 0,
      amountPaid: booking.amountPaid || 0,
      paymentMethod: booking.paymentMethod || "",
      paymentDate: booking.paymentDate || "",
      posReference: booking.posReference || "",
      sourceChannel: booking.sourceChannel || "",
      whatsappPhone: booking.whatsappPhone || "",
      internalNotes: booking.internalNotes || "",
    });
    setShowBookingSheet(true);
  };

  const saveBooking = async () => {
    if (!viewingStudioEvent || !bookingFormData.bookingName.trim()) return;
    
    setSavingBooking(true);
    try {
      if (editingBooking) {
        // Update existing booking
        const res = await apiRequest("PATCH", `/api/bookings/${editingBooking.id}`, bookingFormData);
        if (res.ok) {
          const updated = await res.json();
          setStudioEventBookings(prev => prev.map(b => b.id === editingBooking.id ? updated : b));
          toast({ title: "Booking updated" });
        }
      } else {
        // Create new booking
        const res = await apiRequest("POST", `/api/events/${viewingStudioEvent.id}/bookings`, {
          ...bookingFormData,
          displayOrder: studioEventBookings.length,
        });
        if (res.ok) {
          const newBooking = await res.json();
          setStudioEventBookings(prev => [...prev, newBooking]);
          toast({ title: "Booking added" });
        }
      }
      setShowBookingSheet(false);
    } catch (error) {
      toast({ title: "Failed to save booking", variant: "destructive" });
    } finally {
      setSavingBooking(false);
    }
  };

  const deleteBooking = async (bookingId: string) => {
    try {
      await apiRequest("DELETE", `/api/bookings/${bookingId}`);
      setStudioEventBookings(prev => prev.filter(b => b.id !== bookingId));
      toast({ title: "Booking deleted" });
    } catch (error) {
      toast({ title: "Failed to delete booking", variant: "destructive" });
    }
  };

  // Calculate booking stats
  const bookingStats = {
    totalBookings: studioEventBookings.length,
    totalAdults: studioEventBookings.reduce((sum, b) => sum + (b.adultsCount || 0), 0),
    totalKids: studioEventBookings.reduce((sum, b) => sum + (b.kidsCount || 0), 0),
    totalCost: studioEventBookings.reduce((sum, b) => sum + (b.amountTotal || 0), 0),
    totalPaid: studioEventBookings.reduce((sum, b) => sum + (b.amountPaid || 0), 0),
    arrived: studioEventBookings.filter(b => b.arrived).length,
  };
  const totalOutstanding = bookingStats.totalCost - bookingStats.totalPaid;

  // One-off event helper functions
  const resetOneOffForm = (eventType: "studio_event" | "workshop" = "studio_event") => {
    setOneOffEventType(eventType);
    setOneOffFormData({
      title: "",
      eventDate: format(new Date(), "yyyy-MM-dd"),
      startTime: "14:00",
      endTime: "",
      description: "",
      location: "",
      maxParticipants: null,
      branchId: activeBranchId,
      color: DEFAULT_ONE_OFF_EVENT_COLOR,
    });
    setOneOffInfoFields([]);
    setOneOffTasks([]);
    setShowInfoFieldForm(false);
    setShowOneOffTaskForm(false);
    resetOneOffTaskForm();
    resetInfoFieldForm();
    setEditingOneOffEvent(null);
    setOriginalOneOffTaskIds([]);
  };

  // Open the one-off event edit form, reusing whatever details/tasks are
  // already loaded for the quick-view dialog (studioEventDetails/studioEventTasks)
  const openOneOffEditor = (event: Event) => {
    setOneOffEventType(event.eventType === "workshop" ? "workshop" : "studio_event");
    setOneOffFormData({
      title: event.title,
      eventDate: event.eventDate,
      startTime: event.startTime,
      endTime: event.endTime || "",
      description: studioEventDetails?.description || "",
      location: studioEventDetails?.location || "",
      maxParticipants: studioEventDetails?.maxParticipants ?? null,
      branchId: event.branchId,
      color: (event as any).color || DEFAULT_ONE_OFF_EVENT_COLOR,
    });
    setOneOffInfoFields(
      Array.isArray(studioEventDetails?.customInfo) ? studioEventDetails.customInfo : []
    );
    const tasks = studioEventTasks.map((t: any) => ({
      id: t.id,
      title: t.title,
      description: t.description || "",
      dueTime: t.dueTime,
      departmentId: t.departmentId || "",
      departmentName: t.departmentName,
      requiresPhotoEvidence: !!t.requiresPhotoEvidence,
      requiresQuestionsAnswered: !!t.requiresQuestionsAnswered,
    }));
    setOneOffTasks(tasks);
    setOriginalOneOffTaskIds(tasks.map((t) => t.id).filter(Boolean) as string[]);
    setShowInfoFieldForm(false);
    setShowOneOffTaskForm(false);
    resetOneOffTaskForm();
    resetInfoFieldForm();
    setEditingOneOffEvent(event);
    setShowOneOffWizard(true);
  };

  const resetCampForm = () => {
    setCampFormData({
      title: "",
      eventDate: format(new Date(), "yyyy-MM-dd"),
      campEndDate: format(new Date(), "yyyy-MM-dd"),
      startTime: "10:00",
      endTime: "15:00",
      programName: "",
      specialRequests: "",
      numChildren: null,
      branchId: activeBranchId,
      campDayHosts: {},
    });
    setEditingCampEvent(null);
  };

  const openCampEditor = (event: Event) => {
    setCampFormData({
      title: event.title,
      eventDate: event.eventDate,
      campEndDate: (event as any).campEndDate || event.eventDate,
      startTime: event.startTime,
      endTime: event.endTime || "17:00",
      campDayHosts: (event as any).campDayHosts || {},
      programName: event.programName || "",
      specialRequests: event.specialRequests || "",
      numChildren: event.numChildren || null,
      branchId: event.branchId,
    });
    setEditingCampEvent(event);
    setShowCampSheet(true);
  };

  const resetInfoFieldForm = () => {
    setInfoFieldTitle("");
    setInfoFieldDescription("");
    setShowInfoFieldForm(false);
  };

  const addInfoField = () => {
    if (!infoFieldTitle.trim()) return;
    setOneOffInfoFields(prev => [...prev, {
      id: crypto.randomUUID(),
      title: infoFieldTitle.trim(),
      description: infoFieldDescription.trim(),
    }]);
    resetInfoFieldForm();
  };

  const resetOneOffTaskForm = () => {
    setOneOffTaskTitle("");
    setOneOffTaskDescription("");
    setOneOffTaskDueTime("10:00");
    setOneOffTaskDepartmentId("");
    setOneOffTaskRequiresPhoto(false);
    setOneOffTaskRequiresQuestions(false);
    setShowOneOffTaskForm(false);
  };

  const addOneOffTask = () => {
    if (!oneOffTaskTitle.trim()) return;
    const effectiveDeptId = oneOffTaskDepartmentId && oneOffTaskDepartmentId !== "none" ? oneOffTaskDepartmentId : undefined;
    const dept = effectiveDeptId ? departments?.find(d => d.id === effectiveDeptId) : undefined;
    setOneOffTasks(prev => [...prev, {
      id: crypto.randomUUID(),
      title: oneOffTaskTitle.trim(),
      description: oneOffTaskDescription.trim() || undefined,
      dueTime: oneOffTaskDueTime,
      departmentId: effectiveDeptId,
      departmentName: dept?.name,
      requiresPhotoEvidence: oneOffTaskRequiresPhoto,
      requiresQuestionsAnswered: oneOffTaskRequiresQuestions,
    }]);
    resetOneOffTaskForm();
  };

  const addPendingTask = () => {
    if (!taskTitle.trim()) return;
    // Handle "none" as no department selected
    const effectiveDeptId = taskDepartmentId && taskDepartmentId !== "none" ? taskDepartmentId : undefined;
    const dept = effectiveDeptId ? departments?.find(d => d.id === effectiveDeptId) : undefined;
    setPendingTasks(prev => [...prev, {
      id: crypto.randomUUID(),
      title: taskTitle.trim(),
      description: taskDescription.trim() || undefined,
      dueTime: taskDueTime,
      departmentId: effectiveDeptId,
      departmentName: dept?.name,
      requiresPhotoEvidence: taskRequiresPhoto,
      requiresQuestionsAnswered: taskRequiresQuestions,
    }]);
    resetTaskForm();
  };

  const removePendingTask = (id: string) => {
    const taskToRemove = pendingTasks.find(t => t.id === id);
    if (taskToRemove?.isExisting) {
      // Track existing tasks for deletion on save (deduplicate)
      setTasksToDelete(prev => prev.includes(id) ? prev : [...prev, id]);
    }
    setPendingTasks(prev => prev.filter(t => t.id !== id));
  };

  const handleSubmit = () => {
    // Normalize and combine country code and phone number for storage
    let normalizedPhone: string | null = null;
    if (formData.whatsappPhoneRaw) {
      // Strip spaces, dashes, and non-digit characters except +
      const cleanPhone = formData.whatsappPhoneRaw.replace(/[\s\-()]/g, "").replace(/^0+/, "");
      if (cleanPhone) {
        const countryCode = formData.whatsappCountryCode || "+66";
        normalizedPhone = `${countryCode}${cleanPhone}`;
      }
    }
    
    const processedFormData = {
      ...formData,
      whatsappPhoneRaw: normalizedPhone || "",
    };
    // Remove the whatsappCountryCode as it's not a DB field
    const { whatsappCountryCode, ...submitData } = processedFormData;
    
    if (editingEvent) {
      const newTasks = pendingTasks.filter(t => !t.isExisting);
      updateMutation.mutate({ 
        id: editingEvent.id, 
        data: { ...submitData, branchId: selectedBranchId || editingEvent.branchId }, 
        newTasks,
        deletedTaskIds: tasksToDelete,
      });
    } else {
      // Use selectedBranchId for new events, falling back to activeBranchId
      createMutation.mutate({ 
        eventData: submitData, 
        tasks: pendingTasks,
        branchId: selectedBranchId,
      });
    }
  };

  // Monthly stats for the calendar stats bar
  // Must be declared before any early returns to satisfy Rules of Hooks
  type EventBillingSummary = {
    totalCalculated?: number | string | null;
    depositPaid?: boolean | null;
    depositPaidAmount?: number | string | null;
  };
  const monthlyStats = useMemo(() => {
    const monthEvents = filteredEvents.filter((event) =>
      isSameMonth(parseISO(event.eventDate), calendarMonth)
    );
    let totalRevenue = 0;
    let depositsCollected = 0;
    let confirmedCount = 0;
    for (const event of monthEvents) {
      const billing = (event as Event & { billing?: EventBillingSummary | null }).billing;
      if (billing?.totalCalculated) totalRevenue += Number(billing.totalCalculated) || 0;
      if (billing?.depositPaid) {
        depositsCollected += Number(billing.depositPaidAmount) || 0;
        confirmedCount += 1;
      }
    }
    return { total: monthEvents.length, totalRevenue, depositsCollected, confirmedCount };
  }, [filteredEvents, calendarMonth]);

  const birthdayLegendBranches = useMemo(() => {
    const birthdayBranchIds = new Set(
      filteredEvents
        .filter((event) => event.eventType === "birthday")
        .map((event) => event.branchId),
    );
    return (branches || [])
      .filter((branch) => birthdayBranchIds.has(branch.id))
      .map((branch) => ({
        id: branch.id,
        name: branch.name,
        color: getEventCalendarColor({
          eventType: "birthday",
          branchCalendarColor: branch.calendarColor,
          branchId: branch.id,
          branchName: branch.name,
        }),
      }));
  }, [branches, filteredEvents]);

  if (isLoading) {
    return (
      <LayoutWrapper>
        <LoadingScreen />
      </LayoutWrapper>
    );
  }

  // Group events by status for kanban view (use status value as key)
  const eventsByStatus = statuses.reduce((acc, status) => {
    acc[status.value] = filteredEvents.filter(e => e.status === status.value);
    return acc;
  }, {} as Record<string, Event[]>);

  // Get calendar days for calendar view
  const monthStart = startOfMonth(calendarMonth);
  const monthEnd = endOfMonth(calendarMonth);
  const calendarStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const calendarEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });
  const calendarDays = eachDayOfInterval({ start: calendarStart, end: calendarEnd });

  // Group events by date for calendar view
  // Camp events span multiple days (eventDate → campEndDate), so they appear on every day in that range.
  const eventsByDate = filteredEvents.reduce((acc, event) => {
    if (event.eventType === "camp" && (event as any).campEndDate && (event as any).campEndDate > event.eventDate) {
      try {
        const days = eachDayOfInterval({ start: parseISO(event.eventDate), end: parseISO((event as any).campEndDate) });
        for (const day of days) {
          const dateKey = format(day, "yyyy-MM-dd");
          if (!acc[dateKey]) acc[dateKey] = [];
          if (!acc[dateKey].find(e => e.id === event.id)) acc[dateKey].push(event);
        }
      } catch {
        const dateKey = event.eventDate;
        if (!acc[dateKey]) acc[dateKey] = [];
        acc[dateKey].push(event);
      }
    } else {
      const dateKey = event.eventDate;
      if (!acc[dateKey]) acc[dateKey] = [];
      acc[dateKey].push(event);
    }
    return acc;
  }, {} as Record<string, Event[]>);

  // Track deposit payment dates for calendar indicators
  const depositPaymentsByDate = filteredEvents.reduce((acc, event) => {
    const billing = (event as any).billing;
    if (billing?.depositPaid && billing?.depositPaidAt) {
      const paidDate = format(new Date(billing.depositPaidAt), "yyyy-MM-dd");
      if (!acc[paidDate]) acc[paidDate] = [];
      acc[paidDate].push(event);
    }
    return acc;
  }, {} as Record<string, Event[]>);

  // Render event card (shared between views)
  // Get status color for an event
  const getEventStatusColor = (status: string) => {
    const statusConfig = statuses.find(s => s.value === status);
    return statusConfig?.color || "gray";
  };

  const getEventTypeStyle = (event: Event) => {
    const eventType = event.eventType;
    switch (eventType) {
      case "birthday":
        return { colorClass: null, colorHex: getCalendarColor(event), badge: EVENT_TYPE_LABELS_SHORT.birthday, badgeClass: "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300", icon: Cake };
      case "private_event":
        return { colorClass: null, colorHex: null, badge: EVENT_TYPE_LABELS_SHORT.private_event, badgeClass: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300", icon: Users };
      case "school_group":
        return { colorClass: null, colorHex: null, badge: EVENT_TYPE_LABELS_SHORT.school_group, badgeClass: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300", icon: Users };
      case "studio_event":
        return { colorClass: null, colorHex: getCalendarColor(event), badge: EVENT_TYPE_LABELS_SHORT.studio_event, badgeClass: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300", icon: Sparkles };
      case "workshop":
        return { colorClass: null, colorHex: getCalendarColor(event), badge: EVENT_TYPE_LABELS_SHORT.workshop, badgeClass: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300", icon: Sparkles };
      case "camp":
        return { colorClass: null, colorHex: getCalendarColor(event), badge: EVENT_TYPE_LABELS_SHORT.camp, badgeClass: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300", icon: Users };
      default:
        return { colorClass: null, colorHex: null, badge: null, badgeClass: "", icon: null };
    }
  };

  const renderEventCard = (event: Event, compact = false, isDragging = false) => {
    const statusColor = getEventStatusColor(event.status);
    const statusColorClass = getStatusColorClass(statusColor);
    const typeStyle = getEventTypeStyle(event);
    const colorClass = typeStyle.colorHex ? "" : statusColorClass;
    const colorStyle = typeStyle.colorHex ? { backgroundColor: typeStyle.colorHex } : undefined;
    
    return (
      <div 
        key={event.id} 
        className={`bg-card border rounded-lg overflow-hidden cursor-pointer hover-elevate ${isDragging ? "opacity-50 shadow-lg" : ""}`}
        onClick={() => {
          if (event.eventType === "camp") {
            navigate(`/studio/events/camp/${event.id}`);
          } else if (event.eventType === "studio_event" || event.eventType === "workshop") {
            openStudioEventView(event);
          } else if (event.eventType === "birthday" || event.eventType === "private_event") {
            openBeoEditor(event);
          } else {
            openEditDialog(event);
          }
        }}
        data-testid={`card-event-${event.id}`}
      >
        {/* Section progress bars at top */}
        <div className="flex gap-0.5 px-2 pt-2">
          {(event as any).sectionProgress ? (() => {
            const sp = (event as any).sectionProgress;
            const sections = [
              { key: "info", done: sp.info },
              { key: "host", done: sp.host },
              { key: "package", done: sp.package },
              { key: "entertainment", done: sp.entertainment },
              { key: "setup", done: sp.setup },
              { key: "kitchen", done: sp.kitchen },
              { key: "billing", done: sp.billing },
              { key: "timeline", done: sp.timeline },
            ];
            return sections.map((s) => (
              <div
                key={s.key}
                className={`h-1.5 flex-1 rounded-full ${s.done ? colorClass : "bg-muted"}`}
                style={s.done ? colorStyle : undefined}
              />
            ));
          })() : (
            <>
              <div className={`h-1.5 flex-1 rounded-full ${colorClass}`} style={colorStyle} />
              <div className={`h-1.5 flex-1 rounded-full ${colorClass} opacity-60`} style={colorStyle} />
            </>
          )}
        </div>
        
        <div className="p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <h3 className="font-medium text-sm">{event.title}</h3>
              <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1 flex-wrap">
                <span className="flex items-center gap-1">
                  <CalendarDays className="h-3 w-3" />
                  {format(parseISO(event.eventDate), "d MMM")}
                </span>
                {typeStyle.badge && (
                  <span className={`inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0 rounded-full ${typeStyle.badgeClass}`}>
                    {typeStyle.icon && <typeStyle.icon className="h-2.5 w-2.5" />}
                    {typeStyle.badge}
                  </span>
                )}
                {showingMultipleBranches && event.branchId && (
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">{getBranchName(event.branchId)}</Badge>
                )}
                {!compact && event.updatedAt && (
                  <span>Last updated: {format(new Date(event.updatedAt), "d MMM")}</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {(event as any).billing?.totalCalculated > 0 ? (
                <span className={`text-sm font-semibold ${(event as any).billing?.depositPaid ? "text-green-600 dark:text-green-400" : ""}`}>
                  {Number((event as any).billing.totalCalculated).toLocaleString()}
                </span>
              ) : null}
              {(event as any).isArchived && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  <Archive className="h-3 w-3 mr-0.5" />
                  Archived
                </Badge>
              )}
              {!compact && (
                <span className="text-xs text-muted-foreground">#{event.id.slice(-3)}</span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };
  
  const DraggableEventCard = ({ event, compact = false }: { event: Event; compact?: boolean }) => {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
      id: event.id,
      data: { event },
    });
    
    return (
      <div
        ref={setNodeRef}
        {...listeners}
        {...attributes}
        onContextMenu={(e) => e.preventDefault()}
        className={`kanban-card-draggable ${isDragging ? "opacity-30 scale-[0.98]" : ""}`}
        style={{ touchAction: "none" }}
      >
        {renderEventCard(event, compact, false)}
      </div>
    );
  };
  
  
  // Handle drag end to update event status or reorder columns
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveEventId(null);
    setActiveColumnId(null);
    
    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);
    const isColumnDrag = activeId.startsWith("col-");
    
    if (isColumnDrag) {
      const fromStatusId = activeId.replace("col-", "");
      let toStatusId: string | null = null;
      if (overId.startsWith("col-")) {
        toStatusId = overId.replace("col-", "");
      } else {
        const targetByValue = statuses.find(s => s.value === overId);
        if (targetByValue) toStatusId = targetByValue.id;
      }
      if (!toStatusId || fromStatusId === toStatusId) return;
      const oldIndex = statuses.findIndex(s => s.id === fromStatusId);
      const newIndex = statuses.findIndex(s => s.id === toStatusId);
      if (oldIndex === -1 || newIndex === -1) return;
      const reordered = arrayMove(statuses, oldIndex, newIndex);
      queryClient.setQueryData(["/api/admin/event-statuses"], reordered.map((s, i) => ({ ...s, sortOrder: i })));
      reorderStatusMutation.mutate(reordered.map(s => s.id));
      return;
    }
    
    const eventId = activeId;
    const targetStatus = overId.startsWith("col-") ? "" : overId;
    if (!targetStatus) return;
    
    const draggedEvent = filteredEvents.find(e => e.id === eventId);
    if (!draggedEvent || draggedEvent.status === targetStatus) return;
    
    updateStatusMutation.mutate({ id: eventId, status: targetStatus });
  };
  
  const handleDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    if (id.startsWith("col-")) {
      setActiveColumnId(id.replace("col-", ""));
    } else {
      setActiveEventId(id);
    }
  };

  return (
    <LayoutWrapper>
      <div className={`p-4 ${viewMode === "kanban" || viewMode === "calendar" ? "max-w-full overflow-x-auto" : "max-w-lg"} mx-auto`}>
        <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
          <h1 className="text-xl font-bold">Events</h1>
          <div className="flex items-center gap-2">
            <Tabs value={viewMode} onValueChange={(v) => navigate(`/studio/events/${v}`)}>
              <TabsList className="h-9">
                <TabsTrigger value="list" className="px-3" data-testid="tab-view-list">
                  <List className="h-4 w-4" />
                </TabsTrigger>
                <TabsTrigger value="kanban" className="px-3" data-testid="tab-view-kanban">
                  <Columns className="h-4 w-4" />
                </TabsTrigger>
                <TabsTrigger value="calendar" className="px-3" data-testid="tab-view-calendar">
                  <Calendar className="h-4 w-4" />
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Button variant="outline" size="icon" asChild data-testid="button-event-settings">
              <a href="/studio/event-settings">
                <Settings className="h-4 w-4" />
              </a>
            </Button>
            <Button onClick={() => setShowTypeSelector(true)} data-testid="button-create-event">
              <Plus className="h-4 w-4 mr-2" />
              New Event
            </Button>
          </div>
        </div>

        <div className="flex gap-2 mb-4">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              data-testid="input-search-events"
            />
          </div>
          <Select value={eventTypeFilter} onValueChange={setEventTypeFilter}>
            <SelectTrigger className="w-[90px] lg:w-[140px]" data-testid="select-event-type-filter">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Events</SelectItem>
              <SelectItem value="birthday">{EVENT_TYPE_LABELS.birthday}</SelectItem>
              <SelectItem value="studio_event">{EVENT_TYPE_LABELS.studio_event}</SelectItem>
              <SelectItem value="workshop">{EVENT_TYPE_LABELS.workshop}</SelectItem>
              <SelectItem value="camp">{EVENT_TYPE_LABELS.camp}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={branchFilter} onValueChange={setBranchFilter}>
            <SelectTrigger className="w-[90px] lg:w-[160px]" data-testid="select-branch-filter">
              <SelectValue placeholder="Branch" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Branches</SelectItem>
              {branches?.map((branch) => (
                <SelectItem key={branch.id} value={branch.id}>{branch.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={showArchived ? "default" : "outline"}
                size="icon"
                onClick={() => setShowArchived(!showArchived)}
                data-testid="button-toggle-archived"
              >
                <Archive className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{showArchived ? "Showing archived events" : "Show archived events"}</TooltipContent>
          </Tooltip>
        </div>

        {/* List View */}
        {viewMode === "list" && (
          <div className="space-y-3">
            {filteredEvents.length === 0 ? (
              <EmptyState
                icon={CalendarDays}
                title="No events"
                description="Create your first event to get started"
              />
            ) : (
              filteredEvents.map((event) => renderEventCard(event))
            )}
          </div>
        )}

        {/* Kanban View — Mobile */}
        {viewMode === "kanban" && isMobile && (() => {
          const activeMobileStatus = statuses.find(s => s.value === selectedMobileStatusValue) || statuses[0];
          const activeMobileValue = activeMobileStatus?.value || "";
          // Apply optimistic overrides to eventsByStatus for immediate visual moves
          const optimisticEventsByStatus: Record<string, Event[]> = {};
          for (const s of statuses) {
            optimisticEventsByStatus[s.value] = (eventsByStatus[s.value] || []).filter(
              e => !optimisticEventStatuses[e.id] || optimisticEventStatuses[e.id] === s.value
            );
          }
          for (const [eventId, targetVal] of Object.entries(optimisticEventStatuses)) {
            const origEvent = filteredEvents.find(e => e.id === eventId);
            if (origEvent && optimisticEventsByStatus[targetVal]) {
              if (!optimisticEventsByStatus[targetVal].some(e => e.id === eventId)) {
                optimisticEventsByStatus[targetVal].push(origEvent);
              }
            }
          }
          const activeMobileEvents = optimisticEventsByStatus[activeMobileValue] || [];
          const getTabActiveClassForStatus = (color: string): string => {
            const map: Record<string, string> = {
              blue: "bg-blue-600 text-white",
              green: "bg-green-600 text-white",
              yellow: "bg-yellow-500 text-white",
              red: "bg-red-600 text-white",
              purple: "bg-purple-600 text-white",
              pink: "bg-pink-500 text-white",
              orange: "bg-orange-500 text-white",
              gray: "bg-gray-600 text-white",
            };
            return map[color] || "bg-foreground text-background";
          };
          return (
            <div>
              {/* Mobile tab bar */}
              <div className="flex gap-1.5 overflow-x-auto pb-2 mb-3 no-scrollbar">
                {statuses.map((status) => {
                  const count = (optimisticEventsByStatus[status.value] || []).length;
                  const isActive = status.value === activeMobileValue;
                  const activeClass = getTabActiveClassForStatus(status.color);
                  return (
                    <button
                      key={status.id}
                      onClick={() => setSelectedMobileStatusValue(status.value)}
                      className={cn(
                        "flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-all duration-150",
                        isActive
                          ? activeClass
                          : "text-muted-foreground hover:text-foreground hover:bg-muted"
                      )}
                    >
                      <span className={cn("w-2 h-2 rounded-full flex-shrink-0", getStatusColorClass(status.color))} />
                      {status.name}
                      <span
                        className={cn(
                          "text-xs rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center",
                          isActive ? "bg-white/20" : "bg-muted text-muted-foreground"
                        )}
                      >
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
              {/* Mobile single column */}
              <div className="space-y-2">
                {activeMobileEvents.length === 0 ? (
                  <div className="text-sm text-muted-foreground text-center py-8 border-2 border-dashed border-muted rounded-lg">
                    No events
                  </div>
                ) : (
                  activeMobileEvents.map((event) => {
                    const otherStatuses = statuses.filter(s => s.value !== activeMobileValue);
                    return (
                      <div key={event.id} className="relative">
                        {renderEventCard(event, true)}
                        {otherStatuses.length > 0 && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="absolute top-1.5 right-1.5 h-7 w-7 z-10 bg-background/80 hover:bg-background shadow-sm rounded-full"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <ArrowRight className="h-3.5 w-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="min-w-[140px]">
                              {otherStatuses.map((targetStatus) => (
                                <DropdownMenuItem
                                  key={targetStatus.id}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOptimisticEventStatuses(prev => ({ ...prev, [event.id]: targetStatus.value }));
                                    updateStatusMutation.mutate(
                                      { id: event.id, status: targetStatus.value },
                                      {
                                        onSettled: () => {
                                          setOptimisticEventStatuses(prev => {
                                            const next = { ...prev };
                                            delete next[event.id];
                                            return next;
                                          });
                                        },
                                      }
                                    );
                                  }}
                                >
                                  <span className={cn("w-2 h-2 rounded-full flex-shrink-0 mr-2", getStatusColorClass(targetStatus.color))} />
                                  {targetStatus.name}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })()}

        {/* Kanban View — Desktop */}
        {viewMode === "kanban" && !isMobile && (
          <div className="flex gap-4">
          <div className="flex-1 min-w-0">
          <DndContext 
            sensors={sensors} 
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            autoScroll={{ enabled: true, threshold: { x: 0.15, y: 0.15 }, acceleration: 10 }}
          >
          <div className="overflow-x-auto pb-4 -mx-4 min-h-[500px]">
            <div className="flex gap-3 px-4 h-full" style={{ width: 'fit-content', minWidth: '100%' }}>
            <SortableContext items={statuses.map(s => `col-${s.id}`)} strategy={horizontalListSortingStrategy}>
            {statuses.map((status) => {
              const isCollapsed = collapsedColumns.has(status.id);
              const columnEvents = eventsByStatus[status.value] || [];
              const toggleCollapse = () => {
                setCollapsedColumns(prev => {
                  const next = new Set(prev);
                  if (next.has(status.id)) {
                    next.delete(status.id);
                  } else {
                    next.add(status.id);
                  }
                  return next;
                });
              };
              
              if (isCollapsed) {
                return (
                  <SortableColumnWrapper key={status.id} id={status.id}>
                    {({ listeners, attributes }) => (
                      <div 
                        className="w-10 flex-shrink-0 bg-card rounded-lg border cursor-pointer hover-elevate"
                        onClick={toggleCollapse}
                        data-testid={`column-collapsed-${status.id}`}
                      >
                        <div className="flex flex-col items-center py-3 gap-2">
                          <div {...listeners} {...attributes} className="cursor-grab active:cursor-grabbing p-0.5 rounded hover:bg-muted" onClick={(e) => e.stopPropagation()} data-testid={`grip-column-${status.id}`}>
                            <GripVertical className="h-3 w-3 text-muted-foreground" />
                          </div>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6"
                            onClick={(e) => { e.stopPropagation(); toggleCollapse(); }}
                            data-testid={`button-expand-column-${status.id}`}
                          >
                            <ChevronsRightLeft className="h-3 w-3" />
                          </Button>
                          <Badge variant="secondary" className="text-xs">
                            {columnEvents.length}
                          </Badge>
                          <div className="flex-1 flex items-center justify-center min-h-[120px]">
                            <div 
                              className="text-sm font-medium flex items-center gap-2"
                              style={{ writingMode: 'vertical-lr', textOrientation: 'mixed' }}
                            >
                              <div className={`w-2 h-2 rounded-full flex-shrink-0 ${getStatusColorClass(status.color)}`} />
                              {status.name}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </SortableColumnWrapper>
                );
              }
              
              return (
              <SortableColumnWrapper key={status.id} id={status.id}>
                {({ listeners, attributes }) => (
              <div className="w-[280px] flex-shrink-0 flex flex-col bg-muted/30 rounded-lg p-3">
                <div className="flex items-center gap-1 mb-3 group h-8">
                  <div
                    {...listeners}
                    {...attributes}
                    className="cursor-grab active:cursor-grabbing p-1 -ml-1 rounded hover:bg-muted/80 flex-shrink-0 touch-none"
                    data-testid={`grip-column-${status.id}`}
                  >
                    <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${getStatusColorClass(status.color)}`} />
                  {editingStatus?.id === status.id ? (
                    <div className="flex items-center gap-1 flex-1">
                      <Input
                        value={editingStatus.name}
                        onChange={(e) => setEditingStatus({ ...editingStatus, name: e.target.value })}
                        className="h-7 text-sm"
                        data-testid={`input-edit-status-${status.id}`}
                      />
                      <Select value={editingStatus.color} onValueChange={(v) => setEditingStatus({ ...editingStatus, color: v })}>
                        <SelectTrigger className="h-7 w-24">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {STATUS_COLORS.map((c) => (
                            <SelectItem key={c.value} value={c.value}>
                              <div className="flex items-center gap-2">
                                <div className={`w-3 h-3 rounded-full ${c.class}`} />
                                {c.label}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => updateStatusConfigMutation.mutate(editingStatus)}
                        data-testid={`button-save-status-${status.id}`}
                      >
                        <Check className="h-3 w-3" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => setEditingStatus(null)}
                        data-testid={`button-cancel-edit-status-${status.id}`}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ) : (
                    <>
                      <h3 className="font-medium text-sm">{status.name}</h3>
                      <Badge variant="secondary" className="text-xs ml-auto">
                        {columnEvents.length}
                      </Badge>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity"
                        onClick={toggleCollapse}
                        data-testid={`button-collapse-column-${status.id}`}
                      >
                        <ChevronsLeftRight className="h-3 w-3" />
                      </Button>
                      <div className="hidden lg:flex lg:opacity-0 lg:group-hover:opacity-100 transition-opacity gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          onClick={() => setEditingStatus({ id: status.id, name: status.name, color: status.color })}
                          data-testid={`button-edit-status-${status.id}`}
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                        {!status.isDefault && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 text-destructive"
                            onClick={() => deleteStatusMutation.mutate(status.id)}
                            data-testid={`button-delete-status-${status.id}`}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                </div>
                <DroppableColumnStatic id={status.value}>
                  {columnEvents.length === 0 ? (
                    <div className="border border-dashed rounded-md p-4 text-center text-muted-foreground text-sm">
                      No events
                    </div>
                  ) : (
                    columnEvents.map((event) => (
                      <DraggableEventCard key={event.id} event={event} compact />
                    ))
                  )}
                </DroppableColumnStatic>
              </div>
                )}
              </SortableColumnWrapper>
            );
            })}
            </SortableContext>
            {/* Add Column Button */}
            <div className="min-w-[200px] flex-shrink-0">
              {showAddStatusDialog ? (
                <Card className="p-3">
                  <div className="space-y-3">
                    <Input
                      placeholder="Column name..."
                      value={newStatusName}
                      onChange={(e) => setNewStatusName(e.target.value)}
                      data-testid="input-new-status-name"
                    />
                    <Select value={newStatusColor} onValueChange={setNewStatusColor}>
                      <SelectTrigger data-testid="select-new-status-color">
                        <SelectValue placeholder="Color" />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUS_COLORS.map((c) => (
                          <SelectItem key={c.value} value={c.value}>
                            <div className="flex items-center gap-2">
                              <div className={`w-3 h-3 rounded-full ${c.class}`} />
                              {c.label}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => createStatusMutation.mutate({ name: newStatusName, color: newStatusColor })}
                        disabled={!newStatusName.trim() || createStatusMutation.isPending}
                        data-testid="button-create-status"
                      >
                        {createStatusMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setShowAddStatusDialog(false);
                          setNewStatusName("");
                          setNewStatusColor("blue");
                        }}
                        data-testid="button-cancel-add-status"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                </Card>
              ) : (
                <Button
                  variant="outline"
                  className="w-full h-10 border-dashed"
                  onClick={() => setShowAddStatusDialog(true)}
                  data-testid="button-add-column"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add Column
                </Button>
              )}
            </div>
            </div>
          </div>
          <DragOverlay dropAnimation={{ duration: 200, easing: "cubic-bezier(0.18, 0.67, 0.6, 1.22)" }}>
            {activeEventId ? (
              (() => {
                const event = filteredEvents.find(e => e.id === activeEventId);
                return event ? (
                  <div className="kanban-drag-overlay w-[260px] rounded-lg shadow-xl ring-2 ring-primary/30 scale-[1.03] rotate-[1deg]">
                    {renderEventCard(event, true)}
                  </div>
                ) : null;
              })()
            ) : activeColumnId ? (
              (() => {
                const col = statuses.find(s => s.id === activeColumnId);
                return col ? (
                  <div className="w-[280px] bg-muted/50 rounded-lg p-3 shadow-xl ring-2 ring-primary/30 opacity-80">
                    <div className="flex items-center gap-2 h-8">
                      <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
                      <div className={`w-2 h-2 rounded-full ${getStatusColorClass(col.color)}`} />
                      <h3 className="font-medium text-sm">{col.name}</h3>
                    </div>
                  </div>
                ) : null;
              })()
            ) : null}
          </DragOverlay>
          </DndContext>
          </div>
          <div className="hidden lg:block w-[280px] shrink-0">
            <div className="sticky top-12">
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Activity className="h-4 w-4 text-muted-foreground" />
                    <h3 className="text-sm font-semibold">Recent Updates</h3>
                  </div>
                  {recentEventActivities.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-4 text-center">No recent event activity</p>
                  ) : (
                    <div className="space-y-0 max-h-[calc(100vh-300px)] overflow-y-auto">
                      {recentEventActivities.map((activity) => (
                        <button
                          key={activity.id}
                          className="w-full text-left py-2 border-b last:border-b-0 border-border/50 hover-elevate rounded-sm px-1 -mx-1 cursor-pointer"
                          onClick={() => {
                            const matchingEvent = events?.find(e => e.id === activity.id);
                            if (matchingEvent) {
                              setSelectedBranchId(matchingEvent.branchId);
                              setEditingEvent(matchingEvent);
                            }
                          }}
                          data-testid={`events-activity-${activity.id}`}
                        >
                          <p className="text-xs leading-snug">{activity.description}</p>
                          {activity.title && (
                            <p className="text-xs text-muted-foreground truncate mt-0.5">{activity.title}</p>
                          )}
                          <div className="flex items-center justify-between gap-1 mt-1">
                            <span className="text-[10px] text-muted-foreground truncate max-w-[140px]">
                              {activity.employeeNickname || activity.userName || "System"}
                            </span>
                            <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                              {formatActivityDate(activity.updatedAt)}
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
          </div>
        )}

        {/* Calendar View */}
        {viewMode === "calendar" && (
          <div>
            <div className="flex items-center justify-between mb-4 lg:mb-6">
              <Button variant="ghost" size="icon" onClick={() => setCalendarMonth(subMonths(calendarMonth, 1))} data-testid="button-prev-month">
                <ChevronLeft className="h-4 w-4 lg:h-5 lg:w-5" />
              </Button>
              <h2 className="font-semibold text-lg lg:text-xl">{format(calendarMonth, "MMMM yyyy")}</h2>
              <Button variant="ghost" size="icon" onClick={() => setCalendarMonth(addMonths(calendarMonth, 1))} data-testid="button-next-month">
                <ChevronRight className="h-4 w-4 lg:h-5 lg:w-5" />
              </Button>
            </div>
            {/* Monthly stats bar */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              {[
                { label: "Total Events", value: monthlyStats.total.toString() },
                { label: "Total Revenue", value: monthlyStats.totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
                { label: "Deposits Collected", value: monthlyStats.depositsCollected.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
                { label: "Confirmed Events", value: monthlyStats.confirmedCount.toString() },
              ].map(({ label, value }) => (
                <div key={label} className="rounded-lg border bg-card px-4 py-3 flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground font-medium">{label}</span>
                  <span className="text-lg font-semibold leading-tight">{value}</span>
                </div>
              ))}
            </div>

            {/* Calendar legend */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3 text-xs text-muted-foreground">
              {birthdayLegendBranches.map((branch) => (
                <div key={branch.id} className="flex items-center gap-1.5" data-testid={`calendar-legend-birthday-${branch.id}`}>
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: branch.color }} />
                  <span>BD {branch.name}</span>
                </div>
              ))}
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: getEventCalendarColor({ eventType: "camp" }) }} />
                <span>Camp</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: getEventCalendarColor({ eventType: "workshop" }) }} />
                <span>Workshop</span>
              </div>
              <div className="flex items-center gap-1.5" data-testid="calendar-legend-other-events">
                <span className="flex items-center -space-x-0.5" aria-hidden="true">
                  {OTHER_EVENT_LEGEND_COLORS.map((color) => (
                    <span key={color} className="w-2.5 h-2.5 rounded-full ring-1 ring-background" style={{ backgroundColor: color }} />
                  ))}
                </span>
                <span>Other Events</span>
              </div>
            </div>

            <div className="grid grid-cols-7 gap-px bg-border rounded-lg overflow-hidden">
              {calendarDays.slice(0, 7).map((day) => (
                <div key={format(day, "EEE")} className="bg-muted p-2 lg:p-3 text-center text-xs lg:text-sm font-medium">
                  {format(day, "EEE")}
                </div>
              ))}
              {calendarDays.map((day) => {
                const dateKey = format(day, "yyyy-MM-dd");
                const dayEvents = eventsByDate[dateKey] || [];
                const depositPayments = depositPaymentsByDate[dateKey] || [];
                const isCurrentMonth = isSameMonth(day, calendarMonth);
                const isToday = isSameDay(day, new Date());
                return (
                  <div
                    key={dateKey}
                    className={`bg-card min-h-[120px] lg:min-h-[140px] p-2 ${!isCurrentMonth ? "opacity-50" : ""}`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className={`text-xs font-medium w-6 h-6 flex items-center justify-center rounded-full ${isToday ? "bg-primary text-primary-foreground" : ""}`}>
                        {format(day, "d")}
                      </div>
                      {depositPayments.length > 0 && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              className="flex items-center gap-0.5 text-green-600 dark:text-green-400 cursor-pointer rounded px-0.5 hover-elevate"
                              onClick={(e) => {
                                e.stopPropagation();
                                setPreviewEvent(depositPayments[0]);
                              }}
                              data-testid={`deposit-indicator-${dateKey}`}
                            >
                              <DollarSign className="h-3 w-3" />
                              <span className="text-[9px] font-medium">{depositPayments.length}</span>
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-xs">
                            {depositPayments.map(e => (
                              <div key={e.id}>{e.title}: deposit paid</div>
                            ))}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                    <div className="space-y-0.5">
                      {dayEvents.slice(0, 4).map((event) => {
                        const billing = (event as any).billing;
                        const hasDeposit = billing?.depositPaid;
                        const isCamp = event.eventType === "camp";
                        const campEnd = (event as any).campEndDate;
                        const assignedHosts = (event as Event & {
                          assignedHosts?: Array<{ name: string; role: "host" | "entertainment" }>;
                        }).assignedHosts;
                        const hostSummary = assignedHosts
                          ?.map((host) => host.name)
                          .join(" · ");
                        // Determine where this day falls in the camp's span
                        const isStart = dateKey === event.eventDate;
                        const isEnd = !campEnd || dateKey === campEnd || campEnd === event.eventDate;
                        const campPos = !isCamp ? null : (isStart && isEnd) ? "single" : isStart ? "start" : isEnd ? "end" : "middle";

                        if (isCamp && campPos !== "single") {
                          // Compute which day is the visual center of the full camp span
                          const campStartParsed = parseISO(event.eventDate);
                          const campEndParsed = campEnd ? parseISO(campEnd) : campStartParsed;
                          const spanDays = differenceInDays(campEndParsed, campStartParsed);
                          const midDateKey = format(addDays(campStartParsed, Math.floor(spanDays / 2)), "yyyy-MM-dd");
                          const isNameDay = dateKey === midDateKey;

                          return (
                            <div
                              key={event.id}
                                className={`text-xs py-0.5 cursor-pointer text-white hover:opacity-80 transition-opacity overflow-hidden ${
                                campPos === "start" ? "pl-1 pr-0 rounded-l-sm rounded-r-none -mr-2" :
                                campPos === "end"   ? "pr-1 pl-0 rounded-r-sm rounded-l-none -ml-2" :
                                                     "px-0 rounded-none -mx-2"
                              }`}
                              style={{ backgroundColor: getCalendarColor(event) }}
                              onClick={() => setCampQuickView(event)}
                              data-testid={`calendar-event-${event.id}`}
                            >
                              {isNameDay ? (
                                <div className="flex items-center justify-center w-full px-1">
                                  <span className="font-medium truncate text-center">{event.title}</span>
                                </div>
                              ) : (
                                <div className="h-3" />
                              )}
                            </div>
                          );
                        }

                        const usesCustomColor = event.eventType === "birthday" || event.eventType === "camp" || event.eventType === "workshop" || event.eventType === "studio_event" || event.eventType === "other";
                        return (
                          <div
                            key={event.id}
                            className={`text-xs p-1 rounded cursor-pointer hover-elevate text-white ${
                              usesCustomColor ? "" : getStatusColorClass(statuses.find(s => s.value === event.status)?.color || "blue")
                            }`}
                            style={usesCustomColor ? { backgroundColor: getCalendarColor(event) } : undefined}
                            onClick={() => {
                              if (event.eventType === "camp") {
                                openCampEditor(event);
                              } else if (event.eventType === "birthday" || event.eventType === "private_event") {
                                setPreviewEvent(event);
                              } else if (event.eventType === "studio_event" || event.eventType === "workshop") {
                                openStudioEventView(event);
                              } else {
                                openEditDialog(event);
                              }
                            }}
                            data-testid={`calendar-event-${event.id}`}
                          >
                            <div className="flex items-center gap-1 truncate">
                              {hasDeposit && <CircleCheck className="h-2.5 w-2.5 flex-shrink-0" />}
                              <span className="truncate">{event.startTime} {event.title}</span>
                            </div>
                            {(event.eventType === "birthday" || event.eventType === "private_event") && hostSummary ? (
                              <div
                                className="flex items-center gap-1 text-xs opacity-80 truncate"
                                title={hostSummary}
                                data-testid={`calendar-hosts-${event.id}`}
                              >
                                <UserRound className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                                <span className="truncate">{hostSummary}</span>
                              </div>
                            ) : null}
                            {showingMultipleBranches && event.branchId && (
                              <div className="text-[9px] opacity-80 truncate">{getBranchName(event.branchId)}</div>
                            )}
                          </div>
                        );
                      })}
                      {dayEvents.length > 4 && (
                        <div className="text-xs text-muted-foreground text-center">
                          +{dayEvents.length - 4} more
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Event Preview Dialog - shows event overview (location, activities, decorations) */}
      <Dialog open={!!previewEvent} onOpenChange={(open) => { if (!open) setPreviewEvent(null); }}>
        <DialogContent className="max-w-sm" onOpenAutoFocus={(e) => e.preventDefault()}>
          {previewEvent && (() => {
            const isBirthday = previewEvent.eventType === "birthday";
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    {isBirthday && <Cake className="h-4 w-4 text-pink-500" />}
                    {previewEvent.title}
                  </DialogTitle>
                  <DialogDescription>
                    {format(new Date(previewEvent.eventDate + "T00:00:00"), "EEEE, MMMM d, yyyy")}
                    {previewEvent.branchId && getBranchName(previewEvent.branchId) !== "Unknown" && getBranchName(previewEvent.branchId) !== "" && ` · ${getBranchName(previewEvent.branchId)}`}
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-sm">
                    <Clock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <span>{previewEvent.startTime}{previewEvent.endTime ? ` - ${previewEvent.endTime}` : ""}</span>
                  </div>
                  {previewEvent.childName && (
                    <div className="flex items-center gap-2 text-sm">
                      <Cake className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <span>Birthday child: <span className="font-medium">{previewEvent.childName}</span></span>
                    </div>
                  )}
                  {(previewEvent.numChildren || previewEvent.numAdults) && (
                    <div className="flex items-center gap-2 text-sm">
                      <Users className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <span>{previewEvent.numChildren || 0} children, {previewEvent.numAdults || 0} adults</span>
                    </div>
                  )}

                  {(previewEvent.locationText || (previewEvent.locationId && locationsById[previewEvent.locationId])) && (
                    <div className="flex items-center gap-2 text-sm" data-testid="text-preview-location">
                      <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <span>{previewEvent.locationText || locationsById[previewEvent.locationId!]}</span>
                    </div>
                  )}
                  {(() => {
                    const billing = (previewEvent as any).billing;
                    const paid = Number((billing as any)?.prepaymentReceived) || 0;
                    const depositDateRaw = (billing as any)?.depositDate || (previewEvent as any).prepaymentDate;
                    const depositDateStr = depositDateRaw
                      ? format(parseISO(depositDateRaw), "MMM d, yyyy")
                      : null;
                    return (
                      <div className="flex items-start gap-2 text-sm">
                        <Banknote className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                        <div className="flex flex-col gap-0.5">
                          <span>
                            Deposit: <span className="font-medium">฿{paid.toLocaleString()}</span>
                            {depositDateStr && (
                              <span className="text-muted-foreground"> · {depositDateStr}</span>
                            )}
                          </span>
                        </div>
                      </div>
                    );
                  })()}
                  {previewEvent.activities && (
                    <div className="flex items-center gap-2 text-sm" data-testid="text-preview-activities">
                      <PartyPopper className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <span>{previewEvent.activities}</span>
                    </div>
                  )}
                  {previewEvent.decoration && (
                    <div className="flex items-center gap-2 text-sm" data-testid="text-preview-decoration">
                      <Palette className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <span>{previewEvent.decoration}</span>
                    </div>
                  )}
                </div>
                <DialogFooter className="flex flex-row gap-2">
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      const isArchived = (previewEvent as any).isArchived;
                      archiveMutation.mutate({ id: previewEvent.id, archived: !isArchived });
                      setPreviewEvent(null);
                    }}
                    data-testid="button-archive-preview"
                  >
                    {(previewEvent as any).isArchived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                  </Button>
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => setPreviewEvent(null)}
                    data-testid="button-close-preview"
                  >
                    Close
                  </Button>
                  <Button
                    className="flex-1"
                    onClick={() => {
                      setPreviewEvent(null);
                      if (previewEvent.eventType === "birthday" || previewEvent.eventType === "private_event") {
                        openBeoEditor(previewEvent);
                      } else {
                        openEditDialog(previewEvent);
                      }
                    }}
                    data-testid="button-open-full-editor"
                  >
                    <ExternalLink className="h-4 w-4 mr-1" />
                    Open Full Details
                  </Button>
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      <Dialog open={showCreateDialog || !!editingEvent} onOpenChange={(open) => { if (!open) { setShowCreateDialog(false); setEditingEvent(null); setSelectedBranchId(activeBranchId); } }}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto" onOpenAutoFocus={(e) => e.preventDefault()}>
          <DialogHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <DialogTitle>{editingEvent ? "Edit Event" : "Create Event"}</DialogTitle>
              <DialogDescription>
                {editingEvent ? "Update event details" : "Add a new event"}
              </DialogDescription>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => setShowAIAssistant(true)}
                  data-testid="button-ai-assist"
                >
                  <Sparkles className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>AI Assist</TooltipContent>
            </Tooltip>
          </DialogHeader>
          
          {editingEvent && (
            <div className="flex gap-2 py-2 border-b mb-2 flex-wrap">
              <Button 
                variant="default" 
                size="sm"
                onClick={() => {
                  setViewingStudioEvent(editingEvent);
                  setShowBeoEditor(true);
                }}
                data-testid="button-open-beo-from-edit"
              >
                <Pencil className="h-4 w-4 mr-2" />
                Edit BEO
              </Button>
              <Button 
                variant="secondary" 
                size="sm"
                onClick={() => {
                  setViewingStudioEvent(editingEvent);
                  setShowBeoDayOf(true);
                }}
                data-testid="button-open-dayof-from-edit"
              >
                <ClipboardList className="h-4 w-4 mr-2" />
                Day-of View
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const isArchived = (editingEvent as any).isArchived;
                  archiveMutation.mutate({ id: editingEvent.id, archived: !isArchived });
                  setEditingEvent(null);
                  setShowCreateDialog(false);
                }}
                data-testid="button-archive-edit"
              >
                {(editingEvent as any).isArchived ? <ArchiveRestore className="h-4 w-4 mr-2" /> : <Archive className="h-4 w-4 mr-2" />}
                {(editingEvent as any).isArchived ? "Restore" : "Archive"}
              </Button>
            </div>
          )}
          
          <div className="space-y-4">
            {/* Branch Selection */}
            {branches && branches.length > 1 && (
              <div className="space-y-2">
                <Label>Branch <span className="text-destructive">*</span></Label>
                <Select 
                  value={selectedBranchId || activeBranchId || ""} 
                  onValueChange={(v) => setSelectedBranchId(v || null)}
                >
                  <SelectTrigger data-testid="select-branch">
                    <SelectValue placeholder="Select branch" />
                  </SelectTrigger>
                  <SelectContent>
                    {branches.map((b) => (
                      <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {editingEvent && (
                  <p className="text-xs text-muted-foreground">Note: linked tasks and bookings will remain on the original branch.</p>
                )}
              </div>
            )}
            
            <div className="space-y-2">
              <Label>Title <span className="text-destructive">*</span></Label>
              <Input value={formData.title} onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))} placeholder="e.g., Emma's 5th Birthday" data-testid="input-event-title" />
            </div>
            <div className="space-y-2">
              <Label>Date <span className="text-destructive">*</span></Label>
              <DatePicker value={formData.eventDate} onChange={(date) => setFormData(prev => ({ ...prev, eventDate: date }))} data-testid="input-event-date" />
            </div>
            <div className="space-y-2">
              <Label>Child Name</Label>
              <Input value={formData.childName || ""} onChange={(e) => setFormData(prev => ({ ...prev, childName: e.target.value }))} placeholder="Birthday child's name" data-testid="input-child-name" />
            </div>
            <div className="space-y-2">
              <Label>Parent Name</Label>
              <Input value={formData.parentName || ""} onChange={(e) => setFormData(prev => ({ ...prev, parentName: e.target.value }))} placeholder="Contact person" data-testid="input-parent-name" />
            </div>
            <div className="space-y-2">
              <Label>WhatsApp Number</Label>
              <div className="flex gap-2">
                <Select 
                  value={formData.whatsappCountryCode || "+66"} 
                  onValueChange={(v) => setFormData(prev => ({ ...prev, whatsappCountryCode: v }))}
                >
                  <SelectTrigger className="w-28" data-testid="select-country-code">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Popular countries at the top */}
                    <SelectItem value="+66">+66 TH</SelectItem>
                    <SelectItem value="+1">+1 US</SelectItem>
                    <SelectItem value="+44">+44 UK</SelectItem>
                    <SelectItem value="+65">+65 SG</SelectItem>
                    <SelectItem value="+86">+86 CN</SelectItem>
                    <SelectItem value="+81">+81 JP</SelectItem>
                    <SelectItem value="+82">+82 KR</SelectItem>
                    <SelectItem value="+61">+61 AU</SelectItem>
                    <SelectItem value="+33">+33 FR</SelectItem>
                    <SelectItem value="+49">+49 DE</SelectItem>
                    <SelectItem value="+7">+7 RU</SelectItem>
                    {/* All other countries in alphabetical order */}
                    {allCountries.map((country) => (
                      <SelectItem key={country.code} value={`+${country.callingCode}`}>
                        +{country.callingCode} {country.code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input 
                  value={formData.whatsappPhoneRaw || ""} 
                  onChange={(e) => setFormData(prev => ({ ...prev, whatsappPhoneRaw: e.target.value }))} 
                  placeholder="Phone number" 
                  className="flex-1"
                  data-testid="input-whatsapp" 
                />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Children</Label>
                <Input type="number" value={formData.numChildren || ""} onChange={(e) => setFormData(prev => ({ ...prev, numChildren: parseInt(e.target.value) || 0 }))} data-testid="input-num-children" />
              </div>
              <div className="space-y-2">
                <Label>Adults</Label>
                <Input type="number" value={formData.numAdults || ""} onChange={(e) => setFormData(prev => ({ ...prev, numAdults: parseInt(e.target.value) || 0 }))} data-testid="input-num-adults" />
              </div>
            </div>

            {/* Payment & Tasks sections only shown when editing, not when creating */}
            {editingEvent && (
              <>
            <div className="space-y-3 pt-4 border-t">
              <Label className="text-base font-medium">Payment Details</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Total Value (THB)</Label>
                  <Input 
                    type="number" 
                    value={formData.totalValue || ""} 
                    onChange={(e) => setFormData(prev => ({ ...prev, totalValue: parseInt(e.target.value) || null }))} 
                    placeholder="e.g., 15000"
                    data-testid="input-total-value" 
                  />
                </div>
                <div className="space-y-2">
                  <Label>Prepayment Amount (THB)</Label>
                  <Input 
                    type="number" 
                    value={formData.prepaymentAmount || ""} 
                    onChange={(e) => setFormData(prev => ({ ...prev, prepaymentAmount: parseInt(e.target.value) || null }))} 
                    placeholder="e.g., 5000"
                    data-testid="input-prepayment-amount" 
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Prepayment Date</Label>
                  <DatePicker 
                    value={formData.prepaymentDate || ""} 
                    onChange={(date) => setFormData(prev => ({ ...prev, prepaymentDate: date || null }))} 
                    data-testid="input-prepayment-date" 
                  />
                </div>
                <div className="space-y-2">
                  <Label>Payment Method</Label>
                  <Select 
                    value={formData.prepaymentMethod || ""} 
                    onValueChange={(value) => setFormData(prev => ({ ...prev, prepaymentMethod: value || null }))}
                  >
                    <SelectTrigger data-testid="select-payment-method">
                      <SelectValue placeholder="Select method" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cash">Cash</SelectItem>
                      <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                      <SelectItem value="credit_card">Credit Card</SelectItem>
                      <SelectItem value="promptpay">PromptPay</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            <div className="space-y-3 pt-4 border-t">
                <div className="flex items-center justify-between">
                  <Label className="flex items-center gap-2">
                    <ClipboardList className="h-4 w-4" />
                    Tasks ({pendingTasks.length})
                    {loadingTasks && <Loader2 className="h-3 w-3 animate-spin" />}
                  </Label>
                  {!showTaskForm && (
                    <Button type="button" size="sm" variant="outline" onClick={() => setShowTaskForm(true)} data-testid="button-add-task">
                      <Plus className="h-4 w-4 mr-1" />
                      Add Task
                    </Button>
                  )}
                </div>

                {pendingTasks.length > 0 && (
                  <div className="space-y-2">
                    {pendingTasks.map((task) => (
                      <div key={task.id} className="flex items-center justify-between gap-2 p-2 bg-muted rounded-md">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium truncate">{task.title}</p>
                            {task.isExisting && <Badge variant="outline" className="text-xs">Saved</Badge>}
                          </div>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span>{task.dueTime}</span>
                            {task.departmentName && <Badge variant="secondary" className="text-xs">{task.departmentName}</Badge>}
                            {task.requiresPhotoEvidence && <Camera className="h-3 w-3" />}
                            {task.requiresQuestionsAnswered && <MessageCircle className="h-3 w-3" />}
                          </div>
                        </div>
                        <Button type="button" size="icon" variant="ghost" onClick={() => removePendingTask(task.id)} data-testid={`button-remove-task-${task.id}`}>
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                {showTaskForm && (
                  <div className="space-y-3 p-3 border rounded-md bg-muted/30">
                    <div className="space-y-2">
                      <Label>Task Title</Label>
                      <Input
                        value={taskTitle}
                        onChange={(e) => setTaskTitle(e.target.value)}
                        placeholder="e.g., Prepare birthday cake"
                        data-testid="input-new-task-title"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Description (optional)</Label>
                      <Textarea
                        value={taskDescription}
                        onChange={(e) => setTaskDescription(e.target.value)}
                        placeholder="Add instructions or details..."
                        className="resize-none"
                        rows={2}
                        data-testid="input-new-task-description"
                      />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label>Due Time</Label>
                        <Input
                          type="time"
                          value={taskDueTime}
                          onChange={(e) => setTaskDueTime(e.target.value)}
                          data-testid="input-new-task-time"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Department</Label>
                        <Select value={taskDepartmentId} onValueChange={setTaskDepartmentId}>
                          <SelectTrigger data-testid="select-task-department">
                            <SelectValue placeholder="None" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">No department</SelectItem>
                            {departments?.map((dept) => (
                              <SelectItem key={dept.id} value={dept.id}>{dept.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="space-y-2 pt-2 border-t">
                      <p className="text-xs font-medium text-muted-foreground">Completion Requirements</p>
                      <div className="flex items-center justify-between">
                        <Label htmlFor="taskPhoto" className="text-sm cursor-pointer">Require photo</Label>
                        <Switch
                          id="taskPhoto"
                          checked={taskRequiresPhoto}
                          onCheckedChange={setTaskRequiresPhoto}
                          data-testid="switch-task-photo"
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label htmlFor="taskQuestions" className="text-sm cursor-pointer">Require answers</Label>
                        <Switch
                          id="taskQuestions"
                          checked={taskRequiresQuestions}
                          onCheckedChange={setTaskRequiresQuestions}
                          data-testid="switch-task-questions"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2 pt-2">
                      <Button type="button" variant="outline" size="sm" className="flex-1" onClick={resetTaskForm}>
                        Cancel
                      </Button>
                      <Button type="button" size="sm" className="flex-1" onClick={addPendingTask} disabled={!taskTitle.trim()} data-testid="button-save-task">
                        Add Task
                      </Button>
                    </div>
                  </div>
                )}
              </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowCreateDialog(false); setEditingEvent(null); setSelectedBranchId(activeBranchId); }}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={createMutation.isPending || updateMutation.isPending} data-testid="button-submit-event">
              {editingEvent ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteEventId} onOpenChange={() => setDeleteEventId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Event?</AlertDialogTitle>
            <AlertDialogDescription>
              This will mark the event as cancelled. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Event</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteEventId && deleteMutation.mutate(deleteEventId)} className="bg-destructive text-destructive-foreground">
              Cancel Event
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AIEventAssistant
        open={showAIAssistant}
        onOpenChange={setShowAIAssistant}
        currentFormData={formData as any}
        onApply={(updates) => {
          setFormData(prev => ({ ...prev, ...updates }));
        }}
        onBranchSelect={(branchId) => setSelectedBranchId(branchId)}
        branchContext={activeBranchId && branches ? {
          branch_id: activeBranchId,
          branch_name: branches.find(b => b.id === activeBranchId)?.name || "",
          timezone: branches.find(b => b.id === activeBranchId)?.timezone,
        } : undefined}
      />

      {/* Type Selector Dialog */}
      <Dialog open={showTypeSelector} onOpenChange={setShowTypeSelector}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>New Event</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2 py-2">
            <Button 
              variant="outline" 
              className="justify-start"
              onClick={() => {
                setShowTypeSelector(false);
                setFormData(defaultFormData);
                setPendingTasks([]);
                resetTaskForm();
                setSelectedBranchId(activeBranchId);
                setShowCreateDialog(true);
              }}
              data-testid="button-create-birthday"
            >
              {EVENT_TYPE_LABELS.birthday}
            </Button>
            <Button 
              variant="outline" 
              className="justify-start"
              onClick={() => {
                setShowTypeSelector(false);
                resetOneOffForm("studio_event");
                setShowOneOffWizard(true);
              }}
              data-testid="button-create-oneoff"
            >
              {EVENT_TYPE_LABELS.studio_event}
            </Button>
            <Button
              variant="outline"
              className="justify-start"
              onClick={() => {
                setShowTypeSelector(false);
                resetOneOffForm("workshop");
                setShowOneOffWizard(true);
              }}
              data-testid="button-create-workshop"
            >
              {EVENT_TYPE_LABELS.workshop}
            </Button>
            <Button 
              variant="outline" 
              className="justify-start"
              onClick={() => {
                setShowTypeSelector(false);
                resetCampForm();
                setShowCampSheet(true);
              }}
              data-testid="button-create-camp"
            >
              {EVENT_TYPE_LABELS.camp}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* One-off Event Sheet - slides in smoothly from the right. Used for both create and edit. */}
      <Sheet open={showOneOffWizard} onOpenChange={(open) => { if (!open) { setShowOneOffWizard(false); setEditingOneOffEvent(null); } }}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader className="text-left">
            <SheetTitle>{editingOneOffEvent ? `Edit ${EVENT_TYPE_LABELS[oneOffEventType]}` : `Create ${EVENT_TYPE_LABELS[oneOffEventType]}`}</SheetTitle>
            <SheetDescription>
              {editingOneOffEvent
                ? "Update the event details below."
                : "Fill in the event details below. You can add bookings after the event is created."}
            </SheetDescription>
          </SheetHeader>

          {editingOneOffEvent && (
            <div className="flex gap-2 py-2 border-b mb-2 flex-wrap">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const isArchived = (editingOneOffEvent as any).isArchived;
                  archiveMutation.mutate({ id: editingOneOffEvent.id, archived: !isArchived });
                  setShowOneOffWizard(false);
                  setEditingOneOffEvent(null);
                  setViewingStudioEvent(null);
                }}
                data-testid="button-archive-oneoff-event"
              >
                {(editingOneOffEvent as any).isArchived ? <ArchiveRestore className="h-4 w-4 mr-2" /> : <Archive className="h-4 w-4 mr-2" />}
                {(editingOneOffEvent as any).isArchived ? "Restore" : "Archive"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => {
                  setDeleteEventId(editingOneOffEvent.id);
                  setShowOneOffWizard(false);
                  setEditingOneOffEvent(null);
                  setViewingStudioEvent(null);
                }}
                data-testid="button-delete-oneoff-event"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete
              </Button>
            </div>
          )}

          <div className="space-y-6">
            {/* Basic Details */}
            <div className="space-y-4">
              {branches && branches.length > 1 && (
                <div className="space-y-2">
                  <Label>Branch <span className="text-destructive">*</span></Label>
                  <Select value={oneOffFormData.branchId || ""} onValueChange={(v) => setOneOffFormData(prev => ({ ...prev, branchId: v }))}>
                    <SelectTrigger data-testid="select-oneoff-branch"><SelectValue placeholder="Select branch" /></SelectTrigger>
                    <SelectContent>{branches?.map((b) => (<SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>))}</SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-2">
                <Label>Event Name <span className="text-destructive">*</span></Label>
                <Input 
                  value={oneOffFormData.title} 
                  onChange={(e) => setOneOffFormData(prev => ({ ...prev, title: e.target.value }))} 
                  placeholder="e.g., Company Team Building"
                  data-testid="input-oneoff-title"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Date <span className="text-destructive">*</span></Label>
                  <DatePicker 
                    value={oneOffFormData.eventDate} 
                    onChange={(date) => setOneOffFormData(prev => ({ ...prev, eventDate: date }))}
                    data-testid="input-oneoff-date"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Start Time <span className="text-destructive">*</span></Label>
                  <Input 
                    type="time" 
                    value={oneOffFormData.startTime} 
                    onChange={(e) => setOneOffFormData(prev => ({ ...prev, startTime: e.target.value }))}
                    data-testid="input-oneoff-start"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>End Time <span className="text-muted-foreground font-normal">(Optional)</span></Label>
                  <Input 
                    type="time" 
                    value={oneOffFormData.endTime} 
                    onChange={(e) => setOneOffFormData(prev => ({ ...prev, endTime: e.target.value }))}
                    data-testid="input-oneoff-end"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Location <span className="text-muted-foreground font-normal">(Optional)</span></Label>
                  <Input 
                    value={oneOffFormData.location} 
                    onChange={(e) => setOneOffFormData(prev => ({ ...prev, location: e.target.value }))}
                    placeholder="e.g., Main Hall"
                    data-testid="input-oneoff-location"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Description <span className="text-muted-foreground font-normal">(Optional)</span></Label>
                <Textarea 
                  value={oneOffFormData.description} 
                  onChange={(e) => setOneOffFormData(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="Additional details about the event"
                  className="resize-none"
                  rows={2}
                  data-testid="input-oneoff-description"
                />
              </div>
              {oneOffEventType === "studio_event" && (
              <div className="space-y-2">
                <Label>Calendar Color</Label>
                <div className="flex flex-wrap gap-2" data-testid="picker-oneoff-color">
                  {ONE_OFF_EVENT_COLOR_OPTIONS.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      title={c.label}
                      aria-label={c.label}
                      onClick={() => setOneOffFormData(prev => ({ ...prev, color: c.value }))}
                      className={`h-7 w-7 rounded-full border-2 transition-transform ${
                        oneOffFormData.color === c.value ? "border-foreground scale-110" : "border-transparent"
                      }`}
                      style={{ backgroundColor: c.value }}
                      data-testid={`button-oneoff-color-${c.label.toLowerCase()}`}
                    />
                  ))}
                </div>
              </div>
              )}
            </div>

            {/* Additional Info Fields (F&B, etc.) */}
            <div className="space-y-3 border-t pt-4">
              <div className="flex items-center justify-between">
                <Label className="text-base">Additional Info</Label>
                {!showInfoFieldForm && (
                  <Button 
                    type="button" 
                    variant="outline" 
                    size="sm" 
                    onClick={() => setShowInfoFieldForm(true)}
                    data-testid="button-add-info-field"
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Add Info
                  </Button>
                )}
              </div>
              
              {oneOffInfoFields.map((field, index) => (
                <div key={field.id} className="flex items-start gap-2 p-3 border rounded-md bg-muted/30" data-testid={`card-info-field-${index}`}>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium" data-testid={`text-info-field-title-${index}`}>{field.title}</div>
                    {field.description && <div className="text-sm text-muted-foreground mt-1" data-testid={`text-info-field-desc-${index}`}>{field.description}</div>}
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-destructive shrink-0"
                    onClick={() => setOneOffInfoFields(prev => prev.filter((_, i) => i !== index))}
                    data-testid={`button-delete-info-field-${index}`}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}

              {showInfoFieldForm && (
                <div className="p-3 border rounded-md space-y-3 bg-muted/20">
                  <div className="space-y-2">
                    <Label>Info Title</Label>
                    <Input
                      value={infoFieldTitle}
                      onChange={(e) => setInfoFieldTitle(e.target.value)}
                      placeholder="e.g., F&B Requirements"
                      data-testid="input-info-title"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Description</Label>
                    <Textarea
                      value={infoFieldDescription}
                      onChange={(e) => setInfoFieldDescription(e.target.value)}
                      placeholder="Details about this info..."
                      className="resize-none"
                      rows={2}
                      data-testid="input-info-description"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" className="flex-1" onClick={resetInfoFieldForm} data-testid="button-cancel-info-field">
                      Cancel
                    </Button>
                    <Button type="button" size="sm" className="flex-1" onClick={addInfoField} disabled={!infoFieldTitle.trim()} data-testid="button-save-info-field">
                      Add
                    </Button>
                  </div>
                </div>
              )}
            </div>

          </div>

          <SheetFooter className="gap-2 pt-4">
            <Button variant="outline" onClick={() => { setShowOneOffWizard(false); setEditingOneOffEvent(null); }} data-testid="button-cancel-oneoff-event">
              Cancel
            </Button>
            <Button 
              disabled={!oneOffFormData.title.trim() || savingOneOffEvent}
              data-testid="button-create-oneoff-event"
              onClick={async () => {
                setSavingOneOffEvent(true);
                try {
                  const eventPayload = {
                    eventType: oneOffEventType,
                    title: oneOffFormData.title,
                    eventDate: oneOffFormData.eventDate,
                    startTime: oneOffFormData.startTime,
                    endTime: oneOffFormData.endTime || null,
                    branchId: oneOffFormData.branchId || activeBranchId,
                    ...(oneOffEventType === "studio_event" ? { color: oneOffFormData.color || DEFAULT_ONE_OFF_EVENT_COLOR } : {}),
                  };

                  let savedEvent: Event;
                  if (editingOneOffEvent) {
                    const eventRes = await apiRequest("PATCH", `/api/admin/events/${editingOneOffEvent.id}`, eventPayload);
                    savedEvent = await eventRes.json();
                  } else {
                    const eventRes = await apiRequest("POST", "/api/admin/events", { ...eventPayload, status: "upcoming" });
                    savedEvent = await eventRes.json();
                  }

                  // Save studio details including custom info fields
                  await apiRequest("PUT", `/api/events/${savedEvent.id}/studio-details`, {
                    description: oneOffFormData.description || null,
                    location: oneOffFormData.location || null,
                    maxParticipants: oneOffFormData.maxParticipants,
                    customInfo: oneOffInfoFields.length > 0 ? oneOffInfoFields : null,
                  });


                  queryClient.invalidateQueries({ predicate: (query) =>
                    Array.isArray(query.queryKey) && (query.queryKey[0] === "/api/admin/events" || query.queryKey[0] === "/api/events")
                  });
                  if (savedEvent.branchId && activeBranchId) setActiveBranchId(savedEvent.branchId);
                  setShowOneOffWizard(false);
                  setEditingOneOffEvent(null);
                  toast({ title: editingOneOffEvent ? "Event updated successfully" : "Event created successfully" });

                  // Open the view dialog so user can add bookings / see the updated details
                  openStudioEventView(savedEvent);
                } catch (error) {
                  toast({ title: editingOneOffEvent ? "Failed to update event" : "Failed to create event", variant: "destructive" });
                } finally {
                  setSavingOneOffEvent(false);
                }
              }}
            >
              {editingOneOffEvent ? "Save Changes" : "Create Event"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Camp Quick View Dialog */}
      <Dialog open={!!campQuickView} onOpenChange={(open) => { if (!open) setCampQuickView(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="inline-block w-3 h-3 rounded-full bg-teal-500 flex-shrink-0" />
              {campQuickView?.title}
            </DialogTitle>
          </DialogHeader>
          {campQuickView && (() => {
            const ev = campQuickView;
            const campEnd = (ev as any).campEndDate;
            const branchName = branches?.find((b: any) => b.id === ev.branchId)?.name;
            const formatT = (t: string) => {
              if (!t) return null;
              const [h, m] = t.split(":").map(Number);
              const ampm = h >= 12 ? "PM" : "AM";
              const h12 = h % 12 || 12;
              return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
            };
            const todayStr = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
            const campEndStr = campEnd || ev.eventDate;
            const isCampDay = todayStr >= ev.eventDate && todayStr <= campEndStr;
            const regCount = isCampDay
              ? campQuickViewRegs.filter((r: any) => {
                  const days = r.attendanceDays;
                  if (!Array.isArray(days) || days.length === 0) return true;
                  return days.includes(todayStr);
                }).length
              : campQuickViewRegs.length;
            const regLabel = isCampDay ? "Registered Today" : "Total Registered";
            return (
              <div className="space-y-3 text-sm">
                {branchName && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <MapPin className="h-4 w-4 flex-shrink-0" />
                    <span>{branchName}</span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span>
                    {format(parseISO(ev.eventDate), "d MMM yyyy")}
                    {campEnd && campEnd !== ev.eventDate && (
                      <> → {format(parseISO(campEnd), "d MMM yyyy")}</>
                    )}
                  </span>
                </div>
                {(ev.startTime || ev.endTime) && (
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <span>
                      {formatT(ev.startTime)}
                      {ev.endTime ? ` – ${formatT(ev.endTime)}` : ""} daily
                    </span>
                  </div>
                )}
                {(() => {
                  const dayHosts = (ev as any).campDayHosts as Record<string, string> | null | undefined;
                  const hasPerDay = dayHosts && Object.values(dayHosts).some(v => v?.trim());
                  if (hasPerDay) {
                    return (
                      <div className="flex items-start gap-2">
                        <Users className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                        <div className="space-y-0.5">
                          {Object.entries(dayHosts!).filter(([, v]) => v?.trim()).map(([date, host]) => (
                            <div key={date} className="text-sm">
                              <span className="text-muted-foreground">{format(parseISO(date), "EEE, d MMM")}: </span>
                              <span>{host}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  }
                  if (ev.programName) {
                    return (
                      <div className="flex items-center gap-2">
                        <Users className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        <span>{ev.programName}</span>
                      </div>
                    );
                  }
                  return null;
                })()}
                <div className="flex items-center gap-2">
                  <Baby className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span>{regLabel}: <strong>{regCount}</strong></span>
                </div>
                {ev.specialRequests && (
                  <div className="rounded-md bg-muted px-3 py-2 text-muted-foreground text-xs leading-relaxed">
                    {ev.specialRequests}
                  </div>
                )}
              </div>
            );
          })()}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setCampQuickView(null)}>
              Close
            </Button>
            <Button onClick={() => { const ev = campQuickView; setCampQuickView(null); if (ev) navigate(`/studio/events/camp/${ev.id}`); }}>
              <Pencil className="h-4 w-4 mr-1" />
              Open Details
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Camp Event Creation / Edit Sheet */}
      <Sheet open={showCampSheet} onOpenChange={(open) => { if (!open) { setShowCampSheet(false); setEditingCampEvent(null); setShowCampStartCal(false); setShowCampEndCal(false); } }}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto" onInteractOutside={(e) => e.preventDefault()}>
          <SheetHeader className="text-left">
            <SheetTitle>{editingCampEvent ? "Edit Camp Event" : "Create Camp Event"}</SheetTitle>
            <SheetDescription>
              Camp events appear on the calendar across their full date range.
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-5 py-4">
            {/* Branch */}
            {branches && branches.length > 1 && (
              <div className="space-y-2">
                <Label>Branch <span className="text-destructive">*</span></Label>
                <Select
                  value={campFormData.branchId || ""}
                  onValueChange={(v) => setCampFormData(prev => ({ ...prev, branchId: v }))}
                >
                  <SelectTrigger data-testid="select-camp-branch">
                    <SelectValue placeholder="Select branch" />
                  </SelectTrigger>
                  <SelectContent>
                    {branches.map((b) => (
                      <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Camp Name */}
            <div className="space-y-2">
              <Label>Camp Name <span className="text-destructive">*</span></Label>
              <Input
                value={campFormData.title}
                onChange={(e) => setCampFormData(prev => ({ ...prev, title: e.target.value }))}
                placeholder="e.g., Summer Art Camp"
                data-testid="input-camp-title"
              />
            </div>

            {/* Start Date / End Date — inline calendars (no popup/OS picker) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Start Date <span className="text-destructive">*</span></Label>
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-md border border-input bg-background text-sm hover:bg-accent transition-colors"
                  onClick={() => { setShowCampStartCal(v => !v); setShowCampEndCal(false); }}
                  data-testid="input-camp-start-date"
                >
                  <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span>{campFormData.eventDate ? format(parseISO(campFormData.eventDate), "dd MMM yyyy") : "Pick date"}</span>
                </button>
                {showCampStartCal && (
                  <div className="border rounded-md min-w-[280px] w-fit">
                    <CalendarComponent
                      mode="single"
                      selected={campFormData.eventDate ? parseISO(campFormData.eventDate) : undefined}
                      onSelect={(date) => {
                        if (date) {
                          const ds = format(date, "yyyy-MM-dd");
                          setCampFormData(prev => ({
                            ...prev,
                            eventDate: ds,
                            campEndDate: prev.campEndDate < ds ? ds : prev.campEndDate,
                          }));
                          setShowCampStartCal(false);
                        }
                      }}
                      initialFocus={false}
                    />
                  </div>
                )}
              </div>
              <div className="space-y-1">
                <Label>End Date <span className="text-destructive">*</span></Label>
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-md border border-input bg-background text-sm hover:bg-accent transition-colors"
                  onClick={() => { setShowCampEndCal(v => !v); setShowCampStartCal(false); }}
                  data-testid="input-camp-end-date"
                >
                  <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span>{campFormData.campEndDate ? format(parseISO(campFormData.campEndDate), "dd MMM yyyy") : "Pick date"}</span>
                </button>
                {showCampEndCal && (
                  <div className="border rounded-md min-w-[280px] w-fit">
                    <CalendarComponent
                      mode="single"
                      selected={campFormData.campEndDate ? parseISO(campFormData.campEndDate) : undefined}
                      defaultMonth={campFormData.campEndDate ? parseISO(campFormData.campEndDate) : undefined}
                      disabled={(date) => campFormData.eventDate ? date < parseISO(campFormData.eventDate) : false}
                      onSelect={(date) => {
                        if (date) {
                          setCampFormData(prev => ({ ...prev, campEndDate: format(date, "yyyy-MM-dd") }));
                          setShowCampEndCal(false);
                        }
                      }}
                      initialFocus={false}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Daily Times */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Daily Start Time <span className="text-destructive">*</span></Label>
                <Input
                  type="time"
                  value={campFormData.startTime}
                  onChange={(e) => setCampFormData(prev => ({ ...prev, startTime: e.target.value }))}
                  data-testid="input-camp-start-time"
                />
              </div>
              <div className="space-y-2">
                <Label>Daily End Time</Label>
                <Input
                  type="time"
                  value={campFormData.endTime}
                  onChange={(e) => setCampFormData(prev => ({ ...prev, endTime: e.target.value }))}
                  data-testid="input-camp-end-time"
                />
              </div>
            </div>

            {/* Camp Hosts — per-day assignment */}
            <div className="space-y-2">
              <Label>Camp Hosts</Label>
              <p className="text-xs text-muted-foreground">Assign one or more hosts for each day of the camp</p>
              {(() => {
                try {
                  const days = eachDayOfInterval({
                    start: parseISO(campFormData.eventDate),
                    end: parseISO(campFormData.campEndDate),
                  });
                  return (
                    <div className="space-y-2">
                      {days.map((day) => {
                        const dateKey = format(day, "yyyy-MM-dd");
                        const dayLabel = format(day, "EEE, d MMM");
                        return (
                          <div key={dateKey} className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground w-24 flex-shrink-0">{dayLabel}</span>
                            <HostPickerPopover
                              employees={allEmployees}
                              value={campFormData.campDayHosts[dateKey] || ""}
                              onChange={(val) => setCampFormData(prev => ({
                                ...prev,
                                campDayHosts: { ...prev.campDayHosts, [dateKey]: val },
                              }))}
                            />
                          </div>
                        );
                      })}
                    </div>
                  );
                } catch {
                  return <p className="text-xs text-muted-foreground">Set start and end dates to assign hosts.</p>;
                }
              })()}
            </div>

            {/* Notes */}
            <div className="space-y-2">
              <Label>Additional Information / Notes</Label>
              <Textarea
                value={campFormData.specialRequests}
                onChange={(e) => setCampFormData(prev => ({ ...prev, specialRequests: e.target.value }))}
                placeholder="Any details about the camp, schedule, requirements..."
                className="resize-none"
                rows={3}
                data-testid="input-camp-notes"
              />
            </div>
          </div>

          <SheetFooter className="gap-2 pt-2 flex-col sm:flex-row">
            {editingCampEvent && (
              <Button
                variant="destructive"
                className="sm:mr-auto"
                data-testid="button-delete-camp"
                onClick={async () => {
                  if (!confirm(`Delete "${editingCampEvent.title}"? This cannot be undone.`)) return;
                  try {
                    await apiRequest("DELETE", `/api/admin/events/${editingCampEvent.id}`);
                    toast({ title: "Camp event deleted" });
                    queryClient.invalidateQueries({ predicate: (query) =>
                      Array.isArray(query.queryKey) && (query.queryKey[0] === "/api/admin/events" || query.queryKey[0] === "/api/events")
                    });
                    setShowCampSheet(false);
                    setEditingCampEvent(null);
                  } catch {
                    toast({ title: "Failed to delete camp event", variant: "destructive" });
                  }
                }}
              >
                <Trash2 className="h-4 w-4 mr-1" /> Delete Camp
              </Button>
            )}
            <Button variant="outline" onClick={() => { setShowCampSheet(false); setEditingCampEvent(null); }} data-testid="button-cancel-camp">
              Cancel
            </Button>
            <Button
              disabled={!campFormData.title.trim() || !campFormData.eventDate || !campFormData.campEndDate}
              data-testid="button-create-camp-event"
              onClick={async () => {
                try {
                  const payload = {
                    eventType: "camp",
                    title: campFormData.title.trim(),
                    eventDate: campFormData.eventDate,
                    campEndDate: campFormData.campEndDate,
                    startTime: campFormData.startTime,
                    endTime: campFormData.endTime || null,
                    programName: campFormData.programName.trim() || null,
                    specialRequests: campFormData.specialRequests.trim() || null,
                    numChildren: campFormData.numChildren,
                    branchId: campFormData.branchId || activeBranchId,
                    campDayHosts: campFormData.campDayHosts,
                  };
                  if (editingCampEvent) {
                    await apiRequest("PATCH", `/api/admin/events/${editingCampEvent.id}`, payload);
                    toast({ title: "Camp event updated" });
                  } else {
                    await apiRequest("POST", "/api/admin/events", { ...payload, status: "upcoming" });
                    toast({ title: "Camp event created" });
                  }
                  queryClient.invalidateQueries({ predicate: (query) =>
                    Array.isArray(query.queryKey) && (query.queryKey[0] === "/api/admin/events" || query.queryKey[0] === "/api/events")
                  });
                  setShowCampSheet(false);
                  setEditingCampEvent(null);
                } catch {
                  toast({ title: editingCampEvent ? "Failed to update camp event" : "Failed to create camp event", variant: "destructive" });
                }
              }}
            >
              {editingCampEvent ? "Save Changes" : "Create Camp"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Studio Event View/Manage Dialog - only show for studio events, not when BEO editor or one-off edit sheet is open */}
      <Dialog open={!!viewingStudioEvent && !showBeoEditor && !showBeoDayOf && !(showOneOffWizard && !!editingOneOffEvent)} onOpenChange={(open) => { if (!open) { setViewingStudioEvent(null); setStudioEventDetails(null); setStudioEventTasks([]); setStudioEventBookings([]); } }}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{viewingStudioEvent?.title}</DialogTitle>
            <DialogDescription>
              {viewingStudioEvent && format(parseISO(viewingStudioEvent.eventDate), "d MMMM yyyy")} at {viewingStudioEvent?.startTime}
              {viewingStudioEvent?.endTime && ` - ${viewingStudioEvent.endTime}`}
            </DialogDescription>
          </DialogHeader>

          {/* Quick Actions - Always visible at top */}
          <div className="flex gap-2 py-2 border-b">
            <Button 
              variant="default" 
              size="sm"
              onClick={() => viewingStudioEvent && openOneOffEditor(viewingStudioEvent)}
              data-testid="button-open-beo-editor-top"
            >
              <Pencil className="h-4 w-4 mr-2" />
              Edit
            </Button>
            <Button 
              variant="secondary" 
              size="sm"
              onClick={() => setShowBeoDayOf(true)}
              data-testid="button-open-day-of-top"
            >
              <ClipboardList className="h-4 w-4 mr-2" />
              Day-of View
            </Button>
          </div>

          {loadingStudioData ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : (
            <div className="space-y-6">
              {/* Event Details */}
              {studioEventDetails && (
                <div className="space-y-2">
                  {studioEventDetails.location && (
                    <p className="text-sm"><span className="text-muted-foreground">Location:</span> {studioEventDetails.location}</p>
                  )}
                  {studioEventDetails.description && (
                    <p className="text-sm text-muted-foreground">{studioEventDetails.description}</p>
                  )}
                  {studioEventDetails.maxParticipants && (
                    <p className="text-sm"><span className="text-muted-foreground">Max Participants:</span> {studioEventDetails.maxParticipants}</p>
                  )}
                  {/* Custom Info Fields */}
                  {studioEventDetails.customInfo && Array.isArray(studioEventDetails.customInfo) && studioEventDetails.customInfo.length > 0 && (
                    <div className="space-y-2 pt-2 border-t">
                      {(studioEventDetails.customInfo as Array<{title: string; description: string}>).map((info, index) => (
                        <div key={index} className="p-2 border rounded-md bg-muted/30">
                          <div className="text-sm font-medium">{info.title}</div>
                          {info.description && <div className="text-sm text-muted-foreground">{info.description}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Guest List Section */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-medium text-sm">
                    Guest List ({bookingStats.arrived}/{bookingStats.totalBookings} arrived)
                  </h4>
                  <Button size="sm" variant="outline" onClick={openAddBooking} data-testid="button-add-booking">
                    <Plus className="h-4 w-4 mr-1" />
                    Add
                  </Button>
                </div>
                
                {/* Summary Stats */}
                {studioEventBookings.length > 0 && (
                  <div className="grid grid-cols-3 gap-2 p-3 border rounded-md bg-muted/20">
                    <div className="text-center">
                      <p className="text-lg font-semibold">{bookingStats.totalAdults}</p>
                      <p className="text-xs text-muted-foreground">Adults</p>
                    </div>
                    <div className="text-center">
                      <p className="text-lg font-semibold">{bookingStats.totalKids}</p>
                      <p className="text-xs text-muted-foreground">Kids</p>
                    </div>
                    <div className="text-center">
                      <p className="text-lg font-semibold">{bookingStats.totalAdults + bookingStats.totalKids}</p>
                      <p className="text-xs text-muted-foreground">Total Guests</p>
                    </div>
                    {bookingStats.totalCost > 0 && (
                      <>
                        <div className="text-center">
                          <p className="text-lg font-semibold">{bookingStats.totalCost.toLocaleString()}</p>
                          <p className="text-xs text-muted-foreground">Total (THB)</p>
                        </div>
                        <div className="text-center">
                          <p className="text-lg font-semibold text-green-600">{bookingStats.totalPaid.toLocaleString()}</p>
                          <p className="text-xs text-muted-foreground">Paid</p>
                        </div>
                        <div className="text-center">
                          <p className={`text-lg font-semibold ${totalOutstanding > 0 ? "text-orange-600" : "text-green-600"}`}>
                            {totalOutstanding.toLocaleString()}
                          </p>
                          <p className="text-xs text-muted-foreground">Outstanding</p>
                        </div>
                      </>
                    )}
                  </div>
                )}
                
                {/* Booking List */}
                {studioEventBookings.length > 0 ? (
                  <div className="space-y-2">
                    {studioEventBookings.map((booking) => {
                      const outstanding = (booking.amountTotal || 0) - (booking.amountPaid || 0);
                      return (
                        <div 
                          key={booking.id} 
                          className={`p-3 border rounded-md ${booking.arrived ? "bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800" : ""}`}
                          data-testid={`card-booking-${booking.id}`}
                        >
                          <div className="flex items-start gap-3">
                            <Switch
                              checked={booking.arrived}
                              onCheckedChange={() => toggleBookingArrival(booking.id, booking.arrived)}
                              data-testid={`switch-checkin-${booking.id}`}
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <div className="text-sm font-medium flex items-center gap-2">
                                  {booking.bookingName || booking.name}
                                  {booking.arrived && <Check className="h-3 w-3 text-green-600" />}
                                </div>
                                <div className="flex items-center gap-1">
                                  <Button 
                                    size="icon" 
                                    variant="ghost" 
                                    className="h-7 w-7"
                                    onClick={() => openEditBooking(booking)}
                                    data-testid={`button-edit-booking-${booking.id}`}
                                  >
                                    <Pencil className="h-3 w-3" />
                                  </Button>
                                  <Button 
                                    size="icon" 
                                    variant="ghost" 
                                    className="h-7 w-7 text-destructive"
                                    onClick={() => deleteBooking(booking.id)}
                                    data-testid={`button-delete-booking-${booking.id}`}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              </div>
                              <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                                <div className="flex items-center gap-3 flex-wrap">
                                  {(booking.adultsCount > 0 || booking.kidsCount > 0) && (
                                    <span>{booking.adultsCount || 0} adults, {booking.kidsCount || 0} kids</span>
                                  )}
                                  {booking.whatsappPhone && <span>{booking.whatsappPhone}</span>}
                                </div>
                                {booking.amountTotal > 0 && (
                                  <div className="flex items-center gap-3">
                                    <span>Total: {booking.amountTotal?.toLocaleString()} THB</span>
                                    <span className="text-green-600">Paid: {booking.amountPaid?.toLocaleString()}</span>
                                    {outstanding > 0 && <span className="text-orange-600">Due: {outstanding.toLocaleString()}</span>}
                                  </div>
                                )}
                                {booking.posReference && <div>POS: {booking.posReference}</div>}
                              </div>
                              {booking.arrivedAt && (
                                <div className="text-xs text-green-600 mt-1">
                                  Arrived at {format(new Date(booking.arrivedAt), "h:mm a")}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">No bookings yet. Click Add to add guests.</p>
                )}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setViewingStudioEvent(null)} data-testid="button-close-studio-event-view">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* BEO Editor Sheet - used for Birthday / Private Event only */}
      <Sheet open={showBeoEditor} onOpenChange={(open) => { if (!open) { setShowBeoEditor(false); setViewingStudioEvent(null); setStudioEventDetails(null); setStudioEventTasks([]); setStudioEventBookings([]); } else { setShowBeoEditor(true); } }}>
        <SheetContent side="right" className="w-full sm:max-w-2xl p-0 overflow-hidden">
          {viewingStudioEvent && (
            <BeoEventEditor
              eventId={viewingStudioEvent.id}
              onClose={() => { setShowBeoEditor(false); setViewingStudioEvent(null); setStudioEventDetails(null); setStudioEventTasks([]); setStudioEventBookings([]); }}
              onSave={() => {
                queryClient.invalidateQueries({ queryKey: ["/api/admin/events"] });
              }}
            />
          )}
        </SheetContent>
      </Sheet>

      {/* BEO Day-of View Sheet */}
      <Sheet open={showBeoDayOf} onOpenChange={(open) => { if (!open) { setShowBeoDayOf(false); setViewingStudioEvent(null); setStudioEventDetails(null); setStudioEventTasks([]); setStudioEventBookings([]); } else { setShowBeoDayOf(true); } }}>
        <SheetContent side="right" className="w-full sm:max-w-md p-0 overflow-hidden">
          {viewingStudioEvent && (
            <BeoDayOfView
              eventId={viewingStudioEvent.id}
              onClose={() => { setShowBeoDayOf(false); setViewingStudioEvent(null); setStudioEventDetails(null); setStudioEventTasks([]); setStudioEventBookings([]); }}
            />
          )}
        </SheetContent>
      </Sheet>

      {/* Booking Form Sheet */}
      <Sheet open={showBookingSheet} onOpenChange={setShowBookingSheet}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader className="text-left">
            <SheetTitle>{editingBooking ? "Edit Booking" : "Add Booking"}</SheetTitle>
            <SheetDescription>
              {editingBooking ? "Update the booking details below." : "Enter the booking details for this event."}
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-6 py-4">
            {/* Identity */}
            <div className="space-y-4">
              <h4 className="font-medium text-sm text-muted-foreground">Identity</h4>
              <div className="space-y-2">
                <Label htmlFor="bookingName">Booking / Parent Name *</Label>
                <Input
                  id="bookingName"
                  value={bookingFormData.bookingName}
                  onChange={(e) => setBookingFormData(prev => ({ ...prev, bookingName: e.target.value }))}
                  placeholder="Primary contact name"
                  data-testid="input-booking-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="adultNames">Adult Names</Label>
                <Textarea
                  id="adultNames"
                  value={bookingFormData.adultNames}
                  onChange={(e) => setBookingFormData(prev => ({ ...prev, adultNames: e.target.value }))}
                  placeholder="List all adult names (one per line)"
                  className="resize-none"
                  rows={2}
                  data-testid="input-adult-names"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="kidNames">Kids Names</Label>
                <Textarea
                  id="kidNames"
                  value={bookingFormData.kidNames}
                  onChange={(e) => setBookingFormData(prev => ({ ...prev, kidNames: e.target.value }))}
                  placeholder="List all kids names (one per line)"
                  className="resize-none"
                  rows={2}
                  data-testid="input-kid-names"
                />
              </div>
            </div>

            {/* Counts */}
            <div className="space-y-4">
              <h4 className="font-medium text-sm text-muted-foreground">Guest Counts</h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="adultsCount">Number of Adults</Label>
                  <Input
                    id="adultsCount"
                    type="number"
                    min="0"
                    value={bookingFormData.adultsCount}
                    onChange={(e) => setBookingFormData(prev => ({ ...prev, adultsCount: parseInt(e.target.value) || 0 }))}
                    data-testid="input-adults-count"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="kidsCount">Number of Kids</Label>
                  <Input
                    id="kidsCount"
                    type="number"
                    min="0"
                    value={bookingFormData.kidsCount}
                    onChange={(e) => setBookingFormData(prev => ({ ...prev, kidsCount: parseInt(e.target.value) || 0 }))}
                    data-testid="input-kids-count"
                  />
                </div>
              </div>
            </div>

            {/* Financials */}
            <div className="space-y-4">
              <h4 className="font-medium text-sm text-muted-foreground">Payment</h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="amountTotal">Total Cost (THB)</Label>
                  <Input
                    id="amountTotal"
                    type="number"
                    min="0"
                    value={bookingFormData.amountTotal}
                    onChange={(e) => setBookingFormData(prev => ({ ...prev, amountTotal: parseFloat(e.target.value) || 0 }))}
                    data-testid="input-amount-total"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="amountPaid">Deposit Paid (THB)</Label>
                  <Input
                    id="amountPaid"
                    type="number"
                    min="0"
                    max={bookingFormData.amountTotal}
                    value={bookingFormData.amountPaid}
                    onChange={(e) => setBookingFormData(prev => ({ ...prev, amountPaid: Math.min(parseFloat(e.target.value) || 0, prev.amountTotal) }))}
                    data-testid="input-amount-paid"
                  />
                </div>
              </div>
              <div className="p-3 bg-muted/20 rounded-md">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Outstanding:</span>
                  <span className={`font-medium ${(bookingFormData.amountTotal - bookingFormData.amountPaid) > 0 ? "text-orange-600" : "text-green-600"}`}>
                    {(bookingFormData.amountTotal - bookingFormData.amountPaid).toLocaleString()} THB
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="paymentMethod">Payment Method</Label>
                  <Select
                    value={bookingFormData.paymentMethod}
                    onValueChange={(value) => setBookingFormData(prev => ({ ...prev, paymentMethod: value }))}
                  >
                    <SelectTrigger data-testid="select-payment-method">
                      <SelectValue placeholder="Select method" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="qr_online">QR Online</SelectItem>
                      <SelectItem value="qr_offline">QR Offline</SelectItem>
                      <SelectItem value="cash">Cash</SelectItem>
                      <SelectItem value="card">Card</SelectItem>
                      <SelectItem value="transfer">Bank Transfer</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="paymentDate">Payment Date</Label>
                  <DatePicker
                    value={bookingFormData.paymentDate}
                    onChange={(date) => setBookingFormData(prev => ({ ...prev, paymentDate: date }))}
                    data-testid="input-payment-date"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="posReference">POS Order Reference</Label>
                <Input
                  id="posReference"
                  value={bookingFormData.posReference}
                  onChange={(e) => setBookingFormData(prev => ({ ...prev, posReference: e.target.value }))}
                  placeholder="e.g., POS-12345"
                  data-testid="input-pos-reference"
                />
              </div>
            </div>

            {/* Source & Contact */}
            <div className="space-y-4">
              <h4 className="font-medium text-sm text-muted-foreground">Source & Contact</h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="sourceChannel">Booking Source</Label>
                  <Select
                    value={bookingFormData.sourceChannel}
                    onValueChange={(value) => setBookingFormData(prev => ({ ...prev, sourceChannel: value }))}
                  >
                    <SelectTrigger data-testid="select-source-channel">
                      <SelectValue placeholder="Select source" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="whatsapp">WhatsApp</SelectItem>
                      <SelectItem value="instagram">Instagram</SelectItem>
                      <SelectItem value="telegram">Telegram</SelectItem>
                      <SelectItem value="walkin">Walk-in</SelectItem>
                      <SelectItem value="phone">Phone</SelectItem>
                      <SelectItem value="website">Website</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="whatsappPhone">WhatsApp Phone</Label>
                  <Input
                    id="whatsappPhone"
                    value={bookingFormData.whatsappPhone}
                    onChange={(e) => setBookingFormData(prev => ({ ...prev, whatsappPhone: e.target.value }))}
                    placeholder="+66..."
                    data-testid="input-whatsapp-phone"
                  />
                </div>
              </div>
            </div>

            {/* Notes */}
            <div className="space-y-2">
              <Label htmlFor="internalNotes">Internal Notes</Label>
              <Textarea
                id="internalNotes"
                value={bookingFormData.internalNotes}
                onChange={(e) => setBookingFormData(prev => ({ ...prev, internalNotes: e.target.value }))}
                placeholder="Notes for staff (not visible to guests)"
                className="resize-none"
                rows={3}
                data-testid="input-internal-notes"
              />
            </div>
          </div>

          <SheetFooter className="gap-2 pt-4">
            <Button variant="outline" onClick={() => setShowBookingSheet(false)} data-testid="button-cancel-booking">
              Cancel
            </Button>
            <Button 
              onClick={saveBooking} 
              disabled={!bookingFormData.bookingName.trim() || savingBooking}
              data-testid="button-save-booking"
            >
              {savingBooking && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editingBooking ? "Update" : "Add"} Booking
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

    </LayoutWrapper>
  );
}

// ─── Host Picker Popover ──────────────────────────────────────────────────────
// Allows selecting one or multiple employees as hosts for a camp day.
// Stores selections as a comma-separated string (backward-compatible with existing campDayHosts data).
function HostPickerPopover({
  employees,
  value,
  onChange,
}: {
  employees: any[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const selectedNames = value ? value.split(",").map((n) => n.trim()).filter(Boolean) : [];

  const activeEmployees = employees.filter(
    (e: any) => e.employmentState === "ACTIVE" || e.status === "active"
  );
  const filtered = activeEmployees.filter(
    (e: any) =>
      e.fullName?.toLowerCase().includes(search.toLowerCase()) ||
      e.nickname?.toLowerCase().includes(search.toLowerCase())
  );

  const toggleEmployee = (fullName: string) => {
    const current = new Set(selectedNames);
    if (current.has(fullName)) {
      current.delete(fullName);
    } else {
      current.add(fullName);
    }
    onChange(Array.from(current).join(", "));
  };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch(""); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex-1 flex items-center gap-2 h-8 px-3 rounded-md border border-input bg-background text-sm hover:bg-accent transition-colors text-left min-w-0"
        >
          {selectedNames.length > 0 ? (
            <span className="truncate">{selectedNames.join(", ")}</span>
          ) : (
            <span className="text-muted-foreground">Select host…</span>
          )}
          <ChevronDown className="h-3 w-3 ml-auto flex-shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="p-2 border-b">
          <Input
            placeholder="Search employees…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-sm"
          />
        </div>
        <div className="max-h-48 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-3">No employees found</p>
          ) : (
            filtered.map((emp: any) => {
              const isSelected = selectedNames.includes(emp.fullName);
              return (
                <button
                  key={emp.id}
                  type="button"
                  className={cn(
                    "w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors text-left",
                    isSelected && "bg-teal-50"
                  )}
                  onClick={() => toggleEmployee(emp.fullName)}
                >
                  <Check
                    className={cn(
                      "h-3.5 w-3.5 flex-shrink-0 text-teal-600",
                      isSelected ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="font-medium truncate">{emp.fullName}</span>
                  {emp.nickname && emp.nickname !== emp.fullName && (
                    <span className="text-muted-foreground text-xs ml-auto flex-shrink-0 pl-1">
                      {emp.nickname}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
        {selectedNames.length > 0 && (
          <div className="border-t p-2">
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground w-full text-left"
              onClick={() => onChange("")}
            >
              Clear selection
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
