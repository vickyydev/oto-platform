import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { 
  FileText, Upload, Trash2, RefreshCw, Eye, X, 
  FileImage, FileVideo, CheckCircle, AlertCircle, Clock,
  Search, Filter, Wand2
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useBranchContext } from "@/hooks/use-branch-context";
import { format } from "date-fns";
import type { KnowledgeFile } from "@shared/schema";

interface KnowledgeFilesProps {
  isAdmin: boolean;
}

export function KnowledgeFiles({ isAdmin }: KnowledgeFilesProps) {
  const { toast } = useToast();
  const { branches } = useBranchContext();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [viewingFile, setViewingFile] = useState<KnowledgeFile | null>(null);
  const [deleteFileId, setDeleteFileId] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadDescription, setUploadDescription] = useState("");
  const [uploadBranchId, setUploadBranchId] = useState<string>("global");
  const [uploadLanguage, setUploadLanguage] = useState("en");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  // Extract filename without extension for default title
  const getDefaultTitle = (filename: string) => {
    const lastDot = filename.lastIndexOf(".");
    return lastDot > 0 ? filename.substring(0, lastDot) : filename;
  };

  // Drag and drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    
    const droppedFiles = e.dataTransfer.files;
    if (droppedFiles.length > 0) {
      const file = droppedFiles[0];
      // Validate file type
      const allowedTypes = ["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4", "video/webm"];
      if (!allowedTypes.includes(file.type)) {
        toast({ title: "Invalid file type", description: "Please upload PDF, image (JPEG/PNG/GIF/WebP), or video (MP4/WebM) files.", variant: "destructive" });
        return;
      }
      // Set file and auto-populate title from filename
      setSelectedFile(file);
      setUploadTitle(getDefaultTitle(file.name));
      setIsUploadDialogOpen(true);
    }
  };

  const buildUrl = () => {
    const params = new URLSearchParams();
    if (filterType !== "all") params.set("fileType", filterType);
    if (filterStatus !== "all") params.set("indexStatus", filterStatus);
    params.set("isActive", "true");
    const queryString = params.toString();
    return `/api/knowledge-files?${queryString}`;
  };

  const { data: files = [], isLoading } = useQuery<KnowledgeFile[]>({
    queryKey: ["/api/knowledge-files", filterType, filterStatus],
    queryFn: async () => {
      const res = await fetch(buildUrl(), { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch files");
      return res.json();
    },
  });

  const { data: chunks = [] } = useQuery<Array<{ id: string; text: string; chunkIndex: number }>>({
    queryKey: ["/api/knowledge-files", viewingFile?.id, "chunks"],
    queryFn: async () => {
      const res = await fetch(`/api/knowledge-files/${viewingFile?.id}/chunks`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch chunks");
      return res.json();
    },
    enabled: !!viewingFile?.id,
  });

  const uploadMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      try {
        const res = await fetch("/api/knowledge-files/upload", {
          method: "POST",
          body: formData,
          credentials: "include",
        });
        if (!res.ok) {
          let errorMsg = "Upload failed";
          try {
            const error = await res.json();
            errorMsg = error.message || `Upload failed (${res.status})`;
          } catch {
            errorMsg = `Upload failed with status ${res.status}`;
          }
          throw new Error(errorMsg);
        }
        return res.json();
      } catch (err) {
        if (err instanceof TypeError && err.message.includes("fetch")) {
          throw new Error("Network error - please check your connection and try again");
        }
        throw err;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge-files"] });
      toast({ title: "File uploaded successfully" });
      closeUploadDialog();
    },
    onError: (error: Error) => {
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
    },
  });

  const reindexMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/knowledge-files/${id}/reindex`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge-files"] });
      toast({ title: "Re-indexing started" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to re-index", description: error.message, variant: "destructive" });
    },
  });

  const generateSopMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/knowledge-files/${id}/generate-sop`);
      return res.json();
    },
    onSuccess: (data) => {
      toast({ 
        title: "SOP Created", 
        description: `Created "${data.sop?.title}" with ${data.stepsCount} steps. Go to Articles to review and publish it.` 
      });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to generate SOP", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/knowledge-files/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge-files"] });
      toast({ title: "File deleted successfully" });
      setDeleteFileId(null);
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete file", description: error.message, variant: "destructive" });
    },
  });

  const closeUploadDialog = () => {
    setIsUploadDialogOpen(false);
    setUploadTitle("");
    setUploadDescription("");
    setUploadBranchId("global");
    setUploadLanguage("en");
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      if (!uploadTitle) {
        setUploadTitle(file.name.replace(/\.[^/.]+$/, ""));
      }
    }
  };

  const handleUpload = () => {
    if (!selectedFile) return;
    
    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("title", uploadTitle || selectedFile.name);
    if (uploadDescription) formData.append("description", uploadDescription);
    if (uploadBranchId !== "global") formData.append("branchId", uploadBranchId);
    formData.append("language", uploadLanguage);
    
    uploadMutation.mutate(formData);
  };

  const getFileIcon = (fileType: string) => {
    switch (fileType) {
      case "pdf": return <FileText className="h-5 w-5 text-red-500" />;
      case "image": return <FileImage className="h-5 w-5 text-blue-500" />;
      case "video": return <FileVideo className="h-5 w-5 text-purple-500" />;
      default: return <FileText className="h-5 w-5" />;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "indexed":
        return <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"><CheckCircle className="h-3 w-3 mr-1" />Indexed</Badge>;
      case "processing":
        return <Badge variant="secondary" className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"><Clock className="h-3 w-3 mr-1" />Processing</Badge>;
      case "failed":
        return <Badge variant="secondary" className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"><AlertCircle className="h-3 w-3 mr-1" />Failed</Badge>;
      default:
        return <Badge variant="secondary" className="bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"><Clock className="h-3 w-3 mr-1" />Pending</Badge>;
    }
  };

  const filteredFiles = files.filter(file => 
    !searchQuery || 
    file.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    file.filename.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const formatFileSize = (bytes: number | null) => {
    if (!bytes) return "Unknown size";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search files..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="input-search-files"
          />
        </div>
        <div className="flex gap-2">
          <Select value={filterType} onValueChange={setFilterType}>
            <SelectTrigger className="w-[130px]" data-testid="select-file-type">
              <Filter className="h-4 w-4 mr-2" />
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="pdf">PDFs</SelectItem>
              <SelectItem value="image">Images</SelectItem>
              <SelectItem value="video">Videos</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-[130px]" data-testid="select-status">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="indexed">Indexed</SelectItem>
              <SelectItem value="processing">Processing</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={() => setIsUploadDialogOpen(true)} data-testid="button-upload-file">
            <Upload className="h-4 w-4 mr-2" />
            Upload
          </Button>
        </div>
      </div>

      <div
        className={`relative rounded-lg transition-colors ${isDragOver ? "bg-primary/10 border-2 border-dashed border-primary" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        data-testid="drop-zone"
      >
        {isDragOver && (
          <div className="absolute inset-0 flex items-center justify-center bg-primary/5 rounded-lg z-10 pointer-events-none">
            <div className="flex flex-col items-center gap-2 text-primary">
              <Upload className="h-12 w-12" />
              <p className="text-lg font-medium">Drop file here to upload</p>
            </div>
          </div>
        )}
        
        {filteredFiles.length === 0 ? (
          <div className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-8">
            <EmptyState
              icon={FileText}
              title="No files uploaded"
              description="Drag and drop files here, or click to upload PDFs, images, or videos for the ASK OTO AI assistant."
              action={
                <Button onClick={() => setIsUploadDialogOpen(true)}>
                  <Upload className="h-4 w-4 mr-2" />
                  Upload File
                </Button>
              }
            />
          </div>
        ) : (
          <div className="grid gap-3">
            {filteredFiles.map((file) => (
            <Card key={file.id} className="hover-elevate" data-testid={`card-file-${file.id}`}>
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  {getFileIcon(file.fileType)}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-medium truncate">{file.title || file.filename}</h3>
                      {getStatusBadge(file.indexStatus)}
                    </div>
                    <div className="text-sm text-muted-foreground flex flex-wrap gap-2">
                      <span>{formatFileSize(file.sizeBytes)}</span>
                      {file.pageCount && <span>{file.pageCount} pages</span>}
                      <span>{format(new Date(file.createdAt), "MMM d, yyyy")}</span>
                    </div>
                    {file.indexError && (
                      <p className="text-xs text-destructive mt-1">{file.indexError}</p>
                    )}
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => { setViewingFile(file); setIsViewDialogOpen(true); }}
                      data-testid={`button-view-${file.id}`}
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                    {file.fileType === "pdf" && isAdmin && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => reindexMutation.mutate(file.id)}
                          disabled={reindexMutation.isPending}
                          data-testid={`button-reindex-${file.id}`}
                          title="Re-index file"
                        >
                          <RefreshCw className={`h-4 w-4 ${reindexMutation.isPending ? "animate-spin" : ""}`} />
                        </Button>
                        {file.indexStatus === "indexed" && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => generateSopMutation.mutate(file.id)}
                            disabled={generateSopMutation.isPending}
                            data-testid={`button-generate-sop-${file.id}`}
                            title="Generate SOP from this file"
                          >
                            <Wand2 className={`h-4 w-4 ${generateSopMutation.isPending ? "animate-pulse" : ""}`} />
                          </Button>
                        )}
                      </>
                    )}
                    {isAdmin && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setDeleteFileId(file.id)}
                        data-testid={`button-delete-${file.id}`}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
          </div>
        )}
      </div>

      <Dialog open={isUploadDialogOpen} onOpenChange={setIsUploadDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Upload Knowledge File</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="file">File (PDF, Image, or Video)</Label>
              {selectedFile ? (
                <div className="mt-1 p-3 rounded-md bg-muted flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <FileText className="h-5 w-5 text-primary shrink-0" />
                    <div className="min-w-0">
                      <p className="font-medium truncate">{selectedFile.name}</p>
                      <p className="text-xs text-muted-foreground">{formatFileSize(selectedFile.size)}</p>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setSelectedFile(null);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }}
                    data-testid="button-remove-file"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <Input
                  ref={fileInputRef}
                  id="file"
                  type="file"
                  accept=".pdf,image/*,video/*"
                  onChange={handleFileSelect}
                  className="mt-1"
                  data-testid="input-file-upload"
                />
              )}
            </div>
            <div>
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={uploadTitle}
                onChange={(e) => setUploadTitle(e.target.value)}
                placeholder="Document title"
                className="mt-1"
                data-testid="input-file-title"
              />
            </div>
            <div>
              <Label htmlFor="description">Description (Optional)</Label>
              <Textarea
                id="description"
                value={uploadDescription}
                onChange={(e) => setUploadDescription(e.target.value)}
                placeholder="Brief description of the document"
                className="mt-1"
                data-testid="input-file-description"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="branch">Branch</Label>
                <Select value={uploadBranchId} onValueChange={setUploadBranchId}>
                  <SelectTrigger id="branch" className="mt-1" data-testid="select-file-branch">
                    <SelectValue placeholder="Select branch" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="global">Global (All Branches)</SelectItem>
                    {branches.map((branch) => (
                      <SelectItem key={branch.id} value={branch.id}>{branch.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="language">Language</Label>
                <Select value={uploadLanguage} onValueChange={setUploadLanguage}>
                  <SelectTrigger id="language" className="mt-1" data-testid="select-file-language">
                    <SelectValue placeholder="Language" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="en">English</SelectItem>
                    <SelectItem value="th">Thai</SelectItem>
                    <SelectItem value="ru">Russian</SelectItem>
                    <SelectItem value="zh">Chinese</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={closeUploadDialog}>Cancel</Button>
            <Button
              onClick={handleUpload}
              disabled={!selectedFile || uploadMutation.isPending}
              data-testid="button-submit-upload"
            >
              {uploadMutation.isPending ? "Uploading..." : "Upload"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {viewingFile && getFileIcon(viewingFile.fileType)}
              {viewingFile?.title || viewingFile?.filename}
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto space-y-4">
            {viewingFile && (
              <>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Status:</span>{" "}
                    {getStatusBadge(viewingFile.indexStatus)}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Size:</span>{" "}
                    {formatFileSize(viewingFile.sizeBytes)}
                  </div>
                  {viewingFile.pageCount && (
                    <div>
                      <span className="text-muted-foreground">Pages:</span>{" "}
                      {viewingFile.pageCount}
                    </div>
                  )}
                  <div>
                    <span className="text-muted-foreground">Uploaded:</span>{" "}
                    {format(new Date(viewingFile.createdAt), "MMM d, yyyy HH:mm")}
                  </div>
                </div>
                {viewingFile.description && (
                  <div>
                    <h4 className="font-medium text-sm mb-1">Description</h4>
                    <p className="text-sm text-muted-foreground">{viewingFile.description}</p>
                  </div>
                )}
                {chunks.length > 0 && (
                  <div>
                    <h4 className="font-medium text-sm mb-2">Extracted Text Chunks ({chunks.length})</h4>
                    <div className="space-y-2 max-h-[300px] overflow-auto">
                      {chunks.slice(0, 10).map((chunk) => (
                        <div key={chunk.id} className="p-2 bg-muted rounded text-xs">
                          <span className="font-medium text-muted-foreground">Chunk {chunk.chunkIndex + 1}:</span>{" "}
                          {chunk.text.slice(0, 200)}...
                        </div>
                      ))}
                      {chunks.length > 10 && (
                        <p className="text-xs text-muted-foreground">
                          ...and {chunks.length - 10} more chunks
                        </p>
                      )}
                    </div>
                  </div>
                )}
                {viewingFile.indexError && (
                  <div className="p-3 bg-destructive/10 rounded">
                    <h4 className="font-medium text-sm text-destructive mb-1">Indexing Error</h4>
                    <p className="text-sm text-destructive">{viewingFile.indexError}</p>
                  </div>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteFileId} onOpenChange={() => setDeleteFileId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete File</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this file? This will also remove all extracted text chunks. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteFileId && deleteMutation.mutate(deleteFileId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
