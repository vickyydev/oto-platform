/**
 * THE HAND-OFF TARGET (SCRUM-591, prerequisite P1; plan
 * docs/progress/plans/internal-assistant-build/PLAN.md §C).
 *
 * The launcher's hand-off opens an app signed in. P1 lets it land on a screen
 * rather than the app's home: the fragment that carries the token carries an
 * optional path beside it, `#handoff=<token>&to=<encoded path>`. The path
 * rides the fragment only — it never reaches a server, and the api's hand-off
 * routes do not know it exists.
 *
 * One rule, written once and used on BOTH sides: the launcher checks a path
 * before it writes it (`withHandoffTarget`), and each receiving app checks it
 * again before it honours it (`readHandoffTarget`). A receiver cannot trust a
 * fragment it did not write — anybody can paste a link — so anything that is
 * not plainly a path inside this same app is dropped and the app opens at home.
 */

/** Long enough for any screen in the deep-link map, short enough to refuse a payload. */
export const HANDOFF_TARGET_MAX = 512;

/**
 * The path when it is a same-app relative path, else null. Accepted: starts
 * with exactly one '/', then printable ASCII only, an optional `?query`, and
 * nothing that could leave the app or climb out of it. Refused:
 *   - empty, not a string, or longer than `HANDOFF_TARGET_MAX`;
 *   - not starting with '/', which is how a scheme (`https:`, `javascript:`)
 *     or a bare host would start;
 *   - protocol-relative `//host`, and `/\host`, which browsers read the same;
 *   - any backslash, whitespace, control character or non-ASCII character;
 *   - a fragment (`#`): the hand-off owns this URL's fragment;
 *   - an '&' in the path (before any '?'): it is the fragment's own separator,
 *     and no route of ours is spelled with one;
 *   - a `.` or `..` segment, raw or percent-encoded, and an encoded `/` or `\`
 *     in the path, which a server or router might decode into one;
 *   - a percent-escape of '%' itself (`%25`, a second layer of encoding) or
 *     of a control character (`%00`–`%1f`, `%7f`), anywhere;
 *   - a path that does not decode, or that resolves to another origin.
 */
export function safeTargetPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > HANDOFF_TARGET_MAX) return null;
  if (raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return null;
  // Printable ASCII only, and no backslash or fragment anywhere.
  if (!/^[\x21-\x7e]+$/.test(raw) || raw.includes('\\') || raw.includes('#')) return null;
  // No escape that decodes to '%' or to a control character.
  if (/%(25|[01][0-9a-f]|7f)/i.test(raw)) return null;
  const q = raw.indexOf('?');
  const path = q < 0 ? raw : raw.slice(0, q);
  if (path.includes('&') || /%2f|%5c/i.test(path)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
    if (q >= 0) decodeURIComponent(raw.slice(q + 1));
  } catch {
    return null;
  }
  if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  if (decoded.includes('..')) return null;
  // Belt and braces: whatever a URL parser makes of it must stay on this origin.
  const probe = 'https://handoff.invalid';
  try {
    if (new URL(raw, probe).origin !== probe) return null;
  } catch {
    return null;
  }
  return raw;
}

/**
 * The launch URL with the target beside the token, or the URL unchanged when
 * there is no target or the target is refused. The URL is the api's own
 * `launchUrl` (`<origin>/#handoff=<token>`); only its fragment grows.
 */
export function withHandoffTarget(launchUrl: string, target: string | null | undefined): string {
  const path = target == null ? null : safeTargetPath(target);
  if (path === null || path === '/') return launchUrl;
  if (!launchUrl.includes('#')) return launchUrl; // not a hand-off URL: nowhere safe to put it
  return `${launchUrl}&to=${encodeURIComponent(path)}`;
}

/**
 * The target in a hand-off fragment, checked again here, or null. Pure, for
 * the test. The value is read as the launcher writes it, percent-encoded
 * (`withHandoffTarget`): a hand-written one with an unencoded '?' or '&' is
 * refused whole — the split on '&' may have cut it short — rather than
 * landed in part.
 */
export function readHandoffTarget(hash: string): string | null {
  const match = /(?:^|&)to=([^&]*)/.exec(hash.replace(/^#/, ''));
  if (!match || !match[1]) return null;
  if (/[?&]/.test(match[1])) return null;
  let value: string;
  try {
    value = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const path = safeTargetPath(value);
  return path === '/' ? null : path;
}

/** The address to land on: the app's base path (Vite's `BASE_URL`) and the target. */
export function landingUrl(base: string, target: string): string {
  return base.replace(/\/+$/, '') + target;
}
