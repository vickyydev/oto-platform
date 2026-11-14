/** A persisted moment on the park's calendar, preserving the caller's date format. */
export function parkDayOf(at: string, timeZone?: string | null, locale?: string, options: Intl.DateTimeFormatOptions = {}): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "";
  let zone = "Asia/Bangkok";
  try {
    if (timeZone?.trim()) zone = new Intl.DateTimeFormat("en-GB", { timeZone: timeZone.trim() }).resolvedOptions().timeZone;
  } catch { /* A missing or unknown zone uses the park group's clock. */ }
  return when.toLocaleDateString(locale, { ...options, timeZone: zone });
}
