import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { LoadingScreen } from "@/components/ui/loading-spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { 
  ArrowLeft, 
  CheckCircle, 
  AlertTriangle, 
  MessageSquare,
  ChevronDown,
  ChevronUp,
  Save,
  Camera,
  Image as ImageIcon,
  Upload,
  X,
  MapPin,
  ExternalLink,
  Check,
  XCircle,
  CheckCircle2,
  Wrench,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { ChecklistRun, ChecklistRunItem, ChecklistTemplate, ChecklistTemplateItem } from "@shared/schema";
import { Link } from "wouter";
import { MediaCount, MediaPreviewStrip, MediaViewerModal, type ChecklistAttachment } from "@/components/media";

interface ChecklistRunWithDetails extends ChecklistRun {
  completedByName?: string | null;
  template: ChecklistTemplate & {
    locationName?: string;
    referenceMediaUrls?: string[];
  };
  items: (ChecklistRunItem & { 
    completedByName?: string | null;
    templateItem: ChecklistTemplateItem & {
      referenceMediaUrls?: string[];
      requiresPhoto?: boolean;
      cameraEnabled?: boolean;
      galleryEnabled?: boolean;
      linkedToFix?: boolean;
    };
    linkedFixReports?: {
      id: string;
      title: string;
      status: string;
      createdAt: string;
    }[];
  })[];
}

