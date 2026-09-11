import type {
  AddOn,
  TicketCreditRule,
  TicketFreebie,
  TierAdultRule,
  TierPriceRule,
} from '@/types';
import { getTiers } from '@/store/catalogStore';
import { tierLabel } from '@/lib/membership';
import { formatWWPrice } from '@/lib/pricingMode';

/**
 * Resolve a non-base tier's concrete price from the Tourist (base) price and
 * its rule. `manual` returns the base unchanged (callers supply the typed
 * value directly); percent/amount derive and clamp at 0.
 */
export const computeTierPrice = (base: number, rule: TierPriceRule): number => {
  if (rule.mode === 'percent') {
    return Math.max(0, Math.round(base * (1 - rule.value / 100)));
  }
  if (rule.mode === 'amount') {
    return Math.max(0, base - rule.value);
  }
  return base;
};

/** Short annotation for a derived tier, e.g. "−10%" or "−฿100". Empty for manual. */
export const ruleBadge = (rule: TierPriceRule | undefined): string => {
  if (!rule || rule.mode === 'manual') return '';
  if (rule.mode === 'percent') return `−${rule.value}%`;
  return `−฿${rule.value.toLocaleString()}`;
};

/** Human label for a freebie, e.g. "2× Free socks" or "1× Free adult". */
export const freebieLabel = (
  freebie: TicketFreebie,
  addOns: AddOn[]
): string => {
  const qty = `${freebie.quantity}× `;
  if (freebie.kind === 'adult') return `${qty}Free adult`;
  if (freebie.kind === 'child') return `${qty}Free child`;
  const addOn = addOns.find((a) => a.id === freebie.addOnId);
  return `${qty}Free ${addOn ? addOn.name : 'add-on'}`;
};

/** Suffix listing which tiers a freebie applies to, or '' when it covers all. */
export const freebieTierSuffix = (freebie: TicketFreebie): string => {
  if (freebie.tiers.length === 0 || freebie.tiers.length === getTiers().length) {
    return '';
  }
  return ` (${freebie.tiers.map((t) => tierLabel(t)).join(', ')})`;
};

/** One-line label for a single tier's adult rule. */
// rule.price is a weekday/weekend PAIR — format it like every other admin
// price cell (was stringifying the object as "[object Object]").
const adultRuleLabel = (rule: TierAdultRule): string => {
  if (rule.kind === 'set_price') return formatWWPrice(rule.price);
  if (rule.kind === 'free_adults') {
    const n = rule.freeAdults ?? 0;
    const then =
      rule.overflow === 'set_price' ? `then ${formatWWPrice(rule.price)}` : 'then kid price';
    return `${n} free, ${then}`;
  }
  return 'kid price';
};

/**
 * Summary of a ticket's adult entry across tiers, for the row chip. Groups tiers
 * that share the same rule label ("all tiers …") and only lists per-tier detail
 * when they diverge. Returns '' when every tier is the default (adults = kids).
 */
export const adultRuleSummary = (
  rules: Record<string, TierAdultRule> | undefined
): string => {
  if (!rules || Object.keys(rules).length === 0) return '';
  const tiers = getTiers();
  const parts = tiers
    .filter((t) => rules[t.id])
    .map((t) => ({ tier: t.id, label: adultRuleLabel(rules[t.id]) }));
  if (parts.length === 0) return '';
  const uniqueLabels = Array.from(new Set(parts.map((p) => p.label)));
  if (uniqueLabels.length === 1 && parts.length === tiers.length) {
    return `Adults ${uniqueLabels[0]}`;
  }
  return `Adults ${parts.map((p) => `${tierLabel(p.tier)} ${p.label}`).join(', ')}`;
};

/** Summary of a ticket's F&B credit give-back, for the row chip. */
export const creditRuleSummary = (rule: TicketCreditRule | undefined): string => {
  if (!rule || rule.appliesTo === 'none') return '';
  const who =
    rule.appliesTo === 'both'
      ? 'adults & kids'
      : rule.appliesTo === 'adults'
        ? 'adults'
        : 'kids';
  const amount =
    rule.basis === 'full_price'
      ? 'full price'
      : rule.basis === 'percent'
        ? `${rule.value ?? 0}%`
        : `฿${(rule.value ?? 0).toLocaleString()}`;
  return `${amount} credit · ${who}`;
};
