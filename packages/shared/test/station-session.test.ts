import { describe, expect, it } from 'vitest';
import { STATION_LEASE_TTL_S, stationLeaseLive } from '../src/station-session';

/**
 * A lease is live for one lease length and no longer (SCRUM-439).
 *
 * The expiry is written as the box's clock plus the TTL, and since SCRUM-402
 * that clock is the box's corrected one: a correction that moves it back
 * leaves a lease taken before it hours from expiring. Such a lease is treated
 * as run out, the way the box's outbox treats a retry further off than its
 * backoff cap — and a lease inside its length is live exactly as before, so
 * the rule never costs a live till its station.
 */
describe('stationLeaseLive (SCRUM-439)', () => {
  const now = Date.parse('2026-09-20T03:00:00.000Z');
  const ttlMs = STATION_LEASE_TTL_S * 1000;
  const expiring = (offsetMs: number) => ({ expiresAt: new Date(now + offsetMs).toISOString() });

  it('is live from the instant after now up to a full lease length ahead', () => {
    expect(stationLeaseLive(expiring(1), now)).toBe(true);
    expect(stationLeaseLive(expiring(ttlMs / 2), now)).toBe(true);
    expect(stationLeaseLive(expiring(ttlMs), now)).toBe(true);
  });

  it('has run out at now, and before it', () => {
    expect(stationLeaseLive(expiring(0), now)).toBe(false);
    expect(stationLeaseLive(expiring(-1), now)).toBe(false);
    expect(stationLeaseLive(expiring(-ttlMs), now)).toBe(false);
  });

  it('is treated as run out when further from expiring than its length, which only a clock since gone back can have set', () => {
    expect(stationLeaseLive(expiring(ttlMs + 1), now)).toBe(false);
    // A Pi that booted three hours ahead, claimed, and then measured itself against the platform.
    expect(stationLeaseLive(expiring(3 * 3_600_000 + ttlMs), now)).toBe(false);
  });

  it('holds nothing for no lease, or an expiry that is not a time', () => {
    expect(stationLeaseLive(null, now)).toBe(false);
    expect(stationLeaseLive(undefined, now)).toBe(false);
    expect(stationLeaseLive({ expiresAt: 'not a time' }, now)).toBe(false);
  });
});
