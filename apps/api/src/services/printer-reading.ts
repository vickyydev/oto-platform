import { isPrinterKind, printerAddressProblem } from '@oto/shared';

/**
 * SCRUM-952 — A PRINTER WITH NO ADDRESS IS NOT READ AS HEALTHY.
 *
 * A device row's `reachability`, `paper_status` and `last_error` are what its
 * box last reported, or the seed's defaults until a box reports at all. A
 * printer saved with no address keeps whatever those say — the seeded
 * Receipt Printer 1 at Robinson Chalong read "reachable" and "paper ok" on a
 * box that has never reported — while the box skips every job sent to it
 * (`DEVICE_NO_ADDRESS` in `adapterFor`, `packages/box-agent/src/printing/
 * queue.ts`). The Console's box drawer already draws it as not set up; the
 * platform's own reading said it was healthy, so the Health page's dot stayed
 * green and a till's printer light stayed clear.
 *
 * So the platform reads such a printer the way the box itself reads it on
 * every heartbeat (`probeAll` in the same file): nothing known of its
 * reachability or its paper, and `DEVICE_NO_ADDRESS` as its last error. The
 * till's printer light already words that code ("no address set"), and the
 * Console's Health page draws it as not set up, as the box drawer does.
 *
 * Only a printer with NO address is read anew. A printer with an address,
 * and every device that is not a printer, reads exactly what its row says.
 */
export const NO_ADDRESS_ERROR = 'DEVICE_NO_ADDRESS';

export interface PrinterReading {
  reachability: string;
  paperStatus: string;
  lastError: string | null;
}

export function printerReading(row: {
  kind: string;
  address: string | null;
  reachability: string;
  paperStatus: string;
  lastError: string | null;
}): PrinterReading {
  if (isPrinterKind(row.kind) && printerAddressProblem(row.address) === 'missing') {
    return { reachability: 'unknown', paperStatus: 'unknown', lastError: NO_ADDRESS_ERROR };
  }
  return { reachability: row.reachability, paperStatus: row.paperStatus, lastError: row.lastError };
}
