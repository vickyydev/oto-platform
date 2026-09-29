import { describe, expect, it } from 'vitest';
import { STATION_LEASE_TTL_S, stationLeaseLive } from '../src/station-session';
import { projectDisplayDiagnosticDocument } from '../src/display-presentation';
import { ChildReviewActionSchema, ChildReviewPromptSchema, childReviewAge } from '../src/display-child-review';
import { DisplayFnbCartSchema, readDisplayFnbCart } from '../src/display-fnb';
import { ConsentActionSchema, ConsentPromptSchema, consentActionAllowed } from '../src/display-consent';
import { DisplayMerchCartSchema, readDisplayMerchCart } from '../src/display-merch';

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

describe('finite guest F&B presentation (SCRUM-201)', () => {
  const cart = { kind: 'fnb', supported: true,
    lines: [{ id: 'line-1', name: 'Cold drink', translations: { en: 'Cold drink', th: 'Drink TH' }, qty: 2,
      basePrice: 40, lineTotal: 100, modifiers: [{ groupName: 'Size', optionName: 'Large', price: 10 }], note: 'Less ice', variantLabel: 'Large' }],
    orderNote: 'Serve together', manualDiscounts: [{ id: 'discount-1', scope: 'order', type: 'fixed', value: 10 }], completion: null };
  const completion = { saleId: 'sale-1', pickupCode: 'A12', total: 90, payment: { cash: 30, card: 20, promptpay: 40 } };
  it('retains captured rows and strips catalog, staff, wristband and private fields recursively', () => {
    const parsed = DisplayFnbCartSchema.parse({ ...cart, wristband: { allergiesMedical: 'private' }, operatorName: 'private',
      lines: cart.lines.map(line => ({ ...line, menuItem: { cost: 10 }, translations: { ...line.translations, internal: 'private' },
        modifiers: line.modifiers.map(modifier => ({ ...modifier, cost: 2, internal: 'private' })) })),
      manualDiscounts: cart.manualDiscounts.map(discount => ({ ...discount, reason: 'private', appliedBy: 'private' })),
    });
    expect(parsed).toEqual(cart);
    expect(JSON.stringify(parsed)).not.toMatch(/private|wristband|operatorName|menuItem|cost|reason|appliedBy/);
  });
  it('refuses bounds and invalid money without silently discarding order lines', () => {
    for (const invalid of [
      { ...cart, lines: Array.from({ length: 201 }, (_, i) => ({ ...cart.lines[0], id: `line-${i}` })) },
      { ...cart, lines: [{ ...cart.lines[0], modifiers: Array.from({ length: 101 }, () => cart.lines[0]!.modifiers[0]) }] },
      { ...cart, lines: [{ ...cart.lines[0], qty: 0 }] }, { ...cart, lines: [{ ...cart.lines[0], basePrice: -1 }] },
      { ...cart, lines: [{ ...cart.lines[0], lineTotal: 100.001 }] }, { ...cart, orderNote: 'x'.repeat(1001) },
      { ...cart, completion: { ...completion, payment: { cash: 30, card: 20, promptpay: 39 } } },
      { ...cart, supported: false },
    ]) expect(DisplayFnbCartSchema.safeParse(invalid).success).toBe(false);
  });
  it('allows completion only at thank-you, including zero sales, and always allows a safe empty fallback', () => {
    for (const stage of ['welcome', 'order', 'payment']) {
      expect(readDisplayFnbCart(cart, stage)).toEqual(cart);
      expect(readDisplayFnbCart({ ...cart, completion }, stage)).toBeNull();
    }
    expect(readDisplayFnbCart(cart, 'thankyou')).toBeNull();
    expect(readDisplayFnbCart({ ...cart, completion }, 'thankyou')?.completion).toEqual(completion);
    expect(readDisplayFnbCart({ ...cart, completion: { ...completion, total: 0, payment: { cash: 0, card: 0, promptpay: 0 } } }, 'thankyou')?.completion?.total).toBe(0);
    const fallback = { kind: 'fnb', supported: false, lines: [], orderNote: '', manualDiscounts: [], completion: null };
    expect(readDisplayFnbCart(fallback, 'thankyou')).toEqual(fallback);
    expect(readDisplayFnbCart(fallback, 'input')).toBeNull();
  });
  it('records F&B facts but no member/contact bleed or usable payment QR, and rejects malformed legacy fallthrough', () => {
    const frame = { stationId: '018f0000-0000-7000-8000-000000000001', boxId: '018f0000-0000-7000-8000-000000000002',
      schemaVersion: 1, sequence: 4, stage: 'payment', language: 'en', takeoverCount: 0, updatedAt: '2026-09-29T12:00:00.000Z' };
    const projected = projectDisplayDiagnosticDocument({ ...frame, cart,
      member: { id: 'member', nickname: 'Private marker', tier: 'member' },
      prompt: { kind: 'contact', phone: 'Private marker', answer: 'Private marker' },
      payment: { saleId: 'sale-1', amountSatang: 9000, qrPayload: 'QR fixture contents', qrImageUrl: 'https://example.test/qr.png',
        expiresAt: null, status: 'pending', online: true, offline: false },
    });
    expect(projected?.cart).toEqual(cart);
    expect(projected?.member).toBeNull(); expect(projected?.prompt).toBeNull();
    expect(projected?.payment).toMatchObject({ amountSatang: 9000, hasQrPayload: true, hasQrImage: true });
    expect(JSON.stringify(projected)).not.toMatch(/Private marker|QR fixture contents|example\.test/);
    expect(projectDisplayDiagnosticDocument({ ...frame, cart: { kind: 'fnb', supported: true, sale: { tier: 'tourist' } } })?.cart).toBeNull();
  });
});

