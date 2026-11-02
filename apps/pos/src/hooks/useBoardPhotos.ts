import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { forgetPhotoUrl, photoUrlOf, type ApiBoard } from '@/api/checkin';

/** The boards poll every thirty seconds, so a shorter wait would change nothing. */
const PHOTO_BACKOFF_STEP_MS = 30_000;
const PHOTO_BACKOFF_CAP_MS = 15 * 60_000;

/**
 * The wait after failures in a row for one photo. The first asks again at once,
 * which is how an expired link recovers; every read is an access-log row, so a
 * file that cannot load then waits thirty seconds, doubling up to the cap.
 */
export function photoBackoffMs(failures: number): number {
  if (failures <= 1) return 0;
  return Math.min(PHOTO_BACKOFF_STEP_MS * 2 ** (failures - 2), PHOTO_BACKOFF_CAP_MS);
}

/** Both boards renew through the access-logged endpoint, without a read on every redraw. */
export function useBoardPhotos(board: ApiBoard | null) {
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const readGeneration = useRef(0);
  // Only a loaded image clears this: a missing file still gets a link every time.
  const pacing = useRef(new Map<string, { failures: number; notBefore: number }>());
  // Photos with a link on screen. Sibling cards share one family photo, and the
  // images of one link failing together are one failure, not several.
  const showing = useRef(new Set<string>());

  const noteFailure = useCallback((fileId: string) => {
    const failures = (pacing.current.get(fileId)?.failures ?? 0) + 1;
    pacing.current.set(fileId, { failures, notBefore: Date.now() + photoBackoffMs(failures) });
    return failures;
  }, []);
  const settle = useCallback((fileId: string, url: string | null) => {
    if (!url) {
      noteFailure(fileId);
      return;
    }
    showing.current.add(fileId);
    setPhotos(p => p[fileId] === url ? p : { ...p, [fileId]: url });
  }, [noteFailure]);

  useEffect(() => {
    const generation = ++readGeneration.current;
    if (!board) return;
    const wanted = new Set<string>();
    for (const family of board.families) {
      for (const child of family.children) {
        const fileId = child.photoFileId ?? family.photoFileId;
        if (fileId) wanted.add(fileId);
      }
    }
    for (const fileId of wanted) {
      if (Date.now() < (pacing.current.get(fileId)?.notBefore ?? 0)) continue;
      void photoUrlOf(fileId).then(url => {
        if (readGeneration.current === generation) settle(fileId, url);
      });
    }
    return () => { readGeneration.current = generation + 1; };
  }, [board, settle]);

  const handlePhotoError = useCallback((event: SyntheticEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLImageElement)) return;
    const failedUrl = event.target.currentSrc || event.target.src;
    const fileId = Object.keys(photos).find(id => photos[id] === failedUrl);
    if (!fileId) return;
    forgetPhotoUrl(fileId, failedUrl);
    // Signatures minted in the same second can be identical. Remove the
    // failed image while renewing so even that answer mounts a fresh image.
    setPhotos(previous => {
      if (previous[fileId] !== failedUrl) return previous;
      const next = { ...previous };
      delete next[fileId];
      return next;
    });
    if (!showing.current.delete(fileId)) return;
    // One immediate retry. Failing again waits for a board read after the pause,
    // without an endless image-error loop.
    if (noteFailure(fileId) > 1) return;
    const generation = readGeneration.current;
    void photoUrlOf(fileId).then(url => {
      if (readGeneration.current === generation) settle(fileId, url);
    });
  }, [photos, noteFailure, settle]);

  const handlePhotoLoad = useCallback((event: SyntheticEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLImageElement)) return;
    const loadedUrl = event.target.currentSrc || event.target.src;
    const fileId = Object.keys(photos).find(id => photos[id] === loadedUrl);
    if (fileId) pacing.current.delete(fileId);
  }, [photos]);

  return { photos, handlePhotoError, handlePhotoLoad };
}
