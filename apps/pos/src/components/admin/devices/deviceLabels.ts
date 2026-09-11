import type { DeviceType, DeviceConnection } from '@/types';

// Human-readable labels for the device taxonomy, shared by the list + form.
export const DEVICE_TYPE_LABELS: Record<DeviceType, string> = {
  receipt_printer: 'Receipt printer',
  bracelet_printer: 'Bracelet printer',
  kitchen_printer: 'Kitchen printer',
  bar_printer: 'Bar printer',
  scanner: 'Scanner',
  gate: 'Gate',
};

export const DEVICE_TYPE_OPTIONS: DeviceType[] = [
  'receipt_printer',
  'bracelet_printer',
  'kitchen_printer',
  'bar_printer',
  'scanner',
  'gate',
];

export const DEVICE_CONNECTION_LABELS: Record<DeviceConnection, string> = {
  network: 'Network',
  bluetooth: 'Bluetooth',
};

export const DEVICE_CONNECTION_OPTIONS: DeviceConnection[] = [
  'network',
  'bluetooth',
];
