import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Camera, FileText, Image, Paperclip, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  FIX_COMMENT_MEDIA_ACCEPT,
  FIX_COMMENT_MEDIA_TYPES,
  MAX_FIX_MEDIA,
  MAX_FIX_MEDIA_SIZE,
} from "@/lib/media";
import { recheckFixReportIfRefused } from "@/lib/fix-report-unavailable";
import { apiRequest, queryClient } from "@/lib/queryClient";

type SelectedFile = { file: File; url: string };

interface FixCommentComposerProps {
  reportId: string;
  placeholder: string;
  inputTestId: string;
  sendTestId: string;
  onPosted?: () => void;
}

/**
 * Adding an update to a Fix report: words, attachments from the camera or the
 * gallery, or both. Attachments go up through the Fix upload, as a report's do,
 * and the comment then claims them. The author is the server's session.
 */
export function FixCommentComposer({ reportId, placeholder, inputTestId, sendTestId, onPosted }: FixCommentComposerProps) {
  const { toast } = useToast();
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<SelectedFile[]>([]);
  const selectedRef = useRef<SelectedFile[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  // Previews are object URLs, released on removal, on sending and on unmount.
  useEffect(() => () => {
    selectedRef.current.forEach(({ url }) => URL.revokeObjectURL(url));
  }, []);

  const replaceSelected = (next: SelectedFile[]) => {
    selectedRef.current = next;
    setSelected(next);
  };

  const handleFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (files.length === 0) return;
    const unsupported = files.find((file) => !FIX_COMMENT_MEDIA_TYPES.has(file.type));
    const oversized = files.find((file) => file.size > MAX_FIX_MEDIA_SIZE);
    if (unsupported || oversized || selectedRef.current.length + files.length > MAX_FIX_MEDIA) {
      toast({
        title: "Can't add file",
        description: unsupported
          ? `${unsupported.name}: choose a JPEG, PNG, WebP, MP4, MOV or PDF file.`
          : oversized
            ? `${oversized.name} is over 20 MB. Choose a smaller file.`
            : `You can add up to ${MAX_FIX_MEDIA} files. Remove some or choose fewer files.`,
        variant: "destructive",
      });
      return;
    }
    replaceSelected([...selectedRef.current, ...files.map((file) => ({ file, url: URL.createObjectURL(file) }))]);
  };

  const removeFile = (index: number) => {
    URL.revokeObjectURL(selectedRef.current[index].url);
    replaceSelected(selectedRef.current.filter((_, i) => i !== index));
  };

  const post = useMutation({
    mutationFn: async () => {
      let media: string[] = [];
      if (selected.length > 0) {
        const form = new FormData();
        selected.forEach(({ file }) => form.append("media", file));
        const upload = await fetch("/api/fix-reports/upload?purpose=comment", {
          method: "POST",
          body: form,
          credentials: "include",
        });
        if (!upload.ok) {
          const body = await upload.json().catch(() => null);
          throw new Error(body?.message || `Upload failed (${upload.status}). Check file types and the 20 MB limit, then try again.`);
        }
        media = (await upload.json()).urls;
      }
      await apiRequest("POST", `/api/fix-reports/${reportId}/comments`, { message: message.trim(), media });
    },
    onSuccess: () => {
      toast({ title: "Update added" });
      setMessage("");
      selectedRef.current.forEach(({ url }) => URL.revokeObjectURL(url));
      replaceSelected([]);
      queryClient.invalidateQueries({ queryKey: ["/api/fix-reports", reportId, "details"] });
      onPosted?.();
    },
    onError: (error: Error) => {
      toast({ title: "Failed to add update", description: error.message, variant: "destructive" });
      recheckFixReportIfRefused(reportId, error);
    },
  });

  const canSend = (message.trim().length > 0 || selected.length > 0) && !post.isPending;

  return (
    <div className="p-3 border-t bg-background">
      <input
        ref={cameraRef}
        type="file"
        accept="image/*,video/*"
        capture="environment"
        className="hidden"
        onChange={handleFiles}
        data-testid="input-comment-camera"
      />
      <input
        ref={galleryRef}
        type="file"
        accept={FIX_COMMENT_MEDIA_ACCEPT}
        multiple
        className="hidden"
        onChange={handleFiles}
        data-testid="input-comment-gallery"
      />

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="max-w-sm" data-testid="dialog-comment-file-source">
          <DialogHeader>
            <DialogTitle>Add photo or file</DialogTitle>
            <DialogDescription>Use the camera, or choose existing photos, videos and PDF files.</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3">
            <Button onClick={() => { setPickerOpen(false); cameraRef.current?.click(); }} data-testid="button-comment-camera">
              <Camera className="mr-2 h-4 w-4" />Camera
            </Button>
            <Button variant="outline" onClick={() => { setPickerOpen(false); galleryRef.current?.click(); }} data-testid="button-comment-gallery">
              <Image className="mr-2 h-4 w-4" />Choose from Gallery
            </Button>
          </DialogBody>
        </DialogContent>
      </Dialog>

      {selected.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2" data-testid="comment-file-previews">
          {selected.map(({ file, url }, index) => (
            <div key={url} className="relative w-14 h-14 rounded-md overflow-hidden bg-muted">
              {file.type.startsWith("video/") ? (
                <video src={url} preload="metadata" muted playsInline aria-label={file.name} className="w-full h-full object-cover" />
              ) : file.type === "application/pdf" ? (
                <div className="w-full h-full flex flex-col items-center justify-center gap-0.5 px-1">
                  <FileText className="w-5 h-5 text-muted-foreground" />
                  <span className="w-full truncate text-center text-[9px] text-muted-foreground">{file.name}</span>
                </div>
              ) : (
                <img src={url} alt={file.name} className="w-full h-full object-cover" />
              )}
              <button
                type="button"
                className="absolute top-0.5 right-0.5 bg-black/60 rounded-full p-0.5"
                onClick={() => removeFile(index)}
                disabled={post.isPending}
                aria-label={`Remove ${file.name}`}
                data-testid={`button-remove-comment-file-${index}`}
              >
                <X className="w-2.5 h-2.5 text-white" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          onClick={() => setPickerOpen(true)}
          disabled={post.isPending || selected.length >= MAX_FIX_MEDIA}
          aria-label="Add photo or file"
          data-testid="button-attach-photo"
        >
          <Paperclip className="w-4 h-4" />
        </Button>
        <Input
          placeholder={placeholder}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          className="flex-1"
          onKeyDown={(event) => {
            if (event.key === "Enter" && canSend) post.mutate();
          }}
          data-testid={inputTestId}
        />
        <Button size="icon" onClick={() => canSend && post.mutate()} disabled={!canSend} data-testid={sendTestId}>
          <Send className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
