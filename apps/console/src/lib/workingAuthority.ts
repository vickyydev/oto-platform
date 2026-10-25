import { useCallback, useEffect, useMemo, useRef } from 'react';
import { api, ApiError } from '@/api/client';
import { useSession } from '@/auth/SessionContext';

/** Bind a page's retained callbacks to the exact confirmed session epoch. */
export function useWorkingAuthority() {
  const { authorityEpoch: epoch, isCurrentAuthority, state, refreshing, me } = useSession();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const isCurrent = useCallback(() => mounted.current && state === 'signed-in' && !refreshing
    && me !== null && !me.sessionLocked && !me.account.mustChangePassword && isCurrentAuthority(epoch),
  [epoch, isCurrentAuthority, state, refreshing, me]);
  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    const check = () => {
      if (!isCurrent()) throw new ApiError(409, 'SESSION_CONTEXT_CHANGED', 'The current session changed. Read this page again.');
    };
    check();
    try {
      const answer = await operation();
      check();
      return answer;
    } catch (failure) {
      check();
      throw failure;
    }
  }, [isCurrent]);
  const bound = useMemo<typeof api>(() => {
    // Bind the existing typed methods; route bodies and response types stay
    // at their original callers rather than becoming new hand-typed calls.
    const bind = <M extends (...args: never[]) => Promise<unknown>>(method: M): M =>
      ((...args: Parameters<M>) => run(() => Reflect.apply(method, api, args))) as M;
    return { get: bind(api.get), post: bind(api.post), put: bind(api.put), patch: bind(api.patch),
      delete: bind(api.delete), deleteWithBody: bind(api.deleteWithBody),
      getBlob: bind(api.getBlob), postBlob: bind(api.postBlob), getFile: bind(api.getFile) };
  }, [run]);
  return useMemo(() => ({ epoch, isCurrent, run, api: bound }), [epoch, isCurrent, run, bound]);
}
