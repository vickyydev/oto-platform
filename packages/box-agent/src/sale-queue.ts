import {
  isLegacyBoothCode,
  mintBandCode,
  normaliseBoothCode,
  salePrintDocumentOf,
  salePrintRequests,
  ulidFromUuid,
  verifyBoothCode,
  type PrintKind,
  type SalePrintRequest,
  type SalePrintSnapshot,
  type SaleReprintKind,
} from '@oto/shared';
import {
  paymentRecordedFact,
  saleFinalisedFact,
  type OfflineBandFact,
  type OfflineReceiptFact,
  type OfflineSaleFact,
  type OfflineTenderFact,
  type Outbox,
} from './outbox';
import type { PrintingController } from './printing/index';
import { ROLE_FOR_KIND, type PrintJobOutcome } from './printing/queue';
import { uuidv7 } from './signing';
import type { BoxStore, EnvelopeSealer, PrintJobRecord } from './store';

/**
 * TAKING MONEY WITH THE LINK DOWN (S2-10a, Slice G; offline plan §2.4, Round 4).
 *
 * The rule the outbox states — a fact is on disk before the person who caused
 * it is told it worked — applied to the one fact that is money. The till hands
 * the sale over, this writes it to the box's own queue, and it reaches the
 * ledger whenever the mall's internet comes back: minutes, or tomorrow.
 *
 * ROUND 4 MAKES IT ONE TRANSACTION (plan §2.4 step 3, the booth's pattern):
 * the receipt number from the station's series, the band ids and codes minted
 * with the park's key (OD-13), the print jobs composed from the sale's own
 * snapshot (§2.5), the box's log of the sale, and the `sale.finalised` fact —
 * all of them or none, in one store transaction. Then the drawer, then the
 * paper: nothing is opened or printed for a sale that is not on disk, and a
 * power cut after the commit leaves print jobs the queue resumes rather than a
 * sale nobody can find.
 *
 * WHAT THE BOX DECIDES AND WHAT IT DOES NOT. It decides the journal position
 * (`box_seq`), the receipt number, the band codes and whether the drawer opens.
 * The price it charged is the bridge's to have checked before it got here; the
 * price the ledger files is re-derived on arrival (`payments/offline.ts`).
 */

// --- The words ------------------------------------------------------------------

/**
 * S2-10b (SCRUM-207) — THE WORDS AN OFFLINE SALE CARRYING A VOUCHER IS REFUSED
 * WITH, exactly as the till shows them.
 */
export const OFFLINE_VOUCHER_REFUSAL =
  'Vouchers need the internet — take this one when the connection is back';

/** A sale the box will not take offline, with a code the till can tell apart. */
export class OfflineSaleRefused extends Error {
  readonly code: 'VOUCHER_NEEDS_INTERNET';

  constructor(message: string, code: 'VOUCHER_NEEDS_INTERNET') {
    super(message);
    this.name = 'OfflineSaleRefused';
    this.code = code;
  }
}

/**
 * The Lucky Wheel voucher an offline sale's cart names, or null — the one
 * question the box asks of a cart it otherwise never reads.
 *
 * A voucher is redeemed online only (spec §8; the owner, 24 September): it is
 * held by the platform for one cart and used up in the transaction that
 * closes that sale. A voucher riding an offline sale would be honoured at the
 * counter on the strength of the slip alone, never used up, and the sale's
 * price would disagree with the platform's when it arrived. So the box refuses
 * the sale before it numbers or queues anything.
 *
 * A till names one by putting its code in the cart's `promoCodes` — flat, or
 * under `cart` as the till nests it — and nowhere else. `promos` is not read
 * here on purpose: the park's own discount codes ride there and some have a
 * booth code's shape (SONGKRAN25), which only the platform can tell apart.
 */
export function voucherOnOfflineCart(cart: Record<string, unknown>): string | null {
  const codesOf = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((code): code is string => typeof code === 'string') : [];
  const nested =
    cart.cart && typeof cart.cart === 'object' ? (cart.cart as Record<string, unknown>) : null;
  for (const raw of [...codesOf(cart.promoCodes), ...codesOf(nested?.promoCodes)]) {
    const code = normaliseBoothCode(raw);
    if (verifyBoothCode(code).ok || isLegacyBoothCode(code)) return code;
  }
  return null;
}

// --- What a caller hands over, and what it gets back ------------------------------

/**
 * One band a sale owes, before it has an id or a code: which kind, which cart
 * line and ledger line it admits against, and who wears it.
 */
