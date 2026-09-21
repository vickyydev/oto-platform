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
 * A list that could NOT be read — which is a different thing from a list with
 * nothing in it, and must never be dressed as one.
 *
 * "No simulated printer on this box" is a claim about the park's equipment.
 * Saying it because a request failed sends somebody to a counter to look at a
 * box that is working. This says what actually happened instead: the request,
 * not the box, is what came back empty.
 */
export function Unreadable({
  what,
  message,
  onRetry,
}: {
  /** The list, named as the reader thinks of it: "This box's devices". */
  what: string;
  message?: string | null;
  onRetry?: () => void;
}) {
  return (
    <div
      className="rounded-xl border border-dashed px-4 py-8 text-center"
      style={{
        borderColor: 'hsl(var(--status-warn) / 0.45)',
        backgroundColor: 'hsl(var(--status-warn) / 0.07)',
      }}
    >
      <TriangleAlert className="w-5 h-5 mx-auto mb-2" style={{ color: 'hsl(var(--status-warn))' }} />
      <p className="font-semibold">{what} could not be read</p>
      <p className="mt-1 text-sm text-muted-foreground break-words">
        {message ? `${message} ` : ''}That is a request that did not answer, not a fact about this
        box — it may have everything it had a minute ago.
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 text-sm font-semibold underline underline-offset-4"
        >
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * What is on screen was read earlier and the last refresh failed.
 *
 * Kept rather than dropped, because an older true list beats a confident empty
 * one — but only while it is labelled as old, which is what this is for.
 */
export function StaleNote({
  readAt,
  message,
  onRetry,
}: {
  /** When what is on screen was actually read. */
  readAt: number;
  message?: string | null;
  onRetry?: () => void;
}) {
  /**
   * A clock time rather than "read 5s ago".
   *
   * A relative age is computed once, at render, and this note sits in a drawer
   * somebody leaves open — so "5s ago" would still say 5s ago two minutes
   * later, which is the same kind of confident wrong sentence the note exists
   * to prevent. A clock time is true for as long as it is on screen.
   */
  const at = new Date(readAt).toLocaleTimeString();
  // The message is a sentence from the API or the fetch and usually ends in a
  // full stop; this sentence ends in one too, and two of them read as a typo.
  const reason = message?.trim().replace(/\.+$/, '');
  return (
    <p
      className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2 text-xs"
      style={{
        borderColor: 'hsl(var(--status-warn) / 0.4)',
        backgroundColor: 'hsl(var(--status-warn) / 0.07)',
      }}
    >
      <TriangleAlert className="w-3.5 h-3.5 shrink-0" style={{ color: 'hsl(var(--status-warn))' }} />
      <span className="min-w-0 break-words">
        Shown as it was read at {at}; the refresh since has failed
        {reason ? ` — ${reason}` : ''}.
      </span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="font-semibold underline underline-offset-4"
        >
          Try again
        </button>
      )}
    </p>
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
