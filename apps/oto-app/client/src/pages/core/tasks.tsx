import { useState, useRef, useMemo, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
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
import { Loader2, Eye, Check, LayoutGrid, ListTodo, BarChart3, Activity, CalendarClock, Repeat } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { DatePicker } from "@/components/ui/date-picker";
import { 
  Clock, 
  Calendar,
  CheckCircle,
  Circle,
  Camera,
  MessageSquare,
  ChevronRight,
  Plus,
  Filter,
  Users,
  User,
  Briefcase,
  Building2,
  AlertCircle,
  AlertTriangle,
  Siren,
  Trash2,
  MapPin,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useBranchContext } from "@/hooks/use-branch-context";
import { Link } from "wouter";
import { format, parseISO, isToday, isPast, isBefore, startOfDay, subDays, formatDistanceToNow } from "date-fns";
import TaskBoard, { type BoardTask } from "@/components/core/TaskBoard";
import TaskFiltersPanel, { type TaskFilters } from "@/components/core/TaskFiltersPanel";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

const WEEKDAYS = [
  { id: "mon", label: "Mon" },
  { id: "tue", label: "Tue" },
  { id: "wed", label: "Wed" },
  { id: "thu", label: "Thu" },
  { id: "fri", label: "Fri" },
  { id: "sat", label: "Sat" },
  { id: "sun", label: "Sun" },
];

const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

function formatActivityTime(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return "yesterday";
    if (diffDays < 7) return `${diffDays}d ago`;
    return format(date, "d MMM");
  } catch {
    return "";
  }
}

interface Branch {
  id: string;
  name: string;
}

interface Task {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  priority: string;
  dueDate?: string | null;
  dueTime?: string | null;
  dueAt?: string | null;
  startAt?: string | null;
  startDate?: string | null;
  scheduledMode?: boolean;
  progressPercent?: number;
  statusManualOverride?: boolean;
  blockedReason?: string | null;
  completedAt?: string | null;
  branchId?: string | null;
  branchName?: string | null;
  requiresPhotoEvidence?: boolean;
  requiresResponses?: boolean;
  assignedTo?: string | null;
  assignedEmployeeId?: string | null;
  assignedRoleId?: string | null;
  assignedDepartmentId?: string | null;
  assignedUserEmail?: string | null;
  assignedUserName?: string | null;
  assignedRoleName?: string | null;
  assignedDepartmentName?: string | null;
  assignedUser?: {
    id: string;
    fullName?: string | null;
    email: string;
  } | null;
  assignee?: {
    type: "user" | "employee" | "role" | "department" | "unassigned";
    id: string | null;
    name: string | null;
    label: string;
  } | null;
  isMine?: boolean | null;
}

interface TaskCardProps {
  task: Task;
  onComplete: (id: string) => void;
  onOpenDetail: (task: Task) => void;
  roles?: { id: string; name: string }[];
  departments?: { id: string; name: string }[];
}

