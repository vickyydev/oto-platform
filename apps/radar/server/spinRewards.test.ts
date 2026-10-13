import assert from "node:assert/strict";
import { SPIN_REWARDS } from "@shared/spinRewards";
import { SpinRewardsService } from "./spinRewards";

type Row = {
  win_id: string;
  prize_id: string;
  campaign_id: string;
  code: string;
  won_at: Date;
  redeemed_at: Date | null;
};

/**
 * Disposable SQL-shaped mock: it serializes BEGIN/COMMIT like PostgreSQL row
 * locking and never connects to DATABASE_URL. It exercises the production
 * service's idempotency, redemption, and capacity branches without allocating
 * a reward code in a live database.
 */
class DisposableSpinDatabase {
  readonly rows: Row[] = [];
  exhausted = false;
  private readonly rateAttempts = new Map<string, number>();
  private locked = false;
  private waiters: Array<() => void> = [];

  private async acquire() {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release() {
    const next = this.waiters.shift();
    if (next) return next();
    this.locked = false;
  }

  async connect() {
    const database = this;
    return {
      async query(text: string, values: unknown[] = []) {
        if (text.startsWith("BEGIN")) {
          await database.acquire();
          return { rows: [] };
        }
        if (text === "COMMIT" || text === "ROLLBACK") {
          database.release();
          return { rows: [] };
        }
        if (text.includes("FROM spin_reward_campaigns WHERE prize_id")) {
          const reward = SPIN_REWARDS.find((r) => r.prizeId === values[0]);
          return { rows: reward ? [{ campaign_id: reward.campaignId, prize_id: reward.prizeId, active: reward.activeByDefault }] : [] };
        }
        if (text.includes("WHERE win_id = $1")) {
          return { rows: database.rows.filter((row) => row.win_id === values[0]) };
        }
        if (text.includes("FROM generate_series")) {
          if (database.exhausted) return { rows: [] };
          for (let n = 0; n < 10_000; n++) {
            const code = String(n).padStart(4, "0");
            if (!database.rows.some((row) => row.code === code)) return { rows: [{ code }] };
          }
          return { rows: [] };
        }
        if (text.includes("INSERT INTO spin_reward_code_ledger")) {
          const row: Row = {
            win_id: String(values[0]),
            prize_id: String(values[1]),
            campaign_id: String(values[2]),
            code: String(values[3]),
            won_at: values[4] as Date,
            redeemed_at: null,
          };
          if (database.rows.some((existing) => existing.win_id === row.win_id || existing.code === row.code)) {
            const error = Object.assign(new Error("unique violation"), { code: "23505" });
            throw error;
          }
          database.rows.push(row);
          return { rows: [row] };
        }
        if (text.startsWith("UPDATE spin_reward_code_ledger")) {
          const row = database.rows.find((candidate) => candidate.code === values[0] && candidate.redeemed_at === null);
          if (!row) return { rows: [] };
          row.redeemed_at = new Date("2026-09-17T10:00:00.000Z");
          return { rows: [row] };
        }
        if (text.includes("WHERE code = $1")) {
          return { rows: database.rows.filter((row) => row.code === values[0]) };
        }
        throw new Error(`Unhandled mock SQL: ${text}`);
      },
      release() {},
    };
  }

  async query(text: string, values: unknown[] = []) {
    if (text.startsWith("INSERT INTO spin_reward_rate_limits")) {
      const bucket = String(values[0]);
      const attempts = (this.rateAttempts.get(bucket) ?? 0) + 1;
      this.rateAttempts.set(bucket, attempts);
      return { rows: [{ attempts, retry_after_seconds: 60 }] };
    }
    throw new Error("This test only uses transactional issue/redeem operations");
  }
}

async function run() {
  const database = new DisposableSpinDatabase();
  const service = new SpinRewardsService(database as any);
  const input = {
    winId: "wheel-win-1",
    prizeId: "voucher-100",
    wonAt: new Date(Date.now() - 1_000),
  };

  const concurrent = await Promise.all(Array.from({ length: 20 }, () => service.issue(input)));
  assert.equal(database.rows.length, 1, "concurrent retries create one ledger entry");
  assert(concurrent.every((result) => result.kind === "issued"));
  const issuedCodes = concurrent.map((result) => result.kind === "issued" ? result.reward.code : "");
  assert.equal(new Set(issuedCodes).size, 1, "same win always returns its original code");

  const mismatch = await service.issue({ ...input, prizeId: "voucher-150" });
  assert.deepEqual(mismatch, { kind: "win_prize_mismatch" });

  const redeems = await Promise.all(Array.from({ length: 12 }, () => service.redeem(issuedCodes[0])));
  assert.equal(redeems.filter((result) => result.kind === "redeemed").length, 1, "only one redemption wins");
  assert.equal(redeems.filter((result) => result.kind === "already_used").length, 11);
  const retryAfterRedeem = await service.issue(input);
  assert.equal(retryAfterRedeem.kind, "issued");
  if (retryAfterRedeem.kind === "issued") {
    assert.equal(retryAfterRedeem.reward.code, issuedCodes[0], "redeemed win remains idempotent");
    assert.notEqual(retryAfterRedeem.reward.redeemedAt, null);
  }

  const disabled = await service.issue({
    winId: "wheel-win-disabled",
    prizeId: "mystery-gift",
    wonAt: input.wonAt,
  });
  assert.deepEqual(disabled, { kind: "disabled" });

  database.exhausted = true;
  const exhausted = await service.issue({
    winId: "wheel-win-exhausted",
    prizeId: "voucher-200",
    wonAt: input.wonAt,
  });
  assert.deepEqual(exhausted, { kind: "exhausted" });

  const limiter = await Promise.all(
    Array.from({ length: 61 }, () => service.consumeRedemptionRateLimit("a".repeat(64))),
  );
  assert.equal(limiter.filter((result) => result.allowed).length, 60, "shared limiter permits 60 attempts");
  assert.equal(limiter.filter((result) => !result.allowed).length, 1, "61st attempt is limited");
  console.log("spinRewards.test: idempotency, concurrency, redemption, disabled, and exhaustion passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});