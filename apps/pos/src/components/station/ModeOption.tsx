import { type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * One of a short list of mutually exclusive choices, the way the prototype's
 * scanner step draws them. Lifted out of StationSetup unchanged so the steps
 * added in S2-04 make their choices look identical to the ones already there.
 */
export function ModeOption({
  active,
  icon,
  label,
  description,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-xl border p-4 text-left transition-colors flex items-start gap-3',
        active ? 'border-primary bg-primary/10' : 'hover:bg-muted',
      )}
    >
      <div
        className={cn(
          'w-9 h-9 rounded-lg flex items-center justify-center shrink-0',
          active ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground',
        )}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className={cn('font-semibold', active && 'text-primary')}>{label}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{description}</div>
      </div>
      {active && <Check className="w-5 h-5 text-primary shrink-0 mt-1" />}
    </button>
  );
}
