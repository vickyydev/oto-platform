import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  ClipboardCheck, 
  AlertCircle, 
  AlertTriangle, 
  CheckCircle,
  Clock,
  User,
  Calendar,
  ListTodo,
  PartyPopper,
  Phone,
  MessageSquare,
  Camera,
  MapPin,
  X,
  Users,
  CalendarDays
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { format, subDays, startOfMonth, startOfWeek, endOfWeek } from "date-fns";
import type { ChecklistRun, Issue, Escalation, User as UserType, Task, Event } from "@shared/schema";
import { cn } from "@/lib/utils";

type DateRangePreset = "today" | "yesterday" | "last7days" | "last30days" | "thisMonth" | "thisWeek";

const dateRangePresets: { value: DateRangePreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "thisWeek", label: "This Week" },
  { value: "last7days", label: "Last 7 Days" },
  { value: "last30days", label: "Last 30 Days" },
  { value: "thisMonth", label: "This Month" },
];

function getDateRange(preset: DateRangePreset): { startDate: string; endDate: string } {
  const today = new Date();
  const formatDate = (d: Date) => format(d, "yyyy-MM-dd");
  
  switch (preset) {
    case "today":
      return { startDate: formatDate(today), endDate: formatDate(today) };
    case "yesterday":
      const yesterday = subDays(today, 1);
      return { startDate: formatDate(yesterday), endDate: formatDate(yesterday) };
    case "thisWeek":
      return { startDate: formatDate(startOfWeek(today)), endDate: formatDate(endOfWeek(today)) };
    case "last7days":
      return { startDate: formatDate(subDays(today, 6)), endDate: formatDate(today) };
    case "last30days":
      return { startDate: formatDate(subDays(today, 29)), endDate: formatDate(today) };
    case "thisMonth":
      return { startDate: formatDate(startOfMonth(today)), endDate: formatDate(today) };
  }
}

interface DashboardStats {
  checklistsCompleted: number;
  checklistsInProgress: number;
  checklistsOverdue: number;
  openIssues: number;
  openEscalations: number;
}

interface ChecklistRunWithDetails extends ChecklistRun {
  startedBy: UserType;
  template: { name: string };
}

interface IssueWithDetails extends Issue {
  createdBy: UserType;
}

interface EscalationWithDetails extends Escalation {
  createdBy: UserType;
}

interface TaskWithCompletion extends Task {
  completion?: {
    id: string;
    completedById: string;
    completedAt: string;
    photoUrls?: string[];
    responses?: { questionId: string; response: string | boolean }[];
  };
  completedByName?: string;
  questions?: { id: string; prompt: string; questionType: string; isRequired: boolean }[];
}

interface EventWithDetails extends Event {}

type TabType = "tasks" | "events" | "checklists" | "issues" | "escalations";

type TaskFilter = "all" | "completed" | "pending";
type EventFilter = "all" | "birthday" | "private_event";
type ChecklistFilter = "all" | "completed" | "in_progress";
type IssueFilter = "all" | "open" | "resolved";
type EscalationFilter = "all" | "open" | "closed";

const tabs: { value: TabType; label: string; icon: typeof ListTodo }[] = [
  { value: "tasks", label: "Tasks", icon: ListTodo },
  { value: "events", label: "Events", icon: PartyPopper },
  { value: "checklists", label: "Checklists", icon: ClipboardCheck },
  { value: "issues", label: "Issues", icon: AlertCircle },
  { value: "escalations", label: "Escalations", icon: AlertTriangle },
];

