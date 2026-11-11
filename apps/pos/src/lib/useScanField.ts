import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react';
import { SCANNER_BURST_MIN_LENGTH } from '@/lib/scannerBurst';
import { SCAN_PACE_GAP_MS, SCAN_PACE_QUIET_MS } from '@/lib/pageScan';
import { NO_PACED_RUN, nextPacedRun, noteScannerUse, pacedLikeScanner, type PacedRun } from '@/lib/scannerUse';

/**
 * SCRUM-802 — the F&B field's existing paste/pace rule (SCRUM-790), shared
 * with both History layouts. A paste or scanner run loads after its quiet;
 * hand typing still waits for Enter or the form button. Only paced single
 * keys report scanner presence; pastes and bulk insertions never do.
 */
export function useScanField(onCode: (value: string) => void | Promise<void>, active = true) {
  const field = useRef<HTMLInputElement>(null);
  const latest = useRef(onCode);
  latest.current = onCode;
  const run = useRef({ length: 0, at: 0, pasted: false });
  const paced = useRef<PacedRun>(NO_PACED_RUN);
  const quiet = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopWaiting = useCallback(() => {
    if (quiet.current) clearTimeout(quiet.current);
    quiet.current = null;
  }, []);
  const reset = useCallback(() => {
    stopWaiting();
    run.current = { length: 0, at: 0, pasted: false };
    paced.current = NO_PACED_RUN;
  }, [stopWaiting]);
  useEffect(() => {
    if (!active) reset();
    return reset;
  }, [active, reset]);

  const takePacedRun = (): boolean => {
    const byScanner = pacedLikeScanner(paced.current);
    paced.current = NO_PACED_RUN;
    return byScanner;
  };
  const noteChange = (value: string, added: number, at: number, pasted: boolean) => {
    if (!active) return;
    paced.current = nextPacedRun(paced.current, { added, at, pasted });
    const last = run.current;
    const inRun = added > 0 && last.length > 0 && at - last.at <= SCAN_PACE_GAP_MS;
    run.current = {
      length: added > 0 ? (inRun ? last.length : 0) + added : 0,
      at,
      pasted: pasted || (inRun && last.pasted),
    };
    stopWaiting();
    const now = run.current;
    const whole = now.pasted || added >= SCANNER_BURST_MIN_LENGTH;
    if (!value.trim() || (!whole && now.length < SCANNER_BURST_MIN_LENGTH)) return;
    quiet.current = setTimeout(() => {
      quiet.current = null;
      run.current = { length: 0, at: 0, pasted: false };
      const byScanner = takePacedRun();
      const typed = field.current?.value ?? '';
      if (!typed.trim()) return;
      if (byScanner) noteScannerUse();
      void latest.current(typed);
    }, SCAN_PACE_QUIET_MS);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!active || event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    stopWaiting();
    const typed = event.currentTarget.value;
    const byScanner = takePacedRun();
    run.current = { length: 0, at: 0, pasted: false };
    if (!typed.trim()) return;
    if (byScanner) noteScannerUse();
    void latest.current(typed);
  };
  return { field, noteChange, stopWaiting, reset, onKeyDown };
}
