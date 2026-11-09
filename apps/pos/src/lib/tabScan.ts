import { useEffect, useRef, useState } from 'react';
import { bandShortCode } from '@oto/shared';
import { toast } from '@/hooks/use-toast';
import { readTabScan, type StationScanEvent, type TabScan } from '@/lib/scanChannel';
import type { Wristband } from '@/types';

// A WRISTBAND OR A CREDIT VOUCHER READ AT THE COUNTER'S SCANNER (SCRUM-731).
//
// `readTabScan` says what the box read; this says what each screen does about
// it. There is no second way of opening a tab here. A counter's first screen
// looks the key up through `ScanWristband`, the path a typed code takes, so the
// same child gets the same allergy banner and the same food consent however the
// code arrived. Every other moment changes nothing and says so in words: a
// customer's tab is opened only where a typed code could have opened it, so the
// sale on screen, its credit and its food override are never changed by a scan.
// History's Add time dialog asks for a bracelet scan, so it takes one as it takes
// the typed code, and only while its bracelets can still be chosen.

/** The stages the F&B and shop counters share. */
export type CounterStage = 'scan' | 'order' | 'payment' | 'confirmation';

/** What to say when a scan changed nothing. */
export interface TabScanWords {
  title: string;
  description: string;
  variant?: 'destructive';
}

export type TabScanDecision = { kind: 'open'; key: string } | ({ kind: 'say' } & TabScanWords);

const say = (words: TabScanWords): TabScanDecision => ({ kind: 'say', ...words });

const CREDIT_VOUCHER = 'Credit voucher';

/** The box would not take it: its words, and which of the two it was read as. */
function refusal(scan: Extract<TabScan, { ok: false }>): TabScanWords {
  return {
    title: scan.what === 'wallet' ? `${CREDIT_VOUCHER} not read` : 'Wristband not read',
    description: scan.message,
    variant: 'destructive',
  };
}

const notOpened = (scan: Extract<TabScan, { ok: true }>): string =>
  scan.what === 'wallet' ? `${CREDIT_VOUCHER} not opened` : `Wristband ${scan.key} not opened`;

/** Whether the tab already on screen is the one this key names. */
function isHeld(key: string, held: Pick<Wristband, 'code' | 'qrCode'> | null): boolean {
  if (!held) return false;
  const wanted = key.trim().toUpperCase();
  const code = held.code.trim().toUpperCase();
  return wanted === code || wanted === bandShortCode(code) || wanted === held.qrCode?.trim().toUpperCase();
}

/**
 * THE F&B AND SHOP COUNTERS. Only their first screen opens a tab, which is the
 * only screen a typed code can open one from. `noun` is the word each counter
 * uses for what it is ringing up.
 */
export function decideCounterTabScan(
  scan: TabScan,
  stage: CounterStage,
  held: Pick<Wristband, 'code' | 'qrCode'> | null,
  noun: 'order' | 'sale',
): TabScanDecision {
  if (!scan.ok) return say(refusal(scan));
  if (stage === 'scan') return { kind: 'open', key: scan.key };
  const title = notOpened(scan);
  if (stage === 'order') {
    if (isHeld(scan.key, held)) {
      return say({
        title: scan.what === 'wallet' ? `This ${CREDIT_VOUCHER.toLowerCase()} is already open` : 'This wristband is already open',
        description: `It is on this ${noun}. Nothing changed.`,
      });
    }
    return say({
      title,
      description: `This ${noun} is still open. Finish or clear it, then scan again. Nothing changed.`,
      variant: 'destructive',
    });
  }
  if (stage === 'payment') {
    return say({ title, description: `Finish this ${noun} first. Nothing changed.`, variant: 'destructive' });
  }
  return say({
    title,
    description: `This ${noun} is finished. Start the next one, then scan again. Nothing changed.`,
    variant: 'destructive',
  });
}

/**
 * THE TICKET TILL. The prototype's till reads no band, and the park's wallet
 * credit is spent at F&B and the shop, so a scan means nothing to the sale here.
 * It says so rather than leave staff wondering whether the scanner heard them.
 */
export function ticketTillTabScanWords(scan: TabScan): TabScanWords {
  if (!scan.ok) return refusal(scan);
  return scan.what === 'wallet'
    ? {
        title: `That is a ${CREDIT_VOUCHER.toLowerCase()}`,
        description: 'It spends at F&B or the shop. Nothing changed on this sale.',
      }
    : {
        title: `That is wristband ${scan.key}`,
        description: 'It opens at F&B, the shop or History. Nothing changed on this sale.',
      };
}

/** History's decision: its own two, or the band handed to the open Add time dialog. */
export type HistoryTabScanDecision = TabScanDecision | { kind: 'add-time'; key: string };

