import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConsentActionSchema,
  ConsentPromptSchema,
  consentActionAllowed,
  type ConsentPrompt,
  type StationSessionDocument,
} from '@oto/shared';
import { cartQuote, settle } from './support/fixtures';
import { renderHook, type RenderedHook } from './support/hooks';
import type { SupervisedSlot } from '@/components/till/SupervisionGate';
import { staffTicksAgreements, takeConsentAction } from '@/lib/consentForm';
import { useTicketDisplay, type DisplayAnswer, type TicketDisplayState } from '@/lib/displaySession';
import type { Sale } from '@/types';

/**
 * SCRUM-764 — THE TILL FOLLOWS THE FAMILY'S FORM, AND THE FAMILY'S SCREEN
 * NEVER LOCKS ON AN ANSWER THE TILL HAS TAKEN.
 *
 * The station keeps an answer on the customer's screen until the till
 * publishes the form under a new request, and the screen stays still while it
 * does. A step that changed nothing (Back then Continue, the same date of
 * birth chosen again) used to leave the form exactly as it was, so the till
 * published nothing new and the family's screen waited for ever.
 *
 * Driven here through the till's own publisher (`useTicketDisplay`) and the
 * till's own handling of an answer (`takeConsentAction`), against a station
 * that keeps an answer under the same request id as the box does
 * (`packages/box-agent/test/station-session.test.ts` pins that side).
 */
vi.mock('react', () => import('./support/hooks'));

const sale = {
  id: 'sale-764', operatorId: 'op', operatorName: 'Staff', tier: 'tourist', total: 0, lines: [],
  manualDiscounts: [], creditGrants: [], bracelets: { adults: 0, children: 0 }, createdAt: '', status: 'paid',
  refunds: [],
} as unknown as Sale;

/** The till's state for the form, as `pages/Till.tsx` holds it. */
interface TillModel {
  slots: SupervisedSlot[];
  guardianName: string;
  guardianPhone: string;
  /** SCRUM-863 — the channel the till holds for the registration. */
  guardianChannel: 'whatsapp' | 'telegram' | 'line';
  consentAck: boolean;
  confirmationIds: string[];
  completed: string | null;
  staffOnly: boolean;
  answerRevision: number;
}

const slot = (extra: Partial<SupervisedSlot> = {}): SupervisedSlot => ({
  id: 'slot-a', sourceLineId: 'line', ticketType: {} as SupervisedSlot['ticketType'], name: 'Mai', age: '6',
  waived: false, allergiesMedical: '', foodRestrictions: '', mayOrderFood: false, ...extra,
});

/** The prompt the till builds from its state (`consentBase` in Till.tsx). */
const promptOf = (till: TillModel): Omit<ConsentPrompt, 'kind' | 'requestId' | 'completed'> => ({
  visitorId: 'visitor-764',
  slots: till.slots.map((s) => ({
    id: s.id, name: s.name, ageYears: s.age === '' ? null : Number(s.age),
    requirement: 'drop_off' as const, dateOfBirth: s.dateOfBirth ?? null,
    allergiesMedical: s.allergiesMedical, foodRestrictions: s.foodRestrictions,
  })),
  guardianName: till.guardianName, consentRequired: true, consentAcknowledged: till.consentAck,
  confirmations: [{
    id: 'pickup', text: 'I will collect my child before closing', required: true,
    acknowledged: till.confirmationIds.includes('pickup'),
  }],
  guardianPhone: till.guardianPhone, contactChannel: till.guardianChannel, staffReady: false, canContinue: false,
});

const stateOf = (till: TillModel): TicketDisplayState => {
  const base = promptOf(till);
  const signature = JSON.stringify(base);
  return {
    stage: 'input', step: 7, sessionKey: '1', tier: 'tourist', phone: till.guardianPhone, nickname: '',
    contactChannel: 'whatsapp', member: null, sale, totals: cartQuote(0).totals, rateMode: 'weekday', online: true,
    consent: { ...base, completed: till.completed === signature },
    consentRevision: `${signature}:${till.completed === signature}:${till.staffOnly}`,
    answerRevision: till.answerRevision,
  };
};

