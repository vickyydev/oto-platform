import { CheckCircle2, Circle, ListChecks } from 'lucide-react';
import { TitleChip } from '@/components/redesign/chips';
import { CardShell } from '@/components/redesign/layout';
import { cn } from '@/lib/utils';
import type { SetupStep } from './boothState';

/**
 * "Set up this booth" (SCRUM-468): the six steps in the order a booth is set
 * up, each jumping to the part of the page it is about, with the first step
 * not done yet marked as the next one — so a manager opening a half-set-up
 * booth reads where to go before reading anything else.
 *
 * On the approved sheet (SCRUM-474) the booth's name and where its wheel
 * stands moved up into the command bar, and this became a card of its own
 * across the sheet, opened while a step is still to do and folded into the
 * bar's "Setup" chip once every step is done. The ticks are `boothSetupSteps`,
 * computed by the page; a reading not in hand ticks nothing.
 */
export function BoothSetupChecklist({ steps, id }: { steps: readonly SetupStep[]; id?: string }) {
  const done = steps.filter((step) => step.done).length;
  const next = steps.find((step) => !step.done);

  return (
    <CardShell
      id={id}
      span={12}
      icon={ListChecks}
      title="Set up this booth"
      badge={
        <TitleChip>
          {done} of {steps.length} done
        </TitleChip>
      }
      note="follow these steps in order — a tick confirms the latest saved settings shown on this page"
    >
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="Setup steps done"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={done}
      >
        <div
          className="h-full rounded-full bg-status-ok transition-[width] duration-300"
          style={{ width: `${(done / Math.max(steps.length, 1)) * 100}%` }}
        />
      </div>
      <ol className="grid gap-2 @md:grid-cols-2 @3xl:grid-cols-3">
        {steps.map((step, index) => {
          const isNext = step.id === next?.id;
          return (
            <li key={step.id} className="min-w-0">
              <a
                href={'#' + step.id}
                aria-current={isNext ? 'step' : undefined}
                className={cn(
                  'flex h-full items-center gap-2.5 rounded-[14px] border px-3 py-2.5 text-sm hover:bg-foreground/5',
                  step.done ? 'border-border text-foreground/70' : 'border-border font-medium',
                  isNext && 'border-primary/30 bg-primary/10',
                )}
              >
                {step.done ? (
                  <CheckCircle2
                    className="w-4 h-4 shrink-0 text-status-ok"
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
                  <span className="ml-auto shrink-0 text-[11px] font-semibold uppercase tracking-wide text-primary-ink">
                    Next
                  </span>
                )}
              </a>
            </li>
          );
        })}
      </ol>
    </CardShell>
  );
}
