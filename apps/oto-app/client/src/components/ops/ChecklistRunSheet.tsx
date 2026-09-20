import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

interface ChecklistRunSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runId: string | null;
}

/**
 * Keeps the Ops dashboard mounted while showing the same full checklist
 * experience in a large modal. The iframe intentionally owns its existing
 * mobile/desktop detail layout and mutations.
 */
export function ChecklistRunSheet({ open, onOpenChange, runId }: ChecklistRunSheetProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(96vw,560px)] max-w-[560px] h-[min(92vh,900px)] p-0 gap-0 overflow-hidden"
        data-testid="dialog-checklist-detail"
      >
        <DialogTitle className="sr-only">Checklist Details</DialogTitle>
        <DialogDescription className="sr-only">
          Review checklist items, notes, statuses, and evidence photos.
        </DialogDescription>
        {runId && (
          <iframe
            key={runId}
            src={`/core/checklist/${runId}?embedded=1`}
            title="Checklist full details"
            className="h-full w-full border-0 bg-background"
            data-testid="iframe-checklist-detail"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}