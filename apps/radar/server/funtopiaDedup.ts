export interface VersionedOrderRow {
  order_id: string | number;
  id?: string | number | null;
  synced_at?: string | Date | null;
}

export interface VersionedPaymentRow extends VersionedOrderRow {
  payment_at?: string | null;
  pay_amount?: string | number | null;
  pay_method?: string | null;
  raw_json?: unknown;
}

function versionOf(row: { id?: string | number | null; synced_at?: string | Date | null }): [number, number] {
  const syncedAt = row.synced_at ? new Date(row.synced_at).getTime() : 0;
  const id = Number(row.id ?? 0);
  return [
    Number.isFinite(syncedAt) ? syncedAt : 0,
    Number.isFinite(id) ? id : 0,
  ];
}

function isAtLeastAsNew(candidate: VersionedOrderRow, current: VersionedOrderRow): boolean {
  const [candidateSyncedAt, candidateId] = versionOf(candidate);
  const [currentSyncedAt, currentId] = versionOf(current);
  return candidateSyncedAt > currentSyncedAt
    || (candidateSyncedAt === currentSyncedAt && candidateId >= currentId);
}

/**
 * Keeps one latest row per Pisell order id while preserving the first-seen
 * order of the keys. This is a read-path safety net for historical rows that
 * may have been inserted by two overlapping sync processes.
 */
export function latestOrderRows<T extends VersionedOrderRow>(
  rows: T[],
): { rows: T[]; dropped: number } {
  const latest = new Map<string, T>();
  let unkeyed = 0;

  for (const row of rows) {
    const orderId = String(row.order_id ?? "").trim();
    const key = orderId || `__unkeyed_${unkeyed++}`;
    const current = latest.get(key);
    if (!current || isAtLeastAsNew(row, current)) latest.set(key, row);
  }

  return {
    rows: [...latest.values()],
    dropped: rows.length - latest.size,
  };
}

function parsedRawJson(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function paymentKey(row: VersionedPaymentRow): string | null {
  const raw = parsedRawJson(row.raw_json);
  const pisellId = raw.id ?? raw.payment_id;
  if (pisellId != null && String(pisellId).trim()) return `id:${String(pisellId)}`;
  return null;
}

/** Keeps the latest stored version of each real Pisell payment. */
export function latestPaymentRows<T extends VersionedPaymentRow>(
  rows: T[],
): { rows: T[]; dropped: number } {
  const latest = new Map<string, T>();
  rows.forEach((row, index) => {
    // Pisell ids are stable across snapshots. If an old row has no Pisell id,
    // preserve it: amount/method/time is not guaranteed to identify a payment
    // and two legitimate payments can share those values.
    const key = paymentKey(row) ?? `unkeyed:${String(row.id ?? index)}`;
    const current = latest.get(key);
    if (!current || isAtLeastAsNew(row, current)) latest.set(key, row);
  });
  return {
    rows: [...latest.values()],
    dropped: rows.length - latest.size,
  };
}