/** The till's answer handler for the form: check it, take it in, move the screen on. */
const handlerFor = (till: TillModel, options: { moveOn: boolean }) => (answer: DisplayAnswer): boolean => {
  if (answer.type !== 'consent') return false;
  const action = ConsentActionSchema.safeParse(answer.payload);
  const state = stateOf(till);
  const prompt = ConsentPromptSchema.safeParse({ ...state.consent, kind: 'consent', requestId: answer.payload.requestId });
  if (!action.success || !prompt.success || !consentActionAllowed(prompt.data, action.data)) return false;
  takeConsentAction(action.data, {
    slots: till.slots, guardianPhone: till.guardianPhone, signature: JSON.stringify(promptOf(till)),
    updateSlot: (id, patch) => { till.slots = till.slots.map((s) => (s.id === id ? { ...s, ...patch } : s)); },
    setGuardianName: (name) => { till.guardianName = name; },
    setGuardianPhone: (phone) => { till.guardianPhone = phone; },
    setContactChannel: (channel) => { till.guardianChannel = channel; },
    setConsentAcknowledged: (value) => { till.consentAck = value; },
    setAcknowledgedConfirmationIds: (ids) => { till.confirmationIds = ids; },
    setCompletedSignature: (signature) => { till.completed = signature; },
    askedForHelp: () => { till.staffOnly = true; },
    answered: () => { if (options.moveOn) till.answerRevision += 1; },
  });
  return true;
};

const reply = (data: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => data }) as Response;

/**
 * A station with one paired display. Like the box, a publish under the SAME
 * request id keeps the answer already on the screen; a new request id clears it.
 */
function station() {
  let doc: StationSessionDocument = {
    stationId: 'station-764', boxId: 'box-1', schemaVersion: 1, sequence: 0,
    stage: 'welcome', language: 'en', lease: null, takeoverCount: 0, updatedAt: '2026-11-05T10:00:00.000Z',
  };
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/displays')) return reply({ displays: [{ id: 'display-1', name: 'Counter screen', connected: true }] });
    if (path.endsWith('/lease')) {
      doc = {
        ...doc, lease: {
          leaseId: 'lease-764', holder: 'till', holderKind: 'till', accountId: 'account-1',
          startedAt: doc.updatedAt, heartbeatAt: doc.updatedAt, expiresAt: '2026-11-05T10:01:00.000Z',
        },
      };
      return reply({ document: doc, lease: doc.lease });
    }
    if (path.endsWith('/lease/renew') || path.endsWith('/session')) return reply({ document: doc });
    if (path.endsWith('/intents')) {
      const body = JSON.parse(String(init?.body)) as { payload: Partial<StationSessionDocument> };
      const next = body.payload.prompt as Record<string, unknown> | null | undefined;
      const held = doc.prompt as Record<string, unknown> | null | undefined;
      const kept = next && held && next.requestId === held.requestId && next.kind === held.kind
        && held.answer !== undefined ? { answer: held.answer } : {};
      doc = {
        ...doc, ...body.payload,
        prompt: (next ? { ...next, ...kept } : null) as StationSessionDocument['prompt'],
        sequence: doc.sequence + 1,
      };
      return reply({ document: doc });
    }
    return reply({ released: true });
  }));
  return {
    current: () => doc,
    /** The family presses a button: the station takes it only while nothing else waits on the screen. */
    send: (action: Record<string, unknown>, actionId: string): boolean => {
      const prompt = doc.prompt as Record<string, unknown> | null | undefined;
      if (!prompt || prompt.answer !== undefined) return false;
      doc = {
        ...doc, sequence: doc.sequence + 1,
        prompt: { ...prompt, answer: { type: 'consent', actionId, payload: action } } as StationSessionDocument['prompt'],
      };
      return true;
    },
  };
}

