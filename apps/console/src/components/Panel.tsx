import type { ReactNode } from 'react';
import { Loader2, Lock, PlugZap, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

/** The card every list, table and group on these pages sits in. */
export function Panel({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: string;
  description?: string;
  /** Controls that belong to this panel, aligned to the right of its title. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn('rounded-2xl border bg-card/80 backdrop-blur-sm shadow-sm p-4 sm:p-5', className)}
    >
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            {title && <h2 className="text-base font-bold tracking-tight">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
      <Loader2 className="w-4 h-4 animate-spin" /> Loading {what}…
    </p>
  );
}

/** Nothing to show, and that is the good outcome — said so, rather than blank. */
export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="rounded-xl border border-dashed px-4 py-8 text-center">
      <p className="font-semibold">{title}</p>
      {detail && <p className="mt-1 text-sm text-muted-foreground">{detail}</p>}
    </div>
  );
}

/** A real failure on this page. Distinct from the two "expected absences" below. */
export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      className="rounded-xl border px-4 py-3 text-sm flex flex-wrap items-center gap-x-3 gap-y-2"
      style={{
        color: 'hsl(var(--status-down))',
        borderColor: 'hsl(var(--status-down) / 0.35)',
        backgroundColor: 'hsl(var(--status-down) / 0.08)',
      }}
    >
      <TriangleAlert className="w-4 h-4 shrink-0" />
      <span className="flex-1 min-w-0">{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="font-semibold underline underline-offset-4">
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * The route this panel reads is not on this deployment yet.
 *
 * Said plainly, because the alternative is worse in both directions: an empty
 * list reads as "nothing is failing", and an error banner reads as "the
 * platform is broken". Neither is true — the API half of this ticket simply has
 * not shipped to this environment.
 */
export function RouteUnavailable({ what, detail }: { what: string; detail?: string }) {
  return (
    <div className="rounded-xl border border-dashed px-4 py-8 text-center">
      <PlugZap className="w-5 h-5 mx-auto mb-2 text-muted-foreground" />
      <p className="font-semibold">{what} is not on this deployment yet</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {detail ?? 'The page is ready and will fill in as soon as the API route is deployed here.'}
      </p>
    </div>
  );
}

/** Reached by typing the address; the nav would not have offered it. */
export function PermissionRequired({ permission }: { permission: string }) {
  return (
    <div className="rounded-xl border border-dashed px-4 py-10 text-center">
      <Lock className="w-5 h-5 mx-auto mb-2 text-muted-foreground" />
      <p className="font-semibold">This page is not on your access</p>
      <p className="mt-1 text-sm text-muted-foreground">
        It needs <code className="font-mono text-xs">{permission}</code>. A manager can grant it from
        the Login Users panel.
      </p>
    </div>
  );
}

/** A label above a value, used wherever a record is laid out as facts. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-foreground/45">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium break-words">{children}</dd>
    </div>
  );
}
