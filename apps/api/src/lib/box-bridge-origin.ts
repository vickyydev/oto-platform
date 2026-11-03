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
