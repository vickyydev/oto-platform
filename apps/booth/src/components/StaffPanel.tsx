import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { booth } from '../booth/client';
import { BoothCallError } from '../booth/contract';
import { STAFF_COPY } from '../copy';
import { createPanelTimer } from '../panel-timer';
import { isButtonKey, registerButtonOverlay } from '../press';

/**
 * The staff panel (SCRUM-694): what a member of staff can do at the booth's
 * screen, and nothing that signs anybody in.
 *
 * Nobody signs in at a booth any more — the voucher's Staff row is today's
 * roster from the Console — so the panel offers exactly three things and a
 * Close: **Reprint last voucher** (the same code, marked "Reprint", never a
 * new prize), **Change booth** (only on a box running more than one booth),
 * and **Booth diagnostics** (the `#debug` overlay, where the wheel shows it).
 * It opens from a touch on the corner chip or the on-duty badge, or from
 * holding the red button for three seconds on a ready wheel.
 *
 * A guest can reach it too, which is why it is shaped the way it is: the
 * focus starts on **Close**, so a guest pressing the button twice selects
 * Close; and it closes itself after 45 seconds of nobody using it, and two
 * minutes after it opened whatever is pressed (`panel-timer.ts`). A reprint
 * repeats a single-use code and is recorded as a reprint — it never draws.
 */
export function StaffPanel({
  onClose,
  onChangeBooth,
  onOpenDiagnostics,
  buttonKey,
}: {
  onClose: () => void;
  /** Set only on a box with more than one booth. */
  onChangeBooth?: () => void;
  /** Set only where the diagnostics overlay is on the page (the wheel). */
  onOpenDiagnostics?: () => void;
  buttonKey: string;
}) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const timer = useMemo(
    () =>
      createPanelTimer({
        onClose: () => closeRef.current(),
        isButtonKey: (event) => isButtonKey(event, buttonKey),
      }),
    [buttonKey],
  );
  const touch = useCallback(() => timer.touch(), [timer]);

  // Opened: both countdowns start. Closed (unmounted): nothing is left to fire.
  useEffect(() => {
    timer.open();
    return () => timer.stop();
  }, [timer]);

  // The focus starts on Close, and the red button moves and chooses.
  useEffect(() => {
    closeButton.current?.focus();
    return registerButtonOverlay({
      touch,
      move: () => {
        const choices = [
          ...(panel.current?.querySelectorAll<HTMLButtonElement>(
            'button[data-button-choice]:not(:disabled)',
          ) ?? []),
        ];
        const index = choices.findIndex((button) => button === document.activeElement);
        choices[(index + 1) % choices.length]?.focus();
      },
      select: () => {
        const focused = document.activeElement;
        if (
          focused instanceof HTMLButtonElement &&
          panel.current?.contains(focused) &&
          !focused.disabled
        )
          focused.click();
      },
    });
  }, [touch]);

  // Escape closes; any other key that is not the booth's button keeps it up.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      timer.key(event);
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose, timer]);

  const reprint = () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    touch();
    setMessage(STAFF_COPY.reprinting);
    void booth
      .reprint({})
      .then((result) =>
        setMessage(
          result.printState === 'printed'
            ? STAFF_COPY.reprinted
            : result.printState === 'no_printer'
              ? STAFF_COPY.reprintNoPrinter
              : STAFF_COPY.reprintQueued,
        ),
      )
      .catch((error: unknown) =>
        setMessage(
          error instanceof BoothCallError && error.code === 'nothing_to_reprint'
            ? STAFF_COPY.nothingToReprint
            : STAFF_COPY.reprintFailed,
        ),
      )
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
        touch();
      });
  };

  return (
    <div ref={panel} className="k-panel" data-booth-panel="staff" onPointerDown={touch}>
      <div className="k-panel-head">{STAFF_COPY.staffTitle}</div>
      <p className="k-panel-line">{STAFF_COPY.buttonHint}</p>
      <div className="k-panel-stack">
        <button
          data-button-choice
          type="button"
          className="k-panel-btn k-panel-btn--wide"
          disabled={busy}
          onClick={reprint}
          data-booth-action="reprint"
        >
          {STAFF_COPY.reprint}
        </button>
        {onChangeBooth && (
          <button
            data-button-choice
            type="button"
            className="k-panel-btn k-panel-btn--wide"
            onClick={() => {
              onClose();
              onChangeBooth();
            }}
            data-booth-action="change-booth"
          >
            {STAFF_COPY.changeBooth}
          </button>
        )}
        {onOpenDiagnostics && (
          <button
            data-button-choice
            type="button"
            className="k-panel-btn k-panel-btn--wide"
            onClick={() => {
              onClose();
              onOpenDiagnostics();
            }}
            data-booth-action="diagnostics"
          >
            {STAFF_COPY.debugTitle}
          </button>
        )}
        <button
          ref={closeButton}
          data-button-choice
          type="button"
          className="k-panel-btn k-panel-btn--wide"
          onClick={onClose}
          data-booth-action="close"
        >
          {STAFF_COPY.cancel}
        </button>
      </div>
      {message && (
        <p className="k-panel-warn" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
