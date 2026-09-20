import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { 
  ArrowLeft,
  Calendar,
  Clock,
  AlertTriangle,
  CheckCircle,
  Circle,
  Ban,
  User,
  Loader2,
  Camera,
  Upload,
  X,
  MessageSquare,
  Send,
  Paperclip,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useLocation, useParams } from "wouter";
import { format, parseISO, differenceInDays, formatDistanceToNow } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface TaskCommentData {
  id: string;
  taskId: string;
  authorId: string;
  body: string;
  createdAt: string;
  authorName: string;
}

interface TaskQuestion {
  id: string;
  prompt: string;
  questionType: "text" | "boolean" | "choice";
  options?: string[];
  isRequired: boolean;
  sortOrder: number;
}

interface MultiDayTask {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  priority: string;
  startAt?: string | null;
  startDate?: string | null;
  dueAt?: string | null;
  dueDate?: string | null;
  scheduledMode?: boolean;
  progressPercent: number;
  statusManualOverride: boolean;
  blockedReason?: string | null;
  completedAt?: string | null;
  branchId?: string | null;
  departmentId?: string | null;
  assignedTo?: string | null;
  assignedUserName?: string | null;
  assignee?: {
    type: "user" | "employee" | "role" | "department" | "unassigned";
    id: string | null;
    name: string | null;
    label: string;
  } | null;
  requiresPhotoEvidence?: boolean;
  requiresResponses?: boolean;
  referencePhotoUrl?: string | null;
  questions?: TaskQuestion[];
  createdAt?: string;
  updatedAt?: string;
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
      {/* Track container */}
      <div className="relative h-3 rounded-full bg-muted">
        {/* Progress fill - must come first to be behind other elements */}
        <div
          className="absolute top-0 left-0 h-full rounded-l-full bg-primary transition-all duration-150"
          style={{ 
            width: `${Math.max(0, Math.min(100, value))}%`,
            borderTopRightRadius: value >= 100 ? '9999px' : '0',
            borderBottomRightRadius: value >= 100 ? '9999px' : '0',
          }}
        />
        {/* Expected today line - red marker showing where progress should be */}
        {expectedPercent > 0 && expectedPercent < 100 && (
          <div
            className="absolute w-1 bg-red-500 rounded-full shadow-sm"
            style={{ 
              left: `${clampedExpected}%`, 
              transform: 'translateX(-50%)',
              top: '-6px',
              bottom: '-6px',
            }}
          />
        )}
      </div>
      {/* Slider thumb */}
      <div
        className="absolute top-1/2 w-6 h-6 rounded-full bg-primary border-2 border-primary-foreground shadow-lg cursor-pointer pointer-events-none"
        style={{ 
          left: `calc(${value}% + ${12 - (value / 100) * 24}px)`,
          transform: 'translateY(-50%)',
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
    return { expectedPercent: 0, daysDiff: 0, status: "unknown" };
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

export default function TaskDetailMultiDayPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const params = useParams<{ id: string }>();
  const taskId = params.id;

  const [localProgress, setLocalProgress] = useState<number | null>(null);
  const [isBlocking, setIsBlocking] = useState(false);
  const [blockReason, setBlockReason] = useState("");
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [photoPreviews, setPhotoPreviews] = useState<string[]>([]);
  const [responses, setResponses] = useState<Record<string, string | boolean>>({});
  const [isCompleting, setIsCompleting] = useState(false);
  const [newComment, setNewComment] = useState("");
  const commentsEndRef = useRef<HTMLDivElement>(null);

  const { data: task, isLoading } = useQuery<MultiDayTask>({
    queryKey: ["/api/core/tasks", taskId],
    queryFn: async () => {
      const res = await fetch(`/api/core/tasks/${taskId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch task");
      return res.json();
    },
    enabled: !!user && !!taskId,
  });

  const { data: comments = [] } = useQuery<TaskCommentData[]>({
    queryKey: ["/api/core/tasks", taskId, "comments"],
    queryFn: async () => {
      const res = await fetch(`/api/core/tasks/${taskId}/comments`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch comments");
      return res.json();
    },
    enabled: !!user && !!taskId,
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
      toast({
        title: "Error",
        description: error.message || "Failed to add comment",
        variant: "destructive",
      });
    },
  });

  useEffect(() => {
    if (task) {
      setLocalProgress(task.progressPercent);
    }
  }, [task]);

  const updateProgressMutation = useMutation({
    mutationFn: async (progressPercent: number) => {
      return apiRequest("PATCH", `/api/core/tasks/${taskId}/progress`, { progressPercent });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks/multi-day"] });
      toast({ title: "Progress saved" });
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
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks/multi-day"] });
      setIsBlocking(false);
      setBlockReason("");
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
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks/multi-day"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/core/tasks/multi-day"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks/today"] });
      setIsCompleting(false);
      setPhotoFiles([]);
      setPhotoPreviews([]);
      toast({ title: "Task completed" });
      setLocation("/core/tasks");
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

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

  const handleCompleteTask = async () => {
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
    if (task && currentProgress !== task.progressPercent) {
      updateProgressMutation.mutate(currentProgress);
    }
  }, [localProgress, task, updateProgressMutation]);

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (!task) {
    return (
      <div className="p-4">
        <p className="text-muted-foreground">Task not found</p>
      </div>
    );
  }

  const startDate = task.startAt ? parseISO(task.startAt) : task.startDate ? parseISO(task.startDate) : null;
  const dueDate = task.dueAt ? parseISO(task.dueAt) : task.dueDate ? parseISO(task.dueDate) : null;
  const currentProgress = localProgress ?? task.progressPercent ?? 0;
  const scheduleInfo = getScheduleInfo(startDate, dueDate, currentProgress);

  const isCompleted = task.status === "completed";
  const isBlocked = task.status === "blocked";

  const getStatusBadge = () => {
    if (isCompleted) return <Badge className="bg-green-600">Completed</Badge>;
    if (isBlocked) return <Badge className="bg-orange-500">Blocked</Badge>;
    if (task.status === "in_progress") return <Badge className="bg-blue-500">In Progress</Badge>;
    return <Badge variant="secondary">Not Started</Badge>;
  };

  const getDaysDiffDisplay = () => {
    if (scheduleInfo.status === "not_started") {
      return <span className="text-muted-foreground text-sm">Not started yet</span>;
    }
    if (scheduleInfo.status === "past_due") {
      return <span className="text-red-500 font-semibold">Past due</span>;
    }
    if (scheduleInfo.daysDiff < -1) {
      return <span className="text-red-500 font-semibold">-{Math.abs(scheduleInfo.daysDiff)}d</span>;
    }
    if (scheduleInfo.daysDiff > 1) {
      return <span className="text-green-500 font-semibold">+{scheduleInfo.daysDiff}d</span>;
    }
    return <span className="text-muted-foreground">On track</span>;
  };

  return (
    <div className="min-h-screen bg-background pb-20">
      <header className="sticky top-0 z-10 bg-background border-b p-3">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setLocation("/core/tasks")}
            data-testid="button-back"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1">
            <h1 className="font-semibold text-lg line-clamp-1">{task.title}</h1>
          </div>
          {getStatusBadge()}
        </div>
      </header>

      <main className="p-4 space-y-4">
        {task.description && (
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{task.description}</p>
            </CardContent>
          </Card>
        )}

        {/* Reference photo (e.g., from checker fail) */}
        {task.referencePhotoUrl && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-lg flex items-center gap-2">
                <Camera className="h-4 w-4" />
                Issue Photo
              </CardTitle>
            </CardHeader>
            <CardContent>
              <a href={task.referencePhotoUrl} target="_blank" rel="noopener noreferrer">
                <img 
                  src={task.referencePhotoUrl} 
                  alt="Issue reference" 
                  className="max-h-60 rounded-md object-contain cursor-pointer hover:opacity-90 transition-opacity"
                />
              </a>
            </CardContent>
          </Card>
        )}

        {/* Progress section only for scheduled/multi-day tasks */}
        {task.scheduledMode && (
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">Progress</CardTitle>
                {getDaysDiffDisplay()}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between text-2xl font-bold">
                <span data-testid="text-progress-percent">{currentProgress}%</span>
              </div>

              {startDate ? (
                <div className="flex justify-between text-sm">
                  <div>
                    <div className="text-muted-foreground flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {format(startDate, "MMM d, yyyy")}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-muted-foreground flex items-center gap-1 justify-end">
                      <Calendar className="h-3 w-3" />
                      {dueDate ? format(dueDate, "MMM d, yyyy") : "No due date"}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex justify-center text-sm">
                  <div className="text-muted-foreground flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    Due: {dueDate ? format(dueDate, "MMM d, yyyy") : "No due date"}
                  </div>
                </div>
              )}

              <ProgressSlider
                value={currentProgress}
                expectedPercent={scheduleInfo.expectedPercent}
                onChange={(val) => setLocalProgress(val)}
                onRelease={handleProgressRelease}
                disabled={isCompleted}
              />

              {startDate && (
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Expected today: {Math.round(scheduleInfo.expectedPercent)}%</span>
                  <span className="flex items-center gap-1">
                    <div className="w-3 h-3 bg-red-500 rounded-full" />
                    Today
                  </span>
                </div>
              )}

              {isBlocked && task.blockedReason && (
                <div className="bg-orange-500/10 p-3 rounded-md">
                  <p className="text-sm">
                    <strong>Blocked:</strong> {task.blockedReason}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => unblockMutation.mutate()}
                    disabled={unblockMutation.isPending}
                    data-testid="button-unblock"
                  >
                    {unblockMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                    Unblock
                  </Button>
                </div>
              )}

              {!isCompleted && !isBlocked && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsBlocking(true)}
                  data-testid="button-block"
                >
                  <AlertTriangle className="h-4 w-4 mr-1" />
                  Mark Blocked
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {(task.assignee && task.assignee.type !== "unassigned") && (
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2">
                <User className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">Assigned to: {task.assignee.label}</span>
              </div>
            </CardContent>
          </Card>
        )}

        {!isCompleted && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Complete Task</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {task.requiresPhotoEvidence && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Camera className="h-4 w-4" />
                    <span className="font-medium text-sm">Photo Evidence</span>
                    <span className="text-destructive">*</span>
                  </div>
                  
                  <div className="flex gap-2 flex-wrap">
                    {photoPreviews.map((preview, idx) => (
                      <div key={idx} className="relative h-16 w-16">
                        <img 
                          src={preview} 
                          alt={`Preview ${idx + 1}`}
                          className="h-full w-full object-cover rounded-md"
                        />
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
                    
                    <label className="h-16 w-16 flex items-center justify-center border-2 border-dashed rounded-md cursor-pointer hover:bg-muted/50 transition-colors">
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={handlePhotoChange}
                        data-testid="input-photo-upload"
                      />
                      <Upload className="h-5 w-5 text-muted-foreground" />
                    </label>
                  </div>
                  
                  {task.requiresPhotoEvidence && photoPreviews.length === 0 && (
                    <p className="text-sm text-muted-foreground">Add at least one photo to complete this task</p>
                  )}
                </div>
              )}

              {task.questions && task.questions.length > 0 && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4" />
                    <span className="font-medium text-sm">Questions</span>
                  </div>
                  {task.questions.map((question) => (
                    <div key={question.id} className="space-y-2">
                      <Label className="text-sm">
                        {question.prompt}
                        {question.isRequired && <span className="text-destructive ml-1">*</span>}
                      </Label>
                      {question.questionType === "text" && (
                        <Textarea
                          value={String(responses[question.id] || "")}
                          onChange={(e) => setResponses(prev => ({ ...prev, [question.id]: e.target.value }))}
                          placeholder="Your answer..."
                          className="text-sm"
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
                      {question.questionType === "choice" && question.options && (
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
                className="w-full"
                onClick={handleCompleteTask}
                disabled={completeTaskMutation.isPending || (task.requiresPhotoEvidence && photoPreviews.length === 0) || ((task.questions || []).filter(q => q.isRequired).some(q => responses[q.id] === undefined || responses[q.id] === ""))}
                data-testid="button-complete-task"
              >
                {completeTaskMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                <CheckCircle className="h-4 w-4 mr-2" />
                Complete Task
              </Button>
            </CardContent>
          </Card>
        )}
          <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-lg flex items-center gap-2">
              <MessageSquare className="h-4 w-4" />
              Comments
            </CardTitle>
          </CardHeader>
          <CardContent>
            {comments.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No comments yet. Be the first to comment!</p>
            ) : (
              <div className="space-y-3">
                {comments.map((comment) => (
                  <div key={comment.id} className="flex gap-3" data-testid={`comment-${comment.id}`}>
                    <Avatar className="h-8 w-8 shrink-0">
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
          </CardContent>
        </Card>
      </main>

      <div className="fixed bottom-0 left-0 right-0 z-20 bg-background border-t px-3 py-2" data-testid="comment-bar">
        <div className="flex items-center gap-2 max-w-screen-md mx-auto">
          <Avatar className="h-8 w-8 shrink-0">
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

      <Dialog open={isBlocking} onOpenChange={setIsBlocking}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Block Task</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="block-reason">Why is this task blocked?</Label>
              <Textarea
                id="block-reason"
                value={blockReason}
                onChange={(e) => setBlockReason(e.target.value)}
                placeholder="Describe what's blocking this task..."
                className="mt-2"
                data-testid="input-block-reason"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsBlocking(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => blockMutation.mutate(blockReason)}
              disabled={!blockReason.trim() || blockMutation.isPending}
              data-testid="button-confirm-block"
            >
              {blockMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Confirm Block
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
