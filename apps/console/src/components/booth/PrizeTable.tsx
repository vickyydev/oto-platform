import { Link } from 'wouter';
import { formatTHB } from '@oto/shared';
import { ArchiveRestore } from 'lucide-react';
import { StatusChip } from '@/components/redesign/chips';
import { Button } from '@/components/ui/button';
import { formatWhen } from '@/lib/time';
import { cn } from '@/lib/utils';
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
import { prizeInks } from './WheelPreview';

/**
 * The prize list, with the arithmetic already done.
 *
 * This table is the reason the page exists. A manager opening it is about to
 * decide what a machine in a shopping centre gives away, and the three
 * questions they arrive with are "what are the odds", "do they add up" and
 * "what is this costing me" — none of which a list of basis points answers.
 *
 * So: weights are shown as the chance a child actually has, renormalised over
 * the prizes the box will draw from, drawn as a bar in the prize's own wedge
 * colour beside the figure; the running total is stated under the rows with
 * the gap named in the units somebody has to type; and each row carries its
 * own share of the day's giveaway, because "14.5% of the spins and 61% of the
 * money" is the sentence a prize list is supposed to make visible.
 *
 * Laid out as the approved design draws it (SCRUM-474, Main.dc.html): five
 * columns — the prize with its colour, the odds, its stock, what it has given
 * away today, and its state — on the page's striped rows. Basis points went
 * into the editor, which is where they are typed; the row says the chance.
 *
 * **"Won today" is read off the day's spins, not guessed.** The API does not
 * count wins per prize, so the page counts them from the spins it holds — and
 * only while it holds the whole day. Past one page of spins the column says
 * so with a dash rather than a number that is really "of the newest fifty".
 */
