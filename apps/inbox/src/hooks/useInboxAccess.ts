import { useEffect, useRef } from 'react';
import type { InboxMe } from '@/api/inbox';
import { inboxAccessSignature, newestInboxAccess } from '@/lib/inboxes';

/** Keep the newest policy while filters reset the list or identity reads catch up. */
export function useInboxAccess(page: InboxMe['access'], identity: InboxMe['access'], reload: () => Promise<void>) {
  const observed = useRef(identity), requested = useRef<string | null>(null);
  const current = newestInboxAccess(page, newestInboxAccess(observed.current, identity));
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
