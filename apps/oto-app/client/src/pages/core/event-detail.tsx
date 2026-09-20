import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useRoute } from "wouter";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { BeoViewOnly } from "@/components/beo/beo-view-only";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { 
  ArrowLeft, Clock, Users, Cake, PartyPopper, GraduationCap, CalendarDays,
  AlertCircle, Phone, MessageCircle, User, FileText, Calendar, ListTodo,
  Plus, CheckCircle, Circle, ClipboardList, Play, Printer, Download
} from "lucide-react";
import { SiWhatsapp } from "react-icons/si";
import { Link } from "wouter";
import { format, parseISO, isToday } from "date-fns";
import type { Event, Department } from "@shared/schema";
import { BeoDayOfView } from "@/components/beo";

interface StudioEventTask {
  id: string;
  eventId: string;
  title: string;
  description: string | null;
  dueTime: string | null;
  dueDatetime: Date | null;
  departmentId: string | null;
  assignedToUserId: string | null;
  requiresPhotoEvidence: boolean;
  requiresQuestionsAnswered: boolean;
  completed: boolean;
  completedAt: Date | string | null;
  completedByUserId: string | null;
  completedByName?: string | null;
  status: string;
  displayOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const eventTypeIcons: Record<string, typeof Cake> = {
  birthday: Cake,
  private_event: PartyPopper,
  school_group: GraduationCap,
  other: CalendarDays,
};

const eventTypeColors: Record<string, string> = {
  birthday: "bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-300",
  private_event: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  school_group: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  other: "bg-gray-100 text-gray-800 dark:bg-gray-800/50 dark:text-gray-300",
};

const statusColors: Record<string, string> = {
  upcoming: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  today: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  in_progress: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  completed: "bg-gray-100 text-gray-800 dark:bg-gray-800/50 dark:text-gray-300",
  cancelled: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

function InfoRow({ icon: Icon, label, value }: { icon: typeof Clock; label: string; value: string | number | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-3 py-2">
      <Icon className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm">{value}</p>
      </div>
    </div>
  );
}

function TaskCard({ task, onToggle }: { task: StudioEventTask; onToggle: (taskId: string, completed: boolean) => void }) {
  const isCompleted = task.completed;
  
  const formatCompletedAt = (date: Date | string | null | undefined) => {
    if (!date) return null;
    const d = new Date(date);
    return format(d, "MMM d 'at' h:mm a");
  };
  
  return (
    <div 
      className={`flex items-center gap-3 p-3 rounded-md hover-elevate active-elevate-2 cursor-pointer ${isCompleted ? "opacity-60" : ""}`}
      data-testid={`card-event-task-${task.id}`}
      onClick={() => onToggle(task.id, task.completed)}
    >
      <div className="h-8 w-8 flex items-center justify-center shrink-0">
        {isCompleted ? (
          <CheckCircle className="h-5 w-5 text-green-600" />
        ) : (
          <Circle className="h-5 w-5 text-muted-foreground" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <h4 className={`font-medium text-sm ${isCompleted ? "line-through" : ""}`}>{task.title}</h4>
        {!isCompleted && task.dueTime && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            <span>{task.dueTime}</span>
          </div>
        )}
        {isCompleted && (task.completedByName || task.completedAt) && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {task.completedByName && <span>by {task.completedByName}</span>}
            {task.completedAt && <span>{formatCompletedAt(task.completedAt)}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

interface UserOption {
  id: string;
  fullName: string;
  email: string;
}

function CreateTaskDialog({ eventId, eventDate, onCreated }: { eventId: string; eventDate: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueTime, setDueTime] = useState("10:00");
  const [departmentId, setDepartmentId] = useState<string>("");
  const [assignedToUserId, setAssignedToUserId] = useState<string>("");
  const [requiresPhotoEvidence, setRequiresPhotoEvidence] = useState(false);
  const [requiresQuestionsAnswered, setRequiresQuestionsAnswered] = useState(false);

  const { data: departments } = useQuery<Department[]>({
    queryKey: ["/api/departments"],
  });

  const { data: users } = useQuery<UserOption[]>({
    queryKey: ["/api/users"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: { 
      title: string; 
      description?: string;
      dueDate: string; 
      dueTime: string; 
      departmentId?: string;
      assignedToUserId?: string;
      requiresPhotoEvidence?: boolean;
      requiresQuestionsAnswered?: boolean;
    }) => {
      return apiRequest("POST", `/api/events/${eventId}/tasks`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/events/${eventId}/tasks`] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks/grouped"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks/today"] });
      setOpen(false);
      setTitle("");
      setDescription("");
      setDueTime("10:00");
      setDepartmentId("");
      setAssignedToUserId("");
      setRequiresPhotoEvidence(false);
      setRequiresQuestionsAnswered(false);
      onCreated();
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    createMutation.mutate({
      title: title.trim(),
      description: description.trim() || undefined,
      dueDate: eventDate,
      dueTime,
      departmentId: departmentId && departmentId !== "none" ? departmentId : undefined,
      assignedToUserId: assignedToUserId && assignedToUserId !== "none" ? assignedToUserId : undefined,
      requiresPhotoEvidence,
      requiresQuestionsAnswered,
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid="button-add-event-task">
          <Plus className="h-4 w-4 mr-1" />
          Add Task
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Add Task for Event</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="title">Task Title</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Prepare birthday cake"
              data-testid="input-task-title"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">Description (optional)</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add instructions or details..."
              className="resize-none"
              rows={3}
              data-testid="input-task-description"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dueTime">Due Time</Label>
            <Input
              id="dueTime"
              type="time"
              value={dueTime}
              onChange={(e) => setDueTime(e.target.value)}
              data-testid="input-task-time"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="assignedTo">Assign to Employee (optional)</Label>
            <Select value={assignedToUserId} onValueChange={setAssignedToUserId}>
              <SelectTrigger data-testid="select-assigned-user">
                <SelectValue placeholder="Select employee" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No assignment</SelectItem>
                {users?.map((user) => (
                  <SelectItem key={user.id} value={user.id}>{user.fullName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="department">Department (optional)</Label>
            <Select value={departmentId} onValueChange={setDepartmentId}>
              <SelectTrigger data-testid="select-department">
                <SelectValue placeholder="Select department" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No department</SelectItem>
                {departments?.map((dept) => (
                  <SelectItem key={dept.id} value={dept.id}>{dept.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-3 pt-2 border-t">
            <p className="text-sm font-medium text-muted-foreground">Completion Requirements</p>
            <div className="flex items-center justify-between">
              <Label htmlFor="requiresPhoto" className="text-sm cursor-pointer">Require photo evidence</Label>
              <Switch
                id="requiresPhoto"
                checked={requiresPhotoEvidence}
                onCheckedChange={setRequiresPhotoEvidence}
                data-testid="switch-requires-photo"
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="requiresQuestions" className="text-sm cursor-pointer">Require answers to questions</Label>
              <Switch
                id="requiresQuestions"
                checked={requiresQuestionsAnswered}
                onCheckedChange={setRequiresQuestionsAnswered}
                data-testid="switch-requires-questions"
              />
            </div>
          </div>
          <Button 
            type="submit" 
            className="w-full" 
            disabled={!title.trim() || createMutation.isPending}
            data-testid="button-create-task"
          >
            {createMutation.isPending ? "Creating..." : "Create Task"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function EventDetailPage() {
  const [, params] = useRoute("/core/events/:id");
  const { user } = useAuth();
  const { t } = useI18n();

  const { data: event, isLoading } = useQuery<Event>({
    queryKey: [`/api/admin/events/${params?.id}`],
    enabled: !!user && !!params?.id,
  });

  const { data: eventTasks, refetch: refetchTasks } = useQuery<StudioEventTask[]>({
    queryKey: [`/api/events/${params?.id}/tasks`],
    enabled: !!user && !!params?.id,
  });

  const toggleTaskMutation = useMutation({
    mutationFn: async ({ taskId, completed }: { taskId: string; completed: boolean }) => {
      const res = await apiRequest("PATCH", `/api/studio-tasks/${taskId}`, { completed: !completed });
      return res.json();
    },
    onSuccess: () => {
      refetchTasks();
    },
  });

  const handleToggleTask = (taskId: string, completed: boolean) => {
    toggleTaskMutation.mutate({ taskId, completed });
  };

  const canManage = user?.role === "manager" || user?.role === "admin";

  if (isLoading) {
    return (
      <AppLayout>
        <LoadingScreen />
      </AppLayout>
    );
  }

  if (!event) {
    return (
      <AppLayout>
        <div className="p-4 max-w-lg mx-auto">
          <p className="text-muted-foreground">{t.common.noResults}</p>
        </div>
      </AppLayout>
    );
  }

  const Icon = eventTypeIcons[event.eventType] || CalendarDays;
  const colorClass = eventTypeColors[event.eventType] || eventTypeColors.other;

  const eventTypeLabels: Record<string, string> = {
    birthday: t.events.birthday,
    private_event: t.events.privateEvent,
    school_group: t.events.schoolGroup,
    studio_event: t.events.studioEvent,
    camp: t.events.camp,
    other: t.events.other,
  };

  const statusLabels: Record<string, string> = {
    upcoming: t.events.status.upcoming,
    in_progress: t.events.status.inProgress,
    completed: t.events.status.completed,
    cancelled: t.events.status.cancelled,
  };

  const eventDate = parseISO(event.eventDate);
  const eventIsToday = isToday(eventDate);
  const displayStatus = eventIsToday && event.status === "upcoming" ? "today" : event.status;
  const displayLabel = eventIsToday && event.status === "upcoming" ? t.common.today : statusLabels[event.status];

  const whatsappNumber = event.whatsappPhoneE164?.replace(/\D/g, "") || event.whatsappPhoneRaw?.replace(/\D/g, "");
  const whatsappMessage = encodeURIComponent(
    `Hi ${event.parentName || "there"}, this is OTO Play Park regarding ${event.title} today at ${event.startTime}.`
  );
  const whatsappLink = whatsappNumber ? `https://wa.me/${whatsappNumber}?text=${whatsappMessage}` : null;

  const pendingTasks = eventTasks?.filter(t => !t.completed) || [];
  const completedTasks = eventTasks?.filter(t => t.completed) || [];

  return (
    <AppLayout>
      <div className="p-4 max-w-lg mx-auto">
        <Button 
          variant="ghost" 
          className="mb-4 -ml-2" 
          data-testid="button-back"
          onClick={() => window.history.back()}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t.common.back}
        </Button>

        <div className="space-y-4">
          <div className="flex items-start gap-4">
            <div className={`p-3 rounded-lg ${colorClass}`}>
              <Icon className="h-6 w-6" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <Badge variant="secondary" className={colorClass}>
                  {eventTypeLabels[event.eventType]}
                </Badge>
                <Badge variant="secondary" className={statusColors[displayStatus]}>
                  {displayLabel}
                </Badge>
              </div>
              <h1 className="text-xl font-bold">{event.title}</h1>
            </div>
          </div>

          <Accordion type="multiple" defaultValue={["day-of"]} className="space-y-2">
            <AccordionItem value="day-of" className="border rounded-lg px-4">
              <div className="flex items-center justify-between py-3">
                <AccordionTrigger className="hover:no-underline py-0 flex-1" data-testid="accordion-day-of">
                  <div className="flex items-center gap-2">
                    <Play className="h-4 w-4" />
                    <span className="font-medium">Day-of Execution</span>
                  </div>
                </AccordionTrigger>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="button-print-beo"
                  onClick={(e) => {
                    e.stopPropagation();
                    window.open(`/api/events/${event.id}/beo/pdf`, '_blank');
                  }}
                >
                  <Printer className="h-4 w-4 mr-1" />
                  Print BEO
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="button-download-beo"
                  onClick={async (e) => {
                    e.stopPropagation();
                    const res = await fetch(`/api/events/${event.id}/beo/pdf`, { credentials: 'include' });
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
                >
                  <Download className="h-4 w-4 mr-1" />
                  Download PDF
                </Button>
              </div>
              <AccordionContent className="pb-4">
                <BeoDayOfView eventId={event.id} />
              </AccordionContent>
            </AccordionItem>

{/* Hide Event Details for birthday events since DOE section shows the same info */}
            {event.eventType !== "birthday" && (
              <AccordionItem value="overview" className="border rounded-lg px-4">
                <AccordionTrigger className="hover:no-underline py-3" data-testid="accordion-overview">
                  <div className="flex items-center gap-2">
                    <Calendar className="h-4 w-4" />
                    <span className="font-medium">{t.events.eventDetails}</span>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="pb-4">
                  <div className="space-y-2">
                    <InfoRow 
                      icon={CalendarDays} 
                      label="Date" 
                      value={format(parseISO(event.eventDate), "EEEE, MMMM d, yyyy")} 
                    />
                    <InfoRow 
                      icon={Clock} 
                      label="Time" 
                      value={`${event.startTime}${event.endTime ? ` - ${event.endTime}` : ""}`} 
                    />
                    <InfoRow icon={User} label={t.checkins.childName} value={event.childName} />
                    <InfoRow icon={User} label="Booking Name" value={event.bookingName} />
                    <div className="flex items-start gap-3 py-1">
                      <Users className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                      <div>
                        <p className="text-xs text-muted-foreground">Guests</p>
                        <p className="text-sm">
                          {event.numChildren ? `${event.numChildren} ${t.events.children}` : ""}
                          {event.numChildren && event.numAdults ? ", " : ""}
                          {event.numAdults ? `${event.numAdults} ${t.events.adults}` : ""}
                          {!event.numChildren && !event.numAdults && "Not specified"}
                        </p>
                      </div>
                    </div>
                    <InfoRow icon={FileText} label={t.events.program} value={event.programName} />
                    {event.programDetails && (
                      <div className="py-1">
                        <p className="text-xs text-muted-foreground mb-1">Program Details</p>
                        <p className="text-sm whitespace-pre-wrap">{event.programDetails}</p>
                      </div>
                    )}
                    
                    {(event.parentName || event.whatsappPhoneRaw) && (
                      <div className="pt-2 border-t mt-2">
                        <p className="text-xs text-muted-foreground font-medium mb-2">{t.events.contact}</p>
                        {event.parentName && (
                          <InfoRow icon={User} label={t.checkins.parentName} value={event.parentName} />
                        )}
                        {event.whatsappPhoneRaw && (
                          <div className="flex items-start gap-3 py-1">
                            <MessageCircle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                            <div className="flex-1">
                              <p className="text-xs text-muted-foreground">{t.events.whatsapp}</p>
                              <p className="text-sm">{event.whatsappPhoneRaw}</p>
                              {event.whatsappParseValid === false && (
                                <Badge variant="destructive" className="text-xs mt-1">Invalid number</Badge>
                              )}
                            </div>
                          </div>
                        )}
                        {whatsappLink && (
                          <a href={whatsappLink} target="_blank" rel="noopener noreferrer">
                            <Button size="sm" className="mt-2 bg-[#25D366] hover:bg-[#20BD5A] text-white" data-testid="button-whatsapp">
                              <SiWhatsapp className="h-4 w-4 mr-2" />
                              {t.events.messageParent}
                            </Button>
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>
            )}

            <AccordionItem value="tasks" className="border rounded-lg px-4">
              <AccordionTrigger className="hover:no-underline py-3" data-testid="accordion-tasks">
                <div className="flex items-center gap-2">
                  <ListTodo className="h-4 w-4" />
                  <span className="font-medium">Tasks</span>
                  {eventTasks && eventTasks.length > 0 && (
                    <Badge variant="secondary" className="ml-2">
                      {completedTasks.length}/{eventTasks.length}
                    </Badge>
                  )}
                </div>
              </AccordionTrigger>
              <AccordionContent className="pb-4">
                <div className="space-y-2">
                  {canManage && (
                    <div className="flex justify-end mb-2">
                      <CreateTaskDialog 
                        eventId={event.id} 
                        eventDate={event.eventDate} 
                        onCreated={() => refetchTasks()}
                      />
                    </div>
                  )}
                  {(!eventTasks || eventTasks.length === 0) ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No tasks for this event
                    </p>
                  ) : (
                    <div className="space-y-1">
                      {pendingTasks.map((task) => (
                        <TaskCard key={task.id} task={task} onToggle={handleToggleTask} />
                      ))}
                      {completedTasks.map((task) => (
                        <TaskCard key={task.id} task={task} onToggle={handleToggleTask} />
                      ))}
                    </div>
                  )}
                </div>
              </AccordionContent>
            </AccordionItem>

          </Accordion>
        </div>
      </div>
    </AppLayout>
  );
}
