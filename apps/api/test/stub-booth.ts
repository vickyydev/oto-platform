import {
  BoothRefusal,
  type Booth,
  type BoothConfigBundle,
  type BoothReprintRequest,
  type BoothSignInRequest,
  type BoothSpinRequest,
  type BoothStatusReport,
  type BoxAgent,
  type BoxStaffSession,
} from '@oto/box-agent';
import type { BoothReprintResponse, SpinResponse } from '@oto/shared';
import { attachInProcessBox, detachInProcessBox } from '../src/services/box';

/**
 * A booth module, stubbed at the interface the box publishes — the one stub
 * for every api test that needs a box in this process without a wheel, a
 * store or a printer behind it (`booth-api.test.ts`, `booth-pairing.test.ts`).
 *
 * Written out in full rather than cast, so that a change to `Booth` in
 * `@oto/box-agent` fails those files rather than passing them: what they are
 * about is the api handing a request to THAT interface, and a stub that had
 * drifted from it would be proving nothing.
 *
 * **Every default answer is one the real booth gives**, for a booth with
 * nobody on its staff list and nobody signed in. It is one module because the
 * two files used to carry a copy each, and a copy is where a stub grows a path
 * the box has not (closing audit 2026-09-25, L35: the television page's own
 * fake accepted a badge, invented an expiry and kept a fixed session). So:
 *  - a press draws, unattributed (`staffAccountId: null`);
 *  - a sign-in is refused, PIN or badge alike. The box verifies against the
 *    hashes on its cached staff list and this booth holds none — and a badge
 *    finds nobody on any box today (`booth.ts`, `signIn`);
 *  - there is no live session, so the status says nobody is signed in and
 *    carries `staff: null`, which the booth always sends;
 *  - a reprint is refused `staff_required`, which is what a box with no
 *    session answers (`booth.ts`, `reprint`). Every real booth has the
 *    reprint path; the http contract's 404 for a booth without one is for an
 *    older box, and nothing here stands in for that.
 * A test that needs another answer overrides that one member, and says why.
 */

/** What the stub was asked, in order, for the assertions that read it. */
export interface BoothCalls {
  spin: BoothSpinRequest[];
  signIn: BoothSignInRequest[];
  signOut: number;
  reprint: BoothReprintRequest[];
  /** What `status()` was told about the box's link — the api's own contribution. */
  statusOnline: boolean[];
}

export function newCalls(): BoothCalls {
  return { spin: [], signIn: [], signOut: 0, reprint: [], statusOnline: [] };
}

/** The draw this booth answers every press with. */
export const SPIN: SpinResponse = {
  spinId: '0199a0f0-0000-7000-8000-00000000f001',
  prizeIndex: 2,
  prizeId: '0199a0f0-0000-7000-8000-00000000e002',
  configVersion: 1,
  voucherCode: 'B1H7K2M9PQ',
  expiresAt: '2026-10-05T00:00:00.000Z',
  printState: 'printed',
  staffAccountId: null,
  clockSuspect: false,
};

/** The same code on new paper: what a box with somebody signed in answers a reprint. */
export const REPRINT: BoothReprintResponse = {
  spinId: SPIN.spinId,
  printState: 'printed',
};

export const BUNDLE = {
  schemaVersion: 1,
  settings: { eligibility: 'none', buttonKey: 'Space', dailySpinCap: null },
  layout: { id: 'l1', name: 'Classic wheel', version: 1, design: {}, assetManifest: {} },
  prizes: [],
} as unknown as BoothConfigBundle;

export const STATUS: BoothStatusReport = {
  online: true,
  neverSynced: false,
  configVersion: 1,
  printerReachable: 'reachable',
  paperStatus: 'ok',
  vouchersPending: 0,
  lastSpinAt: null,
  staffSignedIn: false,
  dailyCapsReached: [],
  staff: null,
};

export function stubBooth(calls: BoothCalls, overrides: Partial<Booth> = {}): Booth {
  const base: Booth = {
    start: async () => {},
    stop: () => {},
    config: () => ({ version: 1, bundle: BUNDLE }),
    refresh: async () => false,
    spin: async (request) => {
      calls.spin.push(request);
      return SPIN;
    },
    signIn: async (request) => {
      calls.signIn.push(request);
      return { ok: false };
    },
    signOut: async () => {
      calls.signOut += 1;
    },
    staffSession: async (): Promise<BoxStaffSession | null> => null,
    reprint: async (request) => {
      calls.reprint.push(request);
      throw new BoothRefusal('staff_required', 'A reprint needs a member of staff signed in');
    },
    status: async ({ online }) => {
      calls.statusOnline.push(online);
      return { ...STATUS, online };
    },
    heartbeat: async () => null,
    ownsPrintJob: () => false,
    reportPrint: async () => {},
    noteCloudTime: async () => {},
  };
  return { ...base, ...overrides };
}

/** Nothing stays attached between tests: the map is process-wide. */
const attached: BoxAgent[] = [];

/**
 * That booth — or none — on a box said to be running in this process.
 *
 * The cast is to `BoxAgent`, of which the booth routes use two things: the
 * box id `attachInProcessBox` files it under, and the booth module. A null
 * booth is a box that is here but has no booth module at all — an agent with
 * no store. `print-api.test.ts` attaches a real agent for the same reason —
 * a test driving an agent against this api is the same kind of process
 * making the same claim.
 */
export function attachStubBox(
  boxId: string,
  booth: Booth | null,
  opts: { offline?: boolean } = {},
): BoxAgent {
  const agent = {
    state: { boxId, offline: opts.offline ?? false },
    booth: () => booth,
  } as unknown as BoxAgent;
  attachInProcessBox(agent);
  attached.push(agent);
  return agent;
}

/** Take every stub box out of the process map — each file's `afterEach`. */
export function detachStubBoxes(): void {
  while (attached.length > 0) detachInProcessBox(attached.pop()!);
}
