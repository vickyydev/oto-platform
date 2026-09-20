import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { StudioLayout } from "@/components/layout/studio-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Plus, CalendarDays, Pencil, Trash2, Search, X, ClipboardList, Camera, MessageCircle, Loader2, Sparkles } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { format, parseISO } from "date-fns";
import type { Event, InsertEvent, Department, Branch } from "@shared/schema";
import { AIEventAssistant } from "@/components/ai-event-assistant";

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

type EventFormData = Omit<InsertEvent, "id" | "branchId">;

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
  numChildren: 10,
  numAdults: 5,
  programName: "",
  allergiesNotes: "",
  cakeNotes: "",
  specialRequests: "",
  status: "upcoming",
};

export default function StudioEventsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingEvent, setEditingEvent] = useState<Event | null>(null);
  const [deleteEventId, setDeleteEventId] = useState<string | null>(null);
  const [formData, setFormData] = useState<EventFormData>(defaultFormData);
  
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

  const { data: events, isLoading } = useQuery<Event[]>({
    queryKey: ["/api/events?range=upcoming"],
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

  const createMutation = useMutation({
    mutationFn: async (data: { eventData: EventFormData; tasks: PendingTask[] }) => {
      // First create the event
      const res = await apiRequest("POST", "/api/admin/events", data.eventData);
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events?range=upcoming"] });
      queryClient.invalidateQueries({ queryKey: ["/api/events?range=today"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks/today"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks/grouped"] });
      setShowCreateDialog(false);
      setFormData(defaultFormData);
      setPendingTasks([]);
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
      data: Partial<EventFormData>; 
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
      queryClient.invalidateQueries({ queryKey: ["/api/events?range=upcoming"] });
      queryClient.invalidateQueries({ queryKey: ["/api/events?range=today"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/events?range=upcoming"] });
      queryClient.invalidateQueries({ queryKey: ["/api/events?range=today"] });
      setDeleteEventId(null);
      toast({ title: "Event cancelled successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to cancel event", description: error.message, variant: "destructive" });
    },
  });

  const filteredEvents = events?.filter(event => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      event.title.toLowerCase().includes(query) ||
      event.childName?.toLowerCase().includes(query) ||
      event.parentName?.toLowerCase().includes(query)
    );
  }) || [];

  const openEditDialog = async (event: Event) => {
    setFormData({
      eventType: event.eventType,
      title: event.title,
      eventDate: event.eventDate,
      startTime: event.startTime,
      endTime: event.endTime || "",
      childName: event.childName || "",
      bookingName: event.bookingName || "",
      parentName: event.parentName || "",
      whatsappPhoneRaw: event.whatsappPhoneRaw || "",
      numChildren: event.numChildren || 0,
      numAdults: event.numAdults || 0,
      programName: event.programName || "",
      allergiesNotes: event.allergiesNotes || "",
      cakeNotes: event.cakeNotes || "",
      specialRequests: event.specialRequests || "",
      status: event.status,
    });
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
    if (editingEvent) {
      const newTasks = pendingTasks.filter(t => !t.isExisting);
      updateMutation.mutate({ 
        id: editingEvent.id, 
        data: formData, 
        newTasks,
        deletedTaskIds: tasksToDelete,
      });
    } else {
      createMutation.mutate({ eventData: formData, tasks: pendingTasks });
    }
  };

  if (isLoading) {
    return (
      <StudioLayout>
        <LoadingScreen />
      </StudioLayout>
    );
  }

  return (
    <StudioLayout>
      <div className="p-4 max-w-lg mx-auto">
        <div className="flex items-center justify-between gap-4 mb-4">
          <h1 className="text-xl font-bold">Events</h1>
          <Button onClick={() => { setFormData(defaultFormData); setPendingTasks([]); resetTaskForm(); setShowCreateDialog(true); }} data-testid="button-create-event">
            <Plus className="h-4 w-4 mr-2" />
            New Event
          </Button>
        </div>

        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search events..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="input-search-events"
          />
        </div>

        <div className="space-y-3">
          {filteredEvents.length === 0 ? (
            <EmptyState
              icon={CalendarDays}
              title="No events"
              description="Create your first event to get started"
            />
          ) : (
            filteredEvents.map((event) => (
              <Card key={event.id} className="overflow-visible" data-testid={`card-event-${event.id}`}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <h3 className="font-semibold">{event.title}</h3>
                        <Badge variant="secondary" className="text-xs capitalize">
                          {event.eventType.replace("_", " ")}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {format(parseISO(event.eventDate), "MMM d, yyyy")} at {event.startTime}
                      </p>
                      {event.parentName && (
                        <p className="text-sm text-muted-foreground">{event.parentName}</p>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <Button size="icon" variant="ghost" onClick={() => openEditDialog(event)} data-testid={`button-edit-event-${event.id}`}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button size="icon" variant="ghost" className="text-destructive" onClick={() => setDeleteEventId(event.id)} data-testid={`button-delete-event-${event.id}`}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>

      <Dialog open={showCreateDialog || !!editingEvent} onOpenChange={(open) => { if (!open) { setShowCreateDialog(false); setEditingEvent(null); } }}>
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
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Event Type</Label>
              <Select value={formData.eventType} onValueChange={(v) => setFormData(prev => ({ ...prev, eventType: v as any }))}>
                <SelectTrigger data-testid="select-event-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="birthday">Birthday</SelectItem>
                  <SelectItem value="private_event">Private Event</SelectItem>
                  <SelectItem value="school_group">School Group</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Title</Label>
              <Input value={formData.title} onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))} placeholder="e.g., Emma's 5th Birthday" data-testid="input-event-title" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Date</Label>
                <Input type="date" value={formData.eventDate} onChange={(e) => setFormData(prev => ({ ...prev, eventDate: e.target.value }))} data-testid="input-event-date" />
              </div>
              <div className="space-y-2">
                <Label>Start Time</Label>
                <Input type="time" value={formData.startTime} onChange={(e) => setFormData(prev => ({ ...prev, startTime: e.target.value }))} data-testid="input-event-start" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>End Time <span className="text-muted-foreground font-normal">(Optional)</span></Label>
                <Input type="time" value={formData.endTime || ""} onChange={(e) => setFormData(prev => ({ ...prev, endTime: e.target.value || null }))} data-testid="input-event-end" />
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={formData.status} onValueChange={(v) => setFormData(prev => ({ ...prev, status: v as any }))}>
                  <SelectTrigger data-testid="select-event-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="upcoming">Upcoming</SelectItem>
                    <SelectItem value="in_progress">In Progress</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
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
              <Input value={formData.whatsappPhoneRaw || ""} onChange={(e) => setFormData(prev => ({ ...prev, whatsappPhoneRaw: e.target.value }))} placeholder="+66..." data-testid="input-whatsapp" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Children</Label>
                <Input type="number" value={formData.numChildren || ""} onChange={(e) => setFormData(prev => ({ ...prev, numChildren: parseInt(e.target.value) || 0 }))} data-testid="input-num-children" />
              </div>
              <div className="space-y-2">
                <Label>Adults</Label>
                <Input type="number" value={formData.numAdults || ""} onChange={(e) => setFormData(prev => ({ ...prev, numAdults: parseInt(e.target.value) || 0 }))} data-testid="input-num-adults" />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Program/Package</Label>
              <Input value={formData.programName || ""} onChange={(e) => setFormData(prev => ({ ...prev, programName: e.target.value }))} placeholder="e.g., Premium Birthday Package" data-testid="input-program" />
            </div>
            <div className="space-y-2">
              <Label>Special Requests</Label>
              <Textarea value={formData.specialRequests || ""} onChange={(e) => setFormData(prev => ({ ...prev, specialRequests: e.target.value }))} placeholder="Any special requirements" data-testid="input-requests" />
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
                    <div className="grid grid-cols-2 gap-3">
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowCreateDialog(false); setEditingEvent(null); }}>Cancel</Button>
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
        currentFormData={formData}
        onApply={(updates) => {
          setFormData(prev => ({ ...prev, ...updates }));
        }}
        branchContext={user?.branchId && branches ? {
          branch_id: user.branchId,
          branch_name: branches.find(b => b.id === user.branchId)?.name || "",
        } : undefined}
      />
    </StudioLayout>
  );
}
