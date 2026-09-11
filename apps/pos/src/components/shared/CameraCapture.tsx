import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Camera, RotateCcw, CameraOff, Loader2 } from 'lucide-react';

type CamState = 'idle' | 'requesting' | 'live' | 'captured' | 'denied' | 'unavailable';

interface CameraCaptureProps {
  // Current captured photo (data URL), if any — lets the parent lift the photo
  // into shared state so both screens stay in sync.
  value?: string;
  onCapture: (dataUrl: string) => void;
  onClear?: () => void;
  className?: string;
}

/**
 * Reusable live-camera photo capture. Uses the REAL getUserMedia stream (front
 * camera), grabs a JPEG frame to a canvas, and hands the data URL up. Degrades
 * gracefully when the camera is blocked or absent so the flow can still proceed
 * with no photo (the caller decides whether a photo is mandatory). Always stops
 * the stream on capture and on unmount so the camera light goes off.
 */
export function CameraCapture({ value, onCapture, onClear, className }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<CamState>(value ? 'captured' : 'idle');

  const stop = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setState('unavailable');
      return;
    }
    setState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setState('live');
    } catch (err) {
      const name = (err as DOMException)?.name;
      setState(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable');
    }
  };

  // Stop the stream when the component goes away (camera light off).
  useEffect(() => () => stop(), []);

  const capture = () => {
    const video = videoRef.current;
    if (!video) return;
    const w = video.videoWidth || 320;
    const h = video.videoHeight || 240;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
    stop();
    setState('captured');
    onCapture(dataUrl);
  };

  const retake = () => {
    onClear?.();
    void start();
  };

  return (
    <div className={className}>
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl border border-foreground/10 bg-black/40">
        {/* The video element must stay mounted so the ref is ready before play. */}
        <video
          ref={videoRef}
          playsInline
          muted
          className={`h-full w-full object-cover ${state === 'live' ? '' : 'hidden'}`}
        />

        {(state === 'captured' && value) && (
          <img src={value} alt="Captured" className="h-full w-full object-cover" />
        )}

        {state === 'idle' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-foreground/50">
            <Camera className="h-12 w-12" />
            <span className="text-base">No photo yet</span>
          </div>
        )}

        {state === 'requesting' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-foreground/60">
            <Loader2 className="h-10 w-10 animate-spin" />
            <span className="text-base">Starting camera…</span>
          </div>
        )}

        {(state === 'denied' || state === 'unavailable') && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-amber-300">
            <CameraOff className="h-10 w-10" />
            <span className="text-base font-semibold">
              {state === 'denied' ? 'Camera access blocked' : 'No camera available'}
            </span>
            <span className="text-sm text-foreground/50">
              You can continue without a photo — staff will note it's missing.
            </span>
          </div>
        )}
      </div>

      <div className="mt-3 flex gap-3">
        {state === 'idle' && (
          <Button size="lg" className="h-14 flex-1 rounded-2xl text-lg" onClick={() => void start()}>
            <Camera className="mr-2 h-5 w-5" /> Start camera
          </Button>
        )}
        {state === 'live' && (
          <Button size="lg" className="h-14 flex-1 rounded-2xl text-lg" onClick={capture}>
            <Camera className="mr-2 h-5 w-5" /> Take photo
          </Button>
        )}
        {state === 'captured' && (
          <Button
            size="lg"
            variant="outline"
            className="h-14 flex-1 rounded-2xl border-foreground/20 bg-foreground/5 text-lg text-foreground hover:bg-foreground/10"
            onClick={retake}
          >
            <RotateCcw className="mr-2 h-5 w-5" /> Retake
          </Button>
        )}
        {(state === 'denied' || state === 'unavailable') && (
          <Button
            size="lg"
            variant="outline"
            className="h-14 flex-1 rounded-2xl border-foreground/20 bg-foreground/5 text-lg text-foreground hover:bg-foreground/10"
            onClick={() => void start()}
          >
            <RotateCcw className="mr-2 h-5 w-5" /> Try again
          </Button>
        )}
      </div>
    </div>
  );
}
