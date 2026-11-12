import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentActionSchema, ConsentPromptSchema, consentActionAllowed, type ConsentAction, type ConsentPrompt } from '@oto/shared';
import { PhoneInput } from '@/components/shared/PhoneInput';
import { CameraCapture } from '@/components/shared/CameraCapture';
import { PublicConsentCapture, LIVE_FILL_MS } from '@/components/till/PublicConsentCapture';
import { DisplayChildPhoto } from '@/components/till/DisplayChildPhoto';
import { Button } from '@/components/ui/button';
import { consentPhoneShown, staffCameraLine, takeConsentAction } from '@/lib/consentForm';
import { renderHook } from './support/hooks';

vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')) }));
vi.mock('@/i18n/LanguageContext', () => ({ tFor: () => (key: string) => key,
  useLanguage: () => ({ lang: 'en', t: (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}:${Object.values(vars).join(',')}` : key }) }));
beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/**
 * SCRUM-943 — SMALL POINTS ON THE FAMILY'S FORM ON THE PAIRED DISPLAY.
 *
 * (a) staff are told when the display cannot take the photo (no camera, or
 *     the camera refused), and that it is taken at the till;
 * (b) staff going Back while the family's Done is being saved leave the
 *     display saying it is saving until the save lands;
 * (c) the number is drawn one way on both screens;
 * (d) the reconnecting line (in `s942-display-form-lines.test.ts`);
 * (e) the buttons on the till's read-only copy are drawn as not available;
 * (f) the camera notice reads on a light display, the dark look unchanged;
 * (g) at phone width the language button stays off the heading.
 */

type Element = React.ReactElement<Record<string, unknown>>;
const elements = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(elements) :
  React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children)] : [];
const words = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node) :
  Array.isArray(node) ? node.map(words).join('') : React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';
const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '../src', rel), 'utf8').replace(/\r\n/g, '\n');

const prompt = (extra: Partial<ConsentPrompt> = {}): ConsentPrompt => ({
  kind: 'consent', requestId: 'zz-943', visitorId: 'zz-943-visitor',
  slots: [{ id: 'a', name: 'ZZ TEST Mai', ageYears: 6, requirement: 'drop_off', dateOfBirth: null, allergiesMedical: '', foodRestrictions: '', photo: 'needed' }],
  guardianName: '', guardianPhone: '+66898943001', contactChannel: 'whatsapp', contactConfirmed: false, familyStep: 'care',
  consentRequired: true, consentAcknowledged: false, confirmations: [],
  staffReady: false, canContinue: false, completed: false, ...extra,
});

function form(p: ConsentPrompt, mirror?: { step: 'children' | 'care' | 'agreements' | null }) {
  const sent: ConsentAction[] = [];
  const view = renderHook((next: ConsentPrompt) => PublicConsentCapture({ prompt: next, busy: false, answerPending: false, mirror,
    onAction: (action) => { sent.push(action); }, sendPhoto: async () => 'zz-file' }), p);
  return { view, sent, all: () => elements(view.result.current),
    fills: () => sent.filter((action): action is Extract<ConsentAction, { action: 'fill' }> => action.action === 'fill') };
}

describe('(a) the display tells the till it cannot take the photo', () => {
  it('a display with no camera says so with a fill, on a form whose till asks (reportsCamera)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(), enumerateDevices: vi.fn(async () => [{ kind: 'audioinput' }]) } });
    const display = form(prompt({ reportsCamera: true }));
    await vi.advanceTimersByTimeAsync(LIVE_FILL_MS + 10);
    expect(display.fills().at(-1)).toMatchObject({ action: 'fill', camera: 'none' });
    const parsed = ConsentActionSchema.parse(display.fills().at(-1));
    expect(consentActionAllowed(ConsentPromptSchema.parse(prompt({ reportsCamera: true })), parsed)).toBe(true);
    display.view.unmount();
  });

  it('a refused camera is said too, once the family pressed Start and the browser refused', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(), enumerateDevices: vi.fn(async () => [{ kind: 'videoinput' }]) } });
    const display = form(prompt({ reportsCamera: true }));
    await vi.advanceTimersByTimeAsync(LIVE_FILL_MS + 10);
    expect(display.fills().every((fill) => fill.camera === undefined)).toBe(true);
    const photo = display.all().find((node) => node.type === DisplayChildPhoto)!;
    (photo.props.onCameraTrouble as (trouble: 'refused' | 'none' | null) => void)('refused');
    await vi.advanceTimersByTimeAsync(LIVE_FILL_MS + 10);
    expect(display.fills().at(-1)).toMatchObject({ camera: 'refused' });
    display.view.unmount();
  });

  it('a form whose till does not ask sends nothing new (an older station refuses an unknown field)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(), enumerateDevices: vi.fn(async () => []) } });
    const display = form(prompt());
    await vi.advanceTimersByTimeAsync(LIVE_FILL_MS * 4);
    expect(display.fills().some((fill) => 'camera' in fill)).toBe(false);
    display.view.unmount();
    // The station's own strict reading of a fill without the field is unchanged.
    expect(ConsentActionSchema.safeParse({ action: 'fill', requestId: 'r', visitorId: 'v', slots: [], guardianName: '',
      consentAcknowledged: false, acknowledgedConfirmationIds: [], somethingElse: 1 }).success).toBe(false);
  });

  it('the camera component reports a refusal, an absence, and a camera that works again', async () => {
    const heard: (string | null)[] = [];
    const getUserMedia = vi.fn().mockRejectedValueOnce(Object.assign(new Error('no'), { name: 'NotAllowedError' }))
      .mockRejectedValueOnce(Object.assign(new Error('no'), { name: 'NotFoundError' }));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const view = renderHook(() => CameraCapture({ onCapture: () => undefined, onCameraTrouble: (trouble) => { heard.push(trouble); } }));
    const start = () => (elements(view.result.current).find((node) => typeof node.props.onClick === 'function')!.props.onClick as () => void)();
    start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.rerender(undefined);
    start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(heard).toEqual(['refused', 'none']);
    view.unmount();
  });

  it('the till keeps what the display said with each step, and tells staff the photo is taken at the till', () => {
    const said: ('none' | 'refused' | null)[] = [];
    const till = {
      slots: [], guardianPhone: '', signature: 's', updateSlot: () => undefined, setGuardianName: () => undefined,
      setGuardianPhone: () => undefined, setContactChannel: () => undefined, setConsentAcknowledged: () => undefined,
      setAcknowledgedConfirmationIds: () => undefined, setCompletedSignature: () => undefined, askedForHelp: () => undefined,
      answered: () => undefined, setDisplayCamera: (camera: 'none' | 'refused' | null) => { said.push(camera); },
    };
    const fill: Extract<ConsentAction, { action: 'fill' }> = { action: 'fill', requestId: 'r', visitorId: 'v', slots: [],
      guardianName: '', consentAcknowledged: false, acknowledgedConfirmationIds: [] };
    takeConsentAction({ ...fill, camera: 'refused' }, till);
    takeConsentAction(fill, till);
    expect(said).toEqual(['refused', null]);

    expect(staffCameraLine({ photoStillNeeded: true, displayAsked: true, displayCamera: 'none' }))
      .toBe("The display has no camera. Take each child's photo with the family here, in Private child details.");
    expect(staffCameraLine({ photoStillNeeded: true, displayAsked: true, displayCamera: 'refused' }))
      .toBe("The camera on the display was refused. Take each child's photo with the family here, in Private child details.");
    expect(staffCameraLine({ photoStillNeeded: true, displayAsked: false, displayCamera: null }))
      .toBe("The display does not take the photo at this station. Take each child's photo with the family here, in Private child details.");
    expect(staffCameraLine({ photoStillNeeded: true, displayAsked: true, displayCamera: null })).toBeNull();
    expect(staffCameraLine({ photoStillNeeded: false, displayAsked: true, displayCamera: 'refused' })).toBeNull();
  });

  it('the till asks for the report only when it asks the display for a photo, and draws the line beside its own', () => {
    const till = src('pages/Till.tsx');
    expect(till).toContain('const consentPhotoAsked = consentBase.slots.some(slot => slot.photo !== undefined);');
    expect(till).toContain('if (consentPhotoAsked) consentBase.reportsCamera = true;');
    expect(till).toContain('data-testid="consent-staff-camera"');
    expect(till).toContain('setDisplayCamera: setConsentDisplayCamera,');
  });
});

describe('(b) staff go Back while the family’s Done is being saved', () => {
  it('the display keeps the finished form, saying it is saving, until the save lands', () => {
    const till = src('pages/Till.tsx');
    expect(till).toContain('const savingAfterBack = step !== 7 && consentFinishing !== null;');
    expect(till).toContain('const consent = (step === 7 || savingAfterBack) && displayOnline');
    expect(till).toContain("stage: savingAfterBack && consent ? 'input' : customerStage, step: savingAfterBack && consent ? 7 : step,");
  });
});

describe('(c) the number is drawn one way on both screens', () => {
  it('a complete number typed with its trunk 0 is drawn as the till keeps it; one still being typed, as typed', () => {
    expect(consentPhoneShown('+660898943002')).toBe('+66898943002');
    expect(consentPhoneShown('+66898943002')).toBe('+66898943002');
    expect(consentPhoneShown('+6608985')).toBe('+6608985');
    expect(consentPhoneShown('')).toBe('');
  });

  it('the display’s form draws it so', () => {
    const display = form(prompt({ familyStep: 'agreements', guardianPhone: '+660898943002' }));
    const phone = display.all().find((node) => node.type === PhoneInput)!;
    expect(phone.props.value).toBe('+66898943002');
    display.view.unmount();
    // The till's own customer half keeps SCRUM-783's rule: the field as typed, its stored form beside it.
    expect(src('components/till/ConsentCapture.tsx')).not.toContain('consentPhoneShown');
  });
});

describe('(e) the till’s read-only copy', () => {
  it('draws Ask the team, Back and Done as not available', () => {
    const copy = form(prompt({ familyStep: 'agreements', guardianName: 'ZZ TEST Ploy', consentAcknowledged: true, staffReady: true,
      canContinue: true, contactConfirmed: true, slots: [{ id: 'a', name: 'ZZ TEST Mai', ageYears: 6, requirement: 'drop_off',
        dateOfBirth: null, allergiesMedical: '', foodRestrictions: '' }] }), { step: 'agreements' });
    const buttons = copy.all().filter((node) => node.type === Button);
    const labels = buttons.map((node) => words(node.props.children));
    expect(labels).toEqual(['superviseConsent.askTeam', 'common.back', 'common.done']);
    expect(buttons.every((node) => node.props.disabled === true)).toBe(true);
    copy.view.unmount();
  });

  it('the family’s own screen keeps them live', () => {
    const family = form(prompt({ familyStep: 'agreements', guardianName: 'ZZ TEST Ploy', consentAcknowledged: true, staffReady: true,
      canContinue: true, contactConfirmed: true, slots: [{ id: 'a', name: 'ZZ TEST Mai', ageYears: 6, requirement: 'drop_off',
        dateOfBirth: null, allergiesMedical: '', foodRestrictions: '' }] }));
    const buttons = family.all().filter((node) => node.type === Button);
    expect(buttons.map((node) => node.props.disabled)).toEqual([false, false, false]);
    family.view.unmount();
  });
});

describe('(f) the camera notice on a light display', () => {
  const css = src('index.css');
  const block = (selector: string) => css.slice(css.indexOf(selector), css.indexOf('}', css.indexOf(selector)));

  it('uses the screen’s own inks and veil, dark ink on a pale veil in light', () => {
    const light = block(':root,\n.light {');
    expect(light).toContain('--cd-camera-notice: #92400e;');
    expect(light).toContain('--cd-camera-note: hsl(var(--foreground) / 0.85);');
    expect(light).toContain('--cd-camera-veil: rgb(255 255 255 / 0.82);');
    const camera = src('components/shared/CameraCapture.tsx');
    expect(camera).toContain('bg-(--cd-camera-veil) text-(--cd-camera-notice)');
    expect(camera).toContain('text-sm text-(--cd-camera-note)');
    // The notice itself no longer carries the fixed amber, which is what read badly on light.
    const notice = camera.slice(camera.indexOf("(state === 'denied' || state === 'unavailable') && ("), camera.indexOf('<CameraOff'));
    expect(notice).not.toContain('text-amber-300');
  });

  it('keeps the dark look as it was: amber-300, the note at half strength, no veil', () => {
    const dark = block('.dark {');
    // The very amber the notice's text-amber-300 drew: Tailwind's own value.
    const tailwind = readFileSync(path.resolve(import.meta.dirname, '../node_modules/tailwindcss/theme.css'), 'utf8');
    const amber300 = tailwind.match(/--color-amber-300: ([^;]+);/)![1]!;
    expect(dark).toContain(`--cd-camera-notice: ${amber300};`);
    expect(dark).toContain('--cd-camera-note: hsl(var(--foreground) / 0.5);');
    expect(dark).toContain('--cd-camera-veil: transparent;');
  });

  // The notice is the shared camera's, so the staff screens that take a photo
  // with it draw it too, in the staff theme's inks. In dark it is unchanged
  // (above); here, in the light staff theme, both lines are measured as they
  // were (amber-300 and the half-strength note straight on the frame) and as
  // they are now (the light inks on the veil), with WCAG's contrast ratio.
  describe('on the staff screens that share the camera, in a light staff theme', () => {
    type Rgb = [number, number, number];
    const light = block(':root,\n.light {');
    const token = (name: string) => light.match(new RegExp(`--${name}: (\\d+) (\\d+)% (\\d+)%;`))!.slice(1).map(Number) as Rgb;
    const hsl = ([h, s, l]: Rgb): Rgb => {
      const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
      const f = (n: number) => { const k = (n + h / 30) % 12; return 255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))); };
      return [f(0), f(8), f(4)];
    };
    const hex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
    const over = (ink: Rgb, alpha: number, under: Rgb): Rgb => ink.map((c, i) => c * alpha + under[i]! * (1 - alpha)) as Rgb;
    const lum = (c: Rgb) => {
      const [r, g, b] = c.map((x) => { const v = x / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const contrast = (a: Rgb, b: Rgb) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
    // Tailwind's amber-300, oklch(87.9% 0.169 91.605), in sRGB.
    const AMBER_300 = hex('#ffd230');
    const ink = hsl(token('foreground'));
    /** Both lines on a screen of this colour: before, and with the light inks and veil now. */
    const lines = (screen: Rgb) => {
      // The frame is black at 40% over the screen; the notice's veil is white at 82% over the frame.
      const frame = over([0, 0, 0], 0.4, screen);
      const veiled = over([255, 255, 255], 0.82, frame);
      return {
        before: { notice: contrast(AMBER_300, frame), note: contrast(over(ink, 0.5, frame), frame) },
        after: { notice: contrast(hex('#92400e'), veiled), note: contrast(over(ink, 0.85, veiled), veiled) },
      };
    };

    it('every one of them draws the shared camera, whose frame and notice are measured here', () => {
      for (const file of ['components/dropoff/CheckOutModal.tsx', 'components/dropoff/CheckInBookedModal.tsx',
        'components/mobile/dropoff/MobileCheckInConsent.tsx', 'components/mobile/dropoff/MobileCheckOutView.tsx',
        'components/shared/AuthorizedPickupSheet.tsx']) {
        const screen = src(file);
        expect(screen).toContain("import { CameraCapture } from '@/components/shared/CameraCapture';");
        expect(screen).toContain('<CameraCapture');
      }
      expect(src('components/shared/CameraCapture.tsx')).toContain('rounded-2xl border border-foreground/10 bg-black/40');
    });

    it('on the light screens (the check-out and check-in dialogs, the pickup sheet), both lines read better than before', () => {
      for (const screen of [hsl(token('background')), hsl(token('card')), over(hsl(token('muted')), 0.2, hsl(token('card')))]) {
        const { before, after } = lines(screen);
        expect(before.notice).toBeLessThan(3);
        expect(after.notice).toBeGreaterThanOrEqual(4.5);
        expect(after.note).toBeGreaterThanOrEqual(4.5);
        expect(after.note).toBeGreaterThan(before.note);
      }
    });

    it('on the parent’s check-in screen on the phone, drawn dark whatever the theme, both lines read now', () => {
      const parent = src('components/mobile/dropoff/MobileCheckInConsent.tsx');
      expect(parent).toContain('bg-gradient-to-b from-sky-950 via-slate-950 to-slate-950 text-white');
      expect(parent).toContain('rounded-3xl border border-white/10 bg-white/5 p-5');
      // Tailwind's slate-950 and sky-950 in sRGB, under the card's white at 5%.
      for (const base of [hex('#020618'), hex('#052f4a')]) {
        const { before, after } = lines(over([255, 255, 255], 0.05, base));
        // The note under the notice could not be read before (dark ink on a dark frame).
        expect(before.note).toBeLessThan(1.5);
        expect(after.note).toBeGreaterThanOrEqual(4.5);
        // The notice itself reads less brightly than amber on black did, still at the AA ratio.
        expect(after.notice).toBeGreaterThanOrEqual(4.5);
      }
    });
  });
});

describe('(g) at phone width', () => {
  it('the heading starts below the language button, and the bar is tighter, on both forms', () => {
    const layout = src('components/till/consentFormLayout.ts');
    expect(layout).toContain("export const NARROW_HEAD = 'max-[520px]:pt-14';");
    for (const file of ['components/till/PublicConsentCapture.tsx', 'components/till/ConsentCapture.tsx']) {
      const form = src(file);
      expect(form).toContain('NARROW_HEAD');
      expect(form).toContain('NARROW_BAR');
      expect(form).toContain('NARROW_LINE');
    }
  });
});
