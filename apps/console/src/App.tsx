import { useEffect, type ReactElement } from 'react';
import { Redirect, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import { KeyRound, Loader2, ShieldOff } from 'lucide-react';
import { Backdrop } from '@/components/Backdrop';
import { BrandMark } from '@/components/BrandMark';
import { Button } from '@/components/ui/button';
import { ConsoleLayout } from '@/components/ConsoleLayout';
import { LockedPanel } from '@/components/LockedPanel';
import { SignInPanel } from '@/components/SignInPanel';
import { PermissionRequired } from '@/components/Panel';
import { CONSOLE_SECTIONS, consoleNav, DEFAULT_SECTION, findSection } from '@/components/consoleSections';
import { SessionProvider, useSession, displayName } from '@/auth/SessionContext';
import { PlatformStatusProvider } from '@/lib/platformStatus';
import { accountTheme } from '@/lib/theme';
import { Activity } from '@/pages/Activity';
import { Bookings } from '@/pages/Bookings';
import { Booths } from '@/pages/Booths';
import { BoothReport } from '@/pages/BoothReport';
import { Branches } from '@/pages/Branches';
import { Devices } from '@/pages/Devices';
import { Failures } from '@/pages/Failures';
import { Health } from '@/pages/Health';
import { Integrations } from '@/pages/Integrations';
import { Vouchers } from '@/pages/Vouchers';
import { VoucherTypes } from '@/pages/VoucherTypes';
import { AreaLanding } from '@/pages/AreaLanding';
import { Overview } from '@/pages/Overview';
import { Accounts } from '@/pages/Accounts';
import { Roles } from '@/pages/Roles';
import { AppAccess } from '@/pages/AppAccess';
import { Employees } from '@/pages/Employees';
import { Departments } from '@/pages/Departments';
import { AccessReview } from '@/pages/AccessReview';
import { Operators } from '@/pages/Operators';
import { Holidays } from '@/pages/Holidays';
import { Catalogue } from '@/pages/Catalogue';
import { MenuCatalogue } from '@/pages/MenuCatalogue';
import { Money } from '@/pages/Money';
import { Care } from '@/pages/Care';
import { StaffBenefits } from '@/pages/StaffBenefits';
import { Reports, ReportsLanding } from '@/pages/Reports';
import { ChannelsLanding } from '@/pages/Channels';
import { TeamsRouting } from '@/pages/TeamsRouting';
import { Operations } from '@/pages/Operations';

const LAUNCHER_URL = import.meta.env.VITE_LAUNCHER_URL?.trim();

function Splash() {
  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center gap-4">
      <Backdrop />
      <BrandMark className="h-10 opacity-90" />
      <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
    </div>
  );
}