/**
 * HISTORY. A band opens its orders, as the typed bracelet code does. A credit
 * voucher does not, because History's typed form takes bracelet codes alone. An
 * open sale may have a refund under way on it, so a scan does not take it away,
 * unless that sale's Add time dialog is open and asking for this very scan.
 */
export function decideHistoryTabScan(scan: TabScan, saleOpen: boolean, addTimeOpen = false): HistoryTabScanDecision {
  if (!scan.ok) return say(refusal(scan));
  if (scan.what === 'wallet') {
    return say({
      title: `That is a ${CREDIT_VOUCHER.toLowerCase()}, not a bracelet`,
      description: 'History finds orders by bracelet. A credit voucher opens at F&B or the shop. Nothing changed here.',
    });
  }
  if (addTimeOpen) return { kind: 'add-time', key: scan.key };
  if (saleOpen) {
    return say({
      title: `Bracelet ${scan.key} not opened`,
      description: 'Go back from this sale first, then scan again. Nothing changed.',
      variant: 'destructive',
    });
  }
  return { kind: 'open', key: scan.key };
}

/**
 * How a band reaches a dialog on top of a sale. History holds the one station
 * channel; the dialog fills this slot for as long as it is on screen.
 */
export interface BandScanSlot {
  current: ((key: string) => void) | null;
}

const notAdded = (key: string): string => `Bracelet ${key} not added`;

/**
 * Why the Add time dialog cannot take a band now, or null when it can. These are
 * the moments its typed field is out of reach too: the charge has taken the
 * bracelets as they stood, or the staff member is counting them instead.
 */
export function addTimeScanRefusal(key: string, dialog: { chargeUnderWay: boolean; countOnly: boolean }): TabScanWords | null {
  if (dialog.chargeUnderWay) {
    return {
      title: notAdded(key),
      description: 'The bracelets on this Add time are already set for payment. Nothing changed.',
      variant: 'destructive',
    };
  }
  if (dialog.countOnly) {
    return {
      title: notAdded(key),
      description: 'Count only is chosen here. Press Select or scan bracelets, then scan again. Nothing changed.',
      variant: 'destructive',
    };
  }
  return null;
}

/** A band the Add time dialog took: ticking one already ticked shows nothing, so it says so. */
export function addTimeScanTaken(key: string, alreadyTicked: boolean): TabScanWords {
  return alreadyTicked
    ? { title: `Bracelet ${key} is already ticked`, description: 'Nothing changed.' }
    : { title: `Bracelet ${key} added`, description: 'It is ticked on this Add time.' };
}

/** Replacing bracelets on a paid charge is by its list alone: that dialog has no scan field. */
export function replacementBandScanWords(key: string): TabScanWords {
  return {
    title: notAdded(key),
    description: 'Tick the replacement bracelets on this list. Nothing changed.',
    variant: 'destructive',
  };
}

/**
 * The counters' half: what the channel's handler calls, and the key handed to
 * `ScanWristband` when a scan is to open a tab.
 *
 * `hear` answers true when the scan was a wristband or a credit voucher, so the
 * handler stops there. The key waits for `ScanWristband` to take it, and is let
 * go when the first screen is gone or the station locks: a scan must never land
 * on the next guest, or after an unlock.
 */
export function useCounterTabScan(input: {
  stage: CounterStage;
  held: Pick<Wristband, 'code' | 'qrCode'> | null;
  locked: boolean;
  noun: 'order' | 'sale';
}): {
  scanned: string | null;
  taken: () => void;
  hear: (event: StationScanEvent) => boolean;
  /** SCRUM-766 — the same, for a code read off the page's own keyboard (`lib/pageScan.ts`). */
  take: (scan: TabScan) => void;
} {
  const [scanned, setScanned] = useState<string | null>(null);
  const latest = useRef(input);
  latest.current = input;

  useEffect(() => {
    if (input.locked || input.stage !== 'scan') setScanned(null);
  }, [input.locked, input.stage]);

  const take = (scan: TabScan) => {
    const now = latest.current;
    if (now.locked) return;
    const decision = decideCounterTabScan(scan, now.stage, now.held, now.noun);
    // The code as read goes to the form, as if it had been typed there.
    if (decision.kind === 'open') setScanned(scan.ok && scan.code ? scan.code : decision.key);
    else {
      const { kind: _kind, ...words } = decision;
      toast(words);
    }
  };

  return {
    scanned,
    taken: () => setScanned(null),
    hear: (event) => {
      const scan = readTabScan(event);
      if (!scan) return false;
      take(scan);
      return true;
    },
    take,
  };
}
