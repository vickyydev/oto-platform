import { useState, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import { createPortal } from "react-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Calendar as CalendarPicker } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  Wrench, 
  Calendar,
  CheckCircle,
  Clock,
  MapPin,
  AlertTriangle,
  Filter,
  X,
  Send,
  Image,
  Camera,
  MessageSquare,
  ChevronRight,
  ChevronLeft,
  User,
  Building2,
  Paperclip,
  Eye,
  CalendarDays,
  ZoomIn,
  ZoomOut,
  Users,
  Plus,
  PlayCircle,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useBranchContext } from "@/hooks/use-branch-context";
import { format, parseISO, formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { FixActivityFeed, rawCommentToActivityEntry } from "@/components/fix-activity-feed";
import { getMediaThumbUrl, isVideoUrl } from "@/lib/media";

interface FixReport {
  id: string;
  tenantId: string;
  branchId: string;
  title?: string | null;
  description?: string | null;
  location?: string | null;
  locationId?: string | null;
  locationNote?: string | null;
  status: string;
  priority?: string | null;
  tags: string[];
  media: string[];
  note?: string | null;
  scheduledAt?: string | null;
  closedAt?: string | null;
  closedByUserId?: string | null;
  closedBySupplierTokenId?: string | null;
  doneNote?: string | null;
  createdAt: string;
  updatedAt: string;
  reportedById?: string | null;
  assignedDepartmentId?: string | null;
  reportedBy?: {
    id: string;
    fullName?: string | null;
    email: string;
  } | null;
  branch?: {
    id: string;
    name: string;
  } | null;
  locationDetails?: {
    id: string;
    name: string;
  } | null;
  assignedDepartment?: {
    id: string;
    name: string;
  } | null;
  departmentMembers?: {
    id: string;
    name: string;
    initials: string;
  }[];
  comments?: FixComment[];
}

interface FixComment {
  id: string;
  fixReportId: string;
  authorType: string;
  authorUserId?: string | null;
  authorSupplierTokenId?: string | null;
  message: string;
  createdAt: string;
  author?: {
    id: string;
    fullName?: string | null;
    email: string;
  } | null;
  supplierToken?: {
    id: string;
    name: string;
  } | null;
}

const STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "acknowledged", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "all", label: "All Status" },
];

const DETAIL_STATUS_OPTIONS = [
  { value: "pending", label: "Pending", icon: Clock, color: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800" },
  { value: "acknowledged", label: "In Progress", icon: Eye, color: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 border-blue-200 dark:border-blue-800" },
  { value: "completed", label: "Completed", icon: CheckCircle, color: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 border-green-200 dark:border-green-800" },
];

const PRIORITY_OPTIONS = [
  { value: "all", label: "All Priority" },
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "normal", label: "Normal" },
  { value: "low", label: "Low" },
];

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
    pending: { label: "Pending", variant: "secondary" },
    acknowledged: { label: "In Progress", variant: "default" },
    completed: { label: "Completed", variant: "outline" },
    new: { label: "Pending", variant: "secondary" },
    in_progress: { label: "In Progress", variant: "default" },
    done: { label: "Completed", variant: "outline" },
  };
  
  const { label, variant } = config[status] || { label: status, variant: "secondary" };
  return <Badge variant={variant} data-testid={`badge-status-${status}`}>{label}</Badge>;
}

function PriorityBadge({ priority }: { priority: string }) {
  const config: Record<string, { label: string; className: string }> = {
    urgent: { label: "Urgent", className: "bg-red-500 text-white" },
    high: { label: "High", className: "bg-orange-500 text-white" },
    normal: { label: "Normal", className: "bg-blue-500 text-white" },
    low: { label: "Low", className: "bg-gray-400 text-white" },
  };
  
  const { label, className } = config[priority] || { label: priority, className: "bg-gray-400 text-white" };
  return <Badge className={className} data-testid={`badge-priority-${priority}`}>{label}</Badge>;
}

interface ReportCardProps {
  report: FixReport;
  onClick: () => void;
}

