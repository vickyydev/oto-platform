import type { PoolClient, QueryResult } from "pg";
import { pool } from "./db";
import {
  SPIN_REWARDS,
  SPIN_REWARDS_BY_PRIZE_ID,
  type SpinRewardDefinition,
} from "@shared/spinRewards";

export const SPIN_REWARD_CAPACITY = 10_000;
export const SPIN_REWARD_REDEEM_ATTEMPTS_PER_MINUTE = 60;

type CampaignStateRow = {
  campaign_id: string;
  prize_id: string;
  active: boolean;
};

type LedgerRow = {
  win_id: string;
  prize_id: string;
  campaign_id: string;
  code: string;
  won_at: Date | string;
  redeemed_at: Date | string | null;
};

type TransactionPool = {
  connect(): Promise<PoolClient>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
};

export type SpinRewardState = SpinRewardDefinition & { active: boolean };

export type IssuedSpinReward = {
  status: "Issued";
  code: string;
  winId: string;
  prizeId: string;
  campaignId: string;
  displayName: string;
  customerValue: string;
  title: string;
  instructions: string;
  terms: string | null;
  wonAt: string;
  redeemedAt: string | null;
  expiresAt: null;
  qrPayload: string;
};

export type IssueSpinRewardResult =
  | { kind: "issued"; reward: IssuedSpinReward }
  | { kind: "win_prize_mismatch" }
  | { kind: "invalid_won_at" }
  | { kind: "disabled" }
  | { kind: "exhausted" };

export type RedeemSpinRewardResult =
  | {
      kind: "redeemed" | "already_used";
      code: string;
      prizeId: string;
      campaignId: string;
      displayName: string;
      customerValue: string;
      wonAt: string;
      redeemedAt: string;
    }
  | { kind: "not_found" };

export class SpinRewardsUnavailableError extends Error {
  constructor(message = "Spin Wheel reward service is unavailable") {
    super(message);
    this.name = "SpinRewardsUnavailableError";
  }
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function definitionFor(prizeId: string): SpinRewardDefinition {
  const definition = SPIN_REWARDS_BY_PRIZE_ID.get(prizeId);
  if (!definition) throw new SpinRewardsUnavailableError("Reward campaign configuration is inconsistent");
  return definition;
}

function asIssued(row: LedgerRow): IssuedSpinReward {
  const reward = definitionFor(row.prize_id);
  return {
    status: "Issued",
    code: row.code,
    winId: row.win_id,
    prizeId: reward.prizeId,
    campaignId: reward.campaignId,
    displayName: reward.displayName,
    customerValue: reward.customerValue,
    title: reward.title,
    instructions: reward.instructions,
    terms: reward.terms,
    wonAt: iso(row.won_at),
    redeemedAt: row.redeemed_at ? iso(row.redeemed_at) : null,
    expiresAt: null,
    qrPayload: row.code,
  };
}

function isRetryableDatabaseError(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  // serialization retry and a race on either immutable unique key
  return code === "40001" || code === "23505";
}

/**
 * SQL-backed source of truth. The transaction makes a win idempotent while
 * the database unique constraints protect codes and wins across all servers.
 */
export class SpinRewardsService {
  constructor(private readonly database: TransactionPool = pool) {}

  async listRewards(): Promise<{ rewards: SpinRewardState[] }> {
    const result = await this.database.query<CampaignStateRow>(
      "SELECT campaign_id, prize_id, active FROM spin_reward_campaigns",
    );
    const states = new Map(result.rows.map((row) => [row.prize_id, row]));
    const rewards = SPIN_REWARDS.map((definition) => {
      const row = states.get(definition.prizeId);
      if (!row || row.campaign_id !== definition.campaignId) {
        throw new SpinRewardsUnavailableError();
      }
      return { ...definition, active: row.active };
    });
    return { rewards };
  }

