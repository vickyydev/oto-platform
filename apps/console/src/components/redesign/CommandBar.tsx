import type { ReactNode } from 'react';
import { consoleNav, findSection } from '@/components/consoleSections';
import { cn } from '@/lib/utils';

/**
 * The top of every redesigned page (SCRUM-474): a breadcrumb line, the
 * section's icon on a coral tile, its title, and chips — beside the title for
 * what the page IS right now, on the right for what can be done or chosen.
 *
 * The icon and the title come from `consoleSections`, the same entry the
 * sidebar draws, so the two can never disagree about what a page is called.
 * The section's one-line description rides on the title as its tooltip and its
 * accessible description rather than as a paragraph: the artboards give that
 * line to the chips.
 */
export function CommandBar({
  sectionId,
  place,
  badges,
  actions,
  className,
}: {
  sectionId: string;
  /** The second half of the breadcrumb: a park when the page is about one. */
  place?: string | null;
  badges?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const section = findSection(sectionId);
  const group = consoleNav.find((g) => g.sections.some((s) => s.id === sectionId));
  if (!section) return null;
  const Icon = section.icon;
  const descriptionId = `section-${section.id}-about`;

  return (
    <header
      className={cn(
        'flex flex-wrap items-end justify-between gap-x-6 gap-y-3 min-h-[76px]',
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-[13px] font-medium text-muted-foreground">
          Console · {(place && placeName(place)) || group?.label || 'OTO'}
        </p>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-2">
          <span
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] bg-primary text-primary-foreground"
            aria-hidden="true"
          >
            <Icon className="w-6 h-6" strokeWidth={2.2} />
          </span>
          <h1
            className="m-0 text-[26px] @2xl:text-[30px] font-extrabold leading-tight tracking-[-0.02em]"
            title={section.description}
            aria-describedby={descriptionId}
          >
            {section.label}
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

/**
 * A park as the chrome says it: the part after the operator's own prefix, so
 * "Oto Play Park, Central Floresta" reads "Central Floresta" in a breadcrumb or
 * under the console's name. The full name stays where a park is the subject —
 * its card, a picker's options — and is what a search for it finds.
 */
export function placeName(name: string): string {
  const cut = name.lastIndexOf(',');
  const tail = cut >= 0 ? name.slice(cut + 1).trim() : '';
  return tail || name.trim();
}
