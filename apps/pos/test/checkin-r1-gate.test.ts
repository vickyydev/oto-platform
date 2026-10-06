import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreateRegistrationSchema,
  CreateWaiverSchema,
  DEFAULT_DROP_OFF_PRICING,
  dropOffFees,
  resolveDropOffPricing as resolveSharedPricing,
} from '@oto/shared';
import { api } from '@/api/client';
import { checkinApi, requirePlatformBranchId, TILL_NOT_LINKED } from '@/api/checkin';
import { makeDropOffLine, normalizeDropOffFees, resolveDropOffPricing } from '@/lib/dropoff';
import { priceForTier } from '@/lib/pricing';
import { getActiveBranch, getTicketTypes } from '@/store/catalogStore';
import { getDropOffPricing } from '@/mockApi';
import type { CheckIn } from '@/types';

/**
 * S2-13 ROUND 1, FOCUSED GATE — the reproductions, kept as regression pins.
 * Each `it` states the behaviour owed; the first build failed them, the fix
 * round passes them.
 *
 * R1 — THE GATE MUST REACH THE PLATFORM. `pages/Till.tsx` sent
 * `branchId: branch.id` to `POST /checkin/registrations` and
 * `POST /checkin/waivers`, and `checkinApi.config(branch.id)` for the roster;
 * `AddDropOffModal` sent `checkinApi.awaiting(branch.id)`. `branch` is
 * `useBranch().branch`, the catalogue branch, whose id is the SLUG
 * (`hkt-central`) — the same file maps it with `apiBranchIdForSlug(branch.id)`
 * everywhere else. Every one of these routes validates `branchId` as a UUID,
 * so every supervised walk-in was refused at Continue, the roster was always
 * empty and the waiting-bookings picker always errored. Now: the slug is
 * mapped by `requirePlatformBranchId` in one place, every call site sends the
 * platform's id, an unlinked till is refused in plain words before anything
 * is written, and the client itself refuses a branch id that is not a uuid.
 *
 * R2 — THE FEE LAW ON THE PATH THAT CHARGES. The shared law
 * (`packages/shared/src/supervision.ts`, `dropOffFees`) says an opted-in 'none'
 * child pays no service fee (R-86, "the safety flow without the fee"), and the
 * gate auto-enrols every unaccompanied 9+ child (`optIn: true`). The till
 * priced the cart with the prototype's `normalizeDropOffFees`, whose non-nanny
 * branch charged the flat fee to EVERY non-nanny line, 'none' included — and
 * the platform takes the till's `serviceFee` figure as given
 * (`services/sale.ts` snapshotPriced). Now `normalizeDropOffFees` takes every
 * figure from the shared `dropOffFees`, so the till and the api decide from
 * the same code and a 9-year-old left alone is charged nothing.
 */

/** The platform's row for the catalogue's `hkt-central`, as `loadCatalogFromApi` would hold it. */
const HKT_CENTRAL = '0190a0a0-0000-7000-8000-00000000b001';

vi.mock('@/api/catalogBridge', () => ({
  apiBranchIdForSlug: (slug: string) => (slug === 'hkt-central' ? HKT_CENTRAL : null),
}));
vi.mock('@/api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/client')>();
  return { ...original, api: { ...original.api, get: vi.fn() } };
});

const get = vi.mocked(api.get);

beforeEach(() => {
  get.mockReset();
});

describe('R1: the gate names the branch the platform knows', () => {
  it("the till's branch is a slug; the id sent is the platform's, and the schemas accept it", () => {
    const slug = getActiveBranch().id; // what useBranch().branch.id holds
    expect(slug).toBe('hkt-central');
    const branchId = requirePlatformBranchId(slug);
    expect(branchId).toBe(HKT_CENTRAL);
    const reg = CreateRegistrationSchema.safeParse({
      id: '0190a0a0-0000-7000-8000-000000000001',
      branchId,
      guardianName: 'Ploy',
      consentAcknowledged: true,
      acknowledgedConfirmationIds: ['confirm-15min', 'confirm-no-refund', 'confirm-evac'],
      children: [
        { checkinId: '0190a0a0-0000-7000-8000-000000000002', name: 'Mint', ageYears: 6, service: 'drop_off' },
      ],
    });
    expect(reg.success, `branchId sent = ${JSON.stringify(branchId)}`).toBe(true);
    const waiver = CreateWaiverSchema.safeParse({
      id: '0190a0a0-0000-7000-8000-000000000003',
      branchId,
      child: { name: 'Mint', ageYears: 6 },
      sibling: { name: 'Fah', ageYears: 9 },
      waivedRequirement: 'drop_off',
    });
    expect(waiver.success).toBe(true);
    // The slug itself is exactly what the routes refuse.
    expect(CreateRegistrationSchema.safeParse({ ...reg.data, branchId: slug }).success).toBe(false);
  });

  it('a till with no platform branch is refused in plain words, and nothing is sent', async () => {
    expect(() => requirePlatformBranchId('nowhere')).toThrow(TILL_NOT_LINKED);
    // The client refuses the slug too — the mistake cannot leave the till again.
    await expect(checkinApi.config(getActiveBranch().id)).rejects.toThrow(TILL_NOT_LINKED);
    await expect(checkinApi.awaiting('hkt-central')).rejects.toThrow(TILL_NOT_LINKED);
    expect(get).not.toHaveBeenCalled();
  });

  it("the platform's id goes out on the wire for the roster and the waiting bookings", async () => {
    get.mockResolvedValueOnce({ nannies: [] }).mockResolvedValueOnce({ registrations: [] });
    await checkinApi.config(requirePlatformBranchId(getActiveBranch().id));
    await checkinApi.awaiting(requirePlatformBranchId(getActiveBranch().id));
    expect(get).toHaveBeenNthCalledWith(1, `/checkin/config?branchId=${HKT_CENTRAL}`);
    expect(get).toHaveBeenNthCalledWith(2, `/checkin/registrations?branchId=${HKT_CENTRAL}`);
  });
});

