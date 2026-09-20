import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarPicker } from "@/components/ui/calendar";
import {
  Loader2,
  CalendarDays,
  Clock,
  Check,
  User,
  Repeat,
  AlignLeft,
  ArrowRightLeft,
  Plus,
  Paperclip,
  ListChecks,
  X,
  ChevronDown,
  ChevronRight,
  FileText,
  FileImage,
  File as FileIcon,
} from "lucide-react";
import { format } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useBranchContext } from "@/hooks/use-branch-context";
import AssignmentSearchBar, { type AssignmentValue, getAssignmentSummary } from "@/components/core/AssignmentSearchBar";

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
  userId?: string | null;
  branchId?: string | null;
}

interface Advisor {
  id: string;
  fullName: string;
  preferredName: string | null;
  email: string;
}

const WEEKDAYS = [
  { id: "mon", label: "M" },
  { id: "tue", label: "T" },
  { id: "wed", label: "W" },
  { id: "thu", label: "T" },
  { id: "fri", label: "F" },
  { id: "sat", label: "S" },
  { id: "sun", label: "S" },
];

const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

interface CreateTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}


function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIconComponent(mimeType: string) {
  if (mimeType.startsWith("image/")) return FileImage;
  if (mimeType.includes("pdf") || mimeType.includes("document") || mimeType.includes("text")) return FileText;
  return FileIcon;
}

