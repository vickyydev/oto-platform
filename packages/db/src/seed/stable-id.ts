import { createHash } from 'node:crypto';

/**
 * A DETERMINISTIC UUIDv7.
 *
 * The timestamp half is real — it is the moment the row stands for (the sale
 * rung up, the legacy day pulled) — so the ids sort in the order things
 * happened, which is what every id in this platform promises. The random half
 * is a hash of the key instead of being random, which is what makes a second
 * run of a seed a no-op rather than a second copy.
 *
 * Shared by the demo day (`demo-day.ts`) and the legacy fixture days
 * (`legacy-fixtures.ts`).
 */
export function stableId(key: string, at: Date): string {
  const ms = BigInt(at.getTime());
  const time = ms.toString(16).padStart(12, '0');
  const rand = createHash('sha256').update(key).digest('hex').slice(0, 20);
  // Version 7 in the 13th nibble; variant 0b10 in the 17th.
  const variant = ((parseInt(rand[4]!, 16) & 0b0011) | 0b1000).toString(16);
  return [
    time.slice(0, 8),
    time.slice(8, 12),
    `7${rand.slice(0, 3)}`,
    `${variant}${rand.slice(5, 8)}`,
    rand.slice(8, 20),
  ].join('-');
}
