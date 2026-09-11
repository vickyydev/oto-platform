import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ReprintItemOption } from '@/components/history/ReprintModal';
import { ArrowLeft, Printer, Check } from 'lucide-react';

interface MobileReprintFlowProps {
  items: ReprintItemOption[];
  operatorName: string;
  onConfirm: (labels: string[]) => void;
  onCancel: () => void;
}

export function MobileReprintFlow({
  items,
  operatorName,
  onConfirm,
  onCancel,
}: MobileReprintFlowProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const allSelected = items.length > 0 && selectedIds.length === items.length;

  const toggle = (id: string) =>
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const toggleAll = () => setSelectedIds(allSelected ? [] : items.map((i) => i.id));

  const handleConfirm = () => {
    if (selectedIds.length === 0) return;
    const labels = items
      .filter((i) => selectedIds.includes(i.id))
      .map((i) => (i.sublabel ? `${i.label} ${i.sublabel}` : i.label));
    onConfirm(labels);
  };

  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 px-4 h-14 border-b bg-card/30">
        <button
          type="button"
          onClick={onCancel}
          className="w-9 h-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 font-bold">
            <Printer className="w-4 h-4 text-primary shrink-0" />
            Reprint
          </div>
          <div className="text-xs text-muted-foreground truncate">By {operatorName}</div>
        </div>
        <button
          type="button"
          onClick={toggleAll}
          className="text-xs font-semibold text-primary hover:text-primary/80 transition-colors px-2"
        >
          {allSelected ? 'Clear all' : 'Select all'}
        </button>
      </div>

      {/* Item list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {items.map((item) => {
          const checked = selectedIds.includes(item.id);
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => toggle(item.id)}
              className={`w-full flex items-center justify-between rounded-xl border p-4 text-left transition-colors ${
                checked
                  ? 'border-primary ring-1 ring-primary/30 bg-primary/10'
                  : 'border-border hover:bg-muted/50'
              }`}
            >
              <span className="flex items-center gap-3 min-w-0">
                <span
                  className={`w-6 h-6 rounded border-2 flex items-center justify-center shrink-0 ${
                    checked
                      ? 'bg-primary border-primary text-primary-foreground'
                      : 'border-muted-foreground/40'
                  }`}
                >
                  {checked && <Check className="w-3.5 h-3.5" />}
                </span>
                <span className="font-medium truncate">{item.label}</span>
              </span>
              {item.sublabel && (
                <span className="text-sm text-muted-foreground tabular-nums shrink-0 ml-2">
                  {item.sublabel}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <div className="shrink-0 p-4 border-t bg-card/20">
        <Button
          className="w-full h-14 text-base gap-2"
          disabled={selectedIds.length === 0}
          onClick={handleConfirm}
        >
          <Printer className="w-5 h-5" />
          {selectedIds.length === 0
            ? 'Select items to reprint'
            : `Reprint ${selectedIds.length} item${selectedIds.length > 1 ? 's' : ''}`}
        </Button>
      </div>
    </div>
  );
}
