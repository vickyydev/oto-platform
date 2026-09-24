import { useState, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Panel, ErrorNote, RouteUnavailable } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { Field, TextInput } from '@/components/Form';
import { StatusPill } from '@/components/Status';
import { formatWhen } from '@/lib/time';
import type { BoothDraft } from './boothApi';
import { buildPublishPlan } from './publishPlan';
import { formatBp } from './odds';

/**
 * The last screen before a wheel in a shopping centre changes.
 *
 * A publish is not a save. The booths poll for a higher version about once a
 * minute and apply it whole, between spins, with nobody at the booth asked or
 * told — so this panel's job is to make the change legible while it can still
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
}: {
  draft: BoothDraft;
  publishing: boolean;
  /** The publish route is not on this deployment. */
  unavailable: boolean;
  error: string | null;
  /** What this panel last published, for the line after it succeeds. */
  lastPublished: { version: number } | null;
  timezone?: string | null;
  onPublish: (note: string, expectedBundleHash: string | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState('');
  const plan = buildPublishPlan(draft);
  const blocked = plan.blockers.length > 0;

  return (
    <Panel
      title="Publish"
      description="Freezes this draft as a new version. A booth runs the version it last pulled from the cloud, so publishing does not by itself change the wheel in the mall — “Wheel version” above says which one the booth is actually on."
      actions={
        draft.published ? (
          <StatusPill tone="idle">version {draft.published.version} published</StatusPill>
        ) : (
          <StatusPill tone="warn">never published</StatusPill>
        )
      }
    >
      {unavailable && (
        <RouteUnavailable
          what="Publishing"
          detail="The panel is built and the publish route is not deployed here yet — SCRUM-200. The refusals and the figures below come from the draft the API returned, so they are real; only the button is closed."
        />
      )}

      {error && <ErrorNote message={error} />}

      {lastPublished && (
        <p
          className="mt-3 rounded-xl border px-3.5 py-3 text-sm"
          style={{
            borderColor: 'hsl(var(--status-ok) / 0.4)',
            backgroundColor: 'hsl(var(--status-ok) / 0.07)',
          }}
        >
          Version {lastPublished.version} published. It is on the booth only once the box has pulled
          it — “Wheel version” in the panel above shows which version the booth is actually running,
          and that is the only reading that says it arrived.
        </p>
      )}

      {blocked ? (
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-sm font-semibold">
            This draft cannot be published yet — {plan.blockers.length} thing
            {plan.blockers.length === 1 ? '' : 's'} to fix
          </p>
          <ul className="flex flex-col gap-2">
            {plan.blockers.map((b) => (
              <li
                key={`${b.code}:${b.field}`}
                className="rounded-xl border px-3.5 py-3 text-sm flex gap-2.5"
                style={{
                  borderColor: 'hsl(var(--status-down) / 0.35)',
                  backgroundColor: 'hsl(var(--status-down) / 0.07)',
                }}
              >
                <TriangleAlert
                  className="w-4 h-4 shrink-0 mt-0.5"
                  style={{ color: 'hsl(var(--status-down))' }}
                />
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
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-sm">{plan.headline}</p>

          {plan.warnings.map((w) => (
            <p key={w} className="text-xs text-muted-foreground break-words">
              {w}
            </p>
          ))}

          {confirming && (
            <>
              <dl className="rounded-xl border divide-y">
                <Row label="On the wheel">
                  {plan.summary.activePrizes} prize{plan.summary.activePrizes === 1 ? '' : 's'}
                  {plan.summary.inactivePrizes > 0 &&
                    ` · ${plan.summary.inactivePrizes} switched off`}
                </Row>
                <Row label="Odds">
                  {plan.verdict.balanced
                    ? 'add to 100%'
                    : `add to ${formatBp(plan.verdict.totalBp)}`}
                </Row>
                <Row label="Design">{draft.settings.layoutName ?? 'none chosen'}</Row>
                <Row label="Who may spin">
                  {draft.settings.eligibility === 'none'
                    ? 'anybody at the booth'
                    : draft.settings.eligibility}
                </Row>
                <Row label="Cost">
                  {plan.summary.costPerSpin} a spin · {plan.summary.costPerHundred} per 100 spins
                </Row>
                <Row label="Staff sign-in">{sessionText(draft.settings.staffSessionMinutes ?? null)}</Row>
                <Row label="Slip wording">{wordingText(draft)}</Row>
                {draft.lastEditedAt && (
                  <Row label="Last edited">{formatWhen(draft.lastEditedAt, timezone)}</Row>
                )}
              </dl>

              {/*
                Stated rather than left for somebody to assume: the panel is
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

          <div className="flex flex-wrap gap-2 items-center">
            {confirming ? (
              <>
                <Button
                  onClick={() => onPublish(note, draft.bundleHash)}
                  disabled={publishing || unavailable}
                >
                  {publishing ? 'Publishing…' : `Publish version ${plan.nextVersion}`}
                </Button>
                <Button variant="outline" onClick={() => setConfirming(false)} disabled={publishing}>
                  Not yet
                </Button>
                <span className="text-xs text-muted-foreground">
                  This changes a machine in a public place.
                </span>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => setConfirming(true)} disabled={unavailable}>
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
    </Panel>
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

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="px-3.5 py-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-foreground/45 w-28 shrink-0">
        {label}
      </dt>
      <dd className="text-sm font-medium min-w-0 break-words">{children}</dd>
    </div>
  );
}
