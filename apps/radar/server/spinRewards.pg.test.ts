import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { SpinRewardsService } from "./spinRewards";

const { Pool } = pg;

async function run() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.log("spinRewards.pg.test: skipped (DATABASE_URL is not configured)");
    return;
  }

  // This schema is created only for this test and is removed in finally. The
  // service pool sees only it through startup search_path, never public.
  const schema = `spin_rewards_test_${process.pid}_${Date.now()}`;
  const admin = new Pool({ connectionString });
  const isolated = new Pool({
    connectionString,
    options: `-c search_path=${schema}`,
    max: 8,
  });
  const quotedSchema = `"${schema}"`;

  try {
    await admin.query(`CREATE SCHEMA ${quotedSchema}`);
    await isolated.query(`
      CREATE TABLE campaign_qrs (
        short_code text PRIMARY KEY,
        status text NOT NULL DEFAULT 'issued'
      )
    `);
    // This historical code must stay redeemable after it is reserved.
    await isolated.query("INSERT INTO campaign_qrs (short_code) VALUES ('1234')");

    const migration = await readFile(
      path.resolve(process.cwd(), "migrations/0010_spin_reward_codes.sql"),
      "utf8",
    );
    await isolated.query(migration);

    const reservation = await isolated.query<{ code: string }>(
      "SELECT code FROM spin_reward_legacy_code_reservations WHERE code = '1234'",
    );
    assert.equal(reservation.rows.length, 1, "historical numeric code is reserved");
    await isolated.query("UPDATE campaign_qrs SET status = 'redeemed' WHERE short_code = '1234'");
    await isolated.query("DELETE FROM campaign_qrs WHERE short_code = '1234'");
    const reservationAfterLegacyDelete = await isolated.query<{ code: string }>(
      "SELECT code FROM spin_reward_legacy_code_reservations WHERE code = '1234'",
    );
    assert.equal(reservationAfterLegacyDelete.rows.length, 1, "reservation survives legacy QR deletion");
    await assert.rejects(
      isolated.query("UPDATE spin_reward_legacy_code_reservations SET reserved_at = now() WHERE code = '1234'"),
      /reservations are immutable/,
    );
    await assert.rejects(
      isolated.query("DELETE FROM spin_reward_legacy_code_reservations WHERE code = '1234'"),
      /reservations are immutable/,
    );
    await assert.rejects(
      isolated.query("TRUNCATE spin_reward_legacy_code_reservations"),
      /reservations are immutable/,
    );
    await assert.rejects(
      isolated.query("INSERT INTO campaign_qrs (short_code) VALUES ('9999')"),
      /four digits only/,
      "future all-numeric legacy code is rejected",
    );

    // Running a migration body again neither duplicates seeds nor resets an
    // explicit later activation change.
    const mysteryBeforeActivation = await isolated.query<{ active: boolean }>(
      "SELECT active FROM spin_reward_campaigns WHERE prize_id = 'mystery-gift'",
    );
    assert.equal(mysteryBeforeActivation.rows[0]?.active, false, "Mystery Gift starts disabled");
    await isolated.query("UPDATE spin_reward_campaigns SET active = true WHERE prize_id = 'mystery-gift'");
    await isolated.query(migration);
    const campaigns = await isolated.query<{ count: string; active: boolean }>(
      `SELECT count(*)::text AS count, bool_or(active) AS active
       FROM spin_reward_campaigns WHERE prize_id = 'mystery-gift'`,
    );
    assert.deepEqual(campaigns.rows[0], { count: "1", active: true });

    const service = new SpinRewardsService(isolated as any);
    const wonAt = new Date(Date.now() - 1_000);
    const [first, second] = await Promise.all([
      service.issue({ winId: "different-prize-a", prizeId: "voucher-100", wonAt }),
      service.issue({ winId: "different-prize-b", prizeId: "voucher-150", wonAt }),
    ]);
    assert.equal(first.kind, "issued");
    assert.equal(second.kind, "issued");
    if (first.kind === "issued" && second.kind === "issued") {
      assert.notEqual(first.reward.code, second.reward.code, "concurrent prizes receive distinct codes");
    }

    const future = await service.issue({
      winId: "future-win",
      prizeId: "voucher-200",
      wonAt: new Date(Date.now() + 60_000),
    });
    assert.deepEqual(future, { kind: "invalid_won_at" });

    const oneCode = first.kind === "issued" ? first.reward.code : "";
    const redemptions = await Promise.all([service.redeem(oneCode), service.redeem(oneCode)]);
    assert.equal(redemptions.filter((result) => result.kind === "redeemed").length, 1);
    assert.equal(redemptions.filter((result) => result.kind === "already_used").length, 1);
    await assert.rejects(
      isolated.query("DELETE FROM spin_reward_code_ledger"),
      /cannot be removed/,
      "ledger deletes are prevented",
    );
    await assert.rejects(
      isolated.query("TRUNCATE spin_reward_code_ledger"),
      /cannot be removed/,
      "ledger truncation is prevented",
    );
    const limits = await Promise.all(
      Array.from({ length: 61 }, () => service.consumeRedemptionRateLimit("b".repeat(64))),
    );
    assert.equal(limits.filter((result) => result.allowed).length, 60, "shared database bucket allows 60 requests");
    assert.equal(limits.filter((result) => !result.allowed).length, 1, "61st shared database request is limited");
    assert(limits[60].retryAfterSeconds >= 1);
    console.log("spinRewards.pg.test: isolated PostgreSQL migration and concurrency checks passed");
  } finally {
    await isolated.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    await admin.end();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});