export interface OfflineBandPlan {
  kind: 'kid' | 'adult';
  cartLineId: string;
  saleLineId: string | null;
  childId: string | null;
  childName: string | null;
  allergies: string | null;
  medicalNotes: string | null;
  dietary: string | null;
}

/**
 * What the box prints for a sale and keeps for a reprint (plan §2.5).
 *
 * Everything the shared composer reads that is known before the sale has a
 * receipt number and bands: the ledger's lines, the money, the names. The
 * number and the bands are minted inside the transaction and laid onto it.
 */
export interface OfflineSalePrintout {
  snapshot: Omit<SalePrintSnapshot, 'saleId' | 'receiptNumber' | 'at' | 'bands'>;
  bands: OfflineBandPlan[];
  /** The trading day the box put the sale on: a reprint is today's sales only. */
  businessDate: string;
}

export interface OfflineSaleRequest extends Omit<OfflineSaleFact, 'saleId' | 'receipt' | 'bands'> {
  /** Minted at the till. One is minted here when the till did not send one. */
  saleId?: string;
  /**
   * Open the drawer. Defaults to "whenever one of the tenders was cash", which
   * is the rule the cloud's own cash finalise applies (`payments/drawer.ts`) —
   * a card payment leaves it shut.
   */
  openDrawer?: boolean;
  /**
   * What to print and keep (Round 4). Absent: the sale is recorded and
   * numbered with nothing printed and no bands issued — the S2-10a shape.
   */
  printout?: OfflineSalePrintout | null;
  /**
   * The caller's own record of the sale, kept in the box's log beside it and
   * handed back unchanged when the same sale id is recorded again — so a till
   * retrying through a lost answer is told exactly what it was told the first
   * time. The bridge keeps the till's view of the sale here.
   */
  memo?: Record<string, unknown> | null;
}

export interface OfflineTenderRequest {
  saleId: string;
  stationId: string;
  actorAccountId: string;
  tender: OfflineTenderFact;
  occurredAt?: string;
  actionId?: string | null;
  openDrawer?: boolean;
}

/** One printout of a sale, as the box's log keeps it. */
export interface SalePrintLogJob {
  id: string;
  kind: PrintKind;
  subjectType: SalePrintRequest['subjectType'];
  subjectId: string;
  status: 'queued' | 'printed' | 'failed' | 'skipped';
  errorCode: string | null;
  /** True on a copy asked for later. */
  copy: boolean;
}

/**
 * A band as the box's OWN answer and log carry it: the wire fact plus the
 * child's name. The name never rides the cloud fact (`OfflineBandFact`), but the
 * receipt prints it and the till reads it out when a band does not print, so the
 * box keeps it beside the code it minted. Already in the print snapshot the log
 * holds, so persisting it here is no new record.
 */
export interface OfflineAnswerBand extends OfflineBandFact {
  childName: string | null;
}

export interface OfflineSaleAnswer {
  saleId: string;
  /** The number the box printed and the guest holds (OD-4). */
  receipt: OfflineReceiptFact | null;
  /** The journal position the first of this sale's facts took. */
  boxSeq: number;
  /** How many facts this call put on the queue. None on a replay. */
  queued: number;
  /** What the drawer did. `not_asked` when this sale took no cash, and on a replay. */
  drawer: 'opened' | 'failed' | 'not_asked';
  /** Everything still waiting to go up, so the till can say "3 sales to send". */
  outboxDepth: number;
  /** True when this sale was already on the box and this is its first answer again. */
  replay: boolean;
  /** The bands minted for it, codes and child names included (OD-13). */
  bands: OfflineAnswerBand[];
  /** What it put on paper, and what did not print. */
  printing: { jobs: SalePrintLogJob[]; notes: string[] };
  /** The caller's own record, as it was kept (`OfflineSaleRequest.memo`). */
  memo: Record<string, unknown> | null;
}

/** A station's receipt numbering, as the cache bundle last shipped it. */
export interface ReceiptMark {
  stationId: string;
  /** The station's `code_prefix`, which is the series name printed on the number. */
  prefix: string | null;
  /** The highest number the CLOUD has issued in this series. 0 means none. */
  highWaterMark: number;
}

/** A sale this box recorded, as its log keeps it. */
export interface RecordedSale {
  saleId: string;
  stationId: string;
  businessDate: string | null;
  at: string;
  receipt: OfflineReceiptFact;
  bands: OfflineAnswerBand[];
  boxSeq: number;
  snapshot: SalePrintSnapshot | null;
  jobs: SalePrintLogJob[];
  drawer: OfflineSaleAnswer['drawer'];
  notes: string[];
  memo: Record<string, unknown> | null;
}

