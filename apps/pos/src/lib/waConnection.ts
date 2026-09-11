import { CheckIn, WaConnectionStatus } from '@/types';

/**
 * Derive the effective contact-channel connection status for display on a
 * CheckIn. Works identically for WhatsApp, Telegram, and LINE — the same
 * mocked send→pending→confirmed loop applies to all three.
 *
 *   - No phone captured: undefined — no chip is shown (nothing to connect).
 *   - Phone present with no stored waConnection: 'unverified' — rendered red,
 *     because a confirmation was never successfully established.
 *   - Phone present with a stored waConnection: its status verbatim.
 *
 * Single source of truth shared by the iPad (`CheckInCard`) and the mobile shell
 * (`MobileChildCard` / `MobileChildDetail`) so the two surfaces never drift.
 */
export function deriveWaStatus(checkIn: CheckIn): WaConnectionStatus | undefined {
  return checkIn.phone.trim()
    ? (checkIn.waConnection?.status ?? 'unverified')
    : undefined;
}

/**
 * Whether the WA action panel (Resend / Sim-confirm / Couldn't reach) should be
 * offered for a status. Confirmed channels need no action; only pending, failed,
 * and unverified do.
 */
export function showWaActions(status: WaConnectionStatus | undefined): boolean {
  return status === 'pending' || status === 'failed' || status === 'unverified';
}
