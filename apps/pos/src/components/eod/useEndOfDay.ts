import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, idemKey } from '@/api/client';
import { closeBodyOf, closeEndOfDay, getEndOfDay, type ApiEndOfDay } from '@/api/endOfDay';
import { getBranches } from '@/store/catalogStore';

/**
 * S2-15a round 1 — the End of Day record for the Today section's day and
 * branch, from the platform (what `mockApi.getEndOfDay` used to answer).
 *
 * Re-read whenever the day or the branch changes: a locked record when the
 * day has been closed, otherwise a fresh open one with the expected side and
 * the carried float. Close Day sends staff's entries and shows what the
 * platform locked; a 409 means somebody closed it first, so the locked day is
 * read back — the prototype's `closeEndOfDay(...) ?? getEndOfDay(...)`.
 */
export interface EndOfDayState {
  /** Satang, as the platform sends it; null until the first read lands. */
  record: ApiEndOfDay | null;
  setRecord: (update: (prev: ApiEndOfDay) => ApiEndOfDay) => void;
  /** Why the day could not be read, in the platform's words. */
  error: string | null;
  /** Why Close Day did not go through. */
  closeError: string | null;
  closing: boolean;
  close: () => Promise<void>;
}

const messageOf = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);

export function useEndOfDay(date: string, branch: string): EndOfDayState {
  const [record, setRecordState] = useState<ApiEndOfDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const key = `${branch}:${date}`;
  const current = useRef(key);
  current.current = key;
  // One key per Close Day press, kept while a retry of the same press is possible.
  const closeKey = useRef<string | null>(null);

  const apiIdOf = useCallback((): string | null => getBranches().find((b) => b.id === branch)?.apiId ?? null, [branch]);

  const load = useCallback(async () => {
    const apiId = apiIdOf();
    if (!apiId) {
      setRecordState(null);
      setError('This branch is not linked to the platform yet.');
      return;
    }
    try {
      const rec = await getEndOfDay(apiId, date);
      if (current.current === key) {
        setRecordState(rec);
        setError(null);
      }
    } catch (err) {
      if (current.current === key) setError(messageOf(err, 'The End of Day could not be read.'));
    }
  }, [apiIdOf, date, key]);

  useEffect(() => {
    setRecordState(null);
    setError(null);
    setCloseError(null);
    closeKey.current = null;
    void load();
  }, [load]);

  const setRecord = useCallback((update: (prev: ApiEndOfDay) => ApiEndOfDay) => {
    closeKey.current = null;
    setRecordState((prev) => (prev ? update(prev) : prev));
  }, []);

  const close = useCallback(async () => {
    const apiId = apiIdOf();
    if (!record || !apiId || record.status === 'closed') return;
    setClosing(true);
    setCloseError(null);
    closeKey.current ??= idemKey();
    try {
      const locked = await closeEndOfDay(apiId, closeBodyOf(record), closeKey.current);
      if (current.current === key) setRecordState(locked);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'DAY_CLOSED') {
        // Somebody closed it first: show the day they locked.
        await load();
      } else if (current.current === key) {
        setCloseError(messageOf(err, 'The day could not be closed.'));
      }
    } finally {
      setClosing(false);
    }
  }, [apiIdOf, key, load, record]);

  return { record, setRecord, error, closeError, closing, close };
}