export interface SaleQueue {
  /**
   * Record a whole sale and its money. On disk when this resolves.
   *
   * ONE FACT carries both: the cart and every tender that closed the sale
   * travel inside a single `sale.finalised`, so a box that loses power has
   * either the whole sale or none of it, and the cloud applies both halves in
   * one savepoint. Recording the same sale id again answers from the box's log
   * and writes nothing.
   */
  record(request: OfflineSaleRequest): Promise<OfflineSaleAnswer>;
  /** A later tender against a sale already queued: a split's second half, a late approval. */
  recordTender(request: OfflineTenderRequest): Promise<OfflineSaleAnswer>;
  /** Where this station's receipt numbering stands, as the box last heard. */
  receiptMark(stationId: string): Promise<ReceiptMark | null>;
  /**
   * The till's report of the number the platform gave an online sale at this
   * station (OD-4, `receipt.observed`). The box's offline series continues
   * from the higher of this and the pulled mark. Null for a number that is not
   * this station's series.
   */
  observeReceipt(stationId: string, receiptNumber: string): Promise<{ prefix: string; seq: number } | null>;
  /** The sale this box recorded under this id, from its log. */
  recorded(saleId: string): Promise<RecordedSale | null>;
  /** Another copy of a sale this box recorded on `today`'s trading day (plan §2.8, Reprint). */
  reprint(
    saleId: string,
    kind: SaleReprintKind,
    opts: { today: string; reason?: string | null; actionId?: string | null },
  ): Promise<{ jobs: SalePrintLogJob[]; notes: string[] }>;
  /**
   * Whether a print job is one of the box's own for a sale it recorded, and if
   * so, write its outcome into that sale's log. The platform has no row for
   * such a job, so its outcome never goes up the print-result route.
   */
  notePrintOutcome(outcome: PrintJobOutcome): Promise<boolean>;
}

/** Why a sale cannot be numbered offline: configuration somebody can fix in a minute. */
export class ReceiptSeriesUnavailable extends Error {
  readonly code: 'RECEIPT_MARK_MISSING' | 'STATION_NO_PREFIX';

  constructor(code: ReceiptSeriesUnavailable['code'], message: string) {
    super(message);
    this.name = 'ReceiptSeriesUnavailable';
    this.code = code;
  }
}

/** A reprint the box cannot make, with the reason in the counter's words. */
export class ReprintRefused extends Error {
  readonly code: 'NOT_ON_THIS_BOX' | 'NOT_TODAY' | 'NOTHING_TO_REPRINT';

  constructor(code: ReprintRefused['code'], message: string) {
    super(message);
    this.name = 'ReprintRefused';
    this.code = code;
  }
}

// --- The queue --------------------------------------------------------------------

export interface SaleQueueDeps {
  store: BoxStore;
  boxId: string;
  outbox: Outbox;
  /** Seals facts with the box's signing key; null before registration. */
  sealer: () => EnvelopeSealer | null;
  /** The print pipeline, or null on a box built without one. */
  printing: () => PrintingController | null;
  /**
   * Whether the print queue keeps its jobs on disk (`printing.durable`). Only
   * then are a sale's jobs written in its transaction: a queue in memory never
   * deletes a stored row, and a row left behind would print again the day the
   * queue became durable.
   */
  durablePrinting?: () => boolean;
  /** The park's band key: the host's own, else the config bundle's (OD-13). */
  bandKey: () => string | Uint8Array | null;
  /** The box's corrected clock. */
  now: () => Date;
  note: (level: 'info' | 'warn' | 'error', msg: string, detail?: Record<string, unknown>) => void;
  /**
   * Named crash points for the finalise transaction, called inside it in
   * order. A test throws from one to prove that nothing half-lands; nothing
   * else passes it.
   */
  crashPoint?: (point: FinaliseCrashPoint) => void | Promise<void>;
}

/** Where inside the finalise transaction a test can pull the power lead. */
export const FINALISE_CRASH_POINTS = [
  'after_receipt',
  'after_bands',
  'after_print_jobs',
  'after_fact',
  'after_log',
] as const;
export type FinaliseCrashPoint = (typeof FINALISE_CRASH_POINTS)[number];