// Public consent remains a visitor draft; registration is authorised at the till.
describe('finite guardian acknowledgement (SCRUM-201)', () => {
  const prompt = { kind: 'consent', requestId: 'request', visitorId: 'visitor',
    slots: [{ id: 'slot', name: 'Child one', ageYears: 6, requirement: 'drop_off' }],
    guardianName: 'Guardian', consentRequired: true, consentAcknowledged: true,
    confirmations: [{ id: 'safety', text: 'Confirm the pickup arrangements', required: true, acknowledged: true }],
    staffReady: true, canContinue: true, completed: false };
  it('requires current staff readiness and every required acknowledgement before Done', () => {
    expect(ConsentPromptSchema.safeParse(prompt).success).toBe(true);
    for (const invalid of [
      { ...prompt, staffReady: false }, { ...prompt, consentRequired: false },
      { ...prompt, consentAcknowledged: false }, { ...prompt, guardianName: ' ' },
      { ...prompt, confirmations: [{ ...prompt.confirmations[0], acknowledged: false }] },
      { ...prompt, slots: [...prompt.slots, prompt.slots[0]] },
      { ...prompt, slots: [{ ...prompt.slots[0], ageYears: 18 }] },
      { ...prompt, staffReady: false, canContinue: false, completed: true },
      { ...prompt, slots: Array.from({ length: 51 }, (_, index) => ({ ...prompt.slots[0], id: `slot-${index}` })) },
    ]) expect(ConsentPromptSchema.safeParse(invalid).success).toBe(false);
  });
  it('strips private fields from the finite public prompt and refuses private action writes', () => {
    const parsed = ConsentPromptSchema.parse({ ...prompt, policy: 'Private marker',
      slots: prompt.slots.map(slot => ({ ...slot, allergiesMedical: 'Private marker', childPhotoUrl: 'Private marker', waived: true })),
      confirmations: prompt.confirmations.map(item => ({ ...item, appliedBy: 'Private marker' })) });
    expect(parsed).toEqual(prompt);
    const action = { action: 'acknowledge', requestId: 'request', visitorId: 'visitor', guardianName: ' Guardian ',
      consentAcknowledged: true, acknowledgedConfirmationIds: ['safety'] };
    expect(ConsentActionSchema.parse(action)).toMatchObject({ guardianName: 'Guardian' });
    expect(ConsentActionSchema.safeParse({ ...action, childPhotoUrl: 'Private marker' }).success).toBe(false);
    expect(ConsentActionSchema.safeParse({ ...action, acknowledgedConfirmationIds: ['safety', 'safety'] }).success).toBe(false);
    const current = ConsentPromptSchema.parse(prompt);
    const accepted = ConsentActionSchema.parse(action);
    expect(consentActionAllowed(current, accepted)).toBe(true);
    for (const refused of [{ ...action, requestId: 'old-request' }, { ...action, visitorId: 'old-visitor' },
      { ...action, acknowledgedConfirmationIds: ['unknown'] }]) {
      expect(consentActionAllowed(current, ConsentActionSchema.parse(refused))).toBe(false);
    }
    expect(consentActionAllowed(current, { action: 'done', requestId: 'request', visitorId: 'visitor' })).toBe(true);
    expect(consentActionAllowed({ ...current, staffReady: false, canContinue: false }, { action: 'done', requestId: 'request', visitorId: 'visitor' })).toBe(false);
  });
  it('records prompt metadata only, without guardian, child details or acknowledgement answers', () => {
    const frame = { stationId: '018f0000-0000-7000-8000-000000000001', boxId: '018f0000-0000-7000-8000-000000000002',
      schemaVersion: 1, sequence: 4, stage: 'input', language: 'en', takeoverCount: 0, updatedAt: '2026-09-29T12:00:00.000Z' };
    const projected = projectDisplayDiagnosticDocument({ ...frame, prompt: { ...prompt,
      answer: { type: 'consent', actionId: 'answer', payload: { action: 'done', requestId: 'request', visitorId: 'visitor' } } } });
    expect(projected?.prompt).toEqual({ kind: 'consent', requestId: 'request', hasAnswer: true });
    expect(JSON.stringify(projected)).not.toMatch(/Guardian|Child one|pickup arrangements|visitor|consentAcknowledged|slots/);
  });
});

