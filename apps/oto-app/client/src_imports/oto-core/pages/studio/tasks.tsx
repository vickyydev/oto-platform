import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { StudioLayout } from "@/components/layout/studio-layout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Pencil, Trash2, Clock, Building2, Camera, MessageSquare, ChevronUp, ChevronDown, Upload, X, Image } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import type { Task, Department, TaskQuestion } from "@shared/schema";

interface TaskWithQuestions extends Task {
  questions?: TaskQuestion[];
}

interface QuestionDraft {
  id?: string;
  prompt: string;
  questionType: "text" | "choice" | "boolean";
  options: string[];
  isRequired: boolean;
}

const taskFormSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  dueDate: z.string().min(1, "Due date is required"),
  dueTime: z.string().min(1, "Due time is required"),
  departmentId: z.string().optional(),
  isRecurring: z.boolean().default(false),
  requiresPhotoEvidence: z.boolean().default(false),
  requiresResponses: z.boolean().default(false),
});

type TaskFormValues = z.infer<typeof taskFormSchema>;

export default function StudioTasksPage() {
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskWithQuestions | null>(null);
  const [selectedDate, setSelectedDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [questions, setQuestions] = useState<QuestionDraft[]>([]);
  const [referencePhotoFile, setReferencePhotoFile] = useState<File | null>(null);
  const [referencePhotoPreview, setReferencePhotoPreview] = useState<string | null>(null);

  const { data: tasks = [], isLoading: loadingTasks } = useQuery<Task[]>({
    queryKey: ["/api/admin/tasks", { date: selectedDate }],
    queryFn: async () => {
      const res = await fetch(`/api/admin/tasks?date=${selectedDate}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch tasks");
      return res.json();
    },
  });

  const { data: departments = [] } = useQuery<Department[]>({
    queryKey: ["/api/departments"],
  });

  const form = useForm<TaskFormValues>({
    resolver: zodResolver(taskFormSchema),
    defaultValues: {
      title: "",
      description: "",
      dueDate: format(new Date(), "yyyy-MM-dd"),
      dueTime: "10:00",
      departmentId: "",
      isRecurring: false,
      requiresPhotoEvidence: false,
      requiresResponses: false,
    },
  });

  const requiresResponses = form.watch("requiresResponses");

  const createMutation = useMutation({
    mutationFn: async (data: TaskFormValues) => {
      const res = await apiRequest("POST", "/api/admin/tasks", data);
      const task = await res.json();
      if (referencePhotoFile) {
        const formData = new FormData();
        formData.append('taskId', task.id);
        formData.append('photos', referencePhotoFile);
        const uploadRes = await fetch('/api/upload/photos', {
          method: 'POST', body: formData, credentials: 'include'
        });
        if (!uploadRes.ok) throw new Error('Task created, but reference photo upload failed');
        const uploadData = await uploadRes.json();
        if (!uploadData.urls?.[0]) throw new Error('Task created, but reference photo upload failed');
        await apiRequest("PATCH", `/api/admin/tasks/${task.id}`, { referencePhotoUrl: uploadData.urls[0] });
      }
      
      if (data.requiresResponses && questions.length > 0) {
        await apiRequest("PUT", `/api/admin/tasks/${task.id}/questions`, {
          questions: questions.map((q, i) => ({
            prompt: q.prompt,
            questionType: q.questionType,
            options: q.questionType === "choice" ? q.options : null,
            isRequired: q.isRequired,
            sortOrder: i,
          })),
        });
      }
      return task;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tasks", { date: selectedDate }] });
      toast({ title: "Task created" });
      setDialogOpen(false);
      form.reset();
      setQuestions([]);
      setReferencePhotoFile(null);
      setReferencePhotoPreview(null);
    },
    onError: (error: Error) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tasks", { date: selectedDate }] });
      toast({ title: error.message.startsWith('Task created,') ? error.message : "Failed to create task", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<TaskFormValues> }) => {
      let referencePhotoUrl: string | undefined;
      if (referencePhotoFile) {
        const formData = new FormData();
        formData.append('taskId', id);
        formData.append('photos', referencePhotoFile);
        const uploadRes = await fetch('/api/upload/photos', {
          method: 'POST', body: formData, credentials: 'include'
        });
        if (!uploadRes.ok) throw new Error('Reference photo upload failed');
        const uploadData = await uploadRes.json();
        referencePhotoUrl = uploadData.urls?.[0];
        if (!referencePhotoUrl) throw new Error('Reference photo upload failed');
      }
      const res = await apiRequest("PATCH", `/api/admin/tasks/${id}`, { ...data, ...(referencePhotoUrl ? { referencePhotoUrl } : {}) });
      const task = await res.json();
      
      if (data.requiresResponses && questions.length > 0) {
        await apiRequest("PUT", `/api/admin/tasks/${id}/questions`, {
          questions: questions.map((q, i) => ({
            prompt: q.prompt,
            questionType: q.questionType,
            options: q.questionType === "choice" ? q.options : null,
            isRequired: q.isRequired,
            sortOrder: i,
          })),
        });
      } else if (!data.requiresResponses) {
        await apiRequest("PUT", `/api/admin/tasks/${id}/questions`, { questions: [] });
      }
      return task;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tasks", { date: selectedDate }] });
      toast({ title: "Task updated" });
      setDialogOpen(false);
      setEditingTask(null);
      form.reset();
      setQuestions([]);
    },
    onError: () => {
      toast({ title: "Failed to update task", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/admin/tasks/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tasks", { date: selectedDate }] });
      toast({ title: "Task deleted" });
    },
    onError: () => {
      toast({ title: "Failed to delete task", variant: "destructive" });
    },
  });

  const openNewTaskDialog = () => {
    setEditingTask(null);
    setQuestions([]);
    setReferencePhotoFile(null);
    setReferencePhotoPreview(null);
    form.reset({
      title: "",
      description: "",
      dueDate: selectedDate,
      dueTime: "10:00",
      departmentId: "",
      isRecurring: false,
      requiresPhotoEvidence: false,
      requiresResponses: false,
    });
    setDialogOpen(true);
  };

  const openEditDialog = async (task: Task) => {
    try {
      const res = await fetch(`/api/admin/tasks/${task.id}`, { credentials: 'include' });
      const taskWithQuestions: TaskWithQuestions = await res.json();
      setEditingTask(taskWithQuestions);
      setReferencePhotoFile(null);
      setReferencePhotoPreview(taskWithQuestions.referencePhotoUrl || null);
      setQuestions(
        (taskWithQuestions.questions || []).map(q => ({
          id: q.id,
          prompt: q.prompt,
          questionType: q.questionType as "text" | "choice" | "boolean",
          options: q.options || [],
          isRequired: q.isRequired,
        }))
      );
      form.reset({
        title: task.title,
        description: task.description || "",
        dueDate: task.dueDate,
        dueTime: task.dueTime,
        departmentId: task.departmentId || "",
        isRecurring: task.isRecurring,
        requiresPhotoEvidence: task.requiresPhotoEvidence,
        requiresResponses: task.requiresResponses,
      });
      setDialogOpen(true);
    } catch {
      toast({ title: "Failed to load task details", variant: "destructive" });
    }
  };

  const addQuestion = () => {
    setQuestions([...questions, { prompt: "", questionType: "text", options: [], isRequired: true }]);
  };

  const updateQuestion = (index: number, updates: Partial<QuestionDraft>) => {
    const updated = [...questions];
    updated[index] = { ...updated[index], ...updates };
    setQuestions(updated);
  };

  const removeQuestion = (index: number) => {
    setQuestions(questions.filter((_, i) => i !== index));
  };

  const moveQuestion = (index: number, direction: "up" | "down") => {
    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= questions.length) return;
    const updated = [...questions];
    [updated[index], updated[newIndex]] = [updated[newIndex], updated[index]];
    setQuestions(updated);
  };

  const onSubmit = (data: TaskFormValues) => {
    const submitData = {
      ...data,
      departmentId: data.departmentId === "__none__" || !data.departmentId ? undefined : data.departmentId,
    };
    if (editingTask) {
      updateMutation.mutate({ id: editingTask.id, data: submitData });
    } else {
      createMutation.mutate(submitData);
    }
  };

  const getDepartmentName = (departmentId: string | null) => {
    if (!departmentId) return "All Departments";
    const dept = departments.find(d => d.id === departmentId);
    return dept?.name || "Unknown";
  };

  return (
    <StudioLayout>
      <div className="p-4 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Tasks</h1>
            <p className="text-sm text-muted-foreground">Create and manage daily tasks</p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 flex-wrap">
          <Input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="w-auto"
            data-testid="input-task-date"
          />
          <Button onClick={openNewTaskDialog} data-testid="button-add-task">
            <Plus className="h-4 w-4 mr-2" />
            Add Task
          </Button>
        </div>

        {loadingTasks ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <Card key={i} className="p-4 animate-pulse">
                <div className="h-5 bg-muted rounded w-1/3 mb-2" />
                <div className="h-4 bg-muted rounded w-1/2" />
              </Card>
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <Card className="p-8 text-center text-muted-foreground">
            <p>No tasks for this date. Click "Add Task" to create one.</p>
          </Card>
        ) : (
          <div className="space-y-3">
            {tasks.map((task) => (
              <Card key={task.id} className="p-4" data-testid={`card-task-${task.id}`}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-medium truncate">{task.title}</h3>
                    {task.description && (
                      <p className="text-sm text-muted-foreground line-clamp-2 mt-1">{task.description}</p>
                    )}
                    <div className="flex items-center gap-3 mt-2 flex-wrap">
                      <Badge variant="outline" className="text-xs">
                        <Clock className="h-3 w-3 mr-1" />
                        {task.dueTime}
                      </Badge>
                      <Badge variant="secondary" className="text-xs">
                        <Building2 className="h-3 w-3 mr-1" />
                        {getDepartmentName(task.departmentId)}
                      </Badge>
                      {task.isRecurring && (
                        <Badge className="text-xs bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300">
                          Recurring
                        </Badge>
                      )}
                      {task.requiresPhotoEvidence && (
                        <Badge variant="outline" className="text-xs">
                          <Camera className="h-3 w-3 mr-1" />
                          Photo
                        </Badge>
                      )}
                      {task.requiresResponses && (
                        <Badge variant="outline" className="text-xs">
                          <MessageSquare className="h-3 w-3 mr-1" />
                          Questions
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button 
                      size="icon" 
                      variant="ghost" 
                      onClick={() => openEditDialog(task)}
                      data-testid={`button-edit-task-${task.id}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button 
                      size="icon" 
                      variant="ghost" 
                      onClick={() => deleteMutation.mutate(task.id)}
                      className="text-destructive"
                      data-testid={`button-delete-task-${task.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md max-h-[85vh] flex flex-col p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
          <DialogHeader className="px-6 pt-6 pb-2 shrink-0">
            <DialogTitle>{editingTask ? "Edit Task" : "Add New Task"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col flex-1 min-h-0">
              <div className="flex-1 overflow-y-auto px-6 space-y-4">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Title</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="Task title" data-testid="input-task-title" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description (optional)</FormLabel>
                    <FormControl>
                      <Textarea {...field} placeholder="Task description" data-testid="input-task-description" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="dueDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Due Date</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} data-testid="input-task-due-date" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                <FormField
                  control={form.control}
                  name="dueTime"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Due Time</FormLabel>
                      <FormControl>
                        <Input type="time" {...field} data-testid="input-task-due-time" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="departmentId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Department</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-task-department">
                          <SelectValue placeholder="All Departments" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="__none__">All Departments</SelectItem>
                        {departments.map((dept) => (
                          <SelectItem key={dept.id} value={dept.id}>{dept.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="space-y-3 pt-2 border-t">
                <p className="text-sm font-medium pt-2">Completion Requirements</p>
                
                <FormField
                  control={form.control}
                  name="requiresPhotoEvidence"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <FormLabel className="text-sm">Require Photo Evidence</FormLabel>
                        <p className="text-xs text-muted-foreground">Staff must upload a photo to complete</p>
                      </div>
                      <FormControl>
                        <Switch 
                          checked={field.value} 
                          onCheckedChange={field.onChange}
                          data-testid="switch-requires-photo"
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Image className="h-4 w-4" />
                    <span className="text-sm font-medium">Reference Photo</span>
                    <span className="text-xs text-muted-foreground">(optional)</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Add a photo for staff to reference when completing this task
                  </p>
                  {referencePhotoPreview || (editingTask?.referencePhotoUrl) ? (
                    <div className="relative w-32 h-24 rounded-md overflow-hidden bg-muted">
                      <img 
                        src={referencePhotoPreview || editingTask?.referencePhotoUrl || ''} 
                        alt="Reference" 
                        className="w-full h-full object-cover"
                      />
                      <Button
                        type="button"
                        size="icon"
                        variant="destructive"
                        className="absolute top-1 right-1 h-6 w-6"
                        onClick={() => {
                          setReferencePhotoFile(null);
                          setReferencePhotoPreview(null);
                        }}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ) : (
                    <label className="flex items-center justify-center w-32 h-24 rounded-md border-2 border-dashed border-muted-foreground/25 cursor-pointer hover-elevate overflow-visible">
                      <div className="flex flex-col items-center gap-1">
                        <Upload className="h-5 w-5 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">Upload</span>
                      </div>
                      <input 
                        type="file" 
                        accept="image/*" 
                        className="hidden" 
                        onChange={(e) => {
                          if (e.target.files && e.target.files[0]) {
                            setReferencePhotoFile(e.target.files[0]);
                            setReferencePhotoPreview(URL.createObjectURL(e.target.files[0]));
                          }
                        }}
                        data-testid="input-reference-photo"
                      />
                    </label>
                  )}
                </div>

                <FormField
                  control={form.control}
                  name="requiresResponses"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <FormLabel className="text-sm">Require Questions</FormLabel>
                        <p className="text-xs text-muted-foreground">Staff must answer questions to complete</p>
                      </div>
                      <FormControl>
                        <Switch 
                          checked={field.value} 
                          onCheckedChange={field.onChange}
                          data-testid="switch-requires-responses"
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />

                {requiresResponses && (
                  <div className="space-y-2 pt-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">Questions</p>
                      <Button 
                        type="button" 
                        size="sm" 
                        variant="outline" 
                        onClick={addQuestion}
                        data-testid="button-add-question"
                      >
                        <Plus className="h-3 w-3 mr-1" />
                        Add Question
                      </Button>
                    </div>
                    
                    {questions.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-4">
                        No questions yet. Add a question for staff to answer.
                      </p>
                    ) : (
                      <div className="space-y-3">
                        {questions.map((q, idx) => (
                          <Card key={idx} className="p-3">
                            <div className="flex items-start gap-2">
                              <div className="flex flex-col gap-1">
                                <Button 
                                  type="button" 
                                  size="icon" 
                                  variant="ghost" 
                                  className="h-6 w-6"
                                  onClick={() => moveQuestion(idx, "up")}
                                  disabled={idx === 0}
                                >
                                  <ChevronUp className="h-3 w-3" />
                                </Button>
                                <Button 
                                  type="button" 
                                  size="icon" 
                                  variant="ghost" 
                                  className="h-6 w-6"
                                  onClick={() => moveQuestion(idx, "down")}
                                  disabled={idx === questions.length - 1}
                                >
                                  <ChevronDown className="h-3 w-3" />
                                </Button>
                              </div>
                              <div className="flex-1 space-y-2">
                                <Input
                                  value={q.prompt}
                                  onChange={(e) => updateQuestion(idx, { prompt: e.target.value })}
                                  placeholder="Question text"
                                  data-testid={`input-question-${idx}`}
                                />
                                <div className="flex items-center gap-2">
                                  <Select 
                                    value={q.questionType} 
                                    onValueChange={(v) => updateQuestion(idx, { questionType: v as any })}
                                  >
                                    <SelectTrigger className="w-28" data-testid={`select-question-type-${idx}`}>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="text">Text</SelectItem>
                                      <SelectItem value="boolean">Yes/No</SelectItem>
                                      <SelectItem value="choice">Choice</SelectItem>
                                    </SelectContent>
                                  </Select>
                                  <label className="flex items-center gap-1 text-xs">
                                    <input 
                                      type="checkbox" 
                                      checked={q.isRequired}
                                      onChange={(e) => updateQuestion(idx, { isRequired: e.target.checked })}
                                    />
                                    Required
                                  </label>
                                </div>
                                {q.questionType === "choice" && (
                                  <Input
                                    value={q.options.join(", ")}
                                    onChange={(e) => updateQuestion(idx, { options: e.target.value.split(",").map(o => o.trim()) })}
                                    placeholder="Options (comma separated)"
                                    className="text-xs"
                                    data-testid={`input-question-options-${idx}`}
                                  />
                                )}
                              </div>
                              <Button 
                                type="button" 
                                size="icon" 
                                variant="ghost" 
                                className="text-destructive"
                                onClick={() => removeQuestion(idx)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </Card>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              </div>

              <div className="shrink-0 flex justify-end gap-2 px-6 py-4 border-t bg-background">
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button 
                  type="submit" 
                  disabled={createMutation.isPending || updateMutation.isPending}
                  data-testid="button-save-task"
                >
                  {editingTask ? "Update" : "Create"}
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </StudioLayout>
  );
}
