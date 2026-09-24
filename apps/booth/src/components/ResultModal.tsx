import type { BoothConfigPrize, SpinResponse } from '@oto/shared';
import { groupBoothCode } from '../booth/wheel-view';
import { COPY } from '../copy';
import { QrCode } from './QrCode';

interface Props {
  spin: SpinResponse | null;
  /**
   * The prize as THIS page has it, found by id in the array it drew. Null when
   * the box named a prize this page's bundle does not contain — a publish
   * landed between the page's load and the draw. The card still opens: the
   * guest won something real, and the code and its expiry are on the response.
   */
  prize: BoothConfigPrize | null;
  open: boolean;
  /** Bottom prompt telling the player to press the button to continue. */
  promptText: string;
  /** Dismiss back to the wheel — the button, the backdrop or the X. */
  onClose?: () => void;
}

/**
 * 200 logical pixels: 300 on a 720-wide portrait screen and 450 on a 1080 one,
 * well above what a counter scanner needs, and small enough that the card
 * with the code on it fits a 9:16 screen — the stage is 480 × 853 — with its
 * title in view. At 232 the card stood 889 tall and lost its "You won!" band
 * off the top of the television whenever the printer was down (SCRUM-223).
 */
const QR_SIZE = 200;

/**
 * The win.
 *
 * Lifted from the outgoing game's result card, with the QR rebuilt around a
 * different idea. There, every prize carried a link to a voucher page and the
 * QR was always the point. Here the paper is the point: the booth prints a
 * slip, and the card says so. The code and the QR appear on the television
 * only when no paper came out — which is a printer fault, a queue, or a booth
 * with no printer at all — because then the screen is the guest's only proof.
 *
 * Nothing personal is on this card (D15). A prize name, a code, a date.
 */
export function ResultModal({ spin, prize, open, promptText, onClose }: Props) {
  if (!open || !spin) return null;

  const color = prize?.sliceColor ?? '#FF8A3D';
  const nameEn = prize?.nameEn ?? COPY.yourPrize.en;
  const nameTh = prize === null ? COPY.yourPrize.th : prize.nameTh;

  // The paper is out of the printer and in a hand: nothing to read here.
  const printed = spin.printState === 'printed';
  // A prize with no code is handed over at the booth. Note this is NOT the
  // same as a printer failure — see the note on `voucherCode` in the frozen
  // contract, which a reader that conflated the two would get backwards.
  const hasCode = spin.voucherCode !== null && spin.voucherCode !== '';
  // The tallest card: the code and its QR are the voucher. It drops the
  // decoration above the prize name to keep the whole card on the screen.
  const showsCode = hasCode && !printed;

  return (
    <div className="k-modal">
      {/* The backdrop dismisses too — no dead taps for staff with a pointer. */}
      <div className="k-modal-backdrop" onClick={() => onClose?.()} role="presentation" />

      <div className={showsCode ? 'k-card k-card--code' : 'k-card'}>
        {/* A graphic X, never a <button>: a focusable control here would let
            the physical button double-trigger through it. */}
        <div className="k-close" role="presentation" onClick={() => onClose?.()}>
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
            <path
              d="M4 4l12 12M16 4L4 16"
              stroke="#111111"
              strokeWidth="3.5"
              strokeLinecap="round"
            />
          </svg>
        </div>

        <div className="k-card-band" style={{ background: color }}>
          <span className="k-star k-star--1" aria-hidden>
            <Star />
          </span>
          <div className="k-won-title">{COPY.wonTitle.en}</div>
          <span className="k-star k-star--2" aria-hidden>
            <Star />
          </span>
        </div>

        <div className="k-burst-wrap" aria-hidden>
          <svg className="k-burst" viewBox="0 0 120 120">
            {Array.from({ length: 12 }, (_, i) => (
              <path
                key={i}
                d="M60 60 L54 6 L66 6 Z"
                fill={color}
                opacity={0.55}
                transform={`rotate(${i * 30} 60 60)`}
              />
            ))}
          </svg>
          <div className="k-card-icon" style={{ background: color }}>
            <Sparkle />
          </div>
        </div>

        <p className="k-eyebrow">
          {COPY.resultPrefix.en} · {COPY.resultPrefix.th}
        </p>
        <h2 className="k-prize">{nameEn}</h2>
        {nameTh !== null && nameTh !== '' && <p className="k-prize-th">{nameTh}</p>}
        <div className="k-prize-bar" style={{ background: color }} />

        {!hasCode ? (
          <>
            <div className="k-scan-pill">{COPY.collectAtBooth.en}</div>
            <div className="k-boothbox">
              <div className="k-booth-icon" aria-hidden>
                <BoothMark color={color} />
              </div>
              <p className="k-booth-lead">{COPY.collectAtBooth.en}</p>
              <p className="k-booth-lead k-th">{COPY.collectAtBooth.th}</p>
              <div className="k-booth-rule" style={{ background: color }} />
              <p className="k-booth-prize">{nameEn}</p>
            </div>
            <p className="k-scan">{COPY.noCodeNeeded.en}</p>
            <p className="k-scan k-th">{COPY.noCodeNeeded.th}</p>
          </>
        ) : printed ? (
          <>
            <div className="k-scan-pill">{COPY.takeVoucher.en}</div>
            <div className="k-printedbox">
              <PrinterMark color={color} />
              <p className="k-booth-lead">{COPY.takeVoucher.en}</p>
              <p className="k-booth-lead k-th">{COPY.takeVoucher.th}</p>
            </div>
          </>
        ) : (
          <>
            {/* No paper. The screen is the voucher: the code big enough to
                read across a counter, the QR for a scanner, and the date it
                stops being worth anything. */}
            <div className="k-scan-pill">{COPY.showThisCode.en}</div>
            <p className="k-code" data-voucher-code={spin.voucherCode}>
              {groupBoothCode(spin.voucherCode ?? '')}
            </p>
            <QrCode value={spin.voucherCode ?? ''} size={QR_SIZE} />
            <p className="k-scan">{COPY.scanToClaim.en}</p>
            <p className="k-scan k-th">{COPY.scanToClaim.th}</p>
          </>
        )}

        {hasCode && formatExpiry(spin.expiresAt) !== null && (
          <p className="k-expiry">
            {COPY.validUntil.en} · {COPY.validUntil.th} {formatExpiry(spin.expiresAt)}
          </p>
        )}

        <p className="k-terms">{COPY.terms.en}</p>
        <p className="k-terms k-th">{COPY.terms.th}</p>

        <div className="k-again">
          <span className="k-cta-dot" />
          {promptText}
        </div>
      </div>
    </div>
  );
}

