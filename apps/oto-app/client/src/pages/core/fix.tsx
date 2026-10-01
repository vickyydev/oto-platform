import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation, useSearch, Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { FixActivityFeed, rawCommentToActivityEntry } from "@/components/fix-activity-feed";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useBranchContext } from "@/hooks/use-branch-context";
import { useAuth } from "@/lib/auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { getMediaThumbUrl, isVideoUrl } from "@/lib/media";
import type { Location } from "@shared/schema";
import { 
  Camera, 
  X, 
  Plus, 
  Send, 
  CheckCircle2,
  MapPin,
  AlertTriangle,
  Wrench,
  Sparkles,
  Zap,
  Lightbulb,
  Armchair,
  Settings,
  Video,
  Building2,
  Inbox,
  ChevronRight,
  Clock,
  ArrowLeft,
  Users,
  PlayCircle,
  Image,
} from "lucide-react";
import { formatDistanceToNow, parseISO } from "date-fns";

const QUICK_TAGS = [
  { id: "safety", label: "Safety", icon: AlertTriangle },
  { id: "maintenance", label: "Maintenance", icon: Wrench },
  { id: "cleaning", label: "Cleaning", icon: Sparkles },
  { id: "electrical", label: "Electrical", icon: Zap },
  { id: "furniture", label: "Furniture", icon: Armchair },
  { id: "equipment", label: "Equipment", icon: Settings },
  { id: "urgent", label: "Urgent", icon: AlertTriangle },
];

type Step = "capture" | "details" | "success";

interface FixReport {
  id: string;
  title: string;
  status: string;
  media: string[];
  createdAt: string;
  note?: string | null;
  tags?: string[];
  assignedDepartmentId?: string | null;
}

interface FixComment {
  id: string;
  authorUserId?: string | null;
  authorType: string;
  message: string;
  createdAt: string;
  author?: { id: string; fullName?: string | null; email: string } | null;
}

interface ReportDetail {
  report: FixReport & { assignedDepartmentId?: string | null };
  comments: FixComment[];
  assignedDepartment?: { id: string; name: string } | null;
  departmentMembers?: { id: string; name: string; initials: string }[];
}

interface ChecklistFixContext {
  sourceChecklistRunItemId: string;
  runId: string;
  branch: { id: string; name: string };
  checklistName: string;
  itemTitle: string;
  location: { id: string; name: string } | null;
  sourceDepartment: { id: string; name: string } | null;
  reports: FixReport[];
}

function StatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { label: string; className: string }> = {
    new: { label: "Pending", className: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" },
    pending: { label: "Pending", className: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" },
    in_progress: { label: "In Progress", className: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300" },
    acknowledged: { label: "Acknowledged", className: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300" },
    scheduled: { label: "Scheduled", className: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300" },
    done: { label: "Done", className: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300" },
    fixed: { label: "Fixed", className: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300" },
    closed: { label: "Closed", className: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" },
  };
  const { label, className } = cfg[status] || { label: status, className: "bg-gray-100 text-gray-600" };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${className}`}>{label}</span>;
}

interface ReportDetailSheetProps {
  reportId: string | null;
  open: boolean;
  onClose: () => void;
}

function ReportDetailSheet({ reportId, open, onClose }: ReportDetailSheetProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [comment, setComment] = useState("");

  const { data: detail, isLoading } = useQuery<ReportDetail>({
    queryKey: ['/api/fix-reports', reportId, 'details'],
    queryFn: async () => {
      const res = await fetch(`/api/fix-reports/${reportId}/details`, { credentials: 'include' });
      if (!res.ok) throw new Error("Failed to load report details");
      return res.json();
    },
    enabled: !!reportId && open,
  });

  const addCommentMutation = useMutation({
    mutationFn: async (message: string) => {
      const res = await apiRequest("POST", `/api/fix-reports/${reportId}/comments`, { message });
      if (!res.ok) throw new Error("Failed to add comment");
      return res.json();
    },
    onSuccess: () => {
      setComment("");
      queryClient.invalidateQueries({ queryKey: ['/api/fix-reports', reportId, 'details'] });
      queryClient.invalidateQueries({ queryKey: ['/api/fix-reports'] });
      toast({ title: "Update added" });
    },
    onError: () => {
      toast({ title: "Failed to add update", variant: "destructive" });
    },
  });

  const report = detail?.report;
  const comments = detail?.comments || [];
  const assignedDepartment = detail?.assignedDepartment;
  const departmentMembers = detail?.departmentMembers || [];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col p-0 gap-0" data-testid="dialog-fix-report-staff-detail">
        <div className="flex items-center gap-3 p-4 border-b">
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-muted">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold truncate" data-testid="text-detail-title">
              {report?.title || "Fix Report"}
            </h2>
            {report && <StatusBadge status={report.status} />}
          </div>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12">
            <LoadingSpinner />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {/* Media thumbnails */}
            {report?.media && report.media.length > 0 && (
              <div className="p-4 border-b">
                <div className={`grid gap-2 ${report.media.length === 1 ? '' : 'grid-cols-3'}`}>
                  {report.media.map((url, idx) => (
                    <div key={idx} className={`relative rounded-lg overflow-hidden bg-muted ${report.media.length === 1 ? 'aspect-video' : 'aspect-square'}`}>
                      <img src={getMediaThumbUrl(url)} alt={`Photo ${idx + 1}`} loading="lazy" className="w-full h-full object-cover" />
                      {isVideoUrl(url) && (
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                          <PlayCircle className="w-8 h-8 text-white drop-shadow" />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Assigned department + members */}
            {assignedDepartment && (
              <div className="px-4 py-3 border-b">
                <div className="flex items-center gap-2 mb-2">
                  <Users className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Assigned to {assignedDepartment.name}</span>
                </div>
                {departmentMembers.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {departmentMembers.map(m => (
                      <div key={m.id} className="flex items-center gap-1.5 bg-muted rounded-full px-2 py-0.5">
                        <Avatar className="w-5 h-5">
                          <AvatarFallback className="text-[10px]">{m.initials}</AvatarFallback>
                        </Avatar>
                        <span className="text-xs">{m.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Note */}
            {report?.note && (
              <div className="px-4 py-3 border-b">
                <p className="text-sm text-foreground/80">{report.note}</p>
              </div>
            )}

            {/* Activity feed */}
            <div className="px-4 py-3">
              <FixActivityFeed
                entries={comments.map(c => rawCommentToActivityEntry({
                  id: c.id,
                  message: c.message,
                  createdAt: c.createdAt,
                  authorUserId: c.authorUserId,
                  author: c.author,
                  authorType: c.authorType,
                }))}
                createdAt={report?.createdAt}
                currentUserId={user?.id}
              />
            </div>
          </div>
        )}

        {/* Comment input */}
        <div className="p-3 border-t bg-background">
          <div className="flex items-center gap-2">
            <Input
              placeholder="Add an update..."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              className="flex-1"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && comment.trim()) {
                  addCommentMutation.mutate(comment.trim());
                }
              }}
              data-testid="input-staff-comment"
            />
            <Button
              size="icon"
              onClick={() => comment.trim() && addCommentMutation.mutate(comment.trim())}
              disabled={!comment.trim() || addCommentMutation.isPending}
              data-testid="button-send-staff-comment"
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function FixPage() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const searchParams = new URLSearchParams(search);
  const wantsToReport = searchParams.get("report") === "1";
  const checklistSourceId = searchParams.get("checklistSource");
  const openReportId = searchParams.get("openReport");
  const returnRunId = searchParams.get("returnRun");
  const returnSourceItemId = searchParams.get("sourceItem");
  const returnEmbedded = searchParams.get("returnEmbedded") === "1";
  const { toast } = useToast();
  const { user } = useAuth();
  const { activeBranchId, branches, setActiveBranchId, isLoading: branchLoading } = useBranchContext();
  const isManagerOrAdmin = user?.role && ['admin', 'global_admin', 'operator_admin', 'manager'].includes(user.role);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  
  const [step, setStep] = useState<Step>("capture");
  const [mediaFiles, setMediaFiles] = useState<File[]>([]);
  const [mediaPreviews, setMediaPreviews] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [locationId, setLocationId] = useState<string>("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [priority, setPriority] = useState<string>("normal");
  const [isUploading, setIsUploading] = useState(false);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(openReportId);

  const { data: checklistContext, isLoading: checklistContextLoading, error: checklistContextError } = useQuery<ChecklistFixContext>({
    queryKey: ["/api/fix-reports/checklist-source", checklistSourceId],
    queryFn: async () => {
      const res = await fetch(`/api/fix-reports/checklist-source/${checklistSourceId}`, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Unable to open this checklist item in Fix");
      }
      return res.json();
    },
    enabled: !!checklistSourceId,
  });

  useEffect(() => {
    if (!checklistContext) return;
    setActiveBranchId(checklistContext.branch.id);
    setTitle(checklistContext.itemTitle);
    setLocationId(checklistContext.location?.id || "");
  }, [checklistContext, setActiveBranchId]);

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations", activeBranchId],
    queryFn: async () => {
      if (!activeBranchId) return [];
      const res = await fetch(`/api/locations?branchId=${activeBranchId}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!activeBranchId,
  });

  // Check if this user is a Fix Dept member (grants access to Fix Board)
  const { data: queueInfo } = useQuery<{ isFixDeptMember: boolean; fixDeptId: string | null; userDeptIds: string[] }>({
    queryKey: ['/api/fix-reports/my-queue-info'],
    queryFn: async () => {
      const res = await fetch('/api/fix-reports/my-queue-info', { credentials: 'include' });
      if (!res.ok) return { isFixDeptMember: false, fixDeptId: null, userDeptIds: [] };
      return res.json();
    },
  });
  const isFixDeptMember = queueInfo?.isFixDeptMember ?? false;
  const canAccessFixBoard = !!(isManagerOrAdmin || isFixDeptMember);

  // Fix Dept members who are not managers/admins go directly to the Fix Board (task queue view)
  // by default, since that's their primary job. But if they explicitly navigated here to
  // report an issue themselves (via the "Report an Issue" button on the Fix Board, which adds
  // ?report=1), let them stay and use the normal capture flow like any other staff member.
  useEffect(() => {
    if (queueInfo && isFixDeptMember && !isManagerOrAdmin && !wantsToReport && !checklistSourceId) {
      setLocation("/core/fix-board");
    }
  }, [queueInfo, isFixDeptMember, isManagerOrAdmin, wantsToReport, checklistSourceId, setLocation]);

  // Staff's own submitted reports
  const { data: myReports = [] } = useQuery<FixReport[]>({
    queryKey: ["/api/fix-reports", "myReports"],
    queryFn: async () => {
      const res = await fetch("/api/fix-reports?myReports=true", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>, isVideo = false) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    const newFiles = [...mediaFiles, ...files];
    setMediaFiles(newFiles);

    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = (e) => {
        setMediaPreviews(prev => [...prev, e.target?.result as string]);
      };
      reader.readAsDataURL(file);
    });

    if (step === "capture") {
      setStep("details");
    }
  };

  const removeMedia = (index: number) => {
    setMediaFiles(prev => prev.filter((_, i) => i !== index));
    setMediaPreviews(prev => prev.filter((_, i) => i !== index));
    
    if (mediaFiles.length <= 1) {
      setStep("capture");
    }
  };

  const toggleTag = (tagId: string) => {
    setSelectedTags(prev => 
      prev.includes(tagId) 
        ? prev.filter(t => t !== tagId)
        : [...prev, tagId]
    );
  };

  const submitMutation = useMutation({
    mutationFn: async () => {
      setIsUploading(true);
      
      const formData = new FormData();
      mediaFiles.forEach(file => {
        formData.append("media", file);
      });

      const uploadRes = await fetch("/api/fix-reports/upload", {
        method: "POST",
        body: formData,
        credentials: "include",
      });

      if (!uploadRes.ok) {
        throw new Error("Failed to upload media");
      }

      const { urls } = await uploadRes.json();

      const res = await apiRequest("POST", "/api/fix-reports", {
        media: urls,
        title: title.trim(),
        note: note || null,
        locationId: locationId || null,
        tags: selectedTags,
        priority,
        branchId: activeBranchId,
        sourceChecklistRunItemId: checklistSourceId || undefined,
      });

      return res.json();
    },
    onSuccess: () => {
      setIsUploading(false);
      queryClient.invalidateQueries({ queryKey: ["/api/fix-reports"] });
      if (checklistContext) {
        queryClient.invalidateQueries({ queryKey: ["/api/checklist-runs", checklistContext.runId] });
        setLocation(
          `/core/checklist/${checklistContext.runId}?sourceItem=${encodeURIComponent(checklistContext.sourceChecklistRunItemId)}&reported=1${returnEmbedded ? "&embedded=1" : ""}`
        );
        return;
      }
      setStep("success");
    },
    onError: (error: Error) => {
      setIsUploading(false);
      toast({
        title: "Failed to submit",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleSubmit = () => {
    if (mediaFiles.length === 0) {
      toast({ title: "Please add at least one photo", variant: "destructive" });
      return;
    }
    if (!title.trim()) {
      toast({ title: "Please add a title", variant: "destructive" });
      return;
    }
    submitMutation.mutate();
  };

  if (checklistSourceId && checklistContextLoading) {
    return <div className="min-h-[70vh] flex items-center justify-center"><LoadingSpinner /></div>;
  }

  if (checklistSourceId && checklistContextError) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center p-6 text-center">
        <AlertTriangle className="h-10 w-10 text-destructive mb-4" />
        <h1 className="text-xl font-semibold mb-2">Unable to report from this item</h1>
        <p className="text-muted-foreground mb-4">
          {checklistContextError instanceof Error ? checklistContextError.message : "Access denied"}
        </p>
        <Button variant="outline" onClick={() => setLocation("/core/today")}>Back to Today</Button>
      </div>
    );
  }

  const resetForm = () => {
    setStep("capture");
    setMediaFiles([]);
    setMediaPreviews([]);
    setTitle("");
    setNote("");
    setLocationId("");
    setSelectedTags([]);
    setPriority("normal");
  };

  if (step === "success") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[70vh] p-6 text-center">
        <div className="h-20 w-20 rounded-full bg-green-500/10 flex items-center justify-center mb-6">
          <CheckCircle2 className="h-10 w-10 text-green-500" />
        </div>
        <h1 className="text-2xl font-bold mb-2" data-testid="text-success-title">Fix reported</h1>
        <p className="text-muted-foreground mb-6">Thank you for keeping things in order.</p>
        <p className="text-sm text-muted-foreground mb-8">You can add more photos later if needed.</p>
        <Button onClick={resetForm} size="lg" data-testid="button-report-another">
          Report another
        </Button>
      </div>
    );
  }

  // Show branch selector if no branch is selected
  if (!activeBranchId && !branchLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[70vh] p-6">
        <div className="h-24 w-24 rounded-full bg-primary/10 flex items-center justify-center mb-6">
          <Building2 className="h-12 w-12 text-primary" />
        </div>
        
        <h1 className="text-2xl font-bold mb-2" data-testid="text-select-branch-title">Select a branch</h1>
        <p className="text-muted-foreground mb-8 text-center max-w-xs">
          Choose which branch you're reporting from
        </p>

        <Select onValueChange={(value) => setActiveBranchId(value)}>
          <SelectTrigger className="w-64" data-testid="select-branch">
            <SelectValue placeholder="Select branch..." />
          </SelectTrigger>
          <SelectContent>
            {branches.map((branch) => (
              <SelectItem key={branch.id} value={branch.id} data-testid={`select-branch-${branch.id}`}>
                {branch.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (step === "capture") {
    return (
      <div className="flex flex-col items-center p-6 pb-24">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          onChange={(e) => handleFileSelect(e)}
          className="hidden"
          data-testid="input-camera"
        />
        <input
          ref={galleryInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => handleFileSelect(e)}
          className="hidden"
          data-testid="input-gallery"
        />
        <input
          ref={videoInputRef}
          type="file"
          accept="video/*"
          capture="environment"
          onChange={(e) => handleFileSelect(e, true)}
          className="hidden"
          data-testid="input-video"
        />

        <div className="h-24 w-24 rounded-full bg-primary/10 flex items-center justify-center mb-6">
          <Wrench className="h-12 w-12 text-primary" />
        </div>
        
        <h1 className="text-2xl font-bold mb-2" data-testid="text-fix-title">Fix something?</h1>
        <p className="text-muted-foreground mb-4 text-center">
          Take a photo of what needs fixing
        </p>
        {checklistContext && (
          <Card className="w-full max-w-sm mb-5 border-primary/30 bg-primary/5" data-testid="card-checklist-fix-context">
            <CardContent className="p-4 space-y-1">
              <p className="font-medium">{checklistContext.itemTitle}</p>
              <p className="text-sm text-muted-foreground">{checklistContext.checklistName}</p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Badge variant="outline">{checklistContext.branch.name}</Badge>
                {checklistContext.location && <Badge variant="outline">{checklistContext.location.name}</Badge>}
                {checklistContext.sourceDepartment && <Badge variant="outline">From {checklistContext.sourceDepartment.name}</Badge>}
              </div>
            </CardContent>
          </Card>
        )}
        
        {canAccessFixBoard && (
          <Link href="/core/fix-board">
            <Button variant="outline" className="mb-6" data-testid="button-view-inbox">
              <Inbox className="mr-2 h-4 w-4" />
              View Fix Inbox
            </Button>
          </Link>
        )}

        <div className="flex flex-col gap-3 w-full max-w-xs mb-8">
          <Button 
            size="lg" 
            onClick={() => fileInputRef.current?.click()}
            className="h-14 text-lg"
            data-testid="button-take-photo"
          >
            <Camera className="mr-2 h-5 w-5" />
            Take Photo
          </Button>
          <Button 
            size="lg" 
            variant="outline"
            onClick={() => galleryInputRef.current?.click()}
            className="h-14 text-lg"
            data-testid="button-choose-gallery"
          >
            <Image className="mr-2 h-5 w-5" />
            Choose from Gallery
          </Button>
          <Button 
            size="lg" 
            variant="outline"
            onClick={() => videoInputRef.current?.click()}
            className="h-14 text-lg"
            data-testid="button-take-video"
          >
            <Video className="mr-2 h-5 w-5" />
            Record Video
          </Button>
        </div>

        {/* My Reports section */}
        {myReports.length > 0 && (
          <div className="w-full max-w-sm">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3" data-testid="text-my-reports-title">
              My Reports
            </h2>
            <div className="space-y-2">
              {myReports.slice(0, 5).map((report) => (
                <Card
                  key={report.id}
                  className="hover-elevate cursor-pointer overflow-visible"
                  onClick={() => setSelectedReportId(report.id)}
                  data-testid={`card-my-report-${report.id}`}
                >
                  <CardContent className="p-3">
                    <div className="flex items-center gap-3">
                      {report.media?.[0] && (
                        <div className="relative w-12 h-12 rounded-md overflow-hidden shrink-0 bg-muted">
                          <img src={getMediaThumbUrl(report.media[0])} alt="" loading="lazy" className="w-full h-full object-cover" />
                          {isVideoUrl(report.media[0]) && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black/10">
                              <PlayCircle className="w-4 h-4 text-white drop-shadow" />
                            </div>
                          )}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{report.title}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <StatusBadge status={report.status} />
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {formatDistanceToNow(parseISO(report.createdAt), { addSuffix: true })}
                          </span>
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* Report detail sheet */}
        <ReportDetailSheet
          reportId={selectedReportId}
          open={!!selectedReportId}
          onClose={() => {
            setSelectedReportId(null);
            if (returnRunId) {
              setLocation(`/core/checklist/${returnRunId}?sourceItem=${encodeURIComponent(returnSourceItemId || "")}${returnEmbedded ? "&embedded=1" : ""}`);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className="p-4 max-w-lg mx-auto pb-24">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        onChange={(e) => handleFileSelect(e)}
        className="hidden"
      />
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={(e) => handleFileSelect(e)}
        className="hidden"
      />
      <input
        ref={videoInputRef}
        type="file"
        accept="video/*"
        capture="environment"
        onChange={(e) => handleFileSelect(e, true)}
        className="hidden"
      />

      <div className="grid grid-cols-3 gap-2 mb-6">
        {mediaPreviews.map((preview, index) => (
          <div key={index} className="relative aspect-square rounded-lg overflow-hidden bg-muted">
            {mediaFiles[index]?.type.startsWith("video") ? (
              <video src={preview} className="w-full h-full object-cover" />
            ) : (
              <img src={preview} alt="" className="w-full h-full object-contain" />
            )}
            <Button
              size="icon"
              variant="destructive"
              className="absolute top-1 right-1 h-6 w-6"
              onClick={() => removeMedia(index)}
              data-testid={`button-remove-media-${index}`}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        ))}
        
        {mediaPreviews.length < 10 && (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="aspect-square rounded-lg border-2 border-dashed border-muted-foreground/30 flex flex-col items-center justify-center gap-1 hover-elevate active-elevate-2 overflow-visible"
            data-testid="button-add-more-photos"
          >
            <Plus className="h-6 w-6 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Add</span>
          </button>
        )}
      </div>

      <Card className="mb-4">
        <CardContent className="p-4 space-y-4">
          {checklistContext && (
            <div className="rounded-md border border-primary/20 bg-primary/5 p-3" data-testid="details-checklist-fix-context">
              <p className="text-sm font-medium">{checklistContext.checklistName}</p>
              <p className="text-xs text-muted-foreground">
                {checklistContext.sourceDepartment ? `Source: ${checklistContext.sourceDepartment.name}` : "Checklist issue"}
                {checklistContext.location ? ` • ${checklistContext.location.name}` : ""}
              </p>
            </div>
          )}
          <div>
            <label className="text-sm font-medium mb-2 block">
              Title <span className="text-destructive">*</span>
            </label>
            <Input
              placeholder="What needs fixing?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              readOnly={!!checklistContext}
              data-testid="input-title"
            />
          </div>

          <div>
            <label className="text-sm font-medium mb-2 flex items-center gap-2">
              <MapPin className="h-4 w-4" />
              Location
            </label>
            {locations.length > 0 ? (
              <Select value={locationId} onValueChange={setLocationId}>
                <SelectTrigger data-testid="select-location">
                  <SelectValue placeholder="Select location (optional)" />
                </SelectTrigger>
                <SelectContent>
                  {locations.map((loc) => (
                    <SelectItem key={loc.id} value={loc.id} data-testid={`select-location-${loc.id}`}>
                      {loc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-sm text-muted-foreground">No locations configured for this branch</p>
            )}
          </div>

          <div>
            <label className="text-sm font-medium mb-2 block">Priority</label>
            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger data-testid="select-priority">
                <SelectValue placeholder="Select priority" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="urgent" data-testid="select-priority-urgent">Urgent</SelectItem>
                <SelectItem value="high" data-testid="select-priority-high">High</SelectItem>
                <SelectItem value="normal" data-testid="select-priority-normal">Normal</SelectItem>
                <SelectItem value="low" data-testid="select-priority-low">Low</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-sm font-medium mb-2 block">Additional notes</label>
            <Input
              placeholder="Optional details..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              data-testid="input-note"
            />
          </div>
        </CardContent>
      </Card>

      <div className="mb-6">
        <label className="text-sm text-muted-foreground mb-2 block">Quick tags (optional)</label>
        <div className="flex flex-wrap gap-2">
          {QUICK_TAGS.map((tag) => {
            const Icon = tag.icon;
            const isSelected = selectedTags.includes(tag.id);
            return (
              <Badge
                key={tag.id}
                variant={isSelected ? "default" : "outline"}
                className={`cursor-pointer py-1.5 px-3 ${isSelected ? "" : "hover-elevate"}`}
                onClick={() => toggleTag(tag.id)}
                data-testid={`tag-${tag.id}`}
              >
                <Icon className="h-3 w-3 mr-1" />
                {tag.label}
              </Badge>
            );
          })}
        </div>
      </div>

      <div className="fixed left-0 right-0 p-4 bg-background border-t" style={{ bottom: "calc(env(safe-area-inset-bottom) + 64px)" }}>
        <Button
          size="lg"
          className="w-full h-14 text-lg"
          onClick={handleSubmit}
          disabled={isUploading || submitMutation.isPending || !title.trim() || mediaFiles.length === 0}
          data-testid="button-submit-fix"
        >
          {isUploading || submitMutation.isPending ? (
            <>
              <LoadingSpinner className="mr-2" />
              Submitting...
            </>
          ) : (
            <>
              <Send className="mr-2 h-5 w-5" />
              Submit Fix Report
            </>
          )}
        </Button>
      </div>
      <div className="h-28" />
    </div>
  );
}
