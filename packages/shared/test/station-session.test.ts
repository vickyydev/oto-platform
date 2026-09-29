import { describe, expect, it } from 'vitest';
import { STATION_LEASE_TTL_S, stationLeaseLive } from '../src/station-session';
import { projectDisplayDiagnosticDocument } from '../src/display-presentation';
import { ChildReviewActionSchema, ChildReviewPromptSchema, childReviewAge } from '../src/display-child-review';

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
  it('records only child-review prompt metadata, never child details or the typed answer', () => {
    const projected = projectDisplayDiagnosticDocument({ ...frame, prompt: {
      kind: 'child_review', requestId: 'review-request', visitorId: 'visitor-private', referenceDate: '2026-09-29',
      slots: [{ id: 'slot-private', savedChildId: 'child-private', name: 'Child private', dateOfBirth: '2020-03-14', ageYears: 6 }],
      choices: [{ id: 'child-private', name: 'Child private', dateOfBirth: '2020-03-14', ageYears: 6 }],
      answer: { type: 'child_review', payload: { dateOfBirth: '2020-03-14', name: 'Child private' } },
      answeredAt: frame.updatedAt,
    } });
    expect(projected?.prompt).toEqual({ kind: 'child_review', requestId: 'review-request', hasAnswer: true, answeredAt: frame.updatedAt });
    expect(JSON.stringify(projected)).not.toMatch(/2020-03-14|Child private|child-private|visitor-private|referenceDate|slots|choices/);
  });
});

describe('finite saved-child review contract (SCRUM-201)', () => {
  const prompt = { kind: 'child_review', requestId: 'request', visitorId: 'visitor', referenceDate: '2026-09-20',
    slots: [{ id: 'slot', savedChildId: 'child', name: 'Nok', dateOfBirth: '2020-03-14', ageYears: 6, confirmed: false }],
    choices: [{ id: 'child', name: 'Nok', dateOfBirth: '2020-03-14', ageYears: 6 }],
    save: { status: 'idle', slotId: null, actionId: null }, canContinue: false };
  it('uses real dates and the frozen visit day, while preserving age-only child records', () => {
    expect(childReviewAge('2020-02-29', '2026-02-28')).toBe(5);
    expect(childReviewAge('2020-02-29', '2026-03-01')).toBe(6);
    expect(childReviewAge('2020-02-30', '2026-03-01')).toBeNull();
    expect(childReviewAge('2026-09-21', '2026-09-20')).toBeNull();
    expect(ChildReviewPromptSchema.safeParse({ ...prompt, slots: [{ ...prompt.slots[0], confirmed: true }], canContinue: true }).success).toBe(true);
    expect(ChildReviewPromptSchema.safeParse({ ...prompt, slots: [{ ...prompt.slots[0], dateOfBirth: null, confirmed: true }], canContinue: true }).success).toBe(true);
  });
  it('fails closed on overbound, duplicate, unsaved or falsely confirmed drafts', () => {
    for (const invalid of [
      { ...prompt, slots: Array.from({ length: 51 }, (_, i) => ({ ...prompt.slots[0], id: `slot-${i}`, savedChildId: null })) },
      { ...prompt, choices: Array.from({ length: 101 }, (_, i) => ({ ...prompt.choices[0], id: `child-${i}` })) },
      { ...prompt, slots: [...prompt.slots, prompt.slots[0]] },
      { ...prompt, slots: [{ ...prompt.slots[0], savedChildId: 'undeclared' }] },
      { ...prompt, slots: [{ ...prompt.slots[0], savedChildId: null, confirmed: true }], canContinue: true },
      { ...prompt, slots: [{ ...prompt.slots[0], ageYears: 5, confirmed: true }], canContinue: true },
      { ...prompt, canContinue: true },
      { ...prompt, save: { status: 'failed', slotId: 'missing', actionId: 'save' } },
    ]) expect(ChildReviewPromptSchema.safeParse(invalid).success).toBe(false);
  });
  it('requires an exact saved-child confirmation, never private fields or adult numeric ages', () => {
    const confirm = { action: 'confirm', requestId: 'request', visitorId: 'visitor', slotId: 'slot', savedChildId: 'child',
      name: ' Nok ', dateOfBirth: null, ageYears: 6 };
    expect(ChildReviewActionSchema.parse(confirm)).toEqual({ ...confirm, name: 'Nok' });
    for (const invalid of [{ ...confirm, savedChildId: null }, { ...confirm, ageYears: 18 },
      { ...confirm, dateOfBirth: '2020-02-30' }, { ...confirm, medicalNotes: 'private' }, { ...confirm, ageYears: null }]) {
      expect(ChildReviewActionSchema.safeParse(invalid).success).toBe(false);
    }
    const projected = ChildReviewPromptSchema.parse({ ...prompt, slots: [{ ...prompt.slots[0], medicalNotes: 'private', childPhotoUrl: 'private' }],
      choices: [{ ...prompt.choices[0], medicalNotes: 'private' }] });
    expect(JSON.stringify(projected)).not.toContain('private');
  });
});
