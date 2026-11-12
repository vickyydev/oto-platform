import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentActionSchema, consentActionAllowed, type ConsentAction, type ConsentPrompt } from '@oto/shared';
import { CameraCapture } from '@/components/shared/CameraCapture';
import { DisplayChildPhoto, useCameraPresence } from '@/components/till/DisplayChildPhoto';
import { PublicConsentCapture } from '@/components/till/PublicConsentCapture';
import { collectDisplayConsentPhoto, photoOfDataUrl, sendDisplayConsentPhoto } from '@/api/consentPhoto';
import { consentSlotPhoto, takeConsentAction } from '@/lib/consentForm';
import { DisplayError } from '@/api/display';
import { renderHook } from './support/hooks';

vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')) }));
vi.mock('@/i18n/LanguageContext', () => ({ tFor: () => (key: string) => key,
  useLanguage: () => ({ lang: 'en', t: (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}:${Object.values(vars).join(',')}` : key }) }));
const apiGet = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ api: { get: apiGet } }));
beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => { vi.restoreAllMocks(); apiGet.mockReset(); });

/**
 * SCRUM-857 — THE FAMILY TAKES THE CHILD'S PHOTO ON THE PAIRED DISPLAY.
 *
 * The owner's ruling of 8 November: in the care details the customer takes
 * the photo with a button, instead of reception. On the paired display the
 * care step shows the camera for each child the till marks `photo`; the
 * picture goes to the platform for this form and child and a `photo` answer
 * names it to the till, which keeps it where a staff-taken photo is kept.
 * When the screen has no camera (the park's display today), the browser
 * refuses one, or the till or station between is from before the mark, the
 * screen says reception will take the photo, and the flow goes on.
 */

type Element = React.ReactElement<Record<string, unknown>>;
const elements = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(elements) :
  React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children)] : [];
const words = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node) :
  Array.isArray(node) ? node.map(words).join(' ') : React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const PICTURE = 'data:image/jpeg;base64,/9j/4AAQ';
const OTHER_PICTURE = 'data:image/jpeg;base64,/9j/4BBB';
const FILE_ID = '0190f0a4-7b7e-7c3a-9f1e-1a2b3c4d5e6f';

function cameraOnScreen(kind: 'camera' | 'no-camera' | 'no-browser-camera' | 'insecure') {
  if (kind === 'no-browser-camera') { vi.stubGlobal('navigator', {}); return; }
  if (kind === 'insecure') vi.stubGlobal('isSecureContext', false);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(),
    enumerateDevices: vi.fn(async () => kind === 'no-camera'
      ? [{ kind: 'audioinput' }] : [{ kind: 'audioinput' }, { kind: 'videoinput' }]) } });
}

describe('whether this screen can use a camera, asked before anyone presses anything', () => {
  it.each([
    ['camera', 'available'], ['no-camera', 'none'], ['no-browser-camera', 'none'], ['insecure', 'none'],
  ] as const)('%s → %s', async (kind, expected) => {
    cameraOnScreen(kind);
    const view = renderHook(() => useCameraPresence(true));
    await settle();
    view.rerender(undefined);
    expect(view.result.current).toBe(expected);
    view.unmount();
  });

  it('asks nothing when the form takes no photo', async () => {
    cameraOnScreen('camera');
    const view = renderHook(() => useCameraPresence(false));
    await settle();
    expect(view.result.current).toBe('unknown');
    expect((navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    view.unmount();
  });
});

describe('a child’s photo block on the display', () => {
  const block = (props: Partial<Parameters<typeof DisplayChildPhoto>[0]> = {}) => {
    const stored: string[] = [];
    const view = renderHook((extra: Partial<Parameters<typeof DisplayChildPhoto>[0]>) => DisplayChildPhoto({ mark: 'needed',
      presence: 'available', upload: async () => FILE_ID, onStored: (fileId) => { stored.push(fileId); }, ...props, ...extra }), {});
    const all = () => elements(view.result.current);
    return { view, all, stored, camera: () => all().find((node) => node.type === CameraCapture), text: () => words(view.result.current) };
  };

  it('offers the till’s own camera, small pictures, and the display’s line when it cannot be used', () => {
    const photo = block();
    expect(photo.text()).toContain('superviseConsent.photoTitle');
    expect(photo.text()).toContain('superviseConsent.photoInstructions');
    expect(photo.camera()!.props).toMatchObject({ maxEdge: 720, unavailableNote: 'superviseConsent.photoByReception' });
    expect(photo.all().some((node) => node.props['data-testid'] === 'consent-photo-fallback')).toBe(false);
    photo.view.unmount();
  });

  it('tells the till which file the picture is once it is stored, and nothing for a withdrawn one', () => {
    const photo = block();
    (photo.camera()!.props.onUploaded as (id: string | null) => void)(FILE_ID);
    (photo.camera()!.props.onUploaded as (id: string | null) => void)(null);
    expect(photo.stored).toEqual([FILE_ID]);
    photo.view.unmount();
  });

  it('shows the family’s own picture back to them', () => {
    const photo = block();
    (photo.camera()!.props.onCapture as (url: string) => void)(PICTURE);
    expect(photo.camera()!.props.value).toBe(PICTURE);
    (photo.camera()!.props.onClear as () => void)();
    expect(photo.camera()!.props.value).toBeUndefined();
    photo.view.unmount();
  });

  it('with no camera on the screen says so and that reception takes the photo, with no button', () => {
    const photo = block({ presence: 'none' });
    expect(photo.camera()).toBeUndefined();
    const fallback = photo.all().find((node) => node.props['data-testid'] === 'consent-photo-fallback');
    expect(words(fallback)).toContain('camera.none');
    expect(words(fallback)).toContain('superviseConsent.photoByReception');
    photo.view.unmount();
  });

  it.each([[409, 'a form that no longer asks for it'], [404, 'a screen with no route for it']] as const)(
    'a refusal (%s, %s) tells the family, in their language, that reception takes the photo', async (status, _why) => {
      const photo = block({ upload: async () => { throw new DisplayError(status, 'DISPLAY_PHOTO_NOT_ASKED', 'English words from the platform'); } });
      await expect((photo.camera()!.props.upload as (url: string) => Promise<string>)(PICTURE))
        .rejects.toThrow('camera.saveFailed superviseConsent.photoByReception');
      photo.view.unmount();
    });

  it('a dropped connection is a picture that can be saved again, said in their language', async () => {
    const photo = block({ upload: async () => { throw new DisplayError(0, 'DISPLAY_UNAVAILABLE', 'Connection interrupted.'); } });
    const failure = (photo.camera()!.props.upload as (url: string) => Promise<string>)(PICTURE);
    await expect(failure).rejects.toThrow('camera.saveFailed');
    await expect(failure).rejects.not.toThrow('Connection interrupted.');
    photo.view.unmount();
  });

  it('says the team has the photo once the till holds one', () => {
    expect(block({ mark: 'taken' }).text()).toContain('superviseConsent.photoReceived');
    expect(block({ mark: 'needed' }).text()).not.toContain('superviseConsent.photoReceived');
  });

  it('a photo the team holds is not offered an empty camera, nor the no-camera line', () => {
    const staffTook = block({ mark: 'taken' });
    expect(staffTook.camera()).toBeUndefined();
    const noCamera = block({ mark: 'taken', presence: 'none' });
    expect(noCamera.all().some((node) => node.props['data-testid'] === 'consent-photo-fallback')).toBe(false);
    expect(noCamera.text()).toContain('superviseConsent.photoReceived');
  });

  it('the family’s own picture stays on screen to retake once the team has it', () => {
    const photo = block({ mark: 'needed' });
    (photo.camera()!.props.onCapture as (url: string) => void)(PICTURE);
    photo.view.rerender({ mark: 'taken' });
    expect(photo.camera()!.props.value).toBe(PICTURE);
    expect(photo.text()).toContain('superviseConsent.photoReceived');
    photo.view.unmount();
  });
});

const promptOf = (extra: Partial<ConsentPrompt> = {}): ConsentPrompt => ({
  kind: 'consent', requestId: 'zz-test-request', visitorId: 'zz-test-visitor',
  slots: [
    { id: 'zz-child-a', name: 'ZZ TEST child', ageYears: 6, requirement: 'drop_off', photo: 'needed' },
    { id: 'zz-child-b', name: 'ZZ TEST older', ageYears: 12, requirement: 'none' },
  ],
  guardianName: 'ZZ TEST guardian', consentRequired: true, consentAcknowledged: false, confirmations: [],
  staffReady: false, canContinue: false, completed: false, ...extra,
});

function form(initial: ConsentPrompt, sendPhoto?: (form: { id: string; visitorId: string; slotId: string }, dataUrl: string) => Promise<string>) {
  const sent: ConsentAction[] = [];
  const view = renderHook((props: { prompt: ConsentPrompt; busy: boolean }) => PublicConsentCapture({ ...props,
    onAction: (action) => { sent.push(action); }, ...(sendPhoto ? { sendPhoto } : {}) }), { prompt: initial, busy: false });
  const all = () => elements(view.result.current);
  const press = (label: string) => (all().find((node) => words(node.props.children) === label
    && typeof node.props.onClick === 'function')!.props.onClick as () => void)();
  const photos = () => all().filter((node) => node.type === DisplayChildPhoto);
  return { view, sent, all, photos, toCare: () => press('common.continue'), text: () => words(view.result.current) };
}

describe('the care step on the paired display', () => {
  it('shows the camera for each child the till marks, and not the reception line', async () => {
    cameraOnScreen('camera');
    const display = form(promptOf(), async () => FILE_ID);
    display.toCare();
    await settle();
    display.view.rerender({ prompt: promptOf(), busy: false });
    expect(display.photos()).toHaveLength(1);
    expect(display.photos()[0]!.props).toMatchObject({ mark: 'needed', presence: 'available' });
    expect(display.text()).not.toContain('superviseConsent.photoAtReception');
    display.view.unmount();
  });

  it('on the park’s display with no camera, each marked child says reception takes the photo', async () => {
    cameraOnScreen('no-camera');
    const display = form(promptOf(), async () => FILE_ID);
    display.toCare();
    await settle();
    display.view.rerender({ prompt: promptOf(), busy: false });
    expect(display.photos()[0]!.props.presence).toBe('none');
    display.view.unmount();
  });

  it.each([
    ['a till or station from before the mark', promptOf({ slots: [{ id: 'zz-child-a', name: 'ZZ TEST child', ageYears: 6, requirement: 'drop_off' }] }), true],
    ['a screen that cannot send a photo', promptOf(), false],
  ] as const)('%s keeps the form as it was: reception takes the photo', (_case, prompt, sends) => {
    cameraOnScreen('camera');
    const display = form(prompt, sends ? async () => FILE_ID : undefined);
    display.toCare();
    expect(display.photos()).toHaveLength(0);
    expect(display.text()).toContain('superviseConsent.photoAtReception');
    display.view.unmount();
  });

  it('names the stored picture to the till for this form and child, once the screen is free', () => {
    cameraOnScreen('camera');
    const display = form(promptOf(), async () => FILE_ID);
    display.toCare();
    display.view.rerender({ prompt: promptOf(), busy: true });
    (display.photos()[0]!.props.onStored as (id: string) => void)(FILE_ID);
    expect(display.sent).toEqual([]);
    display.view.rerender({ prompt: promptOf(), busy: false });
    expect(display.sent).toEqual([{ action: 'photo', requestId: 'zz-test-request', visitorId: 'zz-test-visitor',
      slotId: 'zz-child-a', fileId: FILE_ID }]);
    const action = ConsentActionSchema.parse(display.sent[0]);
    expect(consentActionAllowed(promptOf(), action)).toBe(true);
    display.view.unmount();
  });

  it('sends each picture under one id, so a resend is the same file', async () => {
    cameraOnScreen('camera');
    const forms: { id: string; visitorId: string; slotId: string }[] = [];
    const display = form(promptOf(), async (photoForm) => { forms.push(photoForm); return FILE_ID; });
    display.toCare();
    const upload = display.photos()[0]!.props.upload as (url: string) => Promise<string>;
    await upload(PICTURE);
    await upload(PICTURE);
    await upload(OTHER_PICTURE);
    expect(forms[0]).toMatchObject({ visitorId: 'zz-test-visitor', slotId: 'zz-child-a' });
    expect(forms[1]!.id).toBe(forms[0]!.id);
    expect(forms[2]!.id).not.toBe(forms[0]!.id);
    display.view.unmount();
  });
});

describe('which children the till asks the display to photograph', () => {
  const base = { needsConsent: true, hasPhoto: false, stationId: 'station-1', throughCounterBox: false };

  it('a child who needs the consent: needed until the till holds a photo, then taken', () => {
    expect(consentSlotPhoto(base)).toEqual({ photo: 'needed' });
    expect(consentSlotPhoto({ ...base, hasPhoto: true })).toEqual({ photo: 'taken' });
  });

  it('none for a child who needs no consent, a till at no station, or a display through a counter box', () => {
    expect(consentSlotPhoto({ ...base, needsConsent: false })).toEqual({});
    expect(consentSlotPhoto({ ...base, stationId: null })).toEqual({});
    expect(consentSlotPhoto({ ...base, stationId: undefined })).toEqual({});
    expect(consentSlotPhoto({ ...base, throughCounterBox: true })).toEqual({});
  });
});

describe('the till keeps the family’s photo where a staff-taken one is kept', () => {
  const till = (extra: Record<string, unknown> = {}) => ({
    slots: [], guardianPhone: '', signature: 'form-1',
    updateSlot: vi.fn(), setGuardianName: vi.fn(), setGuardianPhone: vi.fn(), setContactChannel: vi.fn(),
    setConsentAcknowledged: vi.fn(), setAcknowledgedConfirmationIds: vi.fn(), setCompletedSignature: vi.fn(),
    askedForHelp: vi.fn(), answered: vi.fn(), takePhoto: vi.fn(), ...extra,
  });

  it('a photo answer collects the picture and never finishes the form', () => {
    const model = till();
    takeConsentAction({ action: 'photo', requestId: 'r', visitorId: 'v', slotId: 'zz-child-a', fileId: FILE_ID }, model);
    expect(model.takePhoto).toHaveBeenCalledWith('zz-child-a', FILE_ID);
    expect(model.setCompletedSignature).not.toHaveBeenCalled();
    expect(model.answered).toHaveBeenCalledTimes(1);
  });

  it('collects the picture from this station, for this form and child', async () => {
    apiGet.mockResolvedValue({ dataUrl: PICTURE, contentType: 'image/jpeg' });
    expect(await collectDisplayConsentPhoto('station-1', { fileId: FILE_ID, visitorId: 'zz visitor', slotId: 'zz-child-a' })).toBe(PICTURE);
    expect(apiGet).toHaveBeenCalledWith(`/stations/station-1/consent-photos/${FILE_ID}?visitorId=zz+visitor&slotId=zz-child-a`);
    apiGet.mockResolvedValue({ dataUrl: 'data:text/html;base64,PGI+', contentType: 'text/html' });
    await expect(collectDisplayConsentPhoto('station-1', { fileId: FILE_ID, visitorId: 'v', slotId: 's' })).rejects.toThrow();
  });
});

describe('the display sends the picture with its own credential', () => {
  it('posts the picture, split into its type and bytes, to its own route', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ fileId: FILE_ID }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const form = { id: FILE_ID, visitorId: 'zz-test-visitor', slotId: 'zz-child-a' };
    expect(await sendDisplayConsentPhoto('a'.repeat(64), form, PICTURE)).toBe(FILE_ID);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/display/consent-photos');
    expect(init.credentials).toBe('omit');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${'a'.repeat(64)}`);
    expect(JSON.parse(String(init.body))).toEqual({ ...form, contentType: 'image/jpeg', data: '/9j/4AAQ' });
  });

  it('refuses to send anything that is not a picture', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(photoOfDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    await expect(sendDisplayConsentPhoto('a'.repeat(64), { id: FILE_ID, visitorId: 'v', slotId: 's' }, 'data:text/plain;base64,AAAA'))
      .rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('the platform’s refusal (this form does not ask) reaches the family as its words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'DISPLAY_PHOTO_NOT_ASKED',
      message: 'The form on this screen is not asking for that photo. Reception will take it at the till.' } }), { status: 409 })));
    await expect(sendDisplayConsentPhoto('a'.repeat(64), { id: FILE_ID, visitorId: 'v', slotId: 's' }, PICTURE))
      .rejects.toThrow('Reception will take it at the till.');
  });
});
