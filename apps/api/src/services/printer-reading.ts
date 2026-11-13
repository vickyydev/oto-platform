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
 * and every device that is not a printer, reads exactly what its row says —
 * with one exception, below.
 *
 * SCRUM-971 — A PRINTER GIVEN AN ADDRESS IS NO LONGER "NOT SET UP".
 *
 * The row keeps `DEVICE_NO_ADDRESS` as its last error until its box reports
 * on it again: until the next heartbeat after the box has pulled the new
 * address, and for ever on a box that is switched off. The Console and the
 * till read that code as "not set up" (`readAsNotSetUp`, the till's printer
 * light), so a printer somebody had just given an address kept saying it had
 * none. A printer whose address the box can open and whose stored error is
 * still `DEVICE_NO_ADDRESS` is therefore read as what is true of it: not yet
 * checked since its address was set — its reachability and its paper unknown,
 * and no error. The box's next report on it is read as it comes. A legacy
 * address the box cannot open is left as its row says: the box skips it for
 * the same reason (`adapterFor` reads it as no address), so the code is still
 * true of it. The audit trail keeps the raw row either way.
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
  if (isPrinterKind(row.kind)) {
    const problem = printerAddressProblem(row.address);
    if (problem === 'missing') {
      return { reachability: 'unknown', paperStatus: 'unknown', lastError: NO_ADDRESS_ERROR };
    }
    if (problem === null && row.lastError === NO_ADDRESS_ERROR) {
      return { reachability: 'unknown', paperStatus: 'unknown', lastError: null };
    }
  }
  return { reachability: row.reachability, paperStatus: row.paperStatus, lastError: row.lastError };
}
