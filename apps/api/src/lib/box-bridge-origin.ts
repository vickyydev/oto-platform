import { AppError } from './errors';
import type { Env } from '../env';

/** A destination, never a URL carrying credentials, a path or a query. */
export function boxBridgeOrigin(
  value: string | null | undefined,
  env: Pick<Env, 'DEPLOY_ENV' | 'BOX_BRIDGE_ALLOW_LOOPBACK'>,
): string | null {
  if (value == null) return null;
  const refuse = () => new AppError(400, 'BOX_BRIDGE_ORIGIN_INVALID', 'Enter an HTTPS origin, without a path, query or sign-in details.');
  let url: URL;
  try { url = new URL(value); } catch { throw refuse(); }
  if (value !== url.origin && value !== `${url.origin}/`) throw refuse();
  const hostname = url.hostname.replace(/\.$/, '');
  const loopback = hostname === 'localhost' || hostname.endsWith('.localhost')
    || /^127\./.test(hostname) || hostname === '[::1]'
    || /^\[::ffff:(?:7f[0-9a-f]{2}:|127\.)/i.test(hostname);
  const testLoopback = loopback && env.DEPLOY_ENV !== 'production' && env.BOX_BRIDGE_ALLOW_LOOPBACK;
  if ((loopback && !testLoopback) || (url.protocol !== 'https:' && !(testLoopback && url.protocol === 'http:'))) throw refuse();
  return url.origin;
}
