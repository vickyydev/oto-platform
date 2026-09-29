import type { PrintKind } from '@oto/shared';
import type { ApiSalePrintJob } from '@/api/history';

/**
 * WHAT THE PLATFORM PUT ON PAPER, IN THE TILL'S WORDS — S2-11 (SCRUM-208).
 *
 * Until S2-11 the till worked its printing out for itself
 * (`lib/printRouting.tsx`: `ticketPrintJobs`, `fnbPrintJobs`) and toasted a
 * simulation of it. The platform now queues the paper when a sale closes and
 * when History asks for a copy: print jobs, each routed to the station's
 * printer for its role, or `skipped` where the station has none. This turns
 * those jobs into the two lists the till's printing toast has always shown —
 * what went to which printer, and what was not printed — so the counter reads
 * the same whichever side did the routing. Pure: no React, no toast.
 */

/** Each printout as the till's toast names it — the prototype's words (`printRouting.tsx`). */
export const PRINT_KIND_LABEL: Record<PrintKind, string> = {
  receipt: 'Receipt',
  kitchen_ticket: 'Kitchen ticket',
  bar_ticket: 'Bar ticket',
  kids_wristband: 'Kids bracelet',
  adult_wristband: 'Adult bracelet',
  credit_voucher: 'F&B credit voucher',
  item_voucher: 'Item voucher',
  booth_voucher: 'Voucher',
  test_page: 'Test page',
};

export interface PrintOutcome {
  /** "Kids bracelet ×2" → "Kids band printer": one row per printout and printer. */
  sent: { label: string; device: string }[];
  /** One sentence per printout that did not go to a printer. */
  notPrinted: string[];
}

/**
 * Where a job went, when the answer names no device — a reprint's answer
 * carries the job as it was queued, without the printer's label: the printer
 * for its role at this station.
 */
function printerOf(job: ApiSalePrintJob): string {
  if (job.deviceLabel) return job.deviceLabel;
  if (!job.role) return 'Printer';
  const role = job.role.replace('_', ' ');
  return `${role.charAt(0).toUpperCase()}${role.slice(1)} printer`;
}

/** The platform's own sentence for a job skipped for want of a printer (`noteFor`, sale-printing.ts). */
function skippedSentence(job: ApiSalePrintJob): string {
  const role = (job.role ?? 'printer').replace('_', ' ');
  return `${PRINT_KIND_LABEL[job.kind]} not printed — no ${role} printer at this station`;
}

/**
 * The toast's two lists from a set of print jobs.
 *
 * `notes` are the platform's sentences where the answer carried them (a
 * finalise, a reprint); a read of the sale carries none, and the same sentence
 * is then made from each skipped job. A job that FAILED at its printer — paper
 * out, the printer off — says what the printer said. Every sentence once.
 */
export function platformPrintOutcome(
  jobs: readonly ApiSalePrintJob[],
  notes: readonly string[] = [],
): PrintOutcome {
  const sent = new Map<string, { kind: PrintKind; copy: boolean; device: string; count: number }>();
  const notPrinted: string[] = [...notes];
  for (const job of jobs) {
    if (job.status === 'queued' || job.status === 'printed') {
      const device = printerOf(job);
      const copy = job.reprintOf !== null;
      const key = `${job.kind}|${device}|${copy}`;
      const row = sent.get(key);
      if (row) row.count += 1;
      else sent.set(key, { kind: job.kind, copy, device, count: 1 });
    } else if (job.status === 'skipped') {
      if (notes.length === 0) notPrinted.push(skippedSentence(job));
    } else if (job.status === 'failed') {
      notPrinted.push(
        `${PRINT_KIND_LABEL[job.kind]} not printed${job.errorMessage ? ` — ${job.errorMessage}` : ''}`,
      );
    }
  }
  return {
    sent: [...sent.values()].map((row) => ({
      label: `${PRINT_KIND_LABEL[row.kind]}${row.count > 1 ? ` ×${row.count}` : ''}${row.copy ? ' (copy)' : ''}`,
      device: row.device,
    })),
    notPrinted: [...new Set(notPrinted)],
  };
}