const requestOf = (doc: StationSessionDocument) => (doc.prompt as { requestId?: string } | null | undefined)?.requestId;
const answerOf = (doc: StationSessionDocument) => (doc.prompt as { answer?: { actionId?: string } } | null | undefined)?.answer;

/** Back, then Continue on the care step: the form exactly as the till already holds it. */
const unchangedStep = (requestId: string, extra: Record<string, unknown> = {}) => ({
  action: 'fill', requestId, visitorId: 'visitor-764',
  slots: [{ id: 'slot-a', name: 'Mai', dateOfBirth: null, ageYears: 6, allergiesMedical: '', foodRestrictions: '' }],
  guardianName: '', consentAcknowledged: false, acknowledgedConfirmationIds: [], ...extra,
});

describe('SCRUM-764 — the family’s screen after each step of the form', () => {
  let hook: RenderedHook<void, ReturnType<typeof useTicketDisplay>> | undefined;
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { hook?.unmount(); hook = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

  const start = async (moveOn: boolean) => {
    const till: TillModel = {
      slots: [slot()], guardianName: '', guardianPhone: '+66812345678', guardianChannel: 'whatsapp', consentAck: false,
      confirmationIds: [], completed: null, staffOnly: false, answerRevision: 0,
    };
    const box = station();
    const onAnswer = vi.fn(handlerFor(till, { moveOn }));
    hook = renderHook(() => useTicketDisplay('station-764', stateOf(till), onAnswer));
    await settle();
    const first = requestOf(box.current());
    expect(first).toBeTruthy();
    return { till, box, onAnswer, first: first! };
  };
  /** The till's poll picks the answer up, React renders what it changed, the next poll publishes. */
  const followed = async () => {
    await vi.advanceTimersByTimeAsync(1_500);
    hook!.rerender();
    await vi.advanceTimersByTimeAsync(1_500);
  };

  it('a step that changes nothing still moves the screen on: a new request, the answer cleared, the next step taken', async () => {
    const { till, box, onAnswer, first } = await start(true);
    expect(box.send(unchangedStep(first), 'unchanged-step')).toBe(true);
    await followed();
    expect(onAnswer).toHaveBeenCalledTimes(1);
    const second = requestOf(box.current());
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(answerOf(box.current())).toBeUndefined();

    // The family carries on: the guardian's name reaches the till and is on the form it publishes.
    expect(box.send(unchangedStep(second!, { guardianName: 'Ploy' }), 'next-step')).toBe(true);
    await followed();
    expect(till.guardianName).toBe('Ploy');
    expect(box.current().prompt).toMatchObject({ kind: 'consent', guardianName: 'Ploy' });
    expect(answerOf(box.current())).toBeUndefined();
  });

  it('without moving on, the station keeps the answer and the family’s screen waits: the lock this guards against', async () => {
    const { box, onAnswer, first } = await start(false);
    expect(box.send(unchangedStep(first), 'unchanged-step')).toBe(true);
    await followed();
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(requestOf(box.current())).toBe(first);
    expect(answerOf(box.current())).toMatchObject({ actionId: 'unchanged-step' });
    expect(box.send(unchangedStep(first, { guardianName: 'Ploy' }), 'next-step')).toBe(false);
  });

  it('the same date of birth chosen twice is taken in and moves the screen on both times', async () => {
    const { box, first } = await start(true);
    expect(box.send(unchangedStep(first), 'first-pick')).toBe(true);
    await followed();
    const after = requestOf(box.current());
    expect(after).not.toBe(first);
    expect(box.send(unchangedStep(after!), 'same-again')).toBe(true);
    await followed();
    expect(requestOf(box.current())).not.toBe(after);
    expect(answerOf(box.current())).toBeUndefined();
  });
});

describe('SCRUM-863 — the number and channel the family changes on the form', () => {
  let hook: RenderedHook<void, ReturnType<typeof useTicketDisplay>> | undefined;
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { hook?.unmount(); hook = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('reach the till and come back on the form it publishes, which starts from the ones given at the start', async () => {
    const till: TillModel = {
      slots: [slot()], guardianName: '', guardianPhone: '+66812345678', guardianChannel: 'whatsapp', consentAck: false,
      confirmationIds: [], completed: null, staffOnly: false, answerRevision: 0,
    };
    const box = station();
    hook = renderHook(() => useTicketDisplay('station-764', stateOf(till), handlerFor(till, { moveOn: true })));
    await settle();
    const first = requestOf(box.current())!;
    expect(box.current().prompt).toMatchObject({ kind: 'consent', guardianPhone: '+66812345678', contactChannel: 'whatsapp' });

    expect(box.send(unchangedStep(first, { guardianPhone: '+66891112222', contactChannel: 'telegram' }), 'changed-number')).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    hook.rerender();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(till.guardianPhone).toBe('+66891112222');
    expect(till.guardianChannel).toBe('telegram');
    expect(box.current().prompt).toMatchObject({ kind: 'consent', guardianPhone: '+66891112222', contactChannel: 'telegram' });
    expect(requestOf(box.current())).not.toBe(first);
    expect(answerOf(box.current())).toBeUndefined();
  });
});

describe('SCRUM-764 — what the till takes from each answer', () => {
  const setters = () => ({
    updateSlot: vi.fn(), setGuardianName: vi.fn(), setGuardianPhone: vi.fn(), setContactChannel: vi.fn(), setConsentAcknowledged: vi.fn(),
    setAcknowledgedConfirmationIds: vi.fn(), setCompletedSignature: vi.fn(), askedForHelp: vi.fn(), answered: vi.fn(),
  });
  const fence = { requestId: 'r', visitorId: 'v' };

  it('every answer moves the screen on, whatever it changed', () => {
    for (const action of [
      { ...fence, action: 'fill' as const, slots: [], guardianName: '', consentAcknowledged: false, acknowledgedConfirmationIds: [] },
      { ...fence, action: 'acknowledge' as const, guardianName: 'Ploy', consentAcknowledged: true, acknowledgedConfirmationIds: [] },
      { ...fence, action: 'done' as const },
      { ...fence, action: 'staff_help' as const },
    ]) {
      const till = setters();
      takeConsentAction(action, { ...till, slots: [], guardianPhone: '', signature: 'form-1' });
      expect(till.answered, action.action).toHaveBeenCalledTimes(1);
    }
  });

  // SCRUM-863 (the owner, 12 November) — the drop-off and nanny forms ask the
  // family to confirm or change the number and the channel; asking once is the
  // ordinary sale's rule only. The two cases here held the earlier reading.
  it('a filled step mirrors the children, the name, the family’s ticks, and the number and channel they confirmed or changed', () => {
    const till = setters();
    takeConsentAction({
      ...fence, action: 'fill', slots: [{
        id: 'slot-a', name: 'Mai', dateOfBirth: '2020-01-02', ageYears: 6, allergiesMedical: 'Peanuts', foodRestrictions: '',
      }], guardianName: 'Ploy', guardianPhone: '0899999999', contactChannel: 'telegram',
      consentAcknowledged: true, acknowledgedConfirmationIds: ['pickup'],
    }, { ...till, slots: [slot()], guardianPhone: '+66812345678', signature: 'form-1' });
    expect(till.updateSlot).toHaveBeenCalledWith('slot-a', expect.objectContaining({ name: 'Mai', age: '6', allergiesMedical: 'Peanuts' }));
    expect(till.setGuardianName).toHaveBeenCalledWith('Ploy');
    // The stored form of the number the family typed, in place of the one from the start.
    expect(till.setGuardianPhone).toHaveBeenCalledWith('+66899999999');
    expect(till.setContactChannel).toHaveBeenCalledWith('telegram');
    expect(till.setConsentAcknowledged).toHaveBeenCalledWith(true);
    expect(till.setAcknowledgedConfirmationIds).toHaveBeenCalledWith(['pickup']);
    expect(till.setCompletedSignature).toHaveBeenCalledWith(null);
  });

  it('a step from an older display, with no number and no channel, changes neither', () => {
    const till = setters();
    takeConsentAction({
      ...fence, action: 'fill', slots: [], guardianName: 'Ploy', consentAcknowledged: false, acknowledgedConfirmationIds: [],
    }, { ...till, slots: [], guardianPhone: '+66812345678', signature: 'form-1' });
    expect(till.setGuardianName).toHaveBeenCalledWith('Ploy');
    expect(till.setGuardianPhone).not.toHaveBeenCalled();
    expect(till.setContactChannel).not.toHaveBeenCalled();
    expect(till.answered).toHaveBeenCalledTimes(1);
  });

  it('a number typed on the form when none was given at the start is taken, as before', () => {
    const till = setters();
    takeConsentAction({
      ...fence, action: 'fill', slots: [], guardianName: 'Ploy', guardianPhone: '0899999999',
      consentAcknowledged: false, acknowledgedConfirmationIds: [],
    }, { ...till, slots: [], guardianPhone: '', signature: 'form-1' });
    expect(till.setGuardianPhone).toHaveBeenCalledWith('+66899999999');
    expect(till.setContactChannel).not.toHaveBeenCalled();
  });

  it('the number confirmed unchanged is not written again, and one that does not read as a number is kept as typed', () => {
    const same = setters();
    takeConsentAction({
      ...fence, action: 'fill', slots: [], guardianName: '', guardianPhone: '+660812345678', contactChannel: 'whatsapp',
      consentAcknowledged: false, acknowledgedConfirmationIds: [],
    }, { ...same, slots: [], guardianPhone: '+66812345678', signature: 'form-1' });
    expect(same.setGuardianPhone).not.toHaveBeenCalled();
    const typed = setters();
    takeConsentAction({
      ...fence, action: 'fill', slots: [], guardianName: '', guardianPhone: '+6681', contactChannel: 'line',
      consentAcknowledged: false, acknowledgedConfirmationIds: [],
    }, { ...typed, slots: [], guardianPhone: '+66812345678', signature: 'form-1' });
    expect(typed.setGuardianPhone).toHaveBeenCalledWith('+6681');
    expect(typed.setContactChannel).toHaveBeenCalledWith('line');
  });

  it('Done marks the form as it is shown finished; asking for help hands it to staff', () => {
    const done = setters();
    takeConsentAction({ ...fence, action: 'done' }, { ...done, slots: [], guardianPhone: '', signature: 'form-1' });
    expect(done.setCompletedSignature).toHaveBeenCalledWith('form-1');
    const help = setters();
    takeConsentAction({ ...fence, action: 'staff_help' }, { ...help, slots: [], guardianPhone: '', signature: 'form-1' });
    expect(help.askedForHelp).toHaveBeenCalledTimes(1);
    expect(help.setConsentAcknowledged).not.toHaveBeenCalled();
  });
});

describe('SCRUM-764 — who ticks the agreements', () => {
  const online = { formPublished: true, displayConnected: true, displaySupported: true, displayError: false };

  it('the family, while the form is on their screen: staff cannot', () => {
    expect(staffTicksAgreements(online)).toBe(false);
  });

  it.each([
    ['the counter box lane or a price still pending, so the till does not publish the form', { ...online, formPublished: false }],
    ['the display has gone', { ...online, displayConnected: false }],
    ['the display cannot show this', { ...online, displaySupported: false }],
    ['the display could not connect', { ...online, displayError: true }],
  ])('staff, with the family, when the family has no form to tick on: %s', (_case, input) => {
    expect(staffTicksAgreements(input)).toBe(true);
  });
});
