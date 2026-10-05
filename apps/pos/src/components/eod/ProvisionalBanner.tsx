import type { EodProvisionalBox } from '@oto/shared';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Hourglass } from 'lucide-react';

/**
 * S2-15a round 2 — UI ADDITION. The day is provisional while a box of the
 * branch still holds records it has not sent, or its clock is out and not
 * corrected; Close Day is refused until then. Sits where the locked banner
 * sits on a closed day, in the amber the summary uses for "outstanding".
 */
export function ProvisionalBanner({
  boxes,
  onRecheck,
  compact = false,
}: {
  boxes: readonly EodProvisionalBox[];
  onRecheck: () => void;
  compact?: boolean;
}) {
  if (boxes.length === 0) return null;
  return (
    <Card role="status" className="p-4 border border-amber-500/40 bg-amber-500/10 flex items-start gap-3">
      <Hourglass className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
      <div className="text-sm min-w-0 flex-1 space-y-1">
        <div>
          <span className="font-semibold">Day is provisional.</span>{' '}
          <span className="text-muted-foreground">Close Day waits until every box has caught up.</span>
        </div>
        <ul className="text-muted-foreground space-y-0.5">
          {boxes.map((b) => (
            <li key={`${b.boxId}:${b.reason}`}>{b.message}</li>
          ))}
        </ul>
      </div>
      <Button variant="outline" size="sm" className={compact ? 'shrink-0 h-9' : 'shrink-0'} onClick={onRecheck}>
        Check again
      </Button>
    </Card>
  );
}
