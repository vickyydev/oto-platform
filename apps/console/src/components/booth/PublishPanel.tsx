import { useState } from 'react';
import { CloudUpload, TriangleAlert } from 'lucide-react';
import { boothSpinDurationSeconds } from '@oto/shared';
import { ErrorNote, RouteUnavailable } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { Field, TextInput } from '@/components/Form';
import { StatusChip } from '@/components/redesign/chips';
import { CardShell, FactLine, FactList } from '@/components/redesign/layout';
import { formatWhen } from '@/lib/time';
import type { BoothDraft } from './boothApi';
import { buildPublishPlan } from './publishPlan';
import { formatBp } from './odds';
import { slipSummary } from './voucherSlip';

/**
 * The last screen before a wheel in a shopping centre changes.
 *
 * A publish is not a save. The booths poll for a higher version about once a
 * minute and apply it whole, between spins, with nobody at the booth asked or
 * told — so this card's job is to make the change legible while it can still
 * be stopped.
 *
 * Two presses, and the first is what makes the summary appear: nobody reaches
 * the second one without having had the odds, the money and the refusals on
 * screen. And the draft's hash goes back with the publish, so a colleague's
 * edit made since this page was read is refused by the API rather than
 * published by somebody who never saw it — a confirmation screen that could be
 * showing stale numbers is not a confirmation of anything.
 */
