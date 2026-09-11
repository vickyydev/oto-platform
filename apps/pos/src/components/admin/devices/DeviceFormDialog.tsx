import { useEffect, useState } from 'react';
import type { Device, DeviceType, DeviceConnection } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  DEVICE_CONNECTION_LABELS,
  DEVICE_CONNECTION_OPTIONS,
  DEVICE_TYPE_LABELS,
  DEVICE_TYPE_OPTIONS,
} from './deviceLabels';

interface DeviceFormDialogProps {
  open: boolean;
  /** The device being edited, or null when creating a new one. */
  device: Device | null;
  onOpenChange: (open: boolean) => void;
  onSave: (device: Device) => void;
}

interface FormErrors {
  label?: string;
  type?: string;
  connection?: string;
}

/**
 * Create/Edit form for a single device (printer/scanner). The IP address field
 * only shows for network devices — Bluetooth devices are OS-paired and carry no
 * address. Pre-filled when `device` is provided, blank when it's null.
 */
export function DeviceFormDialog({
  open,
  device,
  onOpenChange,
  onSave,
}: DeviceFormDialogProps) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState<DeviceType | ''>('');
  const [connection, setConnection] = useState<DeviceConnection | ''>('');
  const [address, setAddress] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});

  // Reset the fields whenever the dialog opens (for add) or the target changes.
  useEffect(() => {
    if (open) {
      setLabel(device?.label ?? '');
      setType(device?.type ?? '');
      setConnection(device?.connection ?? '');
      setAddress(device?.address ?? '');
      setErrors({});
    }
  }, [open, device]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedLabel = label.trim();
    const nextErrors: FormErrors = {};

    if (!trimmedLabel) nextErrors.label = 'Label is required.';
    if (!type) nextErrors.type = 'Type is required.';
    if (!connection) nextErrors.connection = 'Connection is required.';

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    const trimmedAddress = address.trim();
    onSave({
      id: device?.id ?? crypto.randomUUID(),
      label: trimmedLabel,
      type: type as DeviceType,
      connection: connection as DeviceConnection,
      // Address only applies to network devices; drop it for Bluetooth.
      ...(connection === 'network' && trimmedAddress
        ? { address: trimmedAddress }
        : {}),
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{device ? 'Edit device' : 'Add device'}</DialogTitle>
          <DialogDescription>
            {device
              ? 'Update this printer or scanner.'
              : 'Add a printer or scanner the till can drive.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="device-label">Label</Label>
            <Input
              id="device-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Receipt Printer 1"
              autoFocus
            />
            {errors.label && (
              <p className="text-xs text-destructive">{errors.label}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="device-type">Type</Label>
            <Select
              value={type}
              onValueChange={(v) => setType(v as DeviceType)}
            >
              <SelectTrigger id="device-type">
                <SelectValue placeholder="Select a type" />
              </SelectTrigger>
              <SelectContent>
                {DEVICE_TYPE_OPTIONS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {DEVICE_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.type && (
              <p className="text-xs text-destructive">{errors.type}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="device-connection">Connection</Label>
            <Select
              value={connection}
              onValueChange={(v) => setConnection(v as DeviceConnection)}
            >
              <SelectTrigger id="device-connection">
                <SelectValue placeholder="Select a connection" />
              </SelectTrigger>
              <SelectContent>
                {DEVICE_CONNECTION_OPTIONS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {DEVICE_CONNECTION_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.connection && (
              <p className="text-xs text-destructive">{errors.connection}</p>
            )}
          </div>

          {connection === 'network' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="device-address">IP address</Label>
              <Input
                id="device-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="e.g. 192.168.1.21"
                inputMode="decimal"
              />
              <p className="text-xs text-foreground/40">
                Optional — the local network address the print agent reaches.
              </p>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit">{device ? 'Save changes' : 'Add device'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
