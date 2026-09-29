import { Device, FnbOrder, Sale, StationProfile } from '@/types';
import { getAvailableDevices, getPrintTemplate, getMockWristbands } from '@/mockApi';
import { stationDevice } from '@/station/fleet';
import { buildPrepTickets } from '@/lib/fnb';
import { toast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';
import { getSale, type ApiSalePrintJob } from '@/api/history';
import { platformPrintOutcome } from '@/lib/salePrinting';

// SEAM: in production these dispatch to the local print agent keyed by the
// selected device id; the agent holds the real printer addresses. This layer
// only resolves which device a job routes to and surfaces a simulated message.

export function deviceById(id?: string): Device | undefined {
  if (!id) return undefined;
  // A station taken from the platform drives real devices on its box, whose
  // ids the prototype's catalogue has never heard of, so the station's own
  // devices are consulted first and the catalogue remains the fallback for a
  // deployment that has no fleet yet (S2-04).
  return stationDevice(id) ?? getAvailableDevices().find((d) => d.id === id);
}

const deviceName = (d?: Device) => d?.label ?? 'Unassigned';

/** Per-wristband data carried by a credit_voucher print job. */
export interface CreditVoucherData {
  /** QR wallet key — scannable at F&B counter as an alternative to the band. */
  qrCode?: string;
  /** F&B credit amount loaded onto this wallet. */
  balanceTHB: number;
  /** Guest name printed on the voucher. */
  holderName?: string;
}

/** Per-item data carried by an item voucher print job (e.g. free ice cream cone). */
export interface ItemVoucherData {
  /** Item name, e.g. "Free: Ice Cream Cone". */
  label: string;
  /** Quantity to collect. */
  quantity: number;
  /** QR redemption key — seeds from the grant id, matching the customer display. */
  qrCode?: string;
}

export interface PrintJob {
  label: string; // what is being printed
  device?: Device; // where it routes (per the active station profile)
  alert?: string; // a safety alert (e.g. allergy) printed prominently on this ticket
  notes?: string[]; // free-text notes printed on this ticket (item notes + order note)
  header?: string; // template header text (e.g. branch name)
  footer?: string; // template footer text (e.g. thank-you / tax id)
  /** Populated for credit_voucher jobs — one entry per wristband being issued. */
  creditVouchers?: CreditVoucherData[];
  /** Populated for item voucher jobs — one entry per free/collectible item. */
  itemVouchers?: ItemVoucherData[];
}

// The print jobs a finalized ticket sale produces, each routed to the station's
// configured device.
export function ticketPrintJobs(station: StationProfile, sale: Sale): PrintJob[] {
  const receiptTpl = getPrintTemplate('receipt');
  const jobs: PrintJob[] = [
    {
      label: 'Receipt',
      device: deviceById(station.receiptPrinterId),
      header: receiptTpl?.headerText,
      footer: receiptTpl?.footerText,
    },
  ];
  if (sale.bracelets.children > 0) {
    jobs.push({
      label: `Kids bracelet ×${sale.bracelets.children}`,
      device: deviceById(station.kidsBraceletPrinterId),
    });
  }
  if (sale.bracelets.adults > 0) {
    jobs.push({
      label: `Adult bracelet ×${sale.bracelets.adults}`,
      device: deviceById(station.adultBraceletPrinterId),
    });
  }
  // Emit one credit voucher print job per fnb_credit grant (one per adult). The
  // voucher encodes the wallet's QR key so guests can spend without the wristband.
  // Routes to the receipt printer (same device as the sale receipt). The content
  // template is 'credit_voucher'; absent = show everything.
  //
  // Wristband lookup: booking-redemption bands are minted before ticketPrintJobs
  // is called (pushWristband → initWalletLedger in Till.tsx / MobileTill.tsx),
  // so their qrCode + balance are already in the in-memory wristband store and we
  // can resolve them here. Walk-in bands are pre-existing physical bands whose
  // association with the sale is done at door check-in (checkInFamilyWithPayment)
  // — for those the creditVouchers array carries the grant amount only (no QR yet).
  const fnbCreditGrants = sale.creditGrants.filter((g) => g.type === 'fnb_credit');
  if (fnbCreditGrants.length > 0) {
    const voucherTpl = getPrintTemplate('credit_voucher');
    // Apply template field toggles — same gate pattern as wristband/prep tickets.
    // With no template, default to showing everything.
    const showBalance = voucherTpl ? !!voucherTpl.fields.creditVoucherBalance : true;
    const showQr = voucherTpl ? !!voucherTpl.fields.creditVoucherQr : true;

    // Credit wallets are keyed by their fnb_credit-grant index (i), so each
    // voucher pairs to its wallet deterministically regardless of holder role:
    //   1. Booking redemption — `wb-bk-<saleId>-c<i>` (issueBookingBands).
    //   2. Walk-in sale       — `wb-walkin-<saleId>-<i>` (ensureSaleGrantWallet).
    // Both are minted (with qrCode) before dispatchPrintJobs. Exactly one wallet
    // per fnb_credit grant, for adults AND kids alike.
    const allBands = getMockWristbands();

    const creditVouchers: CreditVoucherData[] = fnbCreditGrants.map((grant, i) => {
      const band = allBands.find(
        (w) => w.id === `wb-walkin-${sale.id}-${i}` || w.id === `wb-bk-${sale.id}-c${i}`,
      );
      return {
        balanceTHB: showBalance ? (grant.valueTHB ?? 0) : 0,
        qrCode: showQr ? band?.qrCode : undefined,
        holderName: band?.customerNickname,
      };
    });
    jobs.push({
      label: `F&B credit voucher ×${fnbCreditGrants.length}`,
      device: deviceById(station.receiptPrinterId),
      header: voucherTpl?.headerText,
      footer: voucherTpl?.footerText,
      creditVouchers,
    });
  }

  // Item grants (e.g. a free ice cream cone from a promo code) print one scannable
  // voucher each. The QR seeds from the grant id — the SAME seed the customer
  // display uses — so the printed slip and the on-screen QR resolve identically.
  // This is independent of the F&B credit block: a sale can issue both at once.
  const itemGrants = sale.creditGrants.filter((g) => g.type === 'item');
  if (itemGrants.length > 0) {
    const voucherTpl = getPrintTemplate('credit_voucher');
    const showQr = voucherTpl ? !!voucherTpl.fields.creditVoucherQr : true;
    const itemVouchers: ItemVoucherData[] = itemGrants.map((grant) => ({
      label: grant.label,
      quantity: grant.quantity ?? 1,
      qrCode: showQr ? grant.id : undefined,
    }));
    jobs.push({
      label: `Item voucher ×${itemGrants.length}`,
      device: deviceById(station.receiptPrinterId),
      header: voucherTpl?.headerText,
      footer: voucherTpl?.footerText,
      itemVouchers,
    });
  }

  return jobs;
}

// Bracelet-only print jobs (no receipt / credit grants) routed to the station's
// bracelet printers. Used when bands are issued AFTER the sale receipt already
// printed — e.g. checking in a drop-off child via the door "Check in now" choice.
export function braceletPrintJobs(
  station: StationProfile,
  bracelets: { children: number; adults: number },
): PrintJob[] {
  const jobs: PrintJob[] = [];
  if (bracelets.children > 0) {
    jobs.push({
      label: `Kids bracelet ×${bracelets.children}`,
      device: deviceById(station.kidsBraceletPrinterId),
    });
  }
  if (bracelets.adults > 0) {
    jobs.push({
      label: `Adult bracelet ×${bracelets.adults}`,
      device: deviceById(station.adultBraceletPrinterId),
    });
  }
  return jobs;
}

// An F&B order prints a customer receipt (receipt printer) plus a prep ticket
// per station that has items: food/snacks → kitchen printer, drinks/bar → bar
// printer. Each prep ticket carries the band's allergy alert so prep staff see
// it too. The real local print agent always includes the allergy line.
export function fnbPrintJobs(station: StationProfile, order: FnbOrder): PrintJob[] {
  const receiptTpl = getPrintTemplate('receipt');
  const jobs: PrintJob[] = [
    {
      label: 'Receipt',
      device: deviceById(station.receiptPrinterId),
      header: receiptTpl?.headerText,
      footer: receiptTpl?.footerText,
      // The receipt carries only the whole-order note; per-item notes print on
      // the prep tickets that actually get those items.
      notes: order.orderNote ? [order.orderNote] : undefined,
    },
  ];
  for (const ticket of buildPrepTickets(order)) {
    // The prep ticket's content honors its template's toggles. With no template
    // configured, default to showing everything (the safe fallback).
    const tpl = getPrintTemplate(
      ticket.station === 'kitchen' ? 'kitchen_ticket' : 'bar_ticket',
    );
    const showAllergy = tpl ? !!tpl.fields.allergyLine : true;
    const showNotes = tpl ? !!tpl.fields.orderNotes : true;
    // Each prep ticket prints its own items' notes plus the whole-order note.
    const itemNotes = ticket.lines
      .map((l) => l.note?.trim())
      .filter((n): n is string => !!n);
    const notes = [...itemNotes, ...(ticket.orderNote ? [ticket.orderNote] : [])];
    jobs.push({
      label: `${ticket.title} ticket`,
      device: deviceById(
        ticket.station === 'kitchen' ? station.kitchenPrinterId : station.barPrinterId,
      ),
      alert:
        showAllergy && ticket.allergiesMedical
          ? `⚠ ALLERGY${ticket.holderName ? ` (${ticket.holderName})` : ''}: ${ticket.allergiesMedical}`
          : undefined,
      notes: showNotes && notes.length > 0 ? notes : undefined,
    });
  }
  return jobs;
}

// Fire the simulated routing toast for a set of print jobs.
// Jobs with no device assigned are skipped and surfaced as a subtle note —
// the action (sale / order / check-in) always completes regardless.
export function dispatchPrintJobs(jobs: PrintJob[]) {
  const dispatched = jobs.filter((j) => j.device);
  const skipped = jobs.filter((j) => !j.device);

  // Only toast for dispatched jobs when there are any
  if (dispatched.length > 0) {
    toast({
      title: 'Sending to printers',
      description: (
        <div className="mt-1 space-y-1">
          {dispatched.map((j, i) => (
            <div key={i} className="space-y-0.5">
              <div className="flex items-center justify-between gap-6 text-sm">
                <span className="text-muted-foreground">{j.label}</span>
                <span className="font-semibold">→ {deviceName(j.device)}</span>
              </div>
              {j.header && (
                <div className="text-xs text-muted-foreground/80">{j.header}</div>
              )}
              {j.alert && (
                <div className="text-xs font-bold text-red-500">{j.alert}</div>
              )}
              {j.notes?.map((note, n) => (
                <div key={n} className="text-xs text-amber-500">
                  📝 {note}
                </div>
              ))}
              {/* Credit voucher preview: show balance + QR key per wristband */}
              {j.creditVouchers && j.creditVouchers.length > 0 && (
                <div className="mt-1 space-y-0.5 pl-1 border-l-2 border-emerald-500/40">
                  {j.creditVouchers.map((cv, v) => (
                    <div key={v} className="text-xs text-emerald-400">
                      {cv.holderName ? `${cv.holderName} — ` : ''}
                      <span className="font-bold tabular-nums">฿{cv.balanceTHB}</span>
                      {cv.qrCode && (
                        <span className="ml-1 font-mono opacity-70">[{cv.qrCode}]</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {/* Item voucher preview: show item + qty + QR key per free item */}
              {j.itemVouchers && j.itemVouchers.length > 0 && (
                <div className="mt-1 space-y-0.5 pl-1 border-l-2 border-violet-500/40">
                  {j.itemVouchers.map((iv, v) => (
                    <div key={v} className="text-xs text-violet-300">
                      {iv.label} <span className="font-bold tabular-nums">×{iv.quantity}</span>
                      {iv.qrCode && (
                        <span className="ml-1 font-mono opacity-70">[{iv.qrCode}]</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {j.footer && (
                <div className="text-[11px] italic text-muted-foreground/70">
                  {j.footer}
                </div>
              )}
            </div>
          ))}
        </div>
      ),
    });
  }

  // Subtle, non-blocking note for each skipped job
  if (skipped.length > 0) {
    toast({
      title: 'Some items not printed',
      description: (
        <div className="mt-1 space-y-1">
          {skipped.map((j, i) => (
            <div key={i} className="text-sm text-muted-foreground">
              No printer assigned — <span className="font-medium">{j.label}</span> not printed
            </div>
          ))}
        </div>
      ),
    });
  }
}

/**
 * THE PLATFORM'S PAPER, TOASTED THE WAY THE TILL ALWAYS TOASTED ITS OWN —
 * S2-11 (SCRUM-208).
 *
 * A closed sale's receipt, bands and prep tickets, and a copy History asks
 * for, are print jobs the platform queues for the station's box. This says
 * what they were in the same two toasts `dispatchPrintJobs` shows for the
 * till's own routing: what went to which printer, and — without blocking
 * anything — what was not printed and why.
 */
export function dispatchPlatformPrinting(
  jobs: readonly ApiSalePrintJob[],
  notes: readonly string[] = [],
): void {
  const { sent, notPrinted } = platformPrintOutcome(jobs, notes);
  if (sent.length > 0) {
    toast({
      title: 'Sending to printers',
      description: (
        <div className="mt-1 space-y-1">
          {sent.map((j, i) => (
            <div key={i} className="flex items-center justify-between gap-6 text-sm">
              <span className="text-muted-foreground">{j.label}</span>
              <span className="font-semibold">→ {j.device}</span>
            </div>
          ))}
        </div>
      ),
    });
  }
  if (notPrinted.length > 0) {
    toast({
      title: 'Some items not printed',
      description: (
        <div className="mt-1 space-y-1">
          {notPrinted.map((note, i) => (
            <div key={i} className="text-sm text-muted-foreground">
              {note}
            </div>
          ))}
        </div>
      ),
    });
  }
}

/**
 * Say what a sale that has just closed put on paper, read back from the sale
 * itself: every route that closes a sale — cash at the till, a card on the
 * terminal, a QR the gateway settled — printed in the same transaction, and
 * the sale's read carries the jobs whichever route it was.
 *
 * `fallback` is the till's own simulated routing, for a deployment older than
 * S2-11 whose sale read carries no print jobs at all. A read that fails says
 * nothing: the sale is closed and its paper is the platform's, and a toast
 * guessed at here would be the one thing on screen that is not true.
 */
export async function announceSalePrinting(saleId: string, fallback: () => void): Promise<void> {
  let jobs: ApiSalePrintJob[] | undefined;
  try {
    jobs = (await getSale(saleId)).printJobs;
  } catch {
    return;
  }
  if (!jobs) {
    fallback();
    return;
  }
  dispatchPlatformPrinting(jobs.filter((job) => job.reprintOf === null));
}

export interface EventBraceletPrintParams {
  eventTitle: string;
  eventDate: string; // ISO yyyy-mm-dd (today for events/parties, session date for camps)
  startTime?: string;
  endTime?: string;
  kidName: string;
  wristbandCode: string;
  dietaryDetail?: string;
  allergyDetail?: string;
  // Parent band fields (omit when no parent band is needed).
  parentName?: string;
  parentWristbandCode?: string;
}

/**
 * Build print jobs for an event attendee check-in: always a kid bracelet,
 * optionally a parent bracelet when parentWristbandCode is provided.
 * Routes through the station's bracelet printers (kids → kidsBraceletPrinterId,
 * parent → adultBraceletPrinterId). Missing printer → job still included so
 * dispatchPrintJobs can show the "not printed" non-blocking note.
 */
export function eventBraceletPrintJobs(
  station: StationProfile,
  params: EventBraceletPrintParams,
): PrintJob[] {
  const braceletTpl = getPrintTemplate('kids_wristband');
  const showDietary = braceletTpl ? !!braceletTpl.fields?.dietaryRequirement : true;
  const showAllergy = braceletTpl ? !!braceletTpl.fields?.allergyLine : true;

  const timeLine =
    params.startTime && params.endTime
      ? `${params.startTime} – ${params.endTime}`
      : params.startTime ?? '';

  const kidLabel = [
    `Kid bracelet — ${params.kidName}`,
    `Code: ${params.wristbandCode}`,
    params.eventTitle,
    params.eventDate + (timeLine ? ` · ${timeLine}` : ''),
  ]
    .filter(Boolean)
    .join(' | ');

  const jobs: PrintJob[] = [
    {
      label: kidLabel,
      device: deviceById(station.kidsBraceletPrinterId),
      alert:
        showAllergy && params.allergyDetail
          ? `⚠ ALLERGY (${params.kidName}): ${params.allergyDetail}`
          : undefined,
      notes:
        showDietary && params.dietaryDetail ? [`Dietary: ${params.dietaryDetail}`] : undefined,
    },
  ];

  if (params.parentWristbandCode && params.parentName) {
    const parentLabel = [
      `Parent bracelet — ${params.parentName}`,
      `Code: ${params.parentWristbandCode}`,
      params.eventTitle,
      params.eventDate,
    ]
      .filter(Boolean)
      .join(' | ');
    jobs.push({
      label: parentLabel,
      device: deviceById(station.adultBraceletPrinterId),
    });
  }

  return jobs;
}

// Prompt the operator to configure this station before they can print.
export function promptSetupStation(navigate: (to: string) => void) {
  toast({
    title: 'Set up this station first',
    description: "Assign this iPad's printers and scanner before taking payment.",
    action: (
      <ToastAction altText="Open Station Setup" onClick={() => navigate('/station-setup')}>
        Set up
      </ToastAction>
    ),
  });
}

// Simulated hardware test helpers used by the Station Setup screen.
export function testPrint(device?: Device) {
  // Real print job goes to the local print agent on the branch mini-PC.
  if (!device) {
    toast({ title: 'No printer selected', description: 'Choose a printer first.' });
    return;
  }
  toast({
    title: 'Test print sent',
    description: `Test sent to ${device.label}${device.address ? ` (${device.address})` : ''}`,
  });
}

export function testScan(device: Device | undefined, onConnected?: () => void) {
  // Real scans arrive as HID keyboard input from the OS-paired Bluetooth scanner.
  if (!device) {
    toast({ title: 'No scanner selected', description: 'Choose a scanner first.' });
    return;
  }
  toast({ title: 'Testing scanner…', description: `Waiting for ${device.label}` });
  window.setTimeout(() => {
    toast({ title: 'Scanner connected', description: 'Test scan received.' });
    onConnected?.();
  }, 1200);
}
