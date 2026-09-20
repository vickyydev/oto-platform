import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { 
  Wrench, 
  Clock,
  MapPin,
  CheckCircle,
  Send,
  MessageSquare,
  ChevronRight,
  Building2,
  AlertCircle,
  ShieldAlert,
} from "lucide-react";
import { format, parseISO, formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { LoadingSpinner } from "@/components/ui/loading-spinner";

interface SupplierInfo {
  id: string;
  name: string;
  allowedBranches: { id: string; name: string }[];
}

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
  mediaUrls: string[];
  note?: string | null;
  scheduledAt?: string | null;
  closedAt?: string | null;
  doneNote?: string | null;
  createdAt: string;
  branch?: { id: string; name: string } | null;
  locationDetails?: { id: string; name: string } | null;
  comments?: FixComment[];
}

interface FixComment {
  id: string;
  fixReportId: string;
  authorType: string;
  message: string;
  createdAt: string;
  author?: { id: string; fullName?: string | null; email: string } | null;
  supplierToken?: { id: string; name: string } | null;
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
    new: { label: "New", variant: "destructive" },
    in_progress: { label: "In Progress", variant: "default" },
    pending: { label: "Pending", variant: "secondary" },
    done: { label: "Done", variant: "outline" },
  };
  
  const { label, variant } = config[status] || { label: status, variant: "secondary" };
  return <Badge variant={variant}>{label}</Badge>;
}

function PriorityBadge({ priority }: { priority: string }) {
  const config: Record<string, { label: string; className: string }> = {
    urgent: { label: "Urgent", className: "bg-red-500 text-white" },
    high: { label: "High", className: "bg-orange-500 text-white" },
    normal: { label: "Normal", className: "bg-blue-500 text-white" },
    low: { label: "Low", className: "bg-gray-400 text-white" },
  };
  
  const { label, className } = config[priority] || { label: priority, className: "bg-gray-400 text-white" };
  return <Badge className={className}>{label}</Badge>;
}

