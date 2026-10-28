import { Link } from 'wouter';
import { ArrowRight, ExternalLink } from 'lucide-react';
import { useSession } from '@/auth/SessionContext';
import { assistantSettingsNavigation, canSeeArea, findArea, visibleNavigation, type ConsoleNavGroup } from '@/components/consoleSections';
import { CommandBar } from '@/components/redesign/CommandBar';
import { Panel } from '@/components/Panel';
import { filterPlatformHealthLinks, usePlatformAuthority } from '@/lib/platformAuthority';
import { PaymentsDiscovery } from '@/components/PaymentsDiscovery';

const POS_URL = import.meta.env.VITE_POS_URL?.trim();
const LAUNCHER_URL = import.meta.env.VITE_LAUNCHER_URL?.trim();

/** Navigation only: figures and management panels arrive in their own releases. */
export function AreaLanding({ id }: { id: string }) {
  const { state, has, me, permissions, locked, refreshing } = useSession();
  const platformHealth = usePlatformAuthority('admin:health:read', true);
  const area = findArea(id);
  if (!area) return null;
  if (!canSeeArea(area, has, me?.isPlatformAdmin ?? false)) {
    return <><CommandBar sectionId={id} /><Panel><p>This area is not on your access.</p></Panel></>;
  }
  const settingsOperator = state === 'signed-in' && !refreshing && !locked && me?.account.status === 'active' && !me.account.mustChangePassword ? me.operatorContext.effectiveOperatorId : null;
  const available = assistantSettingsNavigation(filterPlatformHealthLinks(visibleNavigation(has, me?.isPlatformAdmin ?? false), platformHealth.allowed), settingsOperator, permissions);
  const current = available.find((entry) => entry.id === id)!;
  return <AreaLandingContent area={current} available={available} />;
}

export function AreaLandingContent({
  area,
  available,
}: {
  area: ConsoleNavGroup;
  available: ConsoleNavGroup[];
}) {
  const home = area.currentHome;
  const origin = home?.app === 'pos' ? POS_URL : LAUNCHER_URL;
  const links = area.id === 'overview'
    ? available.filter((entry) => entry.id !== 'overview').map((entry) => ({
      path: `/${entry.id}`, label: entry.label, description: entry.description,
    }))
    : area.sections.filter(link => area.id !== 'catalogue' || !['/catalogue/tenders', '/catalogue/tax'].includes(link.path));
  return (
    <>
      <CommandBar sectionId={area.id} />
      <Panel>
        <p className="text-sm text-muted-foreground">{area.description}</p>
        {area.id !== 'overview' && area.sections.length === 0 && (
          <p className="mt-2 text-sm text-muted-foreground">Management panels are not available in this area yet.</p>
        )}
        {home && origin && (
          <a className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-primary-ink"
            href={`${origin.replace(/\/$/, '')}${home.path}`}>
            {home.label}<ExternalLink className="h-4 w-4" aria-hidden="true" />
          </a>
        )}
      </Panel>
      {area.id === 'catalogue' && <PaymentsDiscovery availablePaths={available.flatMap(group => group.sections.map(section => section.path))} />}
      {links.length > 0 && (
        <div className="grid gap-3 @xl:grid-cols-2">
          {links.map((link) => (
            <Link key={link.path} href={link.path}
              className="flex items-center gap-4 rounded-2xl border bg-card p-5 transition-colors hover:bg-foreground/5">
              <span className="min-w-0 flex-1">
                <span className="block font-bold">{link.label}</span>
                <span className="mt-1 block text-sm text-muted-foreground">{link.description}</span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
