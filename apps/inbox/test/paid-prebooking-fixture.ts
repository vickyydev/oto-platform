import type { Prebooking } from '@/api/inbox';

/** Calendar/AI-choice regression tests begin after the separately tested payment gate. */
export function paidPrebookingFixture(branchId: string): NonNullable<Prebooking['draft']> {
  const id = '00000000-0000-7000-8000-000000000987';
  return {
    id,
    booking: {
      id,
      branchId,
      date: '2099-11-21',
      startTime: '14:00',
      kids: null,
      adults: null,
      contactName: 'ZZ TEST parent',
      phone: null,
      childName: null,
      childAge: null,
    },
    amountSatang: 300_000,
    currency: 'THB',
    simulator: true,
    state: 'paid',
    paymentLink: null,
    linkExpiresAt: null,
    paidAt: '2026-11-16T12:00:00.000Z',
  };
}
