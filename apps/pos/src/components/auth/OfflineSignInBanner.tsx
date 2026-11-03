import { createElement, useEffect } from 'react';
import { useOperator } from '@/auth/OperatorContext';

/** OD-6 must remain visible after the lock screen closes, on every staff surface. */
export function OfflineSignInBanner() {
  const { operator, locked, offlineUnlock } = useOperator();
  const active = !!operator && !locked && offlineUnlock?.method === 'offline_sign_in';
  useEffect(() => {
    document.documentElement.classList.toggle('offline-sign-in-active', active);
    return () => document.documentElement.classList.remove('offline-sign-in-active');
  }, [active]);
  if (!active) return null;
  return createElement('div', {
    role: 'status',
    className: 'fixed inset-x-0 z-[80] flex h-9 items-center justify-center bg-amber-100 px-2 text-xs text-amber-950 dark:bg-amber-950 dark:text-amber-100',
    style: { top: 'var(--view-as-offset, 0px)' },
  }, 'Offline sign-in — using this box’s saved staff list');
}
