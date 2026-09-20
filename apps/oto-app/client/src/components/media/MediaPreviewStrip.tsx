import { useState, useEffect } from "react";
import { X, Play, Image as ImageIcon, Video, GripVertical, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ChecklistAttachment } from "./MediaUploadButton";

interface MediaPreviewStripProps {
  attachments: ChecklistAttachment[];
  onRemove?: (attachmentId: string) => void;
  onReorder?: (attachmentIds: string[]) => void;
  onPreview?: (index: number) => void;
  compact?: boolean;
  editable?: boolean;
  className?: string;
}

export function MediaPreviewStrip({
  attachments,
  onRemove,
  onReorder,
  onPreview,
  compact = false,
  editable = false,
  className,
}: MediaPreviewStripProps) {
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});
  const [loadingUrls, setLoadingUrls] = useState<Set<string>>(new Set());

  useEffect(() => {
    const fetchUrls = async () => {
      for (const attachment of attachments) {
        if (!thumbnailUrls[attachment.id] && !loadingUrls.has(attachment.id)) {
          setLoadingUrls((prev) => new Set([...prev, attachment.id]));
          try {
            const response = await fetch(`/api/checklist-media/url?s3Key=${encodeURIComponent(attachment.s3Key)}`, {
              credentials: "include",
            });
            if (response.ok) {
              const { url } = await response.json();
              setThumbnailUrls((prev) => ({ ...prev, [attachment.id]: url }));
            }
          } catch (error) {
            console.error("Failed to fetch thumbnail URL:", error);
          } finally {
            setLoadingUrls((prev) => {
              const next = new Set(prev);
              next.delete(attachment.id);
              return next;
            });
          }
        }
      }
    };
    fetchUrls();
  }, [attachments]);

  if (attachments.length === 0) {
    return null;
  }

  const thumbnailSize = compact ? "h-12 w-12" : "h-16 w-16";

  return (
    <div className={cn("flex flex-wrap gap-2", className)} data-testid="media-preview-strip">
      {attachments.map((attachment, index) => (
        <div
          key={attachment.id}
          className={cn(
            "relative group rounded-md border bg-muted",
            thumbnailSize,
            !editable && "overflow-hidden",
            onPreview && "cursor-pointer hover-elevate"
          )}
          onClick={() => onPreview?.(index)}
          data-testid={`media-thumbnail-${attachment.id}`}
        >
          <div className="h-full w-full overflow-hidden rounded-md">
            {loadingUrls.has(attachment.id) ? (
              <div className="flex items-center justify-center h-full w-full">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : thumbnailUrls[attachment.id] ? (
              attachment.type === "image" ? (
                <img
                  src={thumbnailUrls[attachment.id]}
                  alt={attachment.originalFilename || "Attachment"}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="relative h-full w-full bg-black">
                  <video
                    src={thumbnailUrls[attachment.id]}
                    className="h-full w-full object-cover"
                    preload="metadata"
                    muted
                  />
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                    <Play className="h-4 w-4 text-white fill-white" />
                  </div>
                </div>
              )
            ) : (
              <div className="flex items-center justify-center h-full w-full">
                {attachment.type === "image" ? (
                  <ImageIcon className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <Video className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
            )}
          </div>

          {editable && onRemove && (
            <Button
              type="button"
              variant="destructive"
              size="icon"
              className="absolute -top-1 -right-1 h-5 w-5 z-10 shadow-md"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(attachment.id);
              }}
              data-testid={`button-remove-media-${attachment.id}`}
            >
              <X className="h-3 w-3" />
            </Button>
          )}

          {attachment.type === "video" && attachment.durationSeconds && (
            <div className="absolute bottom-0.5 right-0.5 bg-black/70 text-white text-[10px] px-1 rounded">
              {formatDuration(attachment.durationSeconds)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function MediaCount({
  attachments,
  onClick,
  className,
}: {
  attachments: ChecklistAttachment[];
  onClick?: () => void;
  className?: string;
}) {
  if (attachments.length === 0) return null;

  const imageCount = attachments.filter((a) => a.type === "image").length;
  const videoCount = attachments.filter((a) => a.type === "video").length;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      className={cn("text-xs text-muted-foreground gap-1", className)}
      data-testid="button-view-media"
    >
      {imageCount > 0 && (
        <span className="flex items-center gap-0.5">
          <ImageIcon className="h-3 w-3" />
          {imageCount}
        </span>
      )}
      {videoCount > 0 && (
        <span className="flex items-center gap-0.5">
          <Video className="h-3 w-3" />
          {videoCount}
        </span>
      )}
      <span>View media</span>
    </Button>
  );
}
