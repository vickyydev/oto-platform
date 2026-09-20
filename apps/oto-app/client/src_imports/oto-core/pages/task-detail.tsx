import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { 
  Clock, 
  Calendar,
  CheckCircle,
  Circle,
  Camera,
  MessageSquare,
  ArrowLeft,
  Upload,
  X,
  User,
  Image
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useLocation, Link } from "wouter";
import { format, parseISO } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Task } from "@shared/schema";

interface TaskQuestion {
  id: string;
  prompt: string;
  questionType: "text" | "boolean" | "choice";
  options?: string[];
  isRequired: boolean;
  sortOrder: number;
}

interface TaskWithDetails extends Task {
  completion?: {
    id: string;
    completedById: string;
    completedAt: string;
    photoUrls?: string[];
    responses?: { questionId: string; response: string | boolean }[];
  };
  completedByName?: string;
  questions?: TaskQuestion[];
}

export default function TaskDetailPage({ params }: { params: { id: string } }) {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const taskId = params.id;

  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [photoPreviews, setPhotoPreviews] = useState<string[]>([]);
  const [responses, setResponses] = useState<Record<string, string | boolean>>({});

  const { data: task, isLoading } = useQuery<TaskWithDetails>({
    queryKey: ["/api/tasks", taskId],
    enabled: !!user && !!taskId,
  });

  const completeTaskMutation = useMutation({
    mutationFn: async (data: { photoUrls?: string[]; responses?: { questionId: string; response: string | boolean }[] }) => {
      return apiRequest("POST", `/api/tasks/${taskId}/complete`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks/grouped"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks/today"] });
      // Invalidate all event tasks to ensure bidirectional sync
      queryClient.invalidateQueries({ predicate: (query) => 
        Array.isArray(query.queryKey) && 
        typeof query.queryKey[0] === 'string' && 
        query.queryKey[0].includes('/api/events/') && 
        query.queryKey[0].includes('/tasks')
      });
      toast({
        title: "Task completed",
        description: "Task has been marked as complete.",
      });
      setLocation("/tasks");
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to complete task",
        variant: "destructive",
      });
    },
  });

  if (isLoading) {
    return (
      <AppLayout>
        <LoadingScreen />
      </AppLayout>
    );
  }

  if (!task) {
    return (
      <AppLayout>
        <div className="p-4">
          <p className="text-center text-muted-foreground">Task not found</p>
        </div>
      </AppLayout>
    );
  }

  const isCompleted = !!task.completion;
  const taskDate = task.dueDate ? parseISO(task.dueDate) : new Date();

  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    
    setPhotoFiles(prev => [...prev, ...files]);
    
    files.forEach(file => {
      const reader = new FileReader();
      reader.onloadend = () => {
        setPhotoPreviews(prev => [...prev, reader.result as string]);
      };
      reader.readAsDataURL(file);
    });
  };

  const removePhoto = (index: number) => {
    setPhotoFiles(prev => prev.filter((_, i) => i !== index));
    setPhotoPreviews(prev => prev.filter((_, i) => i !== index));
  };

  const canSubmit = () => {
    if (task.requiresPhotoEvidence && photoFiles.length === 0) return false;
    const requiredQuestions = (task.questions || []).filter(q => q.isRequired);
    for (const q of requiredQuestions) {
      if (responses[q.id] === undefined || responses[q.id] === "") return false;
    }
    return true;
  };

  const handleSubmit = async () => {
    const formattedResponses = Object.entries(responses).map(([questionId, response]) => ({
      questionId,
      response,
    }));

    await completeTaskMutation.mutateAsync({
      photoUrls: photoPreviews.length > 0 ? photoPreviews : undefined,
      responses: formattedResponses.length > 0 ? formattedResponses : undefined,
    });
  };

  return (
    <AppLayout>
      <div className="p-4 max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/tasks">
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div className="flex-1">
            <h1 className="text-xl font-bold">Task Details</h1>
          </div>
        </div>

        <Card className="mb-6">
          <CardContent className="p-4 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 flex items-center justify-center">
                  {isCompleted ? (
                    <CheckCircle className="h-6 w-6 text-green-600" />
                  ) : (
                    <Circle className="h-6 w-6 text-muted-foreground" />
                  )}
                </div>
                <div>
                  <h2 className="font-semibold text-lg">{task.title}</h2>
                  <Badge variant={isCompleted ? "default" : "secondary"}>
                    {isCompleted ? "Completed" : "Pending"}
                  </Badge>
                </div>
              </div>
            </div>

            {task.description && (
              <div>
                <p className="text-sm font-medium text-muted-foreground mb-1">Description</p>
                <p className="text-sm">{task.description}</p>
              </div>
            )}

            {task.referencePhotoUrl && (
              <div>
                <p className="text-sm font-medium text-muted-foreground mb-1">Reference Photo</p>
                <img 
                  src={task.referencePhotoUrl} 
                  alt="Reference" 
                  className="max-h-40 rounded-md object-contain"
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-medium text-muted-foreground mb-1">Due Date</p>
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">{format(taskDate, "MMM d, yyyy")}</span>
                </div>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground mb-1">Due Time</p>
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">{task.dueTime}</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-4 text-sm">
              {task.requiresPhotoEvidence && (
                <div className="flex items-center gap-1">
                  <Camera className="h-4 w-4 text-muted-foreground" />
                  <span>Photo required</span>
                </div>
              )}
              {task.requiresResponses && (
                <div className="flex items-center gap-1">
                  <MessageSquare className="h-4 w-4 text-muted-foreground" />
                  <span>Questions required</span>
                </div>
              )}
            </div>

            {isCompleted && (
              <div className="pt-4 border-t space-y-3">
                <p className="text-sm font-medium text-green-600">Completion Details</p>
                {task.completedByName && (
                  <div className="flex items-center gap-2">
                    <User className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">Completed by {task.completedByName}</span>
                  </div>
                )}
                {task.completion?.completedAt && (
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">{format(parseISO(task.completion.completedAt), "MMM d, yyyy 'at' h:mm a")}</span>
                  </div>
                )}
                {task.completion?.photoUrls && task.completion.photoUrls.length > 0 && (
                  <div>
                    <p className="text-sm font-medium text-muted-foreground mb-2">Photos</p>
                    <div className="flex gap-2 flex-wrap">
                      {task.completion.photoUrls.map((url, idx) => (
                        <img key={idx} src={url} alt={`Evidence ${idx + 1}`} className="h-20 w-20 object-cover rounded-md" />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {!isCompleted && (
          <Card>
            <CardContent className="p-4 space-y-4">
              <h3 className="font-semibold">Complete Task</h3>

              {task.requiresPhotoEvidence && (
                <div className="space-y-2">
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

              {task.requiresResponses && task.questions && task.questions.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4" />
                    <span className="font-medium text-sm">Questions</span>
                  </div>
                  {task.questions.sort((a, b) => a.sortOrder - b.sortOrder).map((q) => (
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
                  ))}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-4">
                <Link href="/tasks">
                  <Button variant="outline">Cancel</Button>
                </Link>
                <Button 
                  onClick={handleSubmit}
                  disabled={!canSubmit() || completeTaskMutation.isPending}
                  data-testid="button-complete-task"
                >
                  {completeTaskMutation.isPending ? "Completing..." : "Mark Complete"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </AppLayout>
  );
}