function ReportCard({ report, onClick }: ReportCardProps) {
  const hasMedia = report.media && report.media.length > 0;
  
  return (
    <Card 
      className="hover-elevate active-elevate-2 overflow-visible cursor-pointer"
      onClick={onClick}
      data-testid={`card-fix-report-${report.id}`}
    >
      <CardContent className="p-4">
        <div className="flex gap-3">
          {hasMedia && (
            <div className="relative w-16 h-16 rounded-md overflow-hidden flex-shrink-0 bg-muted">
              <img 
                src={getMediaThumbUrl(report.media[0])} 
                alt="Fix report media" 
                loading="lazy"
                className="w-full h-full object-cover"
              />
              {isVideoUrl(report.media[0]) && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/10">
                  <PlayCircle className="w-5 h-5 text-white drop-shadow" />
                </div>
              )}
            </div>
          )}
          
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2 mb-1">
              <h3 className="font-medium text-sm truncate">
                {report.title || report.description?.slice(0, 50) || "Fix Report"}
              </h3>
              <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            </div>
            
            <div className="flex flex-wrap gap-1 mb-2">
              <StatusBadge status={report.status} />
              {report.priority && <PriorityBadge priority={report.priority} />}
            </div>
            
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {(report.locationDetails?.name || report.location || report.locationNote) && (
                <span className="flex items-center gap-1">
                  <MapPin className="w-3 h-3" />
                  {report.locationDetails?.name || report.location || report.locationNote}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {formatDistanceToNow(parseISO(report.createdAt), { addSuffix: true })}
              </span>
            </div>
            
            {report.branch && (
              <div className="mt-1 text-xs text-muted-foreground flex items-center gap-1">
                <Building2 className="w-3 h-3" />
                {report.branch.name}
              </div>
            )}

            {/* Assigned department + member avatars */}
            {(report.assignedDepartment || (report.departmentMembers && report.departmentMembers.length > 0)) && (
              <div className="mt-2 flex items-center gap-2">
                {report.assignedDepartment && (
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Users className="w-3 h-3" />
                    {report.assignedDepartment.name}
                  </span>
                )}
                {report.departmentMembers && report.departmentMembers.length > 0 && (
                  <div className="flex -space-x-1.5">
                    {report.departmentMembers.slice(0, 4).map(m => (
                      <Avatar key={m.id} className="w-5 h-5 border border-background">
                        <AvatarFallback className="text-[9px] bg-muted font-medium">{m.initials}</AvatarFallback>
                      </Avatar>
                    ))}
                    {report.departmentMembers.length > 4 && (
                      <div className="w-5 h-5 rounded-full bg-muted border border-background flex items-center justify-center text-[9px] text-muted-foreground font-medium">
                        +{report.departmentMembers.length - 4}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        
        {report.tags && report.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2 pt-2 border-t">
            {report.tags.map(tag => (
              <Badge key={tag} variant="outline" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface PhotoGalleryModalProps {
  media: string[];
  initialIndex: number;
  open: boolean;
  onClose: () => void;
}

function PhotoGalleryModal({ media, initialIndex, open, onClose }: PhotoGalleryModalProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);
  
  useEffect(() => {
    if (open) {
      setCurrentIndex(initialIndex);
      setZoom(1);
    }
  }, [open, initialIndex]);
  
  if (!open) return null;
  
  const currentMedia = media[currentIndex];
  const isVideo = isVideoUrl(currentMedia);
  
  const goNext = () => setCurrentIndex((prev) => (prev + 1) % media.length);
  const goPrev = () => setCurrentIndex((prev) => (prev - 1 + media.length) % media.length);
  
  const handleClose = () => {
    onClose();
  };
  
  return createPortal(
    <div 
      className="fixed inset-0 bg-black flex items-center justify-center"
      style={{ zIndex: 9999, pointerEvents: 'auto' }}
      onClick={handleClose}
      data-testid="modal-photo-gallery"
    >
      <div
        className="absolute top-4 right-4 z-50"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onTouchEnd={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="text-white bg-red-600 hover:bg-red-700 active:bg-red-800 rounded-full w-16 h-16 flex items-center justify-center touch-manipulation cursor-pointer select-none shadow-2xl"
          onClick={(e) => { e.stopPropagation(); e.preventDefault(); handleClose(); }}
          onTouchEnd={(e) => { e.stopPropagation(); e.preventDefault(); handleClose(); }}
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); handleClose(); }}
          data-testid="button-close-gallery"
          aria-label="Close gallery"
        >
          <X className="w-10 h-10" strokeWidth={3} />
        </button>
      </div>
      
      <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2">
        <button
          type="button"
          className="text-white hover:bg-white/20 rounded-full p-2"
          onClick={(e) => { e.stopPropagation(); setZoom(Math.max(0.5, zoom - 0.25)); }}
          data-testid="button-zoom-out"
        >
          <ZoomOut className="w-5 h-5" />
        </button>
        <span className="text-white text-sm min-w-[3rem] text-center">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          className="text-white hover:bg-white/20 rounded-full p-2"
          onClick={(e) => { e.stopPropagation(); setZoom(Math.min(3, zoom + 0.25)); }}
          data-testid="button-zoom-in"
        >
          <ZoomIn className="w-5 h-5" />
        </button>
      </div>
      
      {media.length > 1 && (
        <>
          <button
            type="button"
            className="absolute left-4 top-1/2 -translate-y-1/2 text-white hover:bg-white/20 rounded-full p-2"
            onClick={(e) => { e.stopPropagation(); goPrev(); }}
            data-testid="button-gallery-prev"
          >
            <ChevronLeft className="w-8 h-8" />
          </button>
          <button
            type="button"
            className="absolute right-4 top-1/2 -translate-y-1/2 text-white hover:bg-white/20 rounded-full p-2"
            onClick={(e) => { e.stopPropagation(); goNext(); }}
            data-testid="button-gallery-next"
          >
            <ChevronRight className="w-8 h-8" />
          </button>
        </>
      )}
      
      <div 
        className="max-w-[90vw] max-h-[85vh] flex items-center justify-center"
        onClick={(e) => e.stopPropagation()}
        data-testid="gallery-media-container"
      >
        {isVideo ? (
          <video 
            src={currentMedia} 
            controls 
            preload="metadata"
            poster={getMediaThumbUrl(currentMedia)}
            playsInline
            // @ts-ignore - legacy iOS/webkit attribute, not in the DOM typings but required to prevent native fullscreen takeover
            webkit-playsinline="true"
            className="max-h-[85vh] max-w-full object-contain"
            style={{ transform: `scale(${zoom})`, transformOrigin: 'center' }}
          />
        ) : (
          <img 
            src={currentMedia} 
            alt={`Photo ${currentIndex + 1}`}
            className="max-h-[85vh] max-w-full object-contain transition-transform duration-200"
            style={{ transform: `scale(${zoom})`, transformOrigin: 'center' }}
          />
        )}
      </div>
      
      {media.length > 1 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-1.5">
          {media.map((_, idx) => (
            <button
              key={idx}
              type="button"
              className={`w-2 h-2 rounded-full transition-colors ${idx === currentIndex ? 'bg-white' : 'bg-white/40'}`}
              onClick={(e) => { e.stopPropagation(); setCurrentIndex(idx); }}
              data-testid={`button-gallery-dot-${idx}`}
            />
          ))}
        </div>
      )}
    </div>,
    document.body
  );
}

interface StatusPillProps {
  status: string;
  scheduledAt?: string | null;
  onStatusChange: (status: string) => void;
  onSchedule: (date: Date) => void;
}

function StatusPill({ status, scheduledAt, onStatusChange, onSchedule }: StatusPillProps) {
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const normalizedStatus = status === 'new' ? 'pending' : status === 'in_progress' ? 'acknowledged' : status === 'done' ? 'completed' : status;

  const handleDateSelect = (date: Date | undefined) => {
    if (date) {
      onSchedule(date);
      setDatePickerOpen(false);
    }
  };

  const statusOptions = [
    { value: 'pending', label: 'Pending' },
    { value: 'acknowledged', label: 'In Progress' },
    { value: 'completed', label: 'Complete' },
  ];

  return (
    <div className="flex items-center gap-2">
      {/* Schedule date badge — always visible when a date is set */}
      {scheduledAt && (
        <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
          <PopoverTrigger asChild>
            <Badge className="gap-1.5 bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300 cursor-pointer hover-elevate" data-testid="badge-scheduled">
              <CalendarDays className="w-3.5 h-3.5" />
              {format(parseISO(scheduledAt), "dd MMM")}
            </Badge>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="end">
            <CalendarPicker
              mode="single"
              selected={parseISO(scheduledAt)}
              onSelect={handleDateSelect}
              disabled={(date) => date < new Date(new Date().setHours(0, 0, 0, 0))}
              initialFocus
            />
          </PopoverContent>
        </Popover>
      )}

      {/* Status change dropdown */}
      <Select value={normalizedStatus} onValueChange={onStatusChange}>
        <SelectTrigger className="h-8 w-[130px] text-xs" data-testid="select-status-change">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {statusOptions.map(opt => (
            <SelectItem key={opt.value} value={opt.value} className="text-xs">
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Schedule button — only when no date set yet */}
      {!scheduledAt && (
        <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 h-8"
              data-testid="button-schedule"
            >
              <CalendarDays className="w-4 h-4" />
              Schedule
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="end">
            <CalendarPicker
              mode="single"
              selected={undefined}
              onSelect={handleDateSelect}
              disabled={(date) => date < new Date(new Date().setHours(0, 0, 0, 0))}
              initialFocus
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

interface ActivityItem {
  id: string;
  type: 'comment' | 'status_change';
  authorName: string;
  authorInitials: string;
  message: string;
  timestamp: string;
  imageUrl?: string;
}

interface ReportDetailDialogProps {
  report: FixReport | null;
  open: boolean;
  onClose: () => void;
  onUpdate: () => void;
}

function ReportDetailDialog({ report, open, onClose, onUpdate }: ReportDetailDialogProps) {
  const { toast } = useToast();
  const [newComment, setNewComment] = useState("");
  const [scheduledDate, setScheduledDate] = useState<Date | undefined>();
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Completion photo flow state
  const [completionSheetOpen, setCompletionSheetOpen] = useState(false);
  const [completionFiles, setCompletionFiles] = useState<File[]>([]);
  const [completionPreviews, setCompletionPreviews] = useState<string[]>([]);
  const [isCompletingWithPhotos, setIsCompletingWithPhotos] = useState(false);
  const completionCameraRef = useRef<HTMLInputElement>(null);
  const completionGalleryRef = useRef<HTMLInputElement>(null);
  
  const { data: detailsResponse, isLoading: loadingDetails } = useQuery<{ report: FixReport; comments: FixComment[]; location?: { id: string; name: string } }>({
    queryKey: ['/api/fix-reports', report?.id, 'details'],
    enabled: !!report?.id && open,
  });
  
  const reportDetails = detailsResponse?.report;
  const comments = detailsResponse?.comments || [];
  
  const addCommentMutation = useMutation({
    mutationFn: async (message: string) => {
      return apiRequest("POST", `/api/fix-reports/${report?.id}/comments`, { message });
    },
    onSuccess: () => {
      toast({ title: "Update added" });
      setNewComment("");
      queryClient.invalidateQueries({ queryKey: ['/api/fix-reports', report?.id, 'details'] });
    },
    onError: () => {
      toast({ title: "Failed to add update", variant: "destructive" });
    },
  });
  
  const updateStatusMutation = useMutation({
    mutationFn: async (data: { status: string; scheduledAt?: string; appendMedia?: string[] }) => {
      return apiRequest("PATCH", `/api/fix-reports/${report?.id}/update`, data);
    },
    onSuccess: () => {
      toast({ title: "Status updated" });
      queryClient.invalidateQueries({ queryKey: ['/api/fix-reports', report?.id, 'details'] });
      onUpdate();
    },
    onError: () => {
      toast({ title: "Failed to update status", variant: "destructive" });
    },
  });
  
  // Separate mutation for updating schedule only (without status change)
  const updateScheduleMutation = useMutation({
    mutationFn: async (data: { scheduledAt: string }) => {
      return apiRequest("PATCH", `/api/fix-reports/${report?.id}/update`, data);
    },
    onSuccess: () => {
      toast({ title: "Schedule updated" });
      queryClient.invalidateQueries({ queryKey: ['/api/fix-reports', report?.id, 'details'] });
      onUpdate();
    },
    onError: () => {
      toast({ title: "Failed to update schedule", variant: "destructive" });
    },
  });
  
  if (!report) return null;
  
  const details = reportDetails || report;
  const normalizedStatus = details.status === 'new' ? 'pending' : details.status === 'in_progress' ? 'acknowledged' : details.status === 'done' ? 'completed' : details.status;
  
  const handleCompletionFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const remaining = 10 - completionFiles.length;
    const toAdd = files.slice(0, remaining);
    setCompletionFiles(prev => [...prev, ...toAdd]);
    toAdd.forEach(file => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        setCompletionPreviews(prev => [...prev, ev.target?.result as string]);
      };
      reader.readAsDataURL(file);
    });
    // reset input so same file can be picked again
    e.target.value = "";
  };

  const handleRemoveCompletionFile = (index: number) => {
    setCompletionFiles(prev => prev.filter((_, i) => i !== index));
    setCompletionPreviews(prev => prev.filter((_, i) => i !== index));
  };

  const handleConfirmComplete = async () => {
    setIsCompletingWithPhotos(true);
    try {
      let appendMedia: string[] | undefined;
      if (completionFiles.length > 0) {
        const formData = new FormData();
        completionFiles.forEach(f => formData.append("media", f));
        const uploadRes = await fetch("/api/fix-reports/upload", {
          method: "POST",
          body: formData,
          credentials: "include",
        });
        if (!uploadRes.ok) throw new Error("Failed to upload photos");
        const { urls } = await uploadRes.json();
        appendMedia = urls;
      }
      await updateStatusMutation.mutateAsync({ status: 'done', ...(appendMedia ? { appendMedia } : {}) });
      setCompletionSheetOpen(false);
      setCompletionFiles([]);
      setCompletionPreviews([]);
    } catch {
      toast({ title: "Failed to complete report", variant: "destructive" });
    } finally {
      setIsCompletingWithPhotos(false);
    }
  };

  const handleStatusChange = (newStatus: string) => {
    if (newStatus === 'completed') {
      setCompletionFiles([]);
      setCompletionPreviews([]);
      setCompletionSheetOpen(true);
    } else {
      const backendStatus = newStatus === 'pending' ? 'new' : newStatus === 'acknowledged' ? 'in_progress' : newStatus;
      updateStatusMutation.mutate({ status: backendStatus });
    }
  };
  
  const handleDateSelect = (date: Date | undefined) => {
    setScheduledDate(date);
    if (date) {
      // Only update schedule date without changing status
      updateScheduleMutation.mutate({ scheduledAt: date.toISOString() });
    }
  };
  
  const handleSchedule = (date: Date) => {
    setScheduledDate(date);
    // Only update schedule date without changing status
    updateScheduleMutation.mutate({ scheduledAt: date.toISOString() });
  };
  
  const openGallery = (index: number) => {
    setGalleryIndex(index);
    setGalleryOpen(true);
  };
  
  const { user: authUser } = useAuth();
  const activityEntries = comments.map(c => rawCommentToActivityEntry({
    id: c.id,
    message: c.message,
    createdAt: c.createdAt,
    authorUserId: c.authorUserId,
    author: c.authorType === 'supplier_token'
      ? { id: c.supplierToken?.id || '', fullName: c.supplierToken?.name || 'Supplier', email: '' }
      : c.author || null,
    authorType: c.authorType,
  }));
  
  const locationText = details.locationDetails?.name || details.location || details.locationNote;
  const tagText = details.tags?.[0];
  
  return (
    <>
      {/* Hidden file inputs for completion photos */}
      <input
        ref={completionCameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="hidden"
        onChange={handleCompletionFileSelect}
        data-testid="input-completion-camera"
      />
      <input
        ref={completionGalleryRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleCompletionFileSelect}
        data-testid="input-completion-gallery"
      />

      {/* Completion photo sheet */}
      <Dialog open={completionSheetOpen} onOpenChange={(o) => !o && !isCompletingWithPhotos && setCompletionSheetOpen(false)}>
        <DialogContent className="max-w-sm" data-testid="dialog-completion-photos">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle className="w-5 h-5 text-green-600" />
              Mark as Complete
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Optionally attach photos showing the completed fix before confirming.
          </p>

          {/* Camera / Gallery buttons */}
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1 gap-2"
              disabled={completionFiles.length >= 10}
              onClick={() => completionCameraRef.current?.click()}
              data-testid="button-completion-camera"
            >
              <Camera className="w-4 h-4" />
              Camera
            </Button>
            <Button
              variant="outline"
              className="flex-1 gap-2"
              disabled={completionFiles.length >= 10}
              onClick={() => completionGalleryRef.current?.click()}
              data-testid="button-completion-gallery"
            >
              <Image className="w-4 h-4" />
              Gallery
            </Button>
          </div>

          {/* Thumbnail strip */}
          {completionPreviews.length > 0 && (
            <div className="grid grid-cols-5 gap-1.5">
              {completionPreviews.map((src, idx) => (
                <div key={idx} className="relative aspect-square rounded-md overflow-hidden bg-muted">
                  <img src={src} alt={`Photo ${idx + 1}`} className="w-full h-full object-cover" />
                  <button
                    type="button"
                    className="absolute top-0.5 right-0.5 bg-black/60 rounded-full p-0.5"
                    onClick={() => handleRemoveCompletionFile(idx)}
                    data-testid={`button-remove-completion-${idx}`}
                  >
                    <X className="w-2.5 h-2.5 text-white" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button
              className="w-full"
              onClick={handleConfirmComplete}
              disabled={isCompletingWithPhotos}
              data-testid="button-confirm-complete"
            >
              {isCompletingWithPhotos ? (
                <>
                  <LoadingSpinner />
                  <span className="ml-2">{completionFiles.length > 0 ? "Uploading…" : "Completing…"}</span>
                </>
              ) : (
                <>
                  <CheckCircle className="w-4 h-4 mr-2" />
                  {completionFiles.length > 0 ? `Confirm Complete (${completionFiles.length} photo${completionFiles.length !== 1 ? 's' : ''})` : "Confirm Complete"}
                </>
              )}
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              onClick={handleConfirmComplete}
              disabled={isCompletingWithPhotos}
              data-testid="button-skip-complete"
            >
              Skip photos & complete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={open} onOpenChange={(o) => !o && !galleryOpen && onClose()}>
        <DialogContent className="max-w-lg max-h-[90vh] flex flex-col p-0 gap-0" data-testid="dialog-fix-report-detail">
          <div className="flex items-start justify-between gap-4 p-4 pb-3 pr-12 border-b">
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-semibold leading-tight truncate" data-testid="text-fix-title">
                {details.title || "Fix Report"}
              </h2>
              <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1 flex-wrap">
                {locationText && (
                  <span className="flex items-center gap-1">
                    <MapPin className="w-3.5 h-3.5" />
                    {locationText}
                  </span>
                )}
                {tagText && (
                  <Badge variant="outline" className="text-xs font-normal">
                    {tagText}
                  </Badge>
                )}
              </div>
            </div>
            <StatusPill 
              status={details.status}
              scheduledAt={details.scheduledAt}
              onStatusChange={handleStatusChange}
              onSchedule={handleSchedule}
            />
          </div>
          
          {loadingDetails ? (
            <div className="flex justify-center py-12">
              <LoadingSpinner />
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              {normalizedStatus === 'completed' && details.closedAt && (
                <div className="px-4 py-3 bg-green-50 dark:bg-green-950/30 border-b flex items-center gap-3">
                  <CheckCircle className="w-4 h-4 text-green-600 dark:text-green-400" />
                  <span className="text-sm text-green-700 dark:text-green-300">
                    Completed on {format(parseISO(details.closedAt), "dd MMM yyyy")}
                  </span>
                </div>
              )}
              
              {details.media && details.media.length > 0 && (
                <div className="p-4 border-b">
                  <div 
                    className={`grid gap-2 ${details.media.length === 1 ? '' : 'grid-cols-2'}`}
                  >
                    {details.media.map((url, idx) => {
                      const isVideo = isVideoUrl(url);
                      return (
                        <button
                          type="button"
                          key={idx} 
                          className={`relative rounded-lg overflow-hidden bg-muted cursor-pointer group ${
                            details.media!.length === 1 ? 'aspect-video' : 'aspect-square'
                          }`}
                          onClick={(e) => { e.stopPropagation(); openGallery(idx); }}
                          data-testid={`photo-thumbnail-${idx}`}
                        >
                          <img src={getMediaThumbUrl(url)} alt={`Photo ${idx + 1}`} loading="lazy" className="w-full h-full object-cover pointer-events-none" />
                          {isVideo && (
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                              <PlayCircle className="w-8 h-8 text-white drop-shadow" />
                            </div>
                          )}
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center pointer-events-none">
                            <div className="opacity-0 group-hover:opacity-100 transition-opacity bg-black/50 rounded-full p-2">
                              <ZoomIn className="w-5 h-5 text-white" />
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              
              {details.description && (
                <div className="px-4 py-3 border-b">
                  <p className="text-sm text-foreground/90">{details.description}</p>
                </div>
              )}
              
              <div className="px-4 py-3 border-b">
                <FixActivityFeed
                  entries={activityEntries}
                  createdAt={details.createdAt}
                  currentUserId={authUser?.id}
                />
              </div>
            </div>
          )}
          
          <div className="p-3 border-t bg-background">
            <div className="flex items-center gap-2">
              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept="image/*"
                onChange={() => {}}
              />
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={() => fileInputRef.current?.click()}
                data-testid="button-attach-photo"
              >
                <Paperclip className="w-4 h-4" />
              </Button>
              <Input
                placeholder="Add update or photo..."
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                className="flex-1"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newComment.trim()) {
                    addCommentMutation.mutate(newComment.trim());
                  }
                }}
                data-testid="input-activity-comment"
              />
              <Button 
                size="icon"
                onClick={() => newComment.trim() && addCommentMutation.mutate(newComment.trim())}
                disabled={!newComment.trim() || addCommentMutation.isPending}
                data-testid="button-send-update"
              >
                <Send className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      
      <PhotoGalleryModal
        media={details.media || []}
        initialIndex={galleryIndex}
        open={galleryOpen}
        onClose={() => setGalleryOpen(false)}
      />
    </>
  );
}

export default function FixBoardPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { activeBranchId, branches, setActiveBranchId, isLoading: branchLoading } = useBranchContext();
  const SESSION_KEY = "fix-board-status-filter";
  const [statusFilter, setStatusFilterRaw] = useState<string>(() => {
    try { return sessionStorage.getItem(SESSION_KEY) || "pending"; } catch { return "pending"; }
  });
  const setStatusFilter = (val: string) => {
    try { sessionStorage.setItem(SESSION_KEY, val); } catch {}
    setStatusFilterRaw(val);
    if (val !== "completed") setCompletedTimeFilter("this_month");
  };

  type CompletedTimeFilter = "today" | "yesterday" | "this_week" | "this_month" | "last_month" | "custom";
  const [completedTimeFilter, setCompletedTimeFilter] = useState<CompletedTimeFilter>("this_month");
  const [customFrom, setCustomFrom] = useState<Date | undefined>(undefined);
  const [customTo, setCustomTo] = useState<Date | undefined>(undefined);

  const getCompletedDateRange = (): { from: Date; to: Date } | null => {
    const now = new Date();
    if (completedTimeFilter === "today") {
      const start = new Date(now); start.setHours(0, 0, 0, 0);
      const end = new Date(now); end.setHours(23, 59, 59, 999);
      return { from: start, to: end };
    }
    if (completedTimeFilter === "yesterday") {
      const d = new Date(now); d.setDate(d.getDate() - 1);
      const start = new Date(d); start.setHours(0, 0, 0, 0);
      const end = new Date(d); end.setHours(23, 59, 59, 999);
      return { from: start, to: end };
    }
    if (completedTimeFilter === "this_week") {
      const start = new Date(now); start.setDate(now.getDate() - now.getDay()); start.setHours(0, 0, 0, 0);
      const end = new Date(now); end.setHours(23, 59, 59, 999);
      return { from: start, to: end };
    }
    if (completedTimeFilter === "this_month") {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now); end.setHours(23, 59, 59, 999);
      return { from: start, to: end };
    }
    if (completedTimeFilter === "last_month") {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      return { from: start, to: end };
    }
    if (completedTimeFilter === "custom" && customFrom && customTo) {
      const end = new Date(customTo); end.setHours(23, 59, 59, 999);
      return { from: customFrom, to: end };
    }
    return null;
  };

  const [priorityFilter, setPriorityFilter] = useState("all");
  const [selectedReport, setSelectedReport] = useState<FixReport | null>(null);
  const [activeTab, setActiveTab] = useState<'all' | 'myqueue'>('all');

  // Check if user is a Fix Department member
  const { data: queueInfo } = useQuery<{ isFixDeptMember: boolean; fixDeptId: string | null; userDeptIds: string[] }>({
    queryKey: ['/api/fix-reports/my-queue-info'],
    queryFn: async () => {
      const res = await fetch('/api/fix-reports/my-queue-info', { credentials: 'include' });
      if (!res.ok) return { isFixDeptMember: false, fixDeptId: null, userDeptIds: [] };
      return res.json();
    },
  });

  const isFixDeptMember = queueInfo?.isFixDeptMember ?? false;
  const isManagerOrAdmin = user?.role && ['admin', 'global_admin', 'operator_admin', 'manager'].includes(user.role);

  // Auto-switch non-manager Fix Dept members to My Queue only
  const effectiveTab = (!isManagerOrAdmin && isFixDeptMember && activeTab === 'all') ? 'myqueue' : activeTab;

  const buildQueryUrl = () => {
    const params = new URLSearchParams();
    if (effectiveTab === 'myqueue') {
      params.append('myQueue', 'true');
    } else {
      if (activeBranchId && activeBranchId !== 'all') {
        params.append('branchId', activeBranchId);
      }
    }
    if (statusFilter !== 'all') {
      params.append('status', statusFilter);
    }
    if (priorityFilter !== 'all') {
      params.append('priority', priorityFilter);
    }
    if (statusFilter === 'completed') {
      const range = getCompletedDateRange();
      if (range) {
        params.append('completedFrom', range.from.toISOString());
        params.append('completedTo', range.to.toISOString());
      }
    }
    const queryString = params.toString();
    return queryString ? `/api/fix-reports?${queryString}` : '/api/fix-reports';
  };

  const buildCountsQueryUrl = () => {
    const params = new URLSearchParams();
    if (effectiveTab === 'myqueue') {
      params.append('myQueue', 'true');
    } else {
      if (activeBranchId && activeBranchId !== 'all') {
        params.append('branchId', activeBranchId);
      }
    }
    const queryString = params.toString();
    return queryString ? `/api/fix-reports?${queryString}` : '/api/fix-reports';
  };
  
  // Only fire the report query once we know the user is authorized (queueInfo loaded)
  const isAuthorized = isManagerOrAdmin || isFixDeptMember;
  const queueInfoLoaded = queueInfo !== undefined;

  const { data: reports = [], isLoading, refetch } = useQuery<FixReport[]>({
    queryKey: ['/api/fix-reports', effectiveTab, activeBranchId, statusFilter, priorityFilter, completedTimeFilter, customFrom?.toISOString(), customTo?.toISOString()],
    queryFn: async () => {
      const res = await fetch(buildQueryUrl(), { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch reports');
      return res.json();
    },
    enabled: queueInfoLoaded && isAuthorized,
  });

  // Separate unfiltered query for count cards — not affected by status/priority/date filters
  const { data: allReports = [] } = useQuery<FixReport[]>({
    queryKey: ['/api/fix-reports', 'counts', effectiveTab, activeBranchId],
    queryFn: async () => {
      const res = await fetch(buildCountsQueryUrl(), { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch reports');
      return res.json();
    },
    enabled: queueInfoLoaded && isAuthorized,
  });
  
  const filteredReports = reports.filter(report => {
    if (statusFilter !== 'all') {
      const normalizedStatus = report.status === 'new' ? 'pending' 
        : report.status === 'in_progress' ? 'acknowledged' 
        : report.status === 'done' ? 'completed' 
        : report.status;
      if (normalizedStatus !== statusFilter) return false;
    }
    if (priorityFilter !== 'all' && report.priority !== priorityFilter) return false;
    return true;
  });
  
  const pendingCount = allReports.filter(r => r.status === 'new' || r.status === 'pending').length;
  const acknowledgedCount = allReports.filter(r => r.status === 'in_progress' || r.status === 'acknowledged').length;
  const completedCount = allReports.filter(r => r.status === 'done' || r.status === 'completed').length;
  
  if (branchLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner />
      </div>
    );
  }

  // Access control: only managers/admins and Fix Dept members can see the board
  if (queueInfo && !isManagerOrAdmin && !isFixDeptMember) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] p-6 text-center" data-testid="page-fix-board-denied">
        <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center mb-4">
          <Wrench className="w-8 h-8 text-muted-foreground" />
        </div>
        <h2 className="text-lg font-semibold mb-1">Access Restricted</h2>
        <p className="text-muted-foreground text-sm max-w-xs">
          The Fix Board is available to managers, admins, and Fix Department members.
        </p>
      </div>
    );
  }
  
  return (
    <div className="p-4 pb-20 max-w-2xl mx-auto" data-testid="page-fix-board">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Wrench className="w-5 h-5" />
          Fix Board
        </h1>
        <Button
          size="sm"
          onClick={() => setLocation("/core/fix?report=1")}
          data-testid="button-report-issue"
        >
          <Plus className="w-4 h-4 mr-1" />
          Report an Issue
        </Button>
      </div>

      {/* Tab strip: My Queue shown to Fix Dept members; All Reports only for managers/admins */}
      {isFixDeptMember && isManagerOrAdmin && (
        <div className="flex gap-1 mb-4 bg-muted rounded-lg p-1">
          <button
            type="button"
            className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${effectiveTab === 'myqueue' ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            onClick={() => setActiveTab('myqueue')}
            data-testid="tab-my-queue"
          >
            My Queue
          </button>
          <button
            type="button"
            className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${effectiveTab === 'all' ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            onClick={() => setActiveTab('all')}
            data-testid="tab-all-reports"
          >
            All Reports
          </button>
        </div>
      )}
      {isFixDeptMember && !isManagerOrAdmin && (
        <div className="mb-3">
          <p className="text-sm text-muted-foreground">Showing reports assigned to your department</p>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2 mb-4">
        <Card className="p-2 text-center cursor-pointer hover-elevate" onClick={() => setStatusFilter('pending')}>
          <div className="text-lg font-bold text-amber-500">{pendingCount}</div>
          <div className="text-xs text-muted-foreground">Pending</div>
        </Card>
        <Card className="p-2 text-center cursor-pointer hover-elevate" onClick={() => setStatusFilter('acknowledged')}>
          <div className="text-lg font-bold text-blue-500">{acknowledgedCount}</div>
          <div className="text-xs text-muted-foreground">In Progress</div>
        </Card>
        <Card className="p-2 text-center cursor-pointer hover-elevate" onClick={() => setStatusFilter('completed')}>
          <div className="text-lg font-bold text-green-500">{completedCount}</div>
          <div className="text-xs text-muted-foreground">Completed</div>
        </Card>
      </div>
      
      {effectiveTab === 'all' && (
        <div className="flex gap-2 mb-4">
          <Select
            value={activeBranchId || 'all'}
            onValueChange={(value) => setActiveBranchId(value === 'all' ? null : value)}
          >
            <SelectTrigger className="flex-1" data-testid="select-branch">
              <SelectValue placeholder="Select branch" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Branches</SelectItem>
              {branches.map(branch => (
                <SelectItem key={branch.id} value={branch.id}>{branch.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-32" data-testid="select-status-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map(opt => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          
          <Select value={priorityFilter} onValueChange={setPriorityFilter}>
            <SelectTrigger className="w-32" data-testid="select-priority-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIORITY_OPTIONS.map(opt => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {effectiveTab === 'myqueue' && (
        <div className="flex gap-2 mb-4">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40" data-testid="select-status-filter-queue">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map(opt => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={priorityFilter} onValueChange={setPriorityFilter}>
            <SelectTrigger className="w-40" data-testid="select-priority-filter-queue">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIORITY_OPTIONS.map(opt => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {statusFilter === 'completed' && (
        <div className="mb-4 space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {(["today", "yesterday", "this_week", "this_month", "last_month", "custom"] as const).map(opt => (
              <button
                key={opt}
                type="button"
                onClick={() => setCompletedTimeFilter(opt)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  completedTimeFilter === opt
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-muted-foreground border-border hover:border-primary/50'
                }`}
                data-testid={`btn-completed-time-${opt}`}
              >
                {opt === "today" ? "Today"
                  : opt === "yesterday" ? "Yesterday"
                  : opt === "this_week" ? "This Week"
                  : opt === "this_month" ? "This Month"
                  : opt === "last_month" ? "Last Month"
                  : "Custom Range"}
              </button>
            ))}
          </div>
          {completedTimeFilter === 'custom' && (
            <div className="flex items-center gap-2 flex-wrap">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="text-xs h-8">
                    <CalendarDays className="w-3 h-3 mr-1" />
                    {customFrom ? format(customFrom, "dd MMM yyyy") : "From date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <CalendarPicker mode="single" selected={customFrom} onSelect={setCustomFrom} initialFocus />
                </PopoverContent>
              </Popover>
              <span className="text-xs text-muted-foreground">to</span>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="text-xs h-8">
                    <CalendarDays className="w-3 h-3 mr-1" />
                    {customTo ? format(customTo, "dd MMM yyyy") : "To date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <CalendarPicker mode="single" selected={customTo} onSelect={setCustomTo} initialFocus />
                </PopoverContent>
              </Popover>
            </div>
          )}
        </div>
      )}
      
      {isLoading ? (
        <div className="flex items-center justify-center h-40">
          <LoadingSpinner />
        </div>
      ) : filteredReports.length === 0 ? (
        <Card className="p-8 text-center">
          <Wrench className="w-12 h-12 mx-auto text-muted-foreground mb-2" />
          <p className="text-muted-foreground">
            {effectiveTab === 'myqueue' ? 'No reports in your queue' : 'No fix reports found'}
          </p>
          {statusFilter !== 'all' && (
            <Button 
              variant="link" 
              onClick={() => setStatusFilter('all')}
              className="mt-2"
            >
              Show all reports
            </Button>
          )}
        </Card>
      ) : (
        <div className="space-y-3">
          {filteredReports.map(report => (
            <ReportCard 
              key={report.id} 
              report={report} 
              onClick={() => setSelectedReport(report)}
            />
          ))}
        </div>
      )}
      
      <ReportDetailDialog 
        report={selectedReport}
        open={!!selectedReport}
        onClose={() => setSelectedReport(null)}
        onUpdate={() => {
          refetch();
          queryClient.invalidateQueries({ queryKey: ['/api/fix-reports'] });
        }}
      />
    </div>
  );
}