/** Signed in, but this account has no business on the console. */
function NoConsoleAccess() {
  const { me, signOut } = useSession();
  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center px-4 sm:px-6 py-10 text-center">
      <Backdrop />
      <div className="w-full max-w-md">
        <span className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-3xl bg-muted text-muted-foreground">
          <ShieldOff className="w-7 h-7" />
        </span>
        <h1 className="text-2xl font-black tracking-tight">The console is not on your access</h1>
        <p className="mt-2 text-base text-foreground/60">
          {displayName(me)} is signed in, but opening the console needs{' '}
          <code className="font-mono text-sm">app:console:access</code>. A manager grants it from the
          Accounts page.
        </p>
        <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
          {LAUNCHER_URL && (
            <Button asChild variant="outline">
              <a href={LAUNCHER_URL}>Back to the suite</a>
            </Button>
          )}
          <Button variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * A temporary password blocks every guarded route, so there is nothing here to
 * show until it is changed — and the form that changes it lives on the front
 * door, where an account owing a password change is meant to land.
 */
function MustChangePassword() {
  const { signOut } = useSession();
  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center px-4 sm:px-6 py-10 text-center">
      <Backdrop />
      <div className="w-full max-w-md">
        <span className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-3xl bg-primary/10 text-primary">
          <KeyRound className="w-7 h-7" />
        </span>
        <h1 className="text-2xl font-black tracking-tight">Choose a password first</h1>
        <p className="mt-2 text-base text-foreground/60">
          This account is on a temporary password. Every page here stays closed until it is changed.
        </p>
        <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
          {LAUNCHER_URL && (
            <Button asChild>
              <a href={LAUNCHER_URL}>Change it on the suite front door</a>
            </Button>
          )}
          <Button variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A section reached by address rather than by the nav that would have hidden it. */
function Section({ id, children }: { id: string; children: ReactElement }) {
  const { has, me } = useSession();
  const section = findSection(id);
  if (!section) return <Redirect to={`/${DEFAULT_SECTION}`} />;
  if (section.platformWide && !me?.isPlatformAdmin) return <PermissionRequired permission={section.permission ?? 'app:console:access'} />;
  if (section.permission && !has(section.permission)) return <PermissionRequired permission={section.permission} />;
  return children;
}

function NotFound() {
  const [, navigate] = useLocation();
  return (
    <div className="rounded-2xl border border-dashed p-10 text-center">
      <p className="font-semibold">That page is not part of the console</p>
      <Button variant="outline" className="mt-4" onClick={() => navigate(`/${DEFAULT_SECTION}`)}>
        Go to Overview
      </Button>
    </div>
  );
}

const pageElements: Record<string, ReactElement> = {
  inventory: <Operations page="inventory" />,
  members: <Operations page="members" />,
  'tier-verifications': <Operations page="tier-verifications" />,
  wallets: <Operations page="wallets" />,
  'teams-routing': <TeamsRouting />,
  'reports-sales': <Reports page="sales" />,
  'reports-profitability': <Reports page="profitability" />,
  'reports-discounts': <Reports page="discounts" />,
  'reports-tax-vat': <Reports page="tax-vat" />,
  'reports-wallet-promo': <Reports page="wallet-promo" />,
  care: <Care page="care" />,
  'print-templates': <Care page="print-templates" />,
  'staff-benefits': <StaffBenefits />,
  discounts: <Money page="discounts" />,
  tenders: <Money page="tenders" />,
  tax: <Money page="tax" />,
  'voucher-campaigns': <Money page="voucher-campaigns" />,
  'event-pricing': <Money page="event-pricing" />,
  menu: <MenuCatalogue page="menu" />,
  categories: <MenuCatalogue page="categories" />,
  modifiers: <MenuCatalogue page="modifiers" />,
  merch: <MenuCatalogue page="merch" />,
  tickets: <Catalogue page="tickets" />,
  tiers: <Catalogue page="tiers" />,
  'add-ons': <Catalogue page="add-ons" />,
  operators: <Operators />,
  holidays: <Holidays />,
  accounts: <Accounts />,
  roles: <Roles />,
  'app-access': <AppAccess />,
  employees: <Employees />,
  departments: <Departments />,
  'access-review': <AccessReview />,
  health: <Health />, failures: <Failures />, activity: <Activity />,
  devices: <Devices />, branches: <Branches />, bookings: <Bookings />,
  booths: <Booths />, 'booth-report': <BoothReport />, vouchers: <Vouchers />,
  'voucher-types': <VoucherTypes />, integrations: <Integrations />,
};

function Routes() {
  return (
    <Switch>
      <Route path="/">
        <Redirect to={`/${DEFAULT_SECTION}`} />
      </Route>
      {CONSOLE_SECTIONS.flatMap((page) => [...new Set([page.path, `/${page.id}`])].map((path) => (
        <Route key={path} path={path}>
          <Section id={page.id}>{pageElements[page.id] ?? <NotFound />}</Section>
        </Route>
      )))}
      {consoleNav.filter((area) => !CONSOLE_SECTIONS.some((page) => page.path === `/${area.id}`))
        .map((area) => <Route key={area.id} path={`/${area.id}`}>
          {area.id === 'overview' ? <Overview /> : area.id === 'reports' ? <ReportsLanding /> : area.id === 'channels' ? <ChannelsLanding /> : <AreaLanding id={area.id} />}
        </Route>)}
      <Route component={NotFound} />
    </Switch>
  );
}

function Shell() {
  const { state, me, locked, has } = useSession();

  if (state === 'loading') return <Splash />;
  if (state === 'signed-out') return <SignInPanel />;
  if (locked) return <LockedPanel />;
  if (me?.account.mustChangePassword) return <MustChangePassword />;
  if (!has('app:console:access')) return <NoConsoleAccess />;

  return (
    // The status poll is what puts an alert count in the sidebar from any page,
    // so it belongs above the routes — and it is off for anyone who may not read
    // health, rather than polling a route that would refuse them every 30s.
    <PlatformStatusProvider enabled={has('admin:health:read')}>
      <ConsoleLayout>
        <Routes />
      </ConsoleLayout>
    </PlatformStatusProvider>
  );
}

export default function App() {
  // The theme drives the document root, so anything portaled to <body> follows
  // it. The shared controller follows the device while the account's choice
  // is 'system'; SessionContext adopts the choice after sign-in.
  useEffect(() => accountTheme.start(), []);

  return (
    <SessionProvider>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <Shell />
      </WouterRouter>
    </SessionProvider>
  );
}