export default function DashboardPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [activeTab, setActiveTab] = useState<TabType>("tasks");
  const [dateRangePreset, setDateRangePreset] = useState<DateRangePreset>("today");
  
  const { startDate, endDate } = getDateRange(dateRangePreset);
  
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [eventFilter, setEventFilter] = useState<EventFilter>("all");
  const [checklistFilter, setChecklistFilter] = useState<ChecklistFilter>("all");
  const [issueFilter, setIssueFilter] = useState<IssueFilter>("all");
  const [escalationFilter, setEscalationFilter] = useState<EscalationFilter>("all");

  const [selectedTask, setSelectedTask] = useState<TaskWithCompletion | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<EventWithDetails | null>(null);
  const [selectedChecklist, setSelectedChecklist] = useState<ChecklistRunWithDetails | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<IssueWithDetails | null>(null);
  const [selectedEscalation, setSelectedEscalation] = useState<EscalationWithDetails | null>(null);

  const { data: stats, isLoading: statsLoading } = useQuery<DashboardStats>({
    queryKey: [`/api/dashboard/stats?startDate=${startDate}&endDate=${endDate}`],
    enabled: !!user,
  });

  const { data: recentChecklists, isLoading: checklistsLoading } = useQuery<ChecklistRunWithDetails[]>({
    queryKey: [`/api/dashboard/checklists?startDate=${startDate}&endDate=${endDate}`],
    enabled: !!user,
  });

  const { data: issues, isLoading: issuesLoading } = useQuery<IssueWithDetails[]>({
    queryKey: [`/api/dashboard/issues?startDate=${startDate}&endDate=${endDate}`],
    enabled: !!user,
  });

  const { data: escalations, isLoading: escalationsLoading } = useQuery<EscalationWithDetails[]>({
    queryKey: [`/api/dashboard/escalations?startDate=${startDate}&endDate=${endDate}`],
    enabled: !!user,
  });

  const { data: todayTasks, isLoading: tasksLoading } = useQuery<TaskWithCompletion[]>({
    queryKey: [`/api/dashboard/tasks?startDate=${startDate}&endDate=${endDate}`],
    enabled: !!user,
  });

  const { data: todayEvents, isLoading: eventsLoading } = useQuery<EventWithDetails[]>({
    queryKey: [`/api/dashboard/events?startDate=${startDate}&endDate=${endDate}`],
    enabled: !!user,
  });

  if (statsLoading) {
    return (
      <AppLayout>
        <LoadingScreen />
      </AppLayout>
    );
  }

  const completedTasksCount = todayTasks?.filter(t => t.completion).length || 0;
  const pendingTasksCount = todayTasks?.filter(t => !t.completion).length || 0;
  const totalTasksCount = todayTasks?.length || 0;

  const openEscalationsCount = escalations?.filter(e => e.status === "open").length || 0;
  const closedEscalationsCount = escalations?.filter(e => e.status === "closed").length || 0;

  const openIssuesCount = issues?.filter(i => i.status === "open").length || 0;
  const resolvedIssuesCount = issues?.filter(i => i.status === "resolved").length || 0;

  const handleStatClick = (statLabel: string) => {
    switch (activeTab) {
      case "tasks":
        if (statLabel === "Total") setTaskFilter("all");
        else if (statLabel === "Completed") setTaskFilter("completed");
        else if (statLabel === "Pending") setTaskFilter("pending");
        break;
      case "events":
        if (statLabel === "Today") setEventFilter("all");
        else if (statLabel === "Birthdays") setEventFilter("birthday");
        else if (statLabel === "Private") setEventFilter("private_event");
        break;
      case "checklists":
        if (statLabel === "All") setChecklistFilter("all");
        else if (statLabel === "Completed") setChecklistFilter("completed");
        else if (statLabel === "In Progress") setChecklistFilter("in_progress");
        break;
      case "issues":
        if (statLabel === "Total") setIssueFilter("all");
        else if (statLabel === "Open") setIssueFilter("open");
        else if (statLabel === "Resolved") setIssueFilter("resolved");
        break;
      case "escalations":
        if (statLabel === "Total") setEscalationFilter("all");
        else if (statLabel === "Open") setEscalationFilter("open");
        else if (statLabel === "Closed") setEscalationFilter("closed");
        break;
    }
  };

  const getCurrentFilter = () => {
    switch (activeTab) {
      case "tasks": return taskFilter;
      case "events": return eventFilter;
      case "checklists": return checklistFilter;
      case "issues": return issueFilter;
      case "escalations": return escalationFilter;
    }
  };

  const isStatActive = (statLabel: string) => {
    const filter = getCurrentFilter();
    switch (activeTab) {
      case "tasks":
        return (statLabel === "Total" && filter === "all") ||
               (statLabel === "Completed" && filter === "completed") ||
               (statLabel === "Pending" && filter === "pending");
      case "events":
        return (statLabel === "Today" && filter === "all") ||
               (statLabel === "Birthdays" && filter === "birthday") ||
               (statLabel === "Private" && filter === "private_event");
      case "checklists":
        return (statLabel === "All" && filter === "all") ||
               (statLabel === "Completed" && filter === "completed") ||
               (statLabel === "In Progress" && filter === "in_progress");
      case "issues":
        return (statLabel === "Total" && filter === "all") ||
               (statLabel === "Open" && filter === "open") ||
               (statLabel === "Resolved" && filter === "resolved");
      case "escalations":
        return (statLabel === "Total" && filter === "all") ||
               (statLabel === "Open" && filter === "open") ||
               (statLabel === "Closed" && filter === "closed");
    }
    return false;
  };

  const getStatsForTab = () => {
    switch (activeTab) {
      case "tasks":
        return [
          { label: "Total", value: totalTasksCount, icon: ListTodo, color: "bg-blue-100 dark:bg-blue-900/30", iconColor: "text-blue-600 dark:text-blue-400" },
          { label: "Completed", value: completedTasksCount, icon: CheckCircle, color: "bg-green-100 dark:bg-green-900/30", iconColor: "text-green-600 dark:text-green-400" },
          { label: "Pending", value: pendingTasksCount, icon: Clock, color: "bg-orange-100 dark:bg-orange-900/30", iconColor: "text-orange-600 dark:text-orange-400" },
        ];
      case "events":
        return [
          { label: "Today", value: todayEvents?.length || 0, icon: PartyPopper, color: "bg-purple-100 dark:bg-purple-900/30", iconColor: "text-purple-600 dark:text-purple-400" },
          { label: "Birthdays", value: todayEvents?.filter(e => e.eventType === "birthday").length || 0, icon: PartyPopper, color: "bg-pink-100 dark:bg-pink-900/30", iconColor: "text-pink-600 dark:text-pink-400" },
          { label: "Private", value: todayEvents?.filter(e => e.eventType === "private_event").length || 0, icon: Calendar, color: "bg-blue-100 dark:bg-blue-900/30", iconColor: "text-blue-600 dark:text-blue-400" },
        ];
      case "checklists":
        return [
          { label: "All", value: recentChecklists?.length || 0, icon: ClipboardCheck, color: "bg-blue-100 dark:bg-blue-900/30", iconColor: "text-blue-600 dark:text-blue-400" },
          { label: "In Progress", value: stats?.checklistsInProgress || 0, icon: Clock, color: "bg-orange-100 dark:bg-orange-900/30", iconColor: "text-orange-600 dark:text-orange-400" },
          { label: "Completed", value: stats?.checklistsCompleted || 0, icon: CheckCircle, color: "bg-green-100 dark:bg-green-900/30", iconColor: "text-green-600 dark:text-green-400" },
        ];
      case "issues":
        return [
          { label: "Total", value: issues?.length || 0, icon: AlertCircle, color: "bg-blue-100 dark:bg-blue-900/30", iconColor: "text-blue-600 dark:text-blue-400" },
          { label: "Open", value: openIssuesCount, icon: AlertCircle, color: "bg-orange-100 dark:bg-orange-900/30", iconColor: "text-orange-600 dark:text-orange-400" },
          { label: "Resolved", value: resolvedIssuesCount, icon: CheckCircle, color: "bg-green-100 dark:bg-green-900/30", iconColor: "text-green-600 dark:text-green-400" },
        ];
      case "escalations":
        return [
          { label: "Total", value: escalations?.length || 0, icon: AlertTriangle, color: "bg-blue-100 dark:bg-blue-900/30", iconColor: "text-blue-600 dark:text-blue-400" },
          { label: "Open", value: openEscalationsCount, icon: AlertTriangle, color: "bg-red-100 dark:bg-red-900/30", iconColor: "text-red-600 dark:text-red-400" },
          { label: "Closed", value: closedEscalationsCount, icon: CheckCircle, color: "bg-green-100 dark:bg-green-900/30", iconColor: "text-green-600 dark:text-green-400" },
        ];
    }
  };

  const currentStats = getStatsForTab();

  const getFilteredTasks = () => {
    if (!todayTasks) return [];
    switch (taskFilter) {
      case "completed": return todayTasks.filter(t => t.completion);
      case "pending": return todayTasks.filter(t => !t.completion);
      default: return todayTasks;
    }
  };

  const getFilteredEvents = () => {
    if (!todayEvents) return [];
    switch (eventFilter) {
      case "birthday": return todayEvents.filter(e => e.eventType === "birthday");
      case "private_event": return todayEvents.filter(e => e.eventType === "private_event");
      default: return todayEvents;
    }
  };

  const getFilteredChecklists = () => {
    if (!recentChecklists) return [];
    switch (checklistFilter) {
      case "completed": return recentChecklists.filter(c => c.status === "completed");
      case "in_progress": return recentChecklists.filter(c => c.status === "in_progress");
      default: return recentChecklists;
    }
  };

  const getFilteredIssues = () => {
    if (!issues) return [];
    switch (issueFilter) {
      case "open": return issues.filter(i => i.status === "open");
      case "resolved": return issues.filter(i => i.status === "resolved");
      default: return issues;
    }
  };

  const getFilteredEscalations = () => {
    if (!escalations) return [];
    switch (escalationFilter) {
      case "open": return escalations.filter(e => e.status === "open");
      case "closed": return escalations.filter(e => e.status === "closed");
      default: return escalations;
    }
  };

  const renderContent = () => {
    switch (activeTab) {
      case "tasks":
        if (tasksLoading) return <LoadingScreen />;
        const filteredTasks = getFilteredTasks();
        if (filteredTasks.length === 0) {
          return <EmptyState icon={ListTodo} title="No tasks" description={taskFilter === "all" ? "Tasks for today will appear here" : `No ${taskFilter} tasks`} />;
        }
        return filteredTasks.map((task) => (
          <Card 
            key={task.id} 
            className="cursor-pointer hover-elevate overflow-visible"
            onClick={() => setSelectedTask(task)}
            data-testid={`card-task-${task.id}`}
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{task.title}</p>
                  {task.description && (
                    <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{task.description}</p>
                  )}
                  <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1 flex-wrap">
                    <Clock className="h-3.5 w-3.5" />
                    <span>Due {task.dueTime}</span>
                    {task.completion && task.completedByName && (
                      <>
                        <User className="h-3.5 w-3.5 ml-2" />
                        <span>{task.completedByName}</span>
                      </>
                    )}
                  </div>
                </div>
                <Badge variant={task.completion ? "default" : "secondary"}>
                  {task.completion ? "Completed" : "Pending"}
                </Badge>
              </div>
            </CardContent>
          </Card>
        ));

      case "events":
        if (eventsLoading) return <LoadingScreen />;
        const filteredEvents = getFilteredEvents();
        if (filteredEvents.length === 0) {
          return <EmptyState icon={PartyPopper} title="No events" description={eventFilter === "all" ? "Events for today will appear here" : `No ${eventFilter.replace("_", " ")} events`} />;
        }
        return filteredEvents.map((event) => (
          <Card 
            key={event.id} 
            className="cursor-pointer hover-elevate overflow-visible"
            onClick={() => setSelectedEvent(event)}
            data-testid={`card-event-${event.id}`}
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{event.title}</p>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1 flex-wrap">
                    <Clock className="h-3.5 w-3.5" />
                    <span>{event.startTime} - {event.endTime}</span>
                    {event.parentName && (
                      <>
                        <User className="h-3.5 w-3.5 ml-2" />
                        <span>{event.parentName}</span>
                      </>
                    )}
                  </div>
                  {event.programName && (
                    <Badge variant="outline" className="mt-2 text-xs">{event.programName}</Badge>
                  )}
                </div>
                <Badge variant="secondary" className="capitalize shrink-0">
                  {event.eventType.replace("_", " ")}
                </Badge>
              </div>
            </CardContent>
          </Card>
        ));

      case "checklists":
        if (checklistsLoading) return <LoadingScreen />;
        const filteredChecklists = getFilteredChecklists();
        if (filteredChecklists.length === 0) {
          return <EmptyState icon={ClipboardCheck} title="No checklists" description={checklistFilter === "all" ? "Checklist activity will appear here" : `No ${checklistFilter.replace("_", " ")} checklists`} />;
        }
        return filteredChecklists.map((run) => (
          <Card 
            key={run.id} 
            className="cursor-pointer hover-elevate overflow-visible"
            onClick={() => setSelectedChecklist(run)}
            data-testid={`card-run-${run.id}`}
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{run.template.name}</p>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1 flex-wrap">
                    <User className="h-3.5 w-3.5" />
                    <span>{run.startedBy?.name}</span>
                    <span className="mx-1">at</span>
                    <Calendar className="h-3.5 w-3.5" />
                    <span>{new Date(run.startedAt).toLocaleTimeString()}</span>
                  </div>
                </div>
                <StatusBadge status={run.status} />
              </div>
            </CardContent>
          </Card>
        ));

      case "issues":
        if (issuesLoading) return <LoadingScreen />;
        const filteredIssues = getFilteredIssues();
        if (filteredIssues.length === 0) {
          return <EmptyState icon={AlertCircle} title="No issues" description={issueFilter === "all" ? "Reported issues will appear here" : `No ${issueFilter} issues`} />;
        }
        return filteredIssues.map((issue) => (
          <Card 
            key={issue.id} 
            className="cursor-pointer hover-elevate overflow-visible"
            onClick={() => setSelectedIssue(issue)}
            data-testid={`card-issue-${issue.id}`}
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold">{issue.title}</p>
                    <StatusBadge status={issue.urgency} />
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1 flex-wrap">
                    <User className="h-3.5 w-3.5" />
                    <span>{issue.createdBy?.name}</span>
                    <Badge variant="secondary" className="text-xs capitalize">
                      {issue.category.replace("_", "/")}
                    </Badge>
                  </div>
                </div>
                <StatusBadge status={issue.status} />
              </div>
            </CardContent>
          </Card>
        ));

      case "escalations":
        if (escalationsLoading) return <LoadingScreen />;
        const filteredEscalations = getFilteredEscalations();
        if (filteredEscalations.length === 0) {
          return <EmptyState icon={AlertTriangle} title="No escalations" description={escalationFilter === "all" ? "Escalations will appear here" : `No ${escalationFilter} escalations`} />;
        }
        return filteredEscalations.map((escalation) => (
          <Card 
            key={escalation.id} 
            className={cn("cursor-pointer hover-elevate overflow-visible", escalation.status === "open" && "border-destructive/30")}
            onClick={() => setSelectedEscalation(escalation)}
            data-testid={`card-escalation-${escalation.id}`}
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold line-clamp-1">{escalation.reason}</p>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1 flex-wrap">
                    <User className="h-3.5 w-3.5" />
                    <span>{escalation.createdBy?.name}</span>
                    <Calendar className="h-3.5 w-3.5" />
                    <span>{new Date(escalation.createdAt).toLocaleString()}</span>
                  </div>
                </div>
                <Badge variant={escalation.status === "open" ? "destructive" : "secondary"}>
                  {escalation.status}
                </Badge>
              </div>
            </CardContent>
          </Card>
        ));
    }
  };

  return (
    <AppLayout>
      <div className="p-4 max-w-4xl mx-auto">
        <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold mb-1">Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              {isAdmin ? "All Branches Overview" : "Branch Overview"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
            <Select value={dateRangePreset} onValueChange={(v) => setDateRangePreset(v as DateRangePreset)}>
              <SelectTrigger className="w-[140px]" data-testid="select-date-range">
                <SelectValue placeholder="Select range" />
              </SelectTrigger>
              <SelectContent>
                {dateRangePresets.map((preset) => (
                  <SelectItem key={preset.value} value={preset.value}>
                    {preset.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex gap-1 overflow-x-auto pb-2 mb-4 -mx-4 px-4">
          {tabs.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setActiveTab(tab.value)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors",
                activeTab === tab.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted/50 text-muted-foreground hover-elevate"
              )}
              data-testid={`tab-${tab.value}`}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-3 gap-3 mb-4">
          {currentStats.map((stat, idx) => (
            <Card 
              key={idx} 
              className={cn(
                "cursor-pointer hover-elevate overflow-visible transition-all",
                isStatActive(stat.label) && "ring-2 ring-primary"
              )}
              onClick={() => handleStatClick(stat.label)}
              data-testid={`stat-${stat.label.toLowerCase().replace(" ", "-")}`}
            >
              <CardContent className="p-3">
                <div className="flex flex-col items-center text-center gap-1">
                  <div className={cn("h-8 w-8 rounded-lg flex items-center justify-center", stat.color)}>
                    <stat.icon className={cn("h-4 w-4", stat.iconColor)} />
                  </div>
                  <p className="text-xl font-bold">{stat.value}</p>
                  <p className="text-xs text-muted-foreground">{stat.label}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="space-y-3">
          {renderContent()}
        </div>
      </div>

      <Dialog open={!!selectedTask} onOpenChange={() => setSelectedTask(null)}>
        <DialogContent className="max-w-md max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ListTodo className="h-5 w-5" />
              Task Details
            </DialogTitle>
          </DialogHeader>
          {selectedTask && (
            <div className="flex-1 overflow-y-auto space-y-4">
              <div>
                <h3 className="font-semibold text-lg">{selectedTask.title}</h3>
                <Badge variant={selectedTask.completion ? "default" : "secondary"} className="mt-1">
                  {selectedTask.completion ? "Completed" : "Pending"}
                </Badge>
              </div>
              
              {selectedTask.description && (
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Description</p>
                  <p className="text-sm">{selectedTask.description}</p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Due Time</p>
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">{selectedTask.dueTime}</span>
                  </div>
                </div>
                {selectedTask.completion && selectedTask.completedByName && (
                  <div>
                    <p className="text-sm font-medium text-muted-foreground mb-1">Completed By</p>
                    <div className="flex items-center gap-2">
                      <User className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm">{selectedTask.completedByName}</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-4 text-sm">
                {selectedTask.requiresPhotoEvidence && (
                  <div className="flex items-center gap-1">
                    <Camera className="h-4 w-4 text-muted-foreground" />
                    <span>Photo required</span>
                  </div>
                )}
                {selectedTask.requiresResponses && (
                  <div className="flex items-center gap-1">
                    <MessageSquare className="h-4 w-4 text-muted-foreground" />
                    <span>Questions required</span>
                  </div>
                )}
              </div>

              {selectedTask.completion?.completedAt && (
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Completed At</p>
                  <p className="text-sm">{new Date(selectedTask.completion.completedAt).toLocaleString()}</p>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedEvent} onOpenChange={() => setSelectedEvent(null)}>
        <DialogContent className="max-w-md max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PartyPopper className="h-5 w-5" />
              Event Details
            </DialogTitle>
          </DialogHeader>
          {selectedEvent && (
            <div className="flex-1 overflow-y-auto space-y-4">
              <div>
                <h3 className="font-semibold text-lg">{selectedEvent.title}</h3>
                <Badge variant="secondary" className="mt-1 capitalize">
                  {selectedEvent.eventType.replace("_", " ")}
                </Badge>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Date</p>
                  <div className="flex items-center gap-2">
                    <Calendar className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">{selectedEvent.eventDate}</span>
                  </div>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Time</p>
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">{selectedEvent.startTime} - {selectedEvent.endTime}</span>
                  </div>
                </div>
              </div>

              {selectedEvent.parentName && (
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Parent/Host</p>
                  <div className="flex items-center gap-2">
                    <User className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">{selectedEvent.parentName}</span>
                  </div>
                </div>
              )}

              {selectedEvent.whatsappPhoneE164 && (
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Contact</p>
                  <div className="flex items-center gap-2">
                    <Phone className="h-4 w-4 text-muted-foreground" />
                    <a href={`tel:${selectedEvent.whatsappPhoneE164}`} className="text-sm text-primary">
                      {selectedEvent.whatsappPhoneRaw || selectedEvent.whatsappPhoneE164}
                    </a>
                  </div>
                </div>
              )}

              {selectedEvent.childName && (
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Child</p>
                  <p className="text-sm">{selectedEvent.childName}</p>
                </div>
              )}

              {(selectedEvent.numChildren || selectedEvent.numAdults) && (
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Expected Guests</p>
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">
                      {selectedEvent.numChildren ? `${selectedEvent.numChildren} children` : ""}
                      {selectedEvent.numChildren && selectedEvent.numAdults ? ", " : ""}
                      {selectedEvent.numAdults ? `${selectedEvent.numAdults} adults` : ""}
                    </span>
                  </div>
                </div>
              )}

              {selectedEvent.programName && (
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Package</p>
                  <Badge variant="outline">{selectedEvent.programName}</Badge>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedChecklist} onOpenChange={() => setSelectedChecklist(null)}>
        <DialogContent className="max-w-md max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ClipboardCheck className="h-5 w-5" />
              Checklist Run Details
            </DialogTitle>
          </DialogHeader>
          {selectedChecklist && (
            <div className="flex-1 overflow-y-auto space-y-4">
              <div>
                <h3 className="font-semibold text-lg">{selectedChecklist.template.name}</h3>
                <StatusBadge status={selectedChecklist.status} />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Started By</p>
                  <div className="flex items-center gap-2">
                    <User className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">{selectedChecklist.startedBy?.name}</span>
                  </div>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Started At</p>
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">{new Date(selectedChecklist.startedAt).toLocaleTimeString()}</span>
                  </div>
                </div>
              </div>

              <div>
                <p className="text-sm font-medium text-muted-foreground mb-1">Run Date</p>
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">{selectedChecklist.runDate}</span>
                </div>
              </div>

              {selectedChecklist.completedAt && (
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Completed At</p>
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-green-600" />
                    <span className="text-sm">{new Date(selectedChecklist.completedAt).toLocaleString()}</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedIssue} onOpenChange={() => setSelectedIssue(null)}>
        <DialogContent className="max-w-md max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5" />
              Issue Details
            </DialogTitle>
          </DialogHeader>
          {selectedIssue && (
            <div className="flex-1 overflow-y-auto space-y-4">
              <div>
                <h3 className="font-semibold text-lg">{selectedIssue.title}</h3>
                <div className="flex items-center gap-2 mt-1">
                  <StatusBadge status={selectedIssue.status} />
                  <StatusBadge status={selectedIssue.urgency} />
                </div>
              </div>
              
              {selectedIssue.description && (
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Description</p>
                  <p className="text-sm">{selectedIssue.description}</p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Reported By</p>
                  <div className="flex items-center gap-2">
                    <User className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">{selectedIssue.createdBy?.name}</span>
                  </div>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Category</p>
                  <Badge variant="secondary" className="capitalize text-xs">
                    {selectedIssue.category.replace("_", " ")}
                  </Badge>
                </div>
              </div>

              <div>
                <p className="text-sm font-medium text-muted-foreground mb-1">Department</p>
                <Badge variant="outline" className="capitalize text-xs">
                  {selectedIssue.department.replace("_", " ")}
                </Badge>
              </div>

              <div>
                <p className="text-sm font-medium text-muted-foreground mb-1">Reported At</p>
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">{new Date(selectedIssue.createdAt).toLocaleString()}</span>
                </div>
              </div>

              {selectedIssue.managerNotes && (
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Manager Notes</p>
                  <p className="text-sm">{selectedIssue.managerNotes}</p>
                </div>
              )}

              {selectedIssue.photoUrl && (
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Photo Evidence</p>
                  <img src={selectedIssue.photoUrl} alt="Issue" className="rounded-md max-h-48 object-cover" />
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedEscalation} onOpenChange={() => setSelectedEscalation(null)}>
        <DialogContent className="max-w-md max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5" />
              Escalation Details
            </DialogTitle>
          </DialogHeader>
          {selectedEscalation && (
            <div className="flex-1 overflow-y-auto space-y-4">
              <div>
                <h3 className="font-semibold text-lg">Escalation</h3>
                <Badge variant={selectedEscalation.status === "open" ? "destructive" : "secondary"} className="mt-1">
                  {selectedEscalation.status}
                </Badge>
              </div>
              
              <div>
                <p className="text-sm font-medium text-muted-foreground mb-1">Reason</p>
                <p className="text-sm">{selectedEscalation.reason}</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Escalated By</p>
                  <div className="flex items-center gap-2">
                    <User className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">{selectedEscalation.createdBy?.name}</span>
                  </div>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Created At</p>
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">{new Date(selectedEscalation.createdAt).toLocaleString()}</span>
                  </div>
                </div>
              </div>

              {selectedEscalation.closedAt && (
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Closed At</p>
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-green-600" />
                    <span className="text-sm">{new Date(selectedEscalation.closedAt).toLocaleString()}</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
