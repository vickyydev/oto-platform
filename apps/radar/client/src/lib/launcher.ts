/**
 * The OTO launcher's address, as Radar's server names it in a sign-out or a
 * refusal (`launcherUrl`, from its LAUNCHER_URL setting — SCRUM-529).
 *
 * Only an absolute http(s) URL is used as a place to send the browser; any
 * other value counts as unknown, and the page then offers no launcher link.
 */
export function launcherUrlFrom(body: unknown): string | null {
  const value = (body as { launcherUrl?: unknown } | null | undefined)?.launcherUrl;
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The launcher address with the sign-out marker (`?from=signout`) added, so the
 * launcher can say once that the person left one app and is still signed in to
 * the suite (SCRUM-538). A query, not a fragment: fragments carry the hand-off.
 * Used only where an own sign-out redirects; the "Open the launcher" buttons
 * keep the plain address.
 */
export function withSignOutMarker(launcherUrl: string): string {
  try {
    const url = new URL(launcherUrl);
    url.searchParams.set("from", "signout");
    return url.toString();
  } catch {
    return launcherUrl;
  }
}