describe('R2: an opted-in no-requirement child pays no service fee on the charged path', () => {
  const pricing = resolveDropOffPricing(getDropOffPricing(), 'weekday');
  const shared = resolveSharedPricing(DEFAULT_DROP_OFF_PRICING, 'weekday');
  const stay = (id: string, age: number, service: CheckIn['serviceType']): CheckIn =>
    ({
      id,
      registrationId: 'reg-1',
      childName: `Child ${id}`,
      childAge: age,
      mayOrderFood: false,
      serviceType: service,
      status: 'registered',
    }) as unknown as CheckIn;

  it('normalizeDropOffFees charges the same as the shared law: 0 for service none', () => {
    const ticket = getTicketTypes()[0]!;
    const [line] = normalizeDropOffFees(
      [makeDropOffLine({ ci: stay('stay-1', 9, 'none'), ticket, tier: 'tourist', service: 'none', lengthChosen: true, pricing })],
      pricing,
    );
    const law = dropOffFees([{ id: 'stay-1', service: 'none', hours: ticket.hours, lengthChosen: true }], shared).get('stay-1');
    expect(law).toBe(0);
    expect(line!.dropOff!.serviceFeeTHB * 100).toBe(law);
    // The line still carries the play ticket: the flow without the fee, not a free visit.
    expect(line!.lineTotal).toBe(priceForTier(ticket, 'tourist'));
  });

  it('the rest of the law is unchanged: flat fee per drop-off child, one nanny charged once on her longest child, first wins a tie', () => {
    const tickets = getTicketTypes();
    const short = tickets[0]!;
    const long = tickets.find((t) => t.hours > short.hours) ?? short;
    const nanny = { nannyId: 'n-pim', nannyName: 'Pim' };
    const lines = normalizeDropOffFees(
      [
        makeDropOffLine({ ci: stay('a', 6, 'drop_off'), ticket: short, tier: 'tourist', service: 'drop_off', lengthChosen: true, pricing }),
        makeDropOffLine({ ci: stay('b', 3, 'nanny'), ticket: short, tier: 'tourist', service: 'nanny', lengthChosen: true, pricing, ...nanny }),
        makeDropOffLine({ ci: stay('c', 2, 'nanny'), ticket: long, tier: 'tourist', service: 'nanny', lengthChosen: true, pricing, ...nanny }),
        makeDropOffLine({ ci: stay('d', 4, 'nanny'), ticket: long, tier: 'tourist', service: 'nanny', lengthChosen: true, pricing, ...nanny }),
        makeDropOffLine({ ci: stay('e', 1, 'nanny'), ticket: short, tier: 'tourist', service: 'nanny', lengthChosen: true, pricing }),
        makeDropOffLine({ ci: stay('f', 7, 'drop_off'), ticket: long, tier: 'tourist', service: 'drop_off', lengthChosen: false, pricing }),
      ],
      pricing,
    );
    const fee = (id: string) => lines.find((l) => l.id === `line-${id}`)!.dropOff!.serviceFeeTHB;
    const law = dropOffFees(
      lines.map((l) => ({
        id: l.id,
        service: l.dropOff!.service,
        hours: l.ticketType.hours,
        lengthChosen: l.dropOff!.lengthChosen,
        nannyId: l.dropOff!.nannyId ?? null,
      })),
      shared,
    );
    for (const l of lines) expect(l.dropOff!.serviceFeeTHB * 100, l.id).toBe(law.get(l.id));
    expect(fee('a')).toBe(pricing.oneTimeFeeTHB); // flat, per drop-off child
    expect(fee('b')).toBe(0); // Pim's shorter child
    expect(fee('c')).toBe(pricing.nannyHourlyRateTHB * long.hours); // Pim, once, on her longest — first wins the tie
    expect(fee('d')).toBe(0);
    expect(fee('e')).toBe(pricing.nannyHourlyRateTHB * short.hours); // no nanny yet: a provisional fee of its own
    expect(fee('f')).toBe(0); // length not chosen: unpriced
    expect(lines.find((l) => l.id === 'line-f')!.lineTotal).toBe(0);
  });
});
