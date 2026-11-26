import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { band, sale, saleExtensionBand, saleLine, ticketPackage } from '@oto/db';
import { bandValidUntil, readGuestLanguage, type BandGateDetails } from '@oto/shared';
import type { Exec } from './tx';

type BandRow = typeof band.$inferSelect;

/**
 * SCRUM-68 — the `bands` scope's rows with what the gate shows and checks:
 * the ticket's name, the stay label, and `validUntil`, computed with
 * the band print's own rule (`bandValidUntil` in `@oto/shared`): the sale's
 * close (else when it was rung up), plus the line's stay hours, plus the
 * extra play applied to THAT band and not taken back (SCRUM-861, as
 * `sale-printing.ts` reads it for the paper).
 *
 * Computed on every read, so an Add time on the till reaches the box on its
 * next pull of the scope. Fields are added beside the band row, never in
 * place of one: an older box ignores them.
 *
 * SCRUM-1077 — and the language the guest chose at the till for the band's
 * sale (`pos.sale.guest_language`), null when nobody chose, so the gate shows
 * that guest's messages in it. Wording only: the gate's decision never reads it.
 */
export async function withBandGateDetails(
  db: Exec,
  rows: readonly BandRow[],
): Promise<Array<BandRow & BandGateDetails>> {
  if (rows.length === 0) return [];
  const lineIds = [...new Set(rows.flatMap((r) => (r.saleLineId ? [r.saleLineId] : [])))];
  const saleIds = [...new Set(rows.flatMap((r) => (r.saleId ? [r.saleId] : [])))];
  // A ticket unit's own label is its component ("Adults", "Kids"): the
  // ticket's name is its package's, and the unit's label stands in only for
  // a line sold from no package.
  const lines = lineIds.length
    ? await db
        .select({
          id: saleLine.id,
          label: saleLine.label,
          packageName: ticketPackage.name,
          stayHours: saleLine.stayHours,
          stayDurationLabel: saleLine.stayDurationLabel,
        })
        .from(saleLine)
        .leftJoin(ticketPackage, eq(ticketPackage.id, saleLine.ticketPackageId))
        .where(inArray(saleLine.id, lineIds))
    : [];
  const sales = saleIds.length
    ? await db
        .select({
          id: sale.id,
          finalisedAt: sale.finalisedAt,
          occurredAt: sale.occurredAt,
          guestLanguage: sale.guestLanguage,
        })
        .from(sale)
        .where(inArray(sale.id, saleIds))
    : [];
  const extra = await db
    .select({ bandId: saleExtensionBand.bandId, minutes: saleExtensionBand.minutesAdded })
    .from(saleExtensionBand)
    .where(
      and(
        inArray(
          saleExtensionBand.bandId,
          rows.map((r) => r.id),
        ),
        isNotNull(saleExtensionBand.appliedAt),
        isNull(saleExtensionBand.revokedAt),
      ),
    );
  const lineOf = new Map(lines.map((l) => [l.id, l]));
  const startOf = new Map(sales.map((s) => [s.id, s.finalisedAt ?? s.occurredAt]));
  const languageOf = new Map(sales.map((s) => [s.id, readGuestLanguage(s.guestLanguage)]));
  const extraOf = new Map<string, number>();
  for (const e of extra) extraOf.set(e.bandId, (extraOf.get(e.bandId) ?? 0) + e.minutes);

  return rows.map((r) => {
    const line = r.saleLineId ? lineOf.get(r.saleLineId) : undefined;
    const start = r.saleId ? startOf.get(r.saleId) : undefined;
    const until = line && start ? bandValidUntil(start, line.stayHours, extraOf.get(r.id)) : null;
    const stayLabel =
      line?.stayDurationLabel ??
      (line?.stayHours && line.stayHours > 0 ? `${line.stayHours} hours` : null);
    return {
      ...r,
      ticketLabel: line ? (line.packageName ?? line.label) : null,
      stayLabel,
      validUntil: until ? until.toISOString() : null,
      guestLanguage: r.saleId ? (languageOf.get(r.saleId) ?? null) : null,
    };
  });
}
