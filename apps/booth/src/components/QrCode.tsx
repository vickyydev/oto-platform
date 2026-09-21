import { useEffect, useState } from 'react';
import { toString as renderQr } from 'qrcode';

interface Props {
  value: string;
  size: number;
}

/**
 * The voucher code as a QR, for a phone or reception's scanner.
 *
 * It encodes the code and nothing else — no URL, no origin, no booth id. A QR
 * that carried a link would put this booth's address on a television in a
 * shopping centre (D15), and the code is what a till looks up anyway.
 *
 * **The QR is the convenience, not the proof.** The code is printed beside it
 * in type a person can read across a counter, and it stays there whether or
 * not this component manages to draw anything: encoding is asynchronous and
 * can fail, and a guest standing in front of a booth whose printer is down
 * must not be left with an empty white square.
 */
export function QrCode({ value, size }: Props) {
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    // One beat after the card has landed. Encoding is main-thread work and
    // the card's entrance animation is the moment the whole booth exists for;
    // the box below reserves the final size, so nothing moves when the code
    // fills in.
    const timer = window.setTimeout(() => {
      renderQr(value, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 0,
        width: size,
        color: { dark: '#111111', light: '#ffffff' },
      })
        .then((markup) => {
          if (!cancelled) setSvg(markup);
        })
        .catch(() => {
          // Nothing is shown and nothing is said: the code above the box is
          // the answer to this failure, and a booth does not explain itself.
          if (!cancelled) setSvg(null);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [value, size]);

  return (
    <div className="k-qrbox" style={{ width: size + 32, height: size + 32 }}>
      {svg === null ? (
        <div style={{ width: size, height: size, background: '#ffffff' }} />
      ) : (
        <div
          style={{ width: size, height: size }}
          // `qrcode` emits an SVG document it built itself from the code's
          // modules; the code is 10 characters from a fixed alphabet and
          // never reaches the markup as text.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </div>
  );
}
