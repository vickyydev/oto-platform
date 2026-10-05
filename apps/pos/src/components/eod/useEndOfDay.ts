import { useCallback, useEffect, useRef, useState } from 'react';
import { newId, type EodStrandedRow, type StrandedResolutionReason } from '@oto/shared';
import { ApiError, idemKey } from '@/api/client';
import {
  closeBodyOf,
  closeEndOfDay,
  getEndOfDay,
  reprintEndOfDayReceipt,
  resolveStrandedRow,
  type ApiEndOfDay,
} from '@/api/endOfDay';
import { laneStation } from '@/lib/lane';
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
 *
 * S2-15a round 2 — the boxes that keep the day provisional and who is still
 * counted inside travel on the open record; each stranded row is resolved
 * here, a manager's override reason rides on Close Day, the receipt prints on
 * this counter, and a closed day's receipt is reprinted from it. Re-checking
 * the provisional and stranded lists never touches what staff typed.
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
  /** A manager's reason for closing over rows still counted inside. */
  overrideReason: string;
  setOverrideReason: (reason: string) => void;
  /** The stranded row being resolved, by its subject id. */
  resolving: string | null;
  resolveError: string | null;
  resolve: (row: EodStrandedRow, reason: StrandedResolutionReason) => Promise<void>;
  /** Read the provisional and stranded lists again, keeping staff's entries. */
  recheck: () => Promise<void>;
  reprinting: boolean;
  reprintError: string | null;
  reprint: () => Promise<void>;
}

const messageOf = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);

export function useEndOfDay(date: string, branch: string): EndOfDayState {
  const [record, setRecordState] = useState<ApiEndOfDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [overrideReason, setOverrideReasonState] = useState('');
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [reprinting, setReprinting] = useState(false);
  const [reprintError, setReprintError] = useState<string | null>(null);
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
    setResolveError(null);
    setReprintError(null);
    setOverrideReasonState('');
    closeKey.current = null;
    void load();
  }, [load]);

  const latestReceiptJob = record?.receipt?.jobs.at(-1);
  const pendingReceiptJobId = record?.status === 'closed' && record.date === date && latestReceiptJob?.status === 'queued'
    ? latestReceiptJob.id : null;
  useEffect(() => {
    const apiId = apiIdOf();
    if (!apiId || !pendingReceiptJobId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refreshReceipt = async () => {
      try {
        const fresh = await getEndOfDay(apiId, date);
        if (active && current.current === key && fresh.status === 'closed' && fresh.branchId === apiId && fresh.date === date) {
          setRecordState((prev) => prev?.status === 'closed' && prev.branchId === apiId && prev.date === date &&
            prev.receipt?.jobs.at(-1)?.id === pendingReceiptJobId
            ? { ...prev, receipt: fresh.receipt } : prev);
        }
      } catch {
        // Keep the last print status during a lost connection, then try again.
      } finally {
        if (active) timer = setTimeout(() => void refreshReceipt(), 3_000);
      }
    };
    timer = setTimeout(() => void refreshReceipt(), 3_000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [apiIdOf, date, key, pendingReceiptJobId]);

  const setRecord = useCallback((update: (prev: ApiEndOfDay) => ApiEndOfDay) => {
    closeKey.current = null;
    setRecordState((prev) => (prev ? update(prev) : prev));
  }, []);

  const setOverrideReason = useCallback((reason: string) => {
    closeKey.current = null;
    setOverrideReasonState(reason);
  }, []);

  const recheck = useCallback(async () => {
    const apiId = apiIdOf();
    if (!apiId) return;
    try {
      const fresh = await getEndOfDay(apiId, date);
      if (current.current !== key) return;
      if (fresh.status === 'closed') {
        setRecordState(fresh);
        return;
      }
      setRecordState((prev) =>
        prev && prev.status === 'open' ? { ...prev, provisional: fresh.provisional, stranded: fresh.stranded } : fresh,
      );
    } catch {
      // The lists shown stay as they were; the next press asks again.
    }
  }, [apiIdOf, date, key]);

  const close = useCallback(async () => {
    const apiId = apiIdOf();
    if (!record || !apiId || record.status === 'closed') return;
    setClosing(true);
    setCloseError(null);
    closeKey.current ??= idemKey();
    try {
      const locked = await closeEndOfDay(
        apiId,
        closeBodyOf(record, { stationId: laneStation(), overrideReason }),
        closeKey.current,
      );
      if (current.current === key) setRecordState(locked);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'DAY_CLOSED') {
        // Somebody closed it first: show the day they locked.
        await load();
      } else if (current.current === key) {
        setCloseError(messageOf(err, 'The day could not be closed.'));
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
          // An answer, not a lost one: the next press is a new attempt.
          closeKey.current = null;
          if (err.code === 'DAY_PROVISIONAL' || err.code === 'STRANDED_OCCUPANCY') await recheck();
        }
      }
    } finally {
      setClosing(false);
    }
  }, [apiIdOf, key, load, overrideReason, recheck, record]);

  const resolve = useCallback(
    async (row: EodStrandedRow, reason: StrandedResolutionReason) => {
      const apiId = apiIdOf();
      if (!record || !apiId || record.status === 'closed') return;
      setResolving(row.subjectId);
      setResolveError(null);
      try {
        const answer = await resolveStrandedRow(apiId, {
          date: record.date,
          kind: row.kind,
          subjectId: row.subjectId,
          reason,
          actionId: newId(),
        });
        if (current.current === key) {
          setRecordState((prev) => (prev && prev.status === 'open' ? { ...prev, stranded: answer.stranded } : prev));
        }
      } catch (err) {
        if (current.current !== key) return;
        if (err instanceof ApiError && err.status === 409 && err.code === 'NOT_STRANDED') await recheck();
        else if (err instanceof ApiError && err.status === 409 && err.code === 'DAY_CLOSED') await load();
        else setResolveError(messageOf(err, 'That row could not be resolved.'));
      } finally {
        setResolving(null);
      }
    },
    [apiIdOf, key, load, recheck, record],
  );

  const reprint = useCallback(async () => {
    const apiId = apiIdOf();
    if (!record || !apiId || record.status !== 'closed') return;
    setReprinting(true);
    setReprintError(null);
    try {
      const rec = await reprintEndOfDayReceipt(apiId, { date: record.date, stationId: laneStation() });
      if (current.current === key) setRecordState(rec);
    } catch (err) {
      if (current.current === key) setReprintError(messageOf(err, 'The receipt could not be reprinted.'));
    } finally {
      setReprinting(false);
    }
  }, [apiIdOf, key, record]);

  return {
    record,
    setRecord,
    error,
    closeError,
    closing,
    close,
    overrideReason,
    setOverrideReason,
    resolving,
    resolveError,
    resolve,
    recheck,
    reprinting,
    reprintError,
    reprint,
  };
}
