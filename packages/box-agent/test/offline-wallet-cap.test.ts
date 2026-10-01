import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bandShortCode,
  mintBandCode,
  ulidFromUuid,
  walletOfflineCapMessage,
  type WalletSnapshotItem,
} from '@oto/shared';
import {
  decideOfflineSpend,
  findSnapshotWallet,
  offlineWalletAllowance,
  readWalletSnapshot,
  scannedKeyDigests,
  walletKeyDigestsOf,
} from '../src/wallet-lane';

/**
 * THE OFFLINE CAP'S ARITHMETIC — S2-14a round 4 (plan wallet/PLAN.md §2.6).
 *
 * A wallet spends with the link down up to min(snapshot balance less this
 * box's spends the snapshot does not yet reflect, cap less this wallet's
 * spends on THIS box today). Pure functions, no store: the money rule is
 * proved here at its boundaries, and the bridge suite proves the box holds it.
 */

const CAP = 30_000; // ฿300, the seeded `wallet_policy` cap (OD-14)

test('snapshot vs cap: the smaller one wins, before anything is spent', () => {
  assert.deepEqual(
    offlineWalletAllowance({ snapshotBalanceSatang: 50_000, reflectedSatang: 0, spentOnBoxSatang: 0, spentTodaySatang: 0, capSatang: CAP }),
    { balanceLeftSatang: 50_000, capLeftSatang: 30_000, allowedSatang: 30_000 },
    'a ฿500 wallet spends ฿300 offline',
  );
  assert.deepEqual(
    offlineWalletAllowance({ snapshotBalanceSatang: 20_000, reflectedSatang: 0, spentOnBoxSatang: 0, spentTodaySatang: 0, capSatang: CAP }),
    { balanceLeftSatang: 20_000, capLeftSatang: 30_000, allowedSatang: 20_000 },
    'a ฿200 wallet spends ฿200 — never more than it holds',
  );
});

test('the local day: spends on this box come off the cap and, until reflected, off the snapshot', () => {
  // ฿250 spent here today, none of it filed yet: ฿50 of cap left, ฿250 of balance.
  assert.deepEqual(
    offlineWalletAllowance({ snapshotBalanceSatang: 50_000, reflectedSatang: 0, spentOnBoxSatang: 25_000, spentTodaySatang: 25_000, capSatang: CAP }),
    { balanceLeftSatang: 25_000, capLeftSatang: 5_000, allowedSatang: 5_000 },
  );
  // The same ฿250 after it synced: the snapshot already shows ฿250 left and
  // says this box's filed spends are ฿250, so nothing is taken off twice.
  assert.deepEqual(
    offlineWalletAllowance({ snapshotBalanceSatang: 25_000, reflectedSatang: 25_000, spentOnBoxSatang: 25_000, spentTodaySatang: 25_000, capSatang: CAP }),
    { balanceLeftSatang: 25_000, capLeftSatang: 5_000, allowedSatang: 5_000 },
  );
  // Part-filed: ฿100 of the ฿250 reflected.
  assert.equal(
    offlineWalletAllowance({ snapshotBalanceSatang: 40_000, reflectedSatang: 10_000, spentOnBoxSatang: 25_000, spentTodaySatang: 25_000, capSatang: CAP })
      .balanceLeftSatang,
    25_000,
  );
});

test('the trading day turns with the link still down: yesterday’s unsynced credit still comes off the snapshot, only the cap starts again', () => {
  // ฿300 taken yesterday, none of it filed; a new day on the same ฿400 copy.
  // The cap is fresh (฿300), the snapshot is not: ฿100 is all that is left.
  assert.deepEqual(
    offlineWalletAllowance({ snapshotBalanceSatang: 40_000, reflectedSatang: 0, spentOnBoxSatang: 30_000, spentTodaySatang: 0, capSatang: CAP }),
    { balanceLeftSatang: 10_000, capLeftSatang: 30_000, allowedSatang: 10_000 },
  );
  // Once yesterday's ฿300 is filed and a fresh copy reflects it, nothing comes off twice.
  assert.deepEqual(
    offlineWalletAllowance({ snapshotBalanceSatang: 10_000, reflectedSatang: 30_000, spentOnBoxSatang: 30_000, spentTodaySatang: 0, capSatang: CAP }),
    { balanceLeftSatang: 10_000, capLeftSatang: 30_000, allowedSatang: 10_000 },
  );
  // A hold written before the all-days count existed: today's count is the floor.
  assert.equal(
    offlineWalletAllowance({ snapshotBalanceSatang: 40_000, reflectedSatang: 0, spentOnBoxSatang: 0, spentTodaySatang: 20_000, capSatang: CAP }).balanceLeftSatang,
    20_000,
  );
});

