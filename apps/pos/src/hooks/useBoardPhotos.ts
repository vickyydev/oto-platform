import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { forgetPhotoUrl, photoUrlOf, type ApiBoard } from '@/api/checkin';

/** Both boards renew through the access-logged endpoint, without a read on every redraw. */
export function useBoardPhotos(board: ApiBoard | null) {
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const readGeneration = useRef(0);
  const retryAt = useRef(new Map<string, number>());
  const remember = useCallback((fileId: string, url: string | null) => {
    if (url) setPhotos(p => p[fileId] === url ? p : { ...p, [fileId]: url });
  }, []);

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
      void photoUrlOf(fileId).then(url => {
        if (readGeneration.current === generation) remember(fileId, url);
      });
    }
    return () => { readGeneration.current = generation + 1; };
  }, [board, remember]);

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
    // One immediate retry per board interval. A failed retry stays uncached
    // for the next board read, without an endless image-error loop.
    const now = Date.now();
    if (now - (retryAt.current.get(fileId) ?? -Infinity) < 30_000) return;
    retryAt.current.set(fileId, now);
    const generation = readGeneration.current;
    void photoUrlOf(fileId).then(url => {
      if (readGeneration.current === generation) remember(fileId, url);
    });
  }, [photos, remember]);

  return { photos, handlePhotoError };
}
