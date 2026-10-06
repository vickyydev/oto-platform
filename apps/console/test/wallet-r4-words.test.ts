import { describe, expect, it } from 'vitest';
import { SYNC_ANOMALY_KINDS } from '@oto/shared';
import { anomalyFacts, anomalyWords } from '@/lib/syncWords';

/**
 * THE FAILURES SURFACE'S WORDS FOR AN OFFLINE OVERDRAFT — S2-14a round 4
 * (plan docs/progress/plans/wallet/PLAN.md §2.6).
 *
 * Two boxes spent one wallet with the internet down, and when the second spend
 * reached the platform the wallet held less than it took. The row is read by
 * somebody who is not an engineer, at a moment the park may have given away
 * credit, so it has to say what happened, that the sale stands, and what the
 * row names — in plain words, not the column's.
 */
describe('wallet_overdraft on Failures', () => {
  it('is a kind the console has a sentence for, not the fallback', () => {
    expect(SYNC_ANOMALY_KINDS).toContain('wallet_overdraft');
    const words = anomalyWords('wallet_overdraft');
    expect(words.label).toBe('Credit spent offline that the wallet did not have');
    expect(words.what).toMatch(/two counters spent the same wallet while both were offline/);
    expect(words.what).toMatch(/The sale is filed as it was taken and the wallet is at zero/);
    expect(words.what).toMatch(/names the wallet, the box, the station/);
    expect(words.what).not.toMatch(/has not been taught/);
    expect(words.what).not.toMatch(/sync_anomaly|wallet_entry|balance_after/);
  });

  it('lays the row’s evidence out as labelled facts', () => {
    const facts = anomalyFacts({
      walletId: '018f0000-0000-7000-8000-00000000aa77',
      boxId: '018f0000-0000-7000-8000-00000000b0c5',
      stationId: '018f0000-0000-7000-8000-0000000057a1',
      overdraftSatang: 10_000,
      spentSatang: 30_000,
      coveredSatang: 20_000,
      snapshotBalanceSatang: 50_000,
    });
    expect(facts.map((f) => f.label)).toEqual([
      'Wallet id',
      'Box id',
      'Station id',
      'Overdraft satang',
      'Spent satang',
      'Covered satang',
    ]);
    expect(facts.find((f) => f.label === 'Overdraft satang')?.value).toBe('10000');
  });
});
