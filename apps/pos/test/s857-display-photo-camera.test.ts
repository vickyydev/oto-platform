import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraCapture } from '@/components/shared/CameraCapture';
import { renderHook } from './support/hooks';

vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')) }));
vi.mock('@/i18n/LanguageContext', () => ({ tFor: () => (key: string) => key,
  useLanguage: () => ({ lang: 'en', t: (key: string) => key }) }));
beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.restoreAllMocks());

/**
 * SCRUM-857 — THE CAMERA THE FAMILY USES ON THE PAIRED DISPLAY.
 *
 * The display reuses the till's own camera component (`CameraCapture`): the
 * family presses the button, sees themselves (the user-facing camera), takes
 * or retakes the child's photo. What this ticket adds to it, pinned here with
 * a faked camera: the picture is scaled down before it is sent; a blocked or
 * absent camera says what the display says (reception takes the photo); the
 * camera is switched off when the form leaves the step — even one that only
 * answers after the form has gone — so no camera light stays on between
 * customers; and a photo that arrives from the family's screen shows at once
 * on the staff copy of the details.
 */

type Element = React.ReactElement<Record<string, unknown>>;
const elements = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(elements) :
  React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children)] : [];
const words = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node) :
  Array.isArray(node) ? node.map(words).join(' ') : React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';

const PICTURE = 'data:image/jpeg;base64,/9j/4AAQ';

function fakeCamera(answer: 'ok' | 'NotAllowedError' | 'NotFoundError' | 'held' = 'ok') {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] };
  let release: (value: unknown) => void = () => undefined;
  const getUserMedia = vi.fn(() => answer === 'ok' ? Promise.resolve(stream)
    : answer === 'held' ? new Promise((resolve) => { release = resolve; })
      : Promise.reject(Object.assign(new Error(answer), { name: answer })));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  const drawn: { width: number; height: number }[] = [];
  vi.stubGlobal('document', { createElement: () => {
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: () => { drawn.push({ width: canvas.width, height: canvas.height }); } }),
      toDataURL: () => PICTURE };
    return canvas;
  } });
  return { track, stream, getUserMedia, drawn, answerLate: () => release(stream) };
}

