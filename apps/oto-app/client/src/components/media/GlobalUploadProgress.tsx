import { useState, useEffect } from "react";
import { uploadQueue, UploadItem } from "@/lib/uploadQueue";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { X, RefreshCw, CheckCircle, AlertCircle, Upload, Video, Image as ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function GlobalUploadProgress() {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [isExpanded, setIsExpanded] = useState(true);

  useEffect(() => {
    return uploadQueue.subscribe(setItems);
  }, []);

  const activeItems = items.filter(
    (i) => i.status !== "completed"
  );

  if (activeItems.length === 0) {
    return null;
  }

  const totalProgress = activeItems.length > 0
    ? Math.round(activeItems.reduce((sum, i) => sum + i.progress, 0) / activeItems.length)
    : 0;

  return (
    <div 
      className="fixed bottom-4 right-4 z-[100] bg-card border rounded-lg shadow-lg w-80 overflow-hidden"
      data-testid="container-global-upload-progress"
    >
      <div 
        className="flex items-center justify-between p-3 bg-muted/50 cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
        data-testid="button-upload-header"
      >
        <div className="flex items-center gap-2">
          <Upload className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium" data-testid="text-upload-count">
            Uploading {activeItems.length} file{activeItems.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground" data-testid="text-upload-progress">{totalProgress}%</span>
          <Button 
            size="icon" 
            variant="ghost" 
            className="h-6 w-6"
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(!isExpanded);
            }}
            data-testid="button-toggle-upload-panel"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {!isExpanded && (
        <Progress value={totalProgress} className="h-1" />
      )}

      {isExpanded && (
        <div className="max-h-64 overflow-y-auto">
          {activeItems.map((item) => (
            <UploadItemRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function UploadItemRow({ item }: { item: UploadItem }) {
  const isVideo = item.file.type.startsWith("video/");
  const Icon = isVideo ? Video : ImageIcon;

  return (
    <div className="flex items-center gap-3 p-3 border-t" data-testid={`container-upload-item-${item.id}`}>
      <div className="relative h-10 w-10 rounded overflow-hidden bg-muted flex-shrink-0">
        {item.thumbnailUrl ? (
          <img
            src={item.thumbnailUrl}
            alt=""
            className="h-full w-full object-cover"
            data-testid={`img-upload-thumbnail-${item.id}`}
          />
        ) : (
          <div className="h-full w-full flex items-center justify-center">
            <Icon className="h-5 w-5 text-muted-foreground" />
          </div>
        )}
        {isVideo && (
          <div className="absolute bottom-0.5 right-0.5 bg-black/70 text-white text-[10px] px-1 rounded">
            VID
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-xs truncate" title={item.file.name} data-testid={`text-upload-filename-${item.id}`}>
          {item.file.name}
        </p>
        <div className="flex items-center gap-2 mt-1">
          {item.status === "failed" ? (
            <div className="flex items-center gap-1 text-destructive">
              <AlertCircle className="h-3 w-3" />
              <span className="text-xs" data-testid={`text-upload-error-${item.id}`}>{item.error || "Failed"}</span>
            </div>
          ) : item.status === "completed" ? (
            <div className="flex items-center gap-1 text-green-600">
              <CheckCircle className="h-3 w-3" />
              <span className="text-xs" data-testid={`text-upload-complete-${item.id}`}>Complete</span>
            </div>
          ) : (
            <>
              <Progress value={item.progress} className="h-1 flex-1" />
              <span className="text-xs text-muted-foreground w-8" data-testid={`text-upload-item-progress-${item.id}`}>
                {item.progress}%
              </span>
            </>
          )}
        </div>
      </div>

      {item.status === "failed" && (
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 flex-shrink-0"
          onClick={() => uploadQueue.retryItem(item.id)}
          title="Retry"
          data-testid={`button-retry-upload-${item.id}`}
        >
          <RefreshCw className="h-3 w-3" />
        </Button>
      )}

      <Button
        size="icon"
        variant="ghost"
        className="h-6 w-6 flex-shrink-0"
        onClick={() => uploadQueue.removeItem(item.id)}
        title="Remove"
        data-testid={`button-remove-upload-${item.id}`}
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}
