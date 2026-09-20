import { Link } from 'wouter';
import { ArrowLeft, ExternalLink, Hammer } from 'lucide-react';
import { Backdrop } from '@/components/Backdrop';
import { SuiteHeader } from '@/components/SuiteHeader';
import { Button } from '@/components/ui/button';
import { findApp } from '@/suite/apps';
import { useSession, displayName } from '@/auth/SessionContext';

/**
 * What a tile opens while its app is still being built. It is a real page in
 * the suite's own language rather than a dead tile: it names the app, what it
 * will do, who is signed in, and when it arrives — and, where the park still
 * runs something that does this job today, it links to that instead.
 */
export function ComingSoon({ appKey }: { appKey: string }) {
  const { me, has } = useSession();
  const app = findApp(appKey);

  if (!app || !has(app.permission) || (app.alsoRequires && !has(app.alsoRequires))) {
    return (
      <div className="min-h-[100dvh] flex flex-col">
        <Backdrop />
        <SuiteHeader />
        <main className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <h1 className="text-2xl font-black tracking-tight">Nothing here</h1>
          <p className="text-foreground/60">That app is not one you can open.</p>
          <Link href="/">
            <Button variant="outline" className="gap-2">
              <ArrowLeft className="w-4 h-4" /> Back to the suite
            </Button>
          </Link>
        </main>
      </div>
    );
  }

  const Icon = app.icon;

  return (
    <div className="min-h-[100dvh] flex flex-col">
      <Backdrop />
      <SuiteHeader />

      <main className="flex-1 w-full max-w-2xl mx-auto px-4 sm:px-6 py-10 sm:py-16">
        <div className="rounded-[1.75rem] border bg-card/80 backdrop-blur-sm shadow-xl p-6 sm:p-10 text-center">
          <span className="mx-auto w-20 h-20 rounded-[1.5rem] bg-muted text-muted-foreground flex items-center justify-center">
            <Icon className="w-10 h-10" />
          </span>
          <span className="mt-6 inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-400/10 px-3 py-1 text-xs font-semibold text-amber-600 dark:text-amber-300">
            <Hammer className="w-3.5 h-3.5" />
            Coming soon
          </span>
          <h1 className="mt-4 text-3xl sm:text-4xl font-black tracking-tight">{app.name}</h1>
          <p className="mt-3 text-lg text-foreground/60">{app.purpose}</p>
          <p className="mt-6 text-base text-foreground/70 max-w-prose mx-auto leading-relaxed">
            {app.arriving}
          </p>

          <dl className="mt-8 grid gap-3 sm:grid-cols-2 text-left">
            <div className="rounded-xl border bg-background/60 px-4 py-3">
              <dt className="text-xs font-semibold uppercase tracking-wide text-foreground/45">
                Arrives in
              </dt>
              <dd className="mt-0.5 text-sm font-bold">{app.milestone}</dd>
            </div>
            <div className="rounded-xl border bg-background/60 px-4 py-3">
              <dt className="text-xs font-semibold uppercase tracking-wide text-foreground/45">
                Signed in as
              </dt>
              <dd className="mt-0.5 text-sm font-bold truncate">
                {displayName(me)}
                {me?.branch ? ` · ${me.branch.name}` : ''}
              </dd>
            </div>
          </dl>

          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link href="/">
              <Button variant="outline" className="gap-2 w-full sm:w-auto">
                <ArrowLeft className="w-4 h-4" /> Back to the suite
              </Button>
            </Link>
            {app.legacyUrl && (
              <a href={app.legacyUrl} target="_blank" rel="noreferrer noopener">
                <Button className="gap-2 w-full sm:w-auto">
                  <ExternalLink className="w-4 h-4" />
                  {app.legacyLabel ?? 'Open the system running today'}
                </Button>
              </a>
            )}
          </div>

          {app.legacyUrl && (
            <p className="mt-4 text-xs text-foreground/45">
              That one is outside the suite: it asks for its own sign-in and its data does not come
              from here yet.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
