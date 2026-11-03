import { trustedBoxBridgeOrigin } from '@oto/shared';
import { AppError } from './errors';
import type { Env } from '../env';

export type BoxBridgePolicy = Pick<Env, 'DEPLOY_ENV' | 'BOX_BRIDGE_ALLOW_LOOPBACK' | 'BOX_BRIDGE_ZONE'>;

/** A saved address must still be trusted under the current deployment policy. */
export function readBoxBridgeOrigin(value: string | null | undefined, env?: BoxBridgePolicy): string | null {
  return trustedBoxBridgeOrigin(value, env?.BOX_BRIDGE_ZONE,
    env?.DEPLOY_ENV !== 'production' && env?.BOX_BRIDGE_ALLOW_LOOPBACK === true);
}

export function boxBridgeOrigin(value: string | null | undefined, env?: BoxBridgePolicy): string | null {
  if (value == null) return null;
  const origin = readBoxBridgeOrigin(value, env);
  if (!origin) throw new AppError(400, 'BOX_BRIDGE_ORIGIN_INVALID',
    'Enter an HTTPS box address below the configured box DNS zone, without a path, query, IP address or sign-in details.');
  return origin;
}

/** Administrator-facing reason; never returns the rejected destination. */
export function boxBridgeWarning(value: string | null | undefined, env?: BoxBridgePolicy): string | null {
  if (!env?.BOX_BRIDGE_ZONE) return 'Local box addresses are disabled because the box DNS zone is not configured.';
  if (value && !readBoxBridgeOrigin(value, env)) return 'The saved address is not trusted by the current box DNS zone. It is not in use; replace or clear it. Other box settings can still be changed.';
  if (['onrender.com', 'vercel.app', 'netlify.app', 'github.io', 'co.uk'].includes(env.BOX_BRIDGE_ZONE.toLowerCase())) {
    return 'This zone is shared by unrelated sites. Configure a dedicated DNS zone controlled by the park before using a box address.';
  }
  return null;
}
