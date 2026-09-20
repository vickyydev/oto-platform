/** A timestamp as the branch would read it, never as the device's clock. */
export function formatWhen(iso: string, timezone?: string | null): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone ?? undefined,
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}
