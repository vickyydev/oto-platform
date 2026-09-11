import { useEffect, useRef, useState } from 'react';
import { Wristband } from '@/types';
import { getWristbandByCode, getMockWristbands } from '@/mockApi';
import { Card } from '@/components/ui/card';
import {
  ScanLine,
  Camera,
  CameraOff,
  Loader2,
  RotateCcw,
  AlertCircle,
  UserRound,
  Wallet,
  ArrowRight,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

type CamState = 'idle' | 'requesting' | 'live' | 'denied' | 'unavailable';

interface MobileBraceletScannerProps {
  /** Called when a known wristband is resolved (scanned or typed). */
  onLoaded: (wb: Wristband) => void;
  /** Called when a code is submitted but not in the wristband database. */
  onUnknownCode: (code: string) => void;
}

/**
 * Camera-based wristband scanner for the mobile History surface.
 * Opens the rear camera (facingMode: environment) via getUserMedia — the same
 * getUserMedia approach used by CameraCapture elsewhere. Since this is a
 * prototype with no barcode-decode library, the viewfinder gives the realistic
 * camera experience; staff use the demo-preset tap cards or the manual code
 * entry field to resolve a wristband (identical to how the iPad ScanWristband
 * works, but with the camera viewport added as the primary UI affordance).
 * Degrades gracefully when camera is blocked or absent.
 */
export function MobileBraceletScanner({
  onLoaded,
  onUnknownCode,
}: MobileBraceletScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [camState, setCamState] = useState<CamState>('idle');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const presets = getMockWristbands();

  const stop = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const startCamera = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamState('unavailable');
      return;
    }
    setCamState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }, // rear camera on phones
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setCamState('live');
    } catch (err) {
      const name = (err as DOMException)?.name;
      setCamState(
        name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable',
      );
    }
  };

  // Start camera on mount; stop it on unmount so the indicator light goes off.
  useEffect(() => {
    void startCamera();
    return () => stop();
  }, []);

  const resolve = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const wb = getWristbandByCode(trimmed);
    if (!wb) {
      setError(`No wristband found for "${trimmed}".`);
      return;
    }
    setError(null);
    stop();
    onLoaded(wb);
  };

  const resolveUnknown = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    stop();
    onUnknownCode(trimmed);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const wb = getWristbandByCode(code.trim());
    if (wb) {
      resolve(code);
    } else {
      resolveUnknown(code);
    }
  };

  return (
    <div className="flex flex-col gap-5 p-4 animate-in fade-in duration-300">
      {/* Camera viewfinder */}
      <div className="relative w-full aspect-square max-h-72 overflow-hidden rounded-2xl border border-white/10 bg-black/60">
        {/* Live video stream */}
        <video
          ref={videoRef}
          playsInline
          muted
          className={`h-full w-full object-cover ${camState === 'live' ? '' : 'hidden'}`}
        />

        {/* Scan-line overlay on the live feed */}
        {camState === 'live' && (
          <>
            {/* Corner brackets */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="relative w-40 h-40">
                {/* Top-left */}
                <div className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-primary rounded-tl-md" />
                {/* Top-right */}
                <div className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-primary rounded-tr-md" />
                {/* Bottom-left */}
                <div className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-primary rounded-bl-md" />
                {/* Bottom-right */}
                <div className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-primary rounded-br-md" />
                {/* Animated scan line */}
                <div className="absolute inset-x-2 top-1/2 h-0.5 bg-primary/70 animate-pulse" />
              </div>
            </div>
            <div className="absolute bottom-3 inset-x-0 text-center text-xs text-white/60 font-medium">
              Point camera at wristband QR / barcode
            </div>
          </>
        )}

        {camState === 'idle' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/50">
            <Camera className="h-12 w-12" />
          </div>
        )}

        {camState === 'requesting' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/60">
            <Loader2 className="h-10 w-10 animate-spin" />
            <span className="text-sm font-medium">Starting camera…</span>
          </div>
        )}

        {(camState === 'denied' || camState === 'unavailable') && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <CameraOff className="h-10 w-10 text-amber-400" />
            <span className="text-sm font-semibold text-amber-300">
              {camState === 'denied' ? 'Camera access blocked' : 'No camera available'}
            </span>
            <span className="text-xs text-white/50">
              Use manual entry or demo wristbands below.
            </span>
            <button
              type="button"
              onClick={() => void startCamera()}
              className="flex items-center gap-2 text-xs text-white/60 hover:text-white underline"
            >
              <RotateCcw className="w-3 h-3" />
              Try again
            </button>
          </div>
        )}
      </div>

      {/* Manual entry */}
      <div>
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
          Or enter code manually
        </p>
        <form onSubmit={handleSubmit} className="flex gap-2">
          <Input
            inputMode="numeric"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              if (error) setError(null);
            }}
            placeholder="e.g. 1001"
            className="flex-1 h-12 text-lg px-4"
          />
          <Button type="submit" className="h-12 px-5 gap-1.5" disabled={!code.trim()}>
            Go
            <ArrowRight className="w-4 h-4" />
          </Button>
        </form>
        {error && (
          <div className="flex items-center gap-2 text-destructive text-xs mt-2">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            {error}
          </div>
        )}
      </div>

      {/* Demo wristbands */}
      <div>
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
          Demo wristbands
        </p>
        <div className="space-y-2">
          {presets.map((wb) => (
            <Card
              key={wb.id}
              role="button"
              tabIndex={0}
              onClick={() => resolve(wb.code)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  resolve(wb.code);
                }
              }}
              className="p-3 flex items-center gap-3 cursor-pointer select-none hover:border-primary/60 transition-all active:scale-[0.98]"
            >
              <div className="w-9 h-9 rounded-xl bg-muted text-muted-foreground flex items-center justify-center shrink-0">
                <UserRound className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-bold text-sm leading-tight truncate">
                  {wb.customerNickname}
                </div>
                <div className="text-xs text-muted-foreground font-mono">#{wb.code}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="flex items-center gap-1 text-xs text-muted-foreground justify-end">
                  <Wallet className="w-3 h-3" />
                  credit
                </div>
                <div className="text-sm font-bold tabular-nums text-primary">
                  ฿{wb.creditBalanceTHB}
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
