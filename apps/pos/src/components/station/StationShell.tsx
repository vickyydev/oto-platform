import { type ReactNode } from 'react';
import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import logoUrl from '@/assets/logo-oto.png';

/**
 * The full-screen chrome the station screens share, lifted out of StationSetup
 * unchanged so the picker wears exactly the same one.
 *
 * `closeTo` is null when there is nowhere to close to: a till that has not been
 * given a station yet has no surface behind this one, and a Close button that
 * lands back here would be a door onto the same room.
 */
export function StationShell({
  subtitle,
  closeTo = '/',
  children,
}: {
  subtitle: string;
  closeTo?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <div className="shrink-0 flex items-center justify-between px-6 h-16 border-b bg-card/30">
        <div className="flex items-center gap-3">
          <Link href="/" aria-label="Oto home">
            <img src={logoUrl} alt="Oto" className="h-8 w-auto cursor-pointer" />
          </Link>
          <div className="text-sm text-muted-foreground border-l pl-3">{subtitle}</div>
        </div>
        {closeTo && (
          <Link href={closeTo}>
            <Button variant="ghost" size="sm">
              Close
            </Button>
          </Link>
        )}
      </div>
      <div className="flex-1 flex flex-col p-6 overflow-hidden">{children}</div>
    </div>
  );
}
