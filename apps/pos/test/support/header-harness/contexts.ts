import type { ReactNode } from 'react';
import type { useOperator as realUseOperator } from '@/auth/OperatorContext';
import type { useBranch as realUseBranch } from '@/branch/BranchContext';
import type { useStation as realUseStation } from '@/station/StationContext';
import type { Branch } from '@/types';

/**
 * SCRUM-505 — the three contexts the header reads, as a signed-in till has
 * them, for the header measurement page (`index.html` here; the browser test
 * is `test/scrum-505-header-widths.test.ts`). The measurement server aliases
 * `@/auth/OperatorContext`, `@/branch/BranchContext` and
 * `@/station/StationContext` to this file, so the header and everything in it
 * are the real components reading these values. Nothing in the till imports it.
 *
 * The values are the widest ones staging has shown in the header: a park with
 * the long seeded name (two parks, so the chip is the switcher with its
 * chevron), the seeded admin's "Khun Anan", a station name, and an account
 * that may record a paid-out (so the Cash button is drawn).
 */
export type OperatorValue = ReturnType<typeof realUseOperator>;
export type BranchValue = ReturnType<typeof realUseBranch>;
export type StationValue = ReturnType<typeof realUseStation>;

const params = new URLSearchParams(window.location.search);

export const HARNESS_BRANCHES: Branch[] = [
  {
    id: 'hkt-central',
    apiId: '01990000-0000-7000-8000-00000000c001',
    name: params.get('park') ?? 'Oto Play Park, Central Floresta',
    timezone: 'Asia/Bangkok',
    active: true,
  },
  {
    id: 'robinson-chalong',
    apiId: '01990000-0000-7000-8000-00000000c002',
    name: 'Oto Play Park, Robinson Chalong',
    timezone: 'Asia/Bangkok',
    active: true,
  },
];

const noop = (): void => undefined;
const never = (): Promise<never> => new Promise<never>(() => undefined);

const operatorValue: OperatorValue = {
  operator: { id: '01990000-0000-7000-8000-00000000a001', name: params.get('operator') ?? 'Khun Anan', role: 'manager' },
  locked: false,
  signIn: never,
  unlock: never,
  mustChangePassword: false,
  changePassword: never,
  offlineUnlock: null,
  can: () => params.get('cash') !== 'no',
  lockNow: noop,
  handoffError: null,
  logout: noop,
  warningActive: false,
  secondsLeft: 0,
  stayActive: noop,
  sessionResolved: true,
};

const branchValue: BranchValue = {
  branch: HARNESS_BRANCHES[0]!,
  branches: params.get('parks') === 'one' ? [HARNESS_BRANCHES[0]!] : HARNESS_BRANCHES,
  switching: false,
  setActiveBranchId: noop,
};

const stationValue: StationValue = {
  station: {
    stationId: '01990000-0000-7000-8000-00000000d001',
    stationName: params.get('station') ?? 'Reception Till 1',
    branchId: HARNESS_BRANCHES[0]!.apiId,
  },
  active: null,
  stations: null,
  // No fleet: the link banner under the header stays silent, as on a healthy till.
  fleetAvailable: false,
  resolved: true,
  loading: false,
  error: null,
  notice: null,
  pick: never,
  reload: never,
  setStation: noop,
  clearStation: noop,
};

export const useOperator = (): OperatorValue => operatorValue;
export const useBranch = (): BranchValue => branchValue;
export const useStation = (): StationValue => stationValue;

const passThrough = ({ children }: { children: ReactNode }): ReactNode => children;
export const OperatorProvider = passThrough;
export const BranchProvider = passThrough;
export const StationProvider = passThrough;
