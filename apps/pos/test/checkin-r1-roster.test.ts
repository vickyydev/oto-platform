import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from './support/hooks';
import { checkinApi, type ApiNanny } from '@/api/checkin';
import { useNannyRoster } from '@/lib/nannyRoster';

/**
 * S2-13 ROUND 1, FIX 3 — THE ROSTER FOR A SCREEN THAT PASSES NONE.
 *
 * `DropOffLineConfig` dropped its internal `getNannyRoster` read for a
 * `roster` prop that defaulted to `[]`; `MobileTill` renders it without one,
 * so the mobile till could not pick any nanny and every nanny sale there was
 * blocked. `useNannyRoster` is what the component reads now: the roster it
 * was given, as given — or, given none, the platform's for the park on
 * screen, by the platform's branch id (finding R1).
 *
 * The hook runs on the harness in place of React (support/hooks.ts); the one
 * round trip, `checkinApi.config`, is the test's to answer.
 */

const HKT_CENTRAL = '0190a0a0-0000-7000-8000-00000000b001';

vi.mock('react', () => import('./support/hooks'));
vi.mock('@/api/catalogBridge', () => ({
  apiBranchIdForSlug: (slug: string) => (slug === 'hkt-central' ? HKT_CENTRAL : null),
}));
vi.mock('@/api/checkin', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/checkin')>();
  return { ...original, checkinApi: { ...original.checkinApi, config: vi.fn() } };
});

const config = vi.mocked(checkinApi.config);

const ROSTER: ApiNanny[] = [
  { id: '0190a0a0-0000-7000-8000-0000000000a1', name: 'Pim', onShift: true, load: 1, coveredNames: ['Mint'] },
  { id: '0190a0a0-0000-7000-8000-0000000000a2', name: 'Aor', onShift: false, load: 0, coveredNames: [] },
];

const answer = (nannies: ApiNanny[]) =>
  ({ policy: {}, pricing: {}, photoRetentionDays: 30, nannies }) as unknown as Awaited<
    ReturnType<typeof checkinApi.config>
  >;

/** Let a resolved promise's `then` run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  config.mockReset();
});

describe('useNannyRoster', () => {
  it("a screen that passes no roster gets the platform's, read by the platform's branch id", async () => {
    config.mockResolvedValueOnce(answer(ROSTER));
    const hook = renderHook(() => useNannyRoster('hkt-central'));
    expect(hook.result.current).toEqual([]);
    await settle();
    expect(hook.result.current).toEqual(ROSTER);
    expect(config).toHaveBeenCalledTimes(1);
    expect(config).toHaveBeenCalledWith(HKT_CENTRAL);
  });

  it('a roster passed in is used as given and nothing is asked', async () => {
    const hook = renderHook(() => useNannyRoster('hkt-central', ROSTER));
    await settle();
    expect(hook.result.current).toBe(ROSTER);
    expect(config).not.toHaveBeenCalled();
  });

  it('a till with no platform branch gets an empty roster and asks nothing', async () => {
    const hook = renderHook(() => useNannyRoster('nowhere'));
    await settle();
    expect(hook.result.current).toEqual([]);
    expect(config).not.toHaveBeenCalled();
  });

  it("a refusal leaves the roster empty; an answer for a screen that went away is dropped", async () => {
    config.mockRejectedValueOnce(new Error('403'));
    const refused = renderHook(() => useNannyRoster('hkt-central'));
    await settle();
    expect(refused.result.current).toEqual([]);

    let release: (value: ReturnType<typeof answer>) => void = () => undefined;
    config.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const gone = renderHook(() => useNannyRoster('hkt-central'));
    gone.unmount();
    release(answer(ROSTER));
    await settle();
    expect(gone.result.current).toEqual([]);
  });
});