function DueTimePicker({ value, onChange }: { value: string; onChange: (time: string) => void }) {
  const [localTime, setLocalTime] = useState(value);
  const [isOpen, setIsOpen] = useState(false);
  const isDirty = localTime !== value;

  useEffect(() => {
    if (isOpen) setLocalTime(value);
  }, [isOpen]);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 px-2 font-medium text-muted-foreground" data-testid="input-due-time">
          <Clock className="h-3 w-3 mr-1.5 shrink-0" />
          {value}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3" align="start">
        <div className="flex items-center gap-2">
          <Input
            type="time"
            value={localTime}
            onChange={(e) => setLocalTime(e.target.value)}
            className="text-sm"
            data-testid="input-due-time-picker"
          />
          <Button
            size="sm"
            className={`h-9 px-2.5 shrink-0 transition-opacity ${isDirty ? "opacity-100" : "opacity-40"}`}
            disabled={!isDirty}
            onClick={() => {
              onChange(localTime);
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

export function CreateTaskDialog({ open, onOpenChange }: CreateTaskDialogProps) {
  const { toast } = useToast();
  const { selectedBranchId } = useBranchContext();

  const [formData, setFormData] = useState({
    title: "",
    description: "",
    priority: "medium" as "low" | "medium" | "high" | "critical",
    recurrence: "once" as "once" | "daily" | "weekly" | "monthly",
    weeklyDays: [] as string[],
    monthlyDay: null as number | null,
    preferredDueTime: "18:00",
    scheduledMode: false,
    startDate: "",
    dueDate: "",
  });
  const [assignments, setAssignments] = useState<AssignmentValue[]>([]);
  const [showDescription, setShowDescription] = useState(false);

  const [checklistItems, setChecklistItems] = useState<string[]>([]);
  const [newChecklistItem, setNewChecklistItem] = useState("");
  const [addingChecklistItem, setAddingChecklistItem] = useState(false);
  const [checklistExpanded, setChecklistExpanded] = useState(false);

  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
  const [attachmentsExpanded, setAttachmentsExpanded] = useState(false);
  const [dueDatePopoverOpen, setDueDatePopoverOpen] = useState(false);
  const [startDatePopoverOpen, setStartDatePopoverOpen] = useState(false);
  const attachmentInputRef = useRef<HTMLInputElement>(null);

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
    queryKey: ["/api/employees", { branchId: selectedBranchId }],
    queryFn: async () => {
      const params = selectedBranchId ? `?branchId=${selectedBranchId}` : "";
      const res = await fetch(`/api/employees${params}`);
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: advisors = [] } = useQuery<Advisor[]>({
    queryKey: ["/api/people", { personType: "ADVISOR" }],
    queryFn: async () => {
      const res = await fetch("/api/people?personType=ADVISOR");
      if (!res.ok) return [];
      return res.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const res = await apiRequest("POST", "/api/core/tasks", data);
      return res.json();
    },
    onSuccess: async (createdTask: any) => {
      const taskId = Array.isArray(createdTask) ? createdTask[0]?.id : createdTask?.id;

      if (taskId) {
        const postCreationPromises: Promise<any>[] = [];

        if (checklistItems.length > 0) {
          for (const title of checklistItems) {
            postCreationPromises.push(
              apiRequest("POST", `/api/core/tasks/${taskId}/checklist`, { title }).catch(() => {})
            );
          }
        }

        if (attachmentFiles.length > 0) {
          const formDataObj = new FormData();
          attachmentFiles.forEach((file) => formDataObj.append("files", file));
          postCreationPromises.push(
            fetch(`/api/core/tasks/${taskId}/attachments`, {
              method: "POST",
              body: formDataObj,
              credentials: "include",
            }).catch(() => {})
          );
        }

        if (postCreationPromises.length > 0) {
          await Promise.allSettled(postCreationPromises);
        }
      }

      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks/activities"] });
      toast({ title: "Task created" });
      closeSheet();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const closeSheet = () => {
    onOpenChange(false);
    setFormData({
      title: "",
      description: "",
      priority: "medium",
      recurrence: "once",
      weeklyDays: [],
      monthlyDay: null,
      preferredDueTime: "18:00",
      scheduledMode: false,
      startDate: "",
      dueDate: "",
    });
    setAssignments([]);
    setShowDescription(false);
    setChecklistItems([]);
    setNewChecklistItem("");
    setAddingChecklistItem(false);
    setChecklistExpanded(false);
    setAttachmentFiles([]);
    setAttachmentsExpanded(false);
  };

  const toggleWeeklyDay = (day: string) => {
    if (formData.weeklyDays.includes(day)) {
      setFormData({ ...formData, weeklyDays: formData.weeklyDays.filter(d => d !== day) });
    } else {
      setFormData({ ...formData, weeklyDays: [...formData.weeklyDays, day] });
    }
  };

  const addChecklistItemLocal = () => {
    const trimmed = newChecklistItem.trim();
    if (!trimmed) return;
    setChecklistItems([...checklistItems, trimmed]);
    setNewChecklistItem("");
  };

  const removeChecklistItem = (index: number) => {
    setChecklistItems(checklistItems.filter((_, i) => i !== index));
  };

  const handleAttachmentSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setAttachmentFiles(prev => [...prev, ...Array.from(e.target.files!)]);
      setAttachmentsExpanded(true);
    }
    e.target.value = "";
  };

  const removeAttachment = (index: number) => {
    setAttachmentFiles(attachmentFiles.filter((_, i) => i !== index));
  };

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

    const branchAssignments = assignments.filter(a => a.type === "branch");
    const targetBranchIds = branchAssignments.length > 0
      ? branchAssignments.map(a => a.id)
      : selectedBranchId
        ? [selectedBranchId]
        : branches.length > 0
          ? [branches[0].id]
          : [];

    if (targetBranchIds.length === 0) {
      toast({ title: "At least one branch is required", variant: "destructive" });
      return;
    }

    const taskAssignments = assignments
      .filter(a => a.type !== "everyone")
      .map(a => ({
        assignmentType: a.type as string,
        assignmentId: a.id,
      }));

    createMutation.mutate({
      branchIds: targetBranchIds,
      title: formData.title.trim(),
      description: formData.description.trim() || null,
      priority: formData.priority,
      recurrence: formData.recurrence,
      weeklyDays: formData.recurrence === "weekly" ? formData.weeklyDays : [],
      monthlyDay: formData.recurrence === "monthly" ? formData.monthlyDay : null,
      preferredDueTime: formData.preferredDueTime || null,
      scheduledMode: formData.scheduledMode,
      startAt: formData.scheduledMode && formData.startDate ? `${formData.startDate}T00:00:00+07:00` : null,
      dueAt: formData.dueDate ? `${formData.dueDate}T${formData.preferredDueTime || "18:00"}:00+07:00` : null,
      assignments: taskAssignments,
      requiresPhotoEvidence: false,
      requiresResponses: false,
    });
  };

  const parsedDueDate = formData.dueDate ? (() => { const [y, m, d] = formData.dueDate.split("-").map(Number); return new Date(y, m - 1, d); })() : null;
  const parsedStartDate = formData.startDate ? (() => { const [y, m, d] = formData.startDate.split("-").map(Number); return new Date(y, m - 1, d); })() : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[400px] sm:w-[480px] sm:max-w-[480px] p-0 flex flex-col" data-testid="dialog-create-task">
        <div className="flex-1 overflow-y-auto pb-24">
          <SheetHeader className="sr-only">
            <SheetTitle>Create Task</SheetTitle>
          </SheetHeader>

          <div className="space-y-5">
            <div className="px-5 pt-6 pb-5 bg-slate-800 dark:bg-slate-900 rounded-t-md">
              <input
                type="text"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const nextFocusable = e.currentTarget.closest("[data-testid='dialog-create-task']")?.querySelector<HTMLElement>("[data-testid='input-due-date']");
                    nextFocusable?.focus();
                    nextFocusable?.click();
                  }
                }}
                placeholder="What needs to be done?"
                autoFocus
                className="w-full text-xl font-bold bg-transparent border-none outline-none py-2 text-white placeholder:text-slate-400/70"
                data-testid="input-create-task-title"
              />
            </div>

            <div className="px-5 space-y-5">
              <div className="space-y-0 rounded-md border divide-y">
                <div className="flex items-center gap-3 px-4 py-3">
                  <CalendarDays className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-xs text-muted-foreground w-20 shrink-0">Due</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Popover open={dueDatePopoverOpen} onOpenChange={setDueDatePopoverOpen}>
                        <PopoverTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-7 px-2 font-medium" data-testid="input-due-date">
                            {parsedDueDate ? format(parsedDueDate, "d MMM yyyy") : "Pick a date"}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <CalendarPicker
                            mode="single"
                            selected={parsedDueDate || undefined}
                            onSelect={(date) => {
                              if (date) {
                                setFormData({ ...formData, dueDate: format(date, "yyyy-MM-dd") });
                                setDueDatePopoverOpen(false);
                              }
                            }}
                            defaultMonth={parsedDueDate || new Date()}
                            data-testid="calendar-task-due"
                          />
                        </PopoverContent>
                      </Popover>
                      {parsedDueDate && formData.recurrence === "once" && (
                        <DueTimePicker
                          value={formData.preferredDueTime || "18:00"}
                          onChange={(time) => setFormData({ ...formData, preferredDueTime: time })}
                        />
                      )}
                    </div>
                  </div>
                </div>

                {formData.scheduledMode && (
                  <div className="flex items-center gap-3 px-4 py-3">
                    <CalendarDays className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground w-20 shrink-0">Start</span>
                    <div className="flex-1 min-w-0">
                      <Popover open={startDatePopoverOpen} onOpenChange={setStartDatePopoverOpen}>
                        <PopoverTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-7 px-2 font-medium" data-testid="input-start-date">
                            {parsedStartDate ? format(parsedStartDate, "d MMM yyyy") : "Pick start date"}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <CalendarPicker
                            mode="single"
                            selected={parsedStartDate || undefined}
                            onSelect={(date) => {
                              if (date) {
                                setFormData({ ...formData, startDate: format(date, "yyyy-MM-dd") });
                                setStartDatePopoverOpen(false);
                              }
                            }}
                            defaultMonth={parsedStartDate || new Date()}
                          />
                        </PopoverContent>
                      </Popover>
                    </div>
                  </div>
                )}

                <div className="flex items-start gap-3 px-4 py-3">
                  <User className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                  <span className="text-xs text-muted-foreground w-20 shrink-0 mt-0.5">Assigned to</span>
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <AssignmentSearchBar
                      value={assignments}
                      onChange={setAssignments}
                      employees={employees}
                      advisors={advisors}
                      roles={roles}
                      departments={departments}
                      branches={branches}
                      placeholder="Search person, role, dept..."
                    />
                    <p className="text-[11px] text-muted-foreground leading-tight">
                      {getAssignmentSummary(assignments)}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3 px-4 py-3">
                  <Repeat className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-xs text-muted-foreground w-20 shrink-0">Repeats</span>
                  <div className="flex-1 min-w-0">
                    <Select
                      value={formData.recurrence}
                      onValueChange={(v) => {
                        const rec = v as typeof formData.recurrence;
                        setFormData({ ...formData, recurrence: rec, weeklyDays: rec === "weekly" ? formData.weeklyDays : [] });
                      }}
                    >
                      <SelectTrigger className="w-auto h-auto p-0 border-0 shadow-none [&>svg]:hidden" data-testid="select-recurrence">
                        <SelectValue>
                          <Button variant="ghost" size="sm" className="h-7 px-2 font-medium pointer-events-none">
                            {formData.recurrence === "once" ? "One-off" : formData.recurrence.charAt(0).toUpperCase() + formData.recurrence.slice(1)}
                          </Button>
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="once">One-off</SelectItem>
                        <SelectItem value="daily">Daily</SelectItem>
                        <SelectItem value="weekly">Weekly</SelectItem>
                        <SelectItem value="monthly">Monthly</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {formData.recurrence === "once" && (
                  <div className="flex items-center gap-3 px-4 py-3">
                    <ArrowRightLeft className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground w-20 shrink-0">Multi-day</span>
                    <div className="flex-1 min-w-0 flex items-center justify-between gap-2">
                      <span className="text-sm text-muted-foreground">
                        {formData.scheduledMode ? "Spans start to due" : "Single day"}
                      </span>
                      <Switch
                        checked={formData.scheduledMode}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            const today = new Date().toISOString().split('T')[0];
                            setFormData({ ...formData, scheduledMode: true, startDate: formData.startDate || today });
                          } else {
                            setFormData({ ...formData, scheduledMode: false, startDate: "" });
                          }
                        }}
                        data-testid="switch-scheduled-mode"
                      />
                    </div>
                  </div>
                )}
              </div>

              {formData.recurrence === "weekly" && (
                <div className="rounded-md border px-4 py-3 space-y-2">
                  <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Days of week</span>
                  <div className="flex gap-1.5">
                    {WEEKDAYS.map((day) => (
                      <button
                        key={day.id}
                        type="button"
                        onClick={() => toggleWeeklyDay(day.id)}
                        className={`h-8 w-8 rounded-md text-xs font-medium transition-colors ${
                          formData.weeklyDays.includes(day.id)
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground hover-elevate"
                        }`}
                        data-testid={`badge-day-${day.id}`}
                      >
                        {day.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {formData.recurrence === "monthly" && (
                <div className="rounded-md border px-4 py-3 space-y-2">
                  <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Day of month</span>
                  <div className="grid grid-cols-7 gap-1.5">
                    {MONTH_DAYS.map((day) => (
                      <button
                        key={day}
                        type="button"
                        onClick={() => setFormData({ ...formData, monthlyDay: day })}
                        className={`h-8 w-full rounded-md text-xs font-medium transition-colors ${
                          formData.monthlyDay === day
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground hover-elevate"
                        }`}
                        data-testid={`badge-month-day-${day}`}
                      >
                        {day}
                      </button>
                    ))}
                  </div>
                  {formData.monthlyDay === 31 && (
                    <p className="text-[11px] text-muted-foreground">Falls on the last day for shorter months</p>
                  )}
                </div>
              )}

              {formData.recurrence !== "once" && (
                <div className="rounded-md border px-4 py-3 space-y-2">
                  <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Preferred time</span>
                  <Input
                    type="time"
                    value={formData.preferredDueTime}
                    onChange={(e) => setFormData({ ...formData, preferredDueTime: e.target.value })}
                    className="w-auto"
                    data-testid="input-due-time"
                  />
                </div>
              )}

              {showDescription ? (
                <div className="rounded-md border px-4 py-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Description</span>
                  </div>
                  <Textarea
                    autoFocus
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder="Add details about this task..."
                    className="text-sm min-h-[80px]"
                    data-testid="input-create-task-description"
                  />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowDescription(true)}
                  className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors px-1"
                  data-testid="button-add-description"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <AlignLeft className="h-3.5 w-3.5" />
                  <span>Add description</span>
                </button>
              )}

              <div className="rounded-md border">
                <button
                  type="button"
                  className="flex items-center gap-2 w-full text-left bg-muted/50 rounded-t-md px-3 py-2.5"
                  onClick={() => setAttachmentsExpanded(!attachmentsExpanded)}
                  data-testid="button-toggle-create-attachments"
                >
                  {attachmentsExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                  <Paperclip className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium flex-1">Attachments</span>
                  {attachmentFiles.length > 0 && (
                    <Badge variant="secondary" className="text-xs">{attachmentFiles.length}</Badge>
                  )}
                  <span
                    className="ml-1"
                    onClick={(e) => { e.stopPropagation(); attachmentInputRef.current?.click(); }}
                    data-testid="button-add-create-attachment"
                  >
                    <Plus className="h-4 w-4 text-muted-foreground" />
                  </span>
                </button>
                <input
                  ref={attachmentInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleAttachmentSelect}
                  data-testid="input-create-attachment-file"
                />
                {attachmentsExpanded && (
                  <div className="p-3">
                    {attachmentFiles.length === 0 ? (
                      <div className="text-center py-4">
                        <Paperclip className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
                        <p className="text-sm text-muted-foreground">Use the + button to add files</p>
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {attachmentFiles.map((file, idx) => {
                          const Icon = getFileIconComponent(file.type);
                          return (
                            <div key={idx} className="flex items-center gap-2 p-1.5 rounded-md hover-elevate group" data-testid={`create-attachment-${idx}`}>
                              <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm truncate">{file.name}</p>
                                <p className="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
                              </div>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="invisible group-hover:visible"
                                onClick={() => removeAttachment(idx)}
                                data-testid={`button-remove-create-attachment-${idx}`}
                              >
                                <X className="h-3.5 w-3.5 text-destructive" />
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="rounded-md border">
                <button
                  type="button"
                  className="flex items-center gap-2 w-full text-left bg-muted/50 rounded-t-md px-3 py-2.5"
                  onClick={() => setChecklistExpanded(!checklistExpanded)}
                  data-testid="button-toggle-create-checklist"
                >
                  {checklistExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                  <ListChecks className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium flex-1">Checklist</span>
                  {checklistItems.length > 0 && (
                    <Badge variant="secondary" className="text-xs">{checklistItems.length}</Badge>
                  )}
                  <span
                    className="ml-1"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!checklistExpanded) setChecklistExpanded(true);
                      setAddingChecklistItem(true);
                    }}
                    data-testid="button-add-create-checklist-item"
                  >
                    <Plus className="h-4 w-4 text-muted-foreground" />
                  </span>
                </button>
                {checklistExpanded && (
                  <div className="p-3 space-y-1.5">
                    {checklistItems.length === 0 && !addingChecklistItem ? (
                      <div className="text-center py-4">
                        <ListChecks className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
                        <p className="text-sm text-muted-foreground">Use the + button to add items</p>
                      </div>
                    ) : (
                      <>
                        {checklistItems.map((item, idx) => (
                          <div key={idx} className="flex items-center gap-2 p-1.5 rounded-md hover-elevate group" data-testid={`create-checklist-item-${idx}`}>
                            <div className="h-4 w-4 rounded border border-muted-foreground/30 shrink-0" />
                            <span className="text-sm flex-1 min-w-0 truncate">{item}</span>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="invisible group-hover:visible"
                              onClick={() => removeChecklistItem(idx)}
                              data-testid={`button-remove-create-checklist-${idx}`}
                            >
                              <X className="h-3.5 w-3.5 text-destructive" />
                            </Button>
                          </div>
                        ))}
                      </>
                    )}
                    {addingChecklistItem && (
                      <div className="flex items-center gap-2">
                        <div className="h-4 w-4 rounded border border-muted-foreground/30 shrink-0" />
                        <Input
                          autoFocus
                          value={newChecklistItem}
                          onChange={(e) => setNewChecklistItem(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              addChecklistItemLocal();
                            }
                            if (e.key === "Escape") {
                              setAddingChecklistItem(false);
                              setNewChecklistItem("");
                            }
                          }}
                          onBlur={() => {
                            if (newChecklistItem.trim()) {
                              addChecklistItemLocal();
                            } else {
                              setAddingChecklistItem(false);
                            }
                          }}
                          placeholder="Add item..."
                          className="h-7 text-sm flex-1"
                          data-testid="input-create-checklist-item"
                        />
                      </div>
                    )}
                    {checklistItems.length > 0 && !addingChecklistItem && (
                      <button
                        type="button"
                        onClick={() => setAddingChecklistItem(true)}
                        className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors px-1 pt-1"
                        data-testid="button-add-another-checklist"
                      >
                        <Plus className="h-3 w-3" />
                        <span>Add another item</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="absolute bottom-0 left-0 right-0 border-t bg-background px-5 py-4 flex items-center justify-between gap-3">
          <Button variant="outline" onClick={closeSheet} data-testid="button-cancel-task">
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!formData.title.trim() || createMutation.isPending}
            data-testid="button-submit-task"
          >
            {createMutation.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Create Task
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