  async issue(input: {
    winId: string;
    prizeId: string;
    wonAt: Date;
  }): Promise<IssueSpinRewardResult> {
    const expected = definitionFor(input.prizeId);

    for (let attempt = 0; attempt < 12; attempt++) {
      const client = await this.database.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        const campaignResult = await client.query<CampaignStateRow>(
          "SELECT campaign_id, prize_id, active FROM spin_reward_campaigns WHERE prize_id = $1 FOR UPDATE",
          [input.prizeId],
        );
        const campaign = campaignResult.rows[0];
        if (!campaign || campaign.campaign_id !== expected.campaignId) {
          throw new SpinRewardsUnavailableError();
        }

        const existingResult = await client.query<LedgerRow>(
          "SELECT win_id, prize_id, campaign_id, code, won_at, redeemed_at FROM spin_reward_code_ledger WHERE win_id = $1 FOR UPDATE",
          [input.winId],
        );
        const existing = existingResult.rows[0];
        if (existing) {
          await client.query("COMMIT");
          if (existing.prize_id !== input.prizeId) return { kind: "win_prize_mismatch" };
          return { kind: "issued", reward: asIssued(existing) };
        }
        // This check is deliberately after the existing-win lookup. An
        // idempotent retry always returns its established record unchanged.
        if (input.wonAt.getTime() > Date.now()) {
          await client.query("ROLLBACK");
          return { kind: "invalid_won_at" };
        }
        if (!campaign.active) {
          await client.query("ROLLBACK");
          return { kind: "disabled" };
        }

        // random ordering avoids predictable issuance. Old numeric campaign
        // codes are explicitly excluded; future ones are DB-constrained too.
        const candidateResult = await client.query<{ code: string }>(
          `SELECT lpad(n::text, 4, '0') AS code
           FROM generate_series(0, 9999) AS n
           WHERE NOT EXISTS (
             SELECT 1 FROM spin_reward_code_ledger l
             WHERE l.code = lpad(n::text, 4, '0')
           )
           AND NOT EXISTS (
             SELECT 1 FROM spin_reward_legacy_code_reservations r
             WHERE r.code = lpad(n::text, 4, '0')
           )
           ORDER BY random()
           LIMIT 1`,
        );
        const code = candidateResult.rows[0]?.code;
        if (!code) {
          await client.query("ROLLBACK");
          return { kind: "exhausted" };
        }

        const insertedResult = await client.query<LedgerRow>(
          `INSERT INTO spin_reward_code_ledger
             (win_id, prize_id, campaign_id, code, won_at)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING win_id, prize_id, campaign_id, code, won_at, redeemed_at`,
          [input.winId, input.prizeId, campaign.campaign_id, code, input.wonAt],
        );
        await client.query("COMMIT");
        return { kind: "issued", reward: asIssued(insertedResult.rows[0]) };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        if (isRetryableDatabaseError(error) && attempt < 11) continue;
        throw error;
      } finally {
        client.release();
      }
    }
    throw new SpinRewardsUnavailableError();
  }

  async redeem(code: string): Promise<RedeemSpinRewardResult> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      // Conditional update is atomic. A concurrent attempt waits, then sees
      // redeemed_at and returns Already used instead of redeeming twice.
      const updatedResult = await client.query<LedgerRow>(
        `UPDATE spin_reward_code_ledger
         SET redeemed_at = now()
         WHERE code = $1 AND redeemed_at IS NULL
         RETURNING win_id, prize_id, campaign_id, code, won_at, redeemed_at`,
        [code],
      );
      const row = updatedResult.rows[0];
      if (row) {
        await client.query("COMMIT");
        const reward = definitionFor(row.prize_id);
        return {
          kind: "redeemed",
          code: row.code,
          prizeId: reward.prizeId,
          campaignId: reward.campaignId,
          displayName: reward.displayName,
          customerValue: reward.customerValue,
          wonAt: iso(row.won_at),
          redeemedAt: iso(row.redeemed_at!),
        };
      }

      const existingResult = await client.query<LedgerRow>(
        "SELECT win_id, prize_id, campaign_id, code, won_at, redeemed_at FROM spin_reward_code_ledger WHERE code = $1",
        [code],
      );
      const existing = existingResult.rows[0];
      await client.query("COMMIT");
      if (!existing) return { kind: "not_found" };
      const reward = definitionFor(existing.prize_id);
      return {
        kind: "already_used",
        code: existing.code,
        prizeId: reward.prizeId,
        campaignId: reward.campaignId,
        displayName: reward.displayName,
        customerValue: reward.customerValue,
        wonAt: iso(existing.won_at),
        redeemedAt: iso(existing.redeemed_at!),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Shared, atomic fixed-window limiter. bucketKey is a SHA-256 digest of an
   * already authenticated credential, never an IP address or raw secret.
   */
  async consumeRedemptionRateLimit(bucketKey: string): Promise<{
    allowed: boolean;
    retryAfterSeconds: number;
  }> {
    const result = await this.database.query<{ attempts: number | string; retry_after_seconds: number | string }>(
      `INSERT INTO spin_reward_rate_limits (bucket_key, window_started_at, attempts)
       VALUES ($1, now(), 1)
       ON CONFLICT (bucket_key) DO UPDATE
       SET attempts = CASE
             WHEN spin_reward_rate_limits.window_started_at <= now() - interval '1 minute' THEN 1
             ELSE spin_reward_rate_limits.attempts + 1
           END,
           window_started_at = CASE
             WHEN spin_reward_rate_limits.window_started_at <= now() - interval '1 minute' THEN now()
             ELSE spin_reward_rate_limits.window_started_at
           END
       RETURNING attempts,
         GREATEST(1, CEIL(EXTRACT(EPOCH FROM (
           window_started_at + interval '1 minute' - now()
         ))))::int AS retry_after_seconds`,
      [bucketKey],
    );
    const row = result.rows[0];
    if (!row) throw new SpinRewardsUnavailableError();
    return {
      allowed: Number(row.attempts) <= SPIN_REWARD_REDEEM_ATTEMPTS_PER_MINUTE,
      retryAfterSeconds: Math.max(1, Number(row.retry_after_seconds)),
    };
  }
}

export const spinRewards = new SpinRewardsService();
