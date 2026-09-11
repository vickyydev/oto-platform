import { Card } from '@/components/ui/card';
import { CheckCircle2, AlertTriangle, Hourglass } from 'lucide-react';
import { EndOfDay } from '@/types';
import { reconVerdict } from '@/lib/endOfDay';
import { cn } from '@/lib/utils';

/**
 * Prominent bottom-line: total expected vs total actual and the day's net over/short,
 * with a single verdict — green "balanced", red flag when any channel is off, amber
 * while counts are still outstanding.
 */
export function ReconSummary({ record }: { record: EndOfDay }) {
  const verdict = reconVerdict(record);
  const over = record.totalDifferenceTHB;

  const styles = {
    ok: { ring: 'border-emerald-500/40 bg-emerald-500/10', text: 'text-emerald-400', Icon: CheckCircle2, label: 'Balanced' },
    off: { ring: 'border-rose-500/40 bg-rose-500/10', text: 'text-rose-400', Icon: AlertTriangle, label: 'Out of balance' },
    pending: { ring: 'border-amber-500/40 bg-amber-500/10', text: 'text-amber-400', Icon: Hourglass, label: 'Counts outstanding' },
  }[verdict];

  const { Icon } = styles;
  const overText = `${over > 0 ? '+' : over < 0 ? '-' : ''}฿${Math.abs(over).toLocaleString()}`;

  return (
    <Card className={cn('p-5 border', styles.ring)}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className={cn('flex items-center gap-2 font-semibold', styles.text)}>
          <Icon className="w-5 h-5" />
          {styles.label}
        </div>
        <div className="flex items-center gap-6 text-sm">
          <div className="text-right">
            <div className="text-muted-foreground">Expected</div>
            <div className="text-lg font-bold tabular-nums">
              ฿{record.totalExpectedTHB.toLocaleString()}
            </div>
          </div>
          <div className="text-right">
            <div className="text-muted-foreground">Actual</div>
            <div className="text-lg font-bold tabular-nums">
              ฿{record.totalActualTHB.toLocaleString()}
            </div>
          </div>
          <div className="text-right">
            <div className="text-muted-foreground">Over / short</div>
            <div className={cn('text-lg font-bold tabular-nums', styles.text)}>{overText}</div>
          </div>
        </div>
      </div>
    </Card>
  );
}
