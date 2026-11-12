import { useEffect, useState } from 'react';
import { Camera, CheckCircle2 } from 'lucide-react';
import { CameraCapture } from '@/components/shared/CameraCapture';
import { useLanguage } from '@/i18n/LanguageContext';
import { DISPLAY_CONSENT_PHOTO_EDGE } from '@oto/shared';
import { DisplayError } from '@/api/display';

/**
 * SCRUM-857 — THE FAMILY TAKES THE CHILD'S PHOTO ON THEIR OWN SCREEN.
 *
 * The owner's ruling of 8 November: in the care details the customer takes
 * the photo with a button, instead of reception (a webcam on the display,
 * later connected through the counter box). This is the paired display's
 * copy of what the till's own customer half already shows
 * (`ConsentCapture`): the same camera, the same title and instructions. The
 * picture is scaled down, sent to the platform for this form and child, and
 * named to the till, which keeps it where a photo staff take is kept.
 *
 * When this screen has no camera, the browser refuses it, or permission is
 * denied, the screen says so and that reception will take the photo at the
 * counter — the flow never waits on a camera that is not there.
 */

export type CameraPresence = 'unknown' | 'available' | 'none';

/**
 * Whether this screen can use a camera at all, asked once before anybody
 * presses anything: a camera needs a secure page and a browser that offers
 * one, and a screen with no camera plugged in says so straight away instead
 * of offering a button that cannot work. Only the kind of each device is read
 * — no permission is asked and no camera is switched on.
 */
export function useCameraPresence(enabled: boolean): CameraPresence {
  const [presence, setPresence] = useState<CameraPresence>('unknown');
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    if ((globalThis as { isSecureContext?: boolean }).isSecureContext === false || !media?.getUserMedia) {
      setPresence('none');
      return;
    }
    if (!media.enumerateDevices) {
      setPresence('available');
      return;
    }
    media.enumerateDevices().then(
      (devices) => { if (alive) setPresence(devices.some((device) => device.kind === 'videoinput') ? 'available' : 'none'); },
      () => { if (alive) setPresence('available'); },
    );
    return () => { alive = false; };
  }, [enabled]);
  return presence;
}

export function DisplayChildPhoto({ mark, presence, upload, onStored }: {
  /** The till's mark for this child: it holds no photo yet, or it holds one. */
  mark: 'needed' | 'taken';
  presence: CameraPresence;
  /** Send the picture for this child's form; answered with the stored file's id. */
  upload: (dataUrl: string) => Promise<string>;
  /** The picture is stored: tell the till which file it is. */
  onStored: (fileId: string) => void;
}) {
  const { t, lang } = useLanguage();
  const [picture, setPicture] = useState<string | undefined>(undefined);
  // The family reads why a picture did not reach the team in their own
  // language: a form that no longer asks for it (or a screen with no route
  // for it) means reception takes the photo; anything else can be tried again.
  const send = async (dataUrl: string): Promise<string> => {
    try {
      return await upload(dataUrl);
    } catch (failure) {
      const notHere = failure instanceof DisplayError && (failure.status === 404 || failure.status === 409);
      throw new Error(notHere ? `${t('camera.saveFailed')} ${t('superviseConsent.photoByReception')}` : t('camera.saveFailed'));
    }
  };
  // Once the team holds a photo the camera is offered only to retake the
  // family's own picture still on this screen: a photo staff took, or one
  // taken before the family moved between steps, is not shown here again,
  // and an empty camera frame would read as no photo at all.
  const camera = presence === 'available' && (mark === 'needed' || picture !== undefined);
  return <div data-testid="consent-photo">
    <label className="flex items-center gap-2 text-lg text-foreground/70"><Camera className="h-5 w-5" /> {t('superviseConsent.photoTitle')}</label>
    <p className="mt-1 text-sm text-foreground/50">{t('superviseConsent.photoInstructions')}</p>
    {presence === 'none' && mark === 'needed' && <p className="mt-2 flex items-center gap-2 text-base text-foreground/70" data-testid="consent-photo-fallback">
      <Camera className="h-5 w-5 shrink-0" />{t('camera.none')} · {t('superviseConsent.photoByReception')}</p>}
    {camera && <CameraCapture lang={lang} className="mt-2" maxEdge={DISPLAY_CONSENT_PHOTO_EDGE}
      unavailableNote={t('superviseConsent.photoByReception')}
      value={picture} onCapture={setPicture} onClear={() => setPicture(undefined)}
      upload={send} onUploaded={(fileId) => { if (fileId) onStored(fileId); }} />}
    {mark === 'taken' && <p className="mt-2 flex items-center gap-2 text-base text-foreground/70" data-testid="consent-photo-received">
      <CheckCircle2 className="h-5 w-5 shrink-0 text-primary" />{t('superviseConsent.photoReceived')}</p>}
  </div>;
}
