import { describe, expect, it } from 'vitest';
import { STATION_LEASE_TTL_S, stationLeaseLive } from '../src/station-session';
import { projectDisplayDiagnosticDocument } from '../src/display-presentation';

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

describe('finite recorded display response (SCRUM-201)', () => {
  const frame = { stationId: '018f0000-0000-7000-8000-000000000001', boxId: '018f0000-0000-7000-8000-000000000002',
    schemaVersion: 1, sequence: 4, stage: 'input', language: 'en', takeoverCount: 0, updatedAt: '2026-09-29T12:00:00.000Z' };
  it('removes private data and actual QR contents recursively before recording', () => {
    const raw = { ...frame, lease: { holder: 'Staff-only holder', accountId: 'Staff-only account' }, medical: 'Private marker',
      cart: { supported: true, sale: { tier: 'member', allergies: 'Private marker' } },
      member: { id: 'member', nickname: 'Guest', tier: 'member', medicalNotes: 'Private marker' },
      payment: { saleId: 'sale', amountSatang: 4200, qrPayload: 'QR fixture contents', qrImageUrl: 'https://example.test/qr.png',
        expiresAt: null, status: 'pending', online: true, offline: false, token: 'Private marker' },
      prompt: { kind: 'contact', requestId: 'request', phone: 'Private marker', nickname: 'Private marker',
        contactChannel: 'line', answer: { type: 'contact_done', phone: 'Private marker' }, answeredAt: frame.updatedAt },
    };
    const projected = projectDisplayDiagnosticDocument(raw)!;
    expect(projected.payment).toEqual({ saleId: 'sale', amountSatang: 4200, expiresAt: null, status: 'pending',
      online: true, offline: false, hasQrPayload: true, hasQrImage: true });
    expect(projected.prompt).toEqual({ kind: 'contact', requestId: 'request', hasAnswer: true, answeredAt: frame.updatedAt });
    expect(projected.member).toEqual({ id: 'member', nickname: 'Guest', tier: 'member' });
    expect(JSON.stringify(projected)).not.toMatch(/Private marker|QR fixture contents|example\.test|holder|accountId/);
    expect(raw.payment.qrPayload).toBe('QR fixture contents');
    expect(projectDisplayDiagnosticDocument(projected)).toEqual(projected);
  });
  it('does not disguise malformed full presentation as the older tier-only contract', () => {
    expect(projectDisplayDiagnosticDocument({ ...frame, cart: { supported: true, sale: { id: 'sale', tier: 'member' } } })?.cart).toBeNull();
    expect(projectDisplayDiagnosticDocument({ ...frame, stationId: 'malformed' })).toBeNull();
  });
});
