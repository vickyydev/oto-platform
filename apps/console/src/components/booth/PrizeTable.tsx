import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { formatTHB } from '@oto/shared';
import { ArchiveRestore, CircleSlash, Pencil } from 'lucide-react';
import { StatusPill } from '@/components/Status';
import { Button } from '@/components/ui/button';
import { formatWhen } from '@/lib/time';
import type { BoothArchivedPrize, BoothPrizeDraft, VoucherDefinitionRow } from './boothApi';
import { restoreRefusal } from './boothState';
import {
  chanceBpOf,
  expectedCostPerSpinSatang,
  expectedCostSatang,
  formatBp,
  formatGap,
  prizeCostSatang,
  uncostedActive,
  weightVerdict,
} from './odds';

/**
 * The prize list, with the arithmetic already done.
 *
 * This table is the reason the page exists. A manager opening it is about to
 * decide what a machine in a shopping centre gives away, and the three
 * questions they arrive with are "what are the odds", "do they add up" and
 * "what is this costing me" — none of which a list of basis points answers.
 *
 * So: weights are shown as the chance a child actually has, renormalised over
 * the prizes the box will draw from; the running total is stated in the footer
 * with the gap named in the units somebody has to type; and each row carries
 * its own share of the day's giveaway, because "14.5% of the spins and 61% of
 * the money" is the sentence a prize list is supposed to make visible.
 *
 * Nobody is asked to do the arithmetic. Basis points appear beside the
 * percentage rather than instead of it, since that is the number the editor
 * takes and the API validates.
 */
export function PrizeTable({
  prizes,
  /**
   * Spins on the booth's current trading day, from `GET /booths/:id/status`.
   * Null when it could not be read — in which case the money column is shown
   * per 100 spins and labelled as such, rather than quietly showing zero.
   */
  spinsToday,
  /** `booth.booth_prize.id` of prizes the box says have hit their cap today. */
  cappedToday,
  onEdit,
  disabled,
}: {
  prizes: readonly BoothPrizeDraft[];
  spinsToday: number | null;
  cappedToday: readonly string[];
  onEdit: (prize: BoothPrizeDraft) => void;
  disabled?: boolean;
}) {
  const verdict = weightVerdict(prizes);
  // A day with no spins yet is a real answer and a useless denominator, so the
  // money column falls back to a standard hundred and says which it is using.
  const basis = spinsToday && spinsToday > 0 ? spinsToday : 100;
  const basisIsReal = spinsToday !== null && spinsToday > 0;
  const uncosted = uncostedActive(prizes);

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto -mx-1 px-1">
        <table className="w-full text-sm border-collapse min-w-[38rem]">
          <thead>
            <tr className="text-left">
              <Th className="w-[38%]">Prize</Th>
              <Th className="text-right">Chance</Th>
              <Th className="text-right">Weight</Th>
              <Th className="text-right">Cost each</Th>
              <Th className="text-right">
                {basisIsReal ? `Cost at today’s ${basis} spins` : 'Cost per 100 spins'}
              </Th>
              <Th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {prizes.map((prize) => {
              const capped = cappedToday.includes(prize.id);
              return (
                <tr key={prize.id} className="border-t align-top">
                  <Td>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className={prize.active ? 'font-semibold' : 'font-semibold opacity-55'}>
                        {prize.nameEn}
                      </span>
                      {!prize.active && (
                        <StatusPill tone="idle">
                          <CircleSlash className="w-3 h-3 mr-1 inline-block" aria-hidden />
                          off the wheel
                        </StatusPill>
                      )}
                      {capped && <StatusPill tone="warn">at today’s cap</StatusPill>}
                      {!prize.voucherDefinitionId && prize.active && (
                        <StatusPill tone="down">no voucher</StatusPill>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground break-words">
                      {prize.nameTh ? `${prize.nameTh} · ` : ''}
                      {prize.wheelLabel ? `slice reads “${prize.wheelLabel.replace(/\n/g, ' / ')}”` : 'slice reads its English name'}
                      {prize.dailyCap !== null ? ` · ${prize.dailyCap} a day` : ''}
                    </p>
                  </Td>

                  {/*
                    The real chance, not the typed weight: switch a prize off
                    and every other row here moves, which is the whole point of
                    showing it. Inactive rows show a dash rather than 0%, so
                    "cannot be won" and "will practically never be won" do not
                    look the same.
                  */}
                  <Td className="text-right tabular-nums font-semibold">
                    {prize.active ? formatBp(chanceBpOf(prize, verdict)) : '—'}
                  </Td>
                  <Td className="text-right tabular-nums text-muted-foreground">
                    {prize.weightBp.toLocaleString()} bp
                  </Td>
                  <Td className="text-right tabular-nums">
                    {prize.costSatang === 0 ? (
                      <span className="text-muted-foreground">not costed</span>
                    ) : (
                      formatTHB(prize.costSatang)
                    )}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {prize.active && prize.costSatang > 0
                      ? formatTHB(prizeCostSatang(prize, verdict, basis))
                      : '—'}
                  </Td>
                  <Td className="text-right">
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onEdit(prize)}
                      className="rounded-md p-1.5 hover-elevate active-elevate-2 disabled:opacity-40"
                      aria-label={`Edit ${prize.nameEn}`}
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                  </Td>
                </tr>
              );
            })}
          </tbody>

          <tfoot>
            <tr className="border-t-2">
              <Td className="font-semibold">
                {verdict.activeCount} on the wheel
                {verdict.inactiveCount > 0 && `, ${verdict.inactiveCount} switched off`}
              </Td>
              <Td className="text-right">
                <TotalMark verdict={verdict} />
              </Td>
              <Td className="text-right tabular-nums font-semibold">
                {verdict.totalBp.toLocaleString()} bp
              </Td>
              <Td className="text-right tabular-nums text-muted-foreground">
                {formatTHB(expectedCostPerSpinSatang(prizes))} a spin
              </Td>
              <Td className="text-right tabular-nums font-semibold">
                {formatTHB(expectedCostSatang(prizes, basis))}
              </Td>
              <Td />
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        Chances are the weights renormalised across the prizes the box will draw from — active,
        under their daily cap and in stock. Caps and stock renormalise again during the day, on the
        box, so these are the wheel’s odds as the trading day starts.
        {uncosted > 0 &&
          ` ${uncosted} active prize${uncosted === 1 ? ' has' : 's have'} no cost recorded, so the money columns understate what the wheel gives away.`}
      </p>
    </div>
  );
}

