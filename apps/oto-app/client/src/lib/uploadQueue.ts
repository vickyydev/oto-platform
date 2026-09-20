type UploadStatus = "pending" | "uploading" | "confirming" | "completed" | "failed";

export interface UploadItem {
  id: string;
  file: File;
  target: "checklist" | "item";
  checklistTemplateId?: string;
  checklistTemplateItemId?: string;
  isPending?: boolean;
  pendingChecklistId?: string;
  pendingItemIndex?: number;
  status: UploadStatus;
  progress: number;
  error?: string;
  localPreviewUrl: string;
  thumbnailUrl?: string;
  s3Key?: string;
  attachmentId?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  onComplete?: (attachment: any) => void;
}

type Listener = (items: UploadItem[]) => void;

class UploadQueue {
  private items: Map<string, UploadItem> = new Map();
  private listeners: Set<Listener> = new Set();
  private processing = false;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getItems());
    return () => this.listeners.delete(listener);
  }

  private notify() {
    const items = this.getItems();
    this.listeners.forEach((l) => l(items));
  }

  getItems(): UploadItem[] {
    return Array.from(this.items.values());
  }

  getActiveCount(): number {
    return this.getItems().filter(
      (i) => i.status === "pending" || i.status === "uploading" || i.status === "confirming"
    ).length;
  }

  async addUpload(
    file: File,
    target: "checklist" | "item",
    options: {
      checklistTemplateId?: string;
      checklistTemplateItemId?: string;
      isPending?: boolean;
      pendingChecklistId?: string;
      pendingItemIndex?: number;
      onComplete?: (attachment: any) => void;
    }
  ): Promise<string> {
    const id = crypto.randomUUID();
    const localPreviewUrl = URL.createObjectURL(file);

    const isVideo = file.type.startsWith("video/");
    const isImage = file.type.startsWith("image/");

    const item: UploadItem = {
      id,
      file,
      target,
      checklistTemplateId: options.checklistTemplateId,
      checklistTemplateItemId: options.checklistTemplateItemId,
      isPending: options.isPending,
      pendingChecklistId: options.pendingChecklistId,
      pendingItemIndex: options.pendingItemIndex,
      status: "pending",
      progress: 0,
      localPreviewUrl,
      thumbnailUrl: localPreviewUrl,
      onComplete: options.onComplete,
    };

    this.items.set(id, item);
    this.notify();

    this.extractMetadataAsync(id, file, isImage, isVideo);

    this.processQueue();

    return id;
  }

  private async extractMetadataAsync(id: string, file: File, isImage: boolean, isVideo: boolean) {
    try {
      if (isImage) {
        const dims = await this.getImageDimensionsWithTimeout(file);
        this.updateItem(id, { width: dims.width, height: dims.height });
      }

      if (isVideo) {
        const meta = await this.getVideoMetadataWithTimeout(file);
        this.updateItem(id, {
          width: meta.width,
          height: meta.height,
          durationSeconds: meta.duration,
          thumbnailUrl: meta.thumbnailUrl || this.items.get(id)?.localPreviewUrl,
        });
      }
    } catch (e) {
      console.warn("[UploadQueue] Failed to extract metadata:", e);
    }
  }

  private getImageDimensionsWithTimeout(file: File, timeout = 5000): Promise<{ width: number; height: number }> {
    return Promise.race([
      this.getImageDimensions(file),
      new Promise<{ width: number; height: number }>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), timeout)
      ),
    ]).catch(() => ({ width: 0, height: 0 }));
  }

  private getVideoMetadataWithTimeout(
    file: File,
    timeout = 5000
  ): Promise<{ width: number; height: number; duration: number; thumbnailUrl?: string }> {
    return Promise.race([
      this.getVideoMetadata(file),
      new Promise<{ width: number; height: number; duration: number; thumbnailUrl?: string }>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), timeout)
      ),
    ]).catch(() => ({ width: 0, height: 0, duration: 0 }));
  }

  private async processQueue() {
    if (this.processing) return;
    this.processing = true;

    while (true) {
      const pending = this.getItems().find((i) => i.status === "pending");
      if (!pending) break;

      await this.uploadItem(pending);
    }

    this.processing = false;
  }

  private async uploadItem(item: UploadItem) {
    try {
      this.updateItem(item.id, { status: "uploading", progress: 5 });

      const presignResponse = await fetch("/api/checklist-media/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          fileName: item.file.name,
          mimeType: item.file.type,
          size: item.file.size,
          target: item.target,
          checklistTemplateId: item.isPending ? undefined : item.checklistTemplateId,
          checklistTemplateItemId: item.isPending ? undefined : item.checklistTemplateItemId,
          pendingChecklistId: item.pendingChecklistId,
          pendingItemIndex: item.pendingItemIndex,
        }),
      });

      if (!presignResponse.ok) {
        const err = await presignResponse.json();
        throw new Error(err.error || "Failed to get upload URL");
      }

      const { uploadUrl, s3Key } = await presignResponse.json();
      this.updateItem(item.id, { s3Key, progress: 10 });

      await this.uploadToS3(item, uploadUrl);

      this.updateItem(item.id, { status: "confirming", progress: 95 });

      const confirmResponse = await fetch("/api/checklist-media/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          type: item.file.type.startsWith("image/") ? "image" : "video",
          s3Key,
          mimeType: item.file.type,
          fileSize: item.file.size,
          originalFilename: item.file.name,
          checklistTemplateId: item.isPending ? undefined : item.checklistTemplateId,
          checklistTemplateItemId: item.isPending ? undefined : item.checklistTemplateItemId,
          pendingChecklistId: item.pendingChecklistId,
          pendingItemIndex: item.pendingItemIndex,
          width: item.width && item.width > 0 ? item.width : undefined,
          height: item.height && item.height > 0 ? item.height : undefined,
          durationSeconds: item.durationSeconds && item.durationSeconds > 0 ? item.durationSeconds : undefined,
        }),
      });

      if (!confirmResponse.ok) {
        const err = await confirmResponse.json();
        throw new Error(err.error || "Failed to confirm upload");
      }

      const { attachment } = await confirmResponse.json();
      
      this.updateItem(item.id, {
        status: "completed",
        progress: 100,
        attachmentId: attachment.id,
      });

      if (item.onComplete) {
        item.onComplete({
          ...attachment,
          localPreviewUrl: item.localPreviewUrl,
        });
      }

      setTimeout(() => this.removeItem(item.id), 3000);
    } catch (error) {
      console.error("[UploadQueue] Upload failed:", error);
      this.updateItem(item.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "Upload failed",
      });
    }
  }

  private uploadToS3(item: UploadItem, uploadUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          const progress = Math.round((e.loaded / e.total) * 80) + 10;
          this.updateItem(item.id, { progress: Math.min(progress, 90) });
        }
      });

      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`S3 upload failed: ${xhr.status}`));
        }
      });

      xhr.addEventListener("error", () => reject(new Error("Network error during upload")));
      xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")));

      xhr.open("PUT", uploadUrl);
      xhr.setRequestHeader("Content-Type", item.file.type);
      xhr.send(item.file);
    });
  }

  private updateItem(id: string, updates: Partial<UploadItem>) {
    const item = this.items.get(id);
    if (item) {
      Object.assign(item, updates);
      this.notify();
    }
  }

  removeItem(id: string) {
    const item = this.items.get(id);
    if (item) {
      URL.revokeObjectURL(item.localPreviewUrl);
      if (item.thumbnailUrl && item.thumbnailUrl !== item.localPreviewUrl) {
        URL.revokeObjectURL(item.thumbnailUrl);
      }
    }
    this.items.delete(id);
    this.notify();
  }

  retryItem(id: string) {
    const item = this.items.get(id);
    if (item && item.status === "failed") {
      this.updateItem(id, { status: "pending", progress: 0, error: undefined });
      this.processQueue();
    }
  }

  private getImageDimensions(file: File): Promise<{ width: number; height: number }> {
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

  private getVideoMetadata(
    file: File
  ): Promise<{ width: number; height: number; duration: number; thumbnailUrl?: string }> {
    return new Promise((resolve) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      const url = URL.createObjectURL(file);

      video.onloadeddata = () => {
        video.currentTime = Math.min(1, video.duration / 2);
      };

      video.onseeked = () => {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0);
          const thumbnailUrl = canvas.toDataURL("image/jpeg", 0.7);
          resolve({
            width: video.videoWidth,
            height: video.videoHeight,
            duration: Math.round(video.duration),
            thumbnailUrl,
          });
        } else {
          resolve({
            width: video.videoWidth,
            height: video.videoHeight,
            duration: Math.round(video.duration),
          });
        }
        URL.revokeObjectURL(url);
      };

      video.onerror = () => {
        resolve({ width: 0, height: 0, duration: 0 });
        URL.revokeObjectURL(url);
      };

      video.src = url;
    });
  }
}

export const uploadQueue = new UploadQueue();
