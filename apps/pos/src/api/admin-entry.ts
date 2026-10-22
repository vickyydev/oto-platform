import { withHandoffTarget } from '@oto/shared/handoff-target';
import { api, idemKey } from './client';

/** The existing sign-on seam owns the configured Admin destination and its access check. */
export async function adminAccountsDestination(): Promise<string> {
  const issued = await api.post('/auth/handoff', { app: 'console' }, { idempotencyKey: idemKey() });
  try {
    if (typeof issued !== 'object' || issued === null || !('launchUrl' in issued) ||
      typeof issued.launchUrl !== 'string') throw new Error();
    const authority = /^https?:\/\/([^/?#]*)/i.exec(issued.launchUrl)?.[1];
    const parsed = new URL(issued.launchUrl);
    const fragment = new URLSearchParams(parsed.hash.slice(1));
    if (!authority || authority.includes('@') || !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username || parsed.password || !fragment.get('handoff')?.trim() || fragment.has('to')) throw new Error();
    const destination = withHandoffTarget(issued.launchUrl, '/people/accounts');
    if (destination === issued.launchUrl) throw new Error();
    return destination;
  } catch {
    throw new Error('Admin has no configured signed-in destination.');
  }
}