function TaskCard({ task, onComplete, onOpenDetail, roles = [], departments = [] }: TaskCardProps) {
  const taskDate = task.dueDate ? parseISO(task.dueDate) : task.dueAt ? parseISO(task.dueAt) : null;
  const startDateObj = task.startDate ? parseISO(task.startDate) : task.startAt ? parseISO(task.startAt) : null;
  const taskIsToday = taskDate ? isToday(taskDate) : false;
  const isCompleted = task.status === "completed" || !!task.completion;
  const isBlocked = task.status === "blocked";
  const progressPercent = task.progressPercent ?? 0;
  const isScheduledMode = task.scheduledMode ?? false;
  
  // Calculate overdue: either past day, or same day but past due time
  const isOverdue = !isCompleted && taskDate && (() => {
    const now = new Date();
    const today = startOfDay(now);
    
    // If task date is before today, it's overdue
    if (isBefore(taskDate, today)) return true;
    
    // If task is today and has a due time, check if time has passed
    if (isToday(taskDate) && task.dueTime) {
      const [hours, minutes] = task.dueTime.split(':').map(Number);
      const dueDateTime = new Date();
      dueDateTime.setHours(hours, minutes, 0, 0);
      return now > dueDateTime;
    }
    
    return false;
  })();

  // Calculate urgency label using Bangkok timezone
  const getUrgencyLabel = () => {
    if (!taskDate || isCompleted) return null;
    
    // Get current date in Bangkok timezone
    const nowBangkok = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
    const todayBangkok = startOfDay(nowBangkok);
    
    // Get task due date in Bangkok timezone
    const taskDateBangkok = new Date(taskDate.toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
    const dueDayBangkok = startOfDay(taskDateBangkok);
    
    const diffTime = dueDayBangkok.getTime() - todayBangkok.getTime();
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays < 0) {
      return { text: `${Math.abs(diffDays)} day${Math.abs(diffDays) !== 1 ? 's' : ''}`, isOverdue: true };
    } else if (diffDays === 0) {
      return { text: "Today", isOverdue: false };
    } else {
      return { text: `${diffDays} day${diffDays !== 1 ? 's' : ''}`, isOverdue: false };
    }
  };
  
  const urgency = getUrgencyLabel();
  
  const getAssignmentInfo = () => {
    const assignments = (task as any).assignments as Array<{ assignmentType: string; label: string }> | undefined;
    if (assignments && assignments.length > 0) {
      const label = assignments.length === 1 ? assignments[0].label : assignments.map(x => x.label).join(", ");
      if (assignments.length === 1) {
        const t = assignments[0].assignmentType;
        if (t === "employee" || t === "advisor") return { icon: User, label, type: "employee" };
        if (t === "role") return { icon: Briefcase, label, type: "role" };
        if (t === "department") return { icon: Building2, label, type: "department" };
        if (t === "branch") return { icon: MapPin, label, type: "branch" };
      }
      return { icon: Users, label, type: "multiple" };
    }
    if (task.assignee) {
      switch (task.assignee.type) {
        case "employee":
        case "user":
          return { icon: User, label: task.assignee.label, type: "employee" };
        case "role":
          return { icon: Briefcase, label: task.assignee.label, type: "role" };
        case "department":
          return { icon: Building2, label: task.assignee.label, type: "department" };
        case "unassigned":
        default:
          return { icon: Users, label: "Everyone", type: "everyone" };
      }
    }
    if (task.assignedUserName || task.assignedTo) {
      return { icon: User, label: task.assignedUserName || "Assigned", type: "employee" };
    }
    if (task.assignedRoleName) {
      return { icon: Briefcase, label: task.assignedRoleName, type: "role" };
    }
    if (task.assignedDepartmentName) {
      return { icon: Building2, label: task.assignedDepartmentName, type: "department" };
    }
    return { icon: Users, label: "Everyone", type: "everyone" };
  };
  
  const assignment = getAssignmentInfo();
  const AssignmentIcon = assignment.icon;
  
  // Check for stagnant (3+ days without movement) - task or API might set this
  const isStagnant = (task as any).isStagnant || (task.lastMovementAt && (() => {
    const lastMoved = new Date((task as any).lastMovementAt);
    const now = new Date();
    const diffDays = (now.getTime() - lastMoved.getTime()) / (1000 * 60 * 60 * 24);
    return diffDays >= 3 && task.status !== "completed";
  })());
  
  // Check for escalated
  const isEscalated = (task as any).escalated === true;
  
  const getStatusBadge = () => {
    if (isBlocked) return <Badge className="bg-orange-500 text-white text-xs">Blocked</Badge>;
    if (isCompleted) return <Badge className="bg-green-600 text-white text-xs">Done</Badge>;
    if (isOverdue) return <Badge variant="destructive" className="text-xs">Overdue</Badge>;
    if (progressPercent > 0) return <Badge className="bg-blue-500 text-white text-xs">{progressPercent}%</Badge>;
    return null;
  };

  return (
    <Card 
      className={`hover-elevate active-elevate-2 overflow-visible ${isCompleted ? "opacity-60" : ""} ${isOverdue ? "border-red-400/50 border" : ""} ${isBlocked ? "border-orange-400/50 border" : ""}`}
      data-testid={`card-task-${task.id}`}
    >
      <CardContent className="p-3">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 flex items-center justify-center shrink-0 relative">
            {isCompleted ? (
              <CheckCircle className="h-5 w-5 text-green-600" />
            ) : isBlocked ? (
              <AlertCircle className="h-5 w-5 text-orange-500" />
            ) : isOverdue ? (
              <AlertCircle className="h-5 w-5 text-red-500" />
            ) : (
              <Circle className="h-5 w-5 text-muted-foreground" />
            )}
            {/* Signal badges positioned at bottom-right */}
            {(isStagnant || isEscalated) && !isCompleted && (
              <div className="absolute -bottom-1 -right-1 flex gap-0.5">
                {isStagnant && (
                  <span className="w-4 h-4 bg-amber-500 rounded-full flex items-center justify-center" title="Stagnant (no activity 3+ days)">
                    <AlertTriangle className="w-2.5 h-2.5 text-white" />
                  </span>
                )}
                {isEscalated && (
                  <span className="w-4 h-4 bg-red-600 rounded-full flex items-center justify-center" title="Escalated">
                    <Siren className="w-2.5 h-2.5 text-white" />
                  </span>
                )}
              </div>
            )}
          </div>
          <div onClick={() => onOpenDetail(task)} className="flex-1 min-w-0 cursor-pointer">
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className={`font-medium text-sm ${isCompleted ? "line-through text-muted-foreground" : ""}`}>{task.title}</h4>
              {getStatusBadge()}
              <Badge variant="outline" className="text-xs">{task.priority}</Badge>
            </div>
            <div className="flex items-center gap-2 text-xs flex-wrap mt-1 text-muted-foreground">
              {isScheduledMode && startDateObj && taskDate ? (
                <span className="flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  {format(startDateObj, "d MMM")} → {format(taskDate, "d MMM")}
                </span>
              ) : taskDate ? (
                <span className="flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  {format(taskDate, "d MMM")}
                  {task.dueTime && ` at ${task.dueTime}`}
                </span>
              ) : null}
              {urgency && (
                <span className={`flex items-center gap-1 ${urgency.isOverdue ? "text-red-500 font-medium" : urgency.text === "Due today" ? "text-amber-500 font-medium" : ""}`}>
                  <Clock className="h-3 w-3" />
                  {urgency.text}
                </span>
              )}
              <span className="flex items-center gap-1">
                <AssignmentIcon className="h-3 w-3" />
                <span>{assignment.label}</span>
              </span>
              {task.requiresPhotoEvidence && (
                <Badge variant="outline" className="text-xs">
                  <Camera className="h-2.5 w-2.5 mr-0.5" />
                  Photo
                </Badge>
              )}
            </div>
            {isScheduledMode && startDateObj && taskDate && (
              (() => {
                const todayDate = new Date();
                todayDate.setHours(0, 0, 0, 0);
                const startDay = new Date(startDateObj);
                startDay.setHours(0, 0, 0, 0);
                const dueDay = new Date(taskDate);
                dueDay.setHours(0, 0, 0, 0);
                const totalDays = Math.max(1, Math.ceil((dueDay.getTime() - startDay.getTime()) / (1000 * 60 * 60 * 24)) + 1);
                const elapsedDays = Math.max(0, Math.ceil((todayDate.getTime() - startDay.getTime()) / (1000 * 60 * 60 * 24)) + 1);
                const expectedPercent = Math.min(100, Math.max(0, (elapsedDays / totalDays) * 100));
                return (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="relative flex-1 h-1.5 bg-muted rounded-full">
                      <div 
                        className="absolute top-0 left-0 h-full bg-primary rounded-full"
                        style={{ width: `${progressPercent}%` }}
                      />
                      {expectedPercent > 0 && expectedPercent < 100 && (
                        <div
                          className="absolute top-[-2px] bottom-[-2px] w-0.5 bg-red-500"
                          style={{ left: `${expectedPercent}%`, transform: 'translateX(-50%)' }}
                        />
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground w-8 text-right">{progressPercent}%</span>
                  </div>
                );
              })()
            )}
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        </div>
      </CardContent>
    </Card>
  );
}

interface Role {
  id: string;
  name: string;
}

interface Department {
  id: string;
  name: string;
}

// Simplified view mode: Board (default), List, or Scheduled
type ViewMode = "board" | "list" | "scheduled";

export default function TasksPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const { activeBranchId, branches } = useBranchContext();
  
  // Default view based on screen size: list on mobile, board on desktop
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window !== "undefined") {
      return window.innerWidth < 768 ? "list" : "board";
    }
    return "board";
  });
  
  // Role-based access: line staff only see their tasks
  const isManagerOrAbove = user?.role && ['admin', 'global_admin', 'operator_admin', 'manager'].includes(user.role);
  const isLineStaff = !isManagerOrAbove;
  
  // For line staff, always filter to their tasks only
  const [showMyOnly, setShowMyOnly] = useState(!isManagerOrAbove);
  
  // Load saved filters from localStorage - scoped by user
  const FILTERS_STORAGE_KEY = `oto_task_filters_${user?.id || "anon"}`;
  const getDefaultFilters = (): TaskFilters => ({
    showStagnant: false,
    showEscalated: false,
    showArchived: false,
    hideRecurring: false,
    taskScope: "all",
    taskLevels: [],
    branchId: "all",
    departmentId: "all",
    roleId: "all",
    assigneeId: "all",
    priority: "all",
  });
  
  // Simplified filters with localStorage persistence
  const [boardFilters, setBoardFilters] = useState<TaskFilters>(getDefaultFilters);
  const [filtersLoaded, setFiltersLoaded] = useState(false);
  
  // Load saved filters on mount (client-side only)
  useEffect(() => {
    if (typeof window === "undefined" || !user?.id) return;
    try {
      const saved = localStorage.getItem(FILTERS_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        setBoardFilters({ ...getDefaultFilters(), ...parsed });
      }
    } catch (e) {
      console.warn("Failed to load saved task filters:", e);
    }
    setFiltersLoaded(true);
  }, [user?.id]);
  
  // Save filters to localStorage when they change (after initial load)
  useEffect(() => {
    if (typeof window === "undefined" || !filtersLoaded || !user?.id) return;
    try {
      localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(boardFilters));
    } catch (e) {
      console.warn("Failed to save task filters:", e);
    }
  }, [boardFilters, filtersLoaded, user?.id]);
  
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [formData, setFormData] = useState({
    title: "",
    description: "",
    branchIds: [] as string[],
    recurrence: "once" as "once" | "daily" | "weekly" | "monthly",
    weeklyDays: [] as string[],
    monthlyDay: null as number | null,
    preferredDueTime: "09:00",
    scheduledMode: false,
    startDate: "",
    dueDate: "",
    requiresPhotoEvidence: false,
    requiresResponses: false,
    assignmentType: "everyone" as "everyone" | "specific_employee" | "advisor" | "by_role" | "by_department",
    assignedTo: "",
    assignedAdvisorId: "",
    assignedRoleId: "",
    assignedDepartmentId: "",
    questions: [] as { prompt: string; questionType: "text" | "number" | "boolean" | "multiple_choice"; options?: string[]; isRequired: boolean }[],
  });
  
  // Task detail modal state
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [loadingTask, setLoadingTask] = useState(false);
  const [localProgress, setLocalProgress] = useState(0);
  const [activityDrawerOpen, setActivityDrawerOpen] = useState(false);
  
  // For line staff, force My Tasks Only always on
  useEffect(() => {
    if (isLineStaff) {
      setShowMyOnly(true);
    }
  }, [isLineStaff]);

  const { data: roles = [] } = useQuery<Role[]>({
    queryKey: ["/api/roles"],
  });

  const { data: departments = [] } = useQuery<Department[]>({
    queryKey: ["/api/departments"],
  });

  const { data: employees = [] } = useQuery<{ id: string; firstName: string; lastName: string; nickname?: string | null; fullName?: string; userId?: string; primaryDepartmentId?: string | null; branchId?: string | null }[]>({
    queryKey: ["/api/employees"],
  });

  const { data: advisors = [] } = useQuery<{ id: string; fullName: string; preferredName: string | null; email: string }[]>({
    queryKey: ["/api/people", { personType: "ADVISOR" }],
    queryFn: async () => {
      const res = await fetch("/api/people?personType=ADVISOR");
      if (!res.ok) return [];
      return res.json();
    },
  });

  // For line staff, always force myOnly regardless of state
  const effectiveMyOnly = isLineStaff || showMyOnly;
  
  // Build query params for simplified task API - uses global branch selector
  const taskParams = new URLSearchParams();
  if (activeBranchId) {
    taskParams.append("branchId", activeBranchId);
  }
  if (effectiveMyOnly) taskParams.append("myOnly", "true");
  if (boardFilters.showArchived) taskParams.append("showArchived", "true");
  if (boardFilters.showEscalated) taskParams.append("showEscalated", "true");
  if (boardFilters.showStagnant) taskParams.append("showStagnant", "true");
  if (boardFilters.hideRecurring) taskParams.append("hideRecurring", "true");
  if (boardFilters.taskScope !== "all") taskParams.append("taskScope", boardFilters.taskScope);
  if (boardFilters.taskLevels.length > 0) {
    taskParams.append("taskLevel", boardFilters.taskLevels[0]);
  }
  const tasksUrl = `/api/core/tasks?${taskParams.toString()}`;

  const { data: tasks = [], isLoading: tasksLoading } = useQuery<Task[]>({
    queryKey: ["/api/core/tasks", { 
      branchId: activeBranchId, 
      myOnly: effectiveMyOnly,
      showArchived: boardFilters.showArchived,
      showEscalated: boardFilters.showEscalated,
      showStagnant: boardFilters.showStagnant,
      hideRecurring: boardFilters.hideRecurring,
      taskScope: boardFilters.taskScope,
      taskLevel: boardFilters.taskLevels[0] || null,
    }],
    queryFn: async () => {
      const res = await fetch(tasksUrl, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch tasks");
      return res.json();
    },
    enabled: !!user,
  });

  // Build activity query params - uses global branch selector
  const activityParams = new URLSearchParams();
  if (activeBranchId) {
    activityParams.append("branchId", activeBranchId);
  }
  activityParams.append("limit", "30");
  const activitiesUrl = `/api/core/tasks/activities/recent?${activityParams.toString()}`;

  const { data: recentActivities = [] } = useQuery<{
    id: string;
    taskId: string;
    branchId: string | null;
    activityType: string;
    description: string;
    userId: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: string;
    taskTitle: string | null;
    taskStatus: string | null;
    userName: string | null;
    employeeNickname: string | null;
  }[]>({
    queryKey: ["/api/core/tasks/activities", { branchId: activeBranchId }],
    queryFn: async () => {
      const res = await fetch(activitiesUrl, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch activities");
      return res.json();
    },
    enabled: !!user && isManagerOrAbove,
    refetchInterval: 30000,
  });

  const resetFormData = () => {
    setFormData({
      title: "",
      description: "",
      branchIds: [],
      recurrence: "once",
      weeklyDays: [],
      monthlyDay: null,
      preferredDueTime: "09:00",
      scheduledMode: false,
      startDate: "",
      dueDate: "",
      requiresPhotoEvidence: false,
      requiresResponses: false,
      assignmentType: "everyone",
      assignedTo: "",
      assignedAdvisorId: "",
      assignedRoleId: "",
      assignedDepartmentId: "",
      questions: [],
    });
  };

  const createMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      const payload: Record<string, unknown> = {
        title: data.title,
        description: data.description || undefined,
        recurrence: data.recurrence,
        weeklyDays: data.weeklyDays,
        monthlyDay: data.monthlyDay,
        scheduledMode: data.scheduledMode,
        requiresPhotoEvidence: data.requiresPhotoEvidence,
        requiresResponses: data.requiresResponses,
      };

      const effectiveBranchIds = data.branchIds.length > 0 ? data.branchIds : (activeBranchId ? [activeBranchId] : []);
      if (effectiveBranchIds.length > 1) {
        payload.branchIds = effectiveBranchIds;
      } else if (effectiveBranchIds.length === 1) {
        payload.branchId = effectiveBranchIds[0];
      }

      if (data.recurrence === "once" && data.dueDate) {
        payload.dueAt = `${data.dueDate}T${data.preferredDueTime || '09:00'}:00`;
        if (data.scheduledMode && data.startDate) {
          payload.startAt = `${data.startDate}T00:00:00`;
        }
      } else if (data.recurrence !== "once") {
        payload.preferredDueTime = data.preferredDueTime;
      }

      if (data.assignmentType === "specific_employee" && data.assignedTo) {
        payload.assignedTo = data.assignedTo;
      } else if (data.assignmentType === "advisor" && data.assignedAdvisorId) {
        payload.assignedTo = data.assignedAdvisorId;
      } else if (data.assignmentType === "by_role" && data.assignedRoleId) {
        payload.assignedRoleId = data.assignedRoleId;
      } else if (data.assignmentType === "by_department" && data.assignedDepartmentId) {
        payload.assignedDepartmentId = data.assignedDepartmentId;
      }

      if (data.questions.length > 0) {
        payload.questions = data.questions;
      }
      
      return apiRequest("POST", "/api/core/tasks", payload);
    },
    onSuccess: () => {
      toast({ title: "Task created" });
      setIsCreateOpen(false);
      resetFormData();
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks/multi-day"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks/activities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks/scheduled"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const completeMutation = useMutation({
    mutationFn: async (taskId: string) => {
      return apiRequest("POST", `/api/core/tasks/${taskId}/complete`, {});
    },
    onSuccess: () => {
      toast({ title: "Task completed" });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks/multi-day"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks/activities"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const scheduledTasksQuery = useQuery<{
    id: string;
    title: string;
    description: string | null;
    branchId: string | null;
    branchName: string | null;
    recurrence: string;
    weeklyDays: string[];
    monthlyDay: number | null;
    preferredDueTime: string | null;
    requiresPhotoEvidence: boolean;
    requiresResponses: boolean;
    status: string;
    createdAt: string;
    questions: { id: string; prompt: string; questionType: string; options: string[] | null; isRequired: boolean }[];
  }[]>({
    queryKey: ["/api/core/tasks/scheduled"],
    enabled: viewMode === "scheduled" && isManagerOrAbove,
  });

  const deleteScheduledMutation = useMutation({
    mutationFn: async (taskId: string) => {
      return apiRequest("DELETE", `/api/core/tasks/scheduled/${taskId}`);
    },
    onSuccess: () => {
      toast({ title: "Scheduled task deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks/scheduled"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
    },
  });

  const handleComplete = (taskId: string) => {
    completeMutation.mutate(taskId);
  };
  
  const openTaskDetail = (task: Task) => {
    setLocation(`/core/tasks/${task.id}`);
  };
  
  const closeTaskModal = () => {
    setTaskModalOpen(false);
    setSelectedTask(null);
  };

  const handleCreate = () => {
    if (!formData.title.trim()) {
      toast({ title: "Title is required", variant: "destructive" });
      return;
    }
    if (formData.recurrence === "weekly" && formData.weeklyDays.length === 0) {
      toast({ title: "Please select at least one day", variant: "destructive" });
      return;
    }
    if (formData.recurrence === "monthly" && !formData.monthlyDay) {
      toast({ title: "Please select which day of the month", variant: "destructive" });
      return;
    }
    if (formData.recurrence === "once" && !formData.dueDate) {
      toast({ title: "Due date is required for one-off tasks", variant: "destructive" });
      return;
    }
    if (formData.recurrence === "once" && formData.scheduledMode && !formData.startDate) {
      toast({ title: "Start date is required for scheduled tasks", variant: "destructive" });
      return;
    }
    if (formData.recurrence === "once" && formData.scheduledMode && formData.startDate > formData.dueDate) {
      toast({ title: "Start date must be before or equal to due date", variant: "destructive" });
      return;
    }
    if (formData.assignmentType === "specific_employee" && !formData.assignedTo) {
      toast({ title: "Please select an employee", variant: "destructive" });
      return;
    }
    if (formData.assignmentType === "advisor" && !formData.assignedAdvisorId) {
      toast({ title: "Please select an advisor", variant: "destructive" });
      return;
    }
    if (formData.assignmentType === "by_role" && !formData.assignedRoleId) {
      toast({ title: "Please select a role", variant: "destructive" });
      return;
    }
    if (formData.assignmentType === "by_department" && !formData.assignedDepartmentId) {
      toast({ title: "Please select a department", variant: "destructive" });
      return;
    }
    createMutation.mutate(formData);
  };

  const toggleBranch = (branchId: string) => {
    if (formData.branchIds.includes(branchId)) {
      setFormData({ ...formData, branchIds: formData.branchIds.filter(id => id !== branchId), assignedTo: "" });
    } else {
      setFormData({ ...formData, branchIds: [...formData.branchIds, branchId], assignedTo: "" });
    }
  };

  const toggleWeeklyDay = (day: string) => {
    if (formData.weeklyDays.includes(day)) {
      setFormData({ ...formData, weeklyDays: formData.weeklyDays.filter(d => d !== day) });
    } else {
      setFormData({ ...formData, weeklyDays: [...formData.weeklyDays, day] });
    }
  };

  const addQuestion = () => {
    setFormData({
      ...formData,
      questions: [...formData.questions, { prompt: "", questionType: "text", isRequired: true }],
    });
  };

  const updateQuestion = (index: number, updates: Partial<typeof formData.questions[0]>) => {
    const newQuestions = [...formData.questions];
    newQuestions[index] = { ...newQuestions[index], ...updates };
    setFormData({ ...formData, questions: newQuestions });
  };

  const removeQuestion = (index: number) => {
    setFormData({ ...formData, questions: formData.questions.filter((_, i) => i !== index) });
  };

  const filteredEmployees = formData.branchIds.length === 1
    ? employees.filter(emp => emp.branchId === formData.branchIds[0])
    : employees;

  const isLoading = tasksLoading;

  const searchFilteredTasks = useMemo(() => {
    if (!boardFilters.searchQuery || !boardFilters.searchQuery.trim()) return tasks;
    const q = boardFilters.searchQuery.trim().toLowerCase();
    return tasks.filter(t => {
      if (t.title.toLowerCase().includes(q)) return true;
      if (t.description && t.description.toLowerCase().includes(q)) return true;
      if ((t as any).assignedUserFullName?.toLowerCase().includes(q)) return true;
      if ((t as any).assignedEmployeeNickname?.toLowerCase().includes(q)) return true;
      if ((t as any).assignedEmployeeFullName?.toLowerCase().includes(q)) return true;
      if (t.assignedUserName?.toLowerCase().includes(q)) return true;
      if (t.assignedRoleName?.toLowerCase().includes(q)) return true;
      if (t.assignedDepartmentName?.toLowerCase().includes(q)) return true;
      if (t.assignee?.label?.toLowerCase().includes(q)) return true;
      const assigns = (t as any).assignments as Array<{ label: string }> | undefined;
      if (assigns && assigns.some(a => a.label?.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [tasks, boardFilters.searchQuery]);

  const pendingTasks = useMemo(() => searchFilteredTasks.filter(t => t.status !== "completed"), [searchFilteredTasks]);
  const completedTasks = useMemo(() => searchFilteredTasks.filter(t => t.status === "completed"), [searchFilteredTasks]);

  const filteredBoardTasks = useMemo(() => {
    let filtered = tasks as BoardTask[];
    if (boardFilters.showStagnant) {
      filtered = filtered.filter(t => (t as any).isStagnant);
    }
    if (boardFilters.showEscalated) {
      filtered = filtered.filter(t => t.escalated);
    }
    if (boardFilters.taskLevels.length > 0) {
      filtered = filtered.filter(t => {
        const role = (t as any).assignedUserRole || t.taskLevel;
        return role ? boardFilters.taskLevels.includes(role as any) : false;
      });
    }
    if (boardFilters.priority !== "all") {
      filtered = filtered.filter(t => t.priority === boardFilters.priority);
    }
    if (boardFilters.departmentId !== "all") {
      filtered = filtered.filter(t => t.assignedDepartmentId === boardFilters.departmentId || (t as any).assignedEmployeeDepartmentId === boardFilters.departmentId);
    }
    if (boardFilters.roleId !== "all") {
      filtered = filtered.filter(t => t.assignedRoleId === boardFilters.roleId);
    }
    if (boardFilters.assigneeId !== "all") {
      filtered = filtered.filter(t => {
        if (t.assignedTo === boardFilters.assigneeId || t.assignedEmployeeId === boardFilters.assigneeId) return true;
        const assigns = (t as any).assignments as Array<{ assignmentType: string; assignmentId: string }> | undefined;
        if (assigns) {
          return assigns.some(a => a.assignmentId === boardFilters.assigneeId);
        }
        return false;
      });
    }
    if (boardFilters.searchQuery && boardFilters.searchQuery.trim()) {
      const q = boardFilters.searchQuery.trim().toLowerCase();
      filtered = filtered.filter(t => {
        if (t.title.toLowerCase().includes(q)) return true;
        if (t.description && t.description.toLowerCase().includes(q)) return true;
        if ((t as any).assignedUserFullName?.toLowerCase().includes(q)) return true;
        if ((t as any).assignedEmployeeNickname?.toLowerCase().includes(q)) return true;
        if ((t as any).assignedEmployeeFullName?.toLowerCase().includes(q)) return true;
        if ((t as any).assignedAdvisorNickname?.toLowerCase().includes(q)) return true;
        if ((t as any).assignedAdvisorFullName?.toLowerCase().includes(q)) return true;
        if (t.assignedUserName?.toLowerCase().includes(q)) return true;
        if (t.assignedRoleName?.toLowerCase().includes(q)) return true;
        if (t.assignedDepartmentName?.toLowerCase().includes(q)) return true;
        if (t.assignee?.label?.toLowerCase().includes(q)) return true;
        const assigns = (t as any).assignments as Array<{ label: string }> | undefined;
        if (assigns) {
          if (assigns.some(a => a.label?.toLowerCase().includes(q))) return true;
        }
        return false;
      });
    }
    return filtered;
  }, [tasks, boardFilters]);

  const handleStatusChange = async (taskId: string, newStatus: string) => {
    try {
      if (newStatus === "completed") {
        await apiRequest("POST", `/api/core/tasks/${taskId}/complete`, {});
      } else if (newStatus === "blocked") {
        await apiRequest("POST", `/api/core/tasks/${taskId}/block`, { blockedReason: "Blocked from board" });
      } else {
        await apiRequest("PATCH", `/api/core/tasks/${taskId}`, { status: newStatus });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks/multi-day"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks/activities"] });
      toast({ title: "Task updated" });
    } catch (err: any) {
      toast({ title: "Failed to update task", description: err.message, variant: "destructive" });
    }
  };

  if (isLoading && tasks.length === 0) {
    return (
      <div className="flex items-center justify-center h-full min-h-[200px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      <div className="p-4">
        {/* Top Bar - single row with all controls */}
        <div className="flex items-center justify-between gap-2 sticky top-0 z-20 bg-background py-2 mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Board/List Toggle */}
            <div className="flex items-center p-0.5 bg-muted rounded-md">
              <Button
                variant={viewMode === "board" ? "default" : "ghost"}
                size="icon"
                onClick={() => setViewMode("board")}
                data-testid="btn-view-board"
              >
                <LayoutGrid className="h-4 w-4" />
              </Button>
              <Button
                variant={viewMode === "list" ? "default" : "ghost"}
                size="icon"
                onClick={() => setViewMode("list")}
                data-testid="btn-view-list"
              >
                <ListTodo className="h-4 w-4" />
              </Button>
              {isManagerOrAbove && (
                <Button
                  variant={viewMode === "scheduled" ? "default" : "ghost"}
                  size="icon"
                  onClick={() => setViewMode("scheduled")}
                  data-testid="btn-view-scheduled"
                >
                  <CalendarClock className="h-4 w-4" />
                </Button>
              )}
            </div>
            
            {/* My tasks only toggle - only for managers/admin, hidden in scheduled view */}
            {isManagerOrAbove && viewMode !== "scheduled" && (
              <div className="flex items-center gap-1.5">
                <Switch
                  id="my-tasks-only"
                  checked={showMyOnly}
                  onCheckedChange={setShowMyOnly}
                  data-testid="switch-my-tasks-only"
                />
                <Label htmlFor="my-tasks-only" className="text-sm whitespace-nowrap">
                  My tasks
                </Label>
              </div>
            )}

            {/* Filters - only for managers/admin, hidden in scheduled view */}
            {isManagerOrAbove && viewMode !== "scheduled" && (
              <TaskFiltersPanel
                filters={boardFilters}
                onFiltersChange={setBoardFilters}
                branches={branches}
                departments={departments}
                roles={roles}
                employees={employees.map(e => ({ id: e.id, fullName: e.fullName, nickname: e.nickname, displayName: e.nickname || e.fullName }))}
                showBranchFilter={false}
                showTaskLevelFilter={true}
                showStagnantFilter={true}
                showEscalatedFilter={true}
                showArchivedFilter={true}
              />
            )}
          </div>
          
          <div className="flex items-center gap-2">
            {isManagerOrAbove && (
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden relative"
                onClick={() => setActivityDrawerOpen(true)}
                data-testid="button-recent-updates"
              >
                <Activity className="h-4 w-4" />
                {recentActivities.length > 0 && (
                  <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-primary" />
                )}
              </Button>
            )}
            <Button 
              size="icon" 
              className="rounded-full" 
              onClick={() => setIsCreateOpen(true)} 
              data-testid="button-create-adhoc-task"
            >
              <Plus className="h-5 w-5" />
            </Button>
          </div>
        </div>

        <div className="flex gap-4">
          <div className="flex-1 min-w-0">
            {/* Board View (Primary) */}
            {viewMode === "board" && (
              <TaskBoard
                tasks={filteredBoardTasks}
                isLoading={tasksLoading}
                onTaskClick={openTaskDetail}
                onStatusChange={handleStatusChange}
                roles={roles}
                departments={departments}
                showStagnantHighlight={boardFilters.showStagnant}
              />
            )}

            {/* List View (Secondary) */}
            {viewMode === "list" && (
              <div className="space-y-2">
                {filteredBoardTasks.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    No tasks found
                  </div>
                ) : (
                  filteredBoardTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onComplete={handleComplete}
                      onOpenDetail={openTaskDetail}
                      roles={roles}
                      departments={departments}
                    />
                  ))
                )}
              </div>
            )}

            {/* Scheduled / Recurring Definitions View */}
            {viewMode === "scheduled" && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 mb-4">
                  <Repeat className="h-5 w-5 text-muted-foreground" />
                  <h2 className="text-lg font-semibold">Recurring Task Definitions</h2>
                </div>

                {scheduledTasksQuery.isLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : !scheduledTasksQuery.data?.length ? (
                  <Card>
                    <CardContent className="py-12 text-center text-muted-foreground">
                      <CalendarClock className="h-10 w-10 mx-auto mb-3 opacity-40" />
                      <p className="text-sm">No recurring tasks defined yet.</p>
                      <p className="text-xs mt-1">Create a task with Daily, Weekly, or Monthly recurrence to see it here.</p>
                    </CardContent>
                  </Card>
                ) : (
                  scheduledTasksQuery.data.map((st) => (
                    <Card key={st.id} data-testid={`scheduled-task-${st.id}`}>
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium text-sm" data-testid={`text-scheduled-title-${st.id}`}>{st.title}</span>
                              <Badge variant="secondary" className="text-xs capitalize">
                                {st.recurrence}
                              </Badge>
                            </div>
                            {st.description && (
                              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{st.description}</p>
                            )}
                            <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground flex-wrap">
                              {st.preferredDueTime && (
                                <span className="flex items-center gap-1">
                                  <Clock className="h-3 w-3" />
                                  Due by {st.preferredDueTime}
                                </span>
                              )}
                              {st.recurrence === "weekly" && st.weeklyDays?.length > 0 && (
                                <span>
                                  {st.weeklyDays.map(d => d.charAt(0).toUpperCase() + d.slice(1, 3)).join(", ")}
                                </span>
                              )}
                              {st.recurrence === "monthly" && st.monthlyDay && (
                                <span>Day {st.monthlyDay} of month</span>
                              )}
                              {st.requiresPhotoEvidence && (
                                <span className="flex items-center gap-1">
                                  <Camera className="h-3 w-3" />
                                  Photo required
                                </span>
                              )}
                              {st.questions?.length > 0 && (
                                <span className="flex items-center gap-1">
                                  <MessageSquare className="h-3 w-3" />
                                  {st.questions.length} question{st.questions.length !== 1 ? "s" : ""}
                                </span>
                              )}
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              if (confirm("Delete this recurring task definition? Future instances will no longer be generated.")) {
                                deleteScheduledMutation.mutate(st.id);
                              }
                            }}
                            data-testid={`btn-delete-scheduled-${st.id}`}
                          >
                            <Trash2 className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Recent Updates Panel - visible on lg+ screens for managers */}
          {isManagerOrAbove && (
            <div className="hidden lg:block w-[280px] shrink-0">
              <div className="sticky top-12">
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Activity className="h-4 w-4 text-muted-foreground" />
                      <h3 className="text-sm font-semibold">Recent Updates</h3>
                    </div>
                    {recentActivities.length === 0 ? (
                      <p className="text-xs text-muted-foreground py-4 text-center">
                        No recent activity
                      </p>
                    ) : (
                      <div className="space-y-0">
                        {recentActivities.map((activity) => (
                          <button
                            key={activity.id}
                            className="w-full text-left py-2 border-b last:border-b-0 border-border/50 hover-elevate rounded-sm px-1 -mx-1 cursor-pointer"
                            onClick={() => {
                              const matchingTask = tasks.find(t => t.id === activity.taskId);
                              if (matchingTask) {
                                openTaskDetail(matchingTask);
                              }
                            }}
                            data-testid={`activity-item-${activity.id}`}
                          >
                            <p className="text-xs leading-snug">
                              {activity.employeeNickname && activity.userName
                                ? activity.description.replace(activity.userName, activity.employeeNickname)
                                : activity.description}
                            </p>
                            {activity.metadata?.taskTitle && (
                              <p className="text-xs text-muted-foreground truncate mt-0.5">
                                {activity.metadata.taskTitle as string}
                              </p>
                            )}
                            <div className="flex items-center justify-between mt-1">
                              <span className="text-[10px] text-muted-foreground truncate max-w-[140px]">
                                {activity.employeeNickname || activity.userName || "System"}
                              </span>
                              <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                                {formatActivityTime(activity.createdAt)}
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
          )}
        </div>

      </div>

      <Dialog open={isCreateOpen} onOpenChange={(open) => { if (!open) { setIsCreateOpen(false); resetFormData(); } else { setIsCreateOpen(true); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Task</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4 max-h-[60vh] overflow-y-auto">
            <div className="space-y-2">
              <Label htmlFor="title">Title *</Label>
              <Input
                id="title"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder="Complete inventory count"
                data-testid="input-task-title"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Count all items in storage and update the system"
                data-testid="input-task-description"
              />
            </div>

            <div className="space-y-2">
              <Label>Recurrence</Label>
              <Select
                value={formData.recurrence}
                onValueChange={(v) => {
                  const rec = v as "once" | "daily" | "weekly" | "monthly";
                  setFormData({ 
                    ...formData, 
                    recurrence: rec, 
                    weeklyDays: rec === "weekly" ? formData.weeklyDays : [] 
                  });
                }}
              >
                <SelectTrigger data-testid="select-recurrence">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="once">One-off (single occurrence)</SelectItem>
                  <SelectItem value="daily">Daily (every day)</SelectItem>
                  <SelectItem value="weekly">Weekly (selected days)</SelectItem>
                  <SelectItem value="monthly">Monthly (selected day)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {formData.recurrence === "once" && (
              <>
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Scheduled task (multi-day)</Label>
                    <p className="text-xs text-muted-foreground">
                      {formData.scheduledMode 
                        ? "Task appears from start date until completed"
                        : "One-off task appears only on due date"}
                    </p>
                  </div>
                  <Switch
                    checked={formData.scheduledMode}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        const today = new Date().toISOString().split('T')[0];
                        const startDate = formData.dueDate && today > formData.dueDate 
                          ? formData.dueDate 
                          : today;
                        setFormData({ ...formData, scheduledMode: true, startDate });
                      } else {
                        setFormData({ ...formData, scheduledMode: false, startDate: "" });
                      }
                    }}
                    data-testid="switch-scheduled-mode"
                  />
                </div>
                
                {formData.scheduledMode ? (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Start Date *</Label>
                      <DatePicker
                        value={formData.startDate}
                        onChange={(date) => setFormData({ ...formData, startDate: date })}
                        placeholder="Pick a date"
                        data-testid="input-start-date"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Due Date *</Label>
                      <DatePicker
                        value={formData.dueDate}
                        onChange={(date) => setFormData({ ...formData, dueDate: date })}
                        placeholder="Pick a date"
                        data-testid="input-due-date"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label>Due Date *</Label>
                    <DatePicker
                      value={formData.dueDate}
                      onChange={(date) => setFormData({ ...formData, dueDate: date })}
                      placeholder="Pick a date"
                      data-testid="input-due-date"
                    />
                    <p className="text-xs text-muted-foreground">
                      One-off task: will appear on the due date only.
                    </p>
                  </div>
                )}
              </>
            )}

            {formData.recurrence === "weekly" && (
              <div className="space-y-2">
                <Label>Days of Week *</Label>
                <div className="flex flex-wrap gap-2">
                  {WEEKDAYS.map((day) => (
                    <label
                      key={day.id}
                      className={`flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer border transition-colors ${
                        formData.weeklyDays.includes(day.id)
                          ? "bg-primary text-primary-foreground border-primary"
                          : "border-border hover-elevate"
                      }`}
                    >
                      <Checkbox
                        checked={formData.weeklyDays.includes(day.id)}
                        onCheckedChange={() => toggleWeeklyDay(day.id)}
                        className="sr-only"
                      />
                      <span className="text-sm font-medium">{day.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {formData.recurrence === "monthly" && (
              <div className="space-y-2">
                <Label>Day of Month *</Label>
                <Select
                  value={formData.monthlyDay?.toString() || ""}
                  onValueChange={(v) => setFormData({ ...formData, monthlyDay: parseInt(v, 10) })}
                >
                  <SelectTrigger data-testid="select-monthly-day">
                    <SelectValue placeholder="Select day" />
                  </SelectTrigger>
                  <SelectContent>
                    {MONTH_DAYS.map((day) => (
                      <SelectItem key={day} value={day.toString()}>
                        {day}{day === 31 ? " (or last day)" : day >= 29 ? " (overflow: 1st of next month)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  If the selected day doesn't exist in a month (e.g., 30th in February), the task will appear on the 1st of the next month.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="dueTime">Due Time</Label>
              <Input
                id="dueTime"
                type="time"
                value={formData.preferredDueTime}
                onChange={(e) => setFormData({ ...formData, preferredDueTime: e.target.value })}
                data-testid="input-due-time"
              />
            </div>

            <div className="space-y-2">
              <Label>Branches</Label>
              <div className="border rounded-md p-3 space-y-2 max-h-40 overflow-y-auto">
                {branches.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No branches available</p>
                ) : (
                  branches.map((branch) => (
                    <label
                      key={branch.id}
                      className="flex items-center gap-2 cursor-pointer hover-elevate p-1 rounded"
                    >
                      <Checkbox
                        checked={formData.branchIds.includes(branch.id)}
                        onCheckedChange={() => toggleBranch(branch.id)}
                        data-testid={`checkbox-branch-${branch.id}`}
                      />
                      <span className="text-sm">{branch.name}</span>
                    </label>
                  ))
                )}
              </div>
              {formData.branchIds.length === 0 && (
                <p className="text-xs text-muted-foreground">No branches selected = uses current branch</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Assign To</Label>
              <Select
                value={formData.assignmentType}
                onValueChange={(v) => {
                  const at = v as "everyone" | "specific_employee" | "advisor" | "by_role" | "by_department";
                  setFormData({ 
                    ...formData, 
                    assignmentType: at,
                    assignedTo: "",
                    assignedAdvisorId: "",
                    assignedRoleId: "",
                    assignedDepartmentId: "",
                  });
                }}
              >
                <SelectTrigger data-testid="select-assignment-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="everyone">
                    <div className="flex items-center gap-2">
                      <Users className="h-4 w-4" />
                      <span>Everyone</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="specific_employee">
                    <div className="flex items-center gap-2">
                      <User className="h-4 w-4" />
                      <span>Specific Employee</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="advisor">
                    <div className="flex items-center gap-2">
                      <User className="h-4 w-4" />
                      <span>Advisor</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="by_role">
                    <div className="flex items-center gap-2">
                      <Briefcase className="h-4 w-4" />
                      <span>By Role</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="by_department">
                    <div className="flex items-center gap-2">
                      <Building2 className="h-4 w-4" />
                      <span>By Department</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {formData.assignmentType === "specific_employee" && (
              <div className="space-y-2">
                <Label>Employee *</Label>
                {formData.branchIds.length === 1 && (
                  <p className="text-xs text-muted-foreground">
                    Showing employees from: {branches.find(b => b.id === formData.branchIds[0])?.name}
                  </p>
                )}
                <Select
                  value={formData.assignedTo}
                  onValueChange={(v) => setFormData({ ...formData, assignedTo: v })}
                >
                  <SelectTrigger data-testid="select-employee">
                    <SelectValue placeholder="Select employee" />
                  </SelectTrigger>
                  <SelectContent>
                    {filteredEmployees.filter(e => e.userId).length === 0 ? (
                      <div className="py-2 px-2 text-sm text-muted-foreground">No employees found</div>
                    ) : (
                      filteredEmployees.filter(e => e.userId).map((emp) => (
                        <SelectItem key={emp.id} value={emp.userId!}>
                          {emp.nickname || emp.fullName || `${emp.firstName} ${emp.lastName}`}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
            )}

            {formData.assignmentType === "advisor" && (
              <div className="space-y-2">
                <Label>Advisor *</Label>
                <Select
                  value={formData.assignedAdvisorId}
                  onValueChange={(v) => setFormData({ ...formData, assignedAdvisorId: v })}
                >
                  <SelectTrigger data-testid="select-advisor">
                    <SelectValue placeholder="Select advisor" />
                  </SelectTrigger>
                  <SelectContent>
                    {advisors.length === 0 ? (
                      <div className="py-2 px-2 text-sm text-muted-foreground">No advisors found</div>
                    ) : (
                      advisors.map((adv) => (
                        <SelectItem key={adv.id} value={adv.id}>
                          {adv.preferredName || adv.fullName}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
            )}

            {formData.assignmentType === "by_role" && (
              <div className="space-y-2">
                <Label>Role *</Label>
                <Select
                  value={formData.assignedRoleId}
                  onValueChange={(v) => setFormData({ ...formData, assignedRoleId: v })}
                >
                  <SelectTrigger data-testid="select-role">
                    <SelectValue placeholder="Select role" />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((role) => (
                      <SelectItem key={role.id} value={role.id}>
                        {role.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {formData.assignmentType === "by_department" && (
              <div className="space-y-2">
                <Label>Department *</Label>
                <Select
                  value={formData.assignedDepartmentId}
                  onValueChange={(v) => setFormData({ ...formData, assignedDepartmentId: v })}
                >
                  <SelectTrigger data-testid="select-department">
                    <SelectValue placeholder="Select department" />
                  </SelectTrigger>
                  <SelectContent>
                    {departments.map((dept) => (
                      <SelectItem key={dept.id} value={dept.id}>
                        {dept.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex items-center justify-between">
              <Label htmlFor="requiresPhoto">Requires Photo Evidence</Label>
              <Switch
                id="requiresPhoto"
                checked={formData.requiresPhotoEvidence}
                onCheckedChange={(v) => setFormData({ ...formData, requiresPhotoEvidence: v })}
                data-testid="switch-requires-photo"
              />
            </div>

            <div className="flex items-center justify-between">
              <Label htmlFor="requiresResponses">Requires Responses</Label>
              <Switch
                id="requiresResponses"
                checked={formData.requiresResponses}
                onCheckedChange={(v) => {
                  setFormData({ 
                    ...formData, 
                    requiresResponses: v,
                    questions: v && formData.questions.length === 0 
                      ? [{ prompt: "", questionType: "text", isRequired: true }] 
                      : formData.questions
                  });
                }}
                data-testid="switch-requires-responses"
              />
            </div>

            {formData.requiresResponses && (
              <div className="space-y-3 border rounded-md p-3 bg-muted/30">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <Label className="text-sm font-medium">Questions</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addQuestion}
                    data-testid="button-add-question"
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Add Question
                  </Button>
                </div>
                
                {formData.questions.map((question, index) => (
                  <div key={index} className="space-y-2 p-3 border rounded-md bg-background">
                    <div className="flex items-start gap-2">
                      <div className="flex-1 space-y-2">
                        <Input
                          value={question.prompt}
                          onChange={(e) => updateQuestion(index, { prompt: e.target.value })}
                          placeholder="Enter your question..."
                          data-testid={`input-question-${index}`}
                        />
                        <div className="flex gap-2 flex-wrap">
                          <Select
                            value={question.questionType}
                            onValueChange={(v) => updateQuestion(index, { 
                              questionType: v as "text" | "number" | "boolean" | "multiple_choice",
                              options: v === "multiple_choice" ? [""] : undefined
                            })}
                          >
                            <SelectTrigger className="w-40" data-testid={`select-question-type-${index}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="text">Text</SelectItem>
                              <SelectItem value="number">Number</SelectItem>
                              <SelectItem value="boolean">Yes/No</SelectItem>
                              <SelectItem value="multiple_choice">Multiple Choice</SelectItem>
                            </SelectContent>
                          </Select>
                          <label className="flex items-center gap-2 text-sm">
                            <Checkbox
                              checked={question.isRequired}
                              onCheckedChange={(v) => updateQuestion(index, { isRequired: !!v })}
                            />
                            Required
                          </label>
                        </div>
                        {question.questionType === "multiple_choice" && (
                          <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">Options (one per line)</Label>
                            <Textarea
                              value={(question.options || []).join("\n")}
                              onChange={(e) => updateQuestion(index, { 
                                options: e.target.value.split("\n").filter(o => o.trim())
                              })}
                              placeholder={"Option 1\nOption 2\nOption 3"}
                              className="text-sm"
                              rows={3}
                            />
                          </div>
                        )}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeQuestion(index)}
                        className="shrink-0"
                        data-testid={`button-remove-question-${index}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
                
                {formData.questions.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-2">
                    No questions added yet
                  </p>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-4 border-t">
              <Button variant="outline" onClick={() => { setIsCreateOpen(false); resetFormData(); }}>
                Cancel
              </Button>
              <Button 
                onClick={handleCreate}
                disabled={createMutation.isPending}
                data-testid="button-submit-task"
              >
                {createMutation.isPending && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                Create
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Task Detail Modal */}
      <Dialog open={taskModalOpen} onOpenChange={(open) => !open && closeTaskModal()}>
        <DialogContent className="max-w-md max-h-[85vh] flex flex-col p-0">
          <DialogHeader className="px-6 pt-6 pb-2 shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <Eye className="h-5 w-5" />
              Task Details
            </DialogTitle>
            <DialogDescription className="sr-only">
              View task details and update progress
            </DialogDescription>
          </DialogHeader>
          
          {selectedTask && (
            <div className="flex flex-col flex-1 min-h-0">
              <div className="flex-1 overflow-y-auto px-6 pb-4">
                <div className="space-y-4">
                  <div>
                    <h3 className="font-semibold text-lg">{selectedTask.title}</h3>
                    {selectedTask.description && (
                      <p className="text-sm text-muted-foreground mt-1">{selectedTask.description}</p>
                    )}
                    <div className="flex items-center gap-3 mt-2 text-sm text-muted-foreground flex-wrap">
                      {selectedTask.dueAt && (
                        <div className="flex items-center gap-1">
                          <Calendar className="h-3.5 w-3.5" />
                          <span>{format(parseISO(selectedTask.dueAt), "d MMM yyyy")}</span>
                        </div>
                      )}
                      {selectedTask.dueTime && (
                        <div className="flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5" />
                          <span>{selectedTask.dueTime}</span>
                        </div>
                      )}
                      <Badge variant="outline">{selectedTask.priority}</Badge>
                      <Badge variant={selectedTask.status === "completed" ? "default" : "secondary"}>{selectedTask.status}</Badge>
                    </div>
                    
                    {/* Progress slider for scheduled tasks */}
                    {selectedTask.scheduledMode && selectedTask.startAt && (() => {
                      const startAt = new Date(selectedTask.startAt);
                      const dueAt = selectedTask.dueAt ? new Date(selectedTask.dueAt) : new Date();
                      const todayDate = new Date();
                      todayDate.setHours(0, 0, 0, 0);
                      const startDay = new Date(startAt);
                      startDay.setHours(0, 0, 0, 0);
                      const dueDay = new Date(dueAt);
                      dueDay.setHours(0, 0, 0, 0);
                      
                      const totalDays = Math.max(1, Math.ceil((dueDay.getTime() - startDay.getTime()) / (1000 * 60 * 60 * 24)) + 1);
                      const elapsedDays = Math.max(0, Math.ceil((todayDate.getTime() - startDay.getTime()) / (1000 * 60 * 60 * 24)) + 1);
                      const expectedPercent = Math.min(100, Math.max(0, (elapsedDays / totalDays) * 100));
                      
                      return (
                        <div className="mt-4 space-y-2">
                          <div className="flex items-center justify-between text-sm">
                            <span className="font-medium">Progress</span>
                            <span className="text-muted-foreground">{localProgress}%</span>
                          </div>
                          <div className="relative w-full py-3 px-3">
                            <div className="relative h-3 rounded-full bg-muted">
                              <div 
                                className="absolute top-0 left-0 h-full bg-primary rounded-l-full"
                                style={{ 
                                  width: `${localProgress}%`,
                                  borderTopRightRadius: localProgress >= 100 ? '9999px' : '0',
                                  borderBottomRightRadius: localProgress >= 100 ? '9999px' : '0',
                                }}
                              />
                              {expectedPercent > 0 && expectedPercent < 100 && (
                                <div
                                  className="absolute top-[-4px] bottom-[-4px] w-0.5 bg-red-500"
                                  style={{ left: `${expectedPercent}%`, transform: 'translateX(-50%)' }}
                                />
                              )}
                            </div>
                            <div
                              className="absolute top-1/2 w-5 h-5 rounded-full bg-primary border-2 border-primary-foreground shadow-lg pointer-events-none"
                              style={{ 
                                left: `calc(${localProgress}% + ${12 - (localProgress / 100) * 24}px)`,
                                transform: 'translateY(-50%)',
                              }}
                            />
                            <input
                              type="range"
                              min="0"
                              max="100"
                              value={localProgress}
                              onChange={(e) => setLocalProgress(parseInt(e.target.value, 10))}
                              onMouseUp={async () => {
                                try {
                                  await apiRequest("PATCH", `/api/core/tasks/${selectedTask.id}/progress`, { progressPercent: localProgress });
                                  queryClient.invalidateQueries({ queryKey: ["/api/core/tasks/multi-day"] });
                                  toast({ title: "Progress updated" });
                                } catch (err) {
                                  toast({ title: "Failed to update progress", variant: "destructive" });
                                }
                              }}
                              onTouchEnd={async () => {
                                try {
                                  await apiRequest("PATCH", `/api/core/tasks/${selectedTask.id}/progress`, { progressPercent: localProgress });
                                  queryClient.invalidateQueries({ queryKey: ["/api/core/tasks/multi-day"] });
                                  toast({ title: "Progress updated" });
                                } catch (err) {
                                  toast({ title: "Failed to update progress", variant: "destructive" });
                                }
                              }}
                              className="absolute top-0 left-0 right-0 bottom-0 w-full h-full opacity-0 cursor-pointer"
                              data-testid="slider-task-progress-modal"
                            />
                          </div>
                          <div className="flex justify-between text-xs text-muted-foreground">
                            <span>{format(startAt, "d MMM")}</span>
                            <span>{format(dueAt, "d MMM")}</span>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>
              
              <div className="px-6 py-4 border-t shrink-0 flex justify-end gap-2">
                <Button variant="outline" onClick={closeTaskModal}>
                  Close
                </Button>
                {selectedTask.status !== "completed" && (
                  <Button onClick={() => { handleComplete(selectedTask.id); closeTaskModal(); }}>
                    <Check className="h-4 w-4 mr-1" />
                    Complete
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Recent Updates Dialog - mobile/tablet access for managers */}
      {isManagerOrAbove && (
        <Dialog open={activityDrawerOpen} onOpenChange={setActivityDrawerOpen}>
          <DialogContent className="max-w-md max-h-[80vh] flex flex-col p-0">
            <DialogHeader className="px-6 pt-6 pb-2 shrink-0">
              <DialogTitle className="flex items-center gap-2">
                <Activity className="h-5 w-5" />
                Recent Updates
              </DialogTitle>
              <DialogDescription className="sr-only">
                Recent task activity and updates
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto px-6 pb-6">
              {recentActivities.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  No recent activity
                </p>
              ) : (
                <div className="space-y-0">
                  {recentActivities.map((activity) => (
                    <button
                      key={activity.id}
                      className="w-full text-left py-3 border-b last:border-b-0 border-border/50 hover-elevate rounded-sm px-2 -mx-2 cursor-pointer"
                      onClick={() => {
                        setActivityDrawerOpen(false);
                        const matchingTask = tasks.find(t => t.id === activity.taskId);
                        if (matchingTask) {
                          openTaskDetail(matchingTask);
                        }
                      }}
                      data-testid={`mobile-activity-item-${activity.id}`}
                    >
                      <p className="text-sm leading-snug">
                        {activity.employeeNickname && activity.userName
                          ? activity.description.replace(activity.userName, activity.employeeNickname)
                          : activity.description}
                      </p>
                      {activity.metadata?.taskTitle && (
                        <p className="text-xs text-muted-foreground truncate mt-0.5">
                          {activity.metadata.taskTitle as string}
                        </p>
                      )}
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                          {activity.employeeNickname || activity.userName || "System"}
                        </span>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {formatActivityTime(activity.createdAt)}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
