import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Clock,
  Calendar,
  User,
  CheckCircle,
  Circle,
  AlertTriangle,
  Camera,
  MessageSquare,
  Send,
  Upload,
  X,
  Pencil,
  Ban,
  ShieldAlert,
  UserPlus,
  ChevronDown,
  ChevronRight,
  History,
  Paperclip,
  FileText,
  Image,
  Film,
  Download,
  Trash2,
  Plus,
  ListChecks,
  SquareCheck,
  Square,
  CalendarDays,
  GripVertical,
  XCircle,
  Undo2,
  Check,
} from "lucide-react";
import { format, parseISO, differenceInDays, formatDistanceToNow } from "date-fns";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarPicker } from "@/components/ui/calendar";
import { DndContext, DragEndEvent, PointerSensor, TouchSensor, useSensor, useSensors, closestCenter } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAuth } from "@/lib/auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import AssignmentSearchBar, { type AssignmentValue, getAssignmentSummary } from "@/components/core/AssignmentSearchBar";

interface TaskDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string | null;
  readOnly?: boolean;
}

interface TaskQuestion {
  id: string;
  prompt: string;
  questionType: "text" | "boolean" | "choice" | "number" | "multiple_choice";
  options?: string[];
  isRequired: boolean;
  sortOrder: number;
}

interface TaskCommentData {
  id: string;
  taskId: string;
  authorId: string;
  body: string;
  createdAt: string;
  authorName: string;
  authorAvatar: string | null;
}

interface TaskActivityData {
  id: string;
  taskId: string;
  activityType: string;
  description: string;
  userId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  actorName: string;
  actorAvatar: string | null;
}

interface TaskAttachmentData {
  id: string;
  taskId: string;
  fileName: string;
  fileUrl: string;
  fileSize: number;
  mimeType: string;
  uploadedBy: string;
  createdAt: string;
  uploaderDisplayName: string;
}

interface TaskChecklistItemData {
  id: string;
  taskId: string;
  title: string;
  isChecked: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface TaskData {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  priority?: string | null;
  dueAt?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  startAt?: string | null;
  startDate?: string | null;
  branchId?: string | null;
  branchName?: string | null;
  assignedTo?: string | null;
  assignedEmployeeId?: string | null;
  assignedRoleId?: string | null;
  assignedDepartmentId?: string | null;
  assignedUserName?: string | null;
  assignedRoleName?: string | null;
  assignedDepartmentName?: string | null;
  assignments?: { id: string; assignmentType: string; assignmentId: string; label?: string }[];
  createdByName?: string | null;
  requiresPhotoEvidence?: boolean;
  requiresResponses?: boolean;
  referencePhotoUrl?: string | null;
  isOverdue?: boolean;
  isStagnant?: boolean;
  isArchived?: boolean;
  escalated?: boolean;
  progressPercent?: number;
  scheduledMode?: boolean;
  statusManualOverride?: boolean;
  blockedReason?: string | null;
  taskLevel?: string | null;
  completedAt?: string | null;
  recurrence?: string | null;
  questions?: TaskQuestion[];
  completions?: {
    id: string;
    completedBy: string;
    completedAt: string;
    completedByName?: string | null;
    photoUrls?: string[] | null;
  }[];
}

function ProgressSlider({
  value,
  expectedPercent,
  onChange,
  onRelease,
  disabled,
}: {
  value: number;
  expectedPercent: number;
  onChange: (val: number) => void;
  onRelease: () => void;
  disabled?: boolean;
}) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(parseInt(e.target.value, 10));
  };

  const clampedExpected = Math.max(0, Math.min(100, expectedPercent));

  return (
    <div className="relative w-full py-4 px-3">
      <div className="relative h-3 rounded-full bg-muted">
        <div
          className="absolute top-0 left-0 h-full rounded-l-full bg-primary transition-all duration-150"
          style={{
            width: `${Math.max(0, Math.min(100, value))}%`,
            borderTopRightRadius: value >= 100 ? "9999px" : "0",
            borderBottomRightRadius: value >= 100 ? "9999px" : "0",
          }}
        />
        {expectedPercent > 0 && expectedPercent < 100 && (
          <div
            className="absolute w-1 bg-red-500 rounded-full shadow-sm"
            style={{
              left: `${clampedExpected}%`,
              transform: "translateX(-50%)",
              top: "-6px",
              bottom: "-6px",
            }}
          />
        )}
      </div>
      <div
        className="absolute top-1/2 w-6 h-6 rounded-full bg-primary border-2 border-primary-foreground shadow-lg pointer-events-none"
        style={{
          left: `calc(${value}% + ${12 - (value / 100) * 24}px)`,
          transform: "translateY(-50%)",
        }}
      />
      <input
        type="range"
        min="0"
        max="100"
        value={value}
        onChange={handleChange}
        onMouseUp={onRelease}
        onTouchEnd={onRelease}
        disabled={disabled}
        className="absolute top-0 left-0 right-0 bottom-0 w-full h-full opacity-0 cursor-pointer"
        data-testid="slider-progress"
      />
    </div>
  );
}

function getScheduleInfo(
  startDate: Date | null,
  dueDate: Date | null,
  progressPercent: number
) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (!startDate || !dueDate) {
    return { expectedPercent: 0, daysDiff: 0, status: "unknown" as const };
  }

  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);

  const totalDays = Math.max(1, differenceInDays(due, start) + 1);
  const elapsedDays = Math.max(0, differenceInDays(today, start) + 1);

  let elapsedRatio = elapsedDays / totalDays;
  elapsedRatio = Math.max(0, Math.min(1, elapsedRatio));

  const expectedPercent = elapsedRatio * 100;
  const percentDiff = progressPercent - expectedPercent;
  const daysDiff = Math.round((percentDiff / 100) * totalDays);

  let status: "ahead" | "on_track" | "behind" | "not_started" | "past_due" = "on_track";
  if (today < start) {
    status = "not_started";
  } else if (today > due && progressPercent < 100) {
    status = "past_due";
  } else if (daysDiff < -1) {
    status = "behind";
  } else if (daysDiff > 1) {
    status = "ahead";
  }

  return { expectedPercent, daysDiff, status, totalDays, elapsedDays };
}

function getStatusBadge(status: string) {
  switch (status) {
    case "completed":
      return <Badge className="bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400"><CheckCircle className="h-3 w-3 mr-1" />Completed</Badge>;
    case "active":
    case "in_progress":
      return <Badge className="bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400"><Clock className="h-3 w-3 mr-1" />In Progress</Badge>;
    case "overdue":
      return <Badge className="bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400"><AlertTriangle className="h-3 w-3 mr-1" />Overdue</Badge>;
    default:
      return <Badge className="bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-400"><Circle className="h-3 w-3 mr-1" />Pending</Badge>;
  }
}


function SortableChecklistItem({ id, children, disabled }: { id: string; children: React.ReactNode; disabled?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: "relative" as const,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <div className="flex items-center">
        {!disabled && (
          <button type="button" className="shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground mr-0.5 touch-none" {...listeners} data-testid={`drag-handle-checklist-${id}`}>
            <GripVertical className="h-3.5 w-3.5" />
          </button>
        )}
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </div>
  );
}