export default function SupplierPortalPage() {
  const { toast } = useToast();
  const [, params] = useRoute("/supplier/:token");
  const token = params?.token || '';
  
  const [selectedReport, setSelectedReport] = useState<FixReport | null>(null);
  const [newComment, setNewComment] = useState("");
  const [doneNote, setDoneNote] = useState("");
  const [showCloseForm, setShowCloseForm] = useState(false);
  
  const { data: supplierInfo, isLoading: validating, error: validationError } = useQuery<SupplierInfo>({
    queryKey: ['/api/supplier-portal/validate', token],
    queryFn: async () => {
      const res = await fetch(`/api/supplier-portal/validate?token=${token}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || 'Invalid token');
      }
      return res.json();
    },
    enabled: !!token,
    retry: false,
  });
  
  const { data: reports = [], isLoading: loadingReports, refetch: refetchReports } = useQuery<FixReport[]>({
    queryKey: ['/api/supplier-portal/fix-reports', token],
    queryFn: async () => {
      const res = await fetch(`/api/supplier-portal/fix-reports?token=${token}`);
      if (!res.ok) throw new Error('Failed to fetch reports');
      return res.json();
    },
    enabled: !!supplierInfo,
  });
  
  const { data: reportDetails, isLoading: loadingDetails } = useQuery<FixReport>({
    queryKey: ['/api/supplier-portal/fix-reports', selectedReport?.id, token],
    queryFn: async () => {
      const res = await fetch(`/api/supplier-portal/fix-reports/${selectedReport?.id}?token=${token}`);
      if (!res.ok) throw new Error('Failed to fetch report details');
      return res.json();
    },
    enabled: !!selectedReport?.id && !!token,
  });
  
  const addCommentMutation = useMutation({
    mutationFn: async (message: string) => {
      const res = await fetch(`/api/supplier-portal/fix-reports/${selectedReport?.id}/comments?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) throw new Error('Failed to add comment');
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Comment added" });
      setNewComment("");
      refetchReports();
    },
    onError: () => {
      toast({ title: "Failed to add comment", variant: "destructive" });
    },
  });
  
  const closeReportMutation = useMutation({
    mutationFn: async (note: string) => {
      const res = await fetch(`/api/supplier-portal/fix-reports/${selectedReport?.id}/close?token=${token}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doneNote: note }),
      });
      if (!res.ok) throw new Error('Failed to close report');
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Report marked as done" });
      setShowCloseForm(false);
      setDoneNote("");
      setSelectedReport(null);
      refetchReports();
    },
    onError: () => {
      toast({ title: "Failed to close report", variant: "destructive" });
    },
  });
  
  if (validating) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <LoadingSpinner className="mx-auto mb-4" />
          <p className="text-muted-foreground">Validating access...</p>
        </div>
      </div>
    );
  }
  
  if (validationError || !supplierInfo) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center">
            <ShieldAlert className="w-16 h-16 mx-auto text-destructive mb-4" />
            <h1 className="text-xl font-semibold mb-2">Access Denied</h1>
            <p className="text-muted-foreground">
              {validationError instanceof Error ? validationError.message : 'This link is invalid or has expired.'}
            </p>
            <p className="text-sm text-muted-foreground mt-4">
              Please contact the facility manager for a new access link.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }
  
  const openReports = reports.filter(r => r.status !== 'done');
  const closedReports = reports.filter(r => r.status === 'done');
  const details = reportDetails || selectedReport;
  
  return (
    <div className="min-h-screen bg-background" data-testid="page-supplier-portal">
      <header className="sticky top-0 z-10 bg-background border-b p-4">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center gap-2 mb-1">
            <Wrench className="w-5 h-5 text-primary" />
            <h1 className="font-semibold">Supplier Portal</h1>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>Welcome, {supplierInfo.name}</span>
            <span className="text-muted-foreground/50">|</span>
            <span>{supplierInfo.allowedBranches.map(b => b.name).join(', ')}</span>
          </div>
        </div>
      </header>
      
      <main className="max-w-2xl mx-auto p-4 pb-20">
        <div className="grid grid-cols-2 gap-3 mb-6">
          <Card className="p-3 text-center">
            <div className="text-2xl font-bold text-orange-500">{openReports.length}</div>
            <div className="text-xs text-muted-foreground">Open Issues</div>
          </Card>
          <Card className="p-3 text-center">
            <div className="text-2xl font-bold text-green-500">{closedReports.length}</div>
            <div className="text-xs text-muted-foreground">Completed</div>
          </Card>
        </div>
        
        {loadingReports ? (
          <div className="flex justify-center py-12">
            <LoadingSpinner />
          </div>
        ) : openReports.length === 0 && closedReports.length === 0 ? (
          <Card className="p-8 text-center">
            <CheckCircle className="w-12 h-12 mx-auto text-green-500 mb-2" />
            <p className="text-muted-foreground">No fix requests at this time</p>
          </Card>
        ) : (
          <div className="space-y-6">
            {openReports.length > 0 && (
              <div>
                <h2 className="font-medium mb-3 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-orange-500" />
                  Open Issues ({openReports.length})
                </h2>
                <div className="space-y-3">
                  {openReports.map(report => (
                    <Card 
                      key={report.id}
                      className="hover-elevate active-elevate-2 cursor-pointer overflow-visible"
                      onClick={() => setSelectedReport(report)}
                      data-testid={`card-supplier-report-${report.id}`}
                    >
                      <CardContent className="p-4">
                        <div className="flex gap-3">
                          {report.mediaUrls?.length > 0 && (
                            <div className="w-16 h-16 rounded-md overflow-hidden flex-shrink-0 bg-muted">
                              <img 
                                src={report.mediaUrls[0]} 
                                alt="Fix report" 
                                className="w-full h-full object-cover"
                              />
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2 mb-1">
                              <h3 className="font-medium text-sm truncate">
                                {report.title || report.description?.slice(0, 50) || "Fix Request"}
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
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}
            
            {closedReports.length > 0 && (
              <div>
                <h2 className="font-medium mb-3 flex items-center gap-2 text-muted-foreground">
                  <CheckCircle className="w-4 h-4 text-green-500" />
                  Completed ({closedReports.length})
                </h2>
                <div className="space-y-2">
                  {closedReports.slice(0, 5).map(report => (
                    <Card 
                      key={report.id}
                      className="hover-elevate cursor-pointer overflow-visible opacity-70"
                      onClick={() => setSelectedReport(report)}
                    >
                      <CardContent className="p-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm truncate">
                            {report.title || report.description?.slice(0, 40) || "Fix Request"}
                          </span>
                          <Badge variant="outline">Done</Badge>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </main>
      
      <Dialog open={!!selectedReport} onOpenChange={(o) => !o && setSelectedReport(null)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto" data-testid="dialog-supplier-report-detail">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wrench className="w-5 h-5" />
              {details?.title || "Fix Request"}
            </DialogTitle>
          </DialogHeader>
          
          {loadingDetails ? (
            <div className="flex justify-center py-8">
              <LoadingSpinner />
            </div>
          ) : details && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <StatusBadge status={details.status} />
                {details.priority && <PriorityBadge priority={details.priority} />}
              </div>
              
              {details.mediaUrls?.length > 0 && (
                <div className="grid grid-cols-2 gap-2">
                  {details.mediaUrls.map((url, idx) => (
                    <div key={idx} className="rounded-md overflow-hidden bg-muted aspect-video">
                      {url.includes('.mp4') || url.includes('.mov') ? (
                        <video src={url} controls className="w-full h-full object-cover" />
                      ) : (
                        <img src={url} alt={`Media ${idx + 1}`} className="w-full h-full object-cover" />
                      )}
                    </div>
                  ))}
                </div>
              )}
              
              {details.description && (
                <div>
                  <Label className="text-muted-foreground text-xs">Description</Label>
                  <p className="text-sm">{details.description}</p>
                </div>
              )}
              
              <div className="grid grid-cols-2 gap-4 text-sm">
                {(details.locationDetails?.name || details.location || details.locationNote) && (
                  <div>
                    <Label className="text-muted-foreground text-xs">Location</Label>
                    <p className="flex items-center gap-1">
                      <MapPin className="w-3 h-3" />
                      {details.locationDetails?.name || details.location || details.locationNote}
                    </p>
                  </div>
                )}
                {details.branch && (
                  <div>
                    <Label className="text-muted-foreground text-xs">Branch</Label>
                    <p className="flex items-center gap-1">
                      <Building2 className="w-3 h-3" />
                      {details.branch.name}
                    </p>
                  </div>
                )}
                <div>
                  <Label className="text-muted-foreground text-xs">Reported</Label>
                  <p className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {format(parseISO(details.createdAt), "dd MMM yyyy HH:mm")}
                  </p>
                </div>
              </div>
              
              {details.tags?.length > 0 && (
                <div>
                  <Label className="text-muted-foreground text-xs mb-1 block">Tags</Label>
                  <div className="flex flex-wrap gap-1">
                    {details.tags.map(tag => (
                      <Badge key={tag} variant="outline" className="text-xs">{tag}</Badge>
                    ))}
                  </div>
                </div>
              )}
              
              {details.doneNote && (
                <div className="bg-green-50 dark:bg-green-950 p-3 rounded-md">
                  <Label className="text-green-700 dark:text-green-300 text-xs">Resolution Note</Label>
                  <p className="text-sm text-green-800 dark:text-green-200">{details.doneNote}</p>
                </div>
              )}
              
              <div className="border-t pt-4">
                <Label className="flex items-center gap-1 mb-3">
                  <MessageSquare className="w-4 h-4" />
                  Comments
                </Label>
                
                {details.comments && details.comments.length > 0 ? (
                  <div className="space-y-3 max-h-48 overflow-y-auto mb-3">
                    {details.comments.map(comment => (
                      <div key={comment.id} className="bg-muted p-3 rounded-md text-sm">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-medium text-xs">
                            {comment.authorType === 'supplier_token' 
                              ? `Supplier: ${comment.supplierToken?.name || 'You'}`
                              : comment.author?.fullName || 'Staff'
                            }
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {formatDistanceToNow(parseISO(comment.createdAt), { addSuffix: true })}
                          </span>
                        </div>
                        <p>{comment.message}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground mb-3">No comments yet</p>
                )}
                
                <div className="flex gap-2">
                  <Input
                    placeholder="Add a comment..."
                    value={newComment}
                    onChange={(e) => setNewComment(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newComment.trim()) {
                        addCommentMutation.mutate(newComment.trim());
                      }
                    }}
                    data-testid="input-supplier-comment"
                  />
                  <Button 
                    size="icon"
                    onClick={() => newComment.trim() && addCommentMutation.mutate(newComment.trim())}
                    disabled={!newComment.trim() || addCommentMutation.isPending}
                    data-testid="button-send-supplier-comment"
                  >
                    <Send className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>
          )}
          
          {details?.status !== 'done' && (
            <DialogFooter className="flex-col gap-2 sm:flex-row">
              {!showCloseForm ? (
                <Button 
                  onClick={() => setShowCloseForm(true)}
                  data-testid="button-supplier-mark-done"
                >
                  <CheckCircle className="w-4 h-4 mr-1" />
                  Mark as Done
                </Button>
              ) : (
                <div className="w-full space-y-2">
                  <Textarea
                    placeholder="Describe what was done to fix this issue..."
                    value={doneNote}
                    onChange={(e) => setDoneNote(e.target.value)}
                    data-testid="input-supplier-done-note"
                  />
                  <div className="flex gap-2 justify-end">
                    <Button 
                      variant="outline" 
                      onClick={() => setShowCloseForm(false)}
                    >
                      Cancel
                    </Button>
                    <Button 
                      onClick={() => closeReportMutation.mutate(doneNote)}
                      disabled={closeReportMutation.isPending}
                      data-testid="button-supplier-confirm-done"
                    >
                      Confirm Done
                    </Button>
                  </div>
                </div>
              )}
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
