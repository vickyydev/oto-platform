import { Card } from '@/components/ui/card';
import { FloorRevenueBucket } from '@/types';

const BAR_COLOR: Record<FloorRevenueBucket['key'], string> = {
  tickets: 'bg-sky-500',
  fnb: 'bg-amber-500',
  merch: 'bg-rose-500',
  parties: 'bg-fuchsia-500',
  dropoff: 'bg-emerald-500',
};

/**
 * Revenue split as horizontal bars (Tickets / F&B / Parties / Drop-off), each
 * showing the ฿ amount and its share of net revenue. Bars are sized relative to
 * the largest bucket so the busiest category is obvious at a glance.
 */
export function RevenueBars({ buckets }: { buckets: FloorRevenueBucket[] }) {
  const total = buckets.reduce((a, b) => a + b.amountTHB, 0);
  const max = Math.max(1, ...buckets.map((b) => b.amountTHB));

  return (
    <Card className="p-5 bg-card/50">
      <div className="text-sm font-medium text-muted-foreground mb-4">Revenue split</div>
      <div className="space-y-4">
        {buckets.map((b) => {
          const pct = total > 0 ? Math.round((b.amountTHB / total) * 100) : 0;
          const width = `${(b.amountTHB / max) * 100}%`;
          return (
            <div key={b.key}>
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-sm font-medium">{b.label}</span>
                <span className="text-sm tabular-nums">
                  <span className="font-semibold">฿{b.amountTHB.toLocaleString()}</span>
                  <span className="text-muted-foreground ml-2">{pct}%</span>
                </span>
              </div>
              <div className="h-2.5 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full ${BAR_COLOR[b.key]} transition-all`}
                  style={{ width }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
