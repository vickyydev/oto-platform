import { readFileSync } from 'node:fs';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiCheckinToCheckIn, checkinApi, waitingStaysOf, type ApiCheckin, type ApiRegistration } from '@/api/checkin';
import { bridgeApi } from '@/api/bridge';
import { WaitingFamily, cancelBookingBlockedBy, type RegistrationGroup } from '@/components/till/AddDropOffModal';
import { setLaneStation } from '@/lib/lane';

/**
 * SCRUM-862 — A WAITING BOOKING CAN BE CANCELLED FROM THE ADD DROP-OFF PICKER.
 *
 * The picker listed signed registrations nobody paid for with no way to take
 * one off. Each waiting family now carries "Cancel booking": one confirm that
 * asks a reason, as the till's Void does (HeldSales), then the platform cancels
 * every waiting, unpaid child and the family leaves the list. A family every
 * child of which is paid for has no such button (that is the sale's refund or
 * void path); a family with a child already on this sale has it disabled until
 * the child is taken off. On the box lane the press is refused in the
 * counter's words rather than guessed. `fetch` is stubbed at the boundary, as
 * s740 does.
 */

// The card is compiled with the classic JSX runtime, as the unit runner has no React plugin.
Object.assign(globalThis, { React });

const STATION = '018f0000-0000-7000-8000-0000000058a2';
const BRANCH = '0190a0a0-0000-7000-8000-0000000000b1';
const REG = '0190a0a0-0000-7000-8000-00000000a862';
const SALE = '0190a0a0-0000-7000-8000-00000000b862';

const stay = (id: string, over: Partial<ApiCheckin> = {}): ApiCheckin => ({
  id,
  registrationId: REG,
  childId: null,
  childName: 'ZZ TEST Mint',
  childAgeYears: 6,
  dateOfBirth: null,
  allergies: null,
  foodRestrictions: null,
  mayOrderFood: false,
  foodProvision: null,
  service: 'drop_off',
  status: 'registered',
  scheduledFor: null,
  bookedMinutes: 120,
  nannyId: null,
  checkedInAt: null,
  saleId: null,
  bandId: null,
  visitId: null,
  photoFileId: null,
  ...over,
});

const registration = (children: ApiCheckin[]): ApiRegistration => ({
  id: REG,
  branchId: BRANCH,
  memberId: null,
  guardianName: 'ZZ TEST Ploy',
  guardianPhone: '+66812345678',
  contactChannel: 'whatsapp',
  consentRecordedAt: '2026-11-12T02:00:00.000Z',
  acknowledgedConfirmations: [],
  source: 'till',
  photoFileId: null,
  createdAt: '2026-11-12T02:00:00.000Z',
  children,
});

const group = (children: ApiCheckin[]): RegistrationGroup => ({
  registrationId: REG,
  parentName: 'ZZ TEST Ploy',
  phone: '+66812345678',
  children: children.map((c) => apiCheckinToCheckIn(c, registration(children))),
});

function card(g: RegistrationGroup, attached: string[] = [], onCancel?: (g: RegistrationGroup) => void): string {
  return renderToStaticMarkup(
    createElement(WaitingFamily, { group: g, attached: new Set(attached), onAddToSale: () => {}, onCancel }),
  );
}

/** The one `<button>` whose text is "Cancel booking", or null. */
function cancelButton(markup: string): string | null {
  const match = /<button(?:(?!<\/button>)[\s\S])*Cancel booking<\/button>/.exec(markup);
  return match ? match[0] : null;
}

/** The `disabled` attribute itself — every button's class list carries `disabled:` variants. */
function isDisabled(button: string | null): boolean {
  return /<button[^>]*\sdisabled=""[^>]*>/.test(button ?? '');
}

const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setLaneStation(null);
});