/**
 * The expiry as a day, or null when there is nothing to show.
 *
 * Null covers both "this voucher does not expire" and "the box sent something
 * that is not a date"; either way the line is omitted rather than printing
 * `Invalid Date` on a television.
 */
function formatExpiry(iso: string | null): string | null {
  if (iso === null) return null;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(when);
}

/** Little market stall: striped awning + counter. Inline, so it costs nothing to load. */
function BoothMark({ color }: { color: string }) {
  return (
    <svg width="76" height="62" viewBox="0 0 76 62" fill="none" aria-hidden>
      <path
        d="M6 6h64l6 16H0L6 6z"
        fill={color}
        stroke="#111111"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path d="M25 6l-6 16M44 6l-3 16M63 6l3 16" stroke="#111111" strokeWidth="2.4" />
      <path d="M8 22v34h60V22" stroke="#111111" strokeWidth="3" strokeLinejoin="round" />
      <path d="M8 56h60" stroke="#111111" strokeWidth="3" strokeLinecap="round" />
      <rect
        x="28"
        y="34"
        width="20"
        height="16"
        rx="3"
        fill={color}
        stroke="#111111"
        strokeWidth="3"
      />
      <path d="M38 34v16M28 42h20" stroke="#111111" strokeWidth="2.4" />
    </svg>
  );
}

/** A slip coming out of a printer — the "your paper is ready" mark. */
function PrinterMark({ color }: { color: string }) {
  return (
    <svg width="76" height="62" viewBox="0 0 76 62" fill="none" aria-hidden>
      <rect
        x="6"
        y="18"
        width="64"
        height="26"
        rx="5"
        fill={color}
        stroke="#111111"
        strokeWidth="3"
      />
      <rect
        x="20"
        y="30"
        width="36"
        height="28"
        rx="3"
        fill="#ffffff"
        stroke="#111111"
        strokeWidth="3"
      />
      <path d="M27 40h22M27 48h14" stroke="#111111" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M20 18V8h36v10" stroke="#111111" strokeWidth="3" strokeLinejoin="round" />
    </svg>
  );
}

function Star() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24">
      <path
        d="M12 2.5l1.8 5.4 5.7.4-4.4 3.7 1.5 5.5L12 14.7l-4.6 2.8 1.5-5.5-4.4-3.7 5.7-.4L12 2.5z"
        fill="#FFE72E"
        stroke="#111111"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function Sparkle() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 2.5l1.8 5.4 5.7.4-4.4 3.7 1.5 5.5L12 14.7l-4.6 2.8 1.5-5.5-4.4-3.7 5.7-.4L12 2.5z"
        fill="#111"
      />
    </svg>
  );
}
