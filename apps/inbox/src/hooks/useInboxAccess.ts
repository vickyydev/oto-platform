import { useEffect, useRef } from 'react';
import type { InboxMe } from '@/api/inbox';
import { inboxAccessSignature, newestInboxAccess } from '@/lib/inboxes';

/** Keep the newest policy while filters reset the list or identity reads catch up. */
export function useInboxAccess(page: InboxMe['access'], identity: InboxMe['access'], reload: () => Promise<void>) {
  const observed = useRef(identity), requested = useRef<string | null>(null);
  const conflict = useRef<{ page: InboxMe['access']; identity: InboxMe['access'] } | null>(null);
  const readsAgree = page && identity && inboxAccessSignature(page) === inboxAccessSignature(identity);
  if (page && identity && !readsAgree && !conflict.current) conflict.current = { page, identity };
  // Equal-version expansion after a conflict needs both reads to advance;
  // an old page merely matching a late identity response is not agreement
  // from a fresh list read. Workspace also discards pre-change list requests.
  const freshAgreement = readsAgree && (!conflict.current || (page !== conflict.current.page && identity !== conflict.current.identity));
  const current = freshAgreement && page.version >= (observed.current?.version ?? 0)
    ? page : newestInboxAccess(page, newestInboxAccess(observed.current, identity));
  if (freshAgreement) conflict.current = null;
  observed.current = current;
  const pageSignature = inboxAccessSignature(page), identitySignature = inboxAccessSignature(identity);
  useEffect(() => {
    if (!page || pageSignature === identitySignature) { requested.current = null; return; }
    const pair = `${pageSignature}:${identitySignature}`;
    if (requested.current === pair || (identity?.version ?? 0) > page.version) return;
    requested.current = pair;
    void reload();
  }, [pageSignature, identitySignature, page, identity, reload]);
  return current;
}
