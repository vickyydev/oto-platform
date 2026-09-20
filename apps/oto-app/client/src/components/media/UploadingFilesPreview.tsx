import { useState, useEffect } from "react";
import { Loader2, Video, Image as ImageIcon, CheckCircle2, AlertCircle } from "lucide-react";
import { uploadQueue, UploadItem } from "@/lib/uploadQueue";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";

interface UploadingFilesPreviewProps {
  pendingChecklistId?: string;
  className?: string;
}

export function UploadingFilesPreview({
  pendingChecklistId,
  className,
}: UploadingFilesPreviewProps) {
  const [uploads, setUploads] = useState<UploadItem[]>([]);

  useEffect(() => {
    const unsubscribe = uploadQueue.subscribe((items) => {
      console.log("[UploadingFilesPreview] Queue items:", items.length, items.map(i => ({ id: i.id, status: i.status, pendingId: i.pendingChecklistId })));
      setUploads(items);
    });
    return unsubscribe;
  }, []);

  const activeUploads = uploads.filter(
    (u) => u.status === "pending" || u.status === "uploading" || u.status === "confirming"
  );

  console.log("[UploadingFilesPreview] Active uploads:", activeUploads.length);

  if (activeUploads.length === 0) {
    return null;
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin" />
        Uploading {activeUploads.length} file{activeUploads.length !== 1 ? "s" : ""}...
      </div>
      <div className="flex flex-wrap gap-2">
        {activeUploads.map((upload) => (
          <UploadingFileItem key={upload.id} upload={upload} />
        ))}
      </div>
    </div>
  );
}

function UploadingFileItem({ upload }: { upload: UploadItem }) {
  const isImage = upload.file.type.startsWith("image/");
  const isVideo = upload.file.type.startsWith("video/");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (isImage) {
      const url = URL.createObjectURL(upload.file);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    }
  }, [upload.file, isImage]);

  const statusIcon = {
    pending: <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />,
    uploading: <Loader2 className="h-4 w-4 animate-spin text-primary" />,
    confirming: <Loader2 className="h-4 w-4 animate-spin text-primary" />,
    completed: <CheckCircle2 className="h-4 w-4 text-green-500" />,
    failed: <AlertCircle className="h-4 w-4 text-destructive" />,
  };

  return (
    <div
      className="relative w-16 h-16 rounded-md border bg-muted overflow-hidden"
      data-testid={`uploading-file-${upload.id}`}
    >
      {previewUrl ? (
        <img
          src={previewUrl}
          alt="Uploading"
          className="w-full h-full object-cover opacity-50"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-muted">
          {isVideo ? (
            <Video className="h-6 w-6 text-muted-foreground" />
          ) : (
            <ImageIcon className="h-6 w-6 text-muted-foreground" />
          )}
        </div>
      )}

      <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40">
        {statusIcon[upload.status]}
        {upload.status === "uploading" && (
          <span className="text-[10px] text-white font-medium mt-0.5">
            {Math.round(upload.progress)}%
          </span>
        )}
      </div>

      {upload.status === "uploading" && (
        <div className="absolute bottom-0 left-0 right-0">
          <Progress value={upload.progress} className="h-1 rounded-none" />
        </div>
      )}
    </div>
  );
}

export function UploadStatusBanner({
  pendingChecklistId,
  className,
}: UploadingFilesPreviewProps) {
  const [uploads, setUploads] = useState<UploadItem[]>([]);

  useEffect(() => {
    const unsubscribe = uploadQueue.subscribe((items) => {
      console.log("[UploadStatusBanner] Queue items:", items.length);
      setUploads(items);
    });
    return unsubscribe;
  }, []);

  const activeCount = uploads.filter(
    (u) => u.status === "pending" || u.status === "uploading" || u.status === "confirming"
  ).length;

  console.log("[UploadStatusBanner] Active count:", activeCount);

  if (activeCount === 0) {
    return null;
  }

  const totalProgress = uploads.reduce((sum, u) => {
    if (u.status === "completed") return sum + 100;
    if (u.status === "uploading") return sum + u.progress;
    return sum;
  }, 0);
  const avgProgress = Math.round(totalProgress / uploads.length);

  return (
    <div
      className={cn(
        "bg-amber-500/10 border border-amber-500/30 rounded-lg p-3",
        className
      )}
    >
      <div className="flex items-center gap-2 text-sm font-medium text-amber-600 dark:text-amber-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>
          Uploading {activeCount} file{activeCount !== 1 ? "s" : ""} ({avgProgress}%)
        </span>
      </div>
      <p className="text-xs text-muted-foreground mt-1">
        Please wait for uploads to complete before saving
      </p>
      <Progress value={avgProgress} className="h-1.5 mt-2" />
    </div>
  );
}
