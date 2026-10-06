import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Printer } from 'lucide-react';

export interface ReprintItemOption {
  id: string;
  label: string;
  sublabel?: string;
}

interface ReprintModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ReprintItemOption[];
  operatorName: string;
  /**
   * Receives the human labels of every selected artifact and — S2-11 — their
   * ids, which History sends to the platform as the reprint kinds.
   */
  onConfirm: (labels: string[], ids: string[]) => void;
}

export function ReprintModal({
  open,
  onOpenChange,
  items,
  operatorName,
  onConfirm,
}: ReprintModalProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Reset to a clean slate each time the modal opens.
  useEffect(() => {
    if (open) setSelectedIds([]);
  }, [open]);

  const allSelected = items.length > 0 && selectedIds.length === items.length;

  const toggle = (id: string) =>
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const toggleAll = () =>
    setSelectedIds(allSelected ? [] : items.map((i) => i.id));

  const handleConfirm = () => {
    if (selectedIds.length === 0) return;
    const picked = items.filter((i) => selectedIds.includes(i.id));
    const labels = picked.map((i) => (i.sublabel ? `${i.label} ${i.sublabel}` : i.label));
    onConfirm(
      labels,
      picked.map((i) => i.id),
    );
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Printer className="w-5 h-5 text-primary" />
            Reprint
          </DialogTitle>
          <DialogDescription>
            By {operatorName} · pick everything or just the items you need.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-muted-foreground">Items to reprint</p>
            <Button type="button" size="sm" variant="ghost" onClick={toggleAll}>
              {allSelected ? 'Clear all' : 'Select all'}
            </Button>
          </div>

          <div className="space-y-2">
            {items.map((item) => {
              const checked = selectedIds.includes(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => toggle(item.id)}
                  className={`w-full flex items-center justify-between rounded-lg border p-3 text-left transition-colors ${
                    checked ? 'border-primary ring-1 ring-primary bg-primary/5' : 'hover:bg-muted'
                  }`}
                >
                  <span className="flex items-center gap-3 min-w-0">
                    <span
                      className={`w-5 h-5 rounded border flex items-center justify-center shrink-0 text-xs ${
                        checked
                          ? 'bg-primary border-primary text-primary-foreground'
                          : 'border-muted-foreground/40'
                      }`}
                    >
                      {checked ? '✓' : ''}
                    </span>
                    <span className="truncate font-medium">{item.label}</span>
                  </span>
                  {item.sublabel && (
                    <span className="text-sm text-muted-foreground tabular-nums shrink-0">
                      {item.sublabel}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <Button
            className="w-full h-14 text-lg gap-2"
            disabled={selectedIds.length === 0}
            onClick={handleConfirm}
          >
            <Printer className="w-5 h-5" />
            {selectedIds.length === 0
              ? 'Select what to reprint'
              : `Reprint ${selectedIds.length} item${selectedIds.length > 1 ? 's' : ''}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
