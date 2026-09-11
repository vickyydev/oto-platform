import { CheckCircle2, Smartphone, WifiOff } from 'lucide-react';
import { ContactChannel, WaConnectionStatus } from '@/types';
import { CHANNEL_LABEL, normalizeChannel } from '@/lib/contactChannel';

/**
 * Contact-channel connection chip shown on drop-off cards (iPad + mobile shell).
 * 'confirmed' → green, 'pending' → amber, 'failed'/'unverified' → red.
 * Returns null for undefined status (no phone captured yet).
 * Works identically for WhatsApp / Telegram / LINE.
 */
export function WaChip({
  status,
  channel,
}: {
  status: WaConnectionStatus | undefined;
  channel?: ContactChannel;
}) {
  if (!status) return null;
  const label = CHANNEL_LABEL[normalizeChannel(channel)];

  if (status === 'confirmed') {
    return (
      <span className="flex items-center gap-1.5 text-emerald-400 font-semibold text-xs">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
        {label} confirmed
      </span>
    );
  }
  if (status === 'pending') {
    return (
      <span className="flex items-center gap-1.5 text-amber-400 font-semibold text-xs">
        <Smartphone className="w-3.5 h-3.5 shrink-0" />
        Awaiting confirmation
      </span>
    );
  }
  // 'failed' or 'unverified'
  return (
    <span className="flex items-center gap-1.5 text-red-400 font-semibold text-xs">
      <WifiOff className="w-3.5 h-3.5 shrink-0" />
      No connection — update needed
    </span>
  );
}
