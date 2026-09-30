import { CheckCircle2, Circle } from 'lucide-react';
import { Panel } from '@/components/Panel';
import { StatusPill } from '@/components/Status';
import type { BoothDraft, BoothStaffRow, BoothStatus } from './boothApi';
import { boothSetupSteps, wheelStanding } from './boothState';
import type { Read } from './readState';

/**
 * The top of a booth's page (SCRUM-468): which booth this is, where its wheel
 * stands — published, and whether the draft has moved since — and the setup
 * checklist, which stays the way into the page. Each step jumps to the part
 * of the page it is about, and the first step not done yet is marked as the
 * next one, so a manager opening a half-set-up booth reads where to go before
 * reading anything else.
 *
 * The ticks are `boothSetupSteps`, and a reading not in hand ticks nothing.
 */
export function BoothSetupChecklist({
  draft,
  status,
  staff,
}: {
  draft: Read<BoothDraft | null>;
  status: Read<BoothStatus | null>;
  staff: Read<BoothStaffRow[]>;
}) {
  const steps = boothSetupSteps(
    draft.state === 'read' ? draft.value : null,
    status.state === 'read' ? status.value : null,
    staff.state === 'read' ? staff.value : null,
  );
  const done = steps.filter((step) => step.done).length;
  const next = steps.find((step) => !step.done);
  const standing = draft.value ? wheelStanding(draft.value) : null;

  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground/45">
            Lucky Wheel booth
          </p>
          <h2 className="text-xl font-black tracking-tight break-words">
            {draft.value?.booth.name ?? 'Booth'}
          </h2>
        </div>
        {standing && (
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={standing.published.tone}>{standing.published.label}</StatusPill>
            {standing.draft && (
              <StatusPill tone={standing.draft.tone}>{standing.draft.label}</StatusPill>
            )}
          </div>
        )}
      </div>

      <div className="mt-5 border-t pt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-sm font-bold">Set up this booth</h3>
          <span className="text-xs font-semibold tabular-nums text-muted-foreground">
            {done} of {steps.length} done
          </span>
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Follow these steps in order. A tick confirms the latest saved settings shown on this page.
        </p>
        <div
          className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="Setup steps done"
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-valuenow={done}
        >
          <div
            className="h-full rounded-full transition-[width] duration-300"
            style={{
              width: `${(done / steps.length) * 100}%`,
              backgroundColor: 'hsl(var(--status-ok))',
            }}
          />
        </div>
        <ol className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {steps.map((step, index) => {
            const isNext = step.id === next?.id;
            return (
              <li key={step.id} className="min-w-0">
                <a
                  href={'#' + step.id}
                  aria-current={isNext ? 'step' : undefined}
                  className={`flex h-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-sm hover:bg-muted ${
                    step.done ? 'text-foreground/70' : 'font-medium'
                  } ${isNext ? 'border-primary/50 bg-primary/5' : ''}`}
                >
                  {step.done ? (
                    <CheckCircle2
                      className="w-4 h-4 shrink-0"
                      style={{ color: 'hsl(var(--status-ok))' }}
                      role="img"
                      aria-label="Complete"
                    />
                  ) : (
                    <Circle
                      className="w-4 h-4 shrink-0 text-foreground/35"
                      role="img"
                      aria-label="To do"
                    />
                  )}
                  <span className="min-w-0 break-words">
                    {index + 1}. {step.label}
                  </span>
                  {isNext && (
                    <span className="ml-auto shrink-0 text-[11px] font-semibold uppercase tracking-wide text-primary">
                      Next
                    </span>
                  )}
                </a>
              </li>
            );
          })}
        </ol>
      </div>
    </Panel>
  );
}