export function PublishPanel({
  draft,
  publishing,
  unavailable,
  error,
  lastPublished,
  timezone,
  onPublish,
  id,
  className,
}: {
  draft: BoothDraft;
  publishing: boolean;
  /** The publish route is not on this deployment. */
  unavailable: boolean;
  error: string | null;
  /** What this card last published, for the line after it succeeds. */
  lastPublished: { version: number } | null;
  timezone?: string | null;
  onPublish: (note: string, expectedBundleHash: string | null) => void;
  id?: string;
  className?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState('');
  const plan = buildPublishPlan(draft);
  const blocked = plan.blockers.length > 0;
  const publishedSettings = (
    draft.publishedBundle as { settings?: { spinDurationSeconds?: number } } | null | undefined
  )?.settings;

  return (
    <CardShell
      id={id}
      className={className}
      icon={CloudUpload}
      title="Publish"
      badge={
        draft.published ? (
          <StatusChip tone="idle">version {draft.published.version} published</StatusChip>
        ) : (
          <StatusChip tone="warn">never published</StatusChip>
        )
      }
      note="freezes this draft as a new version — a booth runs the version it last pulled from the cloud, so publishing does not by itself change the wheel in the mall; The box says which version the booth is actually on"
    >
      {unavailable && (
        <RouteUnavailable
          what="Publishing"
          detail="The card is built and the publish route is not deployed here yet — SCRUM-200. The refusals and the figures below come from the draft the API returned, so they are real; only the button is closed."
        />
      )}

      {error && <ErrorNote message={error} />}

      {draft.published && (
        <p className="text-sm">
          Published spin duration: {boothSpinDurationSeconds(publishedSettings ?? {})} seconds.
        </p>
      )}

      {lastPublished && (
        <p className="rounded-[14px] border border-status-ok/30 bg-status-ok/12 px-3.5 py-3 text-sm">
          Version {lastPublished.version} published. It is on the booth only once the box has pulled
          it — “Wheel” on The box shows which version the booth is actually running, and that is
          the only reading that says it arrived.
        </p>
      )}

      {blocked ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold">
            This draft cannot be published yet — {plan.blockers.length} thing
            {plan.blockers.length === 1 ? '' : 's'} to fix
          </p>
          <ul className="flex flex-col gap-2">
            {plan.blockers.map((b) => (
              <li
                key={`${b.code}:${b.field}`}
                className="flex gap-2.5 rounded-[14px] border border-status-down/35 bg-status-down/12 px-3.5 py-3 text-sm"
              >
                <TriangleAlert className="mt-0.5 w-4 h-4 shrink-0 text-status-down" />
                <span className="min-w-0">
                  <span className="break-words">{b.message}</span>
                  <code className="ml-1.5 font-mono text-xs text-muted-foreground break-all">
                    {b.field}
                  </code>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Every refusal at once rather than one at a time — each attempt would otherwise spend a
            version number to find the next problem.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm">{plan.headline}</p>

          {plan.warnings.map((w) => (
            <p key={w} className="text-xs text-muted-foreground break-words">
              {w}
            </p>
          ))}

          {confirming && (
            <>
              <FactList>
                <FactLine label="On the wheel">
                  {plan.summary.activePrizes} prize{plan.summary.activePrizes === 1 ? '' : 's'}
                  {plan.summary.inactivePrizes > 0 &&
                    ` · ${plan.summary.inactivePrizes} switched off`}
                </FactLine>
                <FactLine label="Odds">
                  {plan.verdict.balanced ? 'add to 100%' : `add to ${formatBp(plan.verdict.totalBp)}`}
                </FactLine>
                <FactLine label="Design">{draft.settings.layoutName ?? 'none chosen'}</FactLine>
                <FactLine label="Who may spin">
                  {draft.settings.eligibility === 'none'
                    ? 'anybody at the booth'
                    : draft.settings.eligibility}
                </FactLine>
                <FactLine label="Cost">
                  {plan.summary.costPerSpin} a spin · {plan.summary.costPerHundred} per 100 spins
                </FactLine>
                <FactLine label="Staff sign-in">
                  {sessionText(draft.settings.staffSessionMinutes ?? null)}
                </FactLine>
                <FactLine label="Spin duration">
                  {boothSpinDurationSeconds(draft.settings)} seconds
                </FactLine>
                <FactLine label="Slip wording">{wordingText(draft)}</FactLine>
                {slipSummary(draft.settings) !== null && (
                  <FactLine label="Voucher slip">{slipSummary(draft.settings)}</FactLine>
                )}
                {draft.lastEditedAt && (
                  <FactLine label="Last edited">{formatWhen(draft.lastEditedAt, timezone)}</FactLine>
                )}
              </FactList>

              {/*
                Stated rather than left for somebody to assume: the card is
                not showing a before-and-after, because the draft route returns
                the last published version's hash and not its document.
              */}
              <p className="text-xs text-muted-foreground">
                {draft.published
                  ? `This is what version ${plan.nextVersion} will be. It is not a comparison with version ${draft.published.version} — that version’s own prize list is not something this screen can read back.`
                  : 'This is what version 1 will be.'}
              </p>

              <Field label="What changed" hint="Kept with the version and shown in its history.">
                <TextInput
                  value={note}
                  onChange={setNote}
                  maxLength={200}
                  placeholder="Raised the grand prize for the school holidays"
                />
              </Field>
            </>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {confirming ? (
              <>
                <Button
                  className="rounded-full px-4 font-bold"
                  onClick={() => onPublish(note, draft.bundleHash)}
                  disabled={publishing || unavailable}
                >
                  {publishing ? 'Publishing…' : `Publish version ${plan.nextVersion}`}
                </Button>
                <Button
                  variant="outline"
                  className="rounded-full px-4"
                  onClick={() => setConfirming(false)}
                  disabled={publishing}
                >
                  Not yet
                </Button>
                <span className="text-xs text-muted-foreground">
                  This changes a machine in a public place.
                </span>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  className="rounded-full border-primary px-4 font-bold text-primary-ink"
                  onClick={() => setConfirming(true)}
                  disabled={unavailable}
                >
                  Review and publish
                </Button>
                {!plan.changed && draft.published && (
                  <span className="text-xs text-muted-foreground">
                    Nothing differs from the published version.
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </CardShell>
  );
}

/** How long a staff sign-in lasts at the booth, as the confirmation says it (SCRUM-400). */
function sessionText(minutes: number | null): string {
  if (minutes === null) return 'lasts 12 hours (the default)';
  const hours = minutes / 60;
  return `lasts ${Number.isInteger(hours) ? hours : hours.toFixed(1)} hour${hours === 1 ? '' : 's'}`;
}

/**
 * Which voucher types this version carries the park's own words for — read
 * off the bundle about to be published, which carries them only for types
 * that have a title or an instruction (`slipWording` in `booth-admin.ts`).
 */
function wordingText(draft: BoothDraft): string {
  const bundle = draft.bundle as { voucherDefinitions?: unknown[] } | null;
  const worded = bundle?.voucherDefinitions?.length ?? 0;
  const types = new Set(
    draft.prizes.filter((p) => p.voucherDefinitionId).map((p) => p.voucherDefinitionId),
  ).size;
  if (worded === 0) return 'every slip prints the prize’s name and the standard line';
  return `the park’s own words for ${worded} of the ${types} voucher type${types === 1 ? '' : 's'} this booth’s prizes use`;
}
