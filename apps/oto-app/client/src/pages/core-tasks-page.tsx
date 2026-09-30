import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Loader2, Plus, Upload, CheckCircle, Clock, AlertTriangle, XCircle } from "lucide-react";

interface Task {
  id: string;
  branchId: string;
  departmentId: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  recurrence: string;
  dueAt: string | null;
  assignedTo: string | null;
  requiresPhotoEvidence: boolean;
  requiresResponses: boolean;
  referencePhotoUrl: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  assignedUserEmail: string | null;
  assignedUserName: string | null;
}

interface TaskDetail extends Task {
  questions: Array<{
    id: string;
    prompt: string;
    questionType: string;
    options: string[] | null;
    isRequired: boolean;
    sortOrder: number;
  }>;
  completions: Array<{
    id: string;
    completedBy: string;
    responses: Record<string, unknown> | null;
    photoUrls: string[] | null;
    note: string | null;
    completedAt: string;
    completedByEmail: string | null;
    completedByName: string | null;
  }>;
}

interface Branch {
  id: string;
  name: string;
}

const statusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  in_progress: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  completed: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  overdue: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  cancelled: "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300",
};


const StatusIcon = ({ status, "data-testid": testId }: { status: string; "data-testid"?: string }) => {
  const props = testId ? { "data-testid": testId } : {};
  switch (status) {
    case "completed":
      return <CheckCircle className="h-4 w-4 text-green-500" {...props} />;
    case "in_progress":
      return <Clock className="h-4 w-4 text-blue-500" {...props} />;
    case "overdue":
      return <AlertTriangle className="h-4 w-4 text-red-500" {...props} />;
    case "cancelled":
      return <XCircle className="h-4 w-4 text-gray-500" {...props} />;
    default:
      return <Clock className="h-4 w-4 text-yellow-500" {...props} />;
  }
};