describe('s862 — the control on the family card', () => {
  it('offers Cancel booking on a waiting, unpaid family, beside Add to sale', () => {
    const markup = card(group([stay('c1'), stay('c2', { childName: 'ZZ TEST Bua' })]), [], () => {});
    const button = cancelButton(markup);
    expect(button).not.toBeNull();
    expect(isDisabled(button)).toBe(false);
    expect(markup).toContain('Add to sale');
    expect(markup).not.toContain('Take the children off this sale first.');
  });

  it('is disabled, with the reason, while a child of the family is on this sale', () => {
    const markup = card(group([stay('c1'), stay('c2', { childName: 'ZZ TEST Bua' })]), ['c1'], () => {});
    expect(isDisabled(cancelButton(markup))).toBe(true);
    expect(markup).toContain('Take the children off this sale first.');
  });

  it('is not offered for a family every child of which is paid for', () => {
    const online = group([stay('c1', { paidOnline: { bookingId: SALE, reference: 'OTO-AB12-3456' } })]);
    const atTill = group([stay('c1', { paidAtTill: { saleId: SALE, receiptNumber: 'T1-000042' } })]);
    expect(cancelButton(card(online, [], () => {}))).toBeNull();
    expect(cancelButton(card(atTill, [], () => {}))).toBeNull();
  });

  it('is not offered where the picker gives no cancel path', () => {
    expect(cancelButton(card(group([stay('c1')])))).toBeNull();
  });

  it('is disabled, naming the paid child, when a paid child has an unpaid sibling waiting', () => {
    // The platform refuses the whole press when any waiting child is paid
    // (CHECKIN_CANCEL_PAID), so the till never offers a press it will refuse.
    const mixed = group([stay('c1', { paidOnline: { bookingId: SALE, reference: 'OTO-AB12-3456' } }), stay('c2', { childName: 'ZZ TEST Nok' })]);
    const markup = card(mixed, [], () => {});
    const button = cancelButton(markup);
    expect(button).not.toBeNull();
    expect(isDisabled(button)).toBe(true);
    expect(markup).toContain('ZZ TEST Mint is paid for — a paid booking is handled through its sale.');
  });

  it('is disabled, naming the child, when a sibling on the booking is already checked in', () => {
    const g = { ...group([stay('c2', { childName: 'ZZ TEST Nok' })]), checkedIn: ['ZZ TEST Mint'] };
    const markup = card(g, [], () => {});
    expect(isDisabled(cancelButton(markup))).toBe(true);
    expect(markup).toContain('ZZ TEST Mint is already checked in — a checked-in booking is handled through its sale.');
  });
});

describe('s862 — why the cancel is blocked', () => {
  const mint = apiCheckinToCheckIn(stay('c1'), registration([stay('c1')]));
  const paid = apiCheckinToCheckIn(stay('c2', { paidAtTill: { saleId: SALE, receiptNumber: null } }), registration([]));

  it('names the sale for a paid family, the cart for an attached child, and nothing otherwise', () => {
    expect(cancelBookingBlockedBy({ children: [paid] }, new Set())).toBe('A paid booking is handled through its sale.');
    expect(cancelBookingBlockedBy({ children: [mint, paid] }, new Set(['c1']))).toBe('Take the children off this sale first.');
    // Any paid child blocks the press, as the platform's CHECKIN_CANCEL_PAID does.
    expect(cancelBookingBlockedBy({ children: [mint, paid] }, new Set(['c2']))).toBe(
      'ZZ TEST Mint is paid for — a paid booking is handled through its sale.',
    );
    expect(cancelBookingBlockedBy({ children: [mint] }, new Set())).toBeNull();
    expect(cancelBookingBlockedBy({ children: [] }, new Set())).toBeNull();
  });
});

