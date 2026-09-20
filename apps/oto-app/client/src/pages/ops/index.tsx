import { useState, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { KanbanBoard, type KanbanColumnDef } from "@/components/kanban";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Calendar } from "@/components/ui/calendar";
import { format } from "date-fns";
import { OpsLayout } from "@/components/layout/ops-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { 
  Plus, 
  ListTodo,
  ClipboardList,
  RotateCcw,
  Clock,
  User,
  Users,
  Briefcase,
  Building2,
  Camera,
  MessageSquare,
  CalendarDays,
  Pause,
  Play,
  Trash2,
  Loader2,
  KanbanSquare,
  ChevronLeft,
  ChevronRight,
  Activity,
  Megaphone,
  Pencil,
  Eye,
  EyeOff,
  X,
  MapPin,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useBranchContext } from "@/hooks/use-branch-context";
import { useAuth } from "@/hooks/use-auth";
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
import { useLocation } from "wouter";
import { CreateTaskDialog } from "@/components/create-task-dialog";
import { CreateChecklistDialog } from "@/components/create-checklist-dialog";
import TaskFiltersPanel, { type TaskFilters } from "@/components/core/TaskFiltersPanel";
import { TaskDetailSheet } from "@/components/ops/TaskDetailSheet";
import { ChecklistRunSheet } from "@/components/ops/ChecklistRunSheet";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type OpsTab = "tasks" | "checklists" | "recurring" | "announcements";

interface ScheduledTask {
  id: string;
  title: string;
  description?: string | null;
  branchId?: string | null;
  branchName?: string | null;
  recurrence: "once" | "daily" | "weekly" | "monthly";
  weeklyDays?: string[];
  monthlyDay?: number | null;
  preferredDueTime?: string | null;
  dueAt?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  startAt?: string | null;
  startDate?: string | null;
  scheduledMode?: boolean;
  requiresPhotoEvidence: boolean;
  requiresResponses: boolean;
  isRecurringDefinition?: boolean;
  status: string;
  createdAt: string;
  assignedTo?: string | null;
  assignedEmployeeId?: string | null;
  assignedRoleId?: string | null;
  assignedDepartmentId?: string | null;
  assignedUserName?: string | null;
  priority?: string | null;
  isOverdue?: boolean;
  isStagnant?: boolean;
  isArchived?: boolean;
  escalated?: boolean;
  progressPercent?: number;
  taskLevel?: string | null;
  assignedUserRole?: string | null;
  assignedEmployeeRoleIds?: string | null;
  assignedEmployeeDepartmentId?: string | null;
  createdBy?: string | null;
  assignments?: Array<{ assignmentType: string; assignmentId: string; resolvedName?: string }>;
}

interface AnnouncementData {
  id: string;
  title: string;
  body: string;
  priority: "info" | "warning" | "urgent";
  startDate: string;
  endDate: string;
  branchIds: string[] | null;
  departmentIds: string[] | null;
  showToEveryone: boolean;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  creatorDisplay?: string;
}

interface ChecklistTemplate {
  id: string;
  name: string;
  description: string | null;
  branchId: string | null;
  branchIds?: string[] | null;
  departmentId: string | null;
  assignedDepartmentId: string | null;
  recurrence: string | null;
  scheduledTime: string | null;
  assignedEmployeeId: string | null;
  assignedRoleId: string | null;
  isActive: boolean;
  createdAt: string;
  assignedUserRole?: string | null;
  assignedEmployeeDepartmentId?: string | null;
  assignedEmployeeRoleIds?: string | null;
}

interface ChecklistRunInstance {
  id: string;
  templateId: string;
  templateName: string;
  checklistType: string;
  branchId: string;
  branchName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  assignedTo: string | null;
  assignedUserName: string | null;
  assignedEmployeeId: string | null;
  assignedRoleId: string | null;
  assignedDepartmentId: string | null;
  assignedUserRole?: string | null;
  assignedEmployeeDepartmentId?: string | null;
  assignedEmployeeRoleIds?: string | null;
  status: string | null;
  dueAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  notes: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  missedAt?: string | null;
  responsibleStaff?: Array<{
    employeeId?: string | null;
    userId?: string | null;
    name: string;
    roleName?: string | null;
  }>;
  itemsTotal: number;
  itemsCompleted: number;
  itemsFailed: number;
}

interface Branch {
  id: string;
  name: string;
}

interface Role {
  id: string;
  name: string;
}

interface Department {
  id: string;
  name: string;
}

interface Employee {
  id: string;
  fullName: string;
  nickname?: string | null;
  branchId?: string | null;
}

const WEEKDAYS = [
  { id: "mon", label: "Mon" },
  { id: "tue", label: "Tue" },
  { id: "wed", label: "Wed" },
  { id: "thu", label: "Thu" },
  { id: "fri", label: "Fri" },
  { id: "sat", label: "Sat" },
  { id: "sun", label: "Sun" },
];

