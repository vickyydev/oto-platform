import { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * One glanceable figure on the Floor Report: an icon, a label, a big number, and
 * an optional sub-line for context. Reused for every headline stat so the report
 * reads as one consistent set of cards (no copy-pasted markup per metric).
 */
export function StatCard({
  icon,
  label,
  value,
  sub,
  size = 'md',
  className,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** 'lg' = the hero revenue number; 'md' = the supporting stats. */
  size?: 'md' | 'lg';
  className?: string;
}) {
  return (
    <Card className={cn('p-5 bg-card/50 flex flex-col gap-2', className)}>
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="text-primary">{icon}</span>
        <span className="text-sm font-medium">{label}</span>
      </div>
      <div
        className={cn(
          'font-bold tabular-nums leading-none',
          size === 'lg' ? 'text-5xl' : 'text-3xl',
        )}
      >
        {value}
      </div>
      {sub && <div className="text-sm text-muted-foreground">{sub}</div>}
    </Card>
  );
}
