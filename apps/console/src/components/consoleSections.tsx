import {
  Activity, BarChart3, Building2, CalendarCheck, FerrisWheel, HeartPulse,
  Landmark, LayoutDashboard, LifeBuoy, MessagesSquare, Plug, Router, Shield, Ticket,
  TriangleAlert, Users, type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@oto/shared/permissions';
import type { EffectivePermission } from '../api/platform';

export interface ConsoleSection {
  /** The old address remains an alias; path is the area address in navigation. */
  id: string;
  path: string;
  label: string;
  icon: LucideIcon;
  description: string;
  /** Omitted only for the inherited Inventory offer; its API keeps stock authority. */
  permission?: Permission;
  /** Platform-wide actions are never offered to an operator administrator. */
  platformWide?: boolean;
}

export type AreaGate =
  | { any: readonly Permission[] }
  | { all: readonly Permission[] }
  | { platformWide: true };

export interface ConsoleNavGroup {
  id: string;
  label: string;
  icon: LucideIcon;
  description: string;
  gate: AreaGate;
  sections: ConsoleSection[];
  /** Where the controls live while their panels move into Admin. */
  currentHome?: { app: 'pos' | 'suite'; path: string; label: string };
}

/** Existing pages keep their permissions and their old addresses. */
export const CONSOLE_SECTIONS: ConsoleSection[] = [
  { id: 'analytics', path: '/reports/analytics', label: 'Analytics & sources', icon: BarChart3,
    description: 'Recorded sources, formula versions, queued dates and headline figures.', permission: 'console:analytics:read' },
  { id: 'config', path: '/organisation/configuration', label: 'Configuration', icon: Building2,
    description: 'Settings ownership and the existing pages where each setting is managed.', permission: 'console:config:read' },
  { id: 'apps', path: '/organisation/apps', label: 'Apps', icon: Plug,
    description: 'The suite app registry, origins, tile states and maintenance windows.', permission: 'console:app_registry:read' },
  { id: 'releases', path: '/watch/releases', label: 'Releases', icon: Activity,
    description: 'Kill switches, feature flags, deployment history and box agent versions.', permission: 'console:release:read' },
  // SCRUM-648: `/support` stays the alias the Money oversight trace links open.
  { id: 'support', path: '/watch/support', label: 'Support', icon: LifeBuoy,
    description: 'Find anything across the suite, trace what happened to one sale, and view an app as a staff account.',
    permission: 'console:support:lookup' },
  { id: 'inventory', path: '/catalogue/inventory', label: 'Inventory', icon: Ticket,
    description: 'Stock items, variants, counts and stock locations at a park.' },
  { id: 'members', path: '/catalogue/members', label: 'Members', icon: Users,
    description: 'Member profiles, children and verified customer tiers.', permission: 'pos:member:update' },
  { id: 'tier-verifications', path: '/catalogue/tier-verifications', label: 'Tier verifications', icon: Shield,
    description: 'Recorded tier proofs, their expiry and the staff account that checked them.', permission: 'pos:member:read' },
  { id: 'wallets', path: '/reports/wallets', label: 'Wallets', icon: Ticket,
    description: 'Look up a band or credit voucher and read its balance, expiry and ledger.', permission: 'pos:wallet:read' },
  { id: 'teams-routing', path: '/channels/teams-routing', label: 'Teams & routing', icon: MessagesSquare,
    description: 'System teams and the rules that name the primary owner and backup.', permission: 'inbox:routing:manage' },
  { id: 'assistant-settings', path: '/channels/assistant-settings', label: 'Assistant settings', icon: MessagesSquare,
    description: 'Operator-wide daily caps, pacing and versioned USD usage estimates.', permission: 'inbox:ai:manage' },
  { id: 'reports-sales', path: '/reports/sales', label: 'Sales', icon: BarChart3,
    description: 'Revenue by category, payment method, ticket and item over trading days.', permission: 'analytics:read' },
  { id: 'reports-profitability', path: '/reports/profitability', label: 'Profitability', icon: BarChart3,
    description: 'Recorded revenue, cost of goods and margin for food, drinks and merch.', permission: 'analytics:read' },
  { id: 'reports-discounts', path: '/reports/discounts', label: 'Discounts & comps', icon: BarChart3,
    description: 'Manual discounts, complimentary items and promo-code use.', permission: 'analytics:read' },
  { id: 'reports-tax-vat', path: '/reports/tax-vat', label: 'Tax & VAT', icon: BarChart3,
    description: 'VAT totals and the existing date-bounded receipt exports.', permission: 'analytics:read' },
  { id: 'reports-wallet-promo', path: '/reports/wallet-promo', label: 'Wallet & promo', icon: BarChart3,
    description: 'Wallet movements, current outstanding credit and promotional voucher use.', permission: 'analytics:read' },
  // SCRUM-647: read only, every read audited; the integrity panel needs console:money:investigate too.
  { id: 'money', path: '/reports/money', label: 'Money oversight', icon: Landmark,
    description: 'Sales, refunds, cash days, settlement, wallet liability and costs across parks, read only.', permission: 'console:money:read' },
  { id: 'care', path: '/catalogue/care', label: 'Drop-off & supervision', icon: Shield,
    description: 'Park drop-off and nanny prices, age bands, sibling waiver and consent checklist.', permission: 'pos:checkin:read' },
  { id: 'print-templates', path: '/catalogue/print-templates', label: 'Print templates', icon: Ticket,
    description: 'Saved print layouts, draft previews and separately authorized test prints.', permission: 'pos:print:read' },
  { id: 'staff-benefits', path: '/catalogue/staff-benefits', label: 'Staff benefits', icon: Users,
    description: 'Role templates, per-person overrides, benefit credentials and application history.', permission: 'admin:benefit:read' },
  { id: 'discounts', path: '/catalogue/discounts', label: 'Discounts', icon: Ticket,
    description: 'Discount codes and the existing local manual-discount reasons.', permission: 'catalog:menu:manage' },
  { id: 'tenders', path: '/catalogue/tenders', label: 'Tenders', icon: Ticket,
    description: 'Shared payment methods, availability and ordering.', permission: 'catalog:menu:manage' },
  { id: 'tax', path: '/catalogue/tax', label: 'Tax', icon: Ticket,
    description: 'Park tax rates, category rules and service charges.', permission: 'catalog:tax:manage' },
  { id: 'voucher-campaigns', path: '/catalogue/voucher-campaigns', label: 'Voucher campaigns', icon: Ticket,
    description: 'Promotional rules, campaign batches and their code downloads.', permission: 'admin:booth:read' },
  { id: 'event-pricing', path: '/catalogue/event-pricing', label: 'Event pricing', icon: Ticket,
    description: 'Walk-up camp, event and party prices for a park.', permission: 'admin:event_pricing:manage' },
  { id: 'menu', path: '/catalogue/menu', label: 'Menu', icon: Ticket,
    description: 'Menu items, prices, preparation, tax and workbook import and export.', permission: 'catalog:menu:read' },
  { id: 'categories', path: '/catalogue/categories', label: 'Categories', icon: Ticket,
    description: 'Shared food and drink categories and their inherited defaults.', permission: 'catalog:menu:read' },
  { id: 'modifiers', path: '/catalogue/modifiers', label: 'Modifiers', icon: Ticket,
    description: 'Shared modifier questions, choices and prices.', permission: 'catalog:menu:read' },
  { id: 'merch', path: '/catalogue/merch', label: 'Merch', icon: Ticket,
    description: 'Shop items, weekday and weekend prices, sizes and barcodes.', permission: 'catalog:menu:read' },
  { id: 'tickets', path: '/catalogue/tickets', label: 'Tickets', icon: Ticket,
    description: 'Ticket types, weekday and weekend prices, adult rules and included items.', permission: 'catalog:package:read' },
  { id: 'tiers', path: '/catalogue/tiers', label: 'Tiers', icon: Users,
    description: 'Customer tiers, their default and proof requirements.', permission: 'catalog:package:read' },
  { id: 'add-ons', path: '/catalogue/add-ons', label: 'Add-ons', icon: Ticket,
    description: 'Ticket extras and their weekday and weekend prices.', permission: 'catalog:menu:read' },
  { id: 'operators', path: '/organisation/operators', label: 'Operators', icon: Building2,
    description: 'Platform operators and their administrators.', permission: 'admin:operator:read', platformWide: true },
  { id: 'platform-operators', path: '/platform/operators', label: 'Operators', icon: Building2,
    description: 'The existing operators and administrator controls.', permission: 'admin:operator:read', platformWide: true },
  { id: 'system-roles', path: '/platform/system-roles', label: 'System roles', icon: Shield,
    description: 'Immutable platform-maintained roles and their permission sentences.', permission: 'admin:role:read', platformWide: true },
  { id: 'platform-alerts', path: '/platform/alerts', label: 'Platform alerts', icon: TriangleAlert,
    description: 'Open and resolved platform-wide alert records.', permission: 'admin:health:read', platformWide: true },
  { id: 'platform-jobs', path: '/platform/jobs', label: 'Platform jobs', icon: Activity,
    description: 'Persisted job status, last outcomes and configuration waits.', permission: 'admin:health:read', platformWide: true },
  { id: 'platform-environment', path: '/platform/environment', label: 'Environment', icon: Plug,
    description: 'Allowlisted configuration names and presence, without values.', permission: 'admin:health:read', platformWide: true },
  { id: 'platform-test-controls', path: '/platform/test-controls', label: 'Test controls', icon: Shield,
    description: 'Existing staging-only controls, available only when the server admits them.', permission: 'admin:ops:manage', platformWide: true },
  { id: 'holidays', path: '/organisation/holidays', label: 'Holidays', icon: CalendarCheck,
    description: 'Ticket-pricing holiday and weekend date ranges for a park.', permission: 'catalog:holiday:manage' },
  { id: 'access-review', path: '/people/access-review', label: 'Access review', icon: Shield,
    description: 'Read-only review of wide role holders, account links, recorded sign-ins and required password changes.',
    permission: 'admin:role:read' },
  { id: 'departments', path: '/people/departments', label: 'Departments', icon: Users,
    description: 'Read-only platform department records, their park and current employee member counts.',
    permission: 'admin:account:read' },
  { id: 'employees', path: '/people/employees', label: 'Employees', icon: Users,
    description: 'Read-only employee records, their source, park, department, linked sign-ins and last sign-in.',
    permission: 'admin:account:read' },
  { id: 'app-access', path: '/people/app-access', label: 'App access', icon: Plug,
    description: 'Linked app users, OTO App branch coverage and people with no suite sign-in.',
    permission: 'admin:account:read' },
  { id: 'roles', path: '/people/roles', label: 'Roles & scopes', icon: Shield,
    description: 'Existing roles in plain words, who holds a permission and previews before role changes.',
    permission: 'admin:role:read' },
  {
    id: 'accounts', path: '/people/accounts', label: 'Accounts', icon: Users,
    description: 'Staff sign-in accounts, invitations, phones, passwords and signed-in devices.',
    permission: 'admin:account:read',
  },
  {
    id: 'health',
    path: '/watch/health',
    label: 'Health',
    icon: HeartPulse,
    description: 'Is anything wrong right now — the database, storage, the jobs and any open alert.',
    permission: 'admin:health:read',
  },
  {
    id: 'failures',
    path: '/watch/failures',
    label: 'Failures',
    icon: TriangleAlert,
    description: 'Everything that did not succeed, grouped so one broken thing reads as one problem.',
    permission: 'admin:health:read',
  },
  {
    id: 'activity',
    path: '/watch/activity',
    label: 'Activity',
    icon: Activity,
    description: 'The audit log: who did what, to what, from where, and whether it went through.',
    permission: 'admin:audit:read',
  },
  {
    id: 'booths',
    path: '/devices/booths',
    label: 'Booths',
    icon: FerrisWheel,
    description:
      'The Lucky Wheel at each booth: its prizes, their odds and what they cost, and the version each booth is running.',
    // Reading the wheel is the page; changing it needs `admin:booth:manage`
    // and publishing it `admin:booth:publish`, both checked on the panels
    // themselves — so somebody who may look at the odds gets the page
    // rather than a locked door.
    permission: 'admin:booth:read',
  },
  {
    id: 'booth-report',
    path: '/reports/booths',
    label: 'Booth report',
    icon: BarChart3,
    description:
      'What each booth’s wheel did over a range of trading days: spins, prizes won, vouchers issued and redeemed, and what the prizes cost.',
    // S2-15b round 5: the booth figures are the park's takings' cousin, and
    // `GET /analytics/booths` asks `analytics:read` per branch — the same
    // bar as the Reports panels.
    permission: 'analytics:read',
  },
  {
    id: 'devices',
    path: '/devices',
    label: 'Devices',
    icon: Router,
    description:
      'The boxes at the park, the stations that sit on them, and who may pick each one.',
    // The floor is reading stations: boxes and devices are panels within
    // the page and each is gated on its own, so an account that may see
    // the stations but not the fleet gets the half it is entitled to
    // rather than a locked page.
    permission: 'admin:station:read',
  },
  {
    id: 'branches',
    path: '/organisation/branches',
    label: 'Branches',
    icon: Building2,
    description:
      'Every park, and the row it is joined to in the OTO App — mapped, app-only, or not mapped and why.',
    // Reading the estate is the page; reconciling the two lists needs
    // `admin:branch:update` and is checked on the button, so a manager who
    // may see their own park gets the page rather than a locked door.
    permission: 'admin:branch:read',
  },
  {
    id: 'bookings',
    path: '/reports/bookings',
    label: 'Bookings',
    icon: CalendarCheck,
    description:
      'Online bookings in every state, and the payment behind each — paid only when the payment gateway confirms the money.',
    // The counter's own read, at the park's own scope: the list names the
    // same families the redeem screen does (S2-12).
    permission: 'pos:booking:read',
  },
  {
    id: 'vouchers',
    path: '/catalogue/vouchers',
    label: 'Vouchers',
    icon: Ticket,
    description: 'Issued vouchers, their value and where they were redeemed.',
    permission: 'admin:booth:read',
  },
  {
    id: 'voucher-types',
    path: '/catalogue/voucher-types',
    label: 'Voucher types',
    icon: Ticket,
    description:
      'What each Lucky Wheel prize is worth at the park and the words its slip prints — set up here before a booth gives one away.',
    // Beside Vouchers under Catalogue & money; the Booths prize editor
    // picks from this list. The same split as there: reading is the page,
    // and changing a type needs `admin:booth:manage`, checked on the buttons
    // (SCRUM-400).
    permission: 'admin:booth:read',
  },
  {
    id: 'integrations',
    path: '/watch/integrations',
    label: 'Integrations',
    icon: Plug,
    description: 'The outside services this platform depends on, and what each one is doing.',
    permission: 'admin:health:read',
  },
];

export function findSection(id: string): ConsoleSection | undefined {
  return CONSOLE_SECTIONS.find((page) => page.id === id);
}

export function sectionForPath(path: string): ConsoleSection | undefined {
  return CONSOLE_SECTIONS.find((page) => page.path === path || `/${page.id}` === path);
}

const pages = (...ids: string[]) => ids.map((id) => findSection(id)!);

/** PLAN ?3: area gates hide navigation; each page keeps its own guard. */
export const consoleNav: ConsoleNavGroup[] = [
  {
    id: 'overview', label: 'Overview', icon: LayoutDashboard,
    description: 'Start here, then open the area you need.',
    gate: { any: ['console:overview:read'] }, sections: [],
  },
  {
    id: 'people', label: 'People & access', icon: Users,
    description: 'Accounts, roles, app access, employees and departments.',
    gate: { any: ['admin:account:read'] }, sections: pages('accounts', 'roles', 'app-access', 'employees', 'departments', 'access-review'),
  },
  {
    id: 'organisation', label: 'Organisation', icon: Building2,
    description: 'Operators, branches, their connection to the OTO App, ticket-pricing holidays, configuration and the suite app registry.',
    gate: { any: ['admin:branch:read', 'console:config:read', 'console:app_registry:read'] },
    sections: pages('operators', 'branches', 'holidays', 'config', 'apps'),
  },
  {
    id: 'catalogue', label: 'Catalogue & money', icon: Ticket,
    description: 'Tickets, menu, discounts, tenders, tax, vouchers and event pricing.',
    gate: { any: ['catalog:package:read', 'catalog:menu:read'] },
    sections: pages('tickets', 'tiers', 'add-ons', 'menu', 'categories', 'modifiers', 'merch', 'inventory', 'members', 'tier-verifications', 'discounts', 'tenders', 'tax', 'voucher-types', 'voucher-campaigns', 'vouchers', 'event-pricing', 'care', 'print-templates', 'staff-benefits'),
  },
  {
    id: 'devices', label: 'Devices & places', icon: Router,
    description: 'Boxes, stations, devices, paired screens, kiosks and booths.',
    gate: { any: ['admin:station:read'] }, sections: pages('devices', 'booths'),
  },
  {
    id: 'channels', label: 'Channels & assistant', icon: MessagesSquare,
    description: 'Manage teams, routing, assistant caps and pacing here; open Numbers, Templates, Knowledge base and Examples in Inbox.',
    gate: { any: ['inbox:channel:manage', 'inbox:kb:manage', 'inbox:ai:manage'] }, sections: pages('teams-routing', 'assistant-settings'),
  },
  {
    id: 'staff', label: 'Staff & HR', icon: CalendarCheck,
    description: 'Read-only staff, attendance, leave and payroll headlines from OTO App, with links to their source pages.',
    gate: { all: ['app:oto_app:access', 'admin:account:read'] }, sections: [],
  },
  {
    id: 'reports', label: 'Reports', icon: BarChart3,
    description: 'Sales, profitability, discounts, tax, wallet credit, booth activity and online bookings.',
    gate: { any: ['analytics:read', 'console:money:read'] }, sections: pages('analytics', 'money', 'reports-sales', 'reports-profitability', 'reports-discounts', 'reports-tax-vat', 'reports-wallet-promo', 'wallets', 'booth-report', 'bookings'),
  },
  {
    id: 'watch', label: 'Watch', icon: Activity,
    description: 'Health, failures, integrations, the activity log and recorded releases.',
    gate: { any: ['admin:health:read', 'admin:audit:read', 'console:release:read', 'console:support:lookup'] },
    sections: pages('health', 'failures', 'integrations', 'activity', 'releases', 'support'),
  },
  {
    id: 'platform', label: 'Platform', icon: Shield,
    description: 'Operators, immutable system roles, platform status, configuration presence and staging-only controls.',
    gate: { platformWide: true }, sections: pages('platform-operators', 'system-roles', 'platform-alerts', 'platform-jobs', 'platform-environment', 'platform-test-controls'),
  },
];

export function findArea(id: string): ConsoleNavGroup | undefined {
  return consoleNav.find((area) => area.id === id);
}

export function canSeeArea(
  area: ConsoleNavGroup,
  has: (permission: Permission) => boolean,
  isPlatformAdmin: boolean,
): boolean {
  if ('platformWide' in area.gate) return isPlatformAdmin;
  if ('all' in area.gate) return area.gate.all.every(has);
  return area.gate.any.some(has);
}

export function visibleNavigation(
  has: (permission: Permission) => boolean,
  isPlatformAdmin: boolean,
): ConsoleNavGroup[] {
  return consoleNav.filter((area) => canSeeArea(area, has, isPlatformAdmin))
    .map((area) => ({ ...area, sections: area.sections.filter((page) => (!page.permission || has(page.permission)) && (!page.platformWide || isPlatformAdmin)) }));
}

/** Only this new operator setting needs a narrower offer than the inherited name-only navigation. */
export function assistantSettingsNavigation(
  navigation: ConsoleNavGroup[], operatorId: string | null, permissions: readonly EffectivePermission[],
): ConsoleNavGroup[] {
  const offered = operatorId !== null && permissions.some(grant => grant.permission === 'inbox:ai:manage'
    && grant.scopeType === 'operator' && (grant.scopeId === null || grant.scopeId === operatorId));
  return navigation.map(area => area.id !== 'channels' ? area : { ...area,
    sections: area.sections.filter(page => page.id !== 'assistant-settings' || offered) });
}

export const DEFAULT_SECTION = 'overview';
