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
