/**
 * Where the platform API is, as far as this browser is concerned.
 *
 * Every front end reaches the API same-origin through an `/api` prefix — the
 * dev server proxies it and the static site rewrites it — and `/api` is the
 * **only** path either of them forwards. A path the API minted, such as the
 * `previewUrl` on a printout, is written from the API's own root and is
 * therefore not fetchable as it stands: put it in an `<img src>` unchanged and
 * the browser asks the Console's origin, which serves the Console and not a
 * PNG. That is exactly the defect this file exists to stop repeating, and it
 * is invisible to any test that talks to the server directly, because the
 * server never sees the prefix.
 *
 * So anything the browser fetches by URL rather than through the client's
 * `fetch` wrapper goes through here first.
 *
 * It is its own module, with no DOM in it, so a test can import the real
 * function rather than a copy of the rule.
 */
export const API_PREFIX = '/api';

/** Turn an API path into the URL this browser can actually fetch. */
export function apiUrl(path: string): string {
  if (!path.startsWith('/')) throw new Error(`an API path must start with "/": ${path}`);
  return `${API_PREFIX}${path}`;
}
