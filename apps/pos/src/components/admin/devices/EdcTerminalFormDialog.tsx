import { useEffect, useState } from 'react';
import type { EdcTerminal } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface EdcTerminalFormDialogProps {
  open: boolean;
  /** The terminal being edited, or null when creating a new one. */
  terminal: EdcTerminal | null;
  onOpenChange: (open: boolean) => void;
  onSave: (terminal: EdcTerminal) => void;
}

interface FormErrors {
  tid?: string;
  label?: string;
}

/**
 * Create/Edit form for a single EDC (card-machine) terminal: its TID and a
 * friendly label. Pre-filled when `terminal` is provided, blank when it's null.
 */
export function EdcTerminalFormDialog({
  open,
  terminal,
  onOpenChange,
  onSave,
}: EdcTerminalFormDialogProps) {
  const [tid, setTid] = useState('');
  const [label, setLabel] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});

  // Reset the fields whenever the dialog opens (for add) or the target changes.
  useEffect(() => {
    if (open) {
      setTid(terminal?.tid ?? '');
      setLabel(terminal?.label ?? '');
      setErrors({});
    }
  }, [open, terminal]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedTid = tid.trim();
    const trimmedLabel = label.trim();
    const nextErrors: FormErrors = {};

    if (!trimmedTid) nextErrors.tid = 'TID is required.';
    if (!trimmedLabel) nextErrors.label = 'Label is required.';

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    onSave({
      id: terminal?.id ?? crypto.randomUUID(),
      tid: trimmedTid,
      label: trimmedLabel,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {terminal ? 'Edit EDC terminal' : 'Add EDC terminal'}
          </DialogTitle>
          <DialogDescription>
            {terminal
              ? 'Update this card terminal’s TID or label.'
              : 'Add a card terminal staff reconcile against at End-of-Day.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edc-tid">TID</Label>
            <Input
              id="edc-tid"
              value={tid}
              onChange={(e) => setTid(e.target.value)}
              placeholder="e.g. TID65703234"
              autoFocus
            />
            {errors.tid && (
              <p className="text-xs text-destructive">{errors.tid}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edc-label">Label</Label>
            <Input
              id="edc-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. EDC 1"
            />
            {errors.label && (
              <p className="text-xs text-destructive">{errors.label}</p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit">
              {terminal ? 'Save changes' : 'Add EDC terminal'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