describe('finite guest shop presentation (SCRUM-201)', () => {
  const cart = { kind: 'merch', supported: true,
    lines: [{ id: 'line-1', name: 'Grip Socks (M)', qty: 2, unitPrice: 120, lineTotal: 240 }],
    manualDiscounts: [{ id: 'discount-1', scope: 'order', type: 'fixed', value: 10 }], completion: null };
  const completion = { saleId: 'sale-1', total: 230, payment: { cash: 100, card: 130, promptpay: 0 } };
  it('keeps finite captured purchase facts and strips wallet, stock and staff audit fields', () => {
    const parsed = DisplayMerchCartSchema.parse({ ...cart, wristband: { creditBalanceTHB: 20 },
      lines: cart.lines.map(line => ({ ...line, merchItem: { cost: 2, stock: 8 } })),
      manualDiscounts: cart.manualDiscounts.map(discount => ({ ...discount, reason: 'Private marker', appliedBy: 'Private marker' })) });
    expect(parsed).toEqual(cart);
    const frame = { stationId: '018f0000-0000-7000-8000-000000000001', boxId: '018f0000-0000-7000-8000-000000000002',
      schemaVersion: 1, sequence: 4, stage: 'payment', language: 'en', takeoverCount: 0, updatedAt: '2026-09-29T12:00:00.000Z' };
    const projected = projectDisplayDiagnosticDocument({ ...frame, cart: parsed,
      member: { id: 'member', nickname: 'Private marker', tier: 'member' }, prompt: { kind: 'contact', phone: 'Private marker' },
      payment: { saleId: 'sale-1', amountSatang: 23000, qrPayload: 'QR fixture contents', qrImageUrl: 'https://example.test/qr.png',
        expiresAt: null, status: 'pending', online: true, offline: false } });
    expect(projected?.cart).toEqual(cart);
    expect(projected?.member).toBeNull(); expect(projected?.prompt).toBeNull();
    expect(projected?.payment).toMatchObject({ hasQrPayload: true, hasQrImage: true });
    expect(JSON.stringify(projected)).not.toMatch(/Private marker|QR fixture contents|example\.test|creditBalance|merchItem|stock/);
  });
  it('refuses wrong-stage, unsafe money and unsettled completion and permits only a cleared fallback', () => {
    expect(readDisplayMerchCart(cart, 'order')).toEqual(cart);
    expect(readDisplayMerchCart(cart, 'input')).toBeNull();
    expect(readDisplayMerchCart(cart, 'thankyou')).toBeNull();
    expect(readDisplayMerchCart({ ...cart, completion }, 'thankyou')?.completion).toEqual(completion);
    expect(readDisplayMerchCart({ ...cart, completion }, 'payment')).toBeNull();
    for (const invalid of [{ ...cart, supported: false }, { ...cart, lines: [{ ...cart.lines[0], qty: 0 }] },
      { ...cart, lines: [{ ...cart.lines[0], unitPrice: 120.001 }] },
      { ...cart, lines: Array.from({ length: 201 }, (_, index) => ({ ...cart.lines[0], id: `line-${index}` })) },
      { ...cart, completion: { ...completion, payment: { cash: 100, card: 129, promptpay: 0 } } }]) {
      expect(DisplayMerchCartSchema.safeParse(invalid).success).toBe(false);
    }
    const fallback = { kind: 'merch', supported: false, lines: [], manualDiscounts: [], completion: null };
    expect(readDisplayMerchCart(fallback, 'thankyou')).toEqual(fallback);
  });
});