export function PrizeTable({
  prizes,
  spinsToday,
  cappedToday,
  wonToday,
  onEdit,
  readOnly,
  busy,
}: {
  prizes: readonly BoothPrizeDraft[];
  /**
   * Spins on the booth's current trading day, from `GET /booths/:id/status`.
   * Null when it could not be read — in which case the money figures are
   * shown per 100 spins and labelled as such, rather than quietly showing zero.
   */
  spinsToday: number | null;
  /** `booth.booth_prize.id` of prizes the box says have hit their cap today. */
  cappedToday: readonly string[];
  /**
   * Wins today by prize id, counted from the day's spins — null while the
   * page does not hold the whole day, when the column draws a dash.
   */
  wonToday: ReadonlyMap<string, number> | null;
  onEdit: (prize: BoothPrizeDraft) => void;
  /** The caller may read the wheel but not change it: the names are not buttons. */
  readOnly?: boolean;
  /** A write is out: the names stay buttons, closed until it settles. */
  busy?: boolean;
}) {
  const verdict = weightVerdict(prizes);
  // A day with no spins yet is a real answer and a useless denominator, so the
  // money figures fall back to a standard hundred and say which they are using.
  const basis = spinsToday && spinsToday > 0 ? spinsToday : 100;
  const basisIsReal = spinsToday !== null && spinsToday > 0;
  const basisWords = basisIsReal ? `at today’s ${basis} spins` : 'per 100 spins';
  const uncosted = uncostedActive(prizes);
  const inks = prizeInks(prizes);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div role="table" aria-label="Prizes" className="flex min-w-0 flex-col gap-1">
        <div
          role="row"
          className={cn(
            'hidden gap-3.5 px-3 text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80',
            COLUMNS,
          )}
        >
          <span role="columnheader">Prize</span>
          <span role="columnheader">Odds</span>
          <span role="columnheader">Stock</span>
          <span role="columnheader" title={WON_TODAY_TITLE}>
            Won today
          </span>
          <span role="columnheader" className="@xl:text-right">
            State
          </span>
        </div>
        <div
          role="rowgroup"
          className="flex flex-col [&>*]:rounded-[12px] [&>*:nth-child(odd)]:bg-foreground/[0.025]"
        >
          {prizes.map((prize) => {
            const capped = cappedToday.includes(prize.id);
            const ink = inks.get(prize.id);
            const cost =
              prize.costSatang === 0
                ? 'not costed'
                : `${formatTHB(prize.costSatang)} each${
                    prize.active
                      ? ` · ${formatTHB(prizeCostSatang(prize, verdict, basis))} ${basisWords}`
                      : ''
                  }`;
            // The Thai name and the money. What the wedge itself reads is on
            // the wheel preview beside this card, drawn as the television
            // draws it, and in the editor — not repeated on every row.
            const sub = [prize.nameTh, cost]
              .filter((part): part is string => Boolean(part))
              .join(' · ');
            return (
              <div
                key={prize.id}
                role="row"
                className={cn(
                  'flex flex-wrap gap-x-3.5 gap-y-1.5 px-3 py-[11px] text-[13.5px]',
                  COLUMNS,
                  !prize.active && 'opacity-60',
                )}
              >
                <div
                  role="cell"
                  className="flex min-w-0 basis-full items-center gap-[11px] @xl:basis-auto"
                >
                  <Swatch ink={ink} faded={!prize.active} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {readOnly ? (
                        <span className="font-semibold break-words">{prize.nameEn}</span>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onEdit(prize)}
                          aria-label={`Edit ${prize.nameEn}`}
                          className="text-left font-semibold break-words hover:underline underline-offset-4 disabled:opacity-50"
                        >
                          {prize.nameEn}
                        </button>
                      )}
                      {!prize.voucherDefinitionId && prize.active && (
                        <StatusChip tone="down">no voucher</StatusChip>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground break-words">{sub}</p>
                  </div>
                </div>

                {/*
                  The real chance, not the typed weight: switch a prize off
                  and every other row here moves, which is the whole point of
                  showing it. Inactive rows show a dash rather than 0%, so
                  "cannot be won" and "will practically never be won" do not
                  look the same.
                */}
                <div
                  role="cell"
                  title="Odds"
                  className="flex basis-[118px] items-center gap-[9px] @xl:basis-auto"
                >
                  {prize.active ? (
                    <>
                      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                        <span
                          className="block h-full rounded-full"
                          style={{
                            width: `${chanceBpOf(prize, verdict) / 100}%`,
                            backgroundColor: ink,
                          }}
                        />
                      </span>
                      <span className="w-[3.1rem] shrink-0 text-[12.5px] font-semibold tabular-nums">
                        {formatBp(chanceBpOf(prize, verdict))}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>

                <div role="cell" title="Stock" className="text-[13px] text-muted-foreground">
                  {capped ? (
                    <StatusChip tone="warn">at cap</StatusChip>
                  ) : prize.dailyCap === null ? (
                    'no cap'
                  ) : (
                    `${prize.dailyCap} a day`
                  )}
                </div>

                <div role="cell" title="Won today" className="text-[13px] font-semibold tabular-nums">
                  {wonToday === null ? (
                    <span className="font-normal text-muted-foreground" title={WON_TODAY_TITLE}>
                      —
                    </span>
                  ) : (
                    (wonToday.get(prize.id) ?? 0)
                  )}
                </div>

                <div role="cell" title="State" className="@xl:justify-self-end">
                  {prize.active ? (
                    <StatusChip tone="ok">on the wheel</StatusChip>
                  ) : (
                    <StatusChip tone="idle">off the wheel</StatusChip>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-card-border px-3 pt-3 text-[13px]">
        <span className="font-semibold">
          {verdict.activeCount} on the wheel
          {verdict.inactiveCount > 0 && `, ${verdict.inactiveCount} switched off`}
        </span>
        <TotalMark verdict={verdict} />
        <span className="text-muted-foreground tabular-nums">
          {formatTHB(expectedCostPerSpinSatang(prizes))} a spin ·{' '}
          {formatTHB(expectedCostSatang(prizes, basis))} {basisWords}
        </span>
      </div>

      <p className="text-xs text-muted-foreground">
        Chances are the weights renormalised across the prizes the box will draw from — active,
        under their daily cap and in stock. Caps and stock renormalise again during the day, on the
        box, so these are the wheel’s odds as the trading day starts.
        {uncosted > 0 &&
          ` ${uncosted} active prize${uncosted === 1 ? ' has' : 's have'} no cost recorded, so the money figures understate what the wheel gives away.`}
      </p>
    </div>
  );
}

/**
 * The artboard's five columns, from the card's own width up. The four fixed
 * ones are cut to what their widest reading needs — the artboard drew the
 * sheet without the shell's sidebar, and on the page the card is a fifth
 * narrower than there, so every pixel they do not need is the prize's.
 */
const COLUMNS =
  '@xl:grid @xl:grid-cols-[minmax(0,1fr)_118px_84px_72px_112px] @xl:items-center';

const WON_TODAY_TITLE =
  'Counted from today’s spins, below, while the page holds the whole day. Past one page of spins the count is not on this page.';

/** The prize's colour: its wedge's, or nothing when it has no wedge and no colour of its own. */
function Swatch({ ink, faded }: { ink: string | undefined; faded: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="h-3 w-3 shrink-0 rounded-[4px] border border-foreground/20"
      style={{ backgroundColor: ink ?? 'transparent', opacity: faded ? 0.5 : 1 }}
    />
  );
}

/**
 * The slices archived off this booth, under "Show archived prizes" (SCRUM-468).
 *
 * Kept out of the table above on purpose: its total is the wheel's, and a row
 * the wheel will never carry sitting above "adds to 100%" would read as part
 * of it. So they are listed below, dimmed, each with the chip that says what
 * it is and the one action it takes.
 *
 * A restored prize comes back switched off, so the odds above do not move
 * until somebody switches it on in its editor and re-fits the chances — the
 * Publish card refuses the wheel until they add to 100% again, as it does
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
    return <p className="px-3 py-2 text-sm text-muted-foreground">Nothing archived on this booth.</p>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ul
        className="flex flex-col [&>*]:rounded-[12px] [&>*:nth-child(odd)]:bg-foreground/[0.025]"
        aria-label="Archived prizes"
      >
        {prizes.map((prize) => {
          const refusal = restoreRefusal(prize, definitions);
          return (
            <li
              key={prize.id}
              className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 px-3 py-[11px] text-[13.5px]"
            >
              <div className="flex min-w-0 flex-1 basis-[240px] items-center gap-[11px] opacity-60">
                <Swatch ink={prize.sliceColor ?? undefined} faded />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-semibold break-words">{prize.nameEn}</span>
                    <StatusChip tone="idle">archived</StatusChip>
                  </div>
                  <p className="text-xs text-muted-foreground break-words">
                    {prize.nameTh ? `${prize.nameTh} · ` : ''}
                    {prize.voucherDefinitionCode ?? 'no voucher'} ·{' '}
                    {prize.weightBp.toLocaleString()} bp when it left ·{' '}
                    {prize.costSatang === 0 ? 'not costed' : `${formatTHB(prize.costSatang)} each`} ·
                    archived {formatWhen(prize.archivedAt, timezone)}
                  </p>
                </div>
              </div>
              {refusal && (
                <p className="basis-full text-xs text-status-warn @xl:basis-auto @xl:flex-1">
                  {refusal}{' '}
                  <Link href="/voucher-types" className="underline underline-offset-4">
                    Open Voucher types
                  </Link>
                </p>
              )}
              {!readOnly && (
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto rounded-full bg-card px-3.5"
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
function TotalMark({ verdict }: { verdict: ReturnType<typeof weightVerdict> }) {
  if (verdict.activeCount === 0) {
    return <StatusChip tone="down">nothing on the wheel</StatusChip>;
  }
  if (verdict.balanced) {
    return <StatusChip tone="ok">adds to 100%</StatusChip>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatusChip tone="down">adds to {formatBp(verdict.totalBp)}</StatusChip>
      <span className="text-[12.5px] text-muted-foreground">{formatGap(verdict.differenceBp)}</span>
    </span>
  );
}