/**
 * The receipt counter's scope and its pinned date.
 *
 * `edge.box_counter` moves in ONE statement, so two tills finishing in the
 * same second cannot both take one number. THE DATE IS PINNED: the other
 * users of this table are daily caps and want the reset the key's
 * `business_date` gives them, and a receipt series is continuous — a box
 * offline across midnight must not re-issue last evening's numbers.
 */
const RECEIPT_SEQ_SCOPE = 'receipt_seq';
const RECEIPT_SERIES_DAY = '1970-01-01';
/** `pos.receipt_series.seq_padding`'s default; the ledger's number is authoritative either way. */
const RECEIPT_SEQ_PADDING = 6;
const RECEIPT_SERIES = 'receipt_series';

const logKey = (saleId: string) => `sale_log:${saleId}`;
/**
 * The sales whose log still carries their paper, by trading day. A log holds a
 * member's name, a child's allergy line and the bands' signed codes — what a
 * reprint needs, and nothing a box in a storeroom should keep longer than the
 * day a reprint is for (plan §2.8, "Reprint — today's sales on this box").
 */
const LOG_INDEX_KEY = 'sale_log_index';
const jobKey = (jobId: string) => `sale_print_job:${jobId}`;
const observedKey = (stationId: string) => `receipt_observed:${stationId}`;

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Cash opens the drawer; a card leaves it shut. */
function tookCash(tenders: readonly OfflineTenderFact[]): boolean {
  return tenders.some((t) => t.kind === 'cash' || t.methodCode === 'cash');
}

/** `T1-000042` → `{ prefix: 'T1', seq: 42 }`, or null. */
export function parseReceiptNumber(raw: string): { prefix: string; seq: number } | null {
  const match = /^(.+)-(\d+)$/.exec(raw.trim());
  if (!match) return null;
  const seq = Number(match[2]);
  return Number.isSafeInteger(seq) && seq > 0 ? { prefix: match[1]!, seq } : null;
}

