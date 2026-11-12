import * as React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentPromptSchema, type ConsentAction, type ConsentFormStep, type ConsentPrompt } from '@oto/shared';
import { DisplayChildPhoto, MirrorChildPhoto } from '@/components/till/DisplayChildPhoto';
import { PHOTO_RESEND_MS, PHOTO_TRIES, PublicConsentCapture, SLOW_SEND_MS } from '@/components/till/PublicConsentCapture';
import { renderHook } from './support/hooks';

vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')) }));
vi.mock('@/i18n/LanguageContext', () => ({ tFor: () => (key: string) => key,
  useLanguage: () => ({ lang: 'en', t: (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}:${Object.values(vars).join(',')}` : key }) }));
beforeEach(() => { vi.stubGlobal('React', React); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/**
 * SCRUM-857 — THE FOUR PARTS OF THE DROP-OFF AND NANNY FORM, TOGETHER.
 *
 * The owner's rulings of 8 and 12 November, joined on one form: the family
 * confirms their messaging number, staff watch the form as it is filled
 * (the family's screen sends it as they type), the family takes each
 * child's photo on their own screen, and their Done moves the sale on once
 * every check passes, saying why when it cannot. These tests pin where the
 * parts meet:
 *
 * - a photo is named to the till only when no other answer of the screen is
 *   out, a live fill included, and named again if the till still shows no
 *   photo for that child a moment later;
 * - the till's copy of the family's screen shows the photo the till holds
 *   where the family has the camera, and never opens a camera;
 * - the line under the form reads the photo marks, and says the screen is
 *   sending when Done waits on the last change for more than a moment;
 * - on the paired display a photo answer does not lock the form, as a fill
 *   does not.
 */

type Element = React.ReactElement<Record<string, unknown>>;
const elements = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(elements) :
  React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children)] : [];
const words = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node) :
  Array.isArray(node) ? node.map(words).join('') : React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';

const START = '+66898020001'; // ZZ TEST number, used only by this fixture.
const FILE_ID = '0190f0a4-7b7e-7c3a-9f1e-1a2b3c4d5e6f';
const OTHER_FILE_ID = '0190f0a4-7b7e-7c3a-9f1e-1a2b3c4d5e70';
const PICTURE = 'data:image/jpeg;base64,/9j/4AAQ';

type Slot = ConsentPrompt['slots'][number];
const child = (id: string, extra: Partial<Slot> = {}): Slot => ({ id, name: 'ZZ TEST Mai', ageYears: 6, requirement: 'drop_off',
  dateOfBirth: null, allergiesMedical: '', foodRestrictions: '', photo: 'needed', ...extra });
/** A form the family has filled in on every count but the photo, on the care step. */
const promptOf = (extra: Partial<ConsentPrompt> = {}): ConsentPrompt => ({
  kind: 'consent', requestId: 'zz-joined-1', visitorId: 'zz-joined-visitor',
  slots: [child('a')],
  guardianName: 'ZZ TEST Ploy', guardianPhone: START, contactChannel: 'whatsapp', contactConfirmed: true, familyStep: 'care',
  consentRequired: true, consentAcknowledged: true,
  confirmations: [{ id: 'pickup', text: 'ZZ TEST pick-up before closing', required: true, acknowledged: true }],
  staffReady: false, canContinue: false, completed: false, ...extra,
});

interface Props {
  prompt: ConsentPrompt;
  busy?: boolean;
  answerPending?: boolean;
  mirror?: { step: ConsentFormStep | null; photos?: Readonly<Record<string, string>> };
  sends?: boolean;
}

function open(initial: Props) {
  const sent: ConsentAction[] = [];
  let props = initial;
  const view = renderHook((p: Props) => PublicConsentCapture({ prompt: p.prompt, busy: p.busy ?? false,
    answerPending: p.answerPending ?? p.busy ?? false, mirror: p.mirror,
    ...(p.sends === false ? {} : { sendPhoto: async () => FILE_ID }),
    onAction: (action) => { sent.push(action); } }), initial);
  const all = () => elements(view.result.current);
  const set = (next: Partial<Props>) => { props = { ...props, ...next }; view.rerender(props); };
  return {
    view, sent, all, set,
    photosSent: () => sent.filter((action) => action.action === 'photo'),
    /** The till's newer copy of the form, under a new request. */
    till: (extra: Partial<ConsentPrompt>, request: string) => set({ prompt: { ...props.prompt, ...extra, requestId: request } }),
    familyPhoto: () => all().find((node) => node.type === DisplayChildPhoto),
    mirrorPhoto: () => all().find((node) => node.type === MirrorChildPhoto),
    testId: (testId: string) => all().find((node) => node.props['data-testid'] === testId),
    text: () => words(view.result.current),
  };
}
const withCamera = () => vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(),
  enumerateDevices: vi.fn(async () => [{ kind: 'videoinput' }]) } });

describe('the family’s photo and the live form share one answer at a time', () => {
  it('a photo waits while a live fill is out, then goes', () => {
    withCamera();
    const form = open({ prompt: promptOf(), answerPending: true });
    (form.familyPhoto()!.props.onStored as (id: string) => void)(FILE_ID);
    vi.advanceTimersByTime(PHOTO_RESEND_MS * 2);
    expect(form.photosSent()).toHaveLength(0);
    form.set({ answerPending: false });
    expect(form.photosSent()).toEqual([{ action: 'photo', requestId: 'zz-joined-1', visitorId: 'zz-joined-visitor', slotId: 'a', fileId: FILE_ID }]);
    form.view.unmount();
  });

  it('a photo the till still shows as needed a moment later is named again, a few times in all', () => {
    withCamera();
    const form = open({ prompt: promptOf() });
    (form.familyPhoto()!.props.onStored as (id: string) => void)(FILE_ID);
    expect(form.photosSent()).toHaveLength(1);
    // The till took the answer (a new request), but holds no photo yet.
    form.till({}, 'zz-joined-2');
    vi.advanceTimersByTime(PHOTO_RESEND_MS - 1);
    expect(form.photosSent()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(form.photosSent()).toHaveLength(2);
    expect(form.photosSent()[1]).toMatchObject({ requestId: 'zz-joined-2', fileId: FILE_ID });
    for (let request = 3; request < 10; request += 1) {
      form.till({}, `zz-joined-${request}`);
      vi.advanceTimersByTime(PHOTO_RESEND_MS);
    }
    expect(form.photosSent()).toHaveLength(PHOTO_TRIES);
    expect(new Set(form.photosSent().map((action) => action.action === 'photo' && action.fileId))).toEqual(new Set([FILE_ID]));
    form.view.unmount();
  });

  it('once the till holds the child’s photo, it is not named again', () => {
    withCamera();
    const form = open({ prompt: promptOf() });
    (form.familyPhoto()!.props.onStored as (id: string) => void)(FILE_ID);
    form.till({ slots: [child('a', { photo: 'taken' })], staffReady: true, canContinue: true }, 'zz-joined-2');
    vi.advanceTimersByTime(PHOTO_RESEND_MS * 3);
    expect(form.photosSent()).toHaveLength(1);
    form.view.unmount();
  });

  it('a retake is a new file, named in place of the earlier one', () => {
    withCamera();
    const form = open({ prompt: promptOf(), answerPending: true });
    (form.familyPhoto()!.props.onStored as (id: string) => void)(FILE_ID);
    (form.familyPhoto()!.props.onStored as (id: string) => void)(OTHER_FILE_ID);
    form.set({ answerPending: false });
    expect(form.photosSent()).toEqual([expect.objectContaining({ fileId: OTHER_FILE_ID })]);
    form.view.unmount();
  });

  it('“Ask the team”, waiting for the same free moment, goes first; the photo follows once it is taken', () => {
    withCamera();
    const form = open({ prompt: promptOf(), answerPending: true });
    (form.familyPhoto()!.props.onStored as (id: string) => void)(FILE_ID);
    const ask = form.all().find((node) => words(node.props.children) === 'superviseConsent.askTeam');
    (ask!.props.onClick as () => void)();
    form.set({ answerPending: false });
    expect(form.sent.map((action) => action.action)).toEqual(['staff_help']);
    form.set({ answerPending: true });
    form.till({}, 'zz-joined-2');
    form.set({ answerPending: false });
    expect(form.sent.map((action) => action.action)).toEqual(['staff_help', 'photo']);
    form.view.unmount();
  });
});

describe('the till’s copy of the family’s screen shows their photo, and never a camera', () => {
  it('shows the photo the till holds where the family has the camera', () => {
    const enumerateDevices = vi.fn(async () => [{ kind: 'videoinput' }]);
    const getUserMedia = vi.fn();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices } });
    const prompt = promptOf({ requestId: 'staff-mirror', slots: [child('a', { photo: 'taken' })], staffReady: true, canContinue: true });
    expect(ConsentPromptSchema.safeParse(prompt).success).toBe(true);
    const form = open({ prompt, mirror: { step: 'care', photos: { a: PICTURE } }, sends: false });
    expect(form.mirrorPhoto()!.props).toEqual({ mark: 'taken', photo: PICTURE });
    expect(form.familyPhoto()).toBeUndefined();
    expect(form.text()).not.toContain('superviseConsent.photoAtReception');
    expect(enumerateDevices).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
    form.view.unmount();
  });

  it('a photo not taken yet reads as none yet, and a form with no marks keeps the reception line', () => {
    const waiting = open({ prompt: promptOf({ requestId: 'staff-mirror' }), mirror: { step: 'care' }, sends: false });
    expect(waiting.mirrorPhoto()!.props).toEqual({ mark: 'needed', photo: undefined });
    waiting.view.unmount();
    const older = open({ prompt: promptOf({ requestId: 'staff-mirror', slots: [child('a', { photo: undefined })] }),
      mirror: { step: 'care' }, sends: false });
    expect(older.mirrorPhoto()).toBeUndefined();
    expect(older.text()).toContain('superviseConsent.photoAtReception');
    older.view.unmount();
  });

  it('the block itself: the family’s wording, the photo or “no photo yet”, and the team’s line once taken', () => {
    const taken = renderHook(() => MirrorChildPhoto({ mark: 'taken', photo: PICTURE }), undefined);
    expect(words(taken.result.current)).toContain('superviseConsent.photoTitle');
    expect(elements(taken.result.current).find((node) => node.type === 'img')!.props.src).toBe(PICTURE);
    expect(words(taken.result.current)).toContain('superviseConsent.photoReceived');
    taken.unmount();
    const none = renderHook(() => MirrorChildPhoto({ mark: 'needed' }), undefined);
    expect(elements(none.result.current).some((node) => node.type === 'img')).toBe(false);
    expect(words(none.result.current)).toContain('camera.noPhoto');
    expect(words(none.result.current)).not.toContain('superviseConsent.photoReceived');
    none.unmount();
  });

  it('shows staff what the family still needs before Done, on every step at once when their screen does not say', () => {
    const form = open({ prompt: promptOf({ requestId: 'staff-mirror', familyStep: undefined, consentAcknowledged: false }),
      mirror: { step: null }, sends: false });
    expect(words(form.testId('consent-missing'))).toContain('superviseConsent.missingConsent');
    form.view.unmount();
  });
});

describe('the line under the form: what Done still waits on', () => {
  const agreements = (extra: Partial<ConsentPrompt>) => promptOf({ familyStep: 'agreements', ...extra });

  it('names the photo while the till shows one still needed, whatever staffReady says', () => {
    const needed = open({ prompt: agreements({ staffReady: true }) });
    expect(words(needed.testId('consent-missing'))).toContain('superviseConsent.missingPhoto');
    needed.view.unmount();
    // Taken, while the till is busy writing (staffReady false): not a missing photo.
    const taken = open({ prompt: agreements({ slots: [child('a', { photo: 'taken' })], staffReady: false }) });
    expect(taken.testId('consent-missing')).toBeUndefined();
    taken.view.unmount();
    // A till that marks no photo still says it through staffReady.
    const unmarked = open({ prompt: agreements({ slots: [child('a', { photo: undefined })], staffReady: false }) });
    expect(words(unmarked.testId('consent-missing'))).toContain('superviseConsent.missingPhoto');
    unmarked.view.unmount();
  });

  it('says it is sending when Done waits on the last change for more than a moment, and not before', () => {
    const ready = agreements({ slots: [child('a', { photo: 'taken' })], staffReady: true, canContinue: true });
    const form = open({ prompt: ready, answerPending: true });
    expect(form.testId('consent-missing')).toBeUndefined();
    vi.advanceTimersByTime(SLOW_SEND_MS - 1);
    expect(form.testId('consent-missing')).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(words(form.testId('consent-missing'))).toBe('display.sending');
    form.set({ answerPending: false });
    expect(form.testId('consent-missing')).toBeUndefined();
    const done = form.all().find((node) => words(node.props.children) === 'common.done');
    expect(done!.props.disabled).toBe(false);
    form.view.unmount();
  });
});

describe('the paired display', () => {
  const display = readFileSync(resolve(import.meta.dirname, '../src/pages/Display.tsx'), 'utf8');

  it('does not lock the form for a photo answer, as for a fill, and keeps a refusal of either quiet', () => {
    expect(display).toMatch(/return action === 'fill' \|\| action === 'photo';/);
    expect(display).toMatch(/pending\.current\.type === 'display\.consent' && isLive\(pending\.current\.payload\)\)\s*&& \(!answer \|\| isLive\(/);
    expect(display).toContain("send('display.consent', action, action.action === 'fill' || action.action === 'photo')");
    expect(display).toContain('sendPhoto={(form, dataUrl) => sendDisplayConsentPhoto(bearerRef.current, form, dataUrl)}');
  });
});
