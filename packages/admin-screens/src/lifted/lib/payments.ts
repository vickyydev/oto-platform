import { Banknote, CreditCard, QrCode as QrCodeIcon, Wallet, type LucideIcon } from "lucide-react";
import { type PaymentMethod, type PaymentMethodKind } from "../model/types";
import type { CatalogReaders } from '../model/ports';


export type RefundMode = 'auto' | 'manual';
/** Original domain rules, bound to this host's explicit data ports. */
export function createPaymentsHelpers(deps: { catalog: CatalogReaders }) {
const { getPaymentMethods } = deps.catalog;


// SEAM: payment-method helpers. Methods themselves live in the catalog store
// (configurable in Admin). These pure helpers resolve a stored payment token to
// its label / kind / icon and derive behaviour (refund routing) from the kind,
// so nothing in the POS hardcodes the tender list any more.

// Legacy token migration. Older code/data used `credit_card`; the canonical token
// is `card`. Normalise on read so any stray legacy value still resolves.
function normalizePaymentMethod(token: string): string {
  return token === 'credit_card' ? 'card' : token;
}


/** Enabled methods only, already sorted (the store getter sorts by sortOrder). */
function getEnabledPaymentMethods(
  methods: PaymentMethod[] = getPaymentMethods(),
): PaymentMethod[] {
  return methods.filter((m) => m.enabled);
}


/** Resolve a stored token (normalised) to its configured method, if any. */
function findPaymentMethod(
  token: string,
  methods: PaymentMethod[] = getPaymentMethods(),
): PaymentMethod | undefined {
  const id = normalizePaymentMethod(token);
  return methods.find((m) => m.id === id);
}


/** Display label for a stored token; falls back to the raw token if unknown. */
function paymentMethodLabel(
  token: string,
  methods: PaymentMethod[] = getPaymentMethods(),
): string {
  return findPaymentMethod(token, methods)?.label ?? token;
}


/** Behaviour kind for a stored token; unknown tokens are treated as `other`. */
function paymentMethodKind(
  token: string,
  methods: PaymentMethod[] = getPaymentMethods(),
): PaymentMethodKind {
  return findPaymentMethod(token, methods)?.kind ?? 'other';
}


const ICON_BY_KIND: Record<PaymentMethodKind, LucideIcon> = {
  cash: Banknote,
  card: CreditCard,
  qr: QrCodeIcon,
  other: Wallet,
};


/** The lucide icon that represents a payment-method kind. */
function paymentMethodIcon(kind: PaymentMethodKind): LucideIcon {
  return ICON_BY_KIND[kind] ?? Wallet;
}


// Refund routing seam, driven by the method's kind (not a hardcoded token list):
// electronic tenders (card / QR) reverse automatically through the gateway; cash
// (and anything else) is handed back manually by staff.
function refundModeForMethod(
  token: string,
  methods: PaymentMethod[] = getPaymentMethods(),
): RefundMode {
  const kind = paymentMethodKind(token, methods);
  return kind === 'card' || kind === 'qr' ? 'auto' : 'manual';
}
return { normalizePaymentMethod, getEnabledPaymentMethods, findPaymentMethod, paymentMethodLabel, paymentMethodKind, paymentMethodIcon, refundModeForMethod };
}
export type PaymentsHelpers = ReturnType<typeof createPaymentsHelpers>;
