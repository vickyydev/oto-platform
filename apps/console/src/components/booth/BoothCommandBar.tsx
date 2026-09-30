import type { ReactNode } from 'react';
import { consoleNav, findSection } from '@/components/consoleSections';
import { placeName } from '@/components/redesign/CommandBar';

/**
 * The top of the Booths page (SCRUM-474, Main.dc.html).
 *
 * Every other redesigned page draws `redesign/CommandBar`: the section's icon
 * and name as the title, "Console · <park>" over it. The booth artboard is the
 * one that does not — its title is the BOOTH's name, and the section moves up
 * into the breadcrumb ("Booths · Central Floresta", then "Booth 1"), because
 * a page about one machine in a mall is headed by that machine. Only this page
 * needs that, so it is drawn here rather than added as an option to the shared
 * bar (the redesign's rule: a shared piece is extended when two pages need
 * it). The classes are the shared bar's, line for line, so the two bars stay
 * one design: a change there is a change here.
 *
 * Until a booth is selected the title is the section's, which is also what a
 * reader — and the end-to-end set — looks for on arriving at the page.
 */
export function BoothCommandBar({
  title,
  place,
  badges,
  actions,
}: {
  /** The selected booth's name, or null before one is on screen. */
  title: string | null;
  /** The second half of the breadcrumb: the park the booth is at. */
  place?: string | null;
  badges?: ReactNode;
  actions?: ReactNode;
}) {
  const section = findSection('booths');
  const group = consoleNav.find((g) => g.sections.some((s) => s.id === 'booths'));
  if (!section) return null;
  const Icon = section.icon;
  const descriptionId = `section-${section.id}-about`;

  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 min-h-[76px]">
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-[13px] font-medium text-muted-foreground">
          {section.label} · {(place && placeName(place)) || group?.label || 'OTO'}
        </p>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-2">
          <span
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] bg-primary text-primary-foreground"
            aria-hidden="true"
          >
            <Icon className="w-6 h-6" strokeWidth={2.2} />
          </span>
          <h1
            className="m-0 min-w-0 text-[26px] @2xl:text-[30px] font-extrabold leading-tight tracking-[-0.02em] break-words"
            title={section.description}
            aria-describedby={descriptionId}
          >
            {title ?? section.label}
          </h1>
          <span id={descriptionId} className="sr-only">
            {section.description}
          </span>
          {badges}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 pb-0.5">{actions}</div>}
    </header>
  );
}
