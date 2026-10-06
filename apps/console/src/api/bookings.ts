import { api, qs } from './client';

/**
 * The Console's bookings list (S2-12, SCRUM-209 round 1) — `GET /bookings/ledger`.
 *
 * Every booking at one branch whatever its state, with the payment behind it:
 * the `WEB` invoice the booking site's checkout minted, what the gateway made
 * of it, and the day the money was taken (OD-A10). The counter's waiting list
 * answers "who is arriving"; this answers "what happened to the money".
 */

export const BOOKING_STATUSES = ['pending', 'paid', 'redeemed', 'expired', 'cancelled'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export interface BookingLedgerRow {
  id: string;
  reference: string;
  branchId: string;
  bookingDate: string;
  createdAt: string;
  status: string;
  totalSatang: number;
  tier: string;
  rateMode: string | null;
  parentName: string | null;
  phone: string | null;
  channel: string;
  kidsCount: number;
  adultsCount: number;
  paidAt: string | null;
  expiresAt: string | null;
  qrIssued: boolean;
  /** Written as paid by the booking site before checkout was real — no payment behind it. */
  legacy: boolean;
  payment: {
    attemptId: string;
    invoiceNo: string | null;
    status: string;
    method: string;
    provider: string;
    businessDate: string;
    paidAt: string | null;
  } | null;
  redemption: {
    at: string;
    branchName: string | null;
    stationName: string | null;
    staffName: string | null;
  } | null;
}

export interface BookingLedger {
  total: number;
  rows: BookingLedgerRow[];
}

export interface BookingLedgerFilters {
  status?: BookingStatus;
  from?: string;
  to?: string;
}

export const BOOKING_PAGE = 50;

export const bookingLedgerApi = {
  list: (branchId: string, filters: BookingLedgerFilters, offset = 0) =>
    api.get<BookingLedger>('/bookings/ledger' + qs({ branchId, ...filters, limit: BOOKING_PAGE, offset })),
};
