import {
  Activity, BarChart3, Building2, CalendarCheck, FerrisWheel, HeartPulse,
  LayoutDashboard, MessagesSquare, Plug, Router, Shield, Ticket,
  TriangleAlert, Users, type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@oto/shared/permissions';

export interface ConsoleSection {
  /** The old address remains an alias; path is the area address in navigation. */
  id: string;
  path: string;
  label: string;
  icon: LucideIcon;
  description: string;
  permission: Permission;
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
  { id: 'teams-routing', path: '/channels/teams-routing', label: 'Teams & routing', icon: MessagesSquare,
    description: 'System teams and the rules that name the primary owner and backup.', permission: 'inbox:routing:manage' },
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
    currentHome: { app: 'pos', path: '/admin?panel=login-users', label: 'Open Login Users in POS Admin' },
  },
  {
    id: 'organisation', label: 'Organisation', icon: Building2,
    description: 'Operators, branches, their connection to the OTO App and ticket-pricing holidays.',
    gate: { any: ['admin:branch:read'] }, sections: pages('operators', 'branches', 'holidays'),
  },
  {
    id: 'catalogue', label: 'Catalogue & money', icon: Ticket,
    description: 'Tickets, menu, discounts, tenders, tax, vouchers and event pricing.',
    gate: { any: ['catalog:package:read', 'catalog:menu:read'] },
    sections: pages('tickets', 'tiers', 'add-ons', 'menu', 'categories', 'modifiers', 'merch', 'discounts', 'tenders', 'tax', 'voucher-types', 'voucher-campaigns', 'vouchers', 'event-pricing', 'care', 'print-templates', 'staff-benefits'),
    currentHome: { app: 'pos', path: '/admin', label: 'Open catalogue and pricing in POS Admin' },
  },
  {
    id: 'devices', label: 'Devices & places', icon: Router,
    description: 'Boxes, stations, devices, paired screens, kiosks and booths.',
    gate: { any: ['admin:station:read'] }, sections: pages('devices', 'booths'),
  },
  {
    id: 'channels', label: 'Channels & assistant', icon: MessagesSquare,
    description: 'Manage teams and routing here; open Numbers, Templates, Knowledge base and Examples in Inbox.',
    gate: { any: ['inbox:channel:manage', 'inbox:kb:manage', 'inbox:ai:manage'] }, sections: pages('teams-routing'),
  },
  {
    id: 'staff', label: 'Staff & HR', icon: CalendarCheck,
    description: 'Staff operations and HR are managed in the OTO App.',
    gate: { all: ['app:oto_app:access', 'admin:account:read'] }, sections: [],
    currentHome: { app: 'suite', path: '', label: 'Open the suite to choose OTO App' },
  },
  {
    id: 'reports', label: 'Reports', icon: BarChart3,
    description: 'Sales, profitability, discounts, tax, wallet credit, booth activity and online bookings.',
    gate: { any: ['analytics:read'] }, sections: pages('reports-sales', 'reports-profitability', 'reports-discounts', 'reports-tax-vat', 'reports-wallet-promo', 'booth-report', 'bookings'),
  },
  {
    id: 'watch', label: 'Watch', icon: Activity,
    description: 'Health, failures, integrations and the activity log.',
    gate: { any: ['admin:health:read', 'admin:audit:read'] },
    sections: pages('health', 'failures', 'integrations', 'activity'),
  },
  {
    id: 'platform', label: 'Platform', icon: Shield,
    description: 'Platform administration. Environment and test controls are currently on Integrations and Health.',
    gate: { platformWide: true }, sections: [],
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
    .map((area) => ({ ...area, sections: area.sections.filter((page) => has(page.permission) && (!page.platformWide || isPlatformAdmin)) }));
}

export const DEFAULT_SECTION = 'overview';