function EditDueTimePicker({ value, onSave }: { value: string; onSave: (time: string) => void }) {
  const [hour, minute] = (value || "18:00").split(":").map(Number);
  const [localHour, setLocalHour] = useState(hour);
  const [localMinute, setLocalMinute] = useState(minute);
  const [isOpen, setIsOpen] = useState(false);
  const currentVal = `${String(localHour).padStart(2, "0")}:${String(localMinute).padStart(2, "0")}`;
  const isDirty = currentVal !== value;

  useEffect(() => {
    if (isOpen) {
      const [h, m] = (value || "18:00").split(":").map(Number);
      setLocalHour(h);
      setLocalMinute(m);
    }
  }, [isOpen, value]);

  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = [0, 15, 30, 45];

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 font-medium text-muted-foreground"
          data-testid="input-due-time"
        >
          <Clock className="h-3 w-3 mr-1.5 shrink-0" />
          {value}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3" align="start" side="bottom" sideOffset={4}>
        <div className="flex items-center gap-2">
          <Select value={String(localHour)} onValueChange={(v) => setLocalHour(Number(v))}>
            <SelectTrigger className="w-[70px]" data-testid="select-due-hour">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {hours.map((h) => (
                <SelectItem key={h} value={String(h)}>
                  {String(h).padStart(2, "0")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-sm font-medium text-muted-foreground">:</span>
          <Select value={String(localMinute)} onValueChange={(v) => setLocalMinute(Number(v))}>
            <SelectTrigger className="w-[70px]" data-testid="select-due-minute">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {minutes.map((m) => (
                <SelectItem key={m} value={String(m)}>
                  {String(m).padStart(2, "0")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="icon"
            variant="default"
            className={`shrink-0 transition-opacity ${isDirty ? "opacity-100" : "opacity-40"}`}
            disabled={!isDirty}
            onClick={() => {
              onSave(currentVal);
              setIsOpen(false);
            }}
            data-testid="button-save-due-time"
          >
            <Check className="h-3.5 w-3.5" />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function TaskDetailSheet({ open, onOpenChange, taskId, readOnly = false }: TaskDetailSheetProps) {
  const { user } = useAuth();
  const { toast } = useToast();

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [localProgress, setLocalProgress] = useState<number | null>(null);
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [photoPreviews, setPhotoPreviews] = useState<string[]>([]);
  const [responses, setResponses] = useState<Record<string, string | boolean>>({});
  const [newComment, setNewComment] = useState("");
  const commentsEndRef = useRef<HTMLDivElement>(null);
  const [commentsExpanded, setCommentsExpanded] = useState(false);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [attachmentsExpanded, setAttachmentsExpanded] = useState<boolean | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [checklistExpanded, setChecklistExpanded] = useState<boolean | null>(null);
  const [newChecklistItem, setNewChecklistItem] = useState("");
  const [addingChecklistItem, setAddingChecklistItem] = useState(false);
  const [editingChecklistId, setEditingChecklistId] = useState<string | null>(null);
  const [editingChecklistTitle, setEditingChecklistTitle] = useState("");
  const [editingAssignment, setEditingAssignment] = useState(false);
  const [dueDatePopoverOpen, setDueDatePopoverOpen] = useState(false);
  const [assignmentsDraft, setAssignmentsDraft] = useState<AssignmentValue[]>([]);

  const { data: assignableEmployees = [] } = useQuery<{ id: string; fullName: string; nickname?: string | null; userId?: string | null; branchId?: string | null }[]>({
    queryKey: ["/api/employees"],
    enabled: open && !readOnly,
  });

  const { data: assignableAdvisors = [] } = useQuery<{ id: string; fullName: string; preferredName: string | null }[]>({
    queryKey: ["/api/people", { personType: "ADVISOR" }],
    queryFn: async () => {
      const res = await fetch("/api/people?personType=ADVISOR");
      if (!res.ok) return [];
      return res.json();
    },
    enabled: open && !readOnly,
  });

  const { data: assignableRoles = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["/api/roles"],
    enabled: open && !readOnly,
  });

  const { data: assignableDepartments = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["/api/departments"],
    enabled: open && !readOnly,
  });

  const { data: assignableBranches = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["/api/studio/branches"],
    enabled: open && !readOnly,
  });

  const { data: task, isLoading } = useQuery<TaskData>({
    queryKey: ["/api/core/tasks", taskId],
    queryFn: async () => {
      const res = await fetch(`/api/core/tasks/${taskId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch task");
      return res.json();
    },
    enabled: !!taskId && open,
  });

  const { data: comments = [] } = useQuery<TaskCommentData[]>({
    queryKey: ["/api/core/tasks", taskId, "comments"],
    queryFn: async () => {
      const res = await fetch(`/api/core/tasks/${taskId}/comments`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch comments");
      return res.json();
    },
    enabled: !!taskId && open,
  });

  const { data: activities = [] } = useQuery<TaskActivityData[]>({
    queryKey: ["/api/core/tasks", taskId, "activities"],
    queryFn: async () => {
      const res = await fetch(`/api/core/tasks/${taskId}/activities`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch activities");
      return res.json();
    },
    enabled: !!taskId && open,
  });

  const { data: attachments = [] } = useQuery<TaskAttachmentData[]>({
    queryKey: ["/api/core/tasks", taskId, "attachments"],
    queryFn: async () => {
      const res = await fetch(`/api/core/tasks/${taskId}/attachments`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch attachments");
      return res.json();
    },
    enabled: !!taskId && open,
  });

  const { data: checklistItems = [] } = useQuery<TaskChecklistItemData[]>({
    queryKey: ["/api/core/tasks", taskId, "checklist"],
    queryFn: async () => {
      const res = await fetch(`/api/core/tasks/${taskId}/checklist`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch checklist");
      return res.json();
    },
    enabled: !!taskId && open,
  });

  useEffect(() => {
    if (task) {
      setLocalProgress(task.progressPercent ?? 0);
    }
  }, [task]);

  useEffect(() => {
    if (!open) {
      setEditingTitle(false);
      setEditingDescription(false);
      setPhotoFiles([]);
      setPhotoPreviews([]);
      setResponses({});
      setNewComment("");
      setLocalProgress(null);
      setAttachmentsExpanded(null);
      setChecklistExpanded(null);
      setNewChecklistItem("");
      setAddingChecklistItem(false);
      setEditingChecklistId(null);
      setEditingAssignment(false);
      setAssignmentsDraft([]);
    }
  }, [open]);

  const updateTaskMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      return apiRequest("PATCH", `/api/core/tasks/${taskId}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks", taskId] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks/activities"] });
      toast({ title: "Task updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateProgressMutation = useMutation({
    mutationFn: async (progressPercent: number) => {
      return apiRequest("PATCH", `/api/core/tasks/${taskId}/progress`, { progressPercent });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks", taskId] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks/multi-day"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks/activities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks/today"] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const blockMutation = useMutation({
    mutationFn: async (blockedReason: string) => {
      return apiRequest("POST", `/api/core/tasks/${taskId}/block`, { blockedReason });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks", taskId] });
      toast({ title: "Task blocked" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const unblockMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", `/api/core/tasks/${taskId}/unblock`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks", taskId] });
      toast({ title: "Task unblocked" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const completeTaskMutation = useMutation({
    mutationFn: async (data: { photoUrls?: string[]; responses?: Record<string, unknown> }) => {
      return apiRequest("POST", `/api/core/tasks/${taskId}/complete`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks", taskId] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks/today"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks/multi-day"] });
      setPhotoFiles([]);
      setPhotoPreviews([]);
      setResponses({});
      toast({ title: "Task completed" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const addCommentMutation = useMutation({
    mutationFn: async (body: string) => {
      return apiRequest("POST", `/api/core/tasks/${taskId}/comments`, { body });
    },
    onSuccess: () => {
      setNewComment("");
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks", taskId, "comments"] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to add comment", variant: "destructive" });
    },
  });

  const uploadAttachmentsMutation = useMutation({
    mutationFn: async (files: File[]) => {
      const formData = new FormData();
      files.forEach(f => formData.append("files", f));
      const res = await fetch(`/api/core/tasks/${taskId}/attachments`, {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) throw new Error("Upload failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks", taskId, "attachments"] });
      toast({ title: "Files attached" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteAttachmentMutation = useMutation({
    mutationFn: async (attachmentId: string) => {
      return apiRequest("DELETE", `/api/core/tasks/${taskId}/attachments/${attachmentId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks", taskId, "attachments"] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const addChecklistItemMutation = useMutation({
    mutationFn: async (title: string) => {
      return apiRequest("POST", `/api/core/tasks/${taskId}/checklist`, { title });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks", taskId, "checklist"] });
      setNewChecklistItem("");
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateChecklistItemMutation = useMutation({
    mutationFn: async ({ itemId, ...data }: { itemId: string; isChecked?: boolean; title?: string; dueAt?: string | null }) => {
      return apiRequest("PATCH", `/api/core/tasks/${taskId}/checklist/${itemId}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks", taskId, "checklist"] });
      setEditingChecklistId(null);
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const reorderChecklistMutation = useMutation({
    mutationFn: async (orderedIds: string[]) => {
      return apiRequest("PUT", `/api/core/tasks/${taskId}/checklist/reorder`, { orderedIds });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks", taskId, "checklist"] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const checklistDndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } })
  );

  const handleChecklistDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !checklistItems.length) return;

    const oldIndex = checklistItems.findIndex((item) => item.id === active.id);
    const newIndex = checklistItems.findIndex((item) => item.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(checklistItems, oldIndex, newIndex);
    queryClient.setQueryData(["/api/core/tasks", taskId, "checklist"], reordered);
    reorderChecklistMutation.mutate(reordered.map((item) => item.id));
  }, [checklistItems, taskId, reorderChecklistMutation]);

  const deleteChecklistItemMutation = useMutation({
    mutationFn: async (itemId: string) => {
      return apiRequest("DELETE", `/api/core/tasks/${taskId}/checklist/${itemId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks", taskId, "checklist"] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: async (activityId: string) => {
      return apiRequest("POST", `/api/core/tasks/${taskId}/rollback/${activityId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks", taskId] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks", taskId, "activities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks"] });
      toast({ title: "Rolled back", description: "Change has been reverted" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const rollbackableTypes = new Set([
    "status_changed", "priority_changed", "due_date_changed", "description_changed", "assigned",
  ]);

  const canRollback = (activity: TaskActivityData) => {
    if (!rollbackableTypes.has(activity.activityType)) return false;
    if (!activity.metadata) return false;
    const meta = activity.metadata as Record<string, unknown>;
    if (meta.rollbackFromActivityId) return false;
    if (activity.activityType === "assigned" && meta.oldAssignments === undefined) return false;
    return true;
  };

  const handleAttachmentDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) {
      uploadAttachmentsMutation.mutate(droppedFiles);
    }
  }, [uploadAttachmentsMutation]);

  const handleAttachmentSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files;
    if (!selectedFiles) return;
    uploadAttachmentsMutation.mutate(Array.from(selectedFiles));
    e.target.value = "";
  }, [uploadAttachmentsMutation]);

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function getFileIcon(mimeType: string) {
    if (mimeType.startsWith("image/")) return Image;
    if (mimeType.startsWith("video/")) return Film;
    return FileText;
  }

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const newFiles = Array.from(files);
    setPhotoFiles(prev => [...prev, ...newFiles]);
    newFiles.forEach(file => {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          setPhotoPreviews(prev => [...prev, event.target!.result as string]);
        }
      };
      reader.readAsDataURL(file);
    });
    e.target.value = "";
  };

  const removePhoto = (index: number) => {
    setPhotoFiles(prev => prev.filter((_, i) => i !== index));
    setPhotoPreviews(prev => prev.filter((_, i) => i !== index));
  };

  const handleCompleteTask = () => {
    if (task?.requiresPhotoEvidence && photoPreviews.length === 0) {
      toast({ title: "Photo required", description: "Please add at least one photo", variant: "destructive" });
      return;
    }

    const requiredQuestions = (task?.questions || []).filter(q => q.isRequired);
    for (const q of requiredQuestions) {
      if (responses[q.id] === undefined || responses[q.id] === "") {
        toast({ title: "Answer required", description: `Please answer: ${q.prompt}`, variant: "destructive" });
        return;
      }
    }

    const responsesObj: Record<string, unknown> = {};
    for (const [qId, answer] of Object.entries(responses)) {
      if (answer !== undefined && answer !== "") {
        responsesObj[qId] = answer;
      }
    }

    completeTaskMutation.mutate({
      photoUrls: photoPreviews.length > 0 ? photoPreviews : undefined,
      responses: Object.keys(responsesObj).length > 0 ? responsesObj : undefined,
    });
  };

  const handleProgressRelease = useCallback(() => {
    const currentProgress = localProgress ?? task?.progressPercent ?? 0;
    if (task && currentProgress !== (task.progressPercent ?? 0)) {
      updateProgressMutation.mutate(currentProgress);
    }
  }, [localProgress, task, updateProgressMutation]);

  const handleSaveTitle = () => {
    if (titleDraft.trim() && titleDraft.trim() !== task?.title) {
      updateTaskMutation.mutate({ title: titleDraft.trim() });
    }
    setEditingTitle(false);
  };

  const handleSaveDescription = () => {
    if (descriptionDraft !== (task?.description || "")) {
      updateTaskMutation.mutate({ description: descriptionDraft || null });
    }
    setEditingDescription(false);
  };

  const isCompleted = task?.status === "completed";
  const isOverdue = task?.status === "overdue";
  const parseDateStr = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const startDate = task?.startDate ? parseDateStr(task.startDate) : task?.startAt ? parseISO(task.startAt) : null;
  const dueDate = task?.dueDate ? parseDateStr(task.dueDate) : task?.dueAt ? parseISO(task.dueAt) : null;
  const currentProgress = localProgress ?? task?.progressPercent ?? 0;
  const scheduleInfo = task ? getScheduleInfo(startDate, dueDate, currentProgress) : null;

  const getDaysDiffDisplay = () => {
    if (!scheduleInfo) return null;
    if (scheduleInfo.status === "not_started") return <span className="text-muted-foreground text-xs">Not started</span>;
    if (scheduleInfo.status === "past_due") return <span className="text-red-500 text-xs font-semibold">Past due</span>;
    if (scheduleInfo.daysDiff < -1) return <span className="text-red-500 text-xs font-semibold">-{Math.abs(scheduleInfo.daysDiff)}d</span>;
    if (scheduleInfo.daysDiff > 1) return <span className="text-green-500 text-xs font-semibold">+{scheduleInfo.daysDiff}d</span>;
    return <span className="text-muted-foreground text-xs">On track</span>;
  };

  const getStatusAccentClass = () => {
    switch (task?.status) {
      case "completed": return "bg-green-500/10 dark:bg-green-500/20";
      case "active":
      case "in_progress": return "bg-blue-500/10 dark:bg-blue-500/20";
      case "overdue": return "bg-red-500/10 dark:bg-red-500/20";
      default: return "bg-muted/50";
    }
  };

  const getDueDateColor = () => {
    if (!dueDate) return "";
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(dueDate);
    due.setHours(0, 0, 0, 0);
    const diff = differenceInDays(due, today);
    if (diff < 0) return "text-red-600 dark:text-red-400";
    if (diff <= 1) return "text-amber-600 dark:text-amber-400";
    return "";
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[400px] sm:w-[500px] sm:max-w-[500px] p-0 flex flex-col" data-testid="sheet-task-detail">
        <div className="flex-1 overflow-y-auto pb-20">
          <SheetHeader className="sr-only">
            <SheetTitle>Task Details</SheetTitle>
          </SheetHeader>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !task ? (
            <div className="py-12 text-center text-muted-foreground text-sm">
              Task not found
            </div>
          ) : (
            <div className="space-y-5">
              {/* Status accent strip + header */}
              <div className={`px-5 pt-5 pb-4 ${getStatusAccentClass()}`}>
                {editingTitle && !readOnly ? (
                  <Input
                    autoFocus
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onBlur={handleSaveTitle}
                    onKeyDown={(e) => { if (e.key === "Enter") handleSaveTitle(); if (e.key === "Escape") setEditingTitle(false); }}
                    className="text-xl font-bold"
                    data-testid="input-edit-title"
                  />
                ) : (
                  <h2
                    className={`text-xl font-bold leading-tight ${!readOnly ? "cursor-pointer hover-elevate active-elevate-2 rounded-md px-1 -mx-1" : ""}`}
                    onClick={() => {
                      if (!readOnly) {
                        setTitleDraft(task.title);
                        setEditingTitle(true);
                      }
                    }}
                    data-testid="text-task-title"
                  >
                    {task.title}
                  </h2>
                )}
                <div className="flex items-center gap-2 mt-3 flex-wrap">
                  {!readOnly ? (
                    <Select
                      value={task.status}
                      onValueChange={(val) => updateTaskMutation.mutate({ status: val })}
                    >
                      <SelectTrigger className="w-auto h-auto p-0 border-0 shadow-none [&>svg]:hidden" data-testid="select-status">
                        <SelectValue>{getStatusBadge(task.status)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="pending">
                          <span className="flex items-center gap-1.5"><Circle className="h-3 w-3 text-slate-500" />Pending</span>
                        </SelectItem>
                        <SelectItem value="in_progress">
                          <span className="flex items-center gap-1.5"><Clock className="h-3 w-3 text-blue-500" />In Progress</span>
                        </SelectItem>
                        <SelectItem value="completed">
                          <span className="flex items-center gap-1.5"><CheckCircle className="h-3 w-3 text-green-500" />Completed</span>
                        </SelectItem>
                        <SelectItem value="overdue">
                          <span className="flex items-center gap-1.5"><AlertTriangle className="h-3 w-3 text-red-500" />Overdue</span>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    getStatusBadge(task.status)
                  )}
                </div>
              </div>

              <div className="px-5 space-y-5">
                {/* Alert banner */}
                {(task.isOverdue || task.isStagnant || task.escalated) && (
                  <div className={`rounded-md p-3 flex items-center gap-3 flex-wrap ${
                    task.isOverdue ? "bg-red-500/10 dark:bg-red-500/15" : "bg-amber-500/10 dark:bg-amber-500/15"
                  }`}>
                    <AlertTriangle className={`h-4 w-4 shrink-0 ${
                      task.isOverdue ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"
                    }`} />
                    <div className="flex items-center gap-2 flex-wrap">
                      {task.isOverdue && (
                        <span className="text-sm font-medium text-red-700 dark:text-red-400">Overdue</span>
                      )}
                      {task.isStagnant && (
                        <span className="text-sm font-medium text-amber-700 dark:text-amber-400">Stagnant</span>
                      )}
                      {task.escalated && (
                        <span className="text-sm font-medium text-red-700 dark:text-red-400 flex items-center gap-1">
                          <ShieldAlert className="h-3.5 w-3.5" />Escalated
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* Details rows */}
                <div className="space-y-0 rounded-md border divide-y">
                  {/* Due date row */}
                  {(task.dueDate || task.dueAt || !readOnly) && (() => {
                    const dueDateStr = task.dueDate as string | undefined;
                    const parsedDueLocal = dueDateStr ? (() => { const [y, m, d] = dueDateStr.split("-").map(Number); return new Date(y, m - 1, d); })() : null;
                    const displayDue = parsedDueLocal ? format(parsedDueLocal, "d MMM yyyy") : null;
                    return (
                      <div className="flex items-center gap-3 px-4 py-3">
                        <CalendarDays className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="text-xs text-muted-foreground w-20 shrink-0">Due</span>
                        <div className="flex-1 min-w-0">
                          {!readOnly ? (
                            <div className="flex items-center gap-2 flex-wrap">
                              <Popover open={dueDatePopoverOpen} onOpenChange={setDueDatePopoverOpen}>
                                <PopoverTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className={`h-7 px-2 font-medium ${getDueDateColor()}`}
                                    data-testid="input-due-date"
                                  >
                                    {displayDue || "Pick a date"}
                                  </Button>
                                </PopoverTrigger>
                                <PopoverContent className="w-auto p-0" align="start">
                                  <CalendarPicker
                                    mode="single"
                                    selected={parsedDueLocal || undefined}
                                    onSelect={(date) => {
                                      if (date) {
                                        const timeStr = task.dueTime || task.preferredDueTime || "18:00";
                                        updateTaskMutation.mutate({ dueAt: `${format(date, "yyyy-MM-dd")}T${timeStr}:00` });
                                        setDueDatePopoverOpen(false);
                                      }
                                    }}
                                    defaultMonth={parsedDueLocal || new Date()}
                                    data-testid="calendar-task-due"
                                  />
                                </PopoverContent>
                              </Popover>
                              {parsedDueLocal && (
                                <EditDueTimePicker
                                  value={task.dueTime || task.preferredDueTime || "18:00"}
                                  onSave={(newTime) => {
                                    if (parsedDueLocal) {
                                      updateTaskMutation.mutate({ dueAt: `${format(parsedDueLocal, "yyyy-MM-dd")}T${newTime}:00` });
                                    }
                                  }}
                                />
                              )}
                            </div>
                          ) : (
                            <p className={`text-sm font-medium ${getDueDateColor()}`}>
                              {displayDue || ""}
                              {task.dueTime && <span className="ml-1 text-muted-foreground font-normal text-xs">at {task.dueTime}</span>}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Assigned to row */}
                  <div className="flex items-start gap-3 px-4 py-3">
                    <User className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                    <span className="text-xs text-muted-foreground w-20 shrink-0 mt-0.5">Assigned to</span>
                    <div className="flex-1 min-w-0">
                      {editingAssignment && !readOnly ? (
                        <div className="space-y-2">
                          <AssignmentSearchBar
                            value={assignmentsDraft}
                            onChange={(vals) => {
                              setAssignmentsDraft(vals);
                            }}
                            employees={assignableEmployees}
                            advisors={assignableAdvisors}
                            roles={assignableRoles}
                            departments={assignableDepartments}
                            branches={assignableBranches}
                            placeholder="Change assignment..."
                            showEveryone={true}
                          />
                          <p className="text-xs text-muted-foreground">
                            {getAssignmentSummary(assignmentsDraft)}
                          </p>
                          <div className="flex items-center gap-1.5 pt-0.5">
                            <button
                              type="button"
                              onClick={() => {
                                const taskAssignments = assignmentsDraft
                                  .filter(v => v.type !== "everyone")
                                  .map(v => ({
                                    assignmentType: v.type as string,
                                    assignmentId: v.id,
                                  }));
                                updateTaskMutation.mutate({ assignments: taskAssignments });
                                setEditingAssignment(false);
                              }}
                              disabled={updateTaskMutation.isPending}
                              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
                              data-testid="button-save-assignment"
                            >
                              {updateTaskMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                              Save
                            </button>
                            <span className="text-muted-foreground/30">|</span>
                            <button
                              type="button"
                              onClick={() => setEditingAssignment(false)}
                              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                              data-testid="button-cancel-assignment"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            if (readOnly) return;
                            const draft: AssignmentValue[] = [];
                            if (task.assignments && task.assignments.length > 0) {
                              for (const a of task.assignments) {
                                draft.push({
                                  type: a.assignmentType as AssignmentValue["type"],
                                  id: a.assignmentId,
                                  label: a.label || a.assignmentId,
                                });
                              }
                            } else {
                              if (task.assignedEmployeeId) {
                                const emp = assignableEmployees.find(e => e.id === task.assignedEmployeeId);
                                if (emp) draft.push({ type: "employee", id: emp.id, label: emp.nickname || emp.fullName });
                              } else if (task.assignedTo) {
                                const adv = assignableAdvisors.find(a => a.id === task.assignedTo);
                                if (adv) draft.push({ type: "advisor", id: adv.id, label: adv.preferredName || adv.fullName });
                              }
                              if (task.assignedRoleId) {
                                const role = assignableRoles.find(r => r.id === task.assignedRoleId);
                                if (role) draft.push({ type: "role", id: role.id, label: role.name });
                              }
                              if (task.assignedDepartmentId) {
                                const dept = assignableDepartments.find(d => d.id === task.assignedDepartmentId);
                                if (dept) draft.push({ type: "department", id: dept.id, label: dept.name });
                              }
                            }
                            setAssignmentsDraft(draft);
                            setEditingAssignment(true);
                          }}
                          className={`text-sm font-medium text-left ${!readOnly ? "hover:text-primary cursor-pointer" : ""}`}
                          data-testid="text-task-assignee"
                        >
                          {(() => {
                            if (task.assignments && task.assignments.length > 0) {
                              return task.assignments.map(a => a.label || a.assignmentId).join(", ");
                            }
                            return task.assignedUserName || task.assignedRoleName || task.assignedDepartmentName || "Unassigned";
                          })()}
                          {!readOnly && <Pencil className="inline-block h-3 w-3 ml-1.5 text-muted-foreground" />}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Created by row */}
                  {task.createdByName && (
                    <div className="flex items-center gap-3 px-4 py-3">
                      <UserPlus className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-xs text-muted-foreground w-20 shrink-0">Created by</span>
                      <p className="text-sm font-medium flex-1" data-testid="text-task-creator">{task.createdByName}</p>
                    </div>
                  )}


                  {/* Recurrence row */}
                  {task.recurrence && task.recurrence !== "once" && (
                    <div className="flex items-center gap-3 px-4 py-3">
                      <History className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-xs text-muted-foreground w-20 shrink-0">Repeats</span>
                      <p className="text-sm font-medium flex-1 capitalize">{task.recurrence}</p>
                    </div>
                  )}
                </div>

                {/* Description */}
                {(task.description || !readOnly) && (
                  <div className="rounded-md border px-4 py-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Description</span>
                      {!readOnly && !editingDescription && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => {
                            setDescriptionDraft(task.description || "");
                            setEditingDescription(true);
                          }}
                          data-testid="button-edit-description"
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                    {editingDescription && !readOnly ? (
                      <div className="space-y-2">
                        <Textarea
                          autoFocus
                          value={descriptionDraft}
                          onChange={(e) => setDescriptionDraft(e.target.value)}
                          className="text-sm min-h-[80px]"
                          data-testid="input-edit-description"
                        />
                        <div className="flex gap-2">
                          <Button size="sm" onClick={handleSaveDescription} disabled={updateTaskMutation.isPending} data-testid="button-save-description">
                            Save
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setEditingDescription(false)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : task.description ? (
                      <p className="text-sm whitespace-pre-wrap leading-relaxed" data-testid="text-task-description">{task.description}</p>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">No description</p>
                    )}
                  </div>
                )}

                {/* Progress section */}
                {task.scheduledMode && scheduleInfo && (
                  <div className="rounded-md bg-muted/40 px-3 py-2 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold" data-testid="text-progress-percent">{currentProgress}%</span>
                        <span className="text-xs text-muted-foreground">
                          (expect {Math.round(scheduleInfo.expectedPercent)}%)
                        </span>
                      </div>
                      {getDaysDiffDisplay()}
                    </div>
                    <ProgressSlider
                      value={currentProgress}
                      expectedPercent={scheduleInfo.expectedPercent}
                      onChange={(val) => setLocalProgress(val)}
                      onRelease={handleProgressRelease}
                      disabled={isCompleted}
                    />
                    {startDate && dueDate && (
                      <div className="flex justify-between gap-2 text-[11px] text-muted-foreground">
                        <span>{format(startDate, "MMM d")}</span>
                        <span>{format(dueDate, "MMM d, yyyy")}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Requirements indicators */}
                {(task.requiresPhotoEvidence || task.requiresResponses) && (
                  <div className="flex items-center gap-3 text-sm text-muted-foreground">
                    {task.requiresPhotoEvidence && (
                      <span className="flex items-center gap-1">
                        <Camera className="h-4 w-4" />Photo required
                      </span>
                    )}
                    {task.requiresResponses && (
                      <span className="flex items-center gap-1">
                        <MessageSquare className="h-4 w-4" />Questions
                      </span>
                    )}
                  </div>
                )}

                {/* Reference photo */}
                {task.referencePhotoUrl && (
                  <div>
                    <p className="text-sm font-medium text-muted-foreground mb-1.5">Reference Photo</p>
                    <a href={task.referencePhotoUrl} target="_blank" rel="noopener noreferrer">
                      <img
                        src={task.referencePhotoUrl}
                        alt="Reference"
                        className="max-h-40 rounded-md object-contain cursor-pointer hover:opacity-90 transition-opacity"
                        data-testid="img-task-reference"
                      />
                    </a>
                  </div>
                )}

                {/* Completion section */}
                {!isCompleted && (
                  <div className="rounded-md bg-muted/30 p-4 space-y-3">
                    <span className="text-sm font-medium">Complete Task</span>

                    {task.requiresPhotoEvidence && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Camera className="h-4 w-4" />
                          <span className="text-sm">Photo Evidence</span>
                          <span className="text-destructive text-xs">*</span>
                        </div>
                        <div className="flex gap-2 flex-wrap">
                          {photoPreviews.map((preview, idx) => (
                            <div key={idx} className="relative h-14 w-14">
                              <img src={preview} alt={`Preview ${idx + 1}`} className="h-full w-full object-cover rounded-md" />
                              <Button
                                size="icon"
                                variant="destructive"
                                className="absolute -top-2 -right-2 h-5 w-5"
                                onClick={() => removePhoto(idx)}
                                data-testid={`button-remove-photo-${idx}`}
                              >
                                <X className="h-3 w-3" />
                              </Button>
                            </div>
                          ))}
                          <label className="h-14 w-14 flex items-center justify-center border-2 border-dashed rounded-md cursor-pointer hover-elevate active-elevate-2">
                            <input
                              type="file"
                              accept="image/*"
                              multiple
                              className="hidden"
                              onChange={handlePhotoChange}
                              data-testid="input-photo-upload"
                            />
                            <Upload className="h-4 w-4 text-muted-foreground" />
                          </label>
                        </div>
                      </div>
                    )}

                    {task.questions && task.questions.length > 0 && (
                      <div className="space-y-3">
                        <div className="flex items-center gap-2">
                          <MessageSquare className="h-4 w-4" />
                          <span className="text-sm font-medium">Questions</span>
                        </div>
                        {task.questions.map((question) => (
                          <div key={question.id} className="space-y-1">
                            <Label className="text-sm">
                              {question.prompt}
                              {question.isRequired && <span className="text-destructive ml-1">*</span>}
                            </Label>
                            {(question.questionType === "text" || question.questionType === "number") && (
                              <Textarea
                                value={String(responses[question.id] || "")}
                                onChange={(e) => setResponses(prev => ({ ...prev, [question.id]: e.target.value }))}
                                placeholder="Your answer..."
                                className="text-sm min-h-[60px]"
                                data-testid={`input-question-${question.id}`}
                              />
                            )}
                            {question.questionType === "boolean" && (
                              <div className="flex items-center gap-2">
                                <Switch
                                  checked={responses[question.id] === true || responses[question.id] === "true"}
                                  onCheckedChange={(checked) => setResponses(prev => ({ ...prev, [question.id]: checked }))}
                                  data-testid={`switch-question-${question.id}`}
                                />
                                <span className="text-sm text-muted-foreground">
                                  {responses[question.id] === true || responses[question.id] === "true" ? "Yes" : "No"}
                                </span>
                              </div>
                            )}
                            {(question.questionType === "choice" || question.questionType === "multiple_choice") && question.options && (
                              <RadioGroup
                                value={String(responses[question.id] || "")}
                                onValueChange={(val) => setResponses(prev => ({ ...prev, [question.id]: val }))}
                              >
                                {question.options.map((opt) => (
                                  <div key={opt} className="flex items-center gap-2">
                                    <RadioGroupItem value={opt} id={`${question.id}-${opt}`} />
                                    <Label htmlFor={`${question.id}-${opt}`} className="text-sm font-normal">{opt}</Label>
                                  </div>
                                ))}
                              </RadioGroup>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    <Button
                      className="w-full bg-green-600 text-white dark:bg-green-600 dark:text-white"
                      onClick={handleCompleteTask}
                      disabled={
                        completeTaskMutation.isPending ||
                        (task.requiresPhotoEvidence && photoPreviews.length === 0) ||
                        ((task.questions || []).filter(q => q.isRequired).some(q => responses[q.id] === undefined || responses[q.id] === ""))
                      }
                      data-testid="button-complete-task"
                    >
                      {completeTaskMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                      <CheckCircle className="h-4 w-4 mr-2" />
                      Complete Task
                    </Button>
                  </div>
                )}

                {/* Completion details */}
                {isCompleted && task.completedAt && (
                  <div className="rounded-md bg-green-500/10 dark:bg-green-500/15 p-4 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
                      <p className="text-sm font-medium text-green-700 dark:text-green-400">Task Completed</p>
                    </div>
                    <p className="text-sm text-green-800 dark:text-green-300 ml-6">
                      {format(parseISO(task.completedAt), "d MMM yyyy 'at' h:mm a")}
                    </p>
                    {task.completions && task.completions.length > 0 && task.completions[0].completedByName && (
                      <div className="flex items-center gap-2 text-sm ml-6">
                        <User className="h-3.5 w-3.5 text-green-700 dark:text-green-400" />
                        <span className="text-green-800 dark:text-green-300">by {task.completions[0].completedByName}</span>
                      </div>
                    )}
                  </div>
                )}


                {/* Attachments section */}
                <div className="rounded-md border">
                  <button
                    type="button"
                    className="flex items-center gap-2 w-full text-left bg-muted/50 rounded-t-md px-3 py-2.5"
                    onClick={() => setAttachmentsExpanded(prev => prev === null ? (attachments.length === 0) : !prev)}
                    data-testid="button-toggle-attachments"
                  >
                    {(attachmentsExpanded === null ? attachments.length > 0 : attachmentsExpanded) ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                    <Paperclip className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium flex-1">Attachments</span>
                    {attachments.length > 0 && (
                      <Badge variant="secondary" className="text-xs">{attachments.length}</Badge>
                    )}
                    {!readOnly && (
                      <span
                        className="ml-1"
                        onClick={(e) => { e.stopPropagation(); attachmentInputRef.current?.click(); }}
                        data-testid="button-add-attachment"
                      >
                        <Plus className="h-4 w-4 text-muted-foreground" />
                      </span>
                    )}
                  </button>
                  <input
                    ref={attachmentInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={handleAttachmentSelect}
                    data-testid="input-attachment-file"
                  />
                  {(attachmentsExpanded === null ? attachments.length > 0 : attachmentsExpanded) && (
                    <div
                      className={`p-3 transition-colors ${
                        isDraggingOver ? "bg-primary/5" : ""
                      }`}
                      onDragOver={(e) => { e.preventDefault(); setIsDraggingOver(true); }}
                      onDragLeave={() => setIsDraggingOver(false)}
                      onDrop={handleAttachmentDrop}
                    >
                      {uploadAttachmentsMutation.isPending && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span>Uploading...</span>
                        </div>
                      )}
                      {attachments.length === 0 && !uploadAttachmentsMutation.isPending ? (
                        <div className="text-center py-4">
                          <Paperclip className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
                          <p className="text-sm text-muted-foreground">Drag files here or use the + button</p>
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          {attachments.map((att) => {
                            const FileIcon = getFileIcon(att.mimeType);
                            const isImage = att.mimeType.startsWith("image/");
                            return (
                              <div key={att.id} className="flex items-center gap-2 p-1.5 rounded-md hover-elevate group" data-testid={`attachment-${att.id}`}>
                                <a
                                  href={att.fileUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer"
                                  data-testid={`link-open-attachment-${att.id}`}
                                >
                                  {isImage ? (
                                    <div className="h-10 w-10 rounded-md overflow-hidden shrink-0 bg-muted">
                                      <img src={att.fileUrl} alt={att.fileName} className="h-full w-full object-cover" />
                                    </div>
                                  ) : (
                                    <div className="h-10 w-10 rounded-md shrink-0 bg-muted flex items-center justify-center">
                                      <FileIcon className="h-5 w-5 text-muted-foreground" />
                                    </div>
                                  )}
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium truncate">{att.fileName}</p>
                                    <p className="text-xs text-muted-foreground">
                                      {formatFileSize(att.fileSize)} · {att.uploaderDisplayName} · {formatDistanceToNow(parseISO(att.createdAt), { addSuffix: true })}
                                    </p>
                                  </div>
                                </a>
                                <div className="flex gap-1 shrink-0">
                                  <a href={att.fileUrl} download={att.fileName}>
                                    <Button size="icon" variant="ghost" data-testid={`button-download-${att.id}`}>
                                      <Download className="h-3.5 w-3.5" />
                                    </Button>
                                  </a>
                                  {!readOnly && (
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      onClick={() => deleteAttachmentMutation.mutate(att.id)}
                                      data-testid={`button-delete-attachment-${att.id}`}
                                    >
                                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                                    </Button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {isDraggingOver && (
                        <div className="text-center py-2">
                          <p className="text-sm text-primary font-medium">Drop files to attach</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Checklist section */}
                <div className="rounded-md border">
                  <button
                    type="button"
                    className="flex items-center gap-2 w-full text-left bg-muted/50 rounded-t-md px-3 py-2.5"
                    onClick={() => setChecklistExpanded(prev => prev === null ? (checklistItems.length === 0) : !prev)}
                    data-testid="button-toggle-checklist"
                  >
                    {(checklistExpanded === null ? checklistItems.length > 0 : checklistExpanded) ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                    <ListChecks className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium flex-1">Checklist</span>
                    {checklistItems.length > 0 && (
                      <Badge variant="secondary" className="text-xs">
                        {checklistItems.filter(i => i.isChecked).length}/{checklistItems.length}
                      </Badge>
                    )}
                    {!readOnly && (
                      <span
                        className="ml-1"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (checklistExpanded === null && checklistItems.length === 0) {
                            setChecklistExpanded(true);
                          } else if (!(checklistExpanded === null ? checklistItems.length > 0 : checklistExpanded)) {
                            setChecklistExpanded(true);
                          }
                          setAddingChecklistItem(true);
                        }}
                        data-testid="button-add-checklist-item"
                      >
                        <Plus className="h-4 w-4 text-muted-foreground" />
                      </span>
                    )}
                  </button>
                  {(checklistExpanded === null ? checklistItems.length > 0 : checklistExpanded) && (
                    <div className="p-3 space-y-1">
                      {checklistItems.length > 0 && (
                        <div className="mb-2">
                          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full rounded-full bg-green-500 transition-all duration-300"
                              style={{ width: `${checklistItems.length > 0 ? (checklistItems.filter(i => i.isChecked).length / checklistItems.length) * 100 : 0}%` }}
                            />
                          </div>
                        </div>
                      )}
                      <DndContext sensors={checklistDndSensors} collisionDetection={closestCenter} onDragEnd={handleChecklistDragEnd}>
                        <SortableContext items={checklistItems.map(i => i.id)} strategy={verticalListSortingStrategy}>
                          {checklistItems.map((item) => {
                            const itemDue = item.dueAt ? new Date(item.dueAt) : null;
                            const isItemOverdue = itemDue && !item.isChecked && itemDue < new Date();
                            return (
                              <SortableChecklistItem key={item.id} id={item.id} disabled={readOnly}>
                                <div className="group rounded-md px-1 py-0.5 hover-elevate" data-testid={`checklist-item-${item.id}`}>
                                  <div className="flex items-center gap-2">
                                    <button
                                      type="button"
                                      className="shrink-0 text-muted-foreground"
                                      onClick={() => {
                                        if (!readOnly) {
                                          updateChecklistItemMutation.mutate({ itemId: item.id, isChecked: !item.isChecked });
                                        }
                                      }}
                                      disabled={readOnly}
                                      data-testid={`button-check-${item.id}`}
                                    >
                                      {item.isChecked ? (
                                        <SquareCheck className="h-4.5 w-4.5 text-green-500" />
                                      ) : (
                                        <Square className="h-4.5 w-4.5" />
                                      )}
                                    </button>
                                    {editingChecklistId === item.id && !readOnly ? (
                                      <Input
                                        autoFocus
                                        value={editingChecklistTitle}
                                        onChange={(e) => setEditingChecklistTitle(e.target.value)}
                                        onBlur={() => {
                                          if (editingChecklistTitle.trim() && editingChecklistTitle.trim() !== item.title) {
                                            updateChecklistItemMutation.mutate({ itemId: item.id, title: editingChecklistTitle.trim() });
                                          }
                                          setEditingChecklistId(null);
                                        }}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") {
                                            if (editingChecklistTitle.trim() && editingChecklistTitle.trim() !== item.title) {
                                              updateChecklistItemMutation.mutate({ itemId: item.id, title: editingChecklistTitle.trim() });
                                            }
                                            setEditingChecklistId(null);
                                          }
                                          if (e.key === "Escape") setEditingChecklistId(null);
                                        }}
                                        className="h-7 text-sm flex-1"
                                        data-testid={`input-edit-checklist-${item.id}`}
                                      />
                                    ) : (
                                      <span
                                        className={`text-sm flex-1 min-w-0 truncate ${item.isChecked ? "line-through text-muted-foreground" : ""} ${!readOnly ? "cursor-pointer" : ""}`}
                                        onClick={() => {
                                          if (!readOnly) {
                                            setEditingChecklistId(item.id);
                                            setEditingChecklistTitle(item.title);
                                          }
                                        }}
                                        data-testid={`text-checklist-${item.id}`}
                                      >
                                        {item.title}
                                      </span>
                                    )}
                              <div className="flex items-center gap-0.5 shrink-0">
                                {!readOnly ? (
                                  <Popover>
                                    <PopoverTrigger asChild>
                                      <button
                                        type="button"
                                        className={`flex items-center gap-1 text-xs rounded px-1.5 py-0.5 ${
                                          isItemOverdue
                                            ? "text-destructive font-medium"
                                            : itemDue
                                              ? "text-muted-foreground"
                                              : "text-muted-foreground/50 invisible group-hover:visible"
                                        }`}
                                        data-testid={`button-due-date-${item.id}`}
                                      >
                                        <CalendarDays className="h-3 w-3" />
                                        {itemDue ? format(itemDue, "MMM d") : "Due"}
                                      </button>
                                    </PopoverTrigger>
                                    <PopoverContent className="w-auto p-0" align="end">
                                      <CalendarPicker
                                        mode="single"
                                        selected={itemDue || undefined}
                                        onSelect={(date) => {
                                          updateChecklistItemMutation.mutate({
                                            itemId: item.id,
                                            dueAt: date ? date.toISOString() : null,
                                          });
                                        }}
                                        defaultMonth={itemDue || new Date()}
                                        data-testid={`calendar-checklist-due-${item.id}`}
                                      />
                                      {itemDue && (
                                        <div className="px-3 pb-2">
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            className="w-full text-destructive"
                                            onClick={() => {
                                              updateChecklistItemMutation.mutate({ itemId: item.id, dueAt: null });
                                            }}
                                            data-testid={`button-clear-due-${item.id}`}
                                          >
                                            Clear due date
                                          </Button>
                                        </div>
                                      )}
                                    </PopoverContent>
                                  </Popover>
                                ) : itemDue ? (
                                  <span className={`text-xs px-1.5 ${isItemOverdue ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                                    <CalendarDays className="h-3 w-3 inline mr-1" />
                                    {format(itemDue, "MMM d")}
                                  </span>
                                ) : null}
                                {!readOnly && (
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="invisible group-hover:visible"
                                    onClick={() => deleteChecklistItemMutation.mutate(item.id)}
                                    data-testid={`button-delete-checklist-${item.id}`}
                                  >
                                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                                  </Button>
                                )}
                                  </div>
                                </div>
                              </div>
                            </SortableChecklistItem>
                          );
                        })}
                      </SortableContext>
                    </DndContext>
                      {addingChecklistItem && !readOnly && (
                        <div className="flex items-center gap-2 px-1 py-0.5">
                          <Square className="h-4.5 w-4.5 text-muted-foreground shrink-0" />
                          <Input
                            autoFocus
                            placeholder="Add an item..."
                            value={newChecklistItem}
                            onChange={(e) => setNewChecklistItem(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && newChecklistItem.trim()) {
                                e.preventDefault();
                                addChecklistItemMutation.mutate(newChecklistItem.trim());
                              }
                              if (e.key === "Escape") {
                                setAddingChecklistItem(false);
                                setNewChecklistItem("");
                              }
                            }}
                            onBlur={() => {
                              if (newChecklistItem.trim()) {
                                addChecklistItemMutation.mutate(newChecklistItem.trim());
                              }
                              setAddingChecklistItem(false);
                            }}
                            className="h-7 text-sm flex-1"
                            data-testid="input-new-checklist-item"
                          />
                        </div>
                      )}
                      {checklistItems.length === 0 && !addingChecklistItem && (
                        <div className="text-center py-3">
                          <ListChecks className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
                          <p className="text-sm text-muted-foreground">No checklist items yet</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Comments section */}
                <div className="rounded-md border">
                  <button
                    type="button"
                    className="flex items-center gap-2 w-full text-left bg-muted/50 rounded-t-md px-3 py-2.5"
                    onClick={() => setCommentsExpanded(!commentsExpanded)}
                    data-testid="button-toggle-comments"
                  >
                    {commentsExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                    <MessageSquare className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium flex-1">Comments</span>
                    {comments.length > 0 && (
                      <Badge variant="secondary" className="text-xs">{comments.length}</Badge>
                    )}
                  </button>
                  {commentsExpanded && (
                    <div className="p-3">
                      {comments.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-3">No comments yet</p>
                      ) : (
                        <div className="space-y-3">
                          {comments.map((comment) => (
                            <div key={comment.id} className="flex gap-2" data-testid={`comment-${comment.id}`}>
                              <Avatar className="h-7 w-7 shrink-0">
                                {comment.authorAvatar && (
                                  <AvatarImage src={comment.authorAvatar} alt={comment.authorName} />
                                )}
                                <AvatarFallback className="text-xs">
                                  {(comment.authorName || "?").slice(0, 2).toUpperCase()}
                                </AvatarFallback>
                              </Avatar>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-sm font-medium">{comment.authorName}</span>
                                  <span className="text-xs text-muted-foreground">
                                    {formatDistanceToNow(parseISO(comment.createdAt), { addSuffix: true })}
                                  </span>
                                </div>
                                <p className="text-sm text-muted-foreground mt-0.5 whitespace-pre-wrap">{comment.body}</p>
                              </div>
                            </div>
                          ))}
                          <div ref={commentsEndRef} />
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Activity section */}
                <div className="rounded-md border">
                  <button
                    type="button"
                    className="flex items-center gap-2 w-full text-left bg-muted/50 rounded-t-md px-3 py-2.5"
                    onClick={() => setActivityExpanded(!activityExpanded)}
                    data-testid="button-toggle-activity"
                  >
                    {activityExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                    <History className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium flex-1">Activity</span>
                    {activities.length > 0 && (
                      <Badge variant="secondary" className="text-xs">{activities.length}</Badge>
                    )}
                  </button>
                  {activityExpanded && (
                    <div className="p-3">
                      {activities.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-3">No activity yet</p>
                      ) : (
                        <div className="space-y-2">
                          {activities.map((activity) => (
                            <div key={activity.id} className="flex gap-2 items-start group" data-testid={`activity-${activity.id}`}>
                              <Avatar className="h-5 w-5 shrink-0 mt-0.5">
                                {activity.actorAvatar && (
                                  <AvatarImage src={activity.actorAvatar} alt={activity.actorName} />
                                )}
                                <AvatarFallback className="text-[9px]">
                                  {(activity.actorName || "?").slice(0, 2).toUpperCase()}
                                </AvatarFallback>
                              </Avatar>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm">
                                  <span className="font-medium">{activity.actorName}</span>
                                  <span className="text-muted-foreground"> {activity.actorName && activity.description.startsWith(activity.actorName) ? activity.description.slice(activity.actorName.length).trimStart() : activity.description}</span>
                                </p>
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-xs text-muted-foreground">
                                    {formatDistanceToNow(parseISO(activity.createdAt), { addSuffix: true })}
                                  </span>
                                  {canRollback(activity) && !readOnly && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-5 px-1.5 text-xs text-muted-foreground invisible group-hover:visible"
                                      onClick={() => rollbackMutation.mutate(activity.id)}
                                      disabled={rollbackMutation.isPending}
                                      data-testid={`button-rollback-${activity.id}`}
                                    >
                                      <Undo2 className="h-3 w-3 mr-1" />
                                      Undo
                                    </Button>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Spacer for fixed comment bar */}
                <div className="h-4" />
              </div>
            </div>
          )}
        </div>

        {/* Fixed comment bar */}
        {task && (
          <div className="absolute bottom-0 left-0 right-0 z-20 bg-background/95 backdrop-blur-sm border-t px-4 py-2.5" data-testid="comment-bar">
            <div className="flex items-center gap-2">
              <Avatar className="h-7 w-7 shrink-0">
                <AvatarFallback className="text-xs">
                  {(user?.fullName || user?.email || "?").slice(0, 1).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <Input
                placeholder="Comment..."
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                className="flex-1"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && newComment.trim()) {
                    e.preventDefault();
                    addCommentMutation.mutate(newComment.trim());
                  }
                }}
                data-testid="input-task-comment"
              />
              <Button
                size="icon"
                onClick={() => newComment.trim() && addCommentMutation.mutate(newComment.trim())}
                disabled={!newComment.trim() || addCommentMutation.isPending}
                data-testid="button-send-comment"
              >
                {addCommentMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
