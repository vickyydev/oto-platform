import { AlertCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cakeUnderNoCakeNote } from "@/lib/beo-ai-preview";

/**
 * The BEO editor's Cake block under No Cake (SCRUM-787): a cake time or notes
 * the BEO holds while its type is No Cake (an AI fill loaded or approved them
 * from a message that did not say whose cake it is, and the type stayed as it
 * was) is shown, with what to choose to keep it, never hidden. Nothing is
 * shown when the type is a cake or nothing sits under No Cake.
 */
export function CakeUnderNoCake({
  cakeMode,
  cakeTime,
  cakeNotes,
  onClear,
  disabled = false,
}: {
  cakeMode: string;
  cakeTime: string;
  cakeNotes: string;
  /** Takes the time and notes away, for a party that has no cake after all. */
  onClear: () => void;
  disabled?: boolean;
}) {
  const note = cakeUnderNoCakeNote(cakeMode, cakeTime, cakeNotes);
  if (!note) return null;
  return (
    <div
      className="mt-2 rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-2 space-y-1 text-xs"
      data-testid="cake-under-no-cake"
    >
      <div className="flex items-start gap-2 text-amber-800 dark:text-amber-200">
        <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
        <span className="flex-1" data-testid="text-cake-under-no-cake">{note}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-5 w-5 text-muted-foreground hover:text-destructive"
          onClick={onClear}
          disabled={disabled}
          title="Clear the cake time and notes"
          data-testid="button-cake-under-no-cake-clear"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
      {cakeTime.trim() && (
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">Cake Time</span>
          <span className="font-mono bg-muted px-2 py-0.5 rounded" data-testid="text-cake-under-no-cake-time">{cakeTime.trim()}</span>
        </div>
      )}
      {cakeNotes.trim() && <p data-testid="text-cake-under-no-cake-notes">{cakeNotes.trim()}</p>}
    </div>
  );
}
