const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".m4v"];

// The types and size the server's /api/fix-reports/upload accepts, checked
// before anything is sent so a refusal names the file instead of failing late.
export const FIX_MEDIA_ACCEPT = "image/jpeg,image/png,image/webp,video/mp4,video/quicktime";
export const FIX_MEDIA_TYPES = new Set(FIX_MEDIA_ACCEPT.split(","));
export const MAX_FIX_MEDIA = 10;
export const MAX_FIX_MEDIA_SIZE = 20 * 1024 * 1024;
// A comment can also carry a PDF; a report's own media cannot.
export const FIX_COMMENT_MEDIA_ACCEPT = `${FIX_MEDIA_ACCEPT},application/pdf`;
export const FIX_COMMENT_MEDIA_TYPES = new Set(FIX_COMMENT_MEDIA_ACCEPT.split(","));

export function isPdfUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  return url.split("?")[0].toLowerCase().endsWith(".pdf");
}

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
