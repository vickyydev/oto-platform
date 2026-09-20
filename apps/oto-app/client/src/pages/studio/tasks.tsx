import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { StudioLayout } from "@/components/layout/studio-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { DatePicker } from "@/components/ui/date-picker";
import { 
  Plus, 
  Pencil, 
  Trash2, 
  Clock, 
  Camera, 
  MessageSquare,
  CalendarDays,
  Loader2,
  RotateCcw,
  Users,
  User,
  Briefcase,
  Building2,
  MapPin,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import AssignmentSearchBar, { type AssignmentValue } from "@/components/core/AssignmentSearchBar";
import { useToast } from "@/hooks/use-toast";

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
  firstName?: string | null;
  lastName?: string | null;
  nickname?: string | null;
  userId?: string | null;
  branchId?: string | null;
}

interface TaskQuestion {
  prompt: string;
  questionType: "text" | "number" | "boolean" | "multiple_choice";
  options?: string[];
  isRequired: boolean;
}

interface ScheduledTask {
  id: string;
  title: string;
  description?: string | null;
  branchId?: string | null;
  branchName?: string | null;
  recurrence: "once" | "daily" | "weekly" | "monthly";
  weeklyDays: string[];
  monthlyDay?: number | null;
  preferredDueTime?: string | null;
  dueAt?: string | null;
  requiresPhotoEvidence: boolean;
  requiresResponses: boolean;
  isRecurringDefinition: boolean;
  status: string;
  createdAt: string;
  assignedTo?: string | null;
  assignedEmployeeId?: string | null;
  assignedRoleId?: string | null;
  assignedDepartmentId?: string | null;
  assignments?: { assignmentType: string; assignmentId: string }[];
  questions?: TaskQuestion[];
}

// Days of month for monthly recurrence (1-31)
const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

const WEEKDAYS = [
  { id: "mon", label: "Mon" },
  { id: "tue", label: "Tue" },
  { id: "wed", label: "Wed" },
  { id: "thu", label: "Thu" },
  { id: "fri", label: "Fri" },
  { id: "sat", label: "Sat" },
  { id: "sun", label: "Sun" },
];

