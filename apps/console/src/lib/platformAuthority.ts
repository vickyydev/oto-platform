import { useWorkingAuthority } from '@/lib/workingAuthority';
import { useCallback, useEffect, useRef } from 'react';
import type { Permission } from '@oto/shared/permissions';
import { useSession } from '@/auth/SessionContext';
import type { ConsoleNavGroup } from '../components/consoleSections';

/** Older navigation offers keep has(); only these new global reads need scope. */
export function filterPlatformHealthLinks(groups: ConsoleNavGroup[], allowed: boolean): ConsoleNavGroup[] {
  if (allowed) return groups;
  const globalReads = new Set(['platform-alerts', 'platform-jobs', 'platform-environment']);
  return groups.map((group) => group.id !== 'platform' ? group : {
    ...group, sections: group.sections.filter((section) => !globalReads.has(section.id)),
  });
}

/** An offer only: the API repeats genuine platform and target-permission checks. */
export function usePlatformAuthority(permission: Permission, operatorWide = false) {
  const working = useWorkingAuthority();
  const session = useSession();
  const { me, permissions, authorityEpoch, refreshing, isCurrentAuthority } = session;
  const allowed = working.isCurrent() && session.state === 'signed-in' && !refreshing && !!me?.isPlatformAdmin
    && me.account.status === 'active' && !me.sessionLocked && !me.account.mustChangePassword
    && permissions.some((grant) => grant.permission === permission && (!operatorWide
      || (grant.scopeType === 'operator' && (grant.scopeId === null || grant.scopeId === me.operatorContext.effectiveOperatorId))));
  // Include all authority inputs even when a refresh returns the same identity.
  const key = JSON.stringify([working.epoch, me?.operatorContext, authorityEpoch, permission, operatorWide, session.state, refreshing,
    me?.account.id, me?.operatorContext.effectiveOperatorId, me?.account.status, me?.account.mustChangePassword,
    me?.branch?.id, me?.sessionLocked, me?.isPlatformAdmin,
    permissions.map((grant) => [grant.permission, grant.scopeType, grant.scopeId]).sort()]);
  const current = useRef({ key, allowed, mounted: true });
  current.current.key = key;
  current.current.allowed = allowed;
  useEffect(() => {
    current.current.mounted = true;
    return () => { current.current.mounted = false; };
  }, []);
  const isCurrent = useCallback(() => working.isCurrent() && current.current.mounted && current.current.allowed
    && current.current.key === key && isCurrentAuthority(authorityEpoch), [key, authorityEpoch, isCurrentAuthority, working.isCurrent]);
  return { allowed, key, isCurrent };
}
