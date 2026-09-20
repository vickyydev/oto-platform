import { Check, Cpu } from 'lucide-react';
import type { ApiBox } from '@/api/platform';
import { boxState, heardFrom } from '@/components/station/boxState';
import { cn } from '@/lib/utils';

/**
 * The boxes standing at this branch.
 *
 * A box is not created here and cannot be: it is a Raspberry Pi already bolted
 * under a counter, which registered itself with the platform when it was
 * switched on. The wizard asks for it before it asks about printers because a
 * printer is reachable through the box it is plugged into and through no other,
 * so the box is what decides which devices there are to offer at all.
 */
export function BoxPicker({
  boxes,
  selectedId,
  onSelect,
}: {
  boxes: ApiBox[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {boxes.map((box) => {
        const active = box.id === selectedId;
        const state = boxState(box.status);
        const devices = box.deviceCount ?? 0;
        return (
          <button
            key={box.id}
            type="button"
            onClick={() => onSelect(box.id)}
            className={cn(
              'rounded-xl border p-4 text-left transition-colors min-h-[88px]',
              active ? 'border-primary bg-primary/10' : 'hover:bg-muted',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold truncate">{box.name}</span>
              {active && <Check className="w-5 h-5 text-primary shrink-0" />}
            </div>
            <div className="text-xs text-muted-foreground mt-2 flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">
                {box.slot}
                {state && (
                  <>
                    {' · '}
                    <span className={state.tone}>{state.label}</span>
                  </>
                )}
                {/* The API's own count of the silence, not this iPad's: a tablet
                    with a wrong clock would otherwise call a healthy box dead. */}
                {typeof box.heartbeatAgeSeconds === 'number' &&
                  ` · heard from ${heardFrom(box.heartbeatAgeSeconds)}`}
              </span>
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {devices} {devices === 1 ? 'device' : 'devices'} reported
              {box.agentVersion ? ` · agent ${box.agentVersion}` : ''}
            </div>
          </button>
        );
      })}
    </div>
  );
}