/**
 * The slices archived off this booth, under "Show archived prizes" (SCRUM-468).
 *
 * Kept out of the table above on purpose: its footer is the wheel's total,
 * and a row the wheel will never carry sitting above "adds to 100%" would
 * read as part of it. So they are listed below, muted, each with the chip
 * that says what it is and the one action it takes.
 *
 * A restored prize comes back switched off, so the odds above do not move
 * until somebody switches it on in its editor and re-fits the chances — the
 * Publish panel refuses the wheel until they add to 100% again, as it does
 * for every edit. Restore is not offered for one whose voucher type is itself
 * archived; the line says which type and where it is brought back.
 */
export function ArchivedPrizes({
  prizes,
  definitions,
  timezone,
  onRestore,
  readOnly,
  busy,
}: {
  prizes: readonly BoothArchivedPrize[];
  /** The operator's voucher types, archived ones included, to say which a prize is waiting on. */
  definitions: readonly VoucherDefinitionRow[];
  timezone?: string | null;
  onRestore: (prize: BoothArchivedPrize) => void;
  /** The caller may not edit this booth: no Restore buttons at all. */
  readOnly?: boolean;
  /** A write is out: the buttons stay, closed until it settles. */
  busy?: boolean;
}) {
  if (prizes.length === 0) {
    return (
      <p className="py-2 text-sm text-muted-foreground">
        Nothing archived on this booth.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y rounded-xl border bg-muted/30" aria-label="Archived prizes">
        {prizes.map((prize) => {
          const refusal = restoreRefusal(prize, definitions);
          return (
            <li key={prize.id} className="px-3 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-semibold text-foreground/55 break-words">{prize.nameEn}</span>
                  <StatusPill tone="idle">archived</StatusPill>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground break-words">
                  {prize.nameTh ? `${prize.nameTh} · ` : ''}
                  {prize.voucherDefinitionCode ?? 'no voucher'} ·{' '}
                  {prize.weightBp.toLocaleString()} bp when it left ·{' '}
                  {prize.costSatang === 0 ? 'not costed' : `${formatTHB(prize.costSatang)} each`} ·
                  archived {formatWhen(prize.archivedAt, timezone)}
                </p>
                {refusal && (
                  <p className="mt-0.5 text-xs" style={{ color: 'hsl(var(--status-warn))' }}>
                    {refusal}{' '}
                    <Link href="/voucher-types" className="underline underline-offset-4">
                      Open Voucher types
                    </Link>
                  </p>
                )}
              </div>
              {!readOnly && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || refusal !== null}
                  onClick={() => onRestore(prize)}
                  aria-label={`Restore ${prize.nameEn}`}
                >
                  <ArchiveRestore className="w-4 h-4" />
                  Restore
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">
        A restored prize comes back switched off. Switch it on in its editor and re-fit the chances
        to 100% — a wheel is published only when the prizes switched on add up to exactly 100%.
      </p>
    </div>
  );
}

/** The running total, said as a verdict rather than left as a sum to check. */
function TotalMark({
  verdict,
}: {
  verdict: ReturnType<typeof weightVerdict>;
}) {
  if (verdict.activeCount === 0) {
    return <StatusPill tone="down">nothing on the wheel</StatusPill>;
  }
  if (verdict.balanced) {
    return <StatusPill tone="ok">adds to 100%</StatusPill>;
  }
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <StatusPill tone="down">{formatBp(verdict.totalBp)}</StatusPill>
      <span className="text-[11px] text-muted-foreground">{formatGap(verdict.differenceBp)}</span>
    </span>
  );
}

function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={`pb-2 text-[11px] font-semibold uppercase tracking-wide text-foreground/45 ${className ?? ''}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={`py-2.5 pr-3 ${className ?? ''}`}>{children}</td>;
}