export default function ChecklistRunPage() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const embedded = new URLSearchParams(window.location.search).get("embedded") === "1";
  const returnedSourceItemId = new URLSearchParams(window.location.search).get("sourceItem");
  const reportSubmitted = new URLSearchParams(window.location.search).get("reported") === "1";
  const { toast } = useToast();
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [itemNotes, setItemNotes] = useState<Record<string, string>>({});
  const [itemPhotos, setItemPhotos] = useState<Record<string, string[]>>({});
  const itemPhotosRef = useRef<Record<string, string[]>>({});
  const photoSaveQueues = useRef<Record<string, Promise<unknown>>>({});
  const [uploadingPhoto, setUploadingPhoto] = useState<string | null>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const libraryInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [failNotes, setFailNotes] = useState<Record<string, string>>({});
  const failPhotoInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [failPhotos, setFailPhotos] = useState<Record<string, string>>({});
  const [uploadingFailPhoto, setUploadingFailPhoto] = useState<string | null>(null);

  useEffect(() => {
    if (!embedded) return;
    const handleEmbeddedEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        window.parent.postMessage({ type: "checklist-detail-close" }, window.location.origin);
      }
    };
    window.addEventListener("keydown", handleEmbeddedEscape);
    return () => window.removeEventListener("keydown", handleEmbeddedEscape);
  }, [embedded]);

  const { data: run, isLoading, isError, error } = useQuery<ChecklistRunWithDetails>({
    queryKey: ["/api/checklist-runs", id],
  });

  const templateId = run?.template?.id;
  
  const { data: headerAttachments = [] } = useQuery<ChecklistAttachment[]>({
    queryKey: ["/api/checklist-media/by-template", templateId],
    queryFn: async () => {
      if (!templateId) return [];
      const res = await fetch(`/api/checklist-media/by-template/${templateId}`, { credentials: "include" });
      if (!res.ok) return [];
      const data = await res.json();
      return data.attachments || [];
    },
    enabled: !!templateId,
  });

  const { data: itemAttachmentsByItem = {} } = useQuery<Record<string, ChecklistAttachment[]>>({
    queryKey: ["/api/checklist-media/items-by-template", templateId],
    queryFn: async () => {
      if (!templateId) return {};
      const res = await fetch(`/api/checklist-media/items-by-template/${templateId}`, { credentials: "include" });
      if (!res.ok) return {};
      const data = await res.json();
      return data.attachmentsByItem || {};
    },
    enabled: !!templateId,
  });

  const [mediaViewerOpen, setMediaViewerOpen] = useState(false);
  const [mediaViewerAttachments, setMediaViewerAttachments] = useState<ChecklistAttachment[]>([]);
  const [mediaViewerStartIndex, setMediaViewerStartIndex] = useState(0);

  const openMediaViewer = (attachments: ChecklistAttachment[], startIndex = 0) => {
    setMediaViewerAttachments(attachments);
    setMediaViewerStartIndex(startIndex);
    setMediaViewerOpen(true);
  };

  // Initialize itemPhotos from existing data only on first load
  const [photosInitialized, setPhotosInitialized] = useState(false);
  useEffect(() => {
    if (run && !photosInitialized) {
      const existingPhotos: Record<string, string[]> = {};
      run.items.forEach(item => {
        const photos = item.photoEvidenceUrls as string[] || [];
        if (photos.length > 0) {
          existingPhotos[item.id] = photos;
        }
      });
      if (Object.keys(existingPhotos).length > 0) {
        setItemPhotos(prev => ({ ...existingPhotos, ...prev }));
      }
      setPhotosInitialized(true);
    }
  }, [run, photosInitialized]);

  useEffect(() => {
    if (!run || !returnedSourceItemId) return;
    setExpandedItems((previous) => new Set(previous).add(returnedSourceItemId));
    setTimeout(() => {
      document.querySelector(`[data-testid="card-item-${returnedSourceItemId}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
    if (reportSubmitted) {
      toast({ title: "Fix report submitted", description: "The report is now linked to this checklist item." });
      const cleanUrl = `${window.location.pathname}?sourceItem=${encodeURIComponent(returnedSourceItemId)}${embedded ? "&embedded=1" : ""}`;
      window.history.replaceState({}, "", cleanUrl);
    }
  }, [run, returnedSourceItemId, reportSubmitted, embedded, toast]);

  useEffect(() => {
    itemPhotosRef.current = itemPhotos;
  }, [itemPhotos]);

  const updateItemMutation = useMutation({
    mutationFn: async ({ itemId, updates, checkAutoComplete }: { itemId: string; updates: Partial<ChecklistRunItem>; checkAutoComplete?: boolean }) => {
      const res = await apiRequest("PATCH", `/api/checklist-run-items/${itemId}`, updates);
      return { result: await res.json(), checkAutoComplete, itemId, updates };
    },
    onMutate: async ({ itemId, updates }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/checklist-runs", id] });
      const previous = queryClient.getQueryData<ChecklistRunWithDetails>(["/api/checklist-runs", id]);
      if (previous) {
        queryClient.setQueryData<ChecklistRunWithDetails>(["/api/checklist-runs", id], {
          ...previous,
          items: previous.items.map(item =>
            item.id === itemId
              ? {
                  ...item,
                  completed: updates.completed ?? item.completed,
                  note: updates.note ?? item.note,
                  completedAt: updates.completedAt ?? item.completedAt,
                  photoEvidenceUrls: updates.photoEvidenceUrls ?? item.photoEvidenceUrls,
                  resultStatus: updates.resultStatus !== undefined ? updates.resultStatus : item.resultStatus,
                  failNote: updates.failNote !== undefined ? updates.failNote : item.failNote,
                  failPhotoUrl: updates.failPhotoUrl !== undefined ? updates.failPhotoUrl : item.failPhotoUrl,
                }
              : item
          ),
        });
      }
      return { previous };
    },
    onSuccess: async ({ checkAutoComplete, itemId, updates }) => {
      if (checkAutoComplete && updates.completed === true) {
        const updatedRun = queryClient.getQueryData<ChecklistRunWithDetails>(["/api/checklist-runs", id]);
        if (updatedRun) {
          const isChecker = updatedRun.template.checklistType === 'checker';
          const allItemsComplete = updatedRun.items.every(item => {
            if (item.id === itemId) return true;
            if (isChecker) {
              return item.resultStatus === 'pass' || item.resultStatus === 'fail';
            }
            return item.completed;
          });
          
          const requirementsMet = updatedRun.items.every(item => {
            const requiresPhoto = item.templateItem.linkedToFix !== true
              && item.templateItem.requiresPhoto === true;
            if (requiresPhoto) {
              const photos = (item.photoEvidenceUrls as string[]) || itemPhotos[item.id] || [];
              if (photos.length === 0) return false;
            }
            if (!isChecker && item.templateItem.requiresNote && !item.note && !itemNotes[item.id]) {
              return false;
            }
            return true;
          });
          
          if (allItemsComplete && requirementsMet) {
            completeRunMutation.mutate();
          }
        }
      }
    },
    onError: (error: Error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["/api/checklist-runs", id], context.previous);
      }
      toast({
        title: "Failed to update item",
        description: error.message,
        variant: "destructive",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/checklist-runs", id] });
    },
  });

  const completeRunMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/checklist-runs/${id}`, { status: "completed" });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/checklist-runs", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/checklists/today"] });
      toast({
        title: "Checklist completed!",
        description: "Great job completing this checklist.",
      });
      setLocation("/core/today");
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to complete checklist",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const toggleItem = (
    itemId: string,
    templateItem: ChecklistTemplateItem & {
      requiresPhoto?: boolean;
      cameraEnabled?: boolean;
      galleryEnabled?: boolean;
    },
    currentCompleted: boolean,
  ) => {
    if (run?.status === "completed") return;

    if (templateItem.isCritical && currentCompleted) {
      if (!confirm("This is a critical item. Marking as incomplete may require escalation. Continue?")) {
        return;
      }
    }

    const photos = itemPhotos[itemId] || [];
    const requiresPhoto = templateItem.linkedToFix !== true
      && templateItem.requiresPhoto === true;
    const cameraEnabled = (templateItem.cameraEnabled ?? true)
      || (requiresPhoto && templateItem.cameraEnabled === false && templateItem.galleryEnabled === false);
    
    // If photo is required and no photo yet, expand item and trigger camera
    if (!currentCompleted && requiresPhoto && photos.length === 0) {
      // Expand the item
      const newExpanded = new Set(expandedItems);
      newExpanded.add(itemId);
      setExpandedItems(newExpanded);
      
      // Open the first available evidence method after expansion.
      setTimeout(() => {
        if (cameraEnabled) {
          fileInputRefs.current[itemId]?.click();
        } else if (templateItem.galleryEnabled ?? false) {
          libraryInputRefs.current[itemId]?.click();
        }
      }, 100);
      return;
    }

    const note = itemNotes[itemId] || "";
    const isCompleting = !currentCompleted;
    updateItemMutation.mutate({
      itemId,
      updates: {
        completed: isCompleting,
        note: note || undefined,
        completedAt: isCompleting ? new Date() : null,
        photoEvidenceUrls: photos.length > 0 ? photos : undefined,
      },
      checkAutoComplete: isCompleting, // Check for auto-complete when completing an item
    });
  };

  const toggleExpand = (itemId: string) => {
    const newExpanded = new Set(expandedItems);
    if (newExpanded.has(itemId)) {
      newExpanded.delete(itemId);
    } else {
      newExpanded.add(itemId);
    }
    setExpandedItems(newExpanded);
  };

  const saveNote = (itemId: string) => {
    const note = itemNotes[itemId];
    updateItemMutation.mutate({
      itemId,
      updates: { note },
    });
    toast({ title: "Note saved" });
  };

  const setResultStatus = (itemId: string, status: 'pass' | 'fail', currentStatus?: string) => {
    if (run?.status === "completed") return;
    
    // If clicking the same status, reset it
    if (status === currentStatus) {
      updateItemMutation.mutate({
        itemId,
        updates: { resultStatus: null, completed: false },
      });
      return;
    }
    
    // If pass, mark as completed
    if (status === 'pass') {
      updateItemMutation.mutate({
        itemId,
        updates: { 
          resultStatus: 'pass', 
          completed: true,
          completedAt: new Date(),
        },
        checkAutoComplete: true, // Check for auto-complete when setting pass
      });
    } else {
      // For fail, expand the item and auto-trigger camera
      const newExpanded = new Set(expandedItems);
      newExpanded.add(itemId);
      setExpandedItems(newExpanded);
      
      updateItemMutation.mutate({
        itemId,
        updates: { 
          resultStatus: 'fail', 
          completed: true,
          completedAt: new Date(),
        },
        checkAutoComplete: false, // Don't auto-complete on fail - user needs to add note/photo first
      });
      
      // Auto-trigger camera - input is outside isExpanded so it's always available
      const fileInput = failPhotoInputRefs.current[itemId];
      if (fileInput) {
        fileInput.click();
      }
    }
  };

  const saveFailNote = (itemId: string) => {
    const note = failNotes[itemId];
    const photoUrl = failPhotos[itemId];
    updateItemMutation.mutate({
      itemId,
      updates: { 
        failNote: note || undefined,
        failPhotoUrl: photoUrl || undefined,
      },
    }, {
      onSuccess: () => {
        // Close this item
        const newExpanded = new Set(expandedItems);
        newExpanded.delete(itemId);
        setExpandedItems(newExpanded);
        
        toast({ title: "Issue details saved" });
        
        // Find and scroll to next uncompleted item
        if (run) {
          const sortedItems = [...run.items].sort((a, b) => a.templateItem.sortOrder - b.templateItem.sortOrder);
          const currentIndex = sortedItems.findIndex(item => item.id === itemId);
          const nextItem = sortedItems.slice(currentIndex + 1).find(item => !(item as any).resultStatus);
          
          if (nextItem) {
            // Scroll to next item after a brief delay to allow UI to update
            setTimeout(() => {
              const nextCard = document.querySelector(`[data-testid="card-item-${nextItem.id}"]`);
              if (nextCard) {
                nextCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            }, 100);
          }
        }
      },
    });
  };

  const handleFailPhotoCapture = async (itemId: string, file: File) => {
    setUploadingFailPhoto(itemId);
    try {
      const formData = new FormData();
      formData.append("photo", file);
      
      const response = await fetch("/api/checker-photos/upload", {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      
      if (!response.ok) throw new Error("Failed to upload photo");
      const { url } = await response.json();
      
      setFailPhotos(prev => ({
        ...prev,
        [itemId]: url,
      }));
      
      // Auto-save the fail photo
      updateItemMutation.mutate({
        itemId,
        updates: { failPhotoUrl: url },
      });
      
      toast({ title: "Issue photo uploaded" });
    } catch (error) {
      toast({
        title: "Failed to upload photo",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setUploadingFailPhoto(null);
    }
  };

  const handlePhotoCapture = async (itemId: string, files: File[]) => {
    if (files.length === 0) return;
    setUploadingPhoto(itemId);
    try {
      const uploadedUrls = await Promise.all(files.map(async (file) => {
        const formData = new FormData();
        formData.append("photo", file);
        const response = await fetch("/api/checklist-evidence/upload", {
          method: "POST",
          credentials: "include",
          body: formData,
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.message || "Failed to upload photo");
        }
        const { url } = await response.json();
        return url as string;
      }));
      const currentPhotos = itemPhotosRef.current[itemId] || [];
      const nextPhotos = [...currentPhotos, ...uploadedUrls];
      itemPhotosRef.current = { ...itemPhotosRef.current, [itemId]: nextPhotos };
      setItemPhotos((previous) => ({ ...previous, [itemId]: nextPhotos }));
      const save = (photoSaveQueues.current[itemId] || Promise.resolve())
        .catch(() => undefined)
        .then(() => updateItemMutation.mutateAsync({ itemId, updates: { photoEvidenceUrls: nextPhotos } }));
      photoSaveQueues.current[itemId] = save;
      await save;
      toast({ title: uploadedUrls.length === 1 ? "Photo added" : `${uploadedUrls.length} photos added` });
    } catch (error) {
      toast({
        title: "Upload failed",
        description: error instanceof Error ? error.message : "Could not upload photo",
        variant: "destructive",
      });
    } finally {
      setUploadingPhoto(null);
    }
  };

  const removePhoto = async (itemId: string, photoIndex: number) => {
    const currentPhotos = itemPhotosRef.current[itemId] || [];
    const newPhotos = currentPhotos.filter((_, i) => i !== photoIndex);
    itemPhotosRef.current = { ...itemPhotosRef.current, [itemId]: newPhotos };
    setItemPhotos((previous) => ({ ...previous, [itemId]: newPhotos }));
    const save = (photoSaveQueues.current[itemId] || Promise.resolve())
      .catch(() => undefined)
      .then(() => updateItemMutation.mutateAsync({ itemId, updates: { photoEvidenceUrls: newPhotos } }));
    photoSaveQueues.current[itemId] = save;
    await save;
  };

  const triggerFileInput = (itemId: string) => {
    const input = fileInputRefs.current[itemId];
    if (input) {
      input.click();
    }
  };

  const triggerLibraryInput = (itemId: string) => {
    libraryInputRefs.current[itemId]?.click();
  };

  if (isError) {
    return (
      <AppLayout hideNav>
        <div className="flex flex-col items-center justify-center min-h-[50vh] p-4 text-center">
          <AlertTriangle className="h-10 w-10 text-destructive mb-4" />
          <h2 className="text-lg font-semibold mb-2">Failed to load checklist</h2>
          <p className="text-sm text-muted-foreground mb-4">
            {error instanceof Error ? error.message : "Something went wrong. Please try again."}
          </p>
          {embedded ? (
            <Button variant="outline" onClick={() => window.parent.postMessage({ type: "checklist-detail-close" }, window.location.origin)} data-testid="button-close-checklist-detail">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Close details
            </Button>
          ) : (
            <Link href="/core/today">
              <Button variant="outline" data-testid="button-back-to-today">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Today
              </Button>
            </Link>
          )}
        </div>
      </AppLayout>
    );
  }

  if (isLoading || !run) {
    return (
      <AppLayout hideNav>
        <LoadingScreen />
      </AppLayout>
    );
  }

  const completedCount = run.items.filter((item) => item.completed).length;
  const totalCount = run.items.length;
  const progress = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;
  const allCompleted = completedCount === totalCount;
  const isCompleted = run.status === "completed" || run.status === "missed";
  const formatCompletionTime = (value: Date | string | null | undefined) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
  };
  const runCompletedAt = formatCompletionTime(run.completedAt);

  const canComplete = allCompleted && run.items.every((item) => {
    const requiresPhoto = item.templateItem.linkedToFix !== true
      && item.templateItem.requiresPhoto === true;
    if (!requiresPhoto) return true;
    const photos = itemPhotos[item.id] || [];
    return photos.length > 0;
  });

  return (
    <AppLayout hideNav>
      <div className="min-h-screen flex flex-col">
        <div className="sticky top-0 z-40 bg-background/95 backdrop-blur-md border-b border-border p-4" style={{ paddingTop: "calc(env(safe-area-inset-top) + 1rem)" }}>
          <div className="flex items-center gap-3 max-w-lg mx-auto">
            {embedded ? (
              <Button size="icon" variant="ghost" onClick={() => window.parent.postMessage({ type: "checklist-detail-close" }, window.location.origin)} data-testid="button-close">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            ) : (
              <Link href="/core/today">
                <Button size="icon" variant="ghost" data-testid="button-back">
                  <ArrowLeft className="h-5 w-5" />
                </Button>
              </Link>
            )}
            <div className="flex-1 min-w-0">
              <h1 className="text-lg font-semibold truncate">{run.template.name}</h1>
              <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
                <span>{completedCount}/{totalCount} items</span>
                {run.status !== "completed" && completedCount < totalCount && (
                  <span className="text-xs text-muted-foreground/70">• Tap each number to complete</span>
                )}
                <StatusBadge status={run.status} />
                {run.template?.templateVersion && run.templateVersionApplied && 
                  run.template.templateVersion > run.templateVersionApplied && (
                  <Badge variant="outline" className="text-xs text-orange-600 border-orange-300">
                    Updated
                  </Badge>
                )}
                {run.template.locationName && (
                  <Badge variant="outline" className="text-xs">
                    <MapPin className="h-3 w-3 mr-1" />
                    {run.template.locationName}
                  </Badge>
                )}
                {run.status === "completed" && runCompletedAt && (
                  <span
                    className="w-full text-xs text-muted-foreground"
                    data-testid="checklist-completion-audit"
                  >
                    Completed{run.completedByName ? ` by ${run.completedByName}` : ""} on {runCompletedAt}
                  </span>
                )}
                {headerAttachments.length > 0 && (
                  <MediaCount 
                    attachments={headerAttachments} 
                    onClick={() => openMediaViewer(headerAttachments, 0)}
                  />
                )}
              </div>
            </div>
          </div>
          <div className="max-w-lg mx-auto mt-3">
            <Progress value={progress} className="h-2" />
          </div>
        </div>

        {run.template.referenceMediaUrls && run.template.referenceMediaUrls.length > 0 && (
          <div className="p-4 max-w-lg mx-auto w-full">
            <Card className="bg-muted/30">
              <CardContent className="p-3">
                <h4 className="text-sm font-medium mb-2 flex items-center gap-1">
                  <ImageIcon className="h-4 w-4" />
                  Reference Images
                </h4>
                <div className="flex gap-2 overflow-x-auto pb-2">
                  {run.template.referenceMediaUrls.map((url, index) => (
                    <a 
                      key={index}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0"
                    >
                      <img 
                        src={url} 
                        alt={`Reference ${index + 1}`}
                        className="h-20 w-20 object-cover rounded-md border hover:opacity-80 transition-opacity"
                      />
                    </a>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        <div className="flex-1 p-4 pb-24 max-w-lg mx-auto w-full">
          <div className="space-y-3">
            {run.items
              .sort((a, b) => a.templateItem.sortOrder - b.templateItem.sortOrder)
              .map((item, itemIndex) => {
                const isExpanded = true;
                const hasNote = item.note || itemNotes[item.id];
                const photos = itemPhotos[item.id] || [];
                const requiresPhoto = item.templateItem.linkedToFix !== true
                  && item.templateItem.requiresPhoto === true;
                const cameraEnabled = (item.templateItem.cameraEnabled ?? true)
                  || (requiresPhoto && item.templateItem.cameraEnabled === false && item.templateItem.galleryEnabled === false);
                const galleryEnabled = item.templateItem.galleryEnabled ?? false;
                const itemRefMedia = item.templateItem.referenceMediaUrls as string[] || [];
                const itemAttachments = itemAttachmentsByItem[item.templateItem.id] || [];

                const isChecker = (run.template as any).checklistType === "checker";
                const resultStatus = (item as any).resultStatus;
                const linkedReports = item.linkedFixReports || [];
                const isReturnedSource = returnedSourceItemId === item.id;

                return (
                  <Card 
                    key={item.id} 
                    className={cn(
                      "overflow-visible transition-all",
                      item.completed && "bg-muted/50",
                      item.templateItem.isCritical && !item.completed && "border-destructive/50",
                      resultStatus === "fail" && "border-destructive/80 bg-destructive/5",
                      isReturnedSource && "ring-2 ring-primary border-primary"
                    )}
                    data-testid={`card-item-${item.id}`}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        {isChecker ? (
                          <Button
                            size="lg"
                            variant={resultStatus === "pass" ? "default" : "ghost"}
                            onClick={() => !isCompleted && setResultStatus(item.id, 'pass', resultStatus)}
                            disabled={isCompleted}
                            className={cn(
                              "rounded-full shrink-0 w-12 h-12",
                              resultStatus === "pass" ? "bg-green-500" : "text-green-600 border-2 border-green-500"
                            )}
                            data-testid={`button-pass-${item.id}`}
                          >
                            <CheckCircle2 className="h-6 w-6" />
                          </Button>
                        ) : (
                          <button
                            onClick={() => !isCompleted && toggleItem(item.id, item.templateItem, item.completed)}
                            disabled={isCompleted}
                            title={item.completed ? "Mark as incomplete" : "Tap to complete"}
                            className={cn(
                              "shrink-0 w-10 h-10 rounded-full flex items-center justify-center font-semibold text-lg transition-all",
                              item.completed 
                                ? "bg-primary text-primary-foreground" 
                                : "bg-muted text-muted-foreground hover:bg-primary/20 hover:text-primary hover:ring-2 hover:ring-primary/30",
                              isCompleted && "cursor-not-allowed opacity-50"
                            )}
                            data-testid={`button-item-${item.id}`}
                          >
                            {item.completed ? (
                              <Check className="h-5 w-5" />
                            ) : (
                              itemIndex + 1
                            )}
                          </button>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <p className={cn(
                                "font-medium",
                                item.completed && "line-through text-muted-foreground"
                              )}>
                                {item.templateItem.title}
                              </p>
                              {item.templateItem.description && (
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  {item.templateItem.description}
                                </p>
                              )}
                              {item.completed && item.completedAt && (
                                <p
                                  className="text-xs text-muted-foreground mt-1"
                                  data-testid={`item-completion-audit-${item.id}`}
                                >
                                  Completed{item.completedByName ? ` by ${item.completedByName}` : ""} on {formatCompletionTime(item.completedAt)}
                                </p>
                              )}
                              <div className="flex items-center gap-2 mt-1 flex-wrap">
                                {item.templateItem.isCritical && (
                                  <span className="inline-flex items-center gap-1 text-xs text-destructive">
                                    <AlertTriangle className="h-3 w-3" />
                                    Critical
                                  </span>
                                )}
                                {requiresPhoto && (
                                  <span className={cn(
                                    "inline-flex items-center gap-1 text-xs",
                                    photos.length > 0 ? "text-green-600" : "text-amber-600"
                                  )}>
                                    <Camera className="h-3 w-3" />
                                    {photos.length > 0 ? `${photos.length} photo${photos.length > 1 ? 's' : ''}` : 'Photo required'}
                                  </span>
                                )}
                                {itemAttachments.length > 0 && (
                                  <MediaCount 
                                    attachments={itemAttachments} 
                                    onClick={() => openMediaViewer(itemAttachments, 0)}
                                  />
                                )}
                              </div>

                              {!isChecker && item.templateItem.linkedToFix && (
                                <div className="space-y-2 rounded-md border border-primary/20 bg-primary/5 p-3">
                                  {!isCompleted && (
                                    <Button
                                      className="w-full"
                                      onClick={() => setLocation(
                                        `/core/fix?report=1&checklistSource=${encodeURIComponent(item.id)}${embedded ? "&returnEmbedded=1" : ""}`
                                      )}
                                      data-testid={`button-report-fix-${item.id}`}
                                    >
                                      <Wrench className="mr-2 h-4 w-4" />
                                      Report an Issue
                                    </Button>
                                  )}
                                  {linkedReports.length > 0 && (
                                    <div className="space-y-1.5" data-testid={`fix-report-history-${item.id}`}>
                                      <p className="text-xs font-medium text-muted-foreground">
                                        {linkedReports.length} linked Fix report{linkedReports.length === 1 ? "" : "s"}
                                      </p>
                                      {linkedReports.map((report) => (
                                        <button
                                          key={report.id}
                                          type="button"
                                          onClick={() => setLocation(
                                            `/core/fix?report=1&openReport=${encodeURIComponent(report.id)}&returnRun=${encodeURIComponent(run.id)}&sourceItem=${encodeURIComponent(item.id)}${embedded ? "&returnEmbedded=1" : ""}`
                                          )}
                                          className="w-full flex items-center justify-between gap-2 rounded border bg-background px-2.5 py-2 text-left hover:bg-muted"
                                          data-testid={`button-linked-fix-report-${report.id}`}
                                        >
                                          <span className="truncate text-sm">{report.title}</span>
                                          <Badge variant="outline" className="shrink-0 capitalize">
                                            {report.status.replace("_", " ")}
                                          </Badge>
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                            <div className="flex items-center gap-1">
                              {!isChecker && (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => toggleExpand(item.id)}
                                  className="shrink-0"
                                  data-testid={`button-expand-${item.id}`}
                                >
                                  {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                                </Button>
                              )}
                              {isChecker && !isCompleted && (
                                <Button
                                  size="lg"
                                  variant={resultStatus === "fail" ? "destructive" : "ghost"}
                                  onClick={() => setResultStatus(item.id, 'fail', resultStatus)}
                                  className={cn(
                                    "rounded-full shrink-0 w-12 h-12",
                                    resultStatus !== "fail" && "text-destructive border-2 border-destructive"
                                  )}
                                  data-testid={`button-fail-${item.id}`}
                                >
                                  <XCircle className="h-6 w-6" />
                                </Button>
                              )}
                            </div>
                          </div>

                          {isExpanded && (
                            <div className="mt-3 space-y-4">
                              {item.templateItem.description && (
                                <p className="text-sm text-muted-foreground">{item.templateItem.description}</p>
                              )}

                              {isChecker && resultStatus === "fail" && (
                                <div className="space-y-3 p-3 border border-destructive/30 rounded-md bg-destructive/5">
                                  <label className="text-sm font-medium text-destructive flex items-center gap-1">
                                    <AlertTriangle className="h-3.5 w-3.5" />
                                    Document the Issue
                                  </label>
                                  
                                  <Textarea
                                    placeholder="Describe what's wrong..."
                                    value={failNotes[item.id] ?? (item as any).failNote ?? ""}
                                    onChange={(e) => setFailNotes(prev => ({ ...prev, [item.id]: e.target.value }))}
                                    rows={2}
                                    disabled={isCompleted}
                                    data-testid={`input-fail-note-${item.id}`}
                                  />
                                  
                                  <div className="flex flex-wrap gap-2 items-center">
                                    {((item as any).failPhotoUrl || failPhotos[item.id]) && (
                                      <a 
                                        href={(item as any).failPhotoUrl || failPhotos[item.id]} 
                                        target="_blank" 
                                        rel="noopener noreferrer"
                                      >
                                        <img 
                                          src={(item as any).failPhotoUrl || failPhotos[item.id]} 
                                          alt="Issue photo"
                                          className="h-16 w-16 object-cover rounded-md border"
                                        />
                                      </a>
                                    )}
                                    
                                    {!isCompleted && (
                                      <div className="flex flex-wrap gap-2">
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          onClick={() => failPhotoInputRefs.current[item.id]?.click()}
                                          disabled={uploadingFailPhoto === item.id}
                                          data-testid={`button-add-fail-photo-${item.id}`}
                                        >
                                          {uploadingFailPhoto === item.id ? (
                                            <span className="animate-pulse">Uploading...</span>
                                          ) : (
                                            <>
                                              <Camera className="mr-1 h-3 w-3" />
                                              {((item as any).failPhotoUrl || failPhotos[item.id]) ? "Change Photo" : "Add Photo"}
                                            </>
                                          )}
                                        </Button>
                                        <Button
                                          size="sm"
                                          onClick={() => saveFailNote(item.id)}
                                          disabled={updateItemMutation.isPending}
                                          data-testid={`button-save-fail-note-${item.id}`}
                                        >
                                          <Save className="mr-1 h-3 w-3" />
                                          Save
                                        </Button>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}

                              {itemRefMedia.length > 0 && (
                                <div className="space-y-2">
                                  <label className="text-sm font-medium flex items-center gap-1">
                                    <ImageIcon className="h-3.5 w-3.5" />
                                    Reference Images
                                  </label>
                                  <div className="flex gap-2 overflow-x-auto pb-1">
                                    {itemRefMedia.map((url, index) => (
                                      <a 
                                        key={index}
                                        href={url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="shrink-0"
                                      >
                                        <img 
                                          src={url} 
                                          alt={`Reference ${index + 1}`}
                                          className="h-16 w-16 object-cover rounded-md border hover:opacity-80 transition-opacity"
                                        />
                                      </a>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {/* Linked-to-Fix items collect required evidence in the Fix report flow instead. */}
                              {!item.templateItem.linkedToFix && <div className="space-y-2">
                                <label className="text-sm font-medium flex items-center gap-1">
                                  <Camera className="h-3.5 w-3.5" />
                                  Photo {requiresPhoto ? <span className="text-destructive">*</span> : <span className="text-muted-foreground text-xs">(optional)</span>}
                                </label>
                                  
                                  {photos.length > 0 && (
                                    <div className="flex gap-2 flex-wrap">
                                      {photos.map((photoUrl, index) => (
                                        <div key={index} className="relative group">
                                          <a href={photoUrl} target="_blank" rel="noopener noreferrer">
                                            <img 
                                              src={photoUrl} 
                                              alt={`Evidence ${index + 1}`}
                                              className="h-16 w-16 object-cover rounded-md border"
                                            />
                                          </a>
                                          {!isCompleted && (
                                            <button
                                              onClick={() => removePhoto(item.id, index)}
                                              className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-destructive text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                                              data-testid={`button-remove-photo-${item.id}-${index}`}
                                            >
                                              <X className="h-3 w-3" />
                                            </button>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                  
                                  {!isCompleted && (
                                    <div className="flex gap-2">
                                      {cameraEnabled && <input
                                        type="file"
                                        accept="image/*"
                                        capture="environment"
                                        className="hidden"
                                        ref={(el) => { fileInputRefs.current[item.id] = el; }}
                                        onChange={(e) => {
                                          const files = Array.from(e.target.files || []);
                                          if (files.length > 0) {
                                            void handlePhotoCapture(item.id, files);
                                            e.target.value = '';
                                          }
                                        }}
                                        data-testid={`input-photo-${item.id}`}
                                      />}
                                      {galleryEnabled && <input
                                        type="file"
                                        accept="image/*"
                                        multiple
                                        className="hidden"
                                        ref={(el) => { libraryInputRefs.current[item.id] = el; }}
                                        onChange={(e) => {
                                          const files = Array.from(e.target.files || []);
                                          if (files.length > 0) {
                                            void handlePhotoCapture(item.id, files);
                                            e.target.value = "";
                                          }
                                        }}
                                        data-testid={`input-photo-library-${item.id}`}
                                      />}
                                      {cameraEnabled && <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => triggerFileInput(item.id)}
                                        disabled={uploadingPhoto === item.id}
                                        data-testid={`button-add-photo-${item.id}`}
                                      >
                                        {uploadingPhoto === item.id ? (
                                          <span className="animate-pulse">Uploading...</span>
                                        ) : (
                                          <>
                                            <Camera className="mr-1 h-3 w-3" />
                                            Camera
                                          </>
                                        )}
                                      </Button>}
                                      {galleryEnabled && <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => triggerLibraryInput(item.id)}
                                        disabled={uploadingPhoto === item.id}
                                        data-testid={`button-add-photo-library-${item.id}`}
                                      >
                                        <ImageIcon className="mr-1 h-3 w-3" />
                                        Photo Library
                                      </Button>}
                                    </div>
                                  )}
                                </div>}
                              
                              {!isChecker && (
                                <div className="space-y-2">
                                  <label className="text-sm font-medium flex items-center gap-1">
                                    <MessageSquare className="h-3.5 w-3.5" />
                                    Notes {item.templateItem.requiresNote && <span className="text-destructive">*</span>}
                                  </label>
                                  <Textarea
                                    placeholder="Add notes..."
                                    value={itemNotes[item.id] ?? item.note ?? ""}
                                    onChange={(e) => setItemNotes({ ...itemNotes, [item.id]: e.target.value })}
                                    disabled={isCompleted}
                                    className="text-sm"
                                    data-testid={`textarea-note-${item.id}`}
                                  />
                                  {!isCompleted && (
                                    <Button 
                                      size="sm" 
                                      variant="secondary"
                                      onClick={() => saveNote(item.id)}
                                      disabled={updateItemMutation.isPending}
                                      data-testid={`button-save-note-${item.id}`}
                                    >
                                      <Save className="mr-1 h-3 w-3" />
                                      Save Note
                                    </Button>
                                  )}
                                </div>
                              )}
                            </div>
                          )}

                          {!isChecker && !isExpanded && hasNote && (
                            <p className="text-xs text-muted-foreground mt-1 truncate">
                              Note: {item.note || itemNotes[item.id]}
                            </p>
                          )}
                          
                          {/* Media icon is already shown via MediaCount component in the header row */}
                          
                          {/* Hidden file input for fail photo - must be outside isExpanded for auto-camera to work */}
                          {isChecker && !isCompleted && (
                            <input
                              type="file"
                              accept="image/*"
                              capture="environment"
                              className="hidden"
                              ref={(el) => { failPhotoInputRefs.current[item.id] = el; }}
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) {
                                  handleFailPhotoCapture(item.id, file);
                                  e.target.value = '';
                                }
                              }}
                              data-testid={`input-fail-photo-${item.id}`}
                            />
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
          </div>
        </div>

        {!isCompleted && (
          <div 
            className="fixed bottom-0 left-0 right-0 p-4 bg-background/95 backdrop-blur-md border-t border-border"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
          >
            <div className="max-w-lg mx-auto">
              <Button
                className="w-full h-12 text-base font-semibold"
                disabled={!canComplete || completeRunMutation.isPending}
                onClick={() => completeRunMutation.mutate()}
                data-testid="button-complete-checklist"
              >
                <CheckCircle className="mr-2 h-5 w-5" />
                Complete Checklist
              </Button>
            </div>
          </div>
        )}
      </div>

      <MediaViewerModal
        attachments={mediaViewerAttachments}
        startIndex={mediaViewerStartIndex}
        open={mediaViewerOpen}
        onOpenChange={setMediaViewerOpen}
      />
    </AppLayout>
  );
}
