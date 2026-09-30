import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { GraduationCap, Lock, Plus } from "lucide-react";
import { StudioLayout } from "@/components/layout/studio-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { useAuth } from "@/lib/auth";
import { useBranchContext } from "@/hooks/use-branch-context";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import type { QuizQuestion, TrainingModule } from "@shared/schema";

type ModuleListRow = TrainingModule & { questionCount: number };
type QuestionDraft = { question: string; optionsText: string; correctChoice: string };
type FormState = {
  title: string;
  description: string;
  content: string;
  passingScore: string;
  isActive: boolean;
  scope: "GLOBAL" | "BRANCHES";
  branchIds: string[];
  questions: QuestionDraft[];
};

const emptyForm = (): FormState => ({
  title: "", description: "", content: "", passingScore: "70",
  isActive: true, scope: "GLOBAL", branchIds: [], questions: [],
});

export default function StudioQuizzesPage() {
  const { user } = useAuth();
  const { branches } = useBranchContext();
  const { toast } = useToast();
  const isAdmin = ["admin", "global_admin", "operator_admin"].includes(user?.role || "");
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);

  const { data: modules = [], isLoading } = useQuery<ModuleListRow[]>({
    queryKey: ["/api/training/modules"],
    queryFn: async () => {
      const response = await fetch("/api/training/modules", { credentials: "include" });
      if (!response.ok) throw new Error("Could not load training modules");
      return response.json();
    },
    enabled: !!user,
  });

  const save = useMutation({
    mutationFn: async () => {
      const questions = form.questions.map(draft => ({
        question: draft.question.trim(),
        options: draft.optionsText.split(/\r?\n/).map(option => option.trim()).filter(Boolean),
        correctAnswer: Number(draft.correctChoice) - 1,
      }));
      const response = await fetch(editingId ? `/api/training/modules/${editingId}` : "/api/training/modules", {
        method: editingId ? "PATCH" : "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title.trim(), description: form.description,
          content: form.content, passingScore: Number(form.passingScore),
          isActive: form.isActive, scope: form.scope,
          branchIds: form.scope === "GLOBAL" ? [] : form.branchIds,
          questions,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || "Could not save training module");
      }
      return response.json();
    },
    onSuccess: () => {
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/training/modules"] });
      toast({ title: editingId ? "Training module updated" : "Training module created" });
    },
    onError: (error: Error) => toast({ title: error.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`/api/training/modules/${id}`, { method: "DELETE", credentials: "include" });
      if (!response.ok) throw new Error("Could not delete training module");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/training/modules"] });
      toast({ title: "Training module deleted" });
    },
    onError: (error: Error) => toast({ title: error.message, variant: "destructive" }),
  });

  const openEdit = async (id: string) => {
    const response = await fetch(`/api/training/modules/${id}/edit`, { credentials: "include" });
    if (!response.ok) {
      toast({ title: "Could not open training module", variant: "destructive" });
      return;
    }
    const module: TrainingModule & { questions: QuizQuestion[] } = await response.json();
    setEditingId(id);
    setForm({
      title: module.title,
      description: module.description || "",
      content: module.content || "",
      passingScore: String(module.passingScore ?? 70),
      isActive: module.isActive,
      scope: module.scope === "BRANCHES" ? "BRANCHES" : "GLOBAL",
      branchIds: module.branchIds || [],
      questions: module.questions.map(question => ({
        question: question.question,
        optionsText: question.options.join("\n"),
        correctChoice: String(question.correctAnswer + 1),
      })),
    });
    setOpen(true);
  };

  const updateQuestion = (index: number, patch: Partial<QuestionDraft>) => {
    setForm(current => ({
      ...current,
      questions: current.questions.map((question, at) => at === index ? { ...question, ...patch } : question),
    }));
  };

  if (isLoading) return <StudioLayout><LoadingScreen /></StudioLayout>;

  return (
    <StudioLayout>
      <div className="p-4 max-w-2xl mx-auto">
        <div className="flex items-center justify-between gap-4 mb-4">
          <h1 className="text-xl font-bold">Training & Quizzes</h1>
          {isAdmin ? (
            <Button onClick={() => { setEditingId(null); setForm(emptyForm()); setOpen(true); }} data-testid="button-create-training-module">
              <Plus className="h-4 w-4 mr-1" /> New module
            </Button>
          ) : <Badge variant="secondary"><Lock className="h-3 w-3 mr-1" /> View only</Badge>}
        </div>

        {!isAdmin && (
          <Card className="mb-4 bg-muted/50"><CardContent className="p-3 text-sm text-muted-foreground">
            Training modules can only be edited by administrators.
          </CardContent></Card>
        )}

        <div className="space-y-3">
          {modules.length === 0 ? (
            <EmptyState icon={GraduationCap} title="No modules" description="No training modules have been created yet" />
          ) : modules.map(module => (
            <Card key={module.id} data-testid={`card-module-${module.id}`}>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">{module.title}</h3>
                    {module.description && <p className="text-sm text-muted-foreground">{module.description}</p>}
                  </div>
                  <Badge variant={module.isActive ? "default" : "secondary"}>{module.isActive ? "Active" : "Inactive"}</Badge>
                </div>
                <div className="flex flex-wrap gap-1 text-xs">
                  <Badge variant="outline">{module.questionCount} questions</Badge>
                  {module.scope === "GLOBAL" ? <Badge variant="outline">All branches</Badge> :
                    module.branchIds.map(id => <Badge key={id} variant="outline">{branches.find(branch => branch.id === id)?.name || "Branch"}</Badge>)}
                </div>
                {isAdmin && <div className="flex gap-2 pt-1">
                  <Button variant="outline" size="sm" onClick={() => openEdit(module.id)}>Edit</Button>
                  <Button variant="outline" size="sm" onClick={() => {
                    if (window.confirm(`Delete ${module.title}? This also removes its quiz history.`)) remove.mutate(module.id);
                  }}>Delete</Button>
                </div>}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editingId ? "Edit training module" : "New training module"}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div><Label htmlFor="training-title">Title</Label><Input id="training-title" value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></div>
            <div><Label htmlFor="training-description">Description</Label><Textarea id="training-description" value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></div>
            <div><Label htmlFor="training-content">Learning content</Label><Textarea id="training-content" rows={7} value={form.content} onChange={event => setForm({ ...form, content: event.target.value })} /></div>
            <div><Label htmlFor="training-passing-score">Passing score (%)</Label><Input id="training-passing-score" type="number" min="0" max="100" value={form.passingScore} onChange={event => setForm({ ...form, passingScore: event.target.value })} /></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isActive} onChange={event => setForm({ ...form, isActive: event.target.checked })} /> Active for learners</label>
            <div>
              <Label htmlFor="training-scope">Audience</Label>
              <select id="training-scope" className="w-full border rounded-md p-2 bg-background" value={form.scope} onChange={event => setForm({ ...form, scope: event.target.value as FormState["scope"] })}>
                <option value="GLOBAL">All branches</option><option value="BRANCHES">Selected branches</option>
              </select>
              {form.scope === "BRANCHES" && <div className="mt-2 grid grid-cols-2 gap-2">
                {branches.map(branch => <label key={branch.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.branchIds.includes(branch.id)} onChange={event => setForm(current => ({ ...current, branchIds: event.target.checked ? [...current.branchIds, branch.id] : current.branchIds.filter(id => id !== branch.id) }))} />
                  {branch.name}
                </label>)}
              </div>}
            </div>
            <div className="border-t pt-4 space-y-3">
              <div className="flex items-center justify-between"><h3 className="font-semibold">Quiz questions</h3><Button size="sm" variant="outline" onClick={() => setForm(current => ({ ...current, questions: [...current.questions, { question: "", optionsText: "", correctChoice: "1" }] }))}>Add question</Button></div>
              {form.questions.map((question, index) => <Card key={index}><CardContent className="p-3 space-y-2">
                <div className="flex justify-between items-center"><Label>Question {index + 1}</Label><Button size="sm" variant="ghost" onClick={() => setForm(current => ({ ...current, questions: current.questions.filter((_, at) => at !== index) }))}>Remove</Button></div>
                <Input value={question.question} onChange={event => updateQuestion(index, { question: event.target.value })} placeholder="Question" />
                <Textarea value={question.optionsText} onChange={event => updateQuestion(index, { optionsText: event.target.value })} placeholder="One answer choice per line (2 to 6)" />
                <div><Label>Correct choice number</Label><Input type="number" min="1" max="6" value={question.correctChoice} onChange={event => updateQuestion(index, { correctChoice: event.target.value })} /></div>
              </CardContent></Card>)}
            </div>
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={save.isPending || !form.title.trim()} onClick={() => save.mutate()} data-testid="button-save-training-module">Save module</Button></div>
          </div>
        </DialogContent>
      </Dialog>
    </StudioLayout>
  );
}
