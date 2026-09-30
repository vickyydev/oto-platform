import { z } from 'zod';
import { newId } from '@oto/shared';
import { errors } from '../lib/errors';

/**
 * A RECORD NAMED BEFORE IT IS SAVED — SCRUM-270, plan
 * `docs/progress/plans/offline/PLAN.md` §2.7 and OD-12.
 *
 * `ARCHITECTURE.md` §9 has said since Sprint 1 that ids are minted by the
 * client, "so a till knows the id of the thing it is about to create before it
 * has a connection". Until this ticket only members, visits, sales and public
 * bookings honoured it; every other create picked its id on the platform, so a
 * caller could not name a record until the platform answered, and a create
 * sent twice through a dropped connection could only be recognised by the
 * one-day header cache.
 *
 * OD-12 settles where each id is minted. The till mints the sale, every line
 * and item, the action per press, and each member, child and visit. The box
 * mints receipt numbers, bands, print jobs and its own events. The platform
 * keeps the rows nothing outside it refers to, and the records an
 * administrator creates — whose routes take an OPTIONAL id in the body, so a
 * screen that has one can name the record and one that has none is unchanged.
 *
 * THE RULE, the same on every route that uses this:
 *
 *   - no id sent: the platform mints one, exactly as before;
 *   - an id nothing holds: the record is created under it;
 *   - an id naming THIS record — same operator, same parent — the create is a
 *     replay: nothing is written and the route answers with the record as it
 *     stands, under `x-oto-replay: true` (the convention `POST /members`
 *     started, `routes/members.ts`);
 *   - an id naming ANY OTHER record — another branch's, another member's,
 *     another operator's — is refused `409 ID_IN_USE` before anything is
 *     written. The caller learns nothing about that record but that the id is
 *     taken, and a freshly minted UUIDv7 never meets one.
 *
 * A replay is judged on the id, not on the body. A second arrival carrying the
 * same id and a different name is still answered with the first record: the
 * Idempotency-Key (`plugins/idempotency.ts`) is what refuses a different body
 * under one key, and an id is a name, not a request. A sale is the exception,
 * because its lines are ids of their own (`commitSale`, `SALE_LINES_DIFFER`).
 *
 * TWO CREATES RACING UNDER ONE NEW ID both find it free; the second insert then
 * meets the primary key and is answered 409 by the unique-violation mapper
 * (`lib/scrub.ts`), and its own retry is the replay. Nothing is written twice.
 */

/** The optional body id a create route declares. Any uuid; the platform mints UUIDv7. */
export const ClientIdSchema = z.string().uuid();

export type ClientIdClaim<Row> =
  | { replay: false; id: string }
  | { replay: true; id: string; row: Row };

/** The one refusal for an id that already names another record. */
export function idInUse(id: string) {
  return errors.conflict(
    'ID_IN_USE',
    'That id already names another record, so nothing was saved — send the create again with a new id',
    { id },
  );
}

/**
 * Decide what a create's body id means, before anything is written.
 *
 * `find` reads the row the id names wherever it is (not only inside the
 * caller's operator — that is what makes a foreign id a refusal rather than a
 * primary-key failure mid-transaction), and `isThisRecord` says whether that
 * row is the one this request would have created: the caller's operator and
 * the same parent the route is creating under.
 */
export async function claimClientId<Row>(
  sent: string | null | undefined,
  find: (id: string) => Promise<Row | undefined>,
  isThisRecord: (row: Row) => boolean,
): Promise<ClientIdClaim<Row>> {
  if (!sent) return { replay: false, id: newId() };
  const row = await find(sent);
  if (row === undefined) return { replay: false, id: sent };
  if (!isThisRecord(row)) throw idInUse(sent);
  return { replay: true, id: sent, row };
}

/**
 * A replayed answer, marked for the route that sends it.
 *
 * The services under `services/fleet.ts` return the route's whole body (the
 * contract `withTx` stores), so whether it was a replay has to travel with the
 * body. A symbol key does that without reaching the wire: the response schema
 * and `JSON.stringify` both ignore it, so neither the answer nor the replay
 * store ever carries it.
 */
const REPLAYED = Symbol('oto.replayed');

export function markReplay<T extends object>(body: T): T {
  Object.defineProperty(body, REPLAYED, { value: true, enumerable: false });
  return body;
}

export function wasReplay(body: unknown): boolean {
  return typeof body === 'object' && body !== null && REPLAYED in body;
}

/** The header every replay answers under — the platform's one word for it. */
export const REPLAY_HEADER = 'x-oto-replay';
