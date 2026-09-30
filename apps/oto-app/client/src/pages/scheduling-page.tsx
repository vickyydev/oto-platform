import { useState, useMemo, useCallback, useRef, useEffect, type ReactNode } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { DndContext, DragEndEvent, DragOverlay, DragStartEvent, useDraggable, useDroppable, PointerSensor, TouchSensor, useSensor, useSensors, closestCenter, type PointerSensorOptions } from "@dnd-kit/core";

// Custom PointerSensor that ignores right-clicks so they reach the
// onContextMenu handler on CopyableShiftWrapper (copy mode activation).
class LeftClickOnlyPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: ({ nativeEvent: event }: React.PointerEvent, { onActivation }: PointerSensorOptions) => {
        if (!event.isPrimary || event.button !== 0) return false;
        onActivation?.({ event });
        return true;
      },
    },
  ];
}
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Pencil, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient, ApiError } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useBranchContext } from "@/hooks/use-branch-context";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, Clock, Users, X, Save, FileDown, Trash2, Filter, LayoutGrid, UserCircle, CalendarDays, MapPin, GanttChart, AlertCircle, Thermometer, Briefcase, UserPlus, ChevronDown, ChevronRight, Palette, Search, AlertTriangle, Info, Check, ChevronsUpDown, History, RotateCcw, ListChecks, Undo2, Moon, Coffee, Merge } from "lucide-react";
import { format, startOfWeek, addDays, addWeeks, subWeeks, isSameDay, startOfMonth, endOfMonth, eachDayOfInterval, addMonths, subMonths, eachWeekOfInterval, getWeek, isWeekend, getDay } from "date-fns";
import { TimelineControls, type TimelineMode } from "@/components/scheduling";
import { ShiftCard, EmployeeShiftCard, MinimalShiftBlock, LeaveCard, OffDayCard, DeptShiftCell } from "@/components/scheduling";
import { EmployeeRowHeader, DaysOffRowHeader } from "@/components/scheduling";
import { TimelineView, getEmployeeColor, getShiftColorByIndex, BorrowStaffModal, DutyBlocksSheet } from "@/components/scheduling";
import type { DutyBlock } from "@shared/schema";
import { EmployeeInfoPopup } from "@/components/scheduling/EmployeeInfoPopup";
import { cn } from "@/lib/utils";
import { CopyModeProvider, useCopyMode, type ClipboardShiftData } from "@/hooks/use-copy-mode";
import { useAvatarWorkStatus, type AvatarWorkStatus, type AvatarStatusMap } from "@/hooks/use-avatar-work-status";
import { getWorkStatusColor } from "@/hooks/use-avatar-work-status";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type Department = {
  id: string;
  name: string;
  branchId: string | null;
  isActive: boolean;
};

type Role = {
  id: string;
  name: string;
  isActive: boolean;
};

type Employee = {
  id: string;
  fullName: string;
  nickname?: string | null;
  branchId: string;
  employmentState: string;
  primaryDepartmentId?: string | null;
  weeklyOffDays?: number[] | null;
  profilePhotoPath?: string | null;
  displayOrder?: number;
  lastWorkingDay?: string | null;
  schedulingTransferInfo?: {
    transferredFromBranch: string;
    effectiveDate: string;
    lastDateInOldBranch: string;
  };
  roles?: { roleId: string; roleName: string; isPrimary: boolean | null }[];
};

type CasualWorker = {
  id: string;
  fullName: string;
  nickname: string;
  jobTitle: string | null;
  branchId: string;
  departmentId: string;
  roleId: string;
  startDate: string;
  endDate: string;
  dailyRate: number;
  status: "active" | "inactive" | "expired";
  role?: { id: string; name: string } | null;
  department?: { id: string; name: string } | null;
};

type ScheduleAssignment = {
  id: string;
  weekPlanId: string;
  shiftRowId: string;
  shiftDate: string;
  employeeId: string;
  casualWorkerId?: string | null;
  assigneeType?: "employee" | "casual";
  assignedAt: string;
  assignedBy: string | null;
  employee?: Employee;
  casualWorker?: CasualWorker;
};

type ScheduleShiftRowRole = {
  id: string;
  shiftRowId: string;
  roleId: string;
  role?: Role;
};

type ScheduleShiftBreak = {
  id: string;
  shiftRowId: string;
  assignmentId: string;
  shiftDate: string;
  breakStartTime: string;
  breakEndTime: string;
  breakDurationMinutes: number;
  hasConflict: boolean;
};

type ScheduleShiftRow = {
  id: string;
  branchId: string;
  departmentId: string;
  weekPlanId: string;
  rowOrder: number;
  label: string | null;
  startTime: string;
  endTime: string;
  note: string | null;
  staffRequired: number;
  staffRequiredByDay: Record<string, number> | null;
  colorIndex?: number | null;
  shiftGroupId?: string | null;
  sortOrderWithinGroup?: number | null;
  department?: Department;
  roles: ScheduleShiftRowRole[];
  assignments: ScheduleAssignment[];
  breaks?: ScheduleShiftBreak[];
};

type ScheduleWeekPlan = {
  id: string;
  branchId: string;
  weekStartDate: string;
  name: string | null;
  shiftRows: ScheduleShiftRow[];
};

type ScheduleTemplate = {
  id: string;
  branchId: string;
  departmentId: string | null;
  name: string;
  createdAt: string;
  department?: { id: string; name: string } | null;
};

type TemplatePreviewResult = {
  templateRows: number;
  rowsToAdd: Array<{ label: string | null; startTime: string; endTime: string; shiftGroupName?: string; departmentName?: string }>;
  rowsAlreadyExist: Array<{ label: string | null; startTime: string; endTime: string; shiftGroupName?: string; departmentName?: string }>;
  assignmentsToApply: number;
  timeOffToApply: number;
};

type EmployeeTimeOff = {
  id: string;
  employeeId: string;
  branchId: string | null;
  type: string;
  startDate: string;
  endDate: string;
  note: string | null;
};

type LeaveBalance = {
  employeeId: string;
  daysWorked: number;
  daysEarned: number;
  daysUsed: number;
  balance: number;
  policyName: string | null;
};

type SickLeaveBalance = {
  employeeId: string;
  employeeName: string;
  year: number;
  annualEntitlement: number;
  proRatedEntitlement: number;
  daysUsed: number;
  daysRemaining: number;
  startDate: string | null;
  monthsInYear: number;
};

type AllLeaveBalance = {
  employeeId: string;
  year: number;
  annual: {
    earned: number;
    used: number;
    balance: number;
    canClaim: boolean;
    waitingMonths: number;
    totalMonthsEmployed: number;
  };
  business: {
    earned: number;
    used: number;
    balance: number;
  };
  publicHolidays: {
    remaining: number;
  };
  holidayBalance: number;
};

type BranchEvent = {
  id: string;
  branchId: string;
  title: string;
  description: string | null;
  location: string | null;
  startDateTime: string;
  endDateTime: string;
  isAllDay: boolean;
  status?: string;
  source?: "local" | "core" | "studio";
  eventType?: string;
  numChildren?: number;
  numAdults?: number;
  programName?: string;
  childName?: string;
  parentName?: string;
};

type ViewMode = "shifts" | "employees" | "timeline";

const CopyableShiftWrapper = ({ 
  assignmentId, 
  shiftData, 
  children 
}: { 
  assignmentId: string; 
  shiftData: ClipboardShiftData; 
  children: ReactNode;
}) => {
  const copyMode = useCopyMode();
  const { toast } = useToast();
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    copyMode.enterCopyMode(assignmentId, shiftData);
    toast({
      title: "Copy mode activated",
      description: "Tap/click days to paste this shift. Press Done when finished.",
    });
  };
  
  const handleTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    touchStartPos.current = { x: touch.clientX, y: touch.clientY };
    longPressTimerRef.current = setTimeout(() => {
      copyMode.enterCopyMode(assignmentId, shiftData);
      toast({
        title: "Copy mode activated",
        description: "Tap days to paste this shift. Press Done when finished.",
      });
    }, 450);
  };
  
  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStartPos.current || !longPressTimerRef.current) return;
    const touch = e.touches[0];
    const dx = Math.abs(touch.clientX - touchStartPos.current.x);
    const dy = Math.abs(touch.clientY - touchStartPos.current.y);
    if (dx > 10 || dy > 10) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };
  
  const handleTouchEnd = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };
  
  const isSource = copyMode.isActive && copyMode.sourceAssignmentId === assignmentId;
  
  return (
    <div 
      className={cn("relative select-none", isSource && "ring-2 ring-amber-500 rounded outline outline-1 outline-dashed outline-amber-500")}
      onContextMenu={handleContextMenu}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      {children}
      {isSource && (
        <div className="absolute -top-1 -right-1 bg-amber-500 text-white text-[8px] px-1 rounded-full leading-tight z-10">
          COPIED
        </div>
      )}
    </div>
  );
};

// Sortable department wrapper component - defined outside main component to prevent recreation
const SortableDepartmentWrapper = ({ deptId, children, isManager }: {
  deptId: string;
  children: (props: { attributes: any; listeners: any; setNodeRef: (el: HTMLElement | null) => void; dragStyle: React.CSSProperties | undefined }) => React.ReactNode;
  isManager: boolean;
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ 
    id: deptId,
    data: { type: "department" },
  });

  const dragStyle: React.CSSProperties | undefined = isDragging ? {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: 0.5,
  } : undefined;

  return children({ attributes, listeners, setNodeRef, dragStyle });
};

// Sortable employee row wrapper component - defined outside main component to prevent recreation
const SortableEmployeeRowWrapper = ({ employeeId, departmentId, children, isManager }: {
  employeeId: string;
  departmentId: string;
  children: (props: { attributes: any; listeners: any; setNodeRef: (el: HTMLElement | null) => void; dragStyle: React.CSSProperties | undefined }) => React.ReactNode;
  isManager: boolean;
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ 
    id: `emp-${employeeId}`,
    data: { type: "employee", departmentId },
  });

  const dragStyle: React.CSSProperties | undefined = isDragging ? {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: 0.5,
  } : undefined;

  return children({ attributes, listeners, setNodeRef, dragStyle });
};

// Sortable shift row wrapper component - defined outside main component to prevent recreation
const SortableShiftRowWrapper = ({ rowId, groupId, children }: {
  rowId: string;
  groupId: string;
  children: (props: { attributes: any; listeners: any; setNodeRef: (el: HTMLElement | null) => void; dragStyle: React.CSSProperties | undefined }) => React.ReactNode;
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: rowId, data: { type: "shiftRow", groupId } });

  const dragStyle: React.CSSProperties | undefined = isDragging ? {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: 0.5,
  } : undefined;

  return children({ attributes, listeners, setNodeRef, dragStyle });
};

// Droppable group zone for cross-group shift row drag-and-drop
const DroppableGroupZone = ({ groupId, children }: {
  groupId: string;
  children: (props: { setNodeRef: (el: HTMLElement | null) => void; isOver: boolean }) => React.ReactNode;
}) => {
  const { setNodeRef, isOver } = useDroppable({
    id: `group-drop-${groupId}`,
    data: { type: "shiftGroupDrop", groupId },
  });

  return children({ setNodeRef, isOver });
};

