import { useEffect, useId, useRef, useState } from "react";
import { AlertCircle, Camera, Loader2, ScanLine } from "lucide-react";
import type { Html5Qrcode } from "html5-qrcode";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type ScannerSession = {
  cancelled: boolean;
  stopRequested: boolean;
  scanner: Html5Qrcode | null;
  startPromise: Promise<null> | null;
};

type QrScannerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCodeScanned: (code: string) => void;
};

function scannerErrorMessage(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error ?? "");
  const errorName = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  const normalized = `${detail} ${errorName}`.toLowerCase();

  if (typeof window !== "undefined" && !window.isSecureContext && window.location.hostname !== "localhost") {
    return "Camera scanning requires HTTPS (or localhost). Open this page over HTTPS, or enter the 4-digit code manually.";
  }
  if (
    normalized.includes("permission") ||
    normalized.includes("notallowederror") ||
    normalized.includes("denied") ||
    normalized.includes("not authorized")
  ) {
    return "Camera permission was denied. Allow camera access in your browser settings, then try again, or enter the 4-digit code manually.";
  }
  if (
    normalized.includes("notfounderror") ||
    normalized.includes("notfound") ||
    normalized.includes("no camera") ||
    normalized.includes("camera") ||
    normalized.includes("overconstrained") ||
    normalized.includes("notreadable")
  ) {
    return "No camera is available or it could not be opened. Check browser camera permissions, or enter the 4-digit code manually.";
  }
  return "The camera could not be started. Check browser permissions and use manual entry if needed.";
}

async function stopSession(session: ScannerSession) {
  session.stopRequested = true;

  try {
    await session.startPromise;
  } catch {
    // A rejected start has already released any camera resources it acquired.
  }

  if (!session.scanner) return;

  try {
    if (session.scanner.isScanning) {
      await session.scanner.stop();
    }
  } catch {
    // Closing a scanner while its start request is settling can reject stop.
  }
  try {
    session.scanner.clear();
  } catch {
    // clear() can reject when the camera never finished starting.
  }
  session.scanner = null;
}

export function QrScannerDialog({ open, onOpenChange, onCodeScanned }: QrScannerDialogProps) {
  const id = useId().replace(/:/g, "");
  const readerId = `qr-scanner-reader-${id}`;
  const sessionRef = useRef<ScannerSession | null>(null);
  const acceptedRef = useRef(false);
  const onCodeScannedRef = useRef(onCodeScanned);
  const onOpenChangeRef = useRef(onOpenChange);
  const [starting, setStarting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  onCodeScannedRef.current = onCodeScanned;
  onOpenChangeRef.current = onOpenChange;

  useEffect(() => {
    if (!open) {
      acceptedRef.current = false;
      setStarting(false);
      setFeedback(null);
      return;
    }

    const session: ScannerSession = {
      cancelled: false,
      stopRequested: false,
      scanner: null,
      startPromise: null,
    };
    sessionRef.current = session;
    acceptedRef.current = false;
    setStarting(true);
    setFeedback(null);

    const start = async () => {
      try {
        const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode");
        if (session.cancelled) return;

        const scanner = new Html5Qrcode(readerId, {
          formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
          verbose: false,
        });
        session.scanner = scanner;
        session.startPromise = scanner.start(
          { facingMode: "environment" },
          {
            fps: 10,
            qrbox: (width, height) => {
              const side = Math.min(250, Math.floor(Math.min(width, height) * 0.8));
              return { width: side, height: side };
            },
            disableFlip: false,
          },
          async (decodedText) => {
            if (session.cancelled || session.stopRequested || acceptedRef.current) return;

            if (!/^\d{4}$/.test(decodedText)) {
              setFeedback("That QR does not contain exactly 4 digits. Scan a Spin Wheel code or enter it manually.");
              return;
            }

            acceptedRef.current = true;
            await stopSession(session);
            if (session.cancelled) return;
            onCodeScannedRef.current(decodedText);
            onOpenChangeRef.current(false);
          },
          () => {
            // Decode misses are expected while the camera is searching.
          },
        );
        await session.startPromise;

        if (session.cancelled || session.stopRequested) {
          await stopSession(session);
          return;
        }
        setStarting(false);
      } catch (error) {
        if (session.cancelled || session.stopRequested) return;
        await stopSession(session);
        setStarting(false);
        setFeedback(scannerErrorMessage(error));
      }
    };

    void start();

    return () => {
      session.cancelled = true;
      if (sessionRef.current === session) sessionRef.current = null;
      void stopSession(session);
    };
  }, [open, readerId]);

  const close = () => {
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="dialog-qr-scanner">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Camera className="h-5 w-5 text-sky-600" aria-hidden />
            Scan Spin Wheel code
          </DialogTitle>
          <DialogDescription>
            Point the back camera at a QR containing exactly four digits. Scanning only fills the code; staff still presses Redeem.
          </DialogDescription>
        </DialogHeader>

        <div
          id={readerId}
          className="min-h-[15rem] overflow-hidden rounded-lg border bg-muted/30"
          aria-label="QR code camera preview"
          data-testid="qr-scanner-reader"
        />

        <div className="min-h-10">
          {starting && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Starting camera…
            </p>
          )}
          {!starting && !feedback && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <ScanLine className="h-4 w-4" aria-hidden />
              Scanning for a four-digit QR code…
            </p>
          )}
          {feedback && (
            <p className="flex items-start gap-2 text-sm text-rose-700 dark:text-rose-300" role="alert">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{feedback}</span>
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} data-testid="button-close-qr-scanner">
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}