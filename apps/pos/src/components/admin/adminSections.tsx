import {
  Ticket,
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
  PercentCircle,
  FileSpreadsheet,
  type LucideIcon,
} from 'lucide-react';

export interface AdminPanel {
  id: string;
  label: string;
  icon: LucideIcon;
  description: string;
  /** Manager-only panels are hidden from the nav (and blocked from rendering)
   *  for staff-role operators. See AdminLayout's role filtering. */
  managerOnly?: boolean;
}

export interface AdminNavGroup {
  kind: 'group';
  id: string;
  label: string;
  panels: AdminPanel[];
  /** True when every panel in the group is manager-only (hides the whole group header too). */
  managerOnly?: boolean;
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
      },
      {
        id: 'addons',
        label: 'Add-ons',
        icon: PlusCircle,
        description: 'Manage socks, lockers, cups and other extras.',
      },
      {
        id: 'menu',
        label: 'F&B Menu',
        icon: UtensilsCrossed,
        description: 'Manage food, drinks, bar and snack items.',
      },
      {
        id: 'categories',
        label: 'F&B Categories',
        icon: Tags,
        description: 'Manage menu categories and their default prep & tax.',
      },
      {
        id: 'modifiers',
        label: 'Modifiers',
        icon: SlidersHorizontal,
        description: 'Manage modifier groups (ice, sauces, sizes…).',
      },
      {
        id: 'merch',
        label: 'Merch / Retail',
        icon: ShoppingBag,
        description: 'Manage shop item metadata (name, price, SKU, category).',
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
      },
      {
        id: 'discounts',
        label: 'Discounts & Payments',
        icon: BadgePercent,
        description: 'Manage discount codes, reasons and payment methods.',
      },
      {
        id: 'tax',
        label: 'Tax & Service',
        icon: Receipt,
        description: 'Configure VAT, per-area tax mode and service charges.',
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
      },
      {
        id: 'templates',
        label: 'Print Templates',
        icon: FileText,
        description: 'Configure what each printout shows (content, not routing).',
      },
      {
        id: 'devices',
        label: 'Devices',
        icon: Printer,
        description: 'Manage printers, scanners and EDC terminals.',
      },
      {
        id: 'staff-benefits',
        label: 'Staff Benefits',
        icon: Gift,
        description: 'Configure Owner/Manager/Staff benefit profiles and per-operator overrides.',
      },
    ],
  },
  {
    kind: 'group',
    id: 'reports',
    label: 'Reporting',
    managerOnly: true,
    panels: [
      {
        id: 'reports-sales',
        label: 'Sales',
        icon: BarChart3,
        description: 'Revenue by category, tier, F&B and merch items — filterable by branch and date range.',
        managerOnly: true,
      },
      {
        id: 'reports-profitability',
        label: 'Profitability',
        icon: TrendingUp,
        description: 'F&B and merch margin against catalog cost-to-park (COGS).',
        managerOnly: true,
      },
      {
        id: 'reports-wallet',
        label: 'Wallet & Promo',
        icon: Wallet,
        description: 'F&B/merch wallet credit ledger and promo-code usage.',
        managerOnly: true,
      },
      {
        id: 'reports-discounts',
        label: 'Discounts & Comps',
        icon: PercentCircle,
        description: 'Manual discount and comp impact, by operator.',
        managerOnly: true,
      },
      {
        id: 'reports-tax',
        label: 'Tax & VAT',
        icon: FileSpreadsheet,
        description: 'Bulk tax-receipt export and a category-level VAT summary.',
        managerOnly: true,
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
    },
  },
  // Access management (Sprint 1 rebuild): real accounts, roles and operators
  // against the platform API. Manager-only, like Reports.
  {
    kind: 'group',
    id: 'access',
    label: 'Access',
    managerOnly: true,
    panels: [
      {
        id: 'login-users',
        label: 'Login Users',
        icon: ShieldCheck,
        description: 'Invite staff accounts, assign scoped roles, and review effective permissions.',
        managerOnly: true,
      },
      {
        id: 'operators',
        label: 'Operators',
        icon: Building2,
        description: 'Platform admin: create or archive operators and assign their administrators.',
        managerOnly: true,
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
