/**
 * Time of day at the branch, not on the device. A tablet that never had its
 * clock set, or a manager looking in from another country, should still be
 * greeted by the park's own morning.
 */
export function greeting(timezone?: string | null): string {
  let hour: number;
  try {
    hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        hour: 'numeric',
        hour12: false,
        timeZone: timezone ?? undefined,
      }).format(new Date()),
    );
  } catch {
    hour = new Date().getHours();
  }
  if (!Number.isFinite(hour)) hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** "A", "A and B", "A, B and C" — for a sentence, not a list. */
export function inWords(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
