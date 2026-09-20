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
  Plus, CheckCircle, Circle, ChevronRight
} from "lucide-react";
import { SiWhatsapp } from "react-icons/si";
import { Link } from "wouter";
import { format, parseISO, isToday } from "date-fns";
import type { Event, Task, TaskCompletion, Department } from "@shared/schema";

interface TaskWithCompletion extends Task {
  completion?: TaskCompletion;
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

function TaskCard({ task }: { task: TaskWithCompletion }) {
  const isCompleted = !!task.completion;
  
  return (
    <Link href={`/tasks/${task.id}`}>
      <div 
        className={`flex items-center gap-3 p-3 rounded-md hover-elevate active-elevate-2 cursor-pointer ${isCompleted ? "opacity-60" : ""}`}
        data-testid={`card-event-task-${task.id}`}
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
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            <span>{task.dueTime}</span>
          </div>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
      </div>
    </Link>
  );
}

function CreateTaskDialog({ eventId, eventDate, onCreated }: { eventId: string; eventDate: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueTime, setDueTime] = useState("10:00");
  const [departmentId, setDepartmentId] = useState<string>("");
  const [requiresPhotoEvidence, setRequiresPhotoEvidence] = useState(false);
  const [requiresQuestionsAnswered, setRequiresQuestionsAnswered] = useState(false);

  const { data: departments } = useQuery<Department[]>({
    queryKey: ["/api/departments"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: { 
      title: string; 
      description?: string;
      dueDate: string; 
      dueTime: string; 
      departmentId?: string;
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
      departmentId: departmentId || undefined,
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
  const [, params] = useRoute("/events/:id");
  const { user } = useAuth();
  const { t } = useI18n();

  const { data: event, isLoading } = useQuery<Event>({
    queryKey: [`/api/events/${params?.id}`],
    enabled: !!user && !!params?.id,
  });

  const { data: eventTasks, refetch: refetchTasks } = useQuery<TaskWithCompletion[]>({
    queryKey: [`/api/events/${params?.id}/tasks`],
    enabled: !!user && !!params?.id,
  });

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

  const pendingTasks = eventTasks?.filter(t => !t.completion) || [];
  const completedTasks = eventTasks?.filter(t => t.completion) || [];

  return (
    <AppLayout>
      <div className="p-4 max-w-lg mx-auto">
        <Link href="/events">
          <Button variant="ghost" className="mb-4 -ml-2" data-testid="button-back">
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t.common.back}
          </Button>
        </Link>

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

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                {t.events.eventDetails}
              </CardTitle>
            </CardHeader>
            <CardContent className="divide-y">
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
              <div className="flex items-start gap-3 py-2">
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
                <div className="py-2">
                  <p className="text-xs text-muted-foreground mb-1">Program Details</p>
                  <p className="text-sm whitespace-pre-wrap">{event.programDetails}</p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <ListTodo className="h-4 w-4" />
                  Tasks
                  {eventTasks && eventTasks.length > 0 && (
                    <Badge variant="secondary" className="text-xs">
                      {completedTasks.length}/{eventTasks.length}
                    </Badge>
                  )}
                </CardTitle>
                {canManage && (
                  <CreateTaskDialog 
                    eventId={event.id} 
                    eventDate={event.eventDate} 
                    onCreated={() => refetchTasks()}
                  />
                )}
              </div>
            </CardHeader>
            <CardContent>
              {(!eventTasks || eventTasks.length === 0) ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No tasks for this event
                </p>
              ) : (
                <div className="space-y-1 -mx-3">
                  {pendingTasks.map((task) => (
                    <TaskCard key={task.id} task={task} />
                  ))}
                  {completedTasks.map((task) => (
                    <TaskCard key={task.id} task={task} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {(event.allergiesNotes || event.cakeNotes || event.specialRequests) && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <AlertCircle className="h-4 w-4" />
                  Special Notes
                </CardTitle>
              </CardHeader>
              <CardContent className="divide-y">
                {event.allergiesNotes && (
                  <div className="py-2">
                    <p className="text-xs text-muted-foreground mb-1">{t.events.allergies}</p>
                    <p className="text-sm text-destructive">{event.allergiesNotes}</p>
                  </div>
                )}
                {event.cakeNotes && (
                  <div className="py-2">
                    <p className="text-xs text-muted-foreground mb-1">{t.events.cake}</p>
                    <p className="text-sm">{event.cakeNotes}</p>
                  </div>
                )}
                {event.specialRequests && (
                  <div className="py-2">
                    <p className="text-xs text-muted-foreground mb-1">{t.events.specialRequests}</p>
                    <p className="text-sm">{event.specialRequests}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {(event.parentName || event.whatsappPhoneRaw) && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Phone className="h-4 w-4" />
                  {t.events.contact}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {event.parentName && (
                  <div className="flex items-center gap-3 py-2">
                    <User className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="text-xs text-muted-foreground">{t.checkins.parentName}</p>
                      <p className="text-sm">{event.parentName}</p>
                    </div>
                  </div>
                )}
                {event.whatsappPhoneRaw && (
                  <div className="flex items-center gap-3 py-2">
                    <MessageCircle className="h-4 w-4 text-muted-foreground" />
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
                    <Button className="w-full mt-3 bg-[#25D366] hover:bg-[#20BD5A] text-white" data-testid="button-whatsapp">
                      <SiWhatsapp className="h-4 w-4 mr-2" />
                      {t.events.messageParent}
                    </Button>
                  </a>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
