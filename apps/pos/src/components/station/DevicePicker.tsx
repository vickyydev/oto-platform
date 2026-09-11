import { Device } from '@/types';
import { cn } from '@/lib/utils';
import { Check, Wifi, Bluetooth } from 'lucide-react';

interface DevicePickerProps {
  devices: Device[];
  selectedId?: string;
  onSelect: (id: string) => void;
}

// Touch-friendly grid of selectable devices. Network devices show their address;
// Bluetooth devices note that pairing happens in iOS Settings.
export function DevicePicker({ devices, selectedId, onSelect }: DevicePickerProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {devices.map((d) => {
        const active = d.id === selectedId;
        return (
          <button
            key={d.id}
            type="button"
            onClick={() => onSelect(d.id)}
            className={cn(
              'rounded-xl border p-4 text-left transition-colors min-h-[88px]',
              active ? 'border-primary bg-primary/10' : 'hover:bg-muted',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">{d.label}</span>
              {active && <Check className="w-5 h-5 text-primary shrink-0" />}
            </div>
            <div className="text-xs text-muted-foreground mt-2 flex items-center gap-1.5">
              {d.connection === 'network' ? (
                <>
                  <Wifi className="w-3.5 h-3.5 shrink-0" />
                  {d.address ?? 'Network'}
                </>
              ) : (
                <>
                  <Bluetooth className="w-3.5 h-3.5 shrink-0" />
                  Paired in iOS Settings
                </>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