export default function StudioTasksPage() {
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);
  const [location, navigate] = useLocation();
  const activeTab: "one-off" | "recurring" = location.startsWith("/studio/tasks/recurring") ? "recurring" : "one-off";
  const [assignments, setAssignments] = useState<AssignmentValue[]>([]);

  const handleTabChange = (tab: "one-off" | "recurring") => {
    navigate(`/studio/tasks/${tab}`);
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("create") === "true") {
      setDialogOpen(true);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

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
    questions: [] as TaskQuestion[],
  });

  const { data: scheduledTasks = [], isLoading } = useQuery<ScheduledTask[]>({
    queryKey: ["/api/studio/scheduled-tasks"],
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

  // Fetch advisors (people with personType = ADVISOR)
  const { data: advisors = [] } = useQuery<{ id: string; fullName: string; preferredName: string | null; email: string }[]>({
    queryKey: ["/api/people", { personType: "ADVISOR" }],
    queryFn: async () => {
      const res = await fetch("/api/people?personType=ADVISOR");
      if (!res.ok) return [];
      return res.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      return apiRequest("POST", "/api/studio/scheduled-tasks", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/studio/scheduled-tasks"] });
      toast({ title: "Scheduled task created" });
      closeDialog();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: typeof formData }) => {
      return apiRequest("PATCH", `/api/studio/scheduled-tasks/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/studio/scheduled-tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks"] });
      toast({ title: "Scheduled task updated" });
      closeDialog();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/studio/scheduled-tasks/${id}`, undefined);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/studio/scheduled-tasks"] });
      toast({ title: "Scheduled task deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingTask(null);
    setFormData({
      title: "",
      description: "",
      branchIds: [] as string[],
      recurrence: "once" as "once" | "daily" | "weekly" | "monthly",
      weeklyDays: [] as string[],
      monthlyDay: null,
      preferredDueTime: "09:00",
      scheduledMode: false,
      startDate: "",
      dueDate: "",
      requiresPhotoEvidence: false,
      requiresResponses: false,
      questions: [] as TaskQuestion[],
    });
    setAssignments([]);
  };

  const addQuestion = () => {
    setFormData({
      ...formData,
      questions: [
        ...formData.questions,
        { prompt: "", questionType: "text", isRequired: true },
      ],
    });
  };

  const updateQuestion = (index: number, updates: Partial<TaskQuestion>) => {
    const newQuestions = [...formData.questions];
    newQuestions[index] = { ...newQuestions[index], ...updates };
    setFormData({ ...formData, questions: newQuestions });
  };

  const removeQuestion = (index: number) => {
    setFormData({
      ...formData,
      questions: formData.questions.filter((_, i) => i !== index),
    });
  };

  const openEditDialog = (task: ScheduledTask) => {
    setEditingTask(task);
    // Convert dates to YYYY-MM-DD format for one-off tasks
    let startDate = "";
    let dueDate = "";
    if ((task as any).startAt) {
      const date = new Date((task as any).startAt);
      startDate = date.toISOString().split('T')[0];
    }
    if (task.dueAt) {
      const date = new Date(task.dueAt);
      dueDate = date.toISOString().split('T')[0];
    }
    setFormData({
      title: task.title,
      description: task.description || "",
      branchIds: task.branchId ? [task.branchId] : [],
      recurrence: task.recurrence,
      weeklyDays: task.weeklyDays || [],
      monthlyDay: task.monthlyDay || null,
      preferredDueTime: task.preferredDueTime || "09:00",
      scheduledMode: Boolean((task as any).scheduledMode),
      startDate: startDate,
      dueDate: dueDate,
      requiresPhotoEvidence: Boolean(task.requiresPhotoEvidence),
      requiresResponses: Boolean(task.requiresResponses),

      questions: task.questions?.map(q => ({
        prompt: q.prompt,
        questionType: q.questionType as "text" | "number" | "boolean" | "multiple_choice",
        options: q.options || [],
        isRequired: q.isRequired ?? true,
      })) || [],
    });
    const loadedAssignments: AssignmentValue[] = (task.assignments || []).map(a => {
      if (a.assignmentType === "employee") {
        const emp = employees.find(e => e.id === a.assignmentId);
        return { type: "employee" as const, id: a.assignmentId, label: emp?.nickname || emp?.fullName || a.assignmentId };
      } else if (a.assignmentType === "advisor") {
        const adv = advisors.find(adv => adv.id === a.assignmentId);
        return { type: "advisor" as const, id: a.assignmentId, label: adv?.preferredName || adv?.fullName || a.assignmentId };
      } else if (a.assignmentType === "role") {
        const role = roles.find(r => r.id === a.assignmentId);
        return { type: "role" as const, id: a.assignmentId, label: role?.name || a.assignmentId };
      } else if (a.assignmentType === "department") {
        const dept = departments.find(d => d.id === a.assignmentId);
        return { type: "department" as const, id: a.assignmentId, label: dept?.name || a.assignmentId };
      }
      return { type: "employee" as const, id: a.assignmentId, label: a.assignmentId };
    });
    setAssignments(loadedAssignments);
    setDialogOpen(true);
  };

  const toggleBranch = (branchId: string) => {
    if (formData.branchIds.includes(branchId)) {
      setFormData({ 
        ...formData, 
        branchIds: formData.branchIds.filter(id => id !== branchId),
      });
    } else {
      setFormData({ 
        ...formData, 
        branchIds: [...formData.branchIds, branchId],
      });
    }
  };

  // Filter employees when only one branch is selected
  const filteredEmployees = formData.branchIds.length === 1
    ? employees.filter(emp => emp.branchId === formData.branchIds[0])
    : employees;

  const handleSubmit = () => {
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

    
    // Prepare data with startDate enforcement
    const submitData = {
      ...formData,
      // For non-scheduled (one-off) tasks, enforce startDate = dueDate
      startDate: formData.recurrence === "once" && !formData.scheduledMode 
        ? formData.dueDate 
        : formData.startDate,
    };
    
    const payload = {
      ...submitData,
      assignments: assignments.filter(a => a.type !== "everyone").map(a => ({ assignmentType: a.type, assignmentId: a.id })),
    };

    if (editingTask) {
      updateMutation.mutate({ id: editingTask.id, data: payload as any });
    } else {
      createMutation.mutate(payload as any);
    }
  };

  const handleDelete = (id: string) => {
    if (confirm("Are you sure you want to delete this scheduled task?")) {
      deleteMutation.mutate(id);
    }
  };

  const toggleWeeklyDay = (day: string) => {
    if (formData.weeklyDays.includes(day)) {
      setFormData({ ...formData, weeklyDays: formData.weeklyDays.filter(d => d !== day) });
    } else {
      setFormData({ ...formData, weeklyDays: [...formData.weeklyDays, day] });
    }
  };

  const getRecurrenceLabel = (task: ScheduledTask) => {
    if (task.recurrence === "once") {
      return "One-off";
    }
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

  const resolveAssignmentLabel = (assignmentType: string, assignmentId: string): string => {
    if (assignmentType === "employee") {
      const emp = employees.find(e => e.id === assignmentId);
      return emp?.nickname || emp?.fullName || assignmentId;
    }
    if (assignmentType === "advisor") {
      const adv = advisors.find(a => a.id === assignmentId);
      return adv?.preferredName || adv?.fullName || assignmentId;
    }
    if (assignmentType === "role") {
      return roles.find(r => r.id === assignmentId)?.name || assignmentId;
    }
    if (assignmentType === "department") {
      return departments.find(d => d.id === assignmentId)?.name || assignmentId;
    }
    return assignmentId;
  };

  const getAssignmentLabel = (task: ScheduledTask) => {
    const a = task.assignments;
    if (a && a.length > 0) {
      return a.map(x => resolveAssignmentLabel(x.assignmentType, x.assignmentId)).join(", ");
    }
    if (task.assignedEmployeeId) {
      const emp = employees.find(e => e.id === task.assignedEmployeeId);
      return emp?.nickname || emp?.fullName || "Specific employee";
    }
    if (task.assignedTo) return "Advisor";
    if (task.assignedRoleId) return roles.find(r => r.id === task.assignedRoleId)?.name || "Specific role";
    if (task.assignedDepartmentId) return departments.find(d => d.id === task.assignedDepartmentId)?.name || "Specific department";
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
    if (task.assignedEmployeeId) return User;
    if (task.assignedTo) return User;
    if (task.assignedRoleId) return Briefcase;
    if (task.assignedDepartmentId) return Building2;
    return Users;
  };

  const formatDueDate = (dueAt: string) => {
    const date = new Date(dueAt);
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  // Filter tasks based on active tab
  const oneOffTasks = scheduledTasks.filter(t => t.recurrence === "once");
  const recurringTasks = scheduledTasks.filter(t => t.recurrence !== "once");
  const displayedTasks = activeTab === "one-off" ? oneOffTasks : recurringTasks;

  if (isLoading) {
    return (
      <StudioLayout>
        <div className="flex items-center justify-center h-full min-h-[200px]">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </StudioLayout>
    );
  }

  return (
    <StudioLayout>
      <div className="p-6 max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold mb-1">Tasks</h1>
            <p className="text-sm text-muted-foreground">
              Create one-off or recurring tasks with flexible assignments
            </p>
          </div>
          <Button onClick={() => setDialogOpen(true)} data-testid="button-create-scheduled-task">
            <Plus className="h-4 w-4 mr-2" />
            New Task
          </Button>
        </div>

        {/* Tab Navigation */}
        <div className="flex gap-2 mb-4">
          <Button
            variant={activeTab === "one-off" ? "default" : "outline"}
            size="sm"
            onClick={() => handleTabChange("one-off")}
            data-testid="tab-one-off"
          >
            <CalendarDays className="h-4 w-4 mr-2" />
            One-off Tasks
            {oneOffTasks.length > 0 && (
              <Badge variant="secondary" className="ml-2">{oneOffTasks.length}</Badge>
            )}
          </Button>
          <Button
            variant={activeTab === "recurring" ? "default" : "outline"}
            size="sm"
            onClick={() => handleTabChange("recurring")}
            data-testid="tab-recurring"
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            Recurring Tasks
            {recurringTasks.length > 0 && (
              <Badge variant="secondary" className="ml-2">{recurringTasks.length}</Badge>
            )}
          </Button>
        </div>

        {displayedTasks.length > 0 ? (
          <div className="space-y-3">
            {displayedTasks.map((task) => (
              <Card key={task.id} className="hover-elevate overflow-visible" data-testid={`card-scheduled-task-${task.id}`}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <h3 className="font-medium">{task.title}</h3>
                        <Badge variant={task.recurrence === "once" ? "outline" : "secondary"}>
                          {task.recurrence === "once" ? (
                            <CalendarDays className="h-3 w-3 mr-1" />
                          ) : (
                            <RotateCcw className="h-3 w-3 mr-1" />
                          )}
                          {getRecurrenceLabel(task)}
                        </Badge>
                      </div>
                      {task.description && (
                        <p className="text-sm text-muted-foreground mb-2">{task.description}</p>
                      )}
                      <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                        {task.recurrence === "once" && task.dueAt && (
                          <span className="flex items-center gap-1">
                            <CalendarDays className="h-3 w-3" />
                            {formatDueDate(task.dueAt)}
                          </span>
                        )}
                        {task.preferredDueTime && (
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            Due by {task.preferredDueTime}
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          {(() => {
                            const Icon = getAssignmentIcon(task);
                            return <Icon className="h-3 w-3" />;
                          })()}
                          {getAssignmentLabel(task)}
                        </span>
                        {task.requiresPhotoEvidence && (
                          <span className="flex items-center gap-1">
                            <Camera className="h-3 w-3" />
                            Photo required
                          </span>
                        )}
                        {task.requiresResponses && (
                          <span className="flex items-center gap-1">
                            <MessageSquare className="h-3 w-3" />
                            Responses required
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEditDialog(task)}
                        data-testid={`button-edit-${task.id}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDelete(task.id)}
                        data-testid={`button-delete-${task.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card className="p-8 text-center">
            {activeTab === "one-off" ? (
              <CalendarDays className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            ) : (
              <RotateCcw className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            )}
            <h3 className="font-medium mb-2">
              No {activeTab === "one-off" ? "one-off" : "recurring"} tasks
            </h3>
            <p className="text-sm text-muted-foreground mb-4">
              {activeTab === "one-off" 
                ? "Create one-off tasks for specific dates and assignments."
                : "Set up recurring tasks that repeat daily, weekly, or on specific days."}
            </p>
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create Task
            </Button>
          </Card>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingTask ? "Edit Task" : "Create Task"}
            </DialogTitle>
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
                  const rec = v as "once" | "daily" | "weekly";
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
                          : "border-border hover:bg-muted"
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
                <p className="text-xs text-muted-foreground">No branches selected = visible to all branches</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Assign To</Label>
              <AssignmentSearchBar
                value={assignments}
                onChange={setAssignments}
                employees={filteredEmployees}
                advisors={advisors}
                roles={roles}
                departments={departments}
                branches={branches}
                placeholder="Search person, role, dept..."
              />
            </div>

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
                <div className="flex items-center justify-between">
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
                        <div className="flex gap-2">
                          <Select
                            value={question.questionType}
                            onValueChange={(v) => updateQuestion(index, { 
                              questionType: v as TaskQuestion["questionType"],
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
                              placeholder="Option 1&#10;Option 2&#10;Option 3"
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
              <Button variant="outline" onClick={closeDialog}>
                Cancel
              </Button>
              <Button 
                onClick={handleSubmit}
                disabled={createMutation.isPending || updateMutation.isPending}
                data-testid="button-submit-task"
              >
                {(createMutation.isPending || updateMutation.isPending) && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                {editingTask ? "Update" : "Create"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </StudioLayout>
  );
}