export function createSaleQueue(deps: SaleQueueDeps): SaleQueue {
  const { store, boxId, outbox } = deps;
  const crash = async (point: FinaliseCrashPoint): Promise<void> => {
    await deps.crashPoint?.(point);
  };

  async function receiptMarks(from: BoxStore = store): Promise<ReceiptMark[]> {
    const held = await from.readBundle(boxId, RECEIPT_SERIES).catch(() => null);
    const items = (held?.payload as { items?: unknown[] } | undefined)?.items ?? [];
    const out: ReceiptMark[] = [];
    for (const raw of items) {
      const item = raw as Partial<ReceiptMark>;
      if (typeof item?.stationId !== 'string') continue;
      out.push({
        stationId: item.stationId,
        prefix: typeof item.prefix === 'string' ? item.prefix : null,
        highWaterMark: typeof item.highWaterMark === 'number' ? item.highWaterMark : 0,
      });
    }
    return out;
  }

  /**
   * The number this sale is shown under at the counter (OD-4).
   *
   * THE SERIES CONTINUES FROM THE HIGHEST NUMBER ANYBODY HERE HAS SEEN: the
   * mark the cloud last shipped, the last number the till reported from an
   * online sale (`receipt.observed`), and the last number this box minted
   * itself. So a box that sold five offline, reconnected, took the mark only
   * part-way (three had synced) and went offline again does not print the
   * other two numbers a second time — a guest is already holding them.
   *
   * REFUSES rather than guesses. A box that has never been told where the
   * series stands would start at 1 and collide with numbers the cloud has
   * already issued; a station with no code prefix cannot number a receipt at
   * all. Both are configuration somebody can fix in a minute; taking the money
   * first is what cannot be fixed.
   */
  async function mintReceipt(tx: BoxStore, stationId: string, at: string): Promise<OfflineReceiptFact> {
    const mark = (await receiptMarks(tx)).find((m) => m.stationId === stationId);
    if (!mark) {
      throw new ReceiptSeriesUnavailable(
        'RECEIPT_MARK_MISSING',
        'This box has not been told where this station’s receipt numbering stands, so it cannot number a sale offline',
      );
    }
    if (!mark.prefix) {
      throw new ReceiptSeriesUnavailable(
        'STATION_NO_PREFIX',
        'This station has no code prefix, so it cannot number a receipt',
      );
    }
    const observed = parseJson<{ prefix: string; seq: number }>(
      await tx.readRuntimeValue(boxId, observedKey(stationId)),
    );
    const base = Math.max(
      mark.highWaterMark,
      observed && observed.prefix === mark.prefix ? observed.seq : 0,
    );
    const key = {
      scope: RECEIPT_SEQ_SCOPE,
      key: `last:${stationId}:${mark.prefix}`,
      businessDate: RECEIPT_SERIES_DAY,
    };
    const held = await tx.readCounter(boxId, key);
    let last = held;
    if (held === 0) {
      /**
       * A box upgraded in the middle of an outage: what it minted under the
       * S2-10a key — a count since the mark — still stands, and a guest holds
       * those numbers.
       */
      const legacy = await tx.readCounter(boxId, {
        scope: RECEIPT_SEQ_SCOPE,
        key: `${stationId}:${mark.prefix}:${mark.highWaterMark}`,
        businessDate: RECEIPT_SERIES_DAY,
      });
      if (legacy > 0) last = mark.highWaterMark + legacy;
    }
    const target = Math.max(base, last) + 1;
    // One statement moves the counter to the target; a race only ever skips a
    // number, it never hands one out twice.
    const seq = await tx.bumpCounter(boxId, key, target - held, at);
    return {
      series: mark.prefix,
      seq,
      number: `${mark.prefix}-${String(seq).padStart(RECEIPT_SEQ_PADDING, '0')}`,
    };
  }

  /**
   * The bands a sale owes, minted on the box with the park's own key (OD-13):
   * the same code format the platform mints online, so the gate cannot tell
   * the two apart. With no key the sale still closes and the answer says why
   * no band printed — a band reprint from History issues them online later.
   */
  function mintBands(
    plan: readonly OfflineBandPlan[],
    prefix: string,
    notes: string[],
  ): Array<OfflineBandFact & Pick<OfflineBandPlan, 'childName' | 'allergies' | 'medicalNotes' | 'dietary'>> {
    if (plan.length === 0) return [];
    const key = deps.bandKey();
    if (!key) {
      notes.push('Bands not issued — this box has no band key. Reprint them from History once it is online');
      return [];
    }
    return plan.map((band) => {
      const id = uuidv7();
      return {
        id,
        code: mintBandCode(prefix, ulidFromUuid(id), key),
        kind: band.kind,
        cartLineId: band.cartLineId,
        saleLineId: band.saleLineId,
        childId: band.childId,
        childName: band.childName,
        allergies: band.allergies,
        medicalNotes: band.medicalNotes,
        dietary: band.dietary,
      };
    });
  }

  async function readLog(saleId: string): Promise<RecordedSale | null> {
    if (!store.features().boothRuntime) return null;
    return parseJson<RecordedSale>(await store.readRuntimeValue(boxId, logKey(saleId)));
  }

  function jobRecord(
    id: string,
    stationId: string,
    kind: PrintKind,
    job: PrintJobRecord['job'],
    actionId: string | null,
    at: string,
  ): PrintJobRecord {
    return {
      id,
      boxId,
      kind,
      role: ROLE_FOR_KIND[kind] ?? null,
      stationId,
      deviceId: null,
      copies: 1,
      job,
      finish: null,
      templateId: null,
      templateVersion: null,
      actionId,
      state: 'queued',
      attempts: 0,
      nextAttemptAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      queuedAt: at,
      updatedAt: at,
    };
  }

  /** Put jobs on paper, in order, and say how each went. Never throws. */
  async function printJobs(
    records: readonly PrintJobRecord[],
    logJobs: SalePrintLogJob[],
    notes: string[],
  ): Promise<void> {
    const printing = deps.printing();
    for (const record of records) {
      const entry = logJobs.find((j) => j.id === record.id);
      if (!printing) {
        if (entry) {
          entry.status = 'skipped';
          entry.errorCode = 'PRINTING_DISABLED';
        }
        continue;
      }
      try {
        const outcome = await printing.submit({
          id: record.id,
          kind: record.kind as PrintKind,
          job: record.job,
          stationId: record.stationId,
          role: record.role,
          actionId: record.actionId,
          copies: record.copies,
        });
        if (entry) {
          entry.status = outcome.status;
          entry.errorCode = outcome.errorCode;
        }
      } catch (err) {
        deps.note('error', 'a sale’s printout could not be handed to the printer', {
          jobId: record.id,
          err: String(err),
        });
        if (entry) {
          entry.status = 'failed';
          entry.errorCode = 'PRINT_SUBMIT_FAILED';
        }
      }
    }
    for (const job of logJobs) {
      if (job.status === 'skipped' || job.status === 'failed') {
        const what = job.kind.replace(/_/g, ' ');
        notes.push(
          job.errorCode === 'NO_DEVICE_FOR_ROLE'
            ? `${what} not printed — no printer for it at this station`
            : `${what} not printed (${job.errorCode ?? 'unknown'}) — reprint it from History`,
        );
      }
    }
  }

  /**
   * Strip the paper from every log of an earlier trading day than `today`.
   *
   * What is kept is what the box still has to answer for: the number it
   * printed, the band ids and the sale's view for a till that asks again — so
   * a late platform print of that sale is still refused. What goes is the
   * snapshot (names, allergy lines) and the bands' signed codes. Best effort:
   * a log that cannot be retired now is retired by the next sale.
   */
  async function retireOlderLogs(saleId: string, today: string): Promise<void> {
    try {
      const index = parseJson<Array<{ saleId: string; businessDate: string }>>(
        await store.readRuntimeValue(boxId, LOG_INDEX_KEY),
      ) ?? [];
      const kept: typeof index = [{ saleId, businessDate: today }];
      for (const entry of index) {
        if (entry.saleId === saleId) continue;
        if (entry.businessDate >= today) {
          kept.push(entry);
          continue;
        }
        const old = await readLog(entry.saleId);
        if (old) {
          await saveLog({
            ...old,
            snapshot: null,
            bands: old.bands.map((band) => ({ ...band, code: '' })),
          });
        }
      }
      await store.writeRuntimeValue(boxId, LOG_INDEX_KEY, JSON.stringify(kept));
    } catch (err) {
      deps.note('warn', 'older sale logs could not be retired', { err: String(err) });
    }
  }

  async function saveLog(record: RecordedSale): Promise<void> {
    try {
      await store.writeRuntimeValue(boxId, logKey(record.saleId), JSON.stringify(record));
    } catch (err) {
      deps.note('warn', 'a sale’s print log could not be updated', {
        saleId: record.saleId,
        err: String(err),
      });
    }
  }

  async function openDrawerFor(stationId: string, actionId: string | null): Promise<'opened' | 'failed'> {
    const printing = deps.printing();
    if (!printing) return 'failed';
    try {
      const outcome = await printing.pulseDrawer({ stationId, actionId });
      if (!outcome.opened) {
        deps.note('warn', 'the cash drawer did not open for an offline sale', {
          stationId,
          errorCode: outcome.errorCode,
        });
      }
      return outcome.opened ? 'opened' : 'failed';
    } catch (err) {
      deps.note('error', 'the cash drawer could not be opened', { stationId, err: String(err) });
      return 'failed';
    }
  }

  return {
    async record(request) {
      /**
       * S2-10b — A VOUCHER NEVER RIDES AN OFFLINE SALE. Refused first: before
       * a receipt number is minted, so the refused sale spends no number in
       * the station's series, and before anything is queued or the drawer
       * opens. The code itself is not logged.
       */
      if (voucherOnOfflineCart(request.cart)) {
        deps.note('warn', 'an offline sale carrying a voucher was refused', {
          stationId: request.stationId,
        });
        throw new OfflineSaleRefused(OFFLINE_VOUCHER_REFUSAL, 'VOUCHER_NEEDS_INTERNET');
      }
      const saleId = request.saleId ?? uuidv7();

      // The same sale again is the till retrying through a lost answer: it is
      // told what it was told, and nothing is written, opened or printed twice.
      const prior = await readLog(saleId);
      if (prior) {
        return {
          saleId,
          receipt: prior.receipt,
          boxSeq: prior.boxSeq,
          queued: 0,
          drawer: 'not_asked',
          outboxDepth: (await outbox.depth()).queued,
          replay: true,
          bands: prior.bands,
          printing: { jobs: prior.jobs, notes: prior.notes },
          memo: prior.memo,
        };
      }

      const seal = deps.sealer();
      if (!seal) throw new Error('This box has no signing key yet; it cannot record a sale');
      const at = request.occurredAt ?? deps.now().toISOString();
      const notes: string[] = [];
      const printout = request.printout ?? null;
      let records: PrintJobRecord[] = [];
      let logged: RecordedSale | null = null;

      /**
       * ONE TRANSACTION: the number, the bands, the paper, the fact and the
       * log commit together or not at all. The printer is NOT touched in here:
       * a socket held open inside a transaction holds it for as long as a roll
       * of paper takes, and a print that fails must not undo a sale that
       * happened.
       */
      await store.atomically(async (tx) => {
        const receipt = await mintReceipt(tx, request.stationId, at);
        await crash('after_receipt');

        const bands = mintBands(printout?.bands ?? [], receipt.series, notes);
        await crash('after_bands');

        const snapshot: SalePrintSnapshot | null = printout
          ? {
              ...printout.snapshot,
              saleId,
              receiptNumber: receipt.number,
              at,
              bands: bands.map((b) => ({
                id: b.id,
                kind: b.kind,
                code: b.code,
                saleLineId: b.saleLineId,
                childName: b.childName,
                allergies: b.allergies,
                medicalNotes: b.medicalNotes,
                dietary: b.dietary,
              })),
            }
          : null;
        const logJobs: SalePrintLogJob[] = [];
        records = [];
        if (snapshot) {
          for (const printRequest of salePrintRequests(snapshot)) {
            const document = salePrintDocumentOf(snapshot, printRequest);
            if (!document) continue;
            const id = uuidv7();
            records.push(
              jobRecord(
                id,
                request.stationId,
                printRequest.kind,
                document as PrintJobRecord['job'],
                request.actionId ?? null,
                at,
              ),
            );
            logJobs.push({
              id,
              kind: printRequest.kind,
              subjectType: printRequest.subjectType,
              subjectId: printRequest.subjectId,
              status: 'queued',
              errorCode: null,
              copy: false,
            });
          }
        }
        // The jobs are written down BEFORE anything is attempted, in the
        // sale's own transaction, and each names its sale so the box knows it
        // for its own when the printer answers.
        if (tx.features().printJobs && deps.durablePrinting?.()) {
          for (const record of records) await tx.putPrintJob(record);
        }
        for (const record of records) {
          await tx.writeRuntimeValue(boxId, jobKey(record.id), saleId, at);
        }
        await crash('after_print_jobs');

        const [queued] = await tx.enqueueMany(
          boxId,
          [
            saleFinalisedFact({
              ...request,
              saleId,
              receipt,
              occurredAt: at,
              bands: bands.map(({ id, code, kind, cartLineId, saleLineId, childId }) => ({
                id,
                code,
                kind,
                cartLineId,
                saleLineId,
                childId,
              })),
            }),
          ],
          seal,
          at,
        );
        await crash('after_fact');

        logged = {
          saleId,
          stationId: request.stationId,
          businessDate: printout?.businessDate ?? null,
          at,
          receipt,
          bands: bands.map(({ id, code, kind, cartLineId, saleLineId, childId, childName }) => ({
            id,
            code,
            kind,
            cartLineId,
            saleLineId,
            childId,
            childName,
          })),
          boxSeq: queued?.envelope.boxSeq ?? 0,
          snapshot,
          jobs: logJobs,
          drawer: 'not_asked',
          notes,
          memo: request.memo ?? null,
        };
        await tx.writeRuntimeValue(boxId, logKey(saleId), JSON.stringify(logged), at);
        await crash('after_log');
      });
      const sale = logged as RecordedSale | null;
      if (!sale) throw new Error('the sale was not written');

      /**
       * THE ORDER IS THE POINT: on disk, then the drawer, then the paper. A
       * drawer that opened for a sale the box then failed to record is money
       * in a till with no row behind it — the one outcome this path exists to
       * prevent. The other way round, the worst case is a recorded sale whose
       * drawer has to be opened by hand.
       */
      const drawer =
        (request.openDrawer ?? tookCash(request.tenders))
          ? await openDrawerFor(request.stationId, request.actionId ?? null)
          : ('not_asked' as const);
      await printJobs(records, sale.jobs, notes);
      sale.drawer = drawer;
      sale.notes = notes;
      await saveLog(sale);
      if (sale.businessDate) await retireOlderLogs(saleId, sale.businessDate);

      const depth = await outbox.depth();
      deps.note('info', 'an offline sale is on the queue', {
        saleId,
        stationId: request.stationId,
        boxSeq: sale.boxSeq,
        receiptNumber: sale.receipt.number,
        tenders: request.tenders.length,
        bands: sale.bands.length,
        jobs: sale.jobs.length,
        drawer,
      });
      return {
        saleId,
        receipt: sale.receipt,
        boxSeq: sale.boxSeq,
        queued: 1,
        drawer,
        outboxDepth: depth.queued,
        replay: false,
        bands: sale.bands,
        printing: { jobs: sale.jobs, notes },
        memo: sale.memo,
      };
    },

    async recordTender(request) {
      const records = await outbox.queueAll([paymentRecordedFact(request)]);
      const drawer =
        (request.openDrawer ?? tookCash([request.tender]))
          ? await openDrawerFor(request.stationId, request.actionId ?? null)
          : ('not_asked' as const);
      const depth = await outbox.depth();
      return {
        saleId: request.saleId,
        receipt: null,
        boxSeq: records[0]?.envelope.boxSeq ?? 0,
        queued: records.length,
        drawer,
        outboxDepth: depth.queued,
        replay: false,
        bands: [],
        printing: { jobs: [], notes: [] },
        memo: null,
      };
    },

    async receiptMark(stationId) {
      return (await receiptMarks()).find((m) => m.stationId === stationId) ?? null;
    },

    async observeReceipt(stationId, receiptNumber) {
      const parsed = parseReceiptNumber(receiptNumber);
      if (!parsed) return null;
      const mark = (await receiptMarks()).find((m) => m.stationId === stationId);
      // A number from another series is not this station's, whatever the till says.
      if (mark?.prefix && mark.prefix !== parsed.prefix) return null;
      return store.atomically(async (tx) => {
        const held = parseJson<{ prefix: string; seq: number }>(
          await tx.readRuntimeValue(boxId, observedKey(stationId)),
        );
        const next =
          held && held.prefix === parsed.prefix && held.seq >= parsed.seq ? held : parsed;
        if (next !== held) {
          await tx.writeRuntimeValue(boxId, observedKey(stationId), JSON.stringify(next));
        }
        return next;
      });
    },

    recorded: readLog,

    async reprint(saleId, kind, opts) {
      const sale = await readLog(saleId);
      if (!sale) {
        throw new ReprintRefused(
          'NOT_ON_THIS_BOX',
          'This box did not take that sale, so it has nothing to reprint — reprint it from History when the connection is back',
        );
      }
      if (!sale.snapshot || (sale.businessDate && sale.businessDate !== opts.today)) {
        throw new ReprintRefused(
          'NOT_TODAY',
          'Only today’s sales can be reprinted at this counter while it is offline — reprint older ones from History when the connection is back',
        );
      }
      const snapshot = sale.snapshot;
      const wanted = salePrintRequests(snapshot).filter((r) =>
        kind === 'receipt' || kind === 'merch_receipt'
          ? r.kind === 'receipt'
          : kind === 'prep'
            ? r.kind === 'kitchen_ticket' || r.kind === 'bar_ticket'
            : kind === 'kids_bands'
              ? r.kind === 'kids_wristband'
              : r.kind === 'adult_wristband',
      );
      if (wanted.length === 0) {
        throw new ReprintRefused('NOTHING_TO_REPRINT', `This sale has no ${kind.replace('_', ' ')} to reprint`);
      }
      const at = deps.now().toISOString();
      const records: PrintJobRecord[] = [];
      const jobs: SalePrintLogJob[] = [];
      for (const printRequest of wanted) {
        const document = salePrintDocumentOf(snapshot, printRequest, true);
        if (!document) continue;
        const id = uuidv7();
        records.push(
          jobRecord(id, sale.stationId, printRequest.kind, document as PrintJobRecord['job'], opts.actionId ?? null, at),
        );
        jobs.push({
          id,
          kind: printRequest.kind,
          subjectType: printRequest.subjectType,
          subjectId: printRequest.subjectId,
          status: 'queued',
          errorCode: null,
          copy: true,
        });
      }
      await store.atomically(async (tx) => {
        if (tx.features().printJobs && deps.durablePrinting?.()) {
          for (const record of records) await tx.putPrintJob(record);
        }
        for (const record of records) await tx.writeRuntimeValue(boxId, jobKey(record.id), saleId, at);
      });
      const notes: string[] = [];
      await printJobs(records, jobs, notes);
      await saveLog({ ...sale, jobs: [...sale.jobs, ...jobs] });
      return { jobs, notes };
    },

    async notePrintOutcome(outcome) {
      if (!store.features().boothRuntime) return false;
      const saleId = await store.readRuntimeValue(boxId, jobKey(outcome.id)).catch(() => null);
      if (!saleId) return false;
      const sale = await readLog(saleId);
      if (sale) {
        const job = sale.jobs.find((j) => j.id === outcome.id);
        if (job && outcome.status !== 'queued') {
          job.status = outcome.status;
          job.errorCode = outcome.errorCode;
          await saveLog(sale);
        }
      }
      return true;
    },
  };
}
