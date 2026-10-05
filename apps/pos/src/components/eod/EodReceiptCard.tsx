import type { EodReceipt } from '@oto/shared';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Printer } from 'lucide-react';

const STATUS_WORD: Record<string, string> = {
  queued: 'sent to the printer',
  printed: 'printed',
  failed: 'did not print',
  skipped: 'not printed',
};

/**
 * S2-15a round 2 — UI ADDITION. The End of Day receipt of a closed day: its
 * number on the closing counter's series, where it printed and how the last
 * print went, and Reprint. Shown under the locked banner, read-only like the
 * rest of a closed day.
 */
export function EodReceiptCard({
  receipt,
  reprinting,
  error,
  onReprint,
  compact = false,
}: {
  receipt: EodReceipt | null;
  reprinting: boolean;
  error: string | null;
  onReprint: () => void;
  compact?: boolean;
}) {
  if (!receipt) return null;
  const last = receipt.jobs[receipt.jobs.length - 1];
  const copies = receipt.jobs.filter((j) => j.reprint).length;
  return (
    <Card className={cn(compact ? 'p-4' : 'p-5', 'bg-card/50')}>
      <div className={cn('flex gap-3', compact ? 'flex-col' : 'items-center justify-between')}>
        <div className="flex items-start gap-3 min-w-0">
          <Printer className="w-5 h-5 text-primary shrink-0 mt-0.5" />
          <div className="text-sm min-w-0">
            <div className="font-semibold">
              End of Day receipt{receipt.number ? ` ${receipt.number}` : ''}
            </div>
            <div className="text-muted-foreground">
              {last
                ? `${receipt.stationName ?? 'Counter'} · ${STATUS_WORD[last.status] ?? last.status}${last.deviceLabel ? ` on ${last.deviceLabel}` : ''}`
                : (receipt.note ?? 'Not printed')}
              {copies > 0 && ` · ${copies} ${copies === 1 ? 'copy' : 'copies'}`}
            </div>
            {last && receipt.note && <div className="text-xs text-amber-600">{receipt.note}</div>}
          </div>
        </div>
        <Button
          variant="outline"
          className={cn('gap-2', compact ? 'w-full h-11' : 'shrink-0')}
          onClick={onReprint}
          disabled={reprinting}
        >
          <Printer className="w-4 h-4" />
          Reprint
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-amber-600">
          {error}
        </p>
      )}
    </Card>
  );
}