describe("s862 — the till's cancel call", () => {
  it('posts the reason to the platform with an idempotency key and answers the registration', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return reply(registration([stay('c1', { status: 'cancelled' })]));
      }),
    );
    const answer = await checkinApi.cancelRegistration(REG, 'Family did not come');
    expect(answer.children.map((c) => c.status)).toEqual(['cancelled']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`/api/checkin/registrations/${REG}/cancel`);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ reason: 'Family did not come' });
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['idempotency-key']).toMatch(/\S/);
  });

  it('is refused in the counter’s words on the box lane, and never reaches the box', async () => {
    setLaneStation(STATION);
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return reply({ error: { code: 'STATION_FORCED_OFFLINE', message: 'This station is forced offline for testing.' } }, 503);
      }),
    );
    await expect(checkinApi.cancelRegistration(REG, 'Family did not come')).rejects.toThrow(
      'Cancelling a waiting booking needs the internet — this counter is offline. Do it when the connection is back.',
    );
    expect(urls.some((u) => u.includes('/intents'))).toBe(false);
  });
});

describe('s862 — the confirm step, in the Void dialog’s style', () => {
  // SCRUM-886 — the confirm moved, unchanged, into the dialog the picker and
  // the Check-in board share; the pins follow it there.
  const source = readFileSync(new URL('../src/components/dropoff/CancelBookingDialog.tsx', import.meta.url), 'utf8');
  const picker = readFileSync(new URL('../src/components/till/AddDropOffModal.tsx', import.meta.url), 'utf8');
  const dialog = source.slice(source.indexOf('Cancel this waiting booking'));

  it('asks one reason, refuses to confirm without one, and calls the platform once confirmed', () => {
    expect(dialog).toContain('A reason is required.');
    expect(dialog).toContain('maxLength={CANCEL_REASON_MAX_LENGTH}');
    expect(dialog).toContain("disabled={cancelReason.trim() === '' || cancelBusy}");
    expect(dialog).toContain("'Cancel the booking' : 'Give a reason to cancel'");
    expect(dialog).toContain('variant="destructive"');
    expect(source).toContain('await checkinApi.cancelRegistration(group.registrationId, reason);');
    // The list is re-read after a cancel, as after a sibling is added.
    const after = source.slice(source.indexOf('await checkinApi.cancelRegistration('));
    expect(after.slice(0, after.indexOf('} catch'))).toContain('onCancelled(group)');
    expect(picker).toContain('<CancelBookingDialog');
    expect(picker).toContain('onCancelled={() => setBump((b) => b + 1)}');
  });

  it('tells the family the signed form stays on record', () => {
    expect(dialog).toContain('The signed form stays on record.');
  });
});

describe("s862 — the board's Check in hand-over names its registration", () => {
  it('asks the platform for that registration, past the day rule, and loads its waiting child', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return reply({ registrations: [registration([stay('c1')])] });
      }),
    );
    const lines = await waitingStaysOf(BRANCH, REG);
    expect(lines.map((c) => c.id)).toEqual(['c1']);
    expect(urls).toEqual([`/api/checkin/registrations?branchId=${BRANCH}&registrationId=${REG}`]);
  });

  it('the picker itself still asks for the day list, unnamed', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return reply({ registrations: [] });
      }),
    );
    await checkinApi.awaiting(BRANCH);
    expect(urls).toEqual([`/api/checkin/registrations?branchId=${BRANCH}`]);
  });

  it('on the box lane, names the registration to the box as well', async () => {
    setLaneStation(STATION);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reply({ error: { code: 'STATION_FORCED_OFFLINE', message: 'This station is forced offline for testing.' } }, 503),
      ),
    );
    const intent = vi
      .spyOn(bridgeApi, 'intent')
      .mockResolvedValue({ result: { registrations: [registration([stay('c1')])] } } as never);
    const lines = await waitingStaysOf(BRANCH, REG);
    expect(lines.map((c) => c.id)).toEqual(['c1']);
    expect(intent).toHaveBeenCalledTimes(1);
    expect(intent.mock.calls[0]![1]).toBe('checkin.awaiting');
    expect(intent.mock.calls[0]![2]).toEqual({ registrationId: REG });
  });
});
