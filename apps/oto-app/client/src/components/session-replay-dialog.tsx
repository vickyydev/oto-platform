import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

interface SessionReplayDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called when the user confirms — receives their description text */
  onConfirm: (description: string) => void;
}

export function SessionReplayDialog({
  open,
  onOpenChange,
  onConfirm,
}: SessionReplayDialogProps) {
  const [description, setDescription] = useState("");

  function handleConfirm() {
    onConfirm(description.trim());
    setDescription("");
    onOpenChange(false);
  }

  function handleCancel() {
    setDescription("");
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Start Recording</DialogTitle>
          <DialogDescription>
            Describe the problem you are experiencing. This will be sent to
            Sentry alongside the session recording.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="replay-description">Description (optional)</Label>
          <Textarea
            id="replay-description"
            placeholder="What went wrong? What were you trying to do?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            className="resize-none"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleConfirm}>Start Recording</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
