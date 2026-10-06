import {
  Ticket,
  BadgeCheck,
  PlusCircle,
  UtensilsCrossed,
  ShoppingBag,
  SlidersHorizontal,
  Globe,
  BadgePercent,
  Receipt,
  Users,
  Printer,
  FileText,
  Tags,
  ShieldCheck,
  Package,
  Building2,
  Gift,
  BarChart3,
  TrendingUp,
  Wallet,
  WalletCards,
  PercentCircle,
  FileSpreadsheet,
  type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@oto/shared/permissions';

export interface AdminPanel {
  id: string;
  label: string;
  icon: LucideIcon;
  description: string;
  /**
   * What the nav requires before offering this panel, and what a refusal names
   * when one is reached another way.
   *
   * **This decides what is OFFERED, never what may happen.** The refusal that
   * counts is the API route's, which happens whatever this file says. What
   * this buys is a console that does not promise what it cannot do — a branch
   * manager holds no `admin:operator:read`, so Operators is no longer offered
   * to them only to answer "Platform administrators only" when opened.
   *
   * On a server-backed panel this is the exact string its routes declare, so
   * the nav and the server give the same answer. On a `localOnly` panel no
   * route is called at all, so it governs the nav and nothing else — it is
   * there to keep the same people out of the same screens once the panel is
   * wired up, not because anything is enforcing it today.
   */
  permission?: Permission;
  /**
   * This panel reaches no server route: it edits a catalogue held in browser
   * memory, which is gone on reload and reaches nobody else. Recorded so that
   * nothing here reads as protection. SCRUM-236 wires the rest of them up.
   *
   * Merch, Add-ons, Modifiers and Discounts are no longer among them: SCRUM-204
   * gave the four of them the menu and discount routes, and SCRUM-341 gave the
   * F&B Menu and F&B Categories forms theirs, so each carries the permission
   * those routes declare instead of this flag. A panel that writes
   * through and still says `localOnly` offers itself to an account the server
   * will refuse, which is the thing the flag above exists to prevent.
   */
  localOnly?: true;
}

export interface AdminNavGroup {
  kind: 'group';
  id: string;
  label: string;
  panels: AdminPanel[];
}

// A nav entry is either a collapsible group of panels (2+ items) or a single
// top-level panel (rendered directly, no group header).
export type AdminNavEntry =
  | AdminNavGroup
  | { kind: 'panel'; panel: AdminPanel };

export const adminNav: AdminNavEntry[] = [
  {
    kind: 'group',
    id: 'catalog',
    label: 'Products',
    panels: [
      {
        id: 'tickets',
        label: 'Tickets',
        icon: Ticket,
        description: 'Create and price play tickets per tier, with each ticket owning its adult entry, credit and gate access.',
        // What `PATCH /branches/:branchId/ticket-packages/:id` asks for.
        permission: 'catalog:package:update',
      },
      {
        id: 'addons',
        label: 'Add-ons',
        icon: PlusCircle,
        description: 'Manage socks, lockers, cups and other extras.',
        // An add-on is a `product` row, so this is what
        // `POST/PATCH/DELETE /branches/:branchId/menu/products` asks for.
        permission: 'catalog:menu:manage',
      },
      {
        id: 'menu',
        label: 'F&B Menu',
        icon: UtensilsCrossed,
        description: 'Manage food, drinks, bar and snack items.',
        // The item form saves through the menu product routes (SCRUM-341).
        permission: 'catalog:menu:manage',
      },
      {
        id: 'categories',
        label: 'F&B Categories',
        icon: Tags,
        description: 'Manage menu categories and their default prep & tax.',
        // The category form saves through the menu category routes (SCRUM-341).
        permission: 'catalog:menu:manage',
      },
      {
        id: 'modifiers',
        label: 'Modifiers',
        icon: SlidersHorizontal,
        description: 'Manage modifier groups (ice, sauces, sizes…).',
        // The shared library is operator-wide:
        // `POST/PATCH/DELETE /menu/modifier-groups`.
        permission: 'catalog:menu:manage',
      },
      {
        id: 'merch',
        label: 'Merch / Retail',
        icon: ShoppingBag,
        description: 'Manage shop item metadata (name, price, SKU, category).',
        // The same product routes as Add-ons. The stock counts on this screen
        // reach no route at all and say so on the panel.
        permission: 'catalog:menu:manage',
      },
    ],
  },
  {
    kind: 'panel',
    panel: {
      id: 'inventory',
      label: 'Inventory',
      icon: Package,
      description: 'Unified stock for all physical products — merch and stocked add-ons.',
      localOnly: true,
    },
  },
  {
    kind: 'group',
    id: 'pricing-money',
    label: 'Pricing & Money',
    panels: [
      {
        id: 'pricing',
        label: 'Tiers & Pricing',
        icon: Globe,
        description: 'Configure tiers and drop-off pricing.',
        // The operator tier routes (`POST/PATCH /tiers`) are guarded as
        // package catalogue. Drop-off pricing on the same screen is local.
        permission: 'catalog:package:update',
      },
      {
        id: 'discounts',
        label: 'Discounts & Payments',
        icon: BadgePercent,
        description: 'Manage discount codes, reasons and payment methods.',
        // The codes save through `POST/PATCH/DELETE /menu/discounts` and the
        // payment methods through `/payment-methods` (SCRUM-206), both guarded
        // as catalogue. The discount REASONS beside them are the one list here
        // that still reaches no route, and the panel says so.
        permission: 'catalog:menu:manage',
      },
      {
        // S2-14a round 5 — promotional vouchers: each voucher type's scope,
        // limits and window, and campaigns of codes. `GET /voucher-definitions`
        // and `GET /voucher-campaigns` ask `admin:booth:read`; saving and
        // minting ask `admin:booth:manage`, which the panel checks per button.
        id: 'voucher-promotions',
        label: 'Voucher Promotions',
        icon: Gift,
        description: 'Promotional vouchers: what each comes off, its limits and window, and campaigns of codes.',
        permission: 'admin:booth:read',
      },
      {
        id: 'tax',
        label: 'Tax & Service',
        icon: Receipt,
        description: 'Configure VAT, per-area tax mode and service charges.',
        // `PUT /branches/:branchId/tax-config`.
        permission: 'catalog:tax:manage',
      },
    ],
  },
  {
    kind: 'group',
    id: 'operations',
    label: 'Operations',
    panels: [
      {
        id: 'supervision',
        label: 'Supervision',
        icon: ShieldCheck,
        description: 'Set age-based nanny/drop-off rules and the sibling waiver.',
        localOnly: true,
      },
      {
        id: 'templates',
        label: 'Print Templates',
        icon: FileText,
        description: 'Configure what each printout shows (content, not routing).',
        // `PATCH /print-templates/:id` asks for this against the template's
        // own branch (print.ts), rather than a print permission: editing what
        // a printout says is branch configuration.
        permission: 'admin:branch:update',
      },
      {
        id: 'devices',
        label: 'Devices',
        icon: Printer,
        description: 'Manage printers, scanners and EDC terminals.',
        localOnly: true,
      },
      {
        id: 'staff-benefits',
        label: 'Staff Benefits',
        icon: Gift,
        description: 'Configure Owner/Manager/Staff benefit profiles and per-operator overrides.',
        localOnly: true,
      },
    ],
  },
  {
    kind: 'group',
    id: 'reports',
    label: 'Reporting',
    // Every report reads mock figures today, so `analytics:read` governs only
    // who is offered them. It is the permission the rollups behind them will
    // ask for (S2-18), and it keeps the takings off a counter account's screen
    // in the meantime — which is the same bar these panels had before.
    panels: [
      {
        id: 'reports-sales',
        label: 'Sales',
        icon: BarChart3,
        description: 'Revenue by category, tier, F&B and merch items — filterable by branch and date range.',
        permission: 'analytics:read',
        localOnly: true,
      },
      {
        id: 'reports-profitability',
        label: 'Profitability',
        icon: TrendingUp,
        description: 'F&B and merch margin against catalog cost-to-park (COGS).',
        permission: 'analytics:read',
        localOnly: true,
      },
      {
        id: 'reports-wallet',
        label: 'Wallet & Promo',
        icon: Wallet,
        description: 'F&B/merch wallet credit ledger and promo-code usage.',
        // S2-14a round 3: the wallet half reads `GET /wallets/report`, which
        // asks this exact permission; the promo half is still the catalog's.
        permission: 'analytics:read',
      },
      {
        // S2-14a round 3 — the Wallet view, beside the report the prototype's
        // admin put wallet credit in: scan or type a key, read the balance,
        // status and ledger, bring expired credit back with a reason.
        id: 'wallets',
        label: 'Wallets',
        icon: WalletCards,
        description: 'Look up a wallet by band or voucher: balance, status, ledger — and reactivate expired credit.',
        // `GET /wallets/lookup`; reactivating asks `pos:wallet:reactivate` on top.
        permission: 'pos:wallet:read',
      },
      {
        id: 'reports-discounts',
        label: 'Discounts & Comps',
        icon: PercentCircle,
        description: 'Manual discount and comp impact, by operator.',
        permission: 'analytics:read',
        localOnly: true,
      },
      {
        id: 'reports-tax',
        label: 'Tax & VAT',
        icon: FileSpreadsheet,
        description: 'Bulk tax-receipt export and a category-level VAT summary.',
        permission: 'analytics:read',
        localOnly: true,
      },
    ],
  },
  {
    kind: 'panel',
    panel: {
      id: 'members',
      label: 'Members',
      icon: Users,
      description: 'View and manage member verified tiers.',
      // Changing a member's tier is `PATCH /members/:id`.
      permission: 'pos:member:update',
    },
  },
  {
    kind: 'panel',
    panel: {
      id: 'tier-verifications',
      label: 'Tier Verifications',
      icon: BadgeCheck,
      description:
        'Record checking: every tier upgrade with the document, expiry date, verifying staff and time.',
      // Reading the evidence trail: `GET /members/tier-verifications`.
      permission: 'pos:member:read',
    },
  },
  // Access management (Sprint 1 rebuild): real accounts, roles and operators
  // against the platform API. Manager-only, like Reports.
  {
    kind: 'group',
    id: 'access',
    label: 'Access',
    panels: [
      {
        id: 'login-users',
        label: 'Login Users',
        icon: ShieldCheck,
        description:
          'Invite staff accounts, assign scoped roles, link the suite apps they use, and review effective permissions.',
        // `GET /accounts`, the first thing the panel loads.
        permission: 'admin:account:read',
      },
      {
        id: 'operators',
        label: 'Operators',
        icon: Building2,
        description: 'Platform admin: create or archive operators and assign their administrators.',
        // `GET /operators` is platform-wide. No operator role holds this, so
        // the panel that used to be offered to every manager and then answer
        // "Platform administrators only" is now offered to nobody but them.
        permission: 'admin:operator:read',
      },
    ],
  },
  {
    kind: 'panel',
    panel: {
      id: 'branches',
      label: 'Branches',
      icon: Building2,
      description: 'Manage branch locations and clone catalogs between branches.',
      // The panel edits: `PATCH /branches/:id`. `admin:branch:read` would be
      // the wrong bar — every counter role holds it.
      permission: 'admin:branch:update',
    },
  },
];

// Flat lookup of every panel by id (for the content area).
export const adminPanelsById: Record<string, AdminPanel> = adminNav.reduce(
  (acc, entry) => {
    if (entry.kind === 'group') {
      for (const p of entry.panels) acc[p.id] = p;
    } else {
      acc[entry.panel.id] = entry.panel;
    }
    return acc;
  },
  {} as Record<string, AdminPanel>
);

// Map from panel id → group id (used by AdminLayout to auto-expand the active
// group). Standalone top-level panels have no group and are omitted.
export const panelGroupMap: Record<string, string> = adminNav.reduce(
  (acc, entry) => {
    if (entry.kind === 'group') {
      for (const p of entry.panels) acc[p.id] = entry.id;
    }
    return acc;
  },
  {} as Record<string, string>
);

export const DEFAULT_ADMIN_PANEL = 'tickets';

/** Every panel in nav order, groups flattened. */
export const allAdminPanels: AdminPanel[] = adminNav.flatMap((entry) =>
  entry.kind === 'group' ? entry.panels : [entry.panel],
);

/**
 * What the /admin front door accepts: hold one of these and there is at least
 * one panel worth showing you.
 *
 * The `pos:*` panel permissions are deliberately left out. Reception holds
 * `pos:member:read` and `pos:member:update` for its work at the counter, and
 * holding them has never been a reason to open the back office — inside the
 * console they gate the Members panels for whoever is already through the
 * door, which is not the same question.
 */
export const adminPanelPermissions: Permission[] = Array.from(
  new Set(
    allAdminPanels
      .map((p) => p.permission)
      .filter((p): p is Permission => p !== undefined && !p.startsWith('pos:')),
  ),
);

/** Whether this account is offered a given panel. */
const offered = (can: (permission: Permission) => boolean) => (p: AdminPanel) =>
  p.permission === undefined || can(p.permission);

/**
 * The nav an account is offered. A panel with no permission is offered to
 * anyone already through the front door; one with a permission is offered only
 * to an account holding it. A group with nothing left in it disappears with
 * its header, rather than sitting there empty.
 */
export function visibleNavFor(can: (permission: Permission) => boolean): AdminNavEntry[] {
  const allowed = offered(can);
  return adminNav.reduce<AdminNavEntry[]>((acc, entry) => {
    if (entry.kind === 'panel') {
      if (allowed(entry.panel)) acc.push(entry);
      return acc;
    }
    const panels = entry.panels.filter(allowed);
    if (panels.length > 0) acc.push({ ...entry, panels });
    return acc;
  }, []);
}

/**
 * Where an account opens the console: the first panel in nav order it is
 * offered, so nobody lands on a refusal. Falls back to the front page, which
 * then renders that refusal — the honest answer if it ever happens.
 */
export function firstUsableAdminPanel(can: (permission: Permission) => boolean): string {
  return allAdminPanels.find(offered(can))?.id ?? DEFAULT_ADMIN_PANEL;
}