test('the boundary at exactly ฿300: the ฿300th baht is allowed, one satang more is refused as the cap', () => {
  const fresh = offlineWalletAllowance({ snapshotBalanceSatang: 50_000, reflectedSatang: 0, spentOnBoxSatang: 0, spentTodaySatang: 0, capSatang: CAP });
  assert.deepEqual(decideOfflineSpend(fresh, { amountSatang: 30_000, outstandingSatang: 40_000 }), { amountSatang: 30_000 });
  assert.deepEqual(decideOfflineSpend(fresh, { amountSatang: 30_001, outstandingSatang: 40_000 }), { refusal: 'cap' });
  assert.deepEqual(decideOfflineSpend(fresh, { useCredit: true, outstandingSatang: 40_000 }), { amountSatang: 30_000 });

  const atCap = offlineWalletAllowance({ snapshotBalanceSatang: 50_000, reflectedSatang: 0, spentOnBoxSatang: 30_000, spentTodaySatang: 30_000, capSatang: CAP });
  assert.equal(atCap.capLeftSatang, 0);
  assert.deepEqual(decideOfflineSpend(atCap, { useCredit: true, outstandingSatang: 5_000 }), { refusal: 'cap' });
  assert.deepEqual(decideOfflineSpend(atCap, { amountSatang: 1, outstandingSatang: 5_000 }), { refusal: 'cap' });

  const oneShort = offlineWalletAllowance({ snapshotBalanceSatang: 50_000, reflectedSatang: 0, spentOnBoxSatang: 29_999, spentTodaySatang: 29_999, capSatang: CAP });
  assert.deepEqual(decideOfflineSpend(oneShort, { useCredit: true, outstandingSatang: 5_000 }), { amountSatang: 1 });
});

test('use credit takes what can be spent here up to what the order owes; an exact figure is refused, never floored', () => {
  const a = offlineWalletAllowance({ snapshotBalanceSatang: 12_000, reflectedSatang: 0, spentOnBoxSatang: 0, spentTodaySatang: 0, capSatang: CAP });
  assert.deepEqual(decideOfflineSpend(a, { useCredit: true, outstandingSatang: 8_000 }), { amountSatang: 8_000 });
  assert.deepEqual(decideOfflineSpend(a, { useCredit: true, outstandingSatang: 20_000 }), { amountSatang: 12_000 });
  assert.deepEqual(decideOfflineSpend(a, { amountSatang: 13_000, outstandingSatang: 20_000 }), { refusal: 'insufficient' });
  assert.deepEqual(decideOfflineSpend(a, { amountSatang: 9_000, outstandingSatang: 8_000 }), { refusal: 'over_order' });
  const empty = offlineWalletAllowance({ snapshotBalanceSatang: 0, reflectedSatang: 0, spentOnBoxSatang: 0, spentTodaySatang: 0, capSatang: CAP });
  assert.deepEqual(decideOfflineSpend(empty, { useCredit: true, outstandingSatang: 8_000 }), { refusal: 'empty' });
});

test('the cap refusal is said in the counter’s words', () => {
  assert.match(walletOfflineCapMessage(CAP), /online only above ฿300 per day/);
  assert.match(walletOfflineCapMessage(15_050), /online only above ฿150\.50 per day/);
});

