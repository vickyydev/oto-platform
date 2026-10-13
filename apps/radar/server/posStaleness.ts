import { pool } from "./db";

// task-171: detect a POS that stopped uploading orders mid-day.
//
// Aug 2-3, 2026: the Floresta POS lost connectivity to Pisell's cloud at
// ~13:00 and the dashboard silently showed low revenue for over a day.
// Sync health stayed "clean" because the app faithfully synced what the
// cloud had — the gap was upstream (POS → cloud). This module checks, per
// branch, how old today's latest order is and flags the branch as stale
// when the gap exceeds STALE_THRESHOLD_MINUTES during opening hours.
//
// False-alarm guards:
// - No alert before openHour + threshold (park may legitimately have no
//   orders in the first ~2h of a slow morning).
// - No alert after closeHour (no new orders expected after closing).
// - All times computed as Bangkok wall-clock.

export const STALE_THRESHOLD_MINUTES = 120;

export interface BranchHoursConfig {
  branch: "floresta" | "chalong";
  label: string;
  posName: string;
  openHour: number; // Bangkok hour, inclusive
  closeHour: number; // Bangkok hour — no alerts at/after this hour
}

// Both parks operate 10:00–20:00 (pre-opening staff/test orders can appear
// earlier in the data, but the alert window is based on published hours).
export const BRANCH_CONFIG: BranchHoursConfig[] = [
  { branch: "floresta", label: "Floresta", posName: "Floresta POS (Pisell)", openHour: 10, closeHour: 20 },
  { branch: "chalong", label: "Chalong", posName: "Chalong POS (Papaya)", openHour: 10, closeHour: 20 },
];

export interface PosStalenessAlert {
  branch: string;
  branchLabel: string;
  stale: boolean;
  lastOrderAt: string | null; // "HH:MM" Bangkok, null if no orders today
  minutesSinceLastOrder: number | null;
  message: string;
}

function bangkokNow(): { date: string; minutes: number } {
  const bkk = new Date(Date.now() + 7 * 3600 * 1000);
  const date = `${bkk.getUTCFullYear()}-${String(bkk.getUTCMonth() + 1).padStart(2, "0")}-${String(bkk.getUTCDate()).padStart(2, "0")}`;
  return { date, minutes: bkk.getUTCHours() * 60 + bkk.getUTCMinutes() };
}

// Latest order time today per branch, as minutes-since-midnight Bangkok.
// Floresta: funtopia_raw_orders.created_at is Bangkok wall time in
// 'DD/Mon/YYYY HH24:MI:SS' text form. Chalong: papaya_orders.order_date is
// a proper timestamptz.
async function latestOrderMinutes(branch: "floresta" | "chalong", today: string): Promise<number | null> {
  if (branch === "floresta") {
    const r = await pool.query(
      `SELECT to_char(MAX(to_timestamp(created_at, 'DD/Mon/YYYY HH24:MI:SS')), 'HH24:MI') AS t
       FROM funtopia_raw_orders
       WHERE order_date = $1 AND created_at IS NOT NULL AND created_at <> ''`,
      [today],
    );
    const t = r.rows[0]?.t as string | null;
    if (!t) return null;
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  }
  const r = await pool.query(
    `SELECT to_char(MAX(order_date AT TIME ZONE 'Asia/Bangkok'), 'HH24:MI') AS t
     FROM papaya_orders
     WHERE (order_date AT TIME ZONE 'Asia/Bangkok')::date = $1::date`,
    [today],
  );
  const t = r.rows[0]?.t as string | null;
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function fmtHM(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// Pure staleness decision — no DB, no clock — so it can be unit-tested.
// `nowMin` = current Bangkok minutes-since-midnight; `lastMin` = today's
// latest order in the same unit, or null when no orders exist yet today.
export function evaluateStaleness(
  cfg: Pick<BranchHoursConfig, "openHour" | "closeHour">,
  nowMin: number,
  lastMin: number | null,
  thresholdMin: number = STALE_THRESHOLD_MINUTES,
): boolean {
  const openMin = cfg.openHour * 60;
  const closeMin = cfg.closeHour * 60;
  // Only alert during opening hours, and never within the first
  // threshold window after opening (or before opening / after closing).
  const inAlertWindow = nowMin >= openMin + thresholdMin && nowMin < closeMin;
  if (!inAlertWindow) return false;
  // Gap is measured from the later of (last order, opening time) so a
  // zero-order morning still trips the alert once open + threshold passes.
  const effectiveLast = Math.max(lastMin ?? openMin, openMin);
  return nowMin - effectiveLast >= thresholdMin;
}

export async function getPosStalenessAlerts(): Promise<{ checkedAt: string; alerts: PosStalenessAlert[] }> {
  const { date: today, minutes: now } = bangkokNow();
  const alerts: PosStalenessAlert[] = [];

  for (const cfg of BRANCH_CONFIG) {
    let lastMin: number | null = null;
    try {
      lastMin = await latestOrderMinutes(cfg.branch, today);
    } catch (e: any) {
      console.error(`[PosStaleness] ${cfg.branch} query failed: ${e.message}`);
      continue; // don't fabricate an alert on a DB error
    }

    const lastOrderAt = lastMin != null ? fmtHM(lastMin) : null;
    const minutesSince = lastMin != null ? now - lastMin : null;

    const stale = evaluateStaleness(cfg, now, lastMin);

    let message = "";
    if (stale) {
      message =
        lastOrderAt != null
          ? `${cfg.posName} may have stopped uploading — last order at ${lastOrderAt}`
          : `${cfg.posName} may have stopped uploading — no orders recorded yet today`;
    }

    alerts.push({
      branch: cfg.branch,
      branchLabel: cfg.label,
      stale,
      lastOrderAt,
      minutesSinceLastOrder: minutesSince,
      message,
    });
  }

  return { checkedAt: new Date().toISOString(), alerts };
}