function open(props: Partial<Parameters<typeof CameraCapture>[0]> = {}) {
  const captured: string[] = [];
  const cleared: number[] = [];
  const view = renderHook((extra: Partial<Parameters<typeof CameraCapture>[0]>) => CameraCapture({
    onCapture: (url) => { captured.push(url); }, onClear: () => { cleared.push(1); }, ...props, ...extra }), {});
  const all = () => elements(view.result.current);
  const video = { srcObject: null as unknown, play: vi.fn(async () => undefined), videoWidth: 1920, videoHeight: 1080 };
  const attach = () => { (all().find((node) => node.type === 'video')!.props.ref as { current: unknown }).current = video; };
  const press = async (label: string) => {
    const button = all().find((node) => typeof node.props.onClick === 'function' && words(node.props.children).includes(label));
    if (!button) throw new Error(`no button ${label} in: ${words(view.result.current)}`);
    (button.props.onClick as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { view, all, attach, press, captured, cleared, video, text: () => words(view.result.current) };
}

describe('the family takes, retakes and sends the photo', () => {
  it('opens the user-facing camera, takes a downscaled picture, and sends it once', async () => {
    const camera = fakeCamera();
    const upload = vi.fn(async () => 'file-1');
    const uploaded: (string | null)[] = [];
    const form = open({ maxEdge: 720, upload, onUploaded: (id) => { uploaded.push(id); } });
    form.attach();
    await form.press('camera.start');
    expect(camera.getUserMedia).toHaveBeenCalledWith({ video: { facingMode: 'user' }, audio: false });
    expect(form.video.srcObject).toBe(camera.stream);
    await form.press('camera.take');
    expect(camera.drawn).toEqual([{ width: 720, height: 405 }]);
    expect(form.captured).toEqual([PICTURE]);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith(PICTURE);
    expect(uploaded).toEqual(['file-1']);
    // The camera goes off as soon as the picture is taken.
    expect(camera.track.stop).toHaveBeenCalled();
    form.view.unmount();
  });

  it('keeps the camera size when no edge is given (the till’s own uses)', async () => {
    const camera = fakeCamera();
    const form = open();
    form.attach();
    await form.press('camera.start');
    await form.press('camera.take');
    expect(camera.drawn).toEqual([{ width: 1920, height: 1080 }]);
    form.view.unmount();
  });

  it('retakes: the earlier picture is withdrawn and the camera opens again', async () => {
    const camera = fakeCamera();
    const uploaded: (string | null)[] = [];
    const form = open({ maxEdge: 720, upload: async () => 'file-1', onUploaded: (id) => { uploaded.push(id); } });
    form.attach();
    await form.press('camera.start');
    await form.press('camera.take');
    form.view.rerender({ value: PICTURE });
    await form.press('camera.retake');
    expect(form.cleared).toEqual([1]);
    expect(uploaded).toEqual(['file-1', null]);
    expect(camera.getUserMedia).toHaveBeenCalledTimes(2);
    form.view.unmount();
  });
});

describe('a screen whose camera cannot be used says reception will take the photo', () => {
  it.each([['NotAllowedError', 'camera.blocked'], ['NotFoundError', 'camera.none']] as const)('%s', async (failure, headline) => {
    fakeCamera(failure);
    const form = open({ unavailableNote: 'superviseConsent.photoByReception' });
    form.attach();
    await form.press('camera.start');
    expect(form.text()).toContain(headline);
    expect(form.text()).toContain('superviseConsent.photoByReception');
    expect(form.text()).not.toContain('camera.continueWithout');
    form.view.unmount();
  });

  it('a browser with no camera at all says so without asking', async () => {
    vi.stubGlobal('navigator', {});
    const form = open({ unavailableNote: 'superviseConsent.photoByReception' });
    await form.press('camera.start');
    expect(form.text()).toContain('camera.none');
    form.view.unmount();
  });

  it('the till’s own uses keep their line', async () => {
    fakeCamera('NotFoundError');
    const form = open();
    form.attach();
    await form.press('camera.start');
    expect(form.text()).toContain('camera.continueWithout');
    form.view.unmount();
  });
});

describe('the camera light never stays on between customers', () => {
  it('is switched off when the form leaves the step', async () => {
    const camera = fakeCamera();
    const form = open();
    form.attach();
    await form.press('camera.start');
    expect(camera.track.stop).not.toHaveBeenCalled();
    form.view.unmount();
    expect(camera.track.stop).toHaveBeenCalled();
  });

  it('a camera that answers after the form has gone is switched off at once', async () => {
    const camera = fakeCamera('held');
    const form = open();
    form.attach();
    await form.press('camera.start');
    form.view.unmount();
    camera.answerLate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(camera.track.stop).toHaveBeenCalled();
    expect(form.video.srcObject).toBeNull();
  });
});

describe('the staff copy of the details shows the family’s photo as soon as it arrives', () => {
  it('a picture given while the staff dialog is open is shown, and goes when withdrawn', () => {
    const form = open();
    expect(form.all().some((node) => node.type === 'img')).toBe(false);
    expect(form.text()).toContain('camera.noPhoto');
    form.view.rerender({ value: PICTURE });
    expect(form.all().find((node) => node.type === 'img')?.props.src).toBe(PICTURE);
    form.view.rerender({ value: undefined });
    expect(form.all().some((node) => node.type === 'img')).toBe(false);
    expect(form.text()).toContain('camera.noPhoto');
    form.view.unmount();
  });

  it('a camera live on the staff side is not interrupted by it', async () => {
    fakeCamera();
    const form = open();
    form.attach();
    await form.press('camera.start');
    form.view.rerender({ value: PICTURE });
    expect(form.text()).toContain('camera.take');
    form.view.unmount();
  });
});
