/**
 * Reads a single-range HTTP `Range: bytes=...` header against a file of
 * `totalSize` bytes. Anything that is not one satisfiable byte range (no header,
 * several ranges, a start past the end, an empty file) is answered with the
 * whole file — RFC 9110 lets a server ignore a Range it will not serve, and a
 * 200 with the full body is what every player falls back to.
 *
 * Handles the three forms browsers send: `bytes=0-` (open end, what Safari
 * starts with is usually `bytes=0-1`), `bytes=100-199`, and the suffix form
 * `bytes=-500` (the last 500 bytes, used to find an MP4's trailing moov box).
 */
export function parseRangeHeader(
  rangeHeader: string | undefined,
  totalSize: number,
): { start: number; end: number; isPartial: boolean } {
  const whole = { start: 0, end: Math.max(totalSize - 1, 0), isPartial: false };
  if (!rangeHeader || totalSize <= 0) return whole;
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/.exec(rangeHeader);
  if (!match || (!match[1] && !match[2])) return whole;
  if (!match[1]) {
    const suffix = parseInt(match[2], 10);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return whole;
    return { start: Math.max(totalSize - suffix, 0), end: totalSize - 1, isPartial: true };
  }
  const start = parseInt(match[1], 10);
  let end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= totalSize || end < start) return whole;
  if (end >= totalSize) end = totalSize - 1;
  return { start, end, isPartial: true };
}