function SchedulingPageInner() {
  const { toast } = useToast();
  const copyMode = useCopyMode();
  const { user } = useAuth();
  const { selectedBranchId, selectedBranch } = useBranchContext();
  const [currentWeekStart, setCurrentWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }));
  const [currentMonth, setCurrentMonth] = useState(() => startOfMonth(new Date()));
  const [timelineMode, setTimelineMode] = useState<TimelineMode>("week");
  const [viewMode, setViewMode] = useState<ViewMode>("employees");
  const [createShiftRowOpen, setCreateShiftRowOpen] = useState(false);
  const [selectedDepartmentId, setSelectedDepartmentId] = useState<string | null>(null);
  const [selectedShiftGroupId, setSelectedShiftGroupId] = useState<string | null>(null);
  const [createShiftGroupOpen, setCreateShiftGroupOpen] = useState(false);
  const [newShiftGroupName, setNewShiftGroupName] = useState("");
  const [editingShiftGroupId, setEditingShiftGroupId] = useState<string | null>(null);
  const [editingShiftGroupName, setEditingShiftGroupName] = useState("");
  const [assignmentPopover, setAssignmentPopover] = useState<{
    shiftRowId: string;
    date: string;
    anchorEl: HTMLElement | null;
  } | null>(null);
  const [borrowModalData, setBorrowModalData] = useState<{
    shiftRowId: string;
    weekPlanId: string;
    date: string;
    shiftLabel?: string;
    shiftTime: string;
    departmentName: string;
  } | null>(null);
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateDepartmentId, setTemplateDepartmentId] = useState<string>("");
  const [templateShiftGroupId, setTemplateShiftGroupId] = useState<string>("");
  const [applyTemplateDialogOpen, setApplyTemplateDialogOpen] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [templatePreview, setTemplatePreview] = useState<TemplatePreviewResult | null>(null);
  const [templatePreviewLoading, setTemplatePreviewLoading] = useState(false);
  
  const [templateApplyStep, setTemplateApplyStep] = useState<"select" | "preview" | "apply">("select");
  const [clearWeekDialogOpen, setClearWeekDialogOpen] = useState(false);
  const [clearDeptId, setClearDeptId] = useState<string>("");
  const [clearWeekStart, setClearWeekStart] = useState<string>("");
  const [scheduleHistoryOpen, setScheduleHistoryOpen] = useState(false);
  const [conflictScanDialogOpen, setConflictScanDialogOpen] = useState(false);
  const [conflictScanResults, setConflictScanResults] = useState<any>(null);
  const [conflictScanLoading, setConflictScanLoading] = useState(false);
  const [autoFixLoading, setAutoFixLoading] = useState(false);
  const [conflictResolutions, setConflictResolutions] = useState<Map<string, { kept: string; type: 'shift' | 'dayoff' }>>(new Map());
  const [conflictUndoStack, setConflictUndoStack] = useState<string[]>([]);
  const [departmentFilter, setDepartmentFilter] = useState<string[]>([]);
  const [departmentFilterOpen, setDepartmentFilterOpen] = useState(false);
  const [shiftGroupFilter, setShiftGroupFilter] = useState<string[]>([]);
  const [shiftGroupFilterOpen, setShiftGroupFilterOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [offDaysDialogOpen, setOffDaysDialogOpen] = useState(false);
  const [selectedEmployeeForOffDays, setSelectedEmployeeForOffDays] = useState<Employee | null>(null);
  const [editingOffDays, setEditingOffDays] = useState<number[]>([]);
  const [employeeInfoPopupOpen, setEmployeeInfoPopupOpen] = useState(false);
  const [selectedEmployeeForInfo, setSelectedEmployeeForInfo] = useState<{ id: string; name: string; avatar?: string | null } | null>(null);
  const [dutyBlocksSheetData, setDutyBlocksSheetData] = useState<{
    assignmentId: string;
    employeeId: string;
    employeeName: string;
    date: string;
    shiftStartTime: string;
    shiftEndTime: string;
    shiftName: string;
  } | null>(null);
  
  // Ref for shift view scroll container to handle JS-based sticky positioning
  const shiftScrollRef = useRef<HTMLDivElement>(null);
  
  // JavaScript-based sticky positioning for cells inside transformed parents
  // CSS sticky doesn't work when parent has transform (dnd-kit uses transforms)
  useEffect(() => {
    const scrollContainer = shiftScrollRef.current;
    if (!scrollContainer || viewMode !== 'shifts') return;
    
    const handleScroll = () => {
      const scrollLeft = scrollContainer.scrollLeft;
      // Find all elements with data-js-sticky attribute
      const stickyCells = scrollContainer.querySelectorAll<HTMLElement>('[data-js-sticky="true"]');
      stickyCells.forEach((cell) => {
        // Use transform to counteract scroll position
        cell.style.transform = `translateX(${scrollLeft}px)`;
      });
    };
    
    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
    // Initial call in case already scrolled
    handleScroll();
    
    return () => {
      scrollContainer.removeEventListener('scroll', handleScroll);
    };
  }, [viewMode]);
  
  // Merge shift rows mode
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeSelectedIds, setMergeSelectedIds] = useState<Set<string>>(new Set());
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState<string | null>(null);
  const [mergePreview, setMergePreview] = useState<any>(null);
  const [mergePreviewLoading, setMergePreviewLoading] = useState(false);
  const [mergeConflictResolutions, setMergeConflictResolutions] = useState<Map<string, "keep_target" | "keep_source">>(new Map());
  const [mergeExecuting, setMergeExecuting] = useState(false);

  const DEFAULT_SHIFT_HOURS = 9;
  
  const calculateEndTime = (startTime: string): string => {
    const [hours, minutes] = startTime.split(":").map(Number);
    const totalMinutes = hours * 60 + minutes + DEFAULT_SHIFT_HOURS * 60;
    const endHours = Math.floor(totalMinutes / 60) % 24;
    const endMinutes = totalMinutes % 60;
    return `${endHours.toString().padStart(2, "0")}:${endMinutes.toString().padStart(2, "0")}`;
  };
  
  const [shiftRowForm, setShiftRowForm] = useState({
    startTime: "09:00",
    endTime: "18:00",
    label: "",
    note: "",
    roleIds: [] as string[],
    staffRequired: 1,
    staffRequiredByDay: {} as Record<string, number>,
    colorIndex: null as number | null,
  });

  const [editShiftRowOpen, setEditShiftRowOpen] = useState(false);
  const [editingShiftRow, setEditingShiftRow] = useState<ScheduleShiftRow | null>(null);
  const [editShiftRowForm, setEditShiftRowForm] = useState({
    startTime: "09:00",
    endTime: "18:00",
    label: "",
    note: "",
    roleIds: [] as string[],
    staffRequired: 1,
    staffRequiredByDay: {} as Record<string, number>,
    colorIndex: null as number | null,
    shiftGroupId: null as string | null,
  });
  
  // Collapse/expand state for departments (persisted in localStorage)
  const [collapsedDepts, setCollapsedDepts] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(`scheduling_collapsed_depts_${viewMode}`);
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  });
  
  const toggleDeptCollapse = useCallback((deptId: string) => {
    setCollapsedDepts(prev => {
      const next = new Set(prev);
      if (next.has(deptId)) next.delete(deptId);
      else next.add(deptId);
      localStorage.setItem(`scheduling_collapsed_depts_${viewMode}`, JSON.stringify(Array.from(next)));
      return next;
    });
  }, [viewMode]);

  const toggleCollapseAll = useCallback((deptIds: string[]) => {
    setCollapsedDepts(prev => {
      const allCollapsed = deptIds.every(id => prev.has(id));
      const next = allCollapsed ? new Set<string>() : new Set(deptIds);
      localStorage.setItem(`scheduling_collapsed_depts_${viewMode}`, JSON.stringify(Array.from(next)));
      return next;
    });
  }, [viewMode]);

  const isManager = user?.role === "global_admin" || user?.role === "operator_admin" || user?.role === "admin" || user?.role === "manager";
  const isAdmin = user?.role === "global_admin" || user?.role === "operator_admin" || user?.role === "admin";
  
  // Helper to check if a date string (YYYY-MM-DD) is in the past
  const isPastDate = useCallback((dateStr: string) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = new Date(dateStr);
    return targetDate < today;
  }, []);
  
  // Always calculate the actual Monday of the week for API queries
  const actualWeekStart = useMemo(() => {
    return startOfWeek(currentWeekStart, { weekStartsOn: 1 });
  }, [currentWeekStart]);
  const weekStartFormatted = format(actualWeekStart, "yyyy-MM-dd");

  const visibleDays = useMemo(() => {
    switch (timelineMode) {
      case "day":
        return [currentWeekStart];
      case "3day":
        return Array.from({ length: 3 }, (_, i) => addDays(currentWeekStart, i));
      case "week":
        return Array.from({ length: 7 }, (_, i) => addDays(currentWeekStart, i));
      case "month":
        return eachDayOfInterval({ start: startOfMonth(currentMonth), end: endOfMonth(currentMonth) });
      default:
        return Array.from({ length: 7 }, (_, i) => addDays(currentWeekStart, i));
    }
  }, [currentWeekStart, currentMonth, timelineMode]);

  const dateRangeLabel = useMemo(() => {
    switch (timelineMode) {
      case "day":
        return format(currentWeekStart, "EEEE, d MMMM yyyy");
      case "3day":
        return `${format(currentWeekStart, "d MMM")} - ${format(addDays(currentWeekStart, 2), "d MMM yyyy")}`;
      case "week":
        return `${format(currentWeekStart, "d MMM")} - ${format(addDays(currentWeekStart, 6), "d MMM yyyy")}`;
      case "month":
        return format(currentMonth, "MMMM yyyy");
      default:
        return "";
    }
  }, [currentWeekStart, currentMonth, timelineMode]);

  const weeksOfMonth = useMemo(() => {
    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(currentMonth);
    const weeks = eachWeekOfInterval({ start: monthStart, end: monthEnd }, { weekStartsOn: 1 });
    return weeks.map((weekStart) => ({
      weekStart,
      days: Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    }));
  }, [currentMonth]);

  const handleWeekClick = (weekStart: Date) => {
    setCurrentWeekStart(weekStart);
    setTimelineMode("week");
  };

  const departmentsQuery = useQuery<Department[]>({
    queryKey: ["/api/departments", selectedBranchId],
    queryFn: async () => {
      const params = selectedBranchId ? `?branchId=${selectedBranchId}` : "";
      const res = await fetch(`/api/departments${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch departments");
      return res.json();
    },
    enabled: !!selectedBranchId,
  });

  // Define departments early to avoid "Cannot access before initialization" errors in callbacks
  const allDepartments = departmentsQuery.data?.filter((d) => d.isActive) || [];
  const departments = departmentFilter.length > 0
    ? allDepartments.filter((d) => departmentFilter.includes(d.id))
    : allDepartments;

  const rolesQuery = useQuery<Role[]>({
    queryKey: ["/api/roles"],
  });

  const employeesQuery = useQuery<Employee[]>({
    queryKey: ["/api/employees", selectedBranchId, weekStartFormatted],
    queryFn: async () => {
      const searchParams = new URLSearchParams();
      if (selectedBranchId) searchParams.set("branchId", selectedBranchId);
      if (weekStartFormatted) searchParams.set("schedulingWeekStart", weekStartFormatted);
      const params = searchParams.toString() ? `?${searchParams.toString()}` : "";
      const res = await fetch(`/api/employees${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch employees");
      return res.json();
    },
    enabled: !!selectedBranchId,
  });

  const employeeIdsForStatus = useMemo(() => {
    return (employeesQuery.data || []).map(e => e.id);
  }, [employeesQuery.data]);

  const { data: avatarStatusMap } = useAvatarWorkStatus(employeeIdsForStatus, {
    branchId: selectedBranchId || undefined,
    scope: "BRANCH",
  });

  const weekPlanQuery = useQuery<ScheduleWeekPlan | null>({
    queryKey: ["/api/schedule/week", selectedBranchId, weekStartFormatted],
    queryFn: async () => {
      if (!selectedBranchId) return null;
      const params = new URLSearchParams({
        branchId: selectedBranchId,
        weekStartDate: weekStartFormatted,
      });
      const res = await fetch(`/api/schedule/week?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch week plan");
      return res.json();
    },
    enabled: !!selectedBranchId,
  });

  // For month view, fetch all weeks in the month
  const monthWeekKeys = useMemo(() => {
    if (timelineMode !== "month") return [];
    return weeksOfMonth.map(w => format(w.weekStart, "yyyy-MM-dd"));
  }, [timelineMode, weeksOfMonth]);

  const monthWeekPlansQuery = useQuery<ScheduleWeekPlan[]>({
    queryKey: ["/api/schedule/month-weeks", selectedBranchId, format(currentMonth, "yyyy-MM")],
    queryFn: async () => {
      if (!selectedBranchId || monthWeekKeys.length === 0) return [];
      const cacheBuster = Date.now(); // Force fresh fetch on every query
      const results = await Promise.all(
        monthWeekKeys.map(async (weekStart) => {
          const params = new URLSearchParams({
            branchId: selectedBranchId,
            weekStartDate: weekStart,
            _t: cacheBuster.toString(), // Cache buster
          });
          const res = await fetch(`/api/schedule/week?${params}`, { 
            credentials: "include",
            cache: "no-store",
          });
          if (!res.ok) return null;
          return res.json();
        })
      );
      return results.filter(Boolean) as ScheduleWeekPlan[];
    },
    enabled: !!selectedBranchId && timelineMode === "month" && monthWeekKeys.length > 0,
    staleTime: 0, // Always consider data stale
  });

  // Combined data: use monthWeekPlansQuery in month mode, otherwise use weekPlanQuery
  const allShiftRows = useMemo(() => {
    if (timelineMode === "month" && monthWeekPlansQuery.data) {
      const seen = new Set<string>();
      const deduped: ScheduleShiftRow[] = [];
      for (const wp of monthWeekPlansQuery.data) {
        for (const row of (wp.shiftRows || [])) {
          if (!seen.has(row.id)) {
            seen.add(row.id);
            deduped.push(row);
          }
        }
      }
      return deduped;
    }
    return weekPlanQuery.data?.shiftRows || [];
  }, [timelineMode, monthWeekPlansQuery.data, weekPlanQuery.data]);

  const templatesQuery = useQuery<ScheduleTemplate[]>({
    queryKey: ["/api/schedule/templates", selectedBranchId],
    queryFn: async () => {
      if (!selectedBranchId) return [];
      const res = await fetch(`/api/schedule/templates?branchId=${selectedBranchId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch templates");
      return res.json();
    },
    enabled: !!selectedBranchId,
  });

  // Fetch all branches for borrowed staff display
  const branchesQuery = useQuery<{ id: string; name: string }[]>({
    queryKey: ["/api/branches"],
    staleTime: 10 * 60 * 1000,
  });
  const branches = branchesQuery.data;

  // Fetch leave balances for all employees in the branch
  const leaveBalancesQuery = useQuery<LeaveBalance[]>({
    queryKey: ["/api/leave-balances", selectedBranchId],
    queryFn: async () => {
      if (!selectedBranchId) return [];
      const res = await fetch(`/api/leave-balances?branchId=${selectedBranchId}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!selectedBranchId,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  // Create a map of employee ID to leave balance for quick lookup
  const leaveBalanceMap = (leaveBalancesQuery.data || []).reduce((acc, lb) => {
    acc[lb.employeeId] = lb.balance;
    return acc;
  }, {} as Record<string, number>);

  const weekEndFormatted = format(addDays(currentWeekStart, 6), "yyyy-MM-dd");
  
  // For month view, fetch time-off for the entire month
  const timeOffDateFrom = timelineMode === "month" 
    ? format(startOfMonth(currentMonth), "yyyy-MM-dd")
    : weekStartFormatted;
  const timeOffDateTo = timelineMode === "month"
    ? format(endOfMonth(currentMonth), "yyyy-MM-dd")
    : weekEndFormatted;

  const timeOffQuery = useQuery<EmployeeTimeOff[]>({
    queryKey: ["/api/time-off", selectedBranchId, timeOffDateFrom, timeOffDateTo],
    queryFn: async () => {
      if (!selectedBranchId) return [];
      const params = new URLSearchParams({
        branchId: selectedBranchId,
        dateFrom: timeOffDateFrom,
        dateTo: timeOffDateTo,
      });
      const res = await fetch(`/api/time-off?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch time off");
      return res.json();
    },
    enabled: !!selectedBranchId,
  });

  // Fetch sick leave balances for all employees in the branch
  const sickLeaveBalancesQuery = useQuery<SickLeaveBalance[]>({
    queryKey: ["/api/sick-leave-balances", selectedBranchId],
    queryFn: async () => {
      if (!selectedBranchId) return [];
      const params = new URLSearchParams({ branchId: selectedBranchId });
      const res = await fetch(`/api/sick-leave-balances?${params}`, { credentials: "include" });
      if (!res.ok) {
        throw new Error("Failed to fetch sick leave balances");
      }
      return res.json();
    },
    enabled: !!selectedBranchId,
  });

  // Helper to get sick leave balance for an employee
  const getSickLeaveBalance = (employeeId: string): SickLeaveBalance | undefined => {
    return sickLeaveBalancesQuery.data?.find(b => b.employeeId === employeeId);
  };

  // Get full leave balance for an employee (days off balance)
  const getLeaveBalance = (employeeId: string): LeaveBalance | undefined => {
    return leaveBalancesQuery.data?.find(lb => lb.employeeId === employeeId);
  };

  // Fetch all leave balances (annual, business, PH) for all employees in the branch
  const allLeaveBalancesQuery = useQuery<AllLeaveBalance[]>({
    queryKey: ["/api/all-leave-balances", selectedBranchId],
    queryFn: async () => {
      if (!selectedBranchId) return [];
      const params = new URLSearchParams({ branchId: selectedBranchId });
      const res = await fetch(`/api/all-leave-balances?${params}`, { credentials: "include" });
      if (!res.ok) {
        throw new Error("Failed to fetch all leave balances");
      }
      return res.json();
    },
    enabled: !!selectedBranchId,
  });

  // Create lookup map for all leave balances (annual, business, PH)
  const allLeaveBalanceMap = (allLeaveBalancesQuery.data || []).reduce((acc, b) => {
    acc[b.employeeId] = b;
    return acc;
  }, {} as Record<string, AllLeaveBalance>);

  // Helper to get all leave balance for an employee
  const getAllLeaveBalance = (employeeId: string): AllLeaveBalance | undefined => {
    return allLeaveBalanceMap[employeeId];
  };

  // Events query with proper caching by (branchId, start, end)
  const eventsQueryStart = format(currentWeekStart, "yyyy-MM-dd'T'00:00:00");
  const eventsQueryEnd = format(addDays(currentWeekStart, 7), "yyyy-MM-dd'T'00:00:00");
  const timelineDateStr = format(currentWeekStart, "yyyy-MM-dd");
  const timelineDutyBlocksQuery = useQuery<DutyBlock[]>({
    queryKey: ["/api/duty-blocks", { branchId: selectedBranchId, date: timelineDateStr }],
    queryFn: async () => {
      const params = new URLSearchParams({ branchId: selectedBranchId!, date: timelineDateStr });
      const res = await fetch(`/api/duty-blocks?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch duty blocks");
      return res.json();
    },
    enabled: !!selectedBranchId && viewMode === "timeline",
  });

  const branchEventsQuery = useQuery<BranchEvent[]>({
    queryKey: ["/api/events", selectedBranchId, eventsQueryStart, eventsQueryEnd],
    queryFn: async () => {
      if (!selectedBranchId) return [];
      const params = new URLSearchParams({
        branchId: selectedBranchId,
        start: eventsQueryStart,
        end: eventsQueryEnd,
      });
      const res = await fetch(`/api/events?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch events");
      return res.json();
    },
    enabled: !!selectedBranchId,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  // Borrowed-out assignments: employees from this branch working at other branches
  type BorrowedOutAssignment = {
    id: string;
    employeeId: string;
    employeeName: string;
    shiftDate: string;
    startTime: string;
    endTime: string;
    shiftLabel: string | null;
    departmentName: string | null;
    toBranchId: string;
    toBranchName: string;
  };
  const borrowedOutQuery = useQuery<BorrowedOutAssignment[]>({
    queryKey: ["/api/schedule/branches", selectedBranchId, "borrowed-out-assignments", weekStartFormatted],
    queryFn: async () => {
      if (!selectedBranchId) return [];
      const startDate = weekStartFormatted;
      const endDate = format(addDays(currentWeekStart, 30), "yyyy-MM-dd");
      const params = new URLSearchParams({ startDate, endDate });
      const res = await fetch(`/api/schedule/branches/${selectedBranchId}/borrowed-out-assignments?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch borrowed-out assignments");
      return res.json();
    },
    enabled: !!selectedBranchId && viewMode === "employees",
    staleTime: 5 * 60 * 1000,
  });

  // Helper to get borrowed-out assignments for an employee on a specific date
  const getBorrowedOutForEmployeeDate = (employeeId: string, day: Date): BorrowedOutAssignment[] => {
    if (!borrowedOutQuery.data) return [];
    const dateStr = format(day, "yyyy-MM-dd");
    return borrowedOutQuery.data.filter(a => a.employeeId === employeeId && a.shiftDate === dateStr);
  };

  const eligibleEmployeesQuery = useQuery<Employee[]>({
    queryKey: ["/api/schedule/shift-rows/eligible", assignmentPopover?.shiftRowId, assignmentPopover?.date],
    queryFn: async () => {
      if (!assignmentPopover) return [];
      const res = await fetch(
        `/api/schedule/shift-rows/${assignmentPopover.shiftRowId}/eligible-employees?date=${assignmentPopover.date}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error("Failed to fetch eligible employees");
      return res.json();
    },
    enabled: !!assignmentPopover,
  });

  const casualWorkersQuery = useQuery<CasualWorker[]>({
    queryKey: [`/api/casual-workers/for-scheduling?branchId=${selectedBranchId}&date=${assignmentPopover?.date || ""}`],
    enabled: !!assignmentPopover && !!selectedBranchId,
  });

  // Fetch casual workers active during the visible date range for Employees view
  const visibleStartDate = visibleDays.length > 0 ? format(visibleDays[0], "yyyy-MM-dd") : "";
  const visibleEndDate = visibleDays.length > 0 ? format(visibleDays[visibleDays.length - 1], "yyyy-MM-dd") : "";
  
  const casualWorkersForEmployeeViewQuery = useQuery<CasualWorker[]>({
    queryKey: ["/api/casual-workers/for-scheduling", selectedBranchId, visibleStartDate, visibleEndDate],
    queryFn: async () => {
      const res = await fetch(
        `/api/casual-workers/for-scheduling?branchId=${selectedBranchId}&startDate=${visibleStartDate}&endDate=${visibleEndDate}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error("Failed to fetch casual workers");
      return res.json();
    },
    enabled: !!selectedBranchId && !!visibleStartDate && !!visibleEndDate,
  });

  const ensureWeekPlanMutation = useMutation({
    mutationFn: async () => {
      if (!selectedBranchId) throw new Error("No branch selected");
      return apiRequest("POST", "/api/schedule/week", {
        branchId: selectedBranchId,
        weekStartDate: weekStartFormatted,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/schedule/week", selectedBranchId, weekStartFormatted] });
    },
  });

  const createShiftRowMutation = useMutation({
    mutationFn: async (data: {
      branchId: string;
      startTime: string;
      endTime: string;
      label?: string;
      note?: string;
      roleIds?: string[];
      staffRequired?: number;
      staffRequiredByDay?: Record<string, number>;
      shiftGroupId?: string;
    }) => apiRequest("POST", "/api/schedule/shift-rows", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/schedule/week", selectedBranchId, weekStartFormatted] });
      setCreateShiftRowOpen(false);
      setShiftRowForm({ startTime: "09:00", endTime: "18:00", label: "", note: "", roleIds: [], staffRequired: 1, staffRequiredByDay: {}, colorIndex: null });
      toast({ title: "Shift created", description: "The shift row has been added." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create shift row", variant: "destructive" });
    },
  });

  const deleteShiftRowMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/schedule/shift-rows/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/schedule/week"] });
      toast({ title: "Shift retired", description: "The shift row has been retired and will no longer appear on future schedules." });
    },
  });

  const updateShiftRowMutation = useMutation({
    mutationFn: async (data: {
      id: string;
      startTime: string;
      endTime: string;
      label?: string;
      note?: string;
      roleIds?: string[];
      staffRequired?: number;
      staffRequiredByDay?: Record<string, number>;
      colorIndex?: number | null;
      shiftGroupId?: string | null;
    }) => apiRequest("PATCH", `/api/schedule/shift-rows/${data.id}`, data),
    onSuccess: async (_result, variables) => {
      console.log("[ShiftRowMutation] onSuccess - id:", variables.id, "colorIndex:", variables.colorIndex);
      
      // Close dialog first
      setEditShiftRowOpen(false);
      setEditingShiftRow(null);
      
      // Invalidate all relevant caches and wait for refetch
      const monthKey = format(currentMonth, "yyyy-MM");
      await Promise.all([
        queryClient.invalidateQueries({ 
          queryKey: ["/api/schedule/week", selectedBranchId, weekStartFormatted] 
        }),
        queryClient.invalidateQueries({ 
          queryKey: ["/api/schedule/month-weeks", selectedBranchId, monthKey] 
        }),
      ]);
      
      toast({ title: "Shift updated", description: "The shift row has been updated." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to update shift row", variant: "destructive" });
    },
  });

  const reorderShiftRowsMutation = useMutation({
    mutationFn: async (data: { departmentId?: string; shiftGroupId?: string; orderedIds: string[] }) =>
      apiRequest("PATCH", "/api/schedule/shift-rows/reorder", data),
    onMutate: async ({ shiftGroupId, orderedIds }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/schedule/week", selectedBranchId, weekStartFormatted] });
      const previousData = queryClient.getQueryData(["/api/schedule/week", selectedBranchId, weekStartFormatted]);
      queryClient.setQueryData(["/api/schedule/week", selectedBranchId, weekStartFormatted], (old: any) => {
        if (!old?.shiftRows) return old;
        const updatedRows = old.shiftRows.map((row: any) => {
          const newIndex = orderedIds.indexOf(row.id);
          if (newIndex !== -1) {
            return { ...row, ...(shiftGroupId ? { sortOrderWithinGroup: newIndex } : { rowOrder: newIndex }) };
          }
          return row;
        });
        return { ...old, shiftRows: updatedRows };
      });
      return { previousData };
    },
    onError: (_err, _vars, context) => {
      // Rollback on error
      if (context?.previousData) {
        queryClient.setQueryData(["/api/schedule/week", selectedBranchId, weekStartFormatted], context.previousData);
      }
      toast({ title: "Error", description: "Failed to reorder shifts", variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/schedule/week", selectedBranchId, weekStartFormatted] });
    },
  });

  const handleMergePreview = async () => {
    if (mergeSelectedIds.size < 2 || !mergeTargetId) return;
    setMergePreviewLoading(true);
    try {
      const sourceRowIds = [...mergeSelectedIds].filter(id => id !== mergeTargetId);
      const resp = await apiRequest("POST", "/api/schedule/shift-rows/merge/preview", {
        targetRowId: mergeTargetId,
        sourceRowIds,
      });
      const data = await resp.json();
      setMergePreview(data);
      setMergeConflictResolutions(new Map());
    } catch (err: any) {
      toast({ title: "Error", description: err.message || "Failed to preview merge", variant: "destructive" });
    } finally {
      setMergePreviewLoading(false);
    }
  };

  const handleMergeExecute = async () => {
    if (!mergeTargetId || !mergePreview) return;
    setMergeExecuting(true);
    try {
      const sourceRowIds = [...mergeSelectedIds].filter(id => id !== mergeTargetId);
      const conflictResolutionsArr = mergePreview.conflicts.map((c: any) => ({
        sourceAssignmentId: c.sourceAssignment.id,
        action: mergeConflictResolutions.get(c.sourceAssignment.id) || "keep_target",
      }));
      await apiRequest("POST", "/api/schedule/shift-rows/merge/execute", {
        targetRowId: mergeTargetId,
        sourceRowIds,
        conflictResolutions: conflictResolutionsArr,
      });
      toast({ title: "Shifts merged", description: `${sourceRowIds.length} shift(s) merged into the selected target.` });
      setMergeMode(false);
      setMergeSelectedIds(new Set());
      setMergeDialogOpen(false);
      setMergeTargetId(null);
      setMergePreview(null);
      queryClient.invalidateQueries({ queryKey: ["/api/schedule/week"] });
      queryClient.invalidateQueries({ queryKey: ["/api/schedule/month-weeks"] });
    } catch (err: any) {
      toast({ title: "Error", description: err.message || "Failed to merge shifts", variant: "destructive" });
    } finally {
      setMergeExecuting(false);
    }
  };

  const reorderDepartmentsMutation = useMutation({
    mutationFn: async (orderedIds: string[]) =>
      apiRequest("POST", "/api/departments/reorder", { orderedIds }),
    onMutate: async (orderedIds) => {
      const queryKey = ["/api/departments", selectedBranchId];
      await queryClient.cancelQueries({ queryKey });
      const previousData = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (old: any) => {
        if (!old) return old;
        const orderMap = new Map(orderedIds.map((id, idx) => [id, idx]));
        return [...old].sort((a: any, b: any) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));
      });
      return { previousData, queryKey };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousData && context?.queryKey) {
        queryClient.setQueryData(context.queryKey, context.previousData);
      }
      toast({ title: "Error", description: "Failed to reorder departments", variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/departments", selectedBranchId] });
    },
  });

  const createShiftGroupMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiRequest("POST", "/api/schedule/shift-groups", { branchId: selectedBranchId, name });
      return res.json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/schedule/week", selectedBranchId, weekStartFormatted] });
      setCreateShiftGroupOpen(false);
      setNewShiftGroupName("");
      toast({ title: "Shift group created" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create shift group", description: err.message, variant: "destructive" });
    },
  });

  const deleteShiftGroupMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/schedule/shift-groups/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/schedule/week", selectedBranchId, weekStartFormatted] });
      toast({ title: "Shift group deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete shift group", description: err.message, variant: "destructive" });
    },
  });

  const renameShiftGroupMutation = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const res = await apiRequest("PATCH", `/api/schedule/shift-groups/${id}`, { name });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/schedule/week", selectedBranchId, weekStartFormatted] });
      setEditingShiftGroupId(null);
      setEditingShiftGroupName("");
      toast({ title: "Shift group renamed" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to rename shift group", description: err.message, variant: "destructive" });
    },
  });

  const reorderShiftGroupsMutation = useMutation({
    mutationFn: async (orderedIds: string[]) =>
      apiRequest("PATCH", "/api/schedule/shift-groups/reorder", { orderedIds }),
    onMutate: async (orderedIds) => {
      const queryKey = ["/api/schedule/week", selectedBranchId, weekStartFormatted];
      await queryClient.cancelQueries({ queryKey });
      const previousData = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (old: any) => {
        if (!old?.shiftGroups) return old;
        const orderMap = new Map(orderedIds.map((id, idx) => [id, idx]));
        return { ...old, shiftGroups: [...old.shiftGroups].sort((a: any, b: any) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999)) };
      });
      return { previousData, queryKey };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousData && context?.queryKey) {
        queryClient.setQueryData(context.queryKey, context.previousData);
      }
      toast({ title: "Error", description: "Failed to reorder shift groups", variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/schedule/week", selectedBranchId, weekStartFormatted] });
    },
  });

  const moveShiftRowGroupMutation = useMutation({
    mutationFn: async ({ rowId, targetGroupId }: { rowId: string; targetGroupId: string }) =>
      apiRequest("PATCH", `/api/schedule/shift-rows/${rowId}/move-group`, { shiftGroupId: targetGroupId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/schedule/week", selectedBranchId, weekStartFormatted] });
      toast({ title: "Shift moved", description: "Shift row moved to new group." });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to move shift", description: err.message, variant: "destructive" });
    },
  });

  const reorderEmployeesMutation = useMutation({
    mutationFn: async (orderedIds: string[]) =>
      apiRequest("POST", "/api/employees/reorder", { orderedIds }),
    onMutate: async (orderedIds) => {
      const queryKey = ["/api/employees", selectedBranchId];
      await queryClient.cancelQueries({ queryKey });
      const previousData = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (old: Employee[] | undefined) => {
        if (!old) return old;
        return old.map(emp => {
          const newIndex = orderedIds.indexOf(emp.id);
          if (newIndex !== -1) {
            return { ...emp, displayOrder: newIndex };
          }
          return emp;
        });
      });
      return { previousData, queryKey };
    },
    onError: (_err, _orderedIds, context) => {
      if (context?.previousData && context?.queryKey) {
        queryClient.setQueryData(context.queryKey, context.previousData);
      }
      toast({ title: "Error", description: "Failed to reorder employees", variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedBranchId] });
    },
  });

  const createAssignmentMutation = useMutation({
    mutationFn: async (data: { 
      shiftRowId: string; 
      shiftDate: string; 
      employeeId?: string;
      casualWorkerId?: string;
      assigneeType?: "employee" | "casual";
      dailyRateSnapshot?: number;
      isBorrowed?: boolean;
      borrowedFromBranchId?: string;
    }) => {
      return apiRequest("POST", "/api/schedule/assignments", { ...data, weekPlanId: weekPlanQuery.data?.id });
    },
    onSuccess: async () => {
      await queryClient.refetchQueries({ 
        predicate: (query) => {
          const key = query.queryKey;
          return Array.isArray(key) && (
            key[0] === "/api/schedule/week" || 
            key[0] === "/api/schedule/month-weeks" ||
            (typeof key[0] === "string" && key[0].includes("borrowed-out-assignments"))
          );
        }
      });
      setAssignmentPopover(null);
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError 
        ? error.message 
        : (error instanceof Error ? error.message : "Failed to assign employee");
      toast({ title: "Assignment Failed", description: message, variant: "destructive" });
    },
  });

  const deleteAssignmentMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/schedule/assignments/${id}`),
    onSuccess: async () => {
      await queryClient.refetchQueries({ 
        predicate: (query) => {
          const key = query.queryKey;
          return Array.isArray(key) && (
            key[0] === "/api/schedule/week" || 
            key[0] === "/api/schedule/month-weeks" ||
            (typeof key[0] === "string" && key[0].includes("borrowed-out-assignments"))
          );
        }
      });
    },
  });

  const handleCopyPaste = useCallback((targetEmployeeId: string | undefined, targetDate: string, targetDepartmentId?: string) => {
    if (!copyMode.isActive || !copyMode.clipboardData) return;
    
    const data = copyMode.clipboardData;
    const weekPlanId = weekPlanQuery.data?.id;
    
    const allShiftRows = weekPlanQuery.data?.shiftRows || [];
    let targetShiftRowId = data.shiftRowId;
    const sourceRowExists = allShiftRows.some(r => r.id === data.shiftRowId);
    
    if (!sourceRowExists) {
      const matchingRow = allShiftRows.find(r => 
        r.startTime === data.startTime && 
        r.endTime === data.endTime && 
        r.departmentId === (targetDepartmentId || data.departmentId)
      );
      if (matchingRow) {
        targetShiftRowId = matchingRow.id;
      } else {
        toast({
          title: "Cannot paste",
          description: "No matching shift found in this week's schedule.",
          variant: "destructive",
        });
        copyMode.resetInteractionTimer();
        return;
      }
    }
    
    const mutationData: any = {
      shiftRowId: targetShiftRowId,
      shiftDate: targetDate,
      weekPlanId: weekPlanId || undefined,
    };
    
    if (data.assigneeType === "casual" && data.casualWorkerId) {
      mutationData.casualWorkerId = data.casualWorkerId;
      mutationData.assigneeType = "casual";
      mutationData.dailyRateSnapshot = data.dailyRateSnapshot || 0;
    } else if (data.employeeId && targetEmployeeId) {
      mutationData.employeeId = targetEmployeeId;
      mutationData.assigneeType = "employee";
    } else if (data.employeeId) {
      mutationData.employeeId = data.employeeId;
      mutationData.assigneeType = "employee";
    }
    
    createAssignmentMutation.mutate(mutationData, {
      onSuccess: () => {
        copyMode.setPasteCount(copyMode.pasteCount + 1);
        copyMode.resetInteractionTimer();
        toast({
          title: "Shift copied",
          description: `Pasted to ${format(new Date(targetDate + 'T12:00:00'), "EEE d MMM")}`,
        });
      },
      onError: (err: any) => {
        copyMode.resetInteractionTimer();
        toast({
          title: "Cannot paste",
          description: err.message || "Failed to paste shift",
          variant: "destructive",
        });
      }
    });
  }, [copyMode, weekPlanQuery.data, createAssignmentMutation, toast]);

  const handleCopyPasteToShiftRow = useCallback((targetShiftRowId: string, targetDate: string) => {
    if (!copyMode.isActive || !copyMode.clipboardData) return;
    
    const data = copyMode.clipboardData;
    const weekPlanId = weekPlanQuery.data?.id;
    
    const mutationData: any = {
      shiftRowId: targetShiftRowId,
      shiftDate: targetDate,
      weekPlanId: weekPlanId || undefined,
    };
    
    if (data.assigneeType === "casual" && data.casualWorkerId) {
      mutationData.casualWorkerId = data.casualWorkerId;
      mutationData.assigneeType = "casual";
      mutationData.dailyRateSnapshot = data.dailyRateSnapshot || 0;
    } else if (data.employeeId) {
      mutationData.employeeId = data.employeeId;
      mutationData.assigneeType = "employee";
    }
    
    createAssignmentMutation.mutate(mutationData, {
      onSuccess: () => {
        copyMode.setPasteCount(copyMode.pasteCount + 1);
        copyMode.resetInteractionTimer();
        toast({
          title: "Shift copied",
          description: `Pasted to ${format(new Date(targetDate + 'T12:00:00'), "EEE d MMM")}`,
        });
      },
      onError: (err: any) => {
        copyMode.resetInteractionTimer();
        toast({
          title: "Cannot paste",
          description: err.message || "Failed to paste shift",
          variant: "destructive",
        });
      }
    });
  }, [copyMode, weekPlanQuery.data, createAssignmentMutation, toast]);

  const updateOffDaysMutation = useMutation({
    mutationFn: async ({ employeeId, weeklyOffDays }: { employeeId: string; weeklyOffDays: number[] }) =>
      apiRequest("PATCH", `/api/employees/${employeeId}`, { weeklyOffDays }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedBranchId] });
      setOffDaysDialogOpen(false);
      toast({ title: "Off days updated" });
    },
  });

  const handleOpenOffDaysDialog = (employee: Employee) => {
    setSelectedEmployeeForOffDays(employee);
    setEditingOffDays(employee.weeklyOffDays || []);
    setOffDaysDialogOpen(true);
  };

  const toggleOffDay = (day: number) => {
    setEditingOffDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  };

  const saveOffDays = () => {
    if (!selectedEmployeeForOffDays) return;
    updateOffDaysMutation.mutate({
      employeeId: selectedEmployeeForOffDays.id,
      weeklyOffDays: editingOffDays,
    });
  };

  const createTimeOffMutation = useMutation({
    mutationFn: async ({ employeeId, branchId, timeOffType, date }: { 
      employeeId: string; 
      branchId: string; 
      timeOffType: string; 
      date: string;
    }) => apiRequest("POST", "/api/time-off", {
      employeeId,
      branchId,
      timeOffType,
      startDate: date,
      endDate: date,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/time-off"] });
      queryClient.invalidateQueries({ queryKey: ["/api/schedule/week", selectedBranchId, weekStartFormatted] });
      queryClient.invalidateQueries({ queryKey: ["/api/sick-leave-balances", selectedBranchId] });
      toast({ title: "Time off added" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteTimeOffMutation = useMutation({
    mutationFn: async (timeOffId: string) => apiRequest("DELETE", `/api/time-off/${timeOffId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/time-off"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leave-balances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sick-leave-balances", selectedBranchId] });
      toast({ title: "Time off removed" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handleSetTimeOff = (employee: Employee, dateStr: string, type: "CHANGE_DAY_OFF" | "ANNUAL" | "SICK" | "BUSINESS") => {
    if (!selectedBranchId) return;
    createTimeOffMutation.mutate({
      employeeId: employee.id,
      branchId: employee.branchId || selectedBranchId,
      timeOffType: type,
      date: dateStr,
    });
  };

  // Drag and drop state
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [activeDragData, setActiveDragData] = useState<{ assignmentId: string; shiftRowId: string; employeeId: string; shiftDate: string; shiftName: string } | null>(null);

  const sensors = useSensors(
    useSensor(LeftClickOnlyPointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 200,
        tolerance: 5,
      },
    })
  );

  const reassignMutation = useMutation({
    mutationFn: async ({ assignmentId, newEmployeeId }: { assignmentId: string; newEmployeeId: string }) => 
      apiRequest("PATCH", `/api/schedule/assignments/${assignmentId}/reassign`, { employeeId: newEmployeeId }),
    onMutate: async ({ assignmentId, newEmployeeId }) => {
      // Cancel any outgoing refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: ["/api/schedule/week", selectedBranchId, weekStartFormatted] });
      
      // Snapshot the previous value
      const previousData = queryClient.getQueryData(["/api/schedule/week", selectedBranchId, weekStartFormatted]);
      
      // Optimistically update the cache
      queryClient.setQueryData(["/api/schedule/week", selectedBranchId, weekStartFormatted], (old: any) => {
        if (!old) return old;
        return {
          ...old,
          shiftRows: old.shiftRows?.map((row: any) => ({
            ...row,
            assignments: row.assignments?.map((a: any) => 
              a.id === assignmentId ? { ...a, employeeId: newEmployeeId } : a
            ),
          })),
        };
      });
      
      return { previousData };
    },
    onError: (error: Error, _variables, context) => {
      // Rollback on error
      if (context?.previousData) {
        queryClient.setQueryData(["/api/schedule/week", selectedBranchId, weekStartFormatted], context.previousData);
      }
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
    onSettled: () => {
      // Refetch to ensure we have the latest data
      queryClient.invalidateQueries({ queryKey: ["/api/schedule/week", selectedBranchId, weekStartFormatted] });
      queryClient.invalidateQueries({ predicate: (query) => 
        Array.isArray(query.queryKey) && query.queryKey.includes("borrowed-out-assignments")
      });
    },
    onSuccess: () => {
      toast({ title: "Shift reassigned" });
    },
  });

  // Mutation for moving an assignment to a different shift cell (for Shifts View drag-and-drop)
  const moveAssignmentMutation = useMutation({
    mutationFn: async ({ assignmentId, shiftRowId, shiftDate }: { assignmentId: string; shiftRowId: string; shiftDate: string }) => 
      apiRequest("PATCH", `/api/schedule/assignments/${assignmentId}/move`, { shiftRowId, shiftDate }),
    onMutate: async ({ assignmentId, shiftRowId, shiftDate }) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ["/api/schedule/week", selectedBranchId, weekStartFormatted] });
      
      // Snapshot the previous value
      const previousData = queryClient.getQueryData(["/api/schedule/week", selectedBranchId, weekStartFormatted]);
      
      // Optimistically update the cache - move assignment to new shift row and date
      queryClient.setQueryData(["/api/schedule/week", selectedBranchId, weekStartFormatted], (old: any) => {
        if (!old) return old;
        
        // Find the assignment to move
        let assignmentToMove: any = null;
        for (const row of old.shiftRows || []) {
          const found = row.assignments?.find((a: any) => a.id === assignmentId);
          if (found) {
            assignmentToMove = { ...found, shiftRowId, shiftDate };
            break;
          }
        }
        
        if (!assignmentToMove) return old;
        
        return {
          ...old,
          shiftRows: old.shiftRows?.map((row: any) => ({
            ...row,
            assignments: [
              // Remove from old position
              ...(row.assignments?.filter((a: any) => a.id !== assignmentId) || []),
              // Add to new position if this is the target row
              ...(row.id === shiftRowId ? [assignmentToMove] : []),
            ],
          })),
        };
      });
      
      return { previousData };
    },
    onError: (error: Error, _variables, context) => {
      // Rollback on error
      if (context?.previousData) {
        queryClient.setQueryData(["/api/schedule/week", selectedBranchId, weekStartFormatted], context.previousData);
      }
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
    onSettled: () => {
      // Refetch to ensure we have the latest data
      queryClient.invalidateQueries({ queryKey: ["/api/schedule/week", selectedBranchId, weekStartFormatted] });
      queryClient.invalidateQueries({ predicate: (query) => 
        Array.isArray(query.queryKey) && query.queryKey.includes("borrowed-out-assignments")
      });
    },
    onSuccess: () => {
      toast({ title: "Assignment moved" });
    },
  });

  // Mutation for moving time-off to a different date
  const moveTimeOffMutation = useMutation({
    mutationFn: async ({ timeOffId, newDate }: { timeOffId: string; newDate: string }) => 
      apiRequest("PATCH", `/api/time-off/${timeOffId}`, { startDate: newDate, endDate: newDate }),
    onMutate: async ({ timeOffId, newDate }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/time-off"] });
      const previousData = queryClient.getQueryData(["/api/time-off"]);
      
      queryClient.setQueryData(["/api/time-off"], (old: any[]) => {
        if (!old) return old;
        return old.map((t: any) => 
          t.id === timeOffId 
            ? { ...t, startDate: newDate, endDate: newDate } 
            : t
        );
      });
      
      return { previousData };
    },
    onError: (error: Error, _variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(["/api/time-off"], context.previousData);
      }
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/time-off"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leave-balances"] });
    },
    onSuccess: () => {
      toast({ title: "Time off moved" });
    },
  });

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { active } = event;
    setActiveDragId(active.id as string);
    setActiveDragData(active.data.current as any);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragId(null);
    setActiveDragData(null);

    if (!over) return;

    // Check if this is an employee reorder
    const activeData = active.data.current as { type?: string; departmentId?: string } | undefined;
    if (activeData?.type === "employee" && active.id !== over.id) {
      const departmentId = activeData.departmentId;
      const activeEmps = (employeesQuery.data || []).filter(
        (e) => e.employmentState === "ACTIVE" || e.employmentState === "LEAVING" ||
          (e.employmentState === "LEFT" && e.lastWorkingDay)
      );
      const deptEmployees = activeEmps.filter(e => (e.primaryDepartmentId || "unassigned") === departmentId);
      
      // Extract employee IDs from sortable IDs (format: "emp-{id}")
      const activeEmpId = (active.id as string).replace("emp-", "");
      const overEmpId = (over.id as string).replace("emp-", "");
      
      const oldIndex = deptEmployees.findIndex((e) => e.id === activeEmpId);
      const newIndex = deptEmployees.findIndex((e) => e.id === overEmpId);
      
      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        const newOrder = arrayMove(deptEmployees, oldIndex, newIndex);
        reorderEmployeesMutation.mutate(newOrder.map((e) => e.id));
      }
      return;
    }

    // Check if this is a department reorder
    if (activeData?.type === "department" && active.id !== over.id) {
      const oldIndex = departments.findIndex((d) => d.id === active.id);
      const newIndex = departments.findIndex((d) => d.id === over.id);
      
      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        const newOrder = arrayMove([...departments], oldIndex, newIndex);
        reorderDepartmentsMutation.mutate(newOrder.map((d) => d.id));
      }
      return;
    }

    if (!active.data.current) return;

    const dragData = active.data.current as { 
      assignmentId?: string; 
      employeeId: string; 
      shiftRowId?: string; 
      shiftDate?: string;
      timeOffId?: string;
      currentDate?: string;
      isTimeOff?: boolean;
    };
    const dropData = over.data.current as { employeeId: string; date: string };

    if (!dropData?.employeeId) return;

    // Check if we're trying to modify a past date
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = new Date(dropData.date);
    const sourceDate = dragData.shiftDate ? new Date(dragData.shiftDate) : (dragData.currentDate ? new Date(dragData.currentDate) : null);
    
    if (targetDate < today || (sourceDate && sourceDate < today)) {
      toast({
        title: "Cannot modify past schedules",
        description: "Schedules for past dates cannot be changed.",
        variant: "destructive",
      });
      return;
    }

    // Handle time-off drag
    if (dragData.isTimeOff && dragData.timeOffId) {
      // Time-off can only be moved to different dates for the same employee
      if (dragData.employeeId === dropData.employeeId && dragData.currentDate !== dropData.date) {
        moveTimeOffMutation.mutate({
          timeOffId: dragData.timeOffId,
          newDate: dropData.date,
        });
      }
      return;
    }

    // Handle shift assignment drag
    if (!dragData.assignmentId) return;

    // If dropping on different employee, reassign the shift
    if (dragData.employeeId !== dropData.employeeId) {
      reassignMutation.mutate({
        assignmentId: dragData.assignmentId,
        newEmployeeId: dropData.employeeId,
      });
      return;
    }

    // If dropping on same employee but different date, move the shift to new date
    if (dragData.shiftDate !== dropData.date && dragData.shiftRowId) {
      moveAssignmentMutation.mutate({
        assignmentId: dragData.assignmentId,
        shiftRowId: dragData.shiftRowId,
        shiftDate: dropData.date,
      });
    }
  }, [reassignMutation, moveAssignmentMutation, moveTimeOffMutation, employeesQuery.data, reorderEmployeesMutation, departments, reorderDepartmentsMutation, toast]);

  const shiftGroupsList = useMemo(() => {
    return (weekPlanQuery.data as any)?.shiftGroups || [];
  }, [weekPlanQuery.data]);

  // Shifts View drag handler - move assignment to a different shift cell
  const handleShiftsViewDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragId(null);
    setActiveDragData(null);

    if (!over) return;

    // Check if this is a shift row reorder (from SortableContext)
    const activeData = active.data.current as { sortable?: { containerId: string }; type?: string; assignmentId?: string; shiftRowId?: string; shiftDate?: string };
    
    if (activeData?.type === "department" && active.id !== over.id) {
      const oldIndex = shiftGroupsList.findIndex((g: any) => g.id === active.id);
      const newIndex = shiftGroupsList.findIndex((g: any) => g.id === over.id);
      
      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        const newOrder = arrayMove([...shiftGroupsList], oldIndex, newIndex);
        reorderShiftGroupsMutation.mutate(newOrder.map((g: any) => g.id));
      }
      return;
    }
    
    if (activeData?.type === "shiftRow" && activeData?.sortable) {
      const sourceGroupId = activeData.groupId as string;
      const overData = over.data.current as any;
      
      // Check if dropped on a group drop zone (header area)
      if (overData?.type === "shiftGroupDrop" && overData.groupId !== sourceGroupId) {
        moveShiftRowGroupMutation.mutate({ rowId: String(active.id), targetGroupId: overData.groupId });
        return;
      }
      
      // Check if dropped on a group header (SortableDepartmentWrapper)
      if (overData?.type === "department") {
        const targetGrpId = String(over.id);
        if (targetGrpId !== sourceGroupId) {
          moveShiftRowGroupMutation.mutate({ rowId: String(active.id), targetGroupId: targetGrpId });
        }
        return;
      }
      
      // Check if dropped on a shift row in a different group
      if (overData?.type === "shiftRow" && overData?.groupId && overData.groupId !== sourceGroupId) {
        moveShiftRowGroupMutation.mutate({ rowId: String(active.id), targetGroupId: overData.groupId });
        return;
      }
      
      // Same group reorder
      if (active.id !== over.id) {
        const groupId = sourceGroupId;
        const allShiftRows = weekPlanQuery.data?.shiftRows || [];
        const groupRows = allShiftRows
          .filter((r: any) => r.shiftGroupId === groupId)
          .sort((a: any, b: any) => (a.sortOrderWithinGroup ?? a.rowOrder ?? 0) - (b.sortOrderWithinGroup ?? b.rowOrder ?? 0));
        
        const oldIndex = groupRows.findIndex((r: any) => r.id === active.id);
        const newIndex = groupRows.findIndex((r: any) => r.id === over.id);
        
        if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
          const newOrder = arrayMove(groupRows, oldIndex, newIndex);
          reorderShiftRowsMutation.mutate({
            shiftGroupId: groupId,
            orderedIds: newOrder.map((r: any) => r.id),
          });
        }
      }
      return;
    }

    // Original assignment move logic
    if (!active.data.current) return;
    const dragData = active.data.current as { assignmentId: string; shiftRowId: string; shiftDate: string };
    const dropData = over.data.current as { shiftRowId: string; date: string };

    // Don't move if dropping on the same cell
    if (!dropData?.shiftRowId || (dragData.shiftRowId === dropData.shiftRowId && dragData.shiftDate === dropData.date)) return;

    // Check if we're trying to modify a past date
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = new Date(dropData.date);
    const sourceDate = new Date(dragData.shiftDate);
    
    if (targetDate < today || sourceDate < today) {
      toast({
        title: "Cannot modify past schedules",
        description: "Schedules for past dates cannot be changed.",
        variant: "destructive",
      });
      return;
    }

    moveAssignmentMutation.mutate({
      assignmentId: dragData.assignmentId,
      shiftRowId: dropData.shiftRowId,
      shiftDate: dropData.date,
    });
  }, [moveAssignmentMutation, moveShiftRowGroupMutation, weekPlanQuery.data?.shiftRows, reorderShiftRowsMutation, shiftGroupsList, reorderShiftGroupsMutation, toast]);

  const saveAsTemplateMutation = useMutation({
    mutationFn: async () => {
      if (!selectedBranchId) throw new Error("No branch selected");
      return apiRequest("POST", "/api/schedule/templates/save-week", {
        weekPlanId: weekPlanQuery.data?.id || undefined,
        branchId: selectedBranchId,
        weekStartDate: weekStartFormatted,
        name: templateName,
        shiftGroupId: templateShiftGroupId || undefined,
        departmentId: templateDepartmentId || undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/schedule/templates", selectedBranchId] });
      setTemplateDialogOpen(false);
      setTemplateName("");
      setTemplateDepartmentId("");
      setTemplateShiftGroupId("");
      toast({ title: "Template saved", description: "Schedule template has been saved." });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to save template", description: err.message, variant: "destructive" });
    },
  });

  const applyTemplateMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTemplateId || !selectedBranchId) throw new Error("Missing data");
      const res = await apiRequest("POST", `/api/schedule/templates/${selectedTemplateId}/apply-safe`, {
        branchId: selectedBranchId,
        weekStartDate: weekStartFormatted,
      });
      return await res.json() as { rowsAdded: number; rowsSkipped: number; assignmentsApplied: number; timeOffApplied: number };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/schedule/week", selectedBranchId, weekStartFormatted] });
      queryClient.invalidateQueries({ queryKey: ["/api/time-off"] });
      setApplyTemplateDialogOpen(false);
      setSelectedTemplateId(null);
      setTemplatePreview(null);
      setTemplateApplyStep("select");
      const parts = [];
      if (data.rowsAdded > 0) parts.push(`${data.rowsAdded} shift row${data.rowsAdded !== 1 ? 's' : ''} added`);
      if (data.rowsSkipped > 0) parts.push(`${data.rowsSkipped} already existed`);
      if (data.assignmentsApplied > 0) parts.push(`${data.assignmentsApplied} assignment${data.assignmentsApplied !== 1 ? 's' : ''} applied`);
      if (data.timeOffApplied > 0) parts.push(`${data.timeOffApplied} day${data.timeOffApplied !== 1 ? 's' : ''} off applied`);
      toast({ 
        title: "Template applied", 
        description: parts.length > 0 ? parts.join(", ") + "." : "No changes needed."
      });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to apply template", description: err.message, variant: "destructive" });
    },
  });

  const handlePreviewTemplate = async () => {
    if (!selectedTemplateId || !selectedBranchId) return;
    setTemplatePreviewLoading(true);
    try {
      const res = await fetch(`/api/schedule/templates/${selectedTemplateId}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          branchId: selectedBranchId,
          weekStartDate: weekStartFormatted,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Preview failed");
      }
      const preview = await res.json();
      setTemplatePreview(preview);
      setTemplateApplyStep("preview");
    } catch (err: any) {
      toast({ title: "Preview failed", description: err.message, variant: "destructive" });
    } finally {
      setTemplatePreviewLoading(false);
    }
  };

  const clearViewLabel = timelineMode === "day" ? "Day" : timelineMode === "3day" ? "3 Days" : timelineMode === "month" ? "Month" : "Week";

  const clearWeekMutation = useMutation({
    mutationFn: async () => {
      if (!selectedBranchId) throw new Error("No branch selected");
      if (!clearDeptId) throw new Error("No department selected");
      if (!clearWeekStart) throw new Error("No week selected");
      const weekStartDate = new Date(clearWeekStart + "T00:00:00");
      const startDate = format(weekStartDate, "yyyy-MM-dd");
      const endDate = format(addDays(weekStartDate, 6), "yyyy-MM-dd");
      const res = await apiRequest("POST", `/api/schedule/clear`, {
        branchId: selectedBranchId,
        startDate,
        endDate,
        departmentId: clearDeptId,
      });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/schedule/week"] });
      queryClient.invalidateQueries({ queryKey: ["/api/time-off"] });
      setClearWeekDialogOpen(false);
      const deptName = allDepartments.find(d => d.id === clearDeptId)?.name || "department";
      toast({ title: "Schedule cleared", description: `Cleared ${deptName}: ${data.assignmentsRemoved ?? 0} assignments removed. You can restore from Schedule History if needed.` });
    },
    onError: (error: any) => {
      toast({ title: "Could not clear schedule", description: error?.message || "An unexpected error occurred. Please try again.", variant: "destructive" });
    },
  });

  // Live preview of what will be deleted — fetched whenever dept + week + branch are all selected
  const clearWeekEndDate = clearWeekStart
    ? format(addDays(new Date(clearWeekStart + "T00:00:00"), 6), "yyyy-MM-dd")
    : "";
  const clearPreviewQuery = useQuery<{
    assignments: number;
    breaks: number;
    employees: { id: string; name: string }[];
    department: string;
    branch: string;
  }>({
    queryKey: ["/api/schedule/clear-preview", selectedBranchId, clearDeptId, clearWeekStart],
    queryFn: async () => {
      const params = new URLSearchParams({
        branchId: selectedBranchId!,
        departmentId: clearDeptId,
        startDate: clearWeekStart,
        endDate: clearWeekEndDate,
      });
      const res = await fetch(`/api/schedule/clear-preview?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Preview failed");
      return res.json();
    },
    enabled: !!(selectedBranchId && clearDeptId && clearWeekStart && clearWeekDialogOpen),
    staleTime: 0,
  });

  const deleteTemplateMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/schedule/templates/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/schedule/templates", selectedBranchId] });
      toast({ title: "Template deleted" });
    },
  });

  const navigateTimeline = (direction: "prev" | "next") => {
    if (timelineMode === "month") {
      setCurrentMonth(direction === "prev" ? subMonths(currentMonth, 1) : addMonths(currentMonth, 1));
    } else if (timelineMode === "day") {
      setCurrentWeekStart(direction === "prev" ? addDays(currentWeekStart, -1) : addDays(currentWeekStart, 1));
    } else if (timelineMode === "3day") {
      setCurrentWeekStart(direction === "prev" ? addDays(currentWeekStart, -3) : addDays(currentWeekStart, 3));
    } else {
      setCurrentWeekStart(direction === "prev" ? subWeeks(currentWeekStart, 1) : addWeeks(currentWeekStart, 1));
    }
  };

  const goToToday = () => {
    const today = new Date();
    if (timelineMode === "day" || timelineMode === "3day") {
      setCurrentWeekStart(today);
    } else {
      setCurrentWeekStart(startOfWeek(today, { weekStartsOn: 1 }));
    }
    setCurrentMonth(startOfMonth(today));
  };

  const toggleDepartmentFilter = (deptId: string) => {
    setDepartmentFilter((prev) =>
      prev.includes(deptId) ? prev.filter((id) => id !== deptId) : [...prev, deptId]
    );
  };

  const toggleShiftGroupFilter = (groupId: string) => {
    setShiftGroupFilter((prev) =>
      prev.includes(groupId) ? prev.filter((id) => id !== groupId) : [...prev, groupId]
    );
  };

  const filteredShiftGroupsList = useMemo(() => {
    if (shiftGroupFilter.length === 0) return shiftGroupsList;
    return shiftGroupsList.filter((g: any) => shiftGroupFilter.includes(g.id));
  }, [shiftGroupsList, shiftGroupFilter]);

  useEffect(() => {
    if (shiftGroupFilter.length > 0 && shiftGroupsList.length > 0) {
      const validIds = new Set(shiftGroupsList.map((g: any) => g.id));
      const cleaned = shiftGroupFilter.filter(id => validIds.has(id));
      if (cleaned.length !== shiftGroupFilter.length) {
        setShiftGroupFilter(cleaned);
      }
    }
  }, [shiftGroupsList, shiftGroupFilter]);

  const groupedShiftRows = useMemo(() => {
    const map = new Map<string, ScheduleShiftRow[]>();
    if (!weekPlanQuery.data) return map;
    for (const row of weekPlanQuery.data.shiftRows) {
      const existing = map.get(row.departmentId) || [];
      existing.push(row);
      map.set(row.departmentId, existing);
    }
    // Sort each department's rows by rowOrder
    Array.from(map.entries()).forEach(([deptId, rows]) => {
      map.set(deptId, rows.sort((a: ScheduleShiftRow, b: ScheduleShiftRow) => (a.rowOrder ?? 0) - (b.rowOrder ?? 0)));
    });
    return map;
  }, [weekPlanQuery.data]);

  const groupedByShiftGroup = useMemo(() => {
    const map = new Map<string, ScheduleShiftRow[]>();
    if (!weekPlanQuery.data) return map;
    for (const row of weekPlanQuery.data.shiftRows) {
      const groupId = row.shiftGroupId || "ungrouped";
      const existing = map.get(groupId) || [];
      existing.push(row);
      map.set(groupId, existing);
    }
    Array.from(map.entries()).forEach(([groupId, rows]) => {
      map.set(groupId, rows.sort((a, b) => (a.sortOrderWithinGroup ?? a.rowOrder ?? 0) - (b.sortOrderWithinGroup ?? b.rowOrder ?? 0)));
    });
    return map;
  }, [weekPlanQuery.data]);

  const getShiftsForEmployee = useCallback((employee: Employee | EmployeeOrCasual) => {
    const employeeRoleIds = new Set((employee.roles || []).map(r => r.roleId));
    const allRows = weekPlanQuery.data?.shiftRows || [];
    const groups = (weekPlanQuery.data as any)?.shiftGroups || [];
    const groupMap = new Map<string, { id: string; name: string }>();
    for (const g of groups) groupMap.set(g.id, g);

    const matchedByGroup = new Map<string, ScheduleShiftRow[]>();

    for (const row of allRows) {
      // Department guard: only show shifts that belong to the employee's department.
      // Mirrors the server-side filter in getEligibleEmployeesForShiftRow.
      if (row.departmentId && employee.primaryDepartmentId &&
          row.departmentId !== employee.primaryDepartmentId) continue;

      const shiftRoleIds = row.roles.map(r => r.roleId);
      if (shiftRoleIds.length === 0) continue;
      const hasMatchingRole = shiftRoleIds.some(rid => employeeRoleIds.has(rid));
      if (!hasMatchingRole) continue;

      const groupId = row.shiftGroupId || "ungrouped";
      const existing = matchedByGroup.get(groupId) || [];
      existing.push(row);
      matchedByGroup.set(groupId, existing);
    }

    const result: { groupId: string; groupName: string; rows: ScheduleShiftRow[] }[] = [];
    for (const g of groups) {
      const rows = matchedByGroup.get(g.id);
      if (rows && rows.length > 0) {
        rows.sort((a, b) => (a.sortOrderWithinGroup ?? a.rowOrder ?? 0) - (b.sortOrderWithinGroup ?? b.rowOrder ?? 0));
        result.push({ groupId: g.id, groupName: g.name, rows });
      }
    }
    const ungrouped = matchedByGroup.get("ungrouped");
    if (ungrouped && ungrouped.length > 0) {
      ungrouped.sort((a, b) => (a.rowOrder ?? 0) - (b.rowOrder ?? 0));
      result.push({ groupId: "ungrouped", groupName: "Other Shifts", rows: ungrouped });
    }
    return result;
  }, [weekPlanQuery.data]);

  const activeEmployees = useMemo(() => {
    return (employeesQuery.data || []).filter(
      (e) => e.employmentState === "ACTIVE" || e.employmentState === "LEAVING" ||
        (e.employmentState === "LEFT" && e.lastWorkingDay)
    );
  }, [employeesQuery.data]);

  // Search-filtered employees
  const searchFilteredEmployees = useMemo(() => {
    if (!searchTerm.trim()) return activeEmployees;
    
    const term = searchTerm.toLowerCase().trim();
    
    return activeEmployees.filter((emp) => {
      // Match by employee name
      if (emp.fullName.toLowerCase().includes(term)) return true;
      // Match by nickname
      if (emp.nickname?.toLowerCase().includes(term)) return true;
      // Match by department name
      const dept = departments.find(d => d.id === emp.primaryDepartmentId);
      if (dept?.name.toLowerCase().includes(term)) return true;
      return false;
    });
  }, [activeEmployees, searchTerm, departments]);

  // Combined type for employees and casual workers in employee view
  type EmployeeOrCasual = Employee & { isCasualWorker?: boolean; casualStartDate?: string; casualEndDate?: string };

  const employeesByDepartment = useMemo(() => {
    const map = new Map<string, EmployeeOrCasual[]>();
    
    // Add regular employees (using search-filtered list)
    for (const emp of searchFilteredEmployees) {
      const deptId = emp.primaryDepartmentId || "unassigned";
      const existing = map.get(deptId) || [];
      existing.push({ ...emp, isCasualWorker: false });
      map.set(deptId, existing);
    }
    
    // Add casual workers (mapped to employee-like structure), also apply search filter
    const casualWorkers = casualWorkersForEmployeeViewQuery.data || [];
    const term = searchTerm.toLowerCase().trim();
    for (const cw of casualWorkers) {
      // Apply search filter to casual workers too
      if (term) {
        const matchesName = cw.fullName.toLowerCase().includes(term);
        const matchesNickname = cw.nickname?.toLowerCase().includes(term);
        const dept = departments.find(d => d.id === cw.departmentId);
        const matchesDept = dept?.name.toLowerCase().includes(term);
        if (!matchesName && !matchesNickname && !matchesDept) continue;
      }
      
      const deptId = cw.departmentId || "unassigned";
      const existing = map.get(deptId) || [];
      // Create employee-like structure for casual worker
      const employeeLike: EmployeeOrCasual = {
        id: `casual-${cw.id}`,
        fullName: cw.fullName,
        nickname: cw.nickname,
        branchId: cw.branchId,
        employmentState: "CASUAL",
        primaryDepartmentId: cw.departmentId,
        weeklyOffDays: null,
        profilePhotoPath: null,
        displayOrder: 9999,
        isCasualWorker: true,
        casualStartDate: cw.startDate,
        casualEndDate: cw.endDate,
        roles: cw.roleId ? [{ roleId: cw.roleId, roleName: cw.role?.name || "", isPrimary: true }] : [],
      };
      existing.push(employeeLike);
      map.set(deptId, existing);
    }
    
    // Sort employees within each department by displayOrder
    for (const [, emps] of Array.from(map.entries())) {
      emps.sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
    }
    return map;
  }, [searchFilteredEmployees, casualWorkersForEmployeeViewQuery.data, searchTerm, departments]);

  const getAssignmentsForCell = (row: ScheduleShiftRow, day: Date) => {
    const dateStr = format(day, "yyyy-MM-dd");
    return row.assignments.filter((a) => a.shiftDate === dateStr);
  };

  const getEmployeeAssignmentsForDate = (employeeId: string, day: Date) => {
    const dateStr = format(day, "yyyy-MM-dd");
    const assignments: { assignment: ScheduleAssignment; shiftRow: ScheduleShiftRow }[] = [];
    // Use allShiftRows which includes all weeks in month mode
    const shiftRows = timelineMode === "month" ? allShiftRows : (weekPlanQuery.data?.shiftRows || []);
    for (const row of shiftRows) {
      for (const a of row.assignments) {
        if (a.employeeId === employeeId && a.shiftDate === dateStr) {
          assignments.push({ assignment: a, shiftRow: row });
        }
      }
    }
    return assignments;
  };

  const getCasualWorkerAssignmentsForDate = (casualWorkerId: string, day: Date) => {
    const dateStr = format(day, "yyyy-MM-dd");
    const assignments: { assignment: ScheduleAssignment; shiftRow: ScheduleShiftRow }[] = [];
    // Use allShiftRows which includes all weeks in month mode
    const shiftRows = timelineMode === "month" ? allShiftRows : (weekPlanQuery.data?.shiftRows || []);
    for (const row of shiftRows) {
      for (const a of row.assignments) {
        if (a.casualWorkerId === casualWorkerId && a.shiftDate === dateStr) {
          assignments.push({ assignment: a, shiftRow: row });
        }
      }
    }
    return assignments;
  };

  // Check if a casual worker can be assigned to a specific shift row (no overlapping shifts)
  const canAssignCasualWorkerToShift = (casualWorkerId: string, targetRowId: string, dateStr: string): boolean => {
    const shiftRows = timelineMode === "month" ? allShiftRows : (weekPlanQuery.data?.shiftRows || []);
    
    // Find the target shift row to get its time
    const targetRow = shiftRows.find(r => r.id === targetRowId);
    if (!targetRow) return true;
    
    // Parse target shift times
    const parseTime = (timeStr: string | null): number => {
      if (!timeStr) return 0;
      const [hours, minutes] = timeStr.split(":").map(Number);
      return hours * 60 + (minutes || 0);
    };
    
    const targetStart = parseTime(targetRow.startTime);
    const targetEnd = parseTime(targetRow.endTime);
    
    // Find all existing assignments for this casual worker on this date
    for (const row of shiftRows) {
      for (const a of row.assignments) {
        if (a.casualWorkerId === casualWorkerId && a.shiftDate === dateStr) {
          // Check for time overlap
          const existingStart = parseTime(row.startTime);
          const existingEnd = parseTime(row.endTime);
          
          // Overlap occurs if: existingStart < targetEnd AND existingEnd > targetStart
          if (existingStart < targetEnd && existingEnd > targetStart) {
            return false;
          }
        }
      }
    }
    return true;
  };

  // Get available casual workers for a specific shift (filter out those with overlapping shifts)
  const getAvailableCasualWorkers = (casualWorkers: CasualWorker[], shiftRowId: string, dateStr: string): CasualWorker[] => {
    return casualWorkers.filter(cw => canAssignCasualWorkerToShift(cw.id, shiftRowId, dateStr));
  };

  const getTimeOffForDate = (employeeId: string, day: Date): EmployeeTimeOff | undefined => {
    if (!timeOffQuery.data) return undefined;
    const dateStr = format(day, "yyyy-MM-dd");
    return timeOffQuery.data.find((to) => {
      if (to.employeeId !== employeeId) return false;
      // Convert ISO dates to yyyy-MM-dd for comparison
      const startDateStr = to.startDate.slice(0, 10);
      const endDateStr = to.endDate.slice(0, 10);
      return startDateStr <= dateStr && endDateStr >= dateStr;
    });
  };

  // Day-bucket aggregation: returns events overlapping the given day, sorted by start time
  // Uses overlap rule per spec: include if (eventStart < dayEnd) AND (eventEnd > dayStart)
  const getEventsForDate = (day: Date): BranchEvent[] => {
    if (!branchEventsQuery.data) return [];
    const dayStart = new Date(day);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(day);
    dayEnd.setHours(24, 0, 0, 0); // Start of next day (exclusive)
    
    // Filter events using strict overlap rule: (eventStart < dayEnd) AND (eventEnd > dayStart)
    const overlapping = branchEventsQuery.data.filter((event) => {
      const eventStart = new Date(event.startDateTime);
      const eventEnd = new Date(event.endDateTime);
      return eventStart < dayEnd && eventEnd > dayStart;
    });
    
    // Sort by start time for consistent display order
    return overlapping.sort((a, b) => 
      new Date(a.startDateTime).getTime() - new Date(b.startDateTime).getTime()
    );
  };

  const isEmployeeOffDay = (employee: Employee, day: Date): boolean => {
    if (!employee.weeklyOffDays || employee.weeklyOffDays.length === 0) return false;
    const dayOfWeek = day.getDay();
    return employee.weeklyOffDays.includes(dayOfWeek);
  };

  // Check if an employee should be shown in the current branch's schedule for a specific date
  // Transferred employees show in old branch only until their transfer effective date
  const isEmployeeVisibleForDate = (employee: Employee, day: Date): boolean => {
    if ((employee.employmentState === 'LEAVING' || employee.employmentState === 'LEFT') && employee.lastWorkingDay) {
      const dateStr = format(day, 'yyyy-MM-dd');
      if (dateStr > employee.lastWorkingDay) return false;
    }

    const transferInfo = employee.schedulingTransferInfo;
    if (!transferInfo) return true; // No transfer, always visible
    
    // Employee was transferred from this branch
    // They should only be visible for dates before the effective date
    const dateStr = format(day, "yyyy-MM-dd");
    return dateStr <= transferInfo.lastDateInOldBranch;
  };

  // Check if a casual worker is active on a given date (within their contract period)
  const isCasualWorkerActiveForDate = (employee: EmployeeOrCasual, day: Date): boolean => {
    if (!employee.isCasualWorker) return true; // Regular employees are always active
    const dateStr = format(day, "yyyy-MM-dd");
    const startDate = employee.casualStartDate || "";
    const endDate = employee.casualEndDate || "";
    return dateStr >= startDate && dateStr <= endDate;
  };

  const getOpenShifts = (day: Date) => {
    const dateStr = format(day, "yyyy-MM-dd");
    const openShifts: ScheduleShiftRow[] = [];
    if (!weekPlanQuery.data) return openShifts;
    for (const row of weekPlanQuery.data.shiftRows) {
      const hasAssignments = row.assignments.some((a) => a.shiftDate === dateStr);
      if (!hasAssignments) {
        openShifts.push(row);
      }
    }
    return openShifts;
  };

  const getStaffRequiredForDay = (row: ScheduleShiftRow, day: Date): number => {
    const dayKey = format(day, "EEE").toLowerCase();
    const byDay = row.staffRequiredByDay as Record<string, number> | null;
    if (byDay && byDay[dayKey] !== undefined) {
      return byDay[dayKey];
    }
    return row.staffRequired ?? 1;
  };

  // Get understaffed shifts for a specific department on a specific day
  const getUnderstaffedShiftsForDay = (departmentId: string, day: Date): { row: ScheduleShiftRow; required: number; assigned: number }[] => {
    if (!weekPlanQuery.data) return [];
    const result: { row: ScheduleShiftRow; required: number; assigned: number }[] = [];
    const deptRows = weekPlanQuery.data.shiftRows.filter((r) => r.departmentId === departmentId);
    
    // Only check if day is within the current week's data range
    const weekStartDate = currentWeekStart;
    const weekEndDate = addDays(weekStartDate, 6);
    if (day < weekStartDate || day > weekEndDate) return [];
    
    const dateStr = format(day, "yyyy-MM-dd");
    for (const row of deptRows) {
      const required = getStaffRequiredForDay(row, day);
      const assigned = row.assignments.filter((a) => a.shiftDate === dateStr).length;
      if (assigned < required) {
        result.push({ row, required, assigned });
      }
    }
    return result;
  };

  const getUnderstaffedShiftsForGroup = (shiftGroupId: string, day: Date): { row: ScheduleShiftRow; required: number; assigned: number }[] => {
    if (!weekPlanQuery.data) return [];
    const result: { row: ScheduleShiftRow; required: number; assigned: number }[] = [];
    const groupRows = weekPlanQuery.data.shiftRows.filter((r: any) => (r.shiftGroupId || "ungrouped") === shiftGroupId);
    const weekStartDate = currentWeekStart;
    const weekEndDate = addDays(weekStartDate, 6);
    if (day < weekStartDate || day > weekEndDate) return [];
    const dateStr = format(day, "yyyy-MM-dd");
    for (const row of groupRows) {
      const required = getStaffRequiredForDay(row, day);
      const assigned = row.assignments.filter((a: any) => a.shiftDate === dateStr).length;
      if (assigned < required) {
        result.push({ row, required, assigned });
      }
    }
    return result;
  };

  const handleCreateShiftRow = async () => {
    if (!selectedBranchId) return;
    
    if (!shiftRowForm.label?.trim()) {
      toast({ title: "Error", description: "Shift name is required", variant: "destructive" });
      return;
    }
    if (shiftRowForm.roleIds.length === 0) {
      toast({ title: "Error", description: "At least one role is required", variant: "destructive" });
      return;
    }
    
    createShiftRowMutation.mutate({
      branchId: selectedBranchId,
      shiftGroupId: selectedShiftGroupId || undefined,
      ...shiftRowForm,
    });
  };

  const handleAssignEmployee = (employeeId: string) => {
    if (!assignmentPopover) return;
    createAssignmentMutation.mutate({
      shiftRowId: assignmentPopover.shiftRowId,
      shiftDate: assignmentPopover.date,
      employeeId,
      assigneeType: "employee",
    });
  };

  const handleAssignCasualWorker = (casualWorkerId: string, dailyRate: number) => {
    if (!assignmentPopover) return;
    createAssignmentMutation.mutate({
      shiftRowId: assignmentPopover.shiftRowId,
      shiftDate: assignmentPopover.date,
      casualWorkerId,
      assigneeType: "casual",
      dailyRateSnapshot: dailyRate,
    });
  };

  const handleSaveAsTemplate = () => {
    if (!templateName.trim()) return;
    if (viewMode === "employees" && !templateDepartmentId) return;
    if (viewMode === "shifts" && !templateShiftGroupId) return;
    saveAsTemplateMutation.mutate();
  };

  const handleApplyTemplate = () => {
    if (!selectedTemplateId) return;
    if (templateApplyStep === "select") {
      handlePreviewTemplate();
    } else {
      applyTemplateMutation.mutate();
    }
  };

  const handleCloseApplyDialog = () => {
    setApplyTemplateDialogOpen(false);
    setSelectedTemplateId(null);
    setTemplatePreview(null);
    setTemplateApplyStep("select");
  };

  const handleScanConflicts = async () => {
    setConflictScanLoading(true);
    setConflictScanResults(null);
    setConflictResolutions(new Map());
    setConflictUndoStack([]);
    try {
      const url = selectedBranchId 
        ? `/api/schedule/conflicts/scan?branchId=${selectedBranchId}` 
        : `/api/schedule/conflicts/scan`;
      const res = await apiRequest("GET", url);
      const data = await res.json();
      setConflictScanResults(data);
    } catch (error: any) {
      toast({ title: "Scan failed", description: error.message, variant: "destructive" });
    } finally {
      setConflictScanLoading(false);
    }
  };

  const [generateBreaksLoading, setGenerateBreaksLoading] = useState(false);
  const handleGenerateAllBreaks = async () => {
    setGenerateBreaksLoading(true);
    try {
      const url = selectedBranchId
        ? `/api/schedule/breaks/generate-all?branchId=${selectedBranchId}`
        : `/api/schedule/breaks/generate-all`;
      const res = await apiRequest("POST", url);
      const data = await res.json();
      toast({ title: "Breaks generated", description: `Processed ${data.shiftRowsProcessed} shift rows across ${data.datesProcessed} dates.` });
      queryClient.invalidateQueries({ queryKey: ["/api/schedule"] });
    } catch (error: any) {
      toast({ title: "Failed to generate breaks", description: error.message, variant: "destructive" });
    } finally {
      setGenerateBreaksLoading(false);
    }
  };

  const handleAutoFixConflicts = async () => {
    setAutoFixLoading(true);
    try {
      const res = await apiRequest("POST", "/api/schedule/conflicts/auto-fix", { branchId: selectedBranchId || undefined });
      const data = await res.json();
      toast({ title: "Conflicts fixed", description: `${data.conflictsFixed} conflicts resolved, ${data.recordsDeleted} records removed.` });
      setConflictScanDialogOpen(false);
      setConflictScanResults(null);
      queryClient.invalidateQueries({ queryKey: ["/api/schedule"] });
    } catch (error: any) {
      toast({ title: "Auto-fix failed", description: error.message, variant: "destructive" });
    } finally {
      setAutoFixLoading(false);
    }
  };

  const handleSelectConflictItem = (conflictKey: string, keptId: string, type: 'shift' | 'dayoff') => {
    setConflictResolutions(prev => {
      const next = new Map(prev);
      next.set(conflictKey, { kept: keptId, type });
      return next;
    });
    setConflictUndoStack(prev => [...prev, conflictKey]);
  };

  const handleUndoConflictSelection = () => {
    setConflictUndoStack(prev => {
      if (prev.length === 0) return prev;
      const lastKey = prev[prev.length - 1];
      setConflictResolutions(prevRes => {
        const next = new Map(prevRes);
        next.delete(lastKey);
        return next;
      });
      return prev.slice(0, -1);
    });
  };

  const handleApplyConflictResolutions = async () => {
    if (!conflictScanResults || conflictResolutions.size === 0) return;
    setAutoFixLoading(true);
    try {
      let totalDeleted = 0;
      for (const [key, resolution] of conflictResolutions) {
        const conflict = conflictScanResults.conflicts.find(
          (c: any) => `${c.employeeId}_${c.date}` === key
        );
        if (!conflict) continue;

        if (resolution.type === 'dayoff') {
          await apiRequest("POST", "/api/schedule/conflicts/resolve", {
            employeeId: conflict.employeeId,
            date: conflict.date,
            deleteAssignmentIds: conflict.assignments.map((a: any) => a.id),
            deleteDayOffIds: [],
          });
        } else {
          const deleteAssignmentIds = conflict.assignments
            .map((a: any) => a.id)
            .filter((id: string) => id !== resolution.kept);
          await apiRequest("POST", "/api/schedule/conflicts/resolve", {
            employeeId: conflict.employeeId,
            date: conflict.date,
            keepAssignmentId: resolution.kept,
            deleteAssignmentIds,
            deleteDayOffIds: conflict.hasDayOff ? conflict.dayOffIds : [],
          });
        }
        totalDeleted++;
      }
      toast({ title: "Conflicts resolved", description: `${totalDeleted} conflict${totalDeleted !== 1 ? 's' : ''} resolved.` });
      setConflictResolutions(new Map());
      setConflictUndoStack([]);
      handleScanConflicts();
      queryClient.invalidateQueries({ queryKey: ["/api/schedule"] });
    } catch (error: any) {
      toast({ title: "Resolution failed", description: error.message, variant: "destructive" });
    } finally {
      setAutoFixLoading(false);
    }
  };

  const isLoading = departmentsQuery.isLoading || weekPlanQuery.isLoading;
  const isCompact = timelineMode === "month" || timelineMode === "3day";

  // Draggable shift card wrapper
  const DraggableShiftCard = ({ id, assignmentId, shiftRowId, employeeId, shiftDate, shiftName, isMonthView = false, children }: {
    id: string;
    assignmentId: string;
    shiftRowId: string;
    employeeId: string;
    shiftDate: string;
    shiftName: string;
    isMonthView?: boolean;
    children: React.ReactNode;
  }) => {
    const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
      id,
      data: { assignmentId, shiftRowId, employeeId, shiftDate, shiftName },
    });
    const style: React.CSSProperties = {
      transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
      zIndex: isDragging ? 100 : undefined,
      opacity: isDragging ? 0.85 : 1,
      touchAction: 'none', // Prevent text selection and scrolling during drag
      userSelect: 'none',
      WebkitUserSelect: 'none',
    };
    // When dragging, use transform for movement; otherwise use appropriate anchor class
    const anchorStyle: React.CSSProperties = isDragging ? {
      ...style,
      position: 'fixed',
      transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    } : isMonthView ? style : {
      ...style,
      width: '100%',
    };
    
    return (
      <div 
        ref={setNodeRef} 
        style={anchorStyle} 
        {...listeners} 
        {...attributes} 
        className={cn(
          "select-none",
          isDragging ? "cursor-grabbing scale-105 shadow-lg" : isMonthView ? "monthBadgeAnchor cursor-grab" : "shiftCell__anchor cursor-grab"
        )}
      >
        {children}
      </div>
    );
  };

  // Draggable leave/time-off card wrapper
  const DraggableLeaveCard = ({ id, timeOffId, employeeId, currentDate, isMonthView = false, children }: {
    id: string;
    timeOffId: string;
    employeeId: string;
    currentDate: string;
    isMonthView?: boolean;
    children: React.ReactNode;
  }) => {
    const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
      id,
      data: { timeOffId, employeeId, currentDate, isTimeOff: true },
    });
    const style: React.CSSProperties = {
      zIndex: isDragging ? 100 : undefined,
      opacity: isDragging ? 0.85 : 1,
      touchAction: 'none',
      userSelect: 'none',
      WebkitUserSelect: 'none',
    };
    // When dragging, use transform for movement; otherwise use appropriate anchor class
    const anchorStyle: React.CSSProperties = isDragging ? {
      ...style,
      position: 'fixed',
      transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    } : isMonthView ? style : {
      ...style,
      width: '100%',
    };
    
    return (
      <div 
        ref={setNodeRef} 
        style={anchorStyle} 
        {...listeners} 
        {...attributes} 
        className={cn(
          "select-none",
          isDragging ? "cursor-grabbing scale-105 shadow-lg" : isMonthView ? "monthBadgeAnchor cursor-grab" : "shiftCell__anchor cursor-grab"
        )}
      >
        {children}
      </div>
    );
  };

  // Droppable cell wrapper
  const DroppableCell = ({ id, employeeId, date, className, children, onClick }: {
    id: string;
    employeeId: string;
    date: string;
    className?: string;
    children: React.ReactNode;
    onClick?: (e: React.MouseEvent) => void;
  }) => {
    const { isOver, setNodeRef } = useDroppable({
      id,
      data: { employeeId, date },
    });
    return (
      <div ref={setNodeRef} className={cn("overflow-hidden", className, isOver && "ring-2 ring-primary ring-inset bg-primary/10")} onClick={onClick}>
        {children}
      </div>
    );
  };

  // Shifts View: Draggable assignment pill for moving between shift cells
  const DraggableAssignmentPill = ({ id, assignmentId, shiftRowId, employeeId, employeeName, shiftDate, className, isSick, hasTimeOff, isBorrowed, borrowedFromBranchName, colorIndex, shiftStartTime, shiftEndTime, shiftLabel }: {
    id: string;
    assignmentId: string;
    shiftRowId: string;
    employeeId: string;
    employeeName: string;
    shiftDate: string;
    className?: string;
    isSick?: boolean;
    hasTimeOff?: boolean;
    isBorrowed?: boolean;
    borrowedFromBranchName?: string;
    colorIndex?: number | null;
    shiftStartTime?: string;
    shiftEndTime?: string;
    shiftLabel?: string;
  }) => {
    const [pillPopoverOpen, setPillPopoverOpen] = useState(false);

    const pillDutyBlocksQuery = useQuery<DutyBlock[]>({
      queryKey: ["/api/duty-blocks", { branchId: selectedBranchId, date: shiftDate, employeeId }],
      queryFn: async () => {
        const params = new URLSearchParams({ branchId: selectedBranchId!, date: shiftDate, employeeId });
        const res = await fetch(`/api/duty-blocks?${params}`, { credentials: "include" });
        if (!res.ok) throw new Error("Failed to fetch duty blocks");
        return res.json();
      },
      enabled: pillPopoverOpen && !!selectedBranchId,
    });
    const pillAssignmentBlocks = (pillDutyBlocksQuery.data || [])
      .filter((b: DutyBlock) => b.assignmentId === assignmentId)
      .sort((a: DutyBlock, b: DutyBlock) => a.startTime.localeCompare(b.startTime));

    const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
      id,
      data: { assignmentId, shiftRowId, employeeId, shiftDate },
    });
    const style: React.CSSProperties | undefined = isDragging ? {
      opacity: 0.3,
    } : undefined;
    const pillColor = colorIndex != null ? getShiftColorByIndex(colorIndex) : getEmployeeColor(employeeId);
    return (
      <Popover open={pillPopoverOpen} onOpenChange={setPillPopoverOpen}>
        <PopoverTrigger asChild>
          <div
            ref={setNodeRef}
            style={style}
            {...listeners}
            {...attributes}
            className={cn(
              "text-[10px] font-medium truncate leading-tight text-center px-1 py-0.5 rounded-sm text-white w-full relative",
              pillColor,
              isSick && "line-through opacity-70",
              hasTimeOff && !isSick && "opacity-70",
              isBorrowed && "ring-2 ring-yellow-400 ring-offset-1",
              isDragging ? "cursor-grabbing shadow-lg" : "cursor-grab",
              className
            )}
            title={isBorrowed ? `Borrowed from ${borrowedFromBranchName || 'another branch'}` : undefined}
            onClick={(e) => {
              if (!isDragging) {
                e.stopPropagation();
                setPillPopoverOpen(true);
              }
            }}
            data-testid={`pill-employee-${employeeId}`}
          >
            {employeeName}
            {isBorrowed && (
              <span className="absolute -top-1.5 -right-1.5 bg-yellow-500 text-yellow-950 text-[8px] font-bold px-1 rounded shadow-sm z-10">
                B
              </span>
            )}
          </div>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-2" align="start">
          <div className="space-y-1.5">
            <div className="px-1">
              <div className="text-sm font-medium">{shiftLabel || "Shift"}</div>
              {shiftStartTime && shiftEndTime && (
                <div className="text-xs text-muted-foreground font-mono">
                  {shiftStartTime.slice(0, 5)} - {shiftEndTime.slice(0, 5)}
                </div>
              )}
              <div className="text-xs text-muted-foreground mt-0.5">{employeeName}</div>
            </div>

            {pillAssignmentBlocks.length > 0 && (
              <>
                <div className="border-t my-1" />
                <div className="px-1 space-y-1">
                  <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Duty Blocks</div>
                  {pillAssignmentBlocks.map((block: DutyBlock) => (
                    <div key={block.id} className="flex items-center gap-1.5 text-xs">
                      <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-primary/60" />
                      <span className="font-mono text-muted-foreground shrink-0">
                        {block.startTime.slice(0, 5)}
                      </span>
                      <span className="truncate">{block.dutyName || "Duty"}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="border-t my-1" />
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-xs h-7"
              onClick={() => {
                setPillPopoverOpen(false);
                if (shiftStartTime && shiftEndTime) {
                  setDutyBlocksSheetData({
                    assignmentId,
                    employeeId,
                    employeeName,
                    date: shiftDate,
                    shiftStartTime,
                    shiftEndTime,
                    shiftName: shiftLabel || "Shift",
                  });
                }
              }}
              data-testid={`button-pill-duty-blocks-${assignmentId}`}
            >
              <ListChecks className="h-3.5 w-3.5 mr-1.5" />
              {pillAssignmentBlocks.length > 0 ? "Manage Duty Blocks" : "Add Duty Blocks"}
            </Button>
            {isManager && !isPastDate(shiftDate) && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-xs h-7 text-destructive"
                onClick={() => {
                  setPillPopoverOpen(false);
                  deleteAssignmentMutation.mutate(assignmentId);
                }}
                data-testid={`button-pill-unassign-${assignmentId}`}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                Unassign
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>
    );
  };

  // Shifts View: Droppable shift cell wrapper
  const DroppableShiftCell = ({ id, shiftRowId, date, className, children, onClick }: {
    id: string;
    shiftRowId: string;
    date: string;
    className?: string;
    children: React.ReactNode;
    onClick?: (e: React.MouseEvent) => void;
  }) => {
    const { isOver, setNodeRef } = useDroppable({
      id,
      data: { shiftRowId, date },
    });
    return (
      <div ref={setNodeRef} className={cn("overflow-hidden", className, isOver && "ring-2 ring-primary ring-inset bg-primary/10")} onClick={onClick}>
        {children}
      </div>
    );
  };


  // Handle shift row reorder drag end
  const handleShiftRowReorder = (event: DragEndEvent, departmentId: string, rows: ScheduleShiftRow[]) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = rows.findIndex((r) => r.id === active.id);
      const newIndex = rows.findIndex((r) => r.id === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        const newOrder = arrayMove(rows, oldIndex, newIndex);
        reorderShiftRowsMutation.mutate({
          departmentId,
          orderedIds: newOrder.map((r) => r.id),
        });
      }
    }
  };

  const columnCount = visibleDays.length;
  // Grid column widths - widened for better readability on mobile
  const gridCols = timelineMode === "month"
    ? "" // Use inline style for month view
    : columnCount === 1
      ? "grid-cols-[200px_minmax(0,1fr)] sm:grid-cols-[280px_minmax(0,1fr)]"
      : columnCount === 3
        ? "grid-cols-[180px_repeat(3,minmax(0,1fr))] sm:grid-cols-[240px_repeat(3,minmax(0,1fr))]"
        : "grid-cols-[200px_repeat(7,minmax(0,1fr))] sm:grid-cols-[280px_repeat(7,minmax(0,1fr))]";
  
  // First column width classes to match grid definition (for sticky behavior)
  // Widened for better readability on mobile
  const firstColWidth = timelineMode === "month"
    ? "w-[200px] min-w-[200px] max-w-[200px]"
    : columnCount === 1
      ? "w-[200px] sm:w-[280px] min-w-[200px] sm:min-w-[280px] max-w-[200px] sm:max-w-[280px]"
      : columnCount === 3
        ? "w-[180px] sm:w-[240px] min-w-[180px] sm:min-w-[240px] max-w-[180px] sm:max-w-[240px]"
        : "w-[200px] sm:w-[280px] min-w-[200px] sm:min-w-[280px] max-w-[200px] sm:max-w-[280px]";
  
  // For month view, use inline style since dynamic Tailwind classes don't work at runtime
  // First column is wider (200px) to show department/employee names
  const monthGridStyle = timelineMode === "month" 
    ? { gridTemplateColumns: `200px repeat(${columnCount}, 35px)` } 
    : undefined;

  return (
    <div className="p-2 md:p-4 space-y-2">
      <div className="flex items-center gap-2 flex-wrap sticky top-0 z-50 bg-background py-2 -mt-2">
        <div className="inline-flex rounded-md border bg-muted/30 p-0.5" data-testid="view-mode-toggle">
          <button
            onClick={() => setViewMode("employees")}
            className={cn(
              "flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-sm transition-colors",
              viewMode === "employees"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            data-testid="button-view-employees"
          >
            <UserCircle className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Employees</span>
          </button>
          <button
            onClick={() => setViewMode("shifts")}
            className={cn(
              "flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-sm transition-colors",
              viewMode === "shifts"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            data-testid="button-view-shifts"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Shifts</span>
          </button>
          <button
            onClick={() => {
              setViewMode("timeline");
              setTimelineMode("day");
              setCurrentWeekStart(new Date());
            }}
            className={cn(
              "flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-sm transition-colors",
              viewMode === "timeline"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            data-testid="button-view-timeline"
          >
            <GanttChart className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Timeline</span>
          </button>
        </div>

        <div className="h-4 w-px bg-border hidden sm:block" />

        <TimelineControls
          mode={timelineMode}
          onModeChange={(mode) => {
            const prevMode = timelineMode;
            setTimelineMode(mode);
            const keepContext = prevMode === "month" || prevMode === "week" || prevMode === "3day" || prevMode === "day";
            if (keepContext && mode !== "month") {
              const anchor = prevMode === "month" ? startOfMonth(currentMonth) : currentWeekStart;
              if (mode === "week") {
                setCurrentWeekStart(startOfWeek(anchor, { weekStartsOn: 1 }));
              } else {
                setCurrentWeekStart(anchor);
              }
            }
            if (mode !== "day" && viewMode === "timeline") {
              setViewMode("employees");
            }
          }}
          dateRangeLabel={dateRangeLabel}
          onPrev={() => navigateTimeline("prev")}
          onNext={() => navigateTimeline("next")}
          onToday={goToToday}
        />

        <div className="h-4 w-px bg-border hidden sm:block" />

        {/* Search bar */}
        <div className="relative hidden md:flex items-center">
          <Search className="absolute left-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            type="text"
            placeholder="Search employee, department, role..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-8 h-8 w-[220px] text-sm"
            data-testid="input-schedule-search"
          />
          {searchTerm && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-1 h-6 w-6"
              onClick={() => setSearchTerm("")}
              data-testid="button-clear-search"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5"
          onClick={() => toggleCollapseAll(
            viewMode === "shifts"
              ? shiftGroupsList.map((g: any) => g.id)
              : allDepartments.map(d => d.id)
          )}
          data-testid="button-toggle-collapse-all"
        >
          <ChevronsUpDown className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{
            viewMode === "shifts"
              ? collapsedDepts.size === shiftGroupsList.length ? "Expand All" : "Collapse All"
              : collapsedDepts.size === allDepartments.length ? "Expand All" : "Collapse All"
          }</span>
        </Button>

        <div className="flex-1" />

        {viewMode === "shifts" ? (
          <Popover open={shiftGroupFilterOpen} onOpenChange={setShiftGroupFilterOpen}>
            <PopoverTrigger asChild>
              <Button
                variant={shiftGroupFilter.length > 0 ? "default" : "ghost"}
                size="sm"
                className="h-7 px-2"
                data-testid="button-shift-group-filter"
              >
                <Filter className="h-3.5 w-3.5" />
                {shiftGroupFilter.length > 0 && (
                  <span className="ml-1 text-xs">{shiftGroupFilter.length}</span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-2" align="end">
              <div className="space-y-1">
                {shiftGroupsList.map((group: any) => (
                  <label
                    key={group.id}
                    className="flex items-center gap-2 p-2 rounded cursor-pointer hover-elevate"
                  >
                    <Checkbox
                      checked={shiftGroupFilter.includes(group.id)}
                      onCheckedChange={() => toggleShiftGroupFilter(group.id)}
                      data-testid={`checkbox-shift-group-filter-${group.id}`}
                    />
                    <span className="text-sm">{group.name}</span>
                  </label>
                ))}
                {shiftGroupsList.length === 0 && (
                  <p className="text-sm text-muted-foreground p-2">No shift groups</p>
                )}
                {shiftGroupFilter.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full mt-2"
                    onClick={() => setShiftGroupFilter([])}
                    data-testid="button-clear-shift-group-filter"
                  >
                    Clear Filter
                  </Button>
                )}
              </div>
            </PopoverContent>
          </Popover>
        ) : (
          <Popover open={departmentFilterOpen} onOpenChange={setDepartmentFilterOpen}>
            <PopoverTrigger asChild>
              <Button
                variant={departmentFilter.length > 0 ? "default" : "ghost"}
                size="sm"
                className="h-7 px-2"
                data-testid="button-department-filter"
              >
                <Filter className="h-3.5 w-3.5" />
                {departmentFilter.length > 0 && (
                  <span className="ml-1 text-xs">{departmentFilter.length}</span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-2" align="end">
              <div className="space-y-1">
                {allDepartments.map((dept) => (
                  <label
                    key={dept.id}
                    className="flex items-center gap-2 p-2 rounded cursor-pointer hover-elevate"
                  >
                    <Checkbox
                      checked={departmentFilter.includes(dept.id)}
                      onCheckedChange={() => toggleDepartmentFilter(dept.id)}
                      data-testid={`checkbox-dept-filter-${dept.id}`}
                    />
                    <span className="text-sm">{dept.name}</span>
                  </label>
                ))}
                {allDepartments.length === 0 && (
                  <p className="text-sm text-muted-foreground p-2">No departments</p>
                )}
                {departmentFilter.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full mt-2"
                    onClick={() => setDepartmentFilter([])}
                    data-testid="button-clear-dept-filter"
                  >
                    Clear Filter
                  </Button>
                )}
              </div>
            </PopoverContent>
          </Popover>
        )}

        {isManager && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 px-2" data-testid="button-templates-menu">
                <Save className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem
                onClick={() => setApplyTemplateDialogOpen(true)}
                data-testid="button-apply-template"
              >
                <FileDown className="h-3.5 w-3.5 mr-2" />
                Apply {viewMode === "employees" ? "Dept" : "Shift Group"} Template
              </DropdownMenuItem>
              {weekPlanQuery.data && (
                <DropdownMenuItem
                  onClick={() => setTemplateDialogOpen(true)}
                  data-testid="button-save-template"
                >
                  <Save className="h-3.5 w-3.5 mr-2" />
                  Save {viewMode === "employees" ? "Dept" : "Shift Group"} Template
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => {
                  setMergeMode(true);
                  setMergeSelectedIds(new Set());
                }}
                data-testid="button-merge-shifts"
              >
                <Merge className="h-3.5 w-3.5 mr-2" />
                Merge Shift Rows
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setClearWeekStart(weekStartFormatted);
                  setClearDeptId("");
                  setClearWeekDialogOpen(true);
                }}
                className="text-destructive focus:text-destructive"
                data-testid="button-clear-week"
              >
                <Trash2 className="h-3.5 w-3.5 mr-2" />
                Clear {clearViewLabel}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {isManager && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5"
            onClick={() => {
              setConflictScanDialogOpen(true);
              handleScanConflicts();
            }}
            data-testid="button-scan-conflicts"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Scan Conflicts</span>
          </Button>
        )}

        {isManager && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5"
            onClick={handleGenerateAllBreaks}
            disabled={generateBreaksLoading}
            data-testid="button-generate-breaks"
          >
            <Coffee className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{generateBreaksLoading ? "Generating..." : "Generate Breaks"}</span>
          </Button>
        )}

        {isManager && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5"
            onClick={() => setScheduleHistoryOpen(true)}
            data-testid="button-schedule-history"
          >
            <History className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">History</span>
          </Button>
        )}
      </div>

      {copyMode.isActive && copyMode.clipboardData && (
        <div className="fixed top-2 left-1/2 -translate-x-1/2 z-[9999] w-[calc(100%-2rem)] max-w-lg bg-amber-50 dark:bg-amber-950 border border-amber-300 dark:border-amber-700 rounded-lg px-3 py-2 shadow-lg flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <Badge className="bg-amber-500 text-white shrink-0">COPY MODE</Badge>
            <span className="text-sm text-amber-800 dark:text-amber-200 truncate">
              {copyMode.clipboardData.startTime?.slice(0,5)}–{copyMode.clipboardData.endTime?.slice(0,5)}
              {copyMode.clipboardData.label && ` • ${copyMode.clipboardData.label}`}
              {copyMode.clipboardData.employeeName && ` • ${copyMode.clipboardData.employeeName}`}
            </span>
            {copyMode.pasteCount > 0 && (
              <span className="text-xs text-amber-600 dark:text-amber-400 shrink-0">({copyMode.pasteCount} pasted)</span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button size="sm" variant="outline" onClick={copyMode.exitCopyMode} data-testid="button-copy-mode-cancel">
              Cancel
            </Button>
            <Button size="sm" onClick={copyMode.exitCopyMode} data-testid="button-copy-mode-done">
              <Check className="h-3 w-3 mr-1" /> Done
            </Button>
          </div>
        </div>
      )}

      {mergeMode && (
        <div className="fixed top-2 left-1/2 -translate-x-1/2 z-[9999] w-[calc(100%-2rem)] max-w-lg bg-blue-50 dark:bg-blue-950 border border-blue-300 dark:border-blue-700 rounded-lg px-3 py-2 shadow-lg flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <Badge className="bg-blue-500 text-white shrink-0">MERGE MODE</Badge>
            <span className="text-sm text-blue-800 dark:text-blue-200 truncate">
              {mergeSelectedIds.size === 0
                ? "Select shift rows to merge"
                : `${mergeSelectedIds.size} shift(s) selected`}
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setMergeMode(false);
                setMergeSelectedIds(new Set());
              }}
              data-testid="button-merge-cancel"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={mergeSelectedIds.size < 2}
              onClick={() => {
                const firstId = [...mergeSelectedIds][0];
                setMergeTargetId(firstId);
                setMergePreview(null);
                setMergeDialogOpen(true);
              }}
              data-testid="button-merge-continue"
            >
              <Merge className="h-3 w-3 mr-1" /> Merge ({mergeSelectedIds.size})
            </Button>
          </div>
        </div>
      )}

      {!selectedBranchId ? (
        <Card className="border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20">
          <CardContent className="py-12">
            <div className="text-center space-y-3">
              <div className="flex justify-center">
                <div className="rounded-full bg-amber-100 dark:bg-amber-900/50 p-3">
                  <MapPin className="h-8 w-8 text-amber-600 dark:text-amber-400" />
                </div>
              </div>
              <h3 className="text-lg font-medium text-amber-800 dark:text-amber-200" data-testid="text-no-branch-reminder">
                Please select a branch
              </h3>
              <p className="text-sm text-amber-600 dark:text-amber-400 max-w-md mx-auto">
                Use the branch selector at the top of the page to choose which branch's schedule you want to view or edit.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : isLoading ? (
        <Card>
          <CardContent className="pt-6 space-y-4">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      ) : viewMode === "employees" ? (
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <div data-schedule-grid className={cn("overflow-x-auto overflow-y-auto max-h-[calc(100vh-160px)]", timelineMode === "3day" && "overflow-x-hidden")}>
              <div className={cn(
                timelineMode === "week" && "min-w-[600px]",
                timelineMode === "month" && "min-w-[1220px]"
              )}>
                <div className={cn("grid border-b bg-[#263238] text-white sticky top-0 z-30", gridCols)} style={monthGridStyle}>
                  <div className={cn(
                    "font-medium border-r border-white/10 truncate bg-[#263238] sticky left-0 z-40 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.2)]",
                    firstColWidth,
                    timelineMode === "month" ? "p-1 text-xs" : "p-2 sm:p-3 text-xs sm:text-sm"
                  )}>Employee</div>
                  {visibleDays.map((day) => (
                    <div
                      key={day.toISOString()}
                      className={cn(
                        "text-center border-r border-white/10 last:border-r-0",
                        timelineMode === "month" ? "p-0.5" : "p-2",
                        isSameDay(day, new Date()) && "bg-primary/20",
                        isWeekend(day) && "bg-white/5"
                      )}
                    >
                      {timelineMode === "month" ? (
                        <>
                          <div className="font-medium text-[10px] leading-tight">{format(day, "EEE").charAt(0)}</div>
                          <div className="text-[10px] opacity-75">{format(day, "d")}</div>
                        </>
                      ) : (
                        <>
                          <div className="font-medium text-sm">{format(day, "EEE")}</div>
                          <div className="text-xs opacity-75">{format(day, "d")}</div>
                        </>
                      )}
                    </div>
                  ))}
                </div>

                <>
                    <div className={cn("grid bg-purple-50 dark:bg-purple-900/20 border-b", gridCols)} style={monthGridStyle}>
                      <div className={cn("p-2 font-medium border-r flex items-center gap-1.5 bg-purple-50 dark:bg-purple-950 sticky left-0 z-20 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]", firstColWidth)}>
                        <CalendarDays className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
                        <span className="text-xs sm:text-sm text-purple-700 dark:text-purple-300">Events</span>
                      </div>
                      {visibleDays.map((day) => {
                        const events = getEventsForDate(day);
                        const dateStr = format(day, "yyyy-MM-dd");
                        return (
                          <div
                            key={day.toISOString()}
                            className={cn(
                              "p-1 border-r last:border-r-0 min-h-[36px]",
                              isSameDay(day, new Date()) && "bg-primary/5",
                              isWeekend(day) && "bg-muted/30"
                            )}
                          >
                            {events.length > 0 && (
                              <div className="flex flex-col gap-0.5">
                                {events.slice(0, 2).map((event) => (
                                  <Popover key={event.id}>
                                    <PopoverTrigger asChild>
                                      <button
                                        className="w-full text-left px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-800/40 text-purple-700 dark:text-purple-300 text-[10px] font-medium hover-elevate truncate"
                                        data-testid={`button-event-${event.id}`}
                                      >
                                        {event.title}
                                      </button>
                                    </PopoverTrigger>
                                    <PopoverContent className="w-72 p-3" align="start">
                                      <div className="space-y-2">
                                        <div className="font-medium text-sm">{event.title}</div>
                                        {event.isAllDay ? (
                                          <div className="text-xs text-muted-foreground">All day</div>
                                        ) : (
                                          <div className="text-xs text-muted-foreground">
                                            {format(new Date(event.startDateTime), "h:mm a")} - {format(new Date(event.endDateTime), "h:mm a")}
                                          </div>
                                        )}
                                        {event.source === "studio" && (
                                          <div className="space-y-1 pt-1 border-t">
                                            {(event.numChildren || event.numAdults) && (
                                              <div className="text-xs text-muted-foreground flex items-center gap-2">
                                                <Users className="h-3 w-3" />
                                                {event.numChildren ? `${event.numChildren} children` : ""}{event.numChildren && event.numAdults ? ", " : ""}{event.numAdults ? `${event.numAdults} adults` : ""}
                                              </div>
                                            )}
                                            {event.programName && (
                                              <div className="text-xs text-muted-foreground">
                                                Program: {event.programName}
                                              </div>
                                            )}
                                            {event.parentName && (
                                              <div className="text-xs text-muted-foreground">
                                                Contact: {event.parentName}
                                              </div>
                                            )}
                                          </div>
                                        )}
                                        {event.location && (
                                          <div className="text-xs text-muted-foreground flex items-center gap-1">
                                            <MapPin className="h-3 w-3" />
                                            {event.location}
                                          </div>
                                        )}
                                        {event.description && (
                                          <div className="text-xs text-muted-foreground">{event.description}</div>
                                        )}
                                      </div>
                                    </PopoverContent>
                                  </Popover>
                                ))}
                                {events.length > 2 && (
                                  <Popover>
                                    <PopoverTrigger asChild>
                                      <button
                                        className="text-[10px] text-purple-600 dark:text-purple-400 hover:underline"
                                        data-testid={`button-more-events-${dateStr}`}
                                      >
                                        +{events.length - 2} more
                                      </button>
                                    </PopoverTrigger>
                                    <PopoverContent className="w-64 p-2" align="start">
                                      <div className="text-xs font-medium mb-2">All Events</div>
                                      <div className="space-y-1 max-h-48 overflow-y-auto">
                                        {events.map((event) => (
                                          <div
                                            key={event.id}
                                            className="px-2 py-1.5 rounded bg-purple-50 dark:bg-purple-900/30"
                                          >
                                            <div className="text-xs font-medium text-purple-700 dark:text-purple-300">{event.title}</div>
                                            {event.isAllDay ? (
                                              <div className="text-[10px] text-muted-foreground">All day</div>
                                            ) : (
                                              <div className="text-[10px] text-muted-foreground">
                                                {format(new Date(event.startDateTime), "h:mm a")} - {format(new Date(event.endDateTime), "h:mm a")}
                                              </div>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    </PopoverContent>
                                  </Popover>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <SortableContext items={departments.map(d => d.id)} strategy={verticalListSortingStrategy}>
                    {departments.map((dept) => {
                      const deptEmployees = employeesByDepartment.get(dept.id) || [];
                      
                      return (
                        <SortableDepartmentWrapper key={dept.id} deptId={dept.id} isManager={isManager}>
                          {({ attributes, listeners, setNodeRef: setDeptRef, dragStyle }: { attributes: any; listeners: any; setNodeRef: (el: HTMLElement | null) => void; dragStyle: React.CSSProperties | undefined }) => (
                          <>
                          <div ref={setDeptRef} className={cn("grid bg-muted/30", gridCols)} style={{ ...monthGridStyle, ...dragStyle }}>
                            <div className={cn("p-2 font-medium border-r flex items-center gap-1 min-w-0 bg-muted sticky left-0 z-20 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]", firstColWidth)}>
                              <button
                                onClick={() => toggleDeptCollapse(dept.id)}
                                className="p-0.5 text-muted-foreground hover:text-foreground transition-colors"
                                data-testid={`button-collapse-dept-${dept.id}`}
                              >
                                {collapsedDepts.has(dept.id) ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                              </button>
                              {isManager && (
                                <button
                                  {...attributes}
                                  {...listeners}
                                  className="p-0.5 cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground transition-colors"
                                  data-testid={`button-drag-department-${dept.id}`}
                                  title="Drag to reorder department"
                                >
                                  <GripVertical className="h-3 w-3 opacity-40" />
                                </button>
                              )}
                              <span className="text-xs sm:text-sm truncate">{dept.name}</span>
                              <span className="text-xs text-muted-foreground ml-auto">{deptEmployees.length}</span>
                            </div>
                            {visibleDays.map((day) => (
                              <div
                                key={day.toISOString()}
                                className={cn(
                                  "border-r last:border-r-0 p-1",
                                  isSameDay(day, new Date()) && "bg-primary/5",
                                  isWeekend(day) && "bg-muted/30"
                                )}
                              />
                            ))}
                          </div>

                          {!collapsedDepts.has(dept.id) && (deptEmployees.length === 0 ? (
                            <div className={cn("grid", gridCols)} style={monthGridStyle}>
                              <div className={cn("p-3 text-xs text-muted-foreground border-r italic bg-background sticky left-0 z-20 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]", firstColWidth, isManager && "pl-6")}>
                                No employees in this department
                              </div>
                              {visibleDays.map((day) => (
                                <div key={day.toISOString()} className="border-r last:border-r-0 h-10 bg-muted/10" />
                              ))}
                            </div>
                          ) : (
                            <SortableContext items={deptEmployees.filter(e => !e.isCasualWorker).map(e => `emp-${e.id}`)} strategy={verticalListSortingStrategy}>
                            {deptEmployees.map((employee) => {
                              const isCasual = employee.isCasualWorker;
                              const isVisibleForAnyDay = isCasual
                                ? visibleDays.some(day => isCasualWorkerActiveForDate(employee, day))
                                : visibleDays.some(day => isEmployeeVisibleForDate(employee, day));
                              if (!isVisibleForAnyDay) return null;
                              return (
                              <SortableEmployeeRowWrapper key={employee.id} employeeId={employee.id} departmentId={dept.id} isManager={isManager && !isCasual}>
                              {({ attributes, listeners, setNodeRef: setEmpRef, dragStyle }: { attributes: any; listeners: any; setNodeRef: (el: HTMLElement | null) => void; dragStyle: React.CSSProperties | undefined }) => (
                              <div ref={setEmpRef} className={cn("grid border-t", gridCols)} style={{ ...monthGridStyle, ...dragStyle }}>
                                <div className={cn("p-2 border-r flex items-center gap-1 bg-background sticky left-0 z-20 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]", firstColWidth)}>
                                  {isManager && (
                                    isCasual ? (
                                      <div className="p-0.5 text-muted-foreground/30" title="Casual worker">
                                        <GripVertical className="h-3 w-3" />
                                      </div>
                                    ) : (
                                      <button
                                        {...attributes}
                                        {...listeners}
                                        className="p-0.5 cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground transition-colors"
                                        data-testid={`button-drag-employee-${employee.id}`}
                                        title="Drag to reorder"
                                      >
                                        <GripVertical className="h-3 w-3 opacity-40" />
                                      </button>
                                    )
                                  )}
                                  <div className="flex items-center gap-1 min-w-0 flex-1">
                                    {!isCasual && avatarStatusMap?.[employee.id]?.status === "CLOCKED_IN" && (
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <span className="h-2 w-2 rounded-full bg-green-500 shrink-0" data-testid={`status-dot-${employee.id}`} />
                                        </TooltipTrigger>
                                        <TooltipContent side="top" className="text-xs">Clocked in</TooltipContent>
                                      </Tooltip>
                                    )}
                                    <button
                                      className="text-xs sm:text-sm truncate text-left hover:underline cursor-pointer"
                                      onClick={() => {
                                        if (!isCasual) {
                                          setSelectedEmployeeForInfo({
                                            id: employee.id,
                                            name: employee.fullName,
                                            avatar: employee.profilePhotoPath
                                          });
                                          setEmployeeInfoPopupOpen(true);
                                        }
                                      }}
                                      data-testid={`button-employee-info-${employee.id}`}
                                    >
                                      {employee.nickname || employee.fullName}
                                    </button>
                                    {isCasual && (
                                      <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 shrink-0 text-orange-600 border-orange-400">
                                        Casual
                                      </Badge>
                                    )}
                                    {!isCasual && (employee.employmentState === "LEAVING" || employee.employmentState === "LEFT") && employee.lastWorkingDay && (
                                      <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 shrink-0 text-red-600 border-red-400">
                                        {employee.employmentState === "LEFT" ? "Left" : "Leaving"} {format(new Date(employee.lastWorkingDay), "MMM d")}
                                      </Badge>
                                    )}
                                  </div>
                                </div>
                                {visibleDays.map((day) => {
                                  const dateStr = format(day, "yyyy-MM-dd");
                                  // For casual workers, use their actual ID for assignments lookup
                                  const actualCasualWorkerId = isCasual ? employee.id.replace('casual-', '') : null;
                                  const assignments = isCasual 
                                    ? getCasualWorkerAssignmentsForDate(actualCasualWorkerId!, day) 
                                    : getEmployeeAssignmentsForDate(employee.id, day);
                                  const timeOff = isCasual ? undefined : getTimeOffForDate(employee.id, day);
                                  const isOff = isCasual ? false : isEmployeeOffDay(employee, day);
                                  const isToday = isSameDay(day, new Date());
                                  // Check if employee should be visible for this date (transfer filtering or casual worker contract)
                                  const isVisibleForDate = isCasual 
                                    ? isCasualWorkerActiveForDate(employee, day) 
                                    : isEmployeeVisibleForDate(employee, day);

                                  const isMonthView = timelineMode === "month";
                                  return (
                                    <DroppableCell
                                      key={day.toISOString()}
                                      id={`cell-${employee.id}-${dateStr}`}
                                      employeeId={employee.id}
                                      date={dateStr}
                                      className={cn(
                                        isMonthView ? "monthCell" : "shiftCell",
                                        "border-r last:border-r-0 min-h-[40px]",
                                        isToday && "bg-primary/5",
                                        !isVisibleForDate && "bg-muted/30",
                                        copyMode.isActive && isVisibleForDate && "cursor-copy"
                                      )}
                                      onClick={copyMode.isActive && isVisibleForDate ? (e) => {
                                        e.stopPropagation();
                                        handleCopyPaste(employee.id, dateStr, dept.id);
                                      } : undefined}
                                    >
                                        {!isVisibleForDate ? (
                                          // Employee transferred out or casual not active - show empty disabled cell
                                          <div className="w-full h-full flex items-center justify-center">
                                            <span className="text-xs text-muted-foreground/50">—</span>
                                          </div>
                                        ) : timeOff ? (
                                          <DraggableLeaveCard
                                            id={`drag-timeoff-${timeOff.id}`}
                                            timeOffId={timeOff.id}
                                            employeeId={employee.id}
                                            currentDate={dateStr}
                                            isMonthView={isMonthView}
                                          >
                                            <LeaveCard
                                              type={timeOff.type}
                                              isCompact={isCompact}
                                              viewMode={timelineMode}
                                              timeOffId={timeOff.id}
                                              onDelete={isManager ? () => deleteTimeOffMutation.mutate(timeOff.id) : undefined}
                                            />
                                          </DraggableLeaveCard>
                                        ) : isOff ? (
                                          <div className={isMonthView ? "monthBadgeAnchor" : "shiftCell__anchor w-full"}>
                                            <OffDayCard isCompact={isCompact} viewMode={timelineMode} className={isMonthView ? "" : "w-full"} />
                                          </div>
                                        ) : (() => {
                                          const borrowedOut = getBorrowedOutForEmployeeDate(employee.id, day);
                                          const totalShifts = assignments.length + borrowedOut.length;
                                          const hasCrossBranchShift = borrowedOut.length > 0;
                                          
                                          // Multiple local assignments = conflict (ERROR STATE)
                                          // Borrowed shifts from other branches are legitimate
                                          const hasLocalConflict = assignments.length > 1;
                                          
                                          if (hasLocalConflict) {
                                            return (
                                              <Popover>
                                                <PopoverTrigger asChild>
                                                  <button
                                                    className="w-full px-1 py-1 rounded text-[11px] font-medium text-center text-white cursor-pointer hover-elevate min-h-[36px] flex flex-col items-center justify-center bg-destructive relative animate-pulse"
                                                    data-testid={`conflict-shift-${employee.id}-${dateStr}`}
                                                  >
                                                    <AlertTriangle className="h-3 w-3 mb-0.5" />
                                                    <div>{assignments.length} conflicts</div>
                                                    {hasCrossBranchShift && !isMonthView && (
                                                      <div className="absolute -top-1.5 -right-1.5 bg-yellow-500 text-yellow-950 text-[7px] px-1 py-0.5 rounded font-bold shadow-sm z-10">
                                                        B
                                                      </div>
                                                    )}
                                                  </button>
                                                </PopoverTrigger>
                                                <PopoverContent className="w-64 p-3" align="start">
                                                  <div className="space-y-2">
                                                    <div className="font-medium text-sm">{employee.nickname || employee.fullName}</div>
                                                    <div className="text-xs text-muted-foreground">
                                                      {format(day, "EEEE, MMMM d, yyyy")}
                                                    </div>
                                                    <div className="space-y-1.5">
                                                      {assignments.map(({ assignment, shiftRow }) => (
                                                        <div key={assignment.id} className="flex items-center gap-2 flex-wrap">
                                                          <div className={cn("px-2 py-1 rounded text-xs font-medium text-white", shiftRow.colorIndex != null ? getShiftColorByIndex(shiftRow.colorIndex) : "bg-blue-600")}>
                                                            {shiftRow.startTime.slice(0,5)} – {shiftRow.endTime.slice(0,5)}
                                                          </div>
                                                          <div className="text-xs">
                                                            {shiftRow.label && <span>{shiftRow.label}</span>}
                                                          </div>
                                                          {isManager && !isPastDate(dateStr) && (
                                                            <button
                                                              className="text-destructive text-xs hover:underline"
                                                              onClick={() => deleteAssignmentMutation.mutate(assignment.id)}
                                                            >
                                                              Remove
                                                            </button>
                                                          )}
                                                        </div>
                                                      ))}
                                                      {borrowedOut.map((borrowed) => (
                                                        <div key={borrowed.id} className="flex items-center gap-2 flex-wrap">
                                                          <div className="px-2 py-1 rounded text-xs font-medium text-white bg-yellow-600">
                                                            {borrowed.startTime.slice(0,5)} – {borrowed.endTime.slice(0,5)}
                                                          </div>
                                                          <div className="text-xs">
                                                            {borrowed.shiftLabel && <span>{borrowed.shiftLabel}</span>}
                                                            <span className="ml-1 bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300 px-1.5 py-0.5 rounded font-medium">
                                                              @ {borrowed.toBranchName}
                                                            </span>
                                                          </div>
                                                        </div>
                                                      ))}
                                                    </div>
                                                  </div>
                                                </PopoverContent>
                                              </Popover>
                                            );
                                          }
                                          
                                          // Single shift or borrowed-out shift
                                          return (
                                          <div className="multi-shift-container flex flex-col gap-0.5 w-full">
                                            {assignments.map(({ assignment, shiftRow }) => (
                                            <CopyableShiftWrapper
                                              key={`copy-${assignment.id}-${shiftRow.colorIndex ?? 0}`}
                                              assignmentId={assignment.id}
                                              shiftData={{
                                                shiftRowId: shiftRow.id,
                                                shiftDate: assignment.shiftDate,
                                                employeeId: assignment.employeeId,
                                                casualWorkerId: assignment.casualWorkerId,
                                                assigneeType: assignment.assigneeType || "employee",
                                                startTime: shiftRow.startTime,
                                                endTime: shiftRow.endTime,
                                                label: shiftRow.label,
                                                departmentId: shiftRow.departmentId,
                                                departmentName: shiftRow.department?.name,
                                                employeeName: assignment.employee?.nickname || assignment.employee?.fullName,
                                                colorIndex: shiftRow.colorIndex,
                                              }}
                                            >
                                            <DraggableShiftCard
                                              id={`drag-${assignment.id}`}
                                              assignmentId={assignment.id}
                                              shiftRowId={shiftRow.id}
                                              employeeId={employee.id}
                                              shiftDate={dateStr}
                                              shiftName={shiftRow.label || "Shift"}
                                              isMonthView={isMonthView}
                                            >
                                              <EmployeeShiftCard
                                                shiftName={shiftRow.label || "Shift"}
                                                timeRange={`${shiftRow.startTime.slice(0, 5)} - ${shiftRow.endTime.slice(0, 5)}`}
                                                startTime={shiftRow.startTime}
                                                endTime={shiftRow.endTime}
                                                status="approved"
                                                isCompact={isCompact}
                                                viewMode={timelineMode}
                                                shiftRowId={shiftRow.id}
                                                departmentId={shiftRow.departmentId}
                                                departmentName={shiftRow.department?.name}
                                                note={shiftRow.note || undefined}
                                                roles={(() => {
                                                  if (assignment.roleId) {
                                                    const assignedRole = shiftRow.roles?.find((r: any) => r.roleId === assignment.roleId);
                                                    if (assignedRole?.role?.name) return [assignedRole.role.name];
                                                  }
                                                  if (shiftRow.shiftGroupId) {
                                                    const sg = shiftGroupsList.find((g: any) => g.id === shiftRow.shiftGroupId);
                                                    if (sg?.name) return [sg.name];
                                                  }
                                                  return shiftRow.roles?.map((r: any) => r.role?.name || "").filter(Boolean) || [];
                                                })()}
                                                colorIndex={shiftRow.colorIndex}
                                                onRemove={isManager && !isPastDate(dateStr) ? () => deleteAssignmentMutation.mutate(assignment.id) : undefined}
                                                onDutyBlocks={isManager ? () => setDutyBlocksSheetData({
                                                  assignmentId: assignment.id,
                                                  employeeId: employee.id,
                                                  employeeName: employee.nickname || employee.fullName,
                                                  date: dateStr,
                                                  shiftStartTime: shiftRow.startTime,
                                                  shiftEndTime: shiftRow.endTime,
                                                  shiftName: shiftRow.label || "Shift",
                                                }) : undefined}
                                              />
                                            </DraggableShiftCard>
                                            </CopyableShiftWrapper>
                                          ))}
                                            {/* Borrowed-out assignments: shifts at other branches */}
                                            {borrowedOut.map((borrowed) => (
                                              <div
                                                key={`borrowed-out-${borrowed.id}`}
                                                className="w-full"
                                              >
                                                <EmployeeShiftCard
                                                  shiftName={borrowed.shiftLabel || "Shift"}
                                                  timeRange={`${borrowed.startTime.slice(0, 5)} - ${borrowed.endTime.slice(0, 5)}`}
                                                  startTime={borrowed.startTime}
                                                  endTime={borrowed.endTime}
                                                  status="approved"
                                                  isCompact={isCompact}
                                                  viewMode={timelineMode}
                                                  departmentName={borrowed.departmentName || undefined}
                                                  isBorrowed={true}
                                                  borrowedDeptName={borrowed.toBranchName}
                                                />
                                              </div>
                                            ))}
                                            {isManager && !isPastDate(dateStr) && assignments.length === 0 && (
                                              <Popover>
                                                <PopoverTrigger asChild>
                                                  <button
                                                    className="w-full h-8 flex items-center justify-center text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50 rounded border border-dashed border-transparent hover:border-muted-foreground/20 transition-all"
                                                    data-testid={`button-add-action-${employee.id}-${dateStr}`}
                                                  >
                                                    <Plus className="h-3 w-3" />
                                                  </button>
                                                </PopoverTrigger>
                                                <PopoverContent className="w-64 p-1 max-h-[60vh] overflow-y-auto" align="start">
                                                  <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-2 py-1">
                                                    {format(day, "EEE d MMM")} - {employee.nickname || employee.fullName.split(" ")[0]}
                                                  </div>
                                                  <div className="border-t my-1" />
                                                  {(() => {
                                                    const employeeShiftGroups = getShiftsForEmployee(employee);
                                                    if (employeeShiftGroups.length === 0) return (
                                                      <div className="text-[10px] text-muted-foreground px-2 py-2 italic">
                                                        No matching shifts for this employee's roles
                                                      </div>
                                                    );
                                                    return (
                                                      <>
                                                        {employeeShiftGroups.map((group) => (
                                                          <div key={group.groupId}>
                                                            <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-2 py-1">
                                                              {group.groupName}
                                                            </div>
                                                            {group.rows.map((row) => (
                                                              <Button
                                                                key={row.id}
                                                                variant="ghost"
                                                                size="sm"
                                                                className="w-full justify-start text-xs h-7 px-2"
                                                                onClick={() => {
                                                                  if (isCasual) {
                                                                    const actualCasualId = employee.id.replace('casual-', '');
                                                                    const casualWorkerData = casualWorkersForEmployeeViewQuery.data?.find(cw => cw.id === actualCasualId);
                                                                    createAssignmentMutation.mutate({
                                                                      shiftRowId: row.id,
                                                                      shiftDate: dateStr,
                                                                      casualWorkerId: actualCasualId,
                                                                      assigneeType: "casual",
                                                                      dailyRateSnapshot: casualWorkerData?.dailyRate || 0,
                                                                    });
                                                                  } else {
                                                                    createAssignmentMutation.mutate({
                                                                      shiftRowId: row.id,
                                                                      shiftDate: dateStr,
                                                                      employeeId: employee.id,
                                                                      assigneeType: "employee",
                                                                    });
                                                                  }
                                                                }}
                                                                data-testid={`button-assign-shift-${row.id}-${dateStr}`}
                                                              >
                                                                <Clock className="h-3 w-3 mr-1.5 text-green-600" />
                                                                <span className="truncate">
                                                                  {row.startTime.slice(0, 5)} - {row.endTime.slice(0, 5)} {row.label ? `· ${row.label}` : ""}
                                                                </span>
                                                              </Button>
                                                            ))}
                                                          </div>
                                                        ))}
                                                        <div className="border-t my-1" />
                                                      </>
                                                    );
                                                  })()}
                                                  {!isCasual && (
                                                  <>
                                                  <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-2 py-1">
                                                    Set Time Off
                                                  </div>
                                                  {(() => {
                                                    const leaveBalance = getLeaveBalance(employee.id);
                                                    return (
                                                      <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="w-full justify-start text-xs h-7 px-2"
                                                        onClick={() => handleSetTimeOff(employee, dateStr, "CHANGE_DAY_OFF")}
                                                        disabled={createTimeOffMutation.isPending}
                                                        data-testid={`button-set-dayoff-${employee.id}-${dateStr}`}
                                                      >
                                                        <X className="h-3 w-3 mr-1.5 text-gray-500" />
                                                        <span className="flex-1 text-left">Off</span>
                                                        {leaveBalance && (
                                                          <span className={`text-[10px] ${leaveBalance.balance >= 0 ? 'text-muted-foreground' : 'text-red-500'}`}>
                                                            {leaveBalance.balance} left
                                                          </span>
                                                        )}
                                                      </Button>
                                                    );
                                                  })()}
                                                  {(() => {
                                                    const allBalance = getAllLeaveBalance(employee.id);
                                                    return (
                                                      <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="w-full justify-start text-xs h-7 px-2"
                                                        onClick={() => handleSetTimeOff(employee, dateStr, "ANNUAL")}
                                                        disabled={createTimeOffMutation.isPending}
                                                        data-testid={`button-set-leave-${employee.id}-${dateStr}`}
                                                      >
                                                        <Users className="h-3 w-3 mr-1.5 text-amber-500" />
                                                        <span className="flex-1 text-left">Leave / Holiday</span>
                                                        {allBalance && allBalance.annual.canClaim && (
                                                          <span className={`text-[10px] ${allBalance.holidayBalance >= 0 ? 'text-muted-foreground' : 'text-red-500'}`}>
                                                            {allBalance.holidayBalance} left
                                                          </span>
                                                        )}
                                                      </Button>
                                                    );
                                                  })()}
                                                  {(() => {
                                                    const sickBalance = getSickLeaveBalance(employee.id);
                                                    return (
                                                      <>
                                                        <Button
                                                          variant="ghost"
                                                          size="sm"
                                                          className="w-full justify-start text-xs h-7 px-2"
                                                          onClick={() => handleSetTimeOff(employee, dateStr, "SICK")}
                                                          disabled={createTimeOffMutation.isPending}
                                                          data-testid={`button-set-sick-${employee.id}-${dateStr}`}
                                                        >
                                                          <Thermometer className="h-3 w-3 mr-1.5 text-red-500" />
                                                          <span className="flex-1 text-left">Sick Leave</span>
                                                          {sickBalance && (
                                                            <span className={`text-[10px] ${sickBalance.daysRemaining > 0 ? 'text-muted-foreground' : 'text-red-500'}`}>
                                                              {sickBalance.daysRemaining} left
                                                            </span>
                                                          )}
                                                        </Button>
                                                        {sickBalance && sickBalance.daysRemaining <= 0 && (
                                                          <div className="text-[10px] text-red-500 px-2 pb-1">
                                                            No sick leave remaining this year
                                                          </div>
                                                        )}
                                                      </>
                                                    );
                                                  })()}
                                                  {(() => {
                                                    const allBalance = getAllLeaveBalance(employee.id);
                                                    return (
                                                      <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="w-full justify-start text-xs h-7 px-2"
                                                        onClick={() => handleSetTimeOff(employee, dateStr, "BUSINESS")}
                                                        disabled={createTimeOffMutation.isPending}
                                                        data-testid={`button-set-business-${employee.id}-${dateStr}`}
                                                      >
                                                        <Briefcase className="h-3 w-3 mr-1.5 text-blue-500" />
                                                        <span className="flex-1 text-left">Business Leave</span>
                                                        {allBalance && (
                                                          <span className={`text-[10px] ${allBalance.business.balance >= 0 ? 'text-muted-foreground' : 'text-red-500'}`}>
                                                            {allBalance.business.balance} left
                                                          </span>
                                                        )}
                                                      </Button>
                                                    );
                                                  })()}
                                                  </>
                                                  )}
                                                </PopoverContent>
                                              </Popover>
                                            )}
                                          </div>
                                          );
                                        })()}
                                    </DroppableCell>
                                  );
                                })}
                              </div>
                              )}
                              </SortableEmployeeRowWrapper>
                            );
                            })}
                            </SortableContext>
                          ))}
                          </>
                          )}
                        </SortableDepartmentWrapper>
                      );
                    })}
                    </SortableContext>
                  </>
              </div>
            </div>
          </CardContent>
        </Card>
        </DndContext>
      ) : viewMode === "timeline" ? (
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <TimelineView
              date={currentWeekStart}
              shiftRows={weekPlanQuery.data?.shiftRows || []}
              employees={employeesQuery.data || []}
              departments={allDepartments}
              departmentFilter={departmentFilter}
              events={branchEventsQuery.data || []}
              dutyBlocks={timelineDutyBlocksQuery.data || []}
              shiftGroups={shiftGroupsList}
              onNavigateToDay={(date) => {
                setCurrentWeekStart(date);
                setTimelineMode("day");
              }}
              employeeStatusMap={avatarStatusMap}
            />
          </CardContent>
        </Card>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleShiftsViewDragEnd}>
          <Card className="overflow-hidden">
          <CardContent className="p-0">
            <div 
              ref={shiftScrollRef}
              data-schedule-grid
              className={cn("overflow-x-auto overflow-y-auto max-h-[calc(100vh-160px)]", timelineMode === "3day" && "overflow-x-hidden")}
            >
              <div className={cn(
                timelineMode === "week" && "min-w-[600px]",
                timelineMode === "month" && "min-w-[1220px]"
              )}>
                <div className={cn("grid border-b bg-[#263238] text-white sticky top-0 z-30", gridCols)} style={monthGridStyle}>
                  <div className={cn(
                    "font-medium border-r border-white/10 truncate bg-[#263238] sticky left-0 z-40 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.2)]",
                    firstColWidth,
                    timelineMode === "month" ? "p-1 text-xs" : "p-2 sm:p-3 text-xs sm:text-sm"
                  )}>Dept / Shift</div>
                  {visibleDays.map((day) => (
                    <div
                      key={day.toISOString()}
                      className={cn(
                        "text-center border-r border-white/10 last:border-r-0",
                        timelineMode === "month" ? "p-0.5" : "p-2",
                        isSameDay(day, new Date()) && "bg-primary/20",
                        isWeekend(day) && "bg-white/5"
                      )}
                    >
                      {timelineMode === "month" ? (
                        <>
                          <div className="font-medium text-[10px] leading-tight">{format(day, "EEE").charAt(0)}</div>
                          <div className="text-[10px] opacity-75">{format(day, "d")}</div>
                        </>
                      ) : (
                        <>
                          <div className="font-medium text-sm">{format(day, "EEE")}</div>
                          <div className="text-xs opacity-75">{format(day, "d")}</div>
                        </>
                      )}
                    </div>
                  ))}
                </div>

                {(() => {
                  const ungroupedRows = groupedByShiftGroup.get("ungrouped") || [];
                  const hasNoContent = filteredShiftGroupsList.length === 0 && ungroupedRows.length === 0;
                  
                  if (hasNoContent) {
                    return (
                      <div className="p-8 text-center">
                        <Users className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
                        <p className="text-muted-foreground font-medium">
                          {shiftGroupFilter.length > 0 ? "No matching shift groups" : "No shift groups yet"}
                        </p>
                        <p className="text-sm text-muted-foreground mt-1 mb-4">
                          {shiftGroupFilter.length > 0
                            ? "Try adjusting your filter to see more groups."
                            : "Create shift groups to organize your shifts (e.g., \"Morning Team\", \"Kitchen\", \"Front of House\")."}
                        </p>
                        {isManager && (
                          <Button
                            onClick={() => setCreateShiftGroupOpen(true)}
                            data-testid="button-create-first-shift-group"
                          >
                            <Plus className="h-4 w-4 mr-2" />
                            Create Shift Group
                          </Button>
                        )}
                      </div>
                    );
                  }
                  
                  return (
                  <>
                    <div className={cn("grid bg-purple-50 dark:bg-purple-900/20 border-b", gridCols)} style={monthGridStyle}>
                      <div className={cn("p-2 font-medium border-r flex items-center gap-1.5 bg-purple-50 dark:bg-purple-950 sticky left-0 z-20 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]", firstColWidth)}>
                        <CalendarDays className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
                        <span className="text-xs sm:text-sm text-purple-700 dark:text-purple-300">Events</span>
                      </div>
                      {visibleDays.map((day) => {
                        const events = getEventsForDate(day);
                        const dateStr = format(day, "yyyy-MM-dd");
                        return (
                          <div
                            key={day.toISOString()}
                            className={cn(
                              "p-1 border-r last:border-r-0 min-h-[36px]",
                              isSameDay(day, new Date()) && "bg-primary/5",
                              isWeekend(day) && "bg-muted/30"
                            )}
                          >
                            {events.length > 0 && (
                              <div className="flex flex-col gap-0.5">
                                {events.slice(0, 2).map((event) => (
                                  <Popover key={event.id}>
                                    <PopoverTrigger asChild>
                                      <button
                                        className="w-full text-left px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-800/40 text-purple-700 dark:text-purple-300 text-[10px] font-medium hover-elevate truncate"
                                        data-testid={`button-shift-event-${event.id}`}
                                      >
                                        {event.title}
                                      </button>
                                    </PopoverTrigger>
                                    <PopoverContent className="w-72 p-3" align="start">
                                      <div className="space-y-2">
                                        <div className="font-medium text-sm">{event.title}</div>
                                        {event.isAllDay ? (
                                          <div className="text-xs text-muted-foreground">All day</div>
                                        ) : (
                                          <div className="text-xs text-muted-foreground">
                                            {format(new Date(event.startDateTime), "h:mm a")} - {format(new Date(event.endDateTime), "h:mm a")}
                                          </div>
                                        )}
                                        {event.source === "studio" && (
                                          <div className="space-y-1 pt-1 border-t">
                                            {(event.numChildren || event.numAdults) && (
                                              <div className="text-xs text-muted-foreground flex items-center gap-2">
                                                <Users className="h-3 w-3" />
                                                {event.numChildren ? `${event.numChildren} children` : ""}{event.numChildren && event.numAdults ? ", " : ""}{event.numAdults ? `${event.numAdults} adults` : ""}
                                              </div>
                                            )}
                                            {event.programName && (
                                              <div className="text-xs text-muted-foreground">
                                                Program: {event.programName}
                                              </div>
                                            )}
                                            {event.parentName && (
                                              <div className="text-xs text-muted-foreground">
                                                Contact: {event.parentName}
                                              </div>
                                            )}
                                          </div>
                                        )}
                                        {event.location && (
                                          <div className="text-xs text-muted-foreground flex items-center gap-1">
                                            <MapPin className="h-3 w-3" />
                                            {event.location}
                                          </div>
                                        )}
                                        {event.description && (
                                          <div className="text-xs text-muted-foreground">{event.description}</div>
                                        )}
                                      </div>
                                    </PopoverContent>
                                  </Popover>
                                ))}
                                {events.length > 2 && (
                                  <Popover>
                                    <PopoverTrigger asChild>
                                      <button
                                        className="text-[10px] text-purple-600 dark:text-purple-400 hover:underline"
                                        data-testid={`button-shift-more-events-${dateStr}`}
                                      >
                                        +{events.length - 2} more
                                      </button>
                                    </PopoverTrigger>
                                    <PopoverContent className="w-64 p-2" align="start">
                                      <div className="text-xs font-medium mb-2">All Events</div>
                                      <div className="space-y-1 max-h-48 overflow-y-auto">
                                        {events.map((event) => (
                                          <div
                                            key={event.id}
                                            className="px-2 py-1.5 rounded bg-purple-50 dark:bg-purple-900/30"
                                          >
                                            <div className="text-xs font-medium text-purple-700 dark:text-purple-300">{event.title}</div>
                                            {event.isAllDay ? (
                                              <div className="text-[10px] text-muted-foreground">All day</div>
                                            ) : (
                                              <div className="text-[10px] text-muted-foreground">
                                                {format(new Date(event.startDateTime), "h:mm a")} - {format(new Date(event.endDateTime), "h:mm a")}
                                              </div>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    </PopoverContent>
                                  </Popover>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <SortableContext items={filteredShiftGroupsList.map((g: any) => g.id)} id="shift-groups" strategy={verticalListSortingStrategy}>
                    {filteredShiftGroupsList.map((group: any) => {
                      const rows = groupedByShiftGroup.get(group.id) || [];
                    
                    return (
                      <SortableDepartmentWrapper key={group.id} deptId={group.id} isManager={isManager}>
                        {({ attributes, listeners, setNodeRef: setDeptRef, dragStyle }: { attributes: any; listeners: any; setNodeRef: (el: HTMLElement | null) => void; dragStyle: React.CSSProperties | undefined }) => (
                        <>
                        <div ref={setDeptRef} className={cn("grid bg-muted/30", gridCols)} style={{ ...monthGridStyle, ...dragStyle }}>
                          <div className={cn("group/sg py-1.5 px-2 font-medium border-r flex items-center gap-1 text-sm bg-muted sticky left-0 z-20 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]", firstColWidth)}>
                            <button
                              onClick={() => toggleDeptCollapse(group.id)}
                              className="p-0.5 text-muted-foreground hover:text-foreground transition-colors"
                              data-testid={`button-collapse-shift-group-${group.id}`}
                            >
                              {collapsedDepts.has(group.id) ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                            </button>
                            {isManager && (
                              <button
                                {...attributes}
                                {...listeners}
                                className="p-0.5 cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground transition-colors"
                                data-testid={`button-drag-shift-group-${group.id}`}
                                title="Drag to reorder group"
                              >
                                <GripVertical className="h-3 w-3 opacity-40" />
                              </button>
                            )}
                            {editingShiftGroupId === group.id ? (
                              <form
                                className="flex items-center gap-1 flex-1 min-w-0"
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  if (editingShiftGroupName.trim() && editingShiftGroupName.trim() !== group.name) {
                                    renameShiftGroupMutation.mutate({ id: group.id, name: editingShiftGroupName.trim() });
                                  } else {
                                    setEditingShiftGroupId(null);
                                  }
                                }}
                              >
                                <Input
                                  autoFocus
                                  className="h-6 text-xs sm:text-sm px-1.5 py-0"
                                  value={editingShiftGroupName}
                                  onChange={(e) => setEditingShiftGroupName(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Escape") {
                                      setEditingShiftGroupId(null);
                                    }
                                  }}
                                  data-testid={`input-rename-shift-group-${group.id}`}
                                />
                                <Button
                                  type="submit"
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 shrink-0"
                                  disabled={!editingShiftGroupName.trim()}
                                  data-testid={`button-save-shift-group-${group.id}`}
                                  title="Save"
                                >
                                  <Check className="h-3 w-3" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 shrink-0"
                                  onClick={() => setEditingShiftGroupId(null)}
                                  data-testid={`button-cancel-edit-shift-group-${group.id}`}
                                  title="Cancel"
                                >
                                  <X className="h-3 w-3" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 shrink-0 text-destructive"
                                  onClick={() => {
                                    if (confirm(`Delete "${group.name}"? Shifts in this group will be ungrouped.`)) {
                                      deleteShiftGroupMutation.mutate(group.id);
                                      setEditingShiftGroupId(null);
                                    }
                                  }}
                                  data-testid={`button-delete-shift-group-${group.id}`}
                                  title="Delete group"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </form>
                            ) : (
                              <span className="text-xs sm:text-sm truncate font-medium">{group.name}</span>
                            )}
                            <div className="ml-auto flex items-center gap-0.5">
                            {isManager && viewMode === "shifts" && (
                              <>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 shrink-0 invisible group-hover/sg:visible"
                                onClick={() => {
                                  setEditingShiftGroupId(group.id);
                                  setEditingShiftGroupName(group.name);
                                }}
                                data-testid={`button-edit-shift-group-${group.id}`}
                                title="Edit group"
                              >
                                <Pencil className="h-3 w-3" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 shrink-0"
                                onClick={() => {
                                  setSelectedShiftGroupId(group.id);
                                  setSelectedDepartmentId(departments[0]?.id || null);
                                  setCreateShiftRowOpen(true);
                                }}
                                data-testid={`button-add-shift-row-group-${group.id}`}
                              >
                                <Plus className="h-4 w-4" />
                              </Button>
                              </>
                            )}
                            </div>
                          </div>
                          {visibleDays.map((day) => {
                            const dayUnderstaffed = getUnderstaffedShiftsForGroup(group.id, day);
                            const hasUnderstaffing = dayUnderstaffed.length > 0;
                            return (
                              <div 
                                key={day.toISOString()} 
                                className={cn(
                                  "border-r last:border-r-0 flex items-center justify-center",
                                  isSameDay(day, new Date()) && "bg-primary/5"
                                )}
                              >
                                {hasUnderstaffing && (
                                  <Popover>
                                    <PopoverTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-3.5 w-3.5 text-orange-400/60 hover:text-orange-500/80"
                                        data-testid={`button-understaffed-group-${group.id}-${format(day, "yyyy-MM-dd")}`}
                                      >
                                        <AlertCircle className="h-2.5 w-2.5" />
                                      </Button>
                                    </PopoverTrigger>
                                    <PopoverContent className="w-64" align="center">
                                      <div className="space-y-2">
                                        <h4 className="font-medium text-sm">Understaffed - {format(day, "EEE, MMM d")}</h4>
                                        <div className="space-y-1.5">
                                          {dayUnderstaffed.map((item, idx) => (
                                            <div key={idx} className="flex items-center justify-between text-xs p-1.5 bg-muted/50 rounded">
                                              <div className="flex flex-col">
                                                <span className="font-medium">{item.row.label || "Shift"}</span>
                                                <span className="text-muted-foreground">
                                                  {item.row.startTime.slice(0, 5)} - {item.row.endTime.slice(0, 5)}
                                                </span>
                                              </div>
                                              <span className="text-orange-600 font-medium whitespace-nowrap">
                                                {item.assigned}/{item.required}
                                              </span>
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    </PopoverContent>
                                  </Popover>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        
                        <DroppableGroupZone groupId={group.id}>
                          {({ setNodeRef: setGroupDropRef, isOver: isGroupDropOver }) => (
                        <div ref={setGroupDropRef} className={cn(isGroupDropOver && "ring-2 ring-primary/40 ring-inset rounded-sm")}>
                        {!collapsedDepts.has(group.id) && (rows.length === 0 ? (
                          <div className={cn("grid", gridCols)} style={monthGridStyle}>
                            <div className={cn("p-3 text-xs text-muted-foreground border-r bg-background sticky left-0 z-20 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]", firstColWidth)}>
                              {isManager ? "Click + to add shift times" : "No shifts defined"}
                            </div>
                            {visibleDays.map((day) => (
                              <div key={day.toISOString()} className="border-r last:border-r-0 h-10 bg-muted/10" />
                            ))}
                          </div>
                        ) : (
                          <SortableContext items={rows.map(r => r.id)} id={group.id} strategy={verticalListSortingStrategy}>
                          {rows.map((row) => {
                            const rowTimeRange = (() => {
                              const [startH, startM] = row.startTime.split(':');
                              const [endH, endM] = row.endTime.split(':');
                              const sH = parseInt(startH, 10);
                              const eH = parseInt(endH, 10);
                              if (startM === '00' && endM === '00') {
                                return `${sH}–${eH}`;
                              }
                              const startStr = startM === '00' ? String(sH) : `${sH}:${startM}`;
                              const endStr = endM === '00' ? String(eH) : `${eH}:${endM}`;
                              return `${startStr}–${endStr}`;
                            })();

                            return (
                              <SortableShiftRowWrapper key={row.id} rowId={row.id} groupId={group.id}>
                                {({ attributes, listeners, setNodeRef: setRowRef, dragStyle }) => (
                              <div 
                                ref={setRowRef}
                                className={cn("grid border-t", gridCols)} 
                                style={{ ...monthGridStyle, ...dragStyle }}
                              >
                                <div 
                                  className={cn(
                                    "py-1 border-r flex items-center group bg-background sticky left-0 z-30 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]",
                                    firstColWidth,
                                    isManager ? "pl-1 pr-2 cursor-pointer" : "px-2",
                                    mergeMode && mergeSelectedIds.has(row.id) && "bg-blue-50 dark:bg-blue-950/40"
                                  )}
                                  onClick={() => {
                                    if (mergeMode) {
                                      setMergeSelectedIds(prev => {
                                        const next = new Set(prev);
                                        if (next.has(row.id)) next.delete(row.id);
                                        else next.add(row.id);
                                        return next;
                                      });
                                      return;
                                    }
                                    if (isManager) {
                                      setEditingShiftRow(row);
                                      setEditShiftRowForm({
                                        startTime: row.startTime,
                                        endTime: row.endTime,
                                        label: row.label || "",
                                        note: row.note || "",
                                        roleIds: row.roles?.map((r) => r.roleId) || [],
                                        staffRequired: row.staffRequired ?? 1,
                                        staffRequiredByDay: (row.staffRequiredByDay as Record<string, number>) ?? {},
                                        colorIndex: row.colorIndex ?? null,
                                        shiftGroupId: row.shiftGroupId || null,
                                      });
                                      setEditShiftRowOpen(true);
                                    }
                                  }}
                                  data-testid={`button-edit-shift-row-${row.id}`}
                                >
                                  {mergeMode ? (
                                    <div className="p-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                                      <Checkbox
                                        checked={mergeSelectedIds.has(row.id)}
                                        onCheckedChange={(checked) => {
                                          setMergeSelectedIds(prev => {
                                            const next = new Set(prev);
                                            if (checked) next.add(row.id);
                                            else next.delete(row.id);
                                            return next;
                                          });
                                        }}
                                        data-testid={`checkbox-merge-shift-${row.id}`}
                                      />
                                    </div>
                                  ) : isManager ? (
                                    <button
                                      {...attributes}
                                      {...listeners}
                                      className="p-1 cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                                      data-testid={`button-drag-shift-row-${row.id}`}
                                      title="Drag to reorder"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <GripVertical className="h-3 w-3 opacity-40" />
                                    </button>
                                  ) : null}
                                  <div className="relative flex-1 flex flex-col items-center justify-center py-1">
                                    <span className="font-mono text-xs font-semibold tabular-nums text-center">
                                      {rowTimeRange}
                                    </span>
                                    {row.label && (
                                      <span className="text-[10px] text-muted-foreground text-center truncate max-w-full leading-tight">
                                        {row.label}
                                      </span>
                                    )}
                                    {isManager && (
                                      <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity absolute top-1 right-1" />
                                    )}
                                  </div>
                                </div>

                                {visibleDays.map((day) => {
                                  const dateStr = format(day, "yyyy-MM-dd");
                                  const cellAssignments = getAssignmentsForCell(row, day);
                                  const isToday = isSameDay(day, new Date());

                                  const assignmentsData = cellAssignments.map((a) => {
                                    const isCasual = a.assigneeType === "casual" || !!a.casualWorkerId;
                                    const assigneeId = isCasual ? a.casualWorkerId : a.employeeId;
                                    const assigneeName = isCasual 
                                      ? (a.casualWorker?.nickname || a.casualWorker?.fullName || "Casual Worker")
                                      : (a.employee?.nickname || a.employee?.fullName || "Unknown");
                                    const timeOff = !isCasual && a.employeeId ? getTimeOffForDate(a.employeeId, day) : undefined;
                                    const empBranchId = a.employee?.branchId;
                                    const isBorrowed = !isCasual && empBranchId && empBranchId !== selectedBranchId;
                                    const borrowedFromBranch = isBorrowed ? branches?.find(b => b.id === empBranchId) : null;
                                    const assignmentBreak = (row.breaks || []).find(
                                      (b) => b.assignmentId === a.id && b.shiftDate === dateStr
                                    );
                                    return {
                                      id: a.id,
                                      employeeId: assigneeId || "",
                                      employeeName: assigneeName,
                                      hasTimeOff: !!timeOff,
                                      isSick: timeOff?.type === "SICK",
                                      isBorrowed: !!isBorrowed,
                                      borrowedFromBranchName: borrowedFromBranch?.name,
                                      isCasual,
                                      casualWorkerId: a.casualWorkerId,
                                      assigneeType: a.assigneeType || (isCasual ? "casual" : "employee"),
                                      shiftDate: a.shiftDate,
                                      breakStart: assignmentBreak?.breakStartTime,
                                      breakEnd: assignmentBreak?.breakEndTime,
                                      breakHasConflict: assignmentBreak?.hasConflict,
                                    };
                                  });

                                  return (
                                    <DroppableShiftCell
                                      key={day.toISOString()}
                                      id={`shift-cell-${row.id}-${dateStr}`}
                                      shiftRowId={row.id}
                                      date={dateStr}
                                      className={cn(
                                        "p-0.5 border-r last:border-r-0 min-h-[26px] flex flex-col",
                                        isToday && "bg-primary/5",
                                        isWeekend(day) && "bg-muted/30",
                                        copyMode.isActive && "cursor-copy"
                                      )}
                                      onClick={copyMode.isActive ? (e) => {
                                        e.stopPropagation();
                                        handleCopyPasteToShiftRow(row.id, dateStr);
                                      } : undefined}
                                    >
                                      <DeptShiftCell
                                        shiftName={row.label || "Shift"}
                                        timeRange={`${row.startTime.slice(0, 5)} - ${row.endTime.slice(0, 5)}`}
                                        departmentName={row.department?.name}
                                        roles={(() => {
                                          if (row.shiftGroupId) {
                                            const sg = shiftGroupsList.find((g: any) => g.id === row.shiftGroupId);
                                            if (sg?.name) return [sg.name];
                                          }
                                          return row.roles?.map((r: any) => r.role?.name || "").filter(Boolean) || [];
                                        })()}
                                        assignments={assignmentsData}
                                        colorIndex={row.colorIndex}
                                        onRemoveAssignment={isManager && !isPastDate(dateStr) ? (id) => deleteAssignmentMutation.mutate(id) : undefined}
                                        onAssign={!isPastDate(dateStr) ? () => setAssignmentPopover({ shiftRowId: row.id, date: dateStr, anchorEl: null }) : undefined}
                                        isManager={isManager && !isPastDate(dateStr)}
                                        renderAssignment={isManager ? (a) => (
                                          <CopyableShiftWrapper
                                            key={`copy-shift-${a.id}`}
                                            assignmentId={a.id}
                                            shiftData={{
                                              shiftRowId: row.id,
                                              shiftDate: a.shiftDate || dateStr,
                                              employeeId: a.employeeId,
                                              casualWorkerId: a.casualWorkerId,
                                              assigneeType: a.assigneeType || "employee",
                                              startTime: row.startTime,
                                              endTime: row.endTime,
                                              label: row.label,
                                              departmentId: row.departmentId,
                                              departmentName: row.department?.name,
                                              employeeName: a.employeeName,
                                              colorIndex: row.colorIndex,
                                            }}
                                          >
                                          <DraggableAssignmentPill
                                            id={`shift-assignment-${a.id}`}
                                            assignmentId={a.id}
                                            shiftRowId={row.id}
                                            employeeId={a.employeeId}
                                            employeeName={a.employeeName}
                                            shiftDate={dateStr}
                                            isSick={a.isSick}
                                            hasTimeOff={a.hasTimeOff}
                                            isBorrowed={a.isBorrowed}
                                            borrowedFromBranchName={a.borrowedFromBranchName}
                                            colorIndex={row.colorIndex}
                                            shiftStartTime={row.startTime}
                                            shiftEndTime={row.endTime}
                                            shiftLabel={row.label}
                                          />
                                          </CopyableShiftWrapper>
                                        ) : undefined}
                                      />
                                      {isManager && (
                                        <Popover
                                          open={
                                            assignmentPopover?.shiftRowId === row.id &&
                                            assignmentPopover?.date === dateStr
                                          }
                                          onOpenChange={(open) => {
                                            if (!open) setAssignmentPopover(null);
                                          }}
                                        >
                                          <PopoverTrigger asChild>
                                            <button
                                              className="w-full flex items-center justify-center text-muted-foreground/50 hover:text-muted-foreground py-0.5"
                                              onClick={() =>
                                                setAssignmentPopover({
                                                  shiftRowId: row.id,
                                                  date: dateStr,
                                                  anchorEl: null,
                                                })
                                              }
                                              data-testid={`button-add-assignment-${row.id}-${dateStr}`}
                                            >
                                              <Plus className="h-3 w-3" />
                                            </button>
                                          </PopoverTrigger>
                                          <PopoverContent className="w-64 p-2" align="start">
                                            <div className="text-sm font-medium mb-2">Assign Staff</div>
                                            {eligibleEmployeesQuery.isLoading || casualWorkersQuery.isLoading ? (
                                              <div className="space-y-1">
                                                <Skeleton className="h-6 w-full" />
                                                <Skeleton className="h-6 w-full" />
                                              </div>
                                            ) : (() => {
                                              // Filter casual workers to only show those available for this shift
                                              const availableCasualWorkers = casualWorkersQuery.data 
                                                ? getAvailableCasualWorkers(casualWorkersQuery.data, row.id, dateStr)
                                                : [];
                                              
                                              return (eligibleEmployeesQuery.data?.length === 0 && availableCasualWorkers.length === 0) ? (
                                                <p className="text-xs text-muted-foreground">
                                                  No eligible staff
                                                </p>
                                              ) : (
                                                <ScrollArea className="max-h-56">
                                                  <div className="space-y-1">
                                                    {eligibleEmployeesQuery.data?.map((emp) => (
                                                      <Button
                                                        key={emp.id}
                                                        variant="ghost"
                                                        size="sm"
                                                        className="w-full justify-start text-sm h-7"
                                                        onClick={() => handleAssignEmployee(emp.id)}
                                                        data-testid={`button-assign-${emp.id}`}
                                                      >
                                                        {emp.nickname || emp.fullName}
                                                      </Button>
                                                    ))}
                                                    {availableCasualWorkers.length > 0 && (
                                                      <>
                                                        {eligibleEmployeesQuery.data && eligibleEmployeesQuery.data.length > 0 && (
                                                          <div className="border-t my-2 pt-2">
                                                            <span className="text-xs text-muted-foreground px-2">Casual Workers</span>
                                                          </div>
                                                        )}
                                                        {availableCasualWorkers.map((cw) => (
                                                          <Button
                                                            key={`casual-${cw.id}`}
                                                            variant="ghost"
                                                            size="sm"
                                                            className="w-full justify-start text-sm h-7"
                                                            onClick={() => handleAssignCasualWorker(cw.id, cw.dailyRate)}
                                                            data-testid={`button-assign-casual-${cw.id}`}
                                                          >
                                                            <span className="flex items-center gap-2">
                                                              {cw.nickname || cw.fullName}
                                                              <Badge variant="outline" className="text-[10px] px-1 py-0 bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
                                                                Casual
                                                              </Badge>
                                                            </span>
                                                          </Button>
                                                        ))}
                                                      </>
                                                    )}
                                                  </div>
                                                </ScrollArea>
                                              );
                                            })()}
                                            <div className="mt-2 pt-2 border-t">
                                              <Button
                                                variant="outline"
                                                size="sm"
                                                className="w-full text-xs"
                                                onClick={() => {
                                                  setAssignmentPopover(null);
                                                  setBorrowModalData({
                                                    shiftRowId: row.id,
                                                    weekPlanId: weekPlanQuery.data?.id || "",
                                                    date: dateStr,
                                                    shiftLabel: row.label || undefined,
                                                    shiftTime: rowTimeRange,
                                                    departmentName: group.name,
                                                  });
                                                }}
                                                data-testid={`button-borrow-staff-${row.id}-${dateStr}`}
                                              >
                                                Find staff from other branches
                                              </Button>
                                            </div>
                                          </PopoverContent>
                                        </Popover>
                                      )}
                                    </DroppableShiftCell>
                                  );
                                })}
                              </div>
                                )}
                              </SortableShiftRowWrapper>
                            );
                          })}
                          </SortableContext>
                        ))}
                        </div>
                          )}
                        </DroppableGroupZone>
                        </>
                        )}
                      </SortableDepartmentWrapper>
                    );
                  })}
                  </SortableContext>

                  {/* Ungrouped shift rows - rows not assigned to any shift group */}
                  {(() => {
                    const ungroupedRows = groupedByShiftGroup.get("ungrouped") || [];
                    if (ungroupedRows.length === 0) return null;
                    return (
                      <div>
                        <div className={cn("grid bg-muted/30", gridCols)} style={monthGridStyle}>
                          <div className={cn("group/sg py-1.5 px-2 font-medium border-r flex items-center gap-1 text-sm bg-muted/50 sticky left-0 z-20 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]", firstColWidth)}>
                            <button
                              onClick={() => toggleDeptCollapse("ungrouped")}
                              className="p-0.5 text-muted-foreground hover:text-foreground transition-colors"
                              data-testid="button-collapse-ungrouped"
                            >
                              {collapsedDepts.has("ungrouped") ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                            </button>
                            <span className="text-xs sm:text-sm truncate font-medium text-muted-foreground italic">Ungrouped</span>
                            <Badge variant="secondary" className="ml-1 text-[10px] px-1 py-0">{ungroupedRows.length}</Badge>
                          </div>
                          {visibleDays.map((day) => (
                            <div key={day.toISOString()} className={cn("border-r last:border-r-0", isSameDay(day, new Date()) && "bg-primary/5")} />
                          ))}
                        </div>
                        {!collapsedDepts.has("ungrouped") && (
                          <SortableContext items={ungroupedRows.map(r => r.id)} id="ungrouped" strategy={verticalListSortingStrategy}>
                          {ungroupedRows.map((row) => {
                          const rowTimeRange = (() => {
                            const [startH, startM] = row.startTime.split(':');
                            const [endH, endM] = row.endTime.split(':');
                            const sH = parseInt(startH, 10);
                            const eH = parseInt(endH, 10);
                            if (startM === '00' && endM === '00') return `${sH}–${eH}`;
                            const startStr = startM === '00' ? String(sH) : `${sH}:${startM}`;
                            const endStr = endM === '00' ? String(eH) : `${eH}:${endM}`;
                            return `${startStr}–${endStr}`;
                          })();
                          return (
                            <SortableShiftRowWrapper key={row.id} rowId={row.id} groupId="ungrouped">
                              {({ attributes, listeners, setNodeRef: setRowRef, dragStyle }) => (
                            <div 
                              ref={setRowRef}
                              className={cn("grid border-t", gridCols)} 
                              style={{ ...monthGridStyle, ...dragStyle }}
                            >
                              <div
                                className={cn(
                                  "py-1 border-r flex items-center group bg-background sticky left-0 z-30 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]",
                                  firstColWidth,
                                  isManager ? "pl-1 pr-2 cursor-pointer" : "px-2"
                                )}
                                onClick={() => {
                                  if (isManager) {
                                    setEditingShiftRow(row);
                                    setEditShiftRowForm({
                                      startTime: row.startTime,
                                      endTime: row.endTime,
                                      label: row.label || "",
                                      note: row.note || "",
                                      roleIds: row.roles?.map((r: any) => r.roleId) || [],
                                      staffRequired: row.staffRequired ?? 1,
                                      staffRequiredByDay: (row.staffRequiredByDay as Record<string, number>) ?? {},
                                      colorIndex: row.colorIndex ?? null,
                                      shiftGroupId: row.shiftGroupId || null,
                                    });
                                    setEditShiftRowOpen(true);
                                  }
                                }}
                                data-testid={`button-edit-shift-row-${row.id}`}
                              >
                                {isManager && (
                                  <button
                                    {...attributes}
                                    {...listeners}
                                    className="p-1 cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                                    data-testid={`button-drag-shift-row-ungrouped-${row.id}`}
                                    title="Drag to a shift group"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <GripVertical className="h-3 w-3 opacity-40" />
                                  </button>
                                )}
                                <div className="relative flex-1 flex flex-col items-center justify-center py-1">
                                  <span className="font-mono text-xs font-semibold tabular-nums text-center">{rowTimeRange}</span>
                                  {row.label && (
                                    <span className="text-[10px] text-muted-foreground text-center truncate max-w-full leading-tight">{row.label}</span>
                                  )}
                                  {isManager && (
                                    <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity absolute top-1 right-1" />
                                  )}
                                </div>
                              </div>

                              {visibleDays.map((day) => {
                                const dateStr = format(day, "yyyy-MM-dd");
                                const cellAssignments = getAssignmentsForCell(row, day);
                                const isToday = isSameDay(day, new Date());

                                const assignmentsData = cellAssignments.map((a) => {
                                  const isCasual = a.assigneeType === "casual" || !!a.casualWorkerId;
                                  const assigneeId = isCasual ? a.casualWorkerId : a.employeeId;
                                  const matchedEmp = isCasual ? null : activeEmployees.find(e => e.id === assigneeId);
                                  const assigneeName = isCasual
                                    ? casualWorkers?.find((cw: any) => cw.id === assigneeId)?.nickname || "Casual"
                                    : (matchedEmp?.nickname || matchedEmp?.fullName || "?");
                                  return { ...a, isCasual, assigneeId, assigneeName };
                                });

                                return (
                                  <div key={day.toISOString()} className={cn("border-r last:border-r-0 p-0.5 relative", isToday && "bg-primary/5")}>
                                    <div className="flex flex-col gap-0.5">
                                      {assignmentsData.map((a) => {
                                        const colorIdx = row.colorIndex ?? 0;
                                        const palette = [
                                          "bg-blue-500/80 text-white dark:bg-blue-600/70",
                                          "bg-violet-500/80 text-white dark:bg-violet-600/70",
                                          "bg-emerald-500/80 text-white dark:bg-emerald-600/70",
                                          "bg-amber-500/80 text-white dark:bg-amber-600/70",
                                          "bg-rose-500/80 text-white dark:bg-rose-600/70",
                                          "bg-cyan-500/80 text-white dark:bg-cyan-600/70",
                                          "bg-orange-500/80 text-white dark:bg-orange-600/70",
                                          "bg-indigo-500/80 text-white dark:bg-indigo-600/70",
                                        ];
                                        const color = palette[colorIdx % palette.length];
                                        return (
                                          <div
                                            key={a.id}
                                            className={cn("text-[10px] px-1 py-0.5 rounded-sm font-medium truncate cursor-pointer text-center", color)}
                                            onClick={() => {
                                              setAssignmentPopover({ shiftRowId: row.id, date: dateStr, anchorEl: null });
                                            }}
                                            data-testid={`assignment-${a.id}`}
                                          >
                                            {a.assigneeName}
                                          </div>
                                        );
                                      })}
                                    </div>
                                    {isManager && (
                                      <button
                                        className="absolute bottom-0 right-0 p-0.5 text-muted-foreground/30 hover:text-muted-foreground/70 transition-colors"
                                        onClick={() => setAssignmentPopover({ shiftRowId: row.id, date: dateStr, anchorEl: null })}
                                        data-testid={`button-add-assignment-ungrouped-${row.id}-${dateStr}`}
                                      >
                                        <Plus className="h-2.5 w-2.5" />
                                      </button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                              )}
                            </SortableShiftRowWrapper>
                          );
                        })}
                          </SortableContext>
                        )}
                      </div>
                    );
                  })()}

                  {isManager && (
                    <div className="p-3 border-t">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => setCreateShiftGroupOpen(true)}
                        data-testid="button-add-shift-group"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Add Shift Group
                      </Button>
                    </div>
                  )}
                  </>
                  );
                })()}
              </div>
            </div>
          </CardContent>
          </Card>
          <DragOverlay dropAnimation={null}>
            {activeDragId && activeDragData && activeDragData.assignmentId && (() => {
              const empId = activeDragData.employeeId;
              const shiftRow = weekPlanQuery.data?.shiftRows?.find((r: any) => r.id === activeDragData.shiftRowId);
              const emp = activeEmployees.find(e => e.id === empId);
              const casual = casualWorkersQuery.data?.find((cw: any) => cw.id === empId);
              const name = emp?.nickname || casual?.nickname || "?";
              const cIdx = shiftRow?.colorIndex;
              const pillColor = cIdx != null ? getShiftColorByIndex(cIdx) : getEmployeeColor(empId);
              return (
                <div className={cn("text-[10px] font-medium truncate leading-tight text-center px-1 py-0.5 rounded-sm text-white shadow-lg cursor-grabbing", pillColor)}
                  style={{ width: 80 }}
                >
                  {name}
                </div>
              );
            })()}
          </DragOverlay>
        </DndContext>
      )}

      <Dialog open={createShiftGroupOpen} onOpenChange={setCreateShiftGroupOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Shift Group</DialogTitle>
            <DialogDescription>
              Shift groups help organize shifts in the Shift View (e.g., "Morning Team", "Kitchen", "Front of House").
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="shift-group-name">Group Name <span className="text-destructive">*</span></Label>
              <Input
                id="shift-group-name"
                placeholder="e.g., Morning Team, Kitchen Staff"
                value={newShiftGroupName}
                onChange={(e) => setNewShiftGroupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newShiftGroupName.trim()) {
                    createShiftGroupMutation.mutate(newShiftGroupName.trim());
                  }
                }}
                data-testid="input-shift-group-name"
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setCreateShiftGroupOpen(false)} data-testid="button-cancel-shift-group">
              Cancel
            </Button>
            <Button
              onClick={() => createShiftGroupMutation.mutate(newShiftGroupName.trim())}
              disabled={!newShiftGroupName.trim() || createShiftGroupMutation.isPending}
              data-testid="button-create-shift-group"
            >
              {createShiftGroupMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={createShiftRowOpen} onOpenChange={setCreateShiftRowOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Shift</DialogTitle>
            <DialogDescription>
              Create a new shift for{" "}
              {shiftGroupsList.find((g: any) => g.id === selectedShiftGroupId)?.name || "this group"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="label">Shift Name <span className="text-destructive">*</span></Label>
              <Input
                id="label"
                placeholder="e.g., Morning, Evening, Lunch"
                value={shiftRowForm.label}
                onChange={(e) => setShiftRowForm((f) => ({ ...f, label: e.target.value }))}
                data-testid="input-label"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="startTime">Start Time</Label>
                <Input
                  id="startTime"
                  type="time"
                  value={shiftRowForm.startTime}
                  onChange={(e) => {
                    const newStart = e.target.value;
                    setShiftRowForm((f) => ({ 
                      ...f, 
                      startTime: newStart,
                      endTime: calculateEndTime(newStart)
                    }));
                  }}
                  data-testid="input-start-time"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endTime">End Time</Label>
                <Input
                  id="endTime"
                  type="time"
                  value={shiftRowForm.endTime}
                  onChange={(e) => setShiftRowForm((f) => ({ ...f, endTime: e.target.value }))}
                  data-testid="input-end-time"
                />
                <p className="text-xs text-muted-foreground">Default 9-hour shift. Auto-adjusts when start time changes.</p>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Required Roles <span className="text-destructive">*</span></Label>
              <div className="flex flex-wrap gap-2">
                {rolesQuery.data
                  ?.filter((r) => r.isActive)
                  .map((role) => {
                    const isSelected = shiftRowForm.roleIds.includes(role.id);
                    return (
                      <Badge
                        key={role.id}
                        variant={isSelected ? "default" : "outline"}
                        className="cursor-pointer"
                        onClick={() =>
                          setShiftRowForm((f) => ({
                            ...f,
                            roleIds: isSelected
                              ? f.roleIds.filter((id) => id !== role.id)
                              : [...f.roleIds, role.id],
                          }))
                        }
                        data-testid={`badge-role-${role.id}`}
                      >
                        {role.name}
                      </Badge>
                    );
                  })}
              </div>
              {shiftRowForm.roleIds.length === 0 && (
                <p className="text-xs text-muted-foreground">Select at least one role</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="staffRequired">Staff Required (default)</Label>
              <Input
                id="staffRequired"
                type="number"
                min={1}
                value={shiftRowForm.staffRequired}
                onChange={(e) => setShiftRowForm((f) => ({ ...f, staffRequired: parseInt(e.target.value) || 1 }))}
                data-testid="input-staff-required"
              />
              <p className="text-xs text-muted-foreground">Minimum staff needed per day</p>
            </div>

            <div className="space-y-2">
              <Label>Per-Day Overrides (optional)</Label>
              <div className="grid grid-cols-7 gap-1">
                {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => {
                  const dayKey = day.toLowerCase();
                  const override = shiftRowForm.staffRequiredByDay[dayKey];
                  return (
                    <div key={day} className="flex flex-col items-center gap-1">
                      <span className="text-xs text-muted-foreground">{day}</span>
                      <Input
                        type="number"
                        min={0}
                        className="h-8 w-full text-center px-1"
                        placeholder="-"
                        value={override ?? ""}
                        onChange={(e) => {
                          const val = e.target.value;
                          setShiftRowForm((f) => {
                            const newByDay = { ...f.staffRequiredByDay };
                            if (val === "") {
                              delete newByDay[dayKey];
                            } else {
                              newByDay[dayKey] = parseInt(val) || 0;
                            }
                            return { ...f, staffRequiredByDay: newByDay };
                          });
                        }}
                        data-testid={`input-staff-${dayKey}`}
                      />
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">Leave empty to use default. Set specific values to override per day.</p>
            </div>

            <div className="space-y-2">
              <Label>Shift Color</Label>
              <div className="flex flex-wrap gap-2">
                {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((idx) => (
                  <button
                    key={idx}
                    type="button"
                    className={cn(
                      "w-8 h-8 rounded-md transition-all",
                      getShiftColorByIndex(idx),
                      shiftRowForm.colorIndex === idx ? "ring-2 ring-offset-2 ring-primary" : "opacity-70 hover:opacity-100"
                    )}
                    onClick={() => setShiftRowForm((f) => ({ ...f, colorIndex: f.colorIndex === idx ? null : idx }))}
                    data-testid={`button-color-${idx}`}
                  />
                ))}
              </div>
              <p className="text-xs text-muted-foreground">Click to select a color. Click again to remove.</p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateShiftRowOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateShiftRow}
              disabled={createShiftRowMutation.isPending || ensureWeekPlanMutation.isPending}
              data-testid="button-create-shift-row"
            >
              {createShiftRowMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editShiftRowOpen} onOpenChange={setEditShiftRowOpen}>
        <DialogContent className="max-h-[85vh] overflow-hidden flex flex-col !grid-rows-none">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle>Edit Shift</DialogTitle>
            <DialogDescription>
              Update the shift details
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 overflow-y-auto pr-2 min-h-0">
            <div className="space-y-2">
              <Label htmlFor="editLabel">Shift Name <span className="text-destructive">*</span></Label>
              <Input
                id="editLabel"
                placeholder="e.g., Morning, Evening, Lunch"
                value={editShiftRowForm.label}
                onChange={(e) => setEditShiftRowForm((f) => ({ ...f, label: e.target.value }))}
                data-testid="input-edit-label"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="editShiftGroup">Shift Group</Label>
              <Select
                value={editShiftRowForm.shiftGroupId || "__none__"}
                onValueChange={(val) => setEditShiftRowForm((f) => ({ ...f, shiftGroupId: val === "__none__" ? null : val }))}
              >
                <SelectTrigger id="editShiftGroup" data-testid="select-edit-shift-group">
                  <SelectValue placeholder="Select shift group" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Ungrouped</SelectItem>
                  {shiftGroupsList.map((group: any) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Assign this shift to a group for organization</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="editStartTime">Start Time</Label>
                <Input
                  id="editStartTime"
                  type="time"
                  value={editShiftRowForm.startTime}
                  onChange={(e) => {
                    const newStart = e.target.value;
                    setEditShiftRowForm((f) => ({ 
                      ...f, 
                      startTime: newStart,
                      endTime: calculateEndTime(newStart)
                    }));
                  }}
                  data-testid="input-edit-start-time"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="editEndTime">End Time</Label>
                <Input
                  id="editEndTime"
                  type="time"
                  value={editShiftRowForm.endTime}
                  onChange={(e) => setEditShiftRowForm((f) => ({ ...f, endTime: e.target.value }))}
                  data-testid="input-edit-end-time"
                />
                <p className="text-xs text-muted-foreground">Default 9-hour shift. Auto-adjusts when start time changes.</p>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Required Roles <span className="text-destructive">*</span></Label>
              <div className="flex flex-wrap gap-2">
                {rolesQuery.data
                  ?.filter((r) => r.isActive)
                  .map((role) => {
                    const isSelected = editShiftRowForm.roleIds.includes(role.id);
                    return (
                      <Badge
                        key={role.id}
                        variant={isSelected ? "default" : "outline"}
                        className="cursor-pointer"
                        onClick={() =>
                          setEditShiftRowForm((f) => ({
                            ...f,
                            roleIds: isSelected
                              ? f.roleIds.filter((id) => id !== role.id)
                              : [...f.roleIds, role.id],
                          }))
                        }
                        data-testid={`badge-edit-role-${role.id}`}
                      >
                        {role.name}
                      </Badge>
                    );
                  })}
              </div>
              {editShiftRowForm.roleIds.length === 0 && (
                <p className="text-xs text-muted-foreground">Select at least one role</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="editStaffRequired">Staff Required (default)</Label>
              <Input
                id="editStaffRequired"
                type="number"
                min={1}
                value={editShiftRowForm.staffRequired}
                onChange={(e) => setEditShiftRowForm((f) => ({ ...f, staffRequired: parseInt(e.target.value) || 1 }))}
                data-testid="input-edit-staff-required"
              />
              <p className="text-xs text-muted-foreground">Minimum staff needed per day</p>
            </div>

            <div className="space-y-2">
              <Label>Per-Day Overrides (optional)</Label>
              <div className="grid grid-cols-7 gap-1">
                {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => {
                  const dayKey = day.toLowerCase();
                  const override = editShiftRowForm.staffRequiredByDay[dayKey];
                  return (
                    <div key={day} className="flex flex-col items-center gap-1">
                      <span className="text-xs text-muted-foreground">{day}</span>
                      <Input
                        type="number"
                        min={0}
                        className="h-8 w-full text-center px-1"
                        placeholder="-"
                        value={override ?? ""}
                        onChange={(e) => {
                          const val = e.target.value;
                          setEditShiftRowForm((f) => {
                            const newByDay = { ...f.staffRequiredByDay };
                            if (val === "") {
                              delete newByDay[dayKey];
                            } else {
                              newByDay[dayKey] = parseInt(val) || 0;
                            }
                            return { ...f, staffRequiredByDay: newByDay };
                          });
                        }}
                        data-testid={`input-edit-staff-${dayKey}`}
                      />
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">Leave empty to use default. Set specific values to override per day.</p>
            </div>

            <div className="space-y-2">
              <Label>Shift Color</Label>
              <div className="flex flex-wrap gap-2">
                {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((idx) => (
                  <button
                    key={idx}
                    type="button"
                    className={cn(
                      "w-8 h-8 rounded-md transition-all",
                      getShiftColorByIndex(idx),
                      editShiftRowForm.colorIndex === idx ? "ring-2 ring-offset-2 ring-primary" : "opacity-70 hover:opacity-100"
                    )}
                    onClick={() => setEditShiftRowForm((f) => ({ ...f, colorIndex: f.colorIndex === idx ? null : idx }))}
                    data-testid={`button-edit-color-${idx}`}
                  />
                ))}
              </div>
              <p className="text-xs text-muted-foreground">Click to select a color. Click again to remove.</p>
            </div>
          </div>

          <DialogFooter className="flex gap-2 flex-shrink-0">
            {editingShiftRow && (
              <Button
                variant="destructive"
                onClick={() => {
                  if (editingShiftRow) {
                    deleteShiftRowMutation.mutate(editingShiftRow.id);
                    setEditShiftRowOpen(false);
                    setEditingShiftRow(null);
                  }
                }}
                disabled={deleteShiftRowMutation.isPending}
                data-testid="button-delete-shift-row"
              >
                {deleteShiftRowMutation.isPending ? "Deleting..." : "Delete"}
              </Button>
            )}
            <div className="flex-1" />
            <Button variant="outline" onClick={() => setEditShiftRowOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!editShiftRowForm.label?.trim()) {
                  toast({ title: "Error", description: "Shift name is required", variant: "destructive" });
                  return;
                }
                if (editShiftRowForm.roleIds.length === 0) {
                  toast({ title: "Error", description: "At least one role is required", variant: "destructive" });
                  return;
                }
                if (editingShiftRow) {
                  updateShiftRowMutation.mutate({
                    id: editingShiftRow.id,
                    startTime: editShiftRowForm.startTime,
                    endTime: editShiftRowForm.endTime,
                    label: editShiftRowForm.label,
                    note: editShiftRowForm.note || undefined,
                    roleIds: editShiftRowForm.roleIds,
                    staffRequired: editShiftRowForm.staffRequired,
                    staffRequiredByDay: Object.keys(editShiftRowForm.staffRequiredByDay).length > 0 ? editShiftRowForm.staffRequiredByDay : undefined,
                    colorIndex: editShiftRowForm.colorIndex,
                    shiftGroupId: editShiftRowForm.shiftGroupId,
                  });
                }
              }}
              disabled={updateShiftRowMutation.isPending}
              data-testid="button-update-shift-row"
            >
              {updateShiftRowMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={templateDialogOpen} onOpenChange={setTemplateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save as Template</DialogTitle>
            <DialogDescription>
              {viewMode === "employees"
                ? "Save this week's schedule as a reusable template for a specific department"
                : "Save this week's schedule as a reusable template for a specific shift group"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="templateName">Template Name</Label>
              <Input
                id="templateName"
                placeholder="e.g., Standard Week, Holiday Week"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                data-testid="input-template-name"
              />
            </div>
            {viewMode === "employees" ? (
              <div className="space-y-2">
                <Label>Department</Label>
                <Select value={templateDepartmentId} onValueChange={setTemplateDepartmentId}>
                  <SelectTrigger data-testid="select-template-department">
                    <SelectValue placeholder="Select department" />
                  </SelectTrigger>
                  <SelectContent>
                    {allDepartments.map((dept) => (
                      <SelectItem key={dept.id} value={dept.id}>
                        {dept.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Only shifts for employees in this department will be saved to the template
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <Label>Shift Group</Label>
                <Select value={templateShiftGroupId} onValueChange={setTemplateShiftGroupId}>
                  <SelectTrigger data-testid="select-template-shift-group">
                    <SelectValue placeholder="Select shift group" />
                  </SelectTrigger>
                  <SelectContent>
                    {shiftGroupsList.map((group: any) => (
                      <SelectItem key={group.id} value={group.id}>
                        {group.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Only shifts from this shift group will be saved to the template
                </p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setTemplateDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveAsTemplate}
              disabled={saveAsTemplateMutation.isPending || !templateName.trim() || (viewMode === "employees" ? !templateDepartmentId : !templateShiftGroupId)}
              data-testid="button-save-as-template"
            >
              {saveAsTemplateMutation.isPending ? "Saving..." : "Save Template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={applyTemplateDialogOpen} onOpenChange={handleCloseApplyDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {templateApplyStep === "select" ? "Apply Template" : "Review & Confirm"}
            </DialogTitle>
            <DialogDescription>
              {templateApplyStep === "select" 
                ? viewMode === "employees"
                  ? "Select a department template to apply to this week's schedule"
                  : "Select a shift group template to apply to this week's schedule"
                : "Review what will be added to this week's schedule"
              }
            </DialogDescription>
          </DialogHeader>

          {templateApplyStep === "select" && (
            <>
              {(() => {
                const scopeLabel = viewMode === "employees" ? "Department" : "Shift Group";
                const filteredTemplates = (templatesQuery.data || []).filter((t: any) => 
                  viewMode === "employees" ? t.departmentId : t.shiftGroupId
                );
                return filteredTemplates.length > 0 ? (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>Select {scopeLabel} Template</Label>
                      <Select value={selectedTemplateId || ""} onValueChange={setSelectedTemplateId}>
                        <SelectTrigger data-testid="select-template">
                          <SelectValue placeholder={`Choose a ${scopeLabel.toLowerCase()} template`} />
                        </SelectTrigger>
                        <SelectContent>
                          {filteredTemplates.map((template: any) => (
                            <SelectItem key={template.id} value={template.id}>
                              {template.name} ({viewMode === "employees" ? template.department?.name : template.shiftGroup?.name})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="border rounded p-2 max-h-32 overflow-y-auto">
                      <div className="text-sm font-medium mb-2">{scopeLabel} Templates</div>
                      {filteredTemplates.map((template: any) => (
                        <div key={template.id} className="flex items-center justify-between py-1 text-sm">
                          <div>
                            <span>{template.name}</span>
                            <span className="ml-2 text-xs text-muted-foreground">
                              ({viewMode === "employees" ? template.department?.name : template.shiftGroup?.name})
                            </span>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => deleteTemplateMutation.mutate(template.id)}
                            data-testid={`button-delete-template-${template.id}`}
                          >
                            <Trash2 className="h-3 w-3 text-muted-foreground" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="py-8 text-center text-muted-foreground">
                    <Save className="h-12 w-12 mx-auto mb-3 opacity-50" />
                    <p className="font-medium">No {scopeLabel.toLowerCase()} templates saved yet</p>
                    <p className="text-sm mt-1">
                      {viewMode === "employees"
                        ? "Switch to Employee View and save a schedule as a department template first."
                        : "Switch to Shift View and save a schedule as a shift group template first."}
                    </p>
                  </div>
                );
              })()}
            </>
          )}

          {templateApplyStep === "preview" && templatePreview && (
            <div className="space-y-4">
              <div className="text-sm text-muted-foreground">
                Template has {templatePreview.templateRows} shift row{templatePreview.templateRows !== 1 ? 's' : ''}{templatePreview.assignmentsToApply > 0 ? ` and ${templatePreview.assignmentsToApply} assignment${templatePreview.assignmentsToApply !== 1 ? 's' : ''} to apply` : ''}{(templatePreview.timeOffToApply ?? 0) > 0 ? ` and ${templatePreview.timeOffToApply} leave entr${templatePreview.timeOffToApply !== 1 ? 'ies' : 'y'} to apply` : ''}.
                Applying will only add missing rows and assignments — existing ones are never touched.
              </div>

              {templatePreview.rowsToAdd.length > 0 && (
                <div className="rounded-md border p-3 bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800">
                  <div className="flex items-center gap-2 text-green-800 dark:text-green-200">
                    <Plus className="h-4 w-4" />
                    <span className="font-medium">{templatePreview.rowsToAdd.length} Row{templatePreview.rowsToAdd.length !== 1 ? 's' : ''} Will Be Added</span>
                  </div>
                  <div className="mt-2 space-y-1">
                    {templatePreview.rowsToAdd.map((row, i) => (
                      <div key={i} className="text-sm text-green-700 dark:text-green-300 flex items-center gap-2">
                        <span>{row.label || 'Shift'}</span>
                        <span className="text-xs text-muted-foreground">({row.startTime} - {row.endTime})</span>
                        {row.departmentName && <Badge variant="outline" className="text-xs">{row.departmentName}</Badge>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {templatePreview.rowsAlreadyExist.length > 0 && (
                <div className="rounded-md border p-3 bg-muted/50">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Check className="h-4 w-4" />
                    <span className="font-medium">{templatePreview.rowsAlreadyExist.length} Row{templatePreview.rowsAlreadyExist.length !== 1 ? 's' : ''} Already Exist (will be skipped)</span>
                  </div>
                  <div className="mt-2 space-y-1">
                    {templatePreview.rowsAlreadyExist.map((row, i) => (
                      <div key={i} className="text-sm text-muted-foreground flex items-center gap-2">
                        <span>{row.label || 'Shift'}</span>
                        <span className="text-xs">({row.startTime} - {row.endTime})</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {templatePreview.rowsToAdd.length === 0 && (
                <div className="rounded-md border p-3 bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-800">
                  <div className="flex items-center gap-2 text-amber-800 dark:text-amber-200">
                    <Info className="h-4 w-4" />
                    <span className="font-medium">All shift rows already exist</span>
                  </div>
                  <p className="text-sm mt-1 text-amber-700 dark:text-amber-300">
                    {(templatePreview.assignmentsToApply ?? 0) > 0 && (templatePreview.timeOffToApply ?? 0) === 0
                      ? `No new shift rows will be added, but ${templatePreview.assignmentsToApply} assignment${templatePreview.assignmentsToApply !== 1 ? 's' : ''} from this template will be applied.`
                      : (templatePreview.timeOffToApply ?? 0) > 0
                        ? `No new shift rows will be added, but ${templatePreview.timeOffToApply} leave entr${templatePreview.timeOffToApply !== 1 ? 'ies' : 'y'}${(templatePreview.assignmentsToApply ?? 0) > 0 ? ` and ${templatePreview.assignmentsToApply} assignment${templatePreview.assignmentsToApply !== 1 ? 's' : ''}` : ''} from this template will be applied.`
                      : "Every shift row, assignment, and leave entry from this template is already present in this week. Nothing will be added."
                    }
                  </p>
                </div>
              )}
            </div>
          )}

          <DialogFooter className="gap-2">
            {templateApplyStep === "preview" && (
              <Button 
                variant="outline" 
                onClick={() => setTemplateApplyStep("select")}
                data-testid="button-back-to-select"
              >
                Back
              </Button>
            )}
            <Button variant="outline" onClick={handleCloseApplyDialog}>
              Cancel
            </Button>
            {templatesQuery.data && templatesQuery.data.length > 0 && (
              <Button
                onClick={handleApplyTemplate}
                disabled={
                  (templateApplyStep === "select" && (!selectedTemplateId || templatePreviewLoading)) ||
                  (templateApplyStep === "preview" && applyTemplateMutation.isPending)
                }
                data-testid="button-apply-template-confirm"
              >
                {templatePreviewLoading 
                  ? "Checking..." 
                  : applyTemplateMutation.isPending 
                    ? "Applying..." 
                    : templateApplyStep === "select" 
                      ? "Preview" 
                      : "Apply Template"
                }
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={clearWeekDialogOpen} onOpenChange={(open) => {
        setClearWeekDialogOpen(open);
        if (!open) { setClearDeptId(""); setClearWeekStart(""); }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear Week Schedule</DialogTitle>
            <DialogDescription>
              Removes all assignments for <strong>one department only</strong> in the selected week. All other departments are completely unaffected. Shift row definitions and leave records are never deleted.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Department to clear <span className="text-destructive">*</span></Label>
              <Select value={clearDeptId} onValueChange={setClearDeptId}>
                <SelectTrigger data-testid="select-clear-department">
                  <SelectValue placeholder="Select a department" />
                </SelectTrigger>
                <SelectContent>
                  {allDepartments.map(d => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Week starting (Monday) <span className="text-destructive">*</span></Label>
              <Input
                type="date"
                value={clearWeekStart}
                onChange={e => {
                  const d = new Date(e.target.value + "T00:00:00");
                  const mon = startOfWeek(d, { weekStartsOn: 1 });
                  setClearWeekStart(format(mon, "yyyy-MM-dd"));
                }}
                data-testid="input-clear-week-start"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Branch</Label>
              <Input value={selectedBranch?.name || selectedBranchId || ""} readOnly className="bg-muted/50" />
            </div>
            {clearDeptId && clearWeekStart && selectedBranchId && (() => {
              const ws = new Date(clearWeekStart + "T00:00:00");
              const we = addDays(ws, 6);
              const otherDepts = allDepartments.filter(d => d.id !== clearDeptId);
              const preview = clearPreviewQuery.data;
              return (
                <div className="space-y-2">
                  {/* Live preview box */}
                  <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm space-y-1">
                    <p className="font-medium text-destructive">What will be deleted:</p>
                    {clearPreviewQuery.isLoading ? (
                      <p className="text-muted-foreground">Counting records…</p>
                    ) : clearPreviewQuery.isError ? (
                      <p className="text-muted-foreground">Could not load preview.</p>
                    ) : preview ? (
                      <>
                        <p className="text-destructive">
                          <strong>{preview.assignments}</strong> assignment{preview.assignments !== 1 ? "s" : ""}
                          {preview.breaks > 0 ? ` and ${preview.breaks} break record${preview.breaks !== 1 ? "s" : ""}` : ""}{" "}
                          for <strong>{preview.department}</strong> · <strong>{format(ws, "d MMM")}–{format(we, "d MMM yyyy")}</strong> · {preview.branch}
                        </p>
                        {preview.employees.length > 0 && (
                          <p className="text-muted-foreground text-xs">
                            Affects {preview.employees.length} employee{preview.employees.length !== 1 ? "s" : ""}: {preview.employees.slice(0, 8).map(e => e.name).join(", ")}{preview.employees.length > 8 ? ` +${preview.employees.length - 8} more` : ""}
                          </p>
                        )}
                        {preview.assignments === 0 && (
                          <p className="text-muted-foreground text-xs">No assignments found for this scope — nothing will be deleted.</p>
                        )}
                      </>
                    ) : null}
                  </div>
                  {/* Unaffected departments */}
                  {otherDepts.length > 0 && (
                    <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800">
                      ✓ Other departments ({otherDepts.map(d => d.name).join(", ")}) are <strong>not affected</strong>.
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setClearWeekDialogOpen(false)} data-testid="button-clear-week-cancel">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => clearWeekMutation.mutate()}
              disabled={clearWeekMutation.isPending || !clearDeptId || !clearWeekStart || !selectedBranchId}
              data-testid="button-clear-week-confirm"
            >
              {clearWeekMutation.isPending ? "Clearing..." : `Clear ${allDepartments.find(d => d.id === clearDeptId)?.name || ""} Schedule`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={offDaysDialogOpen} onOpenChange={setOffDaysDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Set Weekly Off Days</DialogTitle>
            <DialogDescription>
              {selectedEmployeeForOffDays?.nickname || selectedEmployeeForOffDays?.fullName}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="grid grid-cols-7 gap-2">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((dayName, idx) => (
                <button
                  key={dayName}
                  onClick={() => toggleOffDay(idx)}
                  className={cn(
                    "p-3 text-sm font-medium rounded-lg border-2 transition-colors",
                    editingOffDays.includes(idx)
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-muted/50 text-muted-foreground border-transparent hover:border-muted-foreground/20"
                  )}
                  data-testid={`button-off-day-${idx}`}
                >
                  {dayName}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Click on days to toggle them as regular off days
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOffDaysDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={saveOffDays}
              disabled={updateOffDaysMutation.isPending}
            >
              {updateOffDaysMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {selectedBranchId && (
        <BorrowStaffModal
          open={!!borrowModalData}
          onOpenChange={(open) => !open && setBorrowModalData(null)}
          shiftRowId={borrowModalData?.shiftRowId || ""}
          weekPlanId={borrowModalData?.weekPlanId || ""}
          date={borrowModalData?.date || ""}
          branchId={selectedBranchId}
          weekStartFormatted={weekStartFormatted}
          shiftLabel={borrowModalData?.shiftLabel}
          shiftTime={borrowModalData?.shiftTime || ""}
          departmentName={borrowModalData?.departmentName || ""}
        />
      )}
      
      {/* Employee Info Popup - shows leave balances when clicking employee name */}
      {selectedEmployeeForInfo && (
        <EmployeeInfoPopup
          open={employeeInfoPopupOpen}
          onOpenChange={setEmployeeInfoPopupOpen}
          employeeId={selectedEmployeeForInfo.id}
          employeeName={selectedEmployeeForInfo.name}
          avatarUrl={selectedEmployeeForInfo.avatar}
        />
      )}

      {dutyBlocksSheetData && (
        <DutyBlocksSheet
          open={!!dutyBlocksSheetData}
          onOpenChange={(open) => !open && setDutyBlocksSheetData(null)}
          assignmentId={dutyBlocksSheetData.assignmentId}
          branchId={selectedBranchId}
          employeeId={dutyBlocksSheetData.employeeId}
          employeeName={dutyBlocksSheetData.employeeName}
          date={dutyBlocksSheetData.date}
          shiftStartTime={dutyBlocksSheetData.shiftStartTime}
          shiftEndTime={dutyBlocksSheetData.shiftEndTime}
          shiftName={dutyBlocksSheetData.shiftName}
        />
      )}

      {/* Conflict Scanner Dialog */}
      <Dialog open={conflictScanDialogOpen} onOpenChange={(open) => {
        setConflictScanDialogOpen(open);
        if (!open) {
          setConflictScanResults(null);
          setConflictResolutions(new Map());
          setConflictUndoStack([]);
        }
      }}>
        <DialogContent className="sm:max-w-xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Scan & Fix Scheduling Conflicts
            </DialogTitle>
            <DialogDescription>
              Detects employees with multiple shifts or shift + day off on the same date.
            </DialogDescription>
          </DialogHeader>

          {conflictScanLoading ? (
            <div className="py-8 text-center text-muted-foreground text-sm">Scanning...</div>
          ) : conflictScanResults ? (
            <div className="space-y-3">
              {conflictScanResults.totalConflicts === 0 ? (
                <div className="py-8 text-center">
                  <Check className="h-8 w-8 text-green-500 mx-auto mb-2" />
                  <p className="text-sm font-medium text-green-700 dark:text-green-400">No conflicts found</p>
                  <p className="text-xs text-muted-foreground mt-1">All schedules are clean.</p>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <p className="text-sm font-medium text-destructive" data-testid="text-conflict-count">
                      {conflictScanResults.totalConflicts} conflict{conflictScanResults.totalConflicts !== 1 ? "s" : ""} found
                    </p>
                    <div className="flex items-center gap-2 flex-wrap">
                      {conflictUndoStack.length > 0 && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleUndoConflictSelection}
                          data-testid="button-undo-conflict"
                        >
                          <Undo2 className="h-3.5 w-3.5 mr-1" />
                          Undo
                        </Button>
                      )}
                      {conflictResolutions.size > 0 && (
                        <Button 
                          size="sm"
                          onClick={handleApplyConflictResolutions}
                          disabled={autoFixLoading}
                          data-testid="button-apply-resolutions"
                        >
                          {autoFixLoading ? "Applying..." : `Apply ${conflictResolutions.size} fix${conflictResolutions.size !== 1 ? 'es' : ''}`}
                        </Button>
                      )}
                      <Button 
                        size="sm" 
                        variant="destructive" 
                        onClick={handleAutoFixConflicts}
                        disabled={autoFixLoading}
                        data-testid="button-auto-fix-all"
                      >
                        {autoFixLoading ? "Fixing..." : "Auto-Fix All"}
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    {conflictScanResults.conflicts.map((conflict: any, idx: number) => {
                      const conflictKey = `${conflict.employeeId}_${conflict.date}`;
                      const resolution = conflictResolutions.get(conflictKey);
                      const isResolved = !!resolution;

                      return (
                        <Card key={`${conflict.employeeId}-${conflict.date}-${idx}`} className={cn(isResolved && "opacity-60")}>
                          <CardContent className="p-3 space-y-2">
                            <div className="flex items-center justify-between gap-2 flex-wrap">
                              <div>
                                <p className="text-sm font-medium" data-testid={`text-conflict-employee-${idx}`}>{conflict.employeeName}</p>
                                <p className="text-xs text-muted-foreground">{conflict.date}</p>
                              </div>
                              <div className="flex items-center gap-1 flex-wrap">
                                {conflict.hasDayOff && (
                                  <Badge variant="secondary" className="text-xs">Day Off</Badge>
                                )}
                                <Badge variant="destructive" className="text-xs">
                                  {conflict.assignmentCount} shift{conflict.assignmentCount !== 1 ? 's' : ''}
                                </Badge>
                                {isResolved && (
                                  <Badge variant="outline" className="text-xs text-green-600 border-green-600">
                                    <Check className="h-3 w-3 mr-0.5" /> Resolved
                                  </Badge>
                                )}
                              </div>
                            </div>
                            <div className="space-y-1">
                              {conflict.hasDayOff && (
                                <div className={cn(
                                  "flex items-center justify-between gap-2 text-xs rounded px-2 py-1.5",
                                  isResolved && resolution.type === 'dayoff'
                                    ? "bg-green-100 dark:bg-green-900/30 border border-green-300 dark:border-green-700"
                                    : isResolved
                                      ? "bg-muted/30 line-through text-muted-foreground"
                                      : "bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800"
                                )}>
                                  <div className="flex items-center gap-1.5">
                                    <Moon className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                                    <span className="font-medium">Day Off</span>
                                  </div>
                                  {!isResolved && (
                                    <Button 
                                      size="sm" 
                                      variant="outline"
                                      onClick={() => handleSelectConflictItem(conflictKey, 'dayoff', 'dayoff')}
                                      data-testid={`button-keep-dayoff-${idx}`}
                                    >
                                      Keep
                                    </Button>
                                  )}
                                </div>
                              )}
                              {conflict.assignments.map((a: any) => {
                                const isKept = isResolved && resolution.type === 'shift' && resolution.kept === a.id;
                                const isStruck = isResolved && !isKept;
                                return (
                                  <div key={a.id} className={cn(
                                    "flex items-center justify-between gap-2 text-xs rounded px-2 py-1.5",
                                    isKept
                                      ? "bg-green-100 dark:bg-green-900/30 border border-green-300 dark:border-green-700"
                                      : isStruck
                                        ? "bg-muted/30 line-through text-muted-foreground"
                                        : "bg-muted/50"
                                  )}>
                                    <div className="flex items-center gap-1.5">
                                      <Clock className="h-3.5 w-3.5" />
                                      <span>{a.startTime?.slice(0,5)}-{a.endTime?.slice(0,5)}</span>
                                      {a.label && <span className="text-muted-foreground">({a.label})</span>}
                                    </div>
                                    {!isResolved && (
                                      <Button 
                                        size="sm" 
                                        variant="outline"
                                        onClick={() => handleSelectConflictItem(conflictKey, a.id, 'shift')}
                                        data-testid={`button-keep-${a.id}`}
                                      >
                                        Keep
                                      </Button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          ) : null}

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConflictScanDialogOpen(false)} data-testid="button-conflict-close">
              Close
            </Button>
            <Button onClick={handleScanConflicts} disabled={conflictScanLoading} data-testid="button-rescan">
              {conflictScanLoading ? "Scanning..." : "Re-Scan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ScheduleHistoryDialog 
        open={scheduleHistoryOpen} 
        onOpenChange={setScheduleHistoryOpen} 
        branchId={selectedBranchId}
        onRestored={() => {
          queryClient.invalidateQueries({ queryKey: ["/api/schedule/week-plan"] });
          weekPlanQuery.refetch();
        }}
      />

      <Dialog open={mergeDialogOpen} onOpenChange={(open) => {
        setMergeDialogOpen(open);
        if (!open) { setMergePreview(null); setMergeTargetId(null); }
      }}>
        <DialogContent className="sm:max-w-xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Merge Shift Rows</DialogTitle>
            <DialogDescription>
              Choose which shift row to keep, then all assignments from the others will be merged into it.
            </DialogDescription>
          </DialogHeader>

          {(() => {
            const allShiftRowsForMerge = weekPlanQuery.data?.shiftRows || [];
            const selectedRows = allShiftRowsForMerge.filter(r => mergeSelectedIds.has(r.id));

            return (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Select the row to keep (target):</Label>
                  <div className="space-y-1.5">
                    {selectedRows.map(row => (
                      <div
                        key={row.id}
                        className={cn(
                          "flex items-center gap-3 p-2 rounded-md border cursor-pointer transition-colors",
                          mergeTargetId === row.id
                            ? "border-primary bg-primary/5"
                            : "border-border hover-elevate"
                        )}
                        onClick={() => {
                          setMergeTargetId(row.id);
                          setMergePreview(null);
                        }}
                        data-testid={`merge-target-${row.id}`}
                      >
                        <div className={cn(
                          "w-3 h-3 rounded-full border-2 flex items-center justify-center flex-shrink-0",
                          mergeTargetId === row.id ? "border-primary" : "border-muted-foreground/40"
                        )}>
                          {mergeTargetId === row.id && <div className="w-1.5 h-1.5 rounded-full bg-primary" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm">{row.label || "Unnamed Shift"}</span>
                            <span className="text-xs text-muted-foreground font-mono">
                              {row.startTime?.slice(0, 5)} - {row.endTime?.slice(0, 5)}
                            </span>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {row.assignments?.length || 0} assignment(s)
                          </span>
                        </div>
                        {mergeTargetId === row.id && (
                          <Badge variant="secondary" className="shrink-0">Keep</Badge>
                        )}
                        {mergeTargetId && mergeTargetId !== row.id && (
                          <Badge variant="outline" className="shrink-0 text-muted-foreground">Merge in</Badge>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {mergeTargetId && !mergePreview && (
                  <Button
                    onClick={handleMergePreview}
                    disabled={mergePreviewLoading}
                    className="w-full"
                    data-testid="button-merge-preview"
                  >
                    {mergePreviewLoading ? "Checking for conflicts..." : "Preview Merge"}
                  </Button>
                )}

                {mergePreview && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <Card className="p-2">
                        <div className="text-muted-foreground text-xs">Will move</div>
                        <div className="font-medium">{mergePreview.willMove} assignment(s)</div>
                      </Card>
                      <Card className="p-2">
                        <div className="text-muted-foreground text-xs">Conflicts</div>
                        <div className={cn("font-medium", mergePreview.conflicts.length > 0 && "text-orange-600")}>{mergePreview.conflicts.length}</div>
                      </Card>
                    </div>

                    {mergePreview.conflicts.length > 0 && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label className="text-sm font-medium text-orange-600">Resolve Conflicts:</Label>
                          <div className="flex gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                const map = new Map<string, "keep_target" | "keep_source">();
                                mergePreview.conflicts.forEach((c: any) => map.set(c.sourceAssignment.id, "keep_target"));
                                setMergeConflictResolutions(map);
                              }}
                              data-testid="button-keep-all-target"
                            >
                              Keep all target
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                const map = new Map<string, "keep_target" | "keep_source">();
                                mergePreview.conflicts.forEach((c: any) => map.set(c.sourceAssignment.id, "keep_source"));
                                setMergeConflictResolutions(map);
                              }}
                              data-testid="button-keep-all-source"
                            >
                              Keep all source
                            </Button>
                          </div>
                        </div>
                        <div className="max-h-48 overflow-y-auto space-y-1.5 border rounded-md p-2">
                          {mergePreview.conflicts.map((conflict: any, idx: number) => {
                            const empName = conflict.sourceAssignment.employee?.nickname 
                              || conflict.sourceAssignment.employee?.fullName 
                              || conflict.employeeId?.slice(0, 8) || "Unknown";
                            const resolution = mergeConflictResolutions.get(conflict.sourceAssignment.id) || "keep_target";
                            return (
                              <div key={idx} className="flex items-center justify-between gap-2 p-1.5 bg-muted/50 rounded text-xs">
                                <div className="min-w-0">
                                  <span className="font-medium">{empName}</span>
                                  <span className="text-muted-foreground ml-1">{conflict.date}</span>
                                </div>
                                <div className="flex gap-1 shrink-0">
                                  <Button
                                    size="sm"
                                    variant={resolution === "keep_target" ? "default" : "outline"}
                                    className="h-6 text-xs px-2"
                                    onClick={() => {
                                      setMergeConflictResolutions(prev => {
                                        const next = new Map(prev);
                                        next.set(conflict.sourceAssignment.id, "keep_target");
                                        return next;
                                      });
                                    }}
                                    data-testid={`conflict-keep-target-${idx}`}
                                  >
                                    Keep target
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant={resolution === "keep_source" ? "default" : "outline"}
                                    className="h-6 text-xs px-2"
                                    onClick={() => {
                                      setMergeConflictResolutions(prev => {
                                        const next = new Map(prev);
                                        next.set(conflict.sourceAssignment.id, "keep_source");
                                        return next;
                                      });
                                    }}
                                    data-testid={`conflict-keep-source-${idx}`}
                                  >
                                    Keep source
                                  </Button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <DialogFooter className="flex gap-2">
                      <Button variant="outline" onClick={() => setMergeDialogOpen(false)}>Cancel</Button>
                      <Button
                        onClick={handleMergeExecute}
                        disabled={mergeExecuting}
                        data-testid="button-merge-execute"
                      >
                        {mergeExecuting ? "Merging..." : `Merge ${mergeSelectedIds.size - 1} row(s) into target`}
                      </Button>
                    </DialogFooter>
                  </div>
                )}
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

    </div>
  );
}

function ScheduleHistoryDialog({ open, onOpenChange, branchId, onRestored }: { 
  open: boolean; onOpenChange: (v: boolean) => void; branchId?: string; onRestored: () => void;
}) {
  const { toast } = useToast();
  const [restoreEntry, setRestoreEntry] = useState<any | null>(null);

  const auditLogQuery = useQuery<any[]>({
    queryKey: ["/api/schedule/audit-log", { branchId }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (branchId) params.append("branchId", branchId);
      const res = await fetch(`/api/schedule/audit-log?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: open,
  });

  const restoreMutation = useMutation({
    mutationFn: async (auditId: string) => {
      const res = await apiRequest("POST", `/api/schedule/audit-log/${auditId}/restore`);
      return res.json();
    },
    onSuccess: (data) => {
      const parts = [
        data.shiftRows > 0 ? `${data.shiftRows} shifts` : null,
        data.assignments > 0 ? `${data.assignments} assignments` : null,
        data.breaks > 0 ? `${data.breaks} breaks` : null,
      ].filter(Boolean).join(", ");
      toast({ title: "Schedule restored", description: `Restored ${parts || "the previous state"}.` });
      setRestoreEntry(null);
      onRestored();
      auditLogQuery.refetch();
    },
    onError: (err: Error) => {
      toast({ title: "Restore failed", description: err.message, variant: "destructive" });
    },
  });

  const actionLabels: Record<string, string> = {
    apply_template: "Template Applied",
    apply_template_safe: "Template Applied (Safe)",
    clear_week: "Week Cleared",
    overwrite_department: "Department Overwritten",
    restore_from_snapshot: "Restored from Snapshot",
  };

  const formatWeekRange = (weekStartDate: string | null) => {
    if (!weekStartDate) return null;
    const ws = new Date(weekStartDate + "T00:00:00");
    const we = addDays(ws, 6);
    return `${format(ws, "d MMM")}–${format(we, "d MMM yyyy")}`;
  };

  const formatSummary = (summaryData: any) => {
    if (!summaryData) return null;
    const parts = [
      summaryData.shiftRows != null ? `${summaryData.shiftRows} shifts` : null,
      summaryData.assignments != null ? `${summaryData.assignments} assignments` : null,
      summaryData.breaks != null ? `${summaryData.breaks} breaks` : null,
    ].filter(Boolean);
    return parts.join(" · ");
  };

  const buildRestoreButtonLabel = (summaryData: any) => {
    if (!summaryData) return "Restore";
    const parts = [
      summaryData.assignments != null ? `${summaryData.assignments} assignments` : null,
      summaryData.breaks != null ? `${summaryData.breaks} breaks` : null,
    ].filter(Boolean);
    return parts.length > 0 ? `Restore ${parts.join(", ")}` : "Restore";
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Schedule History</DialogTitle>
            <DialogDescription>
              View recent schedule changes and restore previous versions.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {auditLogQuery.isLoading && (
              <div className="space-y-2">
                {[1,2,3].map(i => <Skeleton key={i} className="h-16 w-full" />)}
              </div>
            )}
            {auditLogQuery.data?.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">No schedule changes recorded yet. Future changes will appear here.</p>
            )}
            {auditLogQuery.data?.map((entry: any) => (
              <Card key={entry.id} className="p-3">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={entry.action === "clear_week" ? "destructive" : entry.action === "restore_from_snapshot" ? "default" : "secondary"}>
                        {actionLabels[entry.action] || entry.action}
                      </Badge>
                      {entry.branch && (
                        <span className="text-xs font-medium">{entry.branch.name}</span>
                      )}
                      {entry.department && (
                        <span className="text-xs text-muted-foreground">· {entry.department.name}</span>
                      )}
                      {entry.weekStartDate && (
                        <span className="text-xs text-muted-foreground">· {formatWeekRange(entry.weekStartDate)}</span>
                      )}
                    </div>
                    {entry.summaryData && (
                      <p className="text-xs text-muted-foreground">{formatSummary(entry.summaryData)}</p>
                    )}
                    {!entry.summaryData && entry.description && (
                      <p className="text-xs text-muted-foreground truncate">{entry.description}</p>
                    )}
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{entry.performedByUser?.fullName || entry.performedByUser?.username || "Unknown"}</span>
                      <span>·</span>
                      <span>{format(new Date(entry.createdAt), "MMM d, yyyy h:mm a")}</span>
                    </div>
                  </div>
                  {entry.hasSnapshot && entry.action !== "restore_from_snapshot" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setRestoreEntry(entry)}
                      data-testid={`button-restore-${entry.id}`}
                    >
                      <RotateCcw className="h-3 w-3 mr-1" />
                      Restore
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Restore confirmation dialog */}
      <Dialog open={!!restoreEntry} onOpenChange={(v) => { if (!v) setRestoreEntry(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm Restore</DialogTitle>
            <DialogDescription>
              {restoreEntry && (() => {
                const action = actionLabels[restoreEntry.action] || restoreEntry.action;
                const deptName = restoreEntry.department?.name;
                const weekRange = formatWeekRange(restoreEntry.weekStartDate);
                const branchName = restoreEntry.branch?.name;
                const performer = restoreEntry.performedByUser?.fullName || restoreEntry.performedByUser?.username || "Unknown";
                const timestamp = format(new Date(restoreEntry.createdAt), "d MMM yyyy 'at' h:mm a");
                const summary = restoreEntry.summaryData;

                return (
                  <span>
                    Restore
                    {deptName && <> <strong>{deptName}</strong></>}
                    {weekRange && <> schedule for <strong>{weekRange}</strong></>}
                    {branchName && <> at <strong>{branchName}</strong></>}
                    {" "}to the state before <strong>"{action}"</strong> on {timestamp} by {performer}?
                    {summary && (
                      <>
                        {" "}This will recover{" "}
                        <strong>
                          {[
                            summary.assignments != null ? `${summary.assignments} assignments` : null,
                            summary.breaks != null ? `${summary.breaks} breaks` : null,
                          ].filter(Boolean).join(", ")}
                        </strong>.{" "}
                      </>
                    )}
                    {" "}Current assignments in this scope will be replaced.
                  </span>
                );
              })()}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRestoreEntry(null)} data-testid="button-restore-cancel">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => restoreEntry && restoreMutation.mutate(restoreEntry.id)}
              disabled={restoreMutation.isPending}
              data-testid={restoreEntry ? `button-restore-confirm-${restoreEntry.id}` : "button-restore-confirm"}
            >
              {restoreMutation.isPending ? "Restoring..." : buildRestoreButtonLabel(restoreEntry?.summaryData)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function SchedulingPage() {
  return (
    <CopyModeProvider>
      <SchedulingPageInner />
    </CopyModeProvider>
  );
}
