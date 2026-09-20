import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Clock, Play, Eye, PartyPopper, Cake, GraduationCap, CalendarDays, ChevronRight, Check, Circle, Camera, MessageSquare, Upload, X, Info, ClipboardList, Plus, Pencil, Trash2, AlertCircle, User, Briefcase, Building2, Users, MapPin, ImageIcon, Megaphone, ChevronDown, ChevronUp, Wrench } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useBranchContext } from "@/hooks/use-branch-context";
import { useI18n } from "@/lib/i18n";
import { Link, useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { TaskDetailSheet } from "@/components/ops/TaskDetailSheet";
import type { Task, TaskCompletion, TaskQuestion, CoreEvent } from "@shared/schema";

interface StudioEventTaskForToday {
  id: string;
  eventId: string;
  title: string;
  description: string | null;
  dueTime: string | null;
  departmentId: string | null;
  requiresPhotoEvidence: boolean;
  requiresQuestionsAnswered: boolean;
  completed: boolean;
  displayOrder: number;
  eventTitle: string;
  eventStartTime: string | null;
}

interface ChecklistTemplate {
  id: string;
  name: string;
  description: string | null;
  frequency: string;
  scheduledTime: string;
  departments: string[];
  items?: ChecklistTemplateItem[];
}

interface ChecklistTemplateItem {
  id: string;
  templateId: string;
  title: string;
  description: string | null;
  order: number;
}

interface ChecklistRun {
  id: string;
  templateId: string;
  status: "not_started" | "in_progress" | "completed";
  startedAt: Date | null;
  completedAt: Date | null;
}

type Event = CoreEvent & { partyHostName?: string };
import { format, parseISO, formatDistanceToNow } from "date-fns";

interface TaskWithQuestions extends Task {
  questions?: TaskQuestion[];
}

interface ChecklistWithStatus extends ChecklistTemplate {
  todayRun?: ChecklistRun | null;
  computedStatus: "not_started" | "in_progress" | "completed" | "overdue";
  items?: ChecklistTemplateItem[];
}

interface TaskWithCompletion extends Task {
  completion?: TaskCompletion | null;
  completedByName?: string;
}

const eventTypeIcons: Record<string, typeof Cake> = {
  birthday: Cake,
  private_event: PartyPopper,
  school_group: GraduationCap,
  studio_event: CalendarDays,
  other: CalendarDays,
};

export default function TodayPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const { activeBranchId } = useBranchContext();
  const { t } = useI18n();
  const [, setLocation] = useLocation();
  const today = format(new Date(), "yyyy-MM-dd");
  
  const [taskSheetOpen, setTaskSheetOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  
  // Studio event check-in state
  const [checkinEvent, setCheckinEvent] = useState<Event | null>(null);
  const [checkinBookings, setCheckinBookings] = useState<any[]>([]);
  const [checkinTasks, setCheckinTasks] = useState<any[]>([]);
  const [checkinInfoBlocks, setCheckinInfoBlocks] = useState<any[]>([]);
  const [loadingCheckin, setLoadingCheckin] = useState(false);
  
  // Quick task creation state
  const [isQuickTaskOpen, setIsQuickTaskOpen] = useState(false);
  const [quickTaskTitle, setQuickTaskTitle] = useState("");
  const [quickTaskDueTime, setQuickTaskDueTime] = useState("");
  const [quickTaskDepartmentId, setQuickTaskDepartmentId] = useState<string>("");

  const [expandedAnnouncement, setExpandedAnnouncement] = useState<string | null>(null);

  const { data: activeAnnouncements = [] } = useQuery<{
    id: string; title: string; body: string; priority: "info" | "warning" | "urgent";
    startDate: string; endDate: string; showToEveryone: boolean;
  }[]>({
    queryKey: ["/api/announcements/active", activeBranchId],
    queryFn: async () => {
      const params = activeBranchId ? `?branchId=${activeBranchId}` : "";
      const res = await fetch(`/api/announcements/active${params}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!user,
  });

  const branchParam = activeBranchId ? `&branchId=${activeBranchId}` : "";

  const { data: checklists, isLoading } = useQuery<ChecklistWithStatus[]>({
    queryKey: ["/api/checklists/today", activeBranchId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (activeBranchId) params.set("branchId", activeBranchId);
      const res = await fetch(`/api/checklists/today?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch checklists");
      return res.json();
    },
    enabled: !!user,
  });

  const { data: todayEvents } = useQuery<Event[]>({
    queryKey: ["/api/admin/events", { range: "today", branchId: activeBranchId }],
    queryFn: async () => {
      const res = await fetch(`/api/admin/events?range=today${branchParam}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch events");
      return res.json();
    },
    enabled: !!user,
  });

  const { data: todayTasks } = useQuery<TaskWithCompletion[]>({
    queryKey: ["/api/tasks/today", activeBranchId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (activeBranchId) params.set("branchId", activeBranchId);
      const res = await fetch(`/api/tasks/today?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch tasks");
      return res.json();
    },
    enabled: !!user,
  });

  // Studio event tasks for today (informational - completion happens in event view)
  const { data: studioEventTasks } = useQuery<StudioEventTaskForToday[]>({
    queryKey: ["/api/studio-tasks/today", activeBranchId],
    queryFn: async () => {
      const res = await fetch(`/api/studio-tasks/today?${activeBranchId ? `branchId=${activeBranchId}` : ""}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch studio event tasks");
      return res.json();
    },
    enabled: !!user,
  });

  // Departments for quick task assignment
  const { data: departments } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["/api/departments", activeBranchId],
    queryFn: async () => {
      const params = activeBranchId ? `?branchId=${activeBranchId}` : "";
      const res = await fetch(`/api/departments${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch departments");
      return res.json();
    },
    enabled: !!user,
  });

  // Check if this user is a Fix Dept member (to show pending fix reports in Tasks)
  const { data: queueInfo } = useQuery<{ isFixDeptMember: boolean; fixDeptId: string | null; userDeptIds: string[] }>({
    queryKey: ['/api/fix-reports/my-queue-info'],
    queryFn: async () => {
      const res = await fetch('/api/fix-reports/my-queue-info', { credentials: 'include' });
      if (!res.ok) return { isFixDeptMember: false, fixDeptId: null, userDeptIds: [] };
      return res.json();
    },
    enabled: !!user,
  });
  const isFixDeptMember = queueInfo?.isFixDeptMember ?? false;

  interface PendingFixReport { id: string; title?: string | null; location?: string | null; locationNote?: string | null; tags?: string[]; status: string; createdAt: string; }
  const { data: pendingFixReports = [] } = useQuery<PendingFixReport[]>({
    queryKey: ['/api/fix-reports', 'myQueue', 'pending'],
    queryFn: async () => {
      const res = await fetch('/api/fix-reports?myQueue=true', { credentials: 'include' });
      if (!res.ok) return [];
      const all: PendingFixReport[] = await res.json();
      return all.filter(r => r.status !== 'done' && r.status !== 'completed');
    },
    enabled: !!user && isFixDeptMember,
  });

  const startChecklistMutation = useMutation({
    mutationFn: async (templateId: string) => {
      const res = await apiRequest("POST", "/api/checklist-runs/start", { templateId, branchId: activeBranchId });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/checklists/today"] });
      setLocation(`/core/checklist/${data.id}`);
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to start checklist",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const createQuickTaskMutation = useMutation({
    mutationFn: async (data: { title: string; dueAt?: string; branchId?: string; assignedDepartmentId?: string }) => {
      return apiRequest("POST", "/api/core/tasks", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks/today"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks"] });
      toast({ title: "Task created" });
      setIsQuickTaskOpen(false);
      setQuickTaskTitle("");
      setQuickTaskDueTime("");
      setQuickTaskDepartmentId("");
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to create task",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleQuickTaskCreate = () => {
    if (!quickTaskTitle.trim()) {
      toast({ title: "Please enter a task title", variant: "destructive" });
      return;
    }
    if (!activeBranchId) {
      toast({ title: "Please select a branch first", variant: "destructive" });
      return;
    }
    const dueAt = quickTaskDueTime ? `${today}T${quickTaskDueTime}` : undefined;
    createQuickTaskMutation.mutate({
      title: quickTaskTitle.trim(),
      dueAt,
      branchId: activeBranchId,
      assignedDepartmentId: quickTaskDepartmentId || undefined,
    });
  };

  const openTaskSheet = (task: TaskWithCompletion) => {
    setSelectedTaskId(task.id);
    setTaskSheetOpen(true);
  };

  // Studio event check-in handlers
  const openCheckinDialog = async (event: Event) => {
    setCheckinEvent(event);
    setCheckinBookings([]);
    setCheckinTasks([]);
    setCheckinInfoBlocks([]);
    setLoadingCheckin(true);
    
    try {
      // Fetch bookings, tasks, info blocks, and event details in parallel
      const [bookingsRes, tasksRes, infoRes, detailsRes] = await Promise.all([
        fetch(`/api/events/${event.id}/bookings`, { credentials: "include" }),
        fetch(`/api/events/${event.id}/studio-tasks`, { credentials: "include" }),
        fetch(`/api/events/${event.id}/info-blocks`, { credentials: "include" }),
        fetch(`/api/events/${event.id}/details`, { credentials: "include" }),
      ]);
      
      if (bookingsRes.ok) {
        const bookings = await bookingsRes.json();
        setCheckinBookings(bookings);
      }
      if (tasksRes.ok) {
        const tasks = await tasksRes.json();
        setCheckinTasks(tasks);
      }
      if (infoRes.ok) {
        const infoBlocks = await infoRes.json();
        setCheckinInfoBlocks(infoBlocks);
      }
      if (detailsRes.ok) {
        const details = await detailsRes.json();
        // Merge details into the event (description, location from studio_event_details)
        setCheckinEvent(prev => prev ? { ...prev, description: details.description, location: details.location } : null);
      }
    } catch (error) {
      toast({ title: "Failed to load event details", variant: "destructive" });
    } finally {
      setLoadingCheckin(false);
    }
  };

  const toggleBookingArrival = async (bookingId: string, currentArrived: boolean) => {
    try {
      const res = await apiRequest("PATCH", `/api/bookings/${bookingId}`, {
        arrived: !currentArrived,
      });
      if (res.ok) {
        const updated = await res.json();
        setCheckinBookings(prev => prev.map(b => b.id === bookingId ? updated : b));
        toast({ title: currentArrived ? "Check-in removed" : "Checked in" });
      }
    } catch (error) {
      toast({ title: "Failed to update check-in", variant: "destructive" });
    }
  };

  const toggleCheckinTaskCompletion = async (taskId: string, currentCompleted: boolean) => {
    try {
      const res = await apiRequest("PATCH", `/api/studio-tasks/${taskId}/complete`, {
        completed: !currentCompleted,
      });
      if (res.ok) {
        setCheckinTasks(prev => prev.map(t => t.id === taskId ? { ...t, completed: !currentCompleted } : t));
        toast({ title: currentCompleted ? "Task uncompleted" : "Task completed" });
      }
    } catch (error) {
      toast({ title: "Failed to update task", variant: "destructive" });
    }
  };

  const getActionButton = (checklist: ChecklistWithStatus) => {
    if (!checklist.todayRun) {
      return (
        <Button
          className="h-10"
          onClick={() => startChecklistMutation.mutate(checklist.id)}
          disabled={startChecklistMutation.isPending}
          data-testid={`button-start-${checklist.id}`}
        >
          <Play className="mr-2 h-4 w-4" />
          Start
        </Button>
      );
    }

    if (checklist.todayRun.status === "in_progress") {
      return (
        <Link href={`/core/checklist/${checklist.todayRun.id}`}>
          <Button className="h-10" data-testid={`button-continue-${checklist.id}`}>
            <Play className="mr-2 h-4 w-4" />
            Continue
          </Button>
        </Link>
      );
    }

    return (
      <Link href={`/core/checklist/${checklist.todayRun.id}`}>
        <Button variant="secondary" className="h-10" data-testid={`button-view-${checklist.id}`}>
          <Eye className="mr-2 h-4 w-4" />
          View
        </Button>
      </Link>
    );
  };

  if (isLoading) {
    return (
      <AppLayout>
        <LoadingScreen />
      </AppLayout>
    );
  }

  // Sort tasks: overdue → today → future, within each bucket by dueAt ascending (nulls last)
  const pendingTasks = (todayTasks?.filter(t => !t.completion) || []).sort((a, b) => {
    const nowBangkok = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
    const [y, m, d] = nowBangkok.split('-').map(Number);
    const todayStartMs = Date.UTC(y, m - 1, d, -7, 0, 0, 0); // Bangkok midnight in UTC
    const todayEndMs = Date.UTC(y, m - 1, d + 1, -7, 0, 0, 0);
    const FAR_FUTURE = 9999999999999;

    const getBucket = (task: any) => {
      if (!task.dueAt) return 2; // no due date → future bucket
      const ms = new Date(task.dueAt).getTime();
      if (ms < todayStartMs) return 0; // overdue
      if (ms < todayEndMs) return 1;   // today
      return 2;                         // future
    };
    const bucketA = getBucket(a);
    const bucketB = getBucket(b);
    if (bucketA !== bucketB) return bucketA - bucketB;
    const msA = a.dueAt ? new Date(a.dueAt).getTime() : FAR_FUTURE;
    const msB = b.dueAt ? new Date(b.dueAt).getTime() : FAR_FUTURE;
    return msA - msB;
  });
  const completedTasks = (todayTasks?.filter(t => t.completion) || []).sort((a, b) => {
    const dateA = a.completion?.completedAt ? new Date(a.completion.completedAt).getTime() : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
    const dateB = b.completion?.completedAt ? new Date(b.completion.completedAt).getTime() : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
    return dateB - dateA;
  });
  
  // Sort checklists: overdue → today → future, within bucket by scheduled time ascending
  const sortedChecklists = (checklists || []).slice().sort((a, b) => {
    const getBucket = (c: ChecklistWithStatus) => {
      if (c.computedStatus === 'overdue') return 0;
      if (c.computedStatus === 'not_started' || c.computedStatus === 'in_progress') {
        // Check if scheduled time has passed today → overdue bucket
        if (c.scheduledTime) {
          const now = new Date();
          const [h, m] = c.scheduledTime.split(':').map(Number);
          const due = new Date();
          due.setHours(h, m, 0, 0);
          if (now > due) return 0;
        }
        return 1; // today bucket
      }
      return 2; // completed or future
    };
    const bucketA = getBucket(a);
    const bucketB = getBucket(b);
    if (bucketA !== bucketB) return bucketA - bucketB;
    // Within bucket, sort by scheduled time ascending (no time → end of bucket)
    const timeToNum = (t: string | null | undefined) => {
      if (!t) return 9999;
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };
    return timeToNum(a.scheduledTime) - timeToNum(b.scheduledTime);
  });

  // Debug logging for render state
  console.log("[DEBUG Today] Render state:", {
    user: !!user,
    activeBranchId,
    isLoading,
    todayTasks: todayTasks?.length ?? 'undefined',
    pendingTasks: pendingTasks.length,
    completedTasks: completedTasks.length,
    checklists: checklists?.length ?? 'undefined',
  });

  return (
    <AppLayout>
      <div className="p-4 max-w-lg mx-auto">
        <div className="mb-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold">Today</h1>
              <p className="text-sm text-muted-foreground">
                {new Date().toLocaleDateString("en-GB", { 
                  weekday: "long", 
                  day: "numeric",
                  month: "long" 
                })}
              </p>
            </div>
          </div>
        </div>

        {activeAnnouncements.length > 0 && (
          <div className="space-y-2 mb-6" data-testid="announcements-banner-area">
            {activeAnnouncements.map((ann) => {
              const isExpanded = expandedAnnouncement === ann.id;
              const colorMap: Record<string, { bg: string; border: string; icon: string; text: string }> = {
                urgent: {
                  bg: "bg-red-50 dark:bg-red-950/40",
                  border: "border-red-300 dark:border-red-800",
                  icon: "text-red-600 dark:text-red-400",
                  text: "text-red-900 dark:text-red-100",
                },
                warning: {
                  bg: "bg-amber-50 dark:bg-amber-950/40",
                  border: "border-amber-300 dark:border-amber-800",
                  icon: "text-amber-600 dark:text-amber-400",
                  text: "text-amber-900 dark:text-amber-100",
                },
                info: {
                  bg: "bg-blue-50 dark:bg-blue-950/40",
                  border: "border-blue-300 dark:border-blue-800",
                  icon: "text-blue-600 dark:text-blue-400",
                  text: "text-blue-900 dark:text-blue-100",
                },
              };
              const colors = colorMap[ann.priority] || colorMap.info;
              return (
                <div
                  key={ann.id}
                  className={`rounded-md border ${colors.bg} ${colors.border} p-3 cursor-pointer`}
                  onClick={() => setExpandedAnnouncement(isExpanded ? null : ann.id)}
                  data-testid={`announcement-banner-${ann.id}`}
                >
                  <div className="flex items-start gap-2.5">
                    <Megaphone className={`h-4 w-4 mt-0.5 shrink-0 ${colors.icon}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`font-semibold text-sm ${colors.text}`}>{ann.title}</span>
                        {ann.priority === "urgent" && (
                          <Badge className="bg-red-500 text-white border-red-600 text-[10px] px-1.5 py-0">Urgent</Badge>
                        )}
                      </div>
                      {isExpanded ? (
                        <p className={`text-sm mt-1 whitespace-pre-wrap ${colors.text} opacity-80`}>{ann.body}</p>
                      ) : (
                        <p className={`text-sm mt-0.5 truncate ${colors.text} opacity-70`}>{ann.body}</p>
                      )}
                    </div>
                    <div className="shrink-0 mt-0.5">
                      {isExpanded ? (
                        <ChevronUp className={`h-4 w-4 ${colors.icon}`} />
                      ) : (
                        <ChevronDown className={`h-4 w-4 ${colors.icon}`} />
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="space-y-4 mb-8">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">{t.today.eventsToday}</h2>
            <Link href="/core/events">
              <Button variant="ghost" size="sm" className="text-muted-foreground">
                {t.common.viewAll}
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </Link>
          </div>
          {!todayEvents || todayEvents.length === 0 ? (
            <Card className="p-4">
              <p className="text-sm text-muted-foreground text-center">{t.today.noEventsToday}</p>
            </Card>
          ) : (
            <div className="space-y-2">
              {todayEvents.slice(0, 3).map((event) => {
                const Icon = eventTypeIcons[event.eventType] || CalendarDays;
                const isStudioEvent = event.eventType === "studio_event";
                
                const cardContent = (
                  <Card className="hover-elevate active-elevate-2 cursor-pointer overflow-visible" data-testid={`card-today-event-${event.id}`}>
                    <CardContent className="p-3">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-md bg-primary/10">
                          <Icon className="h-4 w-4 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium text-sm truncate">{event.title}</h4>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Clock className="h-3 w-3" />
                            <span>{event.startTime}{event.endTime && ` - ${event.endTime}`}</span>
                            {event.numChildren && (
                              <span className="ml-2">{event.numChildren} {t.events.children.toLowerCase()}</span>
                            )}
                          </div>
                          {event.partyHostName && (
                            <div className="flex items-center gap-1 text-xs mt-0.5">
                              <User className="h-3 w-3 text-pink-500" />
                              <span className="text-pink-600 dark:text-pink-400">Party Host: {event.partyHostName}</span>
                            </div>
                          )}
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      </div>
                    </CardContent>
                  </Card>
                );
                
                // Studio events open check-in dialog, other events navigate to detail page
                if (isStudioEvent) {
                  return (
                    <div key={event.id} onClick={() => openCheckinDialog(event)} data-testid={`checkin-trigger-${event.id}`}>
                      {cardContent}
                    </div>
                  );
                }
                
                return (
                  <Link key={event.id} href={`/core/events/${event.id}`}>
                    {cardContent}
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-4 mb-8">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">Tasks</h2>
            <div className="flex items-center gap-1">
              <Button 
                size="icon" 
                variant="ghost"
                className="h-8 w-8" 
                onClick={() => setIsQuickTaskOpen(true)}
                data-testid="button-quick-task"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {pendingTasks.length === 0 && (!studioEventTasks || studioEventTasks.length === 0) && pendingFixReports.length === 0 ? (
            <Card className="p-4">
              <p className="text-sm text-muted-foreground text-center">No pending tasks for today.</p>
            </Card>
          ) : (
            <div className="space-y-2">
              {/* Pending fix reports for Fix Dept members */}
              {pendingFixReports.map((report) => {
                const statusLabel = report.status === 'new' || report.status === 'pending' ? 'Pending'
                  : report.status === 'in_progress' || report.status === 'acknowledged' ? 'In Progress'
                  : report.status === 'scheduled' ? 'Scheduled'
                  : report.status;
                const locationText = report.location || report.locationNote;
                return (
                  <Link key={`fix-${report.id}`} href="/core/fix-board" data-testid={`card-fix-report-${report.id}`}>
                    <Card className="overflow-visible hover-elevate">
                      <CardContent className="p-3">
                        <div className="flex items-center gap-3">
                          <div className="h-9 w-9 flex items-center justify-center shrink-0">
                            <Wrench className="h-5 w-5 text-amber-500" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h4 className="font-medium text-sm">{report.title || "Fix Report"}</h4>
                              <Badge variant="outline" className="text-xs">{statusLabel}</Badge>
                            </div>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                              {locationText && (
                                <span className="flex items-center gap-1">
                                  <MapPin className="h-3 w-3" />
                                  {locationText}
                                </span>
                              )}
                              {report.tags?.[0] && (
                                <Badge variant="secondary" className="text-xs">{report.tags[0]}</Badge>
                              )}
                              <span className="flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                {formatDistanceToNow(parseISO(report.createdAt), { addSuffix: true })}
                              </span>
                            </div>
                          </div>
                          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                );
              })}
              {pendingTasks.map((task) => {
                // Calculate days overdue based on dueAt date
                const getDaysOverdue = () => {
                  if (!task.dueAt) return 0;
                  const nowBangkok = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
                  const todayStart = new Date(nowBangkok);
                  todayStart.setHours(0, 0, 0, 0);
                  const dueDate = new Date(task.dueAt);
                  const dueDateBangkok = new Date(dueDate.toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
                  dueDateBangkok.setHours(0, 0, 0, 0);
                  const diffTime = todayStart.getTime() - dueDateBangkok.getTime();
                  return Math.floor(diffTime / (1000 * 60 * 60 * 24));
                };
                const daysOverdue = getDaysOverdue();
                const isOverdue = daysOverdue > 0 || (daysOverdue === 0 && task.dueTime && (() => {
                  const now = new Date();
                  const [hours, minutes] = task.dueTime.split(':').map(Number);
                  const dueTime = new Date();
                  dueTime.setHours(hours, minutes, 0, 0);
                  return now > dueTime;
                })());

                const getAssignment = () => {
                  const assignments = (task as any).assignments as Array<{ assignmentType: string; label: string }> | undefined;
                  if (assignments && assignments.length > 0) {
                    const label = assignments.length === 1 ? assignments[0].label : assignments.map(x => x.label).join(", ");
                    if (assignments.length === 1) {
                      const t = assignments[0].assignmentType;
                      if (t === "employee" || t === "advisor") return { icon: User, label };
                      if (t === "role") return { icon: Briefcase, label };
                      if (t === "department") return { icon: Building2, label };
                      if (t === "branch") return { icon: MapPin, label };
                    }
                    return { icon: Users, label };
                  }
                  const assignee = (task as any).assignee;
                  if (assignee) {
                    switch (assignee.type) {
                      case "employee":
                      case "user":
                        return { icon: User, label: assignee.label };
                      case "role":
                        return { icon: Briefcase, label: assignee.label };
                      case "department":
                        return { icon: Building2, label: assignee.label };
                      case "unassigned":
                      default:
                        return { icon: Users, label: "Everyone" };
                    }
                  }
                  if ((task as any).assignedUserName) return { icon: User, label: (task as any).assignedUserName };
                  if ((task as any).assignedRoleName) return { icon: Briefcase, label: (task as any).assignedRoleName };
                  if ((task as any).assignedDepartmentName) return { icon: Building2, label: (task as any).assignedDepartmentName };
                  return { icon: Users, label: "Everyone" };
                };
                const assignment = getAssignment();
                const AssignmentIcon = assignment.icon;

                return (
                  <Card 
                    key={task.id} 
                    className={`overflow-visible hover-elevate active-elevate-2 cursor-pointer ${isOverdue ? "border-red-400/50 border" : ""}`}
                    onClick={() => openTaskSheet(task)}
                    data-testid={`card-task-${task.id}`}
                  >
                    <CardContent className="p-3">
                      <div className="flex items-center gap-3">
                        <div className="h-9 w-9 flex items-center justify-center shrink-0">
                          {isOverdue ? (
                            <AlertCircle className="h-5 w-5 text-red-500" />
                          ) : (
                            <Circle className="h-5 w-5 text-muted-foreground" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h4 className="font-medium text-sm">{task.title}</h4>
                          </div>
                          <div className="flex items-center gap-2 text-xs flex-wrap text-muted-foreground">
                            {/* For scheduled tasks, show date range */}
                            {(task as any).scheduledMode && (task as any).startAt && task.dueAt ? (
                              <span className="flex items-center gap-1">
                                <CalendarDays className="h-3 w-3" />
                                {format(new Date((task as any).startAt), "d MMM")} → {format(new Date(task.dueAt), "d MMM")}
                              </span>
                            ) : task.dueAt ? (
                              <span className="flex items-center gap-1">
                                <CalendarDays className="h-3 w-3" />
                                {format(new Date(task.dueAt), "d MMM")}
                                {task.dueTime && ` at ${task.dueTime}`}
                              </span>
                            ) : null}
                            {/* Show due status */}
                            {(() => {
                              if (daysOverdue > 0) {
                                return (
                                  <span className="text-red-500 flex items-center gap-1 font-medium">
                                    <Clock className="h-3 w-3" />
                                    {daysOverdue}d
                                  </span>
                                );
                              } else if (daysOverdue === 0) {
                                return (
                                  <span className="text-amber-500 flex items-center gap-1">
                                    <Clock className="h-3 w-3" />
                                    Today
                                  </span>
                                );
                              } else {
                                return (
                                  <span className="flex items-center gap-1">
                                    <Clock className="h-3 w-3" />
                                    {Math.abs(daysOverdue)} day{Math.abs(daysOverdue) !== 1 ? 's' : ''}
                                  </span>
                                );
                              }
                            })()}
                            <span className="flex items-center gap-1">
                              <AssignmentIcon className="h-3 w-3" />
                              <span>{assignment.label}</span>
                            </span>
                            {task.requiresPhotoEvidence && (
                              <Badge variant="outline" className="text-xs px-1.5">
                                <Camera className="h-3 w-3" />
                              </Badge>
                            )}
                            {task.requiresResponses && (
                              <Badge variant="outline" className="text-xs px-1.5">
                                <MessageSquare className="h-3 w-3" />
                              </Badge>
                            )}
                          </div>
                          {/* Progress bar for scheduled tasks with expected today line */}
                          {(task as any).scheduledMode && (task as any).startAt && (() => {
                            const startAt = new Date((task as any).startAt);
                            const dueAt = task.dueAt ? new Date(task.dueAt) : new Date();
                            const todayDate = new Date();
                            todayDate.setHours(0, 0, 0, 0);
                            const startDay = new Date(startAt);
                            startDay.setHours(0, 0, 0, 0);
                            const dueDay = new Date(dueAt);
                            dueDay.setHours(0, 0, 0, 0);
                            const totalDays = Math.max(1, Math.ceil((dueDay.getTime() - startDay.getTime()) / (1000 * 60 * 60 * 24)) + 1);
                            const elapsedDays = Math.max(0, Math.ceil((todayDate.getTime() - startDay.getTime()) / (1000 * 60 * 60 * 24)) + 1);
                            const expectedPercent = Math.min(100, Math.max(0, (elapsedDays / totalDays) * 100));
                            const progress = (task as any).progressPercent || 0;
                            return (
                              <div className="mt-2 flex items-center gap-2">
                                <div className="relative flex-1 h-1.5 rounded-full bg-muted">
                                  <div 
                                    className="absolute top-0 left-0 h-full bg-primary rounded-full"
                                    style={{ width: `${progress}%` }}
                                  />
                                  {expectedPercent > 0 && expectedPercent < 100 && (
                                    <div
                                      className="absolute top-[-2px] bottom-[-2px] w-0.5 bg-red-500"
                                      style={{ left: `${expectedPercent}%`, transform: 'translateX(-50%)' }}
                                    />
                                  )}
                                </div>
                                <span className="text-xs text-muted-foreground w-8 text-right">{progress}%</span>
                              </div>
                            );
                          })()}
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
              {/* Studio Event Tasks - informational, complete via event view */}
              {studioEventTasks?.map((task) => (
                <Link 
                  key={`studio-${task.id}`} 
                  href="/studio/events"
                  data-testid={`card-studio-task-${task.id}`}
                >
                  <Card className="overflow-visible hover-elevate">
                    <CardContent className="p-3">
                      <div className="flex items-center gap-3">
                        <div className="h-9 w-9 flex items-center justify-center shrink-0">
                          <CalendarDays className="h-5 w-5 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium text-sm">{task.title}</h4>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                            <Badge variant="secondary" className="text-xs">{task.eventTitle}</Badge>
                            {task.dueTime && (
                              <>
                                <Clock className="h-3 w-3" />
                                <span>by {task.dueTime}</span>
                              </>
                            )}
                            {task.requiresPhotoEvidence && (
                              <Badge variant="outline" className="text-xs">
                                <Camera className="h-2.5 w-2.5 mr-0.5" />
                                Photo
                              </Badge>
                            )}
                          </div>
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-4 mb-8">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-semibold">Checklists</h2>
          </div>
          {sortedChecklists.filter(c => c.computedStatus !== 'completed').length === 0 ? (
            <EmptyState
              title="No checklists"
              description={sortedChecklists.length > 0 ? "All checklists completed for today!" : "There are no checklists assigned for today."}
            />
          ) : (
            sortedChecklists.filter(c => c.computedStatus !== 'completed').map((checklist) => {
              // Check if checklist is overdue
              const isOverdue = checklist.computedStatus === 'overdue' || (checklist.scheduledTime && checklist.computedStatus !== 'completed' && (() => {
                const now = new Date();
                const [hours, minutes] = checklist.scheduledTime.split(':').map(Number);
                const dueTime = new Date();
                dueTime.setHours(hours, minutes, 0, 0);
                return now > dueTime;
              })());

              // Determine assignment display
              const getAssignment = () => {
                if ((checklist as any).assignedEmployeeName) return { icon: User, label: (checklist as any).assignedEmployeeName };
                if ((checklist as any).assignedRoleName) return { icon: Briefcase, label: (checklist as any).assignedRoleName };
                if ((checklist as any).assignedDepartmentName) return { icon: Building2, label: (checklist as any).assignedDepartmentName };
                return { icon: Users, label: "Everyone" };
              };
              const assignment = getAssignment();
              const AssignmentIcon = assignment.icon;

              return (
                <Card key={checklist.id} className={`overflow-visible ${isOverdue ? "border-red-400/50 border" : ""}`} data-testid={`card-checklist-${checklist.id}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <h3 className="font-semibold">{checklist.name}</h3>
                          <StatusBadge status={checklist.computedStatus} />
                        </div>
                        <div className="flex items-center gap-2 text-sm flex-wrap text-muted-foreground">
                          <span className={isOverdue ? "text-red-500 flex items-center gap-1" : "flex items-center gap-1"}>
                            <Clock className="h-3.5 w-3.5" />
                            {(checklist as any).checklistType === 'checker' 
                              ? ((checklist as any).scheduleTime1 || checklist.scheduledTime || 'End of day')
                              : (checklist.scheduledTime || 'End of day')}
                          </span>
                          <span className="flex items-center gap-1">
                            <AssignmentIcon className="h-3.5 w-3.5" />
                            <span>{assignment.label}</span>
                          </span>
                          {(checklist as any).locationName && (
                            <Badge variant="outline" className="text-xs flex items-center gap-1">
                              <MapPin className="h-3 w-3" />
                              {(checklist as any).locationName}
                            </Badge>
                          )}
                          {(checklist as any).requiresPhotoEvidence && (
                            <Badge variant="secondary" className="text-xs flex items-center gap-1">
                              <Camera className="h-3 w-3" />
                              Photo Required
                            </Badge>
                          )}
                        </div>
                        {checklist.description && (
                          <p className="text-sm text-muted-foreground mt-1">{checklist.description}</p>
                        )}
                      </div>
                      <div className="shrink-0">
                        {getActionButton(checklist)}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      </div>

      <TaskDetailSheet
        open={taskSheetOpen}
        onOpenChange={setTaskSheetOpen}
        taskId={selectedTaskId}
      />

      {/* Studio Event Check-in Dialog */}
      <Dialog open={!!checkinEvent} onOpenChange={(open) => !open && setCheckinEvent(null)}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{checkinEvent?.title}</DialogTitle>
            <DialogDescription>
              {checkinEvent?.eventDate && (
                <span>
                  {format(parseISO(checkinEvent.eventDate), "MMMM d, yyyy")} at {checkinEvent.startTime}{checkinEvent.endTime && ` - ${checkinEvent.endTime}`}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>

          {loadingCheckin ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
            </div>
          ) : (
            <div className="space-y-6">
              {/* Event Details */}
              {(checkinEvent?.location || checkinEvent?.description) && (
                <div className="space-y-2">
                  {checkinEvent.location && (
                    <p className="text-sm">
                      <span className="text-muted-foreground">Location:</span> {checkinEvent.location}
                    </p>
                  )}
                  {checkinEvent.description && (
                    <p className="text-sm text-muted-foreground">{checkinEvent.description}</p>
                  )}
                </div>
              )}

              {/* Info Blocks */}
              {checkinInfoBlocks.length > 0 && (
                <div className="space-y-2">
                  {checkinInfoBlocks.map((block: any) => (
                    <div key={block.id} className="p-3 border rounded-md bg-muted/20" data-testid={`info-block-${block.id}`}>
                      <p className="font-medium text-sm">{block.title}</p>
                      {block.description && <p className="text-sm text-muted-foreground mt-1">{block.description}</p>}
                    </div>
                  ))}
                </div>
              )}

              {/* Tasks */}
              {checkinTasks.length > 0 && (
                <div className="space-y-3">
                  <h4 className="font-medium text-sm flex items-center gap-2">
                    <ClipboardList className="h-4 w-4" />
                    Tasks ({checkinTasks.filter(t => t.completed).length}/{checkinTasks.length})
                  </h4>
                  <div className="space-y-2">
                    {checkinTasks.map((task: any) => (
                      <div 
                        key={task.id} 
                        className={`flex items-center gap-3 p-3 border rounded-md ${task.completed ? "bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800" : ""}`}
                        data-testid={`checkin-task-${task.id}`}
                      >
                        <Switch
                          checked={task.completed}
                          onCheckedChange={() => toggleCheckinTaskCompletion(task.id, task.completed)}
                          data-testid={`switch-task-${task.id}`}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium flex items-center gap-2">
                            {task.title}
                            {task.completed && <Check className="h-3 w-3 text-green-600" />}
                          </div>
                          {task.dueTime && (
                            <span className="text-xs text-muted-foreground">at {task.dueTime}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Guest List */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-medium text-sm">
                    Guest List ({checkinBookings.filter(b => b.arrived).length}/{checkinBookings.length} arrived)
                  </h4>
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    className="h-8 gap-1"
                    onClick={() => {
                      setCheckinEvent(null);
                      setLocation(`/studio/events?view=${checkinEvent?.id}&addBooking=true`);
                    }}
                    data-testid="button-add-booking-checkin"
                  >
                    <Plus className="h-4 w-4" />
                    Add
                  </Button>
                </div>

                {/* Summary Stats */}
                {checkinBookings.length > 0 && (
                  <div className="border rounded-md p-3">
                    <div className="grid grid-cols-3 gap-4 text-center mb-3">
                      <div>
                        <div className="text-xl font-bold">{checkinBookings.reduce((sum, b) => sum + (b.adultsCount || 0), 0)}</div>
                        <div className="text-xs text-muted-foreground">Adults</div>
                      </div>
                      <div>
                        <div className="text-xl font-bold">{checkinBookings.reduce((sum, b) => sum + (b.kidsCount || 0), 0)}</div>
                        <div className="text-xs text-muted-foreground">Kids</div>
                      </div>
                      <div>
                        <div className="text-xl font-bold">{checkinBookings.reduce((sum, b) => sum + (b.adultsCount || 0) + (b.kidsCount || 0), 0)}</div>
                        <div className="text-xs text-muted-foreground">Total Guests</div>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-4 text-center">
                      <div>
                        <div className="text-xl font-bold">{checkinBookings.reduce((sum, b) => sum + (b.totalAmount || 0), 0).toLocaleString()}</div>
                        <div className="text-xs text-muted-foreground">Total (THB)</div>
                      </div>
                      <div>
                        <div className="text-xl font-bold text-green-600">{checkinBookings.reduce((sum, b) => sum + (b.paidAmount || 0), 0).toLocaleString()}</div>
                        <div className="text-xs text-muted-foreground">Paid</div>
                      </div>
                      <div>
                        <div className={`text-xl font-bold ${checkinBookings.reduce((sum, b) => sum + ((b.totalAmount || 0) - (b.paidAmount || 0)), 0) > 0 ? "text-orange-500" : "text-green-600"}`}>
                          {checkinBookings.reduce((sum, b) => sum + ((b.totalAmount || 0) - (b.paidAmount || 0)), 0).toLocaleString()}
                        </div>
                        <div className="text-xs text-muted-foreground">Outstanding</div>
                      </div>
                    </div>
                  </div>
                )}

                {checkinBookings.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">No bookings for this event.</p>
                ) : (
                  <div className="space-y-2">
                    {checkinBookings.map((booking) => (
                      <div 
                        key={booking.id} 
                        className={`p-3 border rounded-md ${booking.arrived ? "bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800" : ""}`}
                        data-testid={`checkin-card-${booking.id}`}
                      >
                        <div className="flex items-start gap-3">
                          <Switch
                            checked={booking.arrived}
                            onCheckedChange={() => toggleBookingArrival(booking.id, booking.arrived)}
                            className="mt-1"
                            data-testid={`switch-arrival-${booking.id}`}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between">
                              <span className="font-medium">{booking.bookingName || booking.name}</span>
                              <div className="flex items-center gap-1">
                                <Button 
                                  variant="ghost" 
                                  size="icon" 
                                  className="h-7 w-7"
                                  onClick={() => {
                                    setCheckinEvent(null);
                                    setLocation(`/studio/events?view=${checkinEvent?.id}&editBooking=${booking.id}`);
                                  }}
                                  data-testid={`button-edit-booking-${booking.id}`}
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button 
                                  variant="ghost" 
                                  size="icon" 
                                  className="h-7 w-7 text-destructive hover:text-destructive"
                                  onClick={() => {
                                    setCheckinEvent(null);
                                    setLocation(`/studio/events?view=${checkinEvent?.id}&deleteBooking=${booking.id}`);
                                  }}
                                  data-testid={`button-delete-booking-${booking.id}`}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                            <div className="text-sm text-muted-foreground">
                              {booking.adultsCount || 0} adults, {booking.kidsCount || 0} kids
                              {booking.phone && <span className="ml-2">{booking.phone}</span>}
                            </div>
                            <div className="text-sm mt-1">
                              <span>Total: {(booking.totalAmount || 0).toLocaleString()} THB</span>
                              {(booking.paidAmount || 0) > 0 && (
                                <span className="ml-2 text-green-600">Paid: {booking.paidAmount?.toLocaleString()}</span>
                              )}
                              {((booking.totalAmount || 0) - (booking.paidAmount || 0)) > 0 && (
                                <span className="ml-2 text-orange-500">Due: {((booking.totalAmount || 0) - (booking.paidAmount || 0)).toLocaleString()}</span>
                              )}
                            </div>
                            {booking.posReference && (
                              <div className="text-xs text-muted-foreground mt-1">POS: {booking.posReference}</div>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="flex justify-end mt-4">
            <Button variant="outline" onClick={() => setCheckinEvent(null)} data-testid="button-close-checkin">
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={isQuickTaskOpen} onOpenChange={setIsQuickTaskOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Quick Task</DialogTitle>
            <DialogDescription>
              Add a simple task for today
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="quickTaskTitle">What needs to be done? *</Label>
              <Input
                id="quickTaskTitle"
                value={quickTaskTitle}
                onChange={(e) => setQuickTaskTitle(e.target.value)}
                placeholder="e.g., Check inventory, Clean tables..."
                autoFocus
                data-testid="input-quick-task-title"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="quickTaskDueTime">Due Time (optional)</Label>
              <Input
                id="quickTaskDueTime"
                type="time"
                value={quickTaskDueTime}
                onChange={(e) => setQuickTaskDueTime(e.target.value)}
                data-testid="input-quick-task-time"
              />
            </div>
            {departments && departments.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="quickTaskDepartment">Assign to Department (optional)</Label>
                <Select value={quickTaskDepartmentId || "all"} onValueChange={(val) => setQuickTaskDepartmentId(val === "all" ? "" : val)}>
                  <SelectTrigger data-testid="select-quick-task-department">
                    <SelectValue placeholder="All departments (visible to everyone)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All departments</SelectItem>
                    {departments.map((dept) => (
                      <SelectItem key={dept.id} value={dept.id}>{dept.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Tasks assigned to a department are only visible to that department</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsQuickTaskOpen(false);
                setQuickTaskTitle("");
                setQuickTaskDueTime("");
                setQuickTaskDepartmentId("");
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleQuickTaskCreate}
              disabled={createQuickTaskMutation.isPending || !quickTaskTitle.trim()}
              data-testid="button-create-quick-task"
            >
              {createQuickTaskMutation.isPending ? "Creating..." : "Add Task"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
