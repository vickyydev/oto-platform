/**
 * Where one row of `GET /accounts/:id/staff-tokens` stands.
 *
 * Ended before expired: the api only ever revokes a token still inside its
 * lifetime, so a row with `revokedAt` was ended by somebody or something, and
 * that is the fact worth showing even once its expiry has also passed.
 */
export function staffTokenRowState(
  row: { expiresAt: string; revokedAt: string | null },
  now = Date.now(),
): 'live' | 'ended' | 'expired' {
  if (row.revokedAt) return 'ended';
  const exp = Date.parse(row.expiresAt);
  return Number.isFinite(exp) && exp > now ? 'live' : 'expired';
}

/** Why a shift token was ended, from the api's `revokedReason`. */
export function staffTokenEndedWhy(reason: string | null): string {
  switch (reason) {
    case 'admin':
      return 'ended by a manager';
    case 'sign_out':
      return 'ended when they signed out';
    case 'account_revoked':
      return 'ended with every session they held';
    case 'station_changed':
      return 'replaced by a newer one';
    default:
      return 'ended';
  }
}

/** `GET /staff-tokens/settings`, as one line for the panel. */
export function staffTokenSettingsWords(settings: {
  available: boolean;
  ttlSeconds: number | null;
  offlineSignIn: boolean;
}): string {
  if (!settings.available) {
    return 'This deployment issues no shift tokens (no signing key is set), so a locked till needs the internet to unlock.';
  }
  const hours =
    settings.ttlSeconds === null ? null : Math.round((settings.ttlSeconds / 3600) * 10) / 10;
  const life =
    hours === null ? 'Each is good' : `Each lasts ${hours} hour${hours === 1 ? '' : 's'}`;
  return `${life} at the one station it was issued for. Offline sign-in without a token is ${
    settings.offlineSignIn ? 'on' : 'off'
  }.`;
}
