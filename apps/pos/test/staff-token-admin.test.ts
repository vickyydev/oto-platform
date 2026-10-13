import { describe, expect, it } from 'vitest';
import { staffTokenEndedWhy, staffTokenRowState, staffTokenSettingsWords } from '@/auth/staffToken';

/**
 * SCRUM-512 — the Login Users panel's reading of somebody's shift tokens
 * (`src/auth/staffToken.ts`): which rows still unlock a till offline and so
 * carry an End button, why an ended one ended, and the deployment's terms.
 */
const NOW = Date.parse('2026-10-13T12:00:00Z');

describe('staffTokenRowState', () => {
  it('is live only inside its lifetime and not revoked', () => {
    expect(staffTokenRowState({ expiresAt: '2026-10-13T20:00:00Z', revokedAt: null }, NOW)).toBe(
      'live',
    );
    expect(staffTokenRowState({ expiresAt: '2026-10-13T11:59:59Z', revokedAt: null }, NOW)).toBe(
      'expired',
    );
    // An unreadable expiry is not a live credential.
    expect(staffTokenRowState({ expiresAt: 'not a date', revokedAt: null }, NOW)).toBe('expired');
  });

  it('reads a revoked token as ended even once its expiry has also passed', () => {
    expect(
      staffTokenRowState(
        { expiresAt: '2026-10-13T20:00:00Z', revokedAt: '2026-10-13T10:00:00Z' },
        NOW,
      ),
    ).toBe('ended');
    expect(
      staffTokenRowState(
        { expiresAt: '2026-10-13T11:00:00Z', revokedAt: '2026-10-13T10:00:00Z' },
        NOW,
      ),
    ).toBe('ended');
  });
});

describe('staffTokenEndedWhy and staffTokenSettingsWords', () => {
  it('names each reason the api records, and falls back to "ended"', () => {
    expect(staffTokenEndedWhy('admin')).toBe('ended by a manager');
    expect(staffTokenEndedWhy('sign_out')).toBe('ended when they signed out');
    expect(staffTokenEndedWhy('account_revoked')).toBe('ended with every session they held');
    expect(staffTokenEndedWhy('station_changed')).toBe('replaced by a newer one');
    expect(staffTokenEndedWhy(null)).toBe('ended');
  });

  it('says the lifetime in hours and the offline sign-in switch, or that no tokens are issued', () => {
    expect(
      staffTokenSettingsWords({ available: true, ttlSeconds: 57_600, offlineSignIn: false }),
    ).toBe(
      'Each lasts 16 hours at the one station it was issued for. Offline sign-in without a token is off.',
    );
    expect(
      staffTokenSettingsWords({ available: false, ttlSeconds: null, offlineSignIn: false }),
    ).toMatch(/issues no shift tokens/);
  });
});
