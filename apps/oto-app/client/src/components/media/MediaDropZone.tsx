import { useState, useCallback } from "react";
import { Upload } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { uploadQueue } from "@/lib/uploadQueue";
import { cn } from "@/lib/utils";

interface MediaDropZoneProps {
  target: "checklist" | "item";
  checklistTemplateId?: string;
  checklistTemplateItemId?: string;
  onUploadComplete: (attachment: any) => void;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  isPending?: boolean;
  pendingChecklistId?: string;
  pendingItemIndex?: number;
}

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_VIDEO_SIZE = 200 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1920;

export function MediaDropZone({
  target,
  checklistTemplateId,
  checklistTemplateItemId,
  onUploadComplete,
  children,
  className,
  disabled = false,
  isPending = false,
  pendingChecklistId,
  pendingItemIndex,
}: MediaDropZoneProps) {
  const { toast } = useToast();
  const [isDragOver, setIsDragOver] = useState(false);

  const compressImage = async (file: File): Promise<File> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;

        if (width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION) {
          URL.revokeObjectURL(img.src);
          resolve(file);
          return;
        }

        if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
          const ratio = Math.min(MAX_IMAGE_DIMENSION / width, MAX_IMAGE_DIMENSION / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");

        if (!ctx) {
          URL.revokeObjectURL(img.src);
          resolve(file);
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(img.src);
            if (blob && blob.size < file.size) {
              resolve(new File([blob], file.name, { type: "image/jpeg" }));
            } else {
              resolve(file);
            }
          },
          "image/jpeg",
          0.85
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(img.src);
        resolve(file);
      };
      img.src = URL.createObjectURL(file);
    });
  };

  const handleFiles = useCallback(async (files: FileList) => {
    for (const file of Array.from(files)) {
      const isImage = ALLOWED_IMAGE_TYPES.includes(file.type) || file.type.startsWith("image/");
      const isVideo = ALLOWED_VIDEO_TYPES.includes(file.type) || file.type.startsWith("video/");

      if (!isImage && !isVideo) {
        toast({
          title: "Unsupported file",
          description: `${file.name} is not a supported image or video format`,
          variant: "destructive",
        });
        continue;
      }

      if (isImage && file.size > MAX_IMAGE_SIZE) {
        toast({
          title: "File too large",
          description: `${file.name} exceeds the 10MB limit`,
          variant: "destructive",
        });
        continue;
      }

      if (isVideo && file.size > MAX_VIDEO_SIZE) {
        toast({
          title: "File too large",
          description: `${file.name} exceeds the 200MB limit`,
          variant: "destructive",
        });
        continue;
      }

      let fileToUpload = file;
      if (isImage) {
        fileToUpload = await compressImage(file);
      }

      uploadQueue.addUpload(fileToUpload, target, {
        checklistTemplateId,
        checklistTemplateItemId,
        isPending,
        pendingChecklistId,
        pendingItemIndex,
        onComplete: onUploadComplete,
      });

      toast({
        title: "Upload started",
        description: `${file.name} is uploading in the background`,
      });
    }
  }, [target, checklistTemplateId, checklistTemplateItemId, onUploadComplete, toast]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) {
      setIsDragOver(true);
    }
  }, [disabled]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    if (disabled) return;

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFiles(files);
    }
  }, [disabled, handleFiles]);

  return (
    <div
      className={cn("relative", className)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-testid="container-media-dropzone"
    >
      {children}
      
      {isDragOver && (
        <div 
          className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-primary/10 border-2 border-dashed border-primary rounded-lg pointer-events-none"
          data-testid="overlay-drop-indicator"
        >
          <div className="bg-background/95 rounded-lg p-6 shadow-lg flex flex-col items-center gap-3">
            <Upload className="h-10 w-10 text-primary" />
            <div className="text-center">
              <p className="text-lg font-medium text-foreground">Drop files here</p>
              <p className="text-sm text-muted-foreground">Images and videos supported</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
