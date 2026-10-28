import { Link } from 'wouter';
import { ExternalLink } from 'lucide-react';
import { CardShell, PageGrid } from '@/components/redesign/layout';
import { Tag } from '@/components/redesign/chips';

const LAUNCHER_URL = import.meta.env.VITE_LAUNCHER_URL?.trim();
const setup = [
  { path: '/catalogue/tenders', label: 'Tenders', detail: 'Accepted methods, availability and order across this operator.' },
  { path: '/catalogue/tax', label: 'Tax', detail: 'Tax and service rules in permitted parks.' },
  { path: '/devices', label: 'Station routing', detail: 'Choose a reachable park and station, then its card, QR, cash and offline-wallet routing.' },
];
const other = [
  { title: 'Reconcile', mode: 'Existing reconciliation controls', links: [{ path: '/watch/integrations', label: 'Settlement import', detail: 'The documented fixture format; real provider files still need mapping.' }] },
  { title: 'Investigate', mode: 'Read-only figures and authorized support', links: [{ path: '/reports/money', label: 'Money oversight', detail: 'Read-only figures, cash and settlement evidence.' },
    { path: '/watch/support', label: 'Support', detail: 'Existing authorized lookup and trace tools.' }] },
];

/** A directory over existing filtered doors. A link never grants editing authority. */
export function PaymentsDiscovery({ availablePaths, setupPaths }: { availablePaths: readonly string[]; setupPaths?: readonly string[] }) {
  const allowed = new Set(availablePaths);
  const setups = setup.filter(link => link.path === '/devices' ? allowed.has(link.path)
    : (setupPaths ? setupPaths.includes(link.path) : allowed.has(link.path)));
  const links = (rows: typeof setup) => rows.map(link => <li key={link.path} className="min-w-0 space-y-1">
    <Link href={link.path} aria-label={link.label} className="font-semibold text-primary underline underline-offset-4">{link.label}</Link>
    <p className="text-sm text-muted-foreground break-words">{link.detail}</p>
  </li>);
  return <section className="min-w-0 space-y-3" aria-label="Payments">
    <div><h2 className="text-xl font-bold">Payments</h2>
      <p className="text-sm text-muted-foreground">Use the existing page for each task. Its park and edit permissions still apply.</p></div>
    <PageGrid>
      <CardShell title="Set up" span={6}><Tag>Editable where permitted</Tag>
        {setups.length ? <ul className="space-y-3">{links(setups)}</ul> : <p className="text-sm text-muted-foreground">No setup destination is in this reading or navigation access.</p>}
      </CardShell>
      <CardShell title="Operate in POS" span={6}><Tag>Existing POS operations</Tag>
        <p className="text-sm text-muted-foreground">Take or confirm payments, count cash and close the day in POS. Launcher keeps the existing app-access rules.</p>
        {LAUNCHER_URL ? <a href={LAUNCHER_URL} className="inline-flex items-center gap-1 text-sm font-semibold text-primary underline underline-offset-4">
          Open Launcher<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /></a>
          : <p className="text-sm text-muted-foreground">Launcher is not configured on this deployment.</p>}
      </CardShell>
      {other.map(group => <CardShell key={group.title} title={group.title} span={6}><Tag>{group.mode}</Tag>
        {group.links.some(link => allowed.has(link.path)) ? <ul className="space-y-3">{links(group.links.filter(link => allowed.has(link.path)))}</ul>
          : <p className="text-sm text-muted-foreground">No destination is on this navigation access.</p>}
      </CardShell>)}
    </PageGrid>
    <div className="rounded-2xl border p-4 text-sm space-y-2">
      <p><Tag>Deployment-only</Tag> Gateway provider, credentials and timeouts are deployment configuration; there is no credential editor here.</p>
      <p><Tag>Not integrated</Tag> Releases payment kill switches do not control the till yet. Use the existing tender and station controls for their documented tasks.</p>
    </div>
  </section>;
}
