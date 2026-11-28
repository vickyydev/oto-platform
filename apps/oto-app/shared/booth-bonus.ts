import { z } from 'zod';
import type { ClausePart } from './payroll-clause-reading';

export const windows = ['same-day', '24-hours', '7-days', '30-days', 'any-time'] as const;
export type BonusWindow = (typeof windows)[number];
export const windowLabel: Record<BonusWindow, string> = {
  'same-day': 'the same day',
  '24-hours': '24 hours',
  '7-days': '7 days',
  '30-days': '30 days',
  'any-time': 'any time',
};
export const flyerRuling =
  'Paid in full to each person named on the voucher (owner, 28 November 2026); the contract wording says divided by the team.';
export function isBoothFlyer(part: ClausePart): boolean {
  return (
    part.type === 'bonus' &&
    part.bonus?.basis === 'baht-per-unit' &&
    /\b(?:flyers?|leaflets?)\b/i.test(part.quote) &&
    /return|redeem/i.test(part.quote)
  );
}
export const boothPageSchema = z.object({
  next: z.string().uuid().nullable(),
  records: z.array(
    z.object({
      voucherId: z.string().uuid(),
      stationId: z.string().uuid(),
      booth: z.string(),
      timezone: z.string(),
      issuedAt: z.string().datetime(),
      issuedDay: z.string().date(),
      issuedMonth: z.string(),
      usedAt: z.string().datetime().nullable(),
      usedDay: z.string().date().nullable(),
      saleId: z.string().uuid().nullable(),
      saleState: z.string().nullable(),
      spendSatang: z.number().int().nonnegative(),
      reversedAt: z.string().datetime().nullable(),
      sharedCode: z.boolean(),
      accountIds: z.array(z.string().uuid()),
      employeeIds: z.array(z.string()).nullable(),
      staffLabel: z.string().nullable(),
    }),
  ),
});
export type BoothRecord = z.infer<typeof boothPageSchema>['records'][number];
export interface BoothBonusLine {
  voucherId: string;
  employeeId: string;
  saleId: string;
  issuedAt: string;
  usedAt: string;
  usedDay: string;
  rateSatang: number;
  window: BonusWindow;
  stationId: string;
  branchId: string;
  noClockIn: boolean;
}
export interface BoothReportRow {
  id: string;
  label: string;
  issued: number;
  inside: number;
  outside: number;
  redeemed: number;
  spendSatang: number;
  sales: number;
}
export interface BoothReport {
  month: string;
  active: boolean;
  awards: BoothBonusLine[];
  people: BoothReportRow[];
  booths: BoothReportRow[];
  flags: { voucherId: string; booth: string; reason: string }[];
}
export interface BoothSettings {
  canManage: boolean;
  today: string;
  people: { id: string; name: string }[];
  rules: { from: string; rateSatang: number; window: BonusWindow }[];
  rates: {
    employeeId: string;
    name: string;
    rateSatang: number;
    from: string;
    until: string | null;
  }[];
}
export function withinWindow(
  fact: Pick<BoothRecord, 'issuedAt' | 'issuedDay' | 'usedAt' | 'usedDay'>,
  window: BonusWindow,
) {
  if (!fact.usedAt || !fact.usedDay) return false;
  const elapsed = Date.parse(fact.usedAt) - Date.parse(fact.issuedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return false;
  if (window === '24-hours') return elapsed <= 86400000;
  if (window === 'same-day') return fact.usedDay === fact.issuedDay;
  if (window === 'any-time') return true;
  const parkDays =
    (Date.parse(fact.usedDay + 'T00:00:00Z') - Date.parse(fact.issuedDay + 'T00:00:00Z')) /
    86400000;
  return parkDays >= 0 && parkDays < (window === '7-days' ? 7 : 30);
}