test('keys travel as digests: the box finds a wallet by what is scanned without ever holding the code', () => {
  const qr = 'QR-7KMQ4XABCDEFGHJKMNPQ';
  const bandCode = mintBandCode('T1', ulidFromUuid('018f0000-0000-7000-8000-00000000ba01'), 'park-band-key-for-the-wallet-test');
  assert.ok(bandShortCode(bandCode), 'a real band code, with a short code');
  const childId = '018f0000-0000-7000-8000-00000000c0c1';
  const keys = [
    ...walletKeyDigestsOf({ kind: 'voucher_qr', value: qr }),
    ...walletKeyDigestsOf({ kind: 'band', value: bandCode }),
    ...walletKeyDigestsOf({ kind: 'child', value: childId }),
    ...walletKeyDigestsOf({ kind: 'phone', value: '+66811111111' }),
  ];
  assert.ok(keys.every((k) => /^[0-9a-f]{64}$/.test(k.d)), 'only digests');
  assert.ok(!JSON.stringify(keys).includes('QR-'), 'never the QR itself');
  assert.equal(keys.filter((k) => k.k === 'c').length, 1);
  const snapshot: WalletSnapshotItem = {
    version: 'v',
    generatedAt: new Date().toISOString(),
    branchId: 'b',
    businessDate: '2026-10-01',
    capSatang: CAP,
    truncated: false,
    wallets: [{ id: 'w1', status: 'active', balanceSatang: 1_000, expiresAt: null, boxSpentSatang: 0, keys }],
  };
  assert.equal((findSnapshotWallet(snapshot, qr.toLowerCase()) as { found: { id: string } }).found.id, 'w1');
  assert.equal((findSnapshotWallet(snapshot, ` ${bandCode} `) as { found: { id: string } }).found.id, 'w1');
  assert.equal((findSnapshotWallet(snapshot, childId.toUpperCase()) as { found: { id: string } }).found.id, 'w1');
  assert.equal(findSnapshotWallet(snapshot, 'QR-SOMEBODYELSE'), null);
  assert.equal(findSnapshotWallet(snapshot, '+66811111111'), null, 'a phone is never a scan key');
  assert.ok(scannedKeyDigests('').length === 0);

  // A short code two bands share names neither, rather than a guess.
  const typed = bandShortCode(bandCode)!;
  assert.equal(
    (findSnapshotWallet(snapshot, typed.toLowerCase().replace('-', ' ')) as { found: { id: string } }).found.id,
    'w1',
    'a short code typed at the counter finds the band’s wallet',
  );
  const short = walletKeyDigestsOf({ kind: 'band', value: bandCode }).find((k) => k.k === 's')!;
  const twin: WalletSnapshotItem = {
    ...snapshot,
    wallets: [
      ...snapshot.wallets,
      { id: 'w2', status: 'active', balanceSatang: 1_000, expiresAt: null, boxSpentSatang: 0, keys: [short] },
    ],
  };
  const found = findSnapshotWallet(twin, typed);
  assert.ok(found && 'ambiguous' in found, 'ambiguous short code');
  assert.equal((findSnapshotWallet(twin, bandCode) as { found: { id: string } }).found.id, 'w1', 'the full code is not ambiguous');
});

test('a snapshot is read defensively: a damaged row is skipped, a damaged item is none', () => {
  assert.equal(readWalletSnapshot(null), null);
  assert.equal(readWalletSnapshot({ items: [{ capSatang: -1, businessDate: '2026-10-01' }] }), null);
  const read = readWalletSnapshot({
    items: [
      {
        version: 'v1',
        generatedAt: 'g',
        branchId: 'b',
        businessDate: '2026-10-01',
        capSatang: CAP,
        truncated: false,
        wallets: [
          { id: 'ok', status: 'active', balanceSatang: 500, expiresAt: null, boxSpentSatang: 100, keys: [{ k: 'q', d: 'x' }, { k: 'z', d: 'y' }] },
          { id: 'bad', balanceSatang: -5 },
          { balanceSatang: 5 },
        ],
      },
    ],
  });
  assert.ok(read);
  assert.deepEqual(read.wallets.map((w) => w.id), ['ok']);
  assert.deepEqual(read.wallets[0]!.keys, [{ k: 'q', d: 'x' }], 'an unknown key kind is dropped');
});
