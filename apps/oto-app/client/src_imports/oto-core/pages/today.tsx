import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Clock, Play, Eye, PartyPopper, Cake, GraduationCap, CalendarDays, ChevronRight, Check, Circle, Camera, MessageSquare, Upload, X, Info } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { Link, useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ChecklistTemplate, ChecklistRun, ChecklistTemplateItem, Event, Task, TaskCompletion, TaskQuestion } from "@shared/schema";
import { format } from "date-fns";

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
  other: CalendarDays,
};

export default function TodayPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const { t } = useI18n();
  const [, setLocation] = useLocation();
  const today = format(new Date(), "yyyy-MM-dd");
  
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<TaskWithQuestions | null>(null);
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [responses, setResponses] = useState<Record<string, string | boolean>>({});
  const [loadingTask, setLoadingTask] = useState(false);
  const [isViewMode, setIsViewMode] = useState(false);

  const { data: checklists, isLoading } = useQuery<ChecklistWithStatus[]>({
    queryKey: ["/api/checklists/today"],
    enabled: !!user,
  });

  const { data: todayEvents } = useQuery<Event[]>({
    queryKey: ["/api/events?range=today"],
    enabled: !!user,
  });

  const { data: todayTasks } = useQuery<TaskWithCompletion[]>({
    queryKey: ["/api/tasks/today"],
    enabled: !!user,
  });

  const startChecklistMutation = useMutation({
    mutationFn: async (templateId: string) => {
      const res = await apiRequest("POST", "/api/checklist-runs", { templateId });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/checklists/today"] });
      setLocation(`/checklist/${data.id}`);
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to start checklist",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const completeTaskMutation = useMutation({
    mutationFn: async ({ taskId, photoUrls, responses }: { taskId: string; photoUrls?: string[]; responses?: { questionId: string; answer: string }[] }) => {
      const res = await apiRequest("POST", `/api/tasks/${taskId}/complete`, { photoUrls, responses });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks/today"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks/grouped"] });
      // Invalidate all event tasks to ensure bidirectional sync
      queryClient.invalidateQueries({ predicate: (query) => 
        Array.isArray(query.queryKey) && 
        typeof query.queryKey[0] === 'string' && 
        query.queryKey[0].includes('/api/events/') && 
        query.queryKey[0].includes('/tasks')
      });
      toast({ title: "Task completed" });
      closeTaskModal();
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to complete task",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const openTaskModal = async (task: TaskWithCompletion, viewOnly: boolean = false) => {
    // Open modal immediately for smooth animation
    setSelectedTask(task as TaskWithQuestions);
    setIsViewMode(viewOnly || !!task.completion);
    setPhotoFiles([]);
    setResponses({});
    setTaskModalOpen(true);
    setLoadingTask(true);
    
    // Load full task details in background
    try {
      const res = await fetch(`/api/tasks/${task.id}`, { credentials: 'include' });
      if (!res.ok) {
        throw new Error("Failed to load task");
      }
      const taskWithQuestions: TaskWithQuestions = await res.json();
      setSelectedTask(taskWithQuestions);
    } catch {
      toast({ title: "Failed to load task details", variant: "destructive" });
    } finally {
      setLoadingTask(false);
    }
  };

  const closeTaskModal = () => {
    setTaskModalOpen(false);
    setSelectedTask(null);
    setPhotoFiles([]);
    setResponses({});
    setIsViewMode(false);
  };

  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setPhotoFiles([...photoFiles, ...Array.from(e.target.files)]);
    }
  };

  const removePhoto = (index: number) => {
    setPhotoFiles(photoFiles.filter((_, i) => i !== index));
  };

  const handleSubmitCompletion = async () => {
    if (!selectedTask) return;

    if (selectedTask.requiresPhotoEvidence && photoFiles.length === 0) {
      toast({ title: "Photo required", description: "Please upload at least one photo.", variant: "destructive" });
      return;
    }

    const requiredQuestions = (selectedTask.questions || []).filter(q => q.isRequired);
    for (const q of requiredQuestions) {
      if (responses[q.id] === undefined || responses[q.id] === "") {
        toast({ title: "Answer required", description: `Please answer: ${q.prompt}`, variant: "destructive" });
        return;
      }
    }

    let uploadedUrls: string[] = [];
    if (photoFiles.length > 0) {
      const formData = new FormData();
      formData.append('taskId', selectedTask.id);
      photoFiles.forEach(f => formData.append('photos', f));
      try {
        const uploadRes = await fetch('/api/upload/photos', { 
          method: 'POST', 
          body: formData,
          credentials: 'include'
        });
        if (!uploadRes.ok) throw new Error('Photo upload failed');
        const uploadData = await uploadRes.json();
        uploadedUrls = uploadData.urls || [];
      } catch {
        toast({ title: "Photo upload failed", variant: "destructive" });
        return;
      }
    }

    const formattedResponses = Object.entries(responses).map(([questionId, answer]) => ({
      questionId,
      answer: String(answer),
    }));

    completeTaskMutation.mutate({
      taskId: selectedTask.id,
      photoUrls: uploadedUrls.length > 0 ? uploadedUrls : undefined,
      responses: formattedResponses.length > 0 ? formattedResponses : undefined,
    });
  };

  const canSubmitCompletion = () => {
    if (!selectedTask) return false;
    if (loadingTask) return false;
    if (selectedTask.requiresPhotoEvidence && photoFiles.length === 0) return false;
    const requiredQuestions = (selectedTask.questions || []).filter(q => q.isRequired);
    for (const q of requiredQuestions) {
      if (responses[q.id] === undefined || responses[q.id] === "") return false;
    }
    return true;
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
        <Link href={`/checklist/${checklist.todayRun.id}`}>
          <Button className="h-10" data-testid={`button-continue-${checklist.id}`}>
            <Play className="mr-2 h-4 w-4" />
            Continue
          </Button>
        </Link>
      );
    }

    return (
      <Link href={`/checklist/${checklist.todayRun.id}`}>
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

  const pendingTasks = todayTasks?.filter(t => !t.completion) || [];
  const completedTasks = todayTasks?.filter(t => t.completion) || [];

  return (
    <AppLayout>
      <div className="p-4 max-w-lg mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">Today</h1>
          <p className="text-sm text-muted-foreground">
            {new Date().toLocaleDateString("en-US", { 
              weekday: "long", 
              month: "long", 
              day: "numeric" 
            })}
          </p>
        </div>

        <div className="space-y-4 mb-8">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">{t.today.eventsToday}</h2>
            <Link href="/events">
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
                return (
                  <Link key={event.id} href={`/events/${event.id}`}>
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
                          </div>
                          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-4 mb-8">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">Tasks</h2>
            <Link href="/tasks">
              <Button variant="ghost" size="sm" className="text-xs" data-testid="link-tasks-viewall">
                View All <ChevronRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </div>
          {pendingTasks.length === 0 ? (
            <Card className="p-4">
              <p className="text-sm text-muted-foreground text-center">No pending tasks for today.</p>
            </Card>
          ) : (
            <div className="space-y-2">
              {pendingTasks.map((task) => (
                <Card 
                  key={task.id} 
                  className="overflow-visible hover-elevate active-elevate-2 cursor-pointer" 
                  onClick={() => openTaskModal(task)}
                  data-testid={`card-task-${task.id}`}
                >
                  <CardContent className="p-3">
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 flex items-center justify-center shrink-0">
                        <Circle className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="font-medium text-sm">{task.title}</h4>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                          <Clock className="h-3 w-3" />
                          <span>Due by {task.dueTime}</span>
                          {task.requiresPhotoEvidence && (
                            <Badge variant="outline" className="text-xs">
                              <Camera className="h-2.5 w-2.5 mr-0.5" />
                              Photo
                            </Badge>
                          )}
                          {task.requiresResponses && (
                            <Badge variant="outline" className="text-xs">
                              <MessageSquare className="h-2.5 w-2.5 mr-0.5" />
                              Q&A
                            </Badge>
                          )}
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-4 mb-8">
          <h2 className="text-lg font-semibold">Checklists</h2>
          {!checklists || checklists.length === 0 ? (
            <EmptyState
              title="No checklists"
              description="There are no checklists assigned for today."
            />
          ) : (
            checklists.map((checklist) => (
              <Card key={checklist.id} className="overflow-visible" data-testid={`card-checklist-${checklist.id}`}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <h3 className="font-semibold">{checklist.name}</h3>
                        <StatusBadge status={checklist.computedStatus} />
                      </div>
                      <div className="flex items-center gap-1 text-sm text-muted-foreground">
                        <Clock className="h-3.5 w-3.5" />
                        <span>Due by {checklist.recommendedDueTime}</span>
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
            ))
          )}
        </div>
      </div>

      <Dialog open={taskModalOpen} onOpenChange={(open) => !open && closeTaskModal()}>
        <DialogContent className="max-w-md max-h-[85vh] flex flex-col p-0">
          <DialogHeader className="px-6 pt-6 pb-2 shrink-0">
            <DialogTitle className="flex items-center gap-2">
              {isViewMode ? (
                <>
                  <Eye className="h-5 w-5" />
                  Task Details
                </>
              ) : (
                <>
                  <Check className="h-5 w-5" />
                  Complete Task
                </>
              )}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {isViewMode ? "View task details and completion status" : "Complete this task by providing required evidence"}
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
                    <div className="flex items-center gap-3 mt-2 text-sm text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5" />
                        <span>Due by {selectedTask.dueTime}</span>
                      </div>
                    </div>
                  </div>

                  {selectedTask.referencePhotoUrl && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Info className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm font-medium">Reference Photo</span>
                      </div>
                      <img 
                        src={selectedTask.referencePhotoUrl} 
                        alt="Reference"
                        className="w-full max-w-xs rounded-md border"
                      />
                    </div>
                  )}

                  {!isViewMode && selectedTask.requiresPhotoEvidence && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Camera className="h-4 w-4" />
                          <span className="font-medium text-sm">Photo Evidence</span>
                          <Badge variant="outline" className="text-xs">Required</Badge>
                        </div>
                      </div>
                      
                      <div className="flex flex-wrap gap-2">
                        {photoFiles.map((file, idx) => (
                          <div key={idx} className="relative h-16 w-16 rounded-md overflow-hidden bg-muted">
                            <img 
                              src={URL.createObjectURL(file)} 
                              alt={`Photo ${idx + 1}`}
                              className="h-full w-full object-cover"
                            />
                            <Button
                              size="icon"
                              variant="destructive"
                              className="absolute top-0 right-0 h-5 w-5"
                              onClick={() => removePhoto(idx)}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        ))}
                        <label className="h-16 w-16 rounded-md border-2 border-dashed border-muted-foreground/25 flex items-center justify-center cursor-pointer hover-elevate overflow-visible">
                          <Upload className="h-5 w-5 text-muted-foreground" />
                          <input 
                            type="file" 
                            accept="image/*" 
                            className="hidden" 
                            onChange={handlePhotoUpload}
                            multiple
                          />
                        </label>
                      </div>
                    </div>
                  )}

                  {!isViewMode && selectedTask.requiresResponses && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <MessageSquare className="h-4 w-4" />
                        <span className="font-medium text-sm">Questions</span>
                        {loadingTask && <span className="text-xs text-muted-foreground">(Loading...)</span>}
                      </div>
                      
                      {loadingTask ? (
                        <div className="space-y-3">
                          <div className="h-10 bg-muted animate-pulse rounded-md" />
                          <div className="h-20 bg-muted animate-pulse rounded-md" />
                        </div>
                      ) : selectedTask.questions && selectedTask.questions.length > 0 ? (
                        selectedTask.questions.sort((a, b) => a.sortOrder - b.sortOrder).map((q) => (
                          <div key={q.id} className="space-y-1">
                            <label className="text-sm font-medium flex items-center gap-2">
                              {q.prompt}
                              {q.isRequired && <span className="text-destructive">*</span>}
                            </label>
                            
                            {q.questionType === "text" && (
                              <Textarea
                                value={(responses[q.id] as string) || ""}
                                onChange={(e) => setResponses({ ...responses, [q.id]: e.target.value })}
                                placeholder="Enter your answer"
                                data-testid={`input-response-${q.id}`}
                              />
                            )}
                            
                            {q.questionType === "boolean" && (
                              <div className="flex items-center gap-3">
                                <Switch 
                                  checked={responses[q.id] as boolean || false}
                                  onCheckedChange={(checked) => setResponses({ ...responses, [q.id]: checked })}
                                  data-testid={`switch-response-${q.id}`}
                                />
                                <span className="text-sm text-muted-foreground">
                                  {responses[q.id] ? "Yes" : "No"}
                                </span>
                              </div>
                            )}
                            
                            {q.questionType === "choice" && q.options && (
                              <Select 
                                value={(responses[q.id] as string) || ""}
                                onValueChange={(v) => setResponses({ ...responses, [q.id]: v })}
                              >
                                <SelectTrigger data-testid={`select-response-${q.id}`}>
                                  <SelectValue placeholder="Select an option" />
                                </SelectTrigger>
                                <SelectContent>
                                  {q.options.map((opt, idx) => (
                                    <SelectItem key={idx} value={opt}>{opt}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          </div>
                        ))
                      ) : null}
                    </div>
                  )}

                  {isViewMode && !selectedTask.requiresPhotoEvidence && !selectedTask.requiresResponses && (
                    <div className="p-4 bg-muted/50 rounded-md">
                      <p className="text-sm text-muted-foreground text-center">
                        This is a simple completion task with no additional requirements.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              <div className="shrink-0 flex justify-end gap-2 px-6 py-4 border-t bg-background">
                <Button variant="outline" onClick={closeTaskModal}>
                  {isViewMode ? "Close" : "Cancel"}
                </Button>
                {!isViewMode && (
                  <Button 
                    onClick={handleSubmitCompletion}
                    disabled={!canSubmitCompletion() || completeTaskMutation.isPending}
                    data-testid="button-submit-completion"
                  >
                    {completeTaskMutation.isPending ? "Completing..." : "Mark Complete"}
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
