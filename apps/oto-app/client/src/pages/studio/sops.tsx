import { useState, useRef } from "react";
import { StudioLayout } from "@/components/layout/studio-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { LoadingScreen, LoadingSpinner } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { 
  FileText, 
  Globe, 
  Lock, 
  MapPin, 
  Plus, 
  Search, 
  X, 
  Check, 
  Trash2, 
  Image as ImageIcon,
  Eye,
  Edit,
  ChevronDown,
  ChevronUp
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useBranchContext } from "@/hooks/use-branch-context";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { SopArticle, SopStep } from "@shared/schema";

interface LocalStep {
  id: string;
  stepNumber: number;
  title: string;
  description: string;
  imageUrl: string;
  imageFilename: string;
  isUploading?: boolean;
}

function generateStepFilename(sopTitle: string, stepNumber: number, stepTitle: string): string {
  const sanitizedSopTitle = sopTitle.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 20);
  const sanitizedStepTitle = stepTitle.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 20);
  return `SOP_${sanitizedSopTitle}_Step${stepNumber}_${sanitizedStepTitle}.jpg`;
}

function StepBuilder({ 
  steps, 
  onStepsChange, 
  sopTitle,
  disabled 
}: { 
  steps: LocalStep[]; 
  onStepsChange: (steps: LocalStep[]) => void; 
  sopTitle: string;
  disabled?: boolean;
}) {
  const fileInputRefs = useRef<{ [key: string]: HTMLInputElement | null }>({});
  const { toast } = useToast();

  const addStep = () => {
    const newStep: LocalStep = {
      id: crypto.randomUUID(),
      stepNumber: steps.length + 1,
      title: "",
      description: "",
      imageUrl: "",
      imageFilename: "",
    };
    onStepsChange([...steps, newStep]);
  };

  const removeStep = (id: string) => {
    const filtered = steps.filter(s => s.id !== id);
    const renumbered = filtered.map((s, i) => ({ ...s, stepNumber: i + 1 }));
    onStepsChange(renumbered);
  };

  const updateStep = (id: string, field: keyof LocalStep, value: string) => {
    onStepsChange(steps.map(s => {
      if (s.id !== id) return s;
      const updated = { ...s, [field]: value };
      if (field === "title" && sopTitle) {
        updated.imageFilename = generateStepFilename(sopTitle, s.stepNumber, value);
      }
      return updated;
    }));
  };

  const moveStep = (index: number, direction: "up" | "down") => {
    if (direction === "up" && index === 0) return;
    if (direction === "down" && index === steps.length - 1) return;
    
    const newSteps = [...steps];
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    [newSteps[index], newSteps[targetIndex]] = [newSteps[targetIndex], newSteps[index]];
    
    const renumbered = newSteps.map((s, i) => ({ 
      ...s, 
      stepNumber: i + 1,
      imageFilename: s.title ? generateStepFilename(sopTitle, i + 1, s.title) : s.imageFilename
    }));
    onStepsChange(renumbered);
  };

  const handleImageUpload = async (stepId: string, file: File) => {
    const step = steps.find(s => s.id === stepId);
    if (!step) return;

    // Security: Validate file type (images only)
    const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (!allowedTypes.includes(file.type)) {
      toast({ 
        title: "Invalid file type", 
        description: "Please upload a JPEG, PNG, GIF, or WebP image.",
        variant: "destructive" 
      });
      return;
    }

    // Security: Validate file size (max 2MB to prevent storage bloat)
    const maxSizeBytes = 2 * 1024 * 1024; // 2MB
    if (file.size > maxSizeBytes) {
      toast({ 
        title: "Image too large", 
        description: "Please upload an image smaller than 2MB.",
        variant: "destructive" 
      });
      return;
    }

    onStepsChange(steps.map(s => 
      s.id === stepId ? { ...s, isUploading: true } : s
    ));

    try {
      const reader = new FileReader();
      reader.onload = (e) => {
        const base64 = e.target?.result as string;
        onStepsChange(steps.map(s => 
          s.id === stepId ? { 
            ...s, 
            imageUrl: base64, 
            isUploading: false,
            imageFilename: generateStepFilename(sopTitle, s.stepNumber, s.title || `Step${s.stepNumber}`)
          } : s
        ));
      };
      reader.readAsDataURL(file);
    } catch {
      toast({ title: "Failed to upload image", variant: "destructive" });
      onStepsChange(steps.map(s => 
        s.id === stepId ? { ...s, isUploading: false } : s
      ));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>Steps (with images)</Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addStep}
          disabled={disabled}
          data-testid="button-add-step"
        >
          <Plus className="h-4 w-4 mr-1" />
          Add Step
        </Button>
      </div>

      {steps.length === 0 ? (
        <div className="border-2 border-dashed rounded-lg p-6 text-center text-muted-foreground">
          <p className="text-sm">No steps yet. Click "Add Step" to create your first step.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {steps.map((step, index) => (
            <Card key={step.id} className="overflow-visible" data-testid={`step-card-${index}`}>
              <CardContent className="p-3">
                <div className="flex items-start gap-2">
                  <div className="flex flex-col items-center gap-1 pt-2">
                    <div className="flex items-center justify-center h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-bold">
                      {step.stepNumber}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5"
                        onClick={() => moveStep(index, "up")}
                        disabled={index === 0 || disabled}
                      >
                        <ChevronUp className="h-3 w-3" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5"
                        onClick={() => moveStep(index, "down")}
                        disabled={index === steps.length - 1 || disabled}
                      >
                        <ChevronDown className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>

                  <div className="flex-1 space-y-2">
                    <Input
                      placeholder={`Step ${step.stepNumber} title (e.g., "Check Internet Connection")`}
                      value={step.title}
                      onChange={(e) => updateStep(step.id, "title", e.target.value)}
                      disabled={disabled}
                      data-testid={`input-step-${index}-title`}
                    />
                    <Textarea
                      placeholder="Description (optional)"
                      value={step.description}
                      onChange={(e) => updateStep(step.id, "description", e.target.value)}
                      rows={2}
                      disabled={disabled}
                      data-testid={`textarea-step-${index}-desc`}
                    />

                    <div className="flex items-center gap-2">
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        ref={(el) => { fileInputRefs.current[step.id] = el; }}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleImageUpload(step.id, file);
                        }}
                      />
                      
                      {step.imageUrl ? (
                        <div className="flex items-center gap-2 flex-1">
                          <div className="relative h-12 w-12 rounded border overflow-hidden flex-shrink-0">
                            <img 
                              src={step.imageUrl} 
                              alt={`Step ${step.stepNumber}`}
                              className="h-full w-full object-cover"
                            />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-muted-foreground truncate">{step.imageFilename}</p>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => fileInputRefs.current[step.id]?.click()}
                            disabled={disabled}
                          >
                            Change
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => updateStep(step.id, "imageUrl", "")}
                            disabled={disabled}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => fileInputRefs.current[step.id]?.click()}
                          disabled={disabled || step.isUploading}
                          className="flex-1"
                          data-testid={`button-upload-step-${index}`}
                        >
                          {step.isUploading ? (
                            <LoadingSpinner className="h-4 w-4 mr-1" />
                          ) : (
                            <ImageIcon className="h-4 w-4 mr-1" />
                          )}
                          Upload Photo
                        </Button>
                      )}
                    </div>
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeStep(step.id)}
                    disabled={disabled}
                    className="text-destructive hover:text-destructive"
                    data-testid={`button-remove-step-${index}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function StaffPreview({ 
  title, 
  steps, 
  content 
}: { 
  title: string; 
  steps: LocalStep[]; 
  content: string;
}) {
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());
  const [viewingImage, setViewingImage] = useState<{ url: string; title: string } | null>(null);

  const toggleStep = (stepNumber: number) => {
    const newSet = new Set(completedSteps);
    if (newSet.has(stepNumber)) {
      newSet.delete(stepNumber);
    } else {
      newSet.add(stepNumber);
    }
    setCompletedSteps(newSet);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground border-b pb-2 mb-4">
        <Eye className="h-4 w-4" />
        Staff View Preview
      </div>

      <h2 className="text-lg font-bold">{title || "Untitled SOP"}</h2>
      
      {content && (
        <p className="text-sm text-muted-foreground">{content}</p>
      )}

      {steps.length > 0 && (
        <div className="space-y-2">
          {steps.map((step) => (
            <div
              key={step.id}
              className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${
                completedSteps.has(step.stepNumber) 
                  ? 'bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-900' 
                  : 'bg-card'
              }`}
            >
              <button
                type="button"
                onClick={() => toggleStep(step.stepNumber)}
                className={`flex-shrink-0 h-6 w-6 rounded-full border-2 flex items-center justify-center transition-colors ${
                  completedSteps.has(step.stepNumber)
                    ? 'bg-green-500 border-green-500 text-white'
                    : 'border-muted-foreground/30'
                }`}
              >
                {completedSteps.has(step.stepNumber) && <Check className="h-4 w-4" />}
              </button>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">Step {step.stepNumber}:</span>
                  <span className={completedSteps.has(step.stepNumber) ? 'line-through text-muted-foreground' : ''}>
                    {step.title || `Step ${step.stepNumber}`}
                  </span>
                </div>
                {step.description && (
                  <p className="text-sm text-muted-foreground mt-1">{step.description}</p>
                )}
              </div>

              {step.imageUrl && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setViewingImage({ url: step.imageUrl, title: step.title })}
                  className="flex-shrink-0"
                >
                  <ImageIcon className="h-4 w-4 mr-1" />
                  View Photo
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog open={!!viewingImage} onOpenChange={() => setViewingImage(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{viewingImage?.title || "Step Photo"}</DialogTitle>
          </DialogHeader>
          {viewingImage && (
            <img 
              src={viewingImage.url} 
              alt={viewingImage.title}
              className="w-full h-auto rounded-lg"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function StudioSopsPage() {
  const { user } = useAuth();
  const { activeBranchId, isAllBranches, branches } = useBranchContext();
  const { toast } = useToast();
  const isAdmin = ["admin", "global_admin", "operator_admin"].includes(user?.role || "");
  const [searchQuery, setSearchQuery] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingSop, setEditingSop] = useState<SopArticle | null>(null);
  const [isPreviewMode, setIsPreviewMode] = useState(false);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<"GLOBAL" | "BRANCHES">("GLOBAL");
  const [selectedBranchIds, setSelectedBranchIds] = useState<string[]>([]);
  const [steps, setSteps] = useState<LocalStep[]>([]);

  const branchParam = isAllBranches ? 'all' : activeBranchId;
  const sopsUrl = branchParam ? `/api/sops?branchId=${branchParam}` : '/api/sops';

  const { data: sops, isLoading } = useQuery<SopArticle[]>({
    queryKey: ["/api/sops", branchParam],
    queryFn: async () => {
      const res = await fetch(sopsUrl, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch SOPs");
      return res.json();
    },
    enabled: !!user,
  });

  const createMutation = useMutation({
    mutationFn: async (data: Partial<SopArticle>) => {
      const res = await apiRequest("POST", "/api/sops", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sops"] });
      toast({ title: "SOP created successfully" });
      closeDialog();
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create SOP", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<SopArticle> }) => {
      const res = await apiRequest("PATCH", `/api/sops/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sops"] });
      toast({ title: "SOP updated successfully" });
      closeDialog();
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update SOP", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/sops/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sops"] });
      toast({ title: "SOP deleted successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete SOP", description: error.message, variant: "destructive" });
    },
  });

  const openDialog = (sop?: SopArticle) => {
    if (sop) {
      setEditingSop(sop);
      setTitle(sop.title);
      setContent(sop.body || "");
      setScope(sop.scope as "GLOBAL" | "BRANCHES" || "GLOBAL");
      setSelectedBranchIds(sop.branchIds || []);
      
      const structuredSteps = (sop as any).structuredSteps as SopStep[] | null;
      if (structuredSteps && structuredSteps.length > 0) {
        setSteps(structuredSteps.map(s => ({
          id: crypto.randomUUID(),
          stepNumber: s.stepNumber,
          title: s.title,
          description: s.description || "",
          imageUrl: s.imageUrl || "",
          imageFilename: s.imageFilename || "",
        })));
      } else if (sop.steps && sop.steps.length > 0) {
        setSteps(sop.steps.map((text, i) => ({
          id: crypto.randomUUID(),
          stepNumber: i + 1,
          title: text,
          description: "",
          imageUrl: "",
          imageFilename: "",
        })));
      } else {
        setSteps([]);
      }
    } else {
      setEditingSop(null);
      setTitle("");
      setContent("");
      setScope("GLOBAL");
      setSelectedBranchIds([]);
      setSteps([]);
    }
    setIsPreviewMode(false);
    setIsDialogOpen(true);
  };

  const closeDialog = () => {
    setIsDialogOpen(false);
    setEditingSop(null);
    setTitle("");
    setContent("");
    setScope("GLOBAL");
    setSelectedBranchIds([]);
    setSteps([]);
    setIsPreviewMode(false);
  };

  const handleSubmit = () => {
    const structuredSteps: SopStep[] = steps.map(s => ({
      stepNumber: s.stepNumber,
      title: s.title,
      description: s.description || undefined,
      imageUrl: s.imageUrl || undefined,
      imageFilename: s.imageFilename || undefined,
    }));

    const legacySteps = steps.map(s => s.title);

    const data = {
      title,
      body: content,
      scope,
      branchIds: scope === "BRANCHES" ? selectedBranchIds : [],
      departments: [],
      structuredSteps,
      steps: legacySteps,
    };

    if (editingSop) {
      updateMutation.mutate({ id: editingSop.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const toggleBranch = (branchId: string) => {
    setSelectedBranchIds(prev =>
      prev.includes(branchId)
        ? prev.filter(id => id !== branchId)
        : [...prev, branchId]
    );
  };

  const filteredSops = sops?.filter(sop => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return sop.title.toLowerCase().includes(query);
  }) || [];

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
          <h1 className="text-xl font-bold">SOP Articles</h1>
          {isAdmin ? (
            <Button size="sm" onClick={() => openDialog()} data-testid="button-create-sop">
              <Plus className="h-4 w-4 mr-1" />
              Add SOP
            </Button>
          ) : (
            <Badge variant="secondary" className="flex items-center gap-1">
              <Lock className="h-3 w-3" />
              View Only
            </Badge>
          )}
        </div>

        {!isAdmin && (
          <Card className="mb-4 bg-muted/50">
            <CardContent className="p-3 text-sm text-muted-foreground">
              SOP articles can only be edited by administrators. Contact your admin to make changes.
            </CardContent>
          </Card>
        )}

        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search SOPs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="input-search-sops"
          />
        </div>

        <div className="space-y-3">
          {filteredSops.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No SOPs"
              description={searchQuery ? "No matching articles found" : "No SOP articles have been created yet"}
            />
          ) : (
            filteredSops.map((sop) => (
              <Card 
                key={sop.id} 
                className={`overflow-visible ${isAdmin ? 'hover-elevate cursor-pointer' : ''}`} 
                data-testid={`card-sop-${sop.id}`}
                onClick={() => isAdmin && openDialog(sop)}
              >
                <CardContent className="p-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-semibold">{sop.title}</h3>
                      {isAdmin && sop.scope === 'GLOBAL' && (
                        <Badge variant="outline" className="text-xs">
                          <Globe className="h-3 w-3 mr-1" />
                          Global
                        </Badge>
                      )}
                      {isAdmin && sop.scope === 'BRANCHES' && (
                        <Badge variant="outline" className="text-xs">
                          <MapPin className="h-3 w-3 mr-1" />
                          {sop.branchIds?.length || 0} branches
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {((sop as any).structuredSteps?.length > 0 || sop.steps?.length) && (
                        <Badge variant="secondary" className="text-xs">
                          {(sop as any).structuredSteps?.length || sop.steps?.length || 0} steps
                        </Badge>
                      )}
                      {(sop.departments || []).slice(0, 3).map((dept) => (
                        <Badge key={dept} variant="secondary" className="text-xs capitalize">
                          {dept.replace("_", "/")}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh]">
          <DialogHeader className="flex flex-row items-center justify-between gap-4">
            <DialogTitle>{editingSop ? "Edit SOP" : "Create SOP"}</DialogTitle>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant={isPreviewMode ? "default" : "outline"}
                size="sm"
                onClick={() => setIsPreviewMode(!isPreviewMode)}
                data-testid="button-toggle-preview"
              >
                {isPreviewMode ? <Edit className="h-4 w-4 mr-1" /> : <Eye className="h-4 w-4 mr-1" />}
                {isPreviewMode ? "Edit" : "Preview"}
              </Button>
            </div>
          </DialogHeader>
          
          <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
            {isPreviewMode ? (
              <StaffPreview title={title} steps={steps} content={content} />
            ) : (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="title">Title</Label>
                  <Input
                    id="title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="SOP Title (e.g., Gate Troubleshooting)"
                    data-testid="input-sop-title"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="content">Overview / Introduction</Label>
                  <Textarea
                    id="content"
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder="Brief overview or goal of this SOP..."
                    rows={2}
                    data-testid="textarea-sop-content"
                  />
                </div>

                <StepBuilder 
                  steps={steps} 
                  onStepsChange={setSteps} 
                  sopTitle={title}
                  disabled={createMutation.isPending || updateMutation.isPending}
                />

                <div className="space-y-2">
                  <Label htmlFor="scope">Visibility Scope</Label>
                  <Select value={scope} onValueChange={(v) => setScope(v as "GLOBAL" | "BRANCHES")}>
                    <SelectTrigger data-testid="select-scope">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="GLOBAL">
                        <div className="flex items-center gap-2">
                          <Globe className="h-4 w-4" />
                          Global (all branches)
                        </div>
                      </SelectItem>
                      <SelectItem value="BRANCHES">
                        <div className="flex items-center gap-2">
                          <MapPin className="h-4 w-4" />
                          Selected branches only
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {scope === "BRANCHES" && (
                  <div className="space-y-2">
                    <Label>Select Branches</Label>
                    <div className="border rounded-md p-2 max-h-40 overflow-y-auto space-y-1">
                      {branches.map((branch) => (
                        <div
                          key={branch.id}
                          className={`flex items-center gap-2 p-2 rounded-md cursor-pointer hover-elevate ${
                            selectedBranchIds.includes(branch.id) ? 'bg-primary/10' : ''
                          }`}
                          onClick={() => toggleBranch(branch.id)}
                          data-testid={`branch-option-${branch.id}`}
                        >
                          <div className={`h-4 w-4 rounded border flex items-center justify-center ${
                            selectedBranchIds.includes(branch.id) 
                              ? 'bg-primary border-primary text-primary-foreground' 
                              : 'border-muted-foreground/30'
                          }`}>
                            {selectedBranchIds.includes(branch.id) && <Check className="h-3 w-3" />}
                          </div>
                          <span className="text-sm">{branch.name}</span>
                        </div>
                      ))}
                    </div>
                    {selectedBranchIds.length === 0 && (
                      <p className="text-sm text-muted-foreground">Select at least one branch</p>
                    )}
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  {editingSop && (
                    <Button
                      variant="destructive"
                      onClick={() => {
                        if (confirm("Delete this SOP?")) {
                          deleteMutation.mutate(editingSop.id);
                          closeDialog();
                        }
                      }}
                      disabled={deleteMutation.isPending}
                      data-testid="button-delete-sop"
                    >
                      Delete
                    </Button>
                  )}
                  <div className="flex-1" />
                  <Button variant="outline" onClick={closeDialog} data-testid="button-cancel-sop">
                    Cancel
                  </Button>
                  <Button
                    onClick={handleSubmit}
                    disabled={!title || (scope === "BRANCHES" && selectedBranchIds.length === 0) || createMutation.isPending || updateMutation.isPending}
                    data-testid="button-save-sop"
                  >
                    {createMutation.isPending || updateMutation.isPending ? "Saving..." : "Save"}
                  </Button>
                </div>
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </StudioLayout>
  );
}
