import { pool } from "../db";

/**
 * Radar's own small settings: the revenue planner's per-branch, per-month
 * target and saved scenario, and the calendar's day notes. The tables come
 * from migration 0002_radar_settings.sql; nothing here creates one.
 */

/** Radar's branch keys are lower-case; an empty one meant Floresta in the export. */
function normalizeBranch(branch: string | undefined | null): string {
  const b = String(branch || "").trim().toLowerCase();
  return b || "floresta";
}

export async function getBranchSetting<T = unknown>(branch: string, key: string): Promise<T | null> {
  const res = await pool.query(`SELECT value FROM branch_settings WHERE branch = $1 AND key = $2`, [
    normalizeBranch(branch),
    key,
  ]);
  if (res.rows.length === 0) return null;
  return res.rows[0].value as T;
}

export async function setBranchSetting(branch: string, key: string, value: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO branch_settings (branch, key, value, updated_at)
     VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (branch, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [normalizeBranch(branch), key, JSON.stringify(value)],
  );
}

export async function getCalendarNotes(startDate: string, endDate: string): Promise<Record<string, string>> {
  const result = await pool.query(
    "SELECT date, note FROM calendar_notes WHERE date >= $1 AND date <= $2 AND note != ''",
    [startDate, endDate],
  );
  const notes: Record<string, string> = {};
  for (const row of result.rows) notes[row.date] = row.note;
  return notes;
}

export async function saveCalendarNote(date: string, note: string): Promise<void> {
  if (!note.trim()) {
    await pool.query("DELETE FROM calendar_notes WHERE date = $1", [date]);
    return;
  }
  await pool.query(
    `INSERT INTO calendar_notes (date, note, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (date) DO UPDATE SET note = $2, updated_at = NOW()`,
    [date, note.trim()],
  );
}
