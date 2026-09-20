const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".m4v"];

export function isVideoUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  const clean = url.split("?")[0].toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => clean.endsWith(ext));
}

/**
 * Returns a URL for a small, fast-loading preview of fix report media
 * (a resized JPEG for photos, or a poster frame for videos).
 * Falls back gracefully — the server serves the full file if a thumbnail
 * can't be generated (e.g. very old/legacy media).
 */
export function getMediaThumbUrl(url: string): string {
  if (!url) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}thumb=1`;
}
