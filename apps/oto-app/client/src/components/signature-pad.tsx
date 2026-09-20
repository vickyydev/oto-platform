import { useRef, useEffect, useState } from "react";
import SignatureCanvas from "react-signature-canvas";
import { Button } from "@/components/ui/button";
import { Eraser } from "lucide-react";

interface SignaturePadProps {
  onSignatureChange: (signatureDataUrl: string | null) => void;
  disabled?: boolean;
  value?: string | null;
}

export default function SignaturePad({ onSignatureChange, disabled, value }: SignaturePadProps) {
  const sigCanvasRef = useRef<SignatureCanvas>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isEmpty, setIsEmpty] = useState(!value);
  const initializedRef = useRef(false);
  const restoredRef = useRef(false);

  const handleClear = () => {
    sigCanvasRef.current?.clear();
    setIsEmpty(true);
    restoredRef.current = false;
    onSignatureChange(null);
  };

  const handleEnd = () => {
    if (sigCanvasRef.current) {
      const empty = sigCanvasRef.current.isEmpty();
      setIsEmpty(empty);
      if (!empty) {
        const dataUrl = sigCanvasRef.current.toDataURL("image/png");
        onSignatureChange(dataUrl);
      } else {
        onSignatureChange(null);
      }
    }
  };

  // Initialize canvas size once on mount
  useEffect(() => {
    if (!initializedRef.current && containerRef.current && sigCanvasRef.current) {
      const canvas = sigCanvasRef.current.getCanvas();
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      const width = containerRef.current.offsetWidth;
      const height = 160;
      
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      canvas.getContext("2d")?.scale(ratio, ratio);
      
      initializedRef.current = true;
    }
  }, []);

  // Restore signature from value prop if canvas is empty but we have a value
  useEffect(() => {
    if (value && sigCanvasRef.current && initializedRef.current && !restoredRef.current) {
      const canvas = sigCanvasRef.current;
      if (canvas.isEmpty()) {
        const img = new Image();
        img.onload = () => {
          const canvasEl = canvas.getCanvas();
          const ctx = canvasEl.getContext("2d");
          if (ctx) {
            const ratio = Math.max(window.devicePixelRatio || 1, 1);
            ctx.drawImage(img, 0, 0, canvasEl.width / ratio, canvasEl.height / ratio);
            setIsEmpty(false);
            restoredRef.current = true;
          }
        };
        img.src = value;
      }
    }
  }, [value]);

  return (
    <div className="space-y-3">
      <div 
        ref={containerRef}
        className="border-2 border-dashed border-gray-500 rounded-xl bg-white relative"
        style={{ touchAction: "none" }}
      >
        <SignatureCanvas
          ref={sigCanvasRef}
          penColor="#1a1a1a"
          canvasProps={{
            className: "w-full rounded-xl",
            style: { height: "160px", backgroundColor: "white" },
          }}
          onEnd={handleEnd}
        />
        {isEmpty && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <p className="text-gray-400 text-sm">Sign here with your finger or mouse</p>
          </div>
        )}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleClear}
        disabled={disabled || isEmpty}
        className="w-full border-gray-600 text-gray-300 hover:bg-gray-700"
        data-testid="button-clear-signature"
      >
        <Eraser className="mr-2 h-4 w-4" />
        Clear and Start Over
      </Button>
    </div>
  );
}
