/**
 * Where the other apps of the suite answer, for the links this app shows.
 *
 * Read at build time: Vite writes `import.meta.env.VITE_*` into the bundle,
 * which is how VITE_HR_APP_URL already reaches the "Open in HR" links, each
 * one declared as a build argument in the Dockerfile. The name is the one the
 * launcher reads for the same address, so a deployment sets it once per app.
 *
 * Unset, the link points at `/console` on this host: a placeholder that reads
 * as what it is, rather than a fallback to some other host that a deployment
 * forgets to override.
 */
export const CONSOLE_URL: string = import.meta.env.VITE_CONSOLE_URL || "/console";