export default function OpsPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const { selectedBranchId } = useBranchContext();
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState<OpsTab>("tasks");
  const [tasksViewMode, setTasksViewMode] = useState<"list" | "kanban" | "calendar">("kanban");
  const [checklistsViewMode, setChecklistsViewMode] = useState<"dashboard" | "templates" | "history">("dashboard");
  const [showMyOnly, setShowMyOnly] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [showCreateTaskDialog, setShowCreateTaskDialog] = useState(false);
  const [showCreateChecklistDialog, setShowCreateChecklistDialog] = useState(false);
  const [taskFilters, setTaskFilters] = useState<TaskFilters>({
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
    searchQuery: "",
  });
  const [deleteTarget, setDeleteTarget] = useState<{ type: "task" | "checklist"; id: string; name: string } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false);
  const [overrideTarget, setOverrideTarget] = useState<{ id: string; name: string; currentStatus: string; newStatus: string } | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("taskId") || null;
  });
  const [selectedChecklistRunId, setSelectedChecklistRunId] = useState<string | null>(null);

  useEffect(() => {
    const handleEmbeddedDetailClose = (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.data?.type === "checklist-detail-close") {
        setSelectedChecklistRunId(null);
      }
    };
    window.addEventListener("message", handleEmbeddedDetailClose);
    return () => window.removeEventListener("message", handleEmbeddedDetailClose);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("taskId")) {
      params.delete("taskId");
      const newUrl = params.toString() ? `${window.location.pathname}?${params}` : window.location.pathname;
      window.history.replaceState({}, "", newUrl);
    }
  }, []);
  const [showCreateAnnouncement, setShowCreateAnnouncement] = useState(false);
  const [announcementForm, setAnnouncementForm] = useState({
    title: "",
    body: "",
    priority: "info" as "info" | "warning" | "urgent",
    startDate: new Date(),
    endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    branchIds: [] as string[],
    departmentIds: [] as string[],
    showToEveryone: true,
  });
  const [editingAnnouncementId, setEditingAnnouncementId] = useState<string | null>(null);
  const [mobileUpdatesOpen, setMobileUpdatesOpen] = useState(false);
  const [mobileUpdatesType, setMobileUpdatesType] = useState<"tasks" | "checklists">("tasks");
  const [showQuickTask, setShowQuickTask] = useState(false);
  const [quickTaskForm, setQuickTaskForm] = useState({
    title: "",
    description: "",
    scheduled: false,
    startAt: "",
    dueAt: "",
  });

  const coreTaskParams = new URLSearchParams();
  if (selectedBranchId) coreTaskParams.append("branchId", selectedBranchId);
  
  const { data: coreTasks = [], isLoading: coreTasksLoading } = useQuery<ScheduledTask[]>({
    queryKey: ["/api/core/tasks", { branchId: selectedBranchId }],
    queryFn: async () => {
      const res = await fetch(`/api/core/tasks?${coreTaskParams.toString()}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: scheduledTasks = [], isLoading: scheduledTasksLoading } = useQuery<ScheduledTask[]>({
    queryKey: ["/api/studio/scheduled-tasks"],
  });

  const { data: checklistTemplates = [], isLoading: checklistsLoading } = useQuery<ChecklistTemplate[]>({
    queryKey: ["/api/checklists/templates"],
  });

  const checklistRunsParams = new URLSearchParams();
  if (selectedBranchId) checklistRunsParams.append("branchId", selectedBranchId);
  if (showArchived) checklistRunsParams.append("showArchived", "true");

  const { data: checklistRuns = [], isLoading: checklistRunsLoading } = useQuery<ChecklistRunInstance[]>({
    queryKey: ["/api/checklist-runs/ops", { branchId: selectedBranchId, showArchived }],
    queryFn: async () => {
      const res = await fetch(`/api/checklist-runs/ops?${checklistRunsParams.toString()}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  interface ChecklistHistoryData {
    missedGroups: Array<{
      key: string;
      templateId: string;
      templateName: string;
      recurrence: string | null;
      periodStart: string | null;
      periodEnd: string | null;
      count: number;
      runs: ChecklistRunInstance[];
    }>;
    completed: ChecklistRunInstance[];
  }

  const { data: checklistHistory, isLoading: checklistHistoryLoading } = useQuery<ChecklistHistoryData>({
    queryKey: ["/api/checklist-runs/history", { branchId: selectedBranchId }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (selectedBranchId) params.set("branchId", selectedBranchId);
      const res = await fetch(`/api/checklist-runs/history?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load checklist history");
      return res.json();
    },
    enabled: !!user?.role && ["admin", "global_admin", "operator_admin", "manager"].includes(user.role) && checklistsViewMode === "history",
  });

  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["/api/studio/branches"],
  });

  const { data: roles = [] } = useQuery<Role[]>({
    queryKey: ["/api/roles"],
  });

  const { data: departments = [] } = useQuery<Department[]>({
    queryKey: ["/api/departments"],
  });

  const { data: employees = [] } = useQuery<Employee[]>({
    queryKey: ["/api/employees"],
  });

  const { data: assignableUsers = [] } = useQuery<{ id: string; fullName: string; nickname: string | null; displayName: string; isEmployee: boolean; role: string }[]>({
    queryKey: ["/api/core/tasks/assignable-users"],
  });

  const { data: advisors = [] } = useQuery<{ id: string; fullName: string; preferredName?: string | null }[]>({
    queryKey: ["/api/people", "ADVISOR"],
    queryFn: async () => {
      const res = await fetch("/api/people?personType=ADVISOR", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: announcementsList = [], isLoading: announcementsLoading } = useQuery<AnnouncementData[]>({
    queryKey: ["/api/announcements"],
  });

  interface MyEmployeeInfo {
    linked: boolean;
    employeeId?: string;
    primaryDepartmentId?: string | null;
    branchId?: string | null;
    roles?: { id: string; name: string; isPrimary: boolean }[];
  }

  const { data: myEmployeeInfo } = useQuery<MyEmployeeInfo>({
    queryKey: ["/api/my-account/employee-info"],
  });

  const isManagerOrAbove = user?.role && ['admin', 'global_admin', 'operator_admin', 'manager'].includes(user.role);

  const activityParams = new URLSearchParams();
  if (selectedBranchId) activityParams.append("branchId", selectedBranchId);
  activityParams.append("limit", "30");

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
    queryKey: ["/api/core/tasks/activities", { branchId: selectedBranchId, source: "ops" }],
    queryFn: async () => {
      const res = await fetch(`/api/core/tasks/activities/recent?${activityParams.toString()}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!user && !!isManagerOrAbove,
  });

  const checklistActivityParams = new URLSearchParams();
  if (selectedBranchId) checklistActivityParams.append("branchId", selectedBranchId);
  checklistActivityParams.append("limit", "30");

  const { data: recentChecklistActivities = [] } = useQuery<{
    id: string;
    templateName: string | null;
    branchId: string | null;
    status: string | null;
    description: string;
    userName: string | null;
    employeeNickname: string | null;
    updatedAt: string;
  }[]>({
    queryKey: ["/api/checklist-runs/activities", { branchId: selectedBranchId }],
    queryFn: async () => {
      const res = await fetch(`/api/checklist-runs/activities/recent?${checklistActivityParams.toString()}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!user && !!isManagerOrAbove,
  });

  const deleteTaskMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/studio/scheduled-tasks/${id}`, undefined);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/studio/scheduled-tasks"] });
      toast({ title: "Task deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteChecklistMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/checklists/templates/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/checklists/templates"] });
      toast({ title: "Checklist deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const overrideStatusMutation = useMutation({
    mutationFn: async ({ id, newStatus }: { id: string; newStatus: string }) => {
      return apiRequest("POST", `/api/checklist-runs/${id}/override-status`, { newStatus });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/checklist-runs/ops"] });
      toast({ title: "Status updated" });
      setOverrideDialogOpen(false);
      setOverrideTarget(null);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updateTaskStatusMutation = useMutation({
    mutationFn: async ({ taskId, status, dueAt }: { taskId: string; status: string; dueAt?: string }) => {
      const payload: Record<string, unknown> = { status };
      if (dueAt !== undefined) payload.dueAt = dueAt;
      return apiRequest("PATCH", `/api/core/tasks/${taskId}`, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/studio/scheduled-tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks/activities"] });
      toast({ title: "Task status updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const directOverrideMutation = useMutation({
    mutationFn: async ({ id, newStatus }: { id: string; newStatus: string }) => {
      return apiRequest("POST", `/api/checklist-runs/${id}/override-status`, { newStatus });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/checklist-runs/ops"] });
      toast({ title: "Status updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const createAnnouncementMutation = useMutation({
    mutationFn: async (data: any) => {
      if (editingAnnouncementId) {
        return apiRequest("PATCH", `/api/announcements/${editingAnnouncementId}`, data);
      }
      return apiRequest("POST", "/api/announcements", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/announcements"] });
      setShowCreateAnnouncement(false);
      setEditingAnnouncementId(null);
      setAnnouncementForm({
        title: "", body: "", priority: "info",
        startDate: new Date(), endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        branchIds: [], departmentIds: [], showToEveryone: true,
      });
      toast({ title: editingAnnouncementId ? "Announcement updated" : "Announcement created" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const toggleAnnouncementMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      return apiRequest("PATCH", `/api/announcements/${id}`, { isActive });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/announcements"] });
    },
  });

  const deleteAnnouncementMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/announcements/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/announcements"] });
      toast({ title: "Announcement deleted" });
    },
  });

  const quickTaskMutation = useMutation({
    mutationFn: async (data: {
      title: string;
      description?: string;
      branchId: string;
      assignedTo: string;
      scheduledMode?: boolean;
      startAt?: string | null;
      dueAt?: string | null;
    }) => {
      return apiRequest("POST", "/api/core/tasks", {
        ...data,
        priority: "medium",
        recurrence: "once",
        requiresPhotoEvidence: false,
        requiresResponses: false,
        taskLevel: "line",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks/activities"] });
      setShowQuickTask(false);
      setQuickTaskForm({ title: "", description: "", scheduled: false, startAt: "", dueAt: "" });
      toast({ title: "Task created" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleQuickTaskSubmit = () => {
    if (!quickTaskForm.title.trim()) return;
    if (!selectedBranchId) {
      toast({ title: "No branch selected", description: "Please select a branch first", variant: "destructive" });
      return;
    }
    quickTaskMutation.mutate({
      title: quickTaskForm.title.trim(),
      description: quickTaskForm.description.trim() || undefined,
      branchId: selectedBranchId,
      assignedTo: user!.id,
      scheduledMode: quickTaskForm.scheduled,
      startAt: quickTaskForm.scheduled && quickTaskForm.startAt ? new Date(quickTaskForm.startAt).toISOString() : null,
      dueAt: quickTaskForm.dueAt ? new Date(quickTaskForm.dueAt).toISOString() : null,
    });
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    if (deleteTarget.type === "task") {
      deleteTaskMutation.mutate(deleteTarget.id);
    } else {
      deleteChecklistMutation.mutate(deleteTarget.id);
    }
    setDeleteDialogOpen(false);
    setDeleteTarget(null);
  };

  const getRecurrenceLabel = (task: ScheduledTask) => {
    if (task.recurrence === "once") return "One-off";
    if (task.recurrence === "weekly" && task.weeklyDays?.length > 0) {
      const dayLabels = task.weeklyDays.map(d => WEEKDAYS.find(wd => wd.id === d)?.label || d).join(", ");
      return `Weekly (${dayLabels})`;
    }
    if (task.recurrence === "monthly" && task.monthlyDay) {
      const suffix = task.monthlyDay === 1 ? "st" : task.monthlyDay === 2 ? "nd" : task.monthlyDay === 3 ? "rd" : "th";
      return `Monthly (${task.monthlyDay}${suffix})`;
    }
    return task.recurrence.charAt(0).toUpperCase() + task.recurrence.slice(1);
  };

  const getAssignmentLabel = (task: ScheduledTask) => {
    const a = (task as any).assignments as Array<{ assignmentType: string; label: string }> | undefined;
    if (a && a.length > 0) {
      if (a.length === 1) return a[0].label;
      return a.map(x => x.label).join(", ");
    }
    if (task.assignedUserName) return task.assignedUserName;
    if (task.assignedEmployeeId) {
      const emp = employees.find(e => e.id === task.assignedEmployeeId);
      return emp ? (emp.nickname || emp.fullName) : "Employee";
    }
    if (task.assignedTo) return "Advisor";
    if (task.assignedRoleId) {
      const role = roles.find(r => r.id === task.assignedRoleId);
      return role?.name || "Role";
    }
    if (task.assignedDepartmentId) {
      const dept = departments.find(d => d.id === task.assignedDepartmentId);
      return dept?.name || "Department";
    }
    return "Everyone";
  };

  const getAssignmentIcon = (task: ScheduledTask) => {
    const a = (task as any).assignments as Array<{ assignmentType: string }> | undefined;
    if (a && a.length > 0) {
      if (a.length === 1) {
        if (a[0].assignmentType === "employee" || a[0].assignmentType === "advisor") return User;
        if (a[0].assignmentType === "role") return Briefcase;
        if (a[0].assignmentType === "department") return Building2;
        if (a[0].assignmentType === "branch") return MapPin;
      }
      return Users;
    }
    if (task.assignedEmployeeId || task.assignedTo) return User;
    if (task.assignedRoleId) return Briefcase;
    if (task.assignedDepartmentId) return Building2;
    return Users;
  };

  const getBranchName = (branchId: string | null | undefined) => {
    if (!branchId) return null;
    return branches.find(b => b.id === branchId)?.name || null;
  };

  const isTaskMine = (task: ScheduledTask): boolean => {
    if (!user) return false;
    if (task.assignedTo === user.id) return true;
    if (myEmployeeInfo?.linked && myEmployeeInfo.employeeId) {
      if (task.assignedEmployeeId === myEmployeeInfo.employeeId) return true;
    }
    if (task.assignedRoleId && myEmployeeInfo?.roles?.length) {
      if (myEmployeeInfo.roles.some(r => r.id === task.assignedRoleId)) return true;
    }
    if (task.assignedDepartmentId && myEmployeeInfo?.primaryDepartmentId) {
      if (task.assignedDepartmentId === myEmployeeInfo.primaryDepartmentId) return true;
    }
    if (task.assignments && task.assignments.length > 0) {
      for (const a of task.assignments) {
        if (a.assignmentType === "employee" && myEmployeeInfo?.linked && myEmployeeInfo.employeeId === a.assignmentId) return true;
        if (a.assignmentType === "advisor" && user.id === a.assignmentId) return true;
        if (a.assignmentType === "role" && myEmployeeInfo?.roles?.some(r => r.id === a.assignmentId)) return true;
        if (a.assignmentType === "department" && myEmployeeInfo?.primaryDepartmentId === a.assignmentId) return true;
        if (a.assignmentType === "branch" && myEmployeeInfo?.branchId === a.assignmentId) return true;
      }
      return false;
    }
    if (!task.assignedTo && !task.assignedEmployeeId && !task.assignedRoleId && !task.assignedDepartmentId) {
      return true;
    }
    return false;
  };

  const isChecklistRunMine = (run: ChecklistRunInstance): boolean => {
    if (!user) return false;
    if (run.assignedTo === user.id) return true;
    if (myEmployeeInfo?.linked && myEmployeeInfo.employeeId) {
      if (run.assignedEmployeeId === myEmployeeInfo.employeeId) return true;
    }
    if (run.assignedRoleId && myEmployeeInfo?.roles?.length) {
      if (myEmployeeInfo.roles.some(r => r.id === run.assignedRoleId)) return true;
    }
    const runDeptId = run.assignedDepartmentId || run.departmentId;
    if (runDeptId && myEmployeeInfo?.primaryDepartmentId) {
      if (runDeptId === myEmployeeInfo.primaryDepartmentId) return true;
    }
    return false;
  };

  const isChecklistTemplateMine = (tpl: ChecklistTemplate): boolean => {
    if (!user) return false;
    if (myEmployeeInfo?.linked && myEmployeeInfo.employeeId) {
      if (tpl.assignedEmployeeId === myEmployeeInfo.employeeId) return true;
    }
    if (tpl.assignedRoleId && myEmployeeInfo?.roles?.length) {
      if (myEmployeeInfo.roles.some(r => r.id === tpl.assignedRoleId)) return true;
    }
    const tplDeptId = tpl.assignedDepartmentId || tpl.departmentId;
    if (tplDeptId && myEmployeeInfo?.primaryDepartmentId) {
      if (tplDeptId === myEmployeeInfo.primaryDepartmentId) return true;
    }
    return false;
  };

  const filterBySearch = <T extends { title?: string; name?: string; description?: string | null; assignedUserName?: string | null; assignedEmployeeId?: string | null; assignments?: Array<{ assignmentType: string; assignmentId: string; label?: string; resolvedName?: string }> }>(items: T[]): T[] => {
    if (!taskFilters.searchQuery.trim()) return items;
    const terms = taskFilters.searchQuery.toLowerCase().trim().split(/[,\s]+/).filter(Boolean);
    if (terms.length === 0) return items;
    return items.filter(item => {
      const parts: string[] = [];
      if (item.title) parts.push(item.title);
      if (item.name) parts.push(item.name as string);
      if (item.description) parts.push(item.description);
      if (item.assignedUserName) parts.push(item.assignedUserName);
      if (item.assignedEmployeeId) {
        const emp = employees.find(e => e.id === item.assignedEmployeeId);
        if (emp) parts.push(emp.nickname || emp.fullName);
      }
      if (item.assignments) {
        for (const a of item.assignments) {
          if (a.resolvedName) parts.push(a.resolvedName);
          if (a.label) parts.push(a.label);
          if (a.assignmentType === "advisor") {
            const adv = advisors.find(ad => ad.id === a.assignmentId);
            if (adv) parts.push(adv.preferredName || adv.fullName);
          }
        }
      }
      const searchableText = parts.join(" ").toLowerCase();
      return terms.every(term => searchableText.includes(term));
    });
  };

  const applyTaskFilters = (items: ScheduledTask[]): ScheduledTask[] => {
    let filtered = items;
    if (taskFilters.taskScope === "my_tasks") {
      filtered = filtered.filter(t => {
        if (!user) return false;
        if (t.assignedTo === user.id) return true;
        if (myEmployeeInfo?.linked && myEmployeeInfo.employeeId && t.assignedEmployeeId === myEmployeeInfo.employeeId) return true;
        if (t.assignedRoleId && myEmployeeInfo?.roles?.length && myEmployeeInfo.roles.some(r => r.id === t.assignedRoleId)) return true;
        if (t.assignedDepartmentId && myEmployeeInfo?.primaryDepartmentId && t.assignedDepartmentId === myEmployeeInfo.primaryDepartmentId) return true;
        return false;
      });
    } else if (taskFilters.taskScope === "my_department") {
      filtered = filtered.filter(t => {
        if (!myEmployeeInfo?.primaryDepartmentId) return false;
        return t.assignedDepartmentId === myEmployeeInfo.primaryDepartmentId || t.assignedEmployeeDepartmentId === myEmployeeInfo.primaryDepartmentId;
      });
    } else if (taskFilters.taskScope === "assigned_by_me") {
      filtered = filtered.filter(t => t.createdBy === user?.id);
    }
    if (taskFilters.hideRecurring) {
      filtered = filtered.filter(t => t.recurrence === "once");
    }
    if (taskFilters.branchId !== "all") {
      filtered = filtered.filter(t => t.branchId === taskFilters.branchId);
    }
    
    if (taskFilters.departmentId !== "all") {
      filtered = filtered.filter(t => 
        t.assignedDepartmentId === taskFilters.departmentId || 
        t.assignedEmployeeDepartmentId === taskFilters.departmentId
      );
    }
    if (taskFilters.roleId !== "all") {
      filtered = filtered.filter(t => {
        if (t.assignedRoleId === taskFilters.roleId) return true;
        if (t.assignedEmployeeRoleIds) {
          const roleIds = t.assignedEmployeeRoleIds.split(',');
          if (roleIds.includes(taskFilters.roleId)) return true;
        }
        return false;
      });
    }
    if (taskFilters.assigneeId !== "all") {
      filtered = filtered.filter(t => {
        if (t.assignedEmployeeId === taskFilters.assigneeId || t.assignedTo === taskFilters.assigneeId) return true;
        const ta = (t as any).assignments as Array<{ assignmentType: string; assignmentId: string }> | undefined;
        if (ta?.some(a => (a.assignmentType === "employee" || a.assignmentType === "advisor") && a.assignmentId === taskFilters.assigneeId)) return true;
        return false;
      });
    }
    if (taskFilters.taskLevels.length > 0) {
      const taskLevelToRoleMap: Record<string, string> = { line: "staff", management: "manager", strategic: "admin" };
      filtered = filtered.filter(t => {
        if (t.assignedUserRole && taskFilters.taskLevels.includes(t.assignedUserRole as any)) return true;
        if (t.taskLevel) {
          const mappedRole = taskLevelToRoleMap[t.taskLevel];
          if (mappedRole && taskFilters.taskLevels.includes(mappedRole as any)) return true;
        }
        return false;
      });
    }
    if (taskFilters.showArchived) {
      filtered = filtered.filter(t => t.status === "completed");
    }
    return filtered;
  };

  const applyChecklistFilters = (items: ChecklistTemplate[]): ChecklistTemplate[] => {
    let filtered = items;
    if (taskFilters.taskLevels.length > 0) {
      filtered = filtered.filter(t => {
        const role = t.assignedUserRole;
        return role ? taskFilters.taskLevels.includes(role as any) : false;
      });
    }
    if (taskFilters.departmentId !== "all") {
      filtered = filtered.filter(t => 
        t.assignedDepartmentId === taskFilters.departmentId || 
        t.departmentId === taskFilters.departmentId ||
        t.assignedEmployeeDepartmentId === taskFilters.departmentId
      );
    }
    if (taskFilters.roleId !== "all") {
      filtered = filtered.filter(t => {
        if (t.assignedRoleId === taskFilters.roleId) return true;
        if (t.assignedEmployeeRoleIds) {
          const roleIds = t.assignedEmployeeRoleIds.split(',');
          if (roleIds.includes(taskFilters.roleId)) return true;
        }
        return false;
      });
    }
    return filtered;
  };

  const myFilteredCoreTasks = showMyOnly ? coreTasks.filter((t: any) => t.isMine === true || isTaskMine(t)) : coreTasks;
  const oneOffTasks = applyTaskFilters(filterBySearch(myFilteredCoreTasks));
  const myFilteredScheduledTasks = showMyOnly ? scheduledTasks.filter((t: any) => t.isMine === true || isTaskMine(t as any)) : scheduledTasks;
  const recurringTasks = applyTaskFilters(filterBySearch(myFilteredScheduledTasks.filter(t => t.recurrence !== "once")));
  const myFilteredTemplates = showMyOnly ? checklistTemplates.filter(isChecklistTemplateMine) : checklistTemplates;
  const recurringChecklists = applyChecklistFilters(filterBySearch(myFilteredTemplates.filter(t => t.recurrence && t.recurrence !== "none")));
  const allChecklists = applyChecklistFilters(filterBySearch(myFilteredTemplates));

  const isLoading = coreTasksLoading || checklistsLoading;

  const tabs: { id: OpsTab; label: string; icon: typeof ListTodo; count: number }[] = [
    { id: "tasks", label: "Tasks", icon: ListTodo, count: oneOffTasks.length },
    { id: "checklists", label: "Checklists", icon: ClipboardList, count: allChecklists.length },
    { id: "recurring", label: "Recurring", icon: RotateCcw, count: recurringTasks.length + recurringChecklists.length },
    { id: "announcements" as OpsTab, label: "Announce", icon: Megaphone, count: announcementsList.length },
  ];

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

  const handleNewAction = () => {
    if (activeTab === "tasks" || activeTab === "recurring") {
      if (!selectedBranchId) {
        toast({ title: "A branch must be selected to create a todo", variant: "destructive" });
        return;
      }
      setShowCreateTaskDialog(true);
    } else if (activeTab === "announcements") {
      setShowCreateAnnouncement(true);
    } else {
      setShowCreateChecklistDialog(true);
    }
  };

  return (
    <OpsLayout>
      <div className="p-4 space-y-3 flex min-h-full min-w-0 flex-col">
        <div className="overflow-x-auto scrollbar-hide flex-shrink-0" data-testid="tabs-ops-segments">
          <div className="flex gap-1 p-1 bg-muted rounded-lg min-w-max">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex-1 min-w-fit flex items-center justify-center gap-1.5 py-2 px-3 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
                    isActive
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  data-testid={`tab-ops-${tab.id}`}
                >
                  <Icon className="h-4 w-4 flex-shrink-0" />
                  <span>{tab.label}</span>
                  <Badge variant="secondary" className="text-xs px-1.5 py-0 ml-1">{tab.count}</Badge>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {activeTab === "tasks" && (
            <div className="flex items-center p-0.5 bg-muted rounded-md w-fit shrink-0" data-testid="toggle-tasks-view-mode">
              <Button
                variant={tasksViewMode === "list" ? "default" : "ghost"}
                size="icon"
                onClick={() => setTasksViewMode("list")}
                data-testid="button-tasks-view-list"
              >
                <ListTodo className="h-4 w-4" />
              </Button>
              <Button
                variant={tasksViewMode === "kanban" ? "default" : "ghost"}
                size="icon"
                onClick={() => setTasksViewMode("kanban")}
                data-testid="button-tasks-view-kanban"
              >
                <KanbanSquare className="h-4 w-4" />
              </Button>
              <Button
                variant={tasksViewMode === "calendar" ? "default" : "ghost"}
                size="icon"
                onClick={() => setTasksViewMode("calendar")}
                data-testid="button-tasks-view-calendar"
              >
                <CalendarDays className="h-4 w-4" />
              </Button>
            </div>
          )}
          {activeTab === "checklists" && (
            <div className="flex items-center gap-2 shrink-0">
              <div className="flex items-center p-0.5 bg-muted rounded-md w-fit" data-testid="toggle-checklists-view-mode">
                <Button
                  variant={checklistsViewMode === "dashboard" ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setChecklistsViewMode("dashboard")}
                  data-testid="button-checklists-view-dashboard"
                >
                  <KanbanSquare className="h-4 w-4 mr-1" />
                  Work
                </Button>
                <Button
                  variant={checklistsViewMode === "templates" ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setChecklistsViewMode("templates")}
                  data-testid="button-checklists-view-templates"
                >
                  <ListTodo className="h-4 w-4 mr-1" />
                  List of Checklists
                </Button>
                {isManagerOrAbove && (
                  <Button
                    variant={checklistsViewMode === "history" ? "default" : "ghost"}
                    size="sm"
                    onClick={() => setChecklistsViewMode("history")}
                    data-testid="button-checklists-view-history"
                  >
                    <Clock className="h-4 w-4 mr-1" />
                    History
                  </Button>
                )}
              </div>
            </div>
          )}

          <TaskFiltersPanel
            filters={taskFilters}
            onFiltersChange={setTaskFilters}
            branches={branches}
            departments={departments}
            roles={roles}
            employees={(() => {
              const empList = employees.map(e => ({ id: e.id, fullName: e.fullName, nickname: e.nickname, displayName: e.nickname || e.fullName }));
              const empIds = new Set(employees.map(e => e.id));
              for (const u of assignableUsers) {
                if (!u.isEmployee && !empIds.has(u.id)) {
                  empList.push({ id: u.id, fullName: u.fullName, nickname: u.nickname, displayName: u.displayName });
                  empIds.add(u.id);
                }
              }
              for (const a of advisors) {
                if (!empIds.has(a.id)) {
                  empList.push({ id: a.id, fullName: a.fullName, nickname: a.preferredName || null, displayName: a.preferredName || a.fullName });
                  empIds.add(a.id);
                }
              }
              return empList;
            })()}
            showBranchFilter={false}
            showTaskLevelFilter={activeTab === "tasks"}
          />

          <div className="flex items-center gap-2 shrink-0">
            <div className="flex items-center gap-2">
              <Label htmlFor="my-toggle" className="text-sm text-muted-foreground whitespace-nowrap">Just mine</Label>
              <Switch
                id="my-toggle"
                checked={showMyOnly}
                onCheckedChange={setShowMyOnly}
                data-testid="switch-ops-my-toggle"
              />
            </div>
            {activeTab === "tasks" && (
              <Button size="sm" variant="outline" onClick={() => setShowQuickTask(true)} data-testid="button-ops-quick-task">
                <Plus className="h-4 w-4 mr-1" />
                Quick
              </Button>
            )}
            {isManagerOrAbove && (
              <Button size="sm" onClick={handleNewAction} data-testid="button-ops-new">
                <Plus className="h-4 w-4 mr-1" />
                New
              </Button>
            )}
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {activeTab === "tasks" && (
              <div className="space-y-3 flex-1 flex flex-col min-h-0">

                {tasksViewMode === "list" && (
                  <TasksList
                    tasks={oneOffTasks}
                    getRecurrenceLabel={getRecurrenceLabel}
                    getAssignmentLabel={getAssignmentLabel}
                    getAssignmentIcon={getAssignmentIcon}
                    getBranchName={getBranchName}
                    onDelete={(task) => {
                      setDeleteTarget({ type: "task", id: task.id, name: task.title });
                      setDeleteDialogOpen(true);
                    }}
                    onEdit={(task) => navigate("/studio/tasks")}
                  />
                )}

                {tasksViewMode === "kanban" && (
                  <div className="flex gap-4 flex-1 min-h-0">
                    <div className="flex-1 min-w-0 h-full">
                      <KanbanView
                        tasks={oneOffTasks}
                        getRecurrenceLabel={getRecurrenceLabel}
                        getAssignmentLabel={getAssignmentLabel}
                        getAssignmentIcon={getAssignmentIcon}
                        getBranchName={getBranchName}
                        onDelete={(task) => {
                          setDeleteTarget({ type: "task", id: task.id, name: task.title });
                          setDeleteDialogOpen(true);
                        }}
                        onEdit={(task) => navigate("/studio/tasks")}
                        onCardClick={(task) => setSelectedTaskId(task.id)}
                        onStatusChange={(taskId, newStatus, dueAt) => updateTaskStatusMutation.mutate({ taskId, status: newStatus, dueAt })}
                      />
                    </div>
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
                                <p className="text-xs text-muted-foreground py-4 text-center">No recent activity</p>
                              ) : (
                                <div className="space-y-0 max-h-[calc(100vh-300px)] overflow-y-auto">
                                  {recentActivities.map((activity) => (
                                    <button
                                      key={activity.id}
                                      className="w-full text-left py-2 border-b last:border-b-0 border-border/50 hover-elevate rounded-sm px-1 -mx-1 cursor-pointer"
                                      onClick={() => setSelectedTaskId(activity.taskId)}
                                      data-testid={`ops-activity-${activity.id}`}
                                    >
                                      <p className="text-xs leading-snug">
                                        {activity.employeeNickname && activity.userName
                                          ? activity.description.replace(activity.userName, activity.employeeNickname)
                                          : activity.description}
                                      </p>
                                      {activity.taskTitle && (
                                        <p className="text-xs text-muted-foreground truncate mt-0.5">{activity.taskTitle}</p>
                                      )}
                                      <div className="flex items-center justify-between gap-1 mt-1">
                                        <span className="text-[10px] text-muted-foreground truncate max-w-[140px]">
                                          {activity.employeeNickname || activity.userName || "System"}
                                        </span>
                                        <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                                          {formatActivityDate(activity.createdAt)}
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
                )}

                {isManagerOrAbove && recentActivities.length > 0 && (
                  <div className="lg:hidden mt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => { setMobileUpdatesType("tasks"); setMobileUpdatesOpen(true); }}
                      data-testid="button-mobile-task-updates"
                    >
                      <Activity className="h-4 w-4 mr-2" />
                      Recent Updates ({recentActivities.length})
                    </Button>
                  </div>
                )}

                {tasksViewMode === "calendar" && (
                  <CalendarView
                    tasks={oneOffTasks}
                    getRecurrenceLabel={getRecurrenceLabel}
                    getAssignmentLabel={getAssignmentLabel}
                    getAssignmentIcon={getAssignmentIcon}
                    getBranchName={getBranchName}
                    onDelete={(task) => {
                      setDeleteTarget({ type: "task", id: task.id, name: task.title });
                      setDeleteDialogOpen(true);
                    }}
                    onEdit={(task) => navigate("/studio/tasks")}
                    onCardClick={(task) => setSelectedTaskId(task.id)}
                  />
                )}
              </div>
            )}

            {activeTab === "checklists" && (
              <div className="space-y-3 flex-1 flex flex-col min-h-0">
                {checklistRunsLoading ? (
                  <LoadingScreen />
                ) : checklistsViewMode === "dashboard" ? (
                  <div className="flex min-w-0 flex-1 gap-4">
                    <div className="min-w-0 flex-1">
                      <ChecklistManagerDashboard
                        runs={(() => {
                          let runs = showMyOnly ? checklistRuns.filter(isChecklistRunMine) : checklistRuns;
                          if (taskFilters.taskLevels.length > 0) {
                            runs = runs.filter(r => r.assignedUserRole ? taskFilters.taskLevels.includes(r.assignedUserRole as any) : false);
                          }
                          if (taskFilters.departmentId !== "all") {
                            runs = runs.filter(r => 
                              r.assignedDepartmentId === taskFilters.departmentId || 
                              r.departmentId === taskFilters.departmentId ||
                              r.assignedEmployeeDepartmentId === taskFilters.departmentId
                            );
                          }
                          if (taskFilters.roleId !== "all") {
                            runs = runs.filter(r => {
                              if (r.assignedRoleId === taskFilters.roleId) return true;
                              if (r.assignedEmployeeRoleIds) {
                                const roleIds = r.assignedEmployeeRoleIds.split(',');
                                if (roleIds.includes(taskFilters.roleId)) return true;
                              }
                              return false;
                            });
                          }
                          return runs;
                        })()}
                        onCardClick={(run) => setSelectedChecklistRunId(run.id)}
                      />
                    </div>
                    {isManagerOrAbove && (
                      <div className="hidden lg:block w-[280px] shrink-0">
                        <div className="sticky top-12">
                          <Card>
                            <CardContent className="p-4">
                              <div className="flex items-center gap-2 mb-3">
                                <Activity className="h-4 w-4 text-muted-foreground" />
                                <h3 className="text-sm font-semibold">Recent Updates</h3>
                              </div>
                              {recentChecklistActivities.length === 0 ? (
                                <p className="text-xs text-muted-foreground py-4 text-center">No recent checklist activity</p>
                              ) : (
                                <div className="space-y-0 max-h-[calc(100vh-300px)] overflow-y-auto">
                                  {recentChecklistActivities.map((activity) => (
                                    <button
                                      key={activity.id}
                                      className="w-full text-left py-2 border-b last:border-b-0 border-border/50 hover-elevate rounded-sm px-1 -mx-1 cursor-pointer"
                                      onClick={() => setSelectedChecklistRunId(activity.id)}
                                      data-testid={`ops-cl-activity-${activity.id}`}
                                    >
                                      <p className="text-xs leading-snug">{activity.description}</p>
                                      {activity.templateName && (
                                        <p className="text-xs text-muted-foreground truncate mt-0.5">{activity.templateName}</p>
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
                    )}
                  </div>
                ) : checklistsViewMode === "templates" ? (
                  <div className="min-w-0 space-y-3" data-testid="checklist-templates-view">
                    {isManagerOrAbove && (
                      <div className="flex justify-end">
                        <Button onClick={() => navigate("/studio/checklists?create=true")} data-testid="button-add-new-checklist">
                          <Plus className="h-4 w-4 mr-2" />
                          Add New Checklist
                        </Button>
                      </div>
                    )}
                    <ChecklistsList
                      checklists={allChecklists}
                      departments={departments}
                      getBranchName={getBranchName}
                      onDelete={(cl) => {
                        setDeleteTarget({ type: "checklist", id: cl.id, name: cl.name });
                        setDeleteDialogOpen(true);
                      }}
                      onEdit={(cl) => navigate(`/studio/checklists?edit=${cl.id}`)}
                    />
                  </div>
                ) : checklistHistoryLoading ? (
                  <LoadingScreen />
                ) : (
                  <ChecklistHistory
                    data={checklistHistory}
                    onRunClick={(run) => setSelectedChecklistRunId(run.id)}
                  />
                )}

                {isManagerOrAbove && recentChecklistActivities.length > 0 && (
                  <div className="lg:hidden mt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => { setMobileUpdatesType("checklists"); setMobileUpdatesOpen(true); }}
                      data-testid="button-mobile-checklist-updates"
                    >
                      <Activity className="h-4 w-4 mr-2" />
                      Recent Updates ({recentChecklistActivities.length})
                    </Button>
                  </div>
                )}
              </div>
            )}

            {activeTab === "recurring" && (
              <RecurringList
                recurringTasks={recurringTasks}
                recurringChecklists={recurringChecklists}
                getRecurrenceLabel={getRecurrenceLabel}
                getAssignmentLabel={getAssignmentLabel}
                getAssignmentIcon={getAssignmentIcon}
                getBranchName={getBranchName}
                departments={departments}
                onDeleteTask={(task) => {
                  setDeleteTarget({ type: "task", id: task.id, name: task.title });
                  setDeleteDialogOpen(true);
                }}
                onDeleteChecklist={(cl) => {
                  setDeleteTarget({ type: "checklist", id: cl.id, name: cl.name });
                  setDeleteDialogOpen(true);
                }}
                onEditTask={() => navigate("/studio/tasks/recurring")}
                onEditChecklist={() => navigate("/studio/checklists")}
              />
            )}

            {activeTab === "announcements" && (
              <div className="flex-1 overflow-auto space-y-3">
                {announcementsLoading ? (
                  <LoadingScreen />
                ) : announcementsList.length === 0 ? (
                  <EmptyState
                    icon={Megaphone}
                    title="No announcements"
                    description="Create announcements to keep your team informed"
                  />
                ) : (
                  announcementsList.map((ann) => {
                    const now = new Date();
                    const endDateEndOfDay = new Date(ann.endDate);
                    endDateEndOfDay.setHours(23, 59, 59, 999);
                    const isLive = ann.isActive && new Date(ann.startDate) <= now && endDateEndOfDay >= now;
                    const isExpired = endDateEndOfDay < now;
                    const priorityColors: Record<string, string> = {
                      urgent: "bg-red-500/15 border-red-500/30 dark:bg-red-500/20",
                      warning: "bg-amber-500/15 border-amber-500/30 dark:bg-amber-500/20",
                      info: "bg-blue-500/15 border-blue-500/30 dark:bg-blue-500/20",
                    };
                    return (
                      <Card key={ann.id} className={`overflow-visible ${!ann.isActive || isExpired ? "opacity-50" : ""}`} data-testid={`announcement-card-${ann.id}`}>
                        <CardContent className="p-4 space-y-2">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <Badge className={priorityColors[ann.priority] || priorityColors.info}>
                                {ann.priority.charAt(0).toUpperCase() + ann.priority.slice(1)}
                              </Badge>
                              {isLive && <Badge className="bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30">Live</Badge>}
                              {isExpired && <Badge variant="secondary">Expired</Badge>}
                              {!ann.isActive && <Badge variant="secondary">Inactive</Badge>}
                            </div>
                            <div className="flex gap-1 shrink-0">
                              <Button size="icon" variant="ghost" onClick={() => {
                                setEditingAnnouncementId(ann.id);
                                setAnnouncementForm({
                                  title: ann.title,
                                  body: ann.body,
                                  priority: ann.priority,
                                  startDate: new Date(ann.startDate),
                                  endDate: new Date(ann.endDate),
                                  branchIds: ann.branchIds || [],
                                  departmentIds: ann.departmentIds || [],
                                  showToEveryone: ann.showToEveryone,
                                });
                                setShowCreateAnnouncement(true);
                              }} data-testid={`button-edit-announcement-${ann.id}`}>
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button size="icon" variant="ghost" onClick={() => toggleAnnouncementMutation.mutate({ id: ann.id, isActive: !ann.isActive })} data-testid={`button-toggle-announcement-${ann.id}`}>
                                {ann.isActive ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                              </Button>
                              <Button size="icon" variant="ghost" onClick={() => deleteAnnouncementMutation.mutate(ann.id)} data-testid={`button-delete-announcement-${ann.id}`}>
                                <Trash2 className="h-3.5 w-3.5 text-destructive" />
                              </Button>
                            </div>
                          </div>
                          <h4 className="font-semibold text-sm">{ann.title}</h4>
                          <p className="text-sm text-muted-foreground line-clamp-2">{ann.body}</p>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                            <span className="flex items-center gap-1">
                              <CalendarDays className="h-3 w-3" />
                              {format(new Date(ann.startDate), "dd MMM")} - {format(new Date(ann.endDate), "dd MMM yyyy")}
                            </span>
                            {ann.showToEveryone ? (
                              <span className="flex items-center gap-1"><Users className="h-3 w-3" />Everyone</span>
                            ) : (
                              <span className="flex items-center gap-1">
                                <Building2 className="h-3 w-3" />
                                {ann.branchIds && ann.branchIds.length > 0 ? `${ann.branchIds.length} branch(es)` : ""}
                                {ann.departmentIds && ann.departmentIds.length > 0 ? ` · ${ann.departmentIds.length} dept(s)` : ""}
                              </span>
                            )}
                            {ann.creatorDisplay && <span>by {ann.creatorDisplay}</span>}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })
                )}
              </div>
            )}
          </>
        )}
      </div>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.type === "task" ? "Task" : "Checklist"}</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deleteTarget?.name}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-ops-delete-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} data-testid="button-ops-delete-confirm">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={overrideDialogOpen} onOpenChange={setOverrideDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Override Status</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to change "{overrideTarget?.name}" from {overrideTarget?.currentStatus} to {overrideTarget?.newStatus}? This will be logged as a manager override.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-override-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (overrideTarget) {
                  overrideStatusMutation.mutate({ id: overrideTarget.id, newStatus: overrideTarget.newStatus });
                }
              }}
              data-testid="button-override-confirm"
            >
              Override
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={showQuickTask} onOpenChange={(open) => {
        if (!open) {
          setShowQuickTask(false);
          setQuickTaskForm({ title: "", description: "", scheduled: false, startAt: "", dueAt: "" });
        }
      }}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-quick-task">
          <DialogHeader>
            <DialogTitle>Quick Task</DialogTitle>
            <DialogDescription>Create a task for yourself</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-sm">Title</Label>
              <Input
                placeholder="What needs to be done?"
                value={quickTaskForm.title}
                onChange={(e) => setQuickTaskForm(f => ({ ...f, title: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && quickTaskForm.title.trim()) handleQuickTaskSubmit(); }}
                autoFocus
                data-testid="input-quick-task-title"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Description</Label>
              <Textarea
                placeholder="Optional details..."
                value={quickTaskForm.description}
                onChange={(e) => setQuickTaskForm(f => ({ ...f, description: e.target.value }))}
                className="resize-none"
                rows={3}
                data-testid="input-quick-task-description"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Due Date</Label>
              <DatePicker
                value={quickTaskForm.dueAt}
                onChange={(val) => setQuickTaskForm(f => ({ ...f, dueAt: val }))}
                placeholder="Pick a due date"
                data-testid="input-quick-task-due"
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">Scheduled Task</Label>
                <p className="text-xs text-muted-foreground">Set a start date</p>
              </div>
              <Switch
                checked={quickTaskForm.scheduled}
                onCheckedChange={(checked) => setQuickTaskForm(f => ({ ...f, scheduled: checked, startAt: checked ? f.startAt : "" }))}
                data-testid="switch-quick-task-scheduled"
              />
            </div>
            {quickTaskForm.scheduled && (
              <div className="space-y-1.5">
                <Label className="text-sm">Start Date</Label>
                <DatePicker
                  value={quickTaskForm.startAt}
                  onChange={(val) => setQuickTaskForm(f => ({ ...f, startAt: val }))}
                  placeholder="Pick a start date"
                  data-testid="input-quick-task-start"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowQuickTask(false);
                setQuickTaskForm({ title: "", description: "", scheduled: false, startAt: "", dueAt: "" });
              }}
              data-testid="button-quick-task-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={handleQuickTaskSubmit}
              disabled={!quickTaskForm.title.trim() || quickTaskMutation.isPending}
              data-testid="button-quick-task-submit"
            >
              {quickTaskMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CreateTaskDialog open={showCreateTaskDialog} onOpenChange={setShowCreateTaskDialog} />
      <CreateChecklistDialog open={showCreateChecklistDialog} onOpenChange={setShowCreateChecklistDialog} />
      <TaskDetailSheet
        open={!!selectedTaskId}
        onOpenChange={(open) => { if (!open) setSelectedTaskId(null); }}
        taskId={selectedTaskId}
      />
      <ChecklistRunSheet
        open={!!selectedChecklistRunId}
        onOpenChange={(open) => { if (!open) setSelectedChecklistRunId(null); }}
        runId={selectedChecklistRunId}
      />

      <Sheet open={mobileUpdatesOpen} onOpenChange={setMobileUpdatesOpen}>
        <SheetContent side="bottom" className="max-h-[70vh] rounded-t-xl p-0">
          <SheetHeader className="px-5 pt-5 pb-3 border-b">
            <SheetTitle className="text-base font-semibold flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Recent Updates
            </SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 max-h-[calc(70vh-60px)]">
            <div className="py-2">
              {mobileUpdatesType === "tasks" ? (
                recentActivities.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-6 text-center">No recent activity</p>
                ) : (
                  recentActivities.map((activity) => (
                    <button
                      key={activity.id}
                      className="w-full text-left px-5 py-3 hover-elevate"
                      onClick={() => {
                        setSelectedTaskId(activity.taskId);
                        setMobileUpdatesOpen(false);
                      }}
                      data-testid={`mobile-activity-${activity.id}`}
                    >
                      <p className="text-sm leading-snug">
                        {activity.employeeNickname && activity.userName
                          ? activity.description.replace(activity.userName, activity.employeeNickname)
                          : activity.description}
                      </p>
                      {activity.taskTitle && (
                        <p className="text-xs text-muted-foreground truncate mt-0.5">{activity.taskTitle}</p>
                      )}
                      <div className="flex items-center justify-between gap-1 mt-1">
                        <span className="text-[10px] text-muted-foreground truncate max-w-[140px]">
                          {activity.employeeNickname || activity.userName || "System"}
                        </span>
                        <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                          {formatActivityDate(activity.createdAt)}
                        </span>
                      </div>
                    </button>
                  ))
                )
              ) : (
                recentChecklistActivities.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-6 text-center">No recent checklist activity</p>
                ) : (
                  recentChecklistActivities.map((activity) => (
                    <button
                      key={activity.id}
                      className="w-full text-left px-5 py-3 hover-elevate"
                      onClick={() => {
                        setSelectedChecklistRunId(activity.id);
                        setMobileUpdatesOpen(false);
                      }}
                      data-testid={`mobile-cl-activity-${activity.id}`}
                    >
                      <p className="text-sm leading-snug">{activity.description}</p>
                      {activity.templateName && (
                        <p className="text-xs text-muted-foreground truncate mt-0.5">{activity.templateName}</p>
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
                  ))
                )
              )}
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
      <Dialog open={showCreateAnnouncement} onOpenChange={(open) => {
        if (!open) {
          setShowCreateAnnouncement(false);
          setEditingAnnouncementId(null);
          setAnnouncementForm({
            title: "", body: "", priority: "info",
            startDate: new Date(), endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            branchIds: [], departmentIds: [], showToEveryone: true,
          });
        }
      }}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingAnnouncementId ? "Edit Announcement" : "New Announcement"}</DialogTitle>
            <DialogDescription>Create announcements visible to your team on the Today page.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Title</Label>
              <Input
                value={announcementForm.title}
                onChange={(e) => setAnnouncementForm(f => ({ ...f, title: e.target.value }))}
                placeholder="Announcement title"
                data-testid="input-announcement-title"
              />
            </div>
            <div className="space-y-2">
              <Label>Message</Label>
              <Textarea
                value={announcementForm.body}
                onChange={(e) => setAnnouncementForm(f => ({ ...f, body: e.target.value }))}
                placeholder="Write your announcement..."
                rows={4}
                data-testid="input-announcement-body"
              />
            </div>
            <div className="space-y-2">
              <Label>Priority</Label>
              <Select
                value={announcementForm.priority}
                onValueChange={(val) => setAnnouncementForm(f => ({ ...f, priority: val as any }))}
              >
                <SelectTrigger data-testid="select-announcement-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="info">Info</SelectItem>
                  <SelectItem value="warning">Warning</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Start Date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="w-full justify-start text-left font-normal" data-testid="button-announcement-start-date">
                      <CalendarDays className="mr-2 h-4 w-4" />
                      {format(announcementForm.startDate, "dd MMM yyyy")}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={announcementForm.startDate}
                      onSelect={(d) => d && setAnnouncementForm(f => ({ ...f, startDate: d }))}
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div className="space-y-2">
                <Label>End Date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="w-full justify-start text-left font-normal" data-testid="button-announcement-end-date">
                      <CalendarDays className="mr-2 h-4 w-4" />
                      {format(announcementForm.endDate, "dd MMM yyyy")}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={announcementForm.endDate}
                      onSelect={(d) => d && setAnnouncementForm(f => ({ ...f, endDate: d }))}
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Switch
                  checked={announcementForm.showToEveryone}
                  onCheckedChange={(checked) => setAnnouncementForm(f => ({ ...f, showToEveryone: checked }))}
                  data-testid="switch-announcement-everyone"
                />
                <Label>Show to everyone</Label>
              </div>
              {!announcementForm.showToEveryone && (
                <div className="space-y-3 pl-2 border-l-2 border-muted">
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Branches</Label>
                    <div className="flex gap-1.5 flex-wrap">
                      {branches.map(b => (
                        <Badge
                          key={b.id}
                          variant={announcementForm.branchIds.includes(b.id) ? "default" : "secondary"}
                          className="cursor-pointer"
                          onClick={() => setAnnouncementForm(f => ({
                            ...f,
                            branchIds: f.branchIds.includes(b.id)
                              ? f.branchIds.filter(x => x !== b.id)
                              : [...f.branchIds, b.id],
                          }))}
                          data-testid={`badge-branch-${b.id}`}
                        >
                          {b.name}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Departments</Label>
                    <div className="flex gap-1.5 flex-wrap">
                      {departments.map(d => (
                        <Badge
                          key={d.id}
                          variant={announcementForm.departmentIds.includes(d.id) ? "default" : "secondary"}
                          className="cursor-pointer"
                          onClick={() => setAnnouncementForm(f => ({
                            ...f,
                            departmentIds: f.departmentIds.includes(d.id)
                              ? f.departmentIds.filter(x => x !== d.id)
                              : [...f.departmentIds, d.id],
                          }))}
                          data-testid={`badge-dept-${d.id}`}
                        >
                          {d.name}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                createAnnouncementMutation.mutate({
                  title: announcementForm.title,
                  body: announcementForm.body,
                  priority: announcementForm.priority,
                  startDate: announcementForm.startDate.toISOString(),
                  endDate: announcementForm.endDate.toISOString(),
                  branchIds: announcementForm.showToEveryone ? null : announcementForm.branchIds.length > 0 ? announcementForm.branchIds : null,
                  departmentIds: announcementForm.showToEveryone ? null : announcementForm.departmentIds.length > 0 ? announcementForm.departmentIds : null,
                  showToEveryone: announcementForm.showToEveryone,
                });
              }}
              disabled={!announcementForm.title || !announcementForm.body || createAnnouncementMutation.isPending}
              data-testid="button-save-announcement"
            >
              {createAnnouncementMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              {editingAnnouncementId ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </OpsLayout>
  );
}

function TasksList({
  tasks,
  getRecurrenceLabel,
  getAssignmentLabel,
  getAssignmentIcon,
  getBranchName,
  onDelete,
  onEdit,
}: {
  tasks: ScheduledTask[];
  getRecurrenceLabel: (t: ScheduledTask) => string;
  getAssignmentLabel: (t: ScheduledTask) => string;
  getAssignmentIcon: (t: ScheduledTask) => typeof User;
  getBranchName: (id: string | null | undefined) => string | null;
  onDelete: (t: ScheduledTask) => void;
  onEdit: (t: ScheduledTask) => void;
}) {
  if (tasks.length === 0) {
    return (
      <EmptyState
        icon={ListTodo}
        title="No tasks yet"
        description="Create your first task from Studio or click New above"
      />
    );
  }

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case "completed": return "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400";
      case "in_progress": case "active": return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400";
      case "pending": case "paused": return "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400";
      default: return "";
    }
  };

  return (
    <div className="space-y-2">
      {tasks.map((task) => {
        const AssignIcon = getAssignmentIcon(task);
        const isOverdue = task.isOverdue;
        return (
          <Card key={task.id} className="hover-elevate cursor-pointer overflow-visible" data-testid={`card-ops-task-${task.id}`}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-medium text-sm">{task.title}</h3>
                    <Badge className={`text-xs ${getStatusBadgeClass(task.status)}`}>
                      {task.status === "completed" ? "Done" : task.status === "in_progress" || task.status === "active" ? "In Progress" : "To Do"}
                    </Badge>
                    {isOverdue && (
                      <Badge className="text-xs bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400">
                        Overdue
                      </Badge>
                    )}
                    {task.recurrence !== "once" && (
                      <Badge variant="outline" className="text-xs">
                        <RotateCcw className="h-3 w-3 mr-1" />
                        {getRecurrenceLabel(task)}
                      </Badge>
                    )}
                  </div>
                  {task.description && (
                    <p className="text-xs text-muted-foreground line-clamp-1">{task.description}</p>
                  )}
                  <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <AssignIcon className="h-3 w-3" />
                      {getAssignmentLabel(task)}
                    </span>
                    {task.requiresPhotoEvidence && (
                      <span className="flex items-center gap-1">
                        <Camera className="h-3 w-3" />
                        Photo
                      </span>
                    )}
                    {task.requiresResponses && (
                      <span className="flex items-center gap-1">
                        <MessageSquare className="h-3 w-3" />
                        Responses
                      </span>
                    )}
                    {task.dueDate && (
                      <span className={`flex items-center gap-1 ${isOverdue ? "text-destructive font-medium" : ""}`}>
                        <CalendarDays className="h-3 w-3" />
                        {(() => { const [y, m, d] = task.dueDate.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short" }); })()}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); onEdit(task); }} data-testid={`button-ops-edit-task-${task.id}`}>
                    <ListTodo className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); onDelete(task); }} data-testid={`button-ops-delete-task-${task.id}`}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

const KANBAN_COLUMNS: KanbanColumnDef[] = [
  { id: "todo", label: "To Do", color: "bg-slate-100 dark:bg-slate-900", statuses: ["pending", "paused"] },
  { id: "in_progress", label: "In Progress", color: "bg-blue-100/70 dark:bg-blue-950", statuses: ["active", "in_progress"] },
  { id: "overdue", label: "Overdue", color: "bg-red-100/70 dark:bg-red-950", statuses: [] },
  { id: "done", label: "Done", color: "bg-green-100/70 dark:bg-green-950", statuses: ["completed"] },
];

const CHECKLIST_KANBAN_COLUMNS: KanbanColumnDef[] = [
  { id: "pending", label: "Pending", color: "bg-slate-100 dark:bg-slate-900", statuses: ["pending"] },
  { id: "in_progress", label: "In Progress", color: "bg-blue-100/70 dark:bg-blue-950", statuses: ["in_progress"] },
  { id: "issues", label: "Issues", color: "bg-red-100/70 dark:bg-red-950", statuses: ["issues"] },
  { id: "completed", label: "Completed", color: "bg-green-100/70 dark:bg-green-950", statuses: ["completed"] },
];

const KANBAN_COLUMN_STATUS_MAP: Record<string, string> = {
  todo: "pending",
  in_progress: "in_progress",
  done: "completed",
};

function KanbanView({
  tasks,
  getRecurrenceLabel,
  getAssignmentLabel,
  getAssignmentIcon,
  getBranchName,
  onDelete,
  onEdit,
  onCardClick,
  onStatusChange,
}: {
  tasks: ScheduledTask[];
  getRecurrenceLabel: (t: ScheduledTask) => string;
  getAssignmentLabel: (t: ScheduledTask) => string;
  getAssignmentIcon: (t: ScheduledTask) => typeof User;
  getBranchName: (id: string | null | undefined) => string | null;
  onDelete: (t: ScheduledTask) => void;
  onEdit: (t: ScheduledTask) => void;
  onCardClick: (t: ScheduledTask) => void;
  onStatusChange: (taskId: string, newStatus: string, dueAt?: string) => void;
}) {
  const [pendingOverdueMove, setPendingOverdueMove] = useState<{ taskId: string; targetColumnId: string } | null>(null);
  const [selectedNewDueDate, setSelectedNewDueDate] = useState<Date | undefined>(undefined);

  const handleMove = useCallback((itemId: string, newColumnId: string) => {
    const newStatus = KANBAN_COLUMN_STATUS_MAP[newColumnId];
    if (!newStatus) return;

    const task = tasks.find(t => t.id === itemId);
    const isFromOverdue = task?.isOverdue;

    if (isFromOverdue && newColumnId !== "done") {
      setPendingOverdueMove({ taskId: itemId, targetColumnId: newColumnId });
      setSelectedNewDueDate(undefined);
      return;
    }

    onStatusChange(itemId, newStatus);
  }, [tasks, onStatusChange]);

  const handleConfirmOverdueMove = useCallback(() => {
    if (!pendingOverdueMove || !selectedNewDueDate) return;
    const newStatus = KANBAN_COLUMN_STATUS_MAP[pendingOverdueMove.targetColumnId];
    if (!newStatus) return;
    const dueDateStr = format(selectedNewDueDate, "yyyy-MM-dd'T'23:59:59");
    onStatusChange(pendingOverdueMove.taskId, newStatus, dueDateStr);
    setPendingOverdueMove(null);
    setSelectedNewDueDate(undefined);
  }, [pendingOverdueMove, selectedNewDueDate, onStatusChange]);

  const pendingTask = pendingOverdueMove ? tasks.find(t => t.id === pendingOverdueMove.taskId) : null;

  const renderTaskCard = (task: ScheduledTask, _columnId: string) => {
    const AssignIcon = getAssignmentIcon(task);
    const isCompleted = task.status === "completed";
    const startDateStr = task.startDate ?? null;
    const dueDateStr = task.dueDate ?? null;
    const dueTimeStr = task.dueTime ?? null;
    const dueDate = task.dueAt ? new Date(task.dueAt) : null;
    const isOverdueDate = !isCompleted && dueDate && dueDate < new Date();
    const isScheduledMultiDay = task.scheduledMode && startDateStr && dueDateStr && startDateStr !== dueDateStr;
    const formatShortStr = (s: string) => {
      const [y, m, d] = s.split("-").map(Number);
      return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    };
    const formattedDate = isScheduledMultiDay
      ? `${formatShortStr(startDateStr)} - ${formatShortStr(dueDateStr)}`
      : dueDateStr
        ? `${formatShortStr(dueDateStr)}${dueTimeStr ? ` ${dueTimeStr}` : ""}`
        : null;
    const progress = task.progressPercent ?? 0;
    return (
      <Card
        className={`hover-elevate overflow-visible cursor-pointer ${isCompleted ? "opacity-60" : ""}`}
        data-testid={`task-card-${task.id}`}
        onClick={() => onCardClick(task)}
      >
        <CardContent className="p-3 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <h4 className={`font-medium text-sm line-clamp-2 ${isCompleted ? "line-through text-muted-foreground" : ""}`}>{task.title}</h4>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
            {formattedDate && (
              <span className={`flex items-center gap-1 ${isOverdueDate ? "text-destructive font-medium" : ""}`}>
                <CalendarDays className="h-3 w-3" />
                {formattedDate}
              </span>
            )}
            <span className="flex items-center gap-1">
              <AssignIcon className="h-3 w-3" />
              {getAssignmentLabel(task)}
            </span>
          </div>
          {isScheduledMultiDay && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{progress}%</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    progress >= 100 ? "bg-green-500" : progress > 0 ? "bg-blue-500" : "bg-muted-foreground/30"
                  }`}
                  style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="h-full flex flex-col min-w-0">
      <KanbanBoard<ScheduledTask>
        items={tasks}
        columns={KANBAN_COLUMNS}
        getId={(t) => t.id}
        getStatus={(t) => t.status || "pending"}
        onMove={handleMove}
        renderCard={renderTaskCard}
        disabledColumns={["overdue"]}
        groupOverride={(t) => (t.isOverdue ? "overdue" : null)}
        emptyLabel="No tasks yet"
        idPrefix="task"
        testIdPrefix="kanban"
      />

      <Dialog
        open={!!pendingOverdueMove}
        onOpenChange={(open) => {
          if (!open) {
            setPendingOverdueMove(null);
            setSelectedNewDueDate(undefined);
          }
        }}
      >
        <DialogContent data-testid="dialog-reschedule-overdue">
          <DialogHeader>
            <DialogTitle>Reschedule Task</DialogTitle>
            <DialogDescription>
              {pendingTask
                ? `"${pendingTask.title}" is overdue. Please pick a new due date before moving it.`
                : "This task is overdue. Please pick a new due date before moving it."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-center py-2">
            <Calendar
              mode="single"
              selected={selectedNewDueDate}
              onSelect={setSelectedNewDueDate}
              disabled={(date) => date < new Date(new Date().setHours(0, 0, 0, 0))}
              defaultMonth={new Date()}
              data-testid="calendar-reschedule"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPendingOverdueMove(null);
                setSelectedNewDueDate(undefined);
              }}
              data-testid="button-reschedule-cancel"
            >
              Cancel
            </Button>
            <Button
              disabled={!selectedNewDueDate}
              onClick={handleConfirmOverdueMove}
              data-testid="button-reschedule-confirm"
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CalendarView({
  tasks,
  getRecurrenceLabel,
  getAssignmentLabel,
  getAssignmentIcon,
  getBranchName,
  onDelete,
  onEdit,
  onCardClick,
}: {
  tasks: ScheduledTask[];
  getRecurrenceLabel: (t: ScheduledTask) => string;
  getAssignmentLabel: (t: ScheduledTask) => string;
  getAssignmentIcon: (t: ScheduledTask) => typeof User;
  getBranchName: (id: string | null | undefined) => string | null;
  onDelete: (t: ScheduledTask) => void;
  onEdit: (t: ScheduledTask) => void;
  onCardClick?: (t: ScheduledTask) => void;
}) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [expandedDate, setExpandedDate] = useState<string | null>(null);

  const getTaskColor = (task: ScheduledTask) => {
    if (task.status === "completed") return { mini: "bg-green-200/70 dark:bg-green-900/50 text-green-800 dark:text-green-300", card: "border-l-4 border-l-green-500" };
    if (task.isOverdue) return { mini: "bg-red-200/70 dark:bg-red-900/50 text-red-800 dark:text-red-300", card: "border-l-4 border-l-red-500" };
    if (task.status === "active" || task.status === "in_progress") return { mini: "bg-blue-200/70 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300", card: "border-l-4 border-l-blue-500" };
    return { mini: "bg-slate-200/70 dark:bg-slate-800 text-slate-700 dark:text-slate-300", card: "border-l-4 border-l-slate-400" };
  };

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const monthName = currentDate.toLocaleString("en-US", { month: "long", year: "numeric" });

  const firstDayOfMonth = new Date(year, month, 1);
  const lastDayOfMonth = new Date(year, month + 1, 0);

  const startDay = firstDayOfMonth.getDay();
  const adjustedStart = startDay === 0 ? 6 : startDay - 1;
  const totalDays = lastDayOfMonth.getDate();

  const tasksByDate: Record<string, ScheduledTask[]> = {};
  const unscheduledTasks: ScheduledTask[] = [];

  for (const task of tasks) {
    const dueDateKey = task.dueDate ?? null;
    if (dueDateKey) {
      if (!tasksByDate[dueDateKey]) tasksByDate[dueDateKey] = [];
      tasksByDate[dueDateKey].push(task);
    } else {
      unscheduledTasks.push(task);
    }
  }

  const prevMonth = () => {
    setCurrentDate(new Date(year, month - 1, 1));
  };

  const nextMonth = () => {
    setCurrentDate(new Date(year, month + 1, 1));
  };

  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const cells: { day: number | null; dateKey: string }[] = [];
  for (let i = 0; i < adjustedStart; i++) {
    cells.push({ day: null, dateKey: "" });
  }
  for (let d = 1; d <= totalDays; d++) {
    const dateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    cells.push({ day: d, dateKey });
  }

  const expandedTasks = expandedDate ? (tasksByDate[expandedDate] || []) : [];

  return (
    <div className="space-y-4" data-testid="calendar-view">
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" size="icon" onClick={prevMonth} data-testid="button-calendar-prev">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <h2 className="font-semibold text-sm" data-testid="text-calendar-month">{monthName}</h2>
        <Button variant="ghost" size="icon" onClick={nextMonth} data-testid="button-calendar-next">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid grid-cols-7 gap-px bg-border rounded-lg overflow-hidden">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
          <div key={day} className="bg-muted p-2 text-center text-xs font-medium text-muted-foreground">
            {day}
          </div>
        ))}
        {cells.map((cell, idx) => {
          if (cell.day === null) {
            return <div key={`empty-${idx}`} className="bg-background p-2 min-h-[60px]" />;
          }
          const dayTasks = tasksByDate[cell.dateKey] || [];
          const isToday = cell.dateKey === todayKey;
          return (
            <div
              key={cell.dateKey}
              className={`bg-background p-1.5 min-h-[60px] text-left transition-colors ${isToday ? "bg-primary/5" : ""}`}
              data-testid={`calendar-day-${cell.dateKey}`}
            >
              <span className={`text-xs font-medium inline-flex items-center justify-center w-5 h-5 rounded-full ${
                isToday ? "bg-primary text-primary-foreground" : ""
              }`}>
                {cell.day}
              </span>
              {dayTasks.length > 0 && (
                <div className="mt-0.5 flex flex-wrap gap-0.5">
                  {dayTasks.slice(0, 3).map((t) => {
                    const colors = getTaskColor(t);
                    return (
                      <div
                        key={t.id}
                        className={`w-full truncate text-[10px] leading-tight px-1 py-0.5 rounded cursor-pointer hover:ring-1 hover:ring-primary/40 transition-all ${colors.mini} ${
                          t.status === "completed" ? "line-through" : ""
                        }`}
                        title={t.title}
                        onClick={(e) => { e.stopPropagation(); onCardClick?.(t); }}
                        data-testid={`calendar-mini-task-${t.id}`}
                      >
                        {t.title}
                      </div>
                    );
                  })}
                  {dayTasks.length > 3 && (
                    <span
                      className="text-[10px] text-primary font-medium px-1 cursor-pointer hover:underline"
                      onClick={(e) => { e.stopPropagation(); setExpandedDate(cell.dateKey); }}
                      data-testid={`calendar-more-${cell.dateKey}`}
                    >
                      +{dayTasks.length - 3} more
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Dialog open={!!expandedDate} onOpenChange={(open) => { if (!open) setExpandedDate(null); }}>
        <DialogContent className="sm:max-w-md max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-base">
              {expandedDate && new Date(expandedDate + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-2 pr-1" data-testid="calendar-day-popup">
            {expandedTasks.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No tasks on this day</p>
            ) : (
              expandedTasks.map((task) => {
                const AssignIcon = getAssignmentIcon(task);
                const isCompleted = task.status === "completed";
                const colors = getTaskColor(task);
                return (
                  <Card
                    key={task.id}
                    className={`hover-elevate overflow-visible cursor-pointer ${colors.card} ${isCompleted ? "opacity-60" : ""}`}
                    data-testid={`calendar-popup-task-${task.id}`}
                    onClick={() => onCardClick?.(task)}
                  >
                    <CardContent className="p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0 space-y-1">
                          <h4 className={`font-medium text-sm ${isCompleted ? "line-through text-muted-foreground" : ""}`}>{task.title}</h4>
                          {task.description && (
                            <p className="text-xs text-muted-foreground line-clamp-1">{task.description}</p>
                          )}
                          <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <AssignIcon className="h-3 w-3" />
                              {getAssignmentLabel(task)}
                            </span>
                            <Badge className={`text-xs ${
                              isCompleted ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400" :
                              task.isOverdue ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400" :
                              task.status === "in_progress" || task.status === "active" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400" :
                              "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                            }`}>{isCompleted ? "Done" : task.isOverdue ? "Overdue" : task.status === "in_progress" || task.status === "active" ? "In Progress" : "To Do"}</Badge>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ChecklistsList({
  checklists,
  departments,
  getBranchName,
  onDelete,
  onEdit,
}: {
  checklists: ChecklistTemplate[];
  departments: Department[];
  getBranchName: (id: string | null | undefined) => string | null;
  onDelete: (cl: ChecklistTemplate) => void;
  onEdit: (cl: ChecklistTemplate) => void;
}) {
  if (checklists.length === 0) {
    return (
      <EmptyState
        icon={ClipboardList}
        title="No checklists yet"
        description="Create your first checklist from Studio or click New above"
      />
    );
  }

  const getDeptName = (id: string | null) => {
    if (!id) return null;
    return departments.find(d => d.id === id)?.name || null;
  };

  const getRecurrenceLabel = (recurrence: string | null) => {
    if (!recurrence || recurrence === "none") return "Manual";
    return recurrence.charAt(0).toUpperCase() + recurrence.slice(1);
  };

  return (
    <div className="space-y-2">
      {checklists.map((cl) => {
        const branchName = getBranchName(cl.branchId);
        const deptName = getDeptName(cl.assignedDepartmentId || cl.departmentId);
        return (
          <Card key={cl.id} className="hover-elevate cursor-pointer overflow-visible" data-testid={`card-ops-checklist-${cl.id}`}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-medium text-sm">{cl.name}</h3>
                    <Badge variant={cl.isActive ? "default" : "secondary"} className="text-xs">
                      {cl.isActive ? "Active" : "Paused"}
                    </Badge>
                    {cl.recurrence && cl.recurrence !== "none" && (
                      <Badge variant="outline" className="text-xs">
                        <RotateCcw className="h-3 w-3 mr-1" />
                        {getRecurrenceLabel(cl.recurrence)}
                      </Badge>
                    )}
                  </div>
                  {cl.description && (
                    <p className="text-xs text-muted-foreground line-clamp-1">{cl.description}</p>
                  )}
                  <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
                    {deptName && (
                      <span className="flex items-center gap-1">
                        <Building2 className="h-3 w-3" />
                        {deptName}
                      </span>
                    )}
                    {branchName && (
                      <span className="flex items-center gap-1">
                        <Building2 className="h-3 w-3" />
                        {branchName}
                      </span>
                    )}
                    {cl.scheduledTime && (
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {cl.scheduledTime}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); onEdit(cl); }} data-testid={`button-ops-edit-checklist-${cl.id}`}>
                    <Pencil className="h-4 w-4 mr-1" />
                    Edit
                  </Button>
                  <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); onDelete(cl); }} data-testid={`button-ops-delete-checklist-${cl.id}`}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function RecurringList({
  recurringTasks,
  recurringChecklists,
  getRecurrenceLabel,
  getAssignmentLabel,
  getAssignmentIcon,
  getBranchName,
  departments,
  onDeleteTask,
  onDeleteChecklist,
  onEditTask,
  onEditChecklist,
}: {
  recurringTasks: ScheduledTask[];
  recurringChecklists: ChecklistTemplate[];
  getRecurrenceLabel: (t: ScheduledTask) => string;
  getAssignmentLabel: (t: ScheduledTask) => string;
  getAssignmentIcon: (t: ScheduledTask) => typeof User;
  getBranchName: (id: string | null | undefined) => string | null;
  departments: Department[];
  onDeleteTask: (t: ScheduledTask) => void;
  onDeleteChecklist: (cl: ChecklistTemplate) => void;
  onEditTask: () => void;
  onEditChecklist: () => void;
}) {
  const getDeptName = (id: string | null) => {
    if (!id) return null;
    return departments.find(d => d.id === id)?.name || null;
  };

  if (recurringTasks.length === 0 && recurringChecklists.length === 0) {
    return (
      <EmptyState
        icon={RotateCcw}
        title="No recurring definitions"
        description="Create recurring tasks or checklists to see them here"
      />
    );
  }

  return (
    <div className="space-y-4">
      {recurringTasks.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Recurring Tasks</h2>
          {recurringTasks.map((task) => {
            const AssignIcon = getAssignmentIcon(task);
            return (
              <Card key={task.id} className="hover-elevate overflow-visible" data-testid={`card-ops-recurring-task-${task.id}`}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <ListTodo className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                        <h3 className="font-medium text-sm">{task.title}</h3>
                        <Badge variant="outline" className="text-xs">
                          {getRecurrenceLabel(task)}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <AssignIcon className="h-3 w-3" />
                          {getAssignmentLabel(task)}
                        </span>
                        {task.preferredDueTime && (
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {task.preferredDueTime}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon" onClick={() => onEditTask()} data-testid={`button-ops-edit-recurring-task-${task.id}`}>
                        <ListTodo className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => onDeleteTask(task)} data-testid={`button-ops-delete-recurring-task-${task.id}`}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {recurringChecklists.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Recurring Checklists</h2>
          {recurringChecklists.map((cl) => {
            const deptName = getDeptName(cl.assignedDepartmentId || cl.departmentId);
            return (
              <Card key={cl.id} className="hover-elevate overflow-visible" data-testid={`card-ops-recurring-checklist-${cl.id}`}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <ClipboardList className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                        <h3 className="font-medium text-sm">{cl.name}</h3>
                        <Badge variant={cl.isActive ? "default" : "secondary"} className="text-xs">
                          {cl.isActive ? "Active" : "Paused"}
                        </Badge>
                        <Badge variant="outline" className="text-xs">
                          {cl.recurrence ? cl.recurrence.charAt(0).toUpperCase() + cl.recurrence.slice(1) : ""}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
                        {deptName && (
                          <span className="flex items-center gap-1">
                            <Building2 className="h-3 w-3" />
                            {deptName}
                          </span>
                        )}
                        {cl.scheduledTime && (
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {cl.scheduledTime}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon" onClick={() => onEditChecklist()} data-testid={`button-ops-edit-recurring-checklist-${cl.id}`}>
                        <ClipboardList className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => onDeleteChecklist(cl)} data-testid={`button-ops-delete-recurring-checklist-${cl.id}`}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ChecklistManagerDashboard({
  runs,
  onCardClick,
}: {
  runs: ChecklistRunInstance[];
  onCardClick: (run: ChecklistRunInstance) => void;
}) {
  const formatRunDate = (dateStr: string | null) => {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  const renderChecklistCard = (run: ChecklistRunInstance, columnId: string) => (
    <Card
      key={run.id}
      className={`hover-elevate overflow-visible cursor-pointer ${columnId === "missed" ? "border-destructive/50" : ""}`}
      data-testid={`cl-card-${run.id}`}
      onClick={() => onCardClick(run)}
    >
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <h4 className="font-medium text-sm line-clamp-2">{run.templateName}</h4>
          {run.itemsFailed > 0 && (
            <Badge variant="destructive" className="text-xs shrink-0">
              {run.itemsFailed} failed
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-1">
          <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all"
              style={{ width: run.itemsTotal > 0 ? `${(run.itemsCompleted / run.itemsTotal) * 100}%` : "0%" }}
            />
          </div>
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
            {run.itemsCompleted}/{run.itemsTotal}
          </span>
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
          {run.departmentName && (
            <span className="flex items-center gap-1">
              <Briefcase className="h-3 w-3" />
              {run.departmentName}
            </span>
          )}
          {(run.responsibleStaff?.length || run.assignedUserName) && (
            <span className="flex items-center gap-1">
              <Users className="h-3 w-3" />
              {run.responsibleStaff?.map((staff) => staff.name).join(", ") || run.assignedUserName}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
          {run.dueAt && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatRunDate(run.dueAt)}
            </span>
          )}
          {run.branchName && (
            <span className="flex items-center gap-1">
              <Building2 className="h-3 w-3" />
              {run.branchName}
            </span>
          )}
        </div>

      </CardContent>
    </Card>
  );

  const columns = [
    { id: "pending", title: "Pending", runs: runs.filter((run) => run.status === "pending"), className: "border-slate-300" },
    { id: "in_progress", title: "In Progress", runs: runs.filter((run) => run.status === "in_progress" || run.status === "issues"), className: "border-blue-400" },
    { id: "missed", title: "Missed Last 3 Days", runs: runs.filter((run) => run.status === "missed"), className: "border-red-400" },
    { id: "completed", title: "Completed", runs: runs.filter((run) => run.status === "completed"), className: "border-green-400" },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 items-start" data-testid="checklist-work-dashboard">
      {columns.map((column) => (
        <section key={column.id} className={`rounded-lg border-t-4 ${column.className} bg-muted/30 p-3 min-h-32`} data-testid={`checklist-column-${column.id}`}>
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-sm">{column.title}</h3>
            <Badge variant="secondary">{column.runs.length}</Badge>
          </div>
          <div className="space-y-2">
            {column.runs.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-6">Nothing here</p>
            ) : column.runs.map((run) => renderChecklistCard(run, column.id))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ChecklistHistory({
  data,
  onRunClick,
}: {
  data?: {
    missedGroups: Array<{
      key: string;
      templateName: string;
      recurrence: string | null;
      periodStart: string | null;
      periodEnd: string | null;
      count: number;
      runs: ChecklistRunInstance[];
    }>;
    completed: ChecklistRunInstance[];
  };
  onRunClick: (run: ChecklistRunInstance) => void;
}) {
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const missedGroups = data?.missedGroups || [];
  const completed = data?.completed || [];

  if (missedGroups.length === 0 && completed.length === 0) {
    return <EmptyState icon={Clock} title="No checklist history yet" description="Completed and missed runs will appear here." />;
  }

  return (
    <div className="space-y-6" data-testid="checklist-history">
      <section>
        <h3 className="font-semibold mb-2">Missed</h3>
        <div className="space-y-2">
          {missedGroups.map((group) => (
            <Card key={group.key} className="overflow-visible">
              <CardContent className="p-4">
                <button
                  className="w-full text-left flex items-center justify-between gap-3"
                  onClick={() => setExpandedGroup(expandedGroup === group.key ? null : group.key)}
                  data-testid={`history-missed-group-${group.key}`}
                >
                  <div>
                    <p className="font-medium text-sm">{group.templateName} — {group.count} missed</p>
                    <p className="text-xs text-muted-foreground">
                      {group.periodStart ? new Date(group.periodStart).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "Earlier period"}
                    </p>
                  </div>
                  <ChevronRight className={`h-4 w-4 transition-transform ${expandedGroup === group.key ? "rotate-90" : ""}`} />
                </button>
                {expandedGroup === group.key && (
                  <div className="mt-3 pt-3 border-t space-y-2">
                    {group.runs.map((run) => (
                      <button
                        key={run.id}
                        className="w-full text-left rounded-md border p-3 hover-elevate"
                        onClick={() => onRunClick(run)}
                        data-testid={`history-run-${run.id}`}
                      >
                        <p className="text-sm font-medium">{run.dueAt ? new Date(run.dueAt).toLocaleString("en-GB") : "Unscheduled"}</p>
                        <p className="text-xs text-muted-foreground">
                          {run.departmentName || "All departments"} · {run.responsibleStaff?.map((staff) => staff.name).join(", ") || "No on-shift staff recorded"}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
      <section>
        <h3 className="font-semibold mb-2">Completed</h3>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {completed.map((run) => (
            <button key={run.id} className="text-left rounded-lg border bg-card p-3 hover-elevate" onClick={() => onRunClick(run)}>
              <p className="font-medium text-sm">{run.templateName}</p>
              <p className="text-xs text-muted-foreground">{run.completedAt ? new Date(run.completedAt).toLocaleString("en-GB") : "Completed"}</p>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
