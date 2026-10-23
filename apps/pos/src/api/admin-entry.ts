import { withHandoffTarget } from '@oto/shared/handoff-target';
import { api, idemKey } from './client';

/** Fixed compatibility addresses for the one-release POS admin redirect. */
export const ADMIN_PANEL_TARGETS = Object.freeze({
  tickets: '/catalogue/tickets', addons: '/catalogue/add-ons', menu: '/catalogue/menu',
  categories: '/catalogue/categories', modifiers: '/catalogue/modifiers', merch: '/catalogue/merch',
  inventory: '/catalogue/inventory', pricing: '/catalogue/tiers', discounts: '/catalogue/discounts',
  'voucher-promotions': '/catalogue/voucher-campaigns', tax: '/catalogue/tax', supervision: '/catalogue/care',
  events: '/catalogue/event-pricing', templates: '/catalogue/print-templates', devices: '/devices',
  'staff-benefits': '/catalogue/staff-benefits', 'reports-sales': '/reports/sales',
  'reports-profitability': '/reports/profitability', 'reports-wallet': '/reports/wallet-promo', wallets: '/reports/wallets',
  'reports-discounts': '/reports/discounts', 'reports-tax': '/reports/tax-vat', members: '/catalogue/members',
  'tier-verifications': '/catalogue/tier-verifications', 'login-users': '/people/accounts',
  operators: '/organisation/operators', branches: '/organisation/branches',
} as const);

const templateKinds = new Set(['receipt', 'kids_wristband', 'adult_wristband',
  'kitchen_ticket', 'bar_ticket', 'credit_voucher']);

/** A bookmark chooses a known local page, never an origin or arbitrary next URL. */
export function adminTargetFromSearch(search: string): string {
  const query = new URLSearchParams(search);
  const panel = query.get('panel');
  if (!panel || !Object.hasOwn(ADMIN_PANEL_TARGETS, panel)) return '/overview';
  const target = ADMIN_PANEL_TARGETS[panel as keyof typeof ADMIN_PANEL_TARGETS];
  const template = query.get('template');
  return panel === 'templates' && template !== null && templateKinds.has(template)
    ? `${target}?${new URLSearchParams({ template })}` : target;
}

/** The existing sign-on seam owns the configured Admin destination and its access check. */
async function issueAdminDestination(target: string): Promise<string> {
  const issued = await api.post('/auth/handoff', { app: 'console' }, { idempotencyKey: idemKey() });
  try {
    if (typeof issued !== 'object' || issued === null || !('launchUrl' in issued) ||
      typeof issued.launchUrl !== 'string') throw new Error();
    const authority = /^https?:\/\/([^/?#]*)/i.exec(issued.launchUrl)?.[1];
    const parsed = new URL(issued.launchUrl);
    const fragment = new URLSearchParams(parsed.hash.slice(1));
    if (!authority || authority.includes('@') || !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username || parsed.password || !fragment.get('handoff')?.trim() || fragment.has('to')) throw new Error();
    const destination = withHandoffTarget(issued.launchUrl, target);
    if (destination === issued.launchUrl) throw new Error();
    return destination;
  } catch {
    throw new Error('Admin has no configured signed-in destination.');
  }
}

export function adminDestination(search: string): Promise<string> {
  return issueAdminDestination(adminTargetFromSearch(search));
}

/** Preserve the earlier Accounts entry for callers that name that exact destination. */
export function adminAccountsDestination(): Promise<string> {
  return issueAdminDestination('/people/accounts');
}
