import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Paperclip, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { uploadQueue } from "@/lib/uploadQueue";

interface MediaUploadButtonProps {
  target: "checklist" | "item";
  checklistTemplateId?: string;
  checklistTemplateItemId?: string;
  onUploadComplete: (attachment: ChecklistAttachment) => void;
  variant?: "default" | "ghost" | "outline" | "secondary";
  size?: "default" | "sm" | "icon";
  multiple?: boolean;
  accept?: string;
  className?: string;
  children?: React.ReactNode;
  useDirectUpload?: boolean;
  isPending?: boolean;
  pendingChecklistId?: string;
  pendingItemIndex?: number;
}

export interface ChecklistAttachment {
  id: string;
  tenantId: string;
  checklistTemplateId: string | null;
  checklistTemplateItemId: string | null;
  type: "image" | "video";
  s3Key: string;
  mimeType: string;
  fileSize: number;
  originalFilename: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  sortOrder: number;
  createdByUserId: string | null;
  createdAt: string;
  localPreviewUrl?: string;
}

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_VIDEO_SIZE = 200 * 1024 * 1024; // 200MB
const COMPRESS_TARGET_SIZE = 1 * 1024 * 1024; // Target 1MB for images
const MAX_IMAGE_DIMENSION = 1920; // Max width/height

export function MediaUploadButton({
  target,
  checklistTemplateId,
  checklistTemplateItemId,
  onUploadComplete,
  variant = "ghost",
  size = "sm",
  multiple = false,
  accept = "image/*,video/*",
  className,
  children,
  useDirectUpload = true,
  isPending = false,
  pendingChecklistId,
  pendingItemIndex,
}: MediaUploadButtonProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleClick = () => {
    fileInputRef.current?.click();
  };

  const validateFile = (file: File): { valid: boolean; error?: string } => {
    const isImage = ALLOWED_IMAGE_TYPES.includes(file.type) || file.type.startsWith("image/");
    const isVideo = ALLOWED_VIDEO_TYPES.includes(file.type) || file.type.startsWith("video/");

    if (!isImage && !isVideo) {
      return { valid: false, error: `Unsupported file type: ${file.type}` };
    }

    if (isImage && file.size > MAX_IMAGE_SIZE) {
      return { valid: false, error: `Image too large. Maximum size is 10MB.` };
    }

    if (isVideo && file.size > MAX_VIDEO_SIZE) {
      return { valid: false, error: `Video too large. Maximum size is 200MB.` };
    }

    return { valid: true };
  };

  const compressImage = async (file: File): Promise<File> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;

        if (width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION && file.size <= COMPRESS_TARGET_SIZE) {
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

        const quality = 0.85;
        const targetType = file.type === "image/png" ? "image/png" : "image/jpeg";

        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(img.src);
            if (blob && blob.size < file.size) {
              const compressedFile = new File([blob], file.name, { type: targetType });
              console.log(`[Compress] ${file.name}: ${(file.size / 1024).toFixed(0)}KB -> ${(compressedFile.size / 1024).toFixed(0)}KB`);
              resolve(compressedFile);
            } else {
              resolve(file);
            }
          },
          targetType,
          quality
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(img.src);
        resolve(file);
      };
      img.src = URL.createObjectURL(file);
    });
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsProcessing(true);

    try {
      for (const file of Array.from(files)) {
        const validation = validateFile(file);
        if (!validation.valid) {
          toast({
            title: "Upload failed",
            description: validation.error,
            variant: "destructive",
          });
          continue;
        }

        const isImage = file.type.startsWith("image/");
        let fileToUpload = file;

        if (isImage) {
          fileToUpload = await compressImage(file);
        }

        if (useDirectUpload) {
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
        } else {
          await uploadViaBackend(fileToUpload);
        }
      }
    } finally {
      setIsProcessing(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const uploadViaBackend = async (file: File) => {
    try {
      const isImage = file.type.startsWith("image/");
      const isVideo = file.type.startsWith("video/");

      let width: number | undefined;
      let height: number | undefined;
      let durationSeconds: number | undefined;

      if (isImage) {
        const dims = await getImageDimensions(file);
        width = dims.width;
        height = dims.height;
      }

      if (isVideo) {
        const meta = await getVideoMetadata(file);
        width = meta.width;
        height = meta.height;
        durationSeconds = meta.duration;
      }

      const formData = new FormData();
      formData.append("file", file);
      formData.append("target", target);
      if (target === "checklist" && checklistTemplateId) {
        formData.append("checklistTemplateId", checklistTemplateId);
      }
      if (target === "item" && checklistTemplateItemId) {
        formData.append("checklistTemplateItemId", checklistTemplateItemId);
      }
      if (width) formData.append("width", width.toString());
      if (height) formData.append("height", height.toString());
      if (durationSeconds) formData.append("durationSeconds", durationSeconds.toString());

      const response = await fetch("/api/checklist-media/upload", {
        method: "POST",
        body: formData,
        credentials: "include",
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Upload failed");
      }

      const attachment = await response.json();
      onUploadComplete(attachment);
    } catch (error) {
      console.error("Upload error:", error);
      toast({
        title: "Upload failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={handleFileChange}
        style={{ display: "none" }}
        data-testid="input-media-upload"
      />
      <Button
        type="button"
        variant={variant}
        size={size}
        onClick={handleClick}
        disabled={isProcessing}
        className={className}
        data-testid="button-media-upload"
      >
        {isProcessing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : children ? (
          children
        ) : (
          <Paperclip className="h-4 w-4" />
        )}
      </Button>
    </>
  );
}

async function getImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => {
      resolve({ width: 0, height: 0 });
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  });
}

async function getVideoMetadata(file: File): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      resolve({
        width: video.videoWidth,
        height: video.videoHeight,
        duration: Math.round(video.duration),
      });
      URL.revokeObjectURL(video.src);
    };
    video.onerror = () => {
      resolve({ width: 0, height: 0, duration: 0 });
      URL.revokeObjectURL(video.src);
    };
    video.src = URL.createObjectURL(file);
  });
}
