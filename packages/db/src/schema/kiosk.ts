import { sql } from 'drizzle-orm';
import { check, index, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { idPk, pos, timestamps } from './helpers';
import { branch, operator } from './tenancy';
import { box, deviceCredential, station } from './fleet';
import { booking } from './future';
import { sale } from './sales';

// --- The self-service kiosk (schema `pos`) -----------------------------------
//
// S2-20 K1 (SCRUM-217). A family scans their booking QR at a kiosk; their
// bands print and their credit is loaded, or they are sent to the staff desk.
// The redemption itself is the till's (`services/booking-redemption.ts`) —
// one implementation, two surfaces — so the only thing this file adds is the
// record of what happened at the kiosk: one row per session, read by the
// kiosk's own screen (the surface round) and by the Console's Kiosk tile.

/** How a session ended; null while it runs. `@oto/shared` `KIOSK_SESSION_OUTCOMES` says what each means. */
export const KIOSK_SESSION_OUTCOMES = ['issued', 'handed_off', 'failed', 'abandoned'] as const;
export type KioskSessionOutcome = (typeof KIOSK_SESSION_OUTCOMES)[number];

/**
 * One kiosk session: a guest at the screen, from the scan to the outcome.
 *
 * WHAT IT HOLDS AND WHAT IT DOES NOT. The station, the credential and the box
 * it ran on; the booking and the sale it redeemed with, when it did; the bands
 * that came out of the printer, by id; and the outcome with its reason. No
 * child, no name, no allergy, no phone: the session is about the machine and
 * the booking, and the booking holds the family.
 *
 * NOTHING HALF-REDEEMED, IN THE DATABASE'S OWN WORDS. A redemption at the
 * kiosk is issued, printed and only then committed; a printer fault aborts the
 * whole of it and writes this row `failed`. So a `failed` or `abandoned` row
 * never names a sale (`kiosk_session_no_sale_check`), and an `issued` one
 * always does — a session that says the family was banded and points at
 * nothing is the false hand-off the ticket exists to stop.
 */
export const kioskSession = pos.table(
  'kiosk_session',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    /** The kiosk station (`station.kind = 'kiosk'`) the credential is paired to. */
    stationId: uuid('station_id')
      .notNull()
      .references(() => station.id, { onDelete: 'restrict' }),
    /** The paired credential that spoke: the kiosk's actor, as a sale's account is a till's. */
    deviceCredentialId: uuid('device_credential_id')
      .notNull()
      .references(() => deviceCredential.id, { onDelete: 'restrict' }),
    /** The box the kiosk ran on at the time, whose printer the bands came out of. */
    boxId: uuid('box_id').references(() => box.id, { onDelete: 'restrict' }),
    /**
     * The press: minted on the kiosk, the redemption's identity. The same press
     * sent twice is answered from this row and issues nothing again
     * (`kiosk_session_action_unique`). Null for a session opened before any
     * press — the attract screen's, which the surface round adds.
     */
    actionId: text('action_id'),
    bookingId: uuid('booking_id').references(() => booking.id, { onDelete: 'restrict' }),
    /** The redemption's sale. Only ever set on a session that issued something. */
    saleId: uuid('sale_id').references(() => sale.id, { onDelete: 'restrict' }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    outcome: text('outcome').$type<KioskSessionOutcome>(),
    /** A code (`KIOSK_REASONS`, a refusal's code, a printer's error code), never a sentence. */
    reason: text('reason'),
    /** The bands that came out of the kiosk's printer, by id. Never their codes. */
    bandIds: jsonb('band_ids').$type<string[]>().notNull().default([]),
    /**
     * What else the Console's tile and an investigation read: how many
     * supervised children were sent to the desk, how many jobs printed before a
     * fault and on which device. Counts and ids only.
     */
    detail: jsonb('detail'),
    ...timestamps,
  },
  (t) => [
    index('kiosk_session_operator_idx').on(t.operatorId),
    /** The Console's question: this park's kiosk sessions, newest first. */
    index('kiosk_session_branch_idx').on(t.branchId, t.startedAt),
    index('kiosk_session_station_idx').on(t.stationId, t.startedAt),
    index('kiosk_session_credential_idx').on(t.deviceCredentialId),
    index('kiosk_session_box_idx').on(t.boxId),
    index('kiosk_session_booking_idx').on(t.bookingId),
    index('kiosk_session_sale_idx').on(t.saleId),
    /** One press, one session: a replay finds the row the first one wrote. */
    uniqueIndex('kiosk_session_action_unique')
      .on(t.stationId, t.actionId)
      .where(sql`action_id is not null`),
    check(
      'kiosk_session_outcome_check',
      sql`${t.outcome} is null or ${t.outcome} in ('issued','handed_off','failed','abandoned')`,
    ),
    /** An outcome is an ending: the two arrive together or not at all. */
    check('kiosk_session_ended_check', sql`(${t.outcome} is null) = (${t.endedAt} is null)`),
    /** A session that did not issue says why. */
    check(
      'kiosk_session_reason_check',
      sql`${t.outcome} is null or ${t.outcome} not in ('failed','abandoned') or ${t.reason} is not null`,
    ),
    /** Issued means a sale stands behind it. */
    check('kiosk_session_issued_check', sql`${t.outcome} is distinct from 'issued' or ${t.saleId} is not null`),
    /** Failed or abandoned means nothing was redeemed: no sale, no bands (H13). */
    check(
      'kiosk_session_no_sale_check',
      sql`${t.outcome} is null or ${t.outcome} not in ('failed','abandoned') or (${t.saleId} is null and ${t.bandIds} = '[]'::jsonb)`,
    ),
  ],
);
