import type { RefundMode } from '@oto/shared';

/**
 * A REFUND ASKED FOR WHILE THE STATION WAS OFFLINE — S2-11 (SCRUM-208).
 *
 * Refunds and voids are online only (the plan's rule, S2-11): a refund moves
 * money back through a terminal, a gateway or the drawer, is numbered from the
 * station's refund series and needs a manager's approval, and none of that can
 * be decided by a till that cannot reach the platform. What the till CAN do
 * offline is write down that a guest asked, so the request is not lost with
 * the conversation at the counter: which sale, how much, why, and who took it.
 *
 * It is a note, not a refund. Nothing is owed to anybody because of it, no
 * money moves, and the sale stays as it was. It is kept on THIS till — there
 * is nowhere else to keep it while the platform cannot be reached — and it is
 * shown on the sale's detail and on the History list until a refund is
 * recorded for that sale here, or somebody clears it.
 *
 * WHAT IS STORED: the sale's id and receipt number, the amount and mode, the
 * reason and note, the staff member's name and the time. No guest name and no
 * phone number. Browser storage can be missing or refuse (a private window,
 * cleared site data), so every read and write is guarded, and a till that
 * cannot store the note says so rather than pretending it did.
 */
export interface RefundRequestNote {
  id: string;
  saleId: string;
  receiptNumber: string | null;
  mode: RefundMode;
  amountSatang: number;
  reason: string;
  note: string | null;
  requestedBy: string;
  requestedAt: string;
}

/** Where the notes live. Versioned, so a later shape can leave these alone. */
export const REFUND_REQUESTS_KEY = 'oto.pos.refund-requests.v1';

/** The storage these functions use — `localStorage`, or a stand-in in a test. */
export type NoteStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): NoteStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isNote(value: unknown): value is RefundRequestNote {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.saleId === 'string' &&
    typeof v.amountSatang === 'number' &&
    typeof v.reason === 'string' &&
    typeof v.requestedBy === 'string' &&
    typeof v.requestedAt === 'string'
  );
}

/** Every note on this till, oldest first. Empty when storage is missing or unreadable. */
export function readRefundRequests(storage: NoteStorage | null = defaultStorage()): RefundRequestNote[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(REFUND_REQUESTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isNote) : [];
  } catch {
    return [];
  }
}

function write(notes: readonly RefundRequestNote[], storage: NoteStorage | null): boolean {
  if (!storage) return false;
  try {
    storage.setItem(REFUND_REQUESTS_KEY, JSON.stringify(notes));
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep a request. False when this till could not store it, which the dialog
 * says in so many words — a request that only looked kept is worse than one
 * that was never taken.
 */
export function queueRefundRequest(
  note: RefundRequestNote,
  storage: NoteStorage | null = defaultStorage(),
): boolean {
  const notes = readRefundRequests(storage).filter((n) => n.id !== note.id);
  return write([...notes, note], storage);
}

/** The notes for one sale, oldest first. */
export function refundRequestsFor(
  saleId: string,
  storage: NoteStorage | null = defaultStorage(),
): RefundRequestNote[] {
  return readRefundRequests(storage).filter((n) => n.saleId === saleId);
}

/** Let the notes for one sale go: a refund was recorded for it, or staff cleared them. */
export function clearRefundRequests(saleId: string, storage: NoteStorage | null = defaultStorage()): void {
  const notes = readRefundRequests(storage);
  const kept = notes.filter((n) => n.saleId !== saleId);
  if (kept.length !== notes.length) write(kept, storage);
}