export default function CoreTasksPage() {
  const { toast } = useToast();
  const [selectedBranchId, setSelectedBranchId] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<TaskDetail | null>(null);
  const [detailSheetOpen, setDetailSheetOpen] = useState(false);

  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const { data: tasks = [], isLoading: tasksLoading } = useQuery<Task[]>({
    queryKey: ["/api/core/tasks", selectedBranchId, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (selectedBranchId && selectedBranchId !== "all") params.set("branchId", selectedBranchId);
      if (statusFilter && statusFilter !== "all") params.set("status", statusFilter);
      const res = await fetch(`/api/core/tasks?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch tasks");
      return res.json();
    },
  });

  const handleViewTask = async (taskId: string) => {
    try {
      const res = await fetch(`/api/core/tasks/${taskId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch task");
      const task = await res.json();
      setSelectedTask(task);
      setDetailSheetOpen(true);
    } catch (error) {
      toast({ title: "Error", description: "Failed to load task details", variant: "destructive" });
    }
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold" data-testid="text-page-title">Core Tasks</h1>
        <Button onClick={() => setCreateDialogOpen(true)} data-testid="button-create-task">
          <Plus className="h-4 w-4 mr-2" />
          Create Task
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4">
            <div className="w-64">
              <Label>Branch</Label>
              <Select value={selectedBranchId} onValueChange={setSelectedBranchId}>
                <SelectTrigger data-testid="select-branch">
                  <SelectValue placeholder="All branches" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" data-testid="option-branch-all">All branches</SelectItem>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id} data-testid={`option-branch-${b.id}`}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-48">
              <Label>Status</Label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger data-testid="select-status">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" data-testid="option-status-all">All statuses</SelectItem>
                  <SelectItem value="pending" data-testid="option-status-pending">Pending</SelectItem>
                  <SelectItem value="in_progress" data-testid="option-status-in-progress">In Progress</SelectItem>
                  <SelectItem value="completed" data-testid="option-status-completed">Completed</SelectItem>
                  <SelectItem value="overdue" data-testid="option-status-overdue">Overdue</SelectItem>
                  <SelectItem value="cancelled" data-testid="option-status-cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {tasksLoading ? (
            <div className="flex justify-center items-center p-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : tasks.length === 0 ? (
            <div className="text-center p-12 text-muted-foreground" data-testid="text-empty-state">
              No tasks found. Create one to get started.
            </div>
          ) : (
            <Table data-testid="table-tasks">
              <TableHeader>
                <TableRow>
                  <TableHead data-testid="header-title">Title</TableHead>
                  <TableHead data-testid="header-status">Status</TableHead>
                  <TableHead data-testid="header-due-date">Due Date</TableHead>
                  <TableHead data-testid="header-assigned-to">Assigned To</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((task) => (
                  <TableRow
                    key={task.id}
                    className="cursor-pointer hover-elevate"
                    onClick={() => handleViewTask(task.id)}
                    data-testid={`row-task-${task.id}`}
                  >
                    <TableCell data-testid={`cell-title-${task.id}`}>
                      <div className="font-medium">{task.title}</div>
                      {task.description && (
                        <div className="text-sm text-muted-foreground truncate max-w-xs">
                          {task.description}
                        </div>
                      )}
                    </TableCell>
                    <TableCell data-testid={`cell-status-${task.id}`}>
                      <div className="flex items-center gap-2">
                        <StatusIcon status={task.status} data-testid={`icon-status-${task.id}`} />
                        <Badge variant="outline" className={statusColors[task.status]} data-testid={`badge-status-${task.id}`}>
                          {task.status.replace("_", " ")}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell data-testid={`cell-due-date-${task.id}`}>
                      {task.dueAt ? format(new Date(task.dueAt), "d MMM yyyy") : "-"}
                    </TableCell>
                    <TableCell data-testid={`cell-assigned-${task.id}`}>
                      {task.assignedUserName || task.assignedUserEmail || "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <CreateTaskDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        branches={branches}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: ["/api/core/tasks"] });
        }}
      />

      <TaskDetailSheet
        task={selectedTask}
        open={detailSheetOpen}
        onOpenChange={setDetailSheetOpen}
        onUpdate={() => {
          queryClient.invalidateQueries({ queryKey: ["/api/core/tasks"] });
          if (selectedTask) handleViewTask(selectedTask.id);
        }}
      />
    </div>
  );
}

interface CreateTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branches: Branch[];
  onSuccess: () => void;
}

function CreateTaskDialog({ open, onOpenChange, branches, onSuccess }: CreateTaskDialogProps) {
  const { toast } = useToast();
  const [branchId, setBranchId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const priority = "medium";
  const [dueAt, setDueAt] = useState("");
  const [requiresPhotoEvidence, setRequiresPhotoEvidence] = useState(false);

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", "/api/core/tasks", data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Task created successfully" });
      onSuccess();
      onOpenChange(false);
      setBranchId("");
      setTitle("");
      setDescription("");
      setDueAt("");
      setRequiresPhotoEvidence(false);
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handleSubmit = () => {
    if (!branchId || !title) {
      toast({ title: "Validation", description: "Branch and title are required", variant: "destructive" });
      return;
    }
    createMutation.mutate({
      branchId,
      title,
      description: description || null,
      priority,
      dueAt: dueAt || null,
      requiresPhotoEvidence,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="dialog-create-task">
        <DialogHeader>
          <DialogTitle data-testid="text-dialog-title">Create Task</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Branch *</Label>
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger data-testid="input-branch">
                <SelectValue placeholder="Select branch" />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id} data-testid={`option-create-branch-${b.id}`}>{b.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Title *</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title"
              data-testid="input-title"
            />
          </div>
          <div>
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Task description"
              data-testid="input-description"
            />
          </div>
          <div>
            <Label>Due Date</Label>
            <DatePicker
              value={dueAt}
              onChange={setDueAt}
              data-testid="input-due-date"
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={requiresPhotoEvidence}
              onCheckedChange={setRequiresPhotoEvidence}
              data-testid="switch-photo-evidence"
            />
            <Label>Requires photo evidence</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-create">Cancel</Button>
          <Button onClick={handleSubmit} disabled={createMutation.isPending} data-testid="button-submit-task">
            {createMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Create Task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface TaskDetailSheetProps {
  task: TaskDetail | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdate: () => void;
}

function TaskDetailSheet({ task, open, onOpenChange, onUpdate }: TaskDetailSheetProps) {
  const { toast } = useToast();
  const [completeMode, setCompleteMode] = useState(false);
  const [note, setNote] = useState("");
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [uploadedFileIds, setUploadedFileIds] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const completeMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", `/api/core/tasks/${task?.id}/complete`, data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Task completed" });
      onUpdate();
      setCompleteMode(false);
      setNote("");
      setUploadedFileIds([]);
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !task) return;

    setUploadingPhoto(true);
    try {
      const res = await apiRequest("POST", "/api/core/files/upload-url", {
        taskId: task.id,
        originalFilename: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
      });
      const { uploadUrl, fileId } = await res.json();

      const uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!uploadResponse.ok) throw new Error("Photo upload failed");

      setUploadedFileIds((prev) => [...prev, fileId]);
      toast({ title: "Success", description: "Photo uploaded" });
    } catch (error: any) {
      toast({ title: "Error", description: "Failed to upload photo", variant: "destructive" });
    } finally {
      setUploadingPhoto(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleComplete = () => {
    completeMutation.mutate({
      note: note || null,
      photoFileIds: uploadedFileIds.length > 0 ? uploadedFileIds : undefined,
    });
  };

  if (!task) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto" data-testid="sheet-task-detail">
        <SheetHeader>
          <SheetTitle data-testid="text-task-title">{task.title}</SheetTitle>
        </SheetHeader>
        <div className="mt-6 space-y-4">
          <div className="flex gap-2">
            <Badge variant="outline" className={statusColors[task.status]} data-testid="badge-status">
              {task.status.replace("_", " ")}
            </Badge>
          </div>

          {task.description && (
            <div data-testid="section-description">
              <Label className="text-muted-foreground">Description</Label>
              <p className="mt-1" data-testid="text-description">{task.description}</p>
            </div>
          )}

          {task.dueAt && (
            <div data-testid="section-due-date">
              <Label className="text-muted-foreground">Due Date</Label>
              <p className="mt-1" data-testid="text-due-date">{format(new Date(task.dueAt), "MMMM d, yyyy")}</p>
            </div>
          )}

          {task.assignedUserName && (
            <div data-testid="section-assigned-to">
              <Label className="text-muted-foreground">Assigned To</Label>
              <p className="mt-1" data-testid="text-assigned-to">{task.assignedUserName}</p>
            </div>
          )}

          {task.requiresPhotoEvidence && (
            <div className="flex items-center gap-2 text-sm text-orange-600 dark:text-orange-400" data-testid="text-photo-required">
              <Upload className="h-4 w-4" />
              Photo evidence required
            </div>
          )}

          {task.completions.length > 0 && (
            <div data-testid="section-completions">
              <Label className="text-muted-foreground">Completions ({task.completions.length})</Label>
              <div className="mt-2 space-y-2">
                {task.completions.map((c) => (
                  <div key={c.id} className="p-3 rounded-md bg-muted text-sm" data-testid={`completion-${c.id}`}>
                    <div className="font-medium" data-testid={`text-completed-by-${c.id}`}>{c.completedByName || c.completedByEmail}</div>
                    <div className="text-muted-foreground" data-testid={`text-completed-at-${c.id}`}>
                      {format(new Date(c.completedAt), "d MMM yyyy h:mm a")}
                    </div>
                    {c.note && <p className="mt-1" data-testid={`text-note-${c.id}`}>{c.note}</p>}
                    {c.photoUrls && c.photoUrls.length > 0 && (
                      <div className="mt-1 text-xs text-muted-foreground" data-testid={`text-photos-${c.id}`}>
                        {c.photoUrls.length} photo(s) attached
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {task.status !== "completed" && task.status !== "cancelled" && (
            <div className="pt-4 border-t">
              {!completeMode ? (
                <Button onClick={() => setCompleteMode(true)} className="w-full" data-testid="button-complete-task">
                  <CheckCircle className="h-4 w-4 mr-2" />
                  Complete Task
                </Button>
              ) : (
                <div className="space-y-4">
                  <div>
                    <Label>Note (optional)</Label>
                    <Textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Add a note about completion"
                      data-testid="input-completion-note"
                    />
                  </div>
                  <div>
                    <Label>Photo Evidence {task.requiresPhotoEvidence && "*"}</Label>
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={handlePhotoUpload}
                        data-testid="input-photo-upload"
                      />
                      <Button
                        variant="outline"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploadingPhoto}
                        data-testid="button-upload-photo"
                      >
                        {uploadingPhoto ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Upload className="h-4 w-4 mr-2" />
                        )}
                        Upload Photo
                      </Button>
                      {uploadedFileIds.length > 0 && (
                        <span className="text-sm text-green-600" data-testid="text-photos-uploaded-count">
                          {uploadedFileIds.length} photo(s) uploaded
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setCompleteMode(false)} data-testid="button-cancel-complete">Cancel</Button>
                    <Button
                      onClick={handleComplete}
                      disabled={completeMutation.isPending}
                      data-testid="button-submit-completion"
                    >
                      {completeMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      Submit Completion
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
