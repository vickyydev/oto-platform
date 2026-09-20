/**
 * How a box's state reads to somebody deciding whether to stand at a till.
 *
 * `online` and `offline` are the watchdog's verdict from the heartbeat age and
 * never the box's own claim — a box that has crashed cannot tell anybody it is
 * down, and that silence is the signal. A state this POS has not heard of is
 * shown as it arrived rather than dropped, because a blank where a warning
 * should be is the worst of the three outcomes.
 */
const BOX_STATE: Record<string, { label: string; tone: string }> = {
  online: { label: 'online', tone: 'text-emerald-600 dark:text-emerald-400' },
  offline: { label: 'not answering', tone: 'text-destructive' },
  unclaimed: { label: 'not registered yet', tone: 'text-amber-600 dark:text-amber-400' },
  disabled: { label: 'switched off', tone: 'text-amber-600 dark:text-amber-400' },
};

export function boxState(
  status: string | null | undefined,
): { label: string; tone: string } | null {
  if (!status) return null;
  return BOX_STATE[status] ?? { label: status, tone: 'text-muted-foreground' };
}

/** Heartbeat age in the coarsest unit that still says something useful. */
export function heardFrom(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s}s ago`;
  const minutes = Math.round(s / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}
