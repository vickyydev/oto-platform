import { useState, useEffect, useCallback, useRef } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { X, ChevronLeft, ChevronRight, Play, Pause, Maximize, Loader2, ZoomIn, ZoomOut } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChecklistAttachment } from "./MediaUploadButton";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";

interface MediaViewerModalProps {
  attachments: ChecklistAttachment[];
  startIndex?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MediaViewerModal({
  attachments,
  startIndex = 0,
  open,
  onOpenChange,
}: MediaViewerModalProps) {
  const [currentIndex, setCurrentIndex] = useState(startIndex);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const currentAttachment = attachments[currentIndex];

  useEffect(() => {
    if (open) {
      setCurrentIndex(startIndex);
      setZoom(1);
    }
  }, [open, startIndex]);

  useEffect(() => {
    if (!open || !currentAttachment) return;

    const fetchUrl = async () => {
      setLoading(true);
      setMediaUrl(null);
      try {
        const response = await fetch(
          `/api/checklist-media/url?s3Key=${encodeURIComponent(currentAttachment.s3Key)}`,
          { credentials: "include" }
        );
        if (response.ok) {
          const { url } = await response.json();
          setMediaUrl(url);
        }
      } catch (error) {
        console.error("Failed to fetch media URL:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchUrl();
  }, [open, currentAttachment]);

  const goToPrevious = useCallback(() => {
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : attachments.length - 1));
    setZoom(1);
    setIsPlaying(false);
  }, [attachments.length]);

  const goToNext = useCallback(() => {
    setCurrentIndex((prev) => (prev < attachments.length - 1 ? prev + 1 : 0));
    setZoom(1);
    setIsPlaying(false);
  }, [attachments.length]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!open) return;
      switch (e.key) {
        case "ArrowLeft":
          goToPrevious();
          break;
        case "ArrowRight":
          goToNext();
          break;
        case "Escape":
          onOpenChange(false);
          break;
      }
    },
    [open, goToPrevious, goToNext, onOpenChange]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const togglePlayPause = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleZoomIn = () => setZoom((prev) => Math.min(prev + 0.5, 3));
  const handleZoomOut = () => setZoom((prev) => Math.max(prev - 0.5, 0.5));

  const handleTouchStart = useRef<{ x: number; y: number } | null>(null);

  const onTouchStart = (e: React.TouchEvent) => {
    handleTouchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    if (!handleTouchStart.current) return;
    const deltaX = e.changedTouches[0].clientX - handleTouchStart.current.x;
    const deltaY = e.changedTouches[0].clientY - handleTouchStart.current.y;

    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50) {
      if (deltaX > 0) {
        goToPrevious();
      } else {
        goToNext();
      }
    }
    handleTouchStart.current = null;
  };

  if (!open || !currentAttachment) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[95vw] max-h-[95vh] w-full h-full p-0 bg-black/95 border-none"
        data-testid="media-viewer-modal"
      >
        <VisuallyHidden>
          <DialogTitle>Media Viewer</DialogTitle>
        </VisuallyHidden>

        <Button
          variant="ghost"
          size="icon"
          className="absolute top-2 right-2 z-50 text-white hover:bg-white/20"
          onClick={() => onOpenChange(false)}
          data-testid="button-close-media-viewer"
        >
          <X className="h-6 w-6" />
        </Button>

        <div
          className="relative flex items-center justify-center w-full h-full"
          ref={containerRef}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          {loading ? (
            <Loader2 className="h-12 w-12 animate-spin text-white" />
          ) : mediaUrl ? (
            currentAttachment.type === "image" ? (
              <div
                className="overflow-auto max-w-full max-h-full flex items-center justify-center"
                style={{ transform: `scale(${zoom})`, transition: "transform 0.2s" }}
              >
                <img
                  src={mediaUrl}
                  alt={currentAttachment.originalFilename || "Media"}
                  className="max-w-full max-h-[85vh] object-contain"
                  draggable={false}
                />
              </div>
            ) : (
              <div className="relative max-w-full max-h-[85vh]">
                <video
                  ref={videoRef}
                  src={mediaUrl}
                  className="max-w-full max-h-[85vh]"
                  controls
                  playsInline
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onEnded={() => setIsPlaying(false)}
                />
              </div>
            )
          ) : (
            <div className="text-white text-center">
              <p>Failed to load media</p>
            </div>
          )}

          {attachments.length > 1 && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="absolute left-2 top-1/2 -translate-y-1/2 text-white hover:bg-white/20 h-12 w-12"
                onClick={goToPrevious}
                data-testid="button-media-previous"
              >
                <ChevronLeft className="h-8 w-8" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-white hover:bg-white/20 h-12 w-12"
                onClick={goToNext}
                data-testid="button-media-next"
              >
                <ChevronRight className="h-8 w-8" />
              </Button>
            </>
          )}
        </div>

        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-4">
          {currentAttachment.type === "image" && (
            <div className="flex items-center gap-2 bg-black/50 rounded-full px-3 py-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-white hover:bg-white/20"
                onClick={handleZoomOut}
                disabled={zoom <= 0.5}
              >
                <ZoomOut className="h-4 w-4" />
              </Button>
              <span className="text-white text-sm min-w-[3rem] text-center">{Math.round(zoom * 100)}%</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-white hover:bg-white/20"
                onClick={handleZoomIn}
                disabled={zoom >= 3}
              >
                <ZoomIn className="h-4 w-4" />
              </Button>
            </div>
          )}

          {attachments.length > 1 && (
            <div className="flex items-center gap-1 bg-black/50 rounded-full px-3 py-1">
              {attachments.map((_, index) => (
                <button
                  key={index}
                  className={cn(
                    "w-2 h-2 rounded-full transition-colors",
                    index === currentIndex ? "bg-white" : "bg-white/40 hover:bg-white/60"
                  )}
                  onClick={() => {
                    setCurrentIndex(index);
                    setZoom(1);
                    setIsPlaying(false);
                  }}
                  data-testid={`button-media-dot-${index}`}
                />
              ))}
            </div>
          )}
        </div>

        <div className="absolute top-4 left-4 text-white text-sm bg-black/50 px-3 py-1 rounded-full">
          {currentIndex + 1} / {attachments.length}
        </div>
      </DialogContent>
    </Dialog>
  );
